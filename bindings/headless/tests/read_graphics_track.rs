//! C8-film-read: an explicitly indexed graphic destination respects its lock.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[test]
fn explicit_graphic_destination_must_be_unlocked() {
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    doc.execute("timeline.setTrack", json!({"track":"V1","locked":true})).unwrap();
    let before = doc.save(None).unwrap();
    assert!(doc.execute("graphics.newText", json!({"text":"Mine","newClip":true,"track":0})).is_err(), "an explicit track index does not bypass the lock");
    assert_eq!(doc.save(None).unwrap(), before, "a refused graphic leaves no source item or clip");
}
