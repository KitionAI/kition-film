//! One caption action is one transaction, including automatic creation of its track.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

fn fixture() -> FilmDocument {
    let mut doc = FilmDocument::create("Captions.kfilm", 320, 180).unwrap();
    run(&mut doc, "file.newProject", json!({"name": "Caption transactions"}));
    run(&mut doc, "file.newSequence", json!({"name": "Captions", "width": 320, "height": 180, "fps": 24, "video": 1, "audio": 0}));
    doc
}

#[test]
fn n19_refused_first_caption_never_leaves_an_empty_track_or_history_step() {
    let mut changed = Vec::new();
    for params in [json!({"track": "C9"}), json!({"track": 999999}), json!({"time": i64::MAX})] {
        let mut doc = fixture();
        let before = doc.save(None).unwrap();
        let history = run(&mut doc, "history.list", json!({}));
        assert!(doc.execute("captions.add", params.clone()).is_err(), "invalid first caption must fail: {params}");
        if doc.save(None).unwrap() != before || run(&mut doc, "history.list", json!({})) != history {
            changed.push(params);
        }
    }
    assert!(changed.is_empty(), "refused caption changed the project: {changed:?}");
}

#[test]
fn n20_first_caption_and_its_track_are_one_undoable_action() {
    for params in [json!({"text": "First cue"}), json!({"track": "C1", "text": "First cue"})] {
        let mut doc = fixture();
        let history = run(&mut doc, "history.list", json!({}))["undo"].as_array().unwrap().len();
        run(&mut doc, "captions.add", params);
        assert_eq!(run(&mut doc, "history.list", json!({}))["undo"].as_array().unwrap().len(), history + 1);
        let tracks = run(&mut doc, "captions.list", json!({}))["tracks"].clone();
        assert_eq!(tracks[0]["captions"][0]["text"], "First cue");
        run(&mut doc, "edit.undo", json!({}));
        assert_eq!(run(&mut doc, "captions.list", json!({}))["tracks"], json!([]));
        run(&mut doc, "edit.redo", json!({}));
        assert_eq!(run(&mut doc, "captions.list", json!({}))["tracks"], tracks);
        let saved = doc.save(None).unwrap();
        let mut reopened = FilmDocument::open("Captions.kfilm", &saved).unwrap();
        assert_eq!(run(&mut reopened, "captions.list", json!({}))["tracks"], tracks);
    }
}
