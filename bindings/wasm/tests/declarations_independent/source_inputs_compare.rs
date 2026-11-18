//! presets.rs:434-509, clip_ops.rs:1592-1631 and keyboard.rs:654-703.
//! Preset geometry and Fit/Fill read source dimensions through subclip parents;
//! poster assignments read the resolved source timebase but never its picture.
use super::sync_compare::normalized;
use kition_film_engine::project::{ClipId, ItemId, ItemKind, Project, TrackKind};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

#[test]
fn later_subclip_parent_dimensions_do_not_hold_its_unused_rate() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let leading = doc.execute("file.newColorMatte", json!({"seconds":2})).unwrap()["item"].clone();
    let parent = doc.execute("file.newOfflineFile", json!({"name":"Parent","seconds":1,"audio":false})).unwrap()["item"].as_u64().unwrap();
    let source = doc.execute("clip.makeSubclip", json!({"item":parent,"name":"Subclip","start":0,"end":127_008_000_000i64})).unwrap()["item"].clone();
    let under = doc.under("file.newSequenceFromClip", &json!({"items":[leading,source]})).unwrap().unwrap();
    let need = under.premises.iter().find(|need| need.id == json!(parent)).unwrap();
    assert_eq!(
        need.fields,
        Some(["kind", "props.media.info.video.width", "props.media.info.video.height", "~sourceAudioPlacement"].map(str::to_owned).to_vec()),
        "{under:?}"
    );
    let need = under.premises.iter().find(|need| need.id == source).unwrap();
    assert_eq!(
        need.fields,
        Some(
            ["kind", "name", "props", "sequence", "~sourceGraphicDefinition", "props.common.label", "props.range.duration", "props.parent"]
                .map(str::to_owned)
                .to_vec()
        ),
        "{under:?}"
    );
}

pub const PATHS: &[(&str, &str)] = &[
    ("presets.save", "keyframes retained"),
    ("presets.save", "keyframes none"),
    ("presets.apply", "library preset"),
    ("clip.fitToFrame", "video targets"),
    ("clip.fillFrame", "video targets"),
    ("clip.setPosterFrame", "explicit or default item"),
    ("clip.clearPosterFrame", "explicit or default item"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/keyboard.rs")) == 0xc4c1cfffb8e70cd9
        && hash(include_str!("../../../../crates/engine/engine/src/clip_ops.rs")) == 0x973a242360050d16
        && hash(include_str!("../../../../crates/engine/engine/src/presets.rs")) == 0x3c8b435bcfc471ab
        && hash(include_str!("../../../../crates/engine/project/src/lib.rs")) == 0x784d4865cb75caf9
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-selection-state", "unconsumed-selection"];
    if command.starts_with("presets.") {
        out.extend(["coarse-mode-state", "whole-effect-profile", "clip-owner-position", "coarse-preset-source-mapping"]);
    } else if command.ends_with("Frame") {
        out.push("coarse-active-state");
        if command == "clip.setPosterFrame" {
            out.extend(["item-only-part", "coarse-time-state"]);
        }
    } else {
        out.extend(["whole-effect-profile", "clip-owner-position"]);
    }
    out
}

fn leaf(id: u64, names: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(names).positions(Vec::<String>::new())
}

pub(super) fn dimensions(project: &Project, sequence: u64, source: ItemId, want: &mut Under) {
    let mut id = source;
    for _ in 0..16 {
        let Some(item) = project.item(id) else { break };
        match &item.kind {
            ItemKind::Subclip { parent, .. } => {
                want.premises.push(leaf(id.0, ["kind", "props.parent"]));
                id = *parent;
            }
            ItemKind::Media(_) => {
                want.premises.push(leaf(id.0, ["kind", "props.media.info.video.width", "props.media.info.video.height"]));
                break;
            }
            ItemKind::Sequence(_) => {
                want.premises.push(leaf(id.0, ["kind", "sequence.settings.settings.width", "sequence.settings.settings.height"]));
                break;
            }
            _ => {
                want.premises.push(leaf(id.0, ["kind", "props.width", "props.height"]));
                break;
            }
        }
    }
    if project.source_size(source).is_none() {
        want.premises.push(leaf(sequence, ["sequence.settings.settings.width", "sequence.settings.settings.height"]));
    }
}

fn fixture() -> (FilmDocument, u64, Vec<u64>) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
    let mut clips = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap())
        .collect::<Vec<_>>();
    let sub = doc.execute("clip.makeSubclip", json!({"item":item,"start":0,"end":254_016_000_000i64})).unwrap()["item"].clone();
    clips.extend(
        doc.execute("timeline.place", json!({"item":sub,"track":"V2","audioTrack":"A2","time":0})).unwrap()["clips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_u64().unwrap()),
    );
    let adjustment = doc.execute("file.newAdjustmentLayer", json!({"seconds":1})).unwrap()["item"].clone();
    clips.push(doc.execute("timeline.place", json!({"item":adjustment,"track":"V3","time":0})).unwrap()["clips"][0].as_u64().unwrap());
    clips.push(doc.execute("graphics.newText", json!({"newClip":true,"text":"Text","track":2,"time":762_048_000_000i64})).unwrap()["clip"].as_u64().unwrap());
    (doc, sequence, clips)
}

#[test]
fn fit_fill_and_presets_compare_selection_precedence_source_routes_geometry_and_keyframe_modes() {
    let (mut doc, sequence, clips) = fixture();
    doc.execute("presets.save", json!({"clip":clips[0],"effects":[0],"name":"Geometry"})).unwrap();
    doc.execute("presets.save", json!({"clip":clips[0],"effects":[1],"name":"Scalar"})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let q = project.sequence(ItemId(sequence)).unwrap();
    for selected in [vec![], vec![clips[1]], vec![clips[1], clips[2]], vec![clips[4], clips[0]], clips.clone()] {
        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
        for &(command, path) in &PATHS[..5] {
            assert!(compared_path(command, path));
            let save = command == "presets.save";
            let preset = command.starts_with("presets.");
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            assert!(spec.mutates);
            assert_eq!(spec.enabled, preset || !selected.is_empty());
            assert_eq!(spec.targets, Some(if save { "clip" } else { "clips" }));
            assert_eq!(
                spec.reads,
                if save {
                    vec![EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Mode]
                } else if preset {
                    vec![EditorState::Part, EditorState::Selection, EditorState::Mode]
                } else {
                    vec![EditorState::Part, EditorState::Selection]
                }
            );
            assert_eq!(spec.objects, if preset { vec![] } else { vec!["clip"] });
            assert_eq!(
                spec.object_types,
                if save {
                    vec![("clip", &["Clip"][..])]
                } else if preset {
                    vec![("clips", &["Clip"][..])]
                } else {
                    vec![("clips", &["Clip"][..]), ("clip", &["Clip"][..])]
                }
            );
            assert!(
                spec.places.is_empty()
                    && spec.name_params.is_empty()
                    && spec.name_field.is_none()
                    && spec.index.is_none()
                    && !spec.index_numbers
                    && !spec.index_reversed
            );
            for explicit in [false, true] {
                for name in ["Geometry", "Scalar", "Missing"] {
                    for mode in ["scale", "anchorIn", "anchorOut", "none"] {
                        if save && (path == "keyframes none") != (mode == "none") {
                            continue;
                        }
                        let mut params = if save {
                            json!({"name":"Saved","keyframes":mode})
                        } else if preset {
                            json!({"preset":name})
                        } else {
                            json!({})
                        };
                        if explicit {
                            params[if save { "clip" } else { "clips" }] = if save { json!(clips[0]) } else { json!([clips[0], clips[1], clips[4]]) };
                        }
                        let recipients = if save {
                            params
                                .get("clip")
                                .and_then(Value::as_u64)
                                .or_else(|| {
                                    selected
                                        .iter()
                                        .find(|id| {
                                            q.find_item(ClipId(**id)).and_then(|(owner, _)| q.track(owner)).is_some_and(|track| track.kind == TrackKind::Video)
                                        })
                                        .copied()
                                })
                                .or_else(|| selected.first().copied())
                                .into_iter()
                                .collect::<Vec<_>>()
                        } else {
                            params
                                .get("clips")
                                .and_then(Value::as_array)
                                .map(|ids| ids.iter().filter_map(Value::as_u64).collect())
                                .unwrap_or_else(|| selected.clone())
                        };
                        let mut want = Under::default();
                        for id in recipients {
                            let (owner, clip) = q.find_item(ClipId(id)).unwrap();
                            if !preset && q.track(owner).unwrap().kind != TrackKind::Video {
                                continue;
                            }
                            let mut need =
                                leaf(id, if preset { vec!["effects", "item", "sourceIn", "speed"] } else { vec!["effects", "item", "props.scale_to_frame"] });
                            if preset {
                                need = need.positions(["duration", "clips"]);
                                if save && mode == "none" {
                                    need.fields.as_mut().unwrap().extend(["reverse", "props.frame_hold"].map(str::to_owned));
                                    need.positions.as_mut().unwrap().push("start".into());
                                }
                            }
                            want.premises.push(need);
                            if !preset {
                                want.premises.push(Premise::on(json!(id)).fields(Vec::<String>::new()).positions(["clips"]));
                            }
                            want.premises.push(leaf(owner.0, ["props.kind"]));
                            if !preset || save || name != "Scalar" {
                                dimensions(&project, sequence, clip.item, &mut want);
                            }
                        }
                        if !preset {
                            want.premises.push(leaf(sequence, ["sequence.settings.settings.width", "sequence.settings.settings.height"]));
                        }
                        assert_eq!(
                            normalized(doc.under(command, &params).unwrap().unwrap()),
                            normalized(want),
                            "{command}/{path}/{params}/selected={selected:?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn posters_compare_explicit_project_and_source_items_zero_time_and_parent_timebases() {
    let (mut doc, sequence, _) = fixture();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let items = project.items.keys().map(|id| id.0).collect::<Vec<_>>();
    for source in items.iter().copied() {
        doc.execute("source.open", json!({"item":source})).unwrap();
        for selected in [vec![], vec![source], vec![items[0]]] {
            doc.execute("project.select", json!({"items":selected})).unwrap();
            for &(command, path) in &PATHS[5..] {
                assert!(compared_path(command, path));
                let clear = command == "clip.clearPosterFrame";
                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                assert!(spec.enabled && spec.mutates && spec.objects.is_empty() && spec.targets == Some("item"));
                assert_eq!(spec.object_types, [("item", &["Item"][..])]);
                assert_eq!(
                    spec.reads,
                    if clear {
                        vec![EditorState::Selection, EditorState::Active]
                    } else {
                        vec![EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Active]
                    }
                );
                assert!(
                    spec.places.is_empty()
                        && spec.name_params.is_empty()
                        && spec.name_field.is_none()
                        && spec.index.is_none()
                        && !spec.index_numbers
                        && !spec.index_reversed
                );
                for explicit in [false, true] {
                    for time in [0, 254_016_000_000i64] {
                        let mut params = if clear { json!({}) } else { json!({"time":time}) };
                        if explicit {
                            params["item"] = json!(source);
                        }
                        let target = if explicit { source } else { selected.first().copied().unwrap_or(source) };
                        let mut want = Under { premises: vec![leaf(target, ["kind", "props.common.metadata.Poster Frame"])], ..Default::default() };
                        let uses_source = !explicit && target == source;
                        let actual_time = if uses_source { doc.editor_state()["time"]["source"].as_i64().unwrap() } else { time };
                        if !clear && actual_time != 0 {
                            let mut id = ItemId(target);
                            for _ in 0..16 {
                                let item = project.item(id).unwrap();
                                let mut fields = vec!["kind"];
                                match &item.kind {
                                    ItemKind::Subclip { parent, .. } => {
                                        fields.push("props.parent");
                                        want.premises.push(leaf(id.0, fields));
                                        id = *parent;
                                        continue;
                                    }
                                    ItemKind::Media(media) => {
                                        fields.push("props.media.interpret.frame_rate");
                                        if media.interpret.frame_rate.is_none() {
                                            fields.push("props.media.info.video.frame_rate");
                                        }
                                    }
                                    _ => {}
                                }
                                want.premises.push(leaf(id.0, fields));
                                break;
                            }
                            match &project.item(ItemId(target)).unwrap().kind {
                                ItemKind::Sequence(_) => want.premises.push(leaf(target, ["sequence.settings.settings.frame_rate"])),
                                ItemKind::Graphic { .. } => want.premises.push(leaf(target, ["props.rate"])),
                                _ => {}
                            }
                        }
                        assert_eq!(
                            normalized(doc.under(command, &params).unwrap().unwrap()),
                            normalized(want),
                            "{command}/{params}/source={source}/selected={selected:?}/sequence={sequence}"
                        );
                    }
                }
            }
        }
    }
}
