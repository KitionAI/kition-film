//! # kition-film-kit
//!
//! The Film engine for Kition's in-page editor, on the Kition SDK. [`FilmDocument`] implements
//! [`KitDocument`] for a Kition Film project (`.kfilm`): the picture is the active sequence's
//! program frame at the playhead, commands are the engine's own, and media the project refers to
//! are read through the SDK's lent files ([`kition_kit::host`]), so long videos are never loaded
//! whole.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

pub mod acts;
pub mod check;
mod collab;
pub mod descriptions;
mod dialogs;
mod drafts;
mod facts;
pub mod files;
mod panels;
mod params;
mod picture;
mod prefs;
mod preview;
mod program;
mod render;
mod rests_audio;
mod rests_clip_fields;
mod rests_clipboard;
mod rests_composites;
mod rests_core;
mod rests_edit_inputs;
mod rests_effects;
mod rests_fonts;
mod rests_geometry;
mod rests_join;
mod rests_luts;
mod rests_media;
mod rests_moves;
mod rests_navigation;
mod rests_nest_flatten;
mod rests_placement;
mod rests_project_management;
mod rests_project_sources;
mod rests_render;
mod rests_search;
mod rests_sequences;
mod rests_settings;
mod rests_sync;
mod rests_transcript;
mod rests_trim;
mod sound;
pub mod text;
mod view_state;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use kition_film_engine::{Services, Session, command_specs};
use kition_film_media::reader::{ByteReader, SharedReader};
use kition_kit::raster::{self, Frame};
use kition_kit::{CallContext, KitCommand, KitDocument};
use serde_json::{Value, json};

/// The project file lives in memory; everything else the project names is a lent file.
struct KitServices {
    restoring_reread: AtomicBool,
    memory: Mutex<HashMap<String, Arc<[u8]>>>,
    /// The Program monitor's render scale ([`FilmDocument::set_render_scale`]), as `f32` bits. It
    /// lives here, with the document's other per-instance state, so every way of making a
    /// [`FilmDocument`] starts at full resolution.
    render_scale: AtomicU32,
    /// The open command preview's scratch session ([`crate::preview`]), kept here for the same
    /// reason: every way of making a [`FilmDocument`] starts without one.
    preview: Mutex<Option<Session>>,
    /// The Program monitor's motion and last picture ([`crate::program`]).
    program: program::ProgramState,
    /// How much of the session's journal [`FilmDocument::settle`] has looked through for a
    /// command that replaced the document.
    journal_seen: AtomicUsize,
    /// The loudness meter the page feeds with what it plays ([`crate::sound`]), with its sample
    /// rate; none until the first feed.
    loudness: Mutex<Option<sound::Loudness>>,
    /// The strips' levels of the last chunks the document and its previews mixed ([`crate::sound`]).
    levels: sound::LevelRing,
}

impl Default for KitServices {
    fn default() -> Self {
        Self {
            restoring_reread: AtomicBool::new(false),
            memory: Mutex::default(),
            render_scale: AtomicU32::new(1.0f32.to_bits()),
            preview: Mutex::default(),
            program: program::ProgramState::default(),
            journal_seen: AtomicUsize::new(0),
            loudness: Mutex::default(),
            levels: Mutex::default(),
        }
    }
}

fn io_error(message: String) -> std::io::Error {
    let kind = if message.contains("NotFound") || message.contains("not found") { std::io::ErrorKind::NotFound } else { std::io::ErrorKind::Other };
    std::io::Error::new(kind, message)
}

impl KitServices {
    fn render_scale(&self) -> f32 {
        f32::from_bits(self.render_scale.load(Ordering::Relaxed))
    }

    fn set_render_scale(&self, scale: f32) {
        self.render_scale.store(scale.to_bits(), Ordering::Relaxed);
    }

    fn memory(&self, path: &str) -> Option<Arc<[u8]>> {
        self.memory.lock().unwrap_or_else(PoisonError::into_inner).get(path).cloned()
    }
}

impl Services for KitServices {
    fn read_file(&self, path: &str) -> std::io::Result<Vec<u8>> {
        match self.memory(path) {
            Some(bytes) => Ok(bytes.to_vec()),
            None => kition_kit::host::read(path).map_err(io_error),
        }
    }

    fn write_file(&self, path: &str, data: &[u8]) -> std::io::Result<()> {
        self.memory.lock().unwrap_or_else(PoisonError::into_inner).insert(path.to_owned(), Arc::from(data));
        Ok(())
    }

    fn file_size(&self, path: &str) -> std::io::Result<u64> {
        match self.memory(path) {
            Some(bytes) => Ok(bytes.len() as u64),
            None => kition_kit::host::size(path).map_err(io_error),
        }
    }

    fn read_range(&self, path: &str, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
        match self.memory(path) {
            Some(bytes) => {
                let start = usize::try_from(offset).unwrap_or(usize::MAX).min(bytes.len());
                Ok(bytes.get(start..start.saturating_add(len).min(bytes.len())).unwrap_or_default().to_vec())
            }
            None => kition_kit::host::read_range(path, offset, len).map_err(io_error),
        }
    }

    /// Media are read in place through ranged reads of the lent file.
    fn reader(&self, path: &str) -> Option<std::io::Result<SharedReader>> {
        if self.memory(path).is_some() {
            return None;
        }
        Some(kition_kit::host::size(path).map_err(io_error).map(|len| Arc::new(LentReader { path: path.to_owned(), len }) as SharedReader))
    }

    fn export_in_memory(&self) -> bool {
        true
    }
}

/// A media file read through the host, range by range.
struct LentReader {
    path: String,
    len: u64,
}

impl ByteReader for LentReader {
    fn len(&self) -> u64 {
        self.len
    }

    fn read_at(&self, offset: u64, buf: &mut [u8]) -> std::io::Result<()> {
        let bytes = kition_kit::host::read_range(&self.path, offset, buf.len()).map_err(io_error)?;
        if bytes.len() < buf.len() {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, format!("{} ends before {}", self.path, offset + buf.len() as u64)));
        }
        buf.copy_from_slice(&bytes[..buf.len()]);
        Ok(())
    }
}

/// One open Kition Film project.
pub struct FilmDocument {
    session: Session,
    name: String,
    services: Arc<KitServices>,
}

impl FilmDocument {
    /// Refuses a parameter `command` does not take (a typo or a guessed name) before it runs,
    /// naming the one it resembles, instead of running without it (engine rule E7a). The schemas
    /// are the ones the catalogue offers agents, read once.
    fn refuse_unknown(&self, command: &str, params: &Value) -> Result<(), String> {
        static SCHEMAS: std::sync::OnceLock<HashMap<String, Value>> = std::sync::OnceLock::new();
        let schemas = SCHEMAS.get_or_init(|| self.commands().into_iter().filter_map(|command| Some((command.id, command.schema?))).collect());
        schemas.get(command).map_or(Ok(()), |schema| kition_kit::schema::refuse_unknown(command, schema, params).map_err(params_failure))
    }

    fn settings(&self) -> Option<(u32, u32)> {
        self.session.active_sequence().map(|sequence| (sequence.settings.width, sequence.settings.height))
    }

    /// The longest audio one call mixes, in seconds.
    const MAX_AUDIO_SECONDS: f64 = 10.0;

    /// The active sequence's sample rate (48 kHz by default).
    pub fn audio_rate(&self) -> u32 {
        session_audio_rate(&self.session)
    }

    /// `frames` stereo samples of the sequence mix from `start_seconds`, interleaved left and
    /// right, at [`Self::audio_rate`]: what playback hears, mixed by the engine.
    pub fn audio(&self, start_seconds: f64, frames: u32) -> Result<Vec<f32>, String> {
        session_audio(&self.session, &self.services.levels, start_seconds, frames)
    }

    /// Takes a file the engine wrote, such as an export (`file.exportMedia` with a `path`), out of
    /// memory; the host saves it to the workspace.
    pub fn take_file(&self, path: &str) -> Option<Vec<u8>> {
        if path == self.name {
            return None;
        }
        self.services.memory.lock().unwrap_or_else(PoisonError::into_inner).remove(path).map(|bytes| bytes.to_vec())
    }

    /// Advances a background export (`file.exportMedia` without `wait` returns its job id) for up
    /// to `budget_ms`, and reports it: progress 0 to 1, seconds left, finished, result or error.
    /// The engine has no threads in WebAssembly, so the host calls this until it is finished.
    pub fn export_step(&mut self, job: u64, budget_ms: u32) -> Result<Value, String> {
        self.session.pump_jobs(std::time::Duration::from_millis(u64::from(budget_ms.clamp(1, 1_000))));
        self.session.jobs.iter().find(|candidate| candidate.id == job).map(kition_film_engine::Job::to_json).ok_or_else(|| format!("no export {job}"))
    }

    /// Advances the document's background jobs (Scene Edit Detection, which a host without threads
    /// runs a step at a time, and exports) for up to `budget_ms` (1 to 1,000), then applies what
    /// finished, as upstream's frame loop does (`Session::poll_persistence`: a job's result is its
    /// own history step, recorded in the replica). Answers `{pending, revision, job}`: whether work
    /// is left, the engine's revision now (the page refreshes when it moved), and the running job
    /// (`jobs.list`'s shape: id, label, progress, etaSeconds, …; the newest unfinished one, as
    /// upstream's status bar shows it) or null.
    pub fn jobs_step(&mut self, budget_ms: u32) -> Value {
        self.session.pump_jobs(std::time::Duration::from_millis(u64::from(budget_ms.clamp(1, 1_000))));
        self.session.poll_persistence();
        let session = &self.session;
        let running = session.jobs.iter().rev().find(|job| !job.progress.finished.load(Ordering::Relaxed));
        let pending = !session.stepped.is_empty()
            || !session.scene_jobs.is_empty()
            || !session.media_jobs.is_empty()
            || !session.mask_jobs.is_empty()
            || running.is_some();
        json!({ "pending": pending, "revision": session.revision, "job": running.map_or(Value::Null, kition_film_engine::Job::to_json) })
    }

    /// Asks a background export to stop; the next step reports it finished with an error.
    pub fn cancel_job(&self, job: u64) {
        if let Some(found) = self.session.jobs.iter().find(|candidate| candidate.id == job) {
            found.progress.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// In WebAssembly the host has no threads: the session steps the jobs that can run a step at a
    /// time (`Session::step_jobs`), and the page advances them with [`Self::jobs_step`]. Every way of
    /// opening a document settles once, so each one has it set before its first command.
    fn threadless(&mut self) {
        if cfg!(target_arch = "wasm32") {
            self.session.step_jobs = true;
        }
    }

    /// Lets background work (media indexing, previews) advance before the next frame, and ends
    /// an open preview when a command since the last settle replaced the document: the preview is
    /// a copy of the old one. Every way of running a command settles after it (`execute`,
    /// `executeAs`, undo), and the journal also holds the commands a command ran (Close All
    /// Projects runs Close Project).
    fn settle(&mut self) {
        self.threadless();
        self.session.pump_jobs(std::time::Duration::from_millis(5));
        let journal = &self.session.journal;
        let seen = self.services.journal_seen.swap(journal.len(), Ordering::Relaxed);
        // The engine drops the oldest 1,000 entries past 10,000.
        let start = if seen <= journal.len() { seen } else { seen.saturating_sub(1_000).min(journal.len()) };
        if journal.get(start..).unwrap_or_default().iter().any(|(command, _)| preview::REPLACES_DOCUMENT.contains(&command.as_str())) {
            self.preview_end();
        }
    }
}

impl KitDocument for FilmDocument {
    fn projected_objects(&self) -> Result<Vec<kition_kit::kdm::projection::ProjectedObject>, String> {
        Ok(facts::objects(&self.session))
    }
    fn fork_for_premises(&self) -> Result<Self, String> {
        // Scratch sessions copy editor inputs and fork their media cache. Services are read-only
        // during premise planning; writes and previews go to an independent in-memory service.
        let services = Arc::new(KitServices::default());
        services.memory.lock().unwrap_or_else(PoisonError::into_inner).clone_from(&self.services.memory.lock().unwrap_or_else(PoisonError::into_inner));
        let mut session = self.session.scratch();
        if let Some(replica) = self.session.kdm() {
            let snapshot = replica.snapshot().map_err(|error| error.to_string())?;
            session.open_snapshot(&snapshot).map_err(|error| error.to_string())?;
            session.restore_call_state(&self.session.call_state());
        }
        session.browser = self.session.browser.clone();
        session.shortcuts = self.session.shortcuts.clone();
        session.mcrec = self.session.mcrec.clone();
        session.mixrec = self.session.mixrec.clone();
        session.trim_play = self.session.trim_play.clone();
        session.previews.live.copy_controls_from(&self.session.previews.live);
        session.services = services.clone();
        Ok(Self { session, name: self.name.clone(), services })
    }

    fn carry_replica_objects(&mut self, previous: &Self) -> Result<(), String> {
        self.services.restoring_reread.store(true, Ordering::Relaxed);
        self.session.presets.user.clone_from(&previous.session.presets.user);
        self.session.export_presets.user.clone_from(&previous.session.export_presets.user);
        self.session.export_presets.favorites.clone_from(&previous.session.export_presets.favorites);
        self.session.prefs.clone_from(&previous.session.prefs);
        self.session.browser = previous.session.browser.clone();
        self.session.shortcuts = previous.session.shortcuts.clone();
        self.session.mcrec = previous.session.mcrec.clone();
        self.session.mixrec = previous.session.mixrec.clone();
        self.session.trim_play = previous.session.trim_play.clone();
        self.session.previews.live.copy_controls_from(&previous.session.previews.live);
        Ok(())
    }

    fn reconcile_reread(&mut self, fresh: &Self) -> Result<bool, String> {
        self.session.reconcile_file(&fresh.session.project).map_err(|error| error.to_string())?;
        Ok(true)
    }

    fn batch_settler(&self) -> Option<kition_kit::BatchSettler> {
        Some(Box::new(|tx| kdm_model::settle_batch(tx).map_err(|error| error.to_string())))
    }
    fn open(name: &str, bytes: &[u8]) -> Result<Self, String> {
        let services = Arc::new(KitServices::default());
        services.write_file(name, bytes).map_err(|error| error.to_string())?;
        let mut session = Session::for_host(services.clone());
        session.execute("file.open", json!({ "path": name })).map_err(|error| error.to_string())?;
        let mut doc = Self { session, name: name.to_owned(), services };
        doc.settle();
        Ok(doc)
    }

    /// A new project with one empty sequence of the given frame size.
    fn create(name: &str, width: u32, height: u32) -> Result<Self, String> {
        let services = Arc::new(KitServices::default());
        let mut session = Session::for_host(services.clone());
        let title = std::path::Path::new(name).file_stem().map_or_else(|| "Untitled".to_owned(), |stem| stem.to_string_lossy().into_owned());
        session.execute("file.newProject", json!({ "name": title })).map_err(|error| error.to_string())?;
        session.execute("file.newSequence", json!({ "name": "Sequence 01", "width": width, "height": height })).map_err(|error| error.to_string())?;
        session.saved_revision = session.revision;
        let mut doc = Self { session, name: name.to_owned(), services };
        doc.threadless();
        Ok(doc)
    }

    fn width(&self) -> u32 {
        self.settings().map_or(0, |(w, _)| w)
    }

    fn height(&self) -> u32 {
        self.settings().map_or(0, |(_, h)| h)
    }

    fn revision(&self) -> u64 {
        self.session.revision
    }

    fn dirty(&self) -> bool {
        self.session.is_dirty()
    }

    /// The program at (`x`, `y`) in sequence pixels; a frame rendered at a lower render scale is
    /// scaled up to the same view.
    fn render(&self, x: f64, y: f64, scale: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let (rgba, w, h) = self.frame()?;
        let k = f64::from(w) / f64::from(self.width().max(1));
        Ok(raster::render(Frame { rgba: &rgba[..], width: w, height: h }, x * k, y * k, scale / k, width, height))
    }

    fn render_area(&self, x0: i32, y0: i32, x1: i32, y1: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let (rgba, w, h) = self.frame()?;
        let (kx, ky) = (f64::from(w) / f64::from(self.width().max(1)), f64::from(h) / f64::from(self.height().max(1)));
        let at = |v: i32, k: f64, round: fn(f64) -> f64| round(f64::from(v) * k) as i32;
        let (x0, y0, x1, y1) = (at(x0, kx, f64::floor), at(y0, ky, f64::floor), at(x1, kx, f64::ceil), at(y1, ky, f64::ceil));
        Ok(raster::render_area(Frame { rgba: &rgba[..], width: w, height: h }, x0, y0, x1, y1, width, height))
    }

    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
        self.refuse_unknown(command, &params)?;
        if files::AGENT_EXCLUDED.contains(&command) {
            files::refuse_for_agent(command)?;
        }
        if command == render::RENDER {
            return render::render(&self.session, &params);
        }
        let revision = self.session.revision;
        let result = self.session.execute(command, params);
        // An edit puts the Program monitor back at rest: a scrub's approximate pictures never
        // outlive the scrub, whatever the editor does.
        if self.session.revision != revision {
            self.services.program.settle();
        }
        let result = result.map_err(command_failure)?;
        self.settle();
        Ok(result)
    }

    /// The project, the active sequence (tracks, clips, playhead, duration), and history state.
    fn inspect(&self) -> Result<Value, String> {
        Ok(inspect_session(&self.session))
    }

    fn commands(&self) -> Vec<KitCommand> {
        let mut commands: Vec<kition_kit::KitCommand> = {
            command_specs()
                .iter()
                .map(|spec| {
                    KitCommand {
                        id: spec.id.to_owned(),
                        title: spec.label.trim_end_matches('…').to_owned(),
                        menu: (!spec.menu.is_empty()).then(|| spec.menu.iter().map(|part| (*part).to_owned()).collect()),
                        shortcut: spec.shortcut.map(str::to_owned),
                        params: Some(spec.params.to_owned()),
                        mutates: spec.journal,
                        enabled: self.session.is_enabled(spec.id),
                        description: descriptions::description(spec.id).to_owned(),
                        output_schema: output_schema(spec.id, spec.journal),
                        reads: acts::reads(spec.id),
                        ..Default::default()
                    }
                    .with_kit_schema()
                    .typed_from(param_types())
                })
                .map(|mut command| {
                    if let Some(schema) = command.schema.as_mut() {
                        params::complete(&command.id, schema);
                    }
                    command.targets = acts::targets(&command.id, command.schema.as_ref());
                    command.places = acts::places(&command.id);
                    command.objects = acts::objects(&command.id, command.schema.as_ref(), command.targets, command.places);
                    command.object_types = acts::object_types(&command.id, command.targets, command.objects);
                    command.name_params = acts::name_params(&command.id, command.objects);
                    command
                })
                .collect()
        };
        kition_kit::files::declare(&mut commands, files::FILES);
        commands.push(render::command());
        commands
    }

    /// The commands that cannot run now, without building the full list and its schemas: what
    /// Kition asks after every change for menu and shortcut states.
    fn disabled_commands(&self) -> Vec<String> {
        command_specs().iter().filter(|spec| !(self.session.is_enabled(spec.id))).map(|spec| spec.id.to_owned()).collect()
    }

    /// The open sequence (and the open timeline tabs), each sequence's playhead, the Source
    /// monitor's item and playhead, the timeline, caption and Project panel selections, the
    /// selected edit points, graphic layers and mask, and the track targets, as an opaque snapshot
    /// ([`kition_film_engine::context::CallState`]).
    fn editor_state(&self) -> Value {
        let state = serde_json::to_value(self.session.call_state()).unwrap_or(Value::Null);
        let mut selection: Vec<Value> = self.session.state.selection.iter().map(|id| json!(id.0)).collect();
        selection.extend(self.session.state.caption_selection.iter().map(|id| json!({"caption":id.0})));
        selection.extend(self.session.state.project_selection.iter().map(|id| json!({"item":id.0})));
        if !self.session.state.graphic_layers.is_empty() {
            selection.push(json!({"graphicLayers":self.session.state.graphic_layers}));
        }
        if self.session.state.selected_mask.is_some() {
            selection.push(json!({"mask":self.session.state.selected_mask}));
        }
        json!({
            "filmState":state,
            "selection":selection,
            "part":self.session.state.active_sequence,
            "time":{"program":self.session.state.playheads,"source":self.session.state.source_playhead},
            "active":{
                "source":self.session.state.source_item,"targeting":self.session.state.targeting,"browser":self.session.browser,
                "editPoints":state["editPoints"]
            },
            "mode":{
                "prefs":self.session.prefs,"presets":self.session.presets.user,"exportPresets":self.session.export_presets.user,
                "exportFavorites":self.session.export_presets.favorites,
                "exportQueue":{"items":self.session.export_queue.items,"running":self.session.export_queue.running,"quickPreset":self.session.export_queue.quick_preset},
                "shortcuts":{
                    "revision":self.session.shortcuts.revision,"bindings":self.session.shortcuts.bindings,
                    "preset":self.session.shortcuts.preset,"modified":self.session.shortcuts.modified,
                    "canUndo":self.session.shortcuts.can_undo(),"canRedo":self.session.shortcuts.can_redo()
                },
                "snapping":state["snapping"],"linkedSelection":state["linkedSelection"],"sequencesAsClips":state["sequencesAsClips"],
                "rippleSequenceMarkers":state["rippleSequenceMarkers"],"copyPasteSequenceMarkers":state["copyPasteSequenceMarkers"],
                "selectionFollowsPlayhead":state["selectionFollowsPlayhead"],"showThroughEdits":state["showThroughEdits"],
                "hiddenMarkerColors":state["hiddenMarkerColors"],"multicamAudioFollowsVideo":state["multicamAudioFollowsVideo"],
                "multicamView":state["multicamView"],"clipMixerModes":state["clipMixerModes"],
                "find":self.session.state.find,
                "mixerRecording":self.session.mixrec,
                "trimPlayback":self.session.trim_play,
                "mixerControls":self.session.previews.live.held_controls().into_iter().map(|(strip,lane,value)| {
                    json!({"strip":strip.0,"lane":lane,"value":value.value,"release":value.release})
                }).collect::<Vec<_>>(),
                "clipboard":{
                    "clips":self.session.state.clipboard,"rate":self.session.state.clipboard_rate,
                    "markers":self.session.state.clipboard_markers
                },
                "multicamRecording":{
                    "sequence":self.session.mcrec.seq,"start":self.session.mcrec.start.0.to_string(),
                    "tracks":self.session.mcrec.tracks,"source":self.session.mcrec.source,
                    "cuts":self.session.mcrec.cuts.iter().map(|cut| json!([cut.time.0.to_string(),cut.angle])).collect::<Vec<_>>()
                },
                "defaultVideoTransition":state["defaultVideoTransition"],"defaultAudioTransition":state["defaultAudioTransition"]
            },
            "area":"timeline"
        })
    }

    /// Puts back what [`KitDocument::editor_state`] answered, leaving out what the project no
    /// longer has; no edit.
    fn restore_editor_state(&mut self, saved: &Value) -> Result<(), String> {
        if saved.is_null() {
            return Ok(());
        }
        let state: kition_film_engine::context::CallState =
            serde_json::from_value(saved["filmState"].clone()).map_err(|error| format!("this is not the editor state this kit answered: {error}"))?;
        if self.services.restoring_reread.swap(false, Ordering::Relaxed) {
            self.session.validate_call_state(&state).map_err(|error| error.to_string())?;
        }
        self.session.restore_call_state(&state);
        Ok(())
    }

    /// Sets what a call acts in and on: `part` `{"sequence": id}` (the sequence's item id, as
    /// `file.render`'s `target.sequence` names it) becomes the open sequence; `time`, seconds from
    /// its start, its playhead (on the start of the frame showing it); `on`, clip ids (timeline
    /// clips and captions of that sequence) and project item ids, the selections. Ids come from one
    /// project-wide counter, so each names one thing. A sequence, id or time the project lacks is
    /// refused, saying what is valid, and nothing changes. No edit.
    fn set_context(&mut self, context: &CallContext) -> Result<(), String> {
        let sequence = context.part.as_ref().map(call_sequence).transpose().map_err(params_failure)?;
        let on = context
            .on
            .iter()
            .map(|id| match id {
                Value::Number(number) => number.as_u64(),
                Value::String(text) => text.parse().ok(),
                _ => None,
            })
            .zip(&context.on)
            .map(|(number, id)| {
                number.ok_or_else(|| params_failure(format!("`on` holds {id}: ids are whole numbers, as film_inspect lists them (`clip`, `item`)")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        // Every refusal here is of the call's context: an id, sequence or time the project lacks.
        self.session.set_call_context(sequence, context.time, &on).map_err(params_failure)
    }

    /// What a call depends on (kition-sdk `KitDocument::under`, asked for every step of a write
    /// with `basis`). By its place (C8-film-2): the clips under its time (the playhead the step's
    /// `at.time` set, or its own `time`, `seconds`, `frame`, `timecode`) on the tracks it acts on,
    /// each track's window of them in its `clips` list and, since C8-time-3, the place as a span of
    /// sequence ticks over each clip's `start` and `duration`, which the guard replays exactly
    /// ([`kition_film_engine::place`]); none for a command whose time names no clip
    /// (`playhead.set`, an export). `None` with no open sequence, and for `timeline.placeMany` and
    /// `sound.phrase`, whose places are their own list of times this answer cannot hold. And what
    /// the call needs of the objects it acts on, where the engine states it
    /// ([`kition_film_engine::premise`]); a cut at a place needs where the clip under it starts and
    /// its content, not its length. A track the sequence lacks is refused in the command's words.
    fn under(&self, command: &str, params: &Value) -> Result<Option<kition_kit::Under>, String> {
        let mut explicit;
        let params = if command == "clip.speedDuration"
            && params.is_object()
            && params.get("clips").and_then(Value::as_array).is_none()
            && params.get("clip").and_then(Value::as_u64).is_none()
        {
            explicit = params.clone();
            explicit["clips"] = json!(self.session.state.selection.iter().map(|clip| clip.0).collect::<Vec<_>>());
            &explicit
        } else {
            params
        };
        if acts::local_settings(command) {
            return Ok(None);
        }
        let result = (|| -> Result<Option<kition_kit::Under>, String> {
            // Terminal close consumes no document content; force discards it. The engine
            // checks unsaved state itself, and the SDK ends the run on {closed:true}.
            if matches!(command, "file.closeProject" | "file.closeAllProjects") {
                return Ok(Some(kition_kit::Under::default()));
            }
            if command == "file.newBin" && params.get("name").and_then(Value::as_str).is_some() {
                let parent = params.get("parent").and_then(Value::as_u64).unwrap_or(self.session.project.root.id.0);
                return Ok(Some(kition_kit::Under {
                    premises: vec![kition_kit::Premise::on(json!(parent)).fields(Vec::<String>::new()).positions(Vec::<String>::new())],
                    ..Default::default()
                }));
            }
            if let Some(under) = rests_clip_fields::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_clipboard::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_composites::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_placement::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_geometry::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_project_sources::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_project_management::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_nest_flatten::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_core::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_moves::under(&self.session, command) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_navigation::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_audio::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_transcript::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_sync::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_trim::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_luts::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_settings::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_effects::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_media::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if let Some(under) = rests_sequences::under(&self.session, command, params) {
                return Ok(Some(under));
            }
            if matches!(command, "project.searchBinItems" | "project.editSearchBin" | "project.deleteSearchBin")
                && let Some(id) = params.get("bin").and_then(Value::as_u64)
            {
                return Ok(Some(kition_kit::Under {
                    objects: vec![json!("project")],
                    premises: vec![kition_kit::Premise::on(json!("project")).fields([format!("searchBins[id={id}]")])],
                    ..Default::default()
                }));
            }
            if command.starts_with("mixer.")
                && let Some(sequence) = self.session.active_sequence()
            {
                let mut under = kition_kit::Under::default();
                for key in ["strip", "track", "output", "target"] {
                    let Some(value) = params.get(key) else { continue };
                    let Some(track) = kition_film_engine::mixer::strip_ref(sequence, value) else { continue };
                    if track == kition_film_engine::project::mixer::MASTER_STRIP {
                        if let Some(item) = self.session.state.active_sequence {
                            under.objects.push(json!(item.0));
                            under.premises.push(kition_kit::Premise::on(json!(item.0)).fields([
                                "sequence.masterVolumeDb",
                                "sequence.masterEffects",
                                "sequence.mixer",
                            ]));
                        }
                    } else {
                        under.objects.push(json!(track.0));
                    }
                }
                if !under.objects.is_empty() {
                    return Ok(Some(under));
                }
            }
            let mut premises: Vec<kition_kit::Premise> = self
                .session
                .premises(command, params)
                .into_iter()
                .map(|premise| kition_kit::Premise { id: json!(premise.id), fields: premise.fields, positions: premise.positions, ..Default::default() })
                .collect();
            let mut track_windows = Vec::new();
            if let Some(sequence) = self.session.active_sequence() {
                // An ordinal track is a position in the sequence, even when its time is empty.
                for key in ["track", "audioTrack"] {
                    let Some(spelling) = params.get(key).and_then(Value::as_str) else { continue };
                    let (tracks, field) = match spelling.as_bytes().first() {
                        Some(b'V' | b'v') => (&sequence.video_tracks, "sequence.videoTracks"),
                        Some(b'A' | b'a') => (&sequence.audio_tracks, "sequence.audioTracks"),
                        _ => continue,
                    };
                    let Some(index) = spelling.get(1..).and_then(|n| n.parse::<usize>().ok()).and_then(|n| n.checked_sub(1)) else { continue };
                    if let Some(track) = tracks.get(index) {
                        // The engine supplies the field premise; the ordinal adds only
                        // the address. Repeating a broad field here defeats a narrow patch.
                        if let Some(held) = premises.iter_mut().find(|held| held.id == json!(track.id.0)) {
                            held.positions.get_or_insert_with(Vec::new).push(field.to_owned());
                        } else {
                            premises.push(kition_kit::Premise::on(json!(track.id.0)).fields(Vec::<String>::new()).positions([field]));
                        }
                    }
                }
                if command == "clip.automateToSequence"
                    && !self.session.state.targeting.contains_key(&self.session.state.active_sequence.unwrap_or_default())
                    && let Some(item) = self.session.state.active_sequence
                {
                    for field in ["sequence.videoTracks", "sequence.audioTracks"] {
                        track_windows.push(kition_kit::Within { parent: json!(item.0), field: field.to_owned(), from: 0, to: 1, ..Default::default() });
                    }
                }
            }
            if matches!(command, "timeline.placeMany" | "sound.phrase") {
                return Ok(None);
            }
            // A clip named by id, with no place parameter, is no place: only what the call needs of it.
            let by_id = ["clip", "clips"].iter().any(|key| params.get(*key).is_some_and(|clip| !clip.is_null()));
            let found = if by_id
                && !matches!(command, "clip.speedDuration" | "timeline.trim")
                && kition_film_engine::place::places(command).iter().all(|name| params.get(*name).is_none_or(Value::is_null))
            {
                None
            } else {
                self.session.under(command, params).map_err(|error| error.to_string())?
            };
            let Some(found) = found else {
                // By id, a step's time is asked too (kition-sdk C8-fix-9): it names no clip; only what
                // the call needs of the clips it names.
                if by_id {
                    return Ok(Some(kition_kit::Under { premises, ..Default::default() }));
                }
                return Ok((!premises.is_empty()).then(|| kition_kit::Under { premises, ..Default::default() }));
            };
            if matches!(
                command,
                "timeline.razor"
                    | "sequence.addEdit"
                    | "sequence.addEditAllTracks"
                    | "clip.automateToSequence"
                    | "timeline.place"
                    | "markers.add"
                    | "markers.addRange"
                    | "markers.addChapter"
                    | "markers.addFlashCue"
            ) {
                // Independently reopened lists can pair a replacement with its former occupant.
                // Its immutable id changing means the place now contains another clip.
                premises.extend(found.clips.iter().map(|clip| kition_kit::Premise::on(json!(clip.0)).positions(["start", "clipId"])));
            }
            if matches!(command, "sequence.extract" | "sequence.lift") {
                // Whether a clip is still under the marked range, on any track Extract acts on, is
                // told by being asked (`covered`): a move to another such track inside the range is
                // no change of what it removes; one window per track would see the clip leave one.
                let mut under = kition_kit::Under {
                    objects: found.clips.iter().map(|clip| json!(clip.0)).collect(),
                    premises,
                    covers: Some(kition_kit::Covers::default()),
                    ..Default::default()
                };
                rests_sequences::caption_windows(&self.session, command, &mut under);
                return Ok(Some(under));
            }
            Ok(Some(kition_kit::Under {
                objects: found.clips.iter().map(|clip| json!(clip.0)).collect(),
                within: found
                    .windows
                    .iter()
                    .map(|window| kition_kit::Within {
                        parent: json!(window.track.0),
                        field: "clips".to_owned(),
                        from: window.from,
                        to: window.to,
                        time: Some(kition_kit::TimeSpan {
                            from: json!(window.at.0.to_string()),
                            to: json!(window.at.0.saturating_add(window.span.0).to_string()),
                            start: "start".to_owned(),
                            end: None,
                            duration: Some("duration".to_owned()),
                            identity: None,
                        }),
                    })
                    .chain(found.gaps.iter().map(|gap| kition_kit::Within {
                        parent: json!(gap.parent),
                        field: gap.field.to_owned(),
                        from: gap.index,
                        to: gap.index,
                        ..Default::default()
                    }))
                    .chain(track_windows)
                    .collect(),
                premises,
                ..Default::default()
            }))
        })()?;
        let result = rests_core::complete(&self.session, command, params, result);
        Ok(rests_search::complete(&self.session, command, params, result).map(|mut under| {
            facts::scope(&mut under);
            facts::selection(&self.session, command, params, &mut under);
            let mut under = rests_core::coalesce(under);
            facts::assignments(&mut under, command, params);
            under
        }))
    }

    fn content_at(&self, ask: &kition_kit::ContentAsk, _history: &dyn kition_kit::HistoricalBlobs) -> Result<Option<bool>, String> {
        Ok(facts::content(ask)
            .or_else(|| rests_edit_inputs::scan_order_changed(&self.session, &ask.premise.region))
            .or_else(|| rests_search::content(&self.session, ask)))
    }

    fn derived(&self, ids: &[Value], names: &[String]) -> Result<Vec<kition_kit::DerivedValues>, String> {
        let mut values: std::collections::BTreeMap<String, kition_kit::DerivedValues> = Default::default();
        for more in rests_media::derived(&self.session, ids, names)
            .into_iter()
            .chain(rests_sequences::derived(&self.session, ids, names))
            .chain(rests_navigation::derived(&self.session, ids, names))
            .chain(rests_fonts::derived(&self.session, ids, names))
            .chain(rests_effects::derived(&self.session, ids, names))
            .chain(rests_search::derived(&self.session, ids, names))
            .chain(facts::derived(&self.session, ids, names))
            .chain(rests_composites::derived(&self.session, ids, names))
            .chain(rests_geometry::derived(&self.session, ids, names))
            .chain(rests_project_sources::derived(&self.session, ids, names))
            .chain(rests_project_management::derived(&self.session, ids, names))
            .chain(rests_placement::derived(&self.session, ids, names))
        {
            // The protocol indexes responses by id. Merge every provider before
            // returning, including the media/sequence pair, so no facts are lost.
            match values.entry(more.id.to_string()) {
                std::collections::btree_map::Entry::Occupied(mut entry) => entry.get_mut().values.extend(more.values),
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(more);
                }
            }
        }
        Ok(values.into_values().collect())
    }

    /// What Extract's place named at `basis` (kition-sdk `KitDocument::covered`, C8-time-policy):
    /// the clips under the marked range then, on the tracks it acts on, from each asked clip's
    /// `start` and `duration` at `basis` and every other clip's now, and every clip others moved
    /// from one side of the range to the other (Extract shifts what is after it, not what is
    /// before it: such a clip is no longer where Extract's address put it). The range and the tracks are
    /// held by premises (`premise.rs`), so they are those of now. Which track a clip others
    /// moved was on is not told: when Extract acts on every track it does not matter; otherwise
    /// a clip whose time then overlaps the range cannot be told (`None`, which refuses).
    fn covered(&self, command: &str, params: &Value, objects: &[kition_kit::CoveredAsk]) -> Result<Option<kition_kit::CoveredAt>, String> {
        if command == "sequence.joinThroughEdits" {
            return Ok(rests_join::covered(&self.session, params, objects));
        }
        if !matches!(command, "sequence.extract" | "sequence.lift") {
            return Ok(None);
        }
        let Some(sequence) = self.session.active_sequence() else { return Ok(None) };
        let Some((at, end, tracks)) = self.session.marked_range(command == "sequence.extract") else { return Ok(None) };
        let every = sequence.all_tracks().all(|track| tracks.contains(&track.id));
        let tick = |value: Option<&Value>| value.and_then(|value| value.as_i64().or_else(|| value.as_str().and_then(|text| text.trim().parse().ok())));
        let overlaps = |start: i64, duration: i64| start < end.0 && start.saturating_add(duration) > at.0;
        let id_of = |value: &Value| value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse().ok()));
        let asked: Vec<Option<u64>> = objects.iter().map(|object| id_of(&object.id)).collect();
        let mut under: Vec<Value> = Vec::new();
        for track in sequence.all_tracks().filter(|track| tracks.contains(&track.id)) {
            for clip in &track.items {
                if !asked.contains(&Some(clip.id.0)) && overlaps(clip.start.0, clip.duration.0) {
                    under.push(json!(clip.id.0));
                }
            }
        }
        let mut covered = Vec::with_capacity(objects.len());
        for object in objects {
            let now = id_of(&object.id).and_then(|id| sequence.find_item(kition_film_engine::project::ClipId(id)));
            let answer = if object.created {
                Some(false)
            } else if id_of(&object.id).is_none() {
                // No tool id: not a clip (a caption, a marker, an effect is held as a path of the
                // object that holds it), so no range covers it; the captions Extract consumes are
                // held by `~markedCaptionMaterial`.
                Some(false)
            } else if object.deleted && object.before.is_empty() && object.unknown.iter().all(|field| field == "$was") {
                // The journal keeps `$was` for every deleted object whose type has a time
                // (kition-kdm `to_recorded_json`: a clip's `start` and `duration`): none is kept
                // for a track or an item, which no range covers.
                Some(false)
            } else if object.unknown.iter().any(|field| matches!(field.as_str(), "start" | "duration" | "$was")) {
                None
            } else {
                let start = tick(object.before.get("start")).or(now.map(|(_, clip)| clip.start.0));
                let duration = tick(object.before.get("duration")).or(now.map(|(_, clip)| clip.duration.0));
                // Which side of the range a clip is on decides whether Extract shifts it: a clip
                // others moved from after the range to before it (or back) is part of the place.
                let side = |start: i64, duration: i64| {
                    if start >= end.0 {
                        Some(true)
                    } else if start.saturating_add(duration) <= at.0 {
                        Some(false)
                    } else {
                        None
                    }
                };
                let crossed = command == "sequence.extract"
                    && match (start, duration, now) {
                        (Some(start), Some(duration), Some((_, clip))) => {
                            matches!((side(start, duration), side(clip.start.0, clip.duration.0)), (Some(was), Some(is)) if was != is)
                        }
                        _ => false,
                    };
                match (start, duration) {
                    _ if crossed => Some(true),
                    // Not a clip, or a deleted object the journal kept no time of.
                    (None, _) | (_, None) => Some(false),
                    (Some(start), Some(duration)) if !overlaps(start, duration) => Some(false),
                    _ if every => Some(true),
                    _ => None,
                }
            };
            if answer == Some(true) {
                under.push(object.id.clone());
            }
            covered.push(kition_kit::Covered { id: object.id.clone(), covered: answer, ..Default::default() });
        }
        Ok(Some(kition_kit::CoveredAt { under, covered }))
    }

    /// What is wrong with the project (KHP A21): see [`check`]. Whether each media file is there is
    /// asked of the host (its lent files), never of the file system.
    fn check(&self) -> Vec<kition_kit::diagnostics::Diagnostic> {
        let missing = kition_film_engine::relink::scan(&self.session.project, &*self.session.services)
            .into_iter()
            .filter(|media| media.status == "missing")
            .map(|media| kition_film_engine::project::ItemId(media.item))
            .collect();
        check::check(&self.session.project, &missing)
    }

    /// `document.text` (`KitText 1.0`): the titles and captions as plain text ([`text`]).
    fn text(&self, limit: usize) -> Result<kition_kit::text::DocumentText, String> {
        Ok(text::document_text(&self.session.project, limit))
    }

    fn save(&self, _name: Option<&str>) -> Result<Vec<u8>, String> {
        // The project only: the person's view is their view state (`view_state.rs`).
        Ok(kition_film_format::encode(&self.session.project, false))
    }

    fn mark_saved(&mut self) {
        self.session.saved_revision = self.session.revision;
        if self.session.path.is_none() {
            self.session.path = Some(self.name.clone());
        }
    }
}

/// Why a command did not run, with the reason typed (`kition_kit::failure`) so a host answers
/// its error code without reading the wording: an unknown command, one that cannot run now (or
/// with no sequence open), and wrong parameters. The engine's other errors carry no reason of
/// their own and are passed on as they read.
pub(crate) fn command_failure(error: kition_film_engine::EngineError) -> String {
    use kition_film_engine::EngineError;
    use kition_kit::failure::{CommandFailure, failure};
    match error {
        EngineError::UnknownCommand(_) => failure(CommandFailure::NotFound, error),
        EngineError::Disabled(..) | EngineError::NoSequence => failure(CommandFailure::Disabled, error),
        EngineError::BadParams { .. } => failure(CommandFailure::InvalidParams, error),
        EngineError::Edit(_) | EngineError::Media(_) | EngineError::Other(_) => error.to_string(),
    }
}

/// A call refused for its parameters or its context, for a reason the engine's schema cannot
/// state.
pub(crate) fn params_failure(message: impl std::fmt::Display) -> String {
    kition_kit::failure::failure(kition_kit::failure::CommandFailure::InvalidParams, message)
}

/// A call's part as the sequence it names: `{"sequence": id}`, the sequence's item id.
fn call_sequence(part: &Value) -> Result<u64, String> {
    let fields = part.as_object().filter(|fields| fields.len() == 1);
    match fields.and_then(|fields| fields.get("sequence")) {
        Some(id) => id
            .as_u64()
            .ok_or_else(|| format!("`part.sequence` is {id}: give {{\"sequence\": id}} with the sequence's item id as film_inspect lists it, a whole number")),
        None => Err(format!("`part` is {part}: this kit's parts are sequences, {{\"sequence\": id}} with the sequence's item id as film_inspect lists it")),
    }
}

/// `session`'s active sequence's sample rate (48 kHz by default).
pub(crate) fn session_audio_rate(session: &Session) -> u32 {
    session.active_sequence().map_or(48_000, |sequence| sequence.settings.sample_rate.max(1))
}

/// The first sample at `rate` of a chunk the page asks for at `start_seconds`.
pub(crate) fn audio_start(start_seconds: f64, rate: u32) -> i64 {
    if start_seconds.is_finite() { (start_seconds.max(0.0) * f64::from(rate)).round() as i64 } else { 0 }
}

/// `frames` stereo samples of `session`'s sequence mix from `start_seconds`, interleaved left and
/// right, at [`session_audio_rate`], at most [`FilmDocument::MAX_AUDIO_SECONDS`]. The strips'
/// levels the mix posts are kept in `levels` with the chunk ([`sound::record_levels`]).
pub(crate) fn session_audio(session: &Session, levels: &sound::LevelRing, start_seconds: f64, frames: u32) -> Result<Vec<f32>, String> {
    let id = session.state.active_sequence.ok_or("no sequence is open")?;
    let rate = session_audio_rate(session);
    let start = audio_start(start_seconds, rate);
    let frames = (frames as usize).min((FilmDocument::MAX_AUDIO_SECONDS * f64::from(rate)) as usize);
    let provider = session.media.provider(session.project.clone(), session.services.clone());
    // levels posted by anything mixed since the last chunk are not this chunk's
    session.previews.live.take_windows();
    let mix = session.previews.mix(&session.project, id, start, frames, &provider);
    sound::record_levels(session, levels, start, frames);
    let silence = Vec::new();
    let left = mix.channels.first().unwrap_or(&silence);
    let right = mix.channels.get(1).unwrap_or(left);
    let mut out = Vec::with_capacity(frames * 2);
    for index in 0..frames {
        out.push(left.get(index).copied().unwrap_or(0.0));
        out.push(right.get(index).copied().unwrap_or(0.0));
    }
    Ok(out)
}

/// The places in [`KitDocument::inspect`] that are the editing session's, not the document's, as
/// JSON Pointers: the playhead (at the top and in the open sequence), the timeline selection,
/// which sequence and which Source monitor item are open, how many projects the session has
/// opened, the session's own path, dirty state and revision, the preferences' revision, and a
/// digest of the editor's state (which moves with the playhead and the selection). They are no
/// part of what `view.describe` answers an agent (`film_inspect`'s details), so moving the
/// playhead, selecting clips or opening a sequence changes nothing the agent reads of the
/// document, while document fields of the same names elsewhere (a keyframe's `time`, the title
/// safe area's `title`) stay. `kition-film` passes them to kition-headless as its volatile keys.
pub const EDITOR_STATE: &[&str] = &[
    "/playhead",
    "/sequence/playhead",
    "/sequence/selection",
    "/project/activeSequence",
    "/project/sourceItem",
    "/project/epoch",
    "/project/path",
    "/project/dirty",
    "/project/revision",
    "/prefsRevision",
    "/stateDigest",
];

/// What [`KitDocument::inspect`] answers about `session`: the project, the active sequence
/// (tracks, clips, playhead, duration), history state, and the preferences' revision and a digest
/// of the editor's state, so a preference or a selection an agent's step changes (which makes no
/// revision) still moves the editor's info, and its panels read their views again.
pub(crate) fn inspect_session(session: &Session) -> Value {
    let project = kition_film_engine::commands::inspect_project(session);
    let sequence =
        session.state.active_sequence.and_then(|id| session.project.sequence(id).map(|seq| kition_film_engine::commands::inspect_sequence(session, id, seq)));
    json!({
        "project": project,
        "sequence": sequence,
        "playhead": session.playhead().0,
        "ticksPerSecond": kition_film_time::TICKS_PER_SECOND,
        "canUndo": session.history.can_undo(),
        "canRedo": session.history.can_redo(),
        "prefsRevision": session.prefs_revision,
        "stateDigest": state_digest(&session.state),
    })
}

/// A digest of the editor's state (selections, open sequences, views): equal for equal states.
fn state_digest(state: &kition_film_engine::EditorState) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(state).unwrap_or_default().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Types of parameters the notation leaves untyped, read from how the engine takes each one
/// (`str_p` a string, `bool_p` a boolean, `f64_p` a number, track and strip names or ids, …), so agents
/// see real types (KHP A5): `param_types.json`, per command id and key.
fn param_types() -> &'static serde_json::Map<String, serde_json::Value> {
    static TYPES: std::sync::OnceLock<serde_json::Map<String, serde_json::Value>> = std::sync::OnceLock::new();
    TYPES.get_or_init(|| serde_json::from_str(include_str!("param_types.json")).unwrap_or_default())
}

/// Fills a command's untyped parameter keys (`type: "json"`) from a kit's table of known types.
trait TypedFrom {
    fn typed_from(self, types: &serde_json::Map<String, serde_json::Value>) -> Self;
}

impl TypedFrom for KitCommand {
    fn typed_from(mut self, types: &serde_json::Map<String, serde_json::Value>) -> Self {
        let (Some(known), Some(schema)) =
            (types.get(&self.id).and_then(serde_json::Value::as_object), self.schema.as_mut().and_then(serde_json::Value::as_object_mut))
        else {
            return self;
        };
        for (key, node) in schema.iter_mut() {
            let untyped =
                node.get("type").is_none_or(|kind| kind == "json") && ["oneOf", "anyOf", "enum", "const"].iter().all(|word| node.get(*word).is_none());
            if let (true, Some(typed)) = (untyped, known.get(key)) {
                let required = node.get("required").cloned();
                let mut typed = typed.clone();
                if let (Some(required), Some(object)) = (required, typed.as_object_mut()) {
                    object.insert("required".into(), required);
                }
                *node = typed;
            }
        }
        self
    }
}

/// What a reading command answers (KHP A1 `output.schema`), from `outputs.json` (measured by
/// running each one; `tests/commands_described.rs` checks the answers still match).
fn output_schema(id: &str, mutates: bool) -> Option<serde_json::Value> {
    static OUTPUTS: std::sync::OnceLock<serde_json::Map<String, serde_json::Value>> = std::sync::OnceLock::new();
    if mutates {
        return None;
    }
    OUTPUTS.get_or_init(|| serde_json::from_str(include_str!("outputs.json")).unwrap_or_default()).get(id).cloned()
}

kition_kit::export_kit_document!(FilmDocument as "FilmDocument");

/// From now on, this process reads no font folder of the machine: only the bundled faces, the
/// kition-fonts faces built in, and those [`add_font`] adds (what the page has). A kit served
/// headless calls it at start (KHP A29: it reads only its workspace's files, through its host).
pub fn no_system_fonts() {
    kition_film_text::fonts::set_system_fonts(false);
    program::FONTS.fetch_add(1, Ordering::Relaxed);
}

/// Adds a font file's faces for text the bundled faces do not cover, such as Chinese titles and
/// captions in a web or headless build, which has no system fonts (standard E9): titles and
/// burned-in captions then resolve the family by name and fall back to these faces. Returns the
/// faces added.
pub fn add_font(bytes: &[u8]) -> usize {
    let added = kition_film_text::fonts::add_font_data(bytes.to_vec()).len();
    program::FONTS.fetch_add(1, Ordering::Relaxed);
    added
}

/// Film's own additions to the exported class: the sequence's audio, and exported files.
#[cfg(target_arch = "wasm32")]
pub mod web {
    use kition_kit::wasm_bindgen::prelude::*;
    use serde_json::json;

    use crate::__kition_kit_export::WebDocument;

    /// Adds a font file's faces for text the bundled faces do not cover; returns how many.
    #[wasm_bindgen(js_name = addFont, wasm_bindgen = kition_kit::wasm_bindgen)]
    pub fn add_font(bytes: &[u8]) -> u32 {
        crate::add_font(bytes) as u32
    }

    fn error(message: String) -> JsError {
        JsError::new(&message)
    }

    /// An origin in the KDM's commit form, the JSON array `[kind, principal, label]`.
    fn origin_of(origin: &str) -> Result<kition_film_engine::Origin, JsError> {
        kition_film_engine::Origin::decode(origin).ok_or_else(|| error(format!("origin is not [kind, principal, label]: {origin}")))
    }

    /// An item, clip, or export id from the page; NaN, negative, and fractional numbers are errors
    /// rather than another id (see [`crate::panels::js_id`]).
    fn id(value: f64, what: &str) -> Result<u64, JsError> {
        crate::panels::js_id(value, what).map_err(error)
    }

    #[wasm_bindgen(js_class = "FilmDocument", wasm_bindgen = kition_kit::wasm_bindgen)]
    impl WebDocument {
        #[wasm_bindgen(js_name = audioRate)]
        pub fn audio_rate(&self) -> u32 {
            self.0.audio_rate()
        }

        pub fn audio(&self, start_seconds: f64, frames: u32) -> Result<Vec<f32>, JsError> {
            self.0.audio(start_seconds, frames).map_err(error)
        }

        /// The mixer strips' levels per meter window of the chunk `audio` mixed from
        /// `start_seconds`, as JSON, or `null` (see [`FilmDocument::levels_at`]).
        #[wasm_bindgen(js_name = levelsAt)]
        pub fn levels_at(&self, start_seconds: f64) -> Result<String, JsError> {
            self.0.levels_at(start_seconds).map(|levels| levels.to_string()).map_err(error)
        }

        /// [`Self::levels_at`] of the open preview's copy (see
        /// [`FilmDocument::preview_levels_at`]).
        #[wasm_bindgen(js_name = previewLevelsAt)]
        pub fn preview_levels_at(&self, start_seconds: f64) -> Result<String, JsError> {
            self.0.preview_levels_at(start_seconds).map(|levels| levels.to_string()).map_err(error)
        }

        /// Feeds the loudness meter with interleaved stereo the page played at `rate` from
        /// `start_seconds` of the sequence (see
        /// [`FilmDocument::loudness_feed`]).
        #[wasm_bindgen(js_name = loudnessFeed)]
        pub fn loudness_feed(&self, samples: &[f32], rate: u32, start_seconds: f64) -> Result<(), JsError> {
            self.0.loudness_feed(samples, rate, start_seconds).map_err(error)
        }

        /// The loudness meter's readings as JSON (see [`FilmDocument::loudness_read`]).
        #[wasm_bindgen(js_name = loudnessRead)]
        pub fn loudness_read(&self) -> String {
            self.0.loudness_read().to_string()
        }

        /// Clears the loudness meter (see [`FilmDocument::loudness_reset`]).
        #[wasm_bindgen(js_name = loudnessReset)]
        pub fn loudness_reset(&self) {
            self.0.loudness_reset();
        }

        /// An audio effect's response and transfer curves as JSON (see
        /// [`FilmDocument::fx_response`]).
        #[wasm_bindgen(js_name = fxResponse)]
        pub fn fx_response(&self, target: &str, points: u32, drafts: &str) -> Result<String, JsError> {
            let target = kition_kit::parse_params(target).map_err(error)?;
            let drafts = kition_kit::parse_params(drafts).map_err(error)?;
            self.0.fx_response(&target, points, &drafts).map(|curves| curves.to_string()).map_err(error)
        }

        /// Item `item`'s frame at `seconds`, at most `max_width` wide: `[width u32 LE][height u32
        /// LE]` then RGBA (see [`FilmDocument::item_frame`]).
        #[wasm_bindgen(js_name = itemFrame)]
        pub fn item_frame(&self, item: f64, seconds: f64, max_width: u32) -> Result<Vec<u8>, JsError> {
            self.0.item_frame(id(item, "item")?, seconds, max_width).map_err(error)
        }

        /// Scopes as numbers at `seconds`: what `scopes.read` answers for `params`, as
        /// JSON (see [`FilmDocument::scopes`]).
        pub fn scopes(&self, seconds: f64, params: &str) -> Result<String, JsError> {
            let params = kition_kit::parse_params(params).map_err(error)?;
            self.0.scopes(seconds, params).map(|value| value.to_string()).map_err(error)
        }

        /// Scopes as upstream draws them at `seconds`: a JSON header, then each scope's
        /// RGBA (see [`FilmDocument::scope_images`]).
        #[wasm_bindgen(js_name = scopeImages)]
        pub fn scope_images(&self, seconds: f64, params: &str) -> Result<Vec<u8>, JsError> {
            let params = kition_kit::parse_params(params).map_err(error)?;
            self.0.scope_images(seconds, params).map_err(error)
        }

        /// The color preset thumbnails of `folder` (or `names`, a JSON array): `[count][width]
        /// [height]` as u32 LE, then each one's RGBA (see
        /// [`FilmDocument::color_preset_thumbnails`]).
        #[wasm_bindgen(js_name = colorPresetThumbnails)]
        pub fn color_preset_thumbnails(&self, folder: &str, names: &str, width: u32) -> Result<Vec<u8>, JsError> {
            let names: Vec<String> = if names.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str(names).map_err(|parse| error(format!("names are not a JSON list of names: {parse}")))?
            };
            crate::FilmDocument::color_preset_thumbnails(folder, &names, width).map_err(error)
        }

        /// Item `item`'s waveform peaks, `[min, max, …]` per 256 samples at 48 kHz (see
        /// [`FilmDocument::item_peaks`]).
        #[wasm_bindgen(js_name = itemPeaks)]
        pub fn item_peaks(&self, item: f64, start_seconds: f64, seconds: f64) -> Result<Vec<f32>, JsError> {
            self.0.item_peaks(id(item, "item")?, start_seconds, seconds).map_err(error)
        }

        /// Item `item`'s own sound, interleaved stereo at 48 kHz (see [`FilmDocument::item_audio`]).
        #[wasm_bindgen(js_name = itemAudio)]
        pub fn item_audio(&self, item: f64, start_seconds: f64, frames: u32) -> Result<Vec<f32>, JsError> {
            self.0.item_audio(id(item, "item")?, start_seconds, frames).map_err(error)
        }

        /// The Program monitor's render scale (see [`FilmDocument::set_render_scale`]).
        #[wasm_bindgen(js_name = setRenderScale)]
        pub fn set_render_scale(&self, scale: f32) -> Result<(), JsError> {
            self.0.set_render_scale(scale).map_err(error)
        }

        /// How the Program monitor moves: `still`, `play` or `scrub` (see
        /// [`FilmDocument::set_program_motion`]).
        #[wasm_bindgen(js_name = setProgramMotion)]
        pub fn set_program_motion(&self, motion: &str) -> Result<(), JsError> {
            self.0.set_program_motion(motion).map_err(error)
        }

        /// Whether the last Program picture was exact (see [`FilmDocument::program_frame_exact`]).
        #[wasm_bindgen(js_name = programFrameExact)]
        pub fn program_frame_exact(&self) -> bool {
            self.0.program_frame_exact()
        }

        /// Clip `clip`'s effects with their parameter schemas, typed values, and keyframes, as
        /// JSON (see [`FilmDocument::clip_effects`]).
        #[wasm_bindgen(js_name = clipEffects)]
        pub fn clip_effects(&self, clip: f64) -> Result<String, JsError> {
            self.0.clip_effects(id(clip, "clip")?).map(|effects| effects.to_string()).map_err(error)
        }

        /// What upstream's clip dialog for `command` opens with, `{params, info}`, as JSON (see
        /// [`FilmDocument::dialog_defaults`]).
        #[wasm_bindgen(js_name = dialogDefaults)]
        pub fn dialog_defaults(&self, command: &str) -> Result<String, JsError> {
            self.0.dialog_defaults(command).map(|defaults| defaults.to_string()).map_err(error)
        }

        /// What the Info panel shows about project item `item`, as JSON (see
        /// [`FilmDocument::item_info`]).
        #[wasm_bindgen(js_name = itemInfo)]
        pub fn item_info(&self, item: f64) -> Result<String, JsError> {
            self.0.item_info(id(item, "item")?).map(|info| info.to_string()).map_err(error)
        }

        /// The preferences' revision (see [`FilmDocument::prefs_version`]).
        #[wasm_bindgen(js_name = prefsVersion)]
        pub fn prefs_version(&self) -> f64 {
            self.0.prefs_version() as f64
        }

        /// The preferences and their revision, as JSON `{version, values}` (see [`FilmDocument::prefs_value`]).
        #[wasm_bindgen(js_name = prefsValue)]
        pub fn prefs_value(&self) -> String {
            self.0.prefs_value().to_string()
        }

        /// Takes stored preferences without running a command while the revision is still
        /// `expected`; answers JSON `{loaded, version, values}` (see [`FilmDocument::load_prefs`]).
        #[wasm_bindgen(js_name = loadPrefs)]
        pub fn load_prefs(&mut self, json: &str, expected: f64) -> Result<String, JsError> {
            self.0.load_prefs(json, expected as u64).map(|answer| answer.to_string()).map_err(error)
        }

        /// The person's view of the project as JSON, for the host's view state (see
        /// [`FilmDocument::view_state`]).
        #[wasm_bindgen(js_name = viewState)]
        pub fn view_state(&self) -> String {
            self.0.view_state().to_string()
        }

        /// Puts back a view state [`Self::view_state`] answered; answers whether it did (see
        /// [`FilmDocument::restore_view`]).
        #[wasm_bindgen(js_name = restoreView)]
        pub fn restore_view(&mut self, json: &str) -> bool {
            serde_json::from_str(json).is_ok_and(|state| self.0.restore_view(&state))
        }

        /// The graphic layers in the Program monitor's picture at the playhead, and where new
        /// layers go, as JSON (see [`FilmDocument::graphic_layers`]).
        #[wasm_bindgen(js_name = graphicLayers)]
        pub fn graphic_layers(&self) -> Result<String, JsError> {
            self.0.graphic_layers().map(|layers| layers.to_string()).map_err(error)
        }

        /// The engine's events since the last call (toasts, and the panels to show), as a JSON
        /// array (see [`FilmDocument::take_events`]).
        #[wasm_bindgen(js_name = takeEvents)]
        pub fn take_events(&mut self) -> String {
            self.0.take_events().to_string()
        }

        /// The ids of the commands that act on the Source monitor when it has focus, as a JSON
        /// array (see [`FilmDocument::source_commands`]).
        #[wasm_bindgen(js_name = sourceCommands)]
        pub fn source_commands(&self) -> String {
            json!(crate::FilmDocument::source_commands()).to_string()
        }

        /// Advances an export and reports it as JSON (see [`FilmDocument::export_step`]).
        #[wasm_bindgen(js_name = exportStep)]
        pub fn export_step(&mut self, job: f64, budget_ms: u32) -> Result<String, JsError> {
            self.0.export_step(id(job, "export")?, budget_ms).map(|value| value.to_string()).map_err(error)
        }

        /// Advances the document's background jobs and applies what finished, answering
        /// `{pending, revision, job}` as JSON (see [`FilmDocument::jobs_step`]).
        #[wasm_bindgen(js_name = jobsStep)]
        pub fn jobs_step(&mut self, budget_ms: u32) -> String {
            self.0.jobs_step(budget_ms).to_string()
        }

        /// Asks an export to stop (see [`FilmDocument::cancel_job`]); an id that is not a whole
        /// number is an error.
        #[wasm_bindgen(js_name = cancelJob)]
        pub fn cancel_job(&self, job: f64) -> Result<(), JsError> {
            self.0.cancel_job(id(job, "export")?);
            Ok(())
        }

        /// Runs a dialog's command on a scratch copy of the document and answers its result as
        /// JSON (see [`FilmDocument::preview_begin`]).
        #[wasm_bindgen(js_name = previewBegin)]
        pub fn preview_begin(&self, command: &str, params: &str) -> Result<String, JsError> {
            let params = kition_kit::parse_params(params).map_err(error)?;
            self.0.preview_begin(command, params).map(|value| value.to_string()).map_err(error)
        }

        /// Runs `[{command, params}, …]` on one scratch copy and answers their results as a JSON
        /// array (see [`FilmDocument::preview_begin_steps`]).
        #[wasm_bindgen(js_name = previewBeginSteps)]
        pub fn preview_begin_steps(&self, steps: &str) -> Result<String, JsError> {
            let steps = serde_json::from_str(steps).map_err(|parse| error(format!("steps are not JSON: {parse}")))?;
            self.0.preview_begin_steps(steps).map(|value| value.to_string()).map_err(error)
        }

        /// Advances the preview's jobs for at most `ms` and reports `{pending, progress}` as JSON
        /// (see [`FilmDocument::preview_settle`]).
        #[wasm_bindgen(js_name = previewSettle)]
        pub fn preview_settle(&self, ms: u32) -> Result<String, JsError> {
            self.0.preview_settle(ms).map(|value| value.to_string()).map_err(error)
        }

        /// The preview's program at `seconds`, at most `max_width` wide: `[width u32 LE][height
        /// u32 LE]` then RGBA (see [`FilmDocument::preview_frame`]).
        #[wasm_bindgen(js_name = previewFrame)]
        pub fn preview_frame(&self, seconds: f64, max_width: u32) -> Result<Vec<u8>, JsError> {
            self.0.preview_frame(seconds, max_width).map_err(error)
        }

        /// The preview's sample rate (see [`FilmDocument::preview_audio_rate`]).
        #[wasm_bindgen(js_name = previewAudioRate)]
        pub fn preview_audio_rate(&self) -> Result<u32, JsError> {
            self.0.preview_audio_rate().map_err(error)
        }

        /// The preview's sequence mix, interleaved stereo (see [`FilmDocument::preview_audio`]).
        #[wasm_bindgen(js_name = previewAudio)]
        pub fn preview_audio(&self, start_seconds: f64, frames: u32) -> Result<Vec<f32>, JsError> {
            self.0.preview_audio(start_seconds, frames).map_err(error)
        }

        /// The preview's `inspect()` as JSON, with the document's undo state (see
        /// [`FilmDocument::preview_inspect`]).
        #[wasm_bindgen(js_name = previewInspect)]
        pub fn preview_inspect(&self) -> Result<String, JsError> {
            self.0.preview_inspect().map(|value| value.to_string()).map_err(error)
        }

        /// What the preview changed against the document, by id, as JSON (see
        /// [`FilmDocument::preview_diff`]).
        #[wasm_bindgen(js_name = previewDiff)]
        pub fn preview_diff(&self) -> Result<String, JsError> {
            self.0.preview_diff().map(|value| value.to_string()).map_err(error)
        }

        /// A read-only query on the preview's copy, answered as JSON (see
        /// [`FilmDocument::preview_query`]).
        #[wasm_bindgen(js_name = previewQuery)]
        pub fn preview_query(&self, command: &str, params: &str) -> Result<String, JsError> {
            let params = kition_kit::parse_params(params).map_err(error)?;
            self.0.preview_query(command, params).map(|value| value.to_string()).map_err(error)
        }

        /// Item `item` of the preview's copy at `seconds`, at most `max_width` wide (see
        /// [`FilmDocument::preview_item_frame`]).
        #[wasm_bindgen(js_name = previewItemFrame)]
        pub fn preview_item_frame(&self, item: f64, seconds: f64, max_width: u32) -> Result<Vec<u8>, JsError> {
            self.0.preview_item_frame(id(item, "item")?, seconds, max_width).map_err(error)
        }

        /// Ends the preview, cancelling its jobs (see [`FilmDocument::preview_end`]).
        #[wasm_bindgen(js_name = previewEnd)]
        pub fn preview_end(&self) {
            self.0.preview_end();
        }

        /// A file the engine wrote (an export), taken out of memory; `undefined` when there is none.
        #[wasm_bindgen(js_name = takeFile)]
        pub fn take_file(&self, path: &str) -> Option<Vec<u8>> {
            self.0.take_file(path)
        }

        // Kition phase 3b, Task 3: the collaboration members (engine contract 2). Shapes mirror
        // `kition-sdk`'s `session::web` (`export_kit_session!` does not apply here; see
        // `crate::collab`).

        pub fn version(&mut self) -> Result<Vec<u8>, JsError> {
            self.0.version().map_err(error)
        }

        #[wasm_bindgen(js_name = exportChanges)]
        pub fn export_changes(&mut self, since: &[u8]) -> Result<Vec<u8>, JsError> {
            self.0.export_changes(since).map_err(error)
        }

        #[wasm_bindgen(js_name = importChanges)]
        pub fn import_changes(&mut self, bytes: &[u8]) -> Result<String, JsError> {
            self.0.import_changes(bytes).map(|damage| serde_json::to_string(&damage).unwrap_or_else(|_| "null".to_owned())).map_err(error)
        }

        pub fn snapshot(&mut self) -> Result<Vec<u8>, JsError> {
            self.0.snapshot().map_err(error)
        }

        pub fn undo(&mut self) -> Result<String, JsError> {
            self.0.undo().map(|(done, damage)| json!({ "done": done, "damage": damage }).to_string()).map_err(error)
        }

        pub fn redo(&mut self) -> Result<String, JsError> {
            self.0.redo().map(|(done, damage)| json!({ "done": done, "damage": damage }).to_string()).map_err(error)
        }

        /// `model/describe` as JSON text.
        #[wasm_bindgen(js_name = modelDescribe)]
        pub fn model_describe(&mut self) -> Result<String, JsError> {
            self.0.model_describe().map(|answer| answer.to_string()).map_err(|failure| error(failure.to_string()))
        }

        /// `model/batch`: the request and the answer as JSON text, one undo step; a failure's
        /// message is the error's JSON (`{"code", "index", "message"}`).
        #[wasm_bindgen(js_name = modelBatch)]
        pub fn model_batch(&mut self, request: &str) -> Result<String, JsError> {
            let request: serde_json::Value = serde_json::from_str(request)
                .map_err(|failure| error(json!({ "code": "invalid-op", "index": null, "message": format!("the batch is not JSON: {failure}") }).to_string()))?;
            self.0.model_batch(&request).map(|answer| answer.to_string()).map_err(|failure| error(failure.to_string()))
        }

        /// A draft's changes taken in as one undo step of the person, recorded with `origin`
        /// (`[kind, principal, label]`): `{"damage", "summary"}`. A refusal fails with the KDM's
        /// message.
        #[wasm_bindgen(js_name = mergeChanges)]
        pub fn merge_changes(&mut self, changes: &[u8], origin: &str) -> Result<String, JsError> {
            let origin = origin_of(origin)?;
            self.0.merge_changes(changes, &origin).map(|answer| answer.to_string()).map_err(error)
        }

        /// What merging a draft's changes would change now, as `StateDiff` JSON; changes nothing.
        #[wasm_bindgen(js_name = compareChanges)]
        pub fn compare_changes(&self, changes: &[u8]) -> Result<String, JsError> {
            self.0.compare_changes(changes).map(|answer| answer.to_string()).map_err(error)
        }

        /// Writes the state a snapshot holds over the project as one change of `origin`; answers
        /// the damage JSON.
        #[wasm_bindgen(js_name = restoreState)]
        pub fn restore_state(&mut self, snapshot: &[u8], origin: &str) -> Result<String, JsError> {
            let origin = origin_of(origin)?;
            self.0.restore_state(snapshot, &origin).map(|damage| serde_json::to_string(&damage).unwrap_or_else(|_| "null".to_owned())).map_err(error)
        }

        /// An agent's reply (JSON text) with its object ids named as the tool interface names them.
        #[wasm_bindgen(js_name = modelReply)]
        pub fn model_reply(&self, value: &str) -> Result<String, JsError> {
            self.0.model_reply(value).map_err(error)
        }

        /// What changed since the version `since` (a receipt): `{"changes": StateDiff}`, or
        /// `{"changes": null, "unavailable"}` when the replica's log does not hold it.
        #[wasm_bindgen(js_name = changesSince)]
        pub fn changes_since(&self, since: &[u8]) -> String {
            self.0.changes_since(since).to_string()
        }

        #[wasm_bindgen(js_name = canUndo)]
        pub fn can_undo(&self) -> bool {
            self.0.can_undo()
        }

        #[wasm_bindgen(js_name = canRedo)]
        pub fn can_redo(&self) -> bool {
            self.0.can_redo()
        }

        /// `origin` is the KDM's commit form, the JSON array `[kind, principal, label]`.
        #[wasm_bindgen(js_name = executeAs)]
        pub fn execute_as(&mut self, command: &str, params: &str, origin: &str) -> Result<String, JsError> {
            let params = kition_kit::parse_params(params).map_err(error)?;
            let origin = kition_film_engine::Origin::decode(origin).ok_or_else(|| error(format!("origin is not [kind, principal, label]: {origin}")))?;
            self.0.execute_as(command, params, &origin).map(|value| value.to_string()).map_err(error)
        }

        /// Every blob the replica references: the text of the project's LUTs.
        pub fn blobs(&mut self) -> Result<Vec<u8>, JsError> {
            self.0.blobs().map_err(error)
        }

        /// Adds a peer's blobs (from their `blobs()`), before the changes that reference them.
        #[wasm_bindgen(js_name = addBlobs)]
        pub fn add_blobs(&mut self, bytes: &[u8]) -> Result<(), JsError> {
            self.0.add_blobs(bytes).map_err(error)
        }

        #[wasm_bindgen(js_name = kdmResets)]
        pub fn kdm_resets(&self) -> u32 {
            self.0.kdm_resets()
        }

        /// Opens a file with the replica a host stored for it (the Kit UI protocol's `replica`
        /// capability); a replica that does not open is ignored and the file opens plainly.
        #[wasm_bindgen(js_name = openWithReplica)]
        pub fn open_with_replica(name: &str, bytes: &[u8], snapshot: &[u8], blobs: &[u8]) -> Result<WebDocument, JsError> {
            crate::FilmDocument::open_with_replica(name, bytes, snapshot, blobs).map(Self).map_err(error)
        }

        /// Whether the project has made its replica yet (it makes one on the first shared edit).
        #[wasm_bindgen(getter, js_name = hasReplica)]
        pub fn has_replica(&self) -> bool {
            self.0.has_replica()
        }

        /// The replica's own document id, for the Kit UI protocol's `replica/info` message.
        /// `undefined` before the project has made a replica yet.
        #[wasm_bindgen(getter, js_name = docId)]
        pub fn doc_id(&self) -> Option<String> {
            self.0.doc_id()
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use kition_kit::testing::check_contract;

    /// Held by every test that lends files through [`kition_kit::host::set_root`], which is global.
    pub(crate) static HOST_ROOT: Mutex<()> = Mutex::new(());

    /// One second of a 440 Hz tone as mono 16-bit PCM WAV at 48 kHz.
    pub(crate) fn tone_wav() -> Vec<u8> {
        let rate = 48_000u32;
        let samples: Vec<i16> = (0..rate).map(|i| ((i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 12_000.0) as i16).collect();
        let mut wav = Vec::new();
        let data_len = samples.len() as u32 * 2;
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for sample in &samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        wav
    }

    /// A preference an agent changes (Metadata Display's columns) changes what `inspect` answers,
    /// so the editor's info moves and its panels read their views again: a preference makes no
    /// revision, and kit-editor sends info only when `inspect` changes.
    #[test]
    fn a_preference_change_moves_what_inspect_answers() {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let before = doc.inspect().unwrap();
        doc.execute("project.columns.set", json!({ "columns": ["Name", "Media Duration"] })).unwrap();
        let after = doc.inspect().unwrap();
        assert_ne!(after, before, "inspect must change when a preference does");
        let read = doc.inspect().unwrap();
        assert_eq!(read, after, "a second read of the same state answers the same");
    }

    /// An agent's command that changes only the editor's state (the Project panel's selection)
    /// makes no revision either, and must change what `inspect` answers for the same reason.
    #[test]
    fn an_editor_state_change_moves_what_inspect_answers() {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let matte = doc.execute("file.newColorMatte", json!({ "color": "#ff0000", "seconds": 4.0 })).unwrap();
        doc.execute("project.select", json!({ "items": [] })).unwrap();
        let before = doc.inspect().unwrap();
        let revision = doc.session.revision;
        doc.execute("project.select", json!({ "items": [matte["item"]] })).unwrap();
        assert_eq!(doc.session.revision, revision, "a selection makes no revision");
        assert_ne!(doc.inspect().unwrap(), before, "inspect must change when the editor's state does");
    }

    /// A 64 × 36 project with a red colour matte on the timeline: no media files needed.
    pub(crate) fn fixture() -> Vec<u8> {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let matte = doc.execute("file.newColorMatte", json!({ "color": "#ff0000", "seconds": 4.0 })).unwrap();
        doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0.0 })).unwrap();
        doc.save(None).unwrap()
    }

    #[test]
    fn takes_a_font_for_text_its_bundled_faces_do_not_cover() {
        assert_eq!(add_font(b"not a font"), 0);
        let font = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../kition-fonts/fonts/droid-sans-fallback/DroidSansFallbackFull.ttf");
        let Ok(bytes) = std::fs::read(font) else { return };
        assert!(add_font(&bytes) > 0);
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let families = doc.execute("fonts.list", json!({ "system": false })).unwrap();
        assert!(families.as_array().unwrap().iter().any(|f| f["family"] == "Droid Sans Fallback"), "{families}");
    }

    #[test]
    fn keeps_the_kit_contract() {
        check_contract::<FilmDocument>(&fixture(), "Edit.kfilm", |doc| {
            let matte = doc.execute("file.newColorMatte", json!({ "color": "#0000ff", "seconds": 2.0 }))?;
            doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V2", "seconds": 0.0 })).map(|_| ())
        })
        .unwrap();
    }

    #[test]
    fn derived_providers_return_one_complete_entry_per_object() {
        let doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        for names in [Vec::new(), vec!["metadataVideoReadOnly".to_owned(), "motionScale".to_owned()]] {
            let values = doc.derived(&[], &names).unwrap();
            let unique: std::collections::BTreeSet<_> = values.iter().map(|value| value.id.to_string()).collect();
            assert_eq!(values.len(), unique.len(), "duplicate entries lose facts when the host indexes them by object id");
            for id in doc.session.project.items.keys() {
                let value = values.iter().find(|value| value.id == json!(id.0)).expect("Item facts");
                assert!(value.values.contains_key("metadataVideoReadOnly"), "metadata provider was retained: {value:?}");
                assert!(value.values.contains_key("motionScale"), "sequence provider was retained: {value:?}");
            }
        }
    }

    #[test]
    fn shows_the_frame_at_the_playhead() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        assert_eq!((doc.width(), doc.height()), (64, 36));
        let red = doc.render(0.0, 0.0, 1.0, 64, 36).unwrap();
        assert_eq!(&red[..4], &[255, 0, 0, 255]);
        doc.execute("playhead.set", json!({ "seconds": 10.0 })).unwrap();
        let after = doc.render(0.0, 0.0, 1.0, 64, 36).unwrap();
        assert_eq!(&after[..4], &[0, 0, 0, 255], "black past the end of the clip");
        let inspected = doc.inspect().unwrap();
        assert_eq!(inspected["sequence"]["video"][0]["items"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn mixes_the_sequence_audio() {
        let _lock = HOST_ROOT.lock().unwrap_or_else(PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("kition-film-audio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tone.wav"), tone_wav()).unwrap();
        kition_kit::host::set_root(Some(dir.clone()));

        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let imported = doc.execute("file.import", json!({ "paths": ["tone.wav"] })).unwrap();
        doc.execute("timeline.place", json!({ "item": imported["items"][0], "track": "A1", "seconds": 0.0 })).unwrap();
        assert_eq!(doc.audio_rate(), 48_000);
        let heard = doc.audio(0.25, 4_800).unwrap();
        assert_eq!(heard.len(), 4_800 * 2);
        assert!(heard.iter().any(|sample| sample.abs() > 0.05), "the tone is audible");
        let after = doc.audio(5.0, 4_800).unwrap();
        assert!(after.iter().all(|sample| sample.abs() < 1e-6), "silence after the clip");
        kition_kit::host::set_root(None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn exports_the_sequence_as_mp4() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let started = std::time::Instant::now();
        doc.execute(
            "file.exportMedia",
            json!({ "path": "Edit.mp4", "format": "h264", "wait": true, "range": "custom", "startSeconds": 0.0, "endSeconds": 1.0 }),
        )
        .unwrap();
        let bytes = doc.take_file("Edit.mp4").expect("the export is in memory");
        assert_eq!(&bytes[4..8], b"ftyp", "an MP4");
        assert!(doc.take_file("Edit.mp4").is_none(), "taken once");
        assert!(doc.take_file("Edit.kfilm").is_none(), "the project itself is not handed out");
        eprintln!("exported {} bytes in {:?}", bytes.len(), started.elapsed());
    }

    #[test]
    fn exports_step_by_step_with_progress() {
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let started = doc
            .execute("file.exportMedia", json!({ "path": "Step.mp4", "format": "h264", "range": "custom", "startSeconds": 0.0, "endSeconds": 1.0 }))
            .unwrap();
        let job = started.get("job").or_else(|| started.get("id")).and_then(Value::as_u64).unwrap_or_else(|| panic!("no job in {started}"));
        let mut report = json!({});
        // Natively the export runs on a thread; in WebAssembly each step encodes frames.
        for _ in 0..1_000 {
            report = doc.export_step(job, 20).unwrap();
            if report["finished"] == true {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(report["finished"], true, "{report}");
        assert!(report["result"].get("error").is_none(), "{report}");
        assert_eq!(&doc.take_file("Step.mp4").unwrap()[4..8], b"ftyp");
        assert!(doc.export_step(9_999, 1).is_err());
    }

    #[test]
    fn bad_files_are_errors_not_panics() {
        assert!(FilmDocument::open("Broken.kfilm", b"{not a project").is_err());
        assert!(FilmDocument::open("Broken.kfilm", b"").is_err());
        let mut doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        assert!(doc.execute("no.such.command", json!({})).is_err());
    }

    /// The web document's own Scene Edit Detection (a host without threads, `step_jobs`, which the
    /// WebAssembly build sets): the command returns before the analysis; `jobs_step` advances it
    /// and applies the result through `poll_persistence`, one "Scene Edit Detection" history step
    /// that moves the replica's version; it answers the running job while there is one.
    #[test]
    fn jobs_step_runs_the_documents_scene_detection_and_replicates_its_one_step() {
        let mut doc = FilmDocument::create("Edit.kfilm", 640, 360).unwrap();
        doc.session.step_jobs = true;
        let leader = doc.execute("file.newCountingLeader", json!({})).unwrap()["item"].as_u64().unwrap();
        doc.execute("timeline.place", json!({ "item": leader, "track": "V1", "seconds": 0.0 })).unwrap();
        let clip = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["clip"].as_u64().unwrap();
        let version = doc.version().unwrap();
        let steps = doc.session.history.undo.len();
        let started =
            doc.execute("clip.sceneEditDetection", json!({ "clips": [clip], "applyCuts": false, "generateMarkers": true, "sensitivity": 100.0 })).unwrap();
        let job = started["job"].as_u64().unwrap();
        assert_eq!(doc.session.history.undo.len(), steps, "the command returns before the analysis");
        let first = doc.jobs_step(1);
        assert_eq!(first["pending"], true, "{first}");
        assert_eq!(first["job"]["id"], job);
        assert!(first["job"]["progress"].as_f64().unwrap() < 1.0, "{first}");
        let mut answer = first;
        for _ in 0..100_000 {
            answer = doc.jobs_step(1);
            if answer["pending"] == false {
                break;
            }
        }
        assert_eq!(answer["pending"], false, "{answer}");
        assert_eq!(answer["job"], Value::Null, "no job runs");
        assert_eq!(answer["revision"], doc.session.revision);
        assert_eq!(doc.session.history.undo.len(), steps + 1);
        assert_eq!(doc.session.history.undo.last().unwrap().0, "Scene Edit Detection");
        assert_ne!(doc.version().unwrap(), version, "the replica records the step");
        let markers = doc.session.project.item(kition_film_engine::project::ItemId(leader)).unwrap().as_media().unwrap().markers.len();
        assert!(markers >= 3, "{markers}");
        // jobs.cancel mid-job: nothing changes.
        let revision = doc.session.revision;
        let again = doc.execute("clip.sceneEditDetection", json!({ "clips": [clip], "applyCuts": true })).unwrap();
        assert_eq!(doc.jobs_step(1)["pending"], true);
        doc.execute("jobs.cancel", json!({ "job": again["job"] })).unwrap();
        for _ in 0..1_000 {
            if doc.jobs_step(1)["pending"] == false {
                break;
            }
        }
        assert_eq!(doc.jobs_step(1)["pending"], false);
        assert_eq!(doc.session.revision, revision);
        // Native documents (no flag) keep their thread and wait in the command with `wait`.
        let mut native = FilmDocument::create("Native.kfilm", 64, 36).unwrap();
        assert!(!native.session.step_jobs || cfg!(target_arch = "wasm32"));
        assert_eq!(native.jobs_step(1), json!({ "pending": false, "revision": native.session.revision, "job": null }));
    }
}
