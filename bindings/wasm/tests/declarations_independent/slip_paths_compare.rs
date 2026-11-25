//! commands.rs:2515-2525, keyboard.rs:267-290 and edit/lib.rs:779-790:
//! sourceIn, source bounds and duration determine the slip; the keyboard
//! converts sequence frames through speed while the direct form accepts ticks.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, ItemKind, Project};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("timeline.slip", "source-slip"),
    ("timeline.slipLeft", "slip source"),
    ("timeline.slipRight", "slip source"),
    ("timeline.slipLeft5", "slip source"),
    ("timeline.slipRight5", "slip source"),
];
pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |s: &str| s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0xa5f7dd875311a060
        && hash(include_str!("../../../../crates/engine/engine/src/keyboard.rs")) == 0xc4c1cfffb8e70cd9
        && hash(include_str!("../../../../crates/engine/engine/src/lib.rs")) == 0x12037cc25ba5d4c9
}
pub fn more(command: &str) -> Vec<&'static str> {
    let mut out = vec!["coarse-mode-state"];
    if command != "timeline.slip" {
        out.push("coarse-selection-state");
    }
    out
}
fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}
fn bounds(project: &Project, id: ItemId, want: &mut Under) {
    let mut current = id;
    for _ in 0..=16 {
        let item = project.item(current).unwrap();
        let (fields, next) = match &item.kind {
            ItemKind::Subclip { restrict_trims: true, .. } => (vec!["kind", "props.restrict_trims", "props.range"], None),
            ItemKind::Subclip { parent, .. } => (vec!["kind", "props.restrict_trims", "props.parent"], Some(*parent)),
            ItemKind::Media(media) => {
                let mut fields = vec!["kind", "props.media.info.kind"];
                if !matches!(media.info.kind, kition_film_media::MediaKind::Still | kition_film_media::MediaKind::Synthetic) {
                    fields.push("props.media.info.duration");
                }
                (fields, None)
            }
            ItemKind::Sequence(_) => (vec!["kind", "sequence.duration"], None),
            _ => (vec!["kind"], None),
        };
        want.premises.push(leaf(current.0, fields));
        if let Some(next) = next {
            current = next;
        } else {
            break;
        }
    }
}

#[test]
fn slips_compare_all_keys_link_closures_restricted_routes_frame_holds_and_delta_units() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let nested = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
    let finite = doc.execute("item.newOfflineFile", json!({"name":"Finite","seconds":4})).unwrap()["item"].as_u64().unwrap();
    doc.execute("timeline.place", json!({"item":finite,"track":"V1","time":0})).unwrap();
    let restricted = doc.execute("clip.makeSubclip", json!({"item":finite,"start":0,"end":762_048_000_000i64})).unwrap()["item"].as_u64().unwrap();
    let open =
        doc.execute("clip.makeSubclip", json!({"item":restricted,"start":0,"end":508_032_000_000i64,"restrictTrims":false})).unwrap()["item"].as_u64().unwrap();
    let tone = doc.execute("item.newBarsAndTone", json!({"seconds":4})).unwrap()["item"].as_u64().unwrap();
    let adjustment = doc.execute("item.newAdjustmentLayer", json!({"seconds":2})).unwrap()["item"].as_u64().unwrap();
    let sequence = doc.execute("sequence.new", json!({"name":"Outer"})).unwrap()["sequence"].as_u64().unwrap();
    let mut clips = Vec::new();
    for (index, item) in [finite, restricted, open, tone, adjustment, nested].into_iter().enumerate() {
        let placed = doc
            .execute("timeline.place", json!({"item":item,"track":"V1","audioTrack":"A1","time":index as i64*762_048_000_000i64,"duration":254_016_000_000i64}))
            .unwrap();
        clips.extend(placed["clips"].as_array().unwrap().iter().map(|clip| clip.as_u64().unwrap()));
    }
    doc.execute("clip.frameHoldOptions", json!({"clip":clips[0],"enabled":true,"holdOn":"in"})).unwrap();
    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
    let q = project.sequence(ItemId(sequence)).unwrap();
    for linked in [false, true] {
        doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
        for selected in [vec![], vec![clips[0]], vec![clips[1]], vec![clips[2], clips[3]], clips.clone()] {
            doc.execute("timeline.select", json!({"clips":selected,"linked":false})).unwrap();
            for &(command, path) in PATHS {
                assert!(compared_path(command, path));
                let direct = command == "timeline.slip";
                let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                assert!(spec.mutates && spec.objects.is_empty() && spec.places.is_empty());
                assert_eq!(spec.enabled, direct || !selected.is_empty());
                assert_eq!(spec.targets, direct.then_some("clip"));
                assert_eq!(spec.object_types, if direct { vec![("clip", &["Clip"][..])] } else { vec![] });
                assert_eq!(
                    spec.reads,
                    if direct { vec![EditorState::Part, EditorState::Mode] } else { vec![EditorState::Part, EditorState::Selection, EditorState::Mode] }
                );
                assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed);
                for clip in &clips {
                    for ticks in [false, true] {
                        let params =
                            if direct { if ticks { json!({"clip":clip,"delta":10}) } else { json!({"clip":clip,"deltaFrames":2}) } } else { json!({}) };
                        let base = if direct { vec![*clip] } else { selected.clone() };
                        let mut targets = base.clone();
                        let mut want = Under::default();
                        if !direct || !ticks {
                            want.premises.push(leaf(sequence, ["sequence.settings.settings.frame_rate"]));
                        }
                        if linked {
                            for id in &base {
                                want.premises.push(leaf(*id, ["link", "~linkedGroup"]));
                                if let Some(link) = q.all_tracks().flat_map(|track| &track.items).find(|clip| clip.id.0 == *id).and_then(|clip| clip.link) {
                                    let peers: Vec<_> =
                                        q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(link)).map(|clip| clip.id.0).collect();
                                    want.premises.push(leaf(*peers.iter().min().unwrap(), ["~linkedMembers"]));
                                    targets.extend(peers);
                                }
                            }
                        }
                        targets.sort();
                        targets.dedup();
                        for id in targets {
                            let clip = q.all_tracks().flat_map(|track| &track.items).find(|clip| clip.id.0 == id).unwrap();
                            want.premises.push(leaf(id, ["item", "sourceIn", "speed", "props.frame_hold", "link"]).positions(["duration"]));
                            if clip.frame_hold.is_none() {
                                bounds(&project, clip.item, &mut want);
                            }
                        }
                        assert_eq!(
                            normalized(doc.under(command, &params).unwrap().unwrap()),
                            normalized(want),
                            "{command}/{params}/selection={selected:?}/linked={linked}"
                        );
                    }
                }
            }
        }
    }
}
