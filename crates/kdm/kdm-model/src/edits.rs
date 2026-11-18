//! Object-model edits are checked before the live replica takes them.
use kition_kit::kdm::{KdmError, Replica};
use std::collections::HashMap;

use crate::kdm_err;

/// A clip carries the effects and channel settings of its track kind. Moving it between
/// audio and video is not a conversion; use the source item's placement command instead.
pub fn check_model_edits(before: &Replica, after: &Replica) -> Result<(), KdmError> {
    let mut kinds = HashMap::new();
    for track in before.objects_of_type("Track") {
        let kind = before.get(&track, "props")?["kind"].clone();
        for clip in before.list(&track, "clips")? {
            kinds.insert(clip, kind.clone());
        }
    }
    for track in after.objects_of_type("Track") {
        let kind = after.get(&track, "props")?["kind"].clone();
        for clip in after.list(&track, "clips")? {
            if kinds.get(&clip).is_some_and(|was| was != &kind) {
                return Err(kdm_err("cannot move a clip between video and audio tracks; place the source item on a compatible track"));
            }
        }
    }
    // Newly created clips must also have a source that can supply the destination's media.
    let (project, ids, _) = crate::read_document(after)?;
    for sequence in project.items.values().filter_map(|item| item.as_sequence()) {
        for track in sequence.all_tracks() {
            for clip in &track.items {
                let object = ids.clips.object(clip.id).ok_or_else(|| kdm_err("clip has no model object"))?;
                if kinds.contains_key(object) {
                    continue;
                }
                let Some(item) = project.item(clip.item) else { continue };
                let (video, audio) = project
                    .resolve_media(clip.item)
                    .map_or((item.has_video(), item.has_audio()), |(_, media, _)| (media.info.has_video(), media.info.has_audio()));
                let compatible = match track.kind {
                    kition_film_project::TrackKind::Video => video,
                    kition_film_project::TrackKind::Audio => audio,
                };
                if !compatible {
                    return Err(kdm_err("the source has no media for this track kind"));
                }
            }
        }
    }
    Ok(())
}
