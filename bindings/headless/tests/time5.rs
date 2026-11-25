//! C8-time-5: dense time addresses, independently rewritten between observation and write.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_film_project::{ClipId, ItemId};
use kition_kit::KitDocument;
use serde_json::{Value, json};

// C8-film-pin same-field decision: point-insert holds assigned suffix starts
// (commands.rs timeline.place -> edit::insert -> shift_track_from:153-165).
// Later ripple, overwrite, move and speed changes of those starts must refuse changed.
// These expectations precede execution. A = apply, R = relocated, C = changed,
// D = deleted. The columns are CHANGES, in order; no result selects an expectation.
const CHANGES: [&str; 24] = [
    "ripple-insert-before",
    "ripple-delete-before",
    "overwrite-at",
    "move-later",
    "move-earlier",
    "move-track",
    "trim-head-away",
    "trim-tail-away",
    "trim-tail-covered",
    "slip-at",
    "track-insert-above",
    "track-remove-above",
    "track-rename",
    "speed-before",
    "ripple-insert-after",
    "ripple-delete-after",
    "overwrite-after",
    "move-after",
    "trim-after",
    "slip-after",
    "speed-after",
    "bin-edit",
    "metadata-edit",
    "appearance-at",
];
const ROWS: [(&str, &str); 18] = [
    ("clip-id", "AADAAARRRC AAAA AAAAAAA AAA"),
    ("clip-id-local", "AADAAAAAAA AAAAAAAAAAAAAA"),
    ("clip-time", "RRRRRRRRAC RRAR AAAAAAA AAC"),
    ("point-insert", "RRRRRRRRAC RRAR CCRCAAC AAC"),
    ("point-overwrite", "RRRRRRRRAC RRAR AAAAAAA AAC"),
    ("point-automate", "RRRRRRRRAC RAAR AAAAAAA AAC"),
    ("point-marker", "RRRRRRRRAC AAAR AAAAAAA AAC"),
    ("range-lift", "RRRRRAAAAA AAAR AAAAAAA AAA"),
    ("range-extract", "RRRRRAAAAA AAAR AAAAAAA AAA"),
    ("caption-id", "AAAAAAAAAA AAAA AAAAAAA AAA"),
    ("caption-time", "CCAAAAAAAA AAAC AAAAAAA AAA"),
    ("marker-id", "AAAAAAAAAA AAAA AAAAAAA AAA"),
    ("marker-time", "CCAAAAAAAA A A A C A A A A A A A A A A"),
    ("track-id", "AAAAAAAAAA A A C A A A A A A A A A A A"),
    ("track-index", "AAAAAAAAAA R R C A A A A A A A A A A A"),
    ("transition-id", "AADDDDDAAA AAAA AAAAAAA AAA"),
    ("transition-cut", "RRRRRRRRRC AAAR AAAAAAA AAC"),
    ("playhead", "RRRRRRRRAC RRAR AAAAAAA AAC"),
];

fn seed(row: &str) -> Vec<u8> {
    let mut doc = FilmDocument::open(FILE, &project(10)).unwrap();
    if row.starts_with("transition-") {
        let clip = v1(&doc.inspect().unwrap()["sequence"])[4];
        doc.execute("sequence.applyVideoTransition", json!({"clip":clip,"edge":"in","frames":6})).unwrap();
    }
    for t in [1.5, 4.5, 8.5] {
        doc.execute("marker.add", json!({"seconds":t,"name":format!("M{t}")})).unwrap();
        doc.execute("caption.add", json!({"seconds":t-0.5,"durationSeconds":1,"text":format!("C{t}")})).unwrap();
    }
    doc.execute("marker.markIn", json!({"seconds":4})).unwrap();
    doc.execute("marker.markOut", json!({"seconds":5})).unwrap();
    let mut loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
    let id = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    // An empty track above the addressed track makes insertion/removal-above meaningful.
    if !matches!(row, "point-automate" | "range-lift" | "range-extract") {
        loaded.project.sequence_mut(ItemId(id)).unwrap().video_tracks.swap(0, 1);
    }
    kition_film_format::encode(&loaded.project, false)
}

fn change(f: &Fixture, sequence: u64, kind: &str) {
    rewrite(&f.file(), |p| {
        let fresh = p.alloc_id();
        let q = p.sequence_mut(ItemId(sequence)).unwrap();
        let lane = q.video_tracks.iter().position(|t| !t.items.is_empty()).unwrap();
        if kind == "track-insert-above" {
            let mut track = q.video_tracks[0].clone();
            track.id.0 = fresh;
            track.items.clear();
            q.video_tracks.insert(0, track);
            return;
        }
        if kind == "track-remove-above" {
            q.video_tracks.remove(if lane == 0 { 1 } else { 0 });
            return;
        }
        if kind == "track-rename" {
            q.video_tracks[lane].name = "Renamed".into();
            return;
        }
        if kind == "bin-edit" || kind == "metadata-edit" {
            p.root.name = format!("Colleague {kind}");
            return;
        }
        let after = kind.ends_with("after");
        let at = if after { 8 } else { 1 };
        if kind.starts_with("ripple-insert") || kind.starts_with("ripple-delete") || kind.starts_with("speed-") {
            let deleting = kind.starts_with("ripple-delete");
            let shift = if deleting { -SECOND } else { SECOND };
            let track = &mut q.video_tracks[lane];
            if deleting {
                track.items.remove(at);
            } else if !kind.starts_with("speed-") {
                let mut inserted = track.items[at].clone();
                inserted.id = ClipId(fresh);
                track.items.insert(at, inserted);
            } else {
                track.items[at].speed = 0.5;
                track.items[at].duration.0 += SECOND;
            }
            for clip in track.items.iter_mut().skip(at + usize::from(!deleting)) {
                clip.start.0 += shift;
            }
            for transition in &mut track.transitions {
                if transition.start.0 >= (at as i64 + 1) * SECOND {
                    transition.start.0 += shift;
                }
            }
            for track in &mut q.caption_tracks {
                for caption in &mut track.captions {
                    if caption.start.0 >= (at as i64 + 1) * SECOND {
                        caption.start.0 += shift;
                    }
                }
            }
            for marker in &mut q.markers {
                if marker.start.0 >= (at as i64 + 1) * SECOND {
                    marker.start.0 += shift;
                }
            }
            return;
        }
        let i = if after { 8 } else { 4 };
        if matches!(kind, "overwrite-at" | "move-later" | "move-earlier" | "move-track" | "trim-head-away") {
            let id = q.video_tracks[lane].items[i].id;
            q.video_tracks[lane].transitions.retain(|tr| tr.from != Some(id) && tr.to != Some(id));
        }
        if kind == "move-track" {
            let clip = q.video_tracks[lane].items.remove(i);
            q.video_tracks[2].items.push(clip);
            return;
        }
        if matches!(kind, "move-later" | "move-earlier") {
            let other = if kind == "move-later" { 7 } else { 1 };
            let (start, duration) = (q.video_tracks[lane].items[other].start, q.video_tracks[lane].items[other].duration);
            q.video_tracks[lane].items[other].start = q.video_tracks[lane].items[i].start;
            q.video_tracks[lane].items[other].duration = q.video_tracks[lane].items[i].duration;
            q.video_tracks[lane].items[i].start = start;
            q.video_tracks[lane].items[i].duration = duration;
            q.video_tracks[lane].items.sort_by_key(|c| c.start);
            return;
        }
        let clip = &mut q.video_tracks[lane].items[i];
        match kind {
            "overwrite-at" | "overwrite-after" => {
                clip.id = ClipId(fresh);
                clip.name = "Replacement".into();
            }
            "move-after" => clip.start.0 += SECOND * 3,
            "trim-head-away" => {
                clip.start.0 += SECOND * 3 / 4;
                clip.source_in.0 += SECOND * 3 / 4;
                clip.duration.0 /= 4;
            }
            "trim-tail-away" => clip.duration.0 /= 4,
            "trim-tail-covered" | "trim-after" => clip.duration.0 = SECOND * 3 / 4,
            "slip-at" | "slip-after" => clip.source_in.0 += SECOND / 4,
            "appearance-at" => clip.enabled = false,
            _ => panic!("unknown change {kind}"),
        }
        q.video_tracks[lane].items.sort_by_key(|c| c.start);
    });
}

fn step(row: &str, q: &Value) -> Value {
    let lane = q["video"].as_array().unwrap().iter().position(|t| !t["items"].as_array().unwrap().is_empty()).unwrap();
    let clip = &q["video"][lane]["items"][4]["clip"];
    let item = &q["video"][lane]["items"][0]["item"];
    let command = |id: &str, params: Value| json!({"command":id,"params":params});
    match row {
        "clip-id" => command("timeline.slip", json!({"clip":clip,"deltaFrames":1})),
        "clip-id-local" => command("clip.rename", json!({"clip":clip,"name":"Mine"})),
        "clip-time" => command("timeline.razor", json!({"track":"V2","seconds":4.5})),
        "point-insert" | "point-overwrite" => {
            command("timeline.place", json!({"item":item,"track":"V2","seconds":4.5,"duration":SECOND/4,"insert":row=="point-insert"}))
        }
        "point-automate" => {
            json!({"command":"clip.automateToSequence","at":{"time":4.5},"params":{"items":[item],"method":"overwrite","videoTransition":false,"audioTransition":false}})
        }
        "point-marker" => command("marker.add", json!({"seconds":4.5,"name":"Mine"})),
        "range-lift" => command("sequence.lift", json!({})),
        "range-extract" => command("sequence.extract", json!({})),
        "caption-id" => command("caption.setText", json!({"caption":q["captionTracks"][0]["captions"][1]["id"],"text":"Mine"})),
        "caption-time" => json!({"command":"caption.setText","at":{"time":4.5},"params":{"text":"Mine"}}),
        "marker-id" => command("marker.edit", json!({"marker":q["markers"][1]["id"],"comment":"Mine"})),
        "marker-time" => json!({"command":"marker.clearCurrent","at":{"time":4.5}}),
        "track-id" => command("timeline.setTrack", json!({"track":q["video"][1]["id"],"name":"Mine"})),
        "track-index" => command("timeline.setTrack", json!({"track":"V2","name":"Mine"})),
        "transition-id" => command("sequence.setTransition", json!({"transition":q["video"][lane]["transitions"][0]["id"],"reverse":true})),
        "transition-cut" => json!({"command":"sequence.applyVideoTransition","at":{"time":4},"params":{"frames":6}}),
        "playhead" => json!({"command":"timeline.razor","at":{"time":4.5},"params":{"track":"V2"}}),
        _ => panic!("unknown row {row}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dense_time_matrix() {
    let mut failures = Vec::new();
    let mut counts = [0_usize; 4]; // cells, wrong writes, false refusals, wrong reasons
    for (row, expected) in ROWS {
        let bytes = seed(row);
        let expected: Vec<_> = expected.chars().filter(|c| !c.is_whitespace()).collect();
        assert_eq!(expected.len(), CHANGES.len(), "{row}: declare every cell before running");
        for (col, kind) in CHANGES.iter().enumerate() {
            let f = Fixture::from_bytes(&bytes, Default::default());
            let (mut q, basis) = f.inspect().await;
            let mut doc = FilmDocument::open(FILE, &bytes).unwrap();
            q["captionTracks"] = doc.execute("caption.list", json!({})).unwrap()["tracks"].clone();
            let write = step(row, &q);
            let want = expected[col];
            println!("EXPECT film/{row}/{kind} {want}");
            change(&f, q["id"].as_u64().unwrap(), kind);
            let saved = std::fs::read(f.file()).unwrap();
            let result = f.call("run", json!({"basis":basis,"steps":[write]})).await;
            counts[0] += 1;
            let mismatch = match (&result, want) {
                (Ok(_), 'A') => None,
                (Ok(_), _) => {
                    counts[1] += 1;
                    Some("wrong-write")
                }
                (Err(_), 'A') => {
                    counts[2] += 1;
                    Some("false-refusal")
                }
                (Err(e), _) => {
                    assert_eq!(std::fs::read(f.file()).unwrap(), saved, "refusal wrote {row}/{kind}");
                    let reason = match want {
                        'R' => "relocated",
                        'C' => "changed",
                        'D' => "deleted",
                        _ => panic!("bad expectation"),
                    };
                    if e["error"]["code"] == "conflict" && e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == reason)) {
                        None
                    } else {
                        counts[3] += 1;
                        Some("wrong-reason")
                    }
                }
            };
            println!("MATRIX film/{row}/{kind} {want} {}", mismatch.unwrap_or("PASS"));
            if mismatch == Some("false-refusal") && row == "range-lift" && *kind == "trim-head-away" {
                // Kit limit at SDK 34dff06 (C8-time-policy item 5): Lift reads no time, so its
                // step is no place the guard replays; the start of a clip in the range is the only
                // premise that refuses a clip swapped into the range, and the head trim moves it.
                let error = result.expect_err("over-held range clip");
                assert_eq!(error["error"]["code"], "conflict");
                assert_eq!(std::fs::read(f.file()).unwrap(), saved);
                println!("KIT-DEFECT film/{row}/{kind}: Lift is no place; range clip start held");
                f.shutdown().await;
                continue;
            }
            if mismatch.is_none() && want == 'A' && merge_checked(row, kind) {
                // C8-time-policy item 7: applied is not enough; the saved result must be both edits.
                if let Err(why) = merged(row, kind, &bytes, &saved, &std::fs::read(f.file()).unwrap()) {
                    failures.push(format!("{row}/{kind}: applied, but not the merge: {why}"));
                }
            }
            if let Some(why) = mismatch {
                failures.push(format!(
                    "{row}/{kind}: {why}, expected {want}, conflicts={} error={}",
                    result.as_ref().err().map(|e| &e["conflicts"]).unwrap_or(&Value::Null),
                    result.as_ref().err().map(|e| &e["error"]).unwrap_or(&Value::Null)
                ));
            }
            f.shutdown().await;
        }
    }
    println!("COUNTS film cells/wrong-writes/false-refusals/wrong-reasons {counts:?}");
    assert_eq!(counts[1], 0, "wrong time-addressed writes");
    assert!(counts[2] <= 1 && counts[3] == 0, "time-addressed refusals/reasons regressed: {counts:?}");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_and_marker_before_at_after_matrix() {
    const EDITS: [&str; 9] =
        ["insert-before", "delete-before", "replace-at", "delete-at", "move-at", "value-at", "insert-after", "delete-after", "value-after"];
    const FORMS: [(&str, &str); 4] = [("caption-id", "AACCACAAA"), ("caption-time", "AACCCCAAA"), ("marker-id", "AACCACAAA"), ("marker-time", "AACCCCAAA")];
    let mut failures = Vec::new();
    let mut batch_mismatches = 0;
    let mut batch_counts = [0_usize; 4];
    for route in ["run", "batch"] {
        for (form, expected) in FORMS {
            for (edit, want) in EDITS.iter().zip(expected.chars()) {
                let bytes = seed(form);
                let f = Fixture::from_bytes(&bytes, Default::default());
                let (mut q, basis) = f.inspect().await;
                q["captionTracks"] = FilmDocument::open(FILE, &bytes).unwrap().execute("caption.list", json!({})).unwrap()["tracks"].clone();
                let write = step(form, &q);
                println!("EXPECT film/{route}/{form}/{edit} {want}");
                rewrite(&f.file(), |p| {
                    let fresh = p.alloc_id();
                    let seq = p.sequence_mut(ItemId(q["id"].as_u64().unwrap())).unwrap();
                    if form.starts_with("caption") {
                        let items = &mut seq.caption_tracks[0].captions;
                        match *edit {
                            "insert-before" | "insert-after" => {
                                let mut new = items[1].clone();
                                new.id.0 = fresh;
                                new.start.0 = if *edit == "insert-before" { 0 } else { 12 * SECOND };
                                new.duration.0 = SECOND / 4;
                                items.push(new);
                                items.sort_by_key(|c| c.start);
                            }
                            "delete-before" => {
                                items.remove(0);
                            }
                            "delete-at" => {
                                items.remove(1);
                            }
                            "delete-after" => {
                                items.remove(2);
                            }
                            "replace-at" => items[1].id.0 = fresh,
                            "move-at" => items[1].start.0 += 2 * SECOND,
                            "value-at" => items[1].text = "Theirs".into(),
                            "value-after" => items[2].text = "Theirs".into(),
                            _ => panic!("{edit}"),
                        }
                    } else {
                        let items = &mut seq.markers;
                        match *edit {
                            "insert-before" | "insert-after" => {
                                let mut new = items[1].clone();
                                new.id.0 = fresh;
                                new.start.0 = if *edit == "insert-before" { 0 } else { 12 * SECOND };
                                items.push(new);
                                items.sort_by_key(|m| m.start);
                            }
                            "delete-before" => {
                                items.remove(0);
                            }
                            "delete-at" => {
                                items.remove(1);
                            }
                            "delete-after" => {
                                items.remove(2);
                            }
                            "replace-at" => items[1].id.0 = fresh,
                            "move-at" => items[1].start.0 += 2 * SECOND,
                            "value-at" => items[1].comment = "Theirs".into(),
                            "value-after" => items[2].comment = "Theirs".into(),
                            _ => panic!("{edit}"),
                        }
                    }
                });
                let saved = std::fs::read(f.file()).unwrap();
                let input = if route == "run" {
                    json!({"basis":basis,"steps":[write]})
                } else {
                    json!({"basis":basis,"ops":[{"op":"command","id":write["command"],"params":write.get("params").cloned().unwrap_or(json!({})),"at":write.get("at").cloned().unwrap_or(Value::Null)}]})
                };
                let answer = f.call(route, input).await;
                let valid = if want == 'A' {
                    answer.is_ok()
                } else {
                    answer.as_ref().err().is_some_and(|e| {
                        e["error"]["code"] == "conflict" && e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == "changed"))
                    }) && std::fs::read(f.file()).unwrap() == saved
                };
                println!("MATRIX film/{route}/{form}/{edit} {want} {}", if valid { "PASS" } else { "FAIL" });
                if route == "batch" {
                    batch_mismatches += usize::from(!valid);
                    batch_counts[0] += 1;
                    if !valid {
                        let category = if answer.is_ok() {
                            1
                        } else if want == 'A' {
                            2
                        } else {
                            3
                        };
                        batch_counts[category] += 1;
                        println!("BATCH-MISMATCH film/{form}/{edit}: category={category} {answer:?}");
                    }
                    f.shutdown().await;
                    continue;
                }
                if !valid {
                    failures.push(format!("{route}/{form}/{edit}: {answer:?}"));
                } else if want == 'A' && *edit == "move-at" {
                    // C8-time-policy item 7: the entry keeps the colleague's time and takes the text.
                    let (theirs, now) = (sequence_of(&saved), sequence_of(&std::fs::read(f.file()).unwrap()));
                    let ok = if form == "caption-id" {
                        let mut want = theirs.caption_tracks.clone();
                        want[0].captions[1].text = "Mine".into();
                        want == now.caption_tracks
                    } else {
                        let mut want = theirs.markers.clone();
                        want[1].comment = "Mine".into();
                        want == now.markers
                    };
                    if !ok {
                        failures.push(format!("{route}/{form}/{edit}: applied, but not the merge"));
                    }
                }
                f.shutdown().await;
            }
        }
    }
    // Raw command batches use the same premise guard as runs.
    assert_eq!(batch_counts[1], 0, "raw command batches must not write stale targets");
    assert!(batch_counts[2] == 0 && batch_counts[3] == 0, "batch refusals/reasons regressed: {batch_counts:?}");
    assert_eq!(batch_mismatches, batch_counts[1..].iter().sum::<usize>());
    println!("COUNTS film/batch cells/wrong-writes/false-refusals/wrong-reasons {batch_counts:?}");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn caption_range_and_stored_marks_matrix() {
    // Extract consumes overlapping captions and retimes the suffix. Lift only edits clips.
    // A suffix caption's text and duration do not determine the extraction result.
    const EDITS: [&str; 17] = [
        "insert-before",
        "delete-before",
        "replace-at",
        "delete-at",
        "move-at",
        "value-at",
        "insert-after",
        "delete-after",
        "value-after",
        "insert-at",
        "move-after",
        "duration-after",
        "extend-before",
        "lock-track",
        "sync-track",
        "mark-in",
        "mark-out",
    ];
    const FORMS: [(&str, &str); 2] = [("range-extract", "AACCCCCAACCACCCCC"), ("range-lift", "AAAAAAAAAAAAAAACC")];
    let mut counts = [0_usize; 4];
    let mut failures = Vec::new();
    for (form, expected) in FORMS {
        assert_eq!(expected.len(), EDITS.len());
        for (edit, want) in EDITS.iter().zip(expected.chars()) {
            println!("EXPECT film/caption-range/{form}/{edit} {want}");
            let mut bytes = seed(form);
            if *edit == "extend-before" {
                let mut loaded = kition_film_format::decode(&bytes).unwrap();
                let seq = loaded.project.sequence_mut(ItemId(7)).unwrap();
                seq.caption_tracks[0].captions[1].start.0 = SECOND * 9 / 2;
                seq.caption_tracks[0].captions[1].duration.0 = SECOND / 4;
                bytes = kition_film_format::encode(&loaded.project, false);
            }
            let f = Fixture::from_bytes(&bytes, Default::default());
            let (q, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                let fresh = p.alloc_id();
                let seq = p.sequence_mut(ItemId(q["id"].as_u64().unwrap())).unwrap();
                let track = &mut seq.caption_tracks[0];
                let items = &mut track.captions;
                match *edit {
                    "insert-before" | "insert-at" | "insert-after" => {
                        let mut new = items[1].clone();
                        new.id.0 = fresh;
                        new.start.0 = match *edit {
                            "insert-before" => 0,
                            "insert-at" => 5 * SECOND + SECOND / 100,
                            _ => 12 * SECOND,
                        };
                        new.duration.0 = SECOND / 100;
                        items.push(new);
                        items.sort_by_key(|c| c.start);
                    }
                    "delete-before" => {
                        items.remove(0);
                    }
                    "delete-at" => {
                        items.remove(1);
                    }
                    "delete-after" => {
                        items.remove(2);
                    }
                    "replace-at" => items[1].id.0 = fresh,
                    "move-at" => items[1].start.0 += 2 * SECOND,
                    "value-at" => items[1].text = "Theirs".into(),
                    "value-after" => items[2].text = "Theirs".into(),
                    "move-after" => items[2].start.0 += SECOND,
                    "duration-after" => items[2].duration.0 += SECOND,
                    "extend-before" => items[0].duration.0 = SECOND * 13 / 4,
                    "lock-track" => track.locked = true,
                    "sync-track" => track.sync_lock = false,
                    "mark-in" => seq.mark_in.as_mut().unwrap().0 = 3 * SECOND,
                    "mark-out" => seq.mark_out.as_mut().unwrap().0 = 6 * SECOND,
                    _ => panic!("{edit}"),
                }
            });
            let saved = std::fs::read(f.file()).unwrap();
            let answer = f.call("run", json!({"basis":basis,"steps":[step(form,&q)]})).await;
            counts[0] += 1;
            let mismatch = match (&answer, want) {
                (Ok(_), 'A') => None,
                (Ok(_), _) => {
                    counts[1] += 1;
                    Some("wrong-write")
                }
                (Err(_), 'A') => {
                    counts[2] += 1;
                    Some("false-refusal")
                }
                (Err(e), _) if e["error"]["code"] == "conflict" && e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == "changed")) => {
                    None
                }
                (Err(_), _) => {
                    counts[3] += 1;
                    Some("wrong-reason")
                }
            };
            if answer.is_err() {
                assert_eq!(std::fs::read(f.file()).unwrap(), saved);
            }
            if form == "range-extract" && *edit == "delete-after" && mismatch.is_none() {
                // C8-time-policy item 7: the agent's extraction of its own document, less the
                // 8.5 s caption the colleague deleted, is what is saved.
                let mut alone = FilmDocument::open(FILE, &bytes).unwrap();
                alone.execute("sequence.extract", json!({})).unwrap();
                let mut want = sequence_of(&alone.save(None).unwrap()).caption_tracks;
                want[0].captions.retain(|c| c.text != "C8.5");
                let now = sequence_of(&std::fs::read(f.file()).unwrap()).caption_tracks;
                if want != now {
                    failures.push(format!("{form}/{edit}: applied, but not the merge: expected {want:?}, saved {now:?}"));
                }
            }
            println!("MATRIX film/caption-range/{form}/{edit} {want} {}", mismatch.unwrap_or("PASS"));
            if let Some(why) = mismatch {
                failures.push(format!("{form}/{edit}: {why} {answer:?}"));
            }
            f.shutdown().await;
        }
    }
    println!("COUNTS film/caption-range cells/wrong-writes/false-refusals/wrong-reasons {counts:?}");
    assert_eq!(counts, [34, 0, 0, 0]);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn model_clip_positions_matrix() {
    // Model fields set by id read just that field; a list removal addresses the observed
    // occupant by index. Clip lists are canonicalized by time, so list.move cannot retime one.
    let rows = [("set-id", "AADAAAAAAA AAAA AAAAAAA AAA"), ("remove-index", "RRRRRRAAAA AAAA AAAAAAA AAA")];
    let mut counts = [0_usize; 4];
    for (row, expected) in rows {
        let expected: Vec<_> = expected.chars().filter(|c| !c.is_whitespace()).collect();
        assert_eq!(expected.len(), CHANGES.len());
        for (kind, want) in CHANGES.iter().zip(expected) {
            let f = Fixture::from_bytes(&seed("clip-id"), Default::default());
            let (q, basis) = f.inspect().await;
            let clip = q["video"][1]["items"][4]["clip"].clone();
            let track = q["video"][1]["id"].clone();
            println!("EXPECT film/model/{row}/{kind} {want}");
            change(&f, q["id"].as_u64().unwrap(), kind);
            let saved = std::fs::read(f.file()).unwrap();
            let op = if row == "set-id" {
                json!({"op":"set","target":clip,"field":"props.name","value":"Mine"})
            } else {
                json!({"op":"list.remove","target":track,"field":"clips","index":4})
            };
            let answer = f.call("batch", json!({"basis":basis,"ops":[op]})).await;
            counts[0] += 1;
            let reason = match want {
                'R' => "relocated",
                'D' => "deleted",
                _ => "changed",
            };
            let mismatch = match (&answer, want) {
                (Ok(_), 'A') => None,
                (Ok(_), _) => {
                    counts[1] += 1;
                    Some("wrong-write")
                }
                (Err(_), 'A') => {
                    counts[2] += 1;
                    Some("false-refusal")
                }
                (Err(e), _) if e["error"]["code"] == "conflict" && e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == reason)) => None,
                (Err(_), _) => {
                    counts[3] += 1;
                    Some("wrong-reason")
                }
            };
            if answer.is_err() {
                assert_eq!(std::fs::read(f.file()).unwrap(), saved);
            }
            println!("MATRIX film/model/{row}/{kind} {want} {}", mismatch.unwrap_or("PASS"));
            f.shutdown().await;
        }
    }
    println!("COUNTS film/model cells/wrong-writes/false-refusals/wrong-reasons {counts:?}");
    assert_eq!(counts[0], 48);
    assert_eq!(counts[1], 0, "wrong raw position writes");
    assert!(counts[2] <= 2 && counts[3] == 0, "raw position refusals/reasons regressed: {counts:?}");
}

async fn model_clip_ops(f: &Fixture, q: &Value, form: &str) -> Value {
    let track = &q["video"][1]["id"];
    if form == "set-id" {
        return json!([{"op":"set","target":q["video"][1]["items"][4]["clip"],"field":"props.name","value":"Mine"}]);
    }
    if form == "remove-index" {
        return json!([{"op":"list.remove","target":track,"field":"clips","index":4}]);
    }
    if form == "move" {
        return json!([{"op":"list.move","target":track,"field":"clips","from":4,"to":6}]);
    }
    let clip = f.ok("query", json!({"objects":[q["video"][1]["items"][4]["clip"]]})).await;
    let item = &clip["objects"][0]["fields"]["item"];
    let item = item.as_u64().map(|id| json!(id.to_string())).unwrap_or_else(|| item.clone());
    let mut fields = clip["objects"][0]["fields"].clone();
    for field in ["clipId", "missingItem", "effects", "markers"] {
        fields.as_object_mut().unwrap().remove(field);
    }
    fields["item"] = item;
    fields["start"] = json!((SECOND * 7 / 2).to_string());
    fields["duration"] = json!((SECOND / 4).to_string());
    fields["props"]["name"] = json!("Mine");
    if form == "create" {
        json!([{"op":"create","type":"Clip","in":format!("{}.clips",track.as_u64().unwrap()),"at":4,"fields":fields}])
    } else {
        json!([{"op":"create","type":"Clip","ref":"$new","fields":fields},{"op":"list.insert","target":track,"field":"clips","index":4,"item":"$new"}])
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn model_clip_insertion_and_move_matrix() {
    // A gap at index 4 holds its two observed neighbours. Move also holds the source
    // at index 4. Canonical time ordering is not a substitute for that index premise.
    let specification = "RRRRRRAAAA AAAA AAAAAAA AAA";
    let mut counts = [0_usize; 4];
    for (form, pinned) in [("create", ".EEEEEEFFFFFFFFFFFFFFFFFF"), ("insert", ".EEEEEEFFFFFFFFFFFFFFFFFF"), ("move", ".WWWWWW....FF............")] {
        for (column, (kind, want)) in
            std::iter::once(("none", 'A')).chain(CHANGES.into_iter().zip(specification.chars().filter(|c| !c.is_whitespace()))).enumerate()
        {
            println!("EXPECT film/model/{form}/{kind} {want}");
            let f = Fixture::from_bytes(&seed("clip-id"), Default::default());
            let (q, basis) = f.inspect().await;
            let ops = model_clip_ops(&f, &q, form).await;
            if kind != "none" {
                change(&f, q["id"].as_u64().unwrap(), kind);
            }
            let saved = std::fs::read(f.file()).unwrap();
            let answer = f.call("batch", json!({"basis":basis,"ops":ops})).await;
            if kind == "none" {
                assert!(answer.is_ok(), "invalid model control {form}: {answer:?}");
            }
            counts[0] += 1;
            let mismatch = match (&answer, want) {
                (Ok(_), 'A') => None,
                (Ok(_), _) => {
                    counts[1] += 1;
                    Some("wrong-write")
                }
                (Err(_), 'A') => {
                    counts[2] += 1;
                    Some("false-refusal")
                }
                (Err(e), _)
                    if e["error"]["code"] == "conflict" && e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == "relocated")) =>
                {
                    None
                }
                _ => {
                    counts[3] += 1;
                    Some("wrong-reason")
                }
            };
            if answer.is_err() {
                assert_eq!(std::fs::read(f.file()).unwrap(), saved);
            }
            println!("MATRIX film/model/{form}/{kind} {want} {}", mismatch.unwrap_or("PASS"));
            let observed = match mismatch {
                Some("wrong-write") => b'W',
                Some("false-refusal") => b'F',
                Some("wrong-reason") => b'E',
                _ => b'.',
            };
            assert!(observed != b'F' || pinned.as_bytes()[column] == b'F', "new false refusal at {form}/{kind}: {answer:?}");
            if mismatch.is_some() {
                assert!(
                    answer.as_ref().err().is_none_or(|e| matches!(e["error"]["code"].as_str(), Some("conflict" | "not-found"))),
                    "unexpected model failure: {answer:?}"
                );
                println!("WAITING-SDK film/model/{form}/{kind}: conservative ancestor position hold: {answer:?}");
            }
            f.shutdown().await;
        }
    }
    println!("COUNTS film/model-extra cells/wrong-writes/false-refusals/wrong-reasons {counts:?}");
    assert_eq!(counts[0], 75);
    assert_eq!(counts[1], 0, "wrong raw insertion/move writes");
    assert!(counts[2] <= 4 && counts[3] == 0, "raw insertion refusals/reasons regressed: {counts:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn mixer_name_time_matrix() {
    // The guide promises name and stack premises even though this local mixer setting
    // does not consume clips. These expectations are independent of the returned errors.
    let mut counts = [0_usize; 4];
    let mut failures = Vec::new();
    for kind in CHANGES.into_iter().chain(AFTER) {
        let want = if matches!(kind, "track-insert-above" | "track-remove-above" | "track-rename") { 'R' } else { 'A' };
        println!("EXPECT film/mixer-name/{kind} {want}");
        let bytes = if AFTER.contains(&kind) { after_seed("clip-id") } else { seed("clip-id") };
        let mut loaded = kition_film_format::decode(&bytes).unwrap();
        let doc = FilmDocument::open(FILE, &bytes).unwrap();
        let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        let seq = loaded.project.sequence_mut(ItemId(sequence)).unwrap();
        seq.audio_tracks.truncate(1);
        let mut audio = seq.audio_tracks[0].clone();
        audio.name = "Voice".into();
        seq.audio_tracks.push(audio);
        seq.audio_tracks[1].id.0 = 900_001;
        // This synthetic track uses the shared id space; keep the file valid.
        loaded.project.next_id = loaded.project.next_id.max(900_002);
        let bytes = kition_film_format::encode(&loaded.project, false);
        let f = Fixture::from_bytes(&bytes, Default::default());
        let (_, basis) = f.inspect().await;
        if AFTER.contains(&kind) {
            change_after(&f, sequence, kind);
        } else {
            change(&f, sequence, kind);
        }
        if matches!(kind, "track-insert-above" | "track-remove-above" | "track-rename") {
            rewrite(&f.file(), |p| {
                let fresh = p.alloc_id();
                let seq = p.sequence_mut(ItemId(sequence)).unwrap();
                match kind {
                    "track-insert-above" => {
                        let mut track = seq.audio_tracks[0].clone();
                        track.id.0 = fresh;
                        seq.audio_tracks.insert(0, track);
                    }
                    "track-remove-above" => {
                        seq.audio_tracks.remove(0);
                    }
                    _ => seq.audio_tracks[1].name = "Their Voice".into(),
                }
            });
        }
        let saved = std::fs::read(f.file()).unwrap();
        let answer = f.call("run", json!({"basis":basis,"steps":[{"command":"mixer.setStrip","params":{"strip":"Voice","volumeDb":-6}}]})).await;
        counts[0] += 1;
        let valid = if want == 'A' {
            answer.is_ok()
        } else {
            answer
                .as_ref()
                .err()
                .is_some_and(|e| e["error"]["code"] == "conflict" && e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == "relocated")))
        };
        if !valid {
            counts[if answer.is_ok() {
                1
            } else if want == 'A' {
                2
            } else {
                3
            }] += 1;
            failures.push(format!("{kind}: {answer:?}"));
        }
        if answer.is_err() {
            assert_eq!(std::fs::read(f.file()).unwrap(), saved);
        }
        println!("MATRIX film/mixer-name/{kind} {want} {}", if valid { "PASS" } else { "FAIL" });
        f.shutdown().await;
    }
    println!("COUNTS film/mixer-name cells/wrong-writes/false-refusals/wrong-reasons {counts:?}");
    assert_eq!(counts, [33, 0, 0, 0]);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

const AFTER: [&str; 9] = [
    "move-earlier-after",
    "move-track-after",
    "trim-head-after",
    "trim-tail-away-after",
    "appearance-after",
    "track-insert-below",
    "track-remove-below",
    "track-reorder-below",
    "track-rename-below",
];

fn after_seed(row: &str) -> Vec<u8> {
    let bytes = seed(row);
    let doc = FilmDocument::open(FILE, &bytes).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let mut loaded = kition_film_format::decode(&bytes).unwrap();
    let id = loaded.project.alloc_id();
    let seq = loaded.project.sequence_mut(ItemId(sequence)).unwrap();
    let mut empty = seq.video_tracks[2].clone();
    empty.id.0 = id;
    empty.items.clear();
    empty.transitions.clear();
    seq.video_tracks.push(empty);
    kition_film_format::encode(&loaded.project, false)
}

fn change_after(f: &Fixture, sequence: u64, kind: &str) {
    rewrite(&f.file(), |p| {
        let fresh = if kind == "track-insert-below" { p.alloc_id() } else { 0 };
        let seq = p.sequence_mut(ItemId(sequence)).unwrap();
        let lane = seq.video_tracks.iter().position(|t| !t.items.is_empty()).unwrap();
        match kind {
            "move-earlier-after" => {
                let track = &mut seq.video_tracks[lane];
                let start = track.items[7].start;
                track.items[7].start = track.items[8].start;
                track.items[8].start = start;
                track.items.sort_by_key(|c| c.start);
            }
            "move-track-after" => {
                let clip = seq.video_tracks[lane].items.remove(8);
                seq.video_tracks[2].items.push(clip);
            }
            "trim-head-after" => {
                let clip = &mut seq.video_tracks[lane].items[8];
                clip.start.0 += SECOND / 4;
                clip.source_in.0 += SECOND / 4;
                clip.duration.0 -= SECOND / 4;
            }
            "trim-tail-away-after" => seq.video_tracks[lane].items[8].duration.0 = SECOND / 4,
            "appearance-after" => seq.video_tracks[lane].items[8].enabled = false,
            "track-insert-below" => {
                let mut empty = seq.video_tracks.last().unwrap().clone();
                empty.id.0 = fresh;
                seq.video_tracks.push(empty);
            }
            "track-remove-below" => {
                seq.video_tracks.pop().unwrap();
            }
            "track-reorder-below" => seq.video_tracks.swap(2, 3),
            "track-rename-below" => seq.video_tracks[3].name = "Below".into(),
            _ => panic!("missing after writer {kind}"),
        }
    });
}

#[tokio::test(flavor = "multi_thread")]
async fn strictly_after_time_matrix() {
    let mut counts = [0_usize; 4];
    let mut failures = Vec::new();
    for row in ROWS.iter().map(|(row, _)| *row).chain(["set-id", "remove-index", "create", "insert", "move"]) {
        let raw = matches!(row, "set-id" | "remove-index" | "create" | "insert" | "move");
        let bytes = after_seed(if raw { "clip-id" } else { row });
        for kind in AFTER {
            // C8-time-policy: every cell applies; Extract shifts later clips without reading them.
            // shift_track_from assigns these observed suffix starts too (the maintainers'
            // same-field decision); a changed start is a necessary refusal.
            let want = if row == "point-insert" && matches!(kind, "move-earlier-after" | "trim-head-after") { 'C' } else { 'A' };
            println!("EXPECT film/after/{row}/{kind} {want}");
            let f = Fixture::from_bytes(&bytes, Default::default());
            let (mut q, basis) = f.inspect().await;
            let mut doc = FilmDocument::open(FILE, &bytes).unwrap();
            q["captionTracks"] = doc.execute("caption.list", json!({})).unwrap()["tracks"].clone();
            let input = if raw { json!({"basis":basis,"ops":model_clip_ops(&f,&q,row).await}) } else { json!({"basis":basis,"steps":[step(row,&q)]}) };
            change_after(&f, q["id"].as_u64().unwrap(), kind);
            let saved = std::fs::read(f.file()).unwrap();
            let answer = f.call(if raw { "batch" } else { "run" }, input).await;
            counts[0] += 1;
            let mismatch = match (&answer, want) {
                (Ok(_), 'A') => None,
                (Ok(_), _) => {
                    counts[1] += 1;
                    Some("wrong-write")
                }
                (Err(_), 'A') => {
                    counts[2] += 1;
                    Some("false-refusal")
                }
                (Err(e), _)
                    if e["error"]["code"] == "conflict"
                        && e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == if want == 'C' { "changed" } else { "relocated" })) =>
                {
                    None
                }
                _ => {
                    counts[3] += 1;
                    Some("wrong-reason")
                }
            };
            if answer.is_err() {
                assert_eq!(std::fs::read(f.file()).unwrap(), saved);
            }
            println!("MATRIX film/after/{row}/{kind} {want} {}", mismatch.unwrap_or("PASS"));
            if mismatch.is_none()
                && merge_checked(row, kind)
                && let Err(why) = merged(row, kind, &bytes, &saved, &std::fs::read(f.file()).unwrap())
            {
                failures.push(format!("{row}/{kind}: applied, but not the merge: {why}"));
            }
            let pinned = if matches!(row, "create" | "insert") { Some("false-refusal") } else { None };
            if mismatch == pinned && pinned.is_some() {
                assert_eq!(answer.as_ref().unwrap_err()["error"]["code"], "conflict");
                println!("WAITING-SDK film/after/{row}/{kind}: {answer:?}");
            } else if let Some(why) = mismatch {
                failures.push(format!("{row}/{kind}: {why}: {answer:?}"));
            }
            f.shutdown().await;
        }
    }
    println!("COUNTS film/after cells/wrong-writes/false-refusals/wrong-reasons {counts:?}");
    assert_eq!(counts[0], 207);
    assert_eq!(counts[1], 0);
    assert!(counts[2] == 0 && counts[3] == 0, "strictly-after refusals/reasons regressed: {counts:?}");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The cells whose expectation is A since the C8-time review or C8-time-policy: their saved
/// result is compared with both edits (item 7), not only with "applied".
fn merge_checked(row: &str, kind: &str) -> bool {
    let moved_only = matches!(kind, "ripple-insert-before" | "ripple-delete-before" | "speed-before");
    match row {
        "clip-id" => moved_only || matches!(kind, "move-later" | "move-earlier" | "move-track" | "appearance-at"),
        // Addressed by time: checked where the content at 4.5 s is as observed (the A cells).
        "point-marker" => true,
        "point-insert" | "point-overwrite" => kind == "trim-tail-covered",
        "range-lift" => matches!(kind, "move-track" | "trim-head-away" | "trim-tail-away" | "trim-tail-covered" | "slip-at" | "appearance-at"),
        "range-extract" => matches!(
            kind,
            "move-track"
                | "trim-head-away"
                | "trim-tail-away"
                | "trim-tail-covered"
                | "slip-at"
                | "appearance-at"
                | "ripple-insert-after"
                | "ripple-delete-after"
                | "move-after"
                | "trim-after"
                | "speed-after"
                | "move-earlier-after"
                | "move-track-after"
                | "trim-head-after"
                | "trim-tail-away-after"
        ),
        "caption-id" | "marker-id" | "transition-id" => moved_only,
        _ => false,
    }
}

fn sequence_of(bytes: &[u8]) -> kition_film_project::Sequence {
    let id = FilmDocument::open(FILE, bytes).unwrap().inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    kition_film_format::decode(bytes).unwrap().project.sequence(ItemId(id)).unwrap().clone()
}

/// Each track's clips as (start, duration, source In, item), the fields a timeline result is.
type Pieces = Vec<(i64, i64, i64, u64)>;

fn pieces(track: &kition_film_project::Track) -> Pieces {
    let mut out: Pieces = track.items.iter().map(|c| (c.start.0, c.duration.0, c.source_in.0, c.item.0)).collect();
    out.sort();
    out
}

fn all_pieces(q: &kition_film_project::Sequence) -> Vec<Pieces> {
    q.all_tracks().map(pieces).collect()
}

/// The agent's lift or extract of `[a, b)` applied to the colleague's sequence, modelled
/// independently of the engine: what lies in the range goes, pieces outside it stay, and for an
/// extract every later piece moves up by the range's length.
fn range_model(q: &kition_film_project::Sequence, a: i64, b: i64, extract: bool) -> Vec<Pieces> {
    q.all_tracks()
        .map(|track| {
            let mut out = Pieces::new();
            for c in &track.items {
                let (start, end) = (c.start.0, c.start.0 + c.duration.0);
                if !track.locked && end > a && start < b {
                    if start < a {
                        out.push((start, a - start, c.source_in.0, c.item.0));
                    }
                    if end > b {
                        let skipped = ((b - start) as f64 * c.speed.abs()).round() as i64;
                        out.push((if extract { a } else { b }, end - b, c.source_in.0 + skipped, c.item.0));
                    }
                } else if !track.locked && extract && start >= b {
                    out.push((start - (b - a), c.duration.0, c.source_in.0, c.item.0));
                } else {
                    out.push((start, c.duration.0, c.source_in.0, c.item.0));
                }
            }
            out.sort();
            out
        })
        .collect()
}

/// Whether the saved `result` is the merge of the colleague's change (`theirs`, the file the
/// write met) and the write the agent made from `basis`: the agent's edit as it intended it,
/// applied to everything the colleague left (C8-time-policy item 7).
fn merged(row: &str, kind: &str, basis: &[u8], theirs: &[u8], result: &[u8]) -> Result<(), String> {
    let (was, theirs, now) = (sequence_of(basis), sequence_of(theirs), sequence_of(result));
    let lane = |q: &kition_film_project::Sequence| q.video_tracks.iter().position(|t| !t.items.is_empty()).unwrap();
    let frame = theirs.settings.frame_rate.frame_duration().0;
    let same = |what: &str, a: &dyn std::fmt::Debug, b: &dyn std::fmt::Debug| {
        let (a, b) = (format!("{a:?}"), format!("{b:?}"));
        if a == b { Ok(()) } else { Err(format!("{what} {kind}: expected {a}, saved {b}")) }
    };
    match row {
        "clip-id" => {
            // Slip by one frame: the clip the agent named shows one frame later, wherever it is.
            let clip = was.video_tracks[lane(&was)].items[4].id;
            let mut want = theirs.clone();
            let (track, _) = want.find_item(clip).ok_or("the slipped clip is gone")?;
            want.track_mut(track).unwrap().item_mut(clip).unwrap().source_in.0 += frame;
            same("clips", &all_pieces(&want), &all_pieces(&now))?;
            same("enabled", &theirs.find_item(clip).map(|(_, c)| c.enabled), &now.find_item(clip).map(|(_, c)| c.enabled))
        }
        "point-marker" => {
            let mut markers = now.markers.clone();
            let mine = markers.iter().position(|m| m.name == "Mine").ok_or("no marker Mine")?;
            let added = markers.remove(mine);
            // Where the same marker lands when added to the agent's own document (on a frame).
            let mut alone = FilmDocument::open(FILE, basis).unwrap();
            alone.execute("marker.add", json!({"seconds":4.5,"name":"Mine"})).unwrap();
            let at = sequence_of(&alone.save(None).unwrap()).markers.iter().find(|m| m.name == "Mine").unwrap().start.0;
            same("marker time", &at, &added.start.0)?;
            same("markers", &theirs.markers, &markers)?;
            same("clips", &all_pieces(&theirs), &all_pieces(&now))
        }
        "point-insert" | "point-overwrite" => {
            // 0.25 s of the first item at 4.5 s on V2: an insert splits what is there and pushes
            // the rest later; an overwrite replaces that span.
            // The placed clip lasts whole frames: 0.25 s rounded up to the frame.
            let (at, span) = (SECOND * 9 / 2, (SECOND / 4 + frame - 1) / frame * frame);
            let track = &theirs.video_tracks[lane(&theirs)];
            let item = was.video_tracks[lane(&was)].items[0].item.0;
            let mut want = Pieces::new();
            for c in &track.items {
                let (start, end) = (c.start.0, c.start.0 + c.duration.0);
                if row == "point-insert" {
                    if start < at && at < end {
                        want.push((start, at - start, c.source_in.0, c.item.0));
                        want.push((at + span, end - at, c.source_in.0 + (at - start), c.item.0));
                    } else {
                        want.push((if start >= at { start + span } else { start }, c.duration.0, c.source_in.0, c.item.0));
                    }
                } else if end <= at || start >= at + span {
                    want.push((start, c.duration.0, c.source_in.0, c.item.0));
                } else {
                    if start < at {
                        want.push((start, at - start, c.source_in.0, c.item.0));
                    }
                    if end > at + span {
                        want.push((at + span, end - at - span, c.source_in.0 + (at + span - start), c.item.0));
                    }
                }
            }
            want.push((at, span, 0, item));
            want.sort();
            same("V2", &want, &pieces(&now.video_tracks[lane(&now)]))
        }
        "range-lift" | "range-extract" => {
            let a = was.mark_in.unwrap().0;
            let b = was.mark_out.unwrap().0 + frame;
            let gone: Vec<_> = was.all_tracks().flat_map(|t| &t.items).filter(|c| c.start.0 >= a && c.start.0 + c.duration.0 <= b).map(|c| c.id).collect();
            if let Some(kept) = gone.iter().find(|id| now.find_item(**id).is_some()) {
                return Err(format!("{kind}: clip {} the agent saw in the range is still there", kept.0));
            }
            same("clips", &range_model(&theirs, a, b, row == "range-extract"), &all_pieces(&now))
        }
        "caption-id" => {
            let caption = was.caption_tracks[0].captions[1].id;
            let mut want = theirs.caption_tracks.clone();
            want.iter_mut().flat_map(|t| &mut t.captions).find(|c| c.id == caption).ok_or("caption gone")?.text = "Mine".into();
            same("captions", &want, &now.caption_tracks)?;
            same("clips", &all_pieces(&theirs), &all_pieces(&now))
        }
        "marker-id" => {
            let marker = was.markers[1].id;
            let mut want = theirs.markers.clone();
            want.iter_mut().find(|m| m.id == marker).ok_or("marker gone")?.comment = "Mine".into();
            same("markers", &want, &now.markers)?;
            same("clips", &all_pieces(&theirs), &all_pieces(&now))
        }
        "transition-id" => {
            let transition = was.video_tracks[lane(&was)].transitions[0].id;
            let mut want = theirs.clone();
            want.video_tracks.iter_mut().flat_map(|t| &mut t.transitions).find(|t| t.id == transition).ok_or("transition gone")?.reverse = true;
            let transitions = |q: &kition_film_project::Sequence| q.video_tracks.iter().map(|t| t.transitions.clone()).collect::<Vec<_>>();
            same("transitions", &transitions(&want), &transitions(&now))?;
            same("clips", &all_pieces(&theirs), &all_pieces(&now))
        }
        _ => Err(format!("no merge model for {row}")),
    }
}

/// C8-time-policy items 2 and 5: a clip that stays wholly inside the marked range on a targeted
/// track leaves Lift's and Extract's result as the agent saw it (A, with the merged result
/// checked); a clip that crosses a range edge, or a later clip that moves into the range or
/// across its edge, refuses (R). A clip moved from after the range to before it, or back, is no
/// longer on the side Extract's address put it (shifted or not): Extract refuses, Lift (which
/// shifts nothing) applies.
#[tokio::test(flavor = "multi_thread")]
async fn range_edge_matrix() {
    // (change, lift, extract): clip `index` of V1 moves to V3 at `seconds` (V3 is targeted).
    const CELLS: [(&str, usize, i64, char, char); 8] = [
        ("inside-to-V3", 4, 4000, 'A', 'A'),
        ("inside-shrink", 4, 0, 'A', 'A'),
        ("cross-out-edge", 4, 4500, 'R', 'R'),
        ("cross-in-edge", 4, 3500, 'R', 'R'),
        ("later-into", 8, 4000, 'R', 'R'),
        ("later-across-edge", 8, 4500, 'R', 'R'),
        ("later-to-before", 8, 1000, 'A', 'R'),
        ("before-to-after", 1, 8000, 'A', 'R'),
    ];
    let mut failures = Vec::new();
    for (change, index, millis, lift, extract) in CELLS {
        for (row, want) in [("range-lift", lift), ("range-extract", extract)] {
            println!("EXPECT film/range-edge/{row}/{change} {want}");
            let bytes = seed(row);
            let f = Fixture::from_bytes(&bytes, Default::default());
            let (q, basis) = f.inspect().await;
            rewrite(&f.file(), |p| {
                let seq = p.sequence_mut(ItemId(q["id"].as_u64().unwrap())).unwrap();
                if change == "inside-shrink" {
                    let clip = &mut seq.video_tracks[0].items[index];
                    clip.start.0 += SECOND / 4;
                    clip.source_in.0 += SECOND / 4;
                    clip.duration.0 = SECOND / 2;
                    return;
                }
                let id = seq.video_tracks[0].items[index].id;
                seq.video_tracks[0].transitions.retain(|tr| tr.from != Some(id) && tr.to != Some(id));
                let mut clip = seq.video_tracks[0].items.remove(index);
                clip.start.0 = SECOND * millis / 1000;
                seq.video_tracks[2].items.push(clip);
                seq.video_tracks[2].items.sort_by_key(|c| c.start);
            });
            let saved = std::fs::read(f.file()).unwrap();
            let answer = f.call("run", json!({"basis":basis,"steps":[step(row,&q)]})).await;
            let verdict = match (&answer, want) {
                (Ok(_), 'A') => merged(row, change, &bytes, &saved, &std::fs::read(f.file()).unwrap()).err(),
                (Err(e), 'R')
                    if e["error"]["code"] == "conflict" && e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == "relocated")) =>
                {
                    (std::fs::read(f.file()).unwrap() != saved).then(|| "a refusal wrote".to_owned())
                }
                (Ok(_), _) => Some("wrong write".to_owned()),
                (Err(e), _) => Some(format!("refused: {e}")),
            };
            println!("MATRIX film/range-edge/{row}/{change} {want} {}", verdict.as_deref().unwrap_or("PASS"));
            if let Err(error) = &answer {
                println!("CONFLICTS film/range-edge/{row}/{change} {}", error["conflicts"]);
            }
            if row == "range-lift" && change == "inside-shrink" {
                // Kit limit at SDK 34dff06: Lift reads no time, so its step is no place the guard
                // replays; a clip in the range is held by its start, and a head trim moves it.
                assert!(verdict.as_deref().is_some_and(|why| why.starts_with("refused")), "Lift's place changed: {verdict:?}");
                println!("KIT-DEFECT film/range-edge/{row}/{change}: Lift is no place");
                f.shutdown().await;
                continue;
            }
            if let Some(why) = verdict {
                failures.push(format!("{row}/{change}: {why}"));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
