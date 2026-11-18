//! clip_ops.rs:742-775,1147-1221: bin naming consumes the bin tree's
//! names; subclip creation resolves monitor/project/timeline precedence,
//! bounded media ancestry, source timing, labels and the root's parent bin.
use super::sync_compare::normalized;
use kition_film_engine::project::{ClipId, ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("file.newBinFromSelection", "items/default selection"),
    ("file.newSequenceFromClip", "items/default selection"),
    ("clip.makeSubclip", "explicit clip or timeline fallback"),
    ("clip.makeSubclip", "item or source/project fallback"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command == "file.newBinFromSelection" {
        vec!["coarse-selection-state", "all-moved-entry-positions"]
    } else if command == "file.newSequenceFromClip" {
        vec![
            "coarse-selection-state",
            "coarse-mode-state",
            "whole-created-sequence-source-profile",
            "all-source-entry-positions",
            "coarse-placement-options",
            "whole-subclip-options",
        ]
    } else {
        vec!["coarse-selection-state", "coarse-active-state", "whole-subclip-media-profile", "unused-subclip-defaults", "whole-subclip-options"]
    }
}
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn route(project: &Project, mut item: ItemId, want: &mut Under) {
    for _ in 0..16 {
        let Some(source) = project.item(item) else { break };
        match &source.kind {
            ItemKind::Subclip { parent, .. } => {
                want.premises.push(leaf(item.0, &["kind", "props.parent", "props.range", "props.restrict_trims"]));
                item = *parent;
            }
            ItemKind::Media(_) => {
                want.premises.push(leaf(item.0, &["kind", "props.media", "~parentBin"]));
                break;
            }
            _ => {
                want.premises.push(leaf(item.0, &["kind"]));
                break;
            }
        }
    }
}
fn expected(project: &Project, seq: u64, timeline: &[u64], selected: &[u64], monitor: Option<u64>, command: &str, p: &Value) -> Under {
    let mut want = Under::default();
    if command == "file.newBinFromSelection" {
        let ids = p.get("items").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>()).unwrap_or_else(|| selected.to_vec());
        want.premises.extend(ids.iter().map(|id| leaf(*id, &[]).positions(["entries"])));
        if p.get("name").and_then(Value::as_str).is_none() {
            want.premises.push(Premise::on(json!("project")).fields(["~binNames"]).positions(Vec::<String>::new()));
        }
        return want;
    }
    let source = monitor
        .filter(|id| project.resolve_media(ItemId(*id)).is_some())
        .or_else(|| selected.iter().copied().find(|id| project.resolve_media(ItemId(*id)).is_some()));
    let item = p.get("item").and_then(Value::as_u64);
    let clip = p.get("clip").and_then(Value::as_u64).or_else(|| if item.is_none() && source.is_none() { timeline.first().copied() } else { None });
    if let Some(id) = clip {
        want.premises.push(leaf(id, &["item", "sourceIn", "speed", "reverse", "props.frame_hold", "props.name", "props.label"]).positions(["duration"]));
        if let Some((_, clip)) = project.sequence(ItemId(seq)).unwrap().find_item(ClipId(id)) {
            route(project, clip.item, &mut want);
        }
    } else if let Some(id) = item.or(source) {
        want.premises.push(leaf(id, &["name", "props.common.label"]));
        route(project, ItemId(id), &mut want);
        want.premises.push(Premise::on(json!("project")).fields(["~subclipOptions"]).positions(Vec::<String>::new()));
    }
    want
}
#[test]
fn project_sources_compare_bin_names_and_subclip_source_precedence_ancestry_and_overrides() {
    let mut doc = FilmDocument::create("Sources.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("file.newBarsAndTone", json!({"seconds":4})).unwrap()["item"].as_u64().unwrap();
    let sub = doc.execute("clip.makeSubclip", json!({"item":source,"startFrame":3,"endFrame":40})).unwrap()["item"].as_u64().unwrap();
    let clip = doc.execute("timeline.place", json!({"item":sub,"track":"V1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
    doc.execute("file.newBin", json!({"name":"Bin 01"})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for monitor in [None, Some(source), Some(sub)] {
        if let Some(item) = monitor {
            doc.execute("source.open", json!({"item":item})).unwrap();
        }
        for selected in [vec![], vec![source], vec![seq, sub]] {
            doc.execute("project.select", json!({"items":selected})).unwrap();
            for timeline in [vec![clip], vec![]] {
                doc.execute("timeline.select", json!({"clips":timeline,"linked":false})).unwrap();
                for command in ["clip.makeSubclip", "file.newBinFromSelection"] {
                    let params = if command == "file.newBinFromSelection" {
                        vec![json!({}), json!({"name":"Given"}), json!({"items":[source,sub]}), json!({"items":[],"name":"Empty"})]
                    } else {
                        vec![
                            json!({}),
                            json!({"clip":clip}),
                            json!({"item":source}),
                            json!({"item":sub,"startFrame":8,"endFrame":20,"name":"Given"}),
                            json!({"clip":clip,"item":source,"start":0,"end":254_016_000_000i64}),
                        ]
                    };
                    for p in params {
                        assert_eq!(
                            normalized(doc.under(command, &p).unwrap().unwrap_or_default()),
                            normalized(expected(&project, seq, &timeline, &selected, monitor, command, &p)),
                            "{command}/{p}/monitor={monitor:?}/project={selected:?}/timeline={timeline:?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn sequences_from_clips_compare_copied_sources_first_parent_and_bounded_subclip_settings() {
    let mut doc = FilmDocument::create("Sequence.kfilm", 64, 36).unwrap();
    let media = doc.execute("file.newBarsAndTone", json!({"seconds":4})).unwrap()["item"].as_u64().unwrap();
    let sub = doc.execute("clip.makeSubclip", json!({"item":media,"startFrame":3,"endFrame":40})).unwrap()["item"].as_u64().unwrap();
    doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for selected in [vec![media], vec![sub], vec![media, sub], vec![sub, media]] {
        doc.execute("project.select", json!({"items":selected})).unwrap();
        for p in [json!({}), json!({"items":selected})] {
            let mut want = Under::default();
            want.premises.push(Premise::on(json!("project")).fields(["~placementOptions", "~subclipOptions"]).positions(Vec::<String>::new()));
            want.premises.push(leaf(selected[0], &["~parentBin"]));
            for (index, id) in selected.iter().enumerate() {
                want.premises.push(Premise::on(json!(id)).fields(["kind", "name", "props", "sequence", "~sourceGraphicDefinition"]));
                if matches!(project.item(ItemId(*id)).unwrap().kind, ItemKind::Subclip { .. }) {
                    want.premises.extend(super::new_sequence_compare::expected(&project, &json!({"fromItem":id,"name":"Given"}), false, &[]).premises);
                    if index == 0 {
                        let root = project.resolve_media(ItemId(*id)).unwrap().0;
                        want.premises.push(leaf(root.0, &["props.media.info.video.frame_rate", "props.media.info.audio_streams.0.sample_rate"]));
                    }
                }
            }
            assert_eq!(normalized(doc.under("file.newSequenceFromClip", &p).unwrap().unwrap()), normalized(want), "{p}/{selected:?}");
        }
    }
}
