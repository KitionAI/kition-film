//! Project-owned LUT strings and Color effect slot assignments (color.rs).
use kition_film_engine::{Session, project::ClipId};
use kition_kit::{Premise, Under};
use serde_json::{Value, json};

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !matches!(command, "lut.remove" | "color.setInputLut" | "color.setLook" | "color.setSection" | "color.applyPreset") {
        return None;
    }
    // Path imports are host-only and include file parsing/dedup before target resolution.
    if params.get("path").is_some() {
        return None;
    }
    let mut answer = Under::default();
    let library = if command == "lut.remove" {
        params.get("id").and_then(Value::as_str).map(|id| id.trim_start_matches("lib:"))
    } else {
        params.get("lut").and_then(Value::as_str).and_then(|id| id.trim().strip_prefix("lib:"))
    };
    if let Some(id) = library {
        let field = if !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric()) { format!("luts[id={id}]") } else { "luts".to_owned() };
        answer.premises.push(Premise::on(json!("project")).fields([field]).positions(Vec::<String>::new()));
    }
    if command == "lut.remove" {
        return Some(answer);
    }
    let q = session.active_sequence()?;
    let candidates = kition_film_engine::commands::clips_p(session, params);
    let video: Vec<_> = candidates.into_iter().filter(|id| q.video_tracks.iter().any(|t| t.item(*id).is_some())).collect();
    let targets = if command == "color.applyPreset" {
        video.clone()
    } else {
        let explicit = params.get("clip").and_then(Value::as_u64).map(ClipId);
        explicit
            .or_else(|| video.iter().copied().find(|id| q.find_item(*id).is_some_and(|(_, clip)| clip.effect("color").is_some())))
            .or_else(|| video.first().copied())
            .into_iter()
            .collect()
    };
    for id in &targets {
        answer.premises.push(Premise::on(json!(id.0)).fields(["effects"]).positions(["clips"]));
        if let Some((track, _)) = q.find_item(*id) {
            answer.premises.push(Premise::on(json!(track.0)).fields(["props.kind"]).positions(Vec::<String>::new()));
        }
    }
    if command != "color.applyPreset" && params.get("clip").is_none() {
        // Preferred Color effect selection can change when an effect is removed
        // from a previously preferred clip, even if a different clip wins now.
        for id in &video {
            answer.premises.push(Premise::on(json!(id.0)).fields(["effects"]).positions(["clips"]));
        }
    }
    Some(answer)
}
