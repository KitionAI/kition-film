//! Sequence audio consumers: sequence_extras::{normalize_mix,transcribe}.
use kition_film_engine::{
    Session,
    project::{ClipId, ItemId, Track, TrackId},
};
use kition_kit::{Premise, Under};
use serde_json::{Value, json};

fn need(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}

fn audio_track(session: &Session, value: &Value) -> Option<TrackId> {
    let q = session.active_sequence()?;
    if let Some(id) = value.as_u64() {
        return q.audio_tracks.iter().find(|t| t.id.0 == id).map(|t| t.id);
    }
    let name = value.as_str()?;
    let prefix = name.as_bytes().first()?;
    if !matches!(prefix, b'a' | b'A') {
        return None;
    }
    let index = name.get(1..)?.parse::<usize>().ok()?.checked_sub(1)?;
    q.audio_tracks.get(index).map(|t| t.id)
}

fn mixed_track(session: &Session, track: &Track, answer: &mut Under) {
    answer.premises.push(need(track.id.0, &["volumeDb", "pan", "effects", "props.channels", "props.muted", "props.solo", "props.mixer", "~clipOrder"]));
    for transition in &track.transitions {
        answer.premises.push(Premise::on(json!(transition.id.0)));
    }
    for clip in &track.items {
        answer.premises.push(
            Premise::on(json!(clip.id.0))
                .fields([
                    "item",
                    "sourceIn",
                    "speed",
                    "reverse",
                    "gain",
                    "effects",
                    "props.enabled",
                    "props.frame_hold",
                    "props.audio_mixing.mute",
                    "props.source_channels",
                    "props.audio_stream",
                    "props.multicam",
                ])
                .positions(["start", "duration"]),
        );
        super::rests_effects::source(session, clip.item, answer);
    }
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if command == "audio.detectBeats" || command.starts_with("clip.remix") || command == "clip.sceneEditDetection" {
        return analysis(session, command, params);
    }
    if !matches!(command, "sequence.normalizeMixTrack" | "sequence.transcribe") {
        return None;
    }
    let q = session.active_sequence()?;
    let sequence = session.state.active_sequence?;
    let mut answer = Under::default();
    if command == "sequence.normalizeMixTrack" {
        answer.premises.push(
            Premise::on(json!(sequence.0))
                .fields([
                    "~audioTrackOrder",
                    "~submixTrackOrder",
                    "sequence.masterVolumeDb",
                    "sequence.mixer",
                    "sequence.settings.settings.sample_rate",
                    "sequence.settings.settings.audio_master",
                ])
                .positions(["sequence.duration"]),
        );
        for track in q.audio_tracks.iter().chain(&q.submix_tracks) {
            mixed_track(session, track, &mut answer);
        }
    } else {
        let selected = params.get("track").and_then(|v| audio_track(session, v));
        answer.premises.push(need(sequence.0, &["~audioTrackOrder"]));
        for track in q.audio_tracks.iter().filter(|t| selected.is_none_or(|id| t.id == id)) {
            answer.premises.push(need(track.id.0, &["~clipOrder"]));
            for clip in &track.items {
                answer.premises.push(need(clip.id.0, &["item", "props.enabled"]));
                if clip.enabled {
                    super::rests_effects::source(session, clip.item, &mut answer);
                }
            }
        }
        // transcript.generate replaces the transcripts of its resolved media.
        answer.premises.push(Premise::on(json!("project")).fields(["docState.transcripts"]).positions(Vec::<String>::new()));
    }
    Some(answer)
}

fn analysis(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let sequence = session.state.active_sequence?;
    let q = session.active_sequence()?;
    let beats = command == "audio.detectBeats";
    let scene = command == "clip.sceneEditDetection";
    let mut answer = Under::default();
    answer.premises.push(need(
        sequence.0,
        if beats || scene {
            &["sequence.settings.settings.frame_rate"]
        } else {
            &["sequence.settings.settings.frame_rate", "sequence.settings.settings.drop_frame", "sequence.settings.settings.sample_rate"]
        },
    ));
    if beats && let Some(item) = params.get("item").and_then(Value::as_u64) {
        super::rests_effects::source(session, ItemId(item), &mut answer);
    }
    let targets = if scene {
        kition_film_engine::commands::clips_p(session, params)
    } else if let Some(id) = params.get("clip").and_then(Value::as_u64) {
        vec![ClipId(id)]
    } else if beats {
        Vec::new()
    } else {
        let mut chosen = Vec::new();
        for id in &session.state.selection {
            answer.premises.push(need(id.0, &[]).positions(["clips"]));
            if let Some((owner, _)) = q.find_item(*id) {
                answer.premises.push(need(owner.0, &["props.kind"]));
                if q.audio_tracks.iter().any(|track| track.id == owner) {
                    chosen.push(*id);
                    break;
                }
            }
        }
        chosen
    };
    for id in targets {
        let Some((owner, clip)) = q.find_item(id) else { continue };
        answer.premises.push(need(owner.0, if scene { &["props.kind", "props.locked"] } else { &["props.kind"] }));
        answer.premises.push(if beats {
            need(id.0, &["item", "sourceIn", "speed", "reverse", "props.frame_hold", "effects"]).positions(["start", "duration", "clips"])
        } else {
            Premise::on(json!(id.0))
        });
        super::rests_effects::source(session, clip.item, &mut answer);
        if !beats
            && !scene
            && let Some(track) = q.track(owner)
        {
            answer.premises.push(need(owner.0, &["~clipOrder"]));
            answer.premises.extend(track.items.iter().map(|peer| need(peer.id.0, &[]).positions(["start"])));
        }
        if scene {
            let root = session.project.resolve_media(clip.item).map(|(id, _, _)| id).unwrap_or(clip.item);
            answer.premises.push(need(root.0, &["name", "props.common.label", "props.media.markers"]));
            if params.get("applyCuts").and_then(Value::as_bool) != Some(false) {
                answer.premises.push(need(owner.0, &["transitions"]));
                answer.premises.push(need(id.0, &["~linkedGroup"]));
                if let Some(link) = clip.link {
                    let peers: Vec<_> = q.all_tracks().flat_map(|track| &track.items).filter(|peer| peer.link == Some(link)).collect();
                    if let Some(root) = peers.iter().map(|peer| peer.id.0).min() {
                        answer.premises.push(need(root, &["~linkedMembers"]));
                    }
                    for peer in peers {
                        answer.premises.push(Premise::on(json!(peer.id.0)));
                        if let Some((owner, _)) = q.find_item(peer.id) {
                            answer.premises.push(need(owner.0, &["props.locked", "transitions"]));
                        }
                    }
                }
            }
        }
    }
    Some(answer)
}
