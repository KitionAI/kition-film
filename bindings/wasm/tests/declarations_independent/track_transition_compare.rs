//! commands.rs:1817-1824,3720-3750: deleting a lane resolves its id;
//! transition edits update only effect and reverse. Program windows are
//! incidental declarations and are reported as MORE, as are whole defaults.
//! A transition's new place or length (`span`), clearing transitions and
//! reordering a clip's effects state no premise: they read the joined clips,
//! every track's transitions, or the clip's effects whole, which the
//! defaults (the named objects whole, the program window) already hold.
use super::{project_identity_compare::program, sync_compare::normalized};
use kition_film_engine::project::ItemId;
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::json;
pub const PATHS: &[(&str, &str)] = &[
    ("sequence.deleteTrack", "track"),
    ("sequence.setTransition", "reverse"),
    ("sequence.setTransition", "params/reset"),
    ("sequence.setTransition", "span"),
    ("sequence.removeTransition", "transitions"),
    ("effects.move", "effect-order"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command == "sequence.deleteTrack" {
        vec!["unconsumed-program-material", "whole-deleted-track-default"]
    } else if command == "effects.move" {
        vec!["whole-clip-default"]
    } else {
        vec!["unconsumed-program-material", "whole-transition-default"]
    }
}
#[test]
fn track_and_transition_paths_compare_ordinals_id_defaults_and_patch_masks() {
    let mut doc = FilmDocument::create("Track.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
    let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].clone();
    let transition = doc.execute("sequence.applyVideoTransition", json!({"clip":clip,"edge":"in","frames":8})).unwrap()["transition"].clone();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let q = project.sequence(ItemId(seq)).unwrap();
    for at in [0, 254_016_000_000i64, 1_270_080_000_000] {
        doc.execute("playhead.set", json!({"time":at})).unwrap();
        let at = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
        for command in ["sequence.deleteTrack", "sequence.setTransition"] {
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            assert!(spec.mutates && spec.targets.is_none());
            assert_eq!(spec.objects, if command == "sequence.deleteTrack" { vec!["track"] } else { vec!["transition"] });
            let params = if command == "sequence.deleteTrack" {
                q.all_tracks().flat_map(|track|[json!({"track":track.id.0}),json!({"track":if q.video_tracks.iter().any(|t|t.id==track.id){format!("V{}",q.video_tracks.iter().position(|t|t.id==track.id).unwrap()+1)}else{format!("A{}",q.audio_tracks.iter().position(|t|t.id==track.id).unwrap()+1)}})]).collect::<Vec<_>>()
            } else {
                vec![
                    json!({"transition":transition,"reverse":true}),
                    json!({"transition":transition,"params":{"mix":0.5}}),
                    json!({"transition":transition,"reset":true}),
                    json!({"transition":transition,"reset":false,"reverse":false}),
                ]
            };
            for p in params {
                let mut want = program(q, at);
                if command == "sequence.deleteTrack" {
                    if let Some(name) = p["track"].as_str() {
                        let index = name[1..].parse::<usize>().unwrap() - 1;
                        let (tracks, field) =
                            if name.starts_with('V') { (&q.video_tracks, "sequence.videoTracks") } else { (&q.audio_tracks, "sequence.audioTracks") };
                        want.premises.push(Premise::on(json!(tracks[index].id.0)).fields(Vec::<String>::new()).positions([field]));
                    }
                } else if p.get("params").is_none() && p["reset"] != true {
                    want.premises.push(Premise::on(transition.clone()).fields(["reverse"]).positions(Vec::<String>::new()));
                }
                assert_eq!(normalized(doc.under(command, &p).unwrap().unwrap()), normalized(want), "{command}/{p}/{at}");
            }
        }
    }
}

#[test]
fn transition_spans_clears_and_effect_order_state_no_premise() {
    let mut doc = FilmDocument::create("Track.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
    let first = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].clone();
    let second = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":762_048_000_000i64})).unwrap()["clips"][0].clone();
    let transition = doc.execute("sequence.applyVideoTransition", json!({"clip":second,"edge":"in","frames":8})).unwrap()["transition"].clone();
    doc.execute("effects.apply", json!({"clips":[first],"effect":"gaussian_blur"})).unwrap();
    doc.execute("effects.apply", json!({"clips":[first],"effect":"invert"})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let q = project.sequence(ItemId(seq)).unwrap();
    for at in [0, 254_016_000_000i64, 762_048_000_000] {
        doc.execute("playhead.set", json!({"time":at})).unwrap();
        let at = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
        let calls = [
            ("sequence.setTransition", json!({"transition":transition,"frames":6})),
            ("sequence.setTransition", json!({"transition":transition,"align":"start"})),
            ("sequence.setTransition", json!({"transition":transition,"start":700_000_000_000i64,"merge":true})),
            ("sequence.setTransition", json!({"transition":transition,"start":700_000_000_000i64,"duration":100_000_000_000i64,"reverse":true})),
            ("sequence.removeTransition", json!({"transitions":[transition]})),
            ("effects.move", json!({"clip":first,"index":1,"to":0})),
        ];
        for (command, p) in calls {
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            // a reorder names its clip as its target, which it reads whole; the rest name their
            // transitions and hold the program window
            let want = if command == "effects.move" {
                assert!(spec.mutates && spec.targets == Some("clip"), "{command}");
                Under::default()
            } else {
                assert!(spec.mutates && spec.targets.is_none(), "{command}");
                assert_eq!(spec.objects, vec![if command == "sequence.removeTransition" { "transitions" } else { "transition" }]);
                program(q, at)
            };
            assert_eq!(normalized(doc.under(command, &p).unwrap().unwrap()), normalized(want), "{command}/{p}/{at}");
        }
    }
}
