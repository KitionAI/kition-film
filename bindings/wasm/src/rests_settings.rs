//! Sequence Settings patches and frame_size::scale_motion's conditional inputs.
use kition_film_engine::Session;
use kition_kit::{Premise, Under};
use serde_json::{Value, json};

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if command == "sequence.colorSettings" {
        let id = session.state.active_sequence?;
        let root = "sequence.settings.settings";
        // A color edit normalizes the label from working space even when only
        // a boolean was supplied. Preserve both that input and its assignment.
        let mut fields = vec![format!("{root}.working_space"), format!("{root}.color.working")];
        for (param, field) in [("wideGamut", "wide_gamut"), ("autoToneMap", "auto_tone_map")] {
            if params.get(param).and_then(Value::as_bool).is_some() {
                fields.push(format!("{root}.color.{field}"));
            }
        }
        return Some(Under { premises: vec![Premise::on(json!(id.0)).fields(fields).positions(Vec::<String>::new())], ..Default::default() });
    }
    if command != "sequence.settings" {
        return None;
    }
    let q = session.active_sequence()?;
    let id = session.state.active_sequence?;
    let root = "sequence.settings.settings";
    let mut fields = vec![format!("{root}.working_space"), format!("{root}.color.working")];
    for (param, field) in [
        ("width", "width"),
        ("height", "height"),
        ("fps", "frame_rate"),
        ("sampleRate", "sample_rate"),
        ("mix", "audio_master"),
        ("dropFrame", "drop_frame"),
        ("maxRenderQuality", "max_render_quality"),
        ("workingSpace", "color.working"),
        ("wideGamut", "color.wide_gamut"),
        ("autoToneMap", "color.auto_tone_map"),
    ] {
        if params.get(param).is_some() {
            fields.push(format!("{root}.{field}"));
        }
    }
    if params.get("name").is_some() {
        fields.push("name".to_owned());
    }
    // Invalid dimensions are reported by the handler before publishing an edit.
    let (Ok(width), Ok(height)) =
        (kition_film_engine::commands::checked_u32_p(params, "width", command), kition_film_engine::commands::checked_u32_p(params, "height", command))
    else {
        return None;
    };
    let width = width.unwrap_or(q.settings.width);
    let height = height.unwrap_or(q.settings.height);
    let resizing = (width, height) != (q.settings.width, q.settings.height);
    if resizing || params.get("fps").is_some() {
        // The derived preset label contains all three of these values.
        fields.extend(["width", "height", "frame_rate", "preset"].map(|f| format!("{root}.{f}")));
    }
    if params.get("dropFrame").and_then(Value::as_bool) == Some(true) && params.get("fps").is_none() {
        fields.push(format!("{root}.frame_rate"));
    }
    if resizing && params.get("scaleMotion").and_then(Value::as_bool) == Some(true) {
        fields.push("~motionScale".to_owned());
    }
    Some(Under { premises: vec![Premise::on(json!(id.0)).fields(fields).positions(Vec::<String>::new())], ..Default::default() })
}
