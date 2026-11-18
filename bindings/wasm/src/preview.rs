//! A dialog's live preview: its command runs on a scratch copy of the document
//! ([`kition_film_engine::Session::scratch`]) that shares the project and the decoded media (in a
//! media pool of its own, so nothing it opens, evicts, or marks offline reaches the document), and
//! writes no history step, no journal entry, no file, and no KDM change. The page draws the
//! preview from the copy ([`FilmDocument::preview_frame`], [`FilmDocument::preview_audio`]), and
//! OK runs the command on the document itself, once, as any other command.
//!
//! Only the commands a dialog runs on OK preview ([`PREVIEW_COMMANDS`]). Those that write outside
//! the project ([`PREVIEW_EXTERNAL`]: metadata written next to the media, proxy files, exports and
//! saves) never run on the copy; their dialogs show a summary of what OK will do. Whatever the
//! command, the copy reads files through the document's services but cannot write one.
//!
//! Each [`FilmDocument::preview_begin`] starts a new copy from the document as it is then, so a
//! preview never builds on the previous one, and a change a peer makes meanwhile shows in the
//! next one. A command that starts a job runs it on the copy's own job list
//! ([`FilmDocument::preview_settle`]); ending the preview cancels it.

use std::sync::{Arc, PoisonError, Weak};

use kition_film_engine::time::Tick;
use kition_film_engine::{Services, Session};
use kition_film_media::reader::SharedReader;
use serde_json::{Value, json};

mod diff;

use crate::panels::{MAX_ITEM_FRAME_PIXELS, MAX_ITEM_FRAME_WIDTH};
use crate::{FilmDocument, KitServices};

/// The commands a wave-2 dialog runs on OK, which preview on a scratch copy. Each dialog task
/// adds its own (and the test of every one of them follows this list).
pub const PREVIEW_COMMANDS: &[&str] = &[
    // Task 11: clip dialogs
    "clip.audioGain",
    "clip.fieldOptions",
    "clip.frameHoldOptions",
    "clip.interpretFootage",
    "clip.speedDuration",
    "edit.pasteAttributes",
    "edit.removeAttributes",
    // Task 12: clip structure dialogs
    "clip.audioChannels",
    "clip.editOffline",
    "clip.editSubclip",
    "clip.makeSubclip",
    "clip.mergeClips",
    "clip.modifyTimecode",
    "clip.nest",
    "clip.synchronize",
    "file.newOfflineFile",
    // Task 13: Sequence Settings, New Sequence, and colour management
    "file.newSequence",
    "sequence.colorSettings",
    "sequence.settings",
    // Task 14: tracks, sequence tools, and new items (Color Matte and its colour picker)
    "file.newColorMatte",
    "project.matteColor",
    "sequence.addTracks",
    "sequence.deleteTracks",
    "sequence.normalizeMixTrack",
    "sequence.simplify",
    // Task 15: Find, search bins, and Automate to Sequence
    "clip.automateToSequence",
    "edit.find",
    "file.newSearchBin",
    // Task 16: Scene Edit Detection, markers, and Project Settings
    "clip.sceneEditDetection",
    "file.projectSettings.general",
    "markers.addFlashCue",
    "markers.edit",
    "project.ingestSettings",
    // Task 17: media dialogs. Link Media's OK relinks after Locate…, leaves the files offline, or
    // leaves every file offline; `media.linkMedia` only opens it (it changes nothing).
    "media.makeOffline",
    "media.offlineAll",
    "media.relink",
    // Task 18: Metadata Display and the view preset dialogs
    "project.columns.set",
    "project.viewPreset.delete",
    "project.viewPreset.rename",
    "project.viewPreset.restore",
    "project.viewPreset.saveAs",
    // Task 19: Freeform View Options and Save Arrangement
    "project.freeform.options",
    "project.freeform.saveArrangement",
    // Task 25: Graphics Templates properties and Replace Fonts
    "file.replaceFonts",
    "graphics.set",
    "graphics.setTextType",
    // Task 26: Save Preset…
    "presets.save",
];

/// The commands that write outside the project, so they never run on the scratch copy: their
/// dialogs preview as a summary of what OK will do.
///
/// `file.import` is not a dialog command, so it never previews. If it ever does, an AAF or OMF
/// import writes its embedded audio next to the document (`interchange.rs`), so it must be refused
/// here as well; on the copy that write fails already (`ScratchServices` writes nothing).
pub const PREVIEW_EXTERNAL: &[&str] = &[
    // XMP next to the media
    "clip.updateMetadata",
    // proxy files
    "media.createProxies",
    // exports
    "captions.export",
    "file.exportAaf",
    "file.exportAle",
    "file.exportEdl",
    "file.exportFcp7Xml",
    "file.exportFcpxml",
    "file.exportFrame",
    "file.exportGraphicsTemplate",
    "file.exportMedia",
    "file.exportOmf",
    "file.exportOtio",
    "file.exportSelectionProject",
    "graphics.template.export",
    // saves and other projects
    "file.projectManager",
    "file.save",
    "file.saveAs",
    "file.saveAsTemplate",
    "file.saveCopy",
    // the media cache's files
    "mediaCache.clean",
    // render previews (files next to the project)
    "sequence.deleteRenderFiles",
    "sequence.deleteRenderFilesInToOut",
    "sequence.renderAudio",
    "sequence.renderBar",
    "sequence.renderEffectsInToOut",
    "sequence.renderInToOut",
    "sequence.renderSelection",
    // files a command writes where it is told, or into the data directory
    "audio.voiceover.stop",
    "clip.extractAudio",
    "audioMixing.deletePreset",
    "audioMixing.savePreset",
    "export.presets.export",
    "graphics.template.install",
    "graphics.template.remove",
    "graphics.template.thumbnail",
    "color.presetThumbnails",
    "lut.export",
    "presets.export",
    "shortcuts.export",
    "shortcuts.savePreset",
];

/// What the scratch copy reads and writes through: the document's own files and lent media, and
/// no write at all. It holds the document's services weakly: the document holds the copy.
struct ScratchServices {
    document: Weak<KitServices>,
}

fn closed() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::NotFound, "the document is closed")
}

impl Services for ScratchServices {
    fn read_file(&self, path: &str) -> std::io::Result<Vec<u8>> {
        self.document.upgrade().ok_or_else(closed)?.read_file(path)
    }

    fn write_file(&self, path: &str, _data: &[u8]) -> std::io::Result<()> {
        Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, format!("a preview writes no file ({path})")))
    }

    fn file_size(&self, path: &str) -> std::io::Result<u64> {
        self.document.upgrade().ok_or_else(closed)?.file_size(path)
    }

    fn read_range(&self, path: &str, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
        self.document.upgrade().ok_or_else(closed)?.read_range(path, offset, len)
    }

    fn reader(&self, path: &str) -> Option<std::io::Result<SharedReader>> {
        match self.document.upgrade() {
            Some(document) => document.reader(path),
            None => Some(Err(closed())),
        }
    }

    fn export_in_memory(&self) -> bool {
        true
    }
}

/// The commands that replace the document's project wholesale: the open preview is a copy of
/// the old one, so the document ends it when one of them has run (`FilmDocument::settle`).
pub const REPLACES_DOCUMENT: &[&str] = &[
    "file.closeAllProjects",
    "file.closeProject",
    "file.newProject",
    "file.newProjectFromTemplate",
    "file.open",
    "file.openDemoProject",
    "file.recover",
    "file.revert",
];

/// Why `command` does not preview on a scratch copy, if it does not.
fn refusal(command: &str) -> Option<String> {
    if PREVIEW_EXTERNAL.contains(&command) {
        Some(format!("`{command}` writes outside the project, so it previews as a summary"))
    } else if !PREVIEW_COMMANDS.contains(&command) {
        Some(format!("`{command}` is not a dialog command that previews"))
    } else {
        None
    }
}

/// Asks every job on `session` to stop.
fn cancel_jobs(session: &Session) {
    for job in &session.jobs {
        job.progress.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Whether `session` has work left: a job without its result, or a result not applied yet.
fn pending(session: &Session) -> bool {
    !session.stepped.is_empty()
        || !session.scene_jobs.is_empty()
        || !session.media_jobs.is_empty()
        || !session.mask_jobs.is_empty()
        || session.jobs.iter().any(|job| job.result.lock().unwrap_or_else(PoisonError::into_inner).is_none())
}

/// How far `session`'s jobs are, 0 to 1 (1 without jobs).
fn progress(session: &Session) -> f64 {
    if session.jobs.is_empty() {
        return 1.0;
    }
    let sum: f64 = session
        .jobs
        .iter()
        .map(|job| if job.result.lock().unwrap_or_else(PoisonError::into_inner).is_some() { 1.0 } else { f64::from(job.progress.fraction()).clamp(0.0, 1.0) })
        .sum();
    sum / session.jobs.len() as f64
}

/// The program of `session` at `seconds` (snapped to its frame), opaque over black, as
/// [`FilmDocument::frame`] renders it at `render_scale`, made smaller still to fit `max_width` (1 to
/// [`MAX_ITEM_FRAME_WIDTH`]) and [`MAX_ITEM_FRAME_PIXELS`]: `[width u32 LE][height u32 LE]` then
/// RGBA.
pub(crate) fn program_frame(session: &Session, render_scale: f32, seconds: f64, max_width: u32) -> Result<Vec<u8>, String> {
    let sequence = session.active_sequence().ok_or("no sequence is open")?;
    let (width, height) = (f64::from(sequence.settings.width.max(1)), f64::from(sequence.settings.height.max(1)));
    let mut scale = f64::from(render_scale).min(f64::from(max_width.clamp(1, MAX_ITEM_FRAME_WIDTH)) / width);
    let pixels = width * height * scale * scale;
    if pixels > MAX_ITEM_FRAME_PIXELS as f64 {
        scale *= (MAX_ITEM_FRAME_PIXELS as f64 / pixels).sqrt();
    }
    let time = if seconds.is_finite() { Tick::from_seconds_f64(seconds.max(0.0)) } else { Tick::ZERO };
    let image = session.try_render_program_at(scale as f32, time).map_err(|error| error.to_string())?;
    let (w, h) = (u32::try_from(image.w).map_err(|_| "frame too wide")?, u32::try_from(image.h).map_err(|_| "frame too tall")?);
    let mut out = Vec::with_capacity(8 + image.w * image.h * 4);
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&image.over_black_rgba8());
    Ok(out)
}

impl FilmDocument {
    /// A fresh scratch copy of the document, reading through it and writing nothing.
    fn scratch(&self) -> Session {
        let mut scratch = self.session.scratch();
        scratch.services = Arc::new(ScratchServices { document: Arc::downgrade(&self.services) });
        scratch
    }

    /// Runs `steps` on a new scratch copy and keeps it as the open preview (ending the previous
    /// one first). A refused command, or one that fails, leaves no preview open.
    fn begin(&self, steps: &[(String, Value)]) -> Result<Vec<Value>, String> {
        self.preview_end();
        if let Some(why) = steps.iter().find_map(|(command, _)| refusal(command)) {
            return Err(why);
        }
        let mut scratch = self.scratch();
        let mut results = Vec::with_capacity(steps.len());
        for (command, params) in steps {
            let mut params = params.clone();
            // Make Offline's "delete media files" never runs on the copy (the engine refuses it
            // on a scratch session too); the preview shows the items offline.
            if let Some(fields) = params.as_object_mut() {
                fields.remove("deleteFiles");
            }
            match scratch.execute(command, params) {
                Ok(result) => results.push(result),
                Err(error) => {
                    cancel_jobs(&scratch);
                    return Err(error.to_string());
                }
            }
        }
        scratch.pump_jobs(std::time::Duration::from_millis(5));
        scratch.poll_persistence();
        *self.services.preview.lock().unwrap_or_else(PoisonError::into_inner) = Some(scratch);
        Ok(results)
    }

    /// Runs `body` on the open preview's scratch copy; an error when no preview is open.
    pub(crate) fn with_preview<R>(&self, body: impl FnOnce(&mut Session) -> Result<R, String>) -> Result<R, String> {
        let mut slot = self.services.preview.lock().unwrap_or_else(PoisonError::into_inner);
        body(slot.as_mut().ok_or("no preview is open")?)
    }

    /// Runs `command` with `params` on a new scratch copy of the document and answers the
    /// command's result. The copy stays open for [`Self::preview_frame`] and the rest until
    /// [`Self::preview_end`] or the next begin. Commands outside [`PREVIEW_COMMANDS`], and those
    /// in [`PREVIEW_EXTERNAL`], are refused.
    pub fn preview_begin(&self, command: &str, params: Value) -> Result<Value, String> {
        self.begin(&[(command.to_owned(), params)]).map(|mut results| results.pop().unwrap_or(Value::Null))
    }

    /// Runs several commands, `[{command, params}, …]`, on one new scratch copy (the Manage
    /// dialogs), and answers their results in order.
    pub fn preview_begin_steps(&self, steps: Value) -> Result<Value, String> {
        let steps = steps
            .as_array()
            .ok_or("steps are an array of {command, params}")?
            .iter()
            .map(|step| {
                let command = step.get("command").and_then(Value::as_str).ok_or_else(|| format!("a step without a command: {step}"))?;
                Ok((command.to_owned(), step.get("params").cloned().unwrap_or_else(|| json!({}))))
            })
            .collect::<Result<Vec<_>, String>>()?;
        self.begin(&steps).map(Value::Array)
    }

    /// Advances the preview's jobs (Scene Edit Detection, …) for at most `ms` (up to 1 s) and
    /// applies what finished to the copy: `{pending, progress}`, `progress` from 0 to 1.
    pub fn preview_settle(&self, ms: u32) -> Result<Value, String> {
        let budget = std::time::Duration::from_millis(u64::from(ms.min(1_000)));
        self.with_preview(|scratch| {
            // Stepped jobs (Scene Edit Detection on the copy, exports on the web) advance here, a
            // frame at a time within the budget; only native threads are waited for.
            scratch.pump_jobs(budget.max(std::time::Duration::from_millis(1)));
            scratch.poll_persistence();
            #[cfg(not(target_arch = "wasm32"))]
            {
                let started = std::time::Instant::now();
                while pending(scratch) && started.elapsed() < budget {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                    scratch.pump_jobs(budget.saturating_sub(started.elapsed()).max(std::time::Duration::from_millis(1)));
                    scratch.poll_persistence();
                }
            }
            Ok(json!({ "pending": pending(scratch), "progress": progress(scratch) }))
        })
    }

    /// The preview's program at `seconds`, as the Program monitor renders it at its render scale,
    /// at most `max_width` wide: `[width u32 LE][height u32 LE]` then RGBA over black.
    pub fn preview_frame(&self, seconds: f64, max_width: u32) -> Result<Vec<u8>, String> {
        let scale = self.services.render_scale();
        self.with_preview(|scratch| program_frame(scratch, scale, seconds, max_width))
    }

    /// The preview's sample rate, as [`Self::audio_rate`] answers the document's: a Sequence
    /// Settings preview may change it.
    pub fn preview_audio_rate(&self) -> Result<u32, String> {
        self.with_preview(|scratch| Ok(crate::session_audio_rate(scratch)))
    }

    /// The preview's sequence mix, as [`Self::audio`] mixes the document's.
    pub fn preview_audio(&self, start_seconds: f64, frames: u32) -> Result<Vec<f32>, String> {
        self.with_preview(|scratch| crate::session_audio(scratch, &self.services.levels, start_seconds, frames))
    }

    /// The preview's `inspect()`, the same shape as the document's ([`KitDocument::inspect`]), for
    /// the panels that draw it (the Timeline lays out the preview's sequence). `canUndo` and
    /// `canRedo` are the document's: the copy's history holds only the previewed command, which
    /// is never undone.
    ///
    /// [`KitDocument::inspect`]: kition_kit::KitDocument::inspect
    pub fn preview_inspect(&self) -> Result<Value, String> {
        let (undo, redo) = (self.session.history.can_undo(), self.session.history.can_redo());
        self.with_preview(|scratch| {
            let mut inspected = crate::inspect_session(scratch);
            inspected["canUndo"] = json!(undo);
            inspected["canRedo"] = json!(redo);
            Ok(inspected)
        })
    }

    /// What the preview changed against the document: `{project, sequences, tracks, clips,
    /// items, bins, markers, captions, selection, projectSelection}` (see [`diff`] for the
    /// entries).
    pub fn preview_diff(&self) -> Result<Value, String> {
        self.with_preview(|scratch| Ok(diff::project_diff(&self.session.project, &self.session.state, &scratch.project, &scratch.state)))
    }

    /// Runs a read-only query (a command that writes no journal entry) on the preview's copy and
    /// answers its result: the Project panel's rows, a search bin's items, the mixer, presets.
    /// A journaled command and one that writes outside the project are refused. The query runs
    /// on a throwaway copy of the copy (the same project `Arc`, a fork of its media pool), so
    /// whatever session state it sets (a proxy switch, Link Media's prompt) is dropped with it.
    pub fn preview_query(&self, command: &str, params: Value) -> Result<Value, String> {
        let spec = kition_film_engine::find_command(command).ok_or_else(|| format!("unknown command `{command}`"))?;
        if spec.journal {
            return Err(format!("`{command}` changes the project; a preview runs only read-only queries"));
        }
        if PREVIEW_EXTERNAL.contains(&command) {
            return Err(format!("`{command}` writes outside the project; a preview runs only read-only queries"));
        }
        self.with_preview(|scratch| scratch.scratch().execute(command, params).map_err(|error| error.to_string()))
    }

    /// Project item `item` of the preview's copy at `seconds`, as [`Self::item_frame`] draws the
    /// document's: for an item only the preview has (a new matte, a subclip).
    pub fn preview_item_frame(&self, item: u64, seconds: f64, max_width: u32) -> Result<Vec<u8>, String> {
        self.with_preview(|scratch| crate::panels::session_item_frame(scratch, item, seconds, max_width))
    }

    /// Ends the preview: its jobs are cancelled and its copy dropped. Nothing happens without one.
    pub fn preview_end(&self) {
        if let Some(scratch) = self.services.preview.lock().unwrap_or_else(PoisonError::into_inner).take() {
            cancel_jobs(&scratch);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{HOST_ROOT, fixture, tone_wav};
    use crate::{KitDocument, inspect_session};
    use kition_film_engine::project::ItemId;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    fn clip_at(doc: &FilmDocument, track: usize, index: usize) -> u64 {
        let inspected = doc.inspect().unwrap();
        inspected["sequence"]["video"][track]["items"][index]["clip"].as_u64().unwrap_or_else(|| panic!("no clip in {inspected}"))
    }

    fn rgb(frame: &[u8], x: u32, y: u32) -> [u8; 3] {
        let w = u32::from_le_bytes(frame[0..4].try_into().unwrap());
        let at = 8 + ((y * w + x) * 4) as usize;
        [frame[at], frame[at + 1], frame[at + 2]]
    }

    /// Every file under `dir`, with its size and contents' length.
    fn files(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut out = BTreeMap::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(at) = stack.pop() {
            for entry in std::fs::read_dir(&at).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.insert(path.clone(), std::fs::read(&path).unwrap_or_default());
                }
            }
        }
        out
    }

    /// What a preview must leave as it was.
    #[derive(Debug, PartialEq)]
    struct Untouched {
        version: Vec<u8>,
        revision: u64,
        history: Value,
        inspect: Value,
        journal: usize,
        jobs: Value,
        /// The Project panel's rows (offline, missing, …).
        items: Value,
        /// The media pool's view of each item (online, offline, and why).
        status: Value,
        /// Get Properties for each file item.
        properties: Value,
        /// The address of each item's decoded source in the document's pool: the same `Arc`s,
        /// so nothing is decoded again.
        sources: BTreeMap<u64, usize>,
        memory: Vec<String>,
        files: BTreeMap<PathBuf, Vec<u8>>,
    }

    fn untouched(doc: &mut FilmDocument, dir: Option<&Path>) -> Untouched {
        let mut memory: Vec<String> = doc.services.memory.lock().unwrap().keys().cloned().collect();
        memory.sort();
        let journal = doc.session.journal.len();
        let ids: Vec<u64> = doc.session.project.items.keys().map(|id| id.0).collect();
        let files_only: Vec<u64> = ids
            .iter()
            .copied()
            .filter(|id| {
                doc.session
                    .project
                    .item(ItemId(*id))
                    .and_then(|item| item.as_media())
                    .is_some_and(|media| matches!(media.media, kition_film_engine::project::MediaRef::File { .. }))
            })
            .collect();
        let mut query = |command: &str, params: Value| doc.session.execute(command, params).unwrap_or_else(|error| json!({ "error": error.to_string() }));
        let items = query("project.items", json!({ "recursive": true }));
        let status = query("media.status", json!({}));
        let properties = Value::Array(files_only.iter().map(|id| query("file.mediaProperties", json!({ "items": [id] }))).collect());
        // Get Properties is journaled; the snapshot itself must not count.
        doc.session.journal.truncate(journal);
        let sources =
            ids.iter().filter_map(|id| doc.session.media.cached(ItemId(*id)).map(|source| (*id, Arc::as_ptr(&source) as *const () as usize))).collect();
        Untouched {
            version: doc.version().unwrap(),
            revision: doc.revision(),
            history: doc.session.execute("history.list", json!({})).unwrap(),
            inspect: doc.inspect().unwrap(),
            journal,
            jobs: doc.session.execute("jobs.list", json!({})).unwrap(),
            items,
            status,
            properties,
            sources,
            memory,
            files: dir.map(files).unwrap_or_default(),
        }
    }

    /// Runs `body` with media lent by the host from a fresh folder: `tone.wav`, copies of it for
    /// an item to make offline and for a proxy, and a still image.
    fn with_host(tag: &str, body: impl FnOnce(&Path)) {
        let _lock = HOST_ROOT.lock().unwrap_or_else(PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("kition-film-preview-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["tone.wav", "lost.wav", "tone_Proxy.wav"] {
            std::fs::write(dir.join(name), tone_wav()).unwrap();
        }
        let mut still = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        still.execute("file.exportFrame", json!({ "path": "still.png", "format": "png" })).unwrap();
        std::fs::write(dir.join("still.png"), still.take_file("still.png").expect("a PNG")).unwrap();
        kition_kit::host::set_root(Some(dir.clone()));
        body(&dir);
        kition_kit::host::set_root(None);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Ids in [`rich`]'s project.
    struct Rich {
        red: u64,
        blue: u64,
        matte: u64,
        tone: u64,
        lost: u64,
        subclip: u64,
        title: u64,
        marker: u64,
    }

    /// Two colour mattes on V1 (red, then blue), a title on V2, a tone on A1 with a proxy, an
    /// offline item, a subclip, a still image, a sequence marker, a bin, and a view preset; the
    /// red clip copied, the blue one selected, and the red matte selected in the Project panel.
    /// The document has drawn its picture and sound, so its pool holds decoded sources.
    fn rich() -> (FilmDocument, Rich) {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let imported = doc.execute("file.import", json!({ "paths": ["tone.wav", "lost.wav", "still.png"] })).unwrap();
        let (tone, lost) = (imported["items"][0].as_u64().unwrap(), imported["items"][1].as_u64().unwrap());
        assert_eq!(imported["items"].as_array().map(Vec::len), Some(3), "{imported}");
        doc.execute("timeline.place", json!({ "item": tone, "track": "A1", "seconds": 0.0 })).unwrap();
        doc.execute("media.attachProxies", json!({ "item": tone, "path": "tone_Proxy.wav" })).unwrap();
        doc.execute("media.makeOffline", json!({ "items": [lost] })).unwrap();
        let half = kition_film_engine::time::TICKS_PER_SECOND / 2;
        let subclip = doc.execute("clip.makeSubclip", json!({ "item": tone, "start": 0, "end": half })).unwrap()["item"].as_u64().unwrap();
        let matte = doc.execute("file.newColorMatte", json!({ "color": "#ff0000", "seconds": 4.0 })).unwrap()["item"].as_u64().unwrap();
        doc.execute("timeline.place", json!({ "item": matte, "track": "V1", "seconds": 0.0 })).unwrap();
        let blue = doc.execute("file.newColorMatte", json!({ "color": "#0000ff", "seconds": 2.0 })).unwrap()["item"].as_u64().unwrap();
        doc.execute("timeline.place", json!({ "item": blue, "track": "V1", "seconds": 4.0 })).unwrap();
        doc.execute("timeline.select", json!({ "clips": [] })).unwrap();
        doc.execute("graphics.newText", json!({ "text": "Title", "newClip": true })).unwrap();
        doc.execute("markers.add", json!({ "name": "Marker" })).unwrap();
        doc.execute("file.newBin", json!({ "name": "Bin" })).unwrap();
        doc.execute("project.viewPreset.saveAs", json!({ "name": "View 1", "slot": 1 })).unwrap();
        let (red, blue) = (clip_at(&doc, 0, 0), clip_at(&doc, 0, 1));
        let title = clip_at(&doc, 1, 0);
        doc.execute("timeline.select", json!({ "clips": [red] })).unwrap();
        doc.execute("edit.copy", json!({})).unwrap();
        // The last clip on V1, so a dialog that makes it longer (Nest, Speed/Duration) has room.
        doc.execute("timeline.select", json!({ "clips": [blue] })).unwrap();
        doc.execute("project.select", json!({ "items": [matte] })).unwrap();
        let marker = doc.inspect().unwrap()["sequence"]["markers"][0]["id"].as_u64().unwrap();
        doc.render(0.0, 0.0, 1.0, 64, 36).unwrap();
        doc.audio(0.0, 4_800).unwrap();
        for item in imported["items"].as_array().unwrap().iter().chain([&json!(subclip), &json!(matte), &json!(blue)]) {
            let _ = doc.item_frame(item.as_u64().unwrap(), 0.0, 32);
        }
        doc.take_events();
        (doc, Rich { red, blue, matte, tone, lost, subclip, title, marker })
    }

    /// The params a dialog opens with for `command` on [`rich`]'s project.
    fn dialog_defaults(command: &str, ids: &Rich) -> Value {
        let half = kition_film_engine::time::TICKS_PER_SECOND / 2;
        match command {
            "clip.audioChannels" => json!({ "items": [ids.tone], "format": "stereo" }),
            "clip.audioGain" => json!({ "db": 3.0 }),
            "clip.editOffline" => json!({ "item": ids.lost, "mediaName": "Lost Tape" }),
            "clip.editSubclip" => json!({ "item": ids.subclip, "start": 0, "end": half / 2, "convertToMaster": true }),
            "clip.interpretFootage" => json!({ "colorSpace": "auto" }),
            "clip.mergeClips" => json!({ "items": [ids.matte, ids.tone], "method": "in" }),
            "clip.modifyTimecode" => json!({ "timecode": "01:00:00:00" }),
            "clip.nest" => json!({ "name": "Nested Sequence 01" }),
            "clip.speedDuration" => json!({ "speed": 50.0 }),
            "clip.synchronize" => json!({ "method": "in", "clips": [ids.red, ids.blue] }),
            "edit.find" => json!({ "text": "Color" }),
            "file.newColorMatte" => json!({ "color": "#00ff00", "seconds": 5.0 }),
            "file.newSearchBin" => json!({ "column": "Name", "operator": "contains", "text": "tone" }),
            "file.newSequence" => json!({ "name": "Sequence 02" }),
            "file.replaceFonts" => json!({ "from": "Inter", "to": "Helvetica" }),
            "graphics.set" => json!({ "clip": ids.title, "layer": 0, "props": { "opacity": 50 } }),
            "graphics.setTextType" => json!({ "clip": ids.title, "layer": 0, "type": "paragraph" }),
            "markers.edit" => json!({ "marker": ids.marker, "name": "Edited" }),
            "media.makeOffline" => json!({ "items": [ids.tone], "deleteFiles": true }),
            "media.relink" => json!({ "item": ids.lost, "path": "tone.wav", "force": true }),
            "presets.save" => json!({ "clip": ids.red, "effects": [0], "name": "Preview Preset" }),
            "project.columns.set" => json!({ "columns": ["Name", "Media Duration"] }),
            "project.freeform.options" => json!({ "grid": 20, "snap": true }),
            "project.freeform.saveArrangement" => json!({ "name": "Arrangement" }),
            "project.matteColor" => json!({ "item": ids.matte, "color": "#00ff00" }),
            "project.viewPreset.delete" | "project.viewPreset.restore" => json!({ "slot": 1 }),
            "project.viewPreset.rename" => json!({ "slot": 1, "name": "Renamed" }),
            "project.viewPreset.saveAs" => json!({ "name": "View 2" }),
            "sequence.deleteTracks" => json!({ "video": "empty", "audio": "empty" }),
            _ => json!({}),
        }
    }

    #[test]
    fn a_preview_changes_only_its_copy() {
        with_host("begin", |dir| {
            let (mut doc, ids) = rich();
            let before = untouched(&mut doc, Some(dir));
            doc.preview_begin("clip.speedDuration", json!({ "clips": [ids.red], "speed": 50.0 })).unwrap();
            assert_eq!(doc.with_preview(|scratch| Ok(scratch.journal.len())).unwrap(), 1, "the copy keeps its own journal");
            let speed = |inspected: &Value| inspected["sequence"]["video"][0]["items"][0]["speed"].as_f64().unwrap();
            let copy = doc.with_preview(|scratch| Ok(inspect_session(scratch))).unwrap();
            assert_eq!((speed(&copy), speed(&before.inspect)), (0.5, 1.0), "the copy plays at half speed");
            assert!(doc.with_preview(|scratch| Ok(scratch.kdm().is_none())).unwrap(), "the copy never makes a replica");
            assert_eq!(doc.take_events(), json!([]), "no event reaches the page");
            assert_eq!(untouched(&mut doc, Some(dir)), before);
            doc.preview_end();
            assert_eq!(untouched(&mut doc, Some(dir)), before);
        });
    }

    #[test]
    fn a_preview_frame_shows_the_change_and_ends_with_the_preview() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let red = clip_at(&doc, 0, 0);
        let matte = doc.execute("file.newColorMatte", json!({ "color": "#0000ff", "seconds": 2.0 })).unwrap();
        doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 4.0 })).unwrap();
        let faded = clip_at(&doc, 0, 1);
        doc.execute("effects.setParam", json!({ "clip": faded, "effect": "opacity", "param": "opacity", "value": 25.0 })).unwrap();
        doc.execute("timeline.select", json!({ "clips": [faded] })).unwrap();
        doc.execute("edit.copy", json!({})).unwrap();
        let own = program_frame(&doc.session, 1.0, 1.0, 64).unwrap();
        let before = untouched(&mut doc, None);

        doc.preview_begin("edit.pasteAttributes", json!({ "clips": [red] })).unwrap();
        let preview = doc.preview_frame(1.0, 64).unwrap();
        assert_eq!(rgb(&own, 10, 10), [255, 0, 0], "the document's red at full opacity");
        let [r, g, b] = rgb(&preview, 10, 10);
        // 25 % of linear red over black, encoded again
        assert!((100..=180).contains(&r) && g == 0 && b == 0, "the preview's red at 25 % opacity over black, got {:?}", [r, g, b]);
        assert_eq!(u32::from_le_bytes(preview[0..4].try_into().unwrap()), 64);
        assert_eq!(u32::from_le_bytes(doc.preview_frame(1.0, 16).unwrap()[0..4].try_into().unwrap()), 16, "at most max_width");
        doc.set_render_scale(0.25).unwrap();
        assert_eq!(u32::from_le_bytes(doc.preview_frame(1.0, 64).unwrap()[0..4].try_into().unwrap()), 16, "at the render scale");
        doc.set_render_scale(1.0).unwrap();
        assert_eq!(untouched(&mut doc, None), before);

        doc.preview_end();
        assert!(doc.preview_frame(1.0, 64).is_err(), "no preview after its end");
        assert!(doc.preview_audio(0.0, 480).is_err());
        assert!(doc.preview_settle(1).is_err());
    }

    #[test]
    fn a_preview_mixes_its_copys_sound() {
        with_host("audio", |_| {
            let (doc, ids) = rich();
            let loud = |samples: &[f32]| samples.iter().fold(0f32, |peak, sample| peak.max(sample.abs()));
            let own = loud(&doc.audio(0.25, 4_800).unwrap());
            doc.preview_begin("clip.audioGain", json!({ "clips": [doc.inspect().unwrap()["sequence"]["audio"][0]["items"][0]["clip"]], "db": -20.0 })).unwrap();
            let heard = doc.preview_audio(0.25, 4_800).unwrap();
            assert_eq!(heard.len(), 4_800 * 2);
            assert!(loud(&heard) < own * 0.2 && loud(&heard) > 0.0, "20 dB quieter: {} against {own}", loud(&heard));
            assert_eq!(loud(&doc.audio(0.25, 4_800).unwrap()), own, "the document's sound is unchanged");
            let _ = ids;
        });
    }

    #[test]
    fn a_preview_answers_its_own_sample_rate() {
        let doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        assert!(doc.preview_audio_rate().is_err(), "no preview is open");
        doc.preview_begin("sequence.settings", json!({ "sampleRate": 44_100 })).unwrap();
        assert_eq!((doc.preview_audio_rate().unwrap(), doc.audio_rate()), (44_100, 48_000));
        assert_eq!(doc.preview_audio(0.0, 4_410).unwrap().len(), 4_410 * 2);
    }

    #[test]
    fn each_begin_starts_from_the_document() {
        let (doc, red) = {
            let doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
            let red = clip_at(&doc, 0, 0);
            (doc, red)
        };
        let duration = |doc: &FilmDocument| {
            doc.with_preview(|scratch| Ok(inspect_session(scratch)["sequence"]["video"][0]["items"][0]["duration"].as_i64().unwrap())).unwrap()
        };
        let own = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["duration"].as_i64().unwrap();
        doc.preview_begin("clip.speedDuration", json!({ "clips": [red], "speed": 50.0 })).unwrap();
        assert_eq!(duration(&doc), own * 2);
        doc.preview_begin("clip.speedDuration", json!({ "clips": [red], "speed": 200.0 })).unwrap();
        assert_eq!(duration(&doc), own / 2, "from the document, not from the previous preview");
    }

    #[test]
    fn steps_run_on_one_copy() {
        let doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let own = doc.inspect().unwrap()["sequence"]["video"].as_array().unwrap().len();
        let results = doc
            .preview_begin_steps(json!([
                { "command": "sequence.addTracks", "params": { "video": 1, "audio": 0 } },
                { "command": "sequence.addTracks", "params": { "video": 2, "audio": 0 } },
            ]))
            .unwrap();
        assert_eq!(results.as_array().map(Vec::len), Some(2));
        let tracks = doc.with_preview(|scratch| Ok(inspect_session(scratch)["sequence"]["video"].as_array().unwrap().len())).unwrap();
        assert_eq!(tracks, own + 3);
        assert_eq!(doc.inspect().unwrap()["sequence"]["video"].as_array().unwrap().len(), own);
        assert!(doc.preview_begin_steps(json!([{ "params": {} }])).is_err(), "a step names its command");
        assert!(doc.preview_begin_steps(json!([{ "command": "sequence.addTracks" }, { "command": "file.exportMedia" }])).is_err());
        assert!(doc.preview_frame(0.0, 64).is_err(), "a refused step leaves no preview open");
    }

    #[test]
    fn ok_equals_the_direct_command() {
        /// What OK must make, read from `session`: the command's inspect (without the undo
        /// state: the copy's history starts empty), the Project panel's rows, and media status.
        fn shown(session: &mut Session) -> Value {
            let mut inspected = inspect_session(session);
            if let Some(fields) = inspected.as_object_mut() {
                fields.remove("canUndo");
                fields.remove("canRedo");
            }
            let items = session.execute("project.items", json!({ "recursive": true })).unwrap();
            let status = session.execute("media.status", json!({})).unwrap();
            json!({ "inspect": inspected, "items": items, "status": status })
        }
        with_host("ok", |_| {
            for command in PREVIEW_COMMANDS {
                let (mut doc, ids) = rich();
                let params = dialog_defaults(command, &ids);
                let previewed = doc.preview_begin(command, params.clone()).unwrap_or_else(|error| panic!("{command}: {error}"));
                doc.preview_settle(1_000).unwrap();
                let copy = doc.with_preview(|scratch| Ok(shown(scratch))).unwrap();
                doc.preview_end();
                let direct = doc.execute(command, params).unwrap_or_else(|error| panic!("{command}: {error}"));
                // a job the command started (Scene Edit Detection) applies its result when it ends
                for _ in 0..1_000 {
                    doc.session.poll_persistence();
                    if !pending(&doc.session) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                assert_eq!(previewed, direct, "{command}: the same result");
                assert_eq!(copy, shown(&mut doc.session), "{command}: OK makes what the preview showed");
            }
        });
    }

    #[test]
    fn every_dialog_command_previews_without_touching_the_document() {
        with_host("every", |dir| {
            let mut skipped = Vec::new();
            for command in PREVIEW_COMMANDS {
                assert!(kition_film_engine::find_command(command).is_some(), "{command} is a command");
                assert!(!PREVIEW_EXTERNAL.contains(command), "{command} is listed once");
                let (mut doc, ids) = rich();
                let before = untouched(&mut doc, Some(dir));
                match doc.preview_begin(command, dialog_defaults(command, &ids)) {
                    Ok(_) => {
                        doc.preview_settle(200).unwrap();
                        assert!(doc.with_preview(|scratch| Ok(scratch.kdm().is_none())).unwrap(), "{command}: no replica");
                        // drawing the preview opens, relinks, and marks offline in the copy's pool only
                        for seconds in [0.25, 1.0, 4.5] {
                            doc.preview_frame(seconds, 64).unwrap_or_else(|error| panic!("{command}: {error}"));
                            doc.preview_audio(seconds, 4_800).unwrap_or_else(|error| panic!("{command}: {error}"));
                        }
                        assert!(doc.preview_audio_rate().unwrap() > 0);
                    }
                    Err(error) => skipped.push(format!("{command}: {error}")),
                }
                assert_eq!(doc.take_events(), json!([]), "{command}: no event reaches the page");
                assert_eq!(untouched(&mut doc, Some(dir)), before, "{command}: the document is untouched");
                doc.preview_end();
                assert_eq!(untouched(&mut doc, Some(dir)), before, "{command}: the document is untouched after the end");
            }
            eprintln!("{} of {} dialog commands refused on the fixture:\n  {}", skipped.len(), PREVIEW_COMMANDS.len(), skipped.join("\n  "));
            assert!(skipped.is_empty(), "every dialog command previews on the fixture");
        });
    }

    /// The review's case: Make Offline, then drawing the preview, left the document's item
    /// offline through a shared media pool.
    #[test]
    fn a_preview_leaves_the_documents_media_alone() {
        with_host("media", |dir| {
            let (mut doc, ids) = rich();
            let before = untouched(&mut doc, Some(dir));
            let online = |doc: &mut FilmDocument| {
                let rows = doc.session.execute("project.items", json!({ "recursive": true })).unwrap();
                let row = rows["rows"].as_array().unwrap().iter().find(|row| row["item"] == ids.tone).cloned().unwrap_or_else(|| panic!("no row in {rows}"));
                assert_eq!(row["offline"], false, "{row}");
                row.to_string()
            };
            let row = online(&mut doc);
            let steps: [(&str, Value); 6] = [
                ("media.makeOffline", json!({ "items": [ids.tone] })),
                ("media.offlineAll", json!({})),
                ("media.relink", json!({ "item": ids.lost, "path": "tone.wav", "force": true })),
                ("clip.editSubclip", json!({ "item": ids.subclip, "start": 0, "end": 1000, "convertToMaster": true })),
                ("file.newColorMatte", json!({ "color": "#00ff00", "seconds": 1.0 })),
                ("clip.mergeClips", json!({ "items": [ids.matte, ids.tone], "method": "in" })),
            ];
            for (command, params) in steps {
                doc.preview_begin(command, params).unwrap_or_else(|error| panic!("{command}: {error}"));
                doc.preview_frame(0.25, 64).unwrap();
                doc.preview_audio(0.25, 4_800).unwrap();
                doc.preview_end();
                assert_eq!(online(&mut doc), row, "{command}: the document's row is as it was");
                assert_eq!(untouched(&mut doc, Some(dir)), before, "{command}");
            }
            // Reconnect Full Resolution Media goes to a host picker, with no dialog; a copy that
            // runs it still leaves the document's pool alone.
            let mut scratch = doc.scratch();
            scratch.execute("media.reconnectFullRes", json!({ "item": ids.tone, "path": "tone.wav" })).unwrap();
            scratch.media.full_res_source(&scratch.project, ItemId(ids.tone), &*scratch.services).unwrap();
            crate::session_audio(&scratch, &doc.services.levels, 0.25, 4_800).unwrap();
            drop(scratch);
            assert_eq!(untouched(&mut doc, Some(dir)), before, "media.reconnectFullRes");
        });
    }

    /// Task 17: Link Media's preview relinks the offline item on the copy once Locate… picks its
    /// file (with upstream's match options), and Make Offline's marks an online file offline on
    /// the copy. The copy shows each (its status, its row, and its item's picture), while the
    /// document's thumbnails (its item frames), its program picture, its media status, its
    /// session's missing list, its rows, and its decoded sources stay as they were, during the
    /// preview and after it ends.
    #[test]
    fn link_media_and_make_offline_previews_leave_the_documents_media_alone() {
        with_host("link", |dir| {
            let (mut doc, ids) = rich();
            let still = doc.session.project.items.values().find(|item| item.name == "still.png").map(|item| item.id.0).expect("the still");
            doc.session.execute("media.linkMedia", json!({})).unwrap();
            let missing = doc.session.offline.missing.clone();
            assert_eq!(missing, vec![ItemId(ids.lost)], "Link Media lists the offline item");
            let pictures =
                |doc: &FilmDocument| ([still, ids.matte].map(|item| doc.item_frame(item, 0.0, 32).unwrap()), doc.render(0.0, 0.0, 1.0, 64, 36).unwrap());
            let shown = pictures(&doc);
            let before = untouched(&mut doc, Some(dir));
            let status =
                |answer: &Value, item: u64| answer.as_array().unwrap().iter().find(|row| row["item"] == item).map(|row| row["status"].clone()).unwrap();
            let check = |doc: &mut FilmDocument, what: &str| {
                assert_eq!(pictures(doc), shown, "{what}: the document's thumbnails and picture");
                assert_eq!(doc.session.offline.missing, missing, "{what}: the document's missing list");
                assert_eq!(untouched(doc, Some(dir)), before, "{what}: the document");
            };

            // Link Media ▸ Locate… picks lost.wav again: the copy relinks it and shows it online.
            let link = json!({
                "item": ids.lost,
                "path": "lost.wav",
                "match": { "fileName": true, "extension": true, "clipId": true, "duration": true, "mediaStart": false, "metadata": true },
                "alignTimecode": false,
                "relinkOthers": true,
            });
            let answer = doc.preview_begin("media.relink", link).unwrap();
            assert_eq!(answer["relinked"], json!([{ "item": ids.lost, "path": "lost.wav" }]), "{answer}");
            assert_eq!(status(&doc.preview_query("media.status", json!({})).unwrap(), ids.lost), "online");
            assert!(doc.with_preview(|scratch| Ok(scratch.offline.missing.is_empty())).unwrap(), "the copy's missing list is its own");
            doc.preview_audio(0.25, 4_800).unwrap();
            check(&mut doc, "Link Media's preview");
            assert_eq!(status(&doc.session.execute("media.status", json!({})).unwrap(), ids.lost), "offline");
            doc.preview_end();
            check(&mut doc, "after Link Media's preview");

            // Make Offline on the still: the copy draws its offline slate; the document's thumbnail stays.
            doc.preview_begin("media.makeOffline", json!({ "items": [still], "deleteFiles": false })).unwrap();
            assert_eq!(status(&doc.preview_query("media.status", json!({})).unwrap(), still), "offline");
            assert_ne!(doc.preview_item_frame(still, 0.0, 32).unwrap(), shown.0[0], "the copy shows the slate");
            check(&mut doc, "Make Offline's preview");
            doc.preview_end();
            check(&mut doc, "after Make Offline's preview");
            assert_eq!(status(&doc.session.execute("media.status", json!({})).unwrap(), still), "online");

            // Link Media's Cancel and Offline All run `media.offlineAll` on the document, as
            // upstream's: it clears the open-time prompt only, with no history step, no revision,
            // no replica change, and the same inspect().
            doc.session.offline.prompt = true;
            doc.execute("media.offlineAll", json!({})).unwrap();
            assert!(!doc.session.offline.prompt);
            assert_eq!(untouched(&mut doc, Some(dir)), before, "media.offlineAll");
        });
    }

    #[test]
    fn commands_that_write_outside_the_project_preview_as_a_summary() {
        with_host("external", |dir| {
            let (mut doc, ids) = rich();
            let before = untouched(&mut doc, Some(dir));
            for command in PREVIEW_EXTERNAL {
                assert!(kition_film_engine::find_command(command).is_some(), "{command} is a command");
                let params = json!({ "path": "Out.mp4", "items": [ids.matte], "clips": [ids.red], "wait": true });
                let error = doc.preview_begin(command, params).unwrap_err();
                assert!(error.contains("previews as a summary"), "{command}: {error}");
                assert!(doc.preview_frame(0.0, 64).is_err(), "{command}: no preview is open");
            }
            assert!(doc.preview_begin("edit.undo", json!({})).unwrap_err().contains("not a dialog command"));
            assert_eq!(untouched(&mut doc, Some(dir)), before, "no file is written");
        });
    }

    #[test]
    fn the_copy_writes_no_file() {
        let services = Arc::new(KitServices::default());
        services.write_file("Edit.kfilm", b"project").unwrap();
        let scratch = ScratchServices { document: Arc::downgrade(&services) };
        assert_eq!(scratch.read_file("Edit.kfilm").unwrap(), b"project");
        assert_eq!(scratch.write_file("Out.mp4", b"bytes").unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
        assert!(services.memory("Out.mp4").is_none());
        drop(services);
        assert!(scratch.read_file("Edit.kfilm").is_err(), "the document is gone");
    }

    #[test]
    fn a_job_runs_on_the_copys_own_list_and_ends_with_it() {
        with_host("jobs", |_| {
            let (mut doc, ids) = rich();
            let jobs = doc.session.execute("jobs.list", json!({})).unwrap();
            let started = doc.preview_begin("clip.sceneEditDetection", json!({ "clips": [ids.red], "createSubclips": true })).unwrap();
            assert!(started["job"].is_u64(), "{started}");
            let progress = doc.with_preview(|scratch| Ok(scratch.jobs.first().map(|job| job.progress.clone()))).unwrap().expect("the copy's job");
            assert_eq!(doc.session.execute("jobs.list", json!({})).unwrap(), jobs, "the document's jobs never show it");
            let mut report = json!({});
            for _ in 0..200 {
                report = doc.preview_settle(20).unwrap();
                if report["pending"] == false {
                    break;
                }
            }
            assert_eq!(report["pending"], false, "{report}");
            assert_eq!(report["progress"], 1.0, "{report}");
            assert_eq!(doc.session.execute("jobs.list", json!({})).unwrap(), jobs);
            doc.preview_end();
            assert!(progress.cancel.load(std::sync::atomic::Ordering::Relaxed), "the end cancels the copy's jobs");

            // a job still running when the preview ends is cancelled too
            doc.preview_begin("clip.sceneEditDetection", json!({ "clips": [ids.red] })).unwrap();
            let progress = doc.with_preview(|scratch| Ok(scratch.jobs.first().map(|job| job.progress.clone()))).unwrap().expect("the copy's job");
            doc.preview_end();
            assert!(progress.cancel.load(std::sync::atomic::Ordering::Relaxed));
            assert_eq!(doc.session.execute("jobs.list", json!({})).unwrap(), jobs);
        });
    }

    /// Scene Edit Detection's preview is a stepped job (WebAssembly has no threads, and this is
    /// the path it takes there, run natively): `previewBegin` answers before the analysis ends,
    /// each `previewSettle` reads at most its budget's frames with the progress, the markers it
    /// makes land on the copy only, and `previewEnd` mid-job stops it with the document untouched.
    #[test]
    fn scene_edit_detection_previews_a_step_at_a_time_and_its_end_stops_it() {
        with_host("scene", |dir| {
            let mut doc = FilmDocument::create("Edit.kfilm", 640, 360).unwrap();
            // A Universal Counting Leader cuts every second at full sensitivity.
            let leader = doc.execute("file.newCountingLeader", json!({})).unwrap()["item"].as_u64().unwrap();
            doc.execute("timeline.place", json!({ "item": leader, "track": "V1", "seconds": 0.0 })).unwrap();
            let clip = clip_at(&doc, 0, 0);
            let params = json!({ "clips": [clip], "applyCuts": false, "generateMarkers": true, "sensitivity": 100.0 });
            let before = untouched(&mut doc, Some(dir));
            let started = doc.preview_begin("clip.sceneEditDetection", params.clone()).unwrap();
            let frames = started["frames"].as_u64().unwrap();
            assert!(frames > 100, "{started}");
            assert_eq!(doc.with_preview(|scratch| Ok(scratch.stepped.len())).unwrap(), 1, "a stepped job on the copy");
            let mut seen = Vec::new();
            let mut report = json!({});
            for _ in 0..10_000 {
                report = doc.preview_settle(1).unwrap();
                seen.push(report["progress"].as_f64().unwrap());
                if report["pending"] == false {
                    break;
                }
            }
            assert_eq!(report["pending"], false, "{report}");
            assert!(seen.len() > 2 && seen.windows(2).all(|w| w[0] <= w[1]) && seen[0] < 1.0, "a budget at a time: {seen:?}");
            assert_eq!(report["progress"], 1.0);
            let diff = doc.preview_diff().unwrap();
            let added: Vec<&Value> = diff["markers"]["added"].as_array().unwrap().iter().filter(|m| m["ownerKind"] == "item" && m["owner"] == leader).collect();
            assert!(added.len() >= 3, "the leader's cut markers on the copy: {diff}");
            assert!(added.iter().all(|m| m["name"] == "Scene Edit" && m["color"] == "Green"), "{added:?}");
            doc.preview_end();
            assert_eq!(untouched(&mut doc, Some(dir)), before, "the document is untouched");

            // Ended mid-job: it stops, and nothing reaches the document.
            doc.preview_begin("clip.sceneEditDetection", params).unwrap();
            let progress = doc.with_preview(|scratch| Ok(scratch.jobs[0].progress.clone())).unwrap();
            assert_eq!(doc.preview_settle(1).unwrap()["pending"], true);
            doc.preview_end();
            assert!(progress.cancel.load(std::sync::atomic::Ordering::Relaxed));
            assert!(progress.done.load(std::sync::atomic::Ordering::Relaxed) < frames, "stopped before its end");
            assert_eq!(untouched(&mut doc, Some(dir)), before);
        });
    }

    #[test]
    fn a_peers_changes_keep_the_project_epoch_and_a_new_project_moves_it() {
        // The page closes a previewing dialog when the epoch moves: never for a collaborator's edit.
        let mut a = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let bytes = a.save(None).unwrap();
        let snapshot = a.snapshot().unwrap();
        let mut b = FilmDocument::open_with_replica("Edit.kfilm", &bytes, &snapshot, &[]).unwrap();
        let epoch = |doc: &FilmDocument| doc.inspect().unwrap()["project"]["epoch"].as_u64().unwrap();
        let start = epoch(&a);
        b.execute("file.newBin", json!({ "name": "Peer" })).unwrap();
        let since = a.version().unwrap();
        a.import_changes(&b.export_changes(&since).unwrap()).unwrap();
        assert!(a.inspect().unwrap().to_string().contains("Peer"), "the peer's bin arrived");
        assert_eq!(epoch(&a), start);
        a.execute("file.newProject", json!({ "name": "Other" })).unwrap();
        assert_eq!(epoch(&a), start + 1);
    }

    #[test]
    fn a_peers_change_waits_for_the_next_preview() {
        let mut a = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        a.execute("sequence.addTracks", json!({ "video": 1, "audio": 0 })).unwrap();
        let bytes = a.save(None).unwrap();
        let snapshot = a.snapshot().unwrap();
        let mut b = FilmDocument::open_with_replica("Edit.kfilm", &bytes, &snapshot, &[]).unwrap();
        let red = clip_at(&a, 0, 0);
        let tracks = |doc: &FilmDocument| doc.with_preview(|scratch| Ok(inspect_session(scratch)["sequence"]["video"].as_array().unwrap().len())).unwrap();

        a.preview_begin("clip.speedDuration", json!({ "clips": [red], "speed": 50.0 })).unwrap();
        let shown = tracks(&a);
        b.execute("sequence.addTracks", json!({ "video": 2, "audio": 0 })).unwrap();
        let since = a.version().unwrap();
        a.import_changes(&b.export_changes(&since).unwrap()).unwrap();
        assert_eq!(a.inspect().unwrap()["sequence"]["video"].as_array().unwrap().len(), shown + 2, "the document has the peer's tracks");
        assert_eq!(tracks(&a), shown, "the open preview is unchanged");

        a.preview_begin("clip.speedDuration", json!({ "clips": [red], "speed": 50.0 })).unwrap();
        assert_eq!(tracks(&a), shown + 2, "the next preview sees the peer's change");
    }

    /// The ids a part of [`FilmDocument::preview_diff`] lists under `kind` (`added`, `removed`).
    fn listed(diff: &Value, part: &str, kind: &str) -> Vec<u64> {
        diff[part][kind].as_array().unwrap_or_else(|| panic!("no {part}.{kind} in {diff}")).iter().map(|entry| entry["id"].as_u64().unwrap()).collect()
    }

    /// The entry a part of the diff lists under `kind` for `id` (in `sequence`, when given).
    fn entry<'a>(diff: &'a Value, part: &str, kind: &str, id: u64, sequence: Option<u64>) -> Option<&'a Value> {
        diff[part][kind].as_array()?.iter().find(|entry| entry["id"] == id && sequence.is_none_or(|sequence| entry["sequence"] == sequence))
    }

    /// The fields a part of the diff lists as changed for `id` (empty when it is not changed).
    fn changed(diff: &Value, part: &str, id: u64) -> Vec<String> {
        diff[part]["changed"]
            .as_array()
            .unwrap_or_else(|| panic!("no {part}.changed in {diff}"))
            .iter()
            .find(|entry| entry["id"] == id)
            .map(|entry| entry["fields"].as_array().unwrap().iter().map(|field| field.as_str().unwrap().to_owned()).collect())
            .unwrap_or_default()
    }

    /// Whether nothing at all is listed under `part`.
    fn quiet(diff: &Value, part: &str) -> bool {
        ["added", "removed", "changed"].iter().all(|kind| diff[part][kind].as_array().is_some_and(Vec::is_empty))
    }

    const PARTS: [&str; 10] = ["project", "sequences", "tracks", "clips", "items", "bins", "markers", "captions", "selection", "projectSelection"];

    #[test]
    fn preview_inspect_is_the_copys_with_the_documents_undo_state() {
        with_host("inspect", |_| {
            let (mut doc, _) = rich();
            let names = |inspected: &Value| {
                inspected["project"]["root"]["children"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|child| child["name"].as_str().unwrap_or_default().to_owned())
                    .collect::<Vec<_>>()
            };
            let own = doc.inspect().unwrap();
            doc.preview_begin("clip.nest", json!({ "name": "Nested Sequence 01" })).unwrap();
            let shown = doc.preview_inspect().unwrap();
            assert!(names(&shown).contains(&"Nested Sequence 01".to_owned()), "the new sequence: {:?}", names(&shown));
            assert!(!names(&doc.inspect().unwrap()).contains(&"Nested Sequence 01".to_owned()), "not in the document");
            let nest = shown["sequence"]["video"][0]["items"].as_array().unwrap().iter().find(|clip| clip["name"] == "Nested Sequence 01");
            assert!(nest.is_some(), "the nest clip is on V1");
            assert_eq!(shown.as_object().unwrap().keys().collect::<Vec<_>>(), own.as_object().unwrap().keys().collect::<Vec<_>>(), "the same shape");
            assert_eq!((&shown["canUndo"], &shown["canRedo"]), (&own["canUndo"], &own["canRedo"]), "the document's undo state, not the copy's");
            doc.execute("edit.undo", json!({})).unwrap();
            let own = doc.inspect().unwrap();
            let shown = doc.preview_inspect().unwrap();
            assert_eq!((&shown["canUndo"], &shown["canRedo"]), (&own["canUndo"], &own["canRedo"]));
        });
    }

    #[test]
    fn preview_diff_lists_what_each_dialog_changes() {
        with_host("diff", |_| {
            let (doc, ids) = rich();
            // Nest: a new sequence item, its clip in place of the blue one
            doc.preview_begin("clip.nest", json!({ "name": "Nested Sequence 01" })).unwrap();
            let diff = doc.preview_diff().unwrap();
            let added = listed(&diff, "sequences", "added");
            assert_eq!(added.len(), 1, "{diff}");
            assert!(listed(&diff, "items", "added").contains(&added[0]), "{diff}");
            // the blue clip moves into the new sequence, and the nest clip takes its place
            let active = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
            assert!(entry(&diff, "clips", "removed", ids.blue, Some(active)).is_some(), "it leaves this timeline: {diff}");
            assert!(entry(&diff, "clips", "added", ids.blue, Some(added[0])).is_some(), "into the new sequence: {diff}");
            assert_eq!(listed(&diff, "clips", "added").len(), 2, "{diff}");
            assert!(diff["project"]["changed"].as_array().unwrap().is_empty(), "{diff}");
            assert_eq!(listed(&diff, "projectSelection", "added"), added, "{diff}");
            assert_eq!(changed(&diff, "bins", 0), vec!["items".to_owned()], "the new sequence is in the root bin: {diff}");
            assert!(quiet(&diff, "markers") && quiet(&diff, "captions"), "{diff}");
            for part in PARTS {
                assert!(diff[part].is_object(), "{part} in {diff}");
            }

            // Add Tracks: one new track and nothing else on the timeline
            doc.preview_begin("sequence.addTracks", json!({ "video": 1, "audio": 0 })).unwrap();
            let diff = doc.preview_diff().unwrap();
            assert_eq!(listed(&diff, "tracks", "added").len(), 1, "{diff}");
            assert!(quiet(&diff, "clips") && quiet(&diff, "selection"), "{diff}");
            assert!(listed(&diff, "items", "added").is_empty() && listed(&diff, "items", "removed").is_empty(), "{diff}");

            // Make Subclip: one new item
            let half = kition_film_engine::time::TICKS_PER_SECOND / 2;
            let made = doc.preview_begin("clip.makeSubclip", json!({ "item": ids.tone, "start": 0, "end": half / 2, "name": "Short" })).unwrap();
            let diff = doc.preview_diff().unwrap();
            assert_eq!(listed(&diff, "items", "added"), vec![made["item"].as_u64().unwrap()], "{diff}");
            assert!(quiet(&diff, "clips") && quiet(&diff, "sequences") && quiet(&diff, "tracks"), "{diff}");
            assert!(listed(&diff, "bins", "added").is_empty(), "{diff}");

            // Speed / Duration with ripple: the red clip's speed and duration, the blue clip's start
            doc.preview_begin("clip.speedDuration", json!({ "clips": [ids.red], "speed": 50.0, "ripple": true })).unwrap();
            let diff = doc.preview_diff().unwrap();
            let red = changed(&diff, "clips", ids.red);
            assert!(red.contains(&"speed".to_owned()) && red.contains(&"duration".to_owned()), "{red:?} in {diff}");
            assert!(!red.contains(&"start".to_owned()), "{red:?}");
            assert_eq!(changed(&diff, "clips", ids.blue), vec!["start".to_owned()], "{diff}");
            assert!(listed(&diff, "clips", "added").is_empty() && listed(&diff, "clips", "removed").is_empty());

            // Find: the selection only
            doc.preview_begin("edit.find", json!({ "text": "tone" })).unwrap();
            let diff = doc.preview_diff().unwrap();
            for part in ["sequences", "tracks", "clips", "items", "bins", "markers", "captions"] {
                assert!(quiet(&diff, part), "{part} in {diff}");
            }
            assert!(!quiet(&diff, "selection") || !quiet(&diff, "projectSelection"), "Find selects: {diff}");

            // a marker edit: the marker's name
            doc.preview_begin("markers.edit", json!({ "marker": ids.marker, "name": "Edited" })).unwrap();
            let diff = doc.preview_diff().unwrap();
            assert_eq!(changed(&diff, "markers", ids.marker), vec!["name".to_owned()], "{diff}");
            let marker = entry(&diff, "markers", "changed", ids.marker, None).unwrap();
            assert_eq!((&marker["ownerKind"], &marker["name"], &marker["start"]), (&json!("sequence"), &json!("Edited"), &json!(0)), "{marker}");
            assert!(quiet(&diff, "clips") && quiet(&diff, "tracks"), "{diff}");

            // Rename through Edit Offline: an item's changed fields
            doc.preview_begin("clip.editOffline", json!({ "item": ids.lost, "mediaName": "Lost Tape" })).unwrap();
            let diff = doc.preview_diff().unwrap();
            assert!(!changed(&diff, "items", ids.lost).is_empty(), "{diff}");

            // Make Offline: the item's offline flag
            doc.preview_begin("media.makeOffline", json!({ "items": [ids.tone] })).unwrap();
            let diff = doc.preview_diff().unwrap();
            assert!(changed(&diff, "items", ids.tone).contains(&"offline".to_owned()), "{diff}");
        });
    }

    /// The diff of the document against `change` run on a copy of it (any command, and edits
    /// no command makes).
    fn diff_after(doc: &FilmDocument, change: impl FnOnce(&mut Session)) -> Value {
        let mut copy = doc.scratch();
        change(&mut copy);
        diff::project_diff(&doc.session.project, &doc.session.state, &copy.project, &copy.state)
    }

    #[test]
    fn preview_diff_covers_bins_captions_markers_on_items_and_the_project() {
        with_host("diff-more", |_| {
            let (mut doc, ids) = rich();
            let bin = doc.execute("file.newBin", json!({ "name": "Moved" })).unwrap()["bin"].as_u64().unwrap();

            // an item moved between bins: the item's bin, and both bins' items
            let diff = diff_after(&doc, |copy| drop(copy.execute("project.moveToBin", json!({ "items": [ids.matte], "bin": bin })).unwrap()));
            assert_eq!(changed(&diff, "items", ids.matte), vec!["bin".to_owned()], "{diff}");
            assert_eq!(changed(&diff, "bins", bin), vec!["items".to_owned()], "{diff}");
            assert_eq!(changed(&diff, "bins", 0), vec!["items".to_owned()], "{diff}");

            // a search bin is listed with the bins
            let made =
                diff_after(&doc, |copy| drop(copy.execute("file.newSearchBin", json!({ "column": "Name", "operator": "contains", "text": "tone" })).unwrap()));
            assert_eq!(listed(&made, "bins", "added").len(), 1, "{made}");

            // a caption: its caption track and the caption, by sequence
            let active = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
            let diff = diff_after(&doc, |copy| drop(copy.execute("captions.add", json!({ "text": "Hello", "seconds": 0.5 })).unwrap()));
            let caption = &diff["captions"]["added"][0];
            assert_eq!(caption["sequence"], active, "{diff}");
            assert!(entry(&diff, "tracks", "added", caption["track"].as_u64().unwrap(), Some(active)).is_some(), "{diff}");
            assert!(changed(&diff, "sequences", active).contains(&"captions".to_owned()), "{diff}");

            // a marker on a media item (Scene Edit Detection's Generate Markers) carries its values
            let diff = diff_after(&doc, |copy| {
                let project = Arc::make_mut(&mut copy.project);
                let id = project.alloc_id();
                let media = project.item_mut(ItemId(ids.tone)).and_then(|item| item.as_media_mut()).unwrap();
                media.markers.push(kition_film_engine::project::Marker {
                    id: kition_film_engine::project::MarkerId(id),
                    start: kition_film_engine::time::Tick(1_000),
                    duration: kition_film_engine::time::Tick::ZERO,
                    name: "Scene Edit".into(),
                    comment: String::new(),
                    kind: kition_film_engine::project::MarkerKind::Comment,
                    color: kition_film_engine::project::Label::Green,
                });
            });
            let marker = &diff["markers"]["added"][0];
            assert_eq!(
                (&marker["owner"], &marker["ownerKind"], &marker["start"], &marker["name"]),
                (&json!(ids.tone), &json!("item"), &json!(1_000), &json!("Scene Edit")),
                "{diff}"
            );
            assert!(marker.get("sequence").is_none() && marker["color"].is_string() && marker["duration"] == 0, "{marker}");
            assert!(changed(&diff, "items", ids.tone).contains(&"markers".to_owned()), "{diff}");

            // a field no name covers is `other`
            let diff = diff_after(&doc, |copy| Arc::make_mut(&mut copy.project).items.get_mut(&ItemId(ids.tone)).unwrap().created += 1);
            assert_eq!(changed(&diff, "items", ids.tone), vec!["other".to_owned()], "{diff}");

            // new tracks and moved clips in one change: both are reported
            let diff = diff_after(&doc, |copy| {
                copy.execute("sequence.addTracks", json!({ "video": 1, "audio": 0 })).unwrap();
                copy.execute("clip.speedDuration", json!({ "clips": [ids.red], "speed": 50.0, "ripple": true })).unwrap();
            });
            let fields = changed(&diff, "sequences", active);
            assert!(fields.contains(&"tracks".to_owned()) && fields.contains(&"clips".to_owned()), "{fields:?}");

            // the project's own settings
            doc.preview_begin("file.projectSettings.general", json!({ "actionSafe": [85, 85] })).unwrap();
            let diff = doc.preview_diff().unwrap();
            assert_eq!(diff["project"]["changed"], json!(["settings"]), "{diff}");
            for part in ["sequences", "items", "clips", "tracks", "bins", "markers"] {
                assert!(quiet(&diff, part), "{part} in {diff}");
            }
        });
    }

    #[test]
    fn preview_diff_tells_a_duplicated_sequences_clips_apart() {
        with_host("diff-duplicate", |_| {
            let (mut doc, ids) = rich();
            let active = doc.inspect().unwrap()["sequence"]["id"].as_u64().unwrap();
            doc.execute("project.select", json!({ "items": [active] })).unwrap();
            doc.execute("edit.duplicate", json!({})).unwrap();
            let twin = doc.session.project.sequences().map(|item| item.id.0).find(|id| *id != active).expect("the duplicate");
            // Real duplication allocates fresh ids. Deliberately introduce a
            // repeated clip id in this malformed scratch fixture: preview diffs
            // must still qualify it by sequence, as this test has always required.
            let red_index = doc.session.project.sequence(ItemId(active)).unwrap().video_tracks[0].items.iter().position(|clip| clip.id.0 == ids.red).unwrap();
            let q = Arc::make_mut(&mut doc.session.project).sequence_mut(ItemId(twin)).unwrap();
            let copied_red = q.video_tracks[0].items[red_index].id;
            q.video_tracks[0].items[red_index].id = kition_film_engine::project::ClipId(ids.red);
            for track in q.all_tracks_mut() {
                for transition in &mut track.transitions {
                    if transition.from == Some(copied_red) {
                        transition.from = Some(kition_film_engine::project::ClipId(ids.red));
                    }
                    if transition.to == Some(copied_red) {
                        transition.to = Some(kition_film_engine::project::ClipId(ids.red));
                    }
                }
            }
            let twin_clips: Vec<u64> = doc.session.project.sequence(ItemId(twin)).unwrap().video_tracks[0].items.iter().map(|clip| clip.id.0).collect();
            assert!(twin_clips.contains(&ids.red), "the scratch fixture deliberately repeats the clip id");
            let diff = diff_after(&doc, |copy| {
                let project = Arc::make_mut(&mut copy.project);
                for sequence in [active, twin] {
                    let clip = project.sequence_mut(ItemId(sequence)).unwrap().video_tracks[0].items.iter_mut().find(|clip| clip.id.0 == ids.red).unwrap();
                    clip.gain_db = 6.0;
                }
            });
            for sequence in [active, twin] {
                let found = entry(&diff, "clips", "changed", ids.red, Some(sequence)).unwrap_or_else(|| panic!("{sequence} in {diff}"));
                assert_eq!(found["fields"], json!(["gain"]), "{found}");
            }
            assert_eq!(diff["clips"]["changed"].as_array().unwrap().len(), 2, "{diff}");
        });
    }

    #[test]
    fn preview_query_reads_the_copy_and_refuses_what_writes() {
        with_host("query", |dir| {
            let (mut doc, ids) = rich();
            let before = untouched(&mut doc, Some(dir));
            let made = doc.preview_begin("file.newColorMatte", json!({ "color": "#00ff00", "seconds": 1.0 })).unwrap();
            let matte = made["item"].as_u64().unwrap();
            let rows = |value: &Value| value["rows"].as_array().unwrap().iter().filter_map(|row| row["item"].as_u64()).collect::<Vec<_>>();
            assert!(rows(&doc.preview_query("project.items", json!({ "recursive": true })).unwrap()).contains(&matte));
            assert!(!rows(&doc.session.execute("project.items", json!({ "recursive": true })).unwrap()).contains(&matte));
            for (command, params) in [
                ("project.view.get", json!({})),
                ("project.freeform.layout", json!({})),
                ("mixer.inspect", json!({})),
                ("presets.list", json!({})),
                ("history.list", json!({})),
            ] {
                doc.preview_query(command, params).unwrap_or_else(|error| panic!("{command}: {error}"));
            }
            let bin = doc.preview_begin("file.newSearchBin", json!({ "column": "Name", "operator": "contains", "text": "tone" })).unwrap();
            let bin = bin["bin"].as_u64().or_else(|| bin["id"].as_u64()).unwrap_or_else(|| panic!("no bin in {bin}"));
            let found = doc.preview_query("project.searchBinItems", json!({ "bin": bin })).unwrap();
            assert!(found.to_string().contains(&ids.tone.to_string()), "{found}");
            doc.preview_begin("presets.save", json!({ "clip": ids.red, "effects": [0], "name": "Preview Preset" })).unwrap();
            assert!(doc.preview_query("presets.list", json!({})).unwrap().to_string().contains("Preview Preset"));
            assert!(!doc.session.execute("presets.list", json!({})).unwrap().to_string().contains("Preview Preset"));

            let journaled = doc.preview_query("sequence.addTracks", json!({})).unwrap_err();
            assert!(journaled.contains("read-only"), "{journaled}");
            let external = doc.preview_query("lut.export", json!({ "lut": "builtin:x", "path": "x.cube" })).unwrap_err();
            assert!(external.contains("read-only") || external.contains("summary"), "{external}");
            assert!(doc.preview_query("no.such.command", json!({})).is_err());
            // a read-only command that changes session state runs on a throwaway copy of the copy
            let shown = |doc: &FilmDocument| {
                doc.with_preview(|scratch| {
                    Ok((scratch.media.use_proxies(), scratch.prefs.media.enable_proxies, scratch.offline.prompt, scratch.revision, scratch.saved_revision))
                })
            };
            let (state, frame, sound) = (shown(&doc).unwrap(), doc.preview_frame(0.25, 64).unwrap(), doc.preview_audio(0.25, 4_800).unwrap());
            doc.preview_query("media.toggleProxies", json!({ "enabled": true })).unwrap();
            doc.preview_query("media.linkMedia", json!({})).unwrap();
            assert_eq!(shown(&doc).unwrap(), state, "the copy's proxy switch, preferences, and Link Media prompt are as they were");
            assert_eq!(doc.preview_frame(0.25, 64).unwrap(), frame, "the next preview frame is unchanged");
            assert_eq!(doc.preview_audio(0.25, 4_800).unwrap(), sound, "and its sound");
            doc.preview_end();
            assert_eq!(untouched(&mut doc, Some(dir)), before);
        });
    }

    #[test]
    fn preview_item_frame_draws_an_item_only_the_copy_has() {
        with_host("item", |_| {
            let (doc, ids) = rich();
            let made = doc.preview_begin("file.newColorMatte", json!({ "color": "#00ff00", "seconds": 1.0 })).unwrap();
            let matte = made["item"].as_u64().unwrap();
            assert!(doc.item_frame(matte, 0.0, 32).is_err(), "the document has no such item");
            let frame = doc.preview_item_frame(matte, 0.0, 32).unwrap();
            assert_eq!(u32::from_le_bytes(frame[0..4].try_into().unwrap()), 32);
            assert_eq!(rgb(&frame, 4, 4), [0, 255, 0], "the copy's green matte");
            assert!(doc.preview_item_frame(matte, 0.0, 32).is_ok());
            let half = kition_film_engine::time::TICKS_PER_SECOND / 2;
            let sub = doc.preview_begin("clip.makeSubclip", json!({ "item": ids.matte, "start": 0, "end": half, "name": "Red part" })).unwrap();
            let frame = doc.preview_item_frame(sub["item"].as_u64().unwrap(), 0.0, 16).unwrap();
            assert_eq!(rgb(&frame, 2, 2), [255, 0, 0], "the copy's subclip of the red matte");
            assert!(doc.preview_item_frame(9_999_999, 0.0, 16).is_err());
        });
    }

    #[test]
    fn every_read_is_an_error_without_a_preview() {
        let doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        assert!(doc.preview_inspect().unwrap_err().contains("no preview"));
        assert!(doc.preview_diff().unwrap_err().contains("no preview"));
        assert!(doc.preview_query("project.items", json!({})).unwrap_err().contains("no preview"));
        assert!(doc.preview_item_frame(1, 0.0, 16).unwrap_err().contains("no preview"));
    }

    #[test]
    fn replacing_the_document_ends_the_preview() {
        let origin = kition_film_engine::Origin::person("user:agent-1");
        let cases: [(&str, Value, bool); 6] = [
            ("file.newProject", json!({ "name": "Other" }), false),
            ("file.openDemoProject", json!({}), false),
            ("file.closeProject", json!({ "force": true }), false),
            // Close All Projects runs Close Project inside it
            ("file.closeAllProjects", json!({ "force": true }), false),
            ("file.revert", json!({}), false),
            // an agent's command, through executeAs
            ("file.newProject", json!({ "name": "Agent's" }), true),
        ];
        for (command, params, as_agent) in cases {
            let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
            doc.preview_begin("sequence.addTracks", json!({})).unwrap();
            doc.execute("sequence.addTracks", json!({ "video": 1, "audio": 0 })).unwrap();
            doc.execute_as("sequence.addTracks", json!({ "video": 1, "audio": 0 }), &origin).unwrap();
            assert!(doc.preview_inspect().is_ok(), "an ordinary edit leaves the preview open (the page begins again)");
            let ran = if as_agent { doc.execute_as(command, params, &origin) } else { doc.execute(command, params) };
            ran.unwrap_or_else(|error| panic!("{command}: {error}"));
            assert!(doc.preview_inspect().is_err(), "{command} (executeAs: {as_agent}) ends the preview: its copy is of the old document");
        }
    }

    /// `KITION_FILM_PREVIEW_CLIPS=200 cargo test -p kition-film-kit --release -- --ignored
    /// measures_a_preview --nocapture`
    #[test]
    #[ignore = "a measurement, not a check"]
    fn measures_a_preview_on_a_long_sequence() {
        let clips: usize = std::env::var("KITION_FILM_PREVIEW_CLIPS").ok().and_then(|value| value.parse().ok()).unwrap_or(200);
        let mut doc = FilmDocument::create("Edit.kfilm", 1920, 1080).unwrap();
        for index in 0..clips {
            let matte =
                doc.execute("file.newColorMatte", json!({ "color": format!("#{:02x}40{:02x}", index % 256, 255 - index % 256), "seconds": 2.0 })).unwrap();
            doc.execute("timeline.place", json!({ "item": matte["item"], "track": format!("V{}", 1 + index % 3), "seconds": index as f64 * 2.0 })).unwrap();
        }
        let clip = clip_at(&doc, 0, 0);
        doc.execute("playhead.set", json!({ "seconds": 1.0 })).unwrap();
        // The Program monitor has drawn the document before a dialog opens.
        drop(doc.render(0.0, 0.0, 0.5, 960, 540).unwrap());
        // The resident set in KiB, as `ps` reports it (native only: a rough measure).
        let rss = || {
            let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().parse::<i64>().unwrap_or(0)
        };
        let resident = rss();
        for speed in 0..50 {
            doc.preview_begin("clip.speedDuration", json!({ "clips": [clip], "speed": 30.0 + f64::from(speed), "ripple": true })).unwrap();
        }
        eprintln!("50 previews in a row, one open: resident {} KiB more", rss() - resident);
        doc.preview_end();
        eprintln!("after previewEnd: resident {} KiB more; the project file is {} KiB", rss() - resident, doc.save(None).unwrap().len() / 1024);
        let timed = |label: &str, run: &mut dyn FnMut()| {
            let started = std::time::Instant::now();
            run();
            eprintln!("{label}: {:?}", started.elapsed());
        };
        timed("previewBegin clip.speedDuration (ripple)", &mut || {
            drop(doc.preview_begin("clip.speedDuration", json!({ "clips": [clip], "speed": 50.0, "ripple": true })).unwrap())
        });
        timed("previewBegin again (an update)", &mut || {
            drop(doc.preview_begin("clip.speedDuration", json!({ "clips": [clip], "speed": 25.0, "ripple": true })).unwrap())
        });
        timed("previewFrame 960 px", &mut || drop(doc.preview_frame(1.0, 960).unwrap()));
        let mut changes = 0;
        timed("previewDiff after a ripple speed change", &mut || changes = doc.preview_diff().unwrap()["clips"]["changed"].as_array().unwrap().len());
        eprintln!("  ({changes} clips changed)");
        timed("previewInspect", &mut || drop(doc.preview_inspect().unwrap()));
        timed("previewQuery project.items", &mut || drop(doc.preview_query("project.items", json!({ "recursive": true })).unwrap()));
        timed("previewItemFrame 160 px", &mut || {
            drop(doc.preview_item_frame(doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["item"].as_u64().unwrap(), 0.5, 160).unwrap())
        });
        timed("previewAudio 0.1 s", &mut || drop(doc.preview_audio(1.0, 4_800).unwrap()));
        timed("previewEnd", &mut || doc.preview_end());
        timed("execute clip.speedDuration (ripple), for comparison", &mut || {
            drop(doc.execute("clip.speedDuration", json!({ "clips": [clip], "speed": 50.0, "ripple": true })).unwrap())
        });
        let undo = doc.session.history.undo.len();
        timed("previewBegin sequence.addTracks", &mut || drop(doc.preview_begin("sequence.addTracks", json!({})).unwrap()));
        timed("previewDiff after Add Tracks", &mut || drop(doc.preview_diff().unwrap()));
        timed("previewBegin markers.addFlashCue", &mut || drop(doc.preview_begin("markers.addFlashCue", json!({ "name": "Cue" })).unwrap()));
        timed("previewDiff after a marker", &mut || drop(doc.preview_diff().unwrap()));
        timed("previewBegin edit.find (selection only)", &mut || drop(doc.preview_begin("edit.find", json!({ "text": "Color" })).unwrap()));
        timed("previewDiff after Find (the project shared)", &mut || drop(doc.preview_diff().unwrap()));
        let size = |value: &Value| value.to_string().len();
        eprintln!("project: {clips} clips, inspect {} bytes, undo steps {undo}", size(&doc.inspect().unwrap()));
        doc.preview_end();
    }
}
