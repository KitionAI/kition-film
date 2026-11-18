//! lib.rs:1111-1157 restores the caller's own replica history; it never
//! resolves an edit from Program time. previews.rs:711 deletes cached files;
//! host sessions use PreviewStore::off_disk, whose file set stays empty.
use super::direct_media_compare::program;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Under};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("edit.undo", "history"),
    ("edit.redo", "history"),
    ("sequence.deleteRenderFiles", "all preview files"),
    ("sequence.deleteRenderFilesInToOut", "range previews"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/lib.rs")) == 0xc36863a28b095245
        && hash(include_str!("../../../../crates/engine/engine/src/previews.rs")) == 0x0d82e7999b7c217a
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command.starts_with("edit.") { vec!["coarse-active-state"] } else { vec!["unconsumed-program-material"] }
}

#[test]
fn history_and_off_disk_cache_paths_compare_empty_and_populated_sequences() {
    for populated in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        if populated {
            let source = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
            doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap();
        }
        for marks in [false, true] {
            if marks {
                doc.execute("markers.markIn", json!({"time":0})).unwrap();
                doc.execute("markers.markOut", json!({"time":254_016_000_000i64})).unwrap();
            }
            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
            for at in [0, 254_016_000_000i64, 762_048_000_000i64] {
                doc.execute("playhead.set", json!({"time":at})).unwrap();
                let at = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
                for &(command, path) in PATHS {
                    assert!(compared_path(command, path));
                    let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                    let history = command.starts_with("edit.");
                    assert!(spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty());
                    assert_eq!(spec.reads, if history { vec![EditorState::Part, EditorState::Active] } else { vec![EditorState::Part] });
                    assert!(spec.places.is_empty() && spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none());
                    assert!(!spec.index_numbers && !spec.index_reversed);
                    for params in [json!({}), json!({"scope":"agent"}), json!({"scope":"person"})] {
                        assert_eq!(
                            doc.under(command, &params).unwrap(),
                            Some(if history { Under::default() } else { program(&project, sequence, at) }),
                            "{command}/{params}"
                        );
                    }
                    if !history && spec.enabled {
                        let before = doc.save(None).unwrap();
                        assert_eq!(doc.execute(command, json!({})).unwrap()["deleted"], 0);
                        assert_eq!(doc.save(None).unwrap(), before);
                    }
                }
            }
        }
    }
}
