//! commands.rs:2907-2969 and project_tools.rs:349-375,1000-1018,1064-1089.
//! Deletion scans subclip parents and sequence references; offline edits stop
//! at the first eligible source. Metadata output consumes the named item's log.
use super::sync_compare::normalized;
use kition_film_engine::project::{BinEntry, ClipId, ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] =
    &[("project.delete", "items/bins"), ("clip.editOffline", "first eligible target"), ("clip.updateMetadata", "external XMP write")];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command == "project.delete" {
        vec![
            "coarse-selection-state",
            "coarse-active-state",
            "all-deletion-reference-candidates",
            "whole-deletion-transition-lists",
            "whole-deletion-bin-order",
        ]
    } else {
        vec!["coarse-selection-state", "item-only-part", "whole-metadata-output", "whole-metadata-source-route"]
    }
}
fn leaf(id: Value, fields: &[&str]) -> Premise {
    Premise::on(id).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn bins(bin: &kition_film_engine::project::Bin, want: &mut Under) {
    want.premises.push(leaf(json!(bin.id.0), &["entries"]));
    for entry in &bin.children {
        if let BinEntry::Bin(child) = entry {
            bins(child, want);
        }
    }
}
fn expected(project: &Project, sequence: u64, command: &str, selected: &[u64], items: &[u64], p: &Value) -> Under {
    let mut want = Under::default();
    if command == "project.delete" {
        want.premises.push(leaf(json!("project"), &["~itemIds"]));
        let requested = p["items"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>()).unwrap_or_else(|| items.to_vec());
        for id in requested {
            if let Some(bin) = project.root.find_bin(kition_film_engine::project::BinId(id)) {
                bins(bin, &mut want);
            }
        }
        for item in project.items.values() {
            want.premises.push(leaf(json!(item.id.0), if matches!(item.kind, ItemKind::Subclip { .. }) { &["kind", "props.parent"] } else { &["kind"] }));
            if let Some(q) = item.as_sequence() {
                want.premises.push(leaf(json!(item.id.0), &["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
                for track in q.all_tracks() {
                    want.premises.push(leaf(json!(track.id.0), &["~clipOrder", "transitions"]));
                    want.premises.extend(track.items.iter().map(|clip| leaf(json!(clip.id.0), &["item"])));
                }
            }
        }
        return want;
    }
    let targets = if let Some(a) = p["items"].as_array() {
        a.iter().filter_map(Value::as_u64).filter(|id| project.items.contains_key(&ItemId(*id))).collect::<Vec<_>>()
    } else if let Some(id) = p["item"].as_u64() {
        vec![id]
    } else if !items.is_empty() {
        items.to_vec()
    } else {
        let mut ids = Vec::new();
        for id in selected {
            want.premises.push(leaf(json!(id), &["item"]));
            if let Some((_, clip)) = project.sequence(ItemId(sequence)).unwrap().find_item(ClipId(*id))
                && !ids.contains(&clip.item.0)
            {
                ids.push(clip.item.0);
            }
        }
        ids
    };
    for id in targets {
        let Some(item) = project.item(ItemId(id)) else { continue };
        if command == "clip.editOffline" {
            want.premises.push(leaf(json!(id), &["~offlineEligible"]));
            if !project.resolve_media(ItemId(id)).is_some_and(|(_, m, _)| m.offline) {
                continue;
            }
            want.premises.push(leaf(json!(id), &["name", "props.common.metadata"]));
            break;
        }
        let mut current = Some(ItemId(id));
        for _ in 0..16 {
            let Some(id) = current.take() else { break };
            let route = project.item(id).unwrap();
            let fields = match route.kind {
                ItemKind::Subclip { parent, .. } => {
                    current = Some(parent);
                    vec!["kind", "props.parent", "props.range", "props.restrict_trims"]
                }
                ItemKind::Media(_) => vec!["kind", "props.media.media"],
                _ => vec!["kind"],
            };
            want.premises.push(leaf(json!(id.0), &fields));
        }
        if project.resolve_media(ItemId(id)).is_some_and(|(_, m, _)| matches!(m.media, kition_film_engine::project::MediaRef::File { .. })) {
            want.premises.push(leaf(json!(item.id.0), &["name", "props.common.metadata"]));
        }
    }
    want
}
#[test]
fn project_management_compares_recursive_bins_reference_scans_and_ordered_offline_targets() {
    let mut doc = FilmDocument::create("Project.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let offline = doc.execute("item.newOfflineFile", json!({"seconds":3})).unwrap()["item"].as_u64().unwrap();
    let live = doc.execute("item.newColorMatte", json!({"seconds":3})).unwrap()["item"].as_u64().unwrap();
    let sub = doc.execute("clip.makeSubclip", json!({"item":offline,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let bin = doc.execute("bin.add", json!({"name":"Sources"})).unwrap()["bin"].as_u64().unwrap();
    let nested = doc.execute("bin.add", json!({"name":"Child","parent":bin})).unwrap()["bin"].as_u64().unwrap();
    doc.execute("project.moveToBin", json!({"items":[offline,sub],"bin":nested})).unwrap();
    let clip = doc.execute("timeline.place", json!({"item":offline,"track":"V1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for selected in [vec![], vec![clip]] {
        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
        for items in [vec![], vec![live, sub, offline], vec![seq, offline], vec![bin, nested]] {
            doc.execute("project.select", json!({"items":items})).unwrap();
            for &(command, _) in PATHS {
                for mut p in [json!({}), json!({"items":[]}), json!({"items":[live,sub,offline]}), json!({"items":[bin,nested]}), json!({"item":offline})] {
                    if command == "clip.editOffline" {
                        p["mediaName"] = json!("Assigned");
                        p["description"] = json!("Log");
                    }
                    assert_eq!(
                        normalized(doc.under(command, &p).unwrap().unwrap_or_default()),
                        normalized(expected(&project, seq, command, &selected, &items, &p)),
                        "{command}/{p}/{selected:?}/{items:?}"
                    );
                }
            }
        }
    }
}
