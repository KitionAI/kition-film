//! Source inputs and actual destination lanes for placement commands.
use kition_film_engine::{
    Session, commands,
    project::{ItemId, ItemKind, TrackKind},
};
use kition_kit::{Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn leaf(id: Value, fields: &[&str]) -> Premise {
    Premise::on(id).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
/// `explicit_length`: Place Clip's `duration` is given, so a sequence source's own length is not
/// read (commands.rs:2292).
/// `monitor`: a Source monitor command, whose copy of a sequence source is held by its copied
/// material ([`source_sequence_material`]) rather than the whole sequence.
fn source(session: &Session, id: ItemId, explicit_length: bool, monitor: bool, answer: &mut Under) {
    answer.premises.push(leaf(json!(id.0), &["name", "props.common.label", "props.common.split", "~sourceGraphic"]));
    let mut next = Some(id);
    let mut seen = BTreeSet::new();
    while let Some(id) = next.filter(|id| seen.insert(*id)) {
        let Some(item) = session.project.item(id) else { break };
        next = None;
        let mut fields = vec!["kind"];
        match &item.kind {
            ItemKind::Media(_) => fields.extend([
                "props.media.mark_in",
                "props.media.mark_out",
                "props.media.info.kind",
                "props.media.info.duration",
                "props.media.info.video",
                "props.media.info.audio_streams",
                "props.media.interpret",
            ]),
            ItemKind::Subclip { parent, .. } => {
                fields.extend(["props.parent", "props.range"]);
                next = Some(*parent);
            }
            ItemKind::Sequence(q) => {
                fields.extend(["sequence.settings.mark_in", "sequence.settings.mark_out", "sequence.settings.settings", "sequence.settings.multicam"]);
                if !explicit_length {
                    fields.push("sequence.duration");
                }
                let copied = session.state.sequences_as_clips && q.multicam.is_none();
                if !copied {
                    // A nest gets an audio lane when its source has audio; a copy places the
                    // source's clips themselves.
                    fields.push("~sourceHasAudio");
                } else if !monitor {
                    fields.push("sequence");
                }
            }
            _ => fields.extend(["props.width", "props.height", "props.rate", "props.duration"]),
        }
        answer.premises.push(leaf(json!(id.0), &fields));
    }
}
pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !matches!(command, "timeline.place" | "source.insert" | "source.overwrite" | "clip.automateToSequence") {
        return None;
    }
    let q = session.active_sequence()?;
    let seq = session.state.active_sequence?;
    let automated = command == "clip.automateToSequence";
    let source_command = command.starts_with("source.");
    let insert = command == "source.insert"
        || params.get("insert").and_then(Value::as_bool) == Some(true)
        || automated && params.get("method").and_then(Value::as_str) != Some("overwrite");
    let mut answer = Under::default();
    answer
        .premises
        .push(leaf(json!(seq.0), &["sequence.settings.settings.frame_rate", "sequence.settings.settings.width", "sequence.settings.settings.height"]));
    if params.get("timecode").is_some() {
        answer.premises.push(leaf(json!(seq.0), &["sequence.settings.settings.drop_frame"]));
    }
    if source_command {
        answer.premises.push(leaf(json!(seq.0), &["sequence.settings.mark_in"]));
    }
    if insert && session.state.ripple_sequence_markers {
        answer.premises.push(leaf(json!(seq.0), &["sequence.markers"]));
    }
    snap_targets(session, command, params, &mut answer);
    let ids = if automated {
        let sequential = params.get("placement").and_then(Value::as_str).unwrap_or("sequentially") == "sequentially";
        let transitions = ["videoTransition", "audioTransition"].iter().any(|key| params.get(*key).and_then(Value::as_bool) != Some(false));
        if sequential && transitions {
            // project_tools.rs:1251-1258: the default transitions at the cuts, and their length
            // when there is no overlap.
            answer.premises.push(leaf(
                json!("project"),
                &["settings.default_video_transition", "settings.default_audio_transition", "settings.default_transition_duration_frames"],
            ));
        }
        if params.get("placement").and_then(Value::as_str) == Some("unnumberedMarkers") {
            answer.premises.push(leaf(json!(seq.0), &["sequence.markers"]));
        }
        let ids = params
            .get("items")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(Value::as_u64).map(ItemId).collect::<Vec<_>>())
            .unwrap_or_else(|| session.state.project_selection.clone());
        // project_tools.rs:1134-1138: `sort` orders the items as the bins list them. Their
        // order is what it reads of the bins, not the bins' items (which `bins` holds).
        if params.get("ordering").and_then(Value::as_str).unwrap_or("sort") == "sort" {
            for id in &ids {
                answer.premises.push(leaf(json!(id.0), &["~projectOrder"]));
            }
        }
        ids
    } else if source_command {
        session.state.source_item.into_iter().collect()
    } else {
        commands::item_p(params, "item").into_iter().collect()
    };
    let explicit_length = command == "timeline.place" && params.get("duration").and_then(Value::as_i64).is_some();
    for id in ids {
        source(session, id, explicit_length, source_command, &mut answer);
    }
    if source_command {
        source_sequence_material(session, &mut answer);
    }
    for key in ["track", "audioTrack"] {
        if let Some(name) = params.get(key).and_then(Value::as_str)
            && let Some(track) = super::rests_sequences::track_id(session, params.get(key))
        {
            let field = if name.starts_with(['V', 'v']) { "sequence.videoTracks" } else { "sequence.audioTracks" };
            answer.premises.push(leaf(json!(track.0), &[]).positions([field]));
        }
    }
    // Execution on a scratch session is bounded by the command's own validation.
    // Unlock only for layout discovery, so a newly locked recipient is retained.
    let mut preview = session.scratch();
    if let Some(q) = std::sync::Arc::make_mut(&mut preview.project).sequence_mut(seq) {
        for track in q.all_tracks_mut() {
            let auto = if track.kind == TrackKind::Video { "track" } else { "audioTrack" };
            if params.get(auto).and_then(Value::as_str) != Some("auto") {
                track.locked = false;
            }
        }
    }
    let Ok(result) = preview.execute(command, params.clone()) else { return Some(answer) };
    let placed = result
        .get("clips")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .filter_map(|id| preview.active_sequence().and_then(|q| q.find_item(kition_film_engine::project::ClipId(id))))
        .collect::<Vec<_>>();
    let first = placed.iter().map(|(_, clip)| clip.start.0).min();
    // An insert (edit::insert, edit/src/lib.rs:247-266) opens its gap on every unlocked
    // sync-locked caption track too. Automate's sequential insert opens it on the clip tracks
    // alone and then overwrites (project_tools.rs:1200-1225).
    let marked = params.get("placement").and_then(Value::as_str) == Some("unnumberedMarkers");
    if insert && (!automated || marked) && first.is_some() {
        answer.premises.push(leaf(json!(seq.0), &["~captionTrackOrder"]));
        for track in &q.caption_tracks {
            let path = format!("sequence.captionTracks[id={}]", track.id.0);
            let mut fields = vec![format!("{path}.locked"), format!("{path}.sync_lock")];
            if !track.locked && track.sync_lock {
                // It shifts or splits the captions from the insert's time on; their list is held
                // whole, as the engine's premise holds it (premise.rs:862-873), so a change of
                // them refuses as `changed`.
                fields.extend([format!("{path}.captions"), format!("{path}.captionOrder")]);
            }
            answer.premises.push(Premise::on(json!(seq.0)).fields(fields).positions(Vec::<String>::new()));
        }
    }
    let targets = placed.iter().map(|(owner, _)| *owner).collect::<BTreeSet<_>>();
    for (key, tracks, order) in [("track", &q.video_tracks, "~videoTrackOrder"), ("audioTrack", &q.audio_tracks, "~audioTrackOrder")] {
        if params.get(key).and_then(Value::as_str) != Some("auto") {
            continue;
        }
        answer.premises.push(leaf(json!(seq.0), &[order]));
        for track in tracks {
            answer.premises.push(leaf(json!(track.id.0), &["props.locked", "~editEdges"]));
            if targets.contains(&track.id) && !track.locked {
                break;
            }
        }
    }
    let after = preview.active_sequence();
    for track in q.all_tracks() {
        let target = targets.contains(&track.id);
        // An insert's gap (edit/src/lib.rs:259-263, insert_track_gap) changes a lane only where it
        // has material ending after the insert's time: whether an empty or earlier lane is locked
        // or sync-locked changes nothing.
        let affected = first.is_some_and(|at| {
            track.items.iter().any(|clip| clip.start.0.saturating_add(clip.duration.0) > at)
                || track.transitions.iter().any(|transition| transition.start.0.saturating_add(transition.duration.0) > at)
        });
        if insert && affected || target {
            answer.premises.push(leaf(json!(track.id.0), if insert { &["props.locked", "props.sync_lock"] } else { &["props.locked"] }));
        }
        if target {
            answer.premises.push(leaf(json!(track.id.0), &["props.kind", "transitions"]));
        }
        if track.locked || !(target || insert && track.sync_lock) {
            continue;
        }
        if insert && let Some(at) = first {
            for clip in track.items.iter().filter(|clip| clip.start.0 >= at) {
                answer.premises.push(leaf(json!(clip.id.0), &["start"]));
            }
        }
        let intervals = if insert {
            first.filter(|_| target).map(|at| vec![(at, at.saturating_add(1))]).unwrap_or_default()
        } else {
            placed.iter().filter(|(owner, _)| *owner == track.id).map(|(_, clip)| (clip.start.0, clip.start.0.saturating_add(clip.duration.0))).collect()
        };
        for (start, end) in intervals {
            let from = track.items.iter().take_while(|clip| clip.start.0.saturating_add(clip.duration.0) <= start).count();
            let to = track.items.iter().take_while(|clip| clip.start.0 < end).count().max(from);
            answer.within.push(Within {
                parent: json!(track.id.0),
                field: "clips".into(),
                from,
                to,
                time: Some(TimeSpan {
                    from: json!(start.to_string()),
                    to: json!(end.to_string()),
                    start: "start".into(),
                    duration: Some("duration".into()),
                    ..Default::default()
                }),
            });
            for clip in track.items.get(from..to).into_iter().flatten() {
                answer.objects.push(json!(clip.id.0));
                answer.premises.push(Premise::on(json!(clip.id.0)).positions(["start", "clipId"]));
            }
        }
        // Newly created lanes inherit the first audio lane's mixer profile.
        if target && track.kind == TrackKind::Audio && placed.iter().any(|(id, _)| q.track(*id).is_none()) {
            answer.premises.push(leaf(json!(track.id.0), &["props.channels", "props.enabled", "volumeDb", "pan", "effects"]));
        }
        let starts = after
            .and_then(|q| q.track(track.id))
            .map(|track| track.transitions.iter().map(|t| (t.id, t.start)).collect::<BTreeMap<_, _>>())
            .unwrap_or_default();
        for transition in &track.transitions {
            if starts.get(&transition.id).is_some_and(|at| *at != transition.start) {
                answer.premises.push(leaf(json!(transition.id.0), &["start"]));
            }
        }
    }
    answer.objects.sort_by_key(Value::as_u64);
    answer.objects.dedup();
    Some(answer)
}

/// `timeline.place` with `snap` lands on the nearest target within the tolerance
/// (`kition_film_engine::snap::Snap::from_params`, snap.rs:33-75): every marker's start and a
/// range marker's end, and the beats of the enabled audio clips (beats.rs:100-112). The frame
/// rate that sizes the tolerance is held above. Snap has no other targets (no playhead, clip
/// edges or marks).
fn snap_targets(session: &Session, command: &str, params: &Value, answer: &mut Under) {
    if command != "timeline.place" {
        return;
    }
    let kinds: Vec<&str> = match params.get("snap") {
        Some(Value::String(kind)) => vec![kind.as_str()],
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).collect(),
        _ => return,
    };
    let (Some(seq), Some(q)) = (session.state.active_sequence, session.active_sequence()) else { return };
    if kinds.contains(&"markers") {
        answer.premises.push(leaf(json!(seq.0), &["sequence.markers"]));
    }
    if kinds.contains(&"beats") {
        // Which clips are on the audio tracks, and each one's source, span and speed.
        answer.premises.push(leaf(json!(seq.0), &["~audioTrackOrder"]));
        for track in &q.audio_tracks {
            answer.premises.push(leaf(json!(track.id.0), &["props.kind", "~clipOrder"]));
            answer.premises.extend(track.items.iter().map(|clip| Premise::on(json!(clip.id.0))));
        }
    }
}

/// `projectOrder` of every item: its index in the bins' order (`Bin::all_items`), which
/// Automate to Sequence's `sort` ordering reads.
pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Vec<kition_kit::DerivedValues> {
    if !names.is_empty() && !names.iter().any(|name| name == "projectOrder") {
        return Vec::new();
    }
    let mut order = Vec::new();
    session.project.root.all_items(&mut order);
    order
        .iter()
        .enumerate()
        .filter(|(_, id)| ids.is_empty() || ids.iter().any(|value| value.as_u64() == Some(id.0) || value.as_str() == Some(id.0.to_string().as_str())))
        .map(|(index, id)| kition_kit::DerivedValues { id: json!(id.0), values: serde_json::Map::from_iter([("projectOrder".to_owned(), json!(index))]) })
        .collect()
}

/// A Source monitor copy of a sequence (sequence_tools.rs, `place_sequence_clips`) copies every
/// source clip intersecting its marked (or split) range and the transitions inside it between
/// copied clips, onto consecutive destination lanes from the patched one. What it reads of the
/// source is that material, held by its membership per nonempty lane (`~sourceVideoMaterial`,
/// `~sourceAudioMaterial`), each copied clip and transition, and each lane's window over the range.
fn source_sequence_material(session: &Session, answer: &mut Under) {
    let Some(item) = session.state.source_item else { return };
    let Some(source) = session.project.sequence(item).filter(|q| session.state.sequences_as_clips && q.multicam.is_none()) else { return };
    let Some((video_range, audio_range)) = super::rests_core::source_sequence_copy_ranges(session, item) else { return };
    let targeting = session.targeting();
    for (tracks, destination, material, range) in [
        (&source.video_tracks, targeting.video_dest, "~sourceVideoMaterial", video_range),
        (&source.audio_tracks, targeting.audio_dest, "~sourceAudioMaterial", audio_range),
    ] {
        if destination.is_none() {
            continue;
        }
        answer.premises.push(leaf(json!(item.0), &[material]));
        let (start, end) = (range.start.0, range.end().0);
        for track in tracks {
            let copied: BTreeSet<_> = track.items.iter().filter(|clip| clip.start < range.end() && clip.end() > range.start).map(|clip| clip.id).collect();
            if copied.is_empty() {
                continue;
            }
            for clip in &copied {
                answer.objects.push(json!(clip.0));
                answer.premises.push(Premise::on(json!(clip.0)));
            }
            answer.within.push(Within {
                parent: json!(track.id.0),
                field: "clips".into(),
                from: 0,
                to: track.items.len(),
                time: Some(TimeSpan {
                    from: json!(start.to_string()),
                    to: json!(end.to_string()),
                    start: "start".into(),
                    duration: Some("duration".into()),
                    ..Default::default()
                }),
            });
            for transition in &track.transitions {
                if transition.start >= range.start
                    && transition.start.0.checked_add(transition.duration.0).is_some_and(|stop| stop <= end)
                    && transition.from.is_none_or(|id| copied.contains(&id))
                    && transition.to.is_none_or(|id| copied.contains(&id))
                {
                    answer.objects.push(json!(transition.id.0));
                    answer.premises.push(Premise::on(json!(transition.id.0)));
                }
            }
        }
    }
}
