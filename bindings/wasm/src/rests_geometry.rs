//! Edge searches retain geometry separately from appearance on candidate lanes.
use kition_film_engine::{
    Session, commands,
    project::{ClipId, Track, TrackKind},
};
use kition_kit::{DerivedValues, Premise, Under};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}

fn lane(answer: &mut Under, track: &Track, source_fields: bool, session: &Session) {
    answer.premises.push(leaf(track.id.0, &["~editEdges", "props.locked", "props.sync_lock", "transitions"]));
    for clip in &track.items {
        answer.premises.push(Premise::on(json!(clip.id.0)).fields(["item", "sourceIn", "speed", "reverse", "link", "props.frame_hold"]).positions(["clips"]));
        if source_fields {
            super::rests_core::source_bounds(session, clip.item, answer);
        }
    }
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let slides = matches!(command, "timeline.slideLeft" | "timeline.slideRight" | "timeline.slideLeft5" | "timeline.slideRight5");
    let stretch = command == "timeline.rateStretch";
    let extend = matches!(command, "trim.extendPreviousEdit" | "trim.extendNextEdit");
    let trim = matches!(command, "trim.ripplePrevious" | "trim.rippleNext" | "trim.previous" | "trim.next");
    let hold = matches!(command, "clip.frameHold" | "clip.insertFrameHoldSegment");
    let transition = command == "trim.applyDefaultTransition";
    if !(slides || stretch || extend || trim || hold || transition) {
        return None;
    }
    let q = session.active_sequence()?;
    let id = session.state.active_sequence?;
    let mut answer = Under::default();
    answer.premises.push(leaf(id.0, &["sequence.settings.settings.frame_rate"]));
    if params.get("timecode").and_then(Value::as_str).is_some() {
        answer.premises.push(leaf(id.0, &["sequence.settings.settings.drop_frame"]));
    }
    let named = if stretch { commands::clip_p(params, "clip").into_iter().collect() } else { session.state.selection.clone() };
    let selected = commands::with_links(session, &named);
    if session.state.linked_selection && (slides || stretch || trim) {
        for id in &named {
            answer.premises.push(leaf(id.0, &["link", "~linkedGroup"]));
            if let Some(group) = q.find_item(*id).and_then(|(_, clip)| clip.link)
                && let Some(root) = q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(group)).map(|clip| clip.id.0).min()
            {
                answer.premises.push(leaf(root, &["~linkedMembers"]));
            }
        }
    }
    let owners: BTreeSet<_> = selected.iter().filter_map(|id| q.find_item(*id).map(|(owner, _)| owner)).collect();
    let targeted = session.targeting().targeted;
    if extend || trim || hold {
        answer.premises.push(leaf(id.0, &["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
    }
    for track in q.all_tracks() {
        let candidate = if slides || stretch {
            owners.contains(&track.id)
        } else if extend {
            targeted.contains(&track.id)
        } else if transition {
            session.state.edit_points.iter().any(|point| track.item(point.clip).is_some())
        } else {
            true
        };
        if candidate {
            lane(&mut answer, track, slides || extend, session);
        }
    }
    if hold {
        let at = commands::time_p(session, params, "").unwrap_or(session.playhead());
        let explicit = commands::clip_p(params, "clip");
        let ids = if command == "clip.frameHold" {
            let wanted = commands::clips_p(session, params);
            let mut ids: Vec<_> = q
                .video_tracks
                .iter()
                .flat_map(|track| &track.items)
                .filter(|clip| wanted.contains(&clip.id) && clip.start <= at && at < clip.end())
                .map(|clip| clip.id)
                .collect();
            if ids.is_empty() && params.get("clip").is_none() && params.get("clips").is_none() {
                ids.extend(
                    q.video_tracks
                        .iter()
                        .filter(|track| targeted.contains(&track.id) && !track.locked)
                        .filter_map(|track| track.item_at(at).map(|clip| clip.id))
                        .take(1),
                );
            }
            ids
        } else {
            let pick =
                |id: ClipId| q.video_tracks.iter().find_map(|track| track.item(id).filter(|clip| clip.start <= at && at < clip.end()).map(|clip| clip.id));
            explicit
                .and_then(pick)
                .or_else(|| session.state.selection.iter().find_map(|id| pick(*id)))
                .or_else(|| {
                    if explicit.is_none() {
                        q.video_tracks
                            .iter()
                            .filter(|track| targeted.contains(&track.id) && !track.locked)
                            .find_map(|track| track.item_at(at).map(|clip| clip.id))
                    } else {
                        None
                    }
                })
                .into_iter()
                .collect()
        };
        answer.premises.extend(ids.into_iter().map(|id| Premise::on(json!(id.0))));
        if command == "clip.insertFrameHoldSegment" {
            answer.premises.push(leaf(id.0, &["sequence.captionTracks", "sequence.captions"]));
        }
    }
    if trim {
        let ph = session.playhead();
        let under = |track: &Track, selected_only: bool| {
            track.items.iter().any(|clip| clip.start < ph && ph < clip.end() && (!selected_only || selected.contains(&clip.id)))
        };
        let mut tracks: Vec<_> =
            q.video_tracks.iter().chain(&q.audio_tracks).filter(|track| !track.locked && under(track, true)).map(|track| track.id).collect();
        if tracks.is_empty() {
            tracks = q
                .video_tracks
                .iter()
                .chain(&q.audio_tracks)
                .filter(|track| targeted.contains(&track.id) && !track.locked && under(track, false))
                .map(|track| track.id)
                .collect();
        }
        let next = matches!(command, "trim.rippleNext" | "trim.next");
        let edges = q.all_tracks().filter(|track| tracks.contains(&track.id)).flat_map(|track| track.items.iter().flat_map(|clip| [clip.start, clip.end()]));
        let edge = if next { edges.filter(|edge| *edge > ph).min() } else { edges.filter(|edge| *edge < ph).max() };
        if let Some(edge) = edge {
            let (start, end) = if next { (ph, edge) } else { (edge, ph) };
            let ripple = command.starts_with("trim.ripple");
            for track in q.all_tracks().filter(|track| !track.locked && (tracks.contains(&track.id) || ripple && track.sync_lock)) {
                answer.premises.extend(track.items.iter().filter(|clip| clip.start < end && clip.end() > start).map(|clip| Premise::on(json!(clip.id.0))));
            }
        }
        if command.starts_with("trim.ripple") {
            answer.premises.push(leaf(id.0, &["sequence.captionTracks", "sequence.captions"]));
        }
    }
    if transition {
        for point in &session.state.edit_points {
            let Some((owner, _)) = q.find_item(point.clip) else { continue };
            let video = q.track(owner).is_some_and(|track| track.kind == TrackKind::Video);
            let delegate = if video { "sequence.applyVideoTransition" } else { "sequence.applyAudioTransition" };
            for premise in session.premises(delegate, &json!({"clip":point.clip.0,"edge":if point.out {"out"} else {"in"}})) {
                answer.premises.push(Premise { id: json!(premise.id), fields: premise.fields, positions: premise.positions, ..Default::default() });
            }
        }
    }
    Some(answer)
}

pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Vec<DerivedValues> {
    if !names.is_empty() && !names.iter().any(|name| name == "editEdges") {
        return Vec::new();
    }
    session
        .project
        .sequences()
        .filter_map(|item| session.project.sequence(item.id))
        .flat_map(|q| q.all_tracks())
        .filter(|track| ids.is_empty() || ids.iter().any(|id| id == &json!(track.id.0)))
        .map(|track| DerivedValues {
            id: json!(track.id.0),
            values: serde_json::Map::from_iter([(
                "editEdges".into(),
                json!(track.items.iter().map(|clip| json!([clip.id.0, clip.start.0.to_string(), clip.duration.0.to_string()])).collect::<Vec<_>>()),
            )]),
        })
        .collect()
}
