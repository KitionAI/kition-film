//! Pending mixer gestures belong to the project and sequence where they began.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

const SECOND: i64 = 254_016_000_000;

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

fn new_project(doc: &mut FilmDocument) {
    run(doc, "file.newProject", json!({"name": "Mixer context"}));
    new_sequence(doc);
}

fn new_sequence(doc: &mut FilmDocument) {
    run(doc, "file.newSequence", json!({"name": "Same layout", "width": 64, "height": 36, "fps": 24, "video": 1, "audio": 1}));
}

#[test]
fn n13_unfinished_automation_cannot_write_into_a_replacement_project_with_reused_ids() {
    let mut doc = FilmDocument::create("Mixer.kfilm", 64, 36).unwrap();
    new_project(&mut doc);
    run(&mut doc, "mixer.setStrip", json!({"strip": "A1", "mode": "Latch"}));
    run(&mut doc, "mixer.recordStart", json!({"time": 0}));
    run(&mut doc, "mixer.touch", json!({"strip": "A1", "lane": "volume", "value": -12, "time": 0}));
    new_project(&mut doc);
    let saved = doc.save(None).unwrap();
    let history = run(&mut doc, "history.list", json!({}));
    run(&mut doc, "mixer.recordStop", json!({"time": SECOND}));
    assert!(doc.save(None).unwrap() == saved, "old automation must not modify a replacement project");
    assert_eq!(run(&mut doc, "history.list", json!({})), history);
    let mix = run(&mut doc, "mixer.inspect", json!({}));
    assert_eq!(mix["recording"], false);
    assert_eq!(mix["strips"][0]["lanes"], json!({}));
    // A fresh recording remains available after the cancelled pass.
    run(&mut doc, "mixer.setStrip", json!({"strip": "A1", "mode": "Latch"}));
    run(&mut doc, "mixer.recordStart", json!({"time": 0}));
    run(&mut doc, "mixer.touch", json!({"strip": "A1", "lane": "volume", "value": -6, "time": 0}));
    run(&mut doc, "mixer.recordStop", json!({"time": SECOND}));
    assert_eq!(run(&mut doc, "mixer.inspect", json!({}))["strips"][0]["lanes"]["volume"], json!([[0, -6.0], [SECOND, -6.0]]));
}

#[test]
fn n14_held_master_fader_cannot_commit_after_project_or_sequence_switch() {
    for replace_project in [true, false] {
        let mut doc = FilmDocument::create("Mixer.kfilm", 64, 36).unwrap();
        new_project(&mut doc);
        run(&mut doc, "mixer.touch", json!({"strip": "Mix", "lane": "volume", "value": -12, "time": 0}));
        if replace_project {
            new_project(&mut doc);
        } else {
            new_sequence(&mut doc);
        }
        let saved = doc.save(None).unwrap();
        let history = run(&mut doc, "history.list", json!({}));
        run(&mut doc, "mixer.release", json!({"strip": "Mix", "lane": "volume", "time": 0}));
        assert!(doc.save(None).unwrap() == saved, "old fader gesture must not modify a different context");
        assert_eq!(run(&mut doc, "history.list", json!({})), history);
        let mix = run(&mut doc, "mixer.inspect", json!({}));
        let master = mix["strips"].as_array().unwrap().iter().find(|strip| strip["ref"] == "Mix").unwrap();
        assert_eq!(master["volumeDb"], 0.0);
        assert_eq!(master["at"]["volumeDb"], 0.0, "preview audio must not retain the old held value");
    }
}

fn multicam_project(doc: &mut FilmDocument) {
    run(doc, "file.newProject", json!({"name": "Multicam context"}));
    let source = run(doc, "file.newSequence", json!({"name": "Cameras", "width": 64, "height": 36, "fps": 24, "video": 2, "audio": 1}))["sequence"].clone();
    for (track, color) in [("V1", "#ff0000"), ("V2", "#0000ff")] {
        let item = run(doc, "file.newColorMatte", json!({"color": color, "seconds": 2}))["item"].clone();
        run(doc, "timeline.place", json!({"item": item, "track": track, "seconds": 0}));
    }
    new_sequence(doc);
    run(doc, "timeline.place", json!({"item": source, "seconds": 0}));
    let q = run(doc, "sequence.inspect", json!({}));
    run(doc, "timeline.select", json!({"clips": [q["video"][0]["items"][0]["clip"]]}));
    run(doc, "clip.multicamEnable", json!({"enabled": true}));
}

#[test]
fn n15_multicam_recording_cannot_reapply_old_cuts_to_a_replacement_project() {
    let mut doc = FilmDocument::create("Cameras.kfilm", 64, 36).unwrap();
    multicam_project(&mut doc);
    run(&mut doc, "multicam.recordStart", json!({"time": 0}));
    run(&mut doc, "multicam.cut", json!({"camera": 2, "time": SECOND}));
    multicam_project(&mut doc);
    let before = doc.save(None).unwrap();
    let history = run(&mut doc, "history.list", json!({}));
    run(&mut doc, "multicam.recordStop", json!({"time": 2 * SECOND}));
    assert!(doc.save(None).unwrap() == before, "old camera cuts must not modify a replacement project");
    assert_eq!(run(&mut doc, "history.list", json!({})), history);
}
