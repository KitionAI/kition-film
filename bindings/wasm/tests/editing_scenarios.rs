//! Independent workflow regressions, using only original generated media.
//! The reference editor informed the expected behavior during review; it is never a runtime dependency.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

const SECOND: i64 = 254_016_000_000;
const FRAME: i64 = SECOND / 24;

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

fn sequence(doc: &FilmDocument) -> Value {
    doc.inspect().unwrap()["sequence"].clone()
}

fn fixture() -> FilmDocument {
    let mut doc = FilmDocument::create("Scenario.kfilm", 64, 36).unwrap();
    run(&mut doc, "file.newProject", json!({"name": "Original comparison fixture"}));
    run(&mut doc, "sequence.new", json!({"name": "24 fps edit", "width": 64, "height": 36, "fps": 24, "video": 2, "audio": 2}));
    let item = run(&mut doc, "item.newBarsAndTone", json!({"seconds": 4}))["item"].clone();
    run(&mut doc, "timeline.place", json!({"item": item, "track": "V1", "seconds": 0}));
    doc
}

fn content(q: &Value) -> Value {
    json!({"video": q["video"], "audio": q["audio"], "markers": q["markers"], "duration": q["duration"], "settings": q["settings"]})
}

fn round_trip(doc: &FilmDocument) -> FilmDocument {
    let saved = doc.save(None).unwrap();
    let reopened = FilmDocument::open("Scenario.kfilm", &saved).unwrap();
    assert_eq!(content(&sequence(&reopened)), content(&sequence(doc)), "save/reopen preserves editable content");
    reopened
}

#[test]
fn n01_linked_cut_preserves_source_ranges_history_and_saved_project() {
    let mut doc = fixture();
    let before = sequence(&doc);
    run(&mut doc, "sequence.addEdit", json!({"time": 48 * FRAME}));
    let after = sequence(&doc);
    for kind in ["video", "audio"] {
        let items = after[kind][0]["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["durationFrames"], 48);
        assert_eq!(items[1]["durationFrames"], 48);
        assert_eq!(items[0]["sourceIn"], 0);
        assert_eq!(items[0]["sourceOut"], 2 * SECOND);
        assert_eq!(items[1]["sourceIn"], 2 * SECOND);
        assert_eq!(items[1]["sourceOut"], 4 * SECOND);
    }
    run(&mut doc, "edit.undo", json!({}));
    assert_eq!(content(&sequence(&doc)), content(&before));
    run(&mut doc, "edit.redo", json!({}));
    assert_eq!(content(&sequence(&doc)), content(&after));
    round_trip(&doc);
}

#[test]
fn n02_locked_sound_stays_while_linked_picture_moves_and_undo_restores_it() {
    let mut doc = fixture();
    let clip = sequence(&doc)["video"][0]["items"][0]["clip"].clone();
    run(&mut doc, "timeline.setTrack", json!({"track": "A1", "locked": true}));
    let before = sequence(&doc);
    run(&mut doc, "timeline.move", json!({"moves": [{"clip": clip, "track": "V1", "time": SECOND}]}));
    let moved = sequence(&doc);
    assert_eq!(moved["video"][0]["items"][0]["startFrame"], 24);
    assert_eq!(moved["audio"], before["audio"]);
    round_trip(&doc);
    run(&mut doc, "edit.undo", json!({}));
    assert_eq!(content(&sequence(&doc)), content(&before));
}

#[test]
fn n03_invalid_second_move_is_atomic_and_leaves_history_and_saved_bytes_unchanged() {
    let mut doc = fixture();
    let before = doc.save(None).unwrap();
    let history = run(&mut doc, "history.list", json!({}));
    let clip = sequence(&doc)["video"][0]["items"][0]["clip"].clone();
    assert!(
        doc.execute(
            "timeline.move",
            json!({"moves": [
                {"clip": clip, "track": "V1", "time": SECOND},
                {"clip": 999999, "track": "V1", "time": 2 * SECOND}
            ]})
        )
        .is_err()
    );
    assert_eq!(doc.save(None).unwrap(), before);
    assert_eq!(run(&mut doc, "history.list", json!({})), history);
    round_trip(&doc);
}

#[test]
fn n04_regular_trim_shortens_linked_picture_and_sound_by_exactly_twenty_four_frames() {
    let mut doc = fixture();
    let before = sequence(&doc);
    let clip = before["video"][0]["items"][0]["clip"].clone();
    run(&mut doc, "timeline.trim", json!({"clip": clip, "edge": "out", "mode": "regular", "deltaFrames": -24}));
    let after = sequence(&doc);
    for kind in ["video", "audio"] {
        assert_eq!(after[kind][0]["items"][0]["durationFrames"], 72);
        assert_eq!(after[kind][0]["items"][0]["sourceOut"], 3 * SECOND);
    }
    round_trip(&doc);
    run(&mut doc, "edit.undo", json!({}));
    assert_eq!(content(&sequence(&doc)), content(&before));
    run(&mut doc, "edit.redo", json!({}));
    assert_eq!(content(&sequence(&doc)), content(&after));
}

#[test]
fn n05_bad_trim_and_move_parameters_never_panic_or_damage_the_project() {
    let cases = [
        ("timeline.trim", json!({"edge": "out", "deltaFrames": i64::MAX})),
        ("timeline.trim", json!({"edge": "in", "deltaFrames": i64::MIN})),
        ("timeline.trim", json!({"edge": "bad", "deltaFrames": -1})),
        ("timeline.trim", json!({"mode": "bad", "deltaFrames": -1})),
        ("timeline.trim", json!({"edge": true, "deltaFrames": -1})),
        ("timeline.trim", json!({"deltaFrames": "12"})),
        ("timeline.trim", json!({"delta": false})),
        ("timeline.slip", json!({"deltaFrames": i64::MAX})),
        ("timeline.slide", json!({"deltaFrames": i64::MIN})),
        ("timeline.rateStretch", json!({"edge": "bad", "deltaFrames": -1})),
        ("timeline.move", json!({"moves": [{"clip": 999999, "track": "V1", "time": i64::MAX}]})),
    ];
    for (command, mut params) in cases {
        let mut doc = fixture();
        params["clip"] = sequence(&doc)["video"][0]["items"][0]["clip"].clone();
        let before = doc.save(None).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| doc.execute(command, params.clone())));
        assert!(result.is_ok(), "{command} panicked for {params}");
        let error = result.unwrap().expect_err(&format!("hostile {command} should be refused: {params}"));
        assert!(!error.contains("internal error"), "a caught engine panic is still a bug: {error}");
        assert_eq!(doc.save(None).unwrap(), before, "failed {command} preserves the project");
        round_trip(&doc);
    }
}

#[test]
fn n06_new_edit_after_undo_clears_redo_and_survives_reopen() {
    let mut doc = fixture();
    run(&mut doc, "sequence.addEdit", json!({"time": SECOND}));
    run(&mut doc, "edit.undo", json!({}));
    assert_eq!(doc.inspect().unwrap()["canRedo"], true);
    run(&mut doc, "sequence.addEdit", json!({"time": 2 * SECOND}));
    assert_eq!(doc.inspect().unwrap()["canRedo"], false);
    let reopened = round_trip(&doc);
    assert_eq!(sequence(&reopened)["video"][0]["items"][0]["durationFrames"], 48);
}

#[test]
fn n07_extreme_playhead_steps_never_panic_or_wrap_backwards() {
    for frames in [i64::MAX, i64::MIN] {
        let mut doc = fixture();
        run(&mut doc, "playhead.set", json!({"frame": 24}));
        let before = doc.save(None).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| doc.execute("playhead.step", json!({"frames": frames}))));
        assert!(result.is_ok(), "playhead.step panicked for {frames}");
        match result.unwrap() {
            Ok(_) => {
                let at = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
                assert!(at >= 0);
                if frames > 0 {
                    assert!(at >= SECOND, "forward step must not jump backwards");
                }
            }
            Err(error) => assert!(!error.contains("internal error"), "a caught engine panic is still a bug: {error}"),
        }
        assert_eq!(doc.save(None).unwrap(), before, "seeking never changes saved project content");
    }
}

#[test]
fn n08_unicode_captions_split_merge_lock_export_and_reopen() {
    let mut doc = fixture();
    let caption = run(&mut doc, "caption.add", json!({"time": SECOND, "durationSeconds": 1, "text": "你好 🌊"}))["caption"].clone();
    let split = run(&mut doc, "caption.split", json!({"caption": caption, "time": SECOND + SECOND / 2}));
    let right = split["captions"][0].clone();
    let list = run(&mut doc, "caption.list", json!({}));
    let cues = list["tracks"][0]["captions"].as_array().unwrap();
    assert_eq!(cues.len(), 2);
    assert_eq!(cues[0]["end"], SECOND + SECOND / 2);
    assert_eq!(cues[1]["start"], SECOND + SECOND / 2);
    assert_eq!(cues[1]["end"], 2 * SECOND);
    run(&mut doc, "caption.setText", json!({"caption": right, "text": "Second line"}));
    run(&mut doc, "caption.merge", json!({"captions": [caption, right]}));
    let merged = run(&mut doc, "caption.list", json!({}))["tracks"].clone();
    assert_eq!(merged[0]["captions"][0]["text"], "你好 🌊\nSecond line");
    run(&mut doc, "edit.undo", json!({}));
    assert_eq!(run(&mut doc, "caption.list", json!({}))["tracks"][0]["captions"].as_array().unwrap().len(), 2);
    run(&mut doc, "edit.redo", json!({}));
    assert_eq!(run(&mut doc, "caption.list", json!({}))["tracks"], merged);
    run(&mut doc, "caption.setTrack", json!({"track": "C1", "locked": true}));
    let locked = doc.save(None).unwrap();
    assert!(doc.execute("caption.setText", json!({"caption": caption, "text": "Must not replace"})).is_err());
    assert_eq!(doc.save(None).unwrap(), locked);
    run(&mut doc, "caption.setTrack", json!({"track": "C1", "locked": false}));
    run(&mut doc, "caption.export", json!({"path": "original.srt"}));
    let srt = String::from_utf8(doc.take_file("original.srt").unwrap()).unwrap().replace("\r\n", "\n");
    assert_eq!(srt.trim_start_matches('\u{feff}'), "1\n00:00:01,000 --> 00:00:02,000\n你好 🌊\nSecond line\n\n");
    let mut reopened = round_trip(&doc);
    assert_eq!(run(&mut reopened, "caption.list", json!({}))["tracks"], merged);
}

#[test]
fn n09_damaged_saved_projects_fail_safely_or_round_trip_as_valid_documents() {
    let doc = fixture();
    let bytes = doc.save(None).unwrap();
    let mut cases = Vec::new();
    for length in [0, 1, 4, bytes.len() / 2, bytes.len() - 1] {
        cases.push((format!("truncated to {length}"), bytes[..length].to_vec()));
    }
    for offset in (0..bytes.len()).step_by((bytes.len() / 24).max(1)) {
        let mut damaged = bytes.clone();
        damaged[offset] ^= 0xff;
        cases.push((format!("bit flips at {offset}"), damaged));
    }
    for (description, damaged) in cases {
        let result = std::panic::catch_unwind(|| {
            if let Ok(opened) = FilmDocument::open("Damaged.kfilm", &damaged) {
                // A mutation can still be valid (for example a harmless metadata field).
                // Accepted content must remain inspectable and serializable.
                let expected = content(&sequence(&opened));
                let saved = opened.save(None).unwrap();
                let reopened = FilmDocument::open("Accepted.kfilm", &saved).unwrap();
                assert_eq!(content(&sequence(&reopened)), expected);
            }
        });
        assert!(result.is_ok(), "damaged project panicked: {description}");
    }
    // After rejecting damaged inputs, a valid project still opens and can be edited.
    let mut valid = FilmDocument::open("Valid.kfilm", &bytes).unwrap();
    run(&mut valid, "sequence.addEdit", json!({"time": SECOND}));
    assert_eq!(sequence(&valid)["video"][0]["items"].as_array().unwrap().len(), 2);
    round_trip(&valid);
}

#[test]
fn n10_history_retention_keeps_two_hundred_steps_and_preserves_evicted_content() {
    let mut doc = fixture();
    let mut retained_floor = Value::Null;
    for index in 0..205 {
        run(&mut doc, "marker.add", json!({"time": index * FRAME, "name": format!("Original marker {index}"), "target": "program"}));
        if index == 4 {
            retained_floor = content(&sequence(&doc));
        }
    }
    let after = content(&sequence(&doc));
    let history = run(&mut doc, "history.list", json!({}));
    assert_eq!(history["undo"].as_array().unwrap().len(), 200);
    assert_eq!(after["markers"].as_array().unwrap().len(), 205);
    round_trip(&doc);
    for _ in 0..200 {
        run(&mut doc, "edit.undo", json!({}));
    }
    assert_eq!(content(&sequence(&doc)), retained_floor, "evicting history never removes the five oldest markers");
    assert_eq!(doc.inspect().unwrap()["canUndo"], false);
    round_trip(&doc);
    for _ in 0..200 {
        run(&mut doc, "edit.redo", json!({}));
    }
    assert_eq!(content(&sequence(&doc)), after);
    assert_eq!(doc.inspect().unwrap()["canRedo"], false);
    for _ in 0..10 {
        run(&mut doc, "edit.undo", json!({}));
    }
    run(&mut doc, "marker.add", json!({"time": 3 * SECOND, "name": "New branch after retention", "target": "program"}));
    assert_eq!(doc.inspect().unwrap()["canRedo"], false);
    assert_eq!(sequence(&doc)["markers"].as_array().unwrap().len(), 196);
    round_trip(&doc);
}
