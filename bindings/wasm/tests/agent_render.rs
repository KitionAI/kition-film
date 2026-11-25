//! `file.render`, the kit's agent preview (`agent.render` in kit.json, KHP A24, A39): the frame of
//! an explicit sequence at an explicit time, or a contact sheet of frames over a range, as a pure
//! function of the project. It never reads or moves the playhead, never changes the open
//! sequence, the selection or the dirty state, and answers the same bytes for the same call.
#![allow(clippy::unwrap_used, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

/// A 320 x 180 sequence that is red for its first second and blue for its second.
fn film() -> FilmDocument {
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    let red = run(&mut doc, "item.newColorMatte", json!({ "color": "#ff0000", "seconds": 1 }));
    run(&mut doc, "timeline.place", json!({ "item": red["item"], "track": "V1", "seconds": 0 }));
    let blue = run(&mut doc, "item.newColorMatte", json!({ "color": "#0000ff", "seconds": 1 }));
    run(&mut doc, "timeline.place", json!({ "item": blue["item"], "track": "V1", "seconds": 1 }));
    doc
}

/// The ids of the project's sequences.
fn sequences(doc: &FilmDocument) -> Vec<u64> {
    fn walk(bin: &Value, out: &mut Vec<u64>) {
        for child in bin["children"].as_array().into_iter().flatten() {
            if child["type"] == "Sequence" {
                out.push(child["item"].as_u64().unwrap());
            }
            walk(child, out);
        }
    }
    let mut out = Vec::new();
    walk(&doc.inspect().unwrap()["project"]["root"], &mut out);
    out.sort_unstable();
    out
}

fn render(doc: &mut FilmDocument, params: Value) -> Value {
    run(doc, "file.render", params)
}

fn refused(doc: &mut FilmDocument, params: Value) -> String {
    match doc.execute("file.render", params.clone()) {
        Ok(answer) => panic!("{params} rendered: {}", answer["frames"]),
        Err(error) => error,
    }
}

/// The answer's picture, decoded.
fn picture(answer: &Value) -> image::RgbaImage {
    let png = kition_film_engine::project::gtemplate::base64_decode(answer["png"].as_str().unwrap()).unwrap();
    image::load_from_memory(&png).unwrap().to_rgba8()
}

fn near(pixel: &image::Rgba<u8>, rgb: [u8; 3]) -> bool {
    pixel.0.iter().zip(rgb).all(|(a, b)| a.abs_diff(b) <= 2)
}

/// What the editor holds besides the document: playhead, open sequence, selection, history,
/// dirty state, and the file's bytes.
fn editor_state(doc: &FilmDocument) -> (Value, Value, Value, Value, bool, u64, Vec<u8>) {
    let inspected = doc.inspect().unwrap();
    (
        inspected["playhead"].clone(),
        inspected["project"]["activeSequence"].clone(),
        inspected["sequence"]["selection"].clone(),
        inspected["stateDigest"].clone(),
        doc.dirty(),
        doc.revision(),
        doc.save(None).unwrap(),
    )
}

#[test]
fn rendering_reads_no_playhead_and_changes_nothing() {
    let mut doc = film();
    let [sequence] = sequences(&doc)[..] else { panic!("one sequence") };
    let call = json!({ "target": { "sequence": sequence, "time": 0.5 } });
    let before = editor_state(&doc);
    let first = render(&mut doc, call.clone());
    assert_eq!(editor_state(&doc), before, "rendering moved the playhead, the open sequence, the selection or the dirty state");
    assert!(near(picture(&first).get_pixel(160, 90), RED), "the frame at 0.5 s is red");

    // Move the playhead past the cut, select a clip, and open another sequence.
    run(&mut doc, "playhead.set", json!({ "seconds": 1.5 }));
    let clip = doc.inspect().unwrap()["sequence"]["video"][0]["items"][1]["clip"].clone();
    run(&mut doc, "timeline.select", json!({ "clips": [clip] }));
    run(&mut doc, "sequence.new", json!({ "name": "Other", "width": 64, "height": 36 }));
    assert_ne!(doc.inspect().unwrap()["project"]["activeSequence"], json!(sequence));
    let before = editor_state(&doc);
    let second = render(&mut doc, call);
    assert_eq!(editor_state(&doc), before, "rendering moved the playhead, the open sequence, the selection or the dirty state");
    assert_eq!(second["png"], first["png"], "the same sequence at the same time is the same picture wherever the playhead is");
    assert_eq!(second["frames"], first["frames"]);
}

#[test]
fn two_times_are_two_pictures() {
    let mut doc = film();
    let early = render(&mut doc, json!({ "target": { "time": 0.5 } }));
    let late = render(&mut doc, json!({ "target": { "time": 1.5 } }));
    assert!(near(picture(&early).get_pixel(160, 90), RED));
    assert!(near(picture(&late).get_pixel(160, 90), BLUE));
    let [sequence] = sequences(&doc)[..] else { panic!("one sequence") };
    assert_eq!(early["sequence"], json!(sequence));
    // The frame showing at 1.5 s starts on a frame boundary at or before it.
    let time = late["frames"][0]["time"].as_f64().unwrap();
    assert!((1.4..=1.5).contains(&time), "{late}");
    assert_eq!(late["frames"].as_array().map(Vec::len), Some(1));
}

#[test]
fn the_same_call_answers_the_same_bytes() {
    let mut doc = film();
    for params in [json!({ "target": { "time": 1.25 } }), json!({ "target": { "range": [0, 2], "frames": 5 }, "scale": 0.5 }), json!({})] {
        let once = render(&mut doc, params.clone());
        let again = render(&mut doc, params.clone());
        assert_eq!(once, again, "{params}");
    }
}

#[test]
fn a_time_outside_the_sequence_says_its_range() {
    let mut doc = film();
    for time in [json!(2.5), json!(-0.5), json!(60)] {
        let error = refused(&mut doc, json!({ "target": { "time": time } }));
        let (message, errors) = kition_kit::schema::parse_refusal(&error).unwrap_or_else(|| panic!("not a typed refusal: {error}"));
        assert_eq!(errors[0].path, "/target/time", "{error}");
        assert!(message.contains("from 0 to 2.001 s"), "says how long the sequence is: {message}");
        assert!(message.contains("1.96 s"), "says where its last frame starts: {message}");
    }
    let error = refused(&mut doc, json!({ "target": { "time": "soon" } }));
    assert!(error.contains("target.time") || error.contains("/target/time"), "{error}");
}

#[test]
fn an_unknown_sequence_lists_the_sequences() {
    let mut doc = film();
    let [sequence] = sequences(&doc)[..] else { panic!("one sequence") };
    let error = refused(&mut doc, json!({ "target": { "sequence": 999_999, "time": 0.5 } }));
    let (message, errors) = kition_kit::schema::parse_refusal(&error).unwrap_or_else(|| panic!("not a typed refusal: {error}"));
    assert_eq!(errors[0].path, "/target/sequence", "{error}");
    assert!(message.contains(&sequence.to_string()) && message.contains("Sequence 01"), "lists the sequences: {message}");
    // A project item that is not a sequence is no sequence either.
    let matte = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].as_u64().unwrap();
    let error = refused(&mut doc, json!({ "target": { "sequence": matte, "time": 0.5 } }));
    assert!(error.contains(&sequence.to_string()), "{error}");
}

#[test]
fn several_top_level_sequences_need_the_sequence_named() {
    let mut doc = film();
    let [first] = sequences(&doc)[..] else { panic!("one sequence") };
    run(&mut doc, "sequence.new", json!({ "name": "Other", "width": 64, "height": 36 }));
    let [_, other] = sequences(&doc)[..] else { panic!("two sequences") };
    let error = refused(&mut doc, json!({ "target": { "time": 0.5 } }));
    let (message, errors) = kition_kit::schema::parse_refusal(&error).unwrap_or_else(|| panic!("not a typed refusal: {error}"));
    assert_eq!(errors[0].path, "/target/sequence", "{error}");
    for id in [first, other] {
        assert!(message.contains(&id.to_string()), "lists sequence {id}: {message}");
    }
    let named = render(&mut doc, json!({ "target": { "sequence": first, "time": 0.5 } }));
    assert!(near(picture(&named).get_pixel(160, 90), RED));

    // Nested in the other sequence, the first is part of it: the other is the one the project shows.
    run(&mut doc, "timeline.place", json!({ "item": first, "track": "V1", "seconds": 0 }));
    let main = render(&mut doc, json!({ "target": { "time": 0.5 } }));
    assert_eq!(main["sequence"], json!(other), "{}", main["sequence"]);
}

#[test]
fn scale_and_max_size_size_the_picture() {
    let mut doc = film();
    let size = |answer: &Value| (answer["width"].as_u64().unwrap(), answer["height"].as_u64().unwrap());
    let at = |doc: &mut FilmDocument, extra: Value| {
        let mut params = json!({ "target": { "time": 0.5 } });
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let answer = render(doc, params);
        let shown = picture(&answer);
        assert_eq!((u64::from(shown.width()), u64::from(shown.height())), size(&answer), "the answer says the picture's size");
        answer
    };
    assert_eq!(size(&at(&mut doc, json!({}))), (320, 180), "scale 1: one pixel per sequence pixel");
    assert_eq!(size(&at(&mut doc, json!({ "scale": 0.5 }))), (160, 90));
    let doubled = at(&mut doc, json!({ "scale": 2 }));
    assert_eq!(size(&doubled), (640, 360));
    assert_eq!(doubled["scale"], json!(2.0));
    let fitted = at(&mut doc, json!({ "maxSize": 100 }));
    assert_eq!(size(&fitted), (100, 56), "maxSize bounds the longer side");
    assert!((fitted["scale"].as_f64().unwrap() - 0.3125).abs() < 1e-9, "the scale drawn at, after maxSize: {}", fitted["scale"]);
    assert_eq!(size(&at(&mut doc, json!({ "scale": 2, "maxSize": 4096 }))), (640, 360));
    for bad in [json!({ "scale": 0 }), json!({ "scale": 2.5 }), json!({ "maxSize": 15 }), json!({ "maxSize": 4097 })] {
        let mut params = json!({ "target": { "time": 0.5 } });
        params.as_object_mut().unwrap().extend(bad.as_object().unwrap().clone());
        let error = refused(&mut doc, params);
        let (_, errors) = kition_kit::schema::parse_refusal(&error).unwrap_or_else(|| panic!("not a typed refusal: {error}"));
        let key = bad.as_object().unwrap().keys().next().unwrap().clone();
        assert_eq!(errors[0].path, format!("/{key}"), "{error}");
    }
}

#[test]
fn a_contact_sheet_shows_frames_over_a_range_with_their_times() {
    let mut doc = film();
    let sheet = render(&mut doc, json!({ "target": { "range": [0, 2], "frames": 4 } }));
    let frames = sheet["frames"].as_array().unwrap();
    assert_eq!(frames.len(), 4, "{sheet}");
    let times: Vec<f64> = frames.iter().map(|frame| frame["time"].as_f64().unwrap()).collect();
    assert_eq!(times[0], 0.0);
    assert!(times.windows(2).all(|pair| pair[0] < pair[1]), "{times:?}");
    assert!((1.9..2.0).contains(&times[3]), "the range's end shows the last frame: {times:?}");
    for frame in frames {
        assert!(frame["label"].as_str().is_some_and(|label| label.ends_with('s')), "{frame}");
    }
    assert_eq!((sheet["columns"].as_u64(), sheet["rows"].as_u64()), (Some(2), Some(2)));
    let shown = picture(&sheet);
    let (w, h) = (shown.width(), shown.height());
    assert!(w.max(h) <= 1024, "within the default maxSize: {w} x {h}");
    // The first frame (top left) is red, the last (bottom right) blue.
    assert!(near(shown.get_pixel(w / 4, h / 4 - h / 16), RED));
    assert!(near(shown.get_pixel(w * 3 / 4, h * 3 / 4 - h / 16), BLUE));
    // Each frame carries its time, burned in: light text in its bottom left corner.
    let label_pixels = |x0: u32, y0: u32| {
        (x0..x0 + w / 4)
            .flat_map(|x| (y0 + h / 4..y0 + h / 2).map(move |y| (x, y)))
            .filter(|&(x, y)| shown.get_pixel(x, y).0[..3].iter().all(|c| *c > 200))
            .count()
    };
    for (x0, y0) in [(0, 0), (w / 2, 0), (0, h / 2), (w / 2, h / 2)] {
        assert!(label_pixels(x0, y0) > 10, "no label in the cell at {x0}, {y0}");
    }
    assert_eq!(render(&mut doc, json!({ "target": { "range": [0, 2], "frames": 4 } })), sheet, "deterministic");
}

#[test]
fn a_contact_sheet_refuses_what_it_cannot_lay_out() {
    let mut doc = film();
    for (target, path) in [
        (json!({ "range": [0, 2], "frames": 1 }), "/target/frames"),
        (json!({ "range": [0, 2], "frames": 13 }), "/target/frames"),
        (json!({ "range": [1.5, 0.5], "frames": 3 }), "/target/range"),
        (json!({ "range": [0, 9], "frames": 3 }), "/target/range"),
        (json!({ "range": [0], "frames": 3 }), "/target/range"),
        (json!({ "range": [0, 2], "time": 1 }), "/target/time"),
    ] {
        let error = refused(&mut doc, json!({ "target": target }));
        let (_, errors) = kition_kit::schema::parse_refusal(&error).unwrap_or_else(|| panic!("not a typed refusal: {error}"));
        assert_eq!(errors[0].path, path, "{target}: {error}");
    }
}

#[test]
fn without_a_target_it_shows_the_whole_sequence() {
    let mut doc = film();
    let whole = render(&mut doc, json!({ "scale": 1 }));
    let frames = whole["frames"].as_array().unwrap();
    assert!(frames.len() > 1, "a contact sheet of the sequence: {whole}");
    assert_eq!(frames[0]["time"], json!(0.0));
    let empty = &mut FilmDocument::create("Empty.kfilm", 320, 180).unwrap();
    let black = render(empty, json!({}));
    assert_eq!(black["frames"].as_array().map(Vec::len), Some(1), "an empty sequence has its one black frame");
}

#[test]
fn a_diagnostic_target_names_the_sequence_and_the_clip() {
    let mut doc = film();
    let [sequence] = sequences(&doc)[..] else { panic!("one sequence") };
    let blue = doc.inspect().unwrap()["sequence"]["video"][0]["items"][1]["clip"].as_u64().unwrap();
    let shown = render(&mut doc, json!({ "target": { "path": format!("sequence:{sequence}/clip:{blue}") } }));
    assert!(near(picture(&shown).get_pixel(160, 90), BLUE), "a clip's target shows the clip");
    let at = render(&mut doc, json!({ "target": { "path": format!("sequence:{sequence}"), "time": 0.25 } }));
    assert!(near(picture(&at).get_pixel(160, 90), RED));
    let error = refused(&mut doc, json!({ "target": { "path": "layer:3" } }));
    assert!(error.contains("sequence:<id>"), "{error}");
}
