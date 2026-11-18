//! Inputs whose identity and timing must survive before a background analysis can edit a clip.

use std::sync::{Arc, Weak};

use kition_film_media::{MediaSource, SharedSource};
use kition_film_project::{Project, Sequence, TrackId, TrackItem};
use kition_film_time::FrameRate;

pub(crate) struct AnalysisInput {
    clip: TrackItem,
    track: TrackId,
    locked: bool,
    sequence_rate: FrameRate,
    media_rate: Option<FrameRate>,
    source: Weak<dyn MediaSource>,
}

impl AnalysisInput {
    pub(crate) fn new(project: &Project, sequence: &Sequence, track: TrackId, clip: &TrackItem, source: &SharedSource) -> Self {
        Self {
            clip: clip.clone(),
            track,
            locked: sequence.track(track).is_some_and(|track| track.locked),
            sequence_rate: sequence.settings.frame_rate,
            media_rate: project.resolve_media(clip.item).map(|(_, media, _)| media.frame_rate()),
            source: Arc::downgrade(source),
        }
    }

    pub(crate) fn matches(&self, session: &crate::Session, sequence: &Sequence) -> bool {
        let Some((track, clip)) = sequence.find_item(self.clip.id) else { return false };
        // Compare the inputs to source_time_at, not effect parameters: unrelated color/volume
        // edits remain valid, and Motion's NaN auto-position sentinels cannot invalidate a job.
        track == self.track
            && sequence.track(track).is_some_and(|track| track.locked == self.locked)
            && sequence.settings.frame_rate == self.sequence_rate
            && clip.item == self.clip.item
            && clip.start == self.clip.start
            && clip.duration == self.clip.duration
            && clip.source_in == self.clip.source_in
            && clip.speed.to_bits() == self.clip.speed.to_bits()
            && clip.reverse == self.clip.reverse
            && clip.frame_hold == self.clip.frame_hold
            && clip.link == self.clip.link
            && session.project.resolve_media(clip.item).map(|(_, media, _)| media.frame_rate()) == self.media_rate
            && session.source(clip.item).is_some_and(|source| self.source.ptr_eq(&Arc::downgrade(&source)))
    }
}
