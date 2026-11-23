//! What a call needs of the objects it acts on, where this kit can state it exactly (task card
//! C8-time-3, kition-sdk C8-fix-7 `Under::premises`): the paths into each object the command's code
//! reads or replaces and the positions it depends on. Only a change by others that touches those
//! refuses an agent's write with `basis`; an object a command says nothing of keeps every field and
//! every position (kition-sdk's default), so a command is listed here only after its code was read.
//!
//! | command | object | fields | positions |
//! |---|---|---|---|
//! | `effects.setParam` by `clip`, no `time`/`frame`/`seconds`/`timecode`, no `mask`, on a clip with no keyframe | the clip | `effects` | none |
//! | `effects.setKeyframe`, `effects.deleteKeyframe`, `effects.moveKeyframe`, `effects.setInterpolation` with `mediaTime` | the clip | `effects` | none |
//! | `effects.toggleEnabled` | the clip | `effects` | none |
//! | `clip.enable` | each clip and, with Linked Selection, its linked clips | `props.enabled`, `link` | none |
//! | `clip.rename` | the clip, or the project item `item` | `props.name` (`name` for an item) | none |
//! | `captions.setTrack`, `.deleteTrack`, `.setStyle` | the open sequence's item | `sequence.captionTracks[id=<id>]` (`.deleteTrack` also its captions, `sequence.captions[track=<id>]`); an ordinal also holds its indexed id | none |
//! | `captions.setText` | the open sequence's item | its caption by its id, `sequence.captions[id=<id>]` | none |
//! | `captions.setTimes`, `.trim`, `.move`, `.delete`, `.merge`, `.split` (and `.setText` on a caption it cannot find, or the one under the playhead) | the open sequence's item | `sequence.captionTracks`, `sequence.captions` | none |
//! | `markers.edit` (program) | the open sequence's item | its marker by its id, `sequence.markers[id=<id>]` | none |
//! | `markers.clearCurrent`, `markers.clearAll` (program) | the open sequence's item | `sequence.markers` | none |
//! | `timeline.razor`, `sequence.addEdit`, `sequence.addEditAllTracks` at a place | each clip under it | every field | `start` |
//! | `timeline.place` (insert or overwrite) at a place | each clip under it (bindings/wasm) | every field | `start`, `clipId` |
//! | `sequence.lift`, `sequence.extract` | each clip in the marked range; for extract each later clip | every field; `link` | `start`, `clipId`; `start`, `clips` |
//! | `sequence.addEditAllTracks` | the open sequence's item | `sequence.captionTracks`, `sequence.captions` | none |
//! | `timeline.place` with `snap` | the open sequence's item (`markers`), every audio clip (`beats`) | `sequence.markers`; every field | none; every position |
//!
//! Why each is exact:
//! - `effects.setParam` sets the parameter's value (`Param::set_at`): with no keyframe on the
//!   parameter that ignores the time, so neither the playhead nor where the clip is matters. On a
//!   clip with a keyframe on any parameter, or given a time, it keys the value at the clip's source
//!   time under that time, which a move, trim, slip or speed change of the clip changes: no premise
//!   is stated. A mask path is converted at a source time: none either.
//! - The keyframe edits given `mediaTime` find the keyframe by its source time and change it
//!   (`keyframe_op`); the playhead's source time is computed but not read for them.
//! - `clip.enable` reads every named clip's (and linked clip's) enabled switch to choose on or off,
//!   and writes it; which clips are linked is their `link`.
//! - A caption's text is the caption alone (`edit::captions::set_caption`); the other caption
//!   edits read the neighbours (overlaps, a ripple, a merge), so the whole caption tracks are the
//!   premise. A caption or a marker has no tool id: it is a path in the sequence's item.
//! - A cut at a time splits the clip under it at its source frame there: where it starts, and its
//!   content (source In, speed, effects). Its length matters only while it still covers the time,
//!   which kition-sdk replays from the clips' times (`Within::time`). Add Edit to All Tracks also
//!   splits the captions under the time. An insert splits the clip under its time as a cut
//!   does; an overwrite replaces the clip's frames under its span: the same holds apply.
//! - Lift and Extract remove what lies in the marked range and Extract shifts every later clip
//!   by the range's length: a later clip's length is not read.
//! - With `snap`, Place Clip lands on the nearest marker or beat within the tolerance: the markers,
//!   and the audio clips the beats come from.

use kition_film_project::{ClipId, ItemId, ItemKind};
use serde_json::Value;

use crate::Session;
use crate::commands::with_links;

/// What one call needs of one object ([`Session::premises`]): `None` is every field, or every
/// position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Premise {
    /// The object's tool id (a clip or a project item, one id space).
    pub id: u64,
    pub fields: Option<Vec<String>>,
    pub positions: Option<Vec<String>>,
}

impl Premise {
    fn content(id: u64, fields: &[&str]) -> Self {
        Self { id, fields: Some(fields.iter().map(|field| (*field).to_owned()).collect()), positions: Some(Vec::new()) }
    }
}

/// The caption edits that act on the captions named, else the selected ones, else the one under
/// the playhead (`captions::caption_ids`), or on those under a time (`captions.split`).
const CAPTION_EDITS: [&str; 7] =
    ["captions.setText", "captions.setTimes", "captions.trim", "captions.move", "captions.delete", "captions.merge", "captions.split"];

/// The keys a command reads a sequence time from in place of the playhead.
const TIME_KEYS: [&str; 4] = ["time", "seconds", "frame", "timecode"];

fn given(params: &Value, key: &str) -> bool {
    params.get(key).is_some_and(|value| !value.is_null())
}

fn whole(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(Value::as_u64)
}

/// The ids a list parameter `many` or a single one `one` holds; empty when neither is given.
fn named(params: &Value, many: &str, one: &str) -> Vec<u64> {
    match (params.get(many).and_then(Value::as_array), whole(params, one)) {
        (Some(ids), _) => ids.iter().filter_map(Value::as_u64).collect(),
        (None, Some(id)) => vec![id],
        (None, None) => Vec::new(),
    }
}

/// The fields `media_duration` and `media_start` consume, following only unrestricted
/// subclip parents. Metadata, labels, marks and proxy paths do not bound a trim.
fn source_bounds(session: &Session, mut id: ItemId) -> Vec<Premise> {
    let mut out = Vec::new();
    for _ in 0..=crate::MAX_SUBCLIP_CHAIN {
        let Some(item) = session.project.item(id) else { break };
        match &item.kind {
            ItemKind::Subclip { parent, restrict_trims, .. } => {
                let fields = if *restrict_trims { vec!["props.restrict_trims", "props.range"] } else { vec!["props.restrict_trims", "props.parent"] };
                out.push(Premise::content(id.0, &fields));
                if *restrict_trims {
                    break;
                }
                id = *parent;
            }
            ItemKind::Media(media) => {
                let mut fields = vec!["props.media.info.kind"];
                if !matches!(media.info.kind, kition_film_media::MediaKind::Still | kition_film_media::MediaKind::Synthetic) {
                    fields.push("props.media.info.duration");
                }
                out.push(Premise::content(id.0, &fields));
                break;
            }
            ItemKind::Sequence(_) => {
                // Owned sequences are receipted on their Item. The SDK marks
                // positions by that object's root field; `sequence` is a ref,
                // so its nested duration is content on the Item, not a position.
                out.push(Premise::content(id.0, &["sequence.duration"]));
                break;
            }
            ItemKind::AdjustmentLayer { .. } | ItemKind::Graphic { .. } => break,
        }
    }
    out
}

/// The bounded resolver used by Project::source_size and the renderer.
fn source_dimensions(session: &Session, mut id: ItemId) -> Vec<Premise> {
    let mut out = Vec::new();
    for _ in 0..16 {
        let Some(item) = session.project.item(id) else { break };
        let fields = match &item.kind {
            ItemKind::Subclip { parent, .. } => {
                out.push(Premise::content(id.0, &["props.parent"]));
                id = *parent;
                continue;
            }
            ItemKind::Media(_) => vec!["props.media.info.video.width", "props.media.info.video.height"],
            ItemKind::Sequence(_) => vec!["sequence.settings.settings.width", "sequence.settings.settings.height"],
            ItemKind::AdjustmentLayer { .. } | ItemKind::Graphic { .. } => vec!["props.width", "props.height"],
        };
        out.push(Premise::content(id.0, &fields));
        break;
    }
    out
}

impl Session {
    /// What `command`, given `params`, needs of the objects it acts on, in the open sequence and
    /// editor state the call sets (see the module). Empty where nothing is stated. No edit.
    pub fn premises(&self, command: &str, params: &Value) -> Vec<Premise> {
        let sequence = self.active_sequence();
        let item = self.state.active_sequence.filter(|_| sequence.is_some()).map(|item| item.0);
        let program = params.get("target").and_then(Value::as_str) != Some("source");
        let mut out = Vec::new();
        if command == "captions.split" {
            out.extend(item.map(|item| Premise::content(item, &["sequence.settings.settings.frame_rate"])));
        }
        if matches!(command, "captions.add" | "captions.setTimes") {
            let prefixes: &[&str] = if command == "captions.add" { &[""] } else { &["start", "end"] };
            let timecode = prefixes.iter().any(|prefix| {
                let key = |suffix: &str| if prefix.is_empty() { suffix.to_ascii_lowercase() } else { format!("{prefix}{suffix}") };
                params.get(key("Time")).and_then(Value::as_i64).is_none()
                    && params.get(key("Frame")).and_then(Value::as_i64).is_none()
                    && params.get(key("Seconds")).and_then(Value::as_f64).is_none()
                    && params.get(key("Timecode")).and_then(Value::as_str).is_some()
            });
            if timecode {
                out.extend(item.map(|item| Premise::content(item, &["sequence.settings.settings.drop_frame"])));
            }
        }
        let effect_time = matches!(command, "effects.setParam" | "effects.toggleAnimation" | "effects.addKeyframe")
            || (command == "effects.setInterpolation" && params.get("mediaTime").and_then(Value::as_i64).is_none());
        if effect_time && params.get("time").and_then(Value::as_i64).is_none() {
            let frame = params.get("frame").and_then(Value::as_i64).is_some();
            let timecode = !frame && params.get("seconds").and_then(Value::as_f64).is_none() && params.get("timecode").and_then(Value::as_str).is_some();
            if (frame || timecode)
                && let Some(item) = item
            {
                let mut fields = vec!["sequence.settings.settings.frame_rate"];
                if timecode {
                    fields.push("sequence.settings.settings.drop_frame");
                }
                out.push(Premise::content(item, &fields));
            }
        }
        if command == "effects.setParam"
            && params.get("mask").is_some()
            && params.get("param").and_then(Value::as_str) == Some("path")
            && let Some(clip) = whole(params, "clip").map(ClipId)
        {
            out.push(Premise {
                id: clip.0,
                fields: Some(["effects", "item", "sourceIn", "speed", "reverse", "props.frame_hold", "props.scale_to_frame"].map(str::to_owned).to_vec()),
                positions: Some(["start", "duration"].map(str::to_owned).to_vec()),
            });
            if let Some((_, found)) = sequence.and_then(|q| q.find_item(clip)) {
                out.extend(source_dimensions(self, found.item));
            }
            let at = crate::commands::time_p(self, params, "").unwrap_or(self.playhead());
            if crate::masks::uses_sequence_dimensions(self, clip, at, false)
                && let Some(item) = item
            {
                out.push(Premise::content(item, &["sequence.settings.settings.width", "sequence.settings.settings.height"]));
            }
        }
        // These are additional dependencies of the core handlers. Keep the
        // normal place answer: an absolute mark still names what was there.
        if program
            && matches!(command, "markers.markIn" | "markers.markOut" | "markers.clearIn" | "markers.clearOut" | "markers.clearInOut")
            && let Some(item) = item
        {
            let mut fields = Vec::new();
            if command != "markers.clearOut" {
                fields.push("sequence.settings.mark_in");
            }
            if command != "markers.clearIn" {
                fields.push("sequence.settings.mark_out");
            }
            if matches!(command, "markers.markIn" | "markers.clearIn" | "markers.clearInOut") {
                fields.extend(["sequence.settings.split.videoIn", "sequence.settings.split.audioIn"]);
            }
            if matches!(command, "markers.markOut" | "markers.clearOut" | "markers.clearInOut") {
                fields.extend(["sequence.settings.split.videoOut", "sequence.settings.split.audioOut"]);
            }
            out.push(Premise::content(item, &fields));
        }
        if matches!(command, "edit.clear" | "edit.cut") {
            let named: Vec<_> = if command == "edit.cut" { self.state.selection.clone() } else { crate::commands::clips_p(self, params) };
            let selected = with_links(self, &named);
            if let Some(sequence) = sequence {
                for track in sequence.all_tracks().filter(|track| track.items.iter().any(|clip| selected.contains(&clip.id))) {
                    out.push(Premise::content(track.id.0, &["props.locked"]));
                    if !track.locked {
                        out.extend(track.items.iter().filter(|clip| selected.contains(&clip.id)).map(|clip| Premise {
                            id: clip.id.0,
                            fields: None,
                            positions: None,
                        }));
                        out.extend(
                            track
                                .transitions
                                .iter()
                                .filter(|tr| tr.from.is_some_and(|id| selected.contains(&id)) || tr.to.is_some_and(|id| selected.contains(&id)))
                                .map(|tr| Premise { id: tr.id.0, fields: None, positions: None }),
                        );
                    }
                }
            }
        }
        if matches!(command, "timeline.roll" | "timeline.slide" | "timeline.trim" | "clip.speedDuration") {
            let direct: Vec<_> = if command == "timeline.roll" {
                [whole(params, "left"), whole(params, "right")].into_iter().flatten().map(ClipId).collect()
            } else {
                with_links(self, &crate::commands::clips_p(self, params))
            };
            if let Some(sequence) = sequence {
                let mut bounded = direct.clone();
                if command == "timeline.slide" {
                    for clip in &direct {
                        if let Some((track, _)) = sequence.find_item(*clip).and_then(|(track, found)| sequence.track(track).map(|track| (track, found)))
                            && let Some(index) = track.items.iter().position(|found| found.id == *clip)
                        {
                            bounded.extend(index.checked_sub(1).and_then(|index| track.items.get(index)).map(|clip| clip.id));
                            bounded.extend(index.checked_add(1).and_then(|index| track.items.get(index)).map(|clip| clip.id));
                        }
                    }
                }
                for clip in bounded {
                    if let Some((_, found)) = sequence.find_item(clip) {
                        out.extend(source_bounds(self, found.item));
                        if !direct.contains(&clip) {
                            out.push(Premise { id: clip.0, fields: None, positions: None });
                        }
                    }
                }
                if matches!(command, "timeline.roll" | "timeline.slide") {
                    for track in sequence.all_tracks().filter(|track| track.items.iter().any(|clip| direct.contains(&clip.id))) {
                        // Both edits move transition anchors, assigning their
                        // starts. Retain additions and historical recipients.
                        out.push(Premise::content(track.id.0, &["transitions"]));
                    }
                }
            }
            if let Some(item) = item {
                out.push(Premise::content(item, &["sequence.settings.settings.frame_rate"]));
            }
        }
        match command {
            "masks.track" => {
                if let Ok(id) = crate::masks::target_clip(self, params)
                    && let Some(q) = sequence
                    && let Some((owner, clip)) = q.find_item(id)
                {
                    out.push(Premise { id: id.0, fields: None, positions: None });
                    out.push(Premise::content(owner.0, &["props.locked"]));
                    out.extend(item.map(|item| Premise::content(item, &["sequence.settings.settings.frame_rate"])));
                    let mut next = Some(clip.item);
                    let mut seen = std::collections::BTreeSet::new();
                    while let Some(source) = next.filter(|source| seen.insert(*source)) {
                        out.push(Premise::content(
                            source.0,
                            &[
                                "kind",
                                "props.media",
                                "props.parent",
                                "props.range",
                                "props.restrict_trims",
                                "props.width",
                                "props.height",
                                "props.rate",
                                "sequence",
                            ],
                        ));
                        next = match self.project.item(source).map(|source| &source.kind) {
                            Some(ItemKind::Subclip { parent, .. }) => Some(*parent),
                            _ => None,
                        };
                    }
                }
            }
            "effects.apply" => {
                if let Some(def) = params.get("effect").and_then(Value::as_str).and_then(|name| crate::commands::resolve_effect_name(self, params, name)) {
                    use kition_film_project::{EffectKind, ParamValue, TrackKind};
                    if matches!(def.kind, EffectKind::VideoTransition | EffectKind::AudioTransition) {
                        let mut delegated = params.clone();
                        delegated["effect"] = Value::String(def.id.to_owned());
                        if let Some(clips) = params.get("clips").and_then(Value::as_array)
                            && let [clip] = clips.as_slice()
                        {
                            delegated["clip"] = clip.clone();
                        }
                        out.extend(self.premises(
                            if def.kind == EffectKind::VideoTransition { "sequence.applyVideoTransition" } else { "sequence.applyAudioTransition" },
                            &delegated,
                        ));
                    } else {
                        let defaults = def.instance();
                        if defaults.params.values().any(|p| matches!(&p.value, ParamValue::Vec2(v) if v.x.is_nan() || v.y.is_nan())) {
                            out.extend(item.map(|id| Premise::content(id, &["sequence.settings.settings.width", "sequence.settings.settings.height"])));
                        }
                        if let Some(q) = sequence {
                            for id in crate::commands::clips_p(self, params) {
                                let Some((tid, _)) = q.find_item(id) else { continue };
                                let Some(track) = q.track(tid) else { continue };
                                let eligible = (track.kind == TrackKind::Audio) == (def.kind == EffectKind::Audio);
                                out.push(Premise {
                                    id: id.0,
                                    fields: Some(if eligible { vec!["effects".to_owned()] } else { Vec::new() }),
                                    positions: Some(vec!["clips".to_owned()]),
                                });
                                out.push(Premise::content(tid.0, &["props.kind"]));
                            }
                        }
                    }
                }
            }
            "effects.reset" => {
                if let Some(clip) = whole(params, "clip").map(ClipId)
                    && let Some(q) = sequence
                    && let Some((_, clip)) = q.find_item(clip)
                    && let Some(def) =
                        clip.effects.get(whole(params, "index").and_then(|i| usize::try_from(i).ok()).unwrap_or(0)).and_then(|effect| effect.def())
                {
                    let defaults = def.instance();
                    if defaults.params.values().any(|p| matches!(&p.value, kition_film_project::ParamValue::Vec2(v) if v.x.is_nan() || v.y.is_nan())) {
                        out.extend(item.map(|id| Premise::content(id, &["sequence.settings.settings.width", "sequence.settings.settings.height"])));
                    }
                }
            }
            "masks.add"
            | "masks.remove"
            | "masks.set"
            | "masks.translate"
            | "masks.moveVertex"
            | "masks.addVertex"
            | "masks.removeVertex"
            | "masks.toggleVertexSmooth" => {
                let clip = whole(params, "clip").map(ClipId).or_else(|| self.state.selected_mask.map(|mask| mask.clip)).or_else(|| {
                    self.state.selection.iter().copied().find(|clip| sequence.is_some_and(|q| q.video_tracks.iter().any(|track| track.item(*clip).is_some())))
                });
                if let Some(clip) = clip {
                    if command == "masks.remove" {
                        out.push(Premise::content(clip.0, &["effects"]));
                    } else {
                        out.push(Premise {
                            id: clip.0,
                            fields: Some(
                                ["effects", "item", "sourceIn", "speed", "reverse", "props.frame_hold", "props.scale_to_frame"].map(str::to_owned).to_vec(),
                            ),
                            positions: Some(["start", "duration"].map(str::to_owned).to_vec()),
                        });
                        if let Some((_, found)) = sequence.and_then(|q| q.find_item(clip)) {
                            out.extend(source_dimensions(self, found.item));
                        }
                        let at = if command == "masks.add" { self.playhead() } else { crate::commands::time_p(self, params, "").unwrap_or(self.playhead()) };
                        if crate::masks::uses_sequence_dimensions(self, clip, at, command == "masks.add")
                            && let Some(item) = item
                        {
                            out.push(Premise::content(item, &["sequence.settings.settings.width", "sequence.settings.settings.height"]));
                        }
                    }
                }
            }
            "file.newBarsAndTone"
            | "file.newBlackVideo"
            | "file.newColorMatte"
            | "file.newCountingLeader"
            | "file.newTransparentVideo"
            | "file.newAdjustmentLayer" => {
                if let Some(item) = item {
                    let mut fields = vec!["sequence.settings.settings.frame_rate"];
                    if command == "file.newAdjustmentLayer" || !given(params, "width") {
                        fields.push("sequence.settings.settings.width");
                    }
                    if command == "file.newAdjustmentLayer" || !given(params, "height") {
                        fields.push("sequence.settings.settings.height");
                    }
                    out.push(Premise::content(item, &fields));
                }
            }
            "sequence.applyVideoTransition" | "sequence.applyAudioTransition" => {
                out.extend(item.map(|id| Premise::content(id, &["sequence.settings.settings.frame_rate"])));
                let kind =
                    if command == "sequence.applyVideoTransition" { kition_film_project::TrackKind::Video } else { kition_film_project::TrackKind::Audio };
                if let Ok((track, from, to, _)) = crate::commands::transition_point(self, params, kind) {
                    out.extend([from, to].into_iter().flatten().map(|id| Premise { id: id.0, fields: None, positions: None }));
                    if let Some(track) = sequence.and_then(|q| q.track(track)) {
                        out.push(Premise::content(track.id.0, &["props.locked"]));
                        out.extend(track.transitions.iter().filter(|tr| tr.from == from && tr.to == to).map(|tr| Premise {
                            id: tr.id.0,
                            fields: None,
                            positions: None,
                        }));
                    }
                }
            }
            "timeline.setTrack" => {
                if let Ok(Some(track)) = crate::commands::track_p(self, params, "track", command) {
                    let fields: Vec<_> = [
                        ("locked", "props.locked"),
                        ("syncLock", "props.sync_lock"),
                        ("enabled", "props.enabled"),
                        ("muted", "props.muted"),
                        ("solo", "props.solo"),
                        ("name", "props.name"),
                        ("volumeDb", "volumeDb"),
                        ("pan", "pan"),
                    ]
                    .into_iter()
                    .filter(|(key, _)| given(params, key))
                    .map(|(_, field)| field)
                    .collect();
                    out.push(Premise::content(track.0, &fields));
                }
            }
            "sequence.lift" | "sequence.extract" => {
                if let (Some(item), Some(sequence)) = (item, sequence) {
                    let mut fields = vec![
                        "sequence.settings.mark_in".to_owned(),
                        "sequence.settings.mark_out".to_owned(),
                        "sequence.settings.settings.frame_rate".to_owned(),
                    ];
                    let positions = if sequence.mark_out.is_none() { vec!["sequence.duration".to_owned()] } else { Vec::new() };
                    if command == "sequence.extract" {
                        let start = sequence.mark_in.unwrap_or(kition_film_time::Tick::ZERO);
                        let end = sequence.mark_out.map(|out| out + sequence.settings.frame_rate.frame_duration()).unwrap_or_else(|| sequence.duration());
                        for track in &sequence.caption_tracks {
                            let path = format!("sequence.captionTracks[id={}]", track.id.0);
                            fields.extend([format!("{path}.locked"), format!("{path}.syncLock")]);
                            if track.locked || !track.sync_lock {
                                continue;
                            }
                            for caption in &track.captions {
                                let path = format!("sequence.captions[id={}]", caption.id.0);
                                if caption.start >= end {
                                    fields.push(format!("{path}.start"));
                                } else if caption.end() > start {
                                    fields.push(path);
                                }
                            }
                        }
                    }
                    out.push(Premise { id: item, fields: Some(fields), positions: Some(positions) });
                }
                let extract = command == "sequence.extract";
                if let (Some(sequence), Some((at, end, _))) = (sequence, self.marked_range(extract)) {
                    // Which tracks the edit acts on: their lock, and for Extract their sync lock.
                    for track in sequence.all_tracks() {
                        // An empty/nonparticipating lane has no lock-dependent effect. Its
                        // insertion must not become a new target merely because it is present now.
                        if !track.items.iter().any(|clip| clip.end() > at && (extract || clip.start < end)) {
                            continue;
                        }
                        out.push(Premise::content(track.id.0, if extract { &["props.locked", "props.sync_lock"] } else { &["props.locked"] }));
                    }
                    if let Ok(Some(under)) = self.under(command, params) {
                        for clip in under.clips {
                            let Some((_, found)) = sequence.find_item(clip) else { continue };
                            out.push(if found.start >= at && found.end() <= end {
                                // Wholly inside: removed whatever it shows, so none of its content
                                // is read. Extract is a place: whether the clip is still inside the
                                // range, on any track it acts on, is told from the clips' times
                                // (`bindings/wasm` `covered`), so a trim or a move to another such
                                // track inside the range applies. Lift reads no time, so its step
                                // is no place for the guard: where the clip starts is held.
                                let positions = if extract { vec!["clipId".to_owned()] } else { vec!["start".to_owned(), "clipId".to_owned()] };
                                Premise { id: clip.0, fields: Some(Vec::new()), positions: Some(positions) }
                            } else {
                                // Across an edge: cut there, so what it shows and where it starts
                                // and ends are read.
                                Premise { id: clip.0, fields: None, positions: Some(vec!["start".to_owned(), "duration".to_owned(), "clipId".to_owned()]) }
                            });
                        }
                    }
                }
            }
            "timeline.slip" => {
                // `edit::slip` moves the source In of the clip and of its linked clips by the delta,
                // clamped to the media: it reads their source In, speed, item, frame hold, link
                // and duration (the media they use), not where they are in the sequence.
                let ids: Vec<_> = named(params, "clips", "clip").into_iter().map(ClipId).collect();
                for clip in with_links(self, &ids) {
                    out.push(Premise {
                        id: clip.0,
                        fields: Some(["item", "sourceIn", "speed", "link", "props.frame_hold"].map(str::to_owned).to_vec()),
                        positions: Some(vec!["duration".to_owned()]),
                    });
                    if let Some((_, found)) = sequence.and_then(|q| q.find_item(clip))
                        && found.frame_hold.is_none()
                    {
                        out.extend(source_bounds(self, found.item));
                    }
                }
                if given(params, "deltaFrames")
                    && let Some(item) = item
                {
                    out.push(Premise::content(item, &["sequence.settings.settings.frame_rate"]));
                }
            }
            "sequence.setTransition" if !given(params, "params") && params.get("reset").and_then(Value::as_bool) != Some(true) => {
                // Only `reverse` is written; the transition's place and its clips are not read.
                if let Some(transition) = whole(params, "transition") {
                    out.push(Premise::content(transition, &["reverse"]));
                }
            }
            "markers.addChapter" | "markers.addFlashCue" if program && !given(params, "name") => {
                // The default name counts the markers of the kind.
                out.extend(item.map(|item| Premise::content(item, &["sequence.markers"])));
            }
            "clip.multicamFlatten" => {
                if let Some(sequence) = sequence {
                    let ids: Vec<_> = named(params, "clips", "clip").into_iter().map(ClipId).collect();
                    let ids = with_links(self, &ids);
                    for track in sequence.all_tracks() {
                        for clip in track.items.iter().filter(|clip| ids.contains(&clip.id) && clip.multicam.is_some_and(|mode| mode.enabled)) {
                            out.push(Premise { id: clip.id.0, fields: None, positions: None });
                            let Some(nested) = self.project.sequence(clip.item) else { continue };
                            out.push(Premise::content(clip.item.0, &["sequence.settings"]));
                            let tracks: Vec<_> = if track.kind == kition_film_project::TrackKind::Video {
                                let angle = clip.multicam.map(|mode| mode.angle as usize).unwrap_or(0);
                                nested.angle_video_track_index(angle).and_then(|index| nested.video_tracks.get(index)).into_iter().collect()
                            } else {
                                crate::multicam::audible(nested, clip).into_iter().filter_map(|id| nested.track(id)).collect()
                            };
                            for source in tracks {
                                out.push(Premise::content(source.id.0, &["clips"]));
                                out.extend(source.items.iter().map(|source| Premise { id: source.id.0, fields: None, positions: None }));
                            }
                        }
                    }
                }
            }
            "timeline.place" if !self.state.sequences_as_clips => {
                if let Some(source) = whole(params, "item").and_then(|id| self.project.item(kition_film_project::ItemId(id)))
                    && let Some(nested) = source.as_sequence()
                    && nested.multicam.is_none()
                {
                    let targeting = self.targeting();
                    let named = crate::commands::track_p(self, params, "track", command).ok().flatten();
                    let audio_track = named.is_some_and(|id| sequence.is_some_and(|q| q.audio_tracks.iter().any(|track| track.id == id)));
                    let mut fields = vec!["kind", "name", "props.common.label", "sequence.settings.multicam"];
                    if params.get("audio").and_then(Value::as_bool) != Some(false)
                        && (audio_track || given(params, "audioTrack") || targeting.audio_dest.is_some())
                    {
                        fields.push("~sourceHasAudio");
                    }
                    if params.get("duration").and_then(Value::as_i64).is_none() {
                        fields.push("sequence.duration");
                    }
                    if params.get("video").and_then(Value::as_bool) != Some(false)
                        && !audio_track
                        && (named.is_some() || params.get("track").and_then(Value::as_str) == Some("auto") || targeting.video_dest.is_some())
                    {
                        fields.extend(["sequence.settings.settings.width", "sequence.settings.settings.height", "~sourceGraphicDefinition"]);
                    }
                    out.push(Premise::content(source.id.0, &fields));
                }
            }
            "clip.speedDuration" | "timeline.trim" => {
                let ids: Vec<_> = named(params, "clips", "clip").into_iter().map(ClipId).collect();
                let ids = with_links(self, &ids);
                out.extend(ids.iter().map(|id| Premise { id: id.0, fields: None, positions: None }));
                if let Some(sequence) = sequence {
                    if let Some(under) = self.edit_neighbours_under(command, params) {
                        for id in &under.clips {
                            if !ids.contains(id) {
                                out.push(Premise { id: id.0, fields: Some(vec!["link".to_owned()]), positions: None });
                            }
                        }
                        for track in sequence.all_tracks() {
                            out.push(Premise::content(track.id.0, &["props.locked", "props.sync_lock"]));
                            out.extend(
                                track
                                    .transitions
                                    .iter()
                                    .filter(|transition| {
                                        transition.from.is_some_and(|id| under.clips.contains(&id)) || transition.to.is_some_and(|id| under.clips.contains(&id))
                                    })
                                    .map(|transition| Premise { id: transition.id.0, fields: None, positions: None }),
                            );
                        }
                    }
                    if command == "timeline.trim"
                        && self.state.ripple_sequence_markers
                        && let Some(item) = item
                    {
                        out.push(Premise::content(item, &["sequence.markers"]));
                    }
                }
            }
            "timeline.move" => {
                let clips = params
                    .get("moves")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| whole(entry, "clip"))
                    .map(ClipId)
                    .collect::<Vec<_>>();
                let follow = params.get("linked").and_then(Value::as_bool).unwrap_or(self.state.linked_selection);
                let mut held = clips.clone();
                if let Some(sequence) = sequence {
                    for clip in &clips {
                        for (_, partner) in crate::commands::move_partners(sequence, *clip, follow) {
                            if !held.contains(&partner.id) {
                                held.push(partner.id);
                            }
                        }
                    }
                }
                out.extend(held.into_iter().map(|clip| Premise { id: clip.0, fields: None, positions: None }));
                if let Some(sequence) = sequence {
                    let plan = crate::commands::move_plan(self, params).ok();
                    let insert = params.get("insert").and_then(Value::as_bool) == Some(true);
                    let links: Vec<_> = clips.iter().filter_map(|clip| sequence.find_item(*clip).and_then(|(_, clip)| clip.link)).collect();
                    // Lock and sync switches determine which linked and ripple partners participate.
                    for track in sequence.all_tracks() {
                        let participates = insert
                            || plan.as_ref().is_some_and(|plan| plan.moves.iter().any(|(_, destination, _)| *destination == track.id))
                            || track.items.iter().any(|clip| clips.contains(&clip.id) || (follow && clip.link.is_some_and(|link| links.contains(&link))));
                        if !participates {
                            continue;
                        }
                        let fields = if insert { vec!["props.locked".to_owned(), "props.sync_lock".to_owned()] } else { vec!["props.locked".to_owned()] };
                        out.push(Premise { id: track.id.0, fields: Some(fields), positions: Some(Vec::new()) });
                    }
                    if let Some(plan) = plan {
                        let mut affected: Vec<_> = plan.moves.iter().map(|(clip, _, _)| *clip).collect();
                        if let Ok(Some(under)) = self.under(command, params) {
                            affected.extend(under.clips);
                        }
                        for track in sequence.all_tracks() {
                            out.extend(
                                track
                                    .transitions
                                    .iter()
                                    .filter(|transition| {
                                        transition.from.is_some_and(|clip| affected.contains(&clip))
                                            || transition.to.is_some_and(|clip| affected.contains(&clip))
                                    })
                                    .map(|transition| Premise { id: transition.id.0, fields: None, positions: None }),
                            );
                        }
                        if plan.insert
                            && let Some(item) = item
                        {
                            for track in &sequence.caption_tracks {
                                let path = format!("sequence.captionTracks[id={}]", track.id.0);
                                let fields = if !track.locked && track.sync_lock {
                                    vec![path, format!("sequence.captions[track={}]", track.id.0)]
                                } else {
                                    vec![format!("{path}.locked"), format!("{path}.syncLock")]
                                };
                                out.push(Premise { id: item, fields: Some(fields), positions: Some(Vec::new()) });
                            }
                        }
                    }
                }
            }
            "audio.voiceover.start" => {
                if let Ok(track) = crate::voiceover::record_track(self, params) {
                    out.push(Premise { id: track.0, fields: None, positions: None });
                }
            }
            "effects.setParam" => {
                let unkeyed = |clip: u64| {
                    sequence
                        .and_then(|sequence| sequence.find_item(ClipId(clip)))
                        .is_some_and(|(_, found)| found.effects.iter().all(|effect| effect.params.values().all(|param| !param.is_animated())))
                };
                if let Some(clip) = whole(params, "clip")
                    && !TIME_KEYS.iter().any(|key| given(params, key))
                    && !given(params, "mask")
                    && unkeyed(clip)
                {
                    out.push(Premise::content(clip, &["effects"]));
                }
            }
            "effects.setKeyframe" | "effects.deleteKeyframe" | "effects.moveKeyframe" | "effects.setInterpolation" => {
                if let Some(clip) = whole(params, "clip")
                    && given(params, "mediaTime")
                {
                    out.push(Premise::content(clip, &["effects"]));
                }
            }
            "effects.toggleEnabled" => out.extend(whole(params, "clip").map(|clip| Premise::content(clip, &["effects"]))),
            "clip.enable" => {
                let clips: Vec<ClipId> = named(params, "clips", "clip").into_iter().map(ClipId).collect();
                if !clips.is_empty() {
                    out.extend(with_links(self, &clips).into_iter().map(|clip| Premise::content(clip.0, &["props.enabled", "link"])));
                }
            }
            "clip.rename" => match (whole(params, "item"), whole(params, "clip")) {
                (Some(item), _) => out.push(Premise::content(item, &["name"])),
                (None, Some(clip)) => out.push(Premise::content(clip, &["props.name"])),
                (None, None) => {}
            },
            "captions.setTrack" | "captions.deleteTrack" | "captions.setStyle" => {
                if let (Some(item), Some(sequence), Some(track)) = (item, sequence, crate::captions::track_param(self, params)) {
                    let path = format!("sequence.captionTracks[id={}]", track.0);
                    let mut fields = if command == "captions.deleteTrack" {
                        vec![path.clone(), format!("sequence.captions[track={}]", track.0)]
                    } else if command == "captions.setStyle" {
                        if params.get("reset").and_then(Value::as_bool) == Some(true) {
                            vec![format!("{path}.style")]
                        } else {
                            [
                                ("font", "font"),
                                ("size", "size"),
                                ("color", "color"),
                                ("background", "background"),
                                ("backgroundColor", "background_color"),
                                ("align", "align"),
                                ("anchor", "anchor"),
                                ("margin", "margin"),
                                ("lineSpacing", "line_spacing"),
                                ("outline", "outline"),
                                ("outlineColor", "outline_color"),
                                ("highlightColor", "highlight_color"),
                                ("highlightScale", "highlight_scale"),
                            ]
                            .into_iter()
                            .filter(|(key, _)| given(params, key))
                            .map(|(_, field)| format!("{path}.style.{field}"))
                            .collect()
                        }
                    } else {
                        [
                            ("name", "name"),
                            ("format", "format"),
                            ("language", "language"),
                            ("enabled", "enabled"),
                            ("locked", "locked"),
                            ("syncLock", "syncLock"),
                        ]
                        .into_iter()
                        .filter(|(key, _)| given(params, key))
                        .map(|(_, field)| format!("{path}.{field}"))
                        .collect()
                    };
                    // Existence is needed even for an empty patch.
                    fields.push(format!("{path}.id"));
                    // An ordinal or the default must keep naming the same track after a save.
                    if !params.get("track").is_some_and(Value::is_number)
                        && let Some(index) = sequence.caption_tracks.iter().position(|found| found.id == track)
                    {
                        fields.push(format!("sequence.captionTracks.{index}.id"));
                    }
                    out.push(Premise { id: item, fields: Some(fields), positions: Some(Vec::new()) });
                }
            }
            _ if command.starts_with("captions.") => {
                if let (Some(item), Some(sequence)) = (item, sequence) {
                    let given = named(params, "captions", "caption");
                    let ids: Vec<u64> = if given.is_empty() { crate::captions::caption_ids(self, params).iter().map(|id| id.0).collect() } else { given };
                    let paths: Vec<String> = ids
                        .iter()
                        .filter_map(|id| {
                            sequence
                                .caption_tracks
                                .iter()
                                .find_map(|track| track.captions.iter().any(|caption| caption.id.0 == *id).then(|| format!("sequence.captions[id={id}]")))
                        })
                        .collect();
                    if command == "captions.setText" && !paths.is_empty() && paths.len() == ids.len() {
                        // Named by id, the text (and speaker) alone is written and nothing read
                        // (C8-time-policy): a move of the caption in time does not refuse it. Found
                        // by time, the caption's time is what names it: the whole caption is held.
                        let by_id = !named(params, "captions", "caption").is_empty();
                        let mut paths = if by_id {
                            let keys: Vec<&str> = ["text", "speaker"].into_iter().filter(|key| params.get(*key).is_some()).collect();
                            if keys.is_empty() { paths } else { paths.iter().flat_map(|path| keys.iter().map(move |key| format!("{path}.{key}"))).collect() }
                        } else {
                            paths
                        };
                        for track in &sequence.caption_tracks {
                            if track.captions.iter().any(|c| ids.contains(&c.id.0)) {
                                paths.push(format!("sequence.captionTracks[id={}].locked", track.id.0));
                            }
                        }
                        out.push(Premise { id: item, fields: Some(paths), positions: Some(Vec::new()) });
                    } else if command == "captions.showAll" || command == "captions.hideAll" {
                        let fields = sequence.caption_tracks.iter().map(|track| format!("sequence.captionTracks[id={}].enabled", track.id.0)).collect();
                        out.push(Premise { id: item, fields: Some(fields), positions: Some(Vec::new()) });
                    } else if command == "captions.add" || command == "captions.trim" || command == "captions.setTimes" || command == "captions.move" {
                        let mut fields = Vec::new();
                        if command != "captions.move" || params.get("delta").and_then(Value::as_i64).is_none() {
                            fields.push("sequence.settings.settings.frame_rate".to_owned());
                        }
                        let track = crate::captions::track_param(self, params);
                        for (index, tr) in sequence.caption_tracks.iter().enumerate() {
                            let chosen = if command == "captions.add" { Some(tr.id) == track } else { tr.captions.iter().any(|c| ids.contains(&c.id.0)) };
                            if !chosen {
                                continue;
                            }
                            let path = format!("sequence.captionTracks[id={}]", tr.id.0);
                            fields.push(format!("{path}.locked"));
                            // The pinned SDK cannot replay time windows in a list by a member.
                            // Keep the track's membership (a caption added to it or taken out of
                            // it, `track` selects it) so newly inserted neighbours cannot escape
                            // the guard; hold timing leaves so text remains independent.
                            fields.push(format!("sequence.captions[track={}].id", tr.id.0));
                            for caption in &tr.captions {
                                fields.push(format!("sequence.captions[id={}].start", caption.id.0));
                                fields.push(format!("sequence.captions[id={}].duration", caption.id.0));
                            }
                            if command == "captions.add" && !params.get("track").is_some_and(Value::is_number) {
                                fields.push(format!("sequence.captionTracks.{index}.id"));
                            }
                        }
                        out.push(Premise { id: item, fields: Some(fields), positions: Some(Vec::new()) });
                    } else if CAPTION_EDITS.contains(&command) {
                        out.push(Premise::content(item, &["sequence.captionTracks", "sequence.captions"]));
                    }
                }
            }
            "clip.automateToSequence" if params.get("placement").and_then(Value::as_str) == Some("unnumberedMarkers") => {
                out.extend(item.map(|item| Premise::content(item, &["sequence.markers"])));
                if params.get("method").and_then(Value::as_str).unwrap_or("insert") == "insert"
                    && let (Some(item), Some(sequence)) = (item, sequence)
                {
                    // Marker inserts use edit::insert, which also ripples sync-locked captions.
                    out.extend(sequence.caption_tracks.iter().filter(|track| track.sync_lock && !track.locked).map(|track| {
                        Premise::content(item, &[&format!("sequence.captionTracks[id={}]", track.id.0), &format!("sequence.captions[track={}]", track.id.0)])
                    }));
                }
            }
            "markers.edit" if program => {
                if let (Some(item), Some(sequence), Some(marker)) = (item, sequence, whole(params, "marker")) {
                    // By its id, not its index (kition-sdk C8-fix-9 selectors): followed across others' saves.
                    if sequence.markers.iter().any(|found| found.id.0 == marker) {
                        // It writes the name, comment and colour given and reads nothing of the
                        // marker (C8-time-policy): a move of the marker in time does not refuse it.
                        // A new duration is its time: the whole marker is held then.
                        let path = format!("sequence.markers[id={marker}]");
                        let fields: Vec<String> = if given(params, "durationFrames") || given(params, "durationSeconds") {
                            vec![path]
                        } else {
                            ["name", "comment", "color"].iter().filter(|key| given(params, key)).map(|key| format!("{path}.{key}")).collect()
                        };
                        let fields = if fields.is_empty() { vec![format!("sequence.markers[id={marker}].id")] } else { fields };
                        out.push(Premise { id: item, fields: Some(fields), positions: Some(Vec::new()) });
                    } else {
                        out.push(Premise::content(item, &["sequence.markers"]));
                    }
                }
            }
            "markers.clearCurrent" if program => {
                out.extend(item.map(|item| Premise::content(item, &[&format!("sequence.markers[start={}]", self.playhead().0)])));
            }
            "markers.clearAll" if program => out.extend(item.map(|item| Premise::content(item, &["sequence.markers"]))),
            _ => {}
        }
        if matches!(command, "timeline.place" | "timeline.move" | "timeline.trim") && given(params, "snap") {
            let kinds: Vec<&str> = match params.get("snap") {
                Some(Value::String(kind)) => vec![kind.as_str()],
                Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).collect(),
                _ => Vec::new(),
            };
            if kinds.contains(&"markers") {
                out.extend(item.map(|item| Premise::content(item, &["sequence.markers"])));
            }
            if kinds.contains(&"beats")
                && let Some(sequence) = sequence
            {
                out.extend(sequence.audio_tracks.iter().flat_map(|track| &track.items).map(|clip| Premise { id: clip.id.0, fields: None, positions: None }));
            }
        }
        if command == "sequence.addEditAllTracks" {
            out.extend(item.map(|item| Premise::content(item, &["sequence.captionTracks", "sequence.captions"])));
        }
        out
    }
}
