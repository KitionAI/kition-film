//! captions.rs:293-318 appends a track and returns its ordinal. At 436-480,
//! Add Caption creates C1 only when the sequence has no caption tracks.
use super::sync_compare::normalized;
use kition_film_engine::project::ItemId;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[("caption.newTrack", "append"), ("caption.add", "automatic C1")];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path)) && hash(include_str!("../../../../crates/engine/engine/src/captions.rs")) == 0xd8332e1b444fc431
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command == "caption.add" { vec!["unconsumed-program-material", "unused-caption-playhead"] } else { vec![] }
}
fn leaf(sequence: u64, fields: &[&str]) -> Under {
    Under { premises: vec![Premise::on(json!(sequence)).fields(fields.iter().copied()).positions(Vec::<String>::new())], ..Default::default() }
}
#[test]
fn caption_creation_compares_append_counts_automatic_destinations_formats_and_time_spellings() {
    for populated in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        if populated {
            let source = doc.execute("item.newColorMatte", json!({"seconds":4})).unwrap()["item"].clone();
            doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap();
        }
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        for address in [Value::Null, json!("C1"), json!("c1"), json!("1")] {
            for timing in [
                json!({}),
                json!({"time":1}),
                json!({"seconds":1.0}),
                json!({"frame":1}),
                json!({"timecode":"00:00:00:01"}),
                json!({"words":[{"text":"word","start":1.0,"end":2.0}]}),
            ] {
                for duration in [Value::Null, json!(0.0), json!(1.0)] {
                    let mut params = timing.clone();
                    params["track"] = address.clone();
                    params["durationSeconds"] = duration;
                    let mut want = leaf(
                        sequence,
                        if timing.get("timecode").is_some() {
                            &["sequence.settings.settings.frame_rate", "sequence.settings.settings.drop_frame"]
                        } else {
                            &["sequence.settings.settings.frame_rate"]
                        },
                    );
                    let at = if timing.get("time").is_some() {
                        1
                    } else if timing.get("seconds").is_some() {
                        254_016_000_000
                    } else if timing.get("frame").is_some() || timing.get("timecode").is_some() {
                        q.settings.frame_rate.tick_of(1).0
                    } else {
                        0
                    };
                    super::marks_compare::program_material(q, at, &mut want);
                    assert_eq!(normalized(doc.under("caption.add", &params).unwrap().unwrap()), normalized(want), "automatic/{params}");
                }
            }
        }
        for count in 0..4 {
            let command = "caption.newTrack";
            let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
            assert!(
                spec.enabled && spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty()
            );
            assert_eq!(spec.reads, vec![EditorState::Part]);
            let values = doc.derived(&[json!(sequence)], &["captionTrackCount".to_string()]).unwrap();
            assert_eq!(values.iter().find(|v| v.id == json!(sequence)).unwrap().values["captionTrackCount"], json!(count));
            for format in [Value::Null, json!("Subtitle"), json!("CEA-608"), json!("CEA-708"), json!("Teletext")] {
                for name in [Value::Null, json!("Named")] {
                    let params = json!({"format":format,"name":name,"language":"zh"});
                    assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap()), normalized(leaf(sequence, &["~captionTrackCount"])));
                }
            }
            assert_eq!(doc.execute(command, json!({"name":"New"})).unwrap()["label"], json!(format!("C{}", count + 1)));
        }
        for &(command, path) in PATHS {
            assert!(compared_path(command, path));
        }
    }
}
