//! commands.rs:1013-1018,1645-1650,2902-2906,2966-2979;
//! project_panel.rs:1380-1393 and project/lib.rs:1392-1416.
//! These handlers consume identities, assigned bin names and source entry
//! addresses. The fallback additionally holds Program material at the playhead.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, Sequence};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("file.newBin", "parent"),
    ("project.select", "selection"),
    ("project.renameBin", "bin by ID"),
    ("project.moveToBin", "items"),
    ("sequence.revealInProject", "reveal"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0xb40929b518ec4e05
        && hash(include_str!("../../../../crates/engine/engine/src/project_panel.rs")) == 0x05feb2b3bbb4f4b0
        && hash(include_str!("../../../../crates/engine/project/src/lib.rs")) == 0x784d4865cb75caf9
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["unconsumed-program-material"];
    match command {
        "file.newBin" => out.push("unnamed-bin-parent-content"),
        "project.select" => out.push("selection-target-content"),
        "project.renameBin" => out.push("whole-renamed-bin"),
        "project.moveToBin" => out.extend(["coarse-selection-state", "unconsumed-selection", "moved-item-content", "destination-bin-content"]),
        "sequence.revealInProject" => out.push("whole-revealed-item"),
        _ => {}
    }
    out
}

pub(super) fn program(q: &Sequence, at: i64) -> Under {
    let mut want = Under::default();
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
    want
}

#[test]
fn project_identity_paths_compare_parent_fallbacks_selections_addresses_and_assignment_masks() {
    for populated in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        let item = doc.execute("file.newColorMatte", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
        let bin = doc.execute("file.newBin", json!({"name":"Parent"})).unwrap()["bin"].as_u64().unwrap();
        let child = doc.execute("file.newBin", json!({"name":"Child","parent":bin})).unwrap()["bin"].as_u64().unwrap();
        if populated {
            doc.execute("timeline.place", json!({"item":item,"time":0,"track":"V1"})).unwrap();
        }
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        for selected in [vec![], vec![item], vec![sequence, item], vec![bin, child]] {
            doc.execute("project.select", json!({"items":selected})).unwrap();
            for time in [0, 254_016_000_000i64, 762_048_000_000i64] {
                doc.execute("playhead.set", json!({"time":time})).unwrap();
                let at = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
                for &(command, path) in PATHS {
                    assert!(compared_path(command, path));
                    let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                    assert!(spec.enabled && spec.mutates && spec.places.is_empty());
                    let target = match command {
                        "project.select" | "project.moveToBin" => Some("items"),
                        "sequence.revealInProject" => Some("item"),
                        _ => None,
                    };
                    assert_eq!(spec.targets, target);
                    assert_eq!(
                        spec.reads,
                        match command {
                            "project.moveToBin" => vec![EditorState::Selection],
                            "sequence.revealInProject" => vec![EditorState::Part],
                            _ => vec![],
                        }
                    );
                    let objects = match command {
                        "file.newBin" => vec!["parent"],
                        "project.renameBin" | "project.moveToBin" => vec!["bin"],
                        _ => vec![],
                    };
                    assert_eq!(spec.objects, objects);
                    let types = match command {
                        "file.newBin" => vec![("parent", &["Bin"][..])],
                        "project.select" => vec![("items", &["Item", "Bin"][..])],
                        "project.renameBin" => vec![("bin", &["Bin"][..])],
                        "project.moveToBin" => vec![("items", &["Item"][..]), ("bin", &["Bin"][..])],
                        _ => vec![("item", &["Item"][..])],
                    };
                    assert_eq!(spec.object_types, types);
                    assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                    let params: Vec<Value> = match command {
                        "file.newBin" => [None, Some(Value::Null), Some(json!("New")), Some(json!(""))]
                            .into_iter()
                            .flat_map(|name| {
                                [None, Some(Value::Null), Some(json!(project.root.id.0)), Some(json!(bin)), Some(json!(child))].into_iter().map(move |parent| {
                                    let mut p = json!({});
                                    if let Some(name) = &name {
                                        p["name"] = name.clone();
                                    }
                                    if let Some(parent) = parent {
                                        p["parent"] = parent;
                                    }
                                    p
                                })
                            })
                            .collect(),
                        "project.select" => {
                            vec![json!({"items":[]}), json!({"items":[item]}), json!({"items":[bin,child]}), json!({"items":[item,sequence,item]})]
                        }
                        "project.renameBin" => vec![json!({"bin":bin,"name":"Renamed"}), json!({"bin":child,"name":"Renamed child"})],
                        "project.moveToBin" => [json!({}), json!({"items":[]}), json!({"items":[item]}), json!({"items":[sequence,item]})]
                            .into_iter()
                            .flat_map(|p| {
                                [Value::Null, json!(bin), json!(child)].into_iter().map(move |bin| {
                                    let mut p = p.clone();
                                    p["bin"] = bin;
                                    p
                                })
                            })
                            .collect(),
                        _ => vec![json!({}), json!({"item":null}), json!({"item":sequence}), json!({"item":item})],
                    };
                    for p in params {
                        let want = if command == "file.newBin" && p["name"].is_string() {
                            Under {
                                premises: vec![
                                    Premise::on(json!(p["parent"].as_u64().unwrap_or(project.root.id.0)))
                                        .fields(Vec::<String>::new())
                                        .positions(Vec::<String>::new()),
                                ],
                                ..Default::default()
                            }
                        } else {
                            program(q, at)
                        };
                        assert_eq!(
                            normalized(doc.under(command, &p).unwrap().unwrap()),
                            normalized(want),
                            "{command}/{p}/selected={selected:?}/populated={populated}/time={time}"
                        );
                    }
                }
            }
        }
    }
}
