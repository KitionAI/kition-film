//! commands.rs:733-887,2222-2326; project_tools.rs:1113-1260.
//! Placement consumes source profiles and a destination layout, including free
//! lane searches, stream expansion, overwritten material and insert suffixes.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_film_time::Tick;
use kition_kit::{KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("source.insert", "source-placement"),
    ("source.overwrite", "source-placement"),
    ("timeline.place", "named/default"),
    ("timeline.place", "auto-track"),
    ("clip.automateToSequence", "sequentially insert/overwrite"),
    ("clip.automateToSequence", "unnumberedMarkers insert/overwrite"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(_: &str) -> Vec<&'static str> {
    vec![
        "coarse-active-state",
        "coarse-mode-state",
        "whole-placement-source-profile",
        "whole-placement-destination-transitions",
        "whole-placement-insert-suffix",
    ]
}
fn leaf(id: Value, fields: &[&str]) -> Premise {
    Premise::on(id).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn source(project: &Project, id: ItemId, explicit_length: bool, want: &mut Under) {
    let mut next = Some(id);
    let mut seen = std::collections::BTreeSet::new();
    want.premises.push(leaf(json!(id.0), &["name", "props.common.label", "props.common.split", "~sourceGraphic"]));
    while let Some(id) = next.filter(|id| seen.insert(*id)) {
        let item = project.item(id).unwrap();
        next = None;
        let mut fields = vec!["kind"];
        match &item.kind {
            ItemKind::Media(_) => fields.extend([
                "props.media.mark_in",
                "props.media.mark_out",
                "props.media.info.kind",
                "props.media.info.duration",
                "props.media.info.video",
                "props.media.info.audio_streams",
                "props.media.interpret",
            ]),
            ItemKind::Subclip { parent, .. } => {
                fields.extend(["props.parent", "props.range"]);
                next = Some(*parent);
            }
            ItemKind::Sequence(_) => {
                fields.extend([
                    "sequence.settings.mark_in",
                    "sequence.settings.mark_out",
                    "sequence.settings.settings",
                    "sequence.settings.multicam",
                    "~sourceHasAudio",
                ]);
                if !explicit_length {
                    fields.push("sequence.duration");
                }
            }
            _ => fields.extend(["props.width", "props.height", "props.rate", "props.duration"]),
        }
        want.premises.push(leaf(json!(id.0), &fields));
    }
}
fn window(track: &kition_film_engine::project::Track, start: i64, end: i64, want: &mut Under) {
    let from = track.items.iter().take_while(|clip| clip.end().0 <= start).count();
    let to = track.items.iter().take_while(|clip| clip.start.0 < end).count().max(from);
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
        want.objects.push(json!(clip.id.0));
        want.premises.push(Premise::on(json!(clip.id.0)).positions(["start", "clipId"]));
    }
}
fn expected(project: &Project, seq: u64, command: &str, p: &Value, source_id: u64, marked: bool) -> Under {
    let q = project.sequence(ItemId(seq)).unwrap();
    let automated = command == "clip.automateToSequence";
    let source_command = command.starts_with("source.");
    let insert = command == "source.insert" || p["insert"] == true || automated && p["method"] != "overwrite";
    let mut want = Under::default();
    want.premises.push(leaf(json!(seq), &["sequence.settings.settings.frame_rate", "sequence.settings.settings.width", "sequence.settings.settings.height"]));
    if source_command {
        want.premises.push(leaf(json!(seq), &["sequence.settings.mark_in"]));
    }
    if insert && marked {
        want.premises.push(leaf(json!(seq), &["sequence.markers"]));
    }
    if automated {
        // project_tools.rs:1251-1258: default transitions only at a sequential layout's cuts.
        if p["placement"] != "unnumberedMarkers" && (p["videoTransition"] != false || p["audioTransition"] != false) {
            want.premises.push(leaf(
                json!("project"),
                &["settings.default_video_transition", "settings.default_audio_transition", "settings.default_transition_duration_frames"],
            ));
        }
        if p["placement"] == "unnumberedMarkers" {
            want.premises.push(leaf(json!(seq), &["sequence.markers"]));
        }
        // project_tools.rs:1134-1138: `sort` reads the bins' order of the items, nothing else of the bins.
        if p["ordering"] != "selection" {
            for id in p["items"].as_array().unwrap() {
                want.premises.push(leaf(id.clone(), &["~projectOrder"]));
            }
        }
    }
    // edit/src/lib.rs:247-266: edit::insert shifts every unlocked sync-locked caption track;
    // Automate's sequential insert overwrites into a gap opened on the clip tracks alone.
    if insert && (!automated || p["placement"] == "unnumberedMarkers") {
        want.premises.push(leaf(json!(seq), &["~captionTrackOrder"]));
        for track in &q.caption_tracks {
            let path = format!("sequence.captionTracks[id={}]", track.id.0);
            let mut fields = vec![format!("{path}.locked"), format!("{path}.syncLock")];
            if !track.locked && track.sync_lock {
                fields.push(format!("sequence.captions[track={}]", track.id.0));
            }
            want.premises.push(Premise::on(json!(seq)).fields(fields).positions(Vec::<String>::new()));
        }
    }
    // snap.rs: the targets are every marker's start (and a range marker's end) and the beats
    // of the enabled audio clips; the tolerance is in frames of the sequence rate.
    let kinds: Vec<&str> = match &p["snap"] {
        Value::String(kind) => vec![kind.as_str()],
        Value::Array(kinds) => kinds.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    if kinds.contains(&"markers") {
        want.premises.push(leaf(json!(seq), &["sequence.markers"]));
    }
    if kinds.contains(&"beats") {
        want.premises.push(leaf(json!(seq), &["~audioTrackOrder"]));
        for track in &q.audio_tracks {
            want.premises.push(leaf(json!(track.id.0), &["props.kind", "~clipOrder"]));
            want.premises.extend(track.items.iter().map(|clip| Premise::on(json!(clip.id.0))));
        }
    }
    let ids = if automated {
        p["items"].as_array().unwrap().iter().filter_map(Value::as_u64).collect::<Vec<_>>()
    } else {
        vec![if source_command { source_id } else { p["item"].as_u64().unwrap() }]
    };
    for id in &ids {
        // commands.rs:2292: an explicit `duration` replaces the source's own length.
        source(project, ItemId(*id), command == "timeline.place" && p["duration"].is_i64(), &mut want);
    }
    let durations = ids.iter().map(|id| q.settings.frame_rate.snap_nearest(project.item(ItemId(*id)).unwrap().duration()).0).collect::<Vec<_>>();
    // Zero overlap and explicit order make the independent automation layout
    // unambiguous. Source durations still need the sequence's frame snapping.
    let starts = if automated && p["placement"] == "unnumberedMarkers" {
        vec![0, q.settings.frame_rate.snap(Tick(2 * kition_film_time::TICKS_PER_SECOND)).0]
    } else if automated {
        vec![0, durations[0]]
    } else {
        let asked = p["time"].as_i64().unwrap_or(0);
        let tolerance = q.settings.frame_rate.tick_of(3).0;
        let landing = if kinds.contains(&"markers") {
            q.markers
                .iter()
                .flat_map(|m| [Some(m.start.0), (m.duration.0 > 0).then(|| m.start.0 + m.duration.0)])
                .flatten()
                .filter(|at| (at - asked).abs() <= tolerance)
                .min_by_key(|at| ((at - asked).abs(), *at))
        } else {
            None
        };
        vec![landing.unwrap_or(asked)]
    };
    let auto = p["track"] == "auto";
    if auto {
        want.premises.push(leaf(json!(seq), &["~videoTrackOrder"]));
    }
    let v = if auto {
        q.video_tracks.iter().find(|t| !t.locked && t.items.iter().all(|c| c.end().0 <= starts[0] || c.start.0 >= starts[0] + durations[0]))
    } else {
        q.video_tracks.first()
    };
    let a = q.audio_tracks.first();
    if p["track"] == "V1" {
        want.premises.push(leaf(json!(v.unwrap().id.0), &[]).positions(["sequence.videoTracks"]));
    }
    if p["audioTrack"] == "A1" {
        want.premises.push(leaf(json!(a.unwrap().id.0), &[]).positions(["sequence.audioTracks"]));
    }
    if auto {
        for track in &q.video_tracks {
            want.premises.push(leaf(json!(track.id.0), &["props.locked", "~editEdges"]));
            if v.is_some_and(|v| v.id == track.id) {
                break;
            }
        }
    }
    let targets = [v, a].into_iter().flatten().map(|t| t.id).collect::<Vec<_>>();
    for track in q.all_tracks() {
        let target = targets.contains(&track.id);
        // edit/src/lib.rs:259-263: an insert's gap changes a lane only where it has material
        // ending after the insert's time.
        let affected = track.items.iter().any(|c| c.end().0 > starts[0]) || track.transitions.iter().any(|t| t.start.0 + t.duration.0 > starts[0]);
        if insert && affected || target {
            want.premises.push(leaf(json!(track.id.0), if insert { &["props.locked", "props.sync_lock"] } else { &["props.locked"] }));
        }
        if target {
            want.premises.push(leaf(json!(track.id.0), &["props.kind", "transitions"]));
        }
        if !track.locked && (target || insert && track.sync_lock) {
            if insert {
                if target {
                    window(track, starts[0], starts[0] + 1, &mut want);
                }
                for clip in track.items.iter().filter(|c| c.start.0 >= starts[0]) {
                    want.premises.push(leaf(json!(clip.id.0), &["start", "~assignedStart"]));
                }
            } else {
                for (at, duration) in starts.iter().zip(&durations) {
                    window(track, *at, at + duration, &mut want);
                }
            }
        }
    }
    want.objects.sort_by_key(Value::as_u64);
    want.objects.dedup();
    want
}
#[test]
fn placements_compare_named_default_auto_source_and_automation_layouts() {
    let mut doc = FilmDocument::create("Placement.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":1})).unwrap()["item"].as_u64().unwrap();
    let sub = doc.execute("clip.makeSubclip", json!({"item":item,"start":0,"end":kition_film_time::TICKS_PER_SECOND})).unwrap()["item"].as_u64().unwrap();
    doc.execute("timeline.place", json!({"item":item,"track":"V1","audioTrack":"A1","seconds":4})).unwrap();
    doc.execute("markers.add", json!({"time":0})).unwrap();
    doc.execute("markers.add", json!({"seconds":2})).unwrap();
    // A sync-locked caption track an insert shifts, and a locked one it does not.
    let shifted = doc.execute("captions.newTrack", json!({"name":"Shifted"})).unwrap()["track"].as_u64().unwrap();
    doc.execute("captions.add", json!({"track":shifted,"seconds":6,"text":"after"})).unwrap();
    let kept = doc.execute("captions.newTrack", json!({"name":"Kept"})).unwrap()["track"].as_u64().unwrap();
    doc.execute("captions.setTrack", json!({"track":kept,"locked":true})).unwrap();
    for marked in [false, true] {
        doc.execute("markers.rippleSequenceMarkers", json!({"on":marked})).unwrap();
        for locked in [false, true] {
            doc.execute("timeline.setTrack", json!({"track":"V1","locked":locked})).unwrap();
            for source_id in [item, sub] {
                doc.execute("source.open", json!({"item":source_id})).unwrap();
                doc.execute("playhead.set", json!({"time":0})).unwrap();
                let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                let q = project.sequence(ItemId(seq)).unwrap();
                let near_marker = q.markers.iter().map(|m| m.start.0).max().unwrap() + q.settings.frame_rate.tick_of(1).0;
                for &(command, path) in PATHS {
                    for insert in [false, true] {
                        let mut variants = Vec::new();
                        if command == "timeline.place" {
                            // `snap` varies where Place lands: none, the markers, or markers and
                            // beats, asked at a marker (0) and a frame past the 2 s marker.
                            for snap in [Value::Null, json!("markers"), json!(["markers", "beats"])] {
                                for time in if snap.is_null() { vec![0] } else { vec![0, near_marker] } {
                                    let mut p =
                                        json!({"item":source_id,"track":if path=="auto-track"{"auto"}else{"V1"},"audioTrack":"A1","time":time,"insert":insert});
                                    if !snap.is_null() {
                                        p["snap"] = snap.clone();
                                    }
                                    variants.push(p);
                                }
                            }
                        } else if command.starts_with("source.") {
                            variants.push(json!({}));
                        } else {
                            // Ordering by the bins or by the list, with and without default transitions.
                            for (ordering, transitions) in [("selection", false), ("sort", false), ("selection", true)] {
                                variants.push(json!({"items":[item,sub],"ordering":ordering,"placement":if path.starts_with("unnumbered"){"unnumberedMarkers"}else{"sequentially"},"method":if insert{"insert"}else{"overwrite"},"overlapFrames":0,"videoTransition":transitions,"audioTransition":transitions}));
                            }
                        }
                        for p in &variants {
                            assert_eq!(
                                normalized(doc.under(command, p).unwrap().unwrap()),
                                normalized(expected(&project, seq, command, p, source_id, marked)),
                                "{command}/{path}/{p}/{locked}/{marked}"
                            );
                        }
                    }
                }
            }
        }
    }
}
