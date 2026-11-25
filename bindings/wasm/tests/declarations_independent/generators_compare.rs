//! Complete comparisons of generator landing, defaults and eligibility.
//! commands.rs::new_generator and the adjustment closure create fresh root
//! items with fixed labels. Their only document inputs are sequence defaults;
//! explicit dimensions cancel those defaults. clip_ops::offline_file also
//! accepts an explicit rate and omits dimensions for audio-only media.
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const COMPARED_PATHS: &[(&str, &str)] = &[
    ("item.newAdjustmentLayer", "default-size"),
    ("item.newBarsAndTone", "generator"),
    ("item.newBlackVideo", "generator"),
    ("item.newColorMatte", "generator"),
    ("item.newCountingLeader", "generator"),
    ("item.newTransparentVideo", "generator"),
    ("item.newOfflineFile", "sequence defaults"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    use super::patches_compare::matches_source;
    if !COMPARED_PATHS.contains(&(command, path)) {
        return false;
    }
    let commands = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/commands.rs"));
    let clips = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/clip_ops.rs"));
    if command == "item.newOfflineFile" {
        matches_source(clips, "fn offline_file(", "fn close_project(", 0xfa3a68219f01e36d)
    } else {
        matches_source(commands, "fn new_generator(", "/// `project.matteColor`", 0x8c81d5d34344703d)
            && matches_source(commands, "        cmd!(\"item.newAdjustmentLayer\",", "            \"file.importDemoFootage\",", 0x66817ea60db1f00f)
    }
}

#[test]
fn generator_paths_compare_every_default_and_explicit_dimension_combination() {
    for &(command, path) in COMPARED_PATHS {
        assert!(compared_path(command, path), "handler changed: review {command}/{path} again");
        for active in [false, true] {
            let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
            let sequence = doc.inspect().unwrap()["sequence"]["id"].clone();
            if !active {
                doc.execute("sequence.close", json!({})).unwrap();
            }
            let declaration = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            assert!(declaration.enabled && declaration.mutates, "{command}");
            assert_eq!(declaration.reads, [EditorState::Part], "{command}");
            assert!(declaration.targets.is_none() && declaration.objects.is_empty() && declaration.places.is_empty(), "{command}");
            assert!(declaration.object_types.is_empty() && declaration.name_params.is_empty(), "{command}");
            assert!(declaration.name_field.is_none() && declaration.index.is_none() && !declaration.index_numbers && !declaration.index_reversed, "{command}");
            for mask in 0..8 {
                for floating in [false, true] {
                    for video in [false, true] {
                        let mut params = json!({"seconds":1,"video":video,"audio":true,"name":"Generated","color":"#123456"});
                        for (bit, param, value) in [(0, "width", 320), (1, "height", 180), (2, "fps", 25)] {
                            if mask & (1 << bit) != 0 {
                                params[param] = if floating { json!(f64::from(value)) } else { json!(value) };
                            } else {
                                params[param] = Value::Null;
                            }
                        }
                        let offline = command == "item.newOfflineFile";
                        let adjustment = command == "item.newAdjustmentLayer";
                        let mut fields = Vec::new();
                        if !offline || mask & 4 == 0 {
                            fields.push("sequence.settings.settings.frame_rate");
                        }
                        if !offline || video {
                            if adjustment || mask & 1 == 0 {
                                fields.push("sequence.settings.settings.width");
                            }
                            if adjustment || mask & 2 == 0 {
                                fields.push("sequence.settings.settings.height");
                            }
                        }
                        let expected = Under {
                            premises: if active { vec![Premise::on(sequence.clone()).fields(fields).positions(Vec::<String>::new())] } else { vec![] },
                            ..Default::default()
                        };
                        let held = doc.under(command, &params).unwrap().unwrap_or_default();
                        assert_eq!(held, expected, "{command}/{active}/{mask}/{floating}/{video}: {params}");
                    }
                }
            }
        }
    }
}
