//! color.rs::{color_clip,set_lut,set_section,apply_preset,remove}.
//! Targets are video-only; a preferred existing Color effect precedes the
//! first selected video. Library entries are resolved before editing clips.
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

use super::sync_compare::normalized;

pub const PATHS: &[(&str, &str)] = &[
    ("color.applyPreset", "video targets"),
    ("color.setInputLut", "explicit LUT"),
    ("color.setLook", "explicit LUT"),
    ("color.setSection", "toggle/absolute"),
    ("lut.remove", "entry by library id"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
        && include_str!("../../../../crates/engine/engine/src/color.rs")
            .bytes()
            .fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3))
            == 0x338493baffff87a7
}

pub fn more(command: &str) -> Vec<&'static str> {
    if command == "lut.remove" {
        vec!["literal-lut-library-fallback"]
    } else {
        vec!["whole-effect-profile", "coarse-selection-state", "clip-owner-position", "literal-lut-library-fallback"]
    }
}

fn leaf(id: Value, fields: &[&str]) -> Premise {
    Premise::on(id).fields(fields.iter().copied()).positions(Vec::<String>::new())
}

#[test]
fn color_paths_compare_video_eligibility_preferred_effects_library_refs_and_all_addresses() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let item = doc.execute("file.newOfflineFile", json!({"seconds":1})).unwrap()["item"].clone();
    let clips = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"].as_array().unwrap().clone();
    let first = clips[0].as_u64().unwrap();
    let audio = clips[1].as_u64().unwrap();
    let second = doc.execute("timeline.place", json!({"item":item,"track":"V2","time":0,"audio":false})).unwrap()["clips"][0].as_u64().unwrap();
    doc.execute("effects.apply", json!({"clips":[second],"effect":"color"})).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"].clone();
    let preset = doc.execute("color.presets", json!({})).unwrap()["presets"][0]["name"].clone();
    let owner = |id| if id == first { sequence["video"][0]["id"].clone() } else { sequence["video"][1]["id"].clone() };
    for selected in [vec![], vec![audio], vec![first], vec![audio, first, second], vec![second, first]] {
        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
        for &(command, path) in PATHS {
            assert!(compared_path(command, path), "review expired: {command}");
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            let remove = command == "lut.remove";
            let many = command == "color.applyPreset";
            assert!(spec.mutates && spec.enabled && spec.objects.is_empty() && spec.places.is_empty());
            assert_eq!(spec.reads, if remove { vec![] } else { vec![EditorState::Part, EditorState::Selection] });
            assert_eq!(spec.targets, if remove { None } else { Some(if many { "clips" } else { "clip" }) });
            assert_eq!(spec.object_types, if remove { vec![] } else { vec![(if many { "clips" } else { "clip" }, &["Clip"][..])] });
            assert!(spec.name_field.is_none() && spec.name_params.is_empty() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
            for explicit in [false, true] {
                for reference in ["", "builtin:rec709", "lib:mine", " lib:mine ", "lib:review.v1", "lib:review[1]", "lib:review/mix~1"] {
                    for on in [Value::Null, json!(true), json!(false)] {
                        let mut params = if remove {
                            json!({"id":reference})
                        } else if many {
                            json!({"name":preset})
                        } else if command == "color.setSection" {
                            json!({"section":"basic","on":on})
                        } else {
                            json!({"lut":reference})
                        };
                        if explicit && !remove {
                            params[if many { "clips" } else { "clip" }] = if many { json!([first, audio, second]) } else { json!(first) };
                        }
                        let mut expected = Under::default();
                        let library = if remove {
                            Some(reference.trim_start_matches("lib:"))
                        } else if command == "color.setSection" || many {
                            None
                        } else {
                            reference.trim().strip_prefix("lib:")
                        };
                        if let Some(id) = library {
                            let field = if !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                                format!("docState.luts[id={id}]")
                            } else {
                                "docState.luts".into()
                            };
                            expected.premises.push(Premise::on(json!("project")).fields([field]).positions(Vec::<String>::new()));
                        }
                        if !remove {
                            let video: Vec<_> =
                                if many && explicit { vec![first, second] } else { selected.iter().copied().filter(|id| *id != audio).collect() };
                            let target = if explicit { Some(first) } else { video.iter().copied().find(|id| *id == second).or_else(|| video.first().copied()) };
                            let targets = if many { video.clone() } else { target.into_iter().collect() };
                            for id in targets {
                                expected.premises.push(Premise::on(json!(id)).fields(["effects"]).positions(["clips"]));
                                expected.premises.push(leaf(owner(id), &["props.kind"]));
                            }
                            if !many && !explicit {
                                for id in &video {
                                    expected.premises.push(Premise::on(json!(id)).fields(["effects"]).positions(["clips"]));
                                }
                            }
                        }
                        assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap()), normalized(expected), "{command}/{params}/{selected:?}");
                    }
                }
            }
        }
    }
}
