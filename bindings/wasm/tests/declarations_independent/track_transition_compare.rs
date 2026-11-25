//! commands.rs:1817-1824 (deleteTrack), set_transition, sequence.removeTransition and
//! effects.move (re-read at 451e643e and the commands that follow it). Deleting a lane
//! resolves its id; the program window it holds is incidental (MORE), as is the whole
//! deleted track default. A transition named by its id is no place: setTransition and
//! removeTransition hold no program window. `reverse` alone writes only `reverse`.
//! `params`/`reset` write the effect's parameters while the whole transition (its
//! default) is held: MORE. A new place or length (`span`: start, duration, frames,
//! align) reads the transition's start, duration, from and to (its bounds and cut),
//! the joined clips' starts and lengths, its track's lock and the sequence's frame
//! rate, and writes its start, duration and align (and reverse when given); the
//! effect is written back unchanged. Clearing transitions deletes them whole (their
//! default) and reads each one's track lock. Reordering a clip's effects reads which
//! of its effects are standard and its track's lock and writes the effects' order,
//! holding the whole effects list (MORE). The setTransition answer's start, duration
//! and align are recomputed when a step is replayed; no write depends on them.
use super::{project_identity_compare::program, sync_compare::normalized};
use kition_film_engine::project::{ItemId, Sequence};
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::{Value, json};
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
pub fn more(command: &str, path: &str) -> Vec<&'static str> {
    match (command, path) {
        ("sequence.deleteTrack", _) => vec!["unconsumed-program-material", "whole-deleted-track-default"],
        ("sequence.setTransition", "params/reset") => vec!["whole-transition-default"],
        ("effects.move", _) => vec!["whole-effect-profile"],
        _ => vec![],
    }
}
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
/// What setTransition `p` reads and replaces on the transition `transition` of `q` (sequence `seq`), independently.
fn set_transition(q: &Sequence, seq: u64, transition: u64, p: &Value) -> Under {
    let mut want = Under::default();
    let given = |key: &str| p.get(key).is_some_and(|value| !value.is_null());
    if given("params") || p["reset"] == true {
        // the transition whole (its default): no premise
        return want;
    }
    if !["start", "duration", "frames", "align"].iter().any(|key| given(key)) {
        want.premises.push(leaf(transition, &["reverse"]));
        return want;
    }
    let (track, found) = q.all_tracks().find_map(|t| t.transitions.iter().find(|x| x.id.0 == transition).map(|x| (t, x))).unwrap();
    let mut fields = vec!["start", "duration", "align", "from", "to"];
    if given("reverse") {
        fields.push("reverse");
    }
    want.premises.push(leaf(transition, &fields));
    for clip in [found.from, found.to].into_iter().flatten() {
        want.premises.push(Premise::on(json!(clip.0)).fields(Vec::<String>::new()).positions(["start", "duration"]));
    }
    want.premises.push(leaf(track.id.0, &["props.locked"]));
    want.premises.push(leaf(seq, &["sequence.settings.settings.frame_rate"]));
    want
}
#[test]
fn track_and_transition_paths_compare_ordinals_id_defaults_and_patch_masks() {
    let mut doc = FilmDocument::create("Track.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("item.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
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
                let want = if command == "sequence.deleteTrack" {
                    let mut want = program(q, at);
                    if let Some(name) = p["track"].as_str() {
                        let index = name[1..].parse::<usize>().unwrap() - 1;
                        let (tracks, field) =
                            if name.starts_with('V') { (&q.video_tracks, "sequence.videoTracks") } else { (&q.audio_tracks, "sequence.audioTracks") };
                        want.premises.push(Premise::on(json!(tracks[index].id.0)).fields(Vec::<String>::new()).positions([field]));
                    }
                    want
                } else {
                    set_transition(q, seq, transition.as_u64().unwrap(), &p)
                };
                assert_eq!(normalized(doc.under(command, &p).unwrap().unwrap()), normalized(want), "{command}/{p}/{at}");
            }
        }
    }
}

#[test]
fn transition_spans_clears_and_effect_order_hold_what_they_read() {
    let mut doc = FilmDocument::create("Track.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("item.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
    let first = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].clone();
    let second = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":762_048_000_000i64})).unwrap()["clips"][0].clone();
    // a transition between two clips, and a fade from nothing at the first clip's In
    let between = doc.execute("sequence.applyVideoTransition", json!({"clip":second,"edge":"in","frames":8})).unwrap()["transition"].clone();
    let fade = doc.execute("sequence.applyVideoTransition", json!({"clip":first,"edge":"in","frames":4})).unwrap()["transition"].clone();
    doc.execute("effect.apply", json!({"clips":[first],"effect":"gaussian_blur"})).unwrap();
    doc.execute("effect.apply", json!({"clips":[first],"effect":"invert"})).unwrap();
    for locked in [false, true] {
        doc.execute("timeline.setTrack", json!({"track":"V1","locked":locked})).unwrap();
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(seq)).unwrap();
        let v1 = q.video_tracks[0].id.0;
        for at in [0, 254_016_000_000i64, 762_048_000_000] {
            doc.execute("playhead.set", json!({"time":at})).unwrap();
            for transition in [&between, &fade] {
                let id = transition.as_u64().unwrap();
                for p in [
                    json!({"transition":transition,"frames":6}),
                    json!({"transition":transition,"duration":100_000_000_000i64}),
                    json!({"transition":transition,"align":"start"}),
                    json!({"transition":transition,"start":700_000_000_000i64,"merge":true}),
                    json!({"transition":transition,"start":700_000_000_000i64,"merge":true,"begin":true}),
                    json!({"transition":transition,"start":700_000_000_000i64,"duration":100_000_000_000i64,"reverse":true}),
                    json!({"transition":transition,"frames":6,"params":{"mix":0.5}}),
                    json!({"transition":transition,"align":"end","reset":true}),
                    json!({"transition":transition,"reverse":false,"merge":true}),
                ] {
                    let spec = doc.commands().into_iter().find(|spec| spec.id == "sequence.setTransition").unwrap();
                    assert!(spec.mutates && spec.targets.is_none() && spec.objects == vec!["transition"]);
                    assert_eq!(
                        normalized(doc.under("sequence.setTransition", &p).unwrap().unwrap_or_default()),
                        normalized(set_transition(q, seq, id, &p)),
                        "{p}/{at}/{locked}"
                    );
                }
            }
            // clearing: the named transitions whole (their default), each one's track lock
            for (p, owners) in
                [(json!({"transitions":[between]}), vec![v1]), (json!({"transitions":[between, fade]}), vec![v1]), (json!({"transitions":[u64::MAX]}), vec![])]
            {
                let spec = doc.commands().into_iter().find(|spec| spec.id == "sequence.removeTransition").unwrap();
                assert!(spec.mutates && spec.targets.is_none() && spec.objects == vec!["transitions"]);
                let mut want = Under::default();
                want.premises.extend(owners.iter().map(|track| leaf(*track, &["props.locked"])));
                assert_eq!(normalized(doc.under("sequence.removeTransition", &p).unwrap().unwrap_or_default()), normalized(want), "{p}/{at}/{locked}");
            }
            // reordering a clip's effects: its effects and its track's lock
            for p in [json!({"clip":first,"index":1,"to":0}), json!({"clip":first,"index":0,"to":1}), json!({"clip":u64::MAX,"index":0,"to":1})] {
                let spec = doc.commands().into_iter().find(|spec| spec.id == "effects.move").unwrap();
                assert!(spec.mutates && spec.targets == Some("clip"));
                let mut want = Under::default();
                if p["clip"] == first {
                    want.premises.push(leaf(first.as_u64().unwrap(), &["effects"]));
                    want.premises.push(leaf(v1, &["props.locked"]));
                } else {
                    want.premises.push(leaf(u64::MAX, &["effects"]));
                }
                assert_eq!(normalized(doc.under("effects.move", &p).unwrap().unwrap_or_default()), normalized(want), "{p}/{at}/{locked}");
            }
        }
    }
}
