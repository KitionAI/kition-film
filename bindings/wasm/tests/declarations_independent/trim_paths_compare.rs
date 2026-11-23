//! trim.rs::select/select_nearest/shuttle/tick/stop/cancel/play_around.
//! Geometry selects the nearest edge; dynamic replay holds a conservative
//! sequence and source profile because its reverse patch checks whole lists.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, ItemKind};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("trim.selectEditPoint", "editor"),
    ("trim.selectNearest", "editor"),
    ("trim.edit", "editor"),
    ("trim.shuttle", "initial"),
    ("trim.shuttle", "advance dynamic"),
    ("trim.shuttleStop", "advance dynamic"),
    ("trim.cancelDynamic", "dynamic"),
    ("trim.playAround", "around playback"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/trim.rs")) == 0x8a7edb67cf0883c3
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0xb40929b518ec4e05
}
pub fn more(command: &str) -> Vec<&'static str> {
    if command == "trim.selectEditPoint" {
        vec!["coarse-active-state"]
    } else if matches!(command, "trim.selectNearest" | "trim.edit") {
        vec!["coarse-active-state", "whole-nearest-trim-geometry"]
    } else {
        vec!["coarse-active-state", "coarse-mode-state", "coarse-time-state", "whole-dynamic-sequence", "coarse-source-profile"]
    }
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn fixture() -> (FilmDocument, u64, u64) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":4})).unwrap()["item"].clone();
    let first = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
    doc.execute("timeline.razor", json!({"clip":first,"time":508_032_000_000i64})).unwrap();
    (doc, sequence, first)
}

#[test]
fn edit_point_selection_compares_id_only_addresses_targeting_geometry_and_existing_points() {
    for populated in [false, true] {
        let (mut doc, sequence, clip) = fixture();
        if !populated {
            doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        }
        for selected in [false, true].into_iter().filter(|selected| !selected || populated) {
            if selected {
                doc.execute("trim.selectEditPoint", json!({"clip":clip,"edge":"out"})).unwrap();
            }
            for target in [None, Some(vec![]), Some(vec!["V1"])] {
                let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                let q = project.sequence(ItemId(sequence)).unwrap();
                for track in q.video_tracks.iter().chain(&q.audio_tracks) {
                    let targeted =
                        target.as_ref().is_none_or(|target| target.contains(&"V1") && q.video_tracks.first().is_some_and(|first| first.id == track.id));
                    doc.execute("timeline.setTargeting", json!({"track":track.id.0,"targeted":targeted})).unwrap();
                }
                let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                let q = project.sequence(ItemId(sequence)).unwrap();
                for command in ["trim.selectEditPoint", "trim.selectNearest", "trim.edit"] {
                    assert!(compared_path(command, "editor"));
                    let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                    assert_eq!(
                        spec.reads,
                        if command == "trim.selectEditPoint" {
                            vec![EditorState::Part, EditorState::Active]
                        } else {
                            vec![EditorState::Part, EditorState::Time, EditorState::Active]
                        }
                    );
                    assert_eq!(spec.targets, (command == "trim.selectEditPoint").then_some("clip"));
                    assert!(spec.enabled && spec.mutates && spec.objects.is_empty() && spec.places.is_empty());
                    for kind in ["trimIn", "trimOut", "rippleIn", "rippleOut", "roll"] {
                        for add in [false, true] {
                            let p = json!({"clip":clip,"kind":kind,"add":add});
                            let mut want = Under::default();
                            if command == "trim.selectEditPoint" {
                                want.premises.push(leaf(clip, Vec::<String>::new()));
                            } else if command != "trim.edit" || !selected {
                                want.premises.push(leaf(sequence, ["~videoTrackOrder", "~audioTrackOrder"]));
                                for track in q.video_tracks.iter().chain(&q.audio_tracks).filter(|track| {
                                    target.as_ref().is_none_or(|target| {
                                        target.is_empty() || target.contains(&"V1") && q.video_tracks.first().is_some_and(|first| first.id == track.id)
                                    })
                                }) {
                                    want.premises.push(leaf(track.id.0, ["~clipOrder"]));
                                    want.premises.extend(track.items.iter().map(|clip| leaf(clip.id.0, Vec::<String>::new()).positions(["start", "duration"])));
                                }
                            }
                            assert_eq!(
                                normalized(doc.under(command, &p).unwrap().unwrap()),
                                normalized(want),
                                "{command}/{p}/populated={populated}/selected={selected}/target={target:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn dynamic_commands_compare_empty_active_and_looping_passes_and_all_source_routes() {
    for phase in ["initial", "dynamic", "around"] {
        let (mut doc, sequence, clip) = fixture();
        doc.execute("trim.selectEditPoint", json!({"clip":clip,"edge":"out","kind":"roll"})).unwrap();
        if phase == "dynamic" {
            doc.execute("trim.shuttle", json!({"clock":10})).unwrap();
        } else if phase == "around" {
            doc.execute("trim.playAround", json!({"clock":10})).unwrap();
        }
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        let mut want = Under { premises: vec![leaf(sequence, ["sequence"])], ..Default::default() };
        for clip in q.all_tracks().flat_map(|track| &track.items) {
            let mut current = Some(clip.item);
            let mut seen = std::collections::BTreeSet::new();
            while let Some(id) = current.filter(|id| seen.insert(*id)) {
                want.premises.push(leaf(
                    id.0,
                    ["kind", "props.media", "props.parent", "props.range", "props.restrict_trims", "props.width", "props.height", "props.rate", "sequence"],
                ));
                current = match &project.item(id).unwrap().kind {
                    ItemKind::Subclip { parent, .. } => Some(*parent),
                    _ => None,
                };
            }
        }
        for &(command, path) in PATHS.iter().filter(|(command, _)| !matches!(*command, "trim.selectEditPoint" | "trim.selectNearest" | "trim.edit")) {
            assert!(compared_path(command, path));
            let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
            assert_eq!(spec.reads, vec![EditorState::Part, EditorState::Time, EditorState::Mode, EditorState::Active]);
            assert!(spec.enabled && spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.places.is_empty());
            for clock in [Value::Null, json!(0), json!(10.5)] {
                assert_eq!(normalized(doc.under(command, &json!({"clock":clock})).unwrap().unwrap()), normalized(want.clone()), "{command}/{path}/{phase}");
            }
        }
    }
}
