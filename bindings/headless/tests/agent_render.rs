//! The agent's view of a film through `kition-film` served headless: the preview is the kit's
//! render command (`agent.render` in kit.json), run as the agent, and what `view.describe` answers
//! (the `film_inspect` details) is the document alone: moving the playhead or selecting clips,
//! which are the editor's state, changes neither, and rendering changes nothing.

use kition_film_kit::FilmDocument;
use kition_headless::{Headless, HostFolder, KitInfo};
use kition_kit::KitDocument;
use kition_kit_server::protocol::Origin;
use kition_kit_server::{KitBackend, OpenRequest};
use serde_json::{Map, Value, json};

const MANIFEST: &str = include_str!("../../../kit.json");

fn params(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// A 320 x 180 sequence, red for a second and blue for the next, saved in a fresh workspace.
fn workspace(name: &str) -> (std::path::PathBuf, HostFolder) {
    let root = std::env::temp_dir().join(format!("kition-film-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    for (color, seconds) in [("#ff0000", 0), ("#0000ff", 1)] {
        let matte = doc.execute("item.newColorMatte", json!({ "color": color, "seconds": 1 })).unwrap();
        doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": seconds })).unwrap();
    }
    std::fs::write(root.join("Edit.kfilm"), doc.save(None).unwrap()).unwrap();
    let folder = HostFolder::new(&root).unwrap();
    (root, folder)
}

/// The headless kit as the `kition-film` executable makes it.
fn kit() -> Headless<FilmDocument> {
    let info = KitInfo::from_manifest(MANIFEST, kition_film_kit::files::AGENT_FILE_COMMANDS, kition_film_kit::EDITOR_STATE).unwrap();
    Headless::<FilmDocument>::with_replica_port(info)
}

fn run(kit: &mut Headless<FilmDocument>, id: &str, command: &str, value: Value, origin: Origin) -> Value {
    kit.execute(id, command, params(value), origin).unwrap_or_else(|error| panic!("{command}: {error:?}")).result.unwrap_or(Value::Null)
}

#[test]
fn the_manifest_names_the_render_command() {
    let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
    assert_eq!(manifest["agent"]["render"], json!("file.render"));
}

#[test]
fn the_agent_renders_a_time_and_changes_nothing() {
    let (root, folder) = workspace("agent-render");
    let mut kit = kit();
    kit.set_host(folder.host());
    let id = kit.open(OpenRequest { file: &folder.file("Edit.kfilm").unwrap(), read_only: false, create: None }).unwrap().id;
    let described = kit.describe(&id).unwrap().state;
    let done = kit.execute(&id, "file.render", params(json!({ "target": { "time": 1.5 }, "scale": 1, "maxSize": 1024 })), Origin::Agent).unwrap();
    assert!(!done.changed, "rendering is no edit");
    let answer = done.result.unwrap();
    assert!(answer["png"].as_str().is_some_and(|png| !png.is_empty()), "{answer}");
    assert_eq!((answer["width"].as_u64(), answer["height"].as_u64()), (Some(320), Some(180)));
    assert!(!kit.document(&id).unwrap().dirty, "rendering leaves the document clean");
    assert_eq!(kit.describe(&id).unwrap().state, described);
    // Out of range, the agent is told the range, as invalid parameters.
    let error = kit.execute(&id, "file.render", params(json!({ "target": { "time": 9 } })), Origin::Agent).unwrap_err();
    let shown = format!("{error:?}");
    assert!(shown.contains("invalid_params") && shown.contains("/target/time") && shown.contains("from 0 to 2.001 s"), "{shown}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn the_playhead_and_the_selection_are_no_part_of_the_description() {
    let (root, folder) = workspace("describe-playhead");
    let mut kit = kit();
    kit.set_host(folder.host());
    let id = kit.open(OpenRequest { file: &folder.file("Edit.kfilm").unwrap(), read_only: false, create: None }).unwrap().id;
    let before = kit.describe(&id).unwrap().state;
    run(&mut kit, &id, "playhead.set", json!({ "seconds": 1.5 }), Origin::User);
    let clip = before["sequence"]["video"][0]["items"][1]["clip"].clone();
    run(&mut kit, &id, "timeline.select", json!({ "clips": [clip] }), Origin::User);
    let after = kit.describe(&id).unwrap().state;
    assert_eq!(after, before, "the editor's playhead and selection changed what the agent reads of the document");
    for key in kition_film_kit::EDITOR_STATE {
        assert!(!serde_json::to_string(&after).unwrap().contains(&format!("\"{key}\"")), "{key} is the editor's, not the document's");
    }
    let _ = std::fs::remove_dir_all(root);
}
