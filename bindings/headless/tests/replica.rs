//! `kition-film` as an engine contract 2 kit (KHP E11 to E14a, manifest K10 to K14): `kit.json` names
//! the KDM schema the engine's replica uses, the headless kit serves the replica methods
//! (`model.open`, `model.import`, `model.export`, `model.save`) and the object model, and an
//! agent's call runs as the agent, so it undoes in the agent's scope and never in the person's
//! (KHP A11, KitModel M12a).

use kition_film_kit::FilmDocument;
use kition_headless::{Headless, HostFolder, KitInfo};
use kition_kit::KitDocument;
use kition_kit_server::protocol::Origin;
use kition_kit_server::{ErrorReason, KitBackend, OpenRequest};
use serde_json::{Map, Value, json};

const MANIFEST: &str = include_str!("../../../kit.json");
const SCHEMA: &str = include_str!("../../../crates/kdm/kdm-model/model/schema.json");
const NAME: &str = "Edit.kfilm";

fn kit() -> Headless<FilmDocument> {
    Headless::with_replica_port(KitInfo::from_manifest(MANIFEST, &["file.import"], &[]).unwrap())
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for k in 0..4 {
            out.push(if k <= chunk.len() { char::from(BASE64[((n >> (18 - 6 * k)) & 63) as usize]) } else { '=' });
        }
    }
    out
}

fn decode(text: &str) -> Vec<u8> {
    let (mut out, mut buffer, mut bits) = (Vec::new(), 0u32, 0u32);
    for byte in text.trim_end_matches('=').bytes() {
        let value = BASE64.iter().position(|known| *known == byte).expect("base64");
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    out
}

fn params(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// The names of the project's items, in every bin.
fn item_names(doc: &FilmDocument) -> Vec<String> {
    fn walk(node: &Value, names: &mut Vec<String>) {
        if node.get("item").is_some() {
            names.push(node["name"].as_str().unwrap_or_default().to_owned());
        }
        for child in node["children"].as_array().into_iter().flatten() {
            walk(child, names);
        }
        for bin in node["bins"].as_array().into_iter().flatten() {
            walk(bin, names);
        }
        if let Some(root) = node.get("root") {
            walk(root, names);
        }
    }
    let mut names = Vec::new();
    walk(&doc.inspect().unwrap()["project"], &mut names);
    names.sort();
    names
}

fn matte(doc: &mut FilmDocument, color: &str) {
    doc.execute("file.newColorMatte", json!({ "color": color, "seconds": 2 })).unwrap();
}

#[test]
fn the_manifest_names_engine_contract_2_and_the_engines_kdm_schema() {
    let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
    assert_eq!(manifest["engine"]["contract"], 2);
    assert_eq!(manifest["engine"]["runtime"], "rust-wasm");
    assert!(manifest["capabilities"].as_array().unwrap().iter().any(|capability| capability == "kdm"));
    assert_eq!(manifest["model"]["schema"], "crates/kdm/kdm-model/model/schema.json");
    let schema = kition_kit::kdm::Schema::parse(SCHEMA).unwrap();
    assert_eq!(schema.kit, manifest["id"].as_str().unwrap());
    assert_eq!(manifest["model"]["schemaVersion"], json!(schema.schema_version));
    assert_eq!(manifest["objectModel"]["namespace"], "Film");
    // The headless kit serves `model.describe` and `model.batch`, so the manifest offers the
    // object model tools (`film_query`, `film_batch`; KHP K16, A35).
    assert_eq!(manifest["agent"]["objectModel"], true);
    let features = manifest["headless"]["features"].as_array().unwrap();
    assert!(["model.describe", "model.batch"].iter().all(|feature| features.iter().any(|listed| listed == feature)), "{features:?}");
    assert!(manifest["collaboration"]["merge"].as_array().unwrap().iter().any(|class| class == "timeline"));
}

#[test]
fn opens_a_room_without_a_file_and_imports_exports_and_saves_it() {
    let mut kit = kit();
    let features = kit.capabilities()["features"].clone();
    for feature in ["model.open", "model.import", "model.export", "model.save"] {
        assert!(features.as_array().unwrap().iter().any(|listed| listed == feature), "{feature} in {features}");
    }

    // The room's project, as a collaborator holds it: its replica conforms to the schema the
    // manifest names, or the kit could not open it.
    let mut peer = FilmDocument::create(NAME, 320, 180).unwrap();
    matte(&mut peer, "#ff0000");
    let snapshot = peer.snapshot().unwrap();
    let opened = kit.model("model.open", json!({ "name": NAME, "snapshot": encode(&snapshot) })).unwrap();
    let id = opened["documentId"].as_str().unwrap().to_owned();
    assert_eq!(opened["format"], "film");

    let since = peer.version().unwrap();
    matte(&mut peer, "#00ff00");
    kit.model("model.import", json!({ "documentId": id, "changes": encode(&peer.export_changes(&since).unwrap()) })).unwrap();

    let batch = json!({ "documentId": id, "ops": [{ "op": "command", "id": "file.newColorMatte", "params": { "color": "#0000ff", "seconds": 2 } }] });
    kit.model("model.batch", batch).unwrap();
    let exported = kit.model("model.export", json!({ "documentId": id, "since": encode(&peer.version().unwrap()) })).unwrap();
    peer.import_changes(&decode(exported["changes"].as_str().unwrap())).unwrap();
    let mattes = item_names(&peer).into_iter().filter(|name| name == "Color Matte").count();
    assert_eq!(mattes, 3, "the peer's two mattes and the kit's: {:?}", item_names(&peer));

    let saved = kit.model("model.save", json!({ "documentId": id })).unwrap();
    assert_eq!((saved["name"].as_str(), saved["format"].as_str()), (Some(NAME), Some("film")));
    let file = FilmDocument::open(NAME, &decode(saved["data"].as_str().unwrap())).unwrap();
    assert_eq!(item_names(&file), item_names(&peer));
}

#[test]
fn describes_reads_and_writes_the_object_model() {
    let mut kit = kit();
    let mut peer = FilmDocument::create(NAME, 320, 180).unwrap();
    matte(&mut peer, "#ff0000");
    let opened = kit.model("model.open", json!({ "name": NAME, "snapshot": encode(&peer.snapshot().unwrap()) })).unwrap();
    let id = opened["documentId"].as_str().unwrap().to_owned();

    let described = kit.model("model.describe", json!({ "documentId": id })).unwrap();
    for ty in ["Project", "Bin", "Item", "Sequence", "Track", "Clip"] {
        assert!(described["types"].get(ty).is_some(), "{ty} in {}", described["types"]);
    }

    // Read the matte's item by following the root's bins, then rename it with a model operation.
    let load = |kit: &mut Headless<FilmDocument>, target: &str| {
        kit.model("model.batch", json!({ "documentId": id, "ops": [], "load": [{ "target": target }] })).unwrap()["loaded"][0].clone()
    };
    let root = load(&mut kit, "root");
    let mut matte_item = None;
    for bin in root["fields"]["bins"].as_array().unwrap() {
        for entry in load(&mut kit, bin["object"].as_str().unwrap())["fields"]["entries"].as_array().unwrap() {
            if load(&mut kit, entry.as_str().unwrap())["fields"]["name"] == "Color Matte" {
                matte_item = Some(entry.as_str().unwrap().to_owned());
            }
        }
    }
    let matte_item = matte_item.expect("the matte is an Item of the object model");
    kit.model("model.batch", json!({ "documentId": id, "ops": [{ "op": "set", "target": matte_item, "field": "name", "value": "Opening Matte" }] })).unwrap();

    // The engine took the write: the peer and the saved file both have the new name.
    let exported = kit.model("model.export", json!({ "documentId": id, "since": encode(&peer.version().unwrap()) })).unwrap();
    peer.import_changes(&decode(exported["changes"].as_str().unwrap())).unwrap();
    assert_eq!(item_names(&peer), ["Opening Matte", "Sequence 01"]);
    let saved = kit.model("model.save", json!({ "documentId": id })).unwrap();
    assert_eq!(item_names(&FilmDocument::open(NAME, &decode(saved["data"].as_str().unwrap())).unwrap()), ["Opening Matte", "Sequence 01"]);
}

#[test]
fn never_opens_an_empty_project_for_a_replica_it_cannot_read() {
    let mut kit = kit();
    for snapshot in [&b"not a replica"[..], &b""[..]] {
        let error = kit.model("model.open", json!({ "name": NAME, "snapshot": encode(snapshot) })).unwrap_err();
        assert_eq!(error.code, ErrorReason::UnsupportedFormat.code(), "{error:?}");
    }
}

#[test]
fn an_agents_edit_undoes_in_the_agents_scope_only() {
    let root = std::env::temp_dir().join(format!("kition-film-replica-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    let file = root.join(NAME);
    std::fs::write(&file, FilmDocument::create(NAME, 320, 180).unwrap().save(None).unwrap()).unwrap();
    let mut kit = kit();
    let folder = HostFolder::new(&root).unwrap();
    kit.set_host(folder.host());
    let id = kit.open(OpenRequest { file: &folder.file(NAME).unwrap(), read_only: false, create: None }).unwrap().id;

    let matte = params(json!({ "color": "#ff0000", "seconds": 2 }));
    assert!(kit.execute(&id, "file.newColorMatte", matte, Origin::Agent).unwrap().changed);
    // The person's Undo does not take back the agent's edit.
    let person = kit.execute(&id, "edit.undo", params(json!({ "scope": "person" })), Origin::User).unwrap();
    assert!(!person.changed, "{person:?}");
    // The agent's own Undo does.
    let agent = kit.execute(&id, "edit.undo", Map::new(), Origin::Agent).unwrap();
    assert!(agent.changed, "{agent:?}");
    let _ = std::fs::remove_dir_all(&root);
}
