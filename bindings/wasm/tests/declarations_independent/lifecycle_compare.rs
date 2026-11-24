//! commands.rs:899-930,1068-1091,1376-1383,1444-1448,1646-1697,
//! 2450-2457; project_panel.rs:1451; panels.rs:349; trim.rs:163.
//! These handlers replace the root or consume local session identities. The
//! legacy fallback also holds Program material for several local commands.
use kition_film_engine::project::ItemId;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("file.newProject", "replace"),
    ("file.openDemoProject", "replace"),
    ("file.importDemoFootage", "fixed"),
    ("jobs.cancel", "job"),
    ("edit.deselectAll", "selection"),
    ("project.deselectAll", "clear"),
    ("events.clear", "session log"),
    ("trim.clear", "editor"),
    ("trim.toggleType", "editor"),
    ("file.close", "delegate"),
    ("sequence.open", "navigation"),
    ("sequence.close", "navigation"),
    ("sequence.closeOthers", "navigation"),
    ("sequence.moveTab", "navigation"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0x36d3e3e1d0ffadcf
        && hash(include_str!("../../../../crates/engine/engine/src/project_tools.rs")) == 0xf8d2f12928fa34b4
        && hash(include_str!("../../../../crates/engine/engine/src/project_panel.rs")) == 0x05feb2b3bbb4f4b0
        && hash(include_str!("../../../../crates/engine/engine/src/panels.rs")) == 0x177d40d4071011d4
        && hash(include_str!("../../../../crates/engine/engine/src/trim.rs")) == 0x8a7edb67cf0883c3
}

pub fn more(command: &str) -> Vec<&'static str> {
    if matches!(command, "file.newProject" | "file.openDemoProject") {
        return vec![];
    }
    let mut out = vec!["unconsumed-program-material"];
    if command == "trim.clear" {
        out.push("coarse-mode-state");
    }
    if matches!(command, "sequence.open" | "sequence.close" | "sequence.closeOthers" | "sequence.moveTab" | "file.close" | "trim.clear" | "trim.toggleType") {
        out.push("coarse-active-state");
    }
    if matches!(command, "file.close" | "sequence.open" | "sequence.close" | "sequence.closeOthers" | "sequence.moveTab") {
        out.push("whole-sequence-navigation-target");
    }
    out
}

#[test]
fn lifecycle_paths_compare_local_identity_inputs_root_replacement_and_extra_program_holds() {
    for populated in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        if populated {
            let item = doc.execute("file.newColorMatte", json!({"seconds":2})).unwrap()["item"].clone();
            doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap();
        }
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        for time in [0, 254_016_000_000i64, 762_048_000_000i64] {
            doc.execute("playhead.set", json!({"time":time})).unwrap();
            let at = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
            for &(command, path) in PATHS {
                assert!(compared_path(command, path));
                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                let sequence_command = matches!(command, "file.close" | "sequence.open" | "sequence.close" | "sequence.closeOthers" | "sequence.moveTab");
                let trim = command.starts_with("trim.");
                let reads = if command == "sequence.open" {
                    vec![EditorState::Active]
                } else if command == "trim.clear" {
                    vec![EditorState::Part, EditorState::Mode, EditorState::Active]
                } else if sequence_command || trim {
                    vec![EditorState::Part, EditorState::Active]
                } else {
                    vec![]
                };
                assert_eq!(spec.reads, reads, "{command}");
                assert!(spec.mutates && spec.objects.is_empty() && spec.places.is_empty());
                assert_eq!(spec.targets, sequence_command.then_some("item"));
                assert_eq!(spec.object_types, if sequence_command { vec![("item", &["Item"][..])] } else { vec![] });
                assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                assert_eq!(spec.enabled, !trim, "{command}");
                for value in [None, Some(json!(null)), Some(json!(sequence)), Some(json!(sequence as f64))] {
                    let mut p = json!({});
                    if sequence_command {
                        if let Some(value) = value {
                            p["item"] = value;
                        }
                        if command == "sequence.moveTab" {
                            p["index"] = json!(0);
                        }
                    }
                    if command == "file.newProject" {
                        p["name"] = json!("New");
                    }
                    if command == "jobs.cancel" {
                        p["job"] = json!(1);
                    }
                    let mut want = Under::default();
                    if matches!(command, "file.newProject" | "file.openDemoProject") {
                        want.premises.push(Premise::on(json!("project")));
                    } else {
                        for track in q.all_tracks() {
                            let from = track.items.iter().take_while(|clip| clip.end().0 <= at).count();
                            let to = track.items.iter().take_while(|clip| clip.start.0 <= at).count().max(from);
                            want.objects.extend(track.items[from..to].iter().map(|clip| json!(clip.id.0)));
                            want.within.push(Within {
                                parent: json!(track.id.0),
                                field: "clips".into(),
                                from,
                                to,
                                time: Some(TimeSpan {
                                    from: json!(at.to_string()),
                                    to: json!(at.to_string()),
                                    start: "start".into(),
                                    duration: Some("duration".into()),
                                    ..Default::default()
                                }),
                            });
                        }
                    }
                    assert_eq!(doc.under(command, &p).unwrap(), Some(want), "{command}/{p}/time={time}/populated={populated}");
                }
            }
        }
    }
}
