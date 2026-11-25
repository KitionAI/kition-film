//! commands.rs:1258-1266,3986-4076 and project_tools.rs:679-720:
//! Revert and template replacement assign the entire root. Save All delegates
//! to Save, serializing the entire project and adopting the saved file's name.
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[("file.revert", "load"), ("file.saveAll", "save"), ("file.newProjectFromTemplate", "replace")];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0x95526b4360647be4
        && hash(include_str!("../../../../crates/engine/engine/src/project_tools.rs")) == 0xf8d2f12928fa34b4
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command == "file.saveAll" { vec!["coarse-mode-state", "coarse-active-state"] } else { vec![] }
}
#[test]
fn root_actions_hold_every_serialized_or_replaced_field_in_empty_and_populated_projects() {
    for (populated, saved) in [(false, false), (false, true), (true, false), (true, true)] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        if populated {
            let item = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
            doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap();
        }
        if saved {
            doc = FilmDocument::open("Edit.kfilm", &doc.save(None).unwrap()).unwrap();
        }
        for at in [0, 254_016_000_000i64, 762_048_000_000i64] {
            doc.execute("playhead.set", json!({"time":at})).unwrap();
            for &(command, path) in PATHS {
                assert!(compared_path(command, path));
                let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                assert!(spec.mutates && spec.targets.is_none(), "{command}");
                assert_eq!(spec.enabled, command != "file.revert" || saved, "{command}");
                assert!(spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty());
                assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                assert_eq!(
                    spec.reads,
                    // Save All writes the project only (the open sequence is the person's view state, never the file's): it reads no editor state.
                    if command == "file.saveAll" { vec![] } else { vec![EditorState::Part] }
                );
                for force in [false, true] {
                    let params =
                        if command == "file.newProjectFromTemplate" { json!({"template":"Fixture.kfilm","force":force,"name":"Assigned"}) } else { json!({}) };
                    assert_eq!(
                        doc.under(command, &params).unwrap(),
                        Some(Under { premises: vec![Premise::on(json!("project"))], ..Default::default() }),
                        "{command}/{populated}/{at}/{force}"
                    );
                }
            }
        }
    }
}
