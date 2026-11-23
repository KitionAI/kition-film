//! C8-film-read: creation must never reuse a live id from malformed file metadata.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

#[test]
fn a_corrupt_id_counter_cannot_overwrite_an_existing_source() {
    let mut loaded = kition_film_format::decode(&project(1)).unwrap();
    let source = loaded.project.sequences().find_map(|item| item.as_sequence()).unwrap().video_tracks[0].items[0].item;
    let old_name = loaded.project.item(source).unwrap().name.clone();
    loaded.project.next_id = source.0;
    let bytes = kition_film_format::encode_with_view(&loaded.project, loaded.view.as_ref(), true);
    let Ok(mut doc) = FilmDocument::open(FILE, &bytes) else { return };
    let result = doc.execute("file.newColorMatte", json!({"name":"Injected over the old source","color":"#000000","seconds":1}));
    let after: serde_json::Value = serde_json::from_slice(&doc.save(None).unwrap()).unwrap();
    let retained = after["project"]["items"][source.0.to_string()]["name"] == old_name;
    assert!(result.is_err() && retained, "corrupt counter reused source {source:?}: result={result:?}, original retained={retained}");
}

#[test]
fn an_exhausted_saved_id_counter_is_an_error_instead_of_a_panic_or_invalid_id() {
    let mut failures = Vec::new();
    for counter in [u64::MAX - 1, u64::MAX] {
        let mut loaded = kition_film_format::decode(&project(1)).unwrap();
        loaded.project.next_id = counter;
        let bytes = kition_film_format::encode_with_view(&loaded.project, loaded.view.as_ref(), true);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let Ok(mut doc) = FilmDocument::open(FILE, &bytes) else { return true };
            doc.execute("file.newColorMatte", json!({"name":"Invalid id","color":"#000000","seconds":1})).is_err()
        }));
        if !matches!(outcome, Ok(true)) {
            failures.push(format!("counter {counter} must report an error before allocating an invalid id: {outcome:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn stored_inline_ids_are_reserved_before_editing_without_changing_the_decoded_counter() {
    let bytes = include_bytes!("../../../crates/formats/format/tests/fixtures/edit.kfilm");
    let loaded = kition_film_format::decode(bytes).unwrap();
    assert_eq!(loaded.project.next_id, 48, "the frozen format contract preserves this stored counter");
    let floor = loaded.project.minimum_next_id(true).unwrap();
    assert!(floor > 800_000);
    let mut doc = FilmDocument::open(FILE, bytes).unwrap();
    let created = doc.execute("file.newColorMatte", json!({"name":"Fresh","color":"#000000","seconds":1})).unwrap()["item"].as_u64().unwrap();
    assert!(created >= floor, "creation must reserve every existing inline identity");
    let saved = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
    assert_eq!(saved.project.item(kition_film_project::ItemId(5)).unwrap().name, "Ocean_Sunset.mp4");
    assert_eq!(saved.project.sequence(kition_film_project::ItemId(21)).unwrap().markers[0].id.0, 800_000);
}

#[test]
fn exhausting_the_exact_numeric_counter_does_not_create_an_unreadable_saved_project() {
    let mut loaded = kition_film_format::decode(&project(1)).unwrap();
    loaded.project.next_id = (1u64 << 53) - 1;
    let bytes = kition_film_format::encode_with_view(&loaded.project, loaded.view.as_ref(), true);
    let mut doc = FilmDocument::open(FILE, &bytes).unwrap();
    let result = doc.execute("file.newColorMatte", json!({"name":"Out of ids","color":"#000000","seconds":1}));
    let saved = kition_film_format::decode(&doc.save(None).unwrap());
    assert!(result.is_err() && saved.is_ok(), "exhausted allocation must fail before publishing an unreadable project: result={result:?}, saved={saved:?}");
    assert_eq!(saved.unwrap().project.items.len(), loaded.project.items.len());
}
