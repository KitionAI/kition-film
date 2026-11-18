//! Reviewed path mappings from the committed blind media rows, not additional blind readings.
//! Exact serde paths were pinned after declaration review; raw readings remain unchanged.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

// Pinned after review: machine projection of independently committed prose readings.
// project_panel.rs:615-1027,1285-1375 consumes s.prefs and preset eligibility;
// media_browser.rs:254-414,431,569 consumes prefs (select returns state_json);
// presets.rs:437-571 consumes the local preset library.
pub const MODE_COMMANDS: &[&str] = &[
    "project.view.set",
    "project.columns.set",
    "project.columns.resize",
    "project.sort",
    "project.viewPreset.save",
    "project.viewPreset.saveAs",
    "project.viewPreset.restore",
    "project.viewPreset.rename",
    "project.viewPreset.delete",
    "project.freeform.move",
    "project.freeform.resize",
    "project.freeform.alignToGrid",
    "project.freeform.reset",
    "project.freeform.stack",
    "project.freeform.unstack",
    "project.freeform.saveArrangement",
    "project.freeform.options",
    "mediaBrowser.navigate",
    "mediaBrowser.select",
    "mediaBrowser.favorite",
    "mediaBrowser.clearRecent",
    "mediaBrowser.settings",
    "mediaBrowser.import",
    "presets.save",
    "presets.apply",
    "presets.delete",
    "presets.rename",
    "presets.import",
];

// media_browser.rs:254-356,418,467 and project_tools.rs:107 consume browser
// directory/history/selection. ReviewCorrection: the original blind media rows
// overstate Active for clearRecent/settings: media_browser.rs:568-573 only clones
// preferences; :377-414 only patches preferences. No blind row was changed.
pub const ACTIVE_COMMANDS: &[&str] = &[
    // keyboard.rs:655-665 resolves explicit/Project/Source item identity;
    // the original blind rows already name Active for both commands.
    "clip.setPosterFrame",
    "clip.clearPosterFrame",
    "mediaBrowser.navigate",
    "mediaBrowser.select",
    "mediaBrowser.favorite",
    "mediaBrowser.import",
    "mediaBrowser.openInSource",
    "file.importFromMediaBrowser",
];

// Verified baseline (446de07) gaps; this is a lower-bound inventory, not a claim
// that every row has a machine-comparable encoding. Each entry identifies a call
// path where an assigned field or a fact consumed outside the named object is absent.
pub const DOCUMENT_LESS: &[(&str, &str, &str)] = &[
    (
        "clip.setPosterFrame",
        "implicit poster item assignment and resolved parent timebase",
        "baseline keyboard.rs:655-683; no premise arm or indirect source hold",
    ),
    ("clip.clearPosterFrame", "implicit poster item assignment and eligibility", "baseline keyboard.rs:655-683; no premise arm"),
    ("file.projectSettings.general", "supplied Project.settings fields", "project_tools.rs:875-920"),
    ("file.projectSettings.scratchDisks", "supplied settings.scratch fields (host-only)", "project_tools.rs:952-975"),
    ("project.ingestSettings", "supplied settings.ingest fields (host-only)", "proxies.rs:581-620"),
    ("project.freeform.move", "position-map keys; relative path sibling layout", "project_panel.rs:622-675"),
    ("project.freeform.resize", "implicit sibling layout and bin order", "project_panel.rs:682-714"),
    ("project.freeform.alignToGrid", "default-bin items' layout and assigned positions", "project_panel.rs:715-729"),
    ("project.freeform.reset", "default-bin items' assigned position/stack", "project_panel.rs:733-745"),
    ("project.freeform.stack", "siblings pinned outside explicit selected targets", "project_panel.rs:748-795"),
    ("project.freeform.unstack", "siblings pinned; metadata values name stack members", "project_panel.rs:748-795"),
    ("project.freeform.saveArrangement", "default-bin items' layout/assigned arrangement", "project_panel.rs:812-829"),
    ("project.freeform.restoreArrangement", "default-bin item arrangement and assigned position", "project_panel.rs:831-852"),
    ("project.freeform.deleteArrangement", "default-bin items' assigned arrangement", "project_panel.rs:855-869"),
    ("project.view.set", "metadata-key column eligibility", "project_panel.rs:915-964"),
    ("project.columns.set", "metadata-key column eligibility", "project_panel.rs:966-1000"),
    ("project.sort", "metadata-key column eligibility", "project_panel.rs:1018-1027"),
    ("presets.save", "source dimensions through clip_size", "presets.rs:433-435,461"),
    ("presets.apply", "source dimensions for geometric preset", "presets.rs:311-340,484"),
    ("metadata.set", "clip parameter resolves to source Item", "panels.rs:163-175,284-339"),
];

pub const DOCUMENT_MORE: &[(&str, &str, &str)] = &[
    (
        "clip.setPosterFrame",
        "whole explicit Item and unrelated Program time window",
        "baseline keyboard.rs:655-683; poster target consumes Source/Project time instead of Program material",
    ),
    (
        "clip.clearPosterFrame",
        "whole explicit Item and unused Program part/time",
        "baseline keyboard.rs:668-685 computes snapping but clear discards it; raw blind row correctly omits Part/Time",
    ),
    ("presets.save", "whole Clip holds unrelated name", "presets.rs:437-470; acts::targets default"),
    ("presets.apply", "whole Clip holds unrelated name", "presets.rs:473-507; acts::targets default"),
    ("media.detachProxies", "whole Item holds unrelated metadata/name", "proxies.rs:508-525; acts::targets default"),
    ("metadata.set", "explicit Item Description patch holds unrelated Scene", "panels.rs:284-339; acts::objects default"),
];

#[test]
fn media_commands_declare_the_reviewed_editor_inputs() {
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let commands = doc.commands();
    for (expected, ids) in [(kition_kit::EditorState::Mode, MODE_COMMANDS), (kition_kit::EditorState::Active, ACTIVE_COMMANDS)] {
        for id in ids {
            let command = commands.iter().find(|command| command.id == *id).expect("registered command");
            assert!(command.reads.contains(&expected), "{id} reads {expected:?}: {:?}", command.reads);
        }
    }
}

#[test]
fn project_setting_patch_paths_match_the_blind_assigned_field_reading() {
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let rows = [
        ("file.projectSettings.general", json!({"titleSafe":[20,20]}), vec!["settings.title_safe"]),
        (
            "file.projectSettings.scratchDisks",
            json!({"captured":null,"audioPreviews":"audio"}),
            vec!["settings.scratch.captured", "settings.scratch.audioPreviews"],
        ),
        ("project.ingestSettings", json!({"enabled":true,"destination":null}), vec!["settings.ingest.enabled", "settings.ingest.destination"]),
    ];
    for (command, params, fields) in rows {
        let held = doc.under(command, &params).unwrap().expect("project patch has an explicit field premise");
        assert_eq!(held.premises.len(), 1, "{command}: {held:?}");
        let premise = &held.premises[0];
        assert_eq!(premise.id, json!("project"));
        assert_eq!(premise.fields.as_deref(), Some(fields.iter().map(|f| (*f).to_owned()).collect::<Vec<_>>().as_slice()), "{command}");
        assert_eq!(premise.positions.as_deref(), Some([].as_slice()), "{command}");
    }
}

#[test]
fn metadata_clip_parameter_holds_the_item_it_resolves() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let item = doc.execute("file.newColorMatte", json!({"color":"#557799","seconds":1})).unwrap()["item"].clone();
    let clip = doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":0})).unwrap()["clips"][0].clone();
    let held = doc.under("metadata.set", &json!({"clip":clip,"field":"Description","value":"mine"})).unwrap().unwrap();
    let item_need = held.premises.iter().find(|need| need.id == item).expect("resolved source Item");
    assert_eq!(item_need.fields.as_deref(), Some(["props.common.metadata.Description".to_owned()].as_slice()));
    let clip_need = held.premises.iter().find(|need| need.id == clip).expect("source reference");
    assert_eq!(clip_need.fields.as_deref(), Some(["item".to_owned()].as_slice()));
    assert_eq!(clip_need.positions.as_deref(), Some([].as_slice()));
}

#[test]
fn poster_projection_holds_the_physical_item_metadata_key() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let item = doc.execute("file.newColorMatte", json!({"seconds":1})).unwrap()["item"].clone();
    for command in ["clip.setPosterFrame", "clip.clearPosterFrame"] {
        let under = doc.under(command, &json!({"item":item})).unwrap().unwrap();
        let held = under.premises.iter().find(|held| held.id == item).unwrap();
        assert_eq!(held.fields.as_deref(), Some(["kind".to_owned(), "props.common.metadata.Poster Frame".to_owned()].as_slice()), "{command}: {under:?}");
        assert_eq!(held.positions.as_deref(), Some([].as_slice()), "{command}");
        assert!(under.objects.is_empty() && under.within.is_empty(), "a poster is not a Program place: {under:?}");
    }
}
