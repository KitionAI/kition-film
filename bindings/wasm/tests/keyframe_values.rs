//! Regression: a keyframe asked for at a clip's exact end is kept
//! there, not a tick before; keyframes of a value that cannot interpolate (Source Text) say they
//! hold; and a shape's path points read back as they were given, not as f32 noise.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

const SECOND: i64 = 254_016_000_000;

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

fn fixture() -> FilmDocument {
    let mut doc = FilmDocument::create("Keys.kfilm", 1280, 720).unwrap();
    run(&mut doc, "file.newSequence", json!({ "name": "Edit", "width": 1280, "height": 720, "fps": 24, "video": 2, "audio": 1 }));
    doc
}

fn effects(doc: &FilmDocument, track: usize) -> Value {
    doc.inspect().unwrap()["sequence"]["video"][track]["items"][0]["effects"].clone()
}

#[test]
fn a_keyframe_at_the_clip_end_stays_there() {
    let mut doc = fixture();
    let item = run(&mut doc, "file.newColorMatte", json!({ "color": "#203040", "seconds": 6 }))["item"].clone();
    let clip = run(&mut doc, "timeline.place", json!({ "item": item, "track": "V1", "seconds": 0 }))["clips"][0].clone();
    run(&mut doc, "effects.setParam", json!({ "clip": clip, "effect": "opacity", "param": "opacity", "value": 100, "seconds": 0 }));
    run(&mut doc, "effects.setParam", json!({ "clip": clip, "effect": "opacity", "param": "opacity", "value": 0, "seconds": 6 }));
    let keys = effects(&doc, 0)[1]["params"]["opacity"]["keyframes"].clone();
    assert_eq!(keys[1]["time"], json!(6 * SECOND), "{keys}");
    assert_eq!(keys[1]["mediaTime"], json!(6 * SECOND), "{keys}");
    // Past the end is still the end.
    run(&mut doc, "effects.setParam", json!({ "clip": clip, "effect": "opacity", "param": "opacity", "value": 50, "seconds": 9 }));
    let keys = effects(&doc, 0)[1]["params"]["opacity"]["keyframes"].clone();
    assert_eq!(keys.as_array().unwrap().len(), 2, "{keys}");
    assert_eq!(keys[1]["value"], json!(50.0), "{keys}");
}

#[test]
fn text_keyframes_hold_and_path_points_read_back_as_given() {
    let mut doc = fixture();
    let made = run(&mut doc, "graphics.newText", json!({ "text": "3", "position": [640, 360], "size": 200 }));
    let clip = made["clip"].clone();
    let text_effect = effects(&doc, 0).as_array().unwrap().len() - 1;
    for (at, text) in ["3", "2", "1"].iter().enumerate() {
        run(&mut doc, "effects.setParam", json!({ "clip": clip, "effect": text_effect, "param": "text", "value": text, "seconds": at }));
    }
    let keys = effects(&doc, 0)[text_effect]["params"]["text"]["keyframes"].clone();
    assert_eq!(keys.as_array().unwrap().len(), 3, "{keys}");
    for key in keys.as_array().unwrap() {
        assert_eq!(key["interpolation"], json!("hold"), "Source Text holds: {keys}");
    }

    run(
        &mut doc,
        "graphics.newShape",
        json!({ "clip": clip, "shape": "path", "position": [0, 0], "points": [[0, 0], [720.4, 0], [560, 720.1], [-196.2, 720]] }),
    );
    let listed = run(&mut doc, "graphics.list", json!({ "clip": clip }));
    let text = listed.to_string() + &effects(&doc, 0).to_string();
    for given in ["720.4", "720.1", "-196.2"] {
        assert!(text.contains(given), "{given} reads back as given: {listed}");
    }
    assert!(!text.contains("720.4000244140625") && !text.contains("-196.1999969482422"), "no f32 noise: {listed}");
}
