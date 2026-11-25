//! The blind readings describe engine handlers. These paths have no agent
//! dispatch: files.rs:94-123, collab.rs:137-140 and headless/src/main.rs:15-32
//! reject by command before reading parameters, including raw model.batch.
//! Keep the original readings; do not infer that their engine premises are exact.
use kition_film_kit::files;

pub const PATHS: &[(&str, &str)] = &[
    ("file.save", "save"),
    ("file.saveAs", "save"),
    ("file.saveCopy", "save"),
    ("file.open", "load"),
    ("file.autoSaveNow", "save"),
    ("clip.extractAudio", "explicit or selection-derived source"),
    ("lut.import", "content dedup"),
    ("color.setInputLut", "path import"),
    ("color.setLook", "path import"),
    ("graphics.newFromFile", "new clip placement"),
    ("graphics.newFromFile", "import before placement"),
    ("graphics.template.export", "external template export"),
    ("file.exportGraphicsTemplate", "external template export"),
    ("graphics.template.install", "external library install"),
    ("graphics.template.remove", "external library delete"),
    ("graphics.newFromFile", "post-dispatch existing source graphics"),
    ("graphics.template.export", "post-dispatch existing source graphics"),
    ("graphics.template.install", "post-dispatch existing source graphics"),
    ("graphics.template.remove", "post-dispatch existing source graphics"),
    ("audio.voiceover.stop", "discard/no samples"),
    ("audio.voiceover.stop", "save/overwrite"),
    ("transcript.downloadModel", "external download"),
    ("file.saveAsTemplate", "external file write"),
    ("file.importFromMediaBrowser", "delegate"),
    ("file.importImageSequence", "delegate"),
    ("file.exportSelectionProject", "external project write"),
    ("file.exportAle", "external ALE write"),
    ("mediaBrowser.import", "explicit files or dirs"),
    ("mediaBrowser.openInSource", "already imported file"),
    ("mediaBrowser.openInSource", "file not yet imported"),
    ("media.relink", "one explicit source, optionally other missing"),
    ("media.replaceFootage", "force replacement only one"),
    ("media.autoRelink", "folder-prefix or folder-tree missing sources"),
    ("media.addProxies", "start then attach async"),
    ("media.attachProxies", "checked or force"),
    ("media.reconnectFullRes", "single"),
    ("mediaCache.clean", "cache deletion"),
    ("file.exportFrame", "source snapshot, optional import"),
    ("file.exportFrame", "program snapshot, optional import"),
    ("file.exportMedia", "render snapshot / queue snapshot"),
    ("export.quick", "render snapshot / queue snapshot"),
    ("export.queue.add", "render snapshot / queue snapshot"),
    ("file.exportInterchange", "external snapshot"),
    ("file.exportEdl", "external snapshot"),
    ("file.exportFcp7Xml", "external snapshot"),
    ("file.exportFcpxml", "external snapshot"),
    ("file.exportOtio", "external snapshot"),
    ("file.exportAaf", "external audio/interchange snapshot"),
    ("file.exportOmf", "external audio/interchange snapshot"),
    ("file.importAaf", "merge fragment"),
    ("sequence.renderEffectsInToOut", "external preview job"),
    ("sequence.renderInToOut", "external preview job"),
    ("sequence.renderSelection", "external preview job"),
    ("sequence.renderAudio", "external preview job"),
    ("caption.export", "external"),
    ("caption.import", "active sequence"),
    ("caption.import", "no sequence"),
];

pub fn compared_path(command: &str, path: &str) -> bool {
    let hash = |source: &str| source.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    PATHS.contains(&(command, path))
        && hash(include_str!("../../src/files.rs")) == 0xbcb45df58401d79f
        && hash(include_str!("../../../headless/src/main.rs")) == 0xc870109526ea3c97
        && hash(include_str!("../../src/collab.rs")) == 0x831eab3f5c05dc80
}

#[test]
fn blocked_paths_are_parameter_independent_agent_dispatch_barriers() {
    for &(command, path) in PATHS {
        assert!(compared_path(command, path), "review dispatch again: {command}/{path}");
        assert!(files::refuse_for_agent(command).unwrap_err().contains("not available to the agent"), "{command}/{path}");
        assert!(!files::AGENT_FILE_COMMANDS.contains(&command));
    }
}
