//! keyboard.rs:169-212,265-274; clip_ops.rs:1489-1546;
//! trim.rs:237-280,339-358; edit/lib.rs:792-864. Edge searches do not
//! consume appearance on distant clips. Only copied/deleted recipients need it.
use super::sync_compare::normalized;
use kition_film_engine::project::{ClipId, ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_film_time::Tick;
use kition_kit::{KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("timeline.rateStretch", "stretch"),
    ("timeline.slideLeft", "slide between neighbors"),
    ("timeline.slideRight", "slide between neighbors"),
    ("timeline.slideLeft5", "slide between neighbors"),
    ("timeline.slideRight5", "slide between neighbors"),
    ("trim.extendPreviousEdit", "nearest edit before/after playhead"),
    ("trim.extendNextEdit", "nearest edit before/after playhead"),
    ("clip.frameHold", "named/selected/timed fallback"),
    ("clip.insertFrameHoldSegment", "named/selected/timed fallback"),
    ("trim.applyDefaultTransition", "selected edges"),
    ("trim.ripplePrevious", "selected-under / targeted-under"),
    ("trim.rippleNext", "selected-under / targeted-under"),
    ("trim.previous", "selected-under / targeted-under"),
    ("trim.next", "selected-under / targeted-under"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
}
pub fn more(_: &str) -> Vec<&'static str> {
    vec![
        "all-candidate-lane-edges",
        "unused-lane-geometry-fields",
        "whole-lane-transition-list",
        "whole-edit-timebase",
        "coarse-selection-state",
        "coarse-mode-state",
    ]
}
fn leaf(id: u64, fields: &[&str]) -> Premise {
    Premise::on(json!(id)).fields(fields.iter().copied()).positions(Vec::<String>::new())
}
fn bounds(project: &Project, mut id: ItemId, want: &mut Under) {
    for _ in 0..=16 {
        let item = project.item(id).unwrap();
        let (fields, next) = match &item.kind {
            ItemKind::Subclip { parent, restrict_trims, .. } => (
                if *restrict_trims { vec!["kind", "props.restrict_trims", "props.range"] } else { vec!["kind", "props.restrict_trims", "props.parent"] },
                if *restrict_trims { None } else { Some(*parent) },
            ),
            ItemKind::Media(media) => (
                if matches!(media.info.kind, kition_film_media::MediaKind::Still | kition_film_media::MediaKind::Synthetic) {
                    vec!["kind", "props.media.info.kind"]
                } else {
                    vec!["kind", "props.media.info.kind", "props.media.info.duration"]
                },
                None,
            ),
            ItemKind::Sequence(_) => (vec!["kind", "sequence.duration"], None),
            _ => (vec!["kind"], None),
        };
        want.premises.push(leaf(id.0, &fields));
        let Some(next) = next else { break };
        id = next;
    }
}
fn expected(
    project: &Project,
    seq: u64,
    command: &str,
    selection: &[u64],
    params: &Value,
    targeted: &[u64],
    linked: bool,
    ph: Tick,
    points: &[(u64, bool)],
) -> Under {
    let q = project.sequence(ItemId(seq)).unwrap();
    let slides = command.starts_with("timeline.slide");
    let stretch = command == "timeline.rateStretch";
    let extend = command.starts_with("trim.extend");
    let trim = matches!(command, "trim.previous" | "trim.next" | "trim.ripplePrevious" | "trim.rippleNext");
    let hold = command.starts_with("clip.");
    let transition = command == "trim.applyDefaultTransition";
    let mut want = Under { premises: vec![leaf(seq, &["sequence.settings.settings.frame_rate"])], ..Default::default() };
    if params.get("timecode").is_some() {
        want.premises.push(leaf(seq, &["sequence.settings.settings.drop_frame"]));
    }
    let named = if stretch { params.get("clip").and_then(Value::as_u64).into_iter().collect::<Vec<_>>() } else { selection.to_vec() };
    let mut selected = named.clone();
    if linked {
        for id in &named {
            if let Some(group) = q.find_item(ClipId(*id)).and_then(|(_, clip)| clip.link) {
                selected.extend(q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(group)).map(|clip| clip.id.0));
            }
            if slides || stretch || trim {
                want.premises.push(leaf(*id, &["link", "~linkedGroup"]));
                if let Some(group) = q.find_item(ClipId(*id)).and_then(|(_, clip)| clip.link) {
                    let root = q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(group)).map(|clip| clip.id.0).min().unwrap();
                    want.premises.push(leaf(root, &["~linkedMembers"]));
                }
            }
        }
    }
    if extend || trim || hold {
        want.premises.push(leaf(seq, &["~videoTrackOrder", "~audioTrackOrder", "~submixTrackOrder"]));
    }
    for track in q.all_tracks() {
        let candidate = if slides || stretch {
            track.items.iter().any(|clip| selected.contains(&clip.id.0))
        } else if extend {
            targeted.contains(&track.id.0)
        } else if transition {
            points.iter().any(|(id, _)| track.item(ClipId(*id)).is_some())
        } else {
            true
        };
        if !candidate {
            continue;
        }
        want.premises.push(leaf(track.id.0, &["~editEdges", "props.locked", "props.sync_lock", "transitions"]));
        for clip in &track.items {
            want.premises.push(Premise::on(json!(clip.id.0)).fields(["item", "sourceIn", "speed", "reverse", "link", "props.frame_hold"]).positions(["clips"]));
            if slides || extend {
                bounds(project, clip.item, &mut want);
            }
        }
    }
    if hold {
        let at = params
            .get("time")
            .and_then(Value::as_i64)
            .map(Tick)
            .or_else(|| params.get("frame").and_then(Value::as_i64).map(|frame| q.settings.frame_rate.tick_of(frame)))
            .unwrap_or(ph);
        let scalar = params.get("clip").and_then(Value::as_u64);
        let many = params.get("clips").and_then(Value::as_array).map(|ids| ids.iter().filter_map(Value::as_u64).collect::<Vec<_>>());
        let wanted = many.clone().unwrap_or_else(|| scalar.map(|id| vec![id]).unwrap_or_else(|| selection.to_vec()));
        let pick = |id| q.video_tracks.iter().find_map(|track| track.item(ClipId(id)).filter(|clip| clip.start <= at && at < clip.end()).map(|clip| clip.id.0));
        let fallback =
            || q.video_tracks.iter().filter(|track| targeted.contains(&track.id.0) && !track.locked).find_map(|track| track.item_at(at).map(|clip| clip.id.0));
        let ids = if command == "clip.frameHold" {
            let mut ids: Vec<_> = wanted.iter().filter_map(|id| pick(*id)).collect();
            if ids.is_empty() && params.get("clip").is_none() && params.get("clips").is_none() {
                ids.extend(fallback());
            }
            ids
        } else {
            scalar
                .and_then(pick)
                .or_else(|| selection.iter().find_map(|id| pick(*id)))
                .or_else(|| if scalar.is_none() { fallback() } else { None })
                .into_iter()
                .collect()
        };
        want.premises.extend(ids.into_iter().map(|id| Premise::on(json!(id))));
        if command == "clip.insertFrameHoldSegment" {
            want.premises.push(leaf(seq, &["sequence.captionTracks", "sequence.captions"]));
        }
    }
    if trim {
        let mut tracks: Vec<_> = q
            .video_tracks
            .iter()
            .chain(&q.audio_tracks)
            .filter(|track| !track.locked && track.items.iter().any(|clip| selected.contains(&clip.id.0) && clip.start < ph && ph < clip.end()))
            .map(|track| track.id)
            .collect();
        if tracks.is_empty() {
            tracks = q
                .video_tracks
                .iter()
                .chain(&q.audio_tracks)
                .filter(|track| !track.locked && targeted.contains(&track.id.0) && track.items.iter().any(|clip| clip.start < ph && ph < clip.end()))
                .map(|track| track.id)
                .collect();
        }
        let next = matches!(command, "trim.next" | "trim.rippleNext");
        let edges = q.all_tracks().filter(|track| tracks.contains(&track.id)).flat_map(|track| track.items.iter().flat_map(|clip| [clip.start, clip.end()]));
        let edge = if next { edges.filter(|edge| *edge > ph).min() } else { edges.filter(|edge| *edge < ph).max() };
        if let Some(edge) = edge {
            let (a, b) = if next { (ph, edge) } else { (edge, ph) };
            for track in q.all_tracks().filter(|track| !track.locked && (tracks.contains(&track.id) || command.starts_with("trim.ripple") && track.sync_lock)) {
                want.premises.extend(track.items.iter().filter(|clip| clip.start < b && clip.end() > a).map(|clip| Premise::on(json!(clip.id.0))));
            }
        }
        if command.starts_with("trim.ripple") {
            want.premises.push(leaf(seq, &["sequence.captionTracks", "sequence.captions"]));
        }
    }
    if transition {
        for &(id, out) in points {
            let (owner, clip) = q.find_item(ClipId(id)).unwrap();
            let track = q.track(owner).unwrap();
            let index = track.items.iter().position(|clip| clip.id.0 == id).unwrap();
            let partner = if out {
                track.items.get(index + 1).filter(|next| next.start == clip.end())
            } else {
                index.checked_sub(1).and_then(|i| track.items.get(i)).filter(|prev| prev.end() == clip.start)
            };
            want.premises.push(Premise::on(json!(id)));
            if let Some(partner) = partner {
                want.premises.push(Premise::on(json!(partner.id.0)));
            }
            let (from, to) = if out { (Some(clip.id), partner.map(|clip| clip.id)) } else { (partner.map(|clip| clip.id), Some(clip.id)) };
            want.premises.extend(
                track
                    .transitions
                    .iter()
                    .filter(|transition| transition.from == from && transition.to == to)
                    .map(|transition| Premise::on(json!(transition.id.0))),
            );
        }
    }
    want
}
#[test]
fn geometry_commands_compare_empty_selections_link_modes_locked_lanes_and_explicit_targets() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let seq = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let item = doc.execute("file.newOfflineFile", json!({"seconds":4})).unwrap()["item"].clone();
    let mut clips = Vec::new();
    for at in 0..3 {
        clips.extend(
            doc.execute("timeline.place", json!({"item":item,"track":"V1","audioTrack":"A1","time":at*254_016_000_000i64,"duration":254_016_000_000i64}))
                .unwrap()["clips"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_u64),
        );
    }
    for linked in [false, true] {
        doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
        for locked in [false, true] {
            doc.execute("timeline.setTrack", json!({"track":"V1","locked":locked})).unwrap();
            let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
            let q = project.sequence(ItemId(seq)).unwrap();
            let targets: Vec<_> = q.all_tracks().map(|t| t.id.0).collect();
            for selected in [vec![clips[2]], vec![], clips.clone()] {
                doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
                for ph in [Tick(0), Tick(381_024_000_000)] {
                    doc.execute("playhead.set", json!({"time":ph.0})).unwrap();
                    for &(command, path) in PATHS {
                        assert!(compared_path(command, path));
                        assert!(doc.commands().into_iter().find(|s| s.id == command).unwrap().mutates);
                        for mut params in [
                            json!({"clip":clips[2],"edge":"in","delta":1}),
                            json!({}),
                            json!({"clip":clips[2],"time":381_024_000_000i64,"seconds":0.5}),
                            json!({"clips":[]}),
                        ] {
                            if command == "timeline.rateStretch" {
                                params["clip"] = json!(clips[2]);
                                params["edge"] = json!("in");
                                params["delta"] = json!(1);
                            }
                            assert_eq!(
                                normalized(doc.under(command, &params).unwrap().unwrap_or_default()),
                                normalized(expected(&project, seq, command, &selected, &params, &targets, linked, ph, &[])),
                                "{command}/{path}/{params}/{selected:?}/{linked}/{locked}"
                            );
                        }
                    }
                }
            }
            for points in [vec![(clips[2], false)], vec![(clips[2], true), (clips[3], false)]] {
                for (index, (id, out)) in points.iter().enumerate() {
                    doc.execute("trim.selectEditPoint", json!({"clip":id,"edge":if *out {"out"} else {"in"},"add":index>0})).unwrap();
                }
                assert_eq!(
                    normalized(doc.under("trim.applyDefaultTransition", &json!({})).unwrap().unwrap()),
                    normalized(expected(&project, seq, "trim.applyDefaultTransition", &[], &json!({}), &targets, linked, Tick(381_024_000_000), &points))
                );
                doc.execute("trim.clear", json!({})).unwrap();
            }
        }
    }
}
