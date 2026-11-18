//! C8-film-pin: all blocked blind paths stop before command dispatch.
#[path = "../../wasm/tests/declarations_independent/blocked_compare.rs"]
mod blocked_compare;
mod common;
use common::*;
use kition_film_kit::FilmDocument;
use kition_headless::{Headless, HostFolder, KitInfo};
use kition_kit::KitDocument;
use kition_kit_server::protocol::Origin;
use kition_kit_server::{KitBackend, OpenRequest};
use serde_json::{Value, json};

#[test]
fn blocked_commands_cannot_reach_handlers_directly_or_through_raw_model_batches() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join(FILE), project(1)).unwrap();
    let folder = HostFolder::new(workspace.path()).unwrap();
    let info = KitInfo::from_manifest(include_str!("../../../kit.json"), kition_film_kit::files::AGENT_FILE_COMMANDS, &[]).unwrap();
    let mut kit = Headless::<FilmDocument>::with_replica_port(info);
    kit.set_host(folder.host());
    let opened = kit.open(OpenRequest { file: &folder.file(FILE).unwrap(), read_only: false, create: None }).unwrap();
    let before = std::fs::read(workspace.path().join(FILE)).unwrap();
    let specs = FilmDocument::open(FILE, &before).unwrap().commands();
    for &(command, path) in blocked_compare::PATHS {
        for params in [
            json!({}),
            json!({"path":"Input.srt","dir":"out","destination":"out","discard":true}),
            json!({"path":"Output.srt","overwrite":false,"force":false}),
        ] {
            let schema = specs.iter().find(|spec| spec.id == command).unwrap().schema.as_ref().unwrap();
            let params = Value::Object(
                params.as_object().unwrap().iter().filter(|(name, _)| schema.get(*name).is_some()).map(|(name, value)| (name.clone(), value.clone())).collect(),
            );
            let error = kit.execute(&opened.id, command, params.as_object().unwrap().clone(), Origin::Agent).expect_err(command);
            assert!(format!("{error:?}").contains("disabled") || format!("{error:?}").contains("not available"), "{command}/{path}: {error:?}");
            for origin in [Value::Null, json!({"kind":"agent","principal":"probe"}), json!({"kind":"person","principal":"probe"})] {
                let mut request = json!({"documentId":opened.id,"ops":[{"op":"command","id":command,"params":params}]});
                if !origin.is_null() {
                    request["origin"] = origin;
                }
                let error = kit.model("model.batch", request).expect_err(command);
                assert!(format!("{error:?}").contains("disabled") || format!("{error:?}").contains("not available"), "{command}/{path}: {error:?}");
            }
            assert_eq!(std::fs::read(workspace.path().join(FILE)).unwrap(), before);
        }
    }
    assert_eq!(std::fs::read_dir(workspace.path()).unwrap().count(), 1);
}
