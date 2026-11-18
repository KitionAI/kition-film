//! clip_ops.rs:917-1022 scans every candidate for matching selections and
//! global cleanup. project_tools.rs:510-629 searches the complete project or
//! timeline, then reports all hits. The retained container profiles include
//! unrelated fields, recorded as MORE rather than exact query projections.
use super::sync_compare::normalized;
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("edit.selectAllMatching", "selection"),
    ("edit.selectLabelGroup", "timeline selection"),
    ("edit.selectLabelGroup", "project selection"),
    ("edit.removeUnused", "global"),
    ("edit.consolidateDuplicates", "global"),
    ("edit.find", "project scope"),
    ("edit.find", "timeline scope"),
    ("edit.findNext", "last find"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/clip_ops.rs")) == 0x973a242360050d16
        && hash(include_str!("../../../../crates/engine/engine/src/project_tools.rs")) == 0xf8d2f12928fa34b4
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["whole-query-container"];
    if matches!(command, "edit.selectAllMatching" | "edit.selectLabelGroup" | "edit.consolidateDuplicates") {
        out.push("coarse-selection-state");
    }
    if matches!(command, "edit.find" | "edit.findNext" | "edit.removeUnused" | "edit.consolidateDuplicates") {
        out.push("coarse-active-state");
    }
    if matches!(command, "edit.find" | "edit.findNext") {
        out.extend(["coarse-time-state", "coarse-mode-state"]);
    }
    out
}
#[test]
fn project_queries_hold_complete_candidates_including_empty_and_off_playhead_sets() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    doc.execute("clip.rename", json!({"item":item,"name":"Candidate"})).unwrap();
    let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":5})).unwrap()["clips"][0].as_u64().unwrap();
    for selected in [vec![clip], vec![]] {
        doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
        for project_selected in [vec![], vec![item], vec![sequence, item]] {
            doc.execute("project.select", json!({"items":project_selected})).unwrap();
            for &(command, path) in PATHS {
                doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                doc.execute("project.select", json!({"items":project_selected})).unwrap();
                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                assert!(spec.mutates && spec.objects.is_empty() && spec.places.is_empty() && spec.name_params.is_empty());
                assert_eq!(spec.targets, (command == "edit.selectAllMatching").then_some("clips"));
                assert_eq!(spec.object_types, if command == "edit.selectAllMatching" { vec![("clips", &["Clip"][..])] } else { vec![] });
                assert_eq!(
                    spec.reads,
                    match command {
                        "edit.selectAllMatching" | "edit.selectLabelGroup" => vec![EditorState::Part, EditorState::Selection],
                        "edit.removeUnused" => vec![EditorState::Active],
                        "edit.consolidateDuplicates" => vec![EditorState::Selection, EditorState::Active],
                        _ => vec![EditorState::Part, EditorState::Time, EditorState::Mode, EditorState::Active],
                    }
                );
                assert!(spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                for scope in ["project", "timeline"] {
                    for within in ["all", "clips", "markers"] {
                        if command == "edit.findNext" {
                            let _ = doc.execute("edit.find", json!({"scope":scope,"text":"Candidate","in":within}));
                        }
                        for named in [None, Some(json!([])), Some(json!([clip])), Some(json!([clip as f64]))] {
                            let mut params = if command == "edit.find" { json!({"scope":scope,"text":"Candidate","in":within}) } else { json!({}) };
                            if command == "edit.selectAllMatching"
                                && let Some(named) = named
                            {
                                params["clips"] = named;
                            }
                            let local = command == "edit.selectAllMatching" || command == "edit.selectLabelGroup" && !selected.is_empty();
                            let want = Under {
                                premises: vec![if local {
                                    Premise::on(json!(sequence)).fields(["sequence"]).positions(Vec::<String>::new())
                                } else {
                                    Premise::on(json!("project"))
                                }],
                                ..Default::default()
                            };
                            assert_eq!(
                                normalized(doc.under(command, &params).unwrap().unwrap()),
                                normalized(want),
                                "{command}/{path}/{params}/selected={selected:?}/project={project_selected:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}
