//! clip_ops.rs:1283-1369 separates direct project media from timeline clips.
//! Project maps consume stream availability and the assigned interpretation;
//! timeline maps resolve source streams and assign source_channels on each clip.
use super::{sound_paths_compare::source, sync_compare::normalized};
use kition_film_engine::project::{ClipId, ItemId, ItemKind, Project, TrackKind};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[("clip.audioChannels", "timeline channels path"), ("clip.audioChannels", "project media path")];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
        && include_str!("../../../../crates/engine/engine/src/clip_ops.rs")
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3))
            == 0xd8532e3f9a552dfc
}
pub fn more() -> Vec<&'static str> {
    vec!["coarse-selection-state", "whole-source-audio-streams", "coarse-source-profile", "clip-owner-position"]
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn expected(project: &Project, sequence: u64, selection: &[u64], items: &[u64], params: &Value) -> Under {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let candidates: Vec<_> = params["items"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_u64).collect())
        .unwrap_or_else(|| params["item"].as_u64().map(|id| vec![id]).unwrap_or_else(|| items.to_vec()));
    let eligible: Vec<_> =
        candidates.iter().copied().filter(|id| project.item(ItemId(*id)).and_then(|i| i.as_media()).is_some_and(|m| m.info.has_audio())).collect();
    let timeline = params.get("channels").is_some() || eligible.is_empty();
    let mut want = Under::default();
    for id in candidates {
        let mut fields = Vec::new();
        if params.get("channels").is_none() {
            fields.push("kind");
            if matches!(project.item(ItemId(id)).map(|i| &i.kind), Some(ItemKind::Media(_))) {
                fields.push("props.media.info.audio_streams");
            }
            if eligible.contains(&id) {
                fields.push("props.media.interpret.audio_channels");
            }
        }
        want.premises.push(leaf(id, fields));
    }
    if timeline {
        let named = params["clips"].as_array().filter(|a| a.iter().all(Value::is_u64));
        let targets: Vec<_> = if let Some(named) = named {
            named.iter().filter_map(Value::as_u64).collect()
        } else {
            for id in selection {
                want.premises.push(leaf(*id, Vec::<String>::new()).positions(["clips"]));
                if let Some((owner, _)) = q.find_item(ClipId(*id)) {
                    want.premises.push(leaf(owner.0, ["props.kind"]));
                }
            }
            selection.iter().copied().filter(|id| q.audio_tracks.iter().any(|t| t.items.iter().any(|c| c.id.0 == *id))).collect()
        };
        for target in targets {
            let Some((_, clip)) = q.find_item(ClipId(target)) else { continue };
            want.premises.push(leaf(target, ["item", "props.audio_stream", "props.source_channels"]));
            source(&mut want, project, clip.item);
        }
    }
    want
}
#[test]
fn audio_channels_compare_project_candidates_channel_values_timeline_owners_and_source_routes() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let media = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let sub = doc.execute("clip.makeSubclip", json!({"item":media,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let clips: Vec<_> = doc.execute("timeline.place", json!({"item":sub,"track":"V1","time":0})).unwrap()["clips"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_u64)
        .collect();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    assert_eq!(
        project.sequence(ItemId(sequence)).unwrap().track(project.sequence(ItemId(sequence)).unwrap().find_item(ClipId(clips[1])).unwrap().0).unwrap().kind,
        TrackKind::Audio
    );
    let spec = doc.commands().into_iter().find(|s| s.id == "clip.audioChannels").unwrap();
    assert!(spec.mutates && spec.targets.is_none());
    assert_eq!(spec.reads, [EditorState::Part, EditorState::Selection]);
    assert_eq!(spec.objects, ["item", "items"]);
    assert_eq!(spec.object_types, [("item", &["Item"][..]), ("items", &["Item"][..])]);
    assert!(
        spec.places.is_empty()
            && spec.name_params.is_empty()
            && spec.name_field.is_none()
            && spec.index.is_none()
            && !spec.index_numbers
            && !spec.index_reversed
    );
    for selected in [vec![], vec![clips[0]], vec![clips[1]], clips.clone()] {
        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
        for items in [vec![], vec![media], vec![sub, media], vec![sequence]] {
            doc.execute("project.select", json!({"items":items})).unwrap();
            for named in [
                json!({}),
                json!({"items":[]}),
                json!({"items":[media]}),
                json!({"items":[sequence,media]}),
                json!({"item":media}),
                json!({"item":sequence}),
                json!({"item":media,"items":[]}),
            ] {
                for channels in [None, Some(json!([])), Some(json!([0, 1]))] {
                    for maps in [None, Some(json!([[0], [1]])), Some(json!([clips[1]])), Some(json!([]))] {
                        for format in ["mono", "stereo", "5.1", "adaptive"] {
                            let mut params = named.clone();
                            params["format"] = json!(format);
                            if let Some(channels) = &channels {
                                params["channels"] = channels.clone();
                            }
                            if let Some(maps) = &maps {
                                params["clips"] = maps.clone();
                            }
                            assert_eq!(
                                normalized(doc.under("clip.audioChannels", &params).unwrap().unwrap()),
                                normalized(expected(&project, sequence, &selected, &items, &params)),
                                "{params}/selection={selected:?}/items={items:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}
