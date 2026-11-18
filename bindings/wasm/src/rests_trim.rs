//! Trim monitor wrappers delegate to the same trim/roll operations as the timeline.
use kition_film_engine::{
    Session,
    project::ClipId,
    trim::{self, TrimKind},
};
use kition_film_time::Tick;
use kition_kit::{Premise, Under};
use serde_json::{Value, json};

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if command == "trim.selectEditPoint" {
        return Some(Under {
            premises: params
                .get("clip")
                .and_then(Value::as_u64)
                .into_iter()
                .map(|id| Premise::on(json!(id)).fields(Vec::<String>::new()).positions(Vec::<String>::new()))
                .collect(),
            ..Default::default()
        });
    }
    if matches!(command, "trim.selectNearest" | "trim.edit") {
        let mut answer = Under::default();
        if command == "trim.edit" && !session.state.edit_points.is_empty() {
            return Some(answer);
        }
        let sequence = session.state.active_sequence?;
        let q = session.active_sequence()?;
        answer.premises.push(Premise::on(json!(sequence.0)).fields(["~videoTrackOrder", "~audioTrackOrder"]).positions(Vec::<String>::new()));
        let targeted = session.state.targeting.get(&sequence).map(|targeting| targeting.targeted.as_slice()).unwrap_or_default();
        for track in q.video_tracks.iter().chain(&q.audio_tracks).filter(|track| targeted.is_empty() || targeted.contains(&track.id)) {
            answer.premises.push(Premise::on(json!(track.id.0)).fields(["~clipOrder"]).positions(Vec::<String>::new()));
            answer.premises.extend(track.items.iter().map(|clip| Premise::on(json!(clip.id.0)).fields(Vec::<String>::new()).positions(["start", "duration"])));
        }
        return Some(answer);
    }
    if matches!(command, "trim.shuttle" | "trim.shuttleStop" | "trim.cancelDynamic" | "trim.playAround") {
        let sequence = session.state.active_sequence?;
        let q = session.active_sequence()?;
        let mut answer = Under { premises: vec![Premise::on(json!(sequence.0)).fields(["sequence"]).positions(Vec::<String>::new())], ..Default::default() };
        for clip in q.all_tracks().flat_map(|track| &track.items) {
            super::rests_effects::source(session, clip.item, &mut answer);
        }
        return Some(answer);
    }
    if !matches!(command, "trim.nudge" | "trim.backward" | "trim.forward" | "trim.backwardMany" | "trim.forwardMany" | "trim.extendToPlayhead") {
        return None;
    }
    let q = session.active_sequence()?;
    let sequence = session.state.active_sequence?;
    let frames = match command {
        "trim.backward" => -1,
        "trim.forward" => 1,
        "trim.backwardMany" => -i64::from(session.prefs.trim.large_trim_offset),
        "trim.forwardMany" => i64::from(session.prefs.trim.large_trim_offset),
        _ => params.get("frames").and_then(Value::as_i64).unwrap_or(1),
    };
    let delta = if command == "trim.extendToPlayhead" {
        session.state.edit_points.first().and_then(|point| trim::edit_time(q, point)).map(|time| session.playhead() - time).unwrap_or(Tick::ZERO)
    } else {
        q.settings.frame_rate.tick_of(frames)
    };
    let mut answer = Under::default();
    answer.premises.push(Premise::on(json!(sequence.0)).fields(["sequence.settings.settings.frame_rate"]).positions(Vec::<String>::new()));
    for point in &session.state.edit_points {
        let (delegate, args, targets) = if point.kind == TrimKind::Roll {
            let Some((left, right)) = trim::roll_pair(q, point) else {
                answer.premises.push(Premise::on(json!(point.clip.0)).fields(Vec::<String>::new()).positions(["start", "duration", "clips"]));
                if let Some((track, _)) = q.find_item(point.clip) {
                    answer.premises.push(Premise::on(json!(track.0)).fields(["~clipOrder"]).positions(Vec::<String>::new()));
                }
                continue;
            };
            ("timeline.roll", json!({"left":left.0,"right":right.0,"delta":delta.0}), vec![left, right])
        } else {
            (
                "timeline.trim",
                json!({"clip":point.clip.0,"edge":if point.out {"out"} else {"in"},"mode":if point.kind == TrimKind::Ripple {"ripple"} else {"regular"},"delta":delta.0}),
                kition_film_engine::commands::with_links(session, &[point.clip]),
            )
        };
        for premise in session.premises(delegate, &args) {
            let target = targets.contains(&ClipId(premise.id));
            let fields = if target && premise.fields.is_none() {
                Some(["item", "sourceIn", "speed", "reverse", "link", "props.frame_hold"].map(str::to_owned).to_vec())
            } else {
                premise.fields
            };
            answer.premises.push(Premise { id: json!(premise.id), fields, positions: premise.positions, ..Default::default() });
        }
        for target in &targets {
            answer.premises.push(
                Premise::on(json!(target.0))
                    .fields(["item", "sourceIn", "speed", "reverse", "link", "props.frame_hold"])
                    .positions(["start", "duration", "clips"]),
            );
            if let Some((track, _)) = q.find_item(*target) {
                answer.premises.push(Premise::on(json!(track.0)).fields(["~clipOrder"]).positions(Vec::<String>::new()));
            }
        }
        answer = super::rests_core::complete(session, delegate, &args, Some(answer)).unwrap_or_default();
    }
    Some(answer)
}
