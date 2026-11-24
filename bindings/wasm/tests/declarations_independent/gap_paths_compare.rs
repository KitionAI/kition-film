//! sequence_tools.rs:96-101,252-260,303-327; edit/through.rs:188-216.
//! Gap lookup consumes the searched geometry. A successful destination and
//! enabling selection follow also consume targeted point recipients and links.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, Sequence};
use kition_film_kit::FilmDocument;
use kition_film_time::Tick;
use kition_kit::{EditorState, KitDocument, Premise, RelativeOrder, TimeSpan, Under, Within};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("sequence.goToNextGap", "navigation"),
    ("sequence.goToPrevGap", "navigation"),
    ("sequence.goToNextGapInTrack", "navigation"),
    ("sequence.goToPrevGapInTrack", "navigation"),
    ("sequence.selectionFollowsPlayhead", "on/toggle"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/sequence_tools.rs")) == 0x9c4a17d3fd68bdd4
        && hash(include_str!("../../../../crates/engine/edit/src/through.rs")) == 0x4c6835072dd061dd
        && hash(include_str!("../../../../crates/engine/engine/src/lib.rs")) == 0x29dfa74ea34f459f
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-active-state", "coarse-mode-state", "coarse-time-state"];
    if command != "sequence.selectionFollowsPlayhead" {
        out.push("whole-gap-search-geometry");
    }
    out
}

fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}

fn selection(want: &mut Under, sequence: u64, q: &Sequence, targets: &[u64], explicit: bool, linked: bool, at: i64) {
    if explicit {
        for (tracks, field) in
            [(&q.video_tracks, "sequence.videoTracks"), (&q.audio_tracks, "sequence.audioTracks"), (&q.submix_tracks, "sequence.submixTracks")]
        {
            let objects: Vec<_> = tracks.iter().filter(|track| targets.contains(&track.id.0)).map(|track| json!(track.id.0)).collect();
            if objects.len() > 1 {
                want.orders.push(RelativeOrder { parent: json!(sequence), field: field.into(), objects });
            }
        }
    } else {
        want.premises.push(leaf(sequence, &["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
    }
    for track in q.all_tracks().filter(|track| targets.contains(&track.id.0)) {
        let from = track.items.iter().take_while(|clip| clip.end().0 <= at).count();
        let to = track.items.iter().take_while(|clip| clip.start.0 <= at).count().max(from);
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
        for clip in &track.items[from..to] {
            want.premises.push(Premise::on(json!(clip.id.0)).fields(["link", "~linkedGroup"]).positions(["start", "duration"]));
            if linked && let Some(link) = clip.link {
                let root = q.all_tracks().flat_map(|track| &track.items).filter(|peer| peer.link == Some(link)).map(|peer| peer.id.0).min().unwrap();
                want.premises.push(leaf(root, &["~linkedMembers"]));
            }
        }
    }
}

#[test]
fn gaps_and_selection_follow_compare_target_sets_gap_directions_links_and_empty_destinations() {
    const SECOND: i64 = 254_016_000_000;
    for populated in [false, true] {
        for target_mode in 0..3 {
            let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
            doc.execute("sequence.settings", json!({"fps":30})).unwrap();
            let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
            if populated {
                let item = doc.execute("file.newBarsAndTone", json!({"seconds":1})).unwrap()["item"].clone();
                for (time, track, audio) in [(0, "V1", "A1"), (3 * SECOND, "V1", "A1"), (2 * SECOND, "V2", "A2"), (6 * SECOND, "V2", "A2")] {
                    doc.execute("timeline.place", json!({"item":item,"track":track,"audioTrack":audio,"time":time})).unwrap();
                }
            }
            if target_mode != 0 {
                for track in ["V1", "V2", "V3", "A1", "A2", "A3"] {
                    doc.execute("timeline.setTargeting", json!({"track":track,"targeted":target_mode==1 && track.starts_with('V')})).unwrap();
                }
            }
            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
            let q = project.sequence(ItemId(sequence)).unwrap();
            let targets: Vec<_> = q
                .all_tracks()
                .filter(|track| target_mode == 0 || target_mode == 1 && q.video_tracks.iter().any(|video| video.id == track.id))
                .map(|track| track.id.0)
                .collect();
            for follows in [false, true] {
                doc.execute("sequence.selectionFollowsPlayhead", json!({"on":follows})).unwrap();
                for linked in [false, true] {
                    doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
                    for time in [0, SECOND, 2 * SECOND, 5 * SECOND, 8 * SECOND] {
                        doc.execute("playhead.set", json!({"time":time})).unwrap();
                        for &(command, path) in PATHS {
                            assert!(compared_path(command, path));
                            let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                            let in_track = command.ends_with("InTrack");
                            let toggle = command == "sequence.selectionFollowsPlayhead";
                            assert!(spec.enabled && spec.mutates && spec.targets.is_none());
                            assert_eq!(
                                spec.reads,
                                if in_track {
                                    vec![EditorState::Part, EditorState::Time, EditorState::Active, EditorState::Mode]
                                } else {
                                    vec![EditorState::Part, EditorState::Time, EditorState::Mode, EditorState::Active]
                                }
                            );
                            assert_eq!(spec.objects, if in_track { vec!["track"] } else { vec![] });
                            assert_eq!(spec.object_types, if in_track { vec![("track", &["Track"][..])] } else { vec![] });
                            assert!(
                                spec.places.is_empty()
                                    && spec.name_params.is_empty()
                                    && spec.name_field.is_none()
                                    && spec.index.is_none()
                                    && !spec.index_numbers
                                    && !spec.index_reversed
                            );
                            let params = if toggle {
                                vec![json!({}), json!({"on":false}), json!({"on":true}), json!({"on":null})]
                            } else if in_track {
                                vec![json!({}), json!({"track":null}), json!({"track":"V1"}), json!({"track":"a2"}), json!({"track":q.video_tracks[0].id.0})]
                            } else {
                                vec![json!({})]
                            };
                            for p in params {
                                let mut want = Under::default();
                                if toggle {
                                    if p.get("on").and_then(Value::as_bool).unwrap_or(!follows) {
                                        selection(&mut want, sequence, q, &targets, target_mode != 0, linked, time);
                                    }
                                } else {
                                    want.premises.push(leaf(sequence, &["sequence.settings.settings.frame_rate"]));
                                    let chosen = p["track"].as_u64().or_else(|| {
                                        p["track"].as_str().and_then(|name| match name {
                                            "V1" => Some(q.video_tracks[0].id.0),
                                            "a2" => Some(q.audio_tracks[1].id.0),
                                            _ => None,
                                        })
                                    });
                                    let searched: Vec<_> = q
                                        .all_tracks()
                                        .filter(|track| !in_track || chosen.map_or_else(|| targets.contains(&track.id.0), |id| id == track.id.0))
                                        .collect();
                                    for track in &searched {
                                        let field = if q.video_tracks.iter().any(|video| video.id == track.id) {
                                            "sequence.videoTracks"
                                        } else {
                                            "sequence.audioTracks"
                                        };
                                        want.premises.push(leaf(track.id.0, &["~clipOrder"]).positions([field]));
                                        for clip in &track.items {
                                            want.premises.push(leaf(clip.id.0, &[]).positions(["start", "duration"]));
                                        }
                                    }
                                    let groups: Vec<Vec<_>> = if in_track {
                                        searched.iter().map(|track| track.items.iter().collect()).collect()
                                    } else {
                                        vec![searched.iter().flat_map(|track| &track.items).collect()]
                                    };
                                    let mut gaps = Vec::new();
                                    for mut clips in groups {
                                        clips.sort_by_key(|clip| clip.start);
                                        let mut end = 0;
                                        for clip in clips {
                                            if clip.start.0 > end {
                                                gaps.push(end);
                                            }
                                            end = end.max(clip.end().0);
                                        }
                                    }
                                    let destination = if command.contains("Next") {
                                        gaps.into_iter().filter(|gap| *gap > time).min()
                                    } else {
                                        gaps.into_iter().filter(|gap| *gap < time).max()
                                    };
                                    if follows && let Some(destination) = destination {
                                        selection(&mut want, sequence, q, &targets, target_mode != 0, linked, q.settings.frame_rate.snap(Tick(destination)).0);
                                    }
                                }
                                assert_eq!(
                                    normalized(doc.under(command, &p).unwrap().unwrap()),
                                    normalized(want),
                                    "{command}/{p}/populated={populated}/targets={target_mode}/follows={follows}/linked={linked}/time={time}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}
