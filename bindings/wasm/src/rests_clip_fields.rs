//! C8-film-read: field patches from the independently committed label/video-option readings.
//! Resolution follows clip_ops::apply_label, commands' generic edit.label, and video_clips.

use kition_film_engine::Session;
use kition_film_engine::project::{ClipId, ItemId};
use kition_kit::{Premise, Under};
use serde_json::{Value, json};

fn ids(params: &Value, key: &str) -> Option<Vec<u64>> {
    params.get(key).and_then(Value::as_array).map(|ids| ids.iter().filter_map(Value::as_u64).collect())
}

fn field(id: u64, field: &str) -> Premise {
    Premise { id: json!(id), fields: Some(vec![field.to_owned()]), positions: Some(Vec::new()), ..Default::default() }
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let label = command == "edit.label"
        || matches!(
            command,
            "edit.label.violet"
                | "edit.label.iris"
                | "edit.label.caribbean"
                | "edit.label.lavender"
                | "edit.label.cerulean"
                | "edit.label.forest"
                | "edit.label.rose"
                | "edit.label.mango"
                | "edit.label.purple"
                | "edit.label.blue"
                | "edit.label.teal"
                | "edit.label.magenta"
                | "edit.label.tan"
                | "edit.label.green"
                | "edit.label.brown"
                | "edit.label.yellow"
        );
    if label {
        let generic = command == "edit.label";
        let items = if generic {
            session.state.project_selection.iter().map(|id| id.0).collect()
        } else {
            ids(params, "items")
                .unwrap_or_else(|| if params.get("clips").is_some() { Vec::new() } else { session.state.project_selection.iter().map(|id| id.0).collect() })
        };
        let clips = if generic {
            session.state.selection.iter().map(|id| id.0).collect()
        } else {
            ids(params, "clips")
                .unwrap_or_else(|| if params.get("items").is_some() { Vec::new() } else { session.state.selection.iter().map(|id| id.0).collect() })
        };
        let mut premises: Vec<_> =
            items.into_iter().filter(|id| session.project.item(ItemId(*id)).is_some()).map(|id| field(id, "props.common.label")).collect();
        premises.extend(clips.into_iter().map(|id| super::rests_core::scoped_clip_fields(session, ClipId(id), ["props.label".to_owned()])));
        return Some(Under { premises, ..Default::default() });
    }
    let leaf = match command {
        "clip.fieldOptions" => "props.field_options",
        "clip.setTimeInterpolation"
        | "clip.timeInterpolation.frameSampling"
        | "clip.timeInterpolation.frameBlending"
        | "clip.timeInterpolation.opticalFlow" => "props.time_interpolation",
        _ => return None,
    };
    let clips: Vec<_> = kition_film_engine::commands::clips_p(session, params).into_iter().map(|id| id.0).collect();
    let premises = clips
        .into_iter()
        .map(|id| {
            let video = session.active_sequence().is_some_and(|q| q.video_tracks.iter().any(|track| track.item(ClipId(id)).is_some()));
            Premise {
                id: json!(id),
                fields: Some(if video { vec![leaf.to_owned()] } else { Vec::new() }),
                // Video ownership determines eligibility. Keep that address until the
                // guard can distinguish a move between video tracks from one to audio.
                positions: Some(vec!["clips".to_owned()]),
                ..Default::default()
            }
        })
        .collect();
    Some(Under { premises, ..Default::default() })
}
