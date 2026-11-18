//! Project reference scans and ordered offline targets are independent of Program time.
use kition_film_engine::{
    Session, commands,
    project::{BinEntry, BinId, ItemId, ItemKind},
};
use kition_kit::{DerivedValues, Premise, Under};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn leaf(id: Value, fields: &[&str]) -> Premise {
    Premise::on(id).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn targets(session: &Session, params: &Value, answer: &mut Under) -> Vec<ItemId> {
    if let Some(ids) = params.get("items").and_then(Value::as_array) {
        return ids.iter().filter_map(Value::as_u64).map(ItemId).filter(|id| session.project.items.contains_key(id)).collect();
    }
    if let Some(id) = commands::item_p(params, "item") {
        return vec![id];
    }
    if !session.state.project_selection.is_empty() {
        return session.state.project_selection.clone();
    }
    let mut ids = Vec::new();
    for id in &session.state.selection {
        answer.premises.push(leaf(json!(id.0), &["item"]));
        if let Some((_, clip)) = session.active_sequence().and_then(|q| q.find_item(*id))
            && !ids.contains(&clip.item)
        {
            ids.push(clip.item);
        }
    }
    ids
}
fn offline(session: &Session, id: ItemId) -> bool {
    session.project.resolve_media(id).is_some_and(|(root, media, _)| media.offline || session.media.offline_status(root).is_some())
}
pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if command == "project.delete" {
        let mut answer = Under::default();
        answer.premises.push(leaf(json!("project"), &["~itemIds"]));
        let requested = params
            .get("items")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).map(ItemId).collect::<Vec<_>>())
            .unwrap_or_else(|| session.state.project_selection.clone());
        let mut pending = requested.iter().filter_map(|id| session.project.root.find_bin(BinId(id.0))).collect::<Vec<_>>();
        let mut seen = BTreeSet::new();
        while let Some(bin) = pending.pop() {
            if !seen.insert(bin.id) {
                continue;
            }
            answer.premises.push(leaf(json!(bin.id.0), &["entries"]));
            pending.extend(bin.children.iter().filter_map(|entry| if let BinEntry::Bin(child) = entry { Some(child) } else { None }));
        }
        for item in session.project.items.values() {
            answer.premises.push(leaf(json!(item.id.0), if matches!(item.kind, ItemKind::Subclip { .. }) { &["kind", "props.parent"] } else { &["kind"] }));
            if let Some(q) = item.as_sequence() {
                answer.premises.push(leaf(json!(item.id.0), &["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
                for track in q.all_tracks() {
                    answer.premises.push(leaf(json!(track.id.0), &["~clipOrder", "transitions"]));
                    answer.premises.extend(track.items.iter().map(|clip| leaf(json!(clip.id.0), &["item"])));
                }
            }
        }
        return Some(answer);
    }
    if !matches!(command, "clip.editOffline" | "clip.updateMetadata") {
        return None;
    }
    let mut answer = Under::default();
    for id in targets(session, params, &mut answer) {
        if session.project.item(id).is_none() {
            continue;
        }
        if command == "clip.editOffline" {
            answer.premises.push(leaf(json!(id.0), &["~offlineEligible"]));
            if !offline(session, id) {
                continue;
            }
            answer.premises.push(leaf(json!(id.0), &["name", "props.common.metadata"]));
            break;
        }
        let mut current = Some(id);
        for _ in 0..16 {
            let Some(id) = current.take() else { break };
            let Some(item) = session.project.item(id) else { break };
            let fields = match item.kind {
                ItemKind::Subclip { parent, .. } => {
                    current = Some(parent);
                    vec!["kind", "props.parent", "props.range", "props.restrict_trims"]
                }
                ItemKind::Media(_) => vec!["kind", "props.media.media"],
                _ => vec!["kind"],
            };
            answer.premises.push(leaf(json!(id.0), &fields));
        }
        if session.project.resolve_media(id).is_some_and(|(_, m, _)| matches!(m.media, kition_film_engine::project::MediaRef::File { .. })) {
            answer.premises.push(leaf(json!(id.0), &["name", "props.common.metadata"]));
        }
    }
    Some(answer)
}
pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Vec<DerivedValues> {
    if !names.is_empty() && !names.iter().any(|name| name == "offlineEligible") {
        return Vec::new();
    }
    session
        .project
        .items
        .keys()
        .filter(|id| ids.is_empty() || ids.iter().any(|value| value == &json!(id.0) || value.as_str() == Some(id.0.to_string().as_str())))
        .map(|id| DerivedValues { id: json!(id.0), values: serde_json::Map::from_iter([("offlineEligible".into(), json!(offline(session, *id)))]) })
        .collect()
}
