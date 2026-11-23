//! Dependencies mapped from C8-film-read's committed blind sequence/marker readings.
//! This supplements the engine's place answer; it does not move the editor.

use kition_film_engine::Session;
use kition_film_engine::project::{ClipId, ItemId, TrackId, TrackItem};
use kition_kit::{Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

// A detailed plan for every possible target otherwise repeats long suffixes.
const DETAILED_JOIN_LIMIT: usize = 128;

/// Stored caption maps need a time window even when their observed member was deleted.
pub fn caption_windows(session: &Session, command: &str, under: &mut Under) {
    if command != "sequence.extract" {
        return;
    }
    let Some(id) = session.state.active_sequence else { return };
    // The captions Extract consumes are the members of the marked range on each unlocked
    // sync-locked caption track: `~markedCaptionMaterial` holds exactly those identities, so a
    // caption added, removed, replaced or moved across the range is a change of what it reads
    // (`changed`). A time window over the same list would say `relocated` for the same change.
    under.premises.push(Premise::on(json!(id.0)).fields(["~markedCaptionMaterial"]).positions(Vec::<String>::new()));
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if command == "captions.newTrack" {
        let id = session.state.active_sequence?;
        return Some(Under { premises: vec![Premise::on(json!(id.0)).fields(["~captionTrackCount"]).positions(Vec::<String>::new())], ..Default::default() });
    }
    if let Some((kind, field)) = match command {
        "timeline.toggleMuteTargetedAudio" => Some(("audio", "props.muted")),
        "timeline.toggleSoloTargetedAudio" => Some(("audio", "props.solo")),
        "timeline.toggleOutputTargetedVideo" => Some(("video", "props.enabled")),
        _ => None,
    } {
        let sequence = session.state.active_sequence?;
        let q = session.active_sequence()?;
        let targeted = session.targeting().targeted;
        let tracks = if kind == "audio" { &q.audio_tracks } else { &q.video_tracks };
        let mut answer = Under::default();
        if !session.state.targeting.contains_key(&sequence) {
            answer.premises.push(Premise::on(json!(sequence.0)).fields([format!("~{kind}TrackOrder")]).positions(Vec::<String>::new()));
        }
        answer.premises.extend(
            tracks
                .iter()
                .filter(|track| targeted.contains(&track.id))
                .map(|track| Premise::on(json!(track.id.0)).fields([field]).positions(Vec::<String>::new())),
        );
        return Some(answer);
    }
    if let Some(answer) = caption_navigation(session, command, params) {
        return Some(answer);
    }
    if let Some(answer) = targeting(session, command) {
        return Some(answer);
    }
    if matches!(command, "multicam.page" | "multicam.nextPage" | "multicam.prevPage") {
        let mut answer = Under::default();
        camera_lookup(session, session.playhead(), &mut answer);
        if let Some((_, clip)) = kition_film_engine::multicam::multicam_clip_at(session, session.playhead()) {
            camera_map(&mut answer, session, clip.item);
        }
        return Some(answer);
    }
    if command == "multicam.recordStop" && session.mcrec.active() {
        let mut answer = Under::default();
        for id in session.mcrec.recipients() {
            answer.premises.push(Premise::on(json!(id)));
        }
        recording_material(session, session.mcrec.seq, &session.mcrec.tracks, &mut answer);
        return Some(answer);
    }
    if matches!(command, "sequence.makeSubsequence" | "sequence.simplify") {
        return copy_sequence(session, command, params);
    }
    if command.starts_with("sequence.goTo") && command.contains("Gap") {
        return gap_geometry(session, command, params);
    }
    if matches!(command, "sequence.addTracks" | "sequence.deleteTracks") {
        return track_layout(session, command, params);
    }
    if matches!(command, "clip.multicamEnable" | "multicam.switchAngle" | "multicam.editCameras") {
        return camera_dependencies(session, command, params);
    }
    if camera_keyboard_write(command) {
        return camera_dependencies(session, command, params);
    }
    if command == "sequence.joinThroughEdits" {
        return join_through(session, params);
    }
    let channel = match command {
        "markers.markSplitVideoIn" | "markers.markSplitVideoOut" => Some(("videoIn", "videoOut")),
        "markers.markSplitAudioIn" | "markers.markSplitAudioOut" => Some(("audioIn", "audioOut")),
        _ => None,
    };
    if let Some((in_field, out_field)) = channel {
        let (id, path) = if params.get("target").and_then(Value::as_str) == Some("source") {
            (session.state.source_item?, "props.common.split")
        } else {
            (session.state.active_sequence?, "sequence.settings.split")
        };
        // Side::set assigns this side and filters the opposite side of this
        // channel. The other channel is neither read nor assigned.
        return Some(Under {
            premises: vec![Premise::on(json!(id.0)).fields([format!("{path}.{in_field}"), format!("{path}.{out_field}")]).positions(Vec::<String>::new())],
            ..Default::default()
        });
    }
    if command != "markers.addRangeInOut" {
        return None;
    }
    let id = session.state.active_sequence?;
    let sequence = session.active_sequence()?;
    let mut answer = Under {
        premises: vec![
            Premise::on(json!(id.0))
                .fields(["sequence.settings.mark_in", "sequence.settings.mark_out", "sequence.settings.settings.frame_rate", "~markedMaterial"])
                .positions(Vec::<String>::new()),
        ],
        ..Default::default()
    };
    let (Some(start), Some(out)) = (sequence.mark_in, sequence.mark_out) else { return Some(answer) };
    let end = out.0.saturating_add(sequence.settings.frame_rate.frame_duration().0);
    for track in sequence.all_tracks() {
        let from = track.items.partition_point(|clip| clip.start.0.saturating_add(clip.duration.0) <= start.0);
        let to = track.items.partition_point(|clip| clip.start.0 < end).max(from);
        for clip in track.items.get(from..to).into_iter().flatten() {
            answer.objects.push(json!(clip.id.0));
            answer.premises.push(Premise::on(json!(clip.id.0)).positions(["start", "clipId"]));
        }
        answer.within.push(Within {
            parent: json!(track.id.0),
            field: "clips".to_owned(),
            from,
            to,
            time: Some(TimeSpan {
                from: json!(start.0.to_string()),
                to: json!(end.to_string()),
                start: "start".to_owned(),
                end: None,
                duration: Some("duration".to_owned()),
                identity: None,
            }),
        });
    }
    // The derived identity set preserves members that left before this read;
    // current Within windows alone cannot replay a stored, parameterless range.
    Some(answer)
}

fn caption_navigation(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !matches!(command, "captions.select" | "captions.goTo" | "captions.next" | "captions.previous" | "captions.showActiveOnly") {
        return None;
    }
    let sequence = session.state.active_sequence?;
    let q = session.active_sequence()?;
    let mut fields = vec!["~captionTrackOrder".to_owned()];
    if matches!(command, "captions.goTo" | "captions.next" | "captions.previous") {
        fields.push("sequence.settings.settings.frame_rate".to_owned());
    }
    let explicit = kition_film_engine::commands::clip_p(params, "caption").map(|id| id.0);
    let chosen = if let Some(ids) = params.get("captions").and_then(Value::as_array) {
        ids.iter().find_map(Value::as_u64).map(ClipId)
    } else {
        explicit.map(ClipId).or_else(|| session.state.caption_selection.first().copied())
    };
    let point = explicit.is_none() && params.get("captions").and_then(Value::as_array).is_none() && session.state.caption_selection.is_empty();
    for track in &q.caption_tracks {
        let prefix = format!("sequence.captionTracks[id={}]", track.id.0);
        fields.push(format!("sequence.captions[track={}].id", track.id.0));
        if matches!(command, "captions.next" | "captions.previous" | "captions.showActiveOnly") {
            fields.push(format!("{prefix}.enabled"));
        }
        for caption in &track.captions {
            if matches!(command, "captions.next" | "captions.previous") && track.enabled || command == "captions.goTo" && (point || chosen == Some(caption.id))
            {
                fields.push(format!("sequence.captions[id={}].start", caption.id.0));
                if command == "captions.goTo" && point {
                    fields.push(format!("sequence.captions[id={}].duration", caption.id.0));
                }
            }
        }
    }
    let mut answer = Under::default();
    if session.state.selection_follows_playhead && matches!(command, "captions.next" | "captions.previous") {
        let mut starts: Vec<_> =
            q.caption_tracks.iter().filter(|track| track.enabled).flat_map(|track| track.captions.iter().map(|caption| (caption.start, caption.id))).collect();
        starts.sort();
        let destination = if command == "captions.next" {
            starts.iter().find(|(start, _)| *start > session.playhead())
        } else {
            starts.iter().rev().find(|(start, _)| *start < session.playhead())
        };
        if let Some((start, _)) = destination {
            let time = q.settings.frame_rate.snap(*start);
            fields.extend(["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"].map(str::to_owned));
            let targeting = session.targeting();
            for track in q.all_tracks().filter(|track| targeting.targeted.contains(&track.id)) {
                answer.premises.push(Premise::on(json!(track.id.0)).fields(Vec::<String>::new()).positions(Vec::<String>::new()));
                answer.within.push(Within {
                    parent: json!(track.id.0),
                    field: "clips".into(),
                    time: Some(TimeSpan {
                        from: json!(time.0.to_string()),
                        to: json!(time.0.saturating_add(1).to_string()),
                        start: "start".into(),
                        duration: Some("duration".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                });
                if let Some(clip) = track.item_at(time) {
                    answer.objects.push(json!(clip.id.0));
                    answer.premises.push(Premise::on(json!(clip.id.0)).fields(["link", "~linkedGroup"]).positions(Vec::<String>::new()));
                    if let Some(link) = clip.link
                        && let Some(root) = q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(link)).map(|clip| clip.id.0).min()
                    {
                        answer.premises.push(Premise::on(json!(root)).fields(["~linkedMembers"]).positions(Vec::<String>::new()));
                    }
                }
            }
        }
    }
    answer.premises.push(Premise::on(json!(sequence.0)).fields(fields).positions(Vec::<String>::new()));
    Some(answer)
}

fn targeting(session: &Session, command: &str) -> Option<Under> {
    let fixed = command.strip_prefix("timeline.toggleTarget").and_then(|suffix| {
        let kind = match suffix.as_bytes().first()? {
            b'V' => "video",
            b'A' => "audio",
            _ => return None,
        };
        let index = suffix.get(1..)?.parse::<usize>().ok()?.checked_sub(1)?;
        (index < 8).then_some((kind, index))
    });
    let kind = if let Some((kind, _)) = fixed {
        kind
    } else {
        match command {
            "timeline.toggleAllVideoTargets" | "timeline.toggleAllSourceVideo" | "timeline.moveVideoTargetsUp" | "timeline.moveVideoTargetsDown" => "video",
            "timeline.toggleAllAudioTargets" | "timeline.toggleAllSourceAudio" | "timeline.moveAudioTargetsUp" | "timeline.moveAudioTargetsDown" => "audio",
            _ => return None,
        }
    };
    let id = session.state.active_sequence?;
    let mut answer = Under::default();
    if !session.state.targeting.contains_key(&id) {
        // Session::targeting defaults to every lane, with both first source
        // patches. Even a single toggle carries those other default identities.
        hold(&mut answer, id.0, ["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"], [] as [&str; 0]);
    } else if fixed.is_none() && !command.contains("Source") {
        hold(&mut answer, id.0, [format!("~{kind}TrackOrder")], [] as [&str; 0]);
    }
    if fixed.is_some() || command.contains("Source") {
        let index = fixed.map_or(0, |(_, index)| index);
        answer.within.push(Within {
            parent: json!(id.0),
            field: format!("sequence.{kind}Tracks"),
            from: index,
            to: index.saturating_add(1),
            ..Default::default()
        });
    }
    Some(answer)
}

fn hold(answer: &mut Under, id: u64, fields: impl IntoIterator<Item = impl Into<String>>, positions: impl IntoIterator<Item = impl Into<String>>) {
    answer.premises.push(Premise::on(json!(id)).fields(fields).positions(positions));
}

/// Identity lists have no descendant content. Holding a model list field also
/// holds every child value at SDK 34dff06, which is too broad for these reads.
pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Vec<kition_kit::DerivedValues> {
    let mut out: Vec<kition_kit::DerivedValues> = Vec::new();
    let numeric: std::collections::BTreeSet<_> = ids.iter().filter_map(Value::as_u64).collect();
    let textual: std::collections::BTreeSet<_> = ids.iter().filter_map(Value::as_str).collect();
    let wanted = |id: u64| ids.is_empty() || numeric.contains(&id) || (!textual.is_empty() && textual.contains(id.to_string().as_str()));
    for item in session.project.items.values() {
        let ItemId(id) = item.id;
        let sequence = session.project.sequence(item.id);
        if wanted(id) && (names.is_empty() || names.iter().any(|name| name == "captionTrackCount")) {
            out.push(kition_kit::DerivedValues {
                id: json!(id),
                values: serde_json::Map::from_iter([("captionTrackCount".into(), json!(sequence.map(|q| q.caption_tracks.len())))]),
            });
        }
        if wanted(id) && (names.is_empty() || names.iter().any(|name| name == "captionTrackOrder")) {
            out.push(kition_kit::DerivedValues {
                id: json!(id),
                values: serde_json::Map::from_iter([(
                    "captionTrackOrder".into(),
                    json!(sequence.map(|q| q.caption_tracks.iter().map(|track| track.id.0).collect::<Vec<_>>())),
                )]),
            });
        }
        if wanted(id) && (names.is_empty() || names.iter().any(|name| name == "markedCaptionMaterial")) {
            let material = sequence.map(|sequence| {
                let start = sequence.mark_in.unwrap_or_default();
                let end = sequence
                    .mark_out
                    .map(|end| kition_film_time::Tick(end.0.saturating_add(sequence.settings.frame_rate.frame_duration().0)))
                    .unwrap_or_else(|| sequence.duration());
                sequence
                    .caption_tracks
                    .iter()
                    .filter(|track| !track.locked && track.sync_lock)
                    .flat_map(|track| {
                        track
                            .captions
                            .iter()
                            .filter(move |caption| caption.start < end && caption.start.0.saturating_add(caption.duration.0) > start.0)
                            .map(move |caption| (track.id.0, caption.id.0))
                    })
                    .collect::<Vec<_>>()
            });
            out.push(kition_kit::DerivedValues { id: json!(id), values: serde_json::Map::from_iter([("markedCaptionMaterial".into(), json!(material))]) });
        }
        if wanted(id) && (names.is_empty() || names.iter().any(|n| n == "markedMaterial")) {
            let material = sequence
                .and_then(|q| {
                    let (Some(start), Some(out)) = (q.mark_in, q.mark_out) else { return None };
                    let end = out.0.saturating_add(q.settings.frame_rate.frame_duration().0);
                    let tracks: Vec<_> = q
                        .all_tracks()
                        .filter_map(|track| {
                            let members: Vec<_> = track
                                .items
                                .iter()
                                .filter(|clip| clip.start.0 < end && clip.start.0.saturating_add(clip.duration.0) > start.0)
                                .map(|clip| clip.id.0)
                                .collect();
                            (!members.is_empty()).then(|| json!({"track":track.id.0,"clips":members}))
                        })
                        .collect();
                    Some(json!(tracks))
                })
                .unwrap_or(Value::Null);
            if let Some(values) = out.iter_mut().find(|values| values.id == json!(id)) {
                values.values.insert("markedMaterial".to_owned(), material);
            } else {
                out.push(kition_kit::DerivedValues { id: json!(id), values: serde_json::Map::from_iter([("markedMaterial".to_owned(), material)]) });
            }
        }
        for (name, tracks) in [
            ("videoTrackOrder", sequence.map(|q| &q.video_tracks)),
            ("audioTrackOrder", sequence.map(|q| &q.audio_tracks)),
            ("submixTrackOrder", sequence.map(|q| &q.submix_tracks)),
        ] {
            if wanted(id) && (names.is_empty() || names.iter().any(|n| n == name)) {
                let order = tracks.map(|tracks| json!(tracks.iter().map(|track| track.id.0).collect::<Vec<_>>())).unwrap_or(Value::Null);
                if let Some(values) = out.iter_mut().find(|values| values.id == json!(id)) {
                    values.values.insert(name.to_owned(), order);
                } else {
                    out.push(kition_kit::DerivedValues { id: json!(id), values: serde_json::Map::from_iter([(name.to_owned(), order)]) });
                }
            }
        }
        let Some(q) = sequence else {
            let absent: serde_json::Map<_, _> = [
                "motionScale",
                "allJoinPlan",
                "sourceVideoMaterial",
                "sourceAudioMaterial",
                "sourceHasAudio",
                "newSequenceVideoMaterial",
                "newSequenceAudioMaterial",
            ]
            .into_iter()
            .filter(|name| wanted(id) && (names.is_empty() || names.iter().any(|n| n == name)))
            .map(|name| (name.to_owned(), Value::Null))
            .collect();
            if !absent.is_empty() {
                if let Some(values) = out.iter_mut().find(|values| values.id == json!(id)) {
                    values.values.extend(absent);
                } else {
                    out.push(kition_kit::DerivedValues { id: json!(id), values: absent });
                }
            }
            continue;
        };
        let copy_ranges = (wanted(id) && (names.is_empty() || names.iter().any(|name| matches!(name.as_str(), "sourceVideoMaterial" | "sourceAudioMaterial"))))
            .then(|| super::rests_core::source_sequence_copy_ranges(session, item.id))
            .flatten();
        let mut source_values = serde_json::Map::new();
        if wanted(id) && (names.is_empty() || names.iter().any(|name| name == "sourceHasAudio")) {
            source_values.insert("sourceHasAudio".to_owned(), json!(item.has_audio()));
        }
        for (name, tracks, range) in [
            ("sourceVideoMaterial", &q.video_tracks, copy_ranges.map(|ranges| ranges.0)),
            ("sourceAudioMaterial", &q.audio_tracks, copy_ranges.map(|ranges| ranges.1)),
        ] {
            if !wanted(id) || (!names.is_empty() && !names.iter().any(|wanted| wanted == name)) {
                continue;
            }
            let material = range.map(|range| {
                tracks
                    .iter()
                    .filter_map(|track| {
                        let clips: Vec<_> =
                            track.items.iter().filter(|clip| clip.start < range.end() && clip.end() > range.start).map(|clip| clip.id).collect();
                        if clips.is_empty() {
                            return None;
                        }
                        let transitions: Vec<_> = track
                            .transitions
                            .iter()
                            .filter(|tr| {
                                tr.start >= range.start
                                    && tr.start.0.checked_add(tr.duration.0).is_some_and(|end| end <= range.end().0)
                                    && tr.from.is_none_or(|id| clips.contains(&id))
                                    && tr.to.is_none_or(|id| clips.contains(&id))
                            })
                            .map(|tr| tr.id.0)
                            .collect();
                        Some(json!({"clips":clips.iter().map(|id| id.0).collect::<Vec<_>>(),"transitions":transitions}))
                    })
                    .collect::<Vec<_>>()
            });
            source_values.insert(name.to_owned(), json!(material));
        }
        for (name, tracks) in [("newSequenceVideoMaterial", &q.video_tracks), ("newSequenceAudioMaterial", &q.audio_tracks)] {
            if wanted(id) && (names.is_empty() || names.iter().any(|wanted| wanted == name)) {
                source_values.insert(name.to_owned(), super::rests_core::new_sequence_material(q, tracks));
            }
        }
        if wanted(id) && (names.is_empty() || names.iter().any(|name| name == "cameraMap")) {
            let cameras: Vec<_> = q
                .cameras()
                .cameras
                .iter()
                .map(|camera| {
                    json!([camera.video_track.map(|track| track.0), camera.audio_tracks.iter().map(|track| track.0).collect::<Vec<_>>(), camera.enabled])
                })
                .collect();
            source_values.insert("cameraMap".into(), json!(cameras));
        }
        if !source_values.is_empty() {
            if let Some(values) = out.iter_mut().find(|values| values.id == json!(id)) {
                values.values.extend(source_values);
            } else {
                out.push(kition_kit::DerivedValues { id: json!(id), values: source_values });
            }
        }
        if wanted(id) && (names.is_empty() || names.iter().any(|n| n == "allJoinPlan")) {
            let mut plans: Vec<_> = q
                .all_tracks()
                .flat_map(|track| {
                    kition_film_engine::sequence_tools::all_join_plan(track).into_iter().map(move |(survivor, removed)| {
                        let mut transitions: Vec<_> = track
                            .transitions
                            .iter()
                            .filter(|t| t.from.is_some_and(|id| removed.contains(&id)) || t.to.is_some_and(|id| removed.contains(&id)))
                            .map(|t| t.id.0)
                            .collect();
                        let mut removed: Vec<_> = removed.iter().map(|id| id.0).collect();
                        removed.sort_unstable();
                        transitions.sort_unstable();
                        json!({"survivor":survivor.0,"removed":removed,"transitions":transitions})
                    })
                })
                .collect();
            // Tracks commute for an all-track join; only recipient identities
            // matter here. Content and source/timeline math are held separately.
            plans.sort_by_key(|plan| plan["survivor"].as_u64());
            if let Some(values) = out.iter_mut().find(|values| values.id == json!(id)) {
                values.values.insert("allJoinPlan".to_owned(), json!(plans));
            } else {
                out.push(kition_kit::DerivedValues { id: json!(id), values: serde_json::Map::from_iter([("allJoinPlan".to_owned(), json!(plans))]) });
            }
        }
        if wanted(id) && (names.is_empty() || names.iter().any(|n| n == "motionScale")) {
            // frame_size.rs:37-70 visits only the first intrinsic Motion of
            // each video-kind clip. Other effects, names and timing are preserved.
            let mut motion = serde_json::Map::new();
            for clip in q.all_tracks().filter(|t| t.kind == kition_film_engine::project::TrackKind::Video).flat_map(|t| &t.items) {
                let Some(effect) = clip.effect("motion") else { continue };
                let mut values =
                    serde_json::Map::from_iter([("refits".to_owned(), json!(clip.scale_to_frame)), ("position".to_owned(), json!(effect.param("position")))]);
                if !clip.scale_to_frame {
                    for key in ["scale", "scale_width"] {
                        values.insert(key.to_owned(), json!(effect.param(key)));
                    }
                }
                motion.insert(format!("c{}", clip.id.0), Value::Object(values));
            }
            let projected = Value::Object(motion);
            if let Some(values) = out.iter_mut().find(|values| values.id == json!(id)) {
                values.values.insert("motionScale".to_owned(), projected);
            } else {
                out.push(kition_kit::DerivedValues { id: json!(id), values: serde_json::Map::from_iter([("motionScale".to_owned(), projected)]) });
            }
        }
        // Two sibling-edge maps are linear in sequence size, rather than a
        // separate suffix/prefix inventory for every possible placement.
        for (name, tracks) in [("nextVideoTrack", &q.video_tracks), ("nextAudioTrack", &q.audio_tracks)] {
            if !names.is_empty() && !names.iter().any(|wanted| wanted == name) {
                continue;
            }
            let next: std::collections::BTreeMap<_, _> =
                tracks.iter().enumerate().map(|(index, track)| (track.id, tracks.get(index.saturating_add(1)).map(|next| next.id.0))).collect();
            for track in q.video_tracks.iter().chain(&q.audio_tracks).chain(&q.submix_tracks).filter(|track| wanted(track.id.0)) {
                out.push(kition_kit::DerivedValues {
                    id: json!(track.id.0),
                    values: serde_json::Map::from_iter([(name.to_owned(), json!(next.get(&track.id).copied().flatten()))]),
                });
            }
        }
        let mut groups: std::collections::BTreeMap<u64, Vec<u64>> = Default::default();
        for clip in q.all_tracks().flat_map(|track| &track.items) {
            if let Some(link) = clip.link {
                groups.entry(link).or_default().push(clip.id.0);
            }
        }
        for members in groups.values_mut() {
            members.sort_unstable();
        }
        for track in q.video_tracks.iter().chain(&q.audio_tracks).chain(&q.submix_tracks) {
            for (index, clip) in track.items.iter().enumerate() {
                if !wanted(clip.id.0) {
                    continue;
                }
                let mut values = serde_json::Map::new();
                if names.is_empty() || names.iter().any(|name| name == "joinInput") {
                    values.insert("joinInput".into(), super::rests_join::input(clip));
                }
                if names.is_empty() || names.iter().any(|n| n == "singleJoinPlan") {
                    if let Some(kition_film_engine::sequence_tools::SingleJoinPlan::Complete(survivor, removed)) =
                        kition_film_engine::sequence_tools::single_join_plan(track, index, DETAILED_JOIN_LIMIT)
                    {
                        let transitions: Vec<_> = track
                            .transitions
                            .iter()
                            .filter(|t| t.from.is_some_and(|id| removed.contains(&id)) || t.to.is_some_and(|id| removed.contains(&id)))
                            .map(|t| t.id.0)
                            .collect();
                        values.insert(
                            "singleJoinPlan".to_owned(),
                            json!({"survivor":survivor.0,"removed":removed.iter().map(|id| id.0).collect::<Vec<_>>(),"transitions":transitions}),
                        );
                    } else {
                        values.insert("singleJoinPlan".to_owned(), Value::Null);
                    }
                }
                let members = clip.link.and_then(|link| groups.get(&link));
                let root = members.and_then(|members| members.first()).copied();
                if names.is_empty() || names.iter().any(|n| n == "linkedGroup") {
                    values.insert("linkedGroup".to_owned(), json!(root));
                }
                if names.is_empty() || names.iter().any(|n| n == "linkedMembers") {
                    // Each group is serialized once, on its least clip id.
                    values.insert("linkedMembers".to_owned(), if root == Some(clip.id.0) { json!(members) } else { Value::Null });
                }
                if !values.is_empty() {
                    out.push(kition_kit::DerivedValues { id: json!(clip.id.0), values });
                }
            }
            if wanted(track.id.0) && (names.is_empty() || names.iter().any(|n| n == "joinLock")) {
                out.push(kition_kit::DerivedValues { id: json!(track.id.0), values: serde_json::Map::from_iter([("joinLock".into(), json!(track.locked))]) });
            }
            if wanted(track.id.0) && (names.is_empty() || names.iter().any(|n| n == "clipOrder")) {
                out.push(kition_kit::DerivedValues {
                    id: json!(track.id.0),
                    values: serde_json::Map::from_iter([("clipOrder".to_owned(), json!(track.items.iter().map(|c| c.id.0).collect::<Vec<_>>()))]),
                });
            }
        }
    }
    out
}

fn sequence_layout(answer: &mut Under, session: &Session, id: ItemId) {
    let Some(q) = session.project.sequence(id) else { return };
    hold(answer, id.0, ["~videoTrackOrder", "~audioTrackOrder"], [] as [&str; 0]);
    for (tracks, field) in [(&q.video_tracks, "sequence.videoTracks"), (&q.audio_tracks, "sequence.audioTracks")] {
        for track in tracks {
            hold(answer, track.id.0, ["props.name", "props.channels"], [field]);
        }
    }
}

// The subsequence constructor copies settings, layout, selected TrackItems and
// eligible transitions. Track playback switches are not copied by lay_out_tracks_like.
fn copy_sequence(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let id = session.state.active_sequence?;
    let q = session.active_sequence()?;
    let mut answer = Under::default();
    let simplify = command == "sequence.simplify";
    let mut fields = if simplify {
        vec![
            "sequence.settings",
            "sequence.masterVolumeDb",
            "sequence.masterEffects",
            "sequence.mixer",
            "sequence.captionTracks",
            "sequence.captions",
            "props.common.label",
        ]
    } else {
        vec!["sequence.settings.settings", "sequence.settings.mark_in", "sequence.settings.mark_out"]
    };
    if params.get("name").is_none() {
        fields.push("name");
    }
    hold(&mut answer, id.0, fields, [] as [&str; 0]);
    sequence_layout(&mut answer, session, id);
    let selected = kition_film_engine::commands::with_links(session, &session.state.selection);
    let range_start = q.mark_in.unwrap_or_default();
    let range_end = q.mark_out.map(|out| out.0.saturating_add(q.settings.frame_rate.frame_duration().0)).unwrap_or_else(|| q.duration().0);
    let has_range = q.mark_in.is_some() || q.mark_out.is_some();
    let targeted = session.targeting().targeted;
    let mut copied = Vec::new();
    for track in q.all_tracks() {
        if simplify {
            answer.premises.push(Premise::on(json!(track.id.0)));
        }
        for clip in &track.items {
            let candidate = simplify || if selected.is_empty() { targeted.contains(&track.id) } else { selected.contains(&clip.id) };
            if candidate {
                // Geometry decides range membership even for clips outside the range.
                hold(&mut answer, clip.id.0, ["link"], ["start", "duration"]);
                if simplify || !has_range || (clip.start.0 < range_end && clip.end() > range_start) {
                    answer.premises.push(Premise::on(json!(clip.id.0)));
                    copied.push(clip.id);
                    if simplify && params.get("removeText").and_then(Value::as_bool) == Some(true) {
                        hold(&mut answer, clip.item.0, ["kind"], [] as [&str; 0]);
                    }
                }
            } else if !simplify && session.state.linked_selection {
                hold(&mut answer, clip.id.0, ["link"], [] as [&str; 0]);
            }
        }
        for tr in &track.transitions {
            let endpoints = tr.from.is_none_or(|clip| copied.contains(&clip)) && tr.to.is_none_or(|clip| copied.contains(&clip));
            if simplify || endpoints {
                answer.premises.push(Premise::on(json!(tr.id.0)));
            }
        }
    }
    if !simplify && params.get("name").is_none() {
        for item in session.project.items.values() {
            hold(&mut answer, item.id.0, ["name"], [] as [&str; 0]);
        }
    }
    Some(answer)
}

fn gap_geometry(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let q = session.active_sequence()?;
    let in_track = command.ends_with("InTrack");
    let explicit = track_id(session, params.get("track"));
    let targeted = session.targeting().targeted;
    let mut answer = Under::default();
    hold(&mut answer, session.state.active_sequence?.0, ["sequence.settings.settings.frame_rate"], [] as [&str; 0]);
    for (tracks, field) in [(&q.video_tracks, "sequence.videoTracks"), (&q.audio_tracks, "sequence.audioTracks")] {
        for track in tracks {
            if in_track && !explicit.map_or_else(|| targeted.contains(&track.id), |id| id == track.id) {
                continue;
            }
            hold(&mut answer, track.id.0, ["~clipOrder"], [field]);
            for clip in &track.items {
                hold(&mut answer, clip.id.0, [] as [&str; 0], ["start", "duration"]);
            }
        }
    }
    if session.state.selection_follows_playhead {
        let mut preview = session.scratch();
        if let Ok(result) = preview.execute(command, params.clone())
            && result.get("time").is_some_and(|time| !time.is_null())
        {
            let selection = super::rests_navigation::selection_at(session, Some(preview.playhead().0));
            answer.premises.extend(selection.premises);
            answer.within.extend(selection.within);
            answer.orders.extend(selection.orders);
        }
    }
    Some(answer)
}

fn track_layout(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let q = session.active_sequence()?;
    let mut answer = Under::default();
    if command == "sequence.addTracks" {
        let gaps = kition_film_engine::sequence_tools::added_track_gaps(session, params).ok()?;
        answer.within.extend(gaps.into_iter().map(|gap| Within {
            parent: json!(gap.parent),
            field: gap.field.to_owned(),
            from: gap.index,
            to: gap.index,
            ..Default::default()
        }));
    }
    for (key, tracks, field) in [
        ("video", &q.video_tracks, "sequence.videoTracks"),
        ("audio", &q.audio_tracks, "sequence.audioTracks"),
        ("submix", &q.submix_tracks, "sequence.submixTracks"),
    ] {
        if command == "sequence.addTracks" {
            let amount = params.get(key).and_then(Value::as_u64).unwrap_or(u64::from(key == "video"));
            if amount == 0 {
                continue;
            }
            // Compare only names belonging to lanes observed at the checkpoint;
            // newly appended lanes are not positional dependencies of this gap.
            hold(&mut answer, session.state.active_sequence?.0, [format!("~{key}TrackNames")], [] as [&str; 0]);
        } else {
            let Some(value) = params.get(key).filter(|value| !value.is_null()) else { continue };
            let empty = value.as_str().is_some_and(|value| matches!(value, "empty" | "allEmpty" | "all-empty"));
            let chosen = if empty { None } else { track_id(session, params.get(key)) };
            for track in tracks {
                if empty {
                    hold(&mut answer, track.id.0, ["~clipOrder"], [field]);
                }
                let deleting = if empty {
                    track.items.is_empty() && (tracks.iter().any(|t| !t.items.is_empty()) || tracks.first().is_some_and(|t| t.id != track.id))
                } else {
                    chosen == Some(track.id) && tracks.len() > 1
                };
                if deleting {
                    answer.premises.push(Premise::on(json!(track.id.0)));
                    for clip in &track.items {
                        answer.premises.push(Premise::on(json!(clip.id.0)));
                    }
                    for tr in &track.transitions {
                        answer.premises.push(Premise::on(json!(tr.id.0)));
                    }
                }
            }
        }
        if (command == "sequence.deleteTracks" || params.get(format!("{key}After")).is_none_or(Value::is_null))
            && let Some(id) = session.state.active_sequence
        {
            hold(&mut answer, id.0, [format!("~{key}TrackOrder")], [] as [&str; 0]);
        }
    }
    Some(answer)
}

pub(super) fn track_id(session: &Session, value: Option<&Value>) -> Option<TrackId> {
    let value = value?;
    let q = session.active_sequence()?;
    if let Some(id) = value.as_u64() {
        return q.track(TrackId(id)).map(|track| track.id);
    }
    let name = value.as_str()?;
    let tracks = match name.as_bytes().first()? {
        b'V' | b'v' => &q.video_tracks,
        b'A' | b'a' => &q.audio_tracks,
        _ => return None,
    };
    let index = name.get(1..)?.parse::<usize>().ok()?.checked_sub(1)?;
    tracks.get(index).map(|track| track.id)
}

fn camera_map(answer: &mut Under, session: &Session, id: ItemId) {
    if session.project.sequence(id).is_some() {
        hold(answer, id.0, ["kind", "~cameraMap"], [] as [&str; 0]);
    }
}

fn camera_keyboard_write(command: &str) -> bool {
    matches!(command, "multicam.cut" | "multicam.cutToCamera")
        || ["multicam.selectCamera", "multicam.cutToCamera"]
            .iter()
            .any(|prefix| command.strip_prefix(prefix).and_then(|suffix| suffix.parse::<u8>().ok()).is_some_and(|camera| (1..=9).contains(&camera)))
}

fn camera_lookup(session: &Session, time: kition_film_time::Tick, answer: &mut Under) {
    if let Some(q) = session.active_sequence() {
        if let Some(sequence) = session.state.active_sequence {
            hold(answer, sequence.0, ["~videoTrackOrder"], [] as [&str; 0]);
        }
        for track in &q.video_tracks {
            let from = track.items.partition_point(|clip| clip.end() <= time);
            let to = track.items.partition_point(|clip| clip.start <= time).max(from);
            answer.within.push(Within {
                parent: json!(track.id.0),
                field: "clips".into(),
                from,
                to,
                time: Some(TimeSpan {
                    from: json!(time.0.to_string()),
                    to: json!(time.0.to_string()),
                    start: "start".into(),
                    duration: Some("duration".into()),
                    ..Default::default()
                }),
            });
            for clip in track.items.get(from..to).into_iter().flatten() {
                hold(answer, clip.id.0, ["item", "props.multicam"], [] as [&str; 0]);
                hold(answer, clip.item.0, ["kind"], [] as [&str; 0]);
            }
        }
    }
}

fn recording_material(session: &Session, sequence: Option<ItemId>, tracks: &[TrackId], answer: &mut Under) {
    let sequence = sequence.and_then(|id| session.project.sequence(id));
    for id in tracks {
        hold(answer, id.0, ["props.locked", "~clipOrder", "transitions"], [] as [&str; 0]);
        if let Some(track) = sequence.and_then(|q| q.track(*id)) {
            // Replay can split or heal material beyond the current cut and
            // remove orphan transitions anywhere on a recorded lane.
            answer.premises.extend(track.items.iter().map(|clip| Premise::on(json!(clip.id.0))));
            answer.premises.extend(track.transitions.iter().map(|transition| Premise::on(json!(transition.id.0))));
        }
    }
}

fn camera_dependencies(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let q = session.active_sequence()?;
    let time = kition_film_engine::commands::time_p(session, params, "").unwrap_or(session.playhead());
    let keyboard = camera_keyboard_write(command);
    let cut = command.starts_with("multicam.cutToCamera");
    let mut answer = Under::default();
    let implicit = command != "clip.multicamEnable"
        && if command == "multicam.editCameras" {
            params.get("sequence").and_then(Value::as_u64).is_none()
        } else {
            params.get("clips").is_none() && params.get("clip").is_none()
        };
    if implicit {
        camera_lookup(session, time, &mut answer);
    }
    if keyboard && let Ok(Some(place)) = session.under(command, params) {
        // Keep the original positional address, including material that left it.
        // A camera wrapper adds source dependencies to that address.
        answer.objects.extend(place.clips.iter().map(|clip| json!(clip.0)));
        answer.within.extend(place.windows.into_iter().map(|window| Within {
            parent: json!(window.track.0),
            field: "clips".to_owned(),
            from: window.from,
            to: window.to,
            time: Some(TimeSpan {
                from: json!(window.at.0.to_string()),
                to: json!(window.at.0.saturating_add(window.span.0).to_string()),
                start: "start".to_owned(),
                end: None,
                duration: Some("duration".to_owned()),
                identity: None,
            }),
        }));
    }
    if command == "multicam.editCameras" {
        let source = params.get("sequence").and_then(Value::as_u64).map(ItemId).or_else(|| {
            kition_film_engine::multicam::multicam_clip_at(session, time).map(|(_, clip)| clip).map(|clip| {
                hold(&mut answer, clip.id.0, ["item", "props.multicam"], ["start", "duration"]);
                clip.item
            })
        })?;
        let mut fields = vec!["kind".to_owned()];
        if params.get("audio").is_some() {
            fields.push("sequence.settings.multicam.audio".to_owned());
        }
        for change in params.get("cameras").and_then(Value::as_array).into_iter().flatten() {
            let Some(index) = change.get("angle").and_then(Value::as_u64) else { continue };
            for field in ["name", "enabled"].into_iter().filter(|field| change.get(*field).is_some()) {
                fields.push(format!("sequence.settings.multicam.cameras.{index}.{field}"));
            }
            fields.push(format!("sequence.settings.multicam.cameras.{index}.video_track"));
        }
        hold(&mut answer, source.0, fields, [] as [&str; 0]);
        return Some(answer);
    }
    let named: Option<Vec<_>> = params
        .get("clips")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_u64).map(ClipId).collect())
        .or_else(|| params.get("clip").and_then(Value::as_u64).map(|id| vec![ClipId(id)]));
    let ids = if command == "clip.multicamEnable" {
        kition_film_engine::commands::with_links(session, named.as_deref().unwrap_or(&session.state.selection))
    } else {
        named.unwrap_or_else(|| {
            kition_film_engine::multicam::multicam_clip_at(session, time).map(|(_, clip)| clip).map(|clip| vec![clip.id]).unwrap_or_default()
        })
    };
    let mut targets = ids.clone();
    if (command == "multicam.switchAngle" || keyboard)
        && (params.get("audioOnly").and_then(Value::as_bool) == Some(true)
            || (session.state.multicam_audio_follows_video && params.get("videoOnly").and_then(Value::as_bool) != Some(true)))
    {
        let links: Vec<_> = ids.iter().filter_map(|id| q.find_item(*id).and_then(|(_, clip)| clip.link)).collect();
        for track in &q.audio_tracks {
            for clip in &track.items {
                hold(&mut answer, clip.id.0, ["link", "props.multicam"], [] as [&str; 0]);
                if clip.link.is_some_and(|link| links.contains(&link)) && clip.multicam.is_some() {
                    targets.push(clip.id);
                }
            }
        }
    }
    for id in targets {
        let Some((owner, clip)) = q.find_item(id) else { continue };
        hold(&mut answer, id.0, ["item", "props.multicam", "link"], [] as [&str; 0]);
        if command == "multicam.switchAngle" || keyboard {
            hold(&mut answer, owner.0, ["props.locked"], [] as [&str; 0]);
        }
        if cut {
            // Razor copies the whole item into its right-hand piece.
            answer.premises.push(Premise::on(json!(id.0)));
        }
        camera_map(&mut answer, session, clip.item);
    }
    if keyboard && session.mcrec.active() && session.mcrec.seq == session.state.active_sequence {
        let mut tracks = session.mcrec.tracks.clone();
        if tracks.is_empty()
            && let Some((_, clip)) = kition_film_engine::multicam::multicam_clip_at(session, time)
        {
            tracks.extend(
                q.video_tracks
                    .iter()
                    .filter(|track| track.item_at(time).is_some_and(|candidate| candidate.item == clip.item && candidate.multicam.is_some()))
                    .take(1)
                    .map(|track| track.id),
            );
            if session.state.multicam_audio_follows_video && params.get("videoOnly").and_then(Value::as_bool) != Some(true) {
                tracks.extend(
                    q.audio_tracks
                        .iter()
                        .filter(|track| track.items.iter().any(|candidate| clip.link.is_some() && candidate.link == clip.link && candidate.multicam.is_some()))
                        .map(|track| track.id),
                );
            }
        }
        recording_material(session, session.state.active_sequence, &tracks, &mut answer);
    }
    Some(answer)
}

fn join_through(session: &Session, params: &Value) -> Option<Under> {
    let sequence = session.active_sequence()?;
    let all = params.get("all").and_then(Value::as_bool) == Some(true)
        || (params.get("clips").is_none() && params.get("clip").is_none() && session.state.selection.is_empty());
    let named: Vec<ClipId> = params
        .get("clips")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_u64).map(ClipId).collect())
        .or_else(|| params.get("clip").and_then(Value::as_u64).map(|id| vec![ClipId(id)]))
        .unwrap_or_else(|| session.state.selection.clone());
    let only = if all { Vec::new() } else { kition_film_engine::commands::with_links(session, &named) };

    // Ask the real operation, on its isolated preview, which pieces it removes.
    // Removed content is assigned as a whole; survivors keep unrelated looks.
    // An ineligible current state still supplies candidate/lock premises below,
    // so a changed eligibility is refused before running the real command.
    let mut preview = session.scratch();
    let joined = preview.execute("sequence.joinThroughEdits", params.clone()).is_ok();
    let removed: Vec<ClipId> = if joined {
        sequence
            .all_tracks()
            .flat_map(|track| &track.items)
            .filter(|clip| preview.active_sequence().is_some_and(|q| q.find_item(clip.id).is_none()))
            .map(|clip| clip.id)
            .collect()
    } else {
        Vec::new()
    };
    let mut answer = Under::default();
    if only.is_empty() {
        hold(&mut answer, session.state.active_sequence?.0, ["~allJoinPlan"], [] as [&str; 0]);
    }
    if let [named] = only.as_slice() {
        hold(&mut answer, named.0, ["~singleJoinPlan"], [] as [&str; 0]);
        if let Some((owner, _)) = sequence.find_item(*named)
            && let Some(track) = sequence.track(owner)
            && let Some(index) = track.items.iter().position(|clip| clip.id == *named)
            && matches!(
                kition_film_engine::sequence_tools::single_join_plan(track, index, DETAILED_JOIN_LIMIT),
                Some(kition_film_engine::sequence_tools::SingleJoinPlan::TooLong)
            )
        {
            // The pinned SDK cannot share historical suffixes between targets.
            // Keep large plans bounded with a conservative identity-list hold.
            hold(&mut answer, owner.0, ["~clipOrder"], [] as [&str; 0]);
        }
    }
    for track in sequence.all_tracks() {
        if !only.is_empty() && !track.items.iter().any(|clip| only.contains(&clip.id)) {
            continue;
        }
        answer.premises.push(Premise::on(json!(track.id.0)).fields(["props.locked"]).positions(Vec::<String>::new()));
        let mut facts = std::collections::BTreeMap::new();
        for pair in track.items.windows(2) {
            let [left, right] = pair else { continue };
            if only.is_empty() || only.contains(&left.id) || only.contains(&right.id) || removed.contains(&left.id) || removed.contains(&right.id) {
                through_pair_facts(left, right, &mut facts);
            }
        }
        let mut candidates = std::collections::BTreeSet::new();
        for (index, clip) in track.items.iter().enumerate() {
            if only.is_empty() || only.contains(&clip.id) || removed.contains(&clip.id) {
                candidates.insert(index);
                if let Some(previous) = index.checked_sub(1) {
                    candidates.insert(previous);
                }
                if let Some(next) = index.checked_add(1).filter(|next| *next < track.items.len()) {
                    candidates.insert(next);
                }
            }
        }
        for index in candidates {
            let Some(clip) = track.items.get(index) else { continue };
            let premise = if removed.contains(&clip.id) {
                Premise::on(json!(clip.id.0)).positions(["start", "duration"])
            } else {
                let mut fact = facts.remove(&clip.id.0).unwrap_or_default();
                if !all && only.contains(&clip.id) {
                    fact.fields.insert("link");
                }
                Premise::on(json!(clip.id.0)).fields(fact.fields).positions(fact.positions)
            };
            answer.premises.push(premise);
        }
        for transition in &track.transitions {
            if transition.from.is_some_and(|id| removed.contains(&id)) || transition.to.is_some_and(|id| removed.contains(&id)) {
                answer.premises.push(Premise::on(json!(transition.id.0)));
            }
        }
    }
    answer.objects = removed.iter().map(|clip| json!(clip.0)).collect();
    answer.covers = Some(kition_kit::Covers { fields: vec!["~joinInput".into(), "~joinLock".into()] });
    Some(answer)
}

#[derive(Default)]
struct ThroughFacts {
    fields: std::collections::BTreeSet<&'static str>,
    positions: std::collections::BTreeSet<&'static str>,
}

/// Follow `edit::through::is_through_edit`'s short-circuit checks. A different
/// item already rules out a join; its source In, speed and looks cannot change
/// that result. Removed pieces are held whole by the caller for same-field
/// protection, and their duration also supplies every accumulated join length.
fn through_pair_facts(left: &TrackItem, right: &TrackItem, facts: &mut std::collections::BTreeMap<u64, ThroughFacts>) {
    facts.entry(left.id.0).or_default().positions.extend(["start", "duration"]);
    facts.entry(right.id.0).or_default().positions.insert("start");
    if left.start.0.saturating_add(left.duration.0) != right.start.0 {
        return;
    }
    let mut both = |field| {
        facts.entry(left.id.0).or_default().fields.insert(field);
        facts.entry(right.id.0).or_default().fields.insert(field);
    };
    both("item");
    if left.item != right.item {
        return;
    }
    both("speed");
    if left.speed != right.speed {
        return;
    }
    both("reverse");
    if left.reverse != right.reverse {
        return;
    }
    both("props.multicam");
    if left.multicam != right.multicam {
        return;
    }
    both("props.frame_hold");
    if left.frame_hold.is_some() || right.frame_hold.is_some() {
        return;
    }
    both("sourceIn");
    if left.reverse {
        facts.entry(right.id.0).or_default().positions.insert("duration");
    }
}
