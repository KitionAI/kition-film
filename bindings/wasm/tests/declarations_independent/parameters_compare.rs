//! Effect operands from commands.rs:2669-2899,3108-3213 and masks.rs:179-210.
//! Whole effect/clip profiles retain unrelated values; the projection is exact
//! about when timebase, source geometry, and automatic defaults are consumed.
//! Re-read after effects.setParam's named `merge` (451e643e) and effects.moveKeyframe's
//! `value`, `merge` and `begin`: a merge key and `begin` only join or start undo steps
//! (history, not the document), and a moved keyframe's new value is written into the
//! clip's effects the move already holds, so no declaration changes with them.
use kition_film_engine::project::{EffectKind, ItemId, ItemKind, ParamValue, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

use super::sync_compare::normalized;

pub const PATHS: &[(&str, &str)] = &[
    ("effects.apply", "standard"),
    ("effects.remove", "effect-index"),
    ("effects.toggleEnabled", "effect-index"),
    ("effects.reset", "effect-index"),
    ("effects.setParam", "parameter"),
    ("effects.setParam", "mask-path"),
    ("effects.toggleAnimation", "animated"),
    ("effects.addKeyframe", "animated"),
    ("effects.deleteKeyframe", "media-key"),
    ("effects.moveKeyframe", "media-key"),
    ("effects.setInterpolation", "media-key"),
    ("effects.setKeyframe", "media-key"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
        && include_str!("../../../../crates/engine/engine/src/commands.rs")
            .bytes()
            .fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3))
            == 0x36d3e3e1d0ffadcf
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut classes = vec!["whole-effect-profile"];
    if command == "effects.apply" {
        classes.extend(["coarse-selection-state", "unused-transition-editor-inputs", "clip-owner-position"]);
    } else if !matches!(command, "effects.setParam" | "effects.toggleEnabled") {
        classes.push("whole-clip-default");
    }
    if matches!(command, "effects.deleteKeyframe" | "effects.moveKeyframe" | "effects.setInterpolation" | "effects.setKeyframe") {
        classes.push("unused-explicit-media-time-playhead");
    }
    classes
}

fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}

fn size(sequence: u64) -> Premise {
    leaf(sequence, &["sequence.settings.settings.width", "sequence.settings.settings.height"])
}

fn timebase(sequence: u64, command: &str, params: &Value, answer: &mut Under) {
    let used = matches!(command, "effects.setParam" | "effects.toggleAnimation" | "effects.addKeyframe")
        || (command == "effects.setInterpolation" && params.get("mediaTime").and_then(Value::as_i64).is_none());
    if !used || params.get("time").and_then(Value::as_i64).is_some() {
        return;
    }
    let frames = params.get("frame").and_then(Value::as_i64).is_some();
    let tc = !frames && params.get("seconds").and_then(Value::as_f64).is_none() && params.get("timecode").and_then(Value::as_str).is_some();
    if frames || tc {
        let mut fields = vec!["sequence.settings.settings.frame_rate"];
        if tc {
            fields.push("sequence.settings.settings.drop_frame");
        }
        answer.premises.push(leaf(sequence, &fields));
    }
}

fn source_size(project: &Project, mut source: ItemId, answer: &mut Under) {
    let mut seen = std::collections::BTreeSet::new();
    while seen.insert(source) {
        match &project.item(source).unwrap().kind {
            ItemKind::Subclip { parent, .. } => {
                answer.premises.push(leaf(source.0, &["props.parent"]));
                source = *parent;
            }
            kind => {
                answer.premises.push(leaf(
                    source.0,
                    match kind {
                        ItemKind::Media(_) => &["props.media.info.video.width", "props.media.info.video.height"],
                        ItemKind::Sequence(_) => &["sequence.settings.settings.width", "sequence.settings.settings.height"],
                        _ => &["props.width", "props.height"],
                    },
                ));
                break;
            }
        }
    }
}

#[test]
fn mask_parameter_mapping_compares_source_kinds_and_motion_fallbacks() {
    for kind in ["media", "subclip", "adjustment", "graphic", "sequence"] {
        for fitting in [false, true] {
            for motion in ["resolved", "disabled", "missing-position"] {
                let (mut doc, sequence, media, clips) = fixture();
                let clip = clips[0];
                doc.execute("masks.add", json!({"clip":clip,"shape":"rectangle"})).unwrap();
                let source = match kind {
                    "subclip" => doc.execute("clip.makeSubclip", json!({"item":media,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap(),
                    "adjustment" => doc.execute("file.newAdjustmentLayer", json!({})).unwrap()["item"].as_u64().unwrap(),
                    "graphic" => {
                        let graphic = doc.execute("graphics.newText", json!({"newClip":true,"track":1,"text":"Source"})).unwrap()["clip"].as_u64().unwrap();
                        kition_film_format::decode(&doc.save(None).unwrap())
                            .unwrap()
                            .project
                            .sequence(ItemId(sequence))
                            .unwrap()
                            .find_item(kition_film_engine::project::ClipId(graphic))
                            .unwrap()
                            .1
                            .item
                            .0
                    }
                    "sequence" => {
                        let nested = doc.execute("file.newSequence", json!({"name":"Source","width":640,"height":360})).unwrap()["sequence"].as_u64().unwrap();
                        doc.execute("sequence.open", json!({"item":sequence})).unwrap();
                        nested
                    }
                    _ => media,
                };
                let mut loaded = kition_film_format::decode(&doc.save(None).unwrap()).unwrap();
                let (_, found) = loaded.project.sequence_mut(ItemId(sequence)).unwrap().find_item_mut(kition_film_engine::project::ClipId(clip)).unwrap();
                found.item = ItemId(source);
                found.scale_to_frame = fitting;
                let effect = found.effect_mut("motion").unwrap();
                if motion == "disabled" {
                    effect.enabled = false;
                }
                if motion == "missing-position" {
                    effect.params.remove("position");
                }
                let mut expected = Under::default();
                expected.premises.push(
                    Premise::on(json!(clip))
                        .fields(["effects", "item", "sourceIn", "speed", "reverse", "props.frame_hold", "props.scale_to_frame"])
                        .positions(["start", "duration"]),
                );
                source_size(&loaded.project, ItemId(source), &mut expected);
                if fitting || motion != "resolved" {
                    expected.premises.push(size(sequence));
                }
                let doc = FilmDocument::open("Edit.kfilm", &kition_film_format::encode(&loaded.project, true)).unwrap();
                let params = json!({"clip":clip,"effect":"opacity","param":"path","mask":0});
                assert_eq!(normalized(doc.under("effects.setParam", &params).unwrap().unwrap()), normalized(expected), "{kind}/{fitting}/{motion}");
            }
        }
    }
}

fn fixture() -> (FilmDocument, u64, u64, Vec<u64>) {
    let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
    doc.execute("sequence.linkedSelection", json!({"on":false})).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let media = doc.execute("file.newOfflineFile", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let clips = doc.execute("timeline.place", json!({"item":media,"time":0,"track":"V1","audioTrack":"A1"})).unwrap()["clips"]
        .as_array()
        .unwrap()
        .iter()
        .map(|clip| clip.as_u64().unwrap())
        .collect();
    (doc, sequence, media, clips)
}

fn contract(doc: &FilmDocument, command: &str) {
    let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
    let read_time = matches!(
        command,
        "effects.setParam"
            | "effects.toggleAnimation"
            | "effects.addKeyframe"
            | "effects.deleteKeyframe"
            | "effects.moveKeyframe"
            | "effects.setInterpolation"
            | "effects.setKeyframe"
    );
    assert_eq!(
        spec.reads,
        if command == "effects.apply" {
            vec![EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Active, EditorState::Mode]
        } else if read_time {
            vec![EditorState::Part, EditorState::Time]
        } else {
            vec![EditorState::Part]
        }
    );
    assert!(spec.mutates && spec.enabled && spec.objects.is_empty() && spec.places.is_empty(), "{command}");
    let target = if command == "effects.apply" { "clips" } else { "clip" };
    assert_eq!(spec.targets, Some(target));
    assert_eq!(spec.object_types, [(target, &["Clip"][..])]);
    assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
}

#[test]
fn standard_effect_path_compares_all_definitions_kind_eligibility_and_automatic_points() {
    let (mut doc, sequence, _, clips) = fixture();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let q = project.sequence(ItemId(sequence)).unwrap();
    contract(&doc, "effects.apply");
    assert!(compared_path("effects.apply", "standard"));
    for selected in [vec![], vec![clips[0]], vec![clips[1]], clips.clone()] {
        doc.execute("timeline.select", json!({"clips":selected})).unwrap();
        for def in kition_film_engine::project::effect_defs().iter().filter(|def| matches!(def.kind, EffectKind::Audio | EffectKind::Video)) {
            for explicit in 0..3 {
                for spelling in [def.id.to_owned(), def.name.to_owned(), def.name.to_ascii_uppercase()] {
                    let targets = if explicit == 1 { vec![clips[0]] } else { selected.clone() };
                    let definitions = kition_film_engine::project::effect_defs();
                    let named: Vec<_> = definitions.iter().filter(|candidate| candidate.name.eq_ignore_ascii_case(&spelling)).collect();
                    let audio_only = !targets.is_empty() && targets.iter().all(|id| *id == clips[1]);
                    let chosen = definitions
                        .iter()
                        .find(|candidate| candidate.id == spelling)
                        .or_else(|| {
                            if named.len() <= 1 {
                                named.first().copied()
                            } else {
                                named
                                    .iter()
                                    .copied()
                                    .find(|candidate| !candidate.intrinsic && (candidate.kind == EffectKind::Audio) == audio_only)
                                    .or_else(|| named.iter().copied().find(|candidate| !candidate.intrinsic))
                                    .or_else(|| named.first().copied())
                            }
                        })
                        .unwrap();
                    let mut params = json!({"effect":spelling});
                    if explicit == 1 {
                        params["clip"] = json!(clips[0]);
                    }
                    if explicit == 2 {
                        params["clips"] = json!(selected);
                    }
                    let mut expected = Under::default();
                    if chosen.instance().params.values().any(|param| matches!(&param.value, ParamValue::Vec2(value) if value.x.is_nan() || value.y.is_nan())) {
                        expected.premises.push(size(sequence));
                    }
                    for target in targets {
                        let (track, _) =
                            q.all_tracks().find_map(|track| track.items.iter().find(|clip| clip.id.0 == target).map(|clip| (track, clip))).unwrap();
                        let eligible = (track.kind == kition_film_engine::project::TrackKind::Audio) == (chosen.kind == EffectKind::Audio);
                        expected.premises.push(Premise::on(json!(target)).fields(if eligible { vec!["effects"] } else { vec![] }).positions(["clips"]));
                        expected.premises.push(leaf(track.id.0, &["props.kind"]));
                    }
                    assert_eq!(normalized(doc.under("effects.apply", &params).unwrap().unwrap_or_default()), normalized(expected), "{params}/{selected:?}");
                }
            }
        }
    }
}

#[test]
fn effect_value_paths_compare_index_defaults_animation_mask_and_time_precedence() {
    for animated in [false, true] {
        for fitting in [false, true] {
            let (mut doc, sequence, media, clips) = fixture();
            let clip = clips[0];
            doc.execute("masks.add", json!({"clip":clip,"shape":"rectangle"})).unwrap();
            if fitting {
                doc.execute("timeline.select", json!({"clips":[clip]})).unwrap();
                doc.execute("clip.scaleToFrameSize", json!({})).unwrap();
            }
            if animated {
                doc.execute("effects.toggleAnimation", json!({"clip":clip,"effect":"opacity","param":"opacity"})).unwrap();
            }
            let project: Project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
            let (_, found) = project.sequence(ItemId(sequence)).unwrap().find_item(kition_film_engine::project::ClipId(clip)).unwrap();
            for &(command, path) in PATHS.iter().filter(|(command, _)| *command != "effects.apply") {
                contract(&doc, command);
                assert!(compared_path(command, path));
                for index in [None, Some(0), Some(1), Some(999)] {
                    for address in [json!({}), json!({"time":0,"frame":10}), json!({"frame":10}), json!({"seconds":0.5}), json!({"timecode":"00:00:00:10"})] {
                        for (media_time, merge) in
                            [None, Some(0)].into_iter().flat_map(|media_time| [None, Some(json!(true)), Some(json!("drag"))].map(|merge| (media_time, merge)))
                        {
                            // only the commands that take a merge key are given one
                            if merge.is_some() && !matches!(command, "effects.setParam" | "effects.moveKeyframe")
                                || merge == Some(json!("drag")) && command != "effects.setParam"
                            {
                                continue;
                            }
                            let mask = path == "mask-path";
                            let mut params = json!({"clip":clip,"effect":"opacity","param":if mask { "path" } else { "opacity" },"value":50});
                            if mask {
                                params["mask"] = json!(0);
                            }
                            if let Some(index) = index {
                                params["index"] = json!(index);
                            }
                            if let Some(time) = media_time {
                                params["mediaTime"] = json!(time);
                            }
                            if let Some(merge) = merge {
                                params["merge"] = merge;
                                params["begin"] = json!(true);
                                if command == "effects.moveKeyframe" {
                                    params["to"] = json!(254_016_000_000i64);
                                }
                            }
                            params.as_object_mut().unwrap().extend(address.as_object().unwrap().clone());
                            let mut expected = Under::default();
                            if command == "effects.toggleEnabled"
                                || (matches!(command, "effects.deleteKeyframe" | "effects.moveKeyframe" | "effects.setInterpolation" | "effects.setKeyframe")
                                    && media_time.is_some())
                                || (command == "effects.setParam" && !mask && !animated && address.as_object().unwrap().is_empty())
                            {
                                expected.premises.push(leaf(clip, &["effects"]));
                            }
                            if command == "effects.reset"
                                && found.effects.get(index.unwrap_or(0)).and_then(|effect| effect.def()).is_some_and(|def| {
                                    def.instance()
                                        .params
                                        .values()
                                        .any(|param| matches!(&param.value, ParamValue::Vec2(value) if value.x.is_nan() || value.y.is_nan()))
                                })
                            {
                                expected.premises.push(size(sequence));
                            }
                            if mask {
                                expected.premises.push(
                                    Premise::on(json!(clip))
                                        .fields(["effects", "item", "sourceIn", "speed", "reverse", "props.frame_hold", "props.scale_to_frame"])
                                        .positions(["start", "duration"]),
                                );
                                assert!(matches!(project.item(ItemId(media)).unwrap().kind, ItemKind::Media(_)));
                                expected.premises.push(leaf(media, &["props.media.info.video.width", "props.media.info.video.height"]));
                                if fitting {
                                    expected.premises.push(size(sequence));
                                }
                            }
                            timebase(sequence, command, &params, &mut expected);
                            assert_eq!(
                                normalized(doc.under(command, &params).unwrap().unwrap_or_default()),
                                normalized(expected),
                                "{command}/{path}/{params}/animated={animated}/fitting={fitting}"
                            );
                        }
                    }
                }
            }
        }
    }
}
