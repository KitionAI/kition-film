//! Copy edits retain source material and the geometry of destination searches.
use kition_film_engine::{
    Session, commands,
    project::{ItemKind, TrackKind},
};
use kition_kit::{Premise, Under};
use serde_json::{Value, json};
use std::collections::BTreeSet;
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !matches!(command, "clip.nest" | "clip.multicamFlatten") {
        return None;
    }
    let q = session.active_sequence()?;
    let seq = session.state.active_sequence?;
    let named = if command == "clip.nest" { session.state.selection.clone() } else { commands::clips_p(session, params) };
    let ids = commands::with_links(session, &named);
    let mut answer = Under::default();
    if command == "clip.nest" {
        answer.premises.push(leaf(seq.0, &["sequence.settings.settings", "~videoTrackOrder", "~audioTrackOrder"]));
        if params.get("name").and_then(Value::as_str).is_none_or(|name| name.trim().is_empty()) {
            answer.premises.push(Premise::on(json!("project")).fields(["~itemIds"]).positions(Vec::<String>::new()));
            for item in session.project.items.values() {
                answer.premises.push(leaf(item.id.0, if matches!(item.kind, ItemKind::Sequence(_)) { &["kind", "name"] } else { &["kind"] }));
            }
        }
        for track in q.video_tracks.iter().chain(&q.audio_tracks) {
            answer.premises.push(leaf(track.id.0, &["props.name", "props.channels", "props.locked", "~editEdges", "transitions"]));
            for clip in &track.items {
                answer.premises.push(if ids.contains(&clip.id) && !track.locked { Premise::on(json!(clip.id.0)) } else { leaf(clip.id.0, &["link"]) });
            }
        }
        return Some(answer);
    }
    answer.premises.push(leaf(seq.0, &["sequence.settings.settings.frame_rate", "~videoTrackOrder", "~audioTrackOrder"]));
    let mut destinations = BTreeSet::new();
    for id in &ids {
        answer.premises.push(Premise::on(json!(id.0)));
        let Some((owner, outer)) = q.find_item(*id) else { continue };
        if !outer.multicam.is_some_and(|mode| mode.enabled) {
            continue;
        }
        let Some(source) = session.project.sequence(outer.item) else { continue };
        answer.premises.push(leaf(outer.item.0, &["kind", "~cameraMap", "sequence.settings"]));
        let owner = q.track(owner)?;
        let sources = if owner.kind == TrackKind::Video {
            let angle = outer.multicam.map_or(0, |mode| mode.angle as usize);
            source.angle_video_track_index(angle).and_then(|index| source.video_tracks.get(index)).into_iter().collect::<Vec<_>>()
        } else {
            match &source.multicam {
                Some(map) => map
                    .audible_tracks(if map.audio == kition_film_engine::project::MulticamAudio::SwitchAudio { outer.multicam_angle(source) } else { None })
                    .into_iter()
                    .filter_map(|id| source.track(id))
                    .collect(),
                None => source.audio_tracks.iter().filter(|track| !track.muted).collect(),
            }
        };
        if owner.kind == TrackKind::Video {
            destinations.insert(owner.id);
        } else if let Some(at) = q.audio_tracks.iter().position(|track| track.id == owner.id) {
            destinations.extend(q.audio_tracks.iter().skip(at).take(sources.len().max(1)).map(|track| track.id));
        }
        for track in sources {
            answer.premises.push(leaf(track.id.0, &["clips"]));
            answer.premises.extend(track.items.iter().map(|clip| Premise::on(json!(clip.id.0))));
        }
    }
    for track in q.all_tracks().filter(|track| destinations.contains(&track.id)) {
        answer.premises.push(leaf(track.id.0, &["props.locked", "~editEdges", "transitions"]));
        for clip in &track.items {
            if ids.iter().filter_map(|id| q.find_item(*id)).any(|(_, outer)| clip.start < outer.end() && clip.end() > outer.start) {
                answer.premises.push(Premise::on(json!(clip.id.0)));
            }
        }
    }
    Some(answer)
}
