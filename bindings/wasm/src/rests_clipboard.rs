//! Clipboard reads and deletion recipients from commands.rs and edit/lib.rs.
use kition_film_engine::{
    Session,
    commands::{clips_p, with_links},
};
use kition_kit::{Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

fn leaf(id: u64, names: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(names.iter().copied()).positions(Vec::<String>::new())
}

pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    let copy = matches!(command, "edit.copy" | "edit.cut");
    let paste = matches!(command, "edit.paste" | "edit.pasteInsert");
    let delete = matches!(command, "edit.clear" | "edit.rippleDelete");
    if !copy && !paste && !delete {
        return None;
    }
    let q = session.active_sequence()?;
    let seq = session.state.active_sequence?.0;
    let mut answer = Under::default();
    if delete && params.get("clips").is_none() && params.get("clip").is_none() && session.state.selection.is_empty() {
        answer.premises.push(leaf(seq, &["sequence.captionTracks"]));
        return Some(answer);
    }
    if paste {
        paste_inputs(session, command == "edit.pasteInsert", &mut answer);
        return Some(answer);
    }
    let base = if copy { session.state.selection.clone() } else { clips_p(session, params) };
    let selected = with_links(session, &base);
    let first = selected.iter().filter_map(|id| q.find_item(*id).map(|(_, clip)| clip.start)).min();
    let ripple = command == "edit.rippleDelete";
    if copy {
        answer.premises.push(leaf(seq, &["sequence.settings.settings.frame_rate"]));
    }
    if (copy && session.state.copy_paste_sequence_markers) || (ripple && session.state.ripple_sequence_markers) {
        answer.premises.push(leaf(seq, &["sequence.markers"]));
    }
    for (tracks, position) in [(&q.video_tracks, "sequence.videoTracks"), (&q.audio_tracks, "sequence.audioTracks")] {
        for track in tracks {
            let member = track.items.iter().any(|clip| selected.contains(&clip.id));
            if copy && member {
                answer.premises.push(leaf(track.id.0, &[]).positions([position]));
            }
            if command != "edit.copy" && member || ripple {
                answer.premises.push(leaf(track.id.0, if ripple { &["props.locked", "props.sync_lock"] } else { &["props.locked"] }));
            }
            if ripple || member && !track.locked && command != "edit.copy" {
                answer.premises.push(leaf(track.id.0, &["transitions"]));
            }
            if ripple {
                answer.premises.push(leaf(track.id.0, &["~clipOrder"]));
            }
            for clip in &track.items {
                if selected.contains(&clip.id) && (copy || !track.locked) {
                    answer.premises.push(Premise::on(json!(clip.id.0)));
                } else if selected.contains(&clip.id) {
                    answer.premises.push(leaf(clip.id.0, &[]));
                } else if ripple {
                    let assigned = !track.locked && (member || track.sync_lock) && first.is_some_and(|first| clip.start >= first);
                    answer.premises.push(leaf(clip.id.0, if assigned { &["start", "~assignedStart"] } else { &[] }).positions(["start", "duration"]));
                }
            }
        }
    }
    Some(answer)
}

fn paste_inputs(session: &Session, insert: bool, answer: &mut Under) {
    let Some(q) = session.active_sequence() else { return };
    let Some(seq) = session.state.active_sequence else { return };
    answer.premises.push(leaf(seq.0, &["sequence.settings.settings.frame_rate", "~videoTrackOrder", "~audioTrackOrder"]));
    if session.state.copy_paste_sequence_markers || insert && session.state.ripple_sequence_markers {
        answer.premises.push(leaf(seq.0, &["sequence.markers"]));
    }
    let rate = q.settings.frame_rate;
    let resnap = session.state.clipboard_rate.is_some_and(|copied| copied != rate);
    let mut destinations = std::collections::BTreeSet::new();
    let mut length = 0i64;
    for (kind, index, clip) in &session.state.clipboard {
        answer.premises.push(leaf(clip.item.0, &[]));
        if let Some(track) = q.tracks(*kind).get(*index) {
            destinations.insert(track.id);
        }
        let end = if resnap { rate.snap_nearest(clip.end()).0 } else { clip.end().0 };
        length = length.max(end);
    }
    let at = session.playhead().0;
    for track in q.all_tracks() {
        let member = destinations.contains(&track.id);
        if !member && !insert {
            continue;
        }
        answer.premises.push(leaf(track.id.0, if insert { &["props.locked", "props.sync_lock"] } else { &["props.locked"] }));
        if !member && (track.locked || !track.sync_lock) {
            continue;
        }
        let end = if insert { i64::MAX } else { at.saturating_add(length) };
        let from = track.items.partition_point(|clip| clip.end().0 <= at);
        let to = track.items.partition_point(|clip| clip.start.0 < end).max(from);
        answer.within.push(Within {
            parent: json!(track.id.0),
            field: "clips".into(),
            from,
            to,
            time: Some(TimeSpan {
                from: json!(at.to_string()),
                to: json!(end.to_string()),
                start: "start".into(),
                duration: Some("duration".into()),
                ..Default::default()
            }),
        });
        answer.premises.push(leaf(track.id.0, &["transitions"]));
        for clip in track.items.get(from..to).into_iter().flatten() {
            if !insert || clip.start.0 < at {
                answer.premises.push(Premise::on(json!(clip.id.0)));
            } else {
                answer.premises.push(leaf(clip.id.0, &["start", "~assignedStart"]).positions(["start"]));
            }
        }
    }
    if insert {
        answer.premises.push(leaf(seq.0, &["sequence.captionTracks"]));
    }
}
