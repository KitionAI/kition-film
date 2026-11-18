//! Project deletion must not strand subclips whose media live in another bin.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

#[test]
fn n21_deleting_a_subclip_parent_is_atomic_and_deleting_both_is_undoable() {
    let mut doc = FilmDocument::create("Subclip.kfilm", 64, 36).unwrap();
    run(&mut doc, "file.newProject", json!({"name": "Subclip dependencies"}));
    run(&mut doc, "file.newSequence", json!({"name": "Subclip", "width": 64, "height": 36, "fps": 24, "video": 1, "audio": 0}));
    let parent = run(&mut doc, "file.newColorMatte", json!({"color": "#ff0000", "seconds": 2}))["item"].clone();
    run(&mut doc, "project.select", json!({"items": [parent]}));
    let subclip = run(&mut doc, "clip.makeSubclip", json!({"item": parent, "startFrame": 12, "endFrame": 24, "name": "Dependent subclip"}))["item"].clone();
    run(&mut doc, "timeline.place", json!({"item": subclip, "seconds": 0}));
    let timeline = doc.inspect().unwrap()["sequence"]["video"].clone();
    run(&mut doc, "project.select", json!({"items": [parent]}));
    let before = doc.save(None).unwrap();
    let history = run(&mut doc, "history.list", json!({}));
    let error = doc.execute("project.delete", json!({})).expect_err("a source with surviving dependent subclips must not be deleted");
    assert!(error.contains("subclip"), "actionable refusal: {error}");
    assert_eq!(doc.save(None).unwrap(), before);
    assert_eq!(run(&mut doc, "history.list", json!({})), history);
    run(&mut doc, "source.open", json!({"item": subclip}));
    run(&mut doc, "source.inspect", json!({}));
    // Explicitly selecting the source and its dependent subclip removes all their timeline uses.
    run(&mut doc, "project.select", json!({"items": [parent, subclip]}));
    run(&mut doc, "project.delete", json!({}));
    assert_eq!(doc.inspect().unwrap()["sequence"]["video"][0]["items"], json!([]));
    run(&mut doc, "edit.undo", json!({}));
    assert_eq!(doc.inspect().unwrap()["sequence"]["video"], timeline);
    let saved = doc.save(None).unwrap();
    let mut reopened = FilmDocument::open("Subclip.kfilm", &saved).unwrap();
    assert_eq!(reopened.inspect().unwrap()["sequence"]["video"], timeline);
    run(&mut reopened, "source.open", json!({"item": subclip}));
    run(&mut reopened, "source.inspect", json!({}));
}

#[test]
fn n22_deleting_a_bin_cannot_strand_a_subclip_in_another_bin() {
    let mut doc = FilmDocument::create("Bins.kfilm", 64, 36).unwrap();
    run(&mut doc, "file.newProject", json!({"name": "Bin dependencies"}));
    let bin = run(&mut doc, "file.newBin", json!({"name": "Originals"}))["bin"].clone();
    let parent = run(&mut doc, "file.newColorMatte", json!({"color": "#ff0000", "seconds": 2}))["item"].clone();
    let subclip = run(&mut doc, "clip.makeSubclip", json!({"item": parent, "startFrame": 12, "endFrame": 24}))["item"].clone();
    run(&mut doc, "project.moveToBin", json!({"items": [parent], "bin": bin}));
    run(&mut doc, "project.select", json!({"items": [bin]}));
    let saved = doc.save(None).unwrap();
    let history = run(&mut doc, "history.list", json!({}));
    assert!(doc.execute("project.delete", json!({})).unwrap_err().contains("subclip"));
    assert_eq!(doc.save(None).unwrap(), saved);
    assert_eq!(run(&mut doc, "history.list", json!({})), history);
    run(&mut doc, "project.moveToBin", json!({"items": [subclip], "bin": bin}));
    run(&mut doc, "project.select", json!({"items": [bin]}));
    let before = doc.save(None).unwrap();
    let removed = run(&mut doc, "project.delete", json!({}));
    assert_eq!(removed, json!({"items": 2, "bins": 1}));
    run(&mut doc, "edit.undo", json!({}));
    let mut restored: Value = serde_json::from_slice(&doc.save(None).unwrap()).unwrap();
    let mut expected: Value = serde_json::from_slice(&before).unwrap();
    // Undo reserves a fresh ID range for future replicated edits; document content must match.
    restored["project"].as_object_mut().unwrap().remove("next_id");
    expected["project"].as_object_mut().unwrap().remove("next_id");
    assert_eq!(restored, expected);
    run(&mut doc, "source.open", json!({"item": subclip}));
    run(&mut doc, "source.inspect", json!({}));
}
