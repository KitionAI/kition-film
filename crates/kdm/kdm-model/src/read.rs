//! Replica -> `Project`: rebuilds the engine's project model from a committed replica.

use std::collections::HashSet;

use kition_film_project::{Bin, BinEntry, BinId, ClipId, ItemId, ItemKind, Project, ProjectItem, Sequence, Track, TrackId, TransitionId};
use kition_kit::kdm::{KdmError, ObjectId, Replica, TreeEntry};
use kition_kit::session::BlobSource;
use serde_json::Value;

use crate::ids::{Ids, Known};
use crate::{Nodes, kdm_err, objects, project_id, props, root_bin_id, tick};

type KdmResult<T> = Result<T, KdmError>;

fn as_str(value: &Value, what: &str) -> KdmResult<String> {
    value.as_str().map(str::to_owned).ok_or_else(|| kdm_err(format!("`{what}` is not a string")))
}

/// The read-only field holding each tracked type's id, its tool id (KitObjectModel OM9): the id
/// the engine gave the object, as the `.kfilm` file stores it and `film_inspect` lists it.
pub(crate) const ID_FIELDS: [(&str, &str); 5] =
    [("Bin", "binId"), ("Item", "itemId"), ("Track", "trackId"), ("Clip", "clipId"), ("Transition", "transitionId")];

/// The id an object's tool id field holds, if any.
pub(crate) fn stored_id(value: &Value) -> Option<u64> {
    value.as_u64()
}

/// Gives every object this crate tracks a local id: the id its tool id field holds (the file's
/// id, so every replica reads an object with the id its tool id names), else the one a view gave
/// it before (`known`), else a fresh one past every id the replica stores or the view knows, so
/// a fresh id never takes one an object of any type has. An id is given once per type.
#[derive(Default)]
struct Mint {
    stored: std::collections::HashMap<ObjectId, u64>,
    next: u64,
    bins: HashSet<BinId>,
    items: HashSet<ItemId>,
    tracks: HashSet<TrackId>,
    clips: HashSet<ClipId>,
    transitions: HashSet<TransitionId>,
    /// Ids kept as data (markers, caption tracks, captions, search bins).
    data: HashSet<u64>,
}

fn mint<L: Copy + Eq + std::hash::Hash>(
    object: &ObjectId,
    stored: Option<u64>,
    known: &std::collections::HashMap<ObjectId, L>,
    taken: &mut HashSet<L>,
    next: &mut u64,
    make: impl Fn(u64) -> L,
) -> L {
    if let Some(id) = stored.map(&make)
        && taken.insert(id)
    {
        return id;
    }
    if let Some(&id) = known.get(object)
        && taken.insert(id)
    {
        return id;
    }
    loop {
        *next = next.saturating_add(1);
        let id = make(*next);
        if taken.insert(id) || *next == u64::MAX {
            return id;
        }
    }
}

impl Mint {
    fn new(replica: &Replica, known: &Known) -> Self {
        let mut stored = std::collections::HashMap::new();
        for (ty, field) in ID_FIELDS {
            for object in replica.objects_of_type(ty) {
                if let Some(id) = replica.get(&object, field).ok().as_ref().and_then(stored_id) {
                    stored.insert(object, id);
                }
            }
        }
        let known_max = known
            .bins
            .values()
            .map(|id| id.0)
            .chain(known.items.values().map(|id| id.0))
            .chain(known.tracks.values().map(|id| id.0))
            .chain(known.clips.values().map(|id| id.0))
            .chain(known.transitions.values().map(|id| id.0))
            .max()
            .unwrap_or(0);
        let next = stored.values().copied().max().unwrap_or(0).max(known_max);
        Self { stored, next, ..Self::default() }
    }
    fn bin(&mut self, object: &ObjectId, known: &Known) -> BinId {
        mint(object, self.stored.get(object).copied(), &known.bins, &mut self.bins, &mut self.next, BinId)
    }
    fn item(&mut self, object: &ObjectId, known: &Known) -> ItemId {
        mint(object, self.stored.get(object).copied(), &known.items, &mut self.items, &mut self.next, ItemId)
    }
    fn track(&mut self, object: &ObjectId, known: &Known) -> TrackId {
        mint(object, self.stored.get(object).copied(), &known.tracks, &mut self.tracks, &mut self.next, TrackId)
    }
    fn clip(&mut self, object: &ObjectId, known: &Known) -> ClipId {
        mint(object, self.stored.get(object).copied(), &known.clips, &mut self.clips, &mut self.next, ClipId)
    }
    fn transition(&mut self, object: &ObjectId, known: &Known) -> TransitionId {
        mint(object, self.stored.get(object).copied(), &known.transitions, &mut self.transitions, &mut self.next, TransitionId)
    }
    /// The id of an object that keeps an engine id as data (`stored`, its `id` field), or, when it
    /// has none yet (a batch made it and the repair has not numbered it), a fresh one past every
    /// id the replica holds.
    fn data(&mut self, stored: Option<u64>) -> u64 {
        if let Some(id) = stored {
            self.data.insert(id);
            return id;
        }
        loop {
            self.next = self.next.saturating_add(1);
            if (!self.data.contains(&self.next) && self.data.insert(self.next)) || self.next == u64::MAX {
                return self.next;
            }
        }
    }
}

/// Rebuilds the whole project from a committed replica, minting a fresh local id for every object.
/// The LUTs' file text is read from `blobs`.
pub fn read_document(replica: &Replica, blobs: &dyn BlobSource) -> KdmResult<(Project, Ids, Nodes)> {
    read_document_known(replica, &Known::default(), blobs)
}

/// [`read_document`], but an object a view has already given a local id (`known`) keeps it, so a
/// reload (after an undo, a redo or an import) does not change the ids a session's own state (the
/// active sequence, a selection) names.
///
/// A replica made on another schema version is refused, never read: there is no migration, so a
/// project whose replica an earlier build made is opened again from its `.kfilm` file.
pub fn read_document_known(replica: &Replica, known: &Known, blobs: &dyn BlobSource) -> KdmResult<(Project, Ids, Nodes)> {
    let made = replica.min_schema_version();
    let reads = replica.schema().schema_version;
    if made != reads {
        return Err(kdm_err(format!(
            "this replica was made on schema {made} by another version of the Film kit, which reads schema {reads} only: open the project's .kfilm file instead"
        )));
    }
    let proj = project_id();
    let name = as_str(&replica.get(&proj, "name")?, "name")?;
    let settings: kition_film_project::ProjectSettings = serde_json::from_value(replica.get(&proj, "settings")?).map_err(kdm_err)?;

    let mut project = Project::new(&name);
    project.settings = settings;

    let mut ids = Ids::default();
    let mut nodes = Nodes::default();
    let mut mint = Mint::new(replica, known);

    let (root, root_object) = read_bin_tree(replica, &proj, known, &mut mint, &mut ids, &mut nodes)?;
    project.root = root;

    read_items(replica, &mut project, known, &mut mint, &mut ids)?;
    for item in std::mem::take(&mut project.items).into_values() {
        let mut resolved = resolve_item_props(replica, item, &ids)?;
        if let Some(object) = ids.items.object(resolved.id).cloned() {
            if let ItemKind::Media(media) = &mut resolved.kind {
                media.markers = objects::read_markers(replica, &object, "markers", &mut |_, stored| mint.data(stored))?;
            }
            if let Some(transcript) = objects::read_transcript(replica, &object)? {
                project.transcripts.insert(resolved.id, std::sync::Arc::new(transcript));
            }
            if let Some(graphic) = objects::read_source_graphic(replica, &object)? {
                project.source_graphics.insert(resolved.id, graphic);
            }
        }
        project.items.insert(resolved.id, resolved);
    }
    read_bin_entries(replica, &root_object, &mut project.root, &ids)?;

    let item_objects: Vec<(ItemId, ObjectId)> =
        project.items.keys().copied().filter_map(|id| ids.items.object(id).map(|object| (id, object.clone()))).collect();

    for (id, object) in &item_objects {
        let Value::String(seq_ref) = replica.get(object, "sequence")? else { continue };
        let seq_object = ObjectId::from_string(seq_ref);
        let sequence = read_sequence_tracks(replica, &seq_object, known, &mut mint, &mut ids)?;
        if let Some(item) = project.items.get_mut(id) {
            item.kind = ItemKind::Sequence(Box::new(sequence));
        }
    }
    for (id, object) in &item_objects {
        let Value::String(seq_ref) = replica.get(object, "sequence")? else { continue };
        let seq_object = ObjectId::from_string(seq_ref);
        let Some(ProjectItem { kind: ItemKind::Sequence(seq), .. }) = project.items.get_mut(id) else { continue };
        read_sequence_transitions(replica, &seq_object, seq, known, &mut mint, &mut ids)?;
        props::apply_sequence_settings(seq, replica.get(&seq_object, "settings")?, &ids)?;
        apply_sequence_extras(replica, &seq_object, seq, &mut mint)?;
    }

    project.luts = objects::read_luts(replica, &proj, blobs)?;
    project.search_bins = objects::read_search_bins(replica, &proj, &mut |_, stored| mint.data(stored))?;
    project.next_id = crate::session::next_id_hint(&project, crate::session::slot_base(replica.actor()));
    Ok((project, ids, nodes))
}

/// Reads `Project.bins` and builds the `Bin` tree, minting a local `BinId` for every object.
/// Returns the root bin and its object id. A replica this crate wrote always has exactly one
/// root, named [`root_bin_id`]; anything else (corrupt or foreign data) falls back to an empty
/// root rather than crashing.
fn read_bin_tree(replica: &Replica, proj: &ObjectId, known: &Known, mint: &mut Mint, ids: &mut Ids, nodes: &mut Nodes) -> KdmResult<(Bin, ObjectId)> {
    let entries = replica.tree(proj, "bins")?;
    let mut children_of: Vec<Vec<usize>> = vec![Vec::new(); entries.len()];
    let mut root_index = None;
    for (index, entry) in entries.iter().enumerate() {
        match &entry.parent {
            None => {
                if entry.object == root_bin_id() || root_index.is_none() {
                    root_index = Some(index);
                }
            }
            Some(parent) => {
                if let Some(parent_index) = entries.iter().position(|candidate| &candidate.node == parent) {
                    children_of[parent_index].push(index);
                }
            }
        }
    }

    let Some(root_index) = root_index else {
        return Ok((Bin { id: BinId(0), name: "Root".into(), children: Vec::new() }, root_bin_id()));
    };

    #[allow(clippy::too_many_arguments)]
    fn build(
        index: usize,
        entries: &[TreeEntry],
        children_of: &[Vec<usize>],
        replica: &Replica,
        known: &Known,
        mint: &mut Mint,
        ids: &mut Ids,
        nodes: &mut Nodes,
        depth: usize,
    ) -> KdmResult<Bin> {
        if depth > 64 {
            return Err(kdm_err("bin tree nested too deep"));
        }
        let entry = &entries[index];
        let object = entry.object.clone();
        let id = mint.bin(&object, known);
        ids.bins.insert(object.clone(), id);
        nodes.insert(object.clone(), entry.node.clone());
        let name = as_str(&replica.get(&object, "name")?, "name")?;
        let mut children = Vec::new();
        for &child_index in &children_of[index] {
            if !replica.exists(&entries[child_index].object) {
                continue;
            }
            children.push(BinEntry::Bin(build(child_index, entries, children_of, replica, known, mint, ids, nodes, depth + 1)?));
        }
        Ok(Bin { id, name, children })
    }

    let root = build(root_index, &entries, &children_of, replica, known, mint, ids, nodes, 0)?;
    let root_object = entries[root_index].object.clone();
    Ok((root, root_object))
}

/// Appends each bin's items (`entries`, in list order) after its sub-bins (already built by
/// [`read_bin_tree`]); the engine's single `BinEntry` list interleaves the two in whatever order a
/// person dragged them, which this crate does not reproduce exactly — a deliberate, documented
/// simplification (see the crate's implementation report), never a lost bin or item.
fn read_bin_entries(replica: &Replica, bin_object: &ObjectId, bin: &mut Bin, ids: &Ids) -> KdmResult<()> {
    let mut items = Vec::new();
    for object in replica.list(bin_object, "entries")? {
        if !replica.exists(&object) {
            continue;
        }
        if let Some(id) = ids.items.local(&object) {
            items.push(BinEntry::Item(id));
        }
    }
    bin.children.extend(items);
    for entry in &mut bin.children {
        if let BinEntry::Bin(child) = entry {
            let Some(child_object) = ids.bins.object(child.id).cloned() else { continue };
            read_bin_entries(replica, &child_object, child, ids)?;
        }
    }
    Ok(())
}

/// Mints every `Item` object a local id and a placeholder entry (kind-correct shape, common
/// fields still default), so every `ItemId` exists before [`resolve_item_props`] resolves a
/// subclip's `parent`.
fn read_items(replica: &Replica, project: &mut Project, known: &Known, mint: &mut Mint, ids: &mut Ids) -> KdmResult<()> {
    for object in replica.objects_of_type("Item") {
        let id = mint.item(&object, known);
        ids.items.insert(object.clone(), id);
        let kind_str = as_str(&replica.get(&object, "kind")?, "kind")?;
        let item = ProjectItem {
            id,
            name: as_str(&replica.get(&object, "name")?, "name")?,
            label: kition_film_project::Label::Iris,
            kind: placeholder_kind(&kind_str)?,
            metadata: Default::default(),
            created: 0,
            split: Default::default(),
        };
        project.items.insert(id, item);
    }
    Ok(())
}

fn placeholder_kind(kind: &str) -> KdmResult<ItemKind> {
    Ok(match kind {
        "media" | "sequence" | "subclip" => ItemKind::Sequence(Box::new(empty_sequence())),
        "adjustment" => ItemKind::AdjustmentLayer { width: 1, height: 1, rate: kition_film_time::FrameRate::FPS_24, duration: kition_film_time::Tick(1) },
        "graphic" => ItemKind::Graphic { width: 1, height: 1, rate: kition_film_time::FrameRate::FPS_24 },
        other => return Err(kdm_err(format!("unknown item kind `{other}`"))),
    })
}

fn empty_sequence() -> Sequence {
    Sequence {
        settings: Default::default(),
        video_tracks: Vec::new(),
        audio_tracks: Vec::new(),
        markers: Vec::new(),
        mark_in: None,
        mark_out: None,
        work_area: None,
        start_timecode: 0,
        master_volume_db: 0.0,
        master_effects: Vec::new(),
        master_mixer: Default::default(),
        submix_tracks: Vec::new(),
        caption_tracks: Vec::new(),
        multicam: None,
        merged: None,
        split: Default::default(),
    }
}

/// Replaces an item's placeholder kind/common fields with its real `props`, now that every item
/// has an id (so a subclip's `parent` resolves through `ids`). A subclip whose parent no longer
/// resolves keeps `ItemId(0)` (never an id `Project::alloc_id` gives out): `KitModel::validate`
/// repairs it away; until then the item round-trips without a working parent rather than vanishing
/// or panicking.
fn resolve_item_props(replica: &Replica, mut item: ProjectItem, ids: &Ids) -> KdmResult<ProjectItem> {
    let Some(object) = ids.items.object(item.id).cloned() else { return Ok(item) };
    let kind_str = as_str(&replica.get(&object, "kind")?, "kind")?;
    let props_value = replica.get(&object, "props")?;
    match kind_str.as_str() {
        "media" => {
            let parsed: props::MediaProps = serde_json::from_value(props_value).map_err(kdm_err)?;
            apply_common(&mut item, parsed.common);
            item.kind = ItemKind::Media(parsed.media);
        }
        "sequence" => {
            let parsed: props::SequenceItemProps = serde_json::from_value(props_value).map_err(kdm_err)?;
            apply_common(&mut item, parsed.common);
            item.kind = ItemKind::Sequence(Box::new(empty_sequence()));
        }
        "subclip" => {
            let parsed: props::SubclipProps = serde_json::from_value(props_value).map_err(kdm_err)?;
            apply_common(&mut item, parsed.common);
            let parent = parsed.parent.and_then(|object| ids.items.local(&ObjectId::from_string(object))).unwrap_or(ItemId(0));
            item.kind = ItemKind::Subclip { parent, range: parsed.range, restrict_trims: parsed.restrict_trims };
        }
        "adjustment" => {
            let parsed: props::AdjustmentProps = serde_json::from_value(props_value).map_err(kdm_err)?;
            apply_common(&mut item, parsed.common);
            item.kind = ItemKind::AdjustmentLayer { width: parsed.width, height: parsed.height, rate: parsed.rate, duration: parsed.duration };
        }
        "graphic" => {
            let parsed: props::GraphicProps = serde_json::from_value(props_value).map_err(kdm_err)?;
            apply_common(&mut item, parsed.common);
            item.kind = ItemKind::Graphic { width: parsed.width, height: parsed.height, rate: parsed.rate };
        }
        other => return Err(kdm_err(format!("unknown item kind `{other}`"))),
    }
    Ok(item)
}

fn apply_common(item: &mut ProjectItem, common: props::ItemCommon) {
    item.label = common.label;
    item.metadata = common.metadata;
    item.created = common.created;
    item.split = common.split;
}

fn read_sequence_tracks(replica: &Replica, seq_object: &ObjectId, known: &Known, mint: &mut Mint, ids: &mut Ids) -> KdmResult<Sequence> {
    let mut seq = empty_sequence();
    seq.video_tracks = read_tracks(replica, seq_object, "videoTracks", known, mint, ids)?;
    seq.audio_tracks = read_tracks(replica, seq_object, "audioTracks", known, mint, ids)?;
    seq.submix_tracks = read_tracks(replica, seq_object, "submixTracks", known, mint, ids)?;
    Ok(seq)
}

fn read_tracks(replica: &Replica, seq_object: &ObjectId, field: &str, known: &Known, mint: &mut Mint, ids: &mut Ids) -> KdmResult<Vec<Track>> {
    let mut tracks = Vec::new();
    for object in replica.list(seq_object, field)? {
        if !replica.exists(&object) {
            continue;
        }
        let id = mint.track(&object, known);
        ids.tracks.insert(object.clone(), id);
        let props_value = replica.get(&object, "props")?;
        let props: props::TrackProps = if props_value.is_null() { Default::default() } else { serde_json::from_value(props_value).map_err(kdm_err)? };
        let mut track = Track::new(id, props.kind, props.name);
        track.locked = props.locked;
        track.sync_lock = props.sync_lock;
        track.enabled = props.enabled;
        track.muted = props.muted;
        track.solo = props.solo;
        track.channels = props.channels;
        track.volume_db = replica.get(&object, "volumeDb")?.as_f64().unwrap_or(0.0);
        track.pan = replica.get(&object, "pan")?.as_f64().unwrap_or(0.0);
        track.mixer = props.mixer;
        track.effects = objects::read_effects(replica, &object, "effects")?;
        for clip_object in replica.list(&object, "clips")? {
            if !replica.exists(&clip_object) {
                continue;
            }
            track.items.push(read_clip(replica, &clip_object, known, mint, ids)?);
        }
        track.sort();
        tracks.push(track);
    }
    Ok(tracks)
}

fn read_clip(replica: &Replica, object: &ObjectId, known: &Known, mint: &mut Mint, ids: &mut Ids) -> KdmResult<kition_film_project::TrackItem> {
    let id = mint.clip(object, known);
    ids.clips.insert(object.clone(), id);
    let missing = replica.get(object, "missingItem")?.as_u64().map(ItemId).unwrap_or(ItemId(0));
    let item = match replica.get(object, "item")? {
        Value::String(item_object) => ids.items.local(&ObjectId::from_string(item_object)).unwrap_or(missing),
        _ => missing,
    };
    let start = tick::from_value(&replica.get(object, "start")?)?;
    let duration = tick::from_value(&replica.get(object, "duration")?)?;
    let source_in = tick::from_value(&replica.get(object, "sourceIn")?)?;
    let speed = replica.get(object, "speed")?.as_f64().unwrap_or(1.0);
    let reverse = replica.get(object, "reverse")?.as_bool().unwrap_or(false);
    let link = replica.get(object, "link")?.as_str().and_then(|s| s.parse::<u64>().ok());
    let group = replica.get(object, "group")?.as_str().and_then(|s| s.parse::<u64>().ok());
    let gain_value = replica.get(object, "gain")?;
    let gain: props::ClipGain = if gain_value.is_null() { Default::default() } else { serde_json::from_value(gain_value).map_err(kdm_err)? };
    let markers = objects::read_markers(replica, object, "markers", &mut |_, stored| mint.data(stored))?;
    let props_value = replica.get(object, "props")?;
    let props: Option<props::ClipProps> = if props_value.is_null() { None } else { Some(serde_json::from_value(props_value).map_err(kdm_err)?) };
    let effects = objects::read_effects(replica, object, "effects")?;

    Ok(kition_film_project::TrackItem {
        id,
        item,
        name: props.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
        label: props.as_ref().map(|p| p.label).unwrap_or(kition_film_project::Label::Iris),
        start,
        duration,
        source_in,
        speed,
        reverse,
        enabled: props.as_ref().map(|p| p.enabled).unwrap_or(true),
        link,
        group,
        effects,
        markers,
        gain_db: gain.gain_db,
        frame_hold: props.as_ref().and_then(|p| p.frame_hold),
        scale_to_frame: props.as_ref().map(|p| p.scale_to_frame).unwrap_or(false),
        audio_mixing: props.as_ref().and_then(|p| p.audio_mixing.clone()),
        multicam: props.as_ref().and_then(|p| p.multicam),
        time_interpolation: props.as_ref().map(|p| p.time_interpolation).unwrap_or_default(),
        hold_filters: props.as_ref().map(|p| p.hold_filters).unwrap_or(false),
        field_options: props.as_ref().and_then(|p| p.field_options),
        source_channels: props.as_ref().map(|p| p.source_channels.clone()).unwrap_or_default(),
        audio_stream: props.as_ref().map(|p| p.audio_stream).unwrap_or(0),
        graphic: props.and_then(|p| p.graphic),
    })
}

fn read_sequence_transitions(replica: &Replica, seq_object: &ObjectId, seq: &mut Sequence, known: &Known, mint: &mut Mint, ids: &mut Ids) -> KdmResult<()> {
    for (field, tracks) in [("videoTracks", &mut seq.video_tracks), ("audioTracks", &mut seq.audio_tracks), ("submixTracks", &mut seq.submix_tracks)] {
        let track_objects = replica.list(seq_object, field)?;
        for (track, track_object) in tracks.iter_mut().zip(track_objects.iter()) {
            for object in replica.list(track_object, "transitions")? {
                if !replica.exists(&object) {
                    continue;
                }
                track.transitions.push(read_transition(replica, &object, known, mint, &mut *ids)?);
            }
            track.sort();
        }
    }
    Ok(())
}

fn read_transition(replica: &Replica, object: &ObjectId, known: &Known, mint: &mut Mint, ids: &mut Ids) -> KdmResult<kition_film_project::Transition> {
    let id = mint.transition(object, known);
    ids.transitions.insert(object.clone(), id);
    let Value::String(effect_object) = replica.get(object, "effect")? else { return Err(kdm_err("transition has no effect object")) };
    let effect = objects::read_effect(replica, &ObjectId::from_string(effect_object))?;
    let start = tick::from_value(&replica.get(object, "start")?)?;
    let duration = tick::from_value(&replica.get(object, "duration")?)?;
    let from = match replica.get(object, "from")? {
        Value::String(s) => ids.clips.local(&ObjectId::from_string(s)),
        _ => None,
    };
    let to = match replica.get(object, "to")? {
        Value::String(s) => ids.clips.local(&ObjectId::from_string(s)),
        _ => None,
    };
    let align = match replica.get(object, "align")?.as_str().unwrap_or_default() {
        "startAtCut" => kition_film_project::TransitionAlign::StartAtCut,
        "endAtCut" => kition_film_project::TransitionAlign::EndAtCut,
        _ => kition_film_project::TransitionAlign::CenterAtCut,
    };
    let reverse = replica.get(object, "reverse")?.as_bool().unwrap_or(false);
    Ok(kition_film_project::Transition { id, effect, start, duration, from, to, align, reverse })
}

fn apply_sequence_extras(replica: &Replica, seq_object: &ObjectId, seq: &mut Sequence, mint: &mut Mint) -> KdmResult<()> {
    seq.master_volume_db = replica.get(seq_object, "masterVolumeDb")?.as_f64().unwrap_or(0.0);
    seq.master_effects = objects::read_effects(replica, seq_object, "masterEffects")?;
    let mixer_value = replica.get(seq_object, "mixer")?;
    if !mixer_value.is_null() {
        seq.master_mixer = serde_json::from_value(mixer_value).map_err(kdm_err)?;
    }
    seq.caption_tracks = objects::read_caption_tracks(replica, seq_object, &mut |_, stored| mint.data(stored))?;
    seq.markers = objects::read_markers(replica, seq_object, "markers", &mut |_, stored| mint.data(stored))?;
    Ok(())
}
