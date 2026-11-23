//! Inputs to Color Match's target render and reference render (color.rs::apply_match).
use kition_film_engine::{
    Session,
    project::{ClipId, TrackItem},
};
use kition_film_time::Tick;
use kition_kit::{Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

fn picture(session: &Session, clip: &TrackItem, answer: &mut Under) {
    let mut fields = vec![
        "item",
        "sourceIn",
        "speed",
        "reverse",
        "effects",
        "props.enabled",
        "props.frame_hold",
        "props.hold_filters",
        "props.scale_to_frame",
        "props.time_interpolation",
        "props.multicam",
        "props.graphic",
    ];
    // Clip Name is the only effect that consumes the display name.
    if clip.effects.iter().any(|e| e.enabled && e.effect == "clip_name") {
        fields.push("props.name");
    }
    answer.premises.push(Premise::on(json!(clip.id.0)).fields(fields).positions(["start", "duration"]));
    super::rests_effects::source(session, clip.item, answer);
    for effect in clip.effects.iter().filter(|e| e.enabled) {
        for param in effect.params.values() {
            let kition_film_engine::project::ParamValue::Text(reference) = &param.value else { continue };
            let Some(id) = reference.strip_prefix("lib:") else { continue };
            let field = if id.bytes().all(|b| b.is_ascii_alphanumeric()) { format!("luts[id={id}]") } else { "luts".to_owned() };
            answer.premises.push(Premise::on(json!("project")).fields([field]).positions(Vec::<String>::new()));
        }
    }
}

fn window(answer: &mut Under, parent: u64, field: &str, from: usize, to: usize, at: Tick) {
    answer.within.push(Within {
        parent: json!(parent),
        field: field.to_owned(),
        from,
        to,
        time: Some(TimeSpan {
            from: json!(at.0.to_string()),
            to: json!(at.0.saturating_add(1).to_string()),
            start: "start".to_owned(),
            end: None,
            duration: Some("duration".to_owned()),
            identity: None,
        }),
    });
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if command != "color.applyMatch" {
        return None;
    }
    let q = session.active_sequence()?;
    let sequence = session.state.active_sequence?;
    let video = |id: &ClipId| q.video_tracks.iter().any(|track| track.item(*id).is_some());
    let selected: Vec<_> = session.state.selection.iter().copied().filter(video).collect();
    let id = kition_film_engine::commands::clip_p(params, "clip")
        .or_else(|| selected.iter().copied().find(|id| q.find_item(*id).is_some_and(|(_, clip)| clip.effect("color").is_some())))
        .or_else(|| selected.first().copied())?;
    let (_, target) = q.find_item(id)?;
    let time = kition_film_engine::commands::time_p(session, params, "reference")?;
    let mut answer = Under::default();
    answer.premises.push(Premise::on(json!(sequence.0)).fields(["sequence.settings.settings", "~videoTrackOrder"]).positions(Vec::<String>::new()));
    picture(session, target, &mut answer);
    for track in &q.video_tracks {
        answer.premises.push(Premise::on(json!(track.id.0)).fields(["props.enabled"]).positions(Vec::<String>::new()));
        if !track.enabled {
            continue;
        }
        let from = track.items.partition_point(|clip| clip.end() <= time);
        let to = track.items.partition_point(|clip| clip.start <= time).max(from);
        window(&mut answer, track.id.0, "clips", from, to, time);
        let from = track.transitions.partition_point(|tr| tr.end() <= time);
        let to = track.transitions.partition_point(|tr| tr.start <= time).max(from);
        window(&mut answer, track.id.0, "transitions", from, to, time);
        if let Some(transition) = track.transitions.iter().find(|tr| tr.range().contains(time)) {
            answer.objects.push(json!(transition.id.0));
            answer.premises.push(Premise::on(json!(transition.id.0)));
            for clip in [transition.from, transition.to].into_iter().flatten().filter_map(|id| track.item(id)) {
                picture(session, clip, &mut answer);
            }
        } else if let Some(clip) = track.item_at(time) {
            answer.objects.push(json!(clip.id.0));
            picture(session, clip, &mut answer);
        }
    }
    Some(answer)
}
