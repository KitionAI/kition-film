//! Inputs discovered by independent range, transition and named-move review.
use kition_film_engine::{Session, commands, project::TrackKind};
use kition_kit::{Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
pub fn complete(session: &Session, command: &str, params: &Value, under: Option<Under>) -> Option<Under> {
    let range = matches!(command, "sequence.lift" | "sequence.extract");
    let gap = command == "sequence.closeGap";
    let movement = command == "timeline.move";
    let transition_kind = match command {
        "sequence.applyVideoTransition" => Some(TrackKind::Video),
        "sequence.applyAudioTransition" => Some(TrackKind::Audio),
        "effects.apply" => params
            .get("effect")
            .and_then(Value::as_str)
            .and_then(|name| {
                kition_film_engine::project::find_effect(name)
                    .or_else(|| kition_film_engine::project::effect_defs().iter().find(|effect| effect.name.eq_ignore_ascii_case(name)))
            })
            .and_then(|effect| match effect.kind {
                kition_film_engine::project::EffectKind::VideoTransition => Some(TrackKind::Video),
                kition_film_engine::project::EffectKind::AudioTransition => Some(TrackKind::Audio),
                _ => None,
            }),
        _ => None,
    };
    if !(range || gap || movement || transition_kind.is_some()) {
        return under;
    }
    let Some(q) = session.active_sequence() else { return under };
    let Some(sequence) = session.state.active_sequence else { return under };
    let mut answer = under.unwrap_or_default();
    if command == "effects.apply" && transition_kind.is_some() {
        answer = Under::default();
    }
    if range {
        if command == "sequence.extract" {
            // commands.rs sequence.extract clears the sequence's split marks.
            answer.premises.push(leaf(sequence.0, &["sequence.settings.split"]));
            // It also ripples the program markers when that mode is on.
            if session.state.ripple_sequence_markers {
                answer.premises.push(leaf(sequence.0, &["sequence.markers"]));
            }
        }
        if let Some((_, _, tracks)) = session.marked_range(command == "sequence.extract") {
            // Lift and Extract remove or shift the transitions of the lanes they act on
            // (edit/src/lib.rs:318-340). A lane with neither clips nor transitions has none to
            // change: its transitions are not read (a colleague's new empty lane is no input).
            answer.premises.extend(
                tracks
                    .into_iter()
                    .filter(|id| q.track(*id).is_some_and(|track| !track.items.is_empty() || !track.transitions.is_empty()))
                    .map(|track| leaf(track.0, &["transitions"])),
            );
        }
    }
    if gap {
        // Every lane's edges are held whole below; the place window at the time
        // repeats a part of the named lane's edges.
        answer.within.clear();
        answer.premises.push(leaf(sequence.0, &["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
        if params.get("frame").is_some() {
            answer.premises.push(leaf(sequence.0, &["sequence.settings.settings.frame_rate"]));
        }
        for track in q.all_tracks() {
            answer.premises.push(leaf(track.id.0, &["props.locked", "props.sync_lock", "~editEdges", "transitions"]));
        }
        if session.state.ripple_sequence_markers {
            answer.premises.push(leaf(sequence.0, &["sequence.markers"]));
        }
    }
    if movement {
        for item in params.get("moves").and_then(Value::as_array).into_iter().flatten() {
            if let Some((owner, _)) = commands::clip_p(item, "clip").and_then(|id| q.find_item(id)) {
                answer.premises.push(leaf(owner.0, &["props.kind"]));
            }
            if let Some(track) = super::rests_sequences::track_id(session, item.get("track")) {
                let mut need = leaf(track.0, &["props.kind"]);
                if let Some(name) = item.get("track").and_then(Value::as_str) {
                    let field = match name.as_bytes().first() {
                        Some(b'V' | b'v') => Some("sequence.videoTracks"),
                        Some(b'A' | b'a') => Some("sequence.audioTracks"),
                        _ => None,
                    };
                    if let Some(field) = field {
                        need = need.positions([field]);
                    }
                }
                answer.premises.push(need);
            }
        }
    }
    if let Some(kind) = transition_kind {
        answer.premises.push(leaf(sequence.0, &["sequence.settings.settings.frame_rate"]));
        let named = commands::clip_p(params, "clip").or_else(|| {
            if command == "effects.apply" {
                params.get("clips").and_then(Value::as_array).and_then(|ids| ids.first()).and_then(Value::as_u64).map(kition_film_engine::project::ClipId)
            } else {
                None
            }
        });
        let mut p = params.clone();
        if let Some(id) = named {
            p["clip"] = json!(id.0);
        }
        let delegate = if kind == TrackKind::Video { "sequence.applyVideoTransition" } else { "sequence.applyAudioTransition" };
        let resolved = session.premises(delegate, &p);
        let owners = resolved.iter().filter_map(|need| q.all_tracks().find(|track| track.id.0 == need.id).map(|track| track.id)).collect::<Vec<_>>();
        if named.is_none() {
            let at = session.playhead().0;
            let radius = q.settings.frame_rate.tick_of(3).0;
            // commands.rs transition_point stops at the first targeted track with a
            // cut, so later tracks cannot change the result while that one holds.
            let mut reached = false;
            let mut scanned = Vec::new();
            for track in q.tracks(kind).iter().filter(|track| session.targeting().targeted.contains(&track.id)) {
                if reached {
                    break;
                }
                reached = owners.contains(&track.id);
                scanned.push(track.id.0);
                let start = at.saturating_sub(radius);
                let end = at.saturating_add(radius).saturating_add(1);
                let from = track.items.iter().take_while(|clip| clip.start.0.saturating_add(clip.duration.0) <= start).count();
                let to = track.items.iter().take_while(|clip| clip.start.0 < end).count().max(from);
                answer.within.push(Within {
                    parent: json!(track.id.0),
                    field: "clips".into(),
                    from,
                    to,
                    time: Some(TimeSpan {
                        from: json!(start.to_string()),
                        to: json!(end.to_string()),
                        start: "start".into(),
                        duration: Some("duration".into()),
                        ..Default::default()
                    }),
                });
                for clip in track.items.get(from..to).into_iter().flatten() {
                    answer.premises.push(leaf(clip.id.0, &[]).positions(["start", "duration"]));
                }
            }
            // The scanned lanes' windows are held above. Of the lane order, the scan reads only
            // whether a lane it did not scan now comes before the cut's lane with a cut of its
            // own near the time ([`scan_order_changed`]): an empty lane added or removed is none.
            let order = if kind == TrackKind::Video { "~videoTrackOrder" } else { "~audioTrackOrder" };
            if reached {
                answer.content.push(kition_kit::ContentPremise {
                    id: json!(sequence.0),
                    field: order.into(),
                    region: json!({"transitionScan":{"kind":if kind == TrackKind::Video {"video"} else {"audio"},"scanned":scanned,"at":at,"radius":radius}}),
                });
            } else {
                answer.premises.push(leaf(sequence.0, &[order]));
            }
        }
        answer.premises.extend(resolved.into_iter().map(|need| Premise {
            id: json!(need.id),
            fields: need.fields,
            positions: need.positions,
            ..Default::default()
        }));
        answer.premises.extend(owners.into_iter().map(|id| leaf(id.0, &["transitions"])));
        // A named clip skips the binding's place lookup, yet the cut's neighbourhood
        // decides which sides the transition joins (commands.rs transition_point).
        if (command == "effects.apply" || named.is_some())
            && let Ok(Some(found)) = session.under(delegate, &p)
        {
            answer.objects.extend(found.clips.into_iter().map(|id| json!(id.0)));
            answer.within.extend(found.windows.into_iter().map(|w| Within {
                parent: json!(w.track.0),
                field: "clips".into(),
                from: w.from,
                to: w.to,
                time: Some(TimeSpan {
                    from: json!(w.at.0.to_string()),
                    to: json!(w.at.0.saturating_add(w.span.0).to_string()),
                    start: "start".into(),
                    duration: Some("duration".into()),
                    ..Default::default()
                }),
            }));
        }
        // Keep declaration order stable: search windows precede the chosen cut.
        if command != "effects.apply" && answer.within.len() > 1 {
            answer.within.rotate_left(1);
        }
    }
    Some(answer)
}

/// Whether the cut Apply Transition's scan finds changed through the lane order
/// (`region.transitionScan`, see [`complete`]): the scanned lanes' windows are held by
/// themselves, so only a targeted lane it did not scan, now before the cut's lane, with a clip
/// edge within the radius of the time, or the cut's lane gone, changes it.
pub fn scan_order_changed(session: &Session, region: &Value) -> Option<bool> {
    let scan = region.get("transitionScan")?;
    let kind = if scan.get("kind")?.as_str()? == "video" { TrackKind::Video } else { TrackKind::Audio };
    let scanned: Vec<u64> = scan.get("scanned")?.as_array()?.iter().filter_map(Value::as_u64).collect();
    let owner = *scanned.last()?;
    let at = scan.get("at")?.as_i64()?;
    let radius = scan.get("radius")?.as_i64()?;
    let q = session.active_sequence()?;
    let targeted = session.targeting().targeted;
    let near = |time: i64| time.saturating_sub(at).saturating_abs() < radius;
    for track in q.tracks(kind).iter().filter(|track| targeted.contains(&track.id)) {
        if track.id.0 == owner {
            return Some(false);
        }
        if !scanned.contains(&track.id.0) && track.items.iter().any(|clip| near(clip.start.0) || near(clip.start.0.saturating_add(clip.duration.0))) {
            return Some(true);
        }
    }
    Some(true)
}
