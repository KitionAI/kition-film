//! Regression: a marker reads back in the marker colour it was given
//! (Red, not the label name Rose, for the same colour); a label colour that is no marker colour
//! reads back as its label name.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

#[test]
fn markers_answer_the_colour_asked_for() {
    let mut doc = FilmDocument::create("Markers.kfilm", 64, 36).unwrap();
    run(&mut doc, "sequence.new", json!({ "name": "Edit", "width": 64, "height": 36, "fps": 24, "video": 1, "audio": 1 }));
    let item = run(&mut doc, "item.newColorMatte", json!({ "color": "#203040", "seconds": 10 }))["item"].clone();
    run(&mut doc, "timeline.place", json!({ "item": item, "track": "V1", "seconds": 0 }));
    let colours = ["Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Violet"];
    for (at, colour) in colours.iter().enumerate() {
        run(&mut doc, "marker.add", json!({ "seconds": at, "name": colour, "color": colour }));
    }
    // The label names of marker colours are the same colours, read back as the marker colours.
    run(&mut doc, "marker.add", json!({ "seconds": 9, "name": "Rose", "color": "rose" }));
    let markers = doc.inspect().unwrap()["sequence"]["markers"].clone();
    let read: Vec<(String, String)> =
        markers.as_array().unwrap().iter().map(|m| (m["name"].as_str().unwrap().to_owned(), m["color"].as_str().unwrap().to_owned())).collect();
    for colour in colours {
        assert!(read.contains(&(colour.to_owned(), colour.to_owned())), "{colour}: {read:?}");
    }
    assert!(read.contains(&("Rose".to_owned(), "Red".to_owned())), "{read:?}");
}
