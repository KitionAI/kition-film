//! Complete document/editor comparisons for commands confined to local editor settings.
//! The original readings remain unchanged. These handlers resolve no project
//! objects: their eligibility and assignments consume the named Mode/Active
//! members. Mode holds the complete preferences and libraries, so it is MORE.
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("sequence.snap", "editor-toggle"),
    ("sequence.linkedSelection", "editor-toggle"),
    ("sequence.nestSequences", "editor-toggle"),
    ("sequence.showThroughEdits", "on/toggle"),
    ("marker.showAllMarkerColors", "editor"),
    ("marker.filterColors", "editor"),
    ("marker.rippleSequenceMarkers", "toggle/absolute"),
    ("marker.copyPasteIncludesSequenceMarkers", "toggle/absolute"),
    ("multicam.audioFollowsVideo", "editor"),
    ("multicam.selectionTopDown", "editor"),
    ("multicam.showPreviewMonitor", "editor"),
    ("multicam.autoAdjustQuality", "editor"),
    ("multicam.transmitView", "editor"),
    ("project.columns.resize", "shown column by name"),
    ("project.freeform.options", "supplied fields"),
    ("project.viewPreset.save", "slot explicit or default"),
    ("project.viewPreset.saveAs", "slot explicit or default"),
    ("project.viewPreset.restore", "slot"),
    ("project.viewPreset.rename", "slot"),
    ("project.viewPreset.delete", "slot"),
    ("mediaBrowser.navigate", "editor/prefs only"),
    ("mediaBrowser.select", "editor/prefs only"),
    ("mediaBrowser.favorite", "editor/prefs only"),
    ("mediaBrowser.clearRecent", "editor/prefs only"),
    ("mediaBrowser.settings", "editor/prefs only"),
    ("preset.delete", "local library"),
    ("preset.rename", "local library"),
    ("preset.import", "local library"),
];

fn hash(source: &str) -> u64 {
    source.bytes().fold(0xcbf29ce484222325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3))
}

pub fn compared_path(command: &str, path: &str) -> bool {
    if !PATHS.contains(&(command, path)) {
        return false;
    }
    let (source, reviewed) = if command.starts_with("project.") {
        (include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/project_panel.rs")), 0x05feb2b3bbb4f4b0)
    } else if command.starts_with("mediaBrowser.") {
        (include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/media_browser.rs")), 0xa657cfe622ed6565)
    } else if command.starts_with("preset.") {
        (include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/presets.rs")), 0x4700c45c2128afe3)
    } else if command.starts_with("multicam.") {
        (include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/multicam.rs")), 0xca49dbd431e8f30e)
    } else if command.starts_with("marker.") || command == "sequence.showThroughEdits" {
        (include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/sequence_tools.rs")), 0x848ed5aa3b9d96b3)
    } else {
        (include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/commands.rs")), 0x422d17df7f6d60c9)
    };
    hash(source) == reviewed
}

pub fn more(command: &str) -> Vec<&'static str> {
    let mut classes = vec!["coarse-mode-state"];
    if matches!(command, "mediaBrowser.navigate" | "mediaBrowser.select" | "mediaBrowser.favorite") {
        classes.push("coarse-active-state");
    }
    classes
}

#[test]
fn local_editor_paths_compare_eligibility_all_parameters_and_empty_document_holds() {
    for prepared in [false, true] {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let item = doc.execute("item.newColorMatte", json!({"seconds":1})).unwrap()["item"].clone();
        doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":0})).unwrap();
        if prepared {
            doc.execute("project.viewPreset.saveAs", json!({"slot":2,"name":"Working"})).unwrap();
            doc.execute("marker.filterColors", json!({"hidden":["red"]})).unwrap();
        }
        let specs = doc.commands();
        for &(command, path) in PATHS {
            assert!(compared_path(command, path), "review expired: {command}/{path}");
            let spec = specs.iter().find(|spec| spec.id == command).unwrap();
            let browser = matches!(command, "mediaBrowser.navigate" | "mediaBrowser.select" | "mediaBrowser.favorite");
            assert_eq!(spec.reads, if browser { vec![EditorState::Mode, EditorState::Active] } else { vec![EditorState::Mode] }, "{command}");
            let conditional = matches!(
                command,
                "project.viewPreset.save"
                    | "project.viewPreset.restore"
                    | "project.viewPreset.rename"
                    | "project.viewPreset.delete"
                    | "marker.showAllMarkerColors"
            );
            assert_eq!(spec.enabled, !conditional || prepared, "{command}");
            assert!(spec.mutates && spec.targets.is_none() && spec.objects.is_empty() && spec.places.is_empty(), "{command}");
            assert!(spec.object_types.is_empty() && spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none(), "{command}");
            assert!(!spec.index_numbers && !spec.index_reversed, "{command}");
            // Presence/null/value spellings of every parameter family cannot
            // introduce a project read in these source-pinned handlers.
            for params in [
                json!({}),
                json!({"on":null,"enabled":null,"slot":null,"path":null,"paths":null}),
                json!({"on":true,"enabled":true,"slot":1,"name":"Working","to":"Assigned","hidden":[],"color":"red","visible":true}),
                json!({"on":false,"enabled":false,"slot":10,"name":"Missing","path":"folder","paths":["clip.mov"],"back":true,"remove":true}),
                json!({"slot":2.0,"forward":true,"column":"Name","width":100,"view":"icon","fileTypes":"wav","columns":["Name"]}),
                json!({"up":true,"grid":20,"snap":true,"showNames":false,"showDurations":true,"cardSize":100,"thumbnailSize":100,"hoverScrub":true,"importAsImageSequence":true}),
            ] {
                assert_eq!(doc.under(command, &params).unwrap(), None, "{command}/{params}");
            }
        }
    }
}
