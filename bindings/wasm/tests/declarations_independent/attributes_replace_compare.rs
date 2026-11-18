//! clip_ops.rs:1074-1141,1740-1827: attributes copy/reset effects,
//! replacements copy a source route and expand linked targets. Paste chooses
//! the clipboard stream by the target owner's kind; replacement validates locks.
use super::{sound_paths_compare::source, source_inputs_compare::dimensions, sync_compare::normalized};
use kition_film_engine::project::{ClipId, ItemId, ItemKind, Project, Sequence, TrackKind};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::{Value, json};

pub const PATHS: &[(&str, &str)] = &[
    ("edit.pasteAttributes", "linked targets"),
    ("edit.removeAttributes", "linked targets"),
    ("clip.replaceFromSource", "replacement target expansion"),
    ("clip.replaceFromSourceMatchFrame", "replacement target expansion"),
    ("clip.replaceFromBin", "replacement target expansion"),
    ("clip.replaceFromSourceMatchFrame", "match-frame calculation"),
    ("clip.replaceFromBin", "keepSourceIn"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    PATHS.contains(&(command, path))
        && include_str!("../../../../crates/engine/engine/src/clip_ops.rs")
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3))
            == 0x973a242360050d16
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-selection-state", "coarse-mode-state", "unconsumed-selection", "whole-effect-profile"];
    if command == "edit.pasteAttributes" {
        out.push("clip-owner-position");
    }
    if command.starts_with("clip.") {
        out.extend(["coarse-source-profile", "coarse-active-state", "unused-source-label", "clip-owner-position"]);
    }
    out
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
pub(super) fn operands(q: &Sequence, base: &[u64], linked: bool, want: &mut Under) -> Vec<u64> {
    let mut ids = base.to_vec();
    if linked {
        for id in base {
            want.premises.push(leaf(*id, ["link", "~linkedGroup"]));
            if let Some(link) = q.find_item(ClipId(*id)).and_then(|(_, c)| c.link) {
                let peers: Vec<_> = q.all_tracks().flat_map(|t| &t.items).filter(|c| c.link == Some(link)).map(|c| c.id.0).collect();
                want.premises.push(leaf(*peers.iter().min().unwrap(), ["~linkedMembers"]));
                ids.extend(peers);
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}
fn expected(project: &Project, sequence: u64, command: &str, base: &[u64], linked: bool, from: ItemId, implicit_bin: bool) -> Under {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let mut want = Under::default();
    let ids = operands(q, base, linked, &mut want);
    if command.starts_with("edit.") {
        let paste = command == "edit.pasteAttributes";
        for id in ids {
            let Some((owner, clip)) = q.find_item(ClipId(id)) else { continue };
            if paste {
                want.premises.push(leaf(id, ["effects", "sourceIn", "speed"]).positions(["duration", "clips"]));
                want.premises.push(leaf(owner.0, ["props.kind"]));
            } else {
                want.premises.push(leaf(id, ["effects", "item"]));
                dimensions(project, sequence, clip.item, &mut want);
            }
        }
        if !paste {
            want.premises.push(leaf(sequence, ["sequence.settings.settings.width", "sequence.settings.settings.height"]));
        }
    } else {
        let bin = command == "clip.replaceFromBin";
        if implicit_bin && bin {
            want.premises.push(leaf(from.0, ["kind"]));
        }
        source(&mut want, project, from);
        want.premises.push(leaf(from.0, ["name", "props.common.label"]));
        if matches!(project.item(from).unwrap().kind, ItemKind::Sequence(_)) {
            want.premises.push(leaf(from.0, ["duration", "sequence.settings.mark_in", "sequence.settings.mark_out", "sequence.settings.settings.frame_rate"]));
        }
        want.premises.push(leaf(sequence, ["sequence.settings.settings.frame_rate"]));
        let (video, audio) = if let Some((_, media, _)) = project.resolve_media(from) {
            (media.info.has_video(), media.info.has_audio())
        } else {
            let item = project.item(from).unwrap();
            (item.has_video(), item.has_audio())
        };
        for id in ids {
            let Some((owner, _)) = q.find_item(ClipId(id)) else { continue };
            let track = q.track(owner).unwrap();
            want.premises.push(leaf(owner.0, ["props.kind", "props.locked"]));
            let accepts = if track.kind == TrackKind::Video { video } else { audio };
            let mut fields = Vec::new();
            let mut positions = vec!["clips"];
            if accepts {
                fields.extend(["item", "sourceIn", "props.name", "props.label", "props.frame_hold", "props.multicam", "speed"]);
                if track.kind == TrackKind::Audio {
                    fields.push("props.source_channels");
                }
                positions.push("duration");
                if command == "clip.replaceFromSourceMatchFrame" {
                    positions.push("start");
                }
            }
            want.premises.push(leaf(id, fields).positions(positions));
        }
    }
    want
}
#[test]
fn attributes_and_replacements_compare_links_stream_eligibility_source_routes_and_parameter_masks() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let parent = doc.execute("file.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let sub = doc.execute("clip.makeSubclip", json!({"item":parent,"start":0,"end":254_016_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let silent = doc.execute("file.newColorMatte", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let clips: Vec<_> = doc.execute("timeline.place", json!({"item":parent,"track":"V1","time":0})).unwrap()["clips"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_u64)
        .collect();
    doc.execute("timeline.select", json!({"clips":clips,"linked":false})).unwrap();
    doc.execute("edit.copy", json!({})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    for linked in [false, true] {
        doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
        for selected in [vec![], vec![clips[0]], vec![clips[1]], clips.clone()] {
            doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
            for from in [parent, sub, silent, sequence] {
                doc.execute("source.open", json!({"item":from})).unwrap();
                doc.execute("project.select", json!({"items":[from]})).unwrap();
                for &(command, path) in PATHS {
                    assert!(compared_path(command, path));
                    let spec = doc.commands().into_iter().find(|s| s.id == command).unwrap();
                    let attribute = command.starts_with("edit.");
                    assert!(spec.mutates && spec.places.is_empty());
                    assert_eq!(spec.targets, attribute.then_some("clips"));
                    assert_eq!(spec.objects, if attribute { vec![] } else { vec!["clips", "item"] });
                    assert_eq!(
                        spec.object_types,
                        if attribute { vec![("clips", &["Clip"][..])] } else { vec![("clips", &["Clip"][..]), ("item", &["Item"][..])] }
                    );
                    let mut reads = vec![EditorState::Part, EditorState::Selection];
                    if command == "clip.replaceFromSourceMatchFrame" {
                        reads.push(EditorState::Time);
                    }
                    reads.push(EditorState::Mode);
                    if !attribute && command != "clip.replaceFromBin" {
                        reads.push(EditorState::Active);
                    }
                    assert_eq!(spec.reads, reads);
                    assert_eq!(spec.enabled, !selected.is_empty());
                    assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                    for targets in [None, Some(json!([])), Some(json!(clips)), Some(json!([clips[0] as f64]))] {
                        for explicit in [false, true] {
                            for mask in 0..8 {
                                let mut p = json!({"motion":mask&1!=0,"effects":mask&2!=0,"scaleTimes":mask&4!=0,"keepSourceIn":mask&1!=0});
                                if let Some(ids) = &targets {
                                    p["clips"] = ids.clone();
                                }
                                if explicit {
                                    p["item"] = json!(from);
                                }
                                let base = targets
                                    .as_ref()
                                    .map(|v| v.as_array().unwrap().iter().filter_map(Value::as_u64).collect())
                                    .unwrap_or_else(|| selected.clone());
                                assert_eq!(
                                    normalized(doc.under(command, &p).unwrap().unwrap()),
                                    normalized(expected(&project, sequence, command, &base, linked, ItemId(from), !explicit)),
                                    "{command}/{p}/selected={selected:?}/linked={linked}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}
