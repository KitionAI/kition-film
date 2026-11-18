//! transcript.rs:195-404, edit/transcript.rs:62-103,260-271. Source resolution
//! consumes only parent identities; word indices consume ordered audio geometry.
//! Range edits retain a conservative owned sequence and the library stays whole.
use super::sync_compare::normalized;
use kition_film_engine::project::ItemId;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("transcript.set", "root media destination"),
    ("transcript.delete", "explicit/all transcripts"),
    ("transcript.renameSpeaker", "name or speaker index"),
    ("transcript.select", "word index range"),
    ("transcript.lift", "word index -> time range"),
    ("transcript.extract", "word index -> time range"),
    ("transcript.removePauses", "derived ranges"),
    ("transcript.removeFillers", "derived ranges"),
    ("transcript.createCaptions", "derived words"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/transcript.rs")) == 0x7c5b6211d7c861f4
        && hash(include_str!("../../../../crates/engine/edit/src/transcript.rs")) == 0x6ddd7309ee356c0a
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["whole-transcript-library"];
    if !matches!(command, "transcript.set" | "transcript.delete" | "transcript.renameSpeaker" | "transcript.createCaptions") {
        out.push("whole-transcript-sequence");
    }
    if matches!(command, "transcript.select" | "transcript.lift" | "transcript.extract") {
        out.extend(["coarse-active-state", "coarse-mode-state", "coarse-time-state"]);
    }
    out
}
fn leaf(id: Value, fields: impl IntoIterator<Item = &'static str>) -> Premise {
    Premise::on(id).fields(fields).positions(Vec::<String>::new())
}

#[test]
fn transcript_paths_compare_all_source_routes_word_operations_and_empty_audio_membership() {
    for populated in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        let source = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
        let sub = doc.execute("clip.makeSubclip", json!({"item":source,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
        if populated {
            doc.execute("timeline.place", json!({"item":source,"track":"V1","audioTrack":"A1","time":0})).unwrap();
            doc.execute("timeline.place", json!({"item":sub,"track":"V2","audioTrack":"A2","time":508_032_000_000i64})).unwrap();
            doc.execute("transcript.set", json!({"item":source,"transcript":{"words":[{"text":"um","start":0,"end":127_008_000_000i64}]}})).unwrap();
        }
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        for &(command, path) in PATHS {
            assert!(compared_path(command, path), "{command}/{path}");
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            let sources = matches!(command, "transcript.set" | "transcript.delete" | "transcript.renameSpeaker");
            assert_eq!(
                spec.reads,
                if sources {
                    vec![]
                } else if matches!(command, "transcript.select" | "transcript.lift" | "transcript.extract") {
                    vec![EditorState::Part, EditorState::Time, EditorState::Mode, EditorState::Active]
                } else {
                    vec![EditorState::Part]
                },
                "{command}"
            );
            assert!(spec.mutates && spec.places.is_empty() && spec.objects.is_empty());
            assert_eq!(spec.targets, if sources { Some(if command == "transcript.delete" { "items" } else { "item" }) } else { None });
            assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
            for target in [None, Some(source), Some(sub)] {
                let mut params = json!({"from":0,"to":0});
                let mut want = Under { premises: vec![leaf(json!("project"), ["docState.transcripts"])], ..Default::default() };
                if sources {
                    if let Some(id) = target {
                        params[if command == "transcript.delete" { "items" } else { "item" }] =
                            if command == "transcript.delete" { json!([id]) } else { json!(id) };
                        want.premises.push(leaf(json!(id), ["kind", "props.parent"]));
                        if id == sub {
                            want.premises.push(leaf(json!(source), ["kind", "props.parent"]));
                        }
                    }
                } else if command == "transcript.createCaptions" {
                    want.premises.push(leaf(json!(sequence), ["~audioTrackOrder", "sequence.settings.settings.frame_rate"]));
                    for track in &q.audio_tracks {
                        want.premises.push(leaf(json!(track.id.0), ["~clipOrder"]));
                        for clip in &track.items {
                            want.premises.push(
                                leaf(json!(clip.id.0), ["item", "props.enabled", "reverse", "props.frame_hold", "speed", "sourceIn"])
                                    .positions(["start", "duration"]),
                            );
                        }
                    }
                } else {
                    want.premises.push(leaf(json!(sequence), ["sequence"]));
                }
                assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap()), normalized(want), "{command}/{path}/{target:?}/{populated}");
            }
        }
    }
}
