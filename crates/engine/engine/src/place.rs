//! What a command names by its place (task card C8-film-2): a step that gives no clip and acts
//! at a time (a call's `at.time`, which sets the playhead, or the command's own `time`, `seconds`,
//! `frame`, `timecode`) and on tracks (its `track`, the targeted tracks, the source patching)
//! acts on whatever is there when it runs. [`Session::under`] answers what that is now: the clips
//! under the time on those tracks and each track's window of them in its clip list, for
//! kition-sdk's `KitDocument::under` (Kit Process Protocol `context.under`), so a write by place made
//! after someone else moved what is there is refused instead of landing on another clip.
//!
//! No edit: it reads the open sequence, its playhead, the targets and the selection as they are.

use kition_film_project::{ClipId, ItemKind, Sequence, TrackId};
use kition_film_time::Tick;
use serde_json::Value;

use crate::Session;
use crate::commands::{item_p, marker_time_p, source_range, time_p, track_p};

/// The clips a place names and, for each track it falls on, the window of their indexes in that
/// track's clip list (`from == to` where no clip covers it: where one put there would go).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Under {
    pub clips: Vec<ClipId>,
    pub windows: Vec<Window>,
    pub gaps: Vec<Gap>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gap {
    pub parent: u64,
    pub field: &'static str,
    pub index: usize,
}

/// One actual destination interval; marker placements may leave gaps on the same track.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub track: TrackId,
    pub from: usize,
    pub to: usize,
    pub at: Tick,
    pub span: Tick,
}

/// The tracks a command acts on at its time.
enum Tracks {
    /// Every timeline track, locked or not: what is there to see and hear at that time.
    All,
    /// The tracks targeted for navigation and paste.
    Targeted,
    /// The track `track` names, else every unlocked track (a razor, Add Edit to All Tracks).
    NamedOrUnlocked,
    /// The track `track` names, which the command needs.
    Named,
    /// Add Edit: the selected clips under the time, else the targeted tracks.
    SelectedOrTargeted,
    /// Place Clip: `track` and `audioTrack`, else the source patching.
    Placed,
    /// Insert and Overwrite from the Source monitor: the source patching.
    Patched,
}

/// What command `id` names by its place.
enum Kind {
    /// Its time names no clip: it moves the playhead to an absolute time, plays, exports, or
    /// undoes. The step applies at that time whatever is there.
    Nothing,
    /// The clips under its time on `Tracks`.
    Clips(Tracks),
}

/// How command `id` reads its place. Every command that reads the playhead is here: those whose
/// time names no clip ([`Kind::Nothing`]), those that act on the clips under it on particular
/// tracks, and every other one on what is under it on every track (a marker, a caption, a title
/// put there marks or covers what is seen and heard at that time; a command given a clip by
/// selection acts on its frame at that time).
fn kind(id: &str) -> Kind {
    match id {
        "caption.setTrack"
        | "caption.deleteTrack"
        | "caption.setStyle"
        | "caption.setText"
        | "caption.setTimes"
        | "caption.trim"
        | "caption.move"
        | "caption.delete"
        | "caption.merge"
        | "caption.split"
        | "mask.add"
        | "mask.remove"
        | "mask.set"
        | "mask.moveVertex"
        | "mask.translate"
        | "mask.addVertex"
        | "mask.removeVertex"
        | "mask.track"
        | "mask.toggleVertexSmooth"
        | "marker.edit"
        | "marker.clearCurrent"
        | "marker.clearAll"
        | "timeline.setTrack"
        | "timeline.roll"
        | "playhead.set"
        | "playhead.step"
        | "playhead.stepForward"
        | "playhead.stepBack"
        | "playhead.stepForward5"
        | "playhead.stepBack5"
        | "playhead.start"
        | "playhead.end"
        | "playhead.selectedClipStart"
        | "playhead.selectedClipEnd"
        | "marker.goNext"
        | "marker.goPrev"
        | "marker.goToIn"
        | "marker.goToOut"
        | "marker.goToSplitVideoIn"
        | "marker.goToSplitVideoOut"
        | "marker.goToSplitAudioIn"
        | "marker.goToSplitAudioOut"
        | "sequence.selectionFollowsPlayhead"
        | "edit.undo"
        | "edit.redo"
        | "shortcut.undo"
        | "shortcut.redo"
        | "edit.findNext"
        | "file.openDemoProject"
        | "file.exportMedia"
        | "export.queue.add"
        | "export.quick"
        | "export.resolve"
        | "file.exportFrame"
        | "file.exportGraphicsTemplate"
        | "graphics.template.export"
        | "preset.save"
        | "audioMixing.savePreset"
        | "trim.shuttle"
        | "trim.shuttleStop"
        | "trim.playAround"
        | "trim.cancelDynamic"
        | "multicam.page"
        | "multicam.nextPage"
        | "multicam.prevPage"
        // a transition named by its id: it acts on that transition, not at the playhead
        | "sequence.setTransition"
        | "sequence.removeTransition" => Kind::Nothing,
        "timeline.selectClipAtPlayhead" | "timeline.selectNextClip" | "timeline.selectPrevClip" => Kind::Clips(Tracks::Targeted),
        "timeline.razor" | "sequence.addEditAllTracks" => Kind::Clips(Tracks::NamedOrUnlocked),
        "sequence.addEdit" => Kind::Clips(Tracks::SelectedOrTargeted),
        "sequence.closeGap" => Kind::Clips(Tracks::Named),
        "timeline.place" => Kind::Clips(Tracks::Placed),
        "source.insert" | "source.overwrite" => Kind::Clips(Tracks::Patched),
        _ => Kind::Clips(Tracks::All),
    }
}

/// The parameters of command `id` that name a place rather than an object (kition-sdk
/// `KitCommand::places`): the time a command acts at when it takes one in place of the playhead,
/// and the track it acts on. A command that names its clip by id (`clip`, `clips`) and reads a
/// time inside that clip (a keyframe's, a frame hold's) has none: its clip is its premise.
pub fn places(id: &str) -> &'static [&'static str] {
    const TIME: &[&str] = &["time", "seconds", "frame", "timecode"];
    const TRACK_TIME: &[&str] = &["track", "time", "seconds", "frame", "timecode"];
    match id {
        "color.applyMatch" => &["referenceTime", "referenceFrame", "referenceTimecode"],
        "timeline.move" => &["moves"],
        "sequence.addTracks" => &["videoAfter", "audioAfter", "submixAfter"],
        "timeline.razor"
        | "caption.add"
        | "graphics.newText"
        | "graphics.newShape"
        | "graphics.newVerticalText"
        | "graphics.newPolygon"
        | "graphics.newFromFile"
        | "graphics.template.apply" => TRACK_TIME,
        "timeline.place" => &["track", "audioTrack", "time", "seconds", "frame", "timecode"],
        "sequence.addEdit"
        | "sequence.addEditAllTracks"
        | "marker.add"
        | "marker.addRange"
        | "marker.addChapter"
        | "marker.addFlashCue"
        | "marker.markIn"
        | "marker.markOut"
        | "marker.markSplitVideoIn"
        | "marker.markSplitVideoOut"
        | "marker.markSplitAudioIn"
        | "marker.markSplitAudioOut"
        | "sound.phrase" => TIME,
        "sequence.closeGap" | "audio.voiceover.start" | "clipMixer.release" => &["track", "time"],
        "caption.split"
        | "mixer.setValue"
        | "mixer.release"
        | "mixer.recordStop"
        | "mixer.setKeyframe"
        | "mixer.deleteKeyframe"
        | "mixer.moveKeyframe"
        | "multicam.cut"
        | "multicam.cutToCamera"
        | "multicam.recordStop"
        | "audio.voiceover.sync"
        | "audio.voiceover.stop" => &["time"],
        _ => &[],
    }
}

/// The clips of `track` under `[at, at + span)` (under `at` for a span of zero) and their window.
fn window(track: &kition_film_project::Track, at: Tick, span: Tick) -> (usize, usize) {
    let end = if span > Tick::ZERO { at + span } else { at + Tick(1) };
    let from = track.items.partition_point(|item| item.end() <= at);
    let to = track.items.partition_point(|item| item.start < end).max(from);
    (from, to)
}

impl Session {
    /// What command `command`, given `params`, names by its place in the open sequence now (see
    /// the module): `Ok(None)` when it names its clip by id or the project has no open sequence
    /// (no place to tell), `Ok(Some(Under::default()))` when its place names no clip. A track the
    /// sequence lacks is the command's own error. No edit.
    pub fn under(&self, command: &str, params: &Value) -> crate::Result<Option<Under>> {
        if command == "effect.apply"
            && params
                .get("effect")
                .and_then(Value::as_str)
                .and_then(|name| crate::commands::resolve_effect_name(self, params, name))
                .is_some_and(|effect| matches!(effect.kind, kition_film_project::EffectKind::Video | kition_film_project::EffectKind::Audio))
        {
            return Ok(None);
        }
        if command == "sequence.addTracks" {
            return Ok(Some(Under { gaps: crate::sequence_tools::added_track_gaps(self, params)?, ..Default::default() }));
        }
        if matches!(command, "clip.speedDuration" | "timeline.trim") {
            return Ok(self.edit_neighbours_under(command, params));
        }
        if command == "clip.automateToSequence" {
            return self.automated_under(params);
        }
        if command == "timeline.move" {
            return self.moved_under(params);
        }
        if matches!(command, "sequence.lift" | "sequence.extract") {
            return Ok(self.range_under(command == "sequence.extract"));
        }
        if matches!(command, "sequence.applyVideoTransition" | "sequence.applyAudioTransition") {
            let kind = if command == "sequence.applyVideoTransition" { kition_film_project::TrackKind::Video } else { kition_film_project::TrackKind::Audio };
            let Ok((id, _, _, cut)) = crate::commands::transition_point(self, params, kind) else { return Ok(Some(Under::default())) };
            let Some(track) = self.active_sequence().and_then(|q| q.track(id)) else { return Ok(None) };
            let at = Tick(cut.0.saturating_sub(1).max(0));
            let span = Tick(2);
            let (from, to) = window(track, at, span);
            return Ok(Some(Under {
                clips: track.items.get(from..to).into_iter().flatten().map(|clip| clip.id).collect(),
                windows: vec![Window { track: id, from, to, at, span }],
                ..Default::default()
            }));
        }
        let Kind::Clips(tracks) = kind(command) else { return Ok(Some(Under::default())) };
        // A source marker names no place in the sequence.
        if command.starts_with("marker.") && params.get("target").and_then(Value::as_str) == Some("source") {
            return Ok(Some(Under::default()));
        }
        let Some(sequence) = self.active_sequence() else { return Ok(None) };
        let (at, span) = self.place_time(command, params, sequence);
        let named = |key: &str| track_p(self, params, key, command);
        let targeting = self.targeting();
        let mut on: Vec<(TrackId, Tick)> = Vec::new();
        match tracks {
            Tracks::All => on.extend(sequence.all_tracks().map(|track| (track.id, span))),
            Tracks::Targeted => on.extend(targeting.targeted.iter().map(|track| (*track, span))),
            Tracks::NamedOrUnlocked => match named("track")? {
                Some(track) => on.push((track, span)),
                None => on.extend(sequence.all_tracks().filter(|track| !track.locked).map(|track| (track.id, span))),
            },
            Tracks::Named => on.extend(named("track")?.map(|track| (track, span))),
            Tracks::SelectedOrTargeted => {
                let selected: Vec<TrackId> = self
                    .state
                    .selection
                    .iter()
                    .filter_map(|clip| sequence.find_item(*clip))
                    .filter(|(_, item)| item.start < at && at < item.end())
                    .map(|(track, _)| track)
                    .collect();
                let chosen = if selected.is_empty() { targeting.targeted.clone() } else { selected };
                on.extend(chosen.into_iter().map(|track| (track, span)));
            }
            Tracks::Placed => {
                let picture = params.get("track").and_then(Value::as_str) != Some("auto");
                let sound = params.get("audioTrack").and_then(Value::as_str) != Some("auto");
                let video = if picture { named("track")?.or(targeting.video_dest) } else { None };
                let audio = if sound { named("audioTrack")?.or(targeting.audio_dest) } else { None };
                on.extend([video, audio].into_iter().flatten().map(|track| (track, span)));
            }
            Tracks::Patched => on.extend([targeting.video_dest, targeting.audio_dest].into_iter().flatten().map(|track| (track, span))),
        }
        let mut under = Under::default();
        for (id, span) in on {
            let Some(track) = sequence.track(id) else { continue };
            if under.windows.iter().any(|window| window.track == id) {
                continue;
            }
            let (from, to) = window(track, at, span);
            under.clips.extend(track.items.get(from..to).into_iter().flatten().map(|item| item.id));
            under.windows.push(Window { track: id, from, to, at, span });
        }
        Ok(Some(under))
    }

    /// The marked range Lift and Extract remove (`[In, Out + 1 frame)`, else the whole sequence)
    /// and the tracks they act on, as their code reads them (`edit::lift`, `edit::extract`): the
    /// unlocked targeted tracks, and for Extract also the unlocked sync-locked ones.
    pub fn marked_range(&self, extract: bool) -> Option<(Tick, Tick, Vec<TrackId>)> {
        let sequence = self.active_sequence()?;
        let at = sequence.mark_in.unwrap_or(Tick::ZERO);
        let end = sequence.mark_out.map(|out| out + sequence.settings.frame_rate.frame_duration()).unwrap_or_else(|| sequence.duration());
        let targeted = self.targeting().targeted;
        let tracks = sequence
            .all_tracks()
            .filter(|track| !track.locked && (targeted.contains(&track.id) || (extract && track.sync_lock)))
            .map(|track| track.id)
            .collect();
        Some((at, end, tracks))
    }

    /// What Lift and Extract act on (C8-time-policy): the clips under the marked range on the
    /// tracks they act on, each track's window of them, the range as a span of time. Extract
    /// shifts every later clip by the range's length without reading it: later clips are not
    /// part of its place. Whether a clip is still under the range, on any track it acts on, is
    /// told by `bindings/wasm` (`KitDocument::covered`) from the clips' times at `basis`.
    fn range_under(&self, extract: bool) -> Option<Under> {
        let sequence = self.active_sequence()?;
        let (at, end, tracks) = self.marked_range(extract)?;
        let span = Tick(end.0.saturating_sub(at.0).max(0));
        let mut under = Under::default();
        for id in tracks {
            let Some(track) = sequence.track(id) else { continue };
            let (from, to) = window(track, at, span);
            under.clips.extend(track.items.get(from..to).into_iter().flatten().map(|item| item.id));
            under.windows.push(Window { track: id, from, to, at, span });
        }
        Some(under)
    }

    /// Ripple commands read the later placements on participating tracks, including linked
    /// sound that crosses the cut. The window also detects newly inserted neighbours.
    pub(crate) fn edit_neighbours_under(&self, command: &str, params: &Value) -> Option<Under> {
        let sequence = self.active_sequence()?;
        let ids: Vec<_> = params
            .get("clips")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(Value::as_u64).map(ClipId).collect())
            .unwrap_or_else(|| params.get("clip").and_then(Value::as_u64).map(ClipId).into_iter().collect());
        let ids = crate::commands::with_links(self, &ids);
        let starts: Vec<_> = ids.iter().filter_map(|id| sequence.find_item(*id)).collect();
        let first = starts.iter().map(|(_, clip)| clip.start).min()?;
        let ripple = if command == "timeline.trim" {
            params.get("mode").and_then(Value::as_str) == Some("ripple")
        } else {
            params.get("ripple").and_then(Value::as_bool) == Some(true)
        };
        let mut under = Under::default();
        for track in sequence.all_tracks() {
            let member = starts.iter().any(|(id, _)| *id == track.id);
            if !member && (!ripple || track.locked || !track.sync_lock) {
                continue;
            }
            let mut at = Tick(first.0.saturating_sub(1).max(0));
            let mut span = Tick(Tick::MAX.0.saturating_sub(at.0));
            let (mut from, mut to) = window(track, at, span);
            if !ripple {
                // A regular head trim clamps against the previous clip's end
                // even when an empty gap separates it from the target.
                let first_target = track.items.iter().position(|clip| ids.contains(&clip.id))?;
                from = from.min(first_target.saturating_sub(1));
                if let Some(previous) = track.items.get(from) {
                    at = at.min(previous.start);
                }
                let last = track.items.iter().rposition(|clip| ids.contains(&clip.id))?;
                to = to.min(last.saturating_add(2));
                // The non-ripple command consults only the selected clips and
                // their immediate neighbour. Keep its historical time window
                // bounded by the same recipients as its ordinal window.
                let end = track.items.get(to.saturating_sub(1))?.end();
                span = Tick(end.0.saturating_sub(at.0).max(0));
            }
            under.clips.extend(track.items.get(from..to).into_iter().flatten().map(|clip| clip.id));
            under.windows.push(Window { track: track.id, from, to, at, span });
        }
        Some(under)
    }

    /// The time command `command` acts at, as it reads it, and the length of time it covers there
    /// (zero for a point): an overwrite covers its clip's length.
    fn place_time(&self, command: &str, params: &Value, sequence: &Sequence) -> (Tick, Tick) {
        let playhead = self.playhead();
        match command {
            "marker.add" | "marker.addRange" | "marker.addChapter" | "marker.addFlashCue" => (marker_time_p(self, params).unwrap_or(playhead), Tick::ZERO),
            "source.insert" | "source.overwrite" => {
                let at = sequence.mark_in.unwrap_or(playhead);
                let span = if command == "source.overwrite" {
                    self.state.source_item.and_then(|item| source_range(self, item)).map(|(_, range)| range.duration).unwrap_or_default()
                } else {
                    Tick::ZERO
                };
                (at, span)
            }
            "timeline.place" => {
                let at = time_p(self, params, "").unwrap_or(playhead);
                let insert = params.get("insert").and_then(Value::as_bool).unwrap_or(false);
                let length = if insert { Tick::ZERO } else { self.placed_length(params) };
                // With `snap` the clip lands on a marker or beat up to the tolerance either side
                // of the time asked for (`crate::snap`): the place is every time it may land on.
                if params.get("snap").is_some_and(|snap| !snap.is_null()) {
                    let frames = params
                        .get("toleranceFrames")
                        .and_then(Value::as_i64)
                        .unwrap_or(crate::snap::DEFAULT_TOLERANCE_FRAMES)
                        .clamp(0, crate::snap::MAX_TOLERANCE_FRAMES);
                    let tolerance = sequence.settings.frame_rate.tick_of(frames);
                    let from = Tick(at.0.saturating_sub(tolerance.0).max(0));
                    return (from, Tick(at.0.saturating_add(length.0).saturating_add(tolerance.0).saturating_sub(from.0)));
                }
                (at, length)
            }
            _ => (time_p(self, params, "").unwrap_or(playhead), Tick::ZERO),
        }
    }

    /// Exact destination intervals from the command's own layout, including expanded audio
    /// channels and unpacked sequence tracks. Inserts also shift later clips on sync-lock tracks.
    fn automated_under(&self, params: &Value) -> crate::Result<Option<Under>> {
        let Some(sequence) = self.active_sequence() else { return Ok(None) };
        let plan = crate::project_tools::automation_plan(self, params)?;
        let insert = params.get("method").and_then(Value::as_str).unwrap_or("insert") == "insert";
        let mut intervals = Vec::new();
        for ((id, range), at) in plan.plan.iter().zip(&plan.starts) {
            let Some(item) = self.project.item(*id) else { continue };
            if self.state.sequences_as_clips
                && let Some(source) = item.as_sequence().filter(|q| q.multicam.is_none())
            {
                for (tracks, destination, targets) in
                    [(&source.video_tracks, plan.vdest, &sequence.video_tracks), (&source.audio_tracks, plan.adest, &sequence.audio_tracks)]
                {
                    let Some(base) = destination.and_then(|id| targets.iter().position(|track| track.id == id)) else { continue };
                    let mut lane = 0usize;
                    for track in tracks {
                        let clips: Vec<_> = track.items.iter().filter_map(|clip| kition_film_edit::through::clip_item_to(clip, *range)).collect();
                        if clips.is_empty() {
                            continue;
                        }
                        if let Some(target) = targets.get(base.saturating_add(lane)) {
                            for clip in clips {
                                intervals.push((target.id, *at + (clip.start - range.start), clip.duration));
                            }
                        }
                        lane = lane.saturating_add(1);
                    }
                }
            } else {
                let media = self.project.resolve_media(*id).map(|(_, media, _)| media);
                let (video, audio) = media.map_or((item.has_video(), item.has_audio()), |media| (media.info.has_video(), media.info.has_audio()));
                if video && let Some(track) = plan.vdest {
                    intervals.push((track, *at, range.duration));
                }
                if audio && let Some(base) = plan.adest.and_then(|id| sequence.audio_tracks.iter().position(|track| track.id == id)) {
                    let channels = media.and_then(|media| media.interpret.audio_channels.as_ref()).map(|map| map.clips.as_slice()).unwrap_or(&[]);
                    let streams = media.map_or(1, |media| media.info.audio_streams.len());
                    for spec in crate::commands::audio_placement_specs(channels, streams) {
                        if let Some(track) = sequence.audio_tracks.get(base.saturating_add(spec.track_offset)) {
                            intervals.push((track.id, *at, range.duration));
                        }
                    }
                }
            }
        }
        if insert && let Some(first) = plan.starts.iter().min().copied() {
            let destinations: Vec<_> = [plan.vdest, plan.adest].into_iter().flatten().collect();
            intervals.extend(
                sequence
                    .all_tracks()
                    .filter(|track| !track.locked && (track.sync_lock || destinations.contains(&track.id)))
                    .map(|track| (track.id, first, Tick(Tick::MAX.0.saturating_sub(first.0)))),
            );
        }
        let mut under = Under::default();
        for (track, at, span) in intervals {
            let Some(found) = sequence.track(track) else { continue };
            let (from, to) = window(found, at, span);
            under.clips.extend(found.items.get(from..to).into_iter().flatten().map(|clip| clip.id));
            under.windows.push(Window { track, from, to, at, span });
        }
        under.clips.sort_by_key(|clip| clip.0);
        under.clips.dedup();
        Ok(Some(under))
    }

    fn moved_under(&self, params: &Value) -> crate::Result<Option<Under>> {
        let Some(sequence) = self.active_sequence() else { return Ok(None) };
        // Even an unresolvable snap must retain the input premises returned by `premises`.
        let Ok(plan) = crate::commands::move_plan(self, params) else { return Ok(Some(Under::default())) };
        let mut intervals = Vec::new();
        for (clip, track, at) in &plan.moves {
            if let Some((_, source)) = sequence.find_item(*clip) {
                intervals.push((*track, *at, source.duration));
            }
        }
        if plan.insert
            && let Some(first) = intervals.iter().map(|(_, at, _)| *at).min()
        {
            let destinations: Vec<_> = plan.moves.iter().map(|(_, track, _)| *track).collect();
            intervals = sequence
                .all_tracks()
                .filter(|track| !track.locked && (track.sync_lock || destinations.contains(&track.id)))
                .map(|track| (track.id, first, Tick(Tick::MAX.0.saturating_sub(first.0))))
                .collect();
        }
        let mut under = Under::default();
        for (track, at, span) in intervals {
            let Some(found) = sequence.track(track) else { continue };
            let (from, to) = window(found, at, span);
            under.clips.extend(found.items.get(from..to).into_iter().flatten().map(|clip| clip.id));
            under.windows.push(Window { track, from, to, at, span });
        }
        under.clips.sort_by_key(|clip| clip.0);
        under.clips.dedup();
        Ok(Some(under))
    }

    /// The length `timeline.place` gives the clip it places: its `duration`, else the item's
    /// marked range (its In to its Out), else its whole length; zero when the item is unknown.
    fn placed_length(&self, params: &Value) -> Tick {
        if let Some(duration) = params.get("duration").and_then(Value::as_i64) {
            return Tick(duration.max(0));
        }
        let Some(item) = item_p(params, "item").and_then(|item| self.project.item(item)) else { return Tick::ZERO };
        let (mark_in, mark_out) = match &item.kind {
            ItemKind::Media(media) => (media.mark_in, media.mark_out.map(|out| out + item.frame_rate().frame_duration())),
            ItemKind::Subclip { range, .. } => (Some(range.start), Some(range.end())),
            _ => (None, None),
        };
        let start = params.get("sourceIn").and_then(Value::as_i64).map(Tick).or(mark_in).unwrap_or_default();
        let end = mark_out.unwrap_or_else(|| item.duration());
        if end > start { end - start } else { Tick::ZERO }
    }
}
