//! commands.rs:1402-1452,3308-3398; edit/lib.rs:230-277,342-445.
//! Clipboard layout is ordinal. Copy consumes the frame rate and optional
//! markers; paste consumes source existence, destination intervals and locks.
use super::{attributes_replace_compare::operands, sync_compare::normalized};
use kition_film_engine::project::{ItemId, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("edit.copy", "copy"),
    ("edit.cut", "copy"),
    ("edit.paste", "clipboard"),
    ("edit.pasteInsert", "clipboard"),
    ("edit.clear", "clips"),
    ("edit.rippleDelete", "clips"),
    ("edit.clear", "captions"),
    ("edit.rippleDelete", "captions"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-mode-state", "coarse-selection-state"];
    if command.contains("aste") {
        out.extend(["whole-paste-boundary-material", "whole-paste-lane-order"]);
    }
    if command.contains("ripple") {
        out.extend(["whole-delete-geometry", "whole-delete-transition-list"]);
    }
    if command == "edit.cut" || command == "edit.clear" {
        out.push("whole-delete-transition-list");
    }
    out
}
fn leaf(id: Value, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(id).fields(fields).positions(Vec::<String>::new())
}
fn expected(project: &Project, sequence: u64, command: &str, selected: &[u64], linked: bool, markers: bool, captions: bool, at: i64) -> Under {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let at = q.settings.frame_rate.snap(kition_film_time::Tick(at)).0;
    let mut want = Under::default();
    if captions {
        want.premises.push(leaf(json!(sequence), ["sequence.captionTracks"]));
        return want;
    }
    let copy = matches!(command, "edit.copy" | "edit.cut");
    let paste = command.contains("paste");
    let ripple = matches!(command, "edit.rippleDelete" | "edit.pasteInsert");
    if paste {
        want.premises.push(leaf(json!(sequence), ["sequence.settings.settings.frame_rate", "~videoTrackOrder", "~audioTrackOrder"]));
        if markers {
            want.premises.push(leaf(json!(sequence), ["sequence.markers"]));
        }
        let copied: Vec<_> = q.all_tracks().flat_map(|track| &track.items).filter(|clip| selected.contains(&clip.id.0)).collect();
        let first = copied.iter().map(|clip| clip.start.0).min().unwrap();
        let last = copied.iter().map(|clip| clip.end().0).max().unwrap();
        for clip in &copied {
            want.premises.push(leaf(json!(clip.item.0), Vec::<String>::new()));
        }
        for track in q.all_tracks() {
            let member = track.items.iter().any(|clip| selected.contains(&clip.id.0));
            if !member && !ripple {
                continue;
            }
            want.premises.push(leaf(json!(track.id.0), if ripple { vec!["props.locked", "props.sync_lock"] } else { vec!["props.locked"] }));
            if !member && (track.locked || !track.sync_lock) {
                continue;
            }
            let end = if ripple { i64::MAX } else { at + last - first };
            let from = track.items.partition_point(|clip| clip.end().0 <= at);
            let to = track.items.partition_point(|clip| clip.start.0 < end).max(from);
            want.within.push(Within {
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
            want.premises.push(leaf(json!(track.id.0), ["transitions"]));
            for clip in &track.items[from..to] {
                if !ripple || clip.start.0 < at {
                    want.premises.push(Premise::on(json!(clip.id.0)));
                } else {
                    want.premises.push(leaf(json!(clip.id.0), ["start", "~assignedStart"]).positions(["start"]));
                }
            }
        }
        if ripple {
            want.premises.push(leaf(json!(sequence), ["sequence.captionTracks"]));
        }
        return want;
    }
    let ids = if paste { selected.to_vec() } else { operands(q, selected, linked, &mut want) };
    let first = q.all_tracks().flat_map(|track| &track.items).filter(|clip| ids.contains(&clip.id.0)).map(|clip| clip.start).min();
    if copy || paste {
        want.premises.push(leaf(json!(sequence), ["sequence.settings.settings.frame_rate"]));
    }
    if markers && command != "edit.clear" {
        want.premises.push(leaf(json!(sequence), ["sequence.markers"]));
    }
    if paste {
        want.premises.push(leaf(json!(sequence), ["~videoTrackOrder", "~audioTrackOrder"]));
    }
    for (tracks, position) in [(&q.video_tracks, "sequence.videoTracks"), (&q.audio_tracks, "sequence.audioTracks")] {
        for track in tracks {
            let member = track.items.iter().any(|clip| ids.contains(&clip.id.0));
            if copy && member {
                want.premises.push(leaf(json!(track.id.0), Vec::<String>::new()).positions([position]));
            }
            if (command != "edit.copy" && member) || ripple {
                want.premises.push(leaf(json!(track.id.0), if ripple { vec!["props.locked", "props.sync_lock"] } else { vec!["props.locked"] }));
            }
            if ripple || paste && member {
                want.premises.push(leaf(json!(track.id.0), ["~clipOrder", "transitions"]));
            } else if matches!(command, "edit.clear" | "edit.cut") && member && !track.locked {
                want.premises.push(leaf(json!(track.id.0), ["transitions"]));
            }
            for clip in &track.items {
                if ids.contains(&clip.id.0) && (copy || !track.locked) {
                    want.premises.push(Premise::on(json!(clip.id.0)));
                } else if ids.contains(&clip.id.0) {
                    want.premises.push(leaf(json!(clip.id.0), Vec::<String>::new()));
                } else if ripple {
                    let assigned = !track.locked && (member || track.sync_lock) && first.is_some_and(|first| clip.start >= first);
                    want.premises
                        .push(leaf(json!(clip.id.0), if assigned { vec!["start", "~assignedStart"] } else { vec![] }).positions(["start", "duration"]));
                }
                if paste && ids.contains(&clip.id.0) {
                    want.premises.push(leaf(json!(clip.item.0), Vec::<String>::new()));
                }
            }
        }
    }
    if command == "edit.pasteInsert" {
        want.premises.push(leaf(json!(sequence), ["sequence.captionTracks"]));
    }
    want
}

#[test]
fn clipboard_paths_compare_links_locks_rates_track_ordinals_captions_and_markers() {
    for linked in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        let source = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
        let clips: Vec<u64> = doc.execute("timeline.place", json!({"item":source,"track":"V1","audioTrack":"A1","time":0})).unwrap()["clips"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_u64)
            .collect();
        doc.execute("timeline.place", json!({"item":source,"track":"V1","audioTrack":"A1","time":1_016_064_000_000i64})).unwrap();
        doc.execute("captions.newTrack", json!({})).unwrap();
        let caption = doc.execute("captions.add", json!({"time":0,"text":"Caption","durationSeconds":1})).unwrap()["caption"].clone();
        doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
        for locked in [false, true] {
            doc.execute("timeline.setTrack", json!({"track":"V1","locked":locked})).unwrap();
            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
            for markers in [false, true] {
                doc.execute("markers.copyPasteIncludesSequenceMarkers", json!({"on":markers})).unwrap();
                doc.execute("markers.rippleSequenceMarkers", json!({"on":markers})).unwrap();
                for selected in [vec![clips[0]], clips.clone()] {
                    doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                    doc.execute("edit.copy", json!({})).unwrap();
                    let copied = if linked { clips.clone() } else { selected.clone() };
                    for &(command, path) in PATHS {
                        if path == "captions" {
                            continue;
                        }
                        assert!(compared_path(command, path));
                        let params = if matches!(command, "edit.clear" | "edit.rippleDelete") { json!({"clips":selected}) } else { json!({}) };
                        for at in [0, 254_016_000_000i64, 1_270_080_000_000i64] {
                            doc.execute("playhead.set", json!({"time":at})).unwrap();
                            assert_eq!(
                                normalized(doc.under(command, &params).unwrap().unwrap_or_default()),
                                normalized(expected(
                                    &project,
                                    sequence,
                                    command,
                                    if command.contains("paste") { &copied } else { &selected },
                                    linked,
                                    markers,
                                    false,
                                    at
                                )),
                                "{command}/{selected:?}/{locked}/{linked}/{markers}/{at}"
                            );
                        }
                    }
                }
            }
            doc.execute("timeline.select", json!({"clips":[],"linked":false})).unwrap();
            doc.execute("captions.select", json!({"captions":[caption]})).unwrap();
            for command in ["edit.clear", "edit.rippleDelete"] {
                assert!(compared_path(command, "captions"));
                assert_eq!(
                    normalized(doc.under(command, &json!({})).unwrap().unwrap_or_default()),
                    normalized(expected(&project, sequence, command, &[], linked, false, true, 0)),
                    "{command}/captions"
                );
            }
        }
    }
}
