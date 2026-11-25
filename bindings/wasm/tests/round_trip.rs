//! Command-level round trips: a new project is edited only with engine commands, each edit is
//! checked, then the project is saved as .kfilm, reopened, and compared whole: the inspected
//! project and active sequence, every graphic clip's layers (`graphics.list`), the audio mixer,
//! and the program frame at several times. A second save of the reopened file must reopen the same.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

const SECOND: i64 = 254_016_000_000;
const FRAME: i64 = SECOND / 24;
const W: u32 = 64;
const H: u32 = 36;

fn run(doc: &mut FilmDocument, command: &str, params: Value) -> Value {
    doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"))
}

fn sequence(doc: &FilmDocument) -> Value {
    doc.inspect().unwrap()["sequence"].clone()
}

fn project() -> FilmDocument {
    let mut doc = FilmDocument::create("Edit.kfilm", W, H).unwrap();
    run(&mut doc, "sequence.new", json!({ "name": "Cut", "width": W, "height": H, "fps": 24, "video": 2, "audio": 2 }));
    let bars = run(&mut doc, "item.newBarsAndTone", json!({ "seconds": 4 }))["item"].clone();
    run(&mut doc, "timeline.place", json!({ "item": bars, "track": "V1", "seconds": 0 }));
    doc
}

fn clips(doc: &FilmDocument, kind: &str, track: usize) -> Vec<Value> {
    sequence(doc)[kind][track]["items"].as_array().unwrap().clone()
}

/// What a saved project keeps: the undo state, the unsaved flag, revision counters, the file the
/// session opened (none for a new project) and the timeline's selection belong to the open
/// session, not the project. So does the playhead here: a reopened project starts at 0 (Premiere
/// Pro reopens a sequence where it was left; recorded in the features' `gap`).
fn lasting(doc: &mut FilmDocument) -> Value {
    let mut state = doc.inspect().unwrap();
    let graphics: Vec<Value> = state["sequence"]["video"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|track| track["items"].as_array().unwrap().clone())
        .filter_map(|item| item["clip"].as_i64())
        .filter_map(|clip| doc.execute("graphics.list", json!({ "clip": clip })).ok().map(|layers| json!({ "clip": clip, "layers": layers })))
        .collect();
    let mut mixer = doc.execute("mixer.inspect", json!({})).unwrap();
    // The mixer reads its strips' levels at the playhead (`at`), which is not saved.
    for strip in mixer["strips"].as_array_mut().into_iter().flatten() {
        strip.as_object_mut().map(|strip| strip.remove("at"));
    }
    let object = state.as_object_mut().unwrap();
    // Session state, not the document: undo, the preferences' revision, and the editor's state.
    for key in ["canUndo", "canRedo", "prefsRevision", "stateDigest"] {
        object.remove(key);
    }
    for key in ["dirty", "revision", "epoch", "path"] {
        object["project"].as_object_mut().unwrap().remove(key);
    }
    object.remove("playhead");
    for key in ["selection", "playhead"] {
        object["sequence"].as_object_mut().unwrap().remove(key);
    }
    object.insert("graphics".into(), Value::Array(graphics));
    object.insert("mixer".into(), mixer);
    state
}

fn frames(doc: &mut FilmDocument) -> Vec<Vec<u8>> {
    [0, SECOND, 2 * SECOND + 6 * FRAME, 3 * SECOND]
        .iter()
        .map(|time| {
            run(doc, "playhead.set", json!({ "time": time }));
            doc.render(0.0, 0.0, 1.0, W, H).unwrap()
        })
        .collect()
}

/// Saves and reopens as a host does: the file, and the person's view state (the open sequence,
/// the tabs) the host keeps apart from it and gives back (Kit UI protocol 7n).
fn reopen(doc: &FilmDocument) -> FilmDocument {
    let mut reopened = FilmDocument::open("Edit.kfilm", &doc.save(None).unwrap()).unwrap();
    assert!(reopened.restore_view(&doc.view_state()), "the view state is put back");
    reopened
}

fn differences(path: &str, a: &Value, b: &Value, out: &mut Vec<String>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for key in x.keys().chain(y.keys().filter(|key| !x.contains_key(*key))) {
                differences(&format!("{path}/{key}"), x.get(key).unwrap_or(&Value::Null), y.get(key).unwrap_or(&Value::Null), out);
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (at, (x, y)) in x.iter().zip(y).enumerate() {
                differences(&format!("{path}/{at}"), x, y, out);
            }
        }
        _ if a != b => out.push(format!("{path}: {a} != {b}")),
        _ => {}
    }
}

fn assert_round_trip(doc: &mut FilmDocument) {
    let mut reopened = reopen(doc);
    let (before, after) = (lasting(doc), lasting(&mut reopened));
    let mut changed = Vec::new();
    differences("", &before, &after, &mut changed);
    assert!(changed.is_empty(), "the project after saving and reopening:\n{}", changed.join("\n"));
    assert!(frames(&mut reopened) == frames(doc), "the program frames after saving and reopening");
    let mut again = reopen(&reopened);
    assert_eq!(lasting(&mut again), before, "a second save of the reopened file");
}

#[test]
fn tracks_and_clips_survive_save_and_reopen() {
    let mut doc = project();
    let matte = run(&mut doc, "item.newColorMatte", json!({ "color": "#cc3300", "seconds": 2 }))["item"].clone();
    run(&mut doc, "timeline.place", json!({ "item": matte, "track": "V2", "seconds": 1 }));
    run(&mut doc, "timeline.setTrack", json!({ "track": "V2", "name": "Overlay", "locked": false }));
    run(&mut doc, "timeline.setTrack", json!({ "track": "A2", "muted": true, "name": "Spare" }));
    let bars = clips(&doc, "video", 0)[0]["clip"].clone();
    run(&mut doc, "timeline.razor", json!({ "track": "V1", "time": 2 * SECOND }));
    let first = clips(&doc, "video", 0)[0]["clip"].clone();
    assert_eq!(first, bars);
    run(&mut doc, "timeline.trim", json!({ "clip": first, "edge": "out", "deltaFrames": -6 }));
    run(&mut doc, "clip.rename", json!({ "clip": first, "name": "Opening 中文 ✓" }));
    let overlay = clips(&doc, "video", 1)[0]["clip"].clone();
    run(&mut doc, "clip.speedDuration", json!({ "clips": [overlay], "speed": 50 }));
    let video = clips(&doc, "video", 0);
    assert_eq!(video.len(), 2);
    assert_eq!(video[0]["durationFrames"], 42);
    assert_eq!(video[0]["name"], "Opening 中文 ✓");
    assert_eq!(clips(&doc, "video", 1)[0]["speed"], 0.5);
    assert_round_trip(&mut doc);
}

#[test]
fn markers_and_in_out_survive_save_and_reopen() {
    let mut doc = project();
    run(&mut doc, "marker.add", json!({ "time": SECOND, "name": "Beat", "comment": "drop 中文", "color": "Forest", "durationFrames": 12 }));
    run(&mut doc, "marker.add", json!({ "time": 3 * SECOND, "name": "End" }));
    run(&mut doc, "marker.markIn", json!({ "time": 12 * FRAME }));
    run(&mut doc, "marker.markOut", json!({ "time": 3 * SECOND }));
    let cut = sequence(&doc);
    assert_eq!(cut["markers"].as_array().unwrap().len(), 2, "{cut}");
    assert!(!cut["in"].is_null() && !cut["out"].is_null(), "{cut}");
    assert_round_trip(&mut doc);
}

#[test]
fn transitions_survive_save_and_reopen() {
    let mut doc = project();
    run(&mut doc, "timeline.razor", json!({ "track": "V1", "time": 2 * SECOND }));
    let first = clips(&doc, "video", 0)[0]["clip"].clone();
    run(&mut doc, "sequence.applyVideoTransition", json!({ "clip": first, "edge": "out", "effect": "cross_dissolve", "frames": 12 }));
    let audio = clips(&doc, "audio", 0)[0]["clip"].clone();
    run(&mut doc, "sequence.applyAudioTransition", json!({ "clip": audio, "effect": "constant_power", "frames": 12 }));
    let cut = sequence(&doc);
    assert_eq!(cut["video"][0]["transitions"].as_array().unwrap().len(), 1, "{cut}");
    assert_eq!(cut["audio"][0]["transitions"].as_array().unwrap().len(), 1, "{cut}");
    assert_round_trip(&mut doc);
}

#[test]
fn titles_survive_save_and_reopen() {
    let mut doc = project();
    let title = run(&mut doc, "graphics.newText", json!({ "text": "Kition 中文 ✓", "time": 0, "seconds": 3, "track": 1, "size": 12, "position": [6, 20] }));
    let clip = title["clip"].clone();
    run(&mut doc, "graphics.set", json!({ "clip": clip, "layer": 0, "props": { "fill_color": "#ffcc00", "scale": 80, "rotation": 5 } }));
    run(&mut doc, "graphics.setText", json!({ "clip": clip, "layer": 0, "text": "Kition 中文 ✓ two" }));
    let layers = run(&mut doc, "graphics.list", json!({ "clip": clip }));
    assert!(layers.to_string().contains("Kition 中文 ✓ two"), "{layers}");
    assert!(lasting(&mut doc)["graphics"].to_string().contains("Kition 中文 ✓ two"), "the title's layers are compared");
    let shown = frames(&mut doc);
    assert!(shown[0] != shown[3], "the title shows at 0 s and is gone at 3 s");
    assert_round_trip(&mut doc);
}

#[test]
fn effects_keyframes_and_masks_survive_save_and_reopen() {
    let mut doc = project();
    let clip = clips(&doc, "video", 0)[0]["clip"].clone();
    run(&mut doc, "effect.apply", json!({ "clips": [clip], "effect": "gaussian_blur" }));
    run(&mut doc, "effect.setParam", json!({ "clip": clip, "effect": "motion", "param": "scale", "value": 120.0 }));
    run(&mut doc, "effect.addKeyframe", json!({ "clip": clip, "effect": "opacity", "param": "opacity", "time": 0 }));
    run(&mut doc, "effect.setParam", json!({ "clip": clip, "effect": "opacity", "param": "opacity", "time": 2 * SECOND, "value": 40.0 }));
    run(&mut doc, "mask.add", json!({ "clip": clip, "shape": "ellipse", "center": [32, 18], "size": [30, 20] }));
    let effects = &clips(&doc, "video", 0)[0]["effects"];
    assert!(effects.to_string().contains("gaussian_blur"), "{effects}");
    assert_round_trip(&mut doc);
}

#[test]
fn audio_levels_survive_save_and_reopen() {
    let mut doc = project();
    let clip = clips(&doc, "audio", 0)[0]["clip"].clone();
    run(&mut doc, "clip.audioGain", json!({ "clips": [clip], "db": -6.0, "mode": "set" }));
    run(&mut doc, "clipMixer.set", json!({ "clip": clip, "effect": "volume", "param": "level", "value": -3.0, "time": SECOND, "keyframe": true }));
    run(&mut doc, "timeline.setTrack", json!({ "track": "A1", "volumeDb": -2.0, "pan": -0.3 }));
    run(&mut doc, "mixer.setStrip", json!({ "strip": "Mix", "volumeDb": -1.5 }));
    assert_eq!(clips(&doc, "audio", 0)[0]["gainDb"], -6.0);
    assert_round_trip(&mut doc);
}
