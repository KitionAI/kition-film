//! Dependencies of the independently read core write paths.
use kition_film_engine::Session;
use kition_kit::{Premise, Under};
use serde_json::{Value, json};

/// Add reviewed implicit inputs and assignments without discarding each
/// command's existing target holds or positional address.
pub fn complete(session: &Session, command: &str, params: &Value, under: Option<Under>) -> Option<Under> {
    if matches!(command, "timeline.place" | "source.insert" | "source.overwrite" | "clip.automateToSequence") {
        return under;
    }
    let under = super::rests_edit_inputs::complete(session, command, params, under);
    let under = marker_timebase(session, command, params, under);
    let under = cut_inputs(session, command, params, under);
    let under = super::rests_navigation::source_marker_inputs(session, command, params, under);
    let under = if matches!(command, "markers.markClip" | "markers.markSelection") {
        let mut answer = under.unwrap_or_default();
        if let Some(sequence) = session.state.active_sequence {
            if command == "markers.markClip" {
                answer
                    .premises
                    .push(Premise::on(json!(sequence.0)).fields(["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]).positions(Vec::<String>::new()));
            }
            answer.premises.push(
                Premise::on(json!(sequence.0))
                    .fields(["sequence.settings.mark_in", "sequence.settings.mark_out", "sequence.settings.settings.frame_rate"])
                    .positions(Vec::<String>::new()),
            );
        }
        if let Some(q) = session.active_sequence() {
            let selected = if command == "markers.markSelection" {
                session.state.selection.clone()
            } else {
                let targeted = session.targeting().targeted;
                q.all_tracks()
                    .filter(|track| targeted.contains(&track.id))
                    .find_map(|track| track.item_at(session.playhead()).map(|clip| vec![clip.id]))
                    .unwrap_or_default()
            };
            for clip in selected {
                answer.premises.push(Premise::on(json!(clip.0)).fields(Vec::<String>::new()).positions(["start", "duration"]));
            }
        }
        Some(answer)
    } else {
        under
    };
    let under = if matches!(
        command,
        "graphics.newText"
            | "graphics.newVerticalText"
            | "graphics.newShape"
            | "graphics.newRectangle"
            | "graphics.newEllipse"
            | "graphics.newPolygon"
            | "graphics.newFromFile"
    ) {
        let mut answer = under.unwrap_or_default();
        let explicit_new = matches!(command, "graphics.newText" | "graphics.newVerticalText") && params.get("newClip").and_then(Value::as_bool) == Some(true);
        let clip = if explicit_new { None } else { kition_film_engine::commands::clip_p(params, "clip") };
        if let Some(clip) = clip.and_then(|id| session.active_sequence().and_then(|q| q.find_item(id)).map(|(_, clip)| clip)) {
            answer.premises.push(Premise::on(json!(clip.id.0)).fields(["item"]).positions(Vec::<String>::new()));
            answer.premises.push(Premise::on(json!(clip.item.0)).fields(["kind"]).positions(Vec::<String>::new()));
        }
        let existing = clip.is_some_and(|clip| session.active_sequence().is_some_and(|q| kition_film_engine::graphics::is_graphic(session, q, clip)));
        if !existing && let Some(id) = session.state.active_sequence {
            // graphics::place_video_clip creates intrinsic Motion from the frame
            // size and snaps both placement and duration to this timebase.
            answer.premises.push(
                Premise::on(json!(id.0))
                    .fields(["sequence.settings.settings.width", "sequence.settings.settings.height", "sequence.settings.settings.frame_rate"])
                    .positions(Vec::<String>::new()),
            );
        }
        Some(answer)
    } else {
        under
    };
    let under = if command == "file.newSequenceFromClip" {
        let sources: Vec<_> = kition_film_engine::clip_ops::items_p(session, params)
            .into_iter()
            .filter(|id| kition_film_engine::clip_ops::is_clip_item(&session.project, *id))
            .collect();
        let mut answer = under.unwrap_or_default();
        // Copy stored source fields without unrelated computed navigation
        // facts, whose inherited rates are not read by a later subclip.
        answer
            .premises
            .extend(sources.iter().map(|source| Premise::on(json!(source.0)).fields(["kind", "name", "props", "sequence", "~sourceGraphicDefinition"])));
        for (index, source) in sources.into_iter().enumerate() {
            if !matches!(session.project.item(source).map(|item| &item.kind), Some(kition_film_engine::project::ItemKind::Subclip { .. })) {
                continue;
            }
            // Placement reads the same bounded media route and dimensions as
            // file.newSequence. Unlike that command, this wrapper inherits
            // first-source settings through the media parent (clip_ops:665-673).
            let inputs = new_sequence(session, &json!({"fromItem":source.0}));
            answer.premises.extend(inputs.premises);
            if index == 0
                && let Some((parent, _, _)) = session.project.resolve_media(source)
            {
                answer.premises.push(
                    Premise::on(json!(parent.0))
                        .fields(["props.media.info.video.frame_rate", "props.media.info.audio_streams.0.sample_rate"])
                        .positions(Vec::<String>::new()),
                );
            }
        }
        Some(answer)
    } else {
        under
    };
    let under = if command == "file.newSequence" && params.get("name").and_then(Value::as_str).is_none() {
        let mut answer = under.unwrap_or_default();
        answer.premises.push(Premise::on(json!("project")).fields(["~sequenceCount"]).positions(Vec::<String>::new()));
        Some(answer)
    } else {
        under
    };
    if !session.state.linked_selection {
        return under;
    }
    let selection = matches!(command, "edit.cut" | "edit.copy" | "clip.nest" | "sequence.makeSubsequence");
    let follows = selection
        || matches!(
            command,
            "edit.clear"
                | "edit.rippleDelete"
                | "clip.speedDuration"
                | "clip.enable"
                | "timeline.trim"
                | "timeline.slip"
                | "timeline.slipLeft"
                | "timeline.slipRight"
                | "timeline.slipLeft5"
                | "timeline.slipRight5"
                | "timeline.slide"
                | "timeline.rateStretch"
                | "timeline.razor"
                | "timeline.select"
                | "edit.pasteAttributes"
                | "edit.removeAttributes"
                | "clip.audioGain"
                | "clip.audioPeak"
                | "clip.synchronize"
                | "clip.multicamEnable"
                | "clip.multicamFlatten"
                | "sequence.joinThroughEdits"
                | "clip.replaceFromSource"
                | "clip.replaceFromSourceMatchFrame"
                | "clip.replaceFromBin"
        )
        || (command.starts_with("audioMixing.") && !matches!(command, "audioMixing.deletePreset"));
    if !follows
        || (command == "timeline.select" && params.get("linked").and_then(Value::as_bool) == Some(false))
        || (command == "timeline.razor" && params.get("clip").is_none())
        || (command == "sequence.joinThroughEdits" && params.get("all").and_then(Value::as_bool) == Some(true))
    {
        return under;
    }
    session.active_sequence()?;
    let clips = if selection { session.state.selection.clone() } else { kition_film_engine::commands::clips_p(session, params) };
    if clips.is_empty() {
        return under;
    }
    let mut answer = under.unwrap_or_default();
    for id in clips {
        // A supplemental link fact must not replace the SDK's whole-target
        // default when no earlier handler narrowed this target explicitly.
        if !answer.premises.iter().any(|held| held.id == json!(id.0)) {
            answer.premises.push(Premise::on(json!(id.0)));
        }
        answer.premises.push(Premise::on(json!(id.0)).fields(["link", "~linkedGroup"]).positions(Vec::<String>::new()));
        if let Some(q) = session.active_sequence()
            && let Some(link) = q.find_item(id).and_then(|(_, clip)| clip.link)
            && let Some(root) = q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(link)).map(|clip| clip.id.0).min()
        {
            answer.premises.push(Premise::on(json!(root)).fields(["~linkedMembers"]).positions(Vec::<String>::new()));
        }
    }
    Some(answer)
}

fn cut_inputs(session: &Session, command: &str, params: &Value, under: Option<Under>) -> Option<Under> {
    if !matches!(command, "timeline.razor" | "sequence.addEdit" | "sequence.addEditAllTracks") {
        return under;
    }
    let Some(q) = session.active_sequence() else { return under };
    let Some(seq) = session.state.active_sequence else { return under };
    let mut answer = under.unwrap_or_default();
    let clip = kition_film_engine::commands::clip_p(params, "clip");
    let ids = clip.map(|id| kition_film_engine::commands::with_links(session, &[id])).unwrap_or_default();
    let track = super::rests_sequences::track_id(session, params.get("track"));
    for lane in
        q.all_tracks().filter(|lane| if clip.is_some() { lane.items.iter().any(|clip| ids.contains(&clip.id)) } else { track.is_none_or(|id| id == lane.id) })
    {
        answer.premises.push(Premise::on(json!(lane.id.0)).fields(["props.locked", "transitions"]).positions(Vec::<String>::new()));
    }
    if clip.is_none() && track.is_none() {
        answer.premises.push(Premise::on(json!(seq.0)).fields(["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]).positions(Vec::<String>::new()));
    }
    if params.get("time").and_then(Value::as_i64).is_none() {
        let frames = params.get("frame").and_then(Value::as_i64).is_some();
        let timecode = !frames && params.get("seconds").and_then(Value::as_f64).is_none() && params.get("timecode").and_then(Value::as_str).is_some();
        if frames || timecode {
            let fields = if timecode {
                vec!["sequence.settings.settings.frame_rate", "sequence.settings.settings.drop_frame"]
            } else {
                vec!["sequence.settings.settings.frame_rate"]
            };
            answer.premises.push(Premise::on(json!(seq.0)).fields(fields).positions(Vec::<String>::new()));
        }
    }
    Some(answer)
}

fn marker_timebase(session: &Session, command: &str, params: &Value, under: Option<Under>) -> Option<Under> {
    let add = matches!(command, "markers.add" | "markers.addRange" | "markers.addChapter" | "markers.addFlashCue");
    let mark = matches!(command, "markers.markIn" | "markers.markOut") || command.starts_with("markers.markSplit");
    if !add && !mark && command != "markers.edit" {
        return under;
    }
    let duration = matches!(command, "markers.add" | "markers.addRange" | "markers.edit")
        && !(command == "markers.addRange" && params.get("duration").and_then(Value::as_i64).is_some())
        && (params.get("durationFrames").is_some() || params.get("durationSeconds").is_some());
    if params.get("target").and_then(Value::as_str) == Some("source") {
        if !matches!(command, "markers.add" | "markers.edit") || params.get("durationFrames").is_none() {
            return under;
        }
        let Some(source) = session.state.source_item else { return under };
        let Some(view) = kition_film_engine::clip_ops::source_view(session, source) else { return under };
        let mut answer = under.unwrap_or_default();
        let mut current = source;
        for _ in 0..=16 {
            answer.premises.push(Premise::on(json!(current.0)).fields(["kind", "props.parent"]).positions(Vec::<String>::new()));
            let Some(kition_film_engine::project::ItemKind::Subclip { parent, .. }) = session.project.item(current).map(|item| &item.kind) else { break };
            current = *parent;
        }
        let field = match session.project.item(view.media).map(|item| &item.kind) {
            Some(kition_film_engine::project::ItemKind::Sequence(_)) => "sequence.settings.settings.frame_rate",
            Some(kition_film_engine::project::ItemKind::Media(_)) => "props.media.info.video.frame_rate",
            _ => "props.rate",
        };
        answer.premises.push(Premise::on(json!(view.media.0)).fields([field]).positions(Vec::<String>::new()));
        return Some(answer);
    }
    let ticks = params.get("time").and_then(Value::as_i64).is_some();
    let frames = !ticks && params.get("frame").and_then(Value::as_i64).is_some();
    let seconds = !ticks && !frames && params.get("seconds").and_then(Value::as_f64).is_some();
    let timecode = !ticks && !frames && !seconds && params.get("timecode").and_then(Value::as_str).is_some();
    let snapped_seconds = add && params.get("time").is_none() && params.get("frame").is_none() && seconds;
    let default_range = command == "markers.addRange" && params.get("duration").and_then(Value::as_i64).is_none();
    if !(duration || default_range || ((add || mark) && (frames || timecode || snapped_seconds))) {
        return under;
    }
    let Some(sequence) = session.state.active_sequence else { return under };
    let mut answer = under.unwrap_or_default();
    let mut fields = vec!["sequence.settings.settings.frame_rate"];
    if (add || mark) && timecode {
        fields.push("sequence.settings.settings.drop_frame");
    }
    answer.premises.push(Premise::on(json!(sequence.0)).fields(fields).positions(Vec::<String>::new()));
    Some(answer)
}

/// Content-only patches still resolve clip ids inside the active sequence.
/// Keep normal track/time moves independent; when the id has departed that
/// scope, retain its ordinary relocation premise instead of dropping the id.
pub(super) fn scoped_clip_fields(session: &Session, id: kition_film_engine::project::ClipId, fields: impl IntoIterator<Item = String>) -> Premise {
    let premise = Premise::on(json!(id.0)).fields(fields);
    if session.active_sequence().is_some_and(|sequence| sequence.find_item(id).is_some()) { premise.positions(Vec::<String>::new()) } else { premise }
}

/// The ranges the Source-sequence copy branch actually receives, independent of
/// which Source the editor currently shows. Also used for historical profiles.
pub(super) fn source_sequence_copy_ranges(
    session: &Session,
    item: kition_film_engine::project::ItemId,
) -> Option<(kition_film_time::TimeRange, kition_film_time::TimeRange)> {
    let source = session.project.sequence(item).filter(|q| q.multicam.is_none())?;
    // The real command catches malformed range arithmetic as an edit failure.
    // Premise discovery must not introduce that arithmetic outside its wrapper.
    let frame = source.settings.frame_rate.frame_duration().0;
    let valid = |time: kition_film_time::Tick| time.0 >= 0 && time.0.checked_add(frame).is_some();
    if source.mark_in.into_iter().chain(source.mark_out).any(|time| !valid(time))
        || session.project.item(item).is_some_and(|item| {
            [item.split.video_in, item.split.video_out, item.split.audio_in, item.split.audio_out].into_iter().flatten().any(|time| !valid(time))
        })
        || source
            .all_tracks()
            .any(|track| track.items.iter().any(|clip| clip.start.0 < 0 || clip.duration.0 < 0 || clip.start.0.checked_add(clip.duration.0).is_none()))
    {
        return None;
    }
    let (_, full) = kition_film_engine::commands::source_range(session, item)?;
    let (video, audio) = kition_film_engine::sequence_tools::split_source_ranges(session, item, full);
    // Equal split ranges still replace the ordinary Source range.
    Some((video, audio))
}

/// Source membership of New Sequence's full-item copy, independent of Source
/// monitor marks. Saturating ends keep discovery safe for malformed input.
pub(super) fn new_sequence_material(q: &kition_film_engine::project::Sequence, tracks: &[kition_film_engine::project::Track]) -> Value {
    let media_end = q.all_tracks().flat_map(|track| &track.items).map(|clip| clip.start.0.saturating_add(clip.duration.0)).max().unwrap_or(0);
    let caption_end =
        q.caption_tracks.iter().flat_map(|track| &track.captions).map(|caption| caption.start.0.saturating_add(caption.duration.0)).max().unwrap_or(0);
    let end = media_end.max(caption_end);
    let lanes: Vec<_> = tracks
        .iter()
        .filter_map(|track| {
            let clips: std::collections::BTreeSet<_> =
                track.items.iter().filter(|clip| clip.start.0 < end && clip.start.0.saturating_add(clip.duration.0) > 0).map(|clip| clip.id).collect();
            if clips.is_empty() {
                return None;
            }
            let ordered: Vec<_> = track.items.iter().filter(|clip| clips.contains(&clip.id)).map(|clip| clip.id.0).collect();
            let transitions: Vec<_> = track
                .transitions
                .iter()
                .filter(|transition| {
                    transition.start.0 >= 0
                        && transition.start.0.checked_add(transition.duration.0).is_some_and(|to| to <= end)
                        && transition.from.is_none_or(|id| clips.contains(&id))
                        && transition.to.is_none_or(|id| clips.contains(&id))
                })
                .map(|transition| transition.id.0)
                .collect();
            Some(json!({"clips":ordered,"transitions":transitions}))
        })
        .collect();
    json!(lanes)
}

/// New Sequence creates its destination before resolving targeting.
/// Only source facts survive from the observed project (commands.rs:943-1000).
fn new_sequence(session: &Session, params: &Value) -> Under {
    use kition_film_engine::project::ItemKind;
    let mut answer = Under::default();
    let Some(source) = kition_film_engine::commands::item_p(params, "fromItem") else { return answer };
    let Some(item) = session.project.item(source) else { return answer };
    let video = params.get("video").and_then(Value::as_f64) != Some(0.0);
    let audio = params.get("audio").and_then(Value::as_f64) != Some(0.0);
    let flatten = session.state.sequences_as_clips && item.as_sequence().is_some_and(|q| q.multicam.is_none());
    let mut fields = vec!["kind"];
    if !flatten {
        fields.extend(["name", "props.common.label"]);
        if video {
            fields.push("~sourceGraphicDefinition");
        }
    }
    match &item.kind {
        ItemKind::Media(_) => {
            fields.push("props.media.info.duration");
            for (parameter, field) in [
                ("width", "props.media.info.video.width"),
                ("height", "props.media.info.video.height"),
                ("fps", "props.media.info.video.frame_rate"),
                ("sampleRate", "props.media.info.audio_streams.0.sample_rate"),
            ] {
                if !params.get(parameter).is_some_and(Value::is_number) {
                    fields.push(field);
                }
            }
        }
        ItemKind::Subclip { .. } => fields.push("props.range.duration"),
        ItemKind::Sequence(_) => {
            fields.extend(["sequence.duration", "sequence.settings.multicam"]);
            if !flatten && audio {
                fields.push("~sourceHasAudio");
            }
        }
        ItemKind::AdjustmentLayer { .. } => fields.push("props.duration"),
        ItemKind::Graphic { .. } => {}
    }
    answer.premises.push(Premise::on(json!(source.0)).fields(fields).positions(Vec::<String>::new()));
    if flatten {
        if let Some(q) = item.as_sequence() {
            // The ordinary full-item duration includes every valid media clip.
            // Empty lanes and their names/locks are not copied. Membership must
            // also survive a clip/transition leaving before today's under call.
            for (enabled, tracks, field) in [(video, &q.video_tracks, "~newSequenceVideoMaterial"), (audio, &q.audio_tracks, "~newSequenceAudioMaterial")] {
                if !enabled {
                    continue;
                }
                answer.premises.push(Premise::on(json!(source.0)).fields([field]).positions(Vec::<String>::new()));
                for lane in new_sequence_material(q, tracks).as_array().into_iter().flatten() {
                    for key in ["clips", "transitions"] {
                        answer.premises.extend(lane[key].as_array().into_iter().flatten().cloned().map(Premise::on));
                    }
                }
            }
        }
        return answer;
    }
    // resolve_media/source_size follow at most sixteen parent links. Parent
    // names, marks, ranges and metadata are not inherited by this placement.
    let mut next = Some(source);
    for _ in 0..16 {
        let Some(id) = next.take() else { break };
        let Some(item) = session.project.item(id) else {
            answer.premises.push(Premise::on(json!(id.0)).fields(["kind"]).positions(Vec::<String>::new()));
            break;
        };
        let mut fields = vec!["kind"];
        match &item.kind {
            ItemKind::Subclip { parent, .. } => {
                fields.push("props.parent");
                next = Some(*parent);
            }
            ItemKind::Media(_) => {
                if video {
                    fields.extend(["props.media.info.video.width", "props.media.info.video.height"]);
                }
                if audio {
                    fields.push("~sourceAudioPlacement");
                }
            }
            ItemKind::Sequence(_) => {
                if video {
                    fields.extend(["sequence.settings.settings.width", "sequence.settings.settings.height"]);
                }
            }
            ItemKind::AdjustmentLayer { .. } | ItemKind::Graphic { .. } => {
                if video {
                    fields.extend(["props.width", "props.height"]);
                }
            }
        }
        answer.premises.push(Premise::on(json!(id.0)).fields(fields).positions(Vec::<String>::new()));
    }
    answer
}

// kdm-model/src/props.rs:120-138 stores every Item kind's metadata through
// ItemCommon; keyboard::poster_item is the shared target resolver.
fn poster_dependencies(session: &Session, command: &str, params: &Value) -> Option<Under> {
    use kition_film_engine::project::ItemKind;
    let source = kition_film_engine::keyboard::poster_item(session, params)?;
    let mut answer = Under {
        premises: vec![Premise::on(json!(source.0)).fields(["kind", "props.common.metadata.Poster Frame"]).positions(Vec::<String>::new())],
        ..Default::default()
    };
    if command == "clip.clearPosterFrame" {
        return Some(answer);
    }
    let (_, time) = kition_film_engine::keyboard::poster_target(session, params)?;
    let uses_source = params.get("item").and_then(Value::as_u64).is_none() && session.state.source_item == Some(source);
    if !uses_source
        && (params.get("frame").and_then(Value::as_i64).is_some() || params.get("timecode").and_then(Value::as_str).is_some())
        && let Some(sequence) = session.state.active_sequence
    {
        let mut fields = vec!["sequence.settings.settings.frame_rate"];
        if params.get("timecode").and_then(Value::as_str).is_some() {
            fields.push("sequence.settings.settings.drop_frame");
        }
        answer.premises.push(Premise::on(json!(sequence.0)).fields(fields).positions(Vec::<String>::new()));
    }
    // Snapping zero is independent of the source timebase. Clear never snaps.
    if time.0 == 0 {
        return Some(answer);
    }
    let mut id = source;
    for _ in 0..16 {
        let Some(item) = session.project.item(id) else { break };
        let mut fields = vec!["kind"];
        let parent = match &item.kind {
            ItemKind::Media(media) => {
                fields.push("props.media.interpret.frame_rate");
                if media.interpret.frame_rate.is_none() {
                    fields.push("props.media.info.video.frame_rate");
                }
                None
            }
            ItemKind::Subclip { parent, .. } => {
                fields.push("props.parent");
                Some(*parent)
            }
            _ => None,
        };
        answer.premises.push(Premise::on(json!(id.0)).fields(fields).positions(Vec::<String>::new()));
        let Some(parent) = parent else { break };
        id = parent;
    }
    // With no media parent, ProjectItem::frame_rate consumes only the original
    // item's timebase (a subclip's fallback is a fixed default).
    let fallback = match session.project.item(source).map(|item| &item.kind) {
        Some(ItemKind::Sequence(_)) => Some("sequence.settings.settings.frame_rate"),
        Some(ItemKind::Graphic { .. }) => Some("props.rate"),
        _ => None,
    };
    if let Some(field) = fallback {
        answer.premises.push(Premise::on(json!(source.0)).fields([field]).positions(Vec::<String>::new()));
    }
    Some(answer)
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if matches!(
        command,
        "edit.selectAllMatching" | "edit.selectLabelGroup" | "edit.removeUnused" | "edit.consolidateDuplicates" | "edit.find" | "edit.findNext"
    ) {
        let timeline = command == "edit.selectAllMatching" || command == "edit.selectLabelGroup" && !session.state.selection.is_empty();
        let premise = if timeline {
            Premise::on(json!(session.state.active_sequence?.0)).fields(["sequence"]).positions(Vec::<String>::new())
        } else {
            Premise::on(json!("project"))
        };
        return Some(Under { premises: vec![premise], ..Default::default() });
    }
    if matches!(command, "timeline.slip" | "timeline.slipLeft" | "timeline.slipRight" | "timeline.slipLeft5" | "timeline.slipRight5") {
        return slip_inputs(session, command, params);
    }
    if matches!(
        command,
        "file.newAdjustmentLayer" | "file.newBarsAndTone" | "file.newBlackVideo" | "file.newColorMatte" | "file.newCountingLeader" | "file.newTransparentVideo"
    ) {
        // `seconds` is the new source's duration, not a Program address.
        return Some(Under {
            premises: session
                .premises(command, params)
                .into_iter()
                .map(|held| Premise { id: json!(held.id), fields: held.fields, positions: held.positions, ..Default::default() })
                .collect(),
            ..Default::default()
        });
    }
    if matches!(command, "clip.setPosterFrame" | "clip.clearPosterFrame") {
        return poster_dependencies(session, command, params);
    }
    if command == "file.newSequence" {
        return Some(new_sequence(session, params));
    }
    if matches!(command, "file.newProject" | "file.openDemoProject" | "file.revert" | "file.saveAll" | "file.newProjectFromTemplate") {
        return Some(Under { premises: vec![Premise::on(json!("project"))], ..Default::default() });
    }
    if command == "file.newOfflineFile" {
        let id = session.state.active_sequence?;
        let mut fields = Vec::new();
        if params.get("fps").and_then(Value::as_f64).is_none() {
            fields.push("sequence.settings.settings.frame_rate");
        }
        if params.get("video").and_then(Value::as_bool) != Some(false) {
            for field in ["width", "height"] {
                let Ok(dimension) = kition_film_engine::commands::checked_u32_p(params, field, command) else { return None };
                if dimension.is_none() {
                    fields.push(if field == "width" { "sequence.settings.settings.width" } else { "sequence.settings.settings.height" });
                }
            }
        }
        return Some(Under { premises: vec![Premise::on(json!(id.0)).fields(fields).positions(Vec::<String>::new())], ..Default::default() });
    }
    if command == "project.setMarks" {
        let id = kition_film_engine::commands::item_p(params, "item").or(session.state.source_item)?;
        return source_marks(session, id, params.get("in").is_some(), params.get("out").is_some());
    }
    if params.get("target").and_then(Value::as_str) == Some("source")
        && matches!(command, "markers.markIn" | "markers.markOut" | "markers.clearIn" | "markers.clearOut" | "markers.clearInOut")
    {
        return source_marks(
            session,
            session.state.source_item?,
            matches!(command, "markers.markIn" | "markers.clearIn" | "markers.clearInOut"),
            matches!(command, "markers.markOut" | "markers.clearOut" | "markers.clearInOut"),
        );
    }
    if matches!(command, "clip.link" | "clip.group" | "clip.ungroup" | "clip.enable" | "clip.scaleToFrameSize" | "timeline.select") {
        let clips = if matches!(command, "clip.group" | "clip.ungroup" | "clip.scaleToFrameSize") {
            session.state.selection.clone()
        } else {
            kition_film_engine::commands::clips_p(session, params)
        };
        let clips = if command == "clip.enable" { kition_film_engine::commands::with_links(session, &clips) } else { clips };
        let fields: &[&str] = match command {
            "clip.link" => &["link"],
            "clip.group" | "clip.ungroup" => &["group"],
            "clip.enable" => &["props.enabled", "link"],
            "clip.scaleToFrameSize" => &["props.scale_to_frame"],
            _ => &[],
        };
        return Some(Under {
            premises: clips
                .iter()
                .map(|id| {
                    if command == "timeline.select" {
                        Premise::on(json!(id.0)).fields(fields.iter().copied()).positions(Vec::<String>::new())
                    } else {
                        scoped_clip_fields(session, *id, fields.iter().map(|field| (*field).to_owned()))
                    }
                })
                .collect(),
            ..Default::default()
        });
    }
    if command == "clip.rename" {
        let target = params.get("item").and_then(|_| kition_film_engine::commands::item_p(params, "item")).map(|id| (id.0, "name")).or_else(|| {
            kition_film_engine::commands::clip_p(params, "clip").or_else(|| session.state.selection.first().copied()).map(|id| (id.0, "props.name"))
        });
        return Some(Under {
            premises: target
                .into_iter()
                .map(|(id, field)| {
                    if field == "props.name" {
                        scoped_clip_fields(session, kition_film_engine::project::ClipId(id), [field.to_owned()])
                    } else {
                        Premise::on(json!(id)).fields([field]).positions(Vec::<String>::new())
                    }
                })
                .collect(),
            ..Default::default()
        });
    }
    if command == "project.matteColor" {
        let id = kition_film_engine::commands::item_p(params, "item").map(|id| id.0).or(match session.state.project_selection.as_slice() {
            [id] => Some(id.0),
            _ => None,
        })?;
        return Some(Under {
            premises: vec![Premise::on(json!(id)).fields(["kind", "props.media.media"]).positions(Vec::<String>::new())],
            ..Default::default()
        });
    }
    if command == "edit.duplicate" {
        let premises = session
            .state
            .project_selection
            .iter()
            .filter_map(|id| session.project.item(*id))
            .map(|item| {
                use kition_film_engine::project::ItemKind;
                let mut fields = vec!["kind", "name", "props.common.label"];
                fields.extend(match &item.kind {
                    ItemKind::Sequence(_) => vec!["sequence"],
                    ItemKind::Media(_) => vec!["props.media"],
                    ItemKind::Subclip { .. } => vec!["props.parent", "props.range", "props.restrict_trims"],
                    ItemKind::AdjustmentLayer { .. } => vec!["props.width", "props.height", "props.rate", "props.duration"],
                    ItemKind::Graphic { .. } => vec!["props.width", "props.height", "props.rate"],
                });
                Premise::on(json!(item.id.0)).fields(fields).positions(Vec::<String>::new())
            })
            .collect();
        return Some(Under { premises, ..Default::default() });
    }
    if command == "source.open" {
        let item = kition_film_engine::commands::item_p(params, "item").or_else(|| session.state.project_selection.first().copied())?;
        let mut answer = Under::default();
        let mut current = item;
        for _ in 0..=16 {
            let Some(source) = session.project.item(current) else { break };
            let mut fields = vec!["kind"];
            if let kition_film_engine::project::ItemKind::Subclip { parent, restrict_trims, .. } = &source.kind {
                fields.extend(["props.parent", "props.restrict_trims"]);
                if *restrict_trims {
                    fields.push("props.range.start");
                }
                answer.premises.push(Premise::on(json!(current.0)).fields(fields).positions(Vec::<String>::new()));
                current = *parent;
            } else {
                answer.premises.push(Premise::on(json!(current.0)).fields(fields).positions(Vec::<String>::new()));
                break;
            }
        }
        return Some(answer);
    }
    if params.get("target").and_then(Value::as_str) != Some("source") || !kition_film_engine::source_monitor::source_command(command) {
        return None;
    }
    let item = session.state.source_item?;
    let view = kition_film_engine::clip_ops::source_view(session, item)?;
    let mut answer = Under::default();
    // A subclip's source route is part of the address. The marker itself lives
    // on the resolved media/sequence, rather than on that subclip.
    let mut current = item;
    for _ in 0..=16 {
        answer.premises.push(Premise::on(json!(current.0)).fields(["kind", "props.parent"]).positions(Vec::<String>::new()));
        let Some(kition_film_engine::project::ItemKind::Subclip { parent, .. }) = session.project.item(current).map(|item| &item.kind) else { break };
        current = *parent;
    }
    let sequence = session.project.sequence(view.media).is_some();
    let markers = if sequence { "sequence.markers" } else { "markers" };
    let fields = match command {
        "markers.edit" => {
            let marker = params.get("marker").and_then(Value::as_u64)?;
            let prefix = format!("{markers}[id={marker}]");
            let mut fields = vec![format!("{prefix}.id")];
            fields.extend(["name", "comment", "color"].into_iter().filter(|key| params.get(*key).is_some()).map(|key| format!("{prefix}.{key}")));
            if params.get("durationFrames").is_some() {
                fields.extend([format!("{prefix}.start"), format!("{prefix}.duration")]);
            }
            fields
        }
        "markers.clearAll" | "markers.clearCurrent" | "markers.goNext" | "markers.goPrev" => vec![markers.to_owned()],
        _ => return None,
    };
    answer.premises.push(Premise::on(json!(view.media.0)).fields(fields).positions(Vec::<String>::new()));
    Some(answer)
}

fn slip_inputs(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let sequence = session.state.active_sequence?;
    let q = session.active_sequence()?;
    let direct = command == "timeline.slip";
    let base = if direct { kition_film_engine::commands::clip_p(params, "clip").into_iter().collect() } else { session.state.selection.clone() };
    let mut answer = Under::default();
    if !direct || params.get("delta").and_then(Value::as_i64).is_none() {
        answer.premises.push(Premise::on(json!(sequence.0)).fields(["sequence.settings.settings.frame_rate"]).positions(Vec::<String>::new()));
    }
    for id in kition_film_engine::commands::with_links(session, &base) {
        let Some((_, clip)) = q.find_item(id) else {
            answer.premises.push(Premise::on(json!(id.0)).fields(["item", "sourceIn", "speed", "props.frame_hold", "link"]));
            continue;
        };
        answer.premises.push(Premise::on(json!(id.0)).fields(["item", "sourceIn", "speed", "props.frame_hold", "link"]).positions(["duration"]));
        if clip.frame_hold.is_none() {
            source_bounds(session, clip.item, &mut answer);
        }
    }
    Some(answer)
}

pub(super) fn source_bounds(session: &Session, mut id: kition_film_engine::project::ItemId, answer: &mut Under) {
    use kition_film_engine::project::ItemKind;
    for _ in 0..=16 {
        let Some(item) = session.project.item(id) else { break };
        let mut fields = vec!["kind"];
        let next = match &item.kind {
            ItemKind::Subclip { parent, restrict_trims, .. } => {
                fields.push("props.restrict_trims");
                if *restrict_trims {
                    fields.push("props.range");
                    None
                } else {
                    fields.push("props.parent");
                    Some(*parent)
                }
            }
            ItemKind::Media(media) => {
                fields.push("props.media.info.kind");
                if !matches!(media.info.kind, kition_film_media::MediaKind::Still | kition_film_media::MediaKind::Synthetic) {
                    fields.push("props.media.info.duration");
                }
                None
            }
            ItemKind::Sequence(_) => {
                fields.push("sequence.duration");
                None
            }
            ItemKind::AdjustmentLayer { .. } | ItemKind::Graphic { .. } => None,
        };
        answer.premises.push(Premise::on(json!(id.0)).fields(fields).positions(Vec::<String>::new()));
        let Some(parent) = next else { break };
        id = parent;
    }
}

fn source_marks(session: &Session, id: kition_film_engine::project::ItemId, mark_in: bool, mark_out: bool) -> Option<Under> {
    use kition_film_engine::project::ItemKind;
    let item = session.project.item(id)?;
    let mut fields = Vec::new();
    if mark_in || mark_out {
        fields.push("kind");
    }
    for (set, side) in [(mark_in, "in"), (mark_out, "out")] {
        if !set {
            continue;
        }
        fields.extend(if side == "in" {
            ["props.common.split.videoIn", "props.common.split.audioIn"]
        } else {
            ["props.common.split.videoOut", "props.common.split.audioOut"]
        });
        match &item.kind {
            ItemKind::Media(_) => fields.push(if side == "in" { "props.media.mark_in" } else { "props.media.mark_out" }),
            ItemKind::Sequence(_) => {
                fields.push(if side == "in" { "sequence.settings.mark_in" } else { "sequence.settings.mark_out" });
                fields.extend(if side == "in" {
                    ["sequence.settings.split.videoIn", "sequence.settings.split.audioIn"]
                } else {
                    ["sequence.settings.split.videoOut", "sequence.settings.split.audioOut"]
                });
            }
            _ => {}
        }
    }
    Some(Under { premises: vec![Premise::on(json!(id.0)).fields(fields).positions(Vec::<String>::new())], ..Default::default() })
}

/// A step can read several disjoint facts of one object. SDK 34dff06 takes
/// one premise per id, so express their union before sending the answer.
pub fn coalesce(mut under: Under) -> Under {
    let mut merged: Vec<Premise> = Vec::new();
    for premise in under.premises {
        if let Some(held) = merged.iter_mut().find(|held| held.id == premise.id) {
            union(&mut held.fields, premise.fields);
            union(&mut held.positions, premise.positions);
            held.identities.extend(premise.identities);
        } else {
            merged.push(premise);
        }
    }
    under.premises = merged;
    under
}

fn union(held: &mut Option<Vec<String>>, more: Option<Vec<String>>) {
    match (held.as_mut(), more) {
        (Some(fields), Some(more)) => {
            for field in more {
                if !fields.contains(&field) {
                    fields.push(field);
                }
            }
        }
        (_, None) => *held = None,
        _ => {}
    }
}
