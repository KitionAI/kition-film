//! keyboard.rs:345-380 toggles one flag on the targeted lanes of one kind.
//! Clip contents, timeline time, locks and lane names do not participate.
use super::sync_compare::normalized;
use kition_film_engine::project::ItemId;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::json;

pub const COMMANDS: &[(&str, &str, &str)] = &[
    ("timeline.toggleMuteTargetedAudio", "audio", "props.muted"),
    ("timeline.toggleSoloTargetedAudio", "audio", "props.solo"),
    ("timeline.toggleOutputTargetedVideo", "video", "props.enabled"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    COMMANDS.iter().any(|&(id, _, _)| id == command)
        && path == "targeted track toggles"
        && include_str!("../../../../crates/engine/engine/src/keyboard.rs")
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3))
            == 0xc4c1cfffb8e70cd9
}

pub fn more() -> Vec<&'static str> {
    vec!["coarse-active-state", "whole-default-track-order"]
}

#[test]
fn targeted_flags_compare_empty_and_populated_lanes_default_and_explicit_target_sets() {
    for populated in [false, true] {
        for explicit in [false, true] {
            for mask in 0..8 {
                let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
                if populated {
                    let item = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
                    doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap();
                }
                let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
                let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                let q = project.sequence(ItemId(sequence)).unwrap();
                if explicit {
                    for tracks in [&q.video_tracks, &q.audio_tracks] {
                        for (index, track) in tracks.iter().enumerate() {
                            doc.execute("timeline.setTargeting", json!({"track":track.id.0,"targeted":mask & (1 << index) != 0})).unwrap();
                        }
                    }
                }
                for &(command, kind, field) in COMMANDS {
                    assert!(compared_path(command, "targeted track toggles"));
                    let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                    assert!(spec.enabled && spec.mutates && spec.targets.is_none());
                    assert_eq!(spec.reads, [EditorState::Part, EditorState::Active]);
                    assert!(spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty());
                    assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                    let tracks = if kind == "audio" { &q.audio_tracks } else { &q.video_tracks };
                    let mut want = Under::default();
                    if !explicit {
                        want.premises.push(Premise::on(json!(sequence)).fields([format!("~{kind}TrackOrder")]).positions(Vec::<String>::new()));
                    }
                    for (index, track) in tracks.iter().enumerate().filter(|(index, _)| !explicit || mask & (1 << index) != 0) {
                        doc.execute("timeline.setTrack", json!({"track":track.id.0,"muted":index % 2 == 0,"solo":index % 2 == 1,"enabled":index % 2 == 1}))
                            .unwrap();
                        want.premises.push(Premise::on(json!(track.id.0)).fields([field]).positions(Vec::<String>::new()));
                    }
                    assert_eq!(
                        normalized(doc.under(command, &json!({})).unwrap().unwrap()),
                        normalized(want),
                        "{command}/populated={populated}/explicit={explicit}/mask={mask}"
                    );
                }
            }
        }
    }
}
