//! Inputs used to compute navigation and selection results.
use kition_film_engine::{Session, project::Track};
use kition_kit::{DerivedValues, Premise, RelativeOrder, TimeSpan, Under, Within};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if matches!(command, "clip.revealInProject" | "sequence.matchFrame" | "sequence.revealNested" | "sequence.reverseMatchFrame") {
        return frame_lookup(session, command, params);
    }
    if matches!(command, "timeline.selectClipAtPlayhead" | "timeline.selectNextClip" | "timeline.selectPrevClip") {
        return selection_step(session, command);
    }
    if command == "sequence.selectionFollowsPlayhead" {
        let enabling = params.get("on").and_then(Value::as_bool).unwrap_or(!session.state.selection_follows_playhead);
        return Some(if enabling { selection_at(session, Some(session.playhead().0)) } else { Under::default() });
    }
    if command == "timeline.setTargeting" {
        let sequence = session.state.active_sequence?;
        let mut answer = Under::default();
        if !session.state.targeting.contains_key(&sequence) {
            answer.premises.push(leaf(json!(sequence.0), ["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
        }
        if let Some(track) = super::rests_sequences::track_id(session, params.get("track")) {
            let mut premise = leaf(json!(track.0), []);
            if let Some(spelling) = params.get("track").and_then(Value::as_str) {
                let field = match spelling.as_bytes().first() {
                    Some(b'V' | b'v') => Some("sequence.videoTracks"),
                    Some(b'A' | b'a') => Some("sequence.audioTracks"),
                    _ => None,
                };
                if let Some(field) = field {
                    premise = premise.positions([field]);
                }
            }
            answer.premises.push(premise);
        }
        return Some(answer);
    }
    if command == "source.setPlayhead" || command.starts_with("marker.goTo") || matches!(command, "marker.goNext" | "marker.goPrev") {
        return marker_destination(session, command, params);
    }
    if command == "project.selectAll" {
        return Some(Under { premises: vec![leaf(json!("project"), ["~itemIds"])], ..Default::default() });
    }
    let sequence = session.state.active_sequence?;
    session.active_sequence()?;
    if command == "edit.selectAll" {
        return Some(Under { premises: vec![leaf(json!(sequence.0), ["~clipIds"])], ..Default::default() });
    }
    if !matches!(
        command,
        "playhead.set"
            | "playhead.step"
            | "playhead.stepForward"
            | "playhead.stepBack"
            | "playhead.stepForward5"
            | "playhead.stepBack5"
            | "playhead.start"
            | "playhead.end"
            | "playhead.nextEdit"
            | "playhead.prevEdit"
            | "playhead.nextEditAnyTrack"
            | "playhead.prevEditAnyTrack"
            | "playhead.selectedClipStart"
            | "playhead.selectedClipEnd"
    ) {
        return None;
    }
    let mut answer = Under { premises: vec![leaf(json!(sequence.0), ["sequence.settings.settings.frame_rate"])], ..Default::default() };
    if command == "playhead.set"
        && params.get("time").and_then(Value::as_i64).is_none()
        && params.get("frame").and_then(Value::as_i64).is_none()
        && params.get("seconds").and_then(Value::as_f64).is_none()
        && params.get("timecode").and_then(Value::as_str).is_some()
    {
        answer.premises.push(leaf(json!(sequence.0), ["sequence.settings.settings.drop_frame"]));
    }
    if command == "playhead.end" {
        answer.premises.push(leaf(json!(sequence.0), ["sequence.duration"]));
    }
    if matches!(command, "playhead.selectedClipStart" | "playhead.selectedClipEnd") {
        for clip in &session.state.selection {
            answer.premises.push(Premise::on(json!(clip.0)).fields(Vec::<String>::new()).positions(["start", "duration"]));
        }
    }
    if matches!(command, "playhead.nextEdit" | "playhead.prevEdit" | "playhead.nextEditAnyTrack" | "playhead.prevEditAnyTrack") {
        let targeted = session.targeting().targeted;
        if command.ends_with("AnyTrack") || targeted.is_empty() {
            answer.premises.push(leaf(json!(sequence.0), ["~editPoints"]));
        } else {
            for track in targeted {
                answer.premises.push(leaf(json!(track.0), ["~editPoints"]));
            }
        }
    }
    if session.state.selection_follows_playhead {
        // The isolated command supplies the actual snapped destination. Its
        // timebase and geometry inputs are held above; only that point's
        // recipients, and their linked groups, determine the new selection.
        let mut preview = session.scratch();
        let time = preview.execute(command, params.clone()).ok().map(|_| preview.playhead().0);
        let selection = selection_at(session, time);
        answer.premises.extend(selection.premises);
        answer.within.extend(selection.within);
        answer.orders.extend(selection.orders);
    }
    Some(answer)
}

fn frame_lookup(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let sequence = session.state.active_sequence?;
    let q = session.active_sequence()?;
    let mut answer = Under::default();
    if command == "clip.revealInProject" {
        for id in kition_film_engine::commands::clips_p(session, params) {
            answer.premises.push(leaf(json!(id.0), ["item"]));
            if let Some((_, clip)) = q.find_item(id) {
                answer.premises.push(leaf(json!(clip.item.0), []));
                return Some(answer);
            }
        }
    }
    answer.premises.push(leaf(json!(sequence.0), ["~videoTrackOrder", "~audioTrackOrder", "sequence.settings.settings.frame_rate"]));
    for track in q.video_tracks.iter().chain(&q.audio_tracks) {
        answer.premises.push(leaf(json!(track.id.0), ["~clipOrder"]));
        for clip in &track.items {
            answer.premises.push(
                leaf(json!(clip.id.0), ["item", "sourceIn", "speed", "reverse", "props.frame_hold", "link", "~linkedGroup"])
                    .positions(["start", "duration", "clips"]),
            );
            if let Some(link) = clip.link
                && let Some(root) = q.all_tracks().flat_map(|track| &track.items).filter(|peer| peer.link == Some(link)).map(|peer| peer.id.0).min()
            {
                answer.premises.push(leaf(json!(root), ["~linkedMembers"]));
            }
            if command == "sequence.revealNested" {
                super::rests_effects::source(session, clip.item, &mut answer);
            } else {
                answer.premises.push(leaf(json!(clip.item.0), ["kind"]));
            }
        }
    }
    Some(answer)
}

fn selection_step(session: &Session, command: &str) -> Option<Under> {
    let sequence = session.state.active_sequence?;
    let q = session.active_sequence()?;
    if command == "timeline.selectClipAtPlayhead" || session.state.selection.is_empty() {
        let mut answer = selection_at(session, Some(session.playhead().0));
        let targeted = session.targeting().targeted;
        answer.objects.extend(
            q.all_tracks().filter(|track| targeted.contains(&track.id)).filter_map(|track| track.item_at(session.playhead())).map(|clip| json!(clip.id.0)),
        );
        return Some(answer);
    }
    let mut answer = Under::default();
    let mut owners = Vec::new();
    for track in q.all_tracks() {
        let mut anchors = track.items.iter().enumerate().filter(|(_, clip)| session.state.selection.contains(&clip.id));
        let anchor = if command == "timeline.selectNextClip" { anchors.next_back() } else { anchors.next() };
        let Some((index, _)) = anchor else { continue };
        owners.push(track.id);
        answer.premises.push(leaf(json!(track.id.0), ["~clipOrder"]));
        answer.premises.extend(
            track
                .items
                .iter()
                .filter(|clip| session.state.selection.contains(&clip.id))
                .map(|clip| Premise::on(json!(clip.id.0)).fields(Vec::<String>::new()).positions(["clips"])),
        );
        let pick = if command == "timeline.selectNextClip" { index.checked_add(1) } else { index.checked_sub(1) };
        let Some(clip) = pick.and_then(|index| track.items.get(index)) else { continue };
        answer.premises.push(leaf(json!(clip.id.0), ["link", "~linkedGroup"]));
        if session.state.linked_selection
            && let Some(group) = clip.link
            && let Some(root) = q.all_tracks().flat_map(|track| &track.items).filter(|peer| peer.link == Some(group)).map(|peer| peer.id.0).min()
        {
            answer.premises.push(leaf(json!(root), ["~linkedMembers"]));
        }
    }
    for (tracks, field) in [(&q.video_tracks, "sequence.videoTracks"), (&q.audio_tracks, "sequence.audioTracks"), (&q.submix_tracks, "sequence.submixTracks")] {
        let objects: Vec<_> = tracks.iter().filter(|track| owners.contains(&track.id)).map(|track| json!(track.id.0)).collect();
        if objects.len() > 1 {
            answer.orders.push(RelativeOrder { parent: json!(sequence.0), field: field.into(), objects });
        }
    }
    Some(answer)
}

pub(super) fn selection_at(session: &Session, time: Option<i64>) -> Under {
    let mut answer = Under::default();
    let Some(sequence) = session.state.active_sequence else { return answer };
    let Some(q) = session.active_sequence() else { return answer };
    let targeted = session.targeting().targeted;
    if session.state.targeting.contains_key(&sequence) {
        for (tracks, field) in
            [(&q.video_tracks, "sequence.videoTracks"), (&q.audio_tracks, "sequence.audioTracks"), (&q.submix_tracks, "sequence.submixTracks")]
        {
            let objects: Vec<_> = tracks.iter().filter(|track| targeted.contains(&track.id)).map(|track| json!(track.id.0)).collect();
            if objects.len() > 1 {
                answer.orders.push(RelativeOrder { parent: json!(sequence.0), field: field.into(), objects });
            }
        }
    } else {
        answer.premises.push(leaf(json!(sequence.0), ["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
    }
    let Some(time) = time else { return answer };
    for track in q.all_tracks().filter(|track| targeted.contains(&track.id)) {
        let from = track.items.partition_point(|clip| clip.start.0.saturating_add(clip.duration.0) <= time);
        let to = track.items.partition_point(|clip| clip.start.0 <= time).max(from);
        answer.within.push(Within {
            parent: json!(track.id.0),
            field: "clips".into(),
            from,
            to,
            time: Some(TimeSpan {
                from: json!(time.to_string()),
                to: json!(time.to_string()),
                start: "start".into(),
                duration: Some("duration".into()),
                ..Default::default()
            }),
        });
        for clip in track.items.get(from..to).into_iter().flatten() {
            answer.premises.push(Premise::on(json!(clip.id.0)).fields(["link", "~linkedGroup"]).positions(["start", "duration"]));
            if session.state.linked_selection
                && let Some(link) = clip.link
                && let Some(root) = q.all_tracks().flat_map(|track| &track.items).filter(|peer| peer.link == Some(link)).map(|peer| peer.id.0).min()
            {
                answer.premises.push(leaf(json!(root), ["~linkedMembers"]));
            }
        }
    }
    answer
}

fn marker_destination(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let source = command == "source.setPlayhead" || params.get("target").and_then(Value::as_str) == Some("source");
    let split = command.strip_prefix("marker.goToSplit");
    if source && split.is_none() {
        // Source next/previous already have a historical marker-list profile.
        if matches!(command, "marker.goNext" | "marker.goPrev") {
            return None;
        }
        let id = session.state.source_item?;
        let mut fields = vec!["~sourceStart", "~sourceEnd", "~sourceRate"];
        if command != "source.setPlayhead" {
            fields.push(if command.ends_with("In") { "~sourceMarkIn" } else { "~sourceMarkOut" });
        }
        return Some(Under { premises: vec![leaf(json!(id.0), fields)], ..Default::default() });
    }
    if source {
        let id = session.state.source_item?;
        let item = session.project.item(id)?;
        let side = split?;
        let channel = if side.starts_with("Video") { "video" } else { "audio" };
        let edge = if side.ends_with("In") { "In" } else { "Out" };
        let mut fields = vec!["kind".to_owned(), format!("props.common.split.{channel}{edge}")];
        if item.as_media().is_some() {
            fields.push(format!("props.media.mark_{}", edge.to_ascii_lowercase()));
        } else if item.as_sequence().is_some() {
            fields.push(format!("sequence.settings.mark_{}", edge.to_ascii_lowercase()));
        }
        return Some(Under { premises: vec![Premise::on(json!(id.0)).fields(fields).positions(Vec::<String>::new())], ..Default::default() });
    }
    let id = session.state.active_sequence?;
    let q = session.active_sequence()?;
    let mut fields = vec!["sequence.settings.settings.frame_rate".to_owned()];
    if let Some(side) = split {
        let channel = if side.starts_with("Video") { "video" } else { "audio" };
        let edge = if side.ends_with("In") { "In" } else { "Out" };
        fields.extend([format!("sequence.settings.split.{channel}{edge}"), format!("sequence.settings.mark_{}", edge.to_ascii_lowercase())]);
    } else {
        match command {
            "marker.goToIn" => fields.push("sequence.settings.mark_in".into()),
            "marker.goToOut" => {
                fields.push("sequence.settings.mark_out".into());
                if q.mark_out.is_none() {
                    fields.push("sequence.duration".into());
                }
            }
            "marker.goNext" | "marker.goPrev" => fields.push("sequence.markers".into()),
            _ => return None,
        }
    }
    let mut answer = Under { premises: vec![Premise::on(json!(id.0)).fields(fields).positions(Vec::<String>::new())], ..Default::default() };
    if session.state.selection_follows_playhead {
        let mut preview = session.scratch();
        if preview.execute(command, params.clone()).is_ok()
            && let Some(selection) = under(session, "playhead.set", &json!({"time":preview.playhead().0}))
        {
            answer.premises.extend(selection.premises);
            answer.within.extend(selection.within);
            answer.orders.extend(selection.orders);
        }
    }
    Some(answer)
}

fn leaf(id: Value, fields: impl IntoIterator<Item = &'static str>) -> Premise {
    Premise::on(id).fields(fields).positions(Vec::<String>::new())
}

pub(super) fn source_marker_inputs(session: &Session, command: &str, params: &Value, under: Option<Under>) -> Option<Under> {
    if params.get("target").and_then(Value::as_str) != Some("source") || !matches!(command, "marker.add" | "marker.edit" | "marker.goNext" | "marker.goPrev") {
        return under;
    }
    let Some(id) = session.state.source_item else { return under };
    let Some(view) = kition_film_engine::clip_ops::source_view(session, id) else { return under };
    let navigation = matches!(command, "marker.goNext" | "marker.goPrev");
    let mut fields = vec!["~sourceMedia"];
    let destination = navigation
        && view
            .markers
            .iter()
            .any(|marker| if command == "marker.goNext" { marker.start > session.state.source_playhead } else { marker.start < session.state.source_playhead });
    if navigation {
        fields.push("~sourceMarkerStarts");
    }
    if destination || command == "marker.add" || command == "marker.edit" && params.get("durationFrames").is_some() {
        fields.extend(["~sourceStart", "~sourceEnd"]);
        if destination || params.get("durationFrames").is_some() {
            fields.push("~sourceRate");
        }
    }
    let mut answer = under.unwrap_or_default();
    answer.premises.push(leaf(json!(id.0), fields));
    Some(answer)
}

fn edit_points<'a>(tracks: impl Iterator<Item = &'a Track>) -> Value {
    let points: BTreeSet<_> = tracks.flat_map(|track| &track.items).flat_map(|clip| [clip.start.0, clip.start.0.saturating_add(clip.duration.0)]).collect();
    json!(points.into_iter().map(|point| point.to_string()).collect::<Vec<_>>())
}

pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Vec<DerivedValues> {
    let wanted = |id: &Value| {
        ids.is_empty()
            || ids
                .iter()
                .any(|wanted| wanted == id || wanted.as_str().is_some_and(|wanted| id.as_u64().is_some_and(|id| wanted.parse::<u64>().ok() == Some(id))))
    };
    let named = |name: &str| names.is_empty() || names.iter().any(|wanted| wanted == name);
    let mut result = Vec::new();
    if wanted(&json!("project")) && named("itemIds") {
        result.push(DerivedValues {
            id: json!("project"),
            values: serde_json::Map::from_iter([("itemIds".into(), json!(session.project.items.keys().map(|id| id.0).collect::<Vec<_>>()))]),
        });
    }
    for item in session.project.items.values() {
        let mut values = serde_json::Map::new();
        let q = item.as_sequence();
        if wanted(&json!(item.id.0)) {
            let source_names = ["sourceStart", "sourceEnd", "sourceRate", "sourceMarkIn", "sourceMarkOut", "sourceMedia", "sourceMarkerStarts"];
            if source_names.iter().any(|name| named(name)) {
                let view = kition_film_engine::clip_ops::source_view(session, item.id);
                for (name, value) in [
                    ("sourceStart", json!(view.as_ref().map(|view| view.start.0.to_string()))),
                    ("sourceEnd", json!(view.as_ref().map(|view| view.end.0.to_string()))),
                    ("sourceRate", json!(view.as_ref().map(|view| [view.rate.num, view.rate.den]))),
                    ("sourceMarkIn", json!(view.as_ref().and_then(|view| view.mark_in.map(|time| time.0.to_string())))),
                    ("sourceMarkOut", json!(view.as_ref().and_then(|view| view.mark_out.map(|time| time.0.to_string())))),
                    ("sourceMedia", json!(view.as_ref().map(|view| view.media.0))),
                    ("sourceMarkerStarts", json!(view.as_ref().map(|view| view.markers.iter().map(|marker| marker.start.0.to_string()).collect::<Vec<_>>()))),
                ] {
                    if named(name) {
                        values.insert(name.into(), value);
                    }
                }
            }
            if named("clipIds") {
                values.insert("clipIds".into(), json!(q.map(|q| q.all_tracks().flat_map(|track| &track.items).map(|clip| clip.id.0).collect::<Vec<_>>())));
            }
            if named("audioClipIds") {
                values.insert(
                    "audioClipIds".into(),
                    json!(q.map(|q| q.audio_tracks.iter().flat_map(|track| &track.items).map(|clip| clip.id.0).collect::<Vec<_>>())),
                );
            }
            if named("editPoints") {
                values.insert("editPoints".into(), q.map(|q| edit_points(q.all_tracks())).unwrap_or(Value::Null));
            }
        }
        if !values.is_empty() {
            result.push(DerivedValues { id: json!(item.id.0), values });
        }
        if named("editPoints")
            && let Some(q) = q
        {
            for track in q.all_tracks().filter(|track| wanted(&json!(track.id.0))) {
                result.push(DerivedValues {
                    id: json!(track.id.0),
                    values: serde_json::Map::from_iter([("editPoints".into(), edit_points(std::iter::once(track)))]),
                });
            }
        }
    }
    result
}
