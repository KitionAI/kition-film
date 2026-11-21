//! `kition-film` as `kition-headless` serves it: a parameter of the wrong JSON type is refused by the
//! SDK's schema check (KHP A5, A18), for the agent and the person alike, and the project stays as
//! it was.

use kition_film_kit::FilmDocument;
use kition_headless::{Headless, HostFolder, KitInfo};
use kition_kit::KitDocument;
use kition_kit_server::protocol::Origin;
use kition_kit_server::{ErrorReason, KitBackend, OpenRequest};
use serde_json::{Map, Value, json};

fn params(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

#[test]
fn a_parameter_of_the_wrong_type_is_refused() {
    let root = std::env::temp_dir().join(format!("kition-film-params-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    let file = root.join("a.kfilm");
    std::fs::write(&file, FilmDocument::create("a.kfilm", 320, 180).unwrap().save(None).unwrap()).unwrap();
    let mut kit =
        Headless::<FilmDocument>::new(KitInfo::from_manifest(include_str!("../../../kit.json"), &["file.import"], kition_film_kit::EDITOR_STATE).unwrap());
    let folder = HostFolder::new(&root).unwrap();
    kit.set_host(folder.host());
    let id = kit.open(OpenRequest { file: &folder.file("a.kfilm").unwrap(), read_only: false, create: None }).unwrap().id;
    for origin in [Origin::Agent, Origin::User] {
        let error = kit.execute(&id, "file.newColorMatte", params(json!({ "color": { "not": "a colour" }, "seconds": 2 })), origin).unwrap_err();
        assert_eq!(error.code, ErrorReason::InvalidParams.code());
        let detail = error.data.unwrap()["detail"].as_str().unwrap().to_owned();
        assert!(detail.contains("`color`: expected a string"), "{detail}");
        assert!(!kit.document(&id).unwrap().dirty, "the project stays as it was");
    }
    let made = kit.execute(&id, "file.newColorMatte", params(json!({ "color": "#ff0000", "seconds": 2 })), Origin::Agent).unwrap();
    assert!(made.changed);
    let _ = std::fs::remove_dir_all(root);
}
