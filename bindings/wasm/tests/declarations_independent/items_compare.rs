//! commands.rs:607-633,1449-1468,2173-2184; clip_ops.rs:474-520.
//! ReviewCorrection: Duplicate passes None to add_item, so its destination is
//! the root, not the old bin described by the historical blind reading.
//! Source opening consumes only SourceView.start; its other computed members
//! do not affect this command's result or editor assignment.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, ItemKind};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] =
    &[("project.matteColor", "item"), ("source.open", "open"), ("edit.duplicate", "items"), ("clip.enable", "toggle"), ("timeline.select", "selection")];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0xb40929b518ec4e05
        && hash(include_str!("../../../../crates/engine/engine/src/clip_ops.rs")) == 0x973a242360050d16
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut classes = vec!["coarse-selection-state"];
    if matches!(command, "clip.enable" | "timeline.select") {
        classes.push("coarse-mode-state");
    }
    if command != "edit.duplicate" {
        classes.push("unconsumed-selection");
    }
    classes
}

fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}

fn scalar(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().map(|number| number as u64))
}

#[test]
fn item_commands_compare_explicit_selection_precedence_all_kinds_and_subclip_routes() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let mut items = vec![sequence];
    for command in ["file.newColorMatte", "file.newAdjustmentLayer"] {
        items.push(doc.execute(command, json!({"seconds":2})).unwrap()["item"].as_u64().unwrap());
    }
    let graphic = doc.execute("graphics.newText", json!({"newClip":true,"text":"Text"})).unwrap()["clip"].as_u64().unwrap();
    let initial = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    items.push(initial.sequence(ItemId(sequence)).unwrap().find_item(kition_film_engine::project::ClipId(graphic)).unwrap().1.item.0);
    for restricted in [false, true] {
        items.push(
            doc.execute("clip.makeSubclip", json!({"item":items[1],"start":10_584_000_000i64,"end":254_016_000_000i64,"restrictTrims":restricted}))
                .unwrap()["item"]
                .as_u64()
                .unwrap(),
        );
    }
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for selected in [vec![], vec![items[1]], vec![items[4], items[2]], items.clone()] {
        doc.execute("project.select", json!({"items":selected})).unwrap();
        for &(command, path) in &PATHS[..3] {
            assert!(compared_path(command, path), "review expired: {command}");
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            assert_eq!(spec.reads, [EditorState::Selection], "{command}");
            assert!(spec.mutates && spec.places.is_empty() && spec.objects.is_empty());
            assert_eq!(spec.targets, if command == "edit.duplicate" { None } else { Some("item") });
            assert_eq!(spec.object_types, if command == "edit.duplicate" { vec![] } else { vec![("item", &["Item"][..])] });
            assert_eq!(spec.enabled, command != "edit.duplicate" || !selected.is_empty());
            assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
            for item in [None, Some(Value::Null)].into_iter().chain(items.iter().flat_map(|id| [Some(json!(id)), Some(json!(*id as f64))])) {
                let mut params = json!({"color":"#123456"});
                if let Some(item) = item {
                    params["item"] = item;
                }
                let explicit = params.get("item").and_then(scalar);
                let target =
                    explicit.or_else(|| if command == "project.matteColor" { (selected.len() == 1).then(|| selected[0]) } else { selected.first().copied() });
                let mut expected = Under::default();
                match command {
                    "project.matteColor" => {
                        if let Some(id) = target {
                            expected.premises.push(leaf(id, ["kind", "props.media.media"]));
                        }
                    }
                    "source.open" => {
                        let mut next = target;
                        for _ in 0..=16 {
                            let Some(item) = next.and_then(|id| project.item(ItemId(id))) else { break };
                            let mut fields = vec!["kind"];
                            next = if let ItemKind::Subclip { parent, restrict_trims, .. } = &item.kind {
                                fields.extend(["props.parent", "props.restrict_trims"]);
                                if *restrict_trims {
                                    fields.push("props.range.start");
                                }
                                Some(parent.0)
                            } else {
                                None
                            };
                            expected.premises.push(leaf(item.id.0, fields));
                        }
                    }
                    _ => {
                        for id in &selected {
                            let item = project.item(ItemId(*id)).unwrap();
                            let mut fields = vec!["kind", "name", "props.common.label"];
                            fields.extend(match &item.kind {
                                ItemKind::Sequence(_) => vec!["sequence"],
                                ItemKind::Media(_) => vec!["props.media"],
                                ItemKind::Subclip { .. } => vec!["props.parent", "props.range", "props.restrict_trims"],
                                ItemKind::AdjustmentLayer { .. } => vec!["props.width", "props.height", "props.rate", "props.duration"],
                                ItemKind::Graphic { .. } => vec!["props.width", "props.height", "props.rate"],
                            });
                            expected.premises.push(leaf(*id, fields));
                        }
                    }
                }
                // Missing operands fall through to the legacy Program place;
                // they fail before a handler assignment and certify no landing.
                if command != "edit.duplicate" && target.is_none() {
                    continue;
                }
                assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap()), normalized(expected), "{command}/{params}/selection={selected:?}");
            }
        }
    }
}

#[test]
fn clip_selection_and_enable_compare_link_closure_and_same_field_assignments() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let source = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
    let placed = doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap();
    let clips: Vec<_> = placed["clips"].as_array().unwrap().iter().map(|id| id.as_u64().unwrap()).collect();
    assert_eq!(clips.len(), 2);
    for linked in [false, true] {
        doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
        for selected in [vec![], vec![clips[0]], vec![clips[1]], clips.clone()] {
            doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
            for &(command, path) in &PATHS[3..] {
                assert!(compared_path(command, path));
                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                assert_eq!(spec.reads, [EditorState::Part, EditorState::Selection, EditorState::Mode]);
                assert!(spec.mutates && spec.objects.is_empty() && spec.places.is_empty());
                assert_eq!(spec.targets, Some("clips"));
                assert_eq!(spec.object_types, [("clips", &["Clip"][..])]);
                assert_eq!(spec.enabled, command == "timeline.select" || !selected.is_empty());
                assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                for named in [None, Some(vec![]), Some(vec![clips[0]]), Some(vec![clips[1], clips[0], clips[1]])] {
                    for link_param in [None, Some(false), Some(true)] {
                        for operation in ["replace", "add", "toggle"] {
                            let mut params = json!({});
                            if let Some(named) = &named {
                                params["clips"] = json!(named);
                            }
                            if let Some(link_param) = link_param {
                                params["linked"] = json!(link_param);
                            }
                            if operation != "replace" {
                                params[operation] = json!(true);
                            }
                            let input = named.as_ref().unwrap_or(&selected);
                            let follows = linked && !(command == "timeline.select" && link_param == Some(false));
                            let mut recipients = input.clone();
                            if command == "clip.enable" && linked && !input.is_empty() {
                                recipients = clips.clone();
                            }
                            let mut expected = Under::default();
                            for id in recipients {
                                expected.premises.push(leaf(id, if command == "clip.enable" { vec!["props.enabled", "link"] } else { vec![] }));
                            }
                            if follows {
                                for id in input {
                                    expected.premises.push(leaf(*id, ["link", "~linkedGroup"]));
                                    expected.premises.push(leaf(*clips.iter().min().unwrap(), ["~linkedMembers"]));
                                }
                            }
                            assert_eq!(
                                normalized(doc.under(command, &params).unwrap().unwrap()),
                                normalized(expected),
                                "{command}/{params}/linked={linked}/selection={selected:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}
