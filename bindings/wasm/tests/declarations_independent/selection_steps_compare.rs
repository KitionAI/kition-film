//! keyboard.rs:128-168: point lookup, then one neighbour of the first/last
//! selected index per track. Only the resulting picks undergo linked expansion.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, Sequence};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, RelativeOrder, TimeSpan, Under, Within};
use serde_json::json;

pub const PATHS: &[(&str, &str)] =
    &[("timeline.selectClipAtPlayhead", "selection"), ("timeline.selectNextClip", "selection"), ("timeline.selectPrevClip", "selection")];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path)) && hash(include_str!("../../../../crates/engine/engine/src/keyboard.rs")) == 0xc4c1cfffb8e70cd9
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut classes = vec!["coarse-mode-state", "coarse-active-state", "coarse-selection-state", "unconsumed-link-when-disabled"];
    if command == "timeline.selectClipAtPlayhead" {
        classes.push("unconsumed-selection");
    } else {
        classes.extend(["whole-selection-step-lane-order", "unused-selection-step-time"]);
    }
    classes
}
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn links(want: &mut Under, q: &Sequence, id: u64, linked: bool) {
    want.premises.push(leaf(id, &["link", "~linkedGroup"]));
    if linked && let Some(group) = q.all_tracks().flat_map(|tr| &tr.items).find(|c| c.id.0 == id).unwrap().link {
        let root = q.all_tracks().flat_map(|tr| &tr.items).filter(|c| c.link == Some(group)).map(|c| c.id.0).min().unwrap();
        want.premises.push(leaf(root, &["~linkedMembers"]));
    }
}
fn order(want: &mut Under, sequence: u64, q: &Sequence, tracks: &[u64]) {
    for (list, field) in [(&q.video_tracks, "sequence.videoTracks"), (&q.audio_tracks, "sequence.audioTracks"), (&q.submix_tracks, "sequence.submixTracks")] {
        let objects: Vec<_> = list.iter().filter(|tr| tracks.contains(&tr.id.0)).map(|tr| json!(tr.id.0)).collect();
        if objects.len() > 1 {
            want.orders.push(RelativeOrder { parent: json!(sequence), field: field.into(), objects });
        }
    }
}
fn expected(sequence: u64, q: &Sequence, selected: &[u64], target_mode: u8, linked: bool, at: i64, command: &str) -> Under {
    let mut want = Under::default();
    if command == "timeline.selectClipAtPlayhead" || selected.is_empty() {
        let targets: Vec<_> =
            q.all_tracks().filter(|tr| target_mode == 0 || target_mode == 1 && q.video_tracks.iter().any(|t| t.id == tr.id)).map(|tr| tr.id.0).collect();
        if target_mode == 0 {
            want.premises.push(leaf(sequence, &["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
        } else {
            order(&mut want, sequence, q, &targets);
        }
        for tr in q.all_tracks().filter(|tr| targets.contains(&tr.id.0)) {
            let from = tr.items.iter().take_while(|c| c.end().0 <= at).count();
            let to = tr.items.iter().take_while(|c| c.start.0 <= at).count().max(from);
            want.within.push(Within {
                parent: json!(tr.id.0),
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
            for c in &tr.items[from..to] {
                want.objects.push(json!(c.id.0));
                links(&mut want, q, c.id.0, linked);
                want.premises.push(leaf(c.id.0, &[]).positions(["start", "duration"]));
            }
        }
    } else {
        let mut owners = Vec::new();
        for tr in q.all_tracks() {
            let anchors: Vec<_> = tr.items.iter().enumerate().filter(|(_, c)| selected.contains(&c.id.0)).map(|(i, _)| i).collect();
            let Some(&anchor) = (if command == "timeline.selectNextClip" { anchors.last() } else { anchors.first() }) else { continue };
            owners.push(tr.id.0);
            want.premises.push(leaf(tr.id.0, &["~clipOrder"]));
            for c in tr.items.iter().filter(|c| selected.contains(&c.id.0)) {
                want.premises.push(leaf(c.id.0, &[]).positions(["clips"]));
            }
            let index = if command == "timeline.selectNextClip" { anchor.checked_add(1) } else { anchor.checked_sub(1) };
            if let Some(c) = index.and_then(|i| tr.items.get(i)) {
                links(&mut want, q, c.id.0, linked);
            }
        }
        order(&mut want, sequence, q, &owners);
    }
    want
}

#[test]
fn selection_steps_compare_empty_and_multiple_anchors_track_orders_point_targets_and_links() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let source = doc.execute("item.newBarsAndTone", json!({"seconds":1})).unwrap()["item"].clone();
    let mut ids = Vec::new();
    for (track, audio) in [("V1", "A1"), ("V2", "A2")] {
        for t in [0, 2, 4] {
            ids.extend(
                doc.execute("timeline.place", json!({"item":source,"track":track,"audioTrack":audio,"time":t*254_016_000_000i64})).unwrap()["clips"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| c.as_u64().unwrap()),
            );
        }
    }
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let q = project.sequence(ItemId(sequence)).unwrap();
    for target_mode in 0..3 {
        if target_mode != 0 {
            for track in ["V1", "V2", "V3", "A1", "A2", "A3"] {
                doc.execute("timeline.setTargeting", json!({"track":track,"targeted":target_mode==1 && track.starts_with('V')})).unwrap();
            }
        }
        for linked in [false, true] {
            doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
            for selected in [vec![], vec![ids[0]], vec![ids[2]], vec![ids[4]], vec![ids[0], ids[4]], vec![ids[2], ids[8]], ids.clone()] {
                doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                for at in [0, 254_016_000_000i64, 762_048_000_000i64] {
                    doc.execute("playhead.set", json!({"time":at})).unwrap();
                    let at = q.settings.frame_rate.snap(kition_film_time::Tick(at)).0;
                    for &(command, path) in PATHS {
                        assert!(compared_path(command, path));
                        let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                        assert!(
                            spec.enabled
                                && spec.mutates
                                && spec.targets.is_none()
                                && spec.objects.is_empty()
                                && spec.object_types.is_empty()
                                && spec.places.is_empty()
                        );
                        assert_eq!(spec.reads, vec![EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Mode, EditorState::Active]);
                        assert_eq!(
                            normalized(doc.under(command, &json!({})).unwrap().unwrap()),
                            normalized(expected(sequence, q, &selected, target_mode, linked, at, command)),
                            "{command}/selection={selected:?}/targets={target_mode}/linked={linked}/at={at}"
                        );
                    }
                }
            }
        }
    }
}
