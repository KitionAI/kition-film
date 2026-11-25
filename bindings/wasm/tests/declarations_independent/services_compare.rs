//! Local-service paths from media.rs and effects.rs. These handlers consume
//! preferences, shortcut state or captured queue entries, never Program clips.
//! QueueItem.project is immutable after queue_add, so its queue identity pins
//! that snapshot; queue operations do not consume the current document.
use kition_film_kit::FilmDocument;
use kition_kit::{EditorState, KitDocument};
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("prefs.set", "prefs"),
    ("prefs.reset", "prefs"),
    ("audio.toggleScrubbing", "prefs"),
    ("audio.voiceover.settings", "preferences"),
    ("audioMixing.deletePreset", "preferences by name/type"),
    ("effect.setDefaultTransition", "editor default"),
    ("multicam.gridLayout", "editor"),
    ("shortcut.set", "local prefs/editor"),
    ("shortcut.clear", "local prefs/editor"),
    ("shortcut.undo", "local prefs/editor"),
    ("shortcut.redo", "local prefs/editor"),
    ("shortcut.loadPreset", "local prefs/editor"),
    ("shortcut.savePreset", "local prefs/editor"),
    ("shortcut.deletePreset", "local prefs/editor"),
    ("shortcut.export", "local prefs/editor"),
    ("shortcut.import", "local prefs/editor"),
    ("export.queue.start", "session queue"),
    ("export.queue.stop", "session queue"),
    ("export.queue.cancel", "session queue"),
    ("export.queue.retry", "session queue"),
    ("export.queue.remove", "session queue"),
    ("export.queue.move", "session queue"),
    ("export.queue.clear", "session queue"),
    ("export.presets.save", "local export library"),
    ("export.presets.delete", "local export library"),
    ("export.presets.favorite", "local export library"),
    ("export.presets.import", "local export library"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    if !PATHS.contains(&(command, path)) {
        return false;
    }
    let (source, reviewed) = match command {
        id if id.starts_with("shortcut.") => (include_str!("../../../../crates/engine/engine/src/shortcuts.rs"), 0x6070fbac4e74808a),
        id if id.starts_with("export.") => (include_str!("../../../../crates/engine/engine/src/export_tools.rs"), 0xadba9f2d4562ee64),
        "audio.toggleScrubbing" => (include_str!("../../../../crates/engine/engine/src/keyboard.rs"), 0xc4c1cfffb8e70cd9),
        "audio.voiceover.settings" => (include_str!("../../../../crates/engine/engine/src/voiceover.rs"), 0x91aaae0773822eca),
        "audioMixing.deletePreset" => (include_str!("../../../../crates/engine/engine/src/audio_mixing.rs"), 0x62e5a74e1bc8c02c),
        "multicam.gridLayout" => (include_str!("../../../../crates/engine/engine/src/multicam.rs"), 0xca49dbd431e8f30e),
        _ => (include_str!("../../../../crates/engine/engine/src/commands.rs"), 0xa5f7dd875311a060),
    };
    source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)) == reviewed
}

pub fn more(_: &str) -> Vec<&'static str> {
    vec!["coarse-mode-state"]
}

#[test]
fn local_service_paths_compare_all_parameter_families_without_document_holds() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let item = doc.execute("item.newColorMatte", json!({"seconds":1})).unwrap()["item"].clone();
    doc.execute("timeline.place", json!({"item":item,"track":"V1","seconds":0})).unwrap();
    let specs = doc.commands();
    for &(command, path) in PATHS {
        assert!(compared_path(command, path), "review expired: {command}/{path}");
        let spec = specs.iter().find(|spec| spec.id == command).unwrap();
        assert_eq!(spec.reads, [EditorState::Mode], "{command}");
        assert!(spec.enabled && spec.mutates, "{command}");
        assert!(spec.targets.is_none() && spec.objects.is_empty() && spec.object_types.is_empty() && spec.places.is_empty(), "{command}");
        assert!(spec.name_params.is_empty() && spec.name_field.is_none() && spec.index.is_none() && !spec.index_numbers && !spec.index_reversed, "{command}");
        for params in [
            json!({}),
            json!({"id":null,"slot":null,"name":null,"path":null,"settings":null}),
            json!({"id":1,"to":0,"by":-1,"all":true,"wait":false,"start":false}),
            json!({"key":"audio.scrubAudio","value":false,"values":{"audio.scrubAudio":true}}),
            json!({"category":"graphics"}),
            json!({"name":"Working","type":"dialogue","effect":"cross_dissolve","layout":"2x2","favorite":false}),
            json!({"command":"timeline.razor","keys":"Cmd+K","panel":"Timeline","add":true,"keepConflicts":true,"activate":false,"overwrite":false}),
            json!({"source":"synthetic","inputChannel":1,"name":"Take","countdownSoundCues":false,"prerollSeconds":2,"postrollSeconds":1}),
            json!({"from":"Match Source","settings":{"width":1920,"height":1080},"format":"h264","width":64,"height":36,"fps":24,"scale":0.5,"quality":80}),
        ] {
            assert_eq!(doc.under(command, &params).unwrap(), None, "{command}/{params}");
        }
    }
}

#[test]
fn service_mode_captures_shortcuts_queue_and_export_favorites() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let before = doc.editor_state()["mode"].clone();
    assert!(before["shortcuts"]["revision"].is_u64());
    assert_eq!(before["exportQueue"]["items"], json!([]));
    assert_eq!(before["exportFavorites"], json!([]));
    doc.execute("shortcut.set", json!({"command":"timeline.razor","keys":"Cmd+Alt+K"})).unwrap();
    let changed = doc.editor_state()["mode"].clone();
    assert_ne!(changed["shortcuts"], before["shortcuts"]);
    doc.execute("shortcut.undo", json!({})).unwrap();
    assert_ne!(doc.editor_state()["mode"]["shortcuts"]["revision"], before["shortcuts"]["revision"]);
    doc.execute("export.presets.save", json!({"name":"Working","settings":{"width":64,"height":36}})).unwrap();
    doc.execute("export.presets.favorite", json!({"name":"Working","favorite":true})).unwrap();
    assert_ne!(doc.editor_state()["mode"]["exportFavorites"], before["exportFavorites"]);
    doc.execute("export.queue.add", json!({"path":"out.mp4","preset":"Working","ranges":[{"mode":"custom","startSeconds":0,"endSeconds":1}]})).unwrap();
    let queued = doc.editor_state()["mode"]["exportQueue"].clone();
    assert_eq!(queued["items"].as_array().unwrap().len(), 1);
    let id = queued["items"][0]["id"].clone();
    doc.execute("export.queue.cancel", json!({"id":id})).unwrap();
    assert_ne!(doc.editor_state()["mode"]["exportQueue"], queued);
}
