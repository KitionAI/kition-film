//! Keyboard movement computes destinations from selected geometry before overwriting.
use kition_film_engine::{Session, project::TrackKind};
use kition_film_time::Tick;
use kition_kit::{Premise, TimeSpan, Under, Within};
use serde_json::json;

pub fn under(session: &Session, command: &str) -> Option<Under> {
    let frames = match command {
        "timeline.nudgeLeft" => -1,
        "timeline.nudgeRight" => 1,
        "timeline.nudgeLeft5" => -5,
        "timeline.nudgeRight5" => 5,
        "timeline.nudgeUp" | "timeline.nudgeDown" => 0,
        _ => return None,
    };
    let q = session.active_sequence()?;
    let sequence = session.state.active_sequence?;
    let vertical = frames == 0;
    let selected = if vertical { session.state.selection.clone() } else { kition_film_engine::commands::with_links(session, &session.state.selection) };
    let mut answer = Under::default();
    for clip in &selected {
        answer.premises.push(Premise::on(json!(clip.0)).fields(["link"]));
    }
    let delta = if vertical {
        Tick::ZERO
    } else {
        answer.premises.push(leaf(sequence.0, ["sequence.settings.settings.frame_rate"]));
        if session.state.linked_selection {
            for clip in &session.state.selection {
                answer.premises.push(leaf(clip.0, ["link", "~linkedGroup"]));
                if let Some(group) = q.find_item(*clip).and_then(|(_, clip)| clip.link)
                    && let Some(root) = q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(group)).map(|clip| clip.id.0).min()
                {
                    answer.premises.push(leaf(root, ["~linkedMembers"]));
                }
            }
        }
        let first = selected.iter().filter_map(|id| q.find_item(*id).map(|(_, clip)| clip.start)).min().unwrap_or_default();
        q.settings.frame_rate.tick_of(frames).max(Tick(first.0.saturating_neg()))
    };
    if !vertical && delta == Tick::ZERO {
        return Some(answer);
    }
    let mut moves = Vec::new();
    let mut invalid = false;
    for clip in &selected {
        let Some((owner, item)) = q.find_item(*clip) else { continue };
        let Some(track) = q.track(owner) else { continue };
        let destination = if vertical {
            let list = q.tracks(track.kind);
            let field = if track.kind == TrackKind::Video { "~videoTrackOrder" } else { "~audioTrackOrder" };
            answer.premises.push(leaf(sequence.0, [field]));
            answer.premises.push(leaf(owner.0, ["props.kind"]));
            let forward = matches!((track.kind, command), (TrackKind::Video, "timeline.nudgeUp") | (TrackKind::Audio, "timeline.nudgeDown"));
            list.iter()
                .position(|track| track.id == owner)
                .and_then(|index| if forward { index.checked_add(1) } else { index.checked_sub(1) })
                .and_then(|index| list.get(index))
                .map(|track| track.id)
        } else {
            Some(owner)
        };
        let Some(destination) = destination else {
            invalid = true;
            continue;
        };
        let Some(start) = item.start.0.checked_add(delta.0) else {
            invalid = true;
            continue;
        };
        if !vertical {
            answer.content.push(kition_kit::ContentPremise { id: json!(clip.0), field: "start".into(), region: json!("keyboard-assigned-start") });
        }
        moves.push(json!({"clip":clip.0,"track":destination.0,"time":start}));
    }
    if invalid || moves.is_empty() {
        return Some(answer);
    }
    // The mouse move planner already supplies overwrite membership, locks and
    // transition recipients. Keyboard shortcuts preserve the clips' appearance.
    let params = json!({"moves":moves,"linked":false});
    for premise in session.premises("timeline.move", &params) {
        answer.premises.push(Premise {
            id: json!(premise.id),
            fields: if selected.iter().any(|clip| clip.0 == premise.id) {
                Some(if vertical { vec!["link".into()] } else { vec!["link".into(), "start".into()] })
            } else {
                premise.fields
            },
            positions: premise.positions,
            ..Default::default()
        });
    }
    if let Ok(Some(place)) = session.under("timeline.move", &params) {
        answer.objects.extend(place.clips.iter().map(|clip| json!(clip.0)));
        answer.within.extend(place.windows.iter().map(|window| Within {
            parent: json!(window.track.0),
            field: "clips".into(),
            from: window.from,
            to: window.to,
            time: Some(TimeSpan {
                from: json!(window.at.0.to_string()),
                to: json!(window.at.0.saturating_add(window.span.0).to_string()),
                start: "start".into(),
                duration: Some("duration".into()),
                ..Default::default()
            }),
        }));
    }
    Some(answer)
}

fn leaf(id: u64, fields: impl IntoIterator<Item = &'static str>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
