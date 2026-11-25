//! Full resolver/assignment comparisons for video-option and rename paths.
//! The expected operands follow commands.rs::clips_p/clip.rename and
//! clip_ops.rs::video_clips,field_options,set_interpolation. No declaration
//! helper is used to compute expected recipients or physical field paths.
use std::collections::BTreeSet;

use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const VIDEO: &[&str] = &[
    "clip.fieldOptions",
    "clip.setTimeInterpolation",
    "clip.timeInterpolation.frameSampling",
    "clip.timeInterpolation.frameBlending",
    "clip.timeInterpolation.opticalFlow",
];
pub const PATHS: &[(&str, &str)] = &[
    ("clip.fieldOptions", "video targets"),
    ("clip.setTimeInterpolation", "video targets"),
    ("clip.timeInterpolation.frameSampling", "video targets"),
    ("clip.timeInterpolation.frameBlending", "video targets"),
    ("clip.timeInterpolation.opticalFlow", "video targets"),
    ("clip.rename", "item"),
    ("clip.rename", "clip"),
    ("clip.link", "toggle"),
    ("clip.group", "group"),
    ("clip.ungroup", "group"),
    ("clip.scaleToFrameSize", "toggle"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    if !PATHS.contains(&(command, path)) {
        return false;
    }
    let commands = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/commands.rs"));
    let clips = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/clip_ops.rs"));
    let matches = super::patches_compare::matches_source;
    matches(commands, "pub fn clips_p(", "/// The track parameter", 0x4f56b07f02b0df58)
        && if matches!(command, "clip.link" | "clip.group" | "clip.ungroup" | "clip.scaleToFrameSize") {
            matches(commands, "        cmd!(\"clip.link\",", "            \"clip.audioGain\",", 0x3275f6862cc92cc0)
        } else if command == "clip.rename" {
            matches(commands, "        cmd!(\"clip.rename\",", "            \"clip.speedDuration\",", 0xae9623bfd2bd6147)
        } else {
            matches(clips, "fn video_clips(", "fn frame_hold_options(", 0x4501b301931c339a)
                && matches(clips, "fn field_options(", "/// Fit to frame", 0xe8bdbc2490956949)
        }
}

fn scalar(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().map(|number| number as u64))
}

fn clips(params: &Value, selected: &[u64]) -> Vec<u64> {
    if let Some(ids) = params.get("clips").and_then(Value::as_array) {
        ids.iter().filter_map(Value::as_u64).collect()
    } else {
        params.get("clip").and_then(scalar).map(|id| vec![id]).unwrap_or_else(|| selected.to_vec())
    }
}

fn fixture() -> (FilmDocument, u64, u64, u64) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let item = doc.execute("item.newBarsAndTone", json!({"seconds":1})).unwrap()["item"].as_u64().unwrap();
    let placed = doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":0})).unwrap();
    (doc, item, placed["clips"][0].as_u64().unwrap(), placed["clips"][1].as_u64().unwrap())
}

#[test]
fn video_option_paths_compare_all_selector_precedence_and_track_kinds() {
    let (mut doc, _, video, audio) = fixture();
    let mut more = BTreeSet::new();
    let mut more_selection = BTreeSet::new();
    for selected in [vec![], vec![audio], vec![video, audio]] {
        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
        for &command in VIDEO {
            assert!(compared_path(command, "video targets"), "source review expired: {command}");
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            let conditional = command == "clip.setTimeInterpolation";
            assert_eq!(spec.reads, if conditional { vec![EditorState::Part] } else { vec![EditorState::Part, EditorState::Selection] });
            assert_eq!(spec.targets, Some("clips"));
            assert!(spec.mutates);
            assert_eq!(spec.enabled, !selected.is_empty());
            if command != "clip.fieldOptions" {
                assert_eq!(spec.objects, ["clip"]);
                assert_eq!(spec.object_types, [("clips", &["Clip"][..]), ("clip", &["Clip"][..])]);
            } else {
                assert!(spec.objects.is_empty());
                assert_eq!(spec.object_types, [("clips", &["Clip"][..])]);
            }
            assert!(spec.places.is_empty() && spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none());
            assert!(!spec.index_numbers && !spec.index_reversed);
            for many in [None, Some(Value::Null), Some(json!([])), Some(json!([audio])), Some(json!([video, audio, video])), Some(json!([video as f64]))] {
                for one in [None, Some(Value::Null), Some(json!(video)), Some(json!(audio)), Some(json!(video as f64))] {
                    let mut params = json!({"mode":"opticalFlow","processing":"flickerRemoval"});
                    if let Some(many) = &many {
                        params["clips"] = many.clone();
                    }
                    if let Some(one) = &one {
                        params["clip"] = one.clone();
                    }
                    let operands: BTreeSet<_> = clips(&params, &selected).into_iter().collect();
                    let leaf = if command == "clip.fieldOptions" { "props.field_options" } else { "props.time_interpolation" };
                    let mut expected = Under {
                        premises: operands
                            .iter()
                            .map(|id| Premise::on(json!(id)).fields(if *id == video { vec![leaf] } else { vec![] }).positions(["clips"]))
                            .collect(),
                        ..Default::default()
                    };
                    let implicit = params.get("clips").and_then(Value::as_array).is_none() && params.get("clip").and_then(scalar).is_none();
                    if conditional && implicit {
                        expected.premises.push(Premise::on(json!("project")).fields(["~interpolationSelection"]).positions(Vec::<String>::new()));
                    }
                    let mut held = doc.under(command, &params).unwrap().unwrap();
                    expected.premises.sort_by_key(|need| need.id.to_string());
                    held.premises.sort_by_key(|need| need.id.to_string());
                    assert_eq!(held, expected, "{command}/{params}/{selected:?}");
                    if !operands.is_empty() {
                        // Video-kind eligibility is required; the current clips
                        // position also freezes index and same-kind lane moves.
                        more.insert(command);
                    }
                    if !conditional && !implicit {
                        more_selection.insert(command);
                    }
                }
            }
        }
    }
    assert!(more.len() <= 5 && more_selection.len() <= 4);
    println!(
        "COMPARED_VIDEO_PATHS differing={} less=0 more={} classes=clip-owner-position:{},unconsumed-selection:{}",
        more.len(),
        more.len(),
        more.len(),
        more_selection.len()
    );
}

#[test]
fn rename_paths_compare_item_precedence_and_first_selection() {
    let (mut doc, item, video, audio) = fixture();
    for selected in [vec![], vec![video, audio], vec![audio, video]] {
        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
        for item_form in [None, Some(Value::Null), Some(json!(item)), Some(json!(item as f64))] {
            for clip_form in [None, Some(Value::Null), Some(json!(video)), Some(json!(audio)), Some(json!(audio as f64))] {
                let mut params = json!({"name":"Assigned"});
                if let Some(value) = &item_form {
                    params["item"] = value.clone();
                }
                if let Some(value) = &clip_form {
                    params["clip"] = value.clone();
                }
                let item = params.get("item").and_then(scalar);
                let clip = params.get("clip").and_then(scalar);
                let path = if item.is_some() { "item" } else { "clip" };
                assert!(compared_path("clip.rename", path));
                let target = item.map(|id| (id, "name")).or_else(|| clip.or_else(|| selected.first().copied()).map(|id| (id, "props.name")));
                let mut expected = Under {
                    premises: target.into_iter().map(|(id, field)| Premise::on(json!(id)).fields([field]).positions(Vec::<String>::new())).collect(),
                    ..Default::default()
                };
                if item.is_none() && clip.is_none() {
                    expected.premises.push(Premise::on(json!("project")).fields(["~renameSelection"]).positions(Vec::<String>::new()));
                }
                let mut held = doc.under("clip.rename", &params).unwrap().unwrap();
                expected.premises.sort_by_key(|need| need.id.to_string());
                held.premises.sort_by_key(|need| need.id.to_string());
                assert_eq!(held, expected, "{params}/{selected:?}");
            }
        }
    }
    let spec = doc.commands().into_iter().find(|spec| spec.id == "clip.rename").unwrap();
    assert_eq!(spec.reads, [EditorState::Part]);
    assert_eq!(spec.targets, Some("clip"));
    assert!(spec.enabled && spec.mutates);
    assert_eq!(spec.objects, ["item"]);
    assert_eq!(spec.object_types, [("clip", &["Clip"][..]), ("item", &["Item"][..])]);
    assert!(spec.places.is_empty() && spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none());
    assert!(!spec.index_numbers && !spec.index_reversed);
    println!("COMPARED_RENAME_PATHS differing=1 less=0 more=1 classes=item-only-part:1");
}

#[test]
fn core_field_paths_compare_selection_and_explicit_link_operands() {
    let (mut doc, _, video, audio) = fixture();
    for selected in [vec![], vec![video], vec![audio], vec![audio, video]] {
        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
        for (command, path, field) in [
            ("clip.link", "toggle", "link"),
            ("clip.group", "group", "group"),
            ("clip.ungroup", "group", "group"),
            ("clip.scaleToFrameSize", "toggle", "props.scale_to_frame"),
        ] {
            assert!(compared_path(command, path));
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            assert_eq!(spec.reads, [EditorState::Part, EditorState::Selection]);
            assert!(spec.mutates);
            assert_eq!(spec.enabled, !selected.is_empty());
            assert_eq!(spec.targets, if command == "clip.link" { Some("clips") } else { None });
            assert_eq!(spec.objects, if command == "clip.link" { vec!["clip"] } else { vec![] });
            assert!(spec.places.is_empty() && spec.name_params.is_empty());
            assert!(spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
            assert_eq!(spec.object_types, if command == "clip.link" { vec![("clips", &["Clip"][..]), ("clip", &["Clip"][..])] } else { vec![] });
            for params in [json!({}), json!({"clips":null}), json!({"clips":[]}), json!({"clips":[audio,video,audio]}), json!({"clip":video})] {
                let operands: BTreeSet<_> = if command == "clip.link" { clips(&params, &selected) } else { selected.clone() }.into_iter().collect();
                let mut expected = Under {
                    premises: operands.into_iter().map(|id| Premise::on(json!(id)).fields([field]).positions(Vec::<String>::new())).collect(),
                    ..Default::default()
                };
                let mut held = doc.under(command, &params).unwrap().unwrap();
                held.premises.sort_by_key(|need| need.id.to_string());
                expected.premises.sort_by_key(|need| need.id.to_string());
                assert_eq!(held, expected, "{command}/{params}/{selected:?}");
            }
        }
    }
    println!("COMPARED_CORE_FIELD_PATHS differing=4 less=0 more=4 classes=coarse-selection-state:4,unconsumed-selection:1");
}
