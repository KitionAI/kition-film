//! A `.kfilm` holds the project only: what one person has open (the sequence tabs, the active one,
//! the nest toggle, each sequence's zoom) is their view state, which the host keeps apart from the
//! file (Kit UI protocol 7n). So two sessions that open the same file and save it without an edit
//! write the same bytes, the file's own.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

/// A project of two sequences (a red matte on the first), saved: what both sessions open.
fn two_sequences() -> (Vec<u8>, u64) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let matte = doc.execute("file.newColorMatte", json!({ "color": "#ff0000", "seconds": 4.0 })).unwrap();
    doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0.0 })).unwrap();
    let second = doc.execute("file.newSequence", json!({ "name": "B" })).unwrap()["sequence"].as_u64().unwrap();
    (doc.save(None).unwrap(), second)
}

#[test]
fn two_sessions_that_open_the_same_file_and_save_without_editing_write_byte_identical_files() {
    let (file, second) = two_sequences();
    let a = FilmDocument::open("Edit.kfilm", &file).unwrap();
    let mut b = FilmDocument::open("Edit.kfilm", &file).unwrap();
    // `b`'s person opens the other sequence, turns the nest toggle off and zooms its Timeline.
    b.execute("sequence.open", json!({ "item": second })).unwrap();
    b.execute("sequence.nestSequences", json!({ "on": false })).unwrap();
    let mut zoomed = b.view_state();
    zoomed["view"]["sequences"] =
        json!({ second.to_string(): { "pps": 300.0, "scroll": 2.0, "v_scroll": 0.0, "a_scroll": 0.0, "video_track_h": 80.0, "audio_track_h": 40.0 } });
    assert!(b.restore_view(&zoomed));
    assert_eq!(b.view_state()["view"]["active_sequence"], json!(second));
    assert_eq!(b.view_state()["view"]["sequences"][second.to_string()]["pps"], json!(300.0));
    assert_ne!(a.view_state(), b.view_state(), "the two people see the project differently");

    let (saved_a, saved_b) = (a.save(None).unwrap(), b.save(None).unwrap());
    assert_eq!(saved_a, saved_b, "the same bytes");
    assert_eq!(saved_a, file, "the file's own bytes");
    let text = String::from_utf8(saved_b).unwrap();
    for private in ["open_sequences", "active_sequence", "\"view\"", "\"pps\"", "sequences_as_clips"] {
        assert!(!text.contains(private), "the file holds no view state ({private})");
    }
}
