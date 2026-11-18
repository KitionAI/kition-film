//! commands.rs:3412-3578 and multicam.rs:775-852: copied clip material,
//! camera routing, searched free lanes and overwritten destinations are inputs.
use super::{attributes_replace_compare::operands, sync_compare::normalized};
use kition_film_engine::project::{ClipId, ItemId, Project, TrackKind};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::{Value, json};
use std::collections::BTreeSet;
pub const PATHS: &[(&str, &str)] = &[("clip.nest", "nest"), ("clip.multicamFlatten", "video/audio")];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-selection-state", "coarse-mode-state", "all-candidate-lane-edges", "whole-lane-transition-list"];
    if command == "clip.nest" {
        out.extend(["whole-nest-track-layout", "whole-default-name-item-kinds"]);
    } else {
        out.extend(["whole-flatten-source-track", "coarse-camera-map", "whole-flatten-source-settings"]);
    }
    out
}
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn expected(project: &Project, seq: u64, command: &str, selected: &[u64], linked: bool, p: &Value) -> Under {
    let q = project.sequence(ItemId(seq)).unwrap();
    let mut want = Under::default();
    let named = p.get("clips").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>()).unwrap_or_else(|| selected.to_vec());
    let ids = operands(q, &named, linked, &mut want);
    if command == "clip.nest" {
        want.premises.push(leaf(seq, &["sequence.settings.settings", "~videoTrackOrder", "~audioTrackOrder"]));
        if p.get("name").and_then(Value::as_str).is_none_or(|s| s.trim().is_empty()) {
            want.premises.push(Premise::on(json!("project")).fields(["~itemIds"]).positions(Vec::<String>::new()));
            for item in project.items.values() {
                want.premises.push(leaf(item.id.0, if item.as_sequence().is_some() { &["kind", "name"] } else { &["kind"] }));
            }
        }
        for track in q.video_tracks.iter().chain(&q.audio_tracks) {
            want.premises.push(leaf(track.id.0, &["props.name", "props.channels", "props.locked", "~editEdges", "transitions"]));
            for clip in &track.items {
                if ids.contains(&clip.id.0) && !track.locked {
                    want.premises.push(Premise::on(json!(clip.id.0)));
                } else {
                    want.premises.push(leaf(clip.id.0, &["link"]));
                }
            }
        }
        return want;
    }
    want.premises.push(leaf(seq, &["sequence.settings.settings.frame_rate", "~videoTrackOrder", "~audioTrackOrder"]));
    let mut destinations = BTreeSet::new();
    for id in &ids {
        want.premises.push(Premise::on(json!(id)));
        let Some((owner, outer)) = q.find_item(ClipId(*id)) else { continue };
        if !outer.multicam.is_some_and(|mode| mode.enabled) {
            continue;
        }
        let Some(source) = project.sequence(outer.item) else { continue };
        want.premises.push(leaf(outer.item.0, &["kind", "~cameraMap", "sequence.settings"]));
        let owner = q.track(owner).unwrap();
        let sources = if owner.kind == TrackKind::Video {
            source.angle_video_track_index(outer.multicam.unwrap().angle as usize).and_then(|i| source.video_tracks.get(i)).into_iter().collect::<Vec<_>>()
        } else {
            match &source.multicam {
                Some(map) => map
                    .audible_tracks(if map.audio == kition_film_engine::project::MulticamAudio::SwitchAudio { outer.multicam_angle(source) } else { None })
                    .into_iter()
                    .filter_map(|id| source.track(id))
                    .collect(),
                None => source.audio_tracks.iter().filter(|track| !track.muted).collect(),
            }
        };
        if owner.kind == TrackKind::Video {
            destinations.insert(owner.id);
        } else {
            let at = q.audio_tracks.iter().position(|track| track.id == owner.id).unwrap();
            destinations.extend(q.audio_tracks.iter().skip(at).take(sources.len().max(1)).map(|track| track.id));
        }
        for track in sources {
            want.premises.push(leaf(track.id.0, &["clips"]));
            want.premises.extend(track.items.iter().map(|clip| Premise::on(json!(clip.id.0))));
        }
    }
    for track in q.all_tracks().filter(|track| destinations.contains(&track.id)) {
        want.premises.push(leaf(track.id.0, &["props.locked", "~editEdges", "transitions"]));
        for clip in &track.items {
            let overwritten = ids.iter().filter_map(|id| q.find_item(ClipId(*id))).any(|(_, outer)| clip.start < outer.end() && clip.end() > outer.start);
            if overwritten {
                want.premises.push(Premise::on(json!(clip.id.0)));
            }
        }
    }
    want
}
#[test]
fn nesting_and_flatten_compare_links_locks_copy_material_sources_and_destination_lanes() {
    let mut doc = FilmDocument::create("Copies.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("file.newSequence", json!({"name":"Cameras","video":2,"audio":2})).unwrap()["sequence"].clone();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
    doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap();
    doc.execute("timeline.place", json!({"item":item,"track":"V2","audioTrack":"A2","time":0})).unwrap();
    doc.execute("sequence.open", json!({"item":seq})).unwrap();
    let clips = doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap()["clips"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_u64)
        .collect::<Vec<_>>();
    doc.execute("clip.multicamEnable", json!({"clips":clips,"enabled":true})).unwrap();
    doc.execute("timeline.place", json!({"item":item,"track":"V2","audioTrack":"A2","time":5*254_016_000_000i64})).unwrap();
    for locked in [false, true] {
        doc.execute("timeline.setTrack", json!({"track":"V1","locked":locked})).unwrap();
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        for linked in [false, true] {
            doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
            for selected in [vec![], vec![clips[0]], vec![clips[1]], clips.clone()] {
                doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                for command in ["clip.nest", "clip.multicamFlatten"] {
                    for p in if command == "clip.nest" {
                        vec![json!({}), json!({"name":"Given"})]
                    } else {
                        vec![json!({}), json!({"clips":clips}), json!({"clips":[clips[1]]})]
                    } {
                        assert_eq!(
                            normalized(doc.under(command, &p).unwrap().unwrap_or_default()),
                            normalized(expected(&project, seq, command, &selected, linked, &p)),
                            "{command}/{p}/{selected:?}/{linked}/{locked}"
                        );
                    }
                }
            }
        }
    }
}
