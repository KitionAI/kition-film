//! audio_mixing.rs:34-86,154-243,290-331,376-444 and mixer.rs:1047-1152.
//! Reconciliation reads old settings and effects; measured writes also read
//! media routes. Ducking discovers candidates across all audio clips.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, ItemKind, Project, Sequence};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("audioMixing.setType", "target/update reconciliation"),
    ("audioMixing.clearType", "target/update reconciliation"),
    ("audioMixing.set", "target/update reconciliation"),
    ("audioMixing.applyPreset", "target/update reconciliation"),
    ("audioMixing.savePreset", "target/update reconciliation"),
    ("audioMixing.savePreset", "preferences snapshot"),
    ("audioMixing.autoMatch", "measured audio"),
    ("audioMixing.generateDucking", "trigger discovery and measurement"),
    ("clip.audioGain", "set/adjust"),
    ("clip.audioGain", "normalizeMax/normalizeAll"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/audio_mixing.rs")) == 0x62e5a74e1bc8c02c
        && hash(include_str!("../../../../crates/engine/engine/src/mixer.rs")) == 0xa107f2e7e8e2a5e4
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-selection-state", "coarse-mode-state", "clip-owner-position", "unconsumed-selection"];
    if command.starts_with("audioMixing.") {
        out.extend(["whole-audio-mixing-settings", "whole-effect-profile", "coarse-source-profile"]);
        if command != "audioMixing.generateDucking" {
            out.push("coarse-time-state");
        }
    }
    if command == "audioMixing.generateDucking" {
        out.push("all-ducking-candidate-profiles");
    }
    out
}

fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}

pub(super) fn source(want: &mut Under, project: &Project, mut id: ItemId) {
    let mut seen = std::collections::BTreeSet::new();
    while seen.insert(id) {
        want.premises.push(leaf(
            id.0,
            ["kind", "props.media", "props.parent", "props.range", "props.restrict_trims", "props.width", "props.height", "props.rate", "sequence"],
        ));
        match project.item(id).map(|item| &item.kind) {
            Some(ItemKind::Subclip { parent, .. }) => id = *parent,
            _ => break,
        }
    }
}

fn expected(project: &Project, sequence: u64, q: &Sequence, command: &str, params: &Value, selected: &[u64], linked: bool) -> Under {
    let audio_mixing = command.starts_with("audioMixing.");
    let normalize = command == "clip.audioGain" && matches!(params["mode"].as_str(), Some("normalizeMax" | "normalizeAll"));
    let base: Vec<u64> =
        params.get("clips").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_else(|| selected.to_vec());
    let mut targets = base.clone();
    let mut want = Under::default();
    if linked {
        for id in &base {
            want.premises.push(leaf(*id, ["link", "~linkedGroup"]));
            if let Some(link) = q.all_tracks().flat_map(|track| &track.items).find(|clip| clip.id.0 == *id).and_then(|clip| clip.link) {
                let peers: Vec<_> = q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(link)).map(|clip| clip.id.0).collect();
                want.premises.push(leaf(*peers.iter().min().unwrap(), ["~linkedMembers"]));
                targets.extend(peers);
            }
        }
    }
    for clip in q.audio_tracks.iter().flat_map(|track| &track.items).filter(|clip| targets.contains(&clip.id.0)) {
        let mut fields = if audio_mixing { vec!["link", "props.audio_mixing", "effects", "gain"] } else { vec!["link", "gain"] };
        let mut positions = vec!["clips"];
        if audio_mixing || normalize {
            fields.extend(["item", "sourceIn", "speed", "reverse", "props.frame_hold", "props.source_channels", "props.audio_stream"]);
            positions.extend(["start", "duration"]);
            if normalize || matches!(command, "audioMixing.autoMatch" | "audioMixing.generateDucking") {
                source(&mut want, project, clip.item);
            }
        }
        want.premises.push(leaf(clip.id.0, fields).positions(positions));
    }
    if matches!(command, "audioMixing.autoMatch" | "audioMixing.generateDucking") {
        want.premises.push(leaf(sequence, ["sequence.settings.settings.sample_rate"]));
    }
    if command == "audioMixing.generateDucking" {
        want.premises.push(leaf(sequence, ["~audioClipIds"]));
        for clip in q.audio_tracks.iter().flat_map(|track| &track.items) {
            want.premises.push(
                leaf(
                    clip.id.0,
                    [
                        "props.enabled",
                        "props.audio_mixing",
                        "item",
                        "sourceIn",
                        "speed",
                        "reverse",
                        "props.frame_hold",
                        "props.source_channels",
                        "props.audio_stream",
                    ],
                )
                .positions(["start", "duration"]),
            );
            source(&mut want, project, clip.item);
        }
    }
    want
}

#[test]
fn sound_paths_compare_target_precedence_link_closure_gain_modes_reconciliation_and_media_routes() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let parent = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
    let sub = doc.execute("clip.makeSubclip", json!({"item":parent,"start":0,"end":254_016_000_000i64})).unwrap()["item"].clone();
    let mut clips = Vec::new();
    for (item, video, audio) in [(parent, "V1", "A1"), (sub, "V2", "A2")] {
        clips.extend(
            doc.execute("timeline.place", json!({"item":item,"track":video,"audioTrack":audio,"time":0})).unwrap()["clips"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_u64().unwrap()),
        );
    }
    doc.execute("audioMixing.setType", json!({"clips":[clips[1],clips[3]],"type":"dialogue"})).unwrap();
    doc.execute("audioMixing.savePreset", json!({"clips":[clips[1]],"name":"Saved"})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let q = project.sequence(ItemId(sequence)).unwrap();
    for linked in [false, true] {
        doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
        for selected in [vec![], vec![clips[0]], vec![clips[1]], vec![clips[0], clips[3]], clips.clone()] {
            doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
            for &(command, path) in PATHS {
                assert!(compared_path(command, path));
                let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                assert!(spec.mutates && spec.targets == Some("clips") && spec.objects.is_empty());
                assert_eq!(spec.object_types, [("clips", &["Clip"][..])]);
                assert_eq!(
                    spec.reads,
                    if command == "clip.audioGain" || command == "audioMixing.generateDucking" {
                        vec![EditorState::Part, EditorState::Selection, EditorState::Mode]
                    } else {
                        vec![EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Mode]
                    }
                );
                assert_eq!(spec.enabled, command != "clip.audioGain" || !selected.is_empty());
                assert!(
                    spec.places.is_empty()
                        && spec.name_params.is_empty()
                        && spec.name_field.is_none()
                        && spec.index.is_none()
                        && !spec.index_numbers
                        && !spec.index_reversed
                );
                for explicit in [
                    None,
                    Some(Value::Null),
                    Some(json!([])),
                    Some(json!([clips[0]])),
                    Some(json!([clips[1], clips[3]])),
                    Some(json!([clips[3], clips[0], clips[3]])),
                ] {
                    for mode in if command == "clip.audioGain" {
                        vec![None, Some("set"), Some("adjust"), Some("normalizeMax"), Some("normalizeAll")]
                    } else {
                        vec![None]
                    } {
                        let mut p = json!({"type":"dialogue","preset":"Saved","name":"Preset","target":-23,"key":"mute","value":true,"db":-6});
                        if let Some(clips) = &explicit {
                            p["clips"] = clips.clone();
                        }
                        if let Some(mode) = mode {
                            p["mode"] = json!(mode);
                        }
                        assert_eq!(
                            normalized(doc.under(command, &p).unwrap().unwrap()),
                            normalized(expected(&project, sequence, q, command, &p, &selected, linked)),
                            "{command}/{p}/selected={selected:?}/linked={linked}"
                        );
                    }
                }
            }
        }
    }
    let ids = q.audio_tracks.iter().flat_map(|track| &track.items).map(|clip| clip.id.0).collect::<Vec<_>>();
    let facts = doc.derived(&[json!(sequence)], &["audioClipIds".into()]).unwrap();
    assert_eq!(facts.iter().find(|fact| fact.id == json!(sequence)).unwrap().values["audioClipIds"], json!(ids));
}
