//! Local id bookkeeping: the five engine id types that become KDM objects (`ItemId`, `BinId`,
//! `TrackId`, `ClipId`, `TransitionId`) each get their own [`kition_kit::session::IdMap`], bundled
//! here as [`Ids`] so [`crate::read_document`] and [`crate::write::write_changes`] pass one value
//! instead of five. [`Known`] is the matching bundle of plain maps (object id -> local id), kept
//! across a reload so a surviving object keeps the local id the rest of a session's state (the
//! active sequence, a selection) names it by — the same role `PhotoModel::known` plays for layers.
//!
//! `EffectInstance` and `Marker` mint no local id: effects stay Vec-indexed in the engine (matched
//! positionally at write time, see `crate::write::diff_effects`), and a marker's, a caption's, a
//! caption track's and a search bin's engine id is the object's own `id` field (data, never
//! remapped; see `crate::objects`).

use std::collections::HashMap;

use kition_film_project::{Bin, BinEntry, BinId, ClipId, ItemId, ItemKind, Project, Track, TrackId, TransitionId};
use kition_kit::kdm::ObjectId;
use kition_kit::session::IdMap;

/// The five id maps a loaded view needs to find (and later move or recurse into) the object
/// backing a `Bin`, `ProjectItem`, `Track`, `TrackItem` or `Transition`.
#[derive(Clone, Default)]
pub struct Ids {
    pub items: IdMap<ItemId>,
    pub bins: IdMap<BinId>,
    pub tracks: IdMap<TrackId>,
    pub clips: IdMap<ClipId>,
    pub transitions: IdMap<TransitionId>,
}

/// Object ids to the local ids a view has ever given them, including deleted ones, so a reload
/// (after an undo, a redo, or an import) gives a surviving object the same local id. See
/// [`Known::remember`].
#[derive(Clone, Default)]
pub struct Known {
    pub items: HashMap<ObjectId, ItemId>,
    pub bins: HashMap<ObjectId, BinId>,
    pub tracks: HashMap<ObjectId, TrackId>,
    pub clips: HashMap<ObjectId, ClipId>,
    pub transitions: HashMap<ObjectId, TransitionId>,
}

impl Known {
    /// Walks `project` (every bin, item, track, clip and transition it holds) and remembers the
    /// object id `ids` currently maps each one to, if any. Called after every successful
    /// `read_document`/`write_document`/`write_changes` so the *next* reload can keep local ids
    /// stable for objects that survive it.
    pub fn remember(&mut self, project: &Project, ids: &Ids) {
        fn walk_bin(bin: &Bin, ids: &Ids, known: &mut Known, depth: usize) {
            if depth > 64 {
                return;
            }
            if let Some(object) = ids.bins.object(bin.id) {
                known.bins.insert(object.clone(), bin.id);
            }
            for entry in &bin.children {
                match entry {
                    BinEntry::Item(id) => {
                        if let Some(object) = ids.items.object(*id) {
                            known.items.insert(object.clone(), *id);
                        }
                    }
                    BinEntry::Bin(child) => walk_bin(child, ids, known, depth + 1),
                }
            }
        }
        walk_bin(&project.root, ids, self, 0);
        for item in project.items.values() {
            if let Some(object) = ids.items.object(item.id) {
                self.items.insert(object.clone(), item.id);
            }
            let ItemKind::Sequence(seq) = &item.kind else { continue };
            for track in seq.all_tracks().chain(seq.submix_tracks.iter()) {
                remember_track(track, ids, self);
            }
        }
    }
}

fn remember_track(track: &Track, ids: &Ids, known: &mut Known) {
    if let Some(object) = ids.tracks.object(track.id) {
        known.tracks.insert(object.clone(), track.id);
    }
    for clip in &track.items {
        if let Some(object) = ids.clips.object(clip.id) {
            known.clips.insert(object.clone(), clip.id);
        }
    }
    for transition in &track.transitions {
        if let Some(object) = ids.transitions.object(transition.id) {
            known.transitions.insert(object.clone(), transition.id);
        }
    }
}
