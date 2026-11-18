//! transcript.rs:195-404 and edit/transcript.rs:62-103 derive words from audio
//! geometry. The serialized transcript library is an array of identity pairs.
use kition_film_engine::{Session, project::ItemKind};
use kition_kit::{Premise, Under};
use serde_json::{Value, json};

fn leaf(id: Value, fields: impl IntoIterator<Item = &'static str>) -> Premise {
    Premise::on(id).fields(fields).positions(Vec::<String>::new())
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !matches!(
        command,
        "transcript.set"
            | "transcript.delete"
            | "transcript.renameSpeaker"
            | "transcript.select"
            | "transcript.lift"
            | "transcript.extract"
            | "transcript.removePauses"
            | "transcript.removeFillers"
            | "transcript.createCaptions"
    ) {
        return None;
    }
    let mut answer = Under { premises: vec![leaf(json!("project"), ["docState.transcripts"])], ..Default::default() };
    if matches!(command, "transcript.set" | "transcript.delete" | "transcript.renameSpeaker") {
        let ids = params
            .get("items")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
            .unwrap_or_else(|| params.get("item").and_then(Value::as_u64).into_iter().collect());
        for id in ids {
            let mut current = kition_film_engine::project::ItemId(id);
            for _ in 0..=16 {
                answer.premises.push(leaf(json!(current.0), ["kind", "props.parent"]));
                let Some(ItemKind::Subclip { parent, .. }) = session.project.item(current).map(|item| &item.kind) else { break };
                current = *parent;
            }
        }
        return Some(answer);
    }
    let sequence = session.state.active_sequence?;
    let q = session.active_sequence()?;
    if command != "transcript.createCaptions" {
        // Range edits split/copy clips and shift suffixes; select also delegates
        // to selection-following navigation. Keep their complete owned sequence.
        answer.premises.push(leaf(json!(sequence.0), ["sequence"]));
    } else {
        answer.premises.push(leaf(json!(sequence.0), ["~audioTrackOrder", "sequence.settings.settings.frame_rate"]));
        for track in &q.audio_tracks {
            answer.premises.push(leaf(json!(track.id.0), ["~clipOrder"]));
            for clip in &track.items {
                answer.premises.push(
                    leaf(json!(clip.id.0), ["item", "props.enabled", "reverse", "props.frame_hold", "speed", "sourceIn"]).positions(["start", "duration"]),
                );
            }
        }
    }
    Some(answer)
}
