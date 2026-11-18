//! Regression: the commands that cut or mark at a time take it as the
//! other time-taking commands do: `seconds`, `frame` or `timecode` as well as `time` in ticks.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

const SECOND: i64 = 254_016_000_000;

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

fn fixture() -> FilmDocument {
    let mut doc = FilmDocument::create("Cuts.kfilm", 64, 36).unwrap();
    run(&mut doc, "file.newSequence", json!({ "name": "Edit", "width": 64, "height": 36, "fps": 24, "video": 1, "audio": 1 }));
    let item = run(&mut doc, "file.newColorMatte", json!({ "color": "#203040", "seconds": 6 }))["item"].clone();
    run(&mut doc, "timeline.place", json!({ "item": item, "track": "V1", "seconds": 0 }));
    doc
}

fn starts(doc: &FilmDocument) -> Vec<i64> {
    doc.inspect().unwrap()["sequence"]["video"][0]["items"].as_array().unwrap().iter().map(|item| item["start"].as_i64().unwrap()).collect()
}

#[test]
fn marks_and_cuts_take_seconds() {
    let mut doc = fixture();
    run(&mut doc, "markers.markIn", json!({ "seconds": 1.5 }));
    run(&mut doc, "markers.markOut", json!({ "frame": 96 }));
    let sequence = doc.inspect().unwrap()["sequence"].clone();
    assert_eq!(sequence["in"], json!(SECOND * 3 / 2), "{}", sequence["in"]);
    assert_eq!(sequence["out"], json!(SECOND * 4), "{}", sequence["out"]);

    run(&mut doc, "timeline.razor", json!({ "seconds": 2, "track": "V1" }));
    assert_eq!(starts(&doc), vec![0, 2 * SECOND]);
    run(&mut doc, "sequence.addEdit", json!({ "seconds": 3 }));
    run(&mut doc, "sequence.addEditAllTracks", json!({ "timecode": "00:00:05:00" }));
    assert_eq!(starts(&doc), vec![0, 2 * SECOND, 3 * SECOND, 5 * SECOND]);
}
