//! clip_ops.rs:1367-1414, relink.rs:541-578 and proxies.rs:508-529
//! resolve direct media items and replace fields on those same objects. The
//! default Item hold includes eligibility and every assigned field; Program
//! windows and unrelated Item fields are conservative extras.
use kition_film_engine::project::{ItemId, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, TimeSpan, Under, Within};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("clip.modifyTimecode", "timecode/frame/tape/reset"),
    ("media.makeOffline", "explicit or project selection"),
    ("media.detachProxies", "explicit or project selection"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/clip_ops.rs")) == 0x973a242360050d16
        && hash(include_str!("../../../../crates/engine/engine/src/proxies.rs")) == 0x18363dc19bcdf186
        && hash(include_str!("../../../../crates/engine/engine/src/relink.rs")) == 0xd65bab6cc7779e24
}

pub fn more(_: &str) -> Vec<&'static str> {
    vec!["whole-direct-media-target", "coarse-selection-state", "unconsumed-program-material"]
}

pub(super) fn program(project: &Project, sequence: u64, at: i64) -> Under {
    let mut want = Under::default();
    for track in project.sequence(ItemId(sequence)).unwrap().all_tracks() {
        let from = track.items.iter().take_while(|clip| clip.end().0 <= at).count();
        let to = track.items.iter().take_while(|clip| clip.start.0 <= at).count().max(from);
        want.objects.extend(track.items[from..to].iter().map(|clip| json!(clip.id.0)));
        want.within.push(Within {
            parent: json!(track.id.0),
            field: "clips".into(),
            from,
            to,
            time: Some(TimeSpan {
                from: json!(at.to_string()),
                to: json!(at.to_string()),
                start: "start".into(),
                duration: Some("duration".into()),
                ..Default::default()
            }),
        });
    }
    want
}

#[test]
fn direct_media_paths_compare_all_target_spellings_selection_and_assignment_branches() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("file.newOfflineFile", json!({"seconds":3})).unwrap()["item"].as_u64().unwrap();
    let generated = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    doc.execute("timeline.place", json!({"item":generated,"track":"V1","time":0})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for selected in [vec![], vec![source], vec![sequence, generated], vec![generated, source]] {
        doc.execute("project.select", json!({"items":selected})).unwrap();
        for at in [0, 254_016_000_000i64, 762_048_000_000i64] {
            doc.execute("playhead.set", json!({"time":at})).unwrap();
            let at = doc.inspect().unwrap()["playhead"].as_i64().unwrap();
            for &(command, path) in PATHS {
                assert!(compared_path(command, path));
                let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                let timecode = command == "clip.modifyTimecode";
                assert!(spec.mutates);
                assert_eq!(spec.reads, [EditorState::Selection]);
                assert_eq!(spec.targets, Some(if timecode { "item" } else { "items" }));
                assert_eq!(spec.objects, if timecode { vec![] } else { vec!["item"] });
                assert_eq!(spec.object_types, if timecode { vec![("item", &["Item"][..])] } else { vec![("items", &["Item"][..]), ("item", &["Item"][..])] });
                assert!(spec.places.is_empty() && spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none());
                assert!(!spec.index_numbers && !spec.index_reversed);
                for target in [Value::Null, json!(source), json!(source as f64), json!(generated), json!(sequence)] {
                    for many in [None, Some(json!([])), Some(json!([generated, source])), Some(json!([source as f64]))] {
                        for operation in [
                            json!({"frame":24}),
                            json!({"timecode":"00:00:01:00"}),
                            json!({"tapeName":"Tape"}),
                            json!({"reset":true}),
                            json!({"deleteFiles":true}),
                        ] {
                            let mut params = operation;
                            params["item"] = target.clone();
                            if !timecode && let Some(many) = &many {
                                params["items"] = many.clone();
                            }
                            // The fallback also interprets media `frame` and
                            // `timecode` as Program addresses. Record that
                            // conservative window separately from item work.
                            let place = if params.get("frame").is_some() || params.get("timecode").is_some() {
                                project.sequence(ItemId(sequence)).unwrap().settings.frame_rate.tick_of(24).0
                            } else {
                                at
                            };
                            assert_eq!(doc.under(command, &params).unwrap(), Some(program(&project, sequence, place)), "{command}/{selected:?}/{params}");
                        }
                    }
                }
            }
        }
    }
}
