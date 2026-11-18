//! What a preview changed: [`project_diff`] compares the document's project with the scratch
//! copy's, so the Timeline, Project, and Markers panels draw only what differs.
//!
//! The answer is `{project, sequences, tracks, clips, items, bins, markers, captions, selection,
//! projectSelection}`. `project` is `{changed: [field]}` (the project's own name, settings, LUT
//! library, source graphics, and transcripts). Every other part is `{added: [entry], removed:
//! [entry], changed: [entry]}`, where an entry is `{id, …where it is}` and a changed entry also
//! has `fields: [name]`:
//! - `sequences`, `items`, `bins` (search bins too): `{id}`; project item and bin ids are unique;
//! - `tracks`, `clips`, `captions`: `{id, sequence}`, and `track` for clips and captions. A
//!   duplicated sequence keeps its tracks' and clips' ids, so they are told apart by sequence;
//!   a clip that moves to another sequence (Nest) is removed from one and added to the other;
//! - `markers`: `{id, owner, ownerKind, sequence}`, `ownerKind` `sequence`, `clip` (with the
//!   clip's `sequence`), or `item` (a media item's markers, such as Scene Edit Detection's), and
//!   for added and changed markers their values `start`, `duration` (ticks), `name`, `comment`,
//!   `kind`, and `color`, so a panel draws them without another read;
//! - `selection` (the timeline's clips) and `projectSelection` (the Project panel's items):
//!   `{id}`, added and removed only.
//!
//! The copy shares the document's project until its command edits it: then the whole `Project`
//! is a new value, but every project item the command left alone is equal to the document's (and
//! in the same bin), so it is skipped with everything in it after one comparison.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use kition_film_engine::EditorState;
use kition_film_engine::project::{
    Bin, BinEntry, Caption, CaptionTrack, ItemId, ItemKind, Marker, Project, ProjectItem, SearchBin, Sequence, Track, TrackItem,
};
use serde_json::{Value, json};

/// One part of the diff.
#[derive(Default)]
struct Part {
    added: Vec<Value>,
    removed: Vec<Value>,
    changed: Vec<Value>,
}

/// An entry's JSON object: where it is, and (`values`) what it holds.
type Entry = serde_json::Map<String, Value>;

impl Part {
    /// Lists what is only in `before` as removed, only in `after` as added, and, for what is in
    /// both, the fields `fields` names (an empty list: unchanged). `entry(key, value, values)`
    /// makes an entry's object; `values` is set for added and changed entries.
    fn compare<K: Ord, T>(
        before: &BTreeMap<K, T>,
        after: &BTreeMap<K, T>,
        entry: impl Fn(&K, &T, bool) -> Entry,
        fields: impl Fn(&T, &T) -> Vec<&'static str>,
    ) -> Self {
        let mut part = Part::default();
        for (key, old) in before {
            match after.get(key) {
                None => part.removed.push(Value::Object(entry(key, old, false))),
                Some(new) => {
                    let changed = fields(old, new);
                    if !changed.is_empty() {
                        let mut object = entry(key, new, true);
                        object.insert("fields".to_owned(), json!(changed));
                        part.changed.push(Value::Object(object));
                    }
                }
            }
        }
        part.added = after.iter().filter(|(key, _)| !before.contains_key(key)).map(|(key, new)| Value::Object(entry(key, new, true))).collect();
        part
    }

    /// The added and removed ids of two id lists (a selection), nothing changed.
    fn ids(before: &[u64], after: &[u64]) -> Self {
        let (old, new): (BTreeSet<u64>, BTreeSet<u64>) = (before.iter().copied().collect(), after.iter().copied().collect());
        let entries = |ids: Vec<&u64>| ids.into_iter().map(|id| json!({ "id": id })).collect();
        Part { added: entries(new.difference(&old).collect()), removed: entries(old.difference(&new).collect()), changed: Vec::new() }
    }

    fn json(self) -> Value {
        json!({ "added": self.added, "removed": self.removed, "changed": self.changed })
    }
}

/// `{id}`.
fn id_entry(id: u64) -> Entry {
    let mut entry = Entry::new();
    entry.insert("id".to_owned(), json!(id));
    entry
}

/// `{id, sequence}`, and `track` when there is one.
fn placed(id: u64, sequence: u64, track: Option<u64>) -> Entry {
    let mut entry = id_entry(id);
    entry.insert("sequence".to_owned(), json!(sequence));
    if let Some(track) = track {
        entry.insert("track".to_owned(), json!(track));
    }
    entry
}

/// Field names whose values differ, from `(name, differs)` pairs; `other` when the two differ in
/// a field none of the pairs names.
fn fields(differs: bool, pairs: &[(&'static str, bool)]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = pairs.iter().filter(|(_, changed)| *changed).map(|(name, _)| *name).collect();
    if differs && out.is_empty() {
        out.push("other");
    }
    out
}

/// A track of either kind.
enum TrackRef<'a> {
    Media(&'a Track),
    Caption(&'a CaptionTrack),
}

/// Everything in the project items a diff looks into, by id.
#[derive(Default)]
struct Entities<'a> {
    items: BTreeMap<u64, &'a ProjectItem>,
    sequences: BTreeMap<u64, (&'a ProjectItem, &'a Sequence)>,
    /// By (sequence, track).
    tracks: BTreeMap<(u64, u64), TrackRef<'a>>,
    /// A clip and its track, by (sequence, clip).
    clips: BTreeMap<(u64, u64), (&'a TrackItem, u64)>,
    /// By what it is on: (owner kind, sequence, owner, marker); the sequence is 0 for an item's.
    markers: BTreeMap<(&'static str, u64, u64, u64), &'a Marker>,
    /// A caption and its caption track, by (sequence, caption).
    captions: BTreeMap<(u64, u64), (&'a Caption, u64)>,
}

impl<'a> Entities<'a> {
    /// The entities of `project`'s items, except those in `skip`.
    fn of(project: &'a Project, skip: &BTreeSet<ItemId>) -> Self {
        let mut out = Entities::default();
        for (id, item) in project.items.iter().filter(|(id, _)| !skip.contains(id)) {
            out.items.insert(id.0, item);
            match &item.kind {
                ItemKind::Media(media) => {
                    for marker in &media.markers {
                        out.markers.insert(("item", 0, id.0, marker.id.0), marker);
                    }
                }
                ItemKind::Sequence(sequence) => {
                    out.sequences.insert(id.0, (item, sequence));
                    for marker in &sequence.markers {
                        out.markers.insert(("sequence", id.0, id.0, marker.id.0), marker);
                    }
                    for track in sequence.video_tracks.iter().chain(&sequence.audio_tracks).chain(&sequence.submix_tracks) {
                        out.tracks.insert((id.0, track.id.0), TrackRef::Media(track));
                        for clip in &track.items {
                            out.clips.insert((id.0, clip.id.0), (clip, track.id.0));
                            for marker in &clip.markers {
                                out.markers.insert(("clip", id.0, clip.id.0, marker.id.0), marker);
                            }
                        }
                    }
                    for track in &sequence.caption_tracks {
                        out.tracks.insert((id.0, track.id.0), TrackRef::Caption(track));
                        for caption in &track.captions {
                            out.captions.insert((id.0, caption.id.0), (caption, track.id.0));
                        }
                    }
                }
                _ => {}
            }
        }
        out
    }
}

/// Every bin under `bin` (itself included): the bin, the bin it is in, and the ids of what it holds.
fn bins<'a>(bin: &'a Bin, parent: Option<u64>, out: &mut BTreeMap<u64, (&'a Bin, Option<u64>, Vec<u64>)>) {
    let entries = bin
        .children
        .iter()
        .map(|entry| match entry {
            BinEntry::Item(item) => item.0,
            BinEntry::Bin(child) => child.id.0,
        })
        .collect();
    out.insert(bin.id.0, (bin, parent, entries));
    for entry in &bin.children {
        if let BinEntry::Bin(child) = entry {
            bins(child, Some(bin.id.0), out);
        }
    }
}

/// The bin each item is in.
fn item_bins(bins: &BTreeMap<u64, (&Bin, Option<u64>, Vec<u64>)>) -> BTreeMap<u64, u64> {
    let mut out = BTreeMap::new();
    for (bin, (found, _, _)) in bins {
        for entry in &found.children {
            if let BinEntry::Item(item) = entry {
                out.insert(item.0, *bin);
            }
        }
    }
    out
}

fn sequence_fields(a: &ProjectItem, b: &ProjectItem, x: &Sequence, y: &Sequence) -> Vec<&'static str> {
    let track_ids = |s: &Sequence| s.video_tracks.iter().chain(&s.audio_tracks).chain(&s.submix_tracks).map(|t| t.id).collect::<Vec<_>>();
    // the clips, track by track, whatever tracks were added or removed around them
    let clips_differ =
        !x.video_tracks.iter().chain(&x.audio_tracks).flat_map(|t| &t.items).eq(y.video_tracks.iter().chain(&y.audio_tracks).flat_map(|t| &t.items));
    fields(
        a != b,
        &[
            ("name", a.name != b.name),
            ("label", a.label != b.label),
            ("settings", x.settings != y.settings),
            ("tracks", track_ids(x) != track_ids(y)),
            ("clips", clips_differ),
            ("duration", x.duration() != y.duration()),
            ("markers", x.markers != y.markers),
            ("in", x.mark_in != y.mark_in),
            ("out", x.mark_out != y.mark_out),
            ("workArea", x.work_area != y.work_area),
            ("timecode", x.start_timecode != y.start_timecode),
            ("mix", x.master_volume_db != y.master_volume_db || x.master_effects != y.master_effects || x.master_mixer != y.master_mixer),
            ("captions", x.caption_tracks != y.caption_tracks),
            ("multicam", x.multicam != y.multicam),
            ("merged", x.merged != y.merged),
            ("split", x.split != y.split),
            ("metadata", a.metadata != b.metadata),
        ],
    )
}

fn item_fields(a: &ProjectItem, b: &ProjectItem, bin_a: Option<&u64>, bin_b: Option<&u64>) -> Vec<&'static str> {
    let mut pairs = vec![
        ("name", a.name != b.name),
        ("label", a.label != b.label),
        ("metadata", a.metadata != b.metadata),
        ("split", a.split != b.split),
        ("bin", bin_a != bin_b),
        ("kind", std::mem::discriminant(&a.kind) != std::mem::discriminant(&b.kind)),
    ];
    match (&a.kind, &b.kind) {
        (ItemKind::Media(x), ItemKind::Media(y)) => {
            let mut info = y.info.clone();
            info.start_timecode = x.info.start_timecode;
            pairs.extend([
                ("media", x.media != y.media),
                ("timecode", x.info.start_timecode != y.info.start_timecode),
                ("info", x.info != info),
                ("interpret", x.interpret != y.interpret),
                ("in", x.mark_in != y.mark_in),
                ("out", x.mark_out != y.mark_out),
                ("markers", x.markers != y.markers),
                ("offline", x.offline != y.offline),
                ("proxy", x.proxy != y.proxy),
                ("identity", x.identity != y.identity),
            ]);
        }
        (ItemKind::Sequence(x), ItemKind::Sequence(y)) => {
            pairs.extend([
                ("settings", x.settings != y.settings),
                ("duration", x.duration() != y.duration()),
                ("contents", x != y && x.settings == y.settings),
            ]);
        }
        (ItemKind::Subclip { parent: p, range: r, restrict_trims: t }, ItemKind::Subclip { parent: q, range: s, restrict_trims: u }) => {
            pairs.extend([("parent", p != q), ("range", r != s), ("restrictTrims", t != u)]);
        }
        (x, y) => pairs.push(("settings", x != y && std::mem::discriminant(x) == std::mem::discriminant(y))),
    }
    // `created` is an import counter, never edited; anything else lands in `other`.
    fields(a != b, &pairs)
}

fn track_fields(a: &TrackRef, b: &TrackRef) -> Vec<&'static str> {
    match (a, b) {
        (TrackRef::Media(x), TrackRef::Media(y)) => {
            let ids = |t: &Track| t.items.iter().map(|clip| clip.id).collect::<Vec<_>>();
            fields(
                x != y,
                &[
                    ("name", x.name != y.name),
                    ("kind", x.kind != y.kind),
                    ("clips", ids(x) != ids(y)),
                    ("transitions", x.transitions != y.transitions),
                    ("locked", x.locked != y.locked),
                    ("syncLock", x.sync_lock != y.sync_lock),
                    ("enabled", x.enabled != y.enabled),
                    ("muted", x.muted != y.muted),
                    ("solo", x.solo != y.solo),
                    ("channels", x.channels != y.channels),
                    ("volume", x.volume_db != y.volume_db),
                    ("pan", x.pan != y.pan),
                    ("effects", x.effects != y.effects),
                    ("mixer", x.mixer != y.mixer),
                ],
            )
        }
        (TrackRef::Caption(x), TrackRef::Caption(y)) => {
            let ids = |t: &CaptionTrack| t.captions.iter().map(|caption| caption.id).collect::<Vec<_>>();
            fields(
                x != y,
                &[
                    ("name", x.name != y.name),
                    ("format", x.format != y.format),
                    ("language", x.language != y.language),
                    ("style", x.style != y.style),
                    ("enabled", x.enabled != y.enabled),
                    ("locked", x.locked != y.locked),
                    ("syncLock", x.sync_lock != y.sync_lock),
                    ("captions", ids(x) != ids(y)),
                ],
            )
        }
        _ => vec!["kind"],
    }
}

fn clip_fields((x, tx): &(&TrackItem, u64), (y, ty): &(&TrackItem, u64)) -> Vec<&'static str> {
    fields(
        x != y || tx != ty,
        &[
            ("track", tx != ty),
            ("item", x.item != y.item),
            ("name", x.name != y.name),
            ("label", x.label != y.label),
            ("start", x.start != y.start),
            ("duration", x.duration != y.duration),
            ("sourceIn", x.source_in != y.source_in),
            ("speed", x.speed != y.speed),
            ("reverse", x.reverse != y.reverse),
            ("enabled", x.enabled != y.enabled),
            ("link", x.link != y.link),
            ("group", x.group != y.group),
            ("effects", x.effects != y.effects),
            ("markers", x.markers != y.markers),
            ("gain", x.gain_db != y.gain_db),
            ("frameHold", x.frame_hold != y.frame_hold),
            ("scaleToFrame", x.scale_to_frame != y.scale_to_frame),
            ("audio_mixing", x.audio_mixing != y.audio_mixing),
            ("multicam", x.multicam != y.multicam),
            ("timeInterpolation", x.time_interpolation != y.time_interpolation),
            ("holdFilters", x.hold_filters != y.hold_filters),
            ("fieldOptions", x.field_options != y.field_options),
            ("sourceChannels", x.source_channels != y.source_channels),
            ("audioStream", x.audio_stream != y.audio_stream),
            ("graphic", x.graphic != y.graphic),
        ],
    )
}

fn marker_fields(x: &&Marker, y: &&Marker) -> Vec<&'static str> {
    fields(
        x != y,
        &[
            ("start", x.start != y.start),
            ("duration", x.duration != y.duration),
            ("name", x.name != y.name),
            ("comment", x.comment != y.comment),
            ("kind", x.kind != y.kind),
            ("color", x.color != y.color),
        ],
    )
}

fn caption_fields((x, tx): &(&Caption, u64), (y, ty): &(&Caption, u64)) -> Vec<&'static str> {
    fields(
        x != y || tx != ty,
        &[
            ("track", tx != ty),
            ("start", x.start != y.start),
            ("duration", x.duration != y.duration),
            ("text", x.text != y.text),
            ("speaker", x.speaker != y.speaker),
            ("cueId", x.cue_id != y.cue_id),
            ("settings", x.settings != y.settings),
        ],
    )
}

/// A marker's entry: where it is, and its values.
fn marker_entry(&(kind, sequence, owner, id): &(&'static str, u64, u64, u64), marker: &&Marker, values: bool) -> Entry {
    let mut entry = id_entry(id);
    entry.insert("owner".to_owned(), json!(owner));
    entry.insert("ownerKind".to_owned(), json!(kind));
    if kind != "item" {
        entry.insert("sequence".to_owned(), json!(sequence));
    }
    if values {
        entry.insert("start".to_owned(), json!(marker.start.0));
        entry.insert("duration".to_owned(), json!(marker.duration.0));
        entry.insert("name".to_owned(), json!(marker.name));
        entry.insert("comment".to_owned(), json!(marker.comment));
        entry.insert("kind".to_owned(), json!(format!("{:?}", marker.kind)));
        entry.insert("color".to_owned(), json!(marker.color.name()));
    }
    entry
}

/// The project's own fields that differ (not its items and bins, which have their parts).
fn project_fields(a: &Project, b: &Project) -> Vec<&'static str> {
    [
        ("name", a.name != b.name),
        ("settings", a.settings != b.settings),
        ("luts", a.luts != b.luts),
        ("sourceGraphics", a.source_graphics != b.source_graphics),
        ("transcripts", a.transcripts != b.transcripts),
    ]
    .into_iter()
    .filter(|(_, changed)| *changed)
    .map(|(name, _)| name)
    .collect()
}

/// What the copy (`after`, `after_state`) changed against the document (`before`,
/// `before_state`); see the module's documentation for the shape.
pub(crate) fn project_diff(before: &Arc<Project>, before_state: &EditorState, after: &Arc<Project>, after_state: &EditorState) -> Value {
    let selection = |state: &EditorState| state.selection.iter().map(|clip| clip.0).collect::<Vec<_>>();
    let project_selection = |state: &EditorState| state.project_selection.iter().map(|item| item.0).collect::<Vec<_>>();
    let (selection, project_selection) =
        (Part::ids(&selection(before_state), &selection(after_state)), Part::ids(&project_selection(before_state), &project_selection(after_state)));
    let mut parts = BTreeMap::new();
    let project = if Arc::ptr_eq(before, after) { Vec::new() } else { project_fields(before, after) };
    if Arc::ptr_eq(before, after) {
        for name in ["sequences", "tracks", "clips", "items", "bins", "markers", "captions"] {
            parts.insert(name, Part::default());
        }
    } else {
        let (mut old_bins, mut new_bins) = (BTreeMap::new(), BTreeMap::new());
        if before.root != after.root {
            bins(&before.root, None, &mut old_bins);
            bins(&after.root, None, &mut new_bins);
        }
        let (old_homes, new_homes) = (item_bins(&old_bins), item_bins(&new_bins));
        // An item the command left alone (equal, and in the same bin) is equal on both sides, and
        // so is everything in it.
        let skip: BTreeSet<ItemId> = before
            .items
            .iter()
            .filter(|(id, item)| after.items.get(id) == Some(item) && old_homes.get(&id.0) == new_homes.get(&id.0))
            .map(|(id, _)| *id)
            .collect();
        let (old, new) = (Entities::of(before, &skip), Entities::of(after, &skip));
        let mut bin_part = Part::compare(
            &old_bins,
            &new_bins,
            |id, _, _| id_entry(*id),
            |(x, px, ex), (y, py, ey)| fields(x != y || px != py, &[("name", x.name != y.name), ("bin", px != py), ("items", ex != ey)]),
        );
        // search bins are listed with the bins
        fn search(project: &Project) -> BTreeMap<u64, &SearchBin> {
            project.search_bins.iter().map(|bin| (bin.id.0, bin)).collect()
        }
        let search_part = Part::compare(
            &search(before),
            &search(after),
            |id, _, _| id_entry(*id),
            |x, y| fields(x != y, &[("name", x.name != y.name), ("query", x.query != y.query)]),
        );
        bin_part.added.extend(search_part.added);
        bin_part.removed.extend(search_part.removed);
        bin_part.changed.extend(search_part.changed);
        parts.insert("bins", bin_part);
        parts.insert("sequences", Part::compare(&old.sequences, &new.sequences, |id, _, _| id_entry(*id), |(a, x), (b, y)| sequence_fields(a, b, x, y)));
        parts.insert(
            "items",
            Part::compare(&old.items, &new.items, |id, _, _| id_entry(*id), |a, b| item_fields(a, b, old_homes.get(&a.id.0), new_homes.get(&b.id.0))),
        );
        parts.insert("tracks", Part::compare(&old.tracks, &new.tracks, |(sequence, id), _, _| placed(*id, *sequence, None), track_fields));
        parts.insert("clips", Part::compare(&old.clips, &new.clips, |(sequence, id), (_, track), _| placed(*id, *sequence, Some(*track)), clip_fields));
        parts.insert("markers", Part::compare(&old.markers, &new.markers, marker_entry, marker_fields));
        parts.insert(
            "captions",
            Part::compare(&old.captions, &new.captions, |(sequence, id), (_, track), _| placed(*id, *sequence, Some(*track)), caption_fields),
        );
    }
    let mut out = serde_json::Map::new();
    out.insert("project".to_owned(), json!({ "changed": project }));
    for (name, part) in parts {
        out.insert(name.to_owned(), part.json());
    }
    out.insert("selection".to_owned(), selection.json());
    out.insert("projectSelection".to_owned(), project_selection.json());
    Value::Object(out)
}
