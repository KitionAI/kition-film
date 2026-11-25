//! clip_ops.rs:1426-1486: disabled holds clear two assigned fields; all other
//! modes snap their source frame, and sourceTimecode also consumes its origin.
use super::sync_compare::normalized;
use kition_film_engine::project::{ClipId, ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] =
    &[("clip.frameHoldOptions", "disabled"), ("clip.frameHoldOptions", "in/out/playhead/sequenceTime"), ("clip.frameHoldOptions", "sourceTimecode")];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
        && include_str!("../../../../crates/engine/engine/src/clip_ops.rs")
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3))
            == 0x973a242360050d16
}
pub fn more(_: &str) -> Vec<&'static str> {
    vec!["whole-frame-hold-target", "coarse-selection-state", "coarse-time-state"]
}
fn leaf(id: u64, fields: impl IntoIterator<Item = &'static str>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn expected(project: &Project, sequence: u64, ids: &[u64], enabled: bool, mode: &str, spelling: &str) -> Under {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let mut want = Under::default();
    for id in ids {
        want.premises.push(Premise::on(json!(id)));
        if !enabled {
            continue;
        }
        let Some(clip) = q.video_tracks.iter().find_map(|track| track.item(ClipId(*id))) else { continue };
        let mut id = clip.item;
        for _ in 0..16 {
            let item = project.item(id).unwrap();
            match &item.kind {
                ItemKind::Subclip { parent, .. } => {
                    want.premises.push(leaf(id.0, ["kind", "props.parent"]));
                    id = *parent;
                }
                ItemKind::Media(media) => {
                    let mut fields = vec!["kind", "props.media.interpret.frame_rate"];
                    if media.interpret.frame_rate.is_none() {
                        fields.push("props.media.info.video.frame_rate");
                    }
                    if mode == "sourceTimecode" && spelling == "timecode" {
                        fields.push("props.media.info.start_timecode");
                    }
                    want.premises.push(leaf(id.0, fields));
                    break;
                }
                ItemKind::Sequence(_) => {
                    want.premises.push(leaf(id.0, ["kind", "sequence.settings.settings.frame_rate"]));
                    break;
                }
                ItemKind::Graphic { .. } | ItemKind::AdjustmentLayer { .. } => {
                    want.premises.push(leaf(id.0, ["kind", "props.rate"]));
                    break;
                }
            }
        }
    }
    if enabled && mode == "sequenceTime" && matches!(spelling, "frame" | "timecode") {
        let mut fields = vec!["sequence.settings.settings.frame_rate"];
        if spelling == "timecode" {
            fields.push("sequence.settings.settings.drop_frame");
        }
        want.premises.push(leaf(sequence, fields));
    }
    want
}

#[test]
fn frame_hold_options_compare_every_mode_selector_source_route_and_time_spelling() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("item.newOfflineFile", json!({"seconds":3})).unwrap()["item"].as_u64().unwrap();
    let subclip = doc.execute("clip.makeSubclip", json!({"item":source,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let adjustment = doc.execute("item.newAdjustmentLayer", json!({})).unwrap()["item"].as_u64().unwrap();
    let mut ids = Vec::new();
    for (source, track) in [(source, "V1"), (subclip, "V2"), (adjustment, "V3")] {
        ids.extend(
            doc.execute("timeline.place", json!({"item":source,"track":track,"time":0})).unwrap()["clips"].as_array().unwrap().iter().filter_map(Value::as_u64),
        );
    }
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for selected in [vec![], vec![ids[0]], ids.clone()] {
        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
        let spec = doc.commands().into_iter().find(|s| s.id == "clip.frameHoldOptions").unwrap();
        assert!(spec.mutates && spec.targets == Some("clips"));
        assert_eq!(spec.reads, [EditorState::Part, EditorState::Selection, EditorState::Time]);
        assert_eq!(spec.enabled, !selected.is_empty());
        assert_eq!(spec.objects, ["clip"]);
        assert_eq!(spec.object_types, [("clips", &["Clip"][..]), ("clip", &["Clip"][..])]);
        assert!(spec.places.is_empty() && spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none());
        assert!(!spec.index_numbers && !spec.index_reversed);
        for enabled in [false, true] {
            for mode in ["in", "out", "playhead", "sequenceTime", "sourceTimecode"] {
                let path = if !enabled {
                    "disabled"
                } else if mode == "sourceTimecode" {
                    "sourceTimecode"
                } else {
                    "in/out/playhead/sequenceTime"
                };
                assert!(compared_path("clip.frameHoldOptions", path));
                for (spelling, time) in [("time", json!(0)), ("seconds", json!(0.5)), ("frame", json!(3)), ("timecode", json!("00:00:00:01"))] {
                    for many in [None, Some(json!([])), Some(json!(ids)), Some(json!([ids[0] as f64]))] {
                        for scalar in [None, Some(ids[0])] {
                            let mut params = json!({"enabled":enabled,"holdOn":mode,"holdFilters":true});
                            params[spelling] = time.clone();
                            if let Some(many) = &many {
                                params["clips"] = many.clone();
                            }
                            if let Some(scalar) = scalar {
                                params["clip"] = json!(scalar);
                            }
                            let operands = many
                                .as_ref()
                                .map(|many| many.as_array().unwrap().iter().filter_map(Value::as_u64).collect::<Vec<_>>())
                                .unwrap_or_else(|| scalar.map(|scalar| vec![scalar]).unwrap_or_else(|| selected.clone()));
                            assert_eq!(
                                normalized(doc.under("clip.frameHoldOptions", &params).unwrap().unwrap()),
                                normalized(expected(&project, sequence, &operands, enabled, mode, spelling)),
                                "{params}/{selected:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}
