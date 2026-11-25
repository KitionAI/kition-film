//! beats.rs:72-191, remix.rs:47-246, scene_detect.rs:100-180,348-423.
//! Analysis consumes source bytes and their interpretation, not a Program
//! point. Remix also tests the next item; scene cuts copy linked recipients.
use super::{sound_paths_compare::source, sync_compare::normalized};
use kition_film_engine::project::{ClipId, ItemId, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("audio.detectBeats", "clip"),
    ("audio.detectBeats", "item"),
    ("clip.remix.enable", "analysis/replan"),
    ("clip.remix", "analysis/replan"),
    ("clip.remix.properties", "analysis/replan"),
    ("clip.remix.enable", "already enabled"),
    ("clip.remix.properties", "no replan parameters"),
    ("clip.remix.revert", "restore original duration"),
    ("clip.sceneEditDetection", "analyse"),
    ("clip.sceneEditDetection", "apply cuts"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/beats.rs")) == 0x0b1d7bd12b24f9a5
        && hash(include_str!("../../../../crates/engine/engine/src/remix.rs")) == 0x114b6e6c5b5a25e3
        && hash(include_str!("../../../../crates/engine/engine/src/scene_detect.rs")) == 0x88a6cebe2930b608
        && hash(include_str!("../../../../crates/engine/engine/src/analysis_input.rs")) == 0x086b755aa8f58c89
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-source-profile", "clip-owner-position"];
    if command != "audio.detectBeats" {
        out.extend(["coarse-selection-state", "whole-analysis-target"]);
    }
    if command.starts_with("clip.remix") {
        out.extend(["analysis-inputs-on-report-only", "whole-owner-clip-order"]);
    }
    if command == "clip.sceneEditDetection" {
        out.extend(["whole-scene-marker-profile", "whole-analysis-track-transitions", "ineligible-scene-candidates"]);
    }
    out
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn expected(project: &Project, sequence: u64, command: &str, params: &Value, selected: &[u64]) -> Under {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let beats = command == "audio.detectBeats";
    let scene = command == "clip.sceneEditDetection";
    let mut want = Under::default();
    if beats {
        want.premises.push(leaf(sequence, ["sequence.settings.settings.frame_rate"]));
        if let Some(id) = params["item"].as_u64() {
            source(&mut want, project, ItemId(id));
        }
    } else {
        want.premises.push(leaf(
            sequence,
            if scene {
                vec!["sequence.settings.settings.frame_rate"]
            } else {
                vec!["sequence.settings.settings.frame_rate", "sequence.settings.settings.drop_frame", "sequence.settings.settings.sample_rate"]
            },
        ));
    }
    let ids = if scene {
        params["clips"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_u64).collect())
            .unwrap_or_else(|| params["clip"].as_u64().map(|id| vec![id]).unwrap_or_else(|| selected.to_vec()))
    } else if let Some(id) = params["clip"].as_u64() {
        vec![id]
    } else if beats {
        vec![]
    } else {
        selected.iter().copied().find(|id| q.audio_tracks.iter().any(|t| t.items.iter().any(|c| c.id.0 == *id))).into_iter().collect()
    };
    if !beats && !scene && params["clip"].as_u64().is_none() {
        for id in selected {
            want.premises.push(leaf(*id, Vec::<String>::new()).positions(["clips"]));
            if let Some((owner, _)) = q.find_item(ClipId(*id)) {
                want.premises.push(leaf(owner.0, ["props.kind"]));
                if q.audio_tracks.iter().any(|t| t.id == owner) {
                    break;
                }
            }
        }
    }
    for id in ids {
        let Some((owner, clip)) = q.find_item(ClipId(id)) else { continue };
        want.premises.push(leaf(owner.0, if scene { vec!["props.kind", "props.locked"] } else { vec!["props.kind"] }));
        want.premises.push(if beats {
            leaf(id, ["item", "sourceIn", "speed", "reverse", "props.frame_hold", "effects"]).positions(["start", "duration", "clips"])
        } else {
            Premise::on(json!(id))
        });
        source(&mut want, project, clip.item);
        if !beats && !scene {
            let track = q.track(owner).unwrap();
            want.premises.push(leaf(owner.0, ["~clipOrder"]));
            for peer in &track.items {
                want.premises.push(leaf(peer.id.0, Vec::<String>::new()).positions(["start"]));
            }
        }
        if scene {
            let root = project.resolve_media(clip.item).map(|(id, _, _)| id).unwrap_or(clip.item);
            want.premises.push(leaf(root.0, ["name", "props.common.label", "markers"]));
            if params["applyCuts"].as_bool() != Some(false) {
                want.premises.push(leaf(owner.0, ["transitions"]));
                want.premises.push(leaf(id, ["~linkedGroup"]));
                if let Some(link) = clip.link {
                    let peers: Vec<_> = q.all_tracks().flat_map(|t| &t.items).filter(|c| c.link == Some(link)).collect();
                    want.premises.push(leaf(peers.iter().map(|c| c.id.0).min().unwrap(), ["~linkedMembers"]));
                    for peer in peers {
                        want.premises.push(Premise::on(json!(peer.id.0)));
                        let (owner, _) = q.find_item(peer.id).unwrap();
                        want.premises.push(leaf(owner.0, ["props.locked", "transitions"]));
                    }
                }
            }
        }
    }
    want
}
#[test]
fn analyses_compare_item_routes_clip_owners_neighbours_replan_modes_and_linked_scene_cuts() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let media = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let sub = doc.execute("clip.makeSubclip", json!({"item":media,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let mut clips = Vec::new();
    for (item, at) in [(media, 0), (sub, 762_048_000_000i64)] {
        clips.extend(
            doc.execute("timeline.place", json!({"item":item,"track":"V1","time":at})).unwrap()["clips"].as_array().unwrap().iter().filter_map(Value::as_u64),
        );
    }
    let loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
    for remixed in [false, true] {
        let mut project = loaded.project.clone();
        if remixed {
            project.sequence_mut(ItemId(sequence)).unwrap().find_item_mut(ClipId(clips[1])).unwrap().1.effects.push(
                kition_film_engine::project::EffectInstance {
                    effect: "remix".into(),
                    enabled: true,
                    params: std::collections::BTreeMap::new(),
                    masks: Vec::new(),
                    post_fader: false,
                    audio_mixing: false,
                    layer: None,
                },
            );
        }
        let mut doc = FilmDocument::open("Edit.kfilm", &kition_film_format::encode(&project, true)).unwrap();
        for selected in [vec![], vec![clips[0]], vec![clips[1]], clips.clone()] {
            doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
            for &(command, path) in PATHS {
                assert!(compared_path(command, path));
                let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                assert!(spec.mutates && spec.places.is_empty() && spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none());
                for named in [json!({}), json!({"clip":clips[1]}), json!({"item":media}), json!({"item":sub}), json!({"clips":[]}), json!({"clips":clips})] {
                    for extra in [
                        json!({}),
                        json!({"seconds":1}),
                        json!({"frame":12}),
                        json!({"timecode":"00:00:01:00"}),
                        json!({"segments":20,"variations":70}),
                        json!({"applyCuts":false,"generateMarkers":true,"createSubclips":true}),
                        json!({"markers":true}),
                    ] {
                        let mut params = named.clone();
                        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
                        assert_eq!(
                            normalized(doc.under(command, &params).unwrap().unwrap()),
                            normalized(expected(&project, sequence, command, &params, &selected)),
                            "{command}/{path}/{params}/selected={selected:?}"
                        );
                    }
                }
            }
        }
    }
}
