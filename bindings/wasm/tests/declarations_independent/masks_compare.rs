//! masks.rs::target_clip, effect_index, edit_mask, add and remove. The
//! conversion and inverse check run even for metadata-only edits and topology.
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

use super::sync_compare::normalized;

pub const PATHS: &[(&str, &str)] = &[
    ("mask.add", "clip/effect/default path"),
    ("mask.remove", "index/default mask"),
    ("mask.set", "metadata or parameter/path"),
    ("mask.moveVertex", "path at time"),
    ("mask.translate", "path at time"),
    ("mask.toggleVertexSmooth", "path at time"),
    ("mask.addVertex", "topology all keys"),
    ("mask.removeVertex", "topology all keys"),
    ("mask.track", "job/synchronous"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
        && super::patches_compare::matches_source(
            include_str!("../../../../crates/engine/engine/src/masks.rs"),
            "fn target_clip(",
            "// ---------------------------------------------------------------- tracking",
            0xc1bdb017a55385dc,
        )
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut more = vec!["whole-effect-profile", "coarse-selection-state", "coarse-active-state", "unused-mask-editor-inputs"];
    if command == "mask.track" {
        more.extend(["whole-clip-default", "coarse-source-profile"]);
    }
    more
}

fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}

#[test]
fn mask_paths_compare_target_effect_mask_defaults_geometry_and_animation() {
    for animated in [false, true] {
        for mapping in ["resolved", "fitted", "disabled", "missing-position"] {
            let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
            let mut clips = Vec::new();
            let mut items = Vec::new();
            for n in 0..2 {
                let item = doc.execute("item.newColorMatte", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
                let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":n*2})).unwrap()["clips"][0].as_u64().unwrap();
                doc.execute("mask.add", json!({"clip":clip,"shape":"rectangle"})).unwrap();
                if animated {
                    doc.execute("effect.addKeyframe", json!({"clip":clip,"effect":"opacity","mask":0,"param":"path","time":0})).unwrap();
                }
                if mapping == "fitted" {
                    doc.execute("timeline.select", json!({"clips":[clip]})).unwrap();
                    doc.execute("clip.scaleToFrameSize", json!({})).unwrap();
                }
                if mapping == "disabled" {
                    doc.execute("effect.toggleEnabled", json!({"clip":clip,"index":0})).unwrap();
                }
                clips.push(clip);
                items.push(item);
            }
            if mapping == "missing-position" {
                let mut loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
                for item in loaded.project.items.values_mut() {
                    if let Some(sequence) = item.as_sequence_mut() {
                        for clip in sequence.video_tracks.iter_mut().flat_map(|track| &mut track.items) {
                            clip.effect_mut("motion").unwrap().params.remove("position");
                        }
                    }
                }
                doc = FilmDocument::open("Edit.kfilm", &kition_film_format::encode(&loaded.project, true)).unwrap();
            }
            let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
            let owner = doc.inspect().unwrap()["sequence"]["video"][0]["id"].as_u64().unwrap();
            for selected_mask in [false, true] {
                doc.execute("timeline.select", json!({"clips":[clips[1]],"linked":false})).unwrap();
                doc.execute("mask.select", if selected_mask { json!({"clip":clips[0],"effect":"opacity","mask":0}) } else { json!({"none":true}) }).unwrap();
                for &(command, path) in PATHS {
                    assert!(compared_path(command, path), "source review expired: {command}");
                    let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                    assert_eq!(
                        spec.reads,
                        if command == "mask.remove" {
                            vec![EditorState::Part, EditorState::Selection, EditorState::Active]
                        } else {
                            vec![EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Active]
                        }
                    );
                    assert!(spec.mutates && spec.enabled && spec.places.is_empty() && spec.objects.is_empty());
                    assert_eq!(spec.targets, Some("clip"));
                    assert_eq!(spec.object_types, [("clip", &["Clip"][..])]);
                    assert!(spec.name_field.is_none() && spec.name_params.is_empty() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                    for explicit in [false, true] {
                        let index = if explicit || selected_mask { 0 } else { 1 };
                        let clip = clips[index];
                        for effect in [Value::Null, json!(1), json!("opacity"), json!("missing")] {
                            for mask in [Value::Null, json!(0), json!(999)] {
                                for value in [json!({}), json!({"name":"Assigned"}), json!({"feather":5,"time":1}), json!({"path":[[10,10],[50,10],[50,50]]})] {
                                    let mut params = json!({"effect":effect,"mask":mask,"vertex":0,"after":1,"at":[30,30],"delta":[1,1],"to":[20,20]});
                                    params.as_object_mut().unwrap().extend(value.as_object().unwrap().clone());
                                    if explicit {
                                        params["clip"] = json!(clip);
                                    }
                                    let mut expected = Under::default();
                                    if command == "mask.track" {
                                        expected.premises.push(Premise::on(json!(clip)));
                                        expected.premises.push(leaf(owner, &["props.locked"]));
                                        expected.premises.push(leaf(sequence, &["sequence.settings.settings.frame_rate"]));
                                        expected.premises.push(leaf(
                                            items[index],
                                            &[
                                                "kind",
                                                "props.media",
                                                "props.parent",
                                                "props.range",
                                                "props.restrict_trims",
                                                "props.width",
                                                "props.height",
                                                "props.rate",
                                                "sequence",
                                            ],
                                        ));
                                    } else if command == "mask.remove" {
                                        expected.premises.push(leaf(clip, &["effects"]));
                                    } else {
                                        expected.premises.push(
                                            Premise::on(json!(clip))
                                                .fields(["effects", "item", "sourceIn", "speed", "reverse", "props.frame_hold", "props.scale_to_frame"])
                                                .positions(["start", "duration"]),
                                        );
                                        expected.premises.push(leaf(items[index], &["props.media.info.video.width", "props.media.info.video.height"]));
                                        if mapping != "resolved" {
                                            expected.premises.push(leaf(sequence, &["sequence.settings.settings.width", "sequence.settings.settings.height"]));
                                        }
                                    }
                                    assert_eq!(
                                        normalized(doc.under(command, &params).unwrap().unwrap()),
                                        normalized(expected),
                                        "{command}/{params}/{mapping}/selected-mask={selected_mask}/animated={animated}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
