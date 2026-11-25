//! keyboard.rs:384-429 shifts every base and keyed Volume level on selected
//! audio plus linked partners, without consulting their source or timeline time.
use super::sync_compare::normalized;
use kition_film_engine::project::{ItemId, TrackKind};
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::json;

pub const COMMANDS: &[&str] = &[
    "clip.volumeUp",
    "clip.volumeDown",
    "clip.volumeUpMany",
    "clip.volumeDownMany",
    "clip.nudgeVolumeUp1",
    "clip.nudgeVolumeUp3",
    "clip.nudgeVolumeDown1",
    "clip.nudgeVolumeDown3",
];

pub fn compared_path(command: &str, path: &str) -> bool {
    COMMANDS.contains(&command)
        && path == "linked audio levels"
        && include_str!("../../../../crates/engine/engine/src/keyboard.rs")
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3))
            == 0xc4c1cfffb8e70cd9
}

pub fn more() -> Vec<&'static str> {
    vec!["coarse-selection-state", "coarse-mode-state", "clip-owner-position", "whole-volume-parameter"]
}

fn leaf(id: u64, fields: impl IntoIterator<Item = impl Into<String>>) -> Premise {
    Premise::on(json!(id)).fields(fields).positions(Vec::<String>::new())
}

#[test]
fn keyboard_volume_compares_all_shortcuts_link_modes_recipient_kinds_and_animation() {
    for animated in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let item = doc.execute("item.newBarsAndTone", json!({"seconds":2})).unwrap()["item"].clone();
        let first = doc.execute("timeline.place", json!({"item":item,"track":"V1","time":254_016_000_000i64})).unwrap()["clips"].clone();
        let second = doc.execute("timeline.place", json!({"item":item,"track":"V2","audioTrack":"A2","time":0})).unwrap()["clips"].clone();
        if animated {
            doc.execute("effect.addKeyframe", json!({"clip":first[1],"effect":"volume","param":"level","mediaTime":0,"value":-3})).unwrap();
            doc.execute("effect.addKeyframe", json!({"clip":first[1],"effect":"volume","param":"level","mediaTime":254_016_000_000i64,"value":-6})).unwrap();
        }
        let sequence = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
        let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
        let q = project.sequence(ItemId(sequence)).unwrap();
        for linked in [false, true] {
            doc.execute("sequence.linkedSelection", json!({"on":linked})).unwrap();
            for selection in
                [vec![], vec![first[0].as_u64().unwrap()], vec![first[1].as_u64().unwrap()], vec![first[0].as_u64().unwrap(), second[1].as_u64().unwrap()]]
            {
                doc.execute("timeline.select", json!({"clips":selection,"linked":false})).unwrap();
                let mut recipients = selection.clone();
                let mut want = Under::default();
                if linked {
                    for id in &selection {
                        want.premises.push(leaf(*id, ["link", "~linkedGroup"]));
                        if let Some(link) = q.find_item(kition_film_engine::project::ClipId(*id)).unwrap().1.link {
                            let members: Vec<_> =
                                q.all_tracks().flat_map(|track| &track.items).filter(|clip| clip.link == Some(link)).map(|clip| clip.id.0).collect();
                            want.premises.push(leaf(*members.iter().min().unwrap(), ["~linkedMembers"]));
                            recipients.extend(members);
                        }
                    }
                }
                recipients.sort_unstable();
                recipients.dedup();
                for id in recipients {
                    let (owner, clip) = q.find_item(kition_film_engine::project::ClipId(id)).unwrap();
                    let mut fields = vec![];
                    if q.track(owner).unwrap().kind == TrackKind::Audio {
                        let found = clip.effects.iter().position(|effect| effect.effect == "volume");
                        for index in 0..=found.unwrap_or(clip.effects.len()) {
                            fields.push(format!("effects.{index}.def"));
                        }
                        if let Some(index) = found {
                            fields.push(format!("effects.{index}.params.level"));
                        }
                    }
                    want.premises.push(Premise::on(json!(id)).fields(fields).positions(["clips"]));
                }
                for time in [0, 254_016_000_000i64, 762_048_000_000i64] {
                    doc.execute("playhead.set", json!({"time":time})).unwrap();
                    for &command in COMMANDS {
                        assert!(compared_path(command, "linked audio levels"));
                        let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                        assert_eq!(spec.enabled, !selection.is_empty());
                        assert!(spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty());
                        assert!(
                            spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed
                        );
                        assert_eq!(spec.reads, [EditorState::Part, EditorState::Selection, EditorState::Mode]);
                        assert_eq!(
                            normalized(doc.under(command, &json!({})).unwrap().unwrap()),
                            normalized(want.clone()),
                            "{command}/linked={linked}/selection={selection:?}/animated={animated}/time={time}"
                        );
                    }
                }
            }
        }
    }
}
