//! Regression: inspect answers a transition's parameters as it
//! answers a clip effect's, in the form the commands take (`{value}`, and a choice's `option`), not
//! as the project's tagged values.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

#[test]
fn transition_params_read_back_as_commands_take_them() {
    let mut doc = FilmDocument::create("Iris.kfilm", 64, 36).unwrap();
    run(&mut doc, "sequence.new", json!({ "name": "Edit", "width": 64, "height": 36, "fps": 24, "video": 1, "audio": 1 }));
    let first = run(&mut doc, "item.newColorMatte", json!({ "color": "#203040", "seconds": 2 }))["item"].clone();
    let second = run(&mut doc, "item.newColorMatte", json!({ "color": "#c08040", "seconds": 2 }))["item"].clone();
    run(&mut doc, "timeline.place", json!({ "item": first, "track": "V1", "seconds": 0 }));
    let placed = run(&mut doc, "timeline.place", json!({ "item": second, "track": "V1", "seconds": 2 }));
    let clip = placed["clips"][0].clone();
    run(
        &mut doc,
        "sequence.applyVideoTransition",
        json!({ "clip": clip, "edge": "in", "effect": "iris_round", "frames": 12, "params": { "border_width": 6, "border_color": "#ffd9a0" } }),
    );
    let params = doc.inspect().unwrap()["sequence"]["video"][0]["transitions"][0]["params"].clone();
    assert_eq!(params["border_width"], json!({ "value": 6.0 }), "{params}");
    assert_eq!(params["border_color"], json!({ "value": "#ffd9a0" }), "{params}");
    assert_eq!(params["antialias"]["value"], json!(1), "{params}");
    assert!(params["antialias"]["option"].is_string(), "a choice names its option: {params}");
    assert_eq!(params["center"], json!({ "value": [null, null] }), "an automatic centre is null, as effect.setParam takes it: {params}");
}
