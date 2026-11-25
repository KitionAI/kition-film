//! commands.rs:1945-2136; sequence_tools.rs:902-930;
//! source_monitor.rs:115-217; clip_ops.rs:473-514.
//! Re-read for markers.edit's `time` (a sequence marker moved along the ruler): the
//! marker's new start is checked against its duration (its end must stay in range) and
//! the markers are kept in time order, so the whole marker is held, as for a new
//! duration; the Source route refuses `time` before reading anything.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, ItemKind};
use kition_film_kit::FilmDocument;
use kition_film_time::Tick;
use kition_kit::{KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("markers.markClip", "point"),
    ("markers.markSelection", "selection"),
    ("markers.add", "program"),
    ("markers.clearCurrent", "program"),
    ("markers.clearAll", "program"),
    ("markers.edit", "program"),
    ("markers.addRange", "point"),
    ("markers.addRangeInOut", "marked range"),
    ("markers.addChapter", "point"),
    ("markers.addFlashCue", "point"),
    ("markers.goNext", "target=source"),
    ("markers.goPrev", "target=source"),
    ("markers.add", "target=source"),
    ("markers.edit", "target=source"),
    ("markers.clearCurrent", "target=source"),
    ("markers.clearAll", "target=source"),
    ("timeline.setTargeting", "target"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0x95526b4360647be4
        && hash(include_str!("../../../../crates/engine/engine/src/sequence_tools.rs")) == 0x9c4a17d3fd68bdd4
        && hash(include_str!("../../../../crates/engine/engine/src/source_monitor.rs")) == 0x6614750c7a2b14fe
        && hash(include_str!("../../../../crates/engine/engine/src/clip_ops.rs")) == 0x973a242360050d16
}

pub fn more(command: &str, path: &str) -> Vec<&'static str> {
    if command == "timeline.setTargeting" {
        return vec!["coarse-active-state"];
    }
    if path == "target=source" {
        let mut out = vec!["source-only-part", "coarse-active-state", "coarse-mode-state", "coarse-time-state", "coarse-source-route"];
        if command != "markers.add" {
            out.push("whole-source-marker-list");
        }
        return out;
    }
    if matches!(command, "markers.clearCurrent" | "markers.clearAll") {
        return vec!["coarse-time-state", "coarse-mode-state", "coarse-active-state"];
    }
    let mut out = vec!["coarse-time-state", "coarse-mode-state", "coarse-active-state"];
    if command == "markers.markSelection" {
        out.extend(["coarse-selection-state", "unconsumed-program-material"]);
    } else if command == "markers.markClip" {
        out.push("unconsumed-program-material");
    } else if command == "markers.edit" {
        out.extend(["whole-duration-marker", "whole-moved-marker"]);
    }
    out
}

#[test]
fn private_source_tick_facts_keep_exact_values_and_honor_requested_names() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let source = doc.execute("file.newColorMatte", json!({"seconds":60_000})).unwrap()["item"].as_u64().unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let duration = project.item(ItemId(source)).unwrap().as_media().unwrap().duration().0;
    assert!(duration > 9_007_199_254_740_992);
    for id in [json!(source), json!(source.to_string())] {
        let facts = doc.derived(&[id], &["sourceEnd".into()]).unwrap();
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].id, source);
        assert_eq!(facts[0].values, serde_json::Map::from_iter([("sourceEnd".into(), json!(duration.to_string()))]));
    }
}

fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}

#[test]
fn program_marker_writes_compare_times_ranges_presence_and_assignment_inputs() {
    const SECOND: i64 = 254_016_000_000;
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newColorMatte", json!({"seconds":4})).unwrap()["item"].clone();
    let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
    let marker = doc.execute("markers.add", json!({"time":SECOND})).unwrap()["marker"].as_u64().unwrap();
    doc.execute("markers.markIn", json!({"time":0})).unwrap();
    doc.execute("markers.markOut", json!({"time":2*SECOND})).unwrap();
    doc.execute("timeline.select", json!({"clips":[clip]})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let q = project.sequence(ItemId(sequence)).unwrap();
    for &(command, path) in PATHS.iter().filter(|(_, path)| *path != "target=source" && *path != "target") {
        assert!(compared_path(command, path));
        for time in [0, SECOND, 5 * SECOND] {
            doc.execute("playhead.set", json!({"time":time})).unwrap();
            let at = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
            for params in [json!({}), json!({"time":0}), json!({"frame":12}), json!({"seconds":1.5}), json!({"timecode":"00:00:01:00"})] {
                for patch in [
                    json!({}),
                    json!({"name":"Assigned","comment":"Text","color":"red"}),
                    json!({"durationFrames":12}),
                    json!({"durationSeconds":0.5}),
                    json!({"duration":SECOND}),
                ] {
                    let mut p = params.clone();
                    p.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
                    p["marker"] = json!(marker);
                    let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                    p.as_object_mut().unwrap().retain(|key, _| spec.schema.as_ref().is_some_and(|schema| schema.get(key).is_some()));
                    let mut want = Under::default();
                    let add = matches!(command, "markers.add" | "markers.addRange" | "markers.addChapter" | "markers.addFlashCue");
                    if !matches!(command, "markers.clearCurrent" | "markers.clearAll" | "markers.edit") {
                        let start = if command == "markers.addRangeInOut" {
                            0
                        } else if add {
                            if p.get("time").is_some() {
                                0
                            } else if p.get("frame").is_some() {
                                q.settings.frame_rate.tick_of(12).0
                            } else if p.get("seconds").is_some() {
                                q.settings.frame_rate.snap(Tick::from_seconds_f64(1.5)).0
                            } else if p.get("timecode").is_some() {
                                q.settings.frame_rate.tick_of(24).0
                            } else {
                                at
                            }
                        } else {
                            at
                        };
                        let end = if command == "markers.addRangeInOut" { 2 * SECOND + q.settings.frame_rate.frame_duration().0 } else { start };
                        for track in q.all_tracks() {
                            let from = track.items.iter().take_while(|clip| clip.end().0 <= start).count();
                            let to = track.items.iter().take_while(|clip| clip.start.0 < end.max(start + 1)).count().max(from);
                            for clip in &track.items[from..to] {
                                want.objects.push(json!(clip.id.0));
                                if add || command == "markers.addRangeInOut" {
                                    want.premises.push(Premise::on(json!(clip.id.0)).positions(["start", "clipId"]));
                                }
                            }
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
                        }
                    }
                    let duration = matches!(command, "markers.add" | "markers.addRange" | "markers.edit")
                        && !(command == "markers.addRange" && p.get("duration").is_some())
                        && (p.get("durationFrames").is_some() || p.get("durationSeconds").is_some());
                    let converted = add && (p.get("frame").is_some() || p.get("timecode").is_some() || p.get("seconds").is_some());
                    if duration || converted || command == "markers.addRange" && p.get("duration").is_none() {
                        let mut fields = vec!["sequence.settings.settings.frame_rate"];
                        if add && p.get("timecode").is_some() {
                            fields.push("sequence.settings.settings.drop_frame");
                        }
                        want.premises.push(leaf(sequence, fields));
                    }
                    match command {
                        "markers.markClip" | "markers.markSelection" => {
                            want.premises
                                .push(leaf(sequence, ["sequence.settings.mark_in", "sequence.settings.mark_out", "sequence.settings.settings.frame_rate"]));
                            if command == "markers.markClip" {
                                want.premises.push(leaf(sequence, ["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
                            }
                            if command == "markers.markSelection" || at < q.video_tracks[0].items[0].end().0 {
                                want.premises.push(Premise::on(json!(clip)).fields(Vec::<String>::new()).positions(["start", "duration"]));
                            }
                        }
                        "markers.addChapter" | "markers.addFlashCue" if p.get("name").is_none() => want.premises.push(leaf(sequence, ["sequence.markers"])),
                        "markers.clearCurrent" => want.premises.push(leaf(sequence, [format!("sequence.markers[start={at}]")])),
                        "markers.clearAll" => want.premises.push(leaf(sequence, ["sequence.markers"])),
                        "markers.edit" => {
                            let prefix = format!("sequence.markers[id={marker}]");
                            let moved = p.get("time").is_some();
                            let mut fields: Vec<_> = if duration || moved {
                                vec![prefix.clone()]
                            } else {
                                ["name", "comment", "color"].iter().filter(|key| p.get(**key).is_some()).map(|key| format!("{prefix}.{key}")).collect()
                            };
                            if fields.is_empty() {
                                fields.push(format!("{prefix}.id"));
                            }
                            want.premises.push(leaf(sequence, fields));
                        }
                        "markers.addRangeInOut" => want.premises.push(leaf(
                            sequence,
                            ["sequence.settings.mark_in", "sequence.settings.mark_out", "sequence.settings.settings.frame_rate", "~markedMaterial"],
                        )),
                        _ => {}
                    }
                    assert!(spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty());
                    assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                    assert_eq!(normalized(doc.under(command, &p).unwrap().unwrap()), normalized(want), "{command}/{p}/time={time}");
                }
            }
        }
    }
}

#[test]
fn source_marker_writes_compare_parent_routes_filtered_destinations_and_duration_bounds() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let media = doc.execute("file.newColorMatte", json!({"seconds":4})).unwrap()["item"].as_u64().unwrap();
    doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap();
    let mut sources = vec![sequence, media];
    for restrict in [false, true] {
        sources.push(
            doc.execute("clip.makeSubclip", json!({"item":media,"start":10_584_000_000i64,"end":508_032_000_000i64,"restrictTrims":restrict})).unwrap()["item"]
                .as_u64()
                .unwrap(),
        );
    }
    for source in sources {
        doc.execute("source.open", json!({"item":source})).unwrap();
        let marker = doc.execute("markers.add", json!({"target":"source","time":254_016_000_000i64})).unwrap()["marker"].as_u64().unwrap();
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let root = if source == sequence { sequence } else { media };
        let path = if root == sequence { "sequence.markers" } else { "markers" };
        for &(command, blind_path) in PATHS.iter().filter(|(_, path)| *path == "target=source") {
            assert!(compared_path(command, blind_path));
            for time in [0, 254_016_000_000i64, 762_048_000_000i64] {
                doc.execute("source.setPlayhead", json!({"time":time})).unwrap();
                let cursor = doc.editor_state()["time"]["source"].as_i64().unwrap();
                for patch in [
                    json!({}),
                    json!({"name":"Assigned"}),
                    json!({"durationFrames":12}),
                    json!({"name":"Assigned","comment":"Text","color":"red","durationFrames":12}),
                ] {
                    let mut p = patch;
                    p["target"] = json!("source");
                    p["marker"] = json!(marker);
                    p["time"] = json!(254_016_000_000i64);
                    let mut want = Under::default();
                    let mut route = vec![source];
                    if source != root {
                        route.push(root);
                    }
                    if command != "markers.add" || p.get("durationFrames").is_some() {
                        for &id in &route {
                            want.premises.push(leaf(id, ["kind", "props.parent"]));
                        }
                    }
                    if p.get("durationFrames").is_some() && matches!(command, "markers.add" | "markers.edit") {
                        want.premises
                            .push(leaf(root, [if root == sequence { "sequence.settings.settings.frame_rate" } else { "props.media.info.video.frame_rate" }]));
                    }
                    if command != "markers.add" {
                        let fields = if command == "markers.edit" {
                            let prefix = format!("{path}[id={marker}]");
                            let mut fields = vec![format!("{prefix}.id")];
                            fields.extend(["name", "comment", "color"].iter().filter(|key| p.get(**key).is_some()).map(|key| format!("{prefix}.{key}")));
                            if p.get("durationFrames").is_some() {
                                fields.extend([format!("{prefix}.start"), format!("{prefix}.duration")]);
                            }
                            fields
                        } else {
                            vec![path.to_owned()]
                        };
                        want.premises.push(leaf(root, fields));
                    }
                    if matches!(command, "markers.goNext" | "markers.goPrev" | "markers.add" | "markers.edit") {
                        let mut fields = vec!["~sourceMedia"];
                        let navigation = matches!(command, "markers.goNext" | "markers.goPrev");
                        if navigation {
                            fields.push("~sourceMarkerStarts");
                        }
                        let destination = if navigation {
                            let range = if let ItemKind::Subclip { range, .. } = &project.item(ItemId(source)).unwrap().kind { Some(*range) } else { None };
                            let markers = if root == sequence {
                                &project.sequence(ItemId(root)).unwrap().markers
                            } else {
                                &project.item(ItemId(root)).unwrap().as_media().unwrap().markers
                            };
                            markers.iter().any(|marker| {
                                range.is_none_or(|range| marker.start >= range.start && marker.start < range.end())
                                    && if command == "markers.goNext" { marker.start.0 > cursor } else { marker.start.0 < cursor }
                            })
                        } else {
                            false
                        };
                        if destination || command == "markers.add" || command == "markers.edit" && p.get("durationFrames").is_some() {
                            fields.extend(["~sourceStart", "~sourceEnd"]);
                            if destination || p.get("durationFrames").is_some() {
                                fields.push("~sourceRate");
                            }
                        }
                        want.premises.push(leaf(source, fields));
                    }
                    assert_eq!(normalized(doc.under(command, &p).unwrap().unwrap()), normalized(want), "{command}/{p}/source={source}/time={time}");
                }
            }
        }
    }
}
