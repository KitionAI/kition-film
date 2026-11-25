//! clip_ops.rs:859-878; project_tools.rs:89; wasm/lib.rs:541-543.
//! A terminal close consumes the local dirty flag. Force explicitly permits
//! discarding current document content; no old project value is an input.
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[("file.closeProject", "force/default"), ("file.closeAllProjects", "delegate")];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/clip_ops.rs")) == 0x973a242360050d16
        && hash(include_str!("../../../../crates/engine/engine/src/project_tools.rs")) == 0xf8d2f12928fa34b4
}

#[test]
fn closing_paths_compare_force_dirty_eligibility_and_terminal_results() {
    for &(command, path) in PATHS {
        assert!(compared_path(command, path));
        for dirty in [false, true] {
            for force in [None, Some(Value::Null), Some(json!(false)), Some(json!(true))] {
                let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
                if dirty {
                    doc.execute("bin.add", json!({"name":"Unsaved"})).unwrap();
                }
                assert_eq!(doc.dirty(), dirty);
                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                assert!(spec.enabled && spec.mutates && spec.reads.is_empty());
                assert!(spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty());
                assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                let mut params = json!({});
                if let Some(force) = force {
                    params["force"] = force;
                }
                assert_eq!(doc.under(command, &params).unwrap(), Some(Under::default()));
                let before = doc.save(None).unwrap();
                if dirty && params["force"] != true {
                    let error = doc.execute(command, params).unwrap_err();
                    assert!(error.contains("unsaved changes"), "{command}: {error}");
                    assert_eq!(doc.save(None).unwrap(), before);
                } else {
                    assert_eq!(doc.execute(command, params).unwrap(), json!({"closed":true}));
                    assert!(!doc.dirty());
                    let saved = doc.save(None).unwrap();
                    assert!(kition_film_format::decode(&saved).unwrap().project.items.is_empty());
                }
            }
        }
    }
}
