//! Inputs consumed by trim, clipboard and repeated Find must appear in guards.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[test]
fn selected_trim_edges_change_the_declared_active_input() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let item = doc.execute("file.newColorMatte", json!({"seconds":2})).unwrap()["item"].clone();
    let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].clone();
    doc.execute("trim.selectEditPoint", json!({"clip":clip,"edge":"in"})).unwrap();
    let before = doc.editor_state()["active"].clone();
    doc.execute("trim.selectEditPoint", json!({"clip":clip,"edge":"out"})).unwrap();
    assert_ne!(doc.editor_state()["active"], before, "trim delegates consume the selected edge");
}

#[test]
fn repeated_find_changes_the_declared_mode_input() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    doc.execute("file.newColorMatte", json!({"name":"Needle","seconds":1})).unwrap();
    doc.execute("file.newColorMatte", json!({"name":"Needle second","seconds":1})).unwrap();
    doc.execute("edit.find", json!({"text":"Needle"})).unwrap();
    let before = doc.editor_state()["mode"].clone();
    doc.execute("edit.findNext", json!({})).unwrap();
    assert_ne!(doc.editor_state()["mode"], before, "Find Next consumes the prior result index");
}

#[test]
fn copying_a_different_clip_changes_the_declared_paste_mode_input() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let mut clips = Vec::new();
    for time in [0, 254_016_000_000i64] {
        let item = doc.execute("file.newColorMatte", json!({"seconds":1})).unwrap()["item"].clone();
        clips.push(doc.execute("timeline.place", json!({"item":item,"track":"V1","time":time})).unwrap()["clips"][0].clone());
    }
    doc.execute("timeline.select", json!({"clips":[clips[0]]})).unwrap();
    doc.execute("edit.copy", json!({})).unwrap();
    let before = doc.editor_state()["mode"].clone();
    doc.execute("timeline.select", json!({"clips":[clips[1]]})).unwrap();
    doc.execute("edit.copy", json!({})).unwrap();
    assert_ne!(doc.editor_state()["mode"], before, "paste consumes clipboard content");
}
