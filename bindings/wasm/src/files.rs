//! The parameters of this kit's commands that name files or folders on disk (KHP A28), declared
//! as typed files in the commands' schemas (`kition_kit::files`): a host lends them, and a
//! headless kit keeps those commands from agents (the host opens, saves and exports documents).
//!
//! The kit's own check ([`refuse_for_agent`]) keeps them from an agent's call however it arrives:
//! called directly, or as a step of the object model's `model.batch`, which runs commands the
//! agent is not offered.

use kition_kit::files::FileParam;

/// Every file or folder parameter of the kit's commands.
/// What `file.import` and the Media Browser take: the extensions `kition_film_media::is_importable`
/// accepts (stills, audio, video).
const MEDIA: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "bmp", "wav", "wave", "bwf", "aif", "aiff", "mp3", "mp2", "m4a", "aac", "flac", "ogg", "opus", "mp4",
    "m4v", "mov", "mkv", "webm", "avi", "mxf", "mts", "m2ts", "m2t", "ts", "mpg", "mpeg", "vob", "mod", "tod", "m2v", "m1v", "mpv", "3gp", "y4m", "apv",
];

pub const FILES: &[FileParam] = &[
    FileParam::create("file.exportInterchange", "path", &[]),
    FileParam::create("file.exportEdl", "path", &[]),
    FileParam::create("file.exportSelectionProject", "path", &[]),
    FileParam::create("file.exportAle", "path", &[]),
    FileParam::create("file.exportOtio", "path", &[]),
    FileParam::create("file.exportFcp7Xml", "path", &[]),
    FileParam::create("file.exportFcpxml", "path", &[]),
    FileParam::create("file.exportAaf", "path", &[]),
    FileParam::create("file.exportOmf", "path", &[]),
    FileParam::read("file.importAaf", "path", &[]),
    FileParam::read("file.open", "path", &[]),
    FileParam::write("file.save", "path", &[]),
    FileParam::create("file.saveAs", "path", &[]),
    FileParam::create("file.saveCopy", "path", &[]),
    FileParam::create("file.saveAsTemplate", "path", &[]),
    FileParam::create("file.exportMedia", "path", &[]),
    FileParam::folder("clip.extractAudio", "dir"),
    FileParam::read("caption.import", "path", &[]),
    FileParam::create("caption.export", "path", &[]),
    FileParam::create("color.presetThumbnails", "path", &[]),
    FileParam::read("lut.import", "path", &[]),
    FileParam::create("lut.export", "path", &[]),
    FileParam::read("color.setInputLut", "path", &[]),
    FileParam::read("color.setLook", "path", &[]),
    FileParam::read("graphics.newFromFile", "path", &[]),
    FileParam::create("graphics.template.export", "path", &[]),
    FileParam::create("file.exportGraphicsTemplate", "path", &[]),
    FileParam::read("graphics.template.install", "path", &[]),
    FileParam::create("graphics.template.thumbnail", "path", &[]),
    FileParam::create("shortcut.export", "path", &[]),
    FileParam::read("shortcut.import", "path", &[]),
    FileParam::read("media.relink", "path", &[]),
    FileParam::read("media.replaceFootage", "path", &[]),
    FileParam::folder("media.search", "folder"),
    FileParam::folder("media.autoRelink", "folder"),
    FileParam::read("file.importFromMediaBrowser", "paths", MEDIA),
    FileParam::read("file.import", "paths", MEDIA),
    FileParam::read("file.import", "path", MEDIA),
    FileParam::read("file.importImageSequence", "path", &[]),
    FileParam::read("media.attachProxies", "path", &[]),
    FileParam::read("media.attachProxies", "paths", &[]),
    FileParam::read("media.reconnectFullRes", "path", &[]),
    FileParam::read("file.mediaPropertiesFile", "path", &[]),
    FileParam::create("preset.export", "path", &[]),
    FileParam::read("preset.import", "path", &[]),
    FileParam::read("export.presets.import", "path", &[]),
    FileParam::create("export.presets.export", "path", &[]),
    FileParam::create("export.resolve", "path", &[]),
    FileParam::create("export.queue.add", "path", &[]),
    FileParam::create("export.quick", "path", &[]),
    FileParam::folder("audio.voiceover.stop", "dir"),
    FileParam::create("file.exportFrame", "path", &[]),
    FileParam::folder("mediaBrowser.list", "path"),
    FileParam::folder("mediaBrowser.navigate", "path"),
    FileParam::read("mediaBrowser.select", "paths", MEDIA),
    FileParam::folder("mediaBrowser.favorite", "path"),
    FileParam::read("mediaBrowser.import", "paths", &[]),
    FileParam::read("mediaBrowser.import", "path", &[]),
    FileParam::read("mediaBrowser.openInSource", "path", &[]),
    FileParam::read("mediaBrowser.openInSource", "paths", &[]),
    FileParam::read("mediaBrowser.probe", "path", &[]),
    // Folders the engine writes into (KHP A28: a parameter naming a folder is typed as one).
    FileParam::folder("file.projectManager", "destination"),
    FileParam::folder("media.addProxies", "destination"),
    FileParam::folder("project.ingestSettings", "destination"),
    FileParam::folder("file.projectSettings.scratchDisks", "captured"),
    FileParam::folder("file.projectSettings.scratchDisks", "videoPreviews"),
    FileParam::folder("file.projectSettings.scratchDisks", "audioPreviews"),
    FileParam::folder("file.projectSettings.scratchDisks", "autoSave"),
];

/// The commands with file parameters an agent may run: they read only what the host lends from
/// the workspace (`kition_kit::host`), never the file system. `kition-film` names them to
/// `kition-headless` (its `SANDBOXED`).
pub const AGENT_FILE_COMMANDS: &[&str] = &["file.import"];

/// Commands an agent may not run although they name no file: in a kit, whose host owns every file
/// (`Session::host_files_only`), they can only refuse. The manifest's `agent.exclude` lists them
/// too, for the hosts that read it.
pub const AGENT_EXCLUDED: &[&str] = &[
    "sequence.renderEffectsInToOut",
    "sequence.renderInToOut",
    "sequence.renderSelection",
    "sequence.renderAudio",
    "mediaCache.clean",
    "graphics.template.remove",
    "file.autoSaveNow",
    "transcript.downloadModel",
];

/// Refuses `command` for an agent (KHP A29, A48): it names files or folders by path, or can only
/// reach the file system, and this kit works only on its workspace's files, through its host.
pub fn refuse_for_agent(command: &str) -> Result<(), String> {
    let names_files = FILES.iter().any(|file| file.command == command) && !AGENT_FILE_COMMANDS.contains(&command);
    if names_files || AGENT_EXCLUDED.contains(&command) {
        return Err(format!(
            "`{command}` reaches files or folders by path, and this kit works only on files of its workspace, through its host: \
             it is not available to the agent. Open, save and export the document through the host, and import media from the \
             workspace with file.import"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use kition_kit::KitDocument;

    use super::*;

    /// Parameters whose names read like files but are not: ids, property paths, directions,
    /// folders of the kit's own panels, in-memory data.
    const NOT_FILES: &[(&str, &str)] =
        &[("effect.list", "folder"), ("color.presets", "folder"), ("color.presetThumbnails", "folder"), ("mask.add", "path"), ("mask.set", "path")];

    /// The manifest keeps from agents (`agent.exclude`) what the kit refuses them.
    #[test]
    fn the_manifest_excludes_what_the_kit_refuses_agents() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!("../../../kit.json")).unwrap_or_default();
        let excluded: Vec<&str> = manifest["agent"]["exclude"].as_array().into_iter().flatten().filter_map(serde_json::Value::as_str).collect();
        assert_eq!(excluded, AGENT_EXCLUDED);
        for command in AGENT_EXCLUDED {
            assert!(refuse_for_agent(command).is_err(), "{command}");
        }
        assert!(refuse_for_agent("file.import").is_ok());
        assert!(refuse_for_agent("timeline.place").is_ok());
        let refused = refuse_for_agent("lut.import").unwrap_err();
        assert!(refused.contains("workspace") && refused.contains("file.import"), "{refused}");
    }

    #[test]
    fn every_file_parameter_is_declared() {
        let doc = crate::FilmDocument::create("Untitled.kfilm", 64, 64).unwrap_or_else(|error| panic!("{error}"));
        let problems = kition_kit::files::check(&doc.commands(), FILES, NOT_FILES);
        assert!(problems.is_empty(), "{problems:#?}");
    }
}
