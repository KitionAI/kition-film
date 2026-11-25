//! Complete label paths, including native suppression of the opposite default
//! selection, assigned fields, owner eligibility and the SDK's parameter roles.
//! Source: commands.rs::edit.label and clip_ops.rs::apply_label/can_label.
//! The global Selection and Part declarations are deliberately accounted for
//! as MORE on explicit-target/item-only variants, rather than called exact.
use std::collections::{BTreeMap, BTreeSet};

use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const COMMANDS: &[&str] = &[
    "edit.label",
    "edit.label.violet",
    "edit.label.iris",
    "edit.label.caribbean",
    "edit.label.lavender",
    "edit.label.cerulean",
    "edit.label.forest",
    "edit.label.rose",
    "edit.label.mango",
    "edit.label.purple",
    "edit.label.blue",
    "edit.label.teal",
    "edit.label.magenta",
    "edit.label.tan",
    "edit.label.green",
    "edit.label.brown",
    "edit.label.yellow",
];

pub fn compared_path(command: &str, path: &str) -> bool {
    use super::patches_compare::matches_source;
    if !COMMANDS.contains(&command) || path != if command == "edit.label" { "both-selections" } else { "items/clips/default selections" } {
        return false;
    }
    matches_source(
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/clip_ops.rs")),
        "fn apply_label(",
        "fn select_label_group(",
        0x1d083887b731d066,
    ) && matches_source(
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/commands.rs")),
        "        cmd!(\"edit.label\",",
        "        // ================= Clip =================",
        0xe7510acbf71bad9e,
    )
}

fn operand(params: &Value, key: &str, opposite: &str, selected: &[u64]) -> Vec<u64> {
    match params.get(key) {
        Some(Value::Array(ids)) => ids.iter().filter_map(Value::as_u64).collect(),
        _ if params.get(opposite).is_some() => vec![],
        _ => selected.to_vec(),
    }
}

#[test]
fn label_paths_compare_all_target_presence_and_selection_combinations() {
    let mut more_selection = BTreeSet::new();
    let mut more_part = BTreeSet::new();
    for timeline_selected in [false, true] {
        for project_selected in [false, true] {
            let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
            let item = doc.execute("item.newColorMatte", json!({"seconds":1})).unwrap()["item"].as_u64().unwrap();
            let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":0})).unwrap()["clips"][0].as_u64().unwrap();
            let other = doc.execute("item.newColorMatte", json!({"seconds":1})).unwrap()["item"].as_u64().unwrap();
            let timeline: Vec<u64> = if timeline_selected { vec![clip] } else { vec![] };
            let project: Vec<u64> = if project_selected { vec![item] } else { vec![] };
            doc.execute("timeline.select", json!({"clips":timeline,"linked":false})).unwrap();
            doc.execute("project.select", json!({"items":project})).unwrap();
            for &command in COMMANDS {
                let path = if command == "edit.label" { "both-selections" } else { "items/clips/default selections" };
                assert!(compared_path(command, path), "source review expired: {command}");
                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                assert!(spec.mutates);
                assert_eq!(spec.enabled, command == "edit.label" || timeline_selected || project_selected);
                assert!(spec.targets.is_none() && spec.places.is_empty() && spec.name_params.is_empty());
                assert!(spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                if command == "edit.label" {
                    assert!(spec.objects.is_empty() && spec.object_types.is_empty());
                } else {
                    assert_eq!(spec.objects, ["clips", "items"]);
                    assert_eq!(spec.object_types, [("clips", &["Clip"][..]), ("items", &["Item"][..])]);
                }
                let declared: BTreeSet<_> = spec.reads.iter().map(|state| state.as_str()).collect();
                assert_eq!(declared, BTreeSet::from(["part", "selection"]));
                for items_form in 0..4 {
                    for clips_form in 0..4 {
                        if command == "edit.label" && (items_form != 0 || clips_form != 0) {
                            continue;
                        }
                        let mut params = json!({});
                        for (key, form, value) in [("items", items_form, json!([other, item, other])), ("clips", clips_form, json!([clip, clip]))] {
                            match form {
                                1 => params[key] = Value::Null,
                                2 => params[key] = json!([]),
                                3 => params[key] = value,
                                _ => {}
                            }
                        }
                        let generic = command == "edit.label";
                        let items = if generic { project.clone() } else { operand(&params, "items", "clips", &project) };
                        let clips = if generic { timeline.clone() } else { operand(&params, "clips", "items", &timeline) };
                        let succeeds = generic || !items.is_empty() || !clips.is_empty();
                        let mut fields: BTreeMap<u64, BTreeSet<&str>> = BTreeMap::new();
                        for id in items {
                            fields.entry(id).or_default().insert("props.common.label");
                        }
                        for id in &clips {
                            fields.entry(*id).or_default().insert("props.label");
                        }
                        let mut held = doc.under(command, &params).unwrap().unwrap();
                        held.premises.sort_by_key(|need| need.id.as_u64());
                        let expected = Under {
                            premises: fields.into_iter().map(|(id, fields)| Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())).collect(),
                            ..Default::default()
                        };
                        assert_eq!(held, expected, "{command}/{timeline_selected}/{project_selected}/{params}");
                        let consumes_selection = generic
                            || (params.get("items").and_then(Value::as_array).is_none() && params.get("clips").is_none())
                            || (params.get("clips").and_then(Value::as_array).is_none() && params.get("items").is_none());
                        if !consumes_selection && declared.contains("selection") {
                            more_selection.insert(command);
                        }
                        if clips.is_empty() && declared.contains("part") {
                            more_part.insert(command);
                        }
                        let mut execute = params.clone();
                        if generic {
                            execute["label"] = json!("Violet");
                        }
                        assert_eq!(doc.execute(command, execute).is_ok(), succeeds, "native eligibility: {command}/{params}");
                    }
                }
            }
        }
    }
    assert!(more_selection.len() <= 16, "label selection MORE ceiling grew: {more_selection:?}");
    assert!(more_part.len() <= 17, "label item-only Part MORE ceiling grew: {more_part:?}");
    let differing: BTreeSet<_> = more_selection.union(&more_part).copied().collect();
    assert!(differing.len() <= 17);
    println!(
        "COMPARED_LABEL_PATHS differing={} less=0 more={} classes=unconsumed-selection:{},item-only-part:{}",
        differing.len(),
        differing.len(),
        more_selection.len(),
        more_part.len()
    );
}
