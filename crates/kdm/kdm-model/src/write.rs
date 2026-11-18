//! `Project` -> replica: a full write (new project, `.kfilm` import) and an incremental diff (the
//! engine command bridge, Task 2) that writes only what changed.
//!
//! Three passes, each needing the one before it fully done (ids cannot forward-reference an
//! object that does not exist yet):
//! 1. every `Bin` and `Item` object is created (so every `ItemId`/`BinId` has an object), and for
//!    a sequence item, its `Sequence` object too (with a placeholder `settings`);
//! 2. `Item.props` (a subclip's `parent` resolves through 1), `Bin.entries` (resolves through 1),
//!    and every sequence's tracks, clips and (track-level, clip-level) effects (`Clip.item`
//!    resolves through 1);
//! 3. every sequence's transitions (`from`/`to` resolve through 2), then its `settings` (multicam/
//!    merged resolve through 1 and 2) and `mixer`/`captionTracks`/`markers`, then the project's
//!    `docState` (`transcripts`/`sourceGraphics` resolve through 1).

use std::collections::HashMap;

use kition_film_project::{Bin, BinEntry, EffectInstance, ItemKind, Project, ProjectItem, Sequence, Track, TrackItem, Transition, TransitionAlign};
use kition_kit::kdm::{KdmError, NodeRef, ObjectId, Tx};
use serde_json::{Map, Value, json};

use crate::ids::Ids;
use crate::{Nodes, kdm_err, project_id, props, root_bin_id, tick};

type KdmResult<T> = Result<T, KdmError>;

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn item_kind_str(kind: &ItemKind) -> &'static str {
    match kind {
        ItemKind::Media(_) => "media",
        ItemKind::Sequence(_) => "sequence",
        ItemKind::Subclip { .. } => "subclip",
        ItemKind::AdjustmentLayer { .. } => "adjustment",
        ItemKind::Graphic { .. } => "graphic",
    }
}

fn align_str(align: TransitionAlign) -> &'static str {
    match align {
        TransitionAlign::CenterAtCut => "centerAtCut",
        TransitionAlign::StartAtCut => "startAtCut",
        TransitionAlign::EndAtCut => "endAtCut",
    }
}

/// Writes a whole project into a fresh replica's creating transaction (import, or any other bulk
/// build). Returns the `Project` object's id (always [`project_id`], but handed back so callers
/// do not need to know that).
pub fn write_document(tx: &mut Tx<'_>, project: &Project, ids: &mut Ids, nodes: &mut Nodes) -> KdmResult<ObjectId> {
    let proj = project_id();
    let project_fields = fields(json!({ "name": project.name, "settings": serde_json::to_value(&project.settings).map_err(kdm_err)? }));
    tx.create_with_id("Project", &proj, project_fields)?;
    write_bin_shell(tx, &proj, &project.root, None, ids, nodes)?;
    write_contents(tx, &proj, project, ids)?;
    Ok(proj)
}

/// Writes `project` over everything an existing replica holds, in one transaction: every object
/// but the `Project` and its root `Bin` is deleted (a deleted bin's tree node, and its subtree,
/// is skipped by every reader), and `project` is written in their place exactly as
/// [`write_document`] would write it, under the replica's own `Project` and root bin. For a file
/// that must win over a replica that does not hold it (the replica keeps its document identity
/// and history; collaborators get the new content as ordinary changes). `ids` is reset to the new
/// objects; `nodes` must hold the root bin's node (any other entry is dropped).
pub fn replace_document(tx: &mut Tx<'_>, project: &Project, ids: &mut Ids, nodes: &mut Nodes) -> KdmResult<()> {
    let proj = project_id();
    let root = root_bin_id();
    let root_node = nodes.get(&root).cloned().ok_or_else(|| kdm_err("the replica's root bin has no tree node"))?;
    for ty in ["Transition", "Effect", "Clip", "Track", "Sequence", "Item", "Bin"] {
        for object in tx.objects_of_type(ty) {
            if object != root {
                tx.delete(&object)?;
            }
        }
    }
    let entries = tx.list_items(&root, "entries")?.len();
    for index in (0..entries).rev() {
        tx.list_remove(&root, "entries", index)?;
    }
    tx.set(&proj, "name", json!(project.name))?;
    tx.set(&proj, "settings", serde_json::to_value(&project.settings).map_err(kdm_err)?)?;
    tx.set(&root, "name", json!(project.root.name))?;
    tx.set(&root, "binId", json!(project.root.id.0))?;
    *ids = Ids::default();
    nodes.retain(|object, _| object == &root);
    ids.bins.insert(root, project.root.id);
    for entry in &project.root.children {
        if let BinEntry::Bin(child) = entry {
            write_bin_shell(tx, &proj, child, Some(&root_node), ids, nodes)?;
        }
    }
    write_contents(tx, &proj, project, ids)
}

/// Everything [`write_document`] writes once the bin tree's objects exist: items, bin entries,
/// sequences (tracks, clips, transitions, settings…) and the project's `docState`.
fn write_contents(tx: &mut Tx<'_>, proj: &ObjectId, project: &Project, ids: &mut Ids) -> KdmResult<()> {
    let mut sequence_objects: HashMap<kition_film_project::ItemId, ObjectId> = HashMap::new();
    for item in project.items.values() {
        let seq_obj = if let ItemKind::Sequence(_) = &item.kind {
            let placeholder = fields(json!({ "settings": {} }));
            let object = tx.create("Sequence", placeholder)?;
            sequence_objects.insert(item.id, object.clone());
            Some(object)
        } else {
            None
        };
        let mut item_fields = fields(json!({ "kind": item_kind_str(&item.kind), "name": item.name, "itemId": item.id.0 }));
        if let Some(seq_obj) = &seq_obj {
            item_fields.insert("sequence".into(), json!(seq_obj.as_str()));
        }
        let object = tx.create("Item", item_fields)?;
        ids.items.insert(object, item.id);
    }

    for item in project.items.values() {
        let Some(object) = ids.items.object(item.id).cloned() else { continue };
        let (_, props_value) = props::item_kind_and_props(item, ids)?;
        tx.set(&object, "props", props_value)?;
    }
    write_bin_entries(tx, &root_bin_id(), &project.root, ids)?;

    for item in project.items.values() {
        let ItemKind::Sequence(seq) = &item.kind else { continue };
        let Some(seq_obj) = sequence_objects.get(&item.id).cloned() else { continue };
        write_sequence_tracks(tx, &seq_obj, seq, ids)?;
    }
    for item in project.items.values() {
        let ItemKind::Sequence(seq) = &item.kind else { continue };
        let Some(seq_obj) = sequence_objects.get(&item.id).cloned() else { continue };
        write_sequence_transitions(tx, &seq_obj, seq, ids)?;
    }
    for item in project.items.values() {
        let ItemKind::Sequence(seq) = &item.kind else { continue };
        let Some(seq_obj) = sequence_objects.get(&item.id).cloned() else { continue };
        finalize_sequence_extras(tx, &seq_obj, seq, ids)?;
    }

    let doc_state = props::build_doc_state(project, ids);
    tx.set(proj, "docState", serde_json::to_value(doc_state).map_err(kdm_err)?)?;
    Ok(())
}

/// Creates `bin`'s object and places it in the tree (recursing into sub-bins); does not populate
/// `entries` (see [`write_bin_entries`]).
fn write_bin_shell(tx: &mut Tx<'_>, proj: &ObjectId, bin: &Bin, parent: Option<&NodeRef>, ids: &mut Ids, nodes: &mut Nodes) -> KdmResult<ObjectId> {
    let object = match parent {
        None => tx.create_with_id("Bin", &root_bin_id(), fields(json!({ "name": bin.name, "binId": bin.id.0 })))?,
        Some(_) => tx.create("Bin", fields(json!({ "name": bin.name, "binId": bin.id.0 })))?,
    };
    ids.bins.insert(object.clone(), bin.id);
    let node = tx.tree_create(proj, "bins", parent, &object)?;
    nodes.insert(object.clone(), node.clone());
    for entry in &bin.children {
        if let BinEntry::Bin(child) = entry {
            write_bin_shell(tx, proj, child, Some(&node), ids, nodes)?;
        }
    }
    Ok(object)
}

fn write_bin_entries(tx: &mut Tx<'_>, bin_object: &ObjectId, bin: &Bin, ids: &Ids) -> KdmResult<()> {
    let mut index = 0usize;
    for entry in &bin.children {
        match entry {
            BinEntry::Item(id) => {
                if let Some(item_object) = ids.items.object(*id) {
                    tx.list_insert(bin_object, "entries", index, item_object)?;
                    index += 1;
                }
            }
            BinEntry::Bin(child) => {
                if let Some(child_object) = ids.bins.object(child.id).cloned() {
                    write_bin_entries(tx, &child_object, child, ids)?;
                }
            }
        }
    }
    Ok(())
}

fn write_sequence_tracks(tx: &mut Tx<'_>, seq_obj: &ObjectId, seq: &Sequence, ids: &mut Ids) -> KdmResult<()> {
    for (field, tracks) in [("videoTracks", &seq.video_tracks), ("audioTracks", &seq.audio_tracks), ("submixTracks", &seq.submix_tracks)] {
        for (index, track) in tracks.iter().enumerate() {
            let track_obj = write_track_shell(tx, track, ids)?;
            tx.list_insert(seq_obj, field, index, &track_obj)?;
            write_effects(tx, &track_obj, "effects", &track.effects)?;
            for clip in &track.items {
                let clip_obj = write_clip(tx, clip, ids)?;
                let len = tx.list_items(&track_obj, "clips")?.len();
                tx.list_insert(&track_obj, "clips", len, &clip_obj)?;
            }
        }
    }
    Ok(())
}

fn write_track_shell(tx: &mut Tx<'_>, track: &Track, ids: &mut Ids) -> KdmResult<ObjectId> {
    let props = serde_json::to_value(props::TrackProps {
        kind: track.kind,
        name: track.name.clone(),
        locked: track.locked,
        sync_lock: track.sync_lock,
        enabled: track.enabled,
        muted: track.muted,
        solo: track.solo,
        channels: track.channels,
        mixer: track.mixer.clone(),
    })
    .map_err(kdm_err)?;
    let object = tx.create("Track", fields(json!({ "props": props, "trackId": track.id.0, "volumeDb": track.volume_db, "pan": track.pan })))?;
    ids.tracks.insert(object.clone(), track.id);
    Ok(object)
}

fn clip_fields(clip: &TrackItem, ids: &Ids) -> KdmResult<Map<String, Value>> {
    let item_obj = ids.items.object(clip.item);
    let props = props::ClipProps {
        name: clip.name.clone(),
        label: clip.label,
        enabled: clip.enabled,
        frame_hold: clip.frame_hold,
        scale_to_frame: clip.scale_to_frame,
        audio_mixing: clip.audio_mixing.clone(),
        multicam: clip.multicam,
        time_interpolation: clip.time_interpolation,
        hold_filters: clip.hold_filters,
        field_options: clip.field_options,
        source_channels: clip.source_channels.clone(),
        audio_stream: clip.audio_stream,
        graphic: clip.graphic.clone(),
    };
    Ok(fields(json!({
        "clipId": clip.id.0,
        "item": item_obj.map(ObjectId::as_str),
        "missingItem": if item_obj.is_none() { Some(clip.item.0) } else { None },
        "start": tick::to_string(clip.start),
        "duration": tick::to_string(clip.duration),
        "sourceIn": tick::to_string(clip.source_in),
        "speed": clip.speed,
        "reverse": clip.reverse,
        "link": clip.link.map(|v| v.to_string()),
        "group": clip.group.map(|v| v.to_string()),
        "gain": serde_json::to_value(props::ClipGain { gain_db: clip.gain_db }).map_err(kdm_err)?,
        "markers": serde_json::to_value(&clip.markers).map_err(kdm_err)?,
        "props": serde_json::to_value(props).map_err(kdm_err)?,
    })))
}

fn write_clip(tx: &mut Tx<'_>, clip: &TrackItem, ids: &mut Ids) -> KdmResult<ObjectId> {
    let object = tx.create("Clip", clip_fields(clip, ids)?)?;
    ids.clips.insert(object.clone(), clip.id);
    write_effects(tx, &object, "effects", &clip.effects)?;
    Ok(object)
}

fn write_effects(tx: &mut Tx<'_>, owner: &ObjectId, field: &str, effects: &[EffectInstance]) -> KdmResult<()> {
    for (index, effect) in effects.iter().enumerate() {
        let (def, params) = props::effect_def_and_params(effect)?;
        let object = tx.create("Effect", fields(json!({ "def": def, "params": params })))?;
        tx.list_insert(owner, field, index, &object)?;
    }
    Ok(())
}

fn transition_fields(tx: &mut Tx<'_>, t: &Transition, ids: &Ids) -> KdmResult<Map<String, Value>> {
    let (def, params) = props::effect_def_and_params(&t.effect)?;
    let effect_obj = tx.create("Effect", fields(json!({ "def": def, "params": params })))?;
    Ok(fields(json!({
        "transitionId": t.id.0,
        "effect": effect_obj.as_str(),
        "start": tick::to_string(t.start),
        "duration": tick::to_string(t.duration),
        "from": t.from.and_then(|c| ids.clips.object(c)).map(ObjectId::as_str),
        "to": t.to.and_then(|c| ids.clips.object(c)).map(ObjectId::as_str),
        "align": align_str(t.align),
        "reverse": t.reverse,
    })))
}

fn write_sequence_transitions(tx: &mut Tx<'_>, seq_obj: &ObjectId, seq: &Sequence, ids: &mut Ids) -> KdmResult<()> {
    for field in ["videoTracks", "audioTracks", "submixTracks"] {
        let track_objects = tx.list_items(seq_obj, field)?;
        let tracks: &[Track] = match field {
            "videoTracks" => &seq.video_tracks,
            "audioTracks" => &seq.audio_tracks,
            _ => &seq.submix_tracks,
        };
        for (track, track_obj) in tracks.iter().zip(track_objects.iter()) {
            for (index, transition) in track.transitions.iter().enumerate() {
                let fields = transition_fields(tx, transition, ids)?;
                let object = tx.create("Transition", fields)?;
                ids.transitions.insert(object.clone(), transition.id);
                tx.list_insert(track_obj, "transitions", index, &object)?;
            }
        }
    }
    Ok(())
}

fn finalize_sequence_extras(tx: &mut Tx<'_>, seq_obj: &ObjectId, seq: &Sequence, ids: &Ids) -> KdmResult<()> {
    tx.set(seq_obj, "duration", json!(tick::to_string(seq.duration())))?;
    tx.set(seq_obj, "settings", serde_json::to_value(props::build_sequence_settings(seq, ids)).map_err(kdm_err)?)?;
    tx.set(seq_obj, "masterVolumeDb", json!(seq.master_volume_db))?;
    if !seq.master_effects.is_empty() || seq.master_mixer != Default::default() {
        let mixer = props::SeqMixer { master_effects: seq.master_effects.clone(), master_mixer: seq.master_mixer.clone() };
        tx.set(seq_obj, "mixer", serde_json::to_value(mixer).map_err(kdm_err)?)?;
    }
    if !seq.caption_tracks.is_empty() {
        tx.set(seq_obj, "captionTracks", props::caption_tracks_json(&seq.caption_tracks)?)?;
    }
    if !seq.markers.is_empty() {
        tx.set(seq_obj, "markers", serde_json::to_value(&seq.markers).map_err(kdm_err)?)?;
    }
    Ok(())
}

// --- write_changes: an incremental diff of `before` -> `after` ------------------------------

/// Writes only what differs between `before` and `after`: bin/item/track/clip/transition/effect
/// field changes, inserts, deletes, bin tree moves and clip/transition moves between tracks (the
/// same object, moved). Answers whether it wrote anything.
pub fn write_changes(tx: &mut Tx<'_>, before: &Project, after: &Project, ids: &mut Ids, nodes: &mut Nodes) -> KdmResult<bool> {
    let proj = project_id();
    let mut wrote = false;
    if before.name != after.name {
        tx.set(&proj, "name", json!(after.name))?;
        wrote = true;
    }
    if before.settings != after.settings {
        tx.set(&proj, "settings", serde_json::to_value(&after.settings).map_err(kdm_err)?)?;
        wrote = true;
    }

    let before_items = index_items(before);
    let after_items = index_items(after);

    // Deletes first, so a new item elsewhere can never collide with a freed identity.
    for id in before_items.keys() {
        if !after_items.contains_key(id)
            && let Some(object) = ids.items.object(*id).cloned()
        {
            tx.delete(&object)?;
            ids.items.remove(&object);
            wrote = true;
        }
    }

    // New items (and their sequence placeholder), so every reference below can resolve.
    let mut sequence_objects: HashMap<kition_film_project::ItemId, ObjectId> = HashMap::new();
    let mut new_items: Vec<kition_film_project::ItemId> = Vec::new();
    for item in after.items.values() {
        if before_items.contains_key(&item.id) {
            if let ItemKind::Sequence(_) = &item.kind {
                let object = ids.items.object(item.id).cloned().ok_or_else(|| kdm_err("sequence item has no object"))?;
                if let Value::String(seq) = tx.get(&object, "sequence")? {
                    sequence_objects.insert(item.id, ObjectId::from_string(seq));
                }
            }
            continue;
        }
        let seq_obj = if let ItemKind::Sequence(_) = &item.kind {
            let object = tx.create("Sequence", fields(json!({ "settings": {} })))?;
            sequence_objects.insert(item.id, object.clone());
            Some(object)
        } else {
            None
        };
        let mut item_fields = fields(json!({ "kind": item_kind_str(&item.kind), "name": item.name, "itemId": item.id.0 }));
        if let Some(seq_obj) = &seq_obj {
            item_fields.insert("sequence".into(), json!(seq_obj.as_str()));
        }
        let object = tx.create("Item", item_fields)?;
        ids.items.insert(object, item.id);
        new_items.push(item.id);
        wrote = true;
    }

    // Every new item's `props`, now that every new item (and every pre-existing one) has an id
    // to resolve against (a subclip created in the same edit can name a sibling new item as its
    // parent). `write_document`'s own creation does this in the same two-pass way, for the same
    // reason; unlike that full write, `diff_item` below only runs for items that existed in both
    // `before` and `after`, so a new item's `props` would otherwise stay unset (the read side
    // then fails on it: `resolve_item_props` expects every item's `props`, never a bare `null`).
    for id in &new_items {
        let Some(item) = after.items.get(id) else { continue };
        let Some(object) = ids.items.object(*id).cloned() else { continue };
        let (_, props_value) = props::item_kind_and_props(item, ids)?;
        tx.set(&object, "props", props_value)?;
    }

    // Field changes of items whose identity persists.
    for (id, after_item) in after_items.iter() {
        let Some(before_item) = before_items.get(id) else { continue };
        let Some(object) = ids.items.object(*id).cloned() else { continue };
        wrote |= diff_item(tx, &object, before_item, after_item, ids)?;
    }

    wrote |= diff_bin_tree(tx, &proj, &before.root, &after.root, ids, nodes)?;

    for item in after.items.values() {
        let ItemKind::Sequence(after_seq) = &item.kind else { continue };
        let Some(seq_obj) = sequence_objects.get(&item.id).cloned() else { continue };
        let before_seq = before_items.get(&item.id).and_then(|i| match &i.kind {
            ItemKind::Sequence(s) => Some(s.as_ref()),
            _ => None,
        });
        wrote |= diff_sequence(tx, &seq_obj, before_seq, after_seq, ids)?;
    }

    if let Some(value) = doc_state_diff(before, after, ids)? {
        tx.set(&proj, "docState", value)?;
        wrote = true;
    }

    Ok(wrote)
}

fn index_items(project: &Project) -> HashMap<kition_film_project::ItemId, &ProjectItem> {
    project.items.iter().map(|(id, item)| (*id, item)).collect()
}

fn doc_state_diff(before: &Project, after: &Project, ids: &Ids) -> KdmResult<Option<Value>> {
    if before.luts == after.luts
        && before.transcripts == after.transcripts
        && before.search_bins == after.search_bins
        && before.source_graphics == after.source_graphics
    {
        return Ok(None);
    }
    Ok(Some(serde_json::to_value(props::build_doc_state(after, ids)).map_err(kdm_err)?))
}

/// Diffs one item's own fields: `name`, `kind`, and `props`. Compares `item_kind_and_props`'s
/// *output* rather than the whole `ProjectItem`, for two reasons: a sequence item's `props` holds
/// only its common fields (name/label/metadata/created/split), not its tracks — comparing the
/// whole item would call every track/clip edit a change to the *item* too; and comparing the raw
/// struct would also miss real no-ops (an effect's "auto" point is `f64::NAN`, which is never
/// equal to itself under `==`, but always serializes to the same `null`).
fn diff_item(tx: &mut Tx<'_>, object: &ObjectId, before: &ProjectItem, after: &ProjectItem, ids: &Ids) -> KdmResult<bool> {
    let mut wrote = false;
    if before.name != after.name {
        tx.set(object, "name", json!(after.name))?;
        wrote = true;
    }
    let (before_kind, before_props) = props::item_kind_and_props(before, ids)?;
    let (after_kind, after_props) = props::item_kind_and_props(after, ids)?;
    if before_kind != after_kind {
        tx.set(object, "kind", json!(after_kind))?;
        wrote = true;
    }
    if before_kind != after_kind || before_props != after_props {
        tx.set(object, "props", after_props)?;
        wrote = true;
    }
    Ok(wrote)
}

/// Diffs the bin tree: new/removed bins, items filed in/out, and moves. Simple and correct, not
/// move-count-minimal (see the module docs' tradeoff note for effects/tracks, which this mirrors):
/// a bin whose own identity persists is content-diffed and recursed into in place; anything else
/// (a new bin, or one whose parent changed) is rebuilt at its new position.
fn diff_bin_tree(tx: &mut Tx<'_>, proj: &ObjectId, before: &Bin, after: &Bin, ids: &mut Ids, nodes: &mut Nodes) -> KdmResult<bool> {
    let mut wrote = false;
    let before_bins = index_bins(before);
    let after_bins = index_bins(after);
    for id in before_bins.keys() {
        if !after_bins.contains_key(id)
            && let Some(object) = ids.bins.object(*id).cloned()
        {
            tx.delete(&object)?;
            ids.bins.remove(&object);
            nodes.remove(&object);
            wrote = true;
        }
    }
    wrote |= reconcile_bin(tx, proj, None, before, after, &before_bins, ids, nodes, 0)?;
    Ok(wrote)
}

fn index_bins(bin: &Bin) -> HashMap<kition_film_project::BinId, &Bin> {
    fn walk<'a>(bin: &'a Bin, out: &mut HashMap<kition_film_project::BinId, &'a Bin>) {
        out.insert(bin.id, bin);
        for entry in &bin.children {
            if let BinEntry::Bin(child) = entry {
                walk(child, out);
            }
        }
    }
    let mut out = HashMap::new();
    walk(bin, &mut out);
    out
}

#[allow(clippy::too_many_arguments)]
fn reconcile_bin(
    tx: &mut Tx<'_>,
    proj: &ObjectId,
    this_node: Option<&NodeRef>,
    before: &Bin,
    after: &Bin,
    before_bins: &HashMap<kition_film_project::BinId, &Bin>,
    ids: &mut Ids,
    nodes: &mut Nodes,
    depth: usize,
) -> KdmResult<bool> {
    if depth > 64 {
        return Err(kdm_err("bin tree nested too deep"));
    }
    let mut wrote = false;
    let object = match ids.bins.object(after.id).cloned() {
        Some(object) => object,
        None => {
            let object = tx.create("Bin", fields(json!({ "name": after.name, "binId": after.id.0 })))?;
            ids.bins.insert(object.clone(), after.id);
            let node = tx.tree_create(proj, "bins", this_node, &object)?;
            nodes.insert(object.clone(), node);
            wrote = true;
            object
        }
    };
    if before.name != after.name {
        tx.set(&object, "name", json!(after.name))?;
        wrote = true;
    }
    if before.id != after.id || item_order(before) != item_order(after) {
        wrote |= rewrite_bin_entries(tx, &object, after, ids)?;
    }

    let node = nodes.get(&object).cloned();
    let mut seen_children = std::collections::HashSet::new();
    for entry in &after.children {
        let BinEntry::Bin(child) = entry else { continue };
        seen_children.insert(child.id);
        let was_here = before.children.iter().any(|e| matches!(e, BinEntry::Bin(b) if b.id == child.id));
        if !was_here
            && let Some(child_object) = ids.bins.object(child.id).cloned()
            && let Some(child_node) = nodes.get(&child_object).cloned()
        {
            tx.tree_move(proj, "bins", &child_node, node.as_ref())?;
            wrote = true;
        }
        // A bin new in this edit is diffed against an empty bin of its own name (its object is
        // created with that name), so every item filed into it — and every sub-bin — is written.
        let empty;
        let own_before = match before_bins.get(&child.id) {
            Some(bin) => *bin,
            None => {
                empty = Bin { id: child.id, name: child.name.clone(), children: Vec::new() };
                &empty
            }
        };
        wrote |= reconcile_bin(tx, proj, node.as_ref(), own_before, child, before_bins, ids, nodes, depth + 1)?;
    }
    Ok(wrote)
}

fn item_order(bin: &Bin) -> Vec<kition_film_project::ItemId> {
    bin.children.iter().filter_map(|e| if let BinEntry::Item(id) = e { Some(*id) } else { None }).collect()
}

/// Brings the bin's `entries` list to `bin`'s item order with the fewest edits: entries no longer
/// there are removed, new ones inserted, and the rest moved into place. A rewrite (remove all,
/// insert all) would put every entry back on an undo, beside what another origin wrote since, so
/// undoing one origin's step listed the other's items twice (KitModel 1.1 M12a).
fn rewrite_bin_entries(tx: &mut Tx<'_>, bin_object: &ObjectId, bin: &Bin, ids: &Ids) -> KdmResult<bool> {
    let target: Vec<ObjectId> = item_order(bin).into_iter().filter_map(|id| ids.items.object(id).cloned()).collect();
    let mut current = tx.list_items(bin_object, "entries")?;
    let mut wrote = false;
    for index in (0..current.len()).rev() {
        if !target.contains(&current[index]) {
            tx.list_remove(bin_object, "entries", index)?;
            current.remove(index);
            wrote = true;
        }
    }
    for (index, object) in target.iter().enumerate() {
        match current.iter().position(|each| each == object) {
            Some(at) if at == index => {}
            Some(at) => {
                tx.list_move(bin_object, "entries", at, index)?;
                let moved = current.remove(at);
                current.insert(index, moved);
                wrote = true;
            }
            None => {
                tx.list_insert(bin_object, "entries", index, object)?;
                current.insert(index, object.clone());
                wrote = true;
            }
        }
    }
    Ok(wrote)
}

fn diff_sequence(tx: &mut Tx<'_>, seq_obj: &ObjectId, before: Option<&Sequence>, after: &Sequence, ids: &mut Ids) -> KdmResult<bool> {
    let mut wrote = false;
    if before.map(Sequence::duration) != Some(after.duration()) {
        tx.set(seq_obj, "duration", json!(tick::to_string(after.duration())))?;
        wrote = true;
    }
    let empty = Vec::new();
    for (field, before_tracks, after_tracks) in [
        ("videoTracks", before.map(|s| &s.video_tracks).unwrap_or(&empty), &after.video_tracks),
        ("audioTracks", before.map(|s| &s.audio_tracks).unwrap_or(&empty), &after.audio_tracks),
        ("submixTracks", before.map(|s| &s.submix_tracks).unwrap_or(&empty), &after.submix_tracks),
    ] {
        wrote |= diff_tracks(tx, seq_obj, field, before_tracks, after_tracks, ids)?;
    }
    // Clips and transitions are diffed across the whole sequence, not track by track: either can
    // move to another track (a clip dragged from V1 to V2), and a move must stay the same object
    // (`list_remove` from its old track, `list_insert` into the new one) — diffing each track on
    // its own would see the clip "gone" from one track and "already known" on the other.
    let before_tracks: Vec<&Track> = before.map(all_tracks).unwrap_or_default();
    let after_tracks = all_tracks(after);
    wrote |= diff_sequence_clips(tx, &before_tracks, &after_tracks, ids)?;
    // Transitions reference clips, so they are diffed only after every track's clips above.
    wrote |= diff_sequence_transitions(tx, &before_tracks, &after_tracks, ids)?;
    let before_settings = before.map(|s| props::build_sequence_settings(s, ids));
    let after_settings = props::build_sequence_settings(after, ids);
    let after_value = serde_json::to_value(&after_settings).map_err(kdm_err)?;
    let unchanged = before_settings.map(|b| serde_json::to_value(&b).ok() == Some(after_value.clone())).unwrap_or(false);
    if !unchanged {
        tx.set(seq_obj, "settings", after_value)?;
        wrote = true;
    }
    if before.map(|s| s.master_volume_db) != Some(after.master_volume_db) {
        tx.set(seq_obj, "masterVolumeDb", json!(after.master_volume_db))?;
        wrote = true;
    }
    let before_mixer = before.map(|s| (s.master_effects.clone(), s.master_mixer.clone()));
    let after_mixer = (after.master_effects.clone(), after.master_mixer.clone());
    if before_mixer != Some(after_mixer.clone()) {
        let mixer = props::SeqMixer { master_effects: after_mixer.0, master_mixer: after_mixer.1 };
        tx.set(seq_obj, "mixer", serde_json::to_value(mixer).map_err(kdm_err)?)?;
        wrote = true;
    }
    if before.map(|s| &s.caption_tracks) != Some(&after.caption_tracks) {
        tx.set(seq_obj, "captionTracks", props::caption_tracks_json(&after.caption_tracks)?)?;
        wrote = true;
    }
    if before.map(|s| &s.markers) != Some(&after.markers) {
        tx.set(seq_obj, "markers", serde_json::to_value(&after.markers).map_err(kdm_err)?)?;
        wrote = true;
    }
    Ok(wrote)
}

/// Diffs one sequence's ordered list of tracks: new tracks are created (empty) and appended (track
/// order is meaningful — stacking order — but a reorder is rare enough to rewrite rather than
/// solve minimally, same tradeoff as [`diff_effects`]); tracks whose identity persists are
/// field-diffed and have their effects diffed in place, wherever they now sit. Their clips and
/// transitions are diffed afterwards, across the whole sequence ([`diff_sequence_clips`]).
fn diff_tracks(tx: &mut Tx<'_>, seq_obj: &ObjectId, field: &str, before: &[Track], after: &[Track], ids: &mut Ids) -> KdmResult<bool> {
    let mut wrote = false;
    let before_ids: Vec<_> = before.iter().map(|t| t.id).collect();
    let after_ids: Vec<_> = after.iter().map(|t| t.id).collect();
    for id in &before_ids {
        if !after_ids.contains(id)
            && let Some(object) = ids.tracks.object(*id).cloned()
        {
            let existing = tx.list_items(seq_obj, field)?;
            if let Some(index) = existing.iter().position(|o| o == &object) {
                tx.delete(&object)?;
                tx.list_remove(seq_obj, field, index)?;
                ids.tracks.remove(&object);
                wrote = true;
            }
        }
    }
    let same_order = before_ids == after_ids;
    if !same_order {
        // Structural change (added/removed/reordered track): append new tracks at the end and
        // move the rest into `after`'s order.
        for track in after {
            if ids.tracks.object(track.id).is_none() {
                let track_obj = write_track_shell(tx, track, ids)?;
                let len = tx.list_items(seq_obj, field)?.len();
                tx.list_insert(seq_obj, field, len, &track_obj)?;
                write_effects(tx, &track_obj, "effects", &track.effects)?;
                wrote = true;
            }
        }
        let mut current = tx.list_items(seq_obj, field)?;
        for (target_index, track) in after.iter().enumerate() {
            let Some(object) = ids.tracks.object(track.id).cloned() else { continue };
            let Some(current_index) = current.iter().position(|o| o == &object) else { continue };
            if current_index != target_index {
                tx.list_move(seq_obj, field, current_index, target_index)?;
                let moved = current.remove(current_index);
                current.insert(target_index, moved);
                wrote = true;
            }
        }
    }
    for after_track in after {
        let Some(before_track) = before.iter().find(|t| t.id == after_track.id) else { continue };
        let Some(object) = ids.tracks.object(after_track.id).cloned() else { continue };
        wrote |= diff_track_fields(tx, &object, before_track, after_track)?;
        wrote |= diff_effects(tx, &object, "effects", &before_track.effects, &after_track.effects)?;
    }
    Ok(wrote)
}

fn diff_track_fields(tx: &mut Tx<'_>, object: &ObjectId, before: &Track, after: &Track) -> KdmResult<bool> {
    let before_props = props::TrackProps {
        kind: before.kind,
        name: before.name.clone(),
        locked: before.locked,
        sync_lock: before.sync_lock,
        enabled: before.enabled,
        muted: before.muted,
        solo: before.solo,
        channels: before.channels,
        mixer: before.mixer.clone(),
    };
    let after_props = props::TrackProps {
        kind: after.kind,
        name: after.name.clone(),
        locked: after.locked,
        sync_lock: after.sync_lock,
        enabled: after.enabled,
        muted: after.muted,
        solo: after.solo,
        channels: after.channels,
        mixer: after.mixer.clone(),
    };
    let before_value = serde_json::to_value(before_props).map_err(kdm_err)?;
    let after_value = serde_json::to_value(after_props).map_err(kdm_err)?;
    let mut wrote = false;
    if before_value != after_value {
        tx.set(object, "props", after_value)?;
        wrote = true;
    }
    for (field, old, new) in [("volumeDb", before.volume_db, after.volume_db), ("pan", before.pan, after.pan)] {
        if old != new {
            tx.set(object, field, json!(new))?;
            wrote = true;
        }
    }
    Ok(wrote)
}

fn all_tracks(seq: &Sequence) -> Vec<&Track> {
    seq.video_tracks.iter().chain(seq.audio_tracks.iter()).chain(seq.submix_tracks.iter()).collect()
}

/// Removes `object` from `track`'s `field` list, if that track still exists and lists it.
fn unlist(tx: &mut Tx<'_>, track: Option<kition_film_project::TrackId>, field: &str, object: &ObjectId, ids: &Ids) -> KdmResult<bool> {
    let Some(track_obj) = track.and_then(|t| ids.tracks.object(t)).cloned() else { return Ok(false) };
    if !tx.exists(&track_obj) {
        return Ok(false);
    }
    match tx.list_items(&track_obj, field)?.iter().position(|o| o == object) {
        Some(index) => {
            tx.list_remove(&track_obj, field, index)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Diffs the clips of every track of one sequence. A track's list holds its clips in the engine's
/// order, by start (the engine also sorts them when it reads a track), so an index in it is a
/// place in time, which the premise guard follows: a clip gone from *every* track is deleted; a
/// new one is inserted at its place; one that sits on another track than before is moved there
/// (the same object: removed from its old track's list, inserted into the new one's at its
/// place); one that changed places with another on its track is moved in the list; and every
/// surviving clip is field-diffed and its own effects diffed in place.
fn diff_sequence_clips(tx: &mut Tx<'_>, before: &[&Track], after: &[&Track], ids: &mut Ids) -> KdmResult<bool> {
    let mut wrote = false;
    let mut was: HashMap<kition_film_project::ClipId, (kition_film_project::TrackId, &TrackItem)> = HashMap::new();
    for track in before {
        for clip in &track.items {
            was.insert(clip.id, (track.id, clip));
        }
    }
    let kept: std::collections::HashSet<kition_film_project::ClipId> = after.iter().flat_map(|t| t.items.iter().map(|c| c.id)).collect();
    for track in before {
        for clip in &track.items {
            if kept.contains(&clip.id) {
                continue;
            }
            let Some(object) = ids.clips.object(clip.id).cloned() else { continue };
            unlist(tx, Some(track.id), "clips", &object, ids)?;
            if tx.exists(&object) {
                tx.delete(&object)?;
            }
            ids.clips.remove(&object);
            wrote = true;
        }
    }
    for track in after {
        let Some(track_obj) = ids.tracks.object(track.id).cloned() else { continue };
        // The track's list holds its clips in the engine's order (by start), so a clip's index
        // is its place in time: a clip put before it, or moved past it, changes its index.
        let mut current = tx.list_items(&track_obj, "clips")?;
        for (index, clip) in track.items.iter().enumerate() {
            let known = ids.clips.object(clip.id).cloned().filter(|o| tx.exists(o));
            let (object, before_clip) = match (known, was.get(&clip.id)) {
                (Some(object), Some(&(from, before_clip))) => {
                    if from != track.id {
                        unlist(tx, Some(from), "clips", &object, ids)?;
                        tx.list_insert(&track_obj, "clips", index.min(current.len()), &object)?;
                        current.insert(index.min(current.len()), object.clone());
                        wrote = true;
                    } else if let Some(at) = current.iter().position(|o| o == &object)
                        && at != index
                        && index < current.len()
                    {
                        tx.list_move(&track_obj, "clips", at, index)?;
                        let moved = current.remove(at);
                        current.insert(index, moved);
                        wrote = true;
                    }
                    (object, before_clip)
                }
                // New, or (defensively) an id mapping `before` does not account for: a fresh
                // object, written whole, at its place in time.
                _ => {
                    let object = write_clip(tx, clip, ids)?;
                    tx.list_insert(&track_obj, "clips", index.min(current.len()), &object)?;
                    current.insert(index.min(current.len()), object);
                    wrote = true;
                    continue;
                }
            };
            wrote |= diff_clip_fields(tx, &object, before_clip, clip, ids)?;
            wrote |= diff_effects(tx, &object, "effects", &before_clip.effects, &clip.effects)?;
        }
    }
    Ok(wrote)
}

fn diff_clip_fields(tx: &mut Tx<'_>, object: &ObjectId, before: &TrackItem, after: &TrackItem, ids: &Ids) -> KdmResult<bool> {
    let mut wrote = false;
    if before.item != after.item {
        let item_obj = ids.items.object(after.item);
        tx.set(object, "item", json!(item_obj.map(ObjectId::as_str)))?;
        tx.set(object, "missingItem", json!(if item_obj.is_none() { Some(after.item.0) } else { None }))?;
        wrote = true;
    }
    if before.start != after.start {
        tx.set(object, "start", json!(tick::to_string(after.start)))?;
        wrote = true;
    }
    if before.duration != after.duration {
        tx.set(object, "duration", json!(tick::to_string(after.duration)))?;
        wrote = true;
    }
    if before.source_in != after.source_in {
        tx.set(object, "sourceIn", json!(tick::to_string(after.source_in)))?;
        wrote = true;
    }
    if before.speed != after.speed {
        tx.set(object, "speed", json!(after.speed))?;
        wrote = true;
    }
    if before.reverse != after.reverse {
        tx.set(object, "reverse", json!(after.reverse))?;
        wrote = true;
    }
    if before.link != after.link {
        tx.set(object, "link", json!(after.link.map(|v| v.to_string())))?;
        wrote = true;
    }
    if before.group != after.group {
        tx.set(object, "group", json!(after.group.map(|v| v.to_string())))?;
        wrote = true;
    }
    if before.gain_db != after.gain_db {
        tx.set(object, "gain", serde_json::to_value(props::ClipGain { gain_db: after.gain_db }).map_err(kdm_err)?)?;
        wrote = true;
    }
    if before.markers != after.markers {
        tx.set(object, "markers", serde_json::to_value(&after.markers).map_err(kdm_err)?)?;
        wrote = true;
    }
    let same_other = before.name == after.name
        && before.label == after.label
        && before.enabled == after.enabled
        && before.frame_hold == after.frame_hold
        && before.scale_to_frame == after.scale_to_frame
        && before.audio_mixing == after.audio_mixing
        && before.multicam == after.multicam
        && before.time_interpolation == after.time_interpolation
        && before.hold_filters == after.hold_filters
        && before.field_options == after.field_options
        && before.source_channels == after.source_channels
        && before.audio_stream == after.audio_stream
        && before.graphic == after.graphic;
    if !same_other {
        let props = props::ClipProps {
            name: after.name.clone(),
            label: after.label,
            enabled: after.enabled,
            frame_hold: after.frame_hold,
            scale_to_frame: after.scale_to_frame,
            audio_mixing: after.audio_mixing.clone(),
            multicam: after.multicam,
            time_interpolation: after.time_interpolation,
            hold_filters: after.hold_filters,
            field_options: after.field_options,
            source_channels: after.source_channels.clone(),
            audio_stream: after.audio_stream,
            graphic: after.graphic.clone(),
        };
        tx.set(object, "props", serde_json::to_value(props).map_err(kdm_err)?)?;
        wrote = true;
    }
    let _ = ids;
    Ok(wrote)
}

/// Deletes a transition object and the effect object it owns.
fn delete_transition(tx: &mut Tx<'_>, object: &ObjectId) -> KdmResult<()> {
    if !tx.exists(object) {
        return Ok(());
    }
    if let Value::String(effect) = tx.get(object, "effect")? {
        let effect = ObjectId::from_string(effect);
        if tx.exists(&effect) {
            tx.delete(&effect)?;
        }
    }
    tx.delete(object)
}

/// Diffs the transitions of every track of one sequence, exactly like [`diff_sequence_clips`]
/// (a transition that sits on another track than before is moved there, keeping its object).
fn diff_sequence_transitions(tx: &mut Tx<'_>, before: &[&Track], after: &[&Track], ids: &mut Ids) -> KdmResult<bool> {
    let mut wrote = false;
    let mut was: HashMap<kition_film_project::TransitionId, (kition_film_project::TrackId, &Transition)> = HashMap::new();
    for track in before {
        for transition in &track.transitions {
            was.insert(transition.id, (track.id, transition));
        }
    }
    let kept: std::collections::HashSet<kition_film_project::TransitionId> = after.iter().flat_map(|t| t.transitions.iter().map(|x| x.id)).collect();
    for track in before {
        for transition in &track.transitions {
            if kept.contains(&transition.id) {
                continue;
            }
            let Some(object) = ids.transitions.object(transition.id).cloned() else { continue };
            unlist(tx, Some(track.id), "transitions", &object, ids)?;
            delete_transition(tx, &object)?;
            ids.transitions.remove(&object);
            wrote = true;
        }
    }
    for track in after {
        let Some(track_obj) = ids.tracks.object(track.id).cloned() else { continue };
        for transition in &track.transitions {
            let known = ids.transitions.object(transition.id).cloned().filter(|o| tx.exists(o));
            let (object, before_t) = match (known, was.get(&transition.id)) {
                (Some(object), Some(&(from, before_t))) => {
                    if from != track.id {
                        unlist(tx, Some(from), "transitions", &object, ids)?;
                        let len = tx.list_items(&track_obj, "transitions")?.len();
                        tx.list_insert(&track_obj, "transitions", len, &object)?;
                        wrote = true;
                    }
                    (object, before_t)
                }
                _ => {
                    let fields = transition_fields(tx, transition, ids)?;
                    let object = tx.create("Transition", fields)?;
                    ids.transitions.insert(object.clone(), transition.id);
                    let len = tx.list_items(&track_obj, "transitions")?.len();
                    tx.list_insert(&track_obj, "transitions", len, &object)?;
                    wrote = true;
                    continue;
                }
            };
            wrote |= diff_transition_fields(tx, &object, before_t, transition, ids)?;
        }
    }
    Ok(wrote)
}

fn diff_transition_fields(tx: &mut Tx<'_>, object: &ObjectId, before: &Transition, after: &Transition, ids: &Ids) -> KdmResult<bool> {
    let mut wrote = false;
    let (before_def, before_params) = props::effect_def_and_params(&before.effect)?;
    let (after_def, after_params) = props::effect_def_and_params(&after.effect)?;
    if (before_def != after_def || before_params != after_params)
        && let Value::String(effect_obj) = tx.get(object, "effect")?
    {
        let effect_obj = ObjectId::from_string(effect_obj);
        tx.set(&effect_obj, "def", json!(after_def))?;
        tx.set(&effect_obj, "params", after_params)?;
        wrote = true;
    }
    if before.start != after.start {
        tx.set(object, "start", json!(tick::to_string(after.start)))?;
        wrote = true;
    }
    if before.duration != after.duration {
        tx.set(object, "duration", json!(tick::to_string(after.duration)))?;
        wrote = true;
    }
    if before.from != after.from {
        tx.set(object, "from", json!(after.from.and_then(|c| ids.clips.object(c)).map(ObjectId::as_str)))?;
        wrote = true;
    }
    if before.to != after.to {
        tx.set(object, "to", json!(after.to.and_then(|c| ids.clips.object(c)).map(ObjectId::as_str)))?;
        wrote = true;
    }
    if before.align != after.align {
        tx.set(object, "align", json!(align_str(after.align)))?;
        wrote = true;
    }
    if before.reverse != after.reverse {
        tx.set(object, "reverse", json!(after.reverse))?;
        wrote = true;
    }
    Ok(wrote)
}

/// Diffs an ordered list field whose elements have no engine-given identity (`EffectInstance` is
/// Vec-indexed in the engine): an insert, removal or reorder must still keep every surviving
/// effect's own object, or a concurrent param edit on another replica (which names the object, not
/// the index) targets one this edit just deleted and loses it. The common case — only
/// params/enabled/masks changed, nothing inserted/removed/reordered — is diffed object by object
/// in place (the fast path, unchanged). Any other shape is aligned, not rewritten: a pair matched
/// by [`lcs_match`] (identical def *and* params, in order) needs no write at all; a pair left over
/// is then matched by effect definition id, in order (an edited effect — same def, changed params
/// — keeps its object); whatever is still unmatched after both passes is a real insert or delete.
/// Matched objects are moved with `tx.list_move` only when their relative order actually changed.
fn diff_effects(tx: &mut Tx<'_>, owner: &ObjectId, field: &str, before: &[EffectInstance], after: &[EffectInstance]) -> KdmResult<bool> {
    // Compared as the JSON this crate would write, not as the Rust structs: an "auto" point is
    // `f64::NAN`, never equal to itself under `==`, but always the same `null` once serialized,
    // so every freshly placed clip's intrinsic Motion effect would otherwise look "changed" on
    // every edit that touches nothing about it at all.
    let before_values: Vec<Value> =
        before.iter().map(props::effect_def_and_params).map(|r| r.map(|(def, params)| json!({ "def": def, "params": params }))).collect::<KdmResult<_>>()?;
    let after_values: Vec<Value> =
        after.iter().map(props::effect_def_and_params).map(|r| r.map(|(def, params)| json!({ "def": def, "params": params }))).collect::<KdmResult<_>>()?;
    if before_values == after_values {
        return Ok(false);
    }
    let existing = tx.list_items(owner, field)?;
    let same_shape = before.len() == after.len() && existing.len() == before.len() && before.iter().zip(after).all(|(b, a)| b.effect == a.effect);
    if same_shape {
        let mut wrote = false;
        for ((before_value, after_value), object) in before_values.iter().zip(after_values.iter()).zip(existing.iter()) {
            if before_value == after_value {
                continue;
            }
            tx.set(object, "def", after_value["def"].clone())?;
            tx.set(object, "params", after_value["params"].clone())?;
            wrote = true;
        }
        return Ok(wrote);
    }
    // Defensive: the live list's shape does not match `before` at all (should never happen —
    // every caller diffs against the state it last wrote). Aligning against it would mis-attribute
    // objects, so fall back to the old, always-correct rewrite instead of guessing.
    if existing.len() != before.len() {
        for index in (0..existing.len()).rev() {
            tx.delete(&existing[index])?;
            tx.list_remove(owner, field, index)?;
        }
        for (index, effect) in after.iter().enumerate() {
            let (def, params) = props::effect_def_and_params(effect)?;
            let object = tx.create("Effect", fields(json!({ "def": def, "params": params })))?;
            tx.list_insert(owner, field, index, &object)?;
        }
        return Ok(true);
    }

    let n_before = before.len();
    let n_after = after.len();
    let mut match_before: Vec<Option<usize>> = vec![None; n_before];
    let mut match_after: Vec<Option<usize>> = vec![None; n_after];

    // Pass 1: the longest common subsequence by exact (def, params) equality — an effect
    // untouched by this edit, wherever the edit moved the others around it. Capped: this table is
    // O(n*m), and an effect list is never remotely this long in practice, but it is still
    // attacker-reachable project data.
    if n_before.saturating_mul(n_after) <= 1_000_000 {
        lcs_match(&before_values, &after_values, &mut match_before, &mut match_after);
    }

    // Pass 2: whatever pass 1 left unmatched, paired up by effect definition id in list order —
    // an effect edited (not moved, inserted or removed) keeps its object even though its params
    // did change.
    let mut remaining_before_by_def: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, effect) in before.iter().enumerate() {
        if match_before[i].is_none() {
            remaining_before_by_def.entry(effect.effect.as_str()).or_default().push(i);
        }
    }
    for (j, effect) in after.iter().enumerate() {
        if match_after[j].is_some() {
            continue;
        }
        if let Some(queue) = remaining_before_by_def.get_mut(effect.effect.as_str())
            && !queue.is_empty()
        {
            let i = queue.remove(0);
            match_before[i] = Some(j);
            match_after[j] = Some(i);
        }
    }

    // Unmatched `before` entries are gone: delete their objects and remove them from the live
    // list, highest index first so earlier indices stay valid. What is left in `current` is every
    // matched object, still in `before`'s relative order.
    let mut current: Vec<ObjectId> = existing.clone();
    for i in (0..n_before).rev() {
        if match_before[i].is_none() {
            tx.delete(&existing[i])?;
            tx.list_remove(owner, field, i)?;
            current.remove(i);
        }
    }
    let matched_objects: Vec<(usize, ObjectId)> = (0..n_before).filter(|i| match_before[*i].is_some()).zip(current.iter().cloned()).collect();

    // Walk the target (`after`) order left to right, placing the right object (or a freshly
    // created one) at each position: a matched object already there needs no move; one that sits
    // elsewhere in `current` is moved there with `tx.list_move` (mirrored into `current` so the
    // next position's lookup stays accurate); an unmatched `after` entry is a real insert.
    for j in 0..n_after {
        match match_after[j] {
            Some(before_index) => {
                let object = matched_objects
                    .iter()
                    .find(|(i, _)| *i == before_index)
                    .map(|(_, o)| o.clone())
                    .ok_or_else(|| kdm_err("diff_effects: a matched effect has no object"))?;
                if before_values[before_index] != after_values[j] {
                    tx.set(&object, "def", after_values[j]["def"].clone())?;
                    tx.set(&object, "params", after_values[j]["params"].clone())?;
                }
                let current_index =
                    current.iter().position(|o| o == &object).ok_or_else(|| kdm_err("diff_effects: a matched effect's object is not in the live list"))?;
                if current_index != j {
                    tx.list_move(owner, field, current_index, j)?;
                    let moved = current.remove(current_index);
                    current.insert(j, moved);
                }
            }
            None => {
                let (def, params) = props::effect_def_and_params(&after[j])?;
                let object = tx.create("Effect", fields(json!({ "def": def, "params": params })))?;
                tx.list_insert(owner, field, j, &object)?;
                current.insert(j, object);
            }
        }
    }
    Ok(true)
}

/// The longest common subsequence of `before`/`after` by exact value equality, recording each
/// matched pair's partner on both sides (indices preserved in order on both sides, as any LCS
/// guarantees). Leaves an element's slot `None` when it matches nothing.
fn lcs_match(before: &[Value], after: &[Value], match_before: &mut [Option<usize>], match_after: &mut [Option<usize>]) {
    let n = before.len();
    let m = after.len();
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if before[i] == after[j] { dp[i + 1][j + 1] + 1 } else { dp[i + 1][j].max(dp[i][j + 1]) };
        }
    }
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if before[i] == after[j] {
            match_before[i] = Some(j);
            match_after[j] = Some(i);
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
}
