//! keyboard.rs:424-483 uses the same graphic resolver, source-time mapping,
//! layer selection and source-graphic reconciliation as explicit layer edits.
//! Only text-layer presence and the requested animated parameter are consumed;
//! the declaration's whole clip, layer and source profiles are recorded MORE.
use super::{graphics_compare, sync_compare::normalized};
use kition_kit::{EditorState, KitDocument};
use serde_json::json;

pub const COMMANDS: &[&str] = &[
    "graphics.fontSizeUp",
    "graphics.fontSizeUp5",
    "graphics.fontSizeDown",
    "graphics.fontSizeDown5",
    "graphics.leadingUp",
    "graphics.leadingUp5",
    "graphics.leadingDown",
    "graphics.leadingDown5",
    "graphics.alignTextLeft",
    "graphics.alignTextCenter",
    "graphics.alignTextRight",
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    COMMANDS.contains(&command)
        && path == "text graphic at playhead"
        && hash(include_str!("../../../../crates/engine/engine/src/keyboard.rs")) == 0xc4c1cfffb8e70cd9
        && graphics_compare::compared_path("graphics.setText", "text layer edit")
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut more = graphics_compare::more(command, "text graphic at playhead");
    if command.starts_with("graphics.alignText") {
        more.push("unused-typography-frame");
    }
    more
}

#[test]
fn typography_shortcuts_compare_selection_fallback_layer_modes_and_shared_graphics() {
    for shared in [false, true] {
        let (mut doc, first, other, ordinary, sequence) = graphics_compare::fixture(shared);
        for selection in [vec![], vec![first], vec![other, first], vec![ordinary, first]] {
            doc.execute("timeline.select", json!({"clips":selection,"linked":false})).unwrap();
            for layers in [vec![], vec![0], vec![0, 1, 2]] {
                doc.execute("graphics.selectLayer", json!({"layers":layers,"keepSelection":true})).unwrap();
                for &command in COMMANDS {
                    assert!(compared_path(command, "text graphic at playhead"), "{command}");
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
                    assert_eq!(spec.reads, [EditorState::Part, EditorState::Selection, EditorState::Time, EditorState::Active], "{command}");
                    let target = selection.iter().copied().find(|id| *id == first || *id == other).unwrap_or(other);
                    let project = kition_film_format::decode(&doc.save(None).unwrap()).unwrap().project;
                    let expected = graphics_compare::expected(&project, command, target, sequence, &selection, false);
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
