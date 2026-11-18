//! graphic_templates.rs:259-303,563-635: template controls use stable layer
//! UIDs; partial metadata assignments preserve old leaves. Frame durations
//! consume the sequence timebase, while seconds and ticks do not.
use super::{graphics_compare, sync_compare::normalized};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("graphics.template.set", "control name/id -> layer UID"),
    ("graphics.setRoll", "partial metadata"),
    ("graphics.setResponsiveTime", "first time or established metadata"),
    ("graphics.template.set", graphics_compare::POST_DISPATCH),
    ("graphics.setRoll", graphics_compare::POST_DISPATCH),
    ("graphics.setResponsiveTime", graphics_compare::POST_DISPATCH),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/graphic_templates.rs")) == 0xecaafa1b22c3dc65
        && hash(include_str!("../../../../crates/engine/engine/src/graphics.rs")) == 0xaf7908925300a7a2
}
pub fn more(path: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-selection-state", "coarse-source-profile", "whole-graphic-target", "graphic-layer-profile"];
    if path == graphics_compare::POST_DISPATCH {
        out.push("unconsumed-graphic-peer-fields");
    }
    out
}
#[test]
fn graphic_metadata_compares_partial_assignments_duration_spellings_template_controls_and_shared_peers() {
    for shared in [false, true] {
        for established in [false, true] {
            let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
            let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
            let target =
                doc.execute("graphics.template.apply", json!({"template":"builtin:title-centered","track":0,"time":0})).unwrap()["clip"].as_u64().unwrap();
            if established {
                doc.execute("graphics.setResponsiveTime", json!({"clip":target,"introFrames":2,"outroFrames":2})).unwrap();
            }
            if shared {
                let item = doc.execute("graphics.upgradeToSourceGraphic", json!({"clip":target})).unwrap()["item"].clone();
                doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":10,"duration":254_016_000_000i64})).unwrap();
            }
            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
            for selected in [vec![], vec![target]] {
                doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                for &(command, path) in PATHS {
                    assert!(compared_path(command, path));
                    let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                    assert_eq!(spec.reads, [EditorState::Part, EditorState::Selection, EditorState::Time]);
                    assert!(spec.mutates && spec.targets == Some("clip") && spec.objects.is_empty());
                    assert_eq!(spec.object_types, [("clip", &["Clip"][..])]);
                    assert!(
                        spec.places.is_empty()
                            && spec.name_params.is_empty()
                            && spec.name_field.is_none()
                            && spec.index.is_none()
                            && !spec.index_numbers
                            && !spec.index_reversed
                    );
                    for explicit in [false, true] {
                        for form in ["", "Seconds", "Frames"] {
                            for mask in 0..16 {
                                let mut params = json!({});
                                if explicit {
                                    params["clip"] = json!(target);
                                }
                                let names: &[&str] =
                                    if command == "graphics.setRoll" { &["preroll", "easeIn", "easeOut", "postroll"] } else { &["intro", "outro"] };
                                for (n, name) in names.iter().enumerate() {
                                    if mask & (1 << n) != 0 {
                                        params[format!("{name}{form}")] = json!(1);
                                    }
                                }
                                if command == "graphics.setRoll" {
                                    if mask & 1 != 0 {
                                        params["mode"] = json!("roll");
                                    }
                                    if mask & 2 != 0 {
                                        params["startOffScreen"] = json!(true);
                                    }
                                    if mask & 4 != 0 {
                                        params["endOffScreen"] = json!(false);
                                    }
                                } else if command == "graphics.template.set" {
                                    params = if explicit { json!({"clip":target}) } else { json!({}) };
                                    params["values"] = if mask & 1 != 0 { json!({"title":"Assigned","subtitle":"Other"}) } else { json!({"Title":"Assigned"}) };
                                }
                                let mut want = graphics_compare::expected(&project, command, target, sequence, &selected, explicit);
                                if command != "graphics.template.set" && form == "Frames" && mask & ((1 << names.len()) - 1) != 0 {
                                    want.premises
                                        .push(Premise::on(json!(sequence)).fields(["sequence.settings.settings.frame_rate"]).positions(Vec::<String>::new()));
                                }
                                assert_eq!(
                                    normalized(doc.under(command, &params).unwrap().unwrap()),
                                    normalized(want),
                                    "{command}/{path}/{params}/shared={shared}/established={established}/selected={selected:?}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}
