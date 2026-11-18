//! color.rs:281-325 resolves direct media through project or timeline selection.
//! clip_ops.rs:1639-1681 copies media into mono items beside its source.
use super::sync_compare::normalized;
use kition_film_engine::project::{ClipId, ItemId, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[("clip.interpretFootage", "project or timeline fallback"), ("clip.breakoutToMono", "project media targets")];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/clip_ops.rs")) == 0x973a242360050d16
        && hash(include_str!("../../../../crates/engine/engine/src/color.rs")) == 0x338493baffff87a7
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command == "clip.breakoutToMono" { vec!["coarse-selection-state", "whole-cloned-media", "item-sibling-index"] } else { vec!["coarse-selection-state"] }
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn expected(project: &Project, sequence: u64, command: &str, selected: &[u64], items: &[u64], params: &Value) -> Under {
    let mut want = Under::default();
    let mut candidates: Vec<_> = params["items"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_else(|| items.to_vec());
    if command == "clip.interpretFootage"
        && params["items"].as_array().is_none()
        && !candidates.iter().any(|id| project.item(ItemId(*id)).and_then(|i| i.as_media()).is_some())
    {
        for id in selected {
            want.premises.push(leaf(*id, ["item"]));
            if let Some((_, clip)) = project.sequence(ItemId(sequence)).unwrap().find_item(ClipId(*id)) {
                candidates.push(clip.item.0);
            }
        }
    }
    for id in candidates {
        let media = project.item(ItemId(id)).and_then(|i| i.as_media());
        let mut fields = vec!["kind"];
        if command == "clip.interpretFootage" {
            if media.is_some() {
                fields.push("props.media.interpret.color_space");
            }
            want.premises.push(leaf(id, fields));
        } else {
            if media.is_some() {
                fields.push("props.media.info.audio_streams");
            }
            let eligible = media.is_some_and(|m| m.info.has_audio());
            if eligible {
                fields.extend(["name", "props.common.label", "props.media"]);
            }
            let premise = leaf(id, fields);
            want.premises.push(if eligible { premise.positions(["entries"]) } else { premise });
        }
    }
    want
}
#[test]
fn media_targets_compare_explicit_empty_lists_project_precedence_timeline_sources_and_parent_bins() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let media = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let silent = doc.execute("file.newColorMatte", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let sub = doc.execute("clip.makeSubclip", json!({"item":media,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let bin = doc.execute("file.newBin", json!({"name":"Sources"})).unwrap()["bin"].clone();
    doc.execute("project.moveToBin", json!({"items":[media],"bin":bin})).unwrap();
    let clips: Vec<_> = doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap()["clips"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_u64)
        .collect();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for &(command, path) in PATHS {
        assert!(compared_path(command, path));
        let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
        assert!(spec.mutates && spec.targets == Some("items") && spec.objects.is_empty());
        assert_eq!(spec.object_types, [("items", &["Item"][..])]);
        assert_eq!(spec.reads, if command == "clip.interpretFootage" { vec![EditorState::Part, EditorState::Selection] } else { vec![EditorState::Selection] });
        assert!(
            spec.places.is_empty()
                && spec.name_params.is_empty()
                && spec.name_field.is_none()
                && spec.index.is_none()
                && !spec.index_numbers
                && !spec.index_reversed
        );
        for selected in [vec![], vec![clips[0]], clips.clone()] {
            doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
            for items in [vec![], vec![media], vec![sub, media], vec![sequence, sub], vec![silent]] {
                doc.execute("project.select", json!({"items":items})).unwrap();
                for named in [None, Some(json!([])), Some(json!([media])), Some(json!([sequence, sub, silent, media]))] {
                    for color in ["auto", "srgb", "rec709"] {
                        let mut params = if command == "clip.interpretFootage" { json!({"colorSpace":color}) } else { json!({}) };
                        if let Some(named) = &named {
                            params["items"] = named.clone();
                        }
                        assert_eq!(
                            normalized(doc.under(command, &params).unwrap().unwrap()),
                            normalized(expected(&project, sequence, command, &selected, &items, &params)),
                            "{command}/{params}/selection={selected:?}/items={items:?}"
                        );
                    }
                }
            }
        }
    }
}
