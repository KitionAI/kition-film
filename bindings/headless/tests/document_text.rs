//! `document.text` (`KitText 1.0`) on the document `kition-film` serves: the titles and captions
//! of every sequence as plain text, in timeline order, with a part per title and per caption
//! track, cut at `limit` characters, and nothing changed. The headless executable lists the
//! capability `document-text` and answers the method.

use kition_film_kit::FilmDocument;
use kition_headless::{Headless, HostFolder, KitInfo};
use kition_kit::KitDocument;
use kition_kit::testing::check_text;
use kition_kit::text::DocumentText;
use kition_kit_server::{KitBackend, OpenRequest};
use serde_json::{Value, json};

const TICKS_PER_SECOND: i64 = 254_016_000_000;

fn film() -> FilmDocument {
    FilmDocument::create("Edit.kfilm", 1920, 1080).unwrap()
}

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

fn clip(made: &Value) -> u64 {
    made["clip"].as_u64().or_else(|| made.as_u64()).unwrap_or_else(|| panic!("no clip in {made}"))
}

/// A sequence with two titles (the second added first, later on the timeline; the first with two
/// text layers and a shape) and a caption track with two captions, one of them with markup.
fn titled() -> FilmDocument {
    let mut doc = film();
    run(&mut doc, "graphics.newText", json!({ "text": "Closing credits", "time": 10 * TICKS_PER_SECOND }));
    let first = clip(&run(&mut doc, "graphics.newText", json!({ "text": "Opening Title", "time": 0 })));
    run(&mut doc, "graphics.newShape", json!({ "shape": "rectangle", "clip": first, "position": [400, 920], "size": [500, 150] }));
    run(&mut doc, "graphics.newText", json!({ "text": "A film by Ana", "clip": first }));
    run(&mut doc, "captions.newTrack", json!({ "format": "Subtitle", "name": "Subtitles" }));
    run(&mut doc, "captions.add", json!({ "text": "Hello <b>world</b>", "seconds": 1, "durationSeconds": 1 }));
    run(&mut doc, "captions.add", json!({ "text": "Second line\nwraps", "seconds": 3, "durationSeconds": 1 }));
    doc
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

fn piece(answer: &DocumentText, index: usize) -> String {
    let part = &answer.parts[index];
    answer.text.chars().skip(part.start).take(part.end - part.start).collect()
}

#[test]
fn titles_then_captions_in_timeline_order() {
    let doc = titled();
    let answer = check_text(&doc).unwrap();
    assert_eq!(answer.text, "Opening Title\nA film by Ana\nClosing credits\nHello world\nSecond line\nwraps", "{answer:?}");
    assert!(!answer.truncated);
    let labels: Vec<&str> = answer.parts.iter().map(|p| p.label.as_str()).collect();
    assert_eq!(labels, ["Sequence 01 / Title 1", "Sequence 01 / Title 2", "Sequence 01 / Subtitles"]);
    let pieces: Vec<String> = (0..answer.parts.len()).map(|index| piece(&answer, index)).collect();
    assert_eq!(pieces, ["Opening Title\nA film by Ana", "Closing credits", "Hello world\nSecond line\nwraps"]);
}

#[test]
fn the_limit_cuts_the_text_and_the_parts_stay_within_it() {
    let doc = titled();
    let whole = doc.text(kition_kit::text::DEFAULT_LIMIT).unwrap().text;
    for limit in 0..=chars(&whole) + 2 {
        let answer = doc.text(limit).unwrap();
        assert!(chars(&answer.text) <= limit, "limit {limit}");
        assert!(whole.starts_with(&answer.text));
        assert_eq!(answer.truncated, limit < chars(&whole), "limit {limit}");
        assert_eq!(answer.text == whole, !answer.truncated, "limit {limit}");
        for p in &answer.parts {
            assert!(p.start < p.end && p.end <= chars(&answer.text), "limit {limit}: {p:?} outside {:?}", answer.text);
        }
    }
}

#[test]
fn characters_are_counted_not_bytes() {
    let mut doc = film();
    run(&mut doc, "graphics.newText", json!({ "text": "标题 é" }));
    let answer = doc.text(2).unwrap();
    assert_eq!(answer.text, "标题");
    assert!(answer.truncated);
    assert_eq!(answer.to_json()["parts"], json!([{ "label": "Sequence 01 / Title 1", "start": 0, "end": 2 }]));
    check_text(&doc).unwrap();
}

#[test]
fn reading_the_text_changes_nothing() {
    let doc = titled();
    let (revision, dirty, saved) = (doc.revision(), doc.dirty(), doc.save(None).unwrap());
    for limit in [0, 5, 1_048_576] {
        doc.text(limit).unwrap();
    }
    assert_eq!(doc.revision(), revision);
    assert_eq!(doc.dirty(), dirty);
    assert_eq!(doc.save(None).unwrap(), saved);
}

#[test]
fn a_disabled_title_is_left_out() {
    let mut doc = film();
    let hidden = clip(&run(&mut doc, "graphics.newText", json!({ "text": "Hidden" })));
    run(&mut doc, "clip.enable", json!({ "clips": [hidden] }));
    assert_eq!(check_text(&doc).unwrap().text, "");
}

#[test]
fn an_empty_project_has_no_text() {
    let doc = film();
    let answer = check_text(&doc).unwrap();
    assert_eq!(answer.to_json(), json!({ "text": "", "truncated": false }));
    let reopened = FilmDocument::open("Edit.kfilm", &doc.save(None).unwrap()).unwrap();
    assert_eq!(reopened.text(kition_kit::text::DEFAULT_LIMIT).unwrap(), answer);
}

#[test]
fn the_headless_kit_lists_the_capability_and_answers_document_text() {
    let root = std::env::temp_dir().join(format!("kition-film-text-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    let file = root.join("Edit.kfilm");
    std::fs::write(&file, titled().save(None).unwrap()).unwrap();
    let info = KitInfo::from_manifest(include_str!("../../../kit.json"), &["file.import"], &[]).unwrap();
    let mut kit = Headless::<FilmDocument>::with_replica_port(info);
    assert_eq!(kit.capabilities()["capabilities"], json!([kition_kit::text::CAPABILITY]));
    let folder = HostFolder::new(&root).unwrap();
    kit.set_host(folder.host());
    let id = kit.open(OpenRequest { file: &folder.file("Edit.kfilm").unwrap(), read_only: false, create: None }).unwrap().id;
    let answer = kit.text(&id, 1_048_576).unwrap();
    assert_eq!(answer["text"], json!("Opening Title\nA film by Ana\nClosing credits\nHello world\nSecond line\nwraps"));
    assert_eq!(answer["truncated"], json!(false));
    assert_eq!(answer["parts"].as_array().map(Vec::len), Some(3));
    let cut = kit.text(&id, 7).unwrap();
    assert_eq!(cut["text"], json!("Opening"));
    assert_eq!(cut["truncated"], json!(true));
    assert!(!kit.document(&id).unwrap().dirty, "reading changes nothing");
    let _ = std::fs::remove_dir_all(root);
}
