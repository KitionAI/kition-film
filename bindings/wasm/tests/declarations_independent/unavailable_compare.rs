//! commands.rs:71-73 and project_tools.rs:337-341 reject these paths before
//! dispatch in a host-backed kit. Session::for_host never starts persistence;
//! embedded captions have no reader. No handler dependency claim is inferred.
use kition_film_kit::FilmDocument;
use kition_kit::KitDocument;
use serde_json::json;

pub const PATHS: &[(&str, &str)] = &[
    ("file.recover", "load"),
    ("file.discardRecovery", "discard"),
    ("clip.restoreCaptionsFromSource", "disabled"),
    ("file.closeAllOtherProjects", "disabled"),
    ("transcript.generate", "explicit or default sources"),
    ("sequence.transcribe", "track/mix"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../../../crates/engine/engine/src/commands.rs")) == 0x422d17df7f6d60c9
        && hash(include_str!("../../../../crates/engine/engine/src/project_tools.rs")) == 0x6ec565cfb937b0c8
        && hash(include_str!("../../../../crates/engine/engine/src/lib.rs")) == 0x12037cc25ba5d4c9
        && hash(include_str!("../../../../crates/engine/engine/src/transcript.rs")) == 0x7a1ff3e865248276
        && hash(include_str!("../../../../crates/engine/engine/src/sequence_extras.rs")) == 0xdc0de290f29296a5
}

#[test]
fn unavailable_handlers_refuse_before_reading_or_writing_document_content() {
    let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
    for populated in [false, true] {
        if populated {
            doc.execute("file.importDemoFootage", json!({})).unwrap();
        }
        let specs = doc.commands();
        for &(command, path) in PATHS {
            assert!(compared_path(command, path));
            assert!(!specs.iter().find(|spec| spec.id == command).unwrap().enabled);
            // transcript.rs:66-68 and sequence_extras.rs:110-114 check
            // build capability before resolving any source. FilmDocument's
            // private host session exposes no transcriber installation API.
            let params = match command {
                "file.recover" | "file.discardRecovery" => vec![json!({}), json!({"id":"missing"})],
                "transcript.generate" => vec![json!({}), json!({"items":[]}), json!({"item":999}), json!({"items":[999],"model":"missing"})],
                "sequence.transcribe" => vec![json!({}), json!({"track":"mix"}), json!({"track":"A1"}), json!({"track":999})],
                _ => vec![json!({})],
            };
            for params in params {
                let before = doc.save(None).unwrap();
                let error = doc.execute(command, params).expect_err(command);
                assert!(error.contains("disabled"), "{command}: {error}");
                assert_eq!(doc.save(None).unwrap(), before, "{command}");
            }
        }
        let bytes = doc.save(None).unwrap();
        doc = FilmDocument::open("Edit.kfilm", &bytes).unwrap();
    }
}
