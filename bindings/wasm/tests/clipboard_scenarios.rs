//! Clipboard lifetime and cross-sequence edits, independent of the reference editor.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

fn copied_layers() -> (FilmDocument, Vec<Value>) {
    let mut doc = FilmDocument::create("Clipboard.kfilm", 64, 36).unwrap();
    run(&mut doc, "file.newProject", json!({"name": "Clipboard boundaries"}));
    run(&mut doc, "file.newSequence", json!({"name": "Source", "width": 64, "height": 36, "fps": 24, "video": 2, "audio": 1}));
    let mut sources = Vec::new();
    for (track, color) in [("V1", "#ff0000"), ("V2", "#0000ff")] {
        let item = run(&mut doc, "file.newColorMatte", json!({"color": color, "seconds": 1}))["item"].clone();
        run(&mut doc, "timeline.place", json!({"item": item, "track": track, "seconds": 0}));
        sources.push(item);
    }
    let q = run(&mut doc, "sequence.inspect", json!({}));
    run(&mut doc, "timeline.select", json!({"clips": [q["video"][0]["items"][0]["clip"], q["video"][1]["items"][0]["clip"]]}));
    run(&mut doc, "edit.copy", json!({}));
    (doc, sources)
}

fn refused_without_changes(doc: &mut FilmDocument, command: &str, message: &str) {
    let saved = doc.save(None).unwrap();
    let state = doc.inspect().unwrap();
    let history = run(doc, "history.list", json!({}));
    let error = doc.execute(command, json!({})).expect_err("incomplete paste must be refused");
    assert!(error.contains(message), "actionable refusal: {error}");
    assert_eq!(doc.save(None).unwrap(), saved, "refused paste preserves saved content");
    assert_eq!(doc.inspect().unwrap(), state, "refused paste preserves selection and playhead");
    assert_eq!(run(doc, "history.list", json!({})), history, "refused paste adds no history");
}

#[test]
fn n11_cross_sequence_paste_never_collapses_layers_or_discards_sound() {
    for command in ["edit.paste", "edit.pasteInsert"] {
        let (mut doc, _) = copied_layers();
        run(&mut doc, "file.newSequence", json!({"name": "One track", "width": 64, "height": 36, "fps": 24, "video": 1, "audio": 1}));
        refused_without_changes(&mut doc, command, "track");
        // The same protection applies to linked sound when the destination has no audio track.
        run(&mut doc, "sequence.addTracks", json!({"video": 1}));
        let item = run(&mut doc, "file.newBarsAndTone", json!({"seconds": 1}))["item"].clone();
        run(&mut doc, "timeline.place", json!({"item": item, "seconds": 0}));
        let q = run(&mut doc, "sequence.inspect", json!({}));
        run(&mut doc, "timeline.select", json!({"clips": [q["video"][0]["items"][0]["clip"]]}));
        run(&mut doc, "edit.copy", json!({}));
        run(&mut doc, "file.newSequence", json!({"name": "No sound track", "width": 64, "height": 36, "fps": 24, "video": 1, "audio": 0}));
        refused_without_changes(&mut doc, command, "track A1");
    }
}

#[test]
fn n12_deleted_clipboard_source_cannot_create_dangling_timeline_items() {
    for command in ["edit.paste", "edit.pasteInsert"] {
        let (mut doc, sources) = copied_layers();
        run(&mut doc, "project.select", json!({"items": [sources[0]]}));
        run(&mut doc, "project.delete", json!({}));
        refused_without_changes(&mut doc, command, "source");
        // Undoing the deletion restores the source; the original clipboard is usable again.
        run(&mut doc, "edit.undo", json!({}));
        run(&mut doc, "playhead.set", json!({"frame": 24}));
        run(&mut doc, command, json!({}));
        let q = run(&mut doc, "sequence.inspect", json!({}));
        for (track, source) in sources.iter().enumerate() {
            let items = q["video"][track]["items"].as_array().unwrap();
            assert_eq!(items.len(), 2);
            assert_eq!(items[1]["item"], *source);
            assert_eq!(items[1]["startFrame"], 24);
        }
        let saved = doc.save(None).unwrap();
        let reopened = FilmDocument::open("Clipboard.kfilm", &saved).unwrap();
        assert_eq!(reopened.inspect().unwrap()["sequence"]["video"], q["video"]);
    }
}
