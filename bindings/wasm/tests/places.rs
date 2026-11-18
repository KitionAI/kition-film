//! What a command names by its place (task card C8-film-2): `KitCommand::places` names only
//! parameters the command takes, and `KitDocument::under` answers the clips under the step's time
//! on the tracks the command acts on, with each track's window of them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument};
use serde_json::{Value, json};

/// Ticks in a second.
const SECOND: i64 = 254_016_000_000;

/// A project of `clips` one-second colour mattes end to end on V1: the document, the clip ids and
/// the last matte's item.
fn project(clips: usize) -> (FilmDocument, Vec<u64>, u64) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let mut ids = Vec::new();
    let mut item = 0;
    for n in 0..clips {
        let matte = doc.execute("file.newColorMatte", json!({ "color": "#336699", "seconds": 1 })).unwrap();
        item = matte["item"].as_u64().unwrap();
        let placed = doc.execute("timeline.place", json!({ "item": item, "track": "V1", "seconds": n })).unwrap();
        ids.push(placed["clips"][0].as_u64().unwrap());
    }
    (doc, ids, item)
}

fn track_ids(doc: &FilmDocument) -> (u64, u64) {
    let seen = doc.inspect().unwrap();
    (seen["sequence"]["video"][0]["id"].as_u64().unwrap(), seen["sequence"]["video"][1]["id"].as_u64().unwrap())
}

fn under(doc: &FilmDocument, command: &str, params: Value) -> (Vec<Value>, Vec<(Value, usize, usize)>) {
    let found = doc.under(command, &params).unwrap().unwrap_or_else(|| panic!("{command} tells its place"));
    (found.objects, found.within.into_iter().map(|w| (w.parent, w.from, w.to)).collect())
}

#[test]
fn every_place_is_a_parameter_of_its_command_and_names_no_object() {
    let (doc, _, _) = project(1);
    let mut with_places = 0;
    for command in doc.commands() {
        if command.places.is_empty() {
            continue;
        }
        with_places += 1;
        let schema = command.schema.as_ref().unwrap();
        for place in command.places {
            assert!(schema.get(*place).is_some(), "{}: `{place}` is no parameter of it", command.id);
            assert_ne!(command.targets, Some(*place), "{}", command.id);
        }
        let state = if matches!(command.id.as_str(), "timeline.move" | "sequence.addTracks") { EditorState::Part } else { EditorState::Time };
        assert!(command.reads.contains(&state), "{}: its destination is read from {state:?}", command.id);
        if command.id == "timeline.move" {
            assert!(!command.reads.contains(&EditorState::Time), "nested destinations use their own times");
            assert_eq!(command.places, ["moves"]);
        }
        if command.id == "sequence.addTracks" {
            assert!(!command.reads.contains(&EditorState::Time));
            assert_eq!(command.places, ["videoAfter", "audioAfter", "submixAfter"]);
        }
    }
    assert!(with_places >= 20, "{with_places}");
    let place = doc.commands().into_iter().find(|command| command.id == "timeline.place").unwrap();
    assert_eq!(place.targets, None, "Place Clip acts at its place; its item is what it puts there");
}

#[test]
fn a_razor_names_the_clip_under_its_time_on_its_track_or_every_unlocked_track() {
    let (mut doc, clips, _) = project(4);
    let (v1, v2) = track_ids(&doc);
    // Its own time, in seconds, on V1.
    let (objects, within) = under(&doc, "timeline.razor", json!({ "track": "V1", "seconds": 2.5 }));
    assert_eq!(objects, [json!(clips[2])]);
    assert_eq!(within, [(json!(v1), 2, 3)]);
    // The playhead, on every unlocked track: V2 holds nothing there (an empty window).
    doc.execute("playhead.set", json!({ "seconds": 1.5 })).unwrap();
    let (objects, within) = under(&doc, "timeline.razor", json!({}));
    assert_eq!(objects, [json!(clips[1])]);
    assert!(within.contains(&(json!(v1), 1, 2)) && within.contains(&(json!(v2), 0, 0)), "{within:?}");
    doc.execute("timeline.setTrack", json!({ "track": "V2", "locked": true })).unwrap();
    let (_, within) = under(&doc, "timeline.razor", json!({}));
    assert!(!within.iter().any(|(track, _, _)| *track == json!(v2)), "a locked track is not cut: {within:?}");
    // At a cut, the clip that starts there; past the end, where a clip would go.
    let (objects, _) = under(&doc, "timeline.razor", json!({ "track": "V1", "time": 2 * SECOND }));
    assert_eq!(objects, [json!(clips[2])]);
    let (objects, within) = under(&doc, "timeline.razor", json!({ "track": "V1", "seconds": 9 }));
    assert!(objects.is_empty());
    assert_eq!(within, [(json!(v1), 4, 4)]);
    assert!(doc.under("timeline.razor", &json!({ "track": "V9" })).is_err(), "a track the sequence lacks");
}

#[test]
fn an_overwrite_names_every_clip_it_covers_and_an_insert_the_one_it_splits() {
    let (mut doc, clips, item) = project(4);
    let (v1, _) = track_ids(&doc);
    doc.execute("playhead.set", json!({ "seconds": 1.5 })).unwrap();
    let (objects, within) = under(&doc, "timeline.place", json!({ "item": item, "track": "V1", "insert": true }));
    assert_eq!(objects, [json!(clips[1])]);
    assert!(within.contains(&(json!(v1), 1, 2)), "{within:?}");
    let (objects, _) = under(&doc, "timeline.place", json!({ "item": item, "track": "V1" }));
    assert_eq!(objects, [json!(clips[1]), json!(clips[2])], "a one-second clip put at 1.5 s covers two");
}

#[test]
fn a_marker_names_what_is_under_its_time_and_a_playhead_move_nothing() {
    let (mut doc, clips, _) = project(3);
    let (objects, within) = under(&doc, "markers.add", json!({ "seconds": 1.25 }));
    assert_eq!(objects, [json!(clips[1])]);
    assert!(within.len() >= 2, "every track: {within:?}");
    let (objects, within) = under(&doc, "markers.add", json!({ "target": "source", "seconds": 1.25 }));
    assert!(objects.is_empty() && within.is_empty(), "a source marker has no place in the sequence");
    doc.execute("playhead.set", json!({ "seconds": 0.5 })).unwrap();
    let (objects, within) = under(&doc, "playhead.set", json!({ "seconds": 2.5 }));
    assert!(objects.is_empty() && within.is_empty());
    let (objects, _) = under(&doc, "timeline.selectClipAtPlayhead", json!({}));
    assert_eq!(objects, [json!(clips[0])]);
}
