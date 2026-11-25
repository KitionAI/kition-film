//! captions.rs:561-590,625-640; sequence_extras.rs:486-500.
//! The blind rows omit set_playhead's frame snapping and optional linked
//! selection (lib.rs:1229-1236, sequence_tools.rs:252-260). Keep those readings
//! unchanged and compare these additional consumed inputs explicitly here.
use super::sync_compare::normalized;
use kition_film_engine::project::{ClipId, ItemId};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("caption.select", "editor"),
    ("caption.goTo", "editor"),
    ("caption.next", "editor"),
    ("caption.previous", "editor"),
    ("caption.showActiveOnly", "explicit/default"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/captions.rs")) == 0xd8332e1b444fc431
        && hash(include_str!("../../../../crates/engine/engine/src/sequence_extras.rs")) == 0x6ad34e92a4fc2428
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut classes = vec!["all-caption-membership"];
    if matches!(command, "caption.next" | "caption.previous" | "caption.goTo") {
        classes.push("coarse-mode-state");
        classes.push("coarse-active-state");
    }
    if matches!(command, "caption.select" | "caption.goTo" | "caption.showActiveOnly") {
        classes.push("coarse-selection-state");
    }
    classes
}

#[test]
fn navigation_compares_caption_addresses_visibility_timebases_and_following_selection() {
    const SECOND: i64 = 254_016_000_000;
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("item.newColorMatte", json!({"seconds":10})).unwrap()["item"].clone();
    let clip = doc.execute("timeline.place", json!({"item":source,"track":"V1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
    let mut tracks = Vec::new();
    let mut captions = Vec::new();
    for n in 0..2 {
        let track = doc.execute("caption.newTrack", json!({"name":format!("Track {n}")})).unwrap()["track"].clone();
        tracks.push(track.clone());
        captions.push(
            doc.execute("caption.add", json!({"track":track,"time":(n+1)*SECOND,"durationSeconds":1,"text":"Caption"})).unwrap()["caption"].as_u64().unwrap(),
        );
    }
    for enabled in [false, true] {
        doc.execute("caption.setTrack", json!({"track":tracks[1],"enabled":enabled})).unwrap();
        for follows in [false, true] {
            doc.execute("sequence.selectionFollowsPlayhead", json!({"on":follows})).unwrap();
            for time in [0, SECOND + SECOND / 2, 3 * SECOND] {
                doc.execute("playhead.set", json!({"time":time})).unwrap();
                for selected in [vec![], vec![captions[1]], vec![captions[0], captions[1]]] {
                    doc.execute("caption.select", json!({"captions":selected})).unwrap();
                    for &(command, path) in PATHS {
                        assert!(compared_path(command, path));
                        let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                        let expected_reads = match command {
                            "caption.select" => vec![EditorState::Part, EditorState::Selection],
                            "caption.goTo" => vec![EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Mode, EditorState::Active],
                            "caption.showActiveOnly" => vec![EditorState::Part, EditorState::Selection, EditorState::Active],
                            _ => vec![EditorState::Part, EditorState::Time, EditorState::Mode, EditorState::Active],
                        };
                        assert_eq!(spec.reads, expected_reads, "{command}");
                        assert!(spec.enabled && spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty());
                        assert!(
                            spec.places.is_empty()
                                && spec.name_field.is_none()
                                && spec.name_params.is_empty()
                                && spec.index.is_none()
                                && !spec.index_numbers
                                && !spec.index_reversed
                        );
                        for params in [
                            json!({}),
                            json!({"caption":captions[1]}),
                            json!({"caption":captions[1] as f64}),
                            json!({"captions":[]}),
                            json!({"captions":[null,captions[0],captions[1]],"add":true}),
                            json!({"track":"C2"}),
                        ] {
                            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                            let q = project.sequence(ItemId(sequence)).unwrap();
                            let mut fields = vec!["~captionTrackOrder".to_owned()];
                            let navigation = matches!(command, "caption.next" | "caption.previous");
                            if navigation || command == "caption.goTo" {
                                fields.push("sequence.settings.settings.frame_rate".into());
                            }
                            let array = params.get("captions").and_then(Value::as_array);
                            let explicit = params.get("caption").and_then(Value::as_u64).or_else(|| {
                                params.get("caption").and_then(Value::as_f64).filter(|x| x.is_finite() && *x >= 0.0 && x.fract() == 0.0).map(|x| x as u64)
                            });
                            let chosen = array.map(|ids| ids.iter().find_map(Value::as_u64)).unwrap_or_else(|| explicit.or_else(|| selected.first().copied()));
                            let point = array.is_none() && explicit.is_none() && selected.is_empty();
                            for track in &q.caption_tracks {
                                let base = format!("sequence.captionTracks[id={}]", track.id.0);
                                fields.push(format!("sequence.captions[track={}].id", track.id.0));
                                if navigation || command == "caption.showActiveOnly" {
                                    fields.push(format!("{base}.enabled"));
                                }
                                for caption in &track.captions {
                                    if navigation && track.enabled || command == "caption.goTo" && (point || chosen == Some(caption.id.0)) {
                                        fields.push(format!("sequence.captions[id={}].start", caption.id.0));
                                        if command == "caption.goTo" && point {
                                            fields.push(format!("sequence.captions[id={}].duration", caption.id.0));
                                        }
                                    }
                                }
                            }
                            let mut expected = Under::default();
                            if navigation && follows {
                                let mut candidates: Vec<_> = q
                                    .caption_tracks
                                    .iter()
                                    .filter(|track| track.enabled)
                                    .flat_map(|track| &track.captions)
                                    .map(|caption| (caption.start, caption.id))
                                    .collect();
                                candidates.sort();
                                let now = q.settings.frame_rate.snap(kition_film_time::Tick(time));
                                let destination = if command == "caption.next" {
                                    candidates.iter().find(|(start, _)| *start > now)
                                } else {
                                    candidates.iter().rev().find(|(start, _)| *start < now)
                                };
                                if let Some((start, _)) = destination {
                                    let at = q.settings.frame_rate.snap(*start).0;
                                    fields.extend(["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"].map(str::to_owned));
                                    for track in q.all_tracks() {
                                        expected.premises.push(Premise::on(json!(track.id.0)).fields(Vec::<String>::new()).positions(Vec::<String>::new()));
                                        expected.within.push(Within {
                                            parent: json!(track.id.0),
                                            field: "clips".into(),
                                            time: Some(TimeSpan {
                                                from: json!(at.to_string()),
                                                to: json!(at.saturating_add(1).to_string()),
                                                start: "start".into(),
                                                duration: Some("duration".into()),
                                                ..Default::default()
                                            }),
                                            ..Default::default()
                                        });
                                        for item in &track.items {
                                            if item.start.0 <= at && item.end().0 > at {
                                                assert_eq!(item.id, ClipId(clip));
                                                expected.objects.push(json!(clip));
                                                expected
                                                    .premises
                                                    .push(Premise::on(json!(clip)).fields(["link", "~linkedGroup"]).positions(Vec::<String>::new()));
                                            }
                                        }
                                    }
                                }
                            }
                            expected.premises.push(Premise::on(json!(sequence)).fields(fields).positions(Vec::<String>::new()));
                            assert_eq!(
                                normalized(doc.under(command, &params).unwrap().unwrap()),
                                normalized(expected),
                                "{command}/{params}/enabled={enabled}/follows={follows}/time={time}/selected={selected:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}
