//! Project creation resolves source defaults independently of Program material.
use kition_film_engine::{
    Session, commands,
    project::{ItemId, ItemKind},
};
use kition_kit::{DerivedValues, Premise, Under};
use serde_json::{Value, json};

fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn media_route(session: &Session, mut id: ItemId, answer: &mut Under) {
    for _ in 0..16 {
        let Some(item) = session.project.item(id) else { break };
        match &item.kind {
            ItemKind::Subclip { parent, .. } => {
                answer.premises.push(leaf(id.0, &["kind", "props.parent", "props.range", "props.restrict_trims"]));
                id = *parent;
            }
            ItemKind::Media(_) => {
                answer.premises.push(leaf(id.0, &["kind", "props.media", "~parentBin"]));
                break;
            }
            _ => {
                answer.premises.push(leaf(id.0, &["kind"]));
                break;
            }
        }
    }
}
pub fn under(session: &Session, command: &str, params: &Value) -> Option<Under> {
    if command == "sequence.newFromClip" {
        let mut answer = Under::default();
        answer.premises.push(Premise::on(json!("project")).fields(["~placementOptions", "~subclipOptions"]).positions(Vec::<String>::new()));
        if let Some(first) =
            kition_film_engine::clip_ops::items_p(session, params).into_iter().find(|id| kition_film_engine::clip_ops::is_clip_item(&session.project, *id))
        {
            answer.premises.push(leaf(first.0, &["~parentBin"]));
        }
        return Some(answer);
    }
    if command == "bin.addFromSelection" {
        let mut answer = Under::default();
        answer.premises.extend(kition_film_engine::clip_ops::items_p(session, params).into_iter().map(|id| leaf(id.0, &[]).positions(["entries"])));
        if params.get("name").and_then(Value::as_str).is_none() {
            answer.premises.push(Premise::on(json!("project")).fields(["~binNames"]).positions(Vec::<String>::new()));
        }
        return Some(answer);
    }
    if command != "clip.makeSubclip" {
        return None;
    }
    let mut answer = Under::default();
    let source = session
        .state
        .source_item
        .filter(|id| session.project.resolve_media(*id).is_some())
        .or_else(|| session.state.project_selection.iter().copied().find(|id| session.project.resolve_media(*id).is_some()));
    let item = commands::item_p(params, "item");
    let clip = commands::clip_p(params, "clip").or_else(|| if item.is_none() && source.is_none() { session.state.selection.first().copied() } else { None });
    if let Some(id) = clip {
        answer.premises.push(leaf(id.0, &["item", "sourceIn", "speed", "reverse", "props.frame_hold", "props.name", "props.label"]).positions(["duration"]));
        if let Some((_, clip)) = session.active_sequence().and_then(|q| q.find_item(id)) {
            media_route(session, clip.item, &mut answer);
        }
    } else if let Some(id) = item.or(source) {
        answer.premises.push(leaf(id.0, &["name", "props.common.label"]));
        media_route(session, id, &mut answer);
        answer.premises.push(Premise::on(json!("project")).fields(["~subclipOptions"]).positions(Vec::<String>::new()));
    }
    Some(answer)
}
pub fn derived(session: &Session, ids: &[Value], names: &[String]) -> Vec<DerivedValues> {
    if !ids.is_empty() && !ids.iter().any(|id| id == "project") {
        return Vec::new();
    }
    let mut values = serde_json::Map::new();
    if names.is_empty() || names.iter().any(|name| name == "binNames") {
        let mut names = std::collections::BTreeSet::new();
        let mut bins = vec![&session.project.root];
        while let Some(bin) = bins.pop() {
            for entry in &bin.children {
                if let kition_film_engine::project::BinEntry::Bin(child) = entry {
                    names.insert(child.name.clone());
                    bins.push(child);
                }
            }
        }
        values.insert("binNames".into(), json!(names));
    }
    if names.is_empty() || names.iter().any(|name| name == "subclipOptions") {
        values.insert("subclipOptions".into(), json!({"duration":session.prefs.timeline.still_image_duration,"unit":session.prefs.timeline.still_image_unit}));
    }
    if values.is_empty() { Vec::new() } else { vec![DerivedValues { id: json!("project"), values }] }
}
