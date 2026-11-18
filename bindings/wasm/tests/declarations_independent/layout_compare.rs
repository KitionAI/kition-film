//! Layout operands from project_panel.rs:542-866, retaining the blind rows.
//! A card reads its own literal metadata, not a nested path named by that key.
use kition_film_engine::project::{Bin, BinEntry, ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

use super::sync_compare::normalized;

pub const PATHS: &[(&str, &str)] = &[
    ("project.freeform.move", "positions object"),
    ("project.freeform.move", "items/item/selection relative offsets"),
    ("project.freeform.resize", "absolute size or step"),
    ("project.freeform.alignToGrid", "bin default root"),
    ("project.freeform.reset", "bin default root"),
    ("project.freeform.stack", "selected cards"),
    ("project.freeform.unstack", "selected cards and stack members"),
    ("project.freeform.saveArrangement", "bin default root"),
    ("project.freeform.restoreArrangement", "bin default root"),
    ("project.freeform.deleteArrangement", "bin default root"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
        && include_str!("../../../../crates/engine/engine/src/project_panel.rs")
            .bytes()
            .fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3))
            == 0x05feb2b3bbb4f4b0
}

fn relative(command: &str) -> bool {
    ["project.freeform.move", "project.freeform.resize", "project.freeform.stack", "project.freeform.unstack"].contains(&command)
}

pub fn more(command: &str, path: &str) -> Vec<&'static str> {
    let mut more = Vec::new();
    if !matches!(command, "project.freeform.restoreArrangement" | "project.freeform.deleteArrangement") {
        more.push("coarse-mode-state");
    }
    if relative(command) {
        more.push("coarse-selection-state");
    }
    if path != "positions object" {
        more.push("coarse-layout-profile");
        more.push("unlisted-sibling-order");
        if relative(command) {
            more.push("item-sibling-index");
        } else {
            more.push("unconsumed-selection-targets");
        }
    }
    more
}

fn leaf(id: Value, fields: impl IntoIterator<Item = String>) -> Premise {
    Premise::on(id).fields(fields).positions(Vec::<String>::new())
}

fn metadata(key: &str) -> String {
    if key.contains(['.', '[', ']', '/', '~']) {
        format!("/props/common/metadata/{}", key.replace('~', "~0").replace('/', "~1"))
    } else {
        format!("props.common.metadata.{key}")
    }
}

fn expected(project: &Project, command: &str, bin: &Bin, selected: &[u64], name: &str) -> Under {
    let pos = metadata("Freeform Position");
    let stack = metadata("Freeform Stack");
    let layout = !matches!(command, "project.freeform.reset" | "project.freeform.restoreArrangement" | "project.freeform.deleteArrangement");
    let mut answer = Under { premises: vec![leaf(json!(bin.id.0), ["~entryOrder".into()])], ..Default::default() };
    for entry in &bin.children {
        let BinEntry::Item(id) = entry else { continue };
        let Some(item) = project.item(*id) else { continue };
        let mut fields = vec!["kind".into()];
        let graphic = matches!(item.kind, ItemKind::Graphic { .. });
        if graphic {
            answer.premises.push(leaf(json!("project"), ["docState.source_graphics".into()]));
        }
        if !graphic || project.source_graphics.contains_key(id) {
            if layout || command == "project.freeform.reset" || command == "project.freeform.restoreArrangement" {
                fields.push(pos.clone());
            }
            if layout || command == "project.freeform.reset" {
                fields.push(stack.clone());
            }
            if command.ends_with("Arrangement") {
                let name = if command == "project.freeform.saveArrangement" { name.trim() } else { name };
                let hex = name.bytes().map(|byte| format!("{byte:02x}")).collect::<String>();
                answer.premises.push(leaf(json!("film:item-premises"), [format!("items.i{}.arrangements.a{hex}", id.0)]));
            }
        }
        answer.premises.push(leaf(json!(id.0), fields));
    }
    for id in selected {
        if !answer.premises.iter().any(|need| need.id == json!(id)) {
            answer.premises.push(leaf(json!(id), [pos.clone(), stack.clone()]));
        }
    }
    if relative(command)
        && let Some(first) = selected.first()
    {
        answer.premises.iter_mut().find(|need| need.id == json!(first)).unwrap().positions = Some(vec!["entries".into()]);
    }
    if command == "project.freeform.unstack" {
        for item in project.items.values() {
            let mut fields = vec![stack.clone()];
            let anchor = item.metadata.get("Freeform Stack").and_then(|anchor| anchor.parse::<u64>().ok());
            if selected.contains(&item.id.0) || anchor.is_some_and(|anchor| selected.contains(&anchor)) {
                fields.push(pos.clone());
            }
            answer.premises.push(leaf(json!(item.id.0), fields));
        }
    }
    normalized(answer)
}

#[test]
fn layout_paths_compare_target_precedence_bin_defaults_visibility_and_literal_names() {
    for shared in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let mut items = Vec::new();
        for name in ["First", "Second", "Outside"] {
            items.push(doc.execute("file.newColorMatte", json!({"seconds":1,"name":name})).unwrap()["item"].as_u64().unwrap());
        }
        let bin_id = doc.execute("file.newBin", json!({"name":"Cards"})).unwrap()["bin"].as_u64().unwrap();
        doc.execute("project.moveToBin", json!({"items":&items[..2],"bin":bin_id})).unwrap();
        doc.execute("project.freeform.stack", json!({"items":&items[..2]})).unwrap();
        let graphic = doc.execute("graphics.newText", json!({"newClip":true,"text":"Graphic","time":0,"track":0})).unwrap()["clip"].clone();
        if shared {
            doc.execute("graphics.upgradeToSourceGraphic", json!({"clip":graphic})).unwrap();
        }
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        for &(command, path) in PATHS {
            assert!(compared_path(command, path));
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            let mut reads = if relative(command) { vec![EditorState::Selection] } else { vec![] };
            if !matches!(command, "project.freeform.restoreArrangement" | "project.freeform.deleteArrangement") {
                reads.push(EditorState::Mode);
            }
            assert_eq!(spec.reads, reads, "{command}");
            assert!(spec.mutates && spec.places.is_empty() && spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none());
            assert!(!spec.index_numbers && !spec.index_reversed);
            assert_eq!(spec.targets, relative(command).then_some("items"));
            let objects = if matches!(command, "project.freeform.stack" | "project.freeform.unstack") {
                vec!["item"]
            } else if relative(command) {
                vec![]
            } else {
                vec!["bin"]
            };
            assert_eq!(spec.objects, objects, "{command}");
            for selected in [vec![], vec![items[0]], items[..2].to_vec(), vec![items[2], items[0]]] {
                doc.execute("project.select", json!({"items":selected})).unwrap();
                for address in 0..3 {
                    let resolved = if address == 1 { selected.first().copied().into_iter().collect::<Vec<_>>() } else { selected.clone() };
                    for bin in [None, Some(project.root.id.0), Some(bin_id), Some(u64::MAX)] {
                        for name in ["Working", " Review.v1 ", "Review[1]", "Review/mix~1"] {
                            let mut params = json!({"x":100,"y":200,"size":96,"step":1,"width":640,"grid":12,"snap":false});
                            if command.ends_with("Arrangement") {
                                params["name"] = json!(name);
                            }
                            if address == 0 {
                                params["items"] = json!(selected);
                            }
                            if address == 1
                                && let Some(first) = selected.first()
                            {
                                params["item"] = json!(first);
                            }
                            if let Some(bin) = bin {
                                params["bin"] = json!(bin);
                            }
                            let expected = if path == "positions object" {
                                let positions: serde_json::Map<String, Value> = selected.iter().map(|id| (id.to_string(), json!([100, 200]))).collect();
                                params["positions"] = json!(positions);
                                normalized(Under {
                                    premises: selected.iter().map(|id| leaf(json!(id), [metadata("Freeform Position")])).collect(),
                                    ..Default::default()
                                })
                            } else {
                                let bin =
                                    if relative(command) { resolved.first().and_then(|id| project.root.parent_of(ItemId(*id))).map(|id| id.0) } else { bin };
                                let bin = bin.and_then(|id| project.root.find_bin(kition_film_engine::project::BinId(id))).unwrap_or(&project.root);
                                expected(&project, command, bin, &resolved, name)
                            };
                            assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap()), expected, "{command}/{path}/{params}");
                        }
                    }
                }
            }
        }
    }
}
