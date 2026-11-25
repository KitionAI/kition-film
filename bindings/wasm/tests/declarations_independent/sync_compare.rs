//! Full sync scopes from multicam.rs:337-678 and sync.rs:78-225.
//! Sync methods consume source ranges, marks, timecode, markers or audio.
//! The declaration retains a common source superset for these methods.
use std::collections::{BTreeMap, BTreeSet};

use kition_film_engine::project::{ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::json;

pub const COMMANDS: &[&str] = &["clip.synchronize", "clip.mergeClips", "clip.addMulticam"];
pub const METHODS: &[&str] = &["in", "out", "timecode", "marker", "audio"];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    COMMANDS.contains(&command)
        && METHODS.contains(&path)
        && hash(include_str!("../../../../crates/engine/engine/src/multicam.rs")) == 0x52a6ff09ef04c8dd
        && hash(include_str!("../../../../crates/engine/engine/src/sync.rs")) == 0xc45d8d00e63a38e3
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut more = vec!["coarse-source-profile", "coarse-selection-state"];
    if command == "clip.synchronize" {
        more.extend(["whole-sync-destinations", "coarse-mode-state"]);
    } else {
        more.push("unused-source-label");
    }
    more
}

fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}

pub(super) fn normalized(mut under: Under) -> Under {
    let mut entries: BTreeMap<String, Premise> = BTreeMap::new();
    for need in under.premises {
        let key = need.id.to_string();
        if let Some(previous) = entries.get_mut(&key) {
            for (held, next) in [(&mut previous.fields, need.fields), (&mut previous.positions, need.positions)] {
                if let (Some(held), Some(next)) = (held.as_mut(), &next) {
                    held.extend(next.iter().cloned());
                } else {
                    *held = None;
                }
            }
            previous.identities.extend(need.identities);
        } else {
            entries.insert(key, need);
        }
    }
    for need in entries.values_mut() {
        for fields in [&mut need.fields, &mut need.positions].into_iter().flatten() {
            *fields = fields.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect();
        }
    }
    under.premises = entries.into_values().collect();
    under
}

fn source(project: &Project, id: ItemId, out: &mut Under) {
    let mut current = Some(id);
    let mut seen = BTreeSet::new();
    while let Some(id) = current.filter(|id| seen.insert(*id)) {
        // These cover the independent source reads and expose the retained
        // superset, including fields not used by the chosen method.
        out.premises.push(leaf(
            id.0,
            &["kind", "props.media", "props.parent", "props.range", "props.restrict_trims", "props.width", "props.height", "props.rate", "sequence"],
        ));
        current = match project.item(id).map(|item| &item.kind) {
            Some(ItemKind::Subclip { parent, .. }) => Some(*parent),
            _ => None,
        };
    }
}

fn fixture() -> (FilmDocument, Vec<u64>, Vec<u64>) {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let video = doc.execute("item.newOfflineFile", json!({"name":"Video","seconds":2,"audio":false})).unwrap()["item"].as_u64().unwrap();
    let audio = doc.execute("item.newOfflineFile", json!({"name":"Audio","seconds":2,"video":false})).unwrap()["item"].as_u64().unwrap();
    let subclip = doc.execute("clip.makeSubclip", json!({"item":video,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let mut clips = Vec::new();
    for (item, track) in [(video, "V1"), (audio, "A1")] {
        clips.extend(
            doc.execute("timeline.place", json!({"item":item,"track":track,"time":0})).unwrap()["clips"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_u64().unwrap()),
        );
    }
    (doc, vec![video, audio, subclip], clips)
}

#[test]
fn sync_paths_compare_all_methods_source_routes_addresses_and_camera_defaults() {
    let (mut doc, items, clips) = fixture();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let sequence_id = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let sequence = project.sequence(ItemId(sequence_id)).unwrap();
    doc.execute("project.select", json!({"items":items})).unwrap();
    doc.execute("timeline.select", json!({"clips":clips})).unwrap();
    for &command in COMMANDS {
        let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
        assert!(spec.mutates && spec.enabled);
        assert_eq!(
            spec.reads,
            if command == "clip.synchronize" { vec![EditorState::Part, EditorState::Selection, EditorState::Mode] } else { vec![EditorState::Selection] }
        );
        assert_eq!(spec.targets, Some(if command == "clip.synchronize" { "clips" } else { "items" }));
        assert_eq!(spec.objects, if command == "clip.mergeClips" { Vec::<&str>::new() } else { vec!["reference"] });
        assert_eq!(
            spec.object_types,
            match command {
                "clip.synchronize" => vec![("clips", &["Clip"][..]), ("reference", &["Clip"][..])],
                "clip.addMulticam" => vec![("items", &["Item"][..]), ("reference", &["Item"][..])],
                _ => vec![("items", &["Item"][..])],
            }
        );
        assert!(spec.places.is_empty());
        assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
        for &method in METHODS {
            assert!(compared_path(command, method));
            for subclip in [false, true] {
                let selected = vec![if subclip { items[2] } else { items[0] }, items[1]];
                doc.execute("project.select", json!({"items":selected})).unwrap();
                doc.execute("timeline.select", json!({"clips":clips})).unwrap();
                for explicit in [false, true] {
                    for camera in ["clip", "metadata", "cameraAngle", "label", "track"] {
                        for processed in [false, true] {
                            let mut params = json!({"method":method,"offset":1,"ignoreHours":true,"marker":"Sync"});
                            if explicit {
                                params[if command == "clip.synchronize" { "clips" } else { "items" }] =
                                    json!(if command == "clip.synchronize" { &clips } else { &selected });
                                params["name"] = json!("Assigned");
                                if command != "clip.mergeClips" {
                                    params["reference"] = json!(if command == "clip.synchronize" { clips[1] } else { selected[1] });
                                } else {
                                    params["removeVideoAudio"] = json!(true);
                                }
                            }
                            if command == "clip.addMulticam" {
                                params["cameraNames"] = json!(camera);
                                params["processedBin"] = json!(processed);
                                params["audio"] = json!(if processed { "switch" } else { "all" });
                            }
                            let mut expected = Under::default();
                            if command == "clip.synchronize" {
                                expected.premises.push(leaf(sequence_id, &["sequence.settings.settings.frame_rate", "~videoTrackOrder", "~audioTrackOrder"]));
                                for track in sequence.all_tracks() {
                                    expected.premises.push(leaf(track.id.0, &["props.locked", "~clipOrder"]));
                                    for clip in &track.items {
                                        expected.premises.push(Premise::on(json!(clip.id.0)));
                                        if clips.contains(&clip.id.0) {
                                            source(&project, clip.item, &mut expected);
                                        }
                                    }
                                    expected.premises.extend(track.transitions.iter().map(|transition| Premise::on(json!(transition.id.0))));
                                }
                            } else {
                                for &id in &selected {
                                    let mut fields = vec!["kind", "name", "props.common.label"];
                                    if ["metadata", "cameraAngle", "label"].contains(&camera) && command == "clip.addMulticam" {
                                        fields.extend([
                                            "props.common.metadata.Camera Angle",
                                            "props.common.metadata.Camera Label",
                                            "props.common.metadata.Camera",
                                            "props.common.metadata.camera",
                                            "props.common.metadata.cameraAngle",
                                        ]);
                                    }
                                    expected.premises.push(leaf(id, &fields));
                                    source(&project, ItemId(id), &mut expected);
                                }
                                if command == "clip.mergeClips" {
                                    expected.premises.push(Premise::on(json!(selected[0])).fields(["~parentBin"]).positions(Vec::<String>::new()));
                                } else if processed {
                                    expected.premises.push(Premise::on(json!("project")).fields(["~processedBin"]).positions(Vec::<String>::new()));
                                }
                            }
                            assert_eq!(normalized(doc.under(command, &params).unwrap().unwrap()), normalized(expected), "{command}/{method}/{params}");
                        }
                    }
                }
            }
        }
    }
}
