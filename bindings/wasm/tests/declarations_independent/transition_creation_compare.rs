//! commands.rs:3750-3835; edit/lib.rs:930-942. Applying a transition
//! resolves a cut, converts its duration, checks a lock and replaces overlaps.
//! Re-reviewed at 451e643e's apply_transition: `align` places it on the cut and
//! its length is kept inside the clips it joins (the outgoing clip's start to the
//! incoming clip's end), both read from the clip and neighbour held whole here;
//! the declaration does not depend on `align`.
use super::sync_compare::normalized;
use kition_film_engine::project::{ClipId, ItemId, Project, TrackKind};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};
pub const PATHS: &[(&str, &str)] =
    &[("sequence.applyVideoTransition", "transition-cut"), ("sequence.applyAudioTransition", "transition-cut"), ("effect.apply", "transition")];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(_: &str) -> Vec<&'static str> {
    vec!["coarse-active-state", "coarse-mode-state", "whole-transition-candidates", "whole-transition-list"]
}
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn window(track: &kition_film_engine::project::Track, start: i64, end: i64, want: &mut Under) {
    let from = track.items.iter().take_while(|c| c.end().0 <= start).count();
    let to = track.items.iter().take_while(|c| c.start.0 < end).count().max(from);
    want.within.push(Within {
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
    for clip in &track.items[from..to] {
        want.premises.push(leaf(clip.id.0, &[]).positions(["start", "duration"]));
    }
}
fn expected(project: &Project, seq: u64, kind: TrackKind, at: i64, p: &Value) -> Under {
    let q = project.sequence(ItemId(seq)).unwrap();
    let mut want = Under { premises: vec![leaf(seq, &["sequence.settings.settings.frame_rate"])], ..Default::default() };
    let named = p["clip"].as_u64().or_else(|| p["clips"].as_array().and_then(|a| a.first()).and_then(Value::as_u64));
    let mut point = None;
    let mut scanned = Vec::new();
    for track in q.tracks(kind) {
        if named.is_none() {
            scanned.push(track.id.0);
            let radius = q.settings.frame_rate.tick_of(3).0;
            window(track, at.saturating_sub(radius), at.saturating_add(radius).saturating_add(1), &mut want);
        }
        for (index, clip) in track.items.iter().enumerate() {
            if named.is_some_and(|id| id != clip.id.0) {
                continue;
            }
            let radius = q.settings.frame_rate.tick_of(3).0;
            if named.is_none() && ![(clip.start.0 - at).abs(), (clip.end().0 - at).abs()].into_iter().any(|distance| distance < radius) {
                continue;
            }
            let input = p["edge"].as_str().map_or((at - clip.start.0).abs() <= (at - clip.end().0).abs(), |edge| edge == "in");
            let neighbour = if input {
                index.checked_sub(1).and_then(|i| track.items.get(i)).filter(|c| c.end() == clip.start)
            } else {
                track.items.get(index + 1).filter(|c| c.start == clip.end())
            };
            point = Some((track, clip, neighbour, if input { clip.start.0 } else { clip.end().0 }));
            break;
        }
        if point.is_some() {
            break;
        }
    }
    if named.is_none() {
        // commands.rs:3791-3814: of the lane order the scan reads only which lanes come before
        // the cut's lane (their windows are held above); time5 `transition-cut` requires an empty
        // lane added or removed above to apply. With no cut, the whole order.
        let order = if kind == TrackKind::Video { "~videoTrackOrder" } else { "~audioTrackOrder" };
        if point.is_some() {
            want.content.push(kition_kit::ContentPremise {
                id: json!(seq),
                field: order.into(),
                region: json!({"transitionScan":{"kind":if kind == TrackKind::Video {"video"} else {"audio"},"scanned":scanned,"at":at,"radius":q.settings.frame_rate.tick_of(3).0}}),
            });
        } else {
            want.premises.push(leaf(seq, &[order]));
        }
    }
    if let Some((track, clip, neighbour, cut)) = point {
        want.premises.push(Premise::on(json!(clip.id.0)));
        if let Some(neighbour) = neighbour {
            want.premises.push(Premise::on(json!(neighbour.id.0)));
        }
        want.premises.push(leaf(track.id.0, &["props.locked", "transitions"]));
        let start = cut.saturating_sub(1).max(0);
        window(track, start, start.saturating_add(2), &mut want);
        want.objects.extend(track.items.iter().filter(|clip| clip.start.0 < start + 2 && clip.end().0 > start).map(|clip| json!(clip.id.0)));
    }
    want
}
#[test]
fn transition_creation_compares_explicit_and_implicit_cuts_edges_kinds_locks_and_duration_timebases() {
    let mut doc = FilmDocument::create("Transition.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("item.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
    let clips = doc.execute("timeline.place", json!({"item":item,"track":"V1","audioTrack":"A1","time":0})).unwrap()["clips"].as_array().unwrap().clone();
    let first = clips.iter().filter_map(Value::as_u64).collect::<Vec<_>>();
    for id in &first {
        doc.execute("timeline.razor", json!({"clip":id,"time":254_016_000_000i64})).unwrap();
    }
    for locked in [false, true] {
        doc.execute("timeline.setTrack", json!({"track":"V1","locked":locked})).unwrap();
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        for time in [0, 254_016_000_000i64, 762_048_000_000] {
            // lib.rs:1233 snaps the playhead to a frame and commands.rs:3784
            // searches from that snapped time, not from the requested one.
            let at = doc.execute("playhead.set", json!({"time":time})).unwrap()["time"].as_i64().unwrap();
            for &(command, _) in PATHS {
                for kind in [TrackKind::Video, TrackKind::Audio] {
                    if command == "sequence.applyVideoTransition" && kind != TrackKind::Video
                        || command == "sequence.applyAudioTransition" && kind != TrackKind::Audio
                    {
                        continue;
                    }
                    let id = first
                        .iter()
                        .find(|id| {
                            project
                                .sequence(ItemId(seq))
                                .unwrap()
                                .find_item(ClipId(**id))
                                .and_then(|(t, _)| project.sequence(ItemId(seq)).unwrap().track(t))
                                .unwrap()
                                .kind
                                == kind
                        })
                        .unwrap();
                    for explicit in [false, true] {
                        for (edge, align) in
                            [None, Some("in"), Some("out")].into_iter().flat_map(|edge| [None, Some("start"), Some("end")].map(|align| (edge, align)))
                        {
                            let mut p = json!({"frames":6,"effect":if kind==TrackKind::Video{"cross_dissolve"}else{"constant_power"}});
                            if explicit {
                                p[if command == "effect.apply" { "clips" } else { "clip" }] = if command == "effect.apply" { json!([id]) } else { json!(id) };
                            }
                            if let Some(edge) = edge {
                                p["edge"] = json!(edge);
                            }
                            // effect.apply takes no alignment
                            if let Some(align) = align.filter(|_| command != "effect.apply") {
                                p["align"] = json!(align);
                            }
                            assert_eq!(
                                normalized(doc.under(command, &p).unwrap().unwrap_or_default()),
                                normalized(expected(&project, seq, kind, at, &p)),
                                "{command}/{p}/{at}/{locked}"
                            );
                        }
                    }
                }
            }
        }
    }
}
