//! trim.rs:196-235 delegates each edit point to timeline trim or roll.
//! edit/lib.rs:528-778 consumes source bounds and neighbours; a ripple also
//! reads lock/sync switches, linked groups and every shifted suffix position.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::json;

pub const COMMANDS: &[&str] = &["trim.nudge", "trim.backward", "trim.forward", "trim.backwardMany", "trim.forwardMany", "trim.extendToPlayhead"];
pub const KINDS: &[&str] = &["regular", "ripple", "roll"];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    COMMANDS.contains(&command)
        && KINDS.contains(&path)
        && hash(include_str!("../../../../crates/engine/engine/src/trim.rs")) == 0xe579fba58c4d0f68
        && hash(include_str!("../../../../crates/engine/engine/src/place.rs")) == 0x37ab576d200c6a94
        && hash(include_str!("../../../../crates/engine/engine/src/premise.rs")) == 0xdbc9fd51b8b10958
}
pub fn more(path: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-active-state", "coarse-mode-state", "whole-trim-lane-order", "clip-owner-position"];
    if path == "roll" {
        out.extend(["whole-trim-transition-list", "unused-roll-clip-fields"]);
    } else {
        out.push("whole-trim-neighbour-positions");
    }
    out
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
pub(super) fn source_limits(project: &Project, mut id: ItemId, want: &mut Under) {
    for _ in 0..=16 {
        match &project.item(id).unwrap().kind {
            ItemKind::Subclip { parent, restrict_trims, .. } => {
                want.premises
                    .push(leaf(id.0, if *restrict_trims { vec!["props.restrict_trims", "props.range"] } else { vec!["props.restrict_trims", "props.parent"] }));
                if *restrict_trims {
                    break;
                }
                id = *parent;
            }
            ItemKind::Media(media) => {
                let mut fields = vec!["props.media.info.kind"];
                if !matches!(media.info.kind, kition_film_media::MediaKind::Still | kition_film_media::MediaKind::Synthetic) {
                    fields.push("props.media.info.duration");
                }
                want.premises.push(leaf(id.0, fields));
                break;
            }
            ItemKind::Sequence(_) => {
                want.premises.push(leaf(id.0, ["sequence.duration"]));
                break;
            }
            ItemKind::AdjustmentLayer { .. } | ItemKind::Graphic { .. } => break,
        }
    }
}

fn expected(project: &Project, sequence: u64, point: u64, out: bool, kind: &str, linked: bool, markers: bool) -> Under {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let (owner, clip) = q.all_tracks().find_map(|track| track.items.iter().find(|clip| clip.id.0 == point).map(|clip| (track, clip))).unwrap();
    let mut want = Under { premises: vec![leaf(sequence, ["sequence.settings.settings.frame_rate"])], ..Default::default() };
    let mut targets = vec![point];
    if kind == "roll" {
        let index = owner.items.iter().position(|clip| clip.id.0 == point).unwrap();
        let partner = if out { owner.items.get(index + 1) } else { index.checked_sub(1).and_then(|i| owner.items.get(i)) };
        let Some(partner) = partner.filter(|partner| if out { clip.end() == partner.start } else { partner.end() == clip.start }) else {
            want.premises.push(leaf(point, Vec::<String>::new()).positions(["start", "duration", "clips"]));
            want.premises.push(leaf(owner.id.0, ["~clipOrder"]));
            return want;
        };
        targets.push(partner.id.0);
        want.premises.push(leaf(owner.id.0, ["transitions"]));
    } else if linked && clip.link.is_some() {
        targets = q.all_tracks().flat_map(|track| &track.items).filter(|candidate| candidate.link == clip.link).map(|clip| clip.id.0).collect();
    }
    for target in &targets {
        let (owner, clip) = q.all_tracks().find_map(|track| track.items.iter().find(|clip| clip.id.0 == *target).map(|clip| (track, clip))).unwrap();
        source_limits(project, clip.item, &mut want);
        let target = leaf(*target, ["item", "sourceIn", "speed", "reverse", "link", "props.frame_hold"]);
        want.premises.push(if kind == "roll" { target.positions(["start", "duration", "clips"]) } else { Premise { positions: None, ..target } });
        want.premises.push(leaf(owner.id.0, ["~clipOrder"]));
    }
    if kind != "roll" {
        let first = q.all_tracks().flat_map(|track| &track.items).filter(|clip| targets.contains(&clip.id.0)).map(|clip| clip.start.0).min().unwrap();
        let at = first.saturating_sub(1).max(0);
        let mut affected = Vec::new();
        for track in q.all_tracks() {
            let member = track.items.iter().any(|clip| targets.contains(&clip.id.0));
            if !member && (kind != "ripple" || track.locked || !track.sync_lock) {
                continue;
            }
            let mut from = track.items.partition_point(|clip| clip.end().0 <= at);
            let mut to = track.items.len();
            if kind != "ripple" {
                let first_target = track.items.iter().position(|clip| targets.contains(&clip.id.0)).unwrap();
                from = from.min(first_target.saturating_sub(1));
                let last = track.items.iter().rposition(|clip| targets.contains(&clip.id.0)).unwrap();
                to = to.min(last + 2);
            }
            affected.extend(track.items[from..to].iter().map(|clip| clip.id));
            for clip in &track.items[from..to] {
                if !targets.contains(&clip.id.0) {
                    want.premises.push(Premise::on(json!(clip.id.0)).fields(["link"]));
                }
            }
        }
        for track in q.all_tracks() {
            want.premises.push(leaf(track.id.0, ["props.locked", "props.sync_lock"]));
            for transition in track
                .transitions
                .iter()
                .filter(|transition| transition.from.is_some_and(|id| affected.contains(&id)) || transition.to.is_some_and(|id| affected.contains(&id)))
            {
                want.premises.push(Premise::on(json!(transition.id.0)));
            }
        }
        if markers {
            want.premises.push(leaf(sequence, ["sequence.markers"]));
        }
        if linked {
            want.premises.push(leaf(point, ["link", "~linkedGroup"]));
            if let Some(group) = clip.link {
                let root = q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(group)).map(|clip| clip.id.0).min().unwrap();
                want.premises.push(leaf(root, ["~linkedMembers"]));
            }
        }
    }
    want
}

#[test]
fn selected_trim_edits_compare_all_wrappers_kinds_edges_links_marker_modes_and_missing_roll_partners() {
    for source_kind in ["synthetic", "finite", "restricted", "open", "adjustment", "sequence"] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let nested = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        let finite = doc.execute("file.newOfflineFile", json!({"seconds":8})).unwrap()["item"].clone();
        doc.execute("timeline.place", json!({"item":finite,"track":"V1","time":0})).unwrap();
        let sequence = doc.execute("file.newSequence", json!({"name":"Outer"})).unwrap()["sequence"].as_u64().unwrap();
        let source = match source_kind {
            "synthetic" => doc.execute("file.newBarsAndTone", json!({"seconds":4})).unwrap()["item"].clone(),
            "restricted" | "open" => doc
                .execute("clip.makeSubclip", json!({"item":finite,"start":0,"end":1_016_064_000_000i64,"restrictTrims":source_kind=="restricted"}))
                .unwrap()["item"]
                .clone(),
            "adjustment" => doc.execute("file.newAdjustmentLayer", json!({"seconds":4})).unwrap()["item"].clone(),
            "sequence" => json!(nested),
            _ => finite,
        };
        let first = doc.execute("timeline.place", json!({"item":source,"track":"V1","audioTrack":"A1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
        let second = doc.execute("timeline.razor", json!({"clip":first,"time":254_016_000_000i64})).unwrap()["clips"][0].as_u64().unwrap();
        doc.execute("timeline.razor", json!({"clip":second,"time":508_032_000_000i64})).unwrap();
        doc.execute("sequence.applyVideoTransition", json!({"clip":second,"edge":"in","frames":8})).unwrap();
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        for linked in [false, true] {
            doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
            for markers in [false, true] {
                doc.execute("markers.rippleSequenceMarkers", json!({"on":markers})).unwrap();
                for point in [None, Some(first), Some(second)] {
                    for out in [false, true] {
                        for &kind in KINDS {
                            if doc.commands().iter().any(|spec| spec.id == "trim.clear" && spec.enabled) {
                                doc.execute("trim.clear", json!({})).unwrap();
                            }
                            if let Some(point) = point {
                                doc.execute(
                                    "trim.selectEditPoint",
                                    json!({"clip":point,"edge":if out {"out"} else {"in"},"kind":if kind == "regular" {"trim"} else {kind}}),
                                )
                                .unwrap();
                            }
                            for &command in COMMANDS {
                                assert!(compared_path(command, kind));
                                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                                let mut reads = vec![EditorState::Part];
                                if command == "trim.extendToPlayhead" {
                                    reads.push(EditorState::Time);
                                }
                                reads.extend([EditorState::Mode, EditorState::Active]);
                                assert_eq!(spec.reads, reads, "{command}");
                                assert!(
                                    spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty()
                                );
                                assert_eq!(spec.enabled, point.is_some());
                                let want = point.map(|point| expected(&project, sequence, point, out, kind, linked, markers)).unwrap_or_else(|| Under {
                                    premises: vec![leaf(sequence, ["sequence.settings.settings.frame_rate"])],
                                    ..Default::default()
                                });
                                for frames in [-5, -1, 1, 5] {
                                    assert_eq!(
                                        normalized(doc.under(command, &json!({"frames":frames})).unwrap().unwrap()),
                                        normalized(want.clone()),
                                        "{command}/{kind}/point={point:?}/out={out}/linked={linked}/markers={markers}"
                                    );
                                }
                            }
                        }
                    }
                }
                doc.execute("trim.selectEditPoint", json!({"clip":first,"edge":"out","kind":"roll"})).unwrap();
                doc.execute("trim.selectEditPoint", json!({"clip":second,"edge":"out","kind":"ripple","add":true})).unwrap();
                let mut want = expected(&project, sequence, first, true, "roll", linked, markers);
                want.premises.extend(expected(&project, sequence, second, true, "ripple", linked, markers).premises);
                for &command in COMMANDS {
                    assert_eq!(
                        normalized(doc.under(command, &json!({"frames":2})).unwrap().unwrap()),
                        normalized(want.clone()),
                        "multiple edit points/{command}/{source_kind}"
                    );
                }
            }
        }
    }
}
