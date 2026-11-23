//! Deterministic repair after a merge, an undo/redo, or an import ([`KitModel::validate`]):
//! dropping dangling list entries, clips/transitions left invalid by a concurrent edit, and
//! orphaned subclips, then de-overlapping each track. Every replica runs the exact same steps
//! over the same merged state, so they all write the same repair.

use std::collections::BTreeSet;

use kition_kit::kdm::{KdmError, ObjectId, Tx};
use serde_json::{Value, json};

use crate::tick;

type KdmResult<T> = Result<T, KdmError>;

pub(crate) fn validate(tx: &mut Tx<'_>, _changed: &BTreeSet<ObjectId>) -> KdmResult<bool> {
    let mut wrote = root_bins(tx)?;

    // A subclip whose parent item no longer exists: never read back as a working item (see
    // `read::resolve_item_props`), so it is dropped outright.
    for item in tx.objects_of_type("Item") {
        if tx.get(&item, "kind")?.as_str() != Some("subclip") {
            continue;
        }
        let props = tx.get(&item, "props")?;
        let parent = props.get("parent").and_then(Value::as_str);
        if let Some(parent) = parent
            && !tx.exists(&ObjectId::from_string(parent))
        {
            tx.delete(&item)?;
            wrote = true;
        }
    }

    for bin in tx.objects_of_type("Bin") {
        wrote |= clean_dangling(tx, &bin, "entries")?;
    }

    wrote |= keep_one_listing(tx, "clips")?;
    wrote |= keep_one_listing(tx, "transitions")?;

    for track in tx.objects_of_type("Track") {
        wrote |= clean_dangling(tx, &track, "clips")?;
        wrote |= remove_clips_with_gone_item(tx, &track)?;
        wrote |= repair_overlaps(tx, &track)?;
        wrote |= clean_dangling(tx, &track, "transitions")?;
        wrote |= remove_bad_transitions(tx, &track)?;
        wrote |= order_at_start(tx, &track, "clips")?;
        wrote |= order_at_start(tx, &track, "transitions")?;
        wrote |= clean_dangling(tx, &track, "effects")?;
    }

    for clip in tx.objects_of_type("Clip") {
        wrote |= clean_dangling(tx, &clip, "effects")?;
        wrote |= clean_dangling(tx, &clip, "markers")?;
    }

    for sequence in tx.objects_of_type("Sequence") {
        for field in ["videoTracks", "audioTracks", "submixTracks", "captionTracks", "markers", "masterEffects"] {
            wrote |= clean_dangling(tx, &sequence, field)?;
        }
    }
    for item in tx.objects_of_type("Item") {
        wrote |= clean_dangling(tx, &item, "markers")?;
    }
    for graphic in tx.objects_of_type("SourceGraphic") {
        wrote |= clean_dangling(tx, &graphic, "layers")?;
    }
    for field in ["luts", "searchBins"] {
        wrote |= clean_dangling(tx, &crate::project_id(), field)?;
    }

    wrote |= number_objects(tx)?;
    wrote |= number_data(tx)?;

    // Tree nodes naming a deleted bin need no write here: `Replica::tree` (and this crate's own
    // `read::read_bin_tree`) already skip a node whose object no longer exists, together with its
    // subtree, so they are already absent from every loaded view.
    Ok(wrote)
}

/// The file format has one root bin. Preserve extra model roots as its children.
fn root_bins(tx: &mut Tx<'_>) -> KdmResult<bool> {
    let project = crate::project_id();
    let entries = tx.tree(&project, "bins")?;
    let Some(root) = entries.iter().find(|entry| entry.object == crate::root_bin_id()) else { return Ok(false) };
    let mut wrote = false;
    if root.parent.is_some() {
        tx.tree_move(&project, "bins", &root.node, None)?;
        wrote = true;
    }
    for entry in &entries {
        if entry.node != root.node && entry.parent.is_none() {
            tx.tree_move(&project, "bins", &entry.node, Some(&root.node))?;
            wrote = true;
        }
    }
    Ok(wrote)
}

/// The engine stores clips and transitions chronologically; list order alone is no edit.
fn order_at_start(tx: &mut Tx<'_>, track: &ObjectId, field: &str) -> KdmResult<bool> {
    let mut current = tx.list_items(track, field)?;
    let mut wanted = Vec::with_capacity(current.len());
    for object in &current {
        wanted.push((object.clone(), tick::from_value(&tx.get(object, "start")?)?));
    }
    wanted.sort_by_key(|(_, start)| *start);
    let mut wrote = false;
    for (index, (object, _)) in wanted.iter().enumerate() {
        if current.get(index) == Some(object) {
            continue;
        }
        if let Some(from) = current.iter().position(|candidate| candidate == object) {
            tx.list_move(track, field, from, index)?;
            current.remove(from);
            current.insert(index, object.clone());
            wrote = true;
        }
    }
    Ok(wrote)
}

/// A clip (or transition) moves between tracks as the same object, so two peers that moved one
/// clip to two different tracks at once leave it listed on both after the merge. Keeps the first
/// listing in track-object-id order (the same on every replica) and drops the others, so the clip
/// is never read twice.
fn keep_one_listing(tx: &mut Tx<'_>, field: &str) -> KdmResult<bool> {
    let mut tracks = tx.objects_of_type("Track");
    tracks.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    let mut seen = std::collections::HashSet::new();
    let mut wrote = false;
    for track in &tracks {
        let items = tx.list_items(track, field)?;
        let mut drop = Vec::new();
        for (index, object) in items.iter().enumerate() {
            if !seen.insert(object.clone()) {
                drop.push(index);
            }
        }
        for index in drop.into_iter().rev() {
            tx.list_remove(track, field, index)?;
            wrote = true;
        }
    }
    Ok(wrote)
}

/// Removes list entries naming an object that no longer exists.
fn clean_dangling(tx: &mut Tx<'_>, owner: &ObjectId, field: &str) -> KdmResult<bool> {
    let items = tx.list_items(owner, field)?;
    let mut wrote = false;
    for (index, object) in items.iter().enumerate().rev() {
        if !tx.exists(object) {
            tx.list_remove(owner, field, index)?;
            wrote = true;
        }
    }
    Ok(wrote)
}

/// Removes a track's clips whose `item` no longer exists (or never resolved).
fn remove_clips_with_gone_item(tx: &mut Tx<'_>, track: &ObjectId) -> KdmResult<bool> {
    let clips = tx.list_items(track, "clips")?;
    let mut wrote = false;
    for (index, clip) in clips.iter().enumerate().rev() {
        let source_exists = tx.get(clip, "item")?.as_str().is_some_and(|item| tx.exists(&ObjectId::from_string(item)));
        // A source already absent in the file stays offline, with its original id.
        if tx.get(clip, "missingItem")?.as_u64().is_some() {
            if source_exists {
                tx.set(clip, "missingItem", serde_json::Value::Null)?;
                wrote = true;
            }
            continue;
        }
        if !source_exists {
            tx.delete(clip)?;
            tx.list_remove(track, "clips", index)?;
            wrote = true;
        }
    }
    Ok(wrote)
}

/// Orders a track's clips by `(start, objectId)` and, where a clip would start before the
/// previous one ends, moves it to start exactly there — pushing every later clip in the same
/// left-to-right sweep, so one pass is enough regardless of how many clips a concurrent ripple
/// insert overlapped.
fn repair_overlaps(tx: &mut Tx<'_>, track: &ObjectId) -> KdmResult<bool> {
    let clips = tx.list_items(track, "clips")?;
    let mut info = Vec::with_capacity(clips.len());
    for clip in &clips {
        let start = tick::from_value(&tx.get(clip, "start")?)?.0;
        let duration = tick::from_value(&tx.get(clip, "duration")?)?.0;
        info.push((clip.clone(), start, duration));
    }
    info.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.as_str().cmp(b.0.as_str())));

    let mut wrote = false;
    let mut cursor: Option<i64> = None;
    for (object, start, duration) in info {
        let new_start = match cursor {
            Some(cursor) if start < cursor => cursor,
            _ => start,
        };
        if new_start != start {
            tx.set(&object, "start", json!(new_start.to_string()))?;
            wrote = true;
        }
        cursor = Some(new_start.saturating_add(duration.max(0)));
    }
    Ok(wrote)
}

/// Removes a track's transitions whose `from`/`to` clip is gone, or (when both are set) no
/// longer adjacent in start order — the repair above may have moved either clip.
fn remove_bad_transitions(tx: &mut Tx<'_>, track: &ObjectId) -> KdmResult<bool> {
    let clips = tx.list_items(track, "clips")?;
    let mut ordered = Vec::with_capacity(clips.len());
    for clip in &clips {
        let start = tick::from_value(&tx.get(clip, "start")?)?.0;
        ordered.push((clip.clone(), start));
    }
    ordered.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.as_str().cmp(b.0.as_str())));
    let order: Vec<ObjectId> = ordered.into_iter().map(|(object, _)| object).collect();
    let position = |object: &ObjectId| order.iter().position(|candidate| candidate == object);

    let transitions = tx.list_items(track, "transitions")?;
    let mut wrote = false;
    for (index, transition) in transitions.iter().enumerate().rev() {
        let from = match tx.get(transition, "from")? {
            Value::String(s) => Some(ObjectId::from_string(s)),
            _ => None,
        };
        let to = match tx.get(transition, "to")? {
            Value::String(s) => Some(ObjectId::from_string(s)),
            _ => None,
        };
        let side_ok = |side: &Option<ObjectId>| side.as_ref().map(|o| tx.exists(o) && position(o).is_some()).unwrap_or(true);
        let adjacent = match (&from, &to) {
            (Some(from), Some(to)) => matches!((position(from), position(to)), (Some(pf), Some(pt)) if pt == pf + 1),
            _ => true,
        };
        if !side_ok(&from) || !side_ok(&to) || !adjacent {
            if let Value::String(effect) = tx.get(transition, "effect")? {
                tx.delete(&ObjectId::from_string(effect))?;
            }
            tx.delete(transition)?;
            tx.list_remove(track, "transitions", index)?;
            wrote = true;
        }
    }
    Ok(wrote)
}

/// The objects that keep an engine id as data in their `id` field.
const DATA_TYPES: [&str; 4] = ["Marker", "CaptionTrack", "Caption", "SearchBin"];

/// Gives every marker, caption track, caption and search bin without an id (one a batch or a
/// collaborator made) one past every id the replica holds, in object-id order, so every replica
/// writes the same ids. Ids two objects share are left as they are, as the engine leaves them.
fn number_data(tx: &mut Tx<'_>) -> KdmResult<bool> {
    let mut next = 0u64;
    let mut missing = Vec::new();
    for (ty, field) in crate::read::ID_FIELDS.iter().copied().chain(DATA_TYPES.iter().map(|ty| (*ty, "id"))) {
        for object in tx.objects_of_type(ty) {
            match crate::read::stored_id(&tx.get(&object, field)?) {
                Some(id) => next = next.max(id),
                None if field == "id" => missing.push(object),
                None => {}
            }
        }
    }
    missing.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    let wrote = !missing.is_empty();
    for object in missing {
        next = next.saturating_add(1);
        tx.set(&object, "id", json!(next))?;
    }
    Ok(wrote)
}

/// Gives every bin, item, track, clip and transition an id in its tool id field (KitObjectModel
/// OM9) when it has none (an object a batch or a collaborator created) or shares one with another
/// object (two replicas that each made an object with the same id): past every id the replica
/// holds, in object-id order, so every replica writes the same ids. The first object holding an
/// id, in that order, keeps it.
fn number_objects(tx: &mut Tx<'_>) -> KdmResult<bool> {
    let mut objects: Vec<(ObjectId, &'static str, Option<u64>)> = Vec::new();
    for (ty, field) in crate::read::ID_FIELDS {
        for object in tx.objects_of_type(ty) {
            let id = crate::read::stored_id(&tx.get(&object, field)?);
            objects.push((object, field, id));
        }
    }
    objects.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
    let mut next = objects.iter().filter_map(|(_, _, id)| *id).max().unwrap_or(0);
    let mut seen = std::collections::HashSet::new();
    let mut wrote = false;
    for (object, field, id) in objects {
        if let Some(id) = id
            && seen.insert(id)
        {
            continue;
        }
        next = next.saturating_add(1);
        seen.insert(next);
        tx.set(&object, field, json!(next))?;
        wrote = true;
    }
    Ok(wrote)
}
