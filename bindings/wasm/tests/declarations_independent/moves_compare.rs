//! keyboard.rs:225-270 computes moves from selected starts and track neighbours;
//! edit/lib.rs:477-501 overwrites destinations and drops attached transitions.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, Project, TrackKind};
use kition_film_kit::FilmDocument;
use kition_kit::{ContentPremise, EditorState, KitDocument, Premise, TimeSpan, Under, Within};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("timeline.nudgeLeft", "move in time"),
    ("timeline.nudgeRight", "move in time"),
    ("timeline.nudgeLeft5", "move in time"),
    ("timeline.nudgeRight5", "move in time"),
    ("timeline.nudgeUp", "move track"),
    ("timeline.nudgeDown", "move track"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path)) && hash(include_str!("../../../../crates/engine/engine/src/keyboard.rs")) == 0xc4c1cfffb8e70cd9
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-selection-state", "clip-owner-position", "unused-move-link"];
    if !matches!(command, "timeline.nudgeUp" | "timeline.nudgeDown") {
        out.push("coarse-mode-state");
    } else {
        out.push("whole-track-order");
    }
    out
}
fn leaf(id: u64, fields: impl IntoIterator<Item = &'static str>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn expected(project: &Project, sequence: u64, selected: &[u64], command: &str, linked: bool) -> Under {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let vertical = matches!(command, "timeline.nudgeUp" | "timeline.nudgeDown");
    let mut ids = selected.to_vec();
    if linked && !vertical {
        for id in selected {
            if let Some(group) = q.all_tracks().flat_map(|t| &t.items).find(|c| c.id.0 == *id).and_then(|c| c.link) {
                for c in q.all_tracks().flat_map(|t| &t.items).filter(|c| c.link == Some(group)) {
                    if !ids.contains(&c.id.0) {
                        ids.push(c.id.0);
                    }
                }
            }
        }
    }
    let mut want = Under::default();
    for id in &ids {
        want.premises.push(Premise::on(json!(id)).fields(["link"]));
    }
    let delta = if vertical {
        0
    } else {
        want.premises.push(leaf(sequence, ["sequence.settings.settings.frame_rate"]));
        if linked {
            for id in selected {
                want.premises.push(leaf(*id, ["link", "~linkedGroup"]));
                if let Some(group) = q.all_tracks().flat_map(|t| &t.items).find(|c| c.id.0 == *id).and_then(|c| c.link) {
                    let root = q.all_tracks().flat_map(|t| &t.items).filter(|c| c.link == Some(group)).map(|c| c.id.0).min().unwrap();
                    want.premises.push(leaf(root, ["~linkedMembers"]));
                }
            }
        }
        let frames = match command {
            "timeline.nudgeLeft" => -1,
            "timeline.nudgeRight" => 1,
            "timeline.nudgeLeft5" => -5,
            _ => 5,
        };
        let first = q.all_tracks().flat_map(|t| &t.items).filter(|c| ids.contains(&c.id.0)).map(|c| c.start.0).min().unwrap_or(0);
        q.settings.frame_rate.tick_of(frames).0.max(-first)
    };
    if !vertical && delta == 0 {
        return want;
    }
    let mut moves = Vec::new();
    let mut invalid = false;
    for id in &ids {
        let (owner, clip) = q.all_tracks().find_map(|t| t.items.iter().find(|c| c.id.0 == *id).map(|c| (t, c))).unwrap();
        let destination = if vertical {
            let tracks = if owner.kind == TrackKind::Video { &q.video_tracks } else { &q.audio_tracks };
            want.premises.push(leaf(sequence, [if owner.kind == TrackKind::Video { "~videoTrackOrder" } else { "~audioTrackOrder" }]));
            want.premises.push(leaf(owner.id.0, ["props.kind"]));
            let at = tracks.iter().position(|t| t.id == owner.id).unwrap();
            let forward = (owner.kind == TrackKind::Video) == (command == "timeline.nudgeUp");
            (if forward { at.checked_add(1) } else { at.checked_sub(1) }).and_then(|n| tracks.get(n))
        } else {
            Some(owner)
        };
        if let Some(destination) = destination {
            moves.push((owner, clip, destination, clip.start.0 + delta));
            if !vertical {
                want.content.push(ContentPremise { id: json!(id), field: "start".into(), region: json!("keyboard-assigned-start") });
            }
        } else {
            invalid = true;
        }
    }
    if invalid || moves.is_empty() {
        return want;
    }
    let mut affected = ids.clone();
    for (owner, clip, destination, at) in &moves {
        if !vertical {
            want.premises.push(Premise::on(json!(clip.id.0)).fields(["start"]));
        }
        for track in [owner, destination] {
            want.premises.push(leaf(track.id.0, ["props.locked"]));
        }
        let from = destination.items.iter().take_while(|c| c.end().0 <= *at).count();
        let to = destination.items.iter().take_while(|c| c.start.0 < at + clip.duration.0).count().max(from);
        for item in &destination.items[from..to] {
            affected.push(item.id.0);
            want.objects.push(json!(item.id.0));
        }
        want.within.push(Within {
            parent: json!(destination.id.0),
            field: "clips".into(),
            from,
            to,
            time: Some(TimeSpan {
                from: json!(at.to_string()),
                to: json!((at + clip.duration.0).to_string()),
                start: "start".into(),
                duration: Some("duration".into()),
                ..Default::default()
            }),
        });
    }
    want.objects.sort_by_key(|v| v.as_u64().unwrap());
    want.objects.dedup();
    for t in q.all_tracks() {
        for transition in &t.transitions {
            if [transition.from, transition.to].into_iter().flatten().any(|c| affected.contains(&c.0)) {
                want.premises.push(Premise::on(json!(transition.id.0)));
            }
        }
    }
    want
}
#[test]
fn keyboard_moves_compare_every_direction_links_boundaries_and_destination_overwrites() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newBarsAndTone", json!({"seconds":3})).unwrap()["item"].clone();
    let mut selected = Vec::new();
    for (video, audio, time) in [("V1", "A1", 0), ("V2", "A2", 1_016_064_000_000i64)] {
        selected.push(doc.execute("timeline.place", json!({"item":item,"track":video,"audioTrack":audio,"time":time})).unwrap()["clips"][0].as_u64().unwrap());
    }
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for linked in [false, true] {
        doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
        for ids in [vec![], vec![selected[0]], vec![selected[1]], selected.clone()] {
            doc.execute("timeline.select", json!({"clips":ids,"linked":false})).unwrap();
            for &(command, path) in PATHS {
                assert!(compared_path(command, path));
                let vertical = matches!(command, "timeline.nudgeUp" | "timeline.nudgeDown");
                let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                assert_eq!(
                    spec.reads,
                    if vertical { vec![EditorState::Part, EditorState::Selection] } else { vec![EditorState::Part, EditorState::Selection, EditorState::Mode] }
                );
                assert!(spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.places.is_empty());
                assert_eq!(spec.enabled, !ids.is_empty());
                assert_eq!(
                    normalized(doc.under(command, &json!({})).unwrap().unwrap()),
                    normalized(expected(&project, sequence, &ids, command, linked)),
                    "{command}/{ids:?}/{linked}"
                );
            }
        }
    }
}
