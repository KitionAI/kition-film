//! clip_ops.rs:1218-1269 resolves an explicit subclip or the first selected
//! one. Tick ranges consume no parent; frame ranges use its timebase and
//! conversion copies its direct MediaClip. Stored subclip fields exclude
//! inherited media facts that a raw-tick edit does not consume.
use super::sync_compare::normalized;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[("clip.editSubclip", "range edit"), ("clip.editSubclip", "convertToMaster")];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
        && include_str!("../../../../crates/engine/engine/src/clip_ops.rs")
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3))
            == 0xd8532e3f9a552dfc
}
pub fn more(_: &str) -> Vec<&'static str> {
    vec!["coarse-selection-state"]
}

#[test]
fn subclip_edits_compare_target_precedence_conversion_and_every_range_spelling() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let parent = doc.execute("item.newOfflineFile", json!({"seconds":3})).unwrap()["item"].as_u64().unwrap();
    let subclip = doc.execute("clip.makeSubclip", json!({"item":parent,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
    for selected in [vec![], vec![parent], vec![subclip], vec![parent, subclip]] {
        doc.execute("project.select", json!({"items":selected})).unwrap();
        let spec = doc.commands().into_iter().find(|s| s.id == "clip.editSubclip").unwrap();
        assert!(spec.mutates && spec.targets == Some("item"));
        assert_eq!(spec.reads, [EditorState::Selection]);
        assert_eq!(spec.enabled, selected.contains(&subclip));
        assert!(spec.objects.is_empty() && spec.object_types == [("item", &["Item"][..])]);
        assert!(spec.places.is_empty() && spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none());
        assert!(!spec.index_numbers && !spec.index_reversed);
        for target in [Value::Null, json!(subclip), json!(subclip as f64), json!(parent)] {
            for convert in [false, true] {
                assert!(compared_path("clip.editSubclip", if convert { "convertToMaster" } else { "range edit" }));
                for mask in 0..16 {
                    let mut params = json!({"item":target,"convertToMaster":convert,"restrictTrims":true});
                    for (bit, key, value) in [(0, "start", 0), (1, "end", 254_016_000_000i64), (2, "startFrame", 0), (3, "endFrame", 12)] {
                        if mask & (1 << bit) != 0 {
                            params[key] = json!(value);
                        }
                    }
                    let target = target.as_u64().or_else(|| target.as_f64().map(|id| id as u64)).or_else(|| selected.contains(&subclip).then_some(subclip));
                    let mut want = Under::default();
                    if let Some(target) = target {
                        want.premises.push(
                            Premise::on(json!(target)).fields(["kind", "props.parent", "props.range", "props.restrict_trims"]).positions(Vec::<String>::new()),
                        );
                        if target == subclip {
                            let fields = if convert {
                                vec!["kind", "props.media"]
                            } else if (mask & 1 == 0 && mask & 4 != 0) || (mask & 2 == 0 && mask & 8 != 0) {
                                vec!["kind", "props.media.interpret.frame_rate", "props.media.info.video.frame_rate"]
                            } else {
                                vec![]
                            };
                            if !fields.is_empty() {
                                want.premises.push(Premise::on(json!(parent)).fields(fields).positions(Vec::<String>::new()));
                            }
                        }
                    }
                    assert_eq!(normalized(doc.under("clip.editSubclip", &params).unwrap().unwrap()), normalized(want), "{params}/{selected:?}");
                }
            }
        }
    }
}
