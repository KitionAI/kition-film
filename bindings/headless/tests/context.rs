//! `kition-film` served headless keeps the editing session (the playhead, the timeline selection,
//! the open sequence, the session's path and revision) out of what an agent reads of the project
//! (`view.describe`, the `film_inspect` details), and sets the editor state one call reads and puts
//! it back through the Kit Process Protocol's `context.get`, `context.set` and `context.restore`
//! (section 7a), so nothing an agent does depends on or leaves behind the editor's playhead,
//! active sequence, track targets or selection (task card C4-film).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kition_film_kit::FilmDocument;
use kition_headless::{Headless, HostFolder, KitInfo};
use kition_kit::KitDocument;
use kition_kit_server::protocol::Origin;
use kition_kit_server::{KitBackend, OpenRequest};
use serde_json::{Map, Value, json};

const SECOND: i64 = 254_016_000_000;

fn params(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// The headless kit as the `kition-film` executable makes it.
fn kit() -> Headless<FilmDocument> {
    let info = KitInfo::from_manifest(include_str!("../../../kit.json"), kition_film_kit::files::AGENT_FILE_COMMANDS, kition_film_kit::EDITOR_STATE).unwrap();
    Headless::<FilmDocument>::with_replica_port(info)
}

/// A workspace holding `Edit.kfilm`: a 320 x 180 sequence with a red matte (0-2 s, its opacity
/// keyframed from 0 to 1 s) and a blue one (2-4 s) on V1; the kit opens it.
fn open(name: &str) -> (Headless<FilmDocument>, String, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("kition-film-context-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    let mut clips = Vec::new();
    for (color, seconds) in [("#ff0000", 0), ("#0000ff", 2)] {
        let matte = doc.execute("item.newColorMatte", json!({ "color": color, "seconds": 2 })).unwrap();
        clips.push(doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": seconds })).unwrap()["clips"][0].clone());
    }
    for (value, seconds) in [(0, 0), (100, 1)] {
        doc.execute("effect.setParam", json!({ "clip": clips[0], "effect": "opacity", "param": "opacity", "value": value, "seconds": seconds })).unwrap();
    }
    std::fs::write(root.join("Edit.kfilm"), doc.save(None).unwrap()).unwrap();
    let mut kit = kit();
    let folder = HostFolder::new(&root).unwrap();
    kit.set_host(folder.host());
    let id = kit.open(OpenRequest { file: &folder.file("Edit.kfilm").unwrap(), read_only: false, create: None }).unwrap().id;
    (kit, id, root)
}

fn run(kit: &mut Headless<FilmDocument>, id: &str, command: &str, value: Value, origin: Origin) -> Value {
    kit.execute(id, command, params(value), origin).unwrap_or_else(|error| panic!("{command}: {error:?}")).result.unwrap_or(Value::Null)
}

/// Every place `EDITOR_STATE` names is in what the kit's `inspect()` answers and in no part of what
/// an agent reads; a keyframe's `time` and the title safe area, which are the document's, are.
#[test]
fn what_an_agent_reads_leaves_out_exactly_the_declared_editor_state() {
    let (mut kit, id, root) = open("declared");
    let inspected = kit.describe(&id).unwrap().state;
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    doc.execute("playhead.set", json!({ "seconds": 0 })).unwrap();
    let full = doc.inspect().unwrap();
    for pointer in kition_film_kit::EDITOR_STATE {
        assert!(full.pointer(pointer).is_some(), "{pointer} names nothing in inspect(): {full}");
        assert!(Value::Object(inspected.clone()).pointer(pointer).is_none(), "{pointer} is the editor's, not the document's");
    }
    let keyframes = &inspected["sequence"]["video"][0]["items"][0]["effects"][1]["params"]["opacity"]["keyframes"];
    assert_eq!(keyframes[1]["time"], json!(SECOND), "a keyframe's time is the document's: {keyframes}");
    assert!(inspected["project"]["safeAreas"]["title"].is_array(), "the title safe area is the document's: {}", inspected["project"]);
    let _ = std::fs::remove_dir_all(root);
}

/// A person moving the playhead, selecting clips, loading the Source monitor or opening another
/// sequence's playhead changes nothing an agent reads of the project.
#[test]
fn the_editors_state_changes_nothing_an_agent_reads() {
    let (mut kit, id, root) = open("unchanged");
    let before = kit.describe(&id).unwrap().state;
    let clip = before["sequence"]["video"][0]["items"][1]["clip"].clone();
    let item = before["sequence"]["video"][0]["items"][1]["item"].clone();
    run(&mut kit, &id, "playhead.set", json!({ "seconds": 3 }), Origin::User);
    run(&mut kit, &id, "timeline.select", json!({ "clips": [clip] }), Origin::User);
    run(&mut kit, &id, "source.open", json!({ "item": item }), Origin::User);
    assert_eq!(kit.describe(&id).unwrap().state, before, "the editor's state changed what the agent reads of the project");
    let _ = std::fs::remove_dir_all(root);
}

/// The editor state as `context.get` answers it, and the playhead and selection a person sees.
fn editor(kit: &mut Headless<FilmDocument>, id: &str) -> (Value, Value) {
    let inspected = kit.context_get(id).unwrap();
    (inspected["playheads"].clone(), inspected["selection"].clone())
}

/// Through the Kit Process Protocol's `context.set` and `context.restore`, an agent's step cuts at
/// `at.time` (seconds) the clip it names, and afterwards the playhead and the
/// selection are what the person left; neither request is an edit, nor changes what the agent
/// reads.
#[test]
fn a_step_at_a_time_through_the_context_requests() {
    let (mut kit, id, root) = open("requests");
    let described = kit.describe(&id).unwrap().state;
    let red = described["sequence"]["video"][0]["items"][0]["clip"].clone();
    let blue = described["sequence"]["video"][0]["items"][1]["clip"].clone();
    run(&mut kit, &id, "playhead.set", json!({ "seconds": 1 }), Origin::User);
    run(&mut kit, &id, "timeline.select", json!({ "clips": [red] }), Origin::User);
    let before = editor(&mut kit, &id);
    let saved = kit.context_get(&id).unwrap();
    kit.context_set(&id, &params(json!({ "time": 3.5, "on": [blue] }))).unwrap();
    assert!(!kit.document(&id).unwrap().dirty, "setting the context is no edit");
    assert_eq!(kit.describe(&id).unwrap().state, described, "setting the context changed what the agent reads");
    let cut = run(&mut kit, &id, "timeline.razor", json!({ "clip": blue }), Origin::Agent);
    assert_eq!(cut["cuts"], json!(1), "{cut}");
    kit.context_restore(&id, &saved).unwrap();
    assert_eq!(editor(&mut kit, &id), before);
    let starts: Vec<i64> =
        kit.describe(&id).unwrap().state["sequence"]["video"][0]["items"].as_array().unwrap().iter().map(|clip| clip["start"].as_i64().unwrap()).collect();
    // The sequence runs at 23.976 fps: 3.5 s is in frame 83, which starts at 3.4618 s.
    assert_eq!(starts, [0, 2 * SECOND, 83 * 1_001 * SECOND / 24_000]);
    let _ = std::fs::remove_dir_all(root);
}

/// An id, sequence or time the project lacks is `invalid_params`, saying what is valid.
#[test]
fn what_the_project_lacks_is_invalid_params() {
    let (mut kit, id, root) = open("refused");
    let before = kit.context_get(&id).unwrap();
    for (context, says) in [
        (json!({ "on": [9_999] }), "film_inspect"),
        (json!({ "time": 60 }), "from 0 to 4.002 s"),
        (json!({ "part": { "sequence": 9_999 } }), "its sequences are"),
        (json!({ "part": { "slide": 1 } }), "this kit's parts are sequences"),
    ] {
        let error = format!("{:?}", kit.context_set(&id, &params(context.clone())).unwrap_err());
        assert!(error.contains("invalid_params") && error.contains(says), "{context}: {error}");
    }
    assert_eq!(kit.context_get(&id).unwrap(), before, "a refused context changes nothing");
    let _ = std::fs::remove_dir_all(root);
}

/// The agent's command list says what each command acts on and reads (`x-khp-role`,
/// `x-khp-reads`, Kit Process Protocol section 6).
#[test]
fn the_agent_sees_what_commands_act_on_and_read() {
    let (mut kit, id, root) = open("schemas");
    let commands = kit.agent_commands(Some(&id)).unwrap();
    let params = |wanted: &str| commands.iter().find(|command| command.id == wanted).map(|command| command.params.clone()).unwrap();
    assert_eq!(params("timeline.razor")["x-khp-reads"], json!(["part", "time", "mode"]));
    assert_eq!(params("clip.enable")["properties"]["clips"]["x-khp-role"], json!("targets"));
    assert!(params("timeline.nudgeRight")["x-khp-reads"].as_array().unwrap().contains(&json!("selection")));
    let _ = std::fs::remove_dir_all(root);
}
