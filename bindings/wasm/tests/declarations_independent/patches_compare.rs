//! Complete field-presence comparisons for reviewed successful patch paths.
//! Pinned from the declaration after review, not additional blind readings.
//! General: project_tools.rs:875-920 clones current settings and assigns only
//! supplied fields; unchanged cloned members cancel in the equality check.
//! Ingest: proxies.rs:586-614 does the same; preset eligibility is the immutable
//! proxies.rs:44-68 PRESETS table, not the session effect-preset library.
//! Returned descriptions of preserved fields are not additional assignments.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::{Value, json};

pub const COMPARED_PATHS: &[(&str, &str)] = &[
    ("file.projectSettings.general", "patch supplied settings"),
    ("file.projectSettings.scratchDisks", "patch scratch"),
    ("project.ingestSettings", "patch"),
    ("timeline.setTrack", "partial"),
];

pub(super) fn matches_source(source: &str, start: &str, end: &str, expected: u64) -> bool {
    let Some((_, suffix)) = source.split_once(start) else { return false };
    let Some((body, _)) = suffix.split_once(end) else { return false };
    body.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)) == expected
}

/// A source change invalidates certification until its actual paths are read
/// again; unchanged projections alone must never keep certifying a new handler.
pub fn compared_path(command: &str, path: &str) -> bool {
    if !COMPARED_PATHS.contains(&(command, path)) {
        return false;
    }
    let general = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/project_tools.rs"));
    let proxies = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/proxies.rs"));
    match command {
        "file.projectSettings.general" => matches_source(general, "fn project_settings_general(", "/// Where each scratch disk", 0xfa95177596bbed41),
        "file.projectSettings.scratchDisks" => matches_source(
            general,
            "fn project_settings_scratch(",
            "// ---------------------------------------------------------------------------------------------",
            0x413667430a748309,
        ),
        "project.ingestSettings" => {
            matches_source(proxies, "id: \"project.ingestSettings\",", "journal: true", 0x2e15e2f828077c40)
                && matches_source(proxies, "pub fn preset(id:", "/// What to do with a finished job", 0x2b36e946bbd45788)
        }
        "timeline.setTrack" => {
            let source = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/engine/engine/src/commands.rs"));
            matches_source(source, "            \"timeline.setTrack\",", "        cmd!(\"timeline.setTargeting\"", 0xb27818bc69b6d283)
                && matches_source(source, "pub(crate) fn track_p(", "/// The core project-item resolver", 0xb6fc1a90faa2814f)
        }
        _ => false,
    }
}

#[test]
fn every_track_patch_combination_compares_fields_address_and_editor_inputs() {
    use kition_kit::EditorState;
    assert!(compared_path("timeline.setTrack", "partial"));
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let q = doc.inspect().unwrap()["sequence"].clone();
    // Independent physical paths from commands.rs:2613-2641 and the blind
    // core.rs partial row. track_p:338-359 resolves only ids and V/A ordinals
    // in the active sequence. No omitted property or track content is consumed.
    let fields = [
        ("locked", "props.locked", json!(true)),
        ("syncLock", "props.sync_lock", json!(false)),
        ("enabled", "props.enabled", json!(false)),
        ("muted", "props.muted", json!(true)),
        ("solo", "props.solo", json!(true)),
        ("name", "props.name", json!("Assigned")),
        ("volumeDb", "volumeDb", json!(-12)),
        ("pan", "pan", json!(25)),
    ];
    for (kind, spelling, position) in [("video", "V1", "sequence.videoTracks"), ("audio", "A1", "sequence.audioTracks")] {
        let id = q[kind][0]["id"].clone();
        for address in [id.clone(), json!(spelling), json!(spelling.to_ascii_lowercase())] {
            for mask in 0..(1usize << fields.len()) {
                let mut params = serde_json::Map::from_iter([("track".into(), address.clone())]);
                let mut expected = Vec::new();
                for (index, (param, field, value)) in fields.iter().enumerate() {
                    if mask & (1usize << index) != 0 {
                        params.insert((*param).into(), value.clone());
                        expected.push((*field).to_owned());
                    }
                }
                let under = doc.under("timeline.setTrack", &Value::Object(params)).unwrap().unwrap();
                assert!(under.objects.is_empty() && under.within.is_empty() && under.orders.is_empty(), "{under:?}");
                assert!(under.covers.is_none() && under.content.is_empty() && under.inputs.is_empty(), "{under:?}");
                assert_eq!(under.premises.len(), 1, "{under:?}");
                let held = &under.premises[0];
                assert_eq!(held.id, id);
                assert_eq!(held.fields.as_deref(), Some(expected.as_slice()), "{address}/{mask}: {under:?}");
                let positions = if address.is_string() { vec![position.to_owned()] } else { Vec::new() };
                assert_eq!(held.positions.as_deref(), Some(positions.as_slice()), "{address}/{mask}: {under:?}");
                assert!(held.identities.is_empty());
            }
        }
    }
    let command = doc.commands().into_iter().find(|command| command.id == "timeline.setTrack").unwrap();
    assert_eq!(command.reads, [EditorState::Part]);
    assert!(command.targets.is_none() && command.places.is_empty() && command.name_field.is_none() && command.index.is_none());
    assert_eq!(command.objects, ["track"]);
    assert_eq!(command.object_types, [("track", &["Track"][..])]);
    assert!(command.name_params.is_empty() && !command.index_numbers && !command.index_reversed);
}

#[test]
fn every_supplied_field_combination_has_exact_patch_premises() {
    let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    let families: &[(&str, Vec<(&str, &str, Value)>)] = &[
        (
            "file.projectSettings.general",
            vec![
                ("renderer", "settings.renderer", json!("software")),
                ("videoDisplay", "settings.video_display", json!("timecode")),
                ("audioDisplay", "settings.audio_display_samples", json!("samples")),
                ("captureFormat", "settings.capture_format", json!("DV")),
                ("titleSafe", "settings.title_safe", json!([20, 20])),
                ("actionSafe", "settings.action_safe", json!([10, 10])),
            ],
        ),
        (
            "file.projectSettings.scratchDisks",
            vec![
                ("captured", "settings.scratch.captured", Value::Null),
                ("videoPreviews", "settings.scratch.videoPreviews", json!("previews")),
                ("audioPreviews", "settings.scratch.audioPreviews", json!("same as project")),
                ("autoSave", "settings.scratch.autoSave", json!("")),
            ],
        ),
        (
            "project.ingestSettings",
            vec![
                ("enabled", "settings.ingest.enabled", json!(true)),
                ("action", "settings.ingest.action", json!("copy")),
                ("destination", "settings.ingest.destination", json!("media")),
                ("preset", "settings.ingest.preset", json!("prores_proxy_quarter")),
            ],
        ),
    ];
    for (command, fields) in families {
        assert!(COMPARED_PATHS.iter().any(|(id, path)| id == command && compared_path(id, path)), "source review expired for {command}");
        for mask in 0..(1usize << fields.len()) {
            let mut params = serde_json::Map::new();
            let mut expected = Vec::new();
            for (index, (param, field, value)) in fields.iter().enumerate() {
                if mask & (1usize << index) != 0 {
                    params.insert((*param).to_owned(), value.clone());
                    expected.push((*field).to_owned());
                }
            }
            let under = doc.under(command, &Value::Object(params)).unwrap().unwrap();
            assert!(under.objects.is_empty() && under.within.is_empty() && under.covers.is_none(), "{command}/{mask}: {under:?}");
            assert_eq!(under.premises.len(), 1, "{command}/{mask}: {under:?}");
            let premise = &under.premises[0];
            assert_eq!(premise.id, json!("project"), "{command}/{mask}");
            assert_eq!(premise.fields.as_deref(), Some(expected.as_slice()), "{command}/{mask}");
            assert_eq!(premise.positions.as_deref(), Some([].as_slice()), "{command}/{mask}");
            assert!(premise.identities.is_empty(), "{command}/{mask}");
        }
        let declaration = doc.commands().into_iter().find(|declaration| declaration.id == *command).unwrap();
        assert!(declaration.mutates && declaration.enabled, "{command}");
        assert!(declaration.reads.is_empty(), "{command}: {:?}", declaration.reads);
        assert!(declaration.targets.is_none() && declaration.name_field.is_none() && declaration.index.is_none(), "{command}");
        assert!(declaration.objects.is_empty() && declaration.object_types.is_empty() && declaration.places.is_empty(), "{command}");
        assert!(declaration.name_params.is_empty() && !declaration.index_numbers && !declaration.index_reversed, "{command}");
    }
}
