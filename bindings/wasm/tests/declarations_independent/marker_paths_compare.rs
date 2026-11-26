//! Remaining marker destinations: commands.rs:1945-2136,2184-2203;
//! sequence_tools.rs:845-860; source_monitor.rs:115-217.
use super::sync_compare::normalized;
use kition_film_kit::FilmDocument;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("marker.goToIn", "program"),
    ("marker.goToOut", "program"),
    ("marker.goNext", "program"),
    ("marker.goPrev", "program"),
    ("marker.goToIn", "target=source"),
    ("marker.goToOut", "target=source"),
    ("marker.goToSplitVideoIn", "program"),
    ("marker.goToSplitVideoIn", "source"),
    ("marker.goToSplitVideoOut", "program"),
    ("marker.goToSplitVideoOut", "source"),
    ("marker.goToSplitAudioIn", "program"),
    ("marker.goToSplitAudioIn", "source"),
    ("marker.goToSplitAudioOut", "program"),
    ("marker.goToSplitAudioOut", "source"),
    ("source.setPlayhead", "navigation"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0xa5f7dd875311a060
        && hash(include_str!("../../../../crates/engine/engine/src/sequence_tools.rs")) == 0x848ed5aa3b9d96b3
        && hash(include_str!("../../../../crates/engine/engine/src/source_monitor.rs")) == SOURCE_HASH
}

const SOURCE_HASH: u64 = 0xd5a06c7204ca3dda;

pub fn more(command: &str, path: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-active-state"];
    if command != "source.setPlayhead" {
        out.extend(["coarse-mode-state", "coarse-time-state"]);
    }
    if path != "program" && command != "source.setPlayhead" {
        out.push("source-only-part");
    }
    if matches!(command, "marker.goNext" | "marker.goPrev") {
        out.push("whole-marker-navigation");
    }
    out
}

fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}

#[test]
fn marker_destinations_compare_program_source_split_and_missing_mark_fallbacks() {
    for marked in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        let media = doc.execute("item.newColorMatte", json!({"seconds":3})).unwrap()["item"].as_u64().unwrap();
        doc.execute("timeline.place", json!({"item":media,"track":"V1","time":0})).unwrap();
        if marked {
            doc.execute("marker.markIn", json!({"time":254_016_000_000i64})).unwrap();
            doc.execute("marker.markOut", json!({"time":508_032_000_000i64})).unwrap();
            for side in ["VideoIn", "VideoOut", "AudioIn", "AudioOut"] {
                doc.execute(&format!("marker.markSplit{side}"), json!({"time":254_016_000_000i64})).unwrap();
            }
        }
        doc.execute("marker.add", json!({"time":254_016_000_000i64,"name":"Cue"})).unwrap();
        for source in [media, sequence] {
            doc.execute("source.open", json!({"item":source})).unwrap();
            let specs = doc.commands();
            for &(command, path) in PATHS {
                let spec = specs.iter().find(|s| s.id == command).unwrap();
                assert_eq!(spec.enabled, !command.contains("Split") || marked, "{command}");
                assert!(spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty());
                assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                let source_path = path != "program";
                let params = if command == "source.setPlayhead" {
                    json!({"frame":12})
                } else if source_path {
                    json!({"target":"source"})
                } else {
                    json!({})
                };
                let mut expected = Under::default();
                if command == "source.setPlayhead" || source_path && !command.contains("Split") {
                    let mut fields = vec!["~sourceStart", "~sourceEnd", "~sourceRate"];
                    if command != "source.setPlayhead" {
                        fields.push(if command.ends_with("In") { "~sourceMarkIn" } else { "~sourceMarkOut" });
                    }
                    expected.premises.push(leaf(source, fields));
                } else if command.contains("Split") {
                    let side = command.strip_prefix("marker.goToSplit").unwrap();
                    let channel = if side.starts_with("Video") { "video" } else { "audio" };
                    let edge = if side.ends_with("In") { "In" } else { "Out" };
                    let mut fields = Vec::<String>::new();
                    if source_path {
                        fields.push("kind".into());
                        fields.push(format!("props.common.split.{channel}{edge}"));
                        fields.push(if source == sequence {
                            format!("sequence.settings.mark_{}", edge.to_lowercase())
                        } else {
                            format!("props.media.mark_{}", edge.to_lowercase())
                        });
                    } else {
                        fields.extend([
                            format!("sequence.settings.split.{channel}{edge}"),
                            format!("sequence.settings.mark_{}", edge.to_lowercase()),
                            "sequence.settings.settings.frame_rate".into(),
                        ]);
                    }
                    expected.premises.push(leaf(if source_path { source } else { sequence }, fields));
                } else {
                    let mut fields = vec!["sequence.settings.settings.frame_rate"];
                    match command {
                        "marker.goToIn" => fields.push("sequence.settings.mark_in"),
                        "marker.goToOut" => {
                            fields.push("sequence.settings.mark_out");
                            if !marked {
                                fields.push("sequence.duration");
                            }
                        }
                        _ => fields.push("sequence.markers"),
                    }
                    expected.premises.push(leaf(sequence, fields));
                }
                assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap()), normalized(expected), "{command}/{path}/source={source}/marked={marked}");
            }
        }
    }
}
