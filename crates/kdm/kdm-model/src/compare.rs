//! [`normalize`]: an id-blind form of a [`Project`] for tests. `BinId`/`ItemId`/`TrackId`/
//! `ClipId`/`TransitionId` are minted fresh by every `read_document` (never a stable identity
//! across replicas or reloads, like `kition_photo_doc::LayerId` is for Photo), so two `Project`s
//! that hold the very same content — a round trip through a replica, or two sessions that
//! converged — almost never share them. Comparing `Project`s directly would see every id as a
//! difference; `normalize` renumbers every one of the five id types from a deterministic
//! traversal (the bin tree for bins/items, each sequence's own tracks/clips/transitions for the
//! rest) and rewrites every place that names one, so the comparison that is left is real content.

use std::collections::{BTreeMap, HashMap};

use kition_film_project::{Bin, BinEntry, BinId, ClipId, ItemId, ItemKind, Project, Sequence, Track, TrackId, TrackItem, Transition, TransitionId};

#[derive(Default)]
struct Maps {
    bins: HashMap<BinId, BinId>,
    items: HashMap<ItemId, ItemId>,
    tracks: HashMap<TrackId, TrackId>,
    clips: HashMap<ClipId, ClipId>,
    transitions: HashMap<TransitionId, TransitionId>,
}

/// An id-blind copy of `project`: every `BinId`/`ItemId`/`TrackId`/`ClipId`/`TransitionId`
/// renumbered from 1 in a deterministic traversal order, with every reference to one of them (a
/// subclip's parent, a clip's item, a transition's clip, a multicam camera's track/source, a
/// merged clip's items, `docState`'s transcripts/sourceGraphics keys) rewritten to match. Two
/// projects with the same content normalize to the same value regardless of which concrete ids
/// either happens to hold.
pub fn normalize(project: &Project) -> Project {
    let mut maps = Maps::default();
    let mut next_bin = 1u64;
    let mut next_item = 1u64;
    number_bins_and_items(&project.root, &mut maps, &mut next_bin, &mut next_item);
    // Items unreachable from any bin (should not normally happen) still get a canonical id, in
    // their `BTreeMap` order, so nothing is silently dropped from the comparison.
    for id in project.items.keys() {
        maps.items.entry(*id).or_insert_with(|| {
            let v = ItemId(next_item);
            next_item += 1;
            v
        });
    }

    let mut next_track = 1u64;
    let mut next_clip = 1u64;
    let mut next_transition = 1u64;
    let mut ordered_item_ids: Vec<ItemId> = project.items.keys().copied().collect();
    ordered_item_ids.sort_by_key(|id| maps.items.get(id).copied().unwrap_or(*id));
    for old_id in &ordered_item_ids {
        let Some(item) = project.items.get(old_id) else { continue };
        let ItemKind::Sequence(seq) = &item.kind else { continue };
        for track in seq.video_tracks.iter().chain(seq.audio_tracks.iter()).chain(seq.submix_tracks.iter()) {
            maps.tracks.insert(track.id, TrackId(next_track));
            next_track += 1;
            let mut clips: Vec<&TrackItem> = track.items.iter().collect();
            clips.sort_by_key(|c| c.start);
            for clip in clips {
                maps.clips.insert(clip.id, ClipId(next_clip));
                next_clip += 1;
            }
            let mut transitions: Vec<&Transition> = track.transitions.iter().collect();
            transitions.sort_by_key(|t| t.start);
            for transition in transitions {
                maps.transitions.insert(transition.id, TransitionId(next_transition));
                next_transition += 1;
            }
        }
    }

    let mut out = project.clone();
    out.next_id = 0;
    out.root = remap_bin(&project.root, &maps);
    let mut items = BTreeMap::new();
    for (old_id, item) in &project.items {
        let mut item = item.clone();
        item.id = maps.items[old_id];
        remap_kind(&mut item.kind, &maps);
        items.insert(item.id, item);
    }
    out.items = items;
    out.transcripts = project.transcripts.iter().filter_map(|(id, t)| maps.items.get(id).map(|new| (*new, t.clone()))).collect();
    out.source_graphics = project.source_graphics.iter().filter_map(|(id, sg)| maps.items.get(id).map(|new| (*new, sg.clone()))).collect();
    out
}

fn number_bins_and_items(bin: &Bin, maps: &mut Maps, next_bin: &mut u64, next_item: &mut u64) {
    maps.bins.insert(bin.id, BinId(*next_bin));
    *next_bin += 1;
    for entry in &bin.children {
        match entry {
            BinEntry::Item(id) => {
                maps.items.entry(*id).or_insert_with(|| {
                    let v = ItemId(*next_item);
                    *next_item += 1;
                    v
                });
            }
            BinEntry::Bin(child) => number_bins_and_items(child, maps, next_bin, next_item),
        }
    }
}

fn remap_bin(bin: &Bin, maps: &Maps) -> Bin {
    Bin {
        id: maps.bins.get(&bin.id).copied().unwrap_or(bin.id),
        name: bin.name.clone(),
        children: bin
            .children
            .iter()
            .map(|entry| match entry {
                BinEntry::Item(id) => BinEntry::Item(maps.items.get(id).copied().unwrap_or(*id)),
                BinEntry::Bin(child) => BinEntry::Bin(remap_bin(child, maps)),
            })
            .collect(),
    }
}

fn remap_item(id: ItemId, maps: &Maps) -> ItemId {
    maps.items.get(&id).copied().unwrap_or(id)
}
fn remap_track(id: TrackId, maps: &Maps) -> TrackId {
    maps.tracks.get(&id).copied().unwrap_or(id)
}

fn remap_kind(kind: &mut ItemKind, maps: &Maps) {
    match kind {
        ItemKind::Subclip { parent, .. } => *parent = remap_item(*parent, maps),
        ItemKind::Sequence(seq) => remap_sequence(seq, maps),
        ItemKind::Media(_) | ItemKind::AdjustmentLayer { .. } | ItemKind::Graphic { .. } => {}
    }
}

fn remap_sequence(seq: &mut Sequence, maps: &Maps) {
    for tracks in [&mut seq.video_tracks, &mut seq.audio_tracks, &mut seq.submix_tracks] {
        for track in tracks.iter_mut() {
            remap_track_contents(track, maps);
        }
    }
    if let Some(multicam) = &mut seq.multicam {
        for camera in &mut multicam.cameras {
            camera.video_track = camera.video_track.map(|t| remap_track(t, maps));
            camera.audio_tracks = camera.audio_tracks.iter().map(|t| remap_track(*t, maps)).collect();
            camera.source = camera.source.map(|i| remap_item(i, maps));
        }
    }
    if let Some(merged) = &mut seq.merged {
        merged.video = merged.video.map(|i| remap_item(i, maps));
        merged.audio = merged.audio.iter().map(|i| remap_item(*i, maps)).collect();
    }
}

fn remap_track_contents(track: &mut Track, maps: &Maps) {
    track.id = remap_track(track.id, maps);
    for clip in &mut track.items {
        clip.id = maps.clips.get(&clip.id).copied().unwrap_or(clip.id);
        clip.item = remap_item(clip.item, maps);
    }
    track.items.sort_by_key(|c| c.start);
    for transition in &mut track.transitions {
        transition.id = maps.transitions.get(&transition.id).copied().unwrap_or(transition.id);
        transition.from = transition.from.map(|c| maps.clips.get(&c).copied().unwrap_or(c));
        transition.to = transition.to.map(|c| maps.clips.get(&c).copied().unwrap_or(c));
    }
    track.transitions.sort_by_key(|t| t.start);
}
