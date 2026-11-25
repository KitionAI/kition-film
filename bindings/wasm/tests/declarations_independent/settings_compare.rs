//! commands.rs::sequence.settings and edit/frame_size.rs::scale_motion.
//! The preset label copies the complete old size/rate; working_space is always
//! assigned from Color. Motion scaling only visits first Motion instances.
use super::sync_compare::normalized;
use kition_film_engine::project::ItemId;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] =
    &[("sequence.settings", "partial"), ("sequence.settings", "scale-motion"), ("sequence.colorSettings", "assigned color members")];

pub fn compared_path(command: &str, path: &str) -> bool {
    if command == "sequence.colorSettings" {
        return PATHS.contains(&(command, path))
            && include_str!("../../../../crates/engine/engine/src/color.rs")
                .bytes()
                .fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3))
                == 0x338493baffff87a7;
    }
    PATHS.contains(&(command, path))
        && super::patches_compare::matches_source(
            include_str!("../../../../crates/engine/engine/src/commands.rs"),
            "            \"sequence.settings\",",
            "        cmd!(\"sequence.renderEffectsInToOut\"",
            0xf0181ab0b3f4bffc,
        )
}

pub fn more(command: &str) -> Vec<&'static str> {
    if command == "sequence.colorSettings" { vec!["conditional-color-normalization"] } else { vec![] }
}

#[test]
fn sequence_settings_compare_every_patch_subset_resize_branch_and_motion_inputs() {
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("item.newColorMatte", json!({"seconds":2})).unwrap()["item"].clone();
    for n in 0..2 {
        let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":n*2})).unwrap()["clips"][0].clone();
        if n == 0 {
            doc.execute("timeline.select", json!({"clips":[clip]})).unwrap();
            doc.execute("clip.scaleToFrameSize", json!({})).unwrap();
        }
        doc.execute("effect.addKeyframe", json!({"clip":clip,"effect":"motion","param":"position","time":0})).unwrap();
    }
    let spec = doc.commands().into_iter().find(|spec| spec.id == "sequence.settings").unwrap();
    assert!(spec.mutates && spec.enabled);
    assert_eq!(spec.reads, [EditorState::Part]);
    assert!(spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty());
    assert!(spec.name_field.is_none() && spec.name_params.is_empty() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
    let keys = [
        ("width", "width", json!(640)),
        ("height", "height", json!(360)),
        ("fps", "frame_rate", json!(29.97)),
        ("sampleRate", "sample_rate", json!(44100)),
        ("mix", "audio_master", json!("Mono")),
        ("dropFrame", "drop_frame", json!(true)),
        ("maxRenderQuality", "max_render_quality", json!(true)),
        ("workingSpace", "color.working", json!("rec2100-pq")),
        ("wideGamut", "color.wide_gamut", json!(true)),
        ("autoToneMap", "color.auto_tone_map", json!(false)),
        ("name", "name", json!("Assigned")),
    ];
    for (command, path) in &PATHS[..2] {
        assert!(compared_path(command, path));
        for same_size in [false, true] {
            for subset in 0..(1usize << keys.len()) {
                let scale = *path == "scale-motion";
                let mut params = json!({"scaleMotion":scale});
                let mut fields = vec!["sequence.settings.settings.working_space".to_owned(), "sequence.settings.settings.color.working".to_owned()];
                for (index, (param, field, value)) in keys.iter().enumerate() {
                    if subset & (1 << index) == 0 {
                        continue;
                    }
                    params[*param] = if same_size && *param == "width" {
                        json!(320)
                    } else if same_size && *param == "height" {
                        json!(180)
                    } else {
                        value.clone()
                    };
                    fields.push(if *field == "name" { "name".into() } else { format!("sequence.settings.settings.{field}") });
                }
                let resizing = !same_size && (params.get("width").is_some() || params.get("height").is_some());
                if resizing || params.get("fps").is_some() {
                    fields.extend(["width", "height", "frame_rate", "preset"].map(|field| format!("sequence.settings.settings.{field}")));
                }
                if params.get("dropFrame").is_some() && params.get("fps").is_none() {
                    fields.push("sequence.settings.settings.frame_rate".into());
                }
                if resizing && scale {
                    fields.push("~motionScale".into());
                }
                let expected = Under { premises: vec![Premise::on(json!(sequence)).fields(fields).positions(Vec::<String>::new())], ..Default::default() };
                assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap()), normalized(expected), "{path}/{params}");
            }
        }
    }
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let q = project.sequence(ItemId(sequence)).unwrap();
    let mut expected = serde_json::Map::new();
    for clip in q.video_tracks.iter().flat_map(|track| &track.items) {
        let effect = clip.effect("motion").unwrap();
        let mut values = json!({"refits":clip.scale_to_frame,"position":effect.param("position")});
        if !clip.scale_to_frame {
            values["scale"] = json!(effect.param("scale"));
            values["scale_width"] = json!(effect.param("scale_width"));
        }
        expected.insert(format!("c{}", clip.id.0), values);
    }
    let held = doc.derived(&[json!(sequence)], &["motionScale".into()]).unwrap();
    assert_eq!(held.iter().find(|value| value.id == sequence).unwrap().values["motionScale"], Value::Object(expected));
}

#[test]
fn color_settings_compare_patch_subsets_native_types_and_label_normalization() {
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let command = "sequence.colorSettings";
    assert!(compared_path(command, "assigned color members"));
    let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
    assert!(spec.mutates && spec.enabled);
    assert_eq!(spec.reads, [EditorState::Part]);
    assert!(spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty());
    assert!(spec.name_field.is_none() && spec.name_params.is_empty() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
    for working in [None, Some(Value::Null), Some(json!("rec709")), Some(json!("rec2100-pq"))] {
        for wide in [None, Some(Value::Null), Some(json!(false)), Some(json!(true))] {
            for tone in [None, Some(Value::Null), Some(json!(false)), Some(json!(true))] {
                let mut params = json!({});
                let mut fields = vec!["sequence.settings.settings.working_space", "sequence.settings.settings.color.working"];
                for (key, value, field) in [
                    ("workingSpace", &working, "sequence.settings.settings.color.working"),
                    ("wideGamut", &wide, "sequence.settings.settings.color.wide_gamut"),
                    ("autoToneMap", &tone, "sequence.settings.settings.color.auto_tone_map"),
                ] {
                    if let Some(value) = value {
                        params[key] = value.clone();
                        if value.is_boolean() {
                            fields.push(field);
                        }
                    }
                }
                let expected = Under { premises: vec![Premise::on(json!(sequence)).fields(fields).positions(Vec::<String>::new())], ..Default::default() };
                assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap()), normalized(expected), "{params}");
            }
        }
    }
}
