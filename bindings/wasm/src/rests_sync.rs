//! Source facts consumed by multicam.rs / sync.rs, including referenced parents.
use kition_film_engine::{Session, project::ItemId};
use kition_kit::{Premise, Under};
use serde_json::{Value, json};

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if !matches!(command, "clip.createMulticam" | "clip.mergeClips" | "clip.synchronize") {
        return None;
    }
    let mut answer = Under::default();
    if command == "clip.synchronize" {
        let q = session.active_sequence()?;
        let clips = kition_film_engine::commands::with_links(session, &kition_film_engine::commands::clips_p(session, params));
        for id in clips {
            let Some((_, clip)) = q.find_item(id) else { continue };
            answer.premises.push(Premise::on(json!(id.0)));
            super::rests_effects::source(session, clip.item, &mut answer);
        }
        for track in q.all_tracks() {
            answer.premises.push(Premise::on(json!(track.id.0)).fields(["props.locked", "~clipOrder"]).positions(Vec::<String>::new()));
            // Synchronize overwrites its destinations, copying boundary pieces.
            for clip in &track.items {
                answer.premises.push(Premise::on(json!(clip.id.0)));
            }
            for transition in &track.transitions {
                answer.premises.push(Premise::on(json!(transition.id.0)));
            }
        }
        answer.premises.push(
            Premise::on(json!(session.state.active_sequence?.0))
                .fields(["sequence.settings.settings.frame_rate", "~videoTrackOrder", "~audioTrackOrder"])
                .positions(Vec::<String>::new()),
        );
    } else {
        let items = params
            .get("items")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).map(ItemId).collect::<Vec<_>>())
            .unwrap_or_else(|| session.state.project_selection.clone());
        if command == "clip.mergeClips" {
            let eligible: Vec<_> = items.iter().copied().filter(|id| kition_film_engine::sync::project_clip(&session.project, *id).is_some()).collect();
            let reference =
                eligible.iter().copied().find(|id| session.project.item(*id).is_some_and(|item| item.has_video())).or_else(|| eligible.first().copied());
            if let Some(reference) = reference {
                answer.premises.push(Premise::on(json!(reference.0)).fields(["~parentBin"]).positions(Vec::<String>::new()));
            }
        }
        for id in items {
            let mut fields = vec!["kind", "name", "props.common.label"];
            if matches!(params.get("cameraNames").and_then(Value::as_str), Some("metadata" | "cameraAngle" | "label")) {
                fields.extend([
                    "props.common.metadata.Camera Angle",
                    "props.common.metadata.Camera Label",
                    "props.common.metadata.Camera",
                    "props.common.metadata.camera",
                    "props.common.metadata.cameraAngle",
                ]);
            }
            answer.premises.push(Premise::on(json!(id.0)).fields(fields).positions(Vec::<String>::new()));
            super::rests_effects::source(session, id, &mut answer);
        }
        if params.get("processedBin").and_then(Value::as_bool) == Some(true) {
            // Reusing the named root bin is an address by name, not its contents.
            answer.premises.push(Premise::on(json!("project")).fields(["~processedBin"]).positions(Vec::<String>::new()));
        }
    }
    Some(answer)
}
