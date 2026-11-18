//! keyboard.rs:485-525 chooses between layer edits and Motion on every
//! selected video. The mixed branch consumes no layer or source definition.
use super::{graphics_compare, sync_compare::normalized};
use kition_film_engine::project::{ItemId, Project};
use kition_kit::{EditorState, KitDocument, Premise, Under};
use serde_json::json;

pub const COMMANDS: &[&str] = &[
    "graphics.nudgeLeft",
    "graphics.nudgeLeft5",
    "graphics.nudgeRight",
    "graphics.nudgeRight5",
    "graphics.nudgeUp",
    "graphics.nudgeUp5",
    "graphics.nudgeDown",
    "graphics.nudgeDown5",
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    COMMANDS.contains(&command)
        && matches!(path, "graphic layers" | "video clip Motion")
        && hash(include_str!("../../../../crates/engine/engine/src/keyboard.rs")) == 0xc4c1cfffb8e70cd9
        && graphics_compare::compared_path("graphics.setText", "text layer edit")
}

pub fn more(command: &str, path: &str) -> Vec<&'static str> {
    if path == "graphic layers" {
        graphics_compare::more(command, path)
    } else {
        vec!["coarse-selection-state", "coarse-active-state", "unconsumed-graphic-kind", "clip-owner-position"]
    }
}

fn motion_expected(project: &Project, sequence: u64, selection: &[u64]) -> Under {
    let q = project.sequence(ItemId(sequence)).unwrap();
    let mut expected = Under::default();
    for id in selection {
        let (track, clip) = q.all_tracks().find_map(|track| track.items.iter().find(|clip| clip.id.0 == *id).map(|clip| (track, clip))).unwrap();
        expected.premises.push(Premise::on(json!(id)).fields(["item"]).positions(Vec::<String>::new()));
        expected.premises.push(Premise::on(json!(clip.item.0)).fields(["kind"]).positions(Vec::<String>::new()));
        if track.kind != kition_film_engine::project::TrackKind::Video {
            expected.premises.push(Premise::on(json!(id)).fields(Vec::<String>::new()).positions(["clips"]));
            continue;
        }
        let mut fields: Vec<String> = ["sourceIn", "speed", "reverse", "props.frame_hold"].map(str::to_owned).to_vec();
        // Effect ids before the first Motion determine which parameter is read;
        // a missing terminal slot also protects an appended Motion instance.
        let mut found = false;
        for (index, effect) in clip.effects.iter().enumerate() {
            fields.push(format!("effects.{index}.def"));
            if effect.effect == "motion" {
                fields.push(format!("effects.{index}.params.params.position"));
                found = true;
                break;
            }
        }
        if !found {
            fields.push(format!("effects.{}.def", clip.effects.len()));
        }
        expected.premises.push(Premise::on(json!(id)).fields(fields).positions(["clips", "start", "duration"]));
    }
    expected
}

#[test]
fn nudges_compare_all_graphic_mixed_and_ordinary_selections() {
    for shared in [false, true] {
        let (mut doc, first, other, ordinary, sequence) = graphics_compare::fixture(shared);
        let sound = doc.execute("file.newOfflineFile", json!({"name":"Audio","seconds":2,"video":false})).unwrap()["item"].clone();
        let audio = doc.execute("timeline.place", json!({"item":sound,"track":"A1","time":0})).unwrap()["clips"][0].as_u64().unwrap();
        for selection in [
            vec![],
            vec![first],
            vec![other, first],
            vec![ordinary],
            vec![first, ordinary],
            vec![ordinary, first],
            vec![audio],
            vec![first, audio],
            vec![audio, ordinary],
            vec![audio, first, ordinary],
        ] {
            doc.execute("timeline.select", json!({"clips":selection,"linked":false})).unwrap();
            for layers in [vec![], vec![0], vec![0, 1, 2]] {
                doc.execute("graphics.selectLayer", json!({"layers":layers,"keepSelection":true})).unwrap();
                let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                for &command in COMMANDS {
                    assert!(compared_path(command, "graphic layers") && compared_path(command, "video clip Motion"));
                    let spec = doc.commands().into_iter().find(|spec| spec.id == command).unwrap();
                    assert!(spec.enabled && spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty());
                    assert!(
                        spec.places.is_empty()
                            && spec.name_params.is_empty()
                            && spec.name_field.is_none()
                            && spec.index.is_none()
                            && !spec.index_numbers
                            && !spec.index_reversed
                    );
                    assert_eq!(spec.reads, [EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Active]);
                    let expected = if selection.contains(&ordinary) || selection.contains(&audio) {
                        motion_expected(&project, sequence, &selection)
                    } else {
                        graphics_compare::expected(&project, command, selection.first().copied().unwrap_or(other), sequence, &selection, false)
                    };
                    assert_eq!(
                        normalized(doc.under(command, &json!({})).unwrap().unwrap()),
                        normalized(expected),
                        "{command}/selection={selection:?}/layers={layers:?}/shared={shared}"
                    );
                }
            }
        }
    }
}
