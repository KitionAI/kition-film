//! Metadata operands from panels.rs:163-175,284-339 and project_panel.rs:915-1027.
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

use super::sync_compare::normalized;

pub const PATHS: &[(&str, &str)] = &[
    ("project.view.set", "fields supplied"),
    ("project.columns.set", "columns"),
    ("project.sort", "explicit or toggle descending"),
    ("metadata.set", "item explicit"),
    ("metadata.set", "clip or selection"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let source = if command == "metadata.set" {
        include_str!("../../../../crates/engine/engine/src/panels.rs")
    } else {
        include_str!("../../../../crates/engine/engine/src/project_panel.rs")
    };
    PATHS.contains(&(command, path))
        && source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3))
            == if command == "metadata.set" { 0x22fe7782eed3ce6c } else { 0x05feb2b3bbb4f4b0 }
}

pub fn more(command: &str) -> Vec<&'static str> {
    if command == "metadata.set" { vec!["coarse-selection-state", "item-only-part", "unused-explicit-clip"] } else { vec!["coarse-mode-state"] }
}

fn leaf(id: Value, fields: impl IntoIterator<Item = String>) -> Premise {
    Premise::on(id).fields(fields).positions(Vec::<String>::new())
}

fn metadata(key: &str) -> String {
    if key.eq_ignore_ascii_case("name") {
        "name".into()
    } else if key.eq_ignore_ascii_case("label") {
        "props.common.label".into()
    } else if key.contains(['.', '[', ']', '/', '~']) {
        format!("/props/common/metadata/{}", key.replace('~', "~0").replace('/', "~1"))
    } else {
        format!("props.common.metadata.{key}")
    }
}

#[test]
fn column_paths_compare_canonical_lookups_and_branches_without_metadata_reads() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let item = doc.execute("item.newColorMatte", json!({"seconds":1})).unwrap()["item"].clone();
    doc.execute("timeline.place", json!({"item":item,"time":0,"track":"V1"})).unwrap();
    for command in ["project.view.set", "project.columns.set", "project.sort"] {
        assert!(PATHS.iter().any(|&(id, path)| command == id && compared_path(id, path)));
        let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
        assert!(spec.mutates && spec.enabled);
        assert_eq!(spec.reads, [EditorState::Mode]);
        assert!(spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty());
        assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
        for names in [vec![], vec!["Name"], vec![" Scene ", "SCENE"], vec!["Review.v1", "Review[1]", "Review/mix~1"]] {
            for objects in [false, true] {
                let params = match command {
                    "project.columns.set" => {
                        json!({"columns":names.iter().map(|name| if objects { json!({"name":name,"width":100}) } else { json!(name) }).collect::<Vec<_>>()})
                    }
                    "project.view.set" => names.first().map_or(
                        json!({"view":"freeform"}),
                        |name| json!({"iconSort":if objects { json!({"column":name,"descending":true}) } else { json!(name) }}),
                    ),
                    _ => names.first().map_or(json!({}), |name| json!({"column":name,"descending":objects})),
                };
                let looked_up: Vec<_> = if command == "project.columns.set" { names.clone() } else { names.first().copied().into_iter().collect() };
                let mut expected = Under::default();
                if !looked_up.is_empty() {
                    expected.premises.push(leaf(json!("project"), Vec::<String>::new()));
                    for name in looked_up {
                        let hex = name.trim().to_ascii_lowercase().bytes().map(|byte| format!("{byte:02x}")).collect::<String>();
                        expected.premises.push(leaf(json!(format!("fact:project:~metadataColumns.c{hex}")), ["value".into()]));
                    }
                }
                assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap_or_default()), normalized(expected), "{command}/{params}");
            }
        }
    }
}

#[test]
fn metadata_paths_compare_every_target_precedence_literal_key_and_read_only_family() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let media = doc.execute("item.newOfflineFile", json!({"seconds":1})).unwrap()["item"].as_u64().unwrap();
    let subclip = doc.execute("clip.makeSubclip", json!({"item":media,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let adjustment = doc.execute("item.newAdjustmentLayer", json!({})).unwrap()["item"].as_u64().unwrap();
    let clips = doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap()["clips"].as_array().unwrap().clone();
    let clip = clips[0].clone();
    let spec = doc.commands().into_iter().find(|spec| spec.id == "metadata.set").unwrap();
    assert_eq!(spec.reads, [EditorState::Part, EditorState::Selection]);
    assert!(spec.mutates && spec.enabled && spec.targets.is_none() && spec.places.is_empty());
    assert_eq!(spec.objects, ["clip", "item"]);
    assert_eq!(spec.object_types, [("clip", &["Clip"][..]), ("item", &["Item"][..])]);
    assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
    for item in [sequence, media, subclip, adjustment] {
        for project_selected in [false, true] {
            doc.execute("project.select", json!({"items":if project_selected { vec![item] } else { vec![] }})).unwrap();
            doc.execute("timeline.select", json!({"clips":[clip]})).unwrap();
            for address in 0..4 {
                // panels.rs:167 accepts numeric clip ids; strings take the selection fallback.
                let target = if address == 0 || (address >= 2 && project_selected) { item } else { media };
                for key in [
                    "Name",
                    "LABEL",
                    "Description",
                    "Scene",
                    "Review.v1",
                    "Review[1]",
                    "Review/mix~1",
                    "Video Info",
                    "Color Space",
                    "Video Codec",
                    "Audio Info",
                    "Audio Codec",
                    "In Point",
                    "Out Point",
                ] {
                    for map in [false, true] {
                        let mut params = if map { json!({"fields":{}}) } else { json!({"field":key,"value":"Assigned"}) };
                        if map {
                            params["fields"][key] = json!("Assigned");
                        }
                        if address == 0 {
                            params["item"] = json!(item);
                            params["clip"] = clip.clone();
                        }
                        if address == 1 {
                            params["clip"] = clip.clone();
                        }
                        if address == 2 {
                            params["clip"] = json!(clip.as_u64().unwrap().to_string());
                        }
                        let mut fields = vec![metadata(key)];
                        let rule = match key {
                            "Video Info" | "Color Space" => Some("~metadataVideoReadOnly"),
                            "Video Codec" => Some("~metadataVideoCodecReadOnly"),
                            "Audio Info" | "Audio Codec" => Some("~metadataAudioReadOnly"),
                            "In Point" | "Out Point" => Some("~metadataMarksReadOnly"),
                            _ => None,
                        };
                        if let Some(rule) = rule {
                            fields.push(rule.into());
                        }
                        let mut expected = Under { premises: vec![leaf(json!(target), fields)], ..Default::default() };
                        if address == 1 || (address >= 2 && !project_selected) {
                            expected.premises.push(leaf(clip.clone(), ["item".into()]));
                        }
                        assert_eq!(
                            normalized(doc.under("metadata.set", &params).unwrap().unwrap()),
                            normalized(expected),
                            "{params}/{item}/{project_selected}"
                        );
                    }
                }
            }
        }
    }
}
