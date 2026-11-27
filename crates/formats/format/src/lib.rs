//! `.kfilm` project files.
//!
//! A project file is UTF-8 JSON with an explicit format version:
//!
//! ```json
//! { "format": "kition-film.project", "schema_version": 1, "project": { … } }
//! ```
//!
//! - **Versioning.** [`SCHEMA_VERSION`] is the one version this build reads and writes. There is
//!   no upgrade chain: a file of any other version is refused with
//!   [`FormatError::Unsupported`], never half-read (and later overwritten with data loss).
//! - **Atomic saves.** [`atomic_write`] writes a temp file in the destination directory, fsyncs it,
//!   renames it over the target and fsyncs the directory: a crash or power cut during a save leaves
//!   either the old file or the new one, never a torn mix.
//! - **Auto-save naming/rotation** lives in [`autosave`] (`<name>-YYYY-MM-DD_HH-MM-SS.kfilm` in an
//!   `Auto-Save` folder next to the project, oldest pruned beyond the version limit).
//! - **Content only.** The file holds the project and nothing of one person's view of it (the open
//!   sequence tabs, the Timeline's zoom and scroll): that is the person's view state, which the
//!   host keeps apart from the file (Kit UI protocol 7n). Nor does it hold a session's own id
//!   counter: a document is saved with [`encode_file`], whose `next_id` is the first id past every
//!   id the project holds, so it depends on the content alone. Two sessions that open the same
//!   file and save it without an edit write the same bytes, also when one of them opened it with
//!   its stored replica. Nor does it name the build that wrote it: the bytes depend on the
//!   content alone, whichever version of Kition Film saves it.
//! - **Listed keys only.** The envelope holds `format`, `schema_version` and `project`; a file with
//!   any other top-level key is refused as damaged ([`FormatError::Corrupt`]), never read in part.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable))]

pub mod atomic;
pub mod autosave;

use kition_film_project::Project;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use atomic::atomic_write;

/// The `format` tag written in every envelope.
pub const FORMAT_ID: &str = "kition-film.project";

/// The format version this build reads and writes.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum FormatError {
    #[error("not a Kition Film project: {0}")]
    NotAProject(String),
    #[error("this project file is format version {found}; this build of Kition Film reads version {supported} only")]
    Unsupported { found: u32, supported: u32 },
    #[error("project file is damaged: {0}")]
    Corrupt(String),
}

/// A project read from disk.
#[derive(Debug)]
pub struct Loaded {
    pub project: Project,
    /// Format version found in the file (always [`SCHEMA_VERSION`]: no other is read).
    pub schema_version: u32,
}

#[derive(Serialize)]
struct EnvelopeOut<'a> {
    format: &'static str,
    schema_version: u32,
    project: &'a Project,
}

/// The envelope as read: its listed keys and no other (`format` and `schema_version` are checked
/// by [`Probe`] first).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvelopeIn {
    #[serde(rename = "format")]
    _format: Value,
    #[serde(rename = "schema_version")]
    _schema_version: Value,
    project: Project,
}

impl EnvelopeIn {
    fn loaded(self, schema_version: u32) -> Loaded {
        Loaded { project: self.project, schema_version }
    }
}

/// Just enough of a document to know which format version it is.
#[derive(Deserialize)]
struct Probe {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    schema_version: Option<u32>,
}

/// Serialize a project. `pretty` = indented (human-diffable), compact otherwise (what project
/// files and recovery snapshots are written as).
pub fn encode(project: &Project, pretty: bool) -> Vec<u8> {
    let env = EnvelopeOut { format: FORMAT_ID, schema_version: SCHEMA_VERSION, project };
    let r = if pretty { serde_json::to_vec_pretty(&env) } else { serde_json::to_vec(&env) };
    // Serializing plain data (string keys, finite numbers or null) cannot fail.
    r.unwrap_or_default()
}

/// Serialize a project as its file holds it: [`encode`], with `next_id` written as the first id
/// past every id the project holds, ids kept as data included ([`Project::minimum_next_id`]),
/// instead of the session's own counter. That counter is the session's: it never goes back within
/// the session (an id a step made that was undone since is never handed out again), and once the
/// project has a replica it runs in that replica's own range of ids (`kdm_model::slot_base`), so
/// a draft, a replica forked from the document, never mints an id the document mints. Neither is
/// content: written this way, a project saves the same bytes whoever saves the same content, and a
/// project reopened (with or without its stored replica) and saved unchanged saves the bytes it
/// was opened from. Reading the file back gives a counter no smaller than every id it holds, so a
/// new session never reuses an id the content holds.
pub fn encode_file(project: &Project, pretty: bool) -> Vec<u8> {
    match project.minimum_next_id(true) {
        Some(counter) if counter != project.next_id => {
            let mut content = project.clone();
            content.next_id = counter;
            encode(&content, pretty)
        }
        _ => encode(project, pretty),
    }
}

/// The format version of a parsed document.
pub fn detect_version(doc: &Value) -> Result<u32, FormatError> {
    let probe: Probe = serde_json::from_value(doc.clone()).map_err(|e| FormatError::NotAProject(e.to_string()))?;
    probe_version(&probe)
}

fn probe_version(p: &Probe) -> Result<u32, FormatError> {
    if p.format.as_deref() != Some(FORMAT_ID) {
        return Err(FormatError::NotAProject(match &p.format {
            Some(f) => format!("format is `{f}`, expected `{FORMAT_ID}`"),
            None => "no `format`".into(),
        }));
    }
    p.schema_version.ok_or_else(|| FormatError::NotAProject("no `schema_version`".into()))
}

/// Read a project file.
pub fn decode(bytes: &[u8]) -> Result<Loaded, FormatError> {
    let probe: Probe = serde_json::from_slice(bytes)
        .map_err(|e| if e.is_syntax() || e.is_eof() { FormatError::Corrupt(e.to_string()) } else { FormatError::NotAProject(e.to_string()) })?;
    let found = probe_version(&probe)?;
    if found != SCHEMA_VERSION {
        return Err(FormatError::Unsupported { found, supported: SCHEMA_VERSION });
    }
    let env: EnvelopeIn = serde_json::from_slice(bytes).map_err(|e| FormatError::Corrupt(e.to_string()))?;
    validate_loaded(env.loaded(found))
}

/// Refuse values that would overwrite live ids, overflow or exhaust memory later (`Sequence::check_bounds`);
/// structural rules such as overlaps are left to the editor, so projects that open today still open.
fn validate_loaded(mut loaded: Loaded) -> Result<Loaded, FormatError> {
    let minimum = loaded.project.minimum_next_id(false).ok_or_else(|| FormatError::Corrupt("project id space exhausted".into()))?;
    // Tool ids travel through JavaScript numbers and must remain exact. A
    // hostile saved counter can otherwise both overflow alloc_id and mint ids
    // that the object-model boundary cannot address.
    if loaded.project.next_id > kition_film_project::MAX_TOOL_ID
        || loaded.project.minimum_next_id(true).is_none_or(|minimum| minimum > kition_film_project::MAX_TOOL_ID)
    {
        return Err(FormatError::Corrupt("next_id exceeds the exact tool id range".into()));
    }
    if loaded.project.next_id < minimum {
        return Err(FormatError::Corrupt(format!("next_id {} would reuse an existing id (minimum {minimum})", loaded.project.next_id)));
    }
    // Out-of-range audio stream data is repaired, not refused: failing the load would lose the
    // whole project over one bad index. A media item keeps its first `MAX_AUDIO_STREAMS` streams; a
    // clip pointing past that plays stream 0.
    let max = kition_film_media::MAX_AUDIO_STREAMS;
    for item in loaded.project.items.values_mut() {
        let name = item.name.clone();
        match &mut item.kind {
            kition_film_project::ItemKind::Media(m) if m.info.audio_streams.len() > max => {
                log::warn!("media `{name}`: {} audio streams, keeping the first {max}", m.info.audio_streams.len());
                m.info.audio_streams.truncate(max);
            }
            kition_film_project::ItemKind::Sequence(sequence) => {
                for clip in sequence.audio_tracks.iter_mut().flat_map(|t| t.items.iter_mut()) {
                    if clip.audio_stream >= max {
                        log::warn!("sequence `{name}`: clip `{}` uses audio stream {}, reset to 0", clip.name, clip.audio_stream);
                        clip.audio_stream = 0;
                    }
                }
            }
            _ => {}
        }
    }
    for item in loaded.project.sequences() {
        if let kition_film_project::ItemKind::Sequence(sequence) = &item.kind {
            sequence.check_bounds().map_err(|e| FormatError::Corrupt(format!("sequence `{}`: {e}", item.name)))?;
        }
    }
    Ok(loaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_format_version_is_one() {
        assert_eq!(SCHEMA_VERSION, 1);
    }

    #[test]
    fn damaged_sequence_settings_are_rejected_before_rendering() {
        let mut p = Project::new("Invalid sequence");
        let id = p.new_sequence("Bad", kition_film_project::SequenceSettings::default(), 1, 1, None);
        for (width, height, sample_rate) in [(0, 90, 48000), (160, 0, 48000), (160, 90, 0), (65536, 90, 48000), (32768, 16384, 48000)] {
            let settings = &mut p.sequence_mut(id).unwrap().settings;
            (settings.width, settings.height, settings.sample_rate) = (width, height, sample_rate);
            assert!(matches!(decode(&encode(&p, false)), Err(FormatError::Corrupt(_))));
        }
    }

    /// Load-time validation refuses only overflowing values. A project that breaks a
    /// structural rule (overlapping or zero-length clips) still opens; and 16K sequences are not
    /// "too large".
    #[test]
    fn structural_rule_breaks_still_open() {
        use kition_film_project::{ItemKind, SequenceSettings, TrackKind};
        use kition_film_time::{FrameRate, Tick, TimeRange};
        let mut p = Project::new("Legacy");
        let rate = FrameRate::FPS_24;
        let layer = p.add_item(
            "Layer",
            kition_film_project::Label::Iris,
            ItemKind::AdjustmentLayer { width: 1920, height: 1080, rate, duration: rate.tick_of(48) },
            None,
        );
        let settings = SequenceSettings { width: 15360, height: 8640, ..Default::default() };
        let seq = p.new_sequence("Sequence 01", settings, 1, 1, None);
        let range = TimeRange::new(Tick::ZERO, rate.tick_of(48));
        let a = p.make_track_item(layer, TrackKind::Video, Tick::ZERO, range, rate).unwrap();
        let b = p.make_track_item(layer, TrackKind::Video, rate.tick_of(24), range, rate).unwrap();
        let mut c = p.make_track_item(layer, TrackKind::Video, rate.tick_of(200), range, rate).unwrap();
        c.duration = Tick::ZERO;
        p.sequence_mut(seq).unwrap().video_tracks[0].items = vec![a, b, c];
        assert!(p.sequence(seq).unwrap().check().is_err(), "the sequence breaks the editor's invariants");
        let loaded = decode(&encode(&p, false)).unwrap_or_else(|e| panic!("a project that opened before is refused: {e}"));
        assert_eq!(loaded.project.sequence(seq).unwrap().video_tracks[0].items.len(), 3);
    }

    #[test]
    fn roundtrip_current() {
        let p = Project::new("Round Trip");
        for pretty in [true, false] {
            let b = encode(&p, pretty);
            let l = decode(&b).unwrap();
            assert_eq!(l.project, p);
            assert_eq!(l.schema_version, SCHEMA_VERSION);
        }
    }

    /// The file holds the project only: nothing of what is open in an editor (the person's view
    /// state, kept by the host), so saving the same project always writes the same bytes.
    #[test]
    fn the_file_holds_the_project_and_no_view() {
        use kition_film_project::SequenceSettings;
        let mut p = Project::new("Tabs");
        p.new_sequence("Sequence 01", SequenceSettings::default(), 1, 1, None);
        for pretty in [true, false] {
            let bytes = encode(&p, pretty);
            let doc: Value = serde_json::from_slice(&bytes).unwrap();
            let mut keys: Vec<&str> = doc.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, ["format", "project", "schema_version"], "the envelope's fields");
            assert_eq!(decode(&bytes).unwrap().project, p);
            assert_eq!(encode(&decode(&bytes).unwrap().project, pretty), bytes, "read and written again: the same bytes");
        }
    }

    /// A clip with unresolved "auto" points (NaN) is written with `null` coordinates. Such a file
    /// used to be refused as damaged; it opens, and the points are still "auto".
    #[test]
    fn auto_points_written_as_null_open_again() {
        use kition_film_project::{ItemKind, SequenceSettings, TrackKind};
        use kition_film_time::{FrameRate, Tick, TimeRange};
        let mut p = Project::new("Imported");
        let layer = p.add_item(
            "Layer",
            kition_film_project::Label::Iris,
            ItemKind::AdjustmentLayer { width: 3840, height: 2160, rate: FrameRate::FPS_24, duration: FrameRate::FPS_24.tick_of(48) },
            None,
        );
        let seq = p.new_sequence("Sequence 01", SequenceSettings::default(), 1, 1, None);
        let ti = p.make_track_item(layer, TrackKind::Video, Tick::ZERO, TimeRange::new(Tick::ZERO, FrameRate::FPS_24.tick_of(48)), FrameRate::FPS_24).unwrap();
        p.sequence_mut(seq).unwrap().video_tracks[0].items.push(ti);
        for pretty in [true, false] {
            let bytes = encode(&p, pretty);
            let text = String::from_utf8(bytes.clone()).unwrap();
            assert!(text.replace([' ', '\n'], "").contains(r#"{"Vec2":{"x":null,"y":null}}"#), "the file holds NaN points as null");
            let l = decode(&bytes).unwrap_or_else(|e| panic!("a file with `null` points is refused: {e}"));
            let motion = l.project.sequence(seq).unwrap().video_tracks[0].items[0].effect("motion").unwrap().clone();
            let anchor = motion.params["anchor"].value.as_vec2().unwrap();
            assert!(anchor.x.is_nan() && anchor.y.is_nan(), "still auto");
            assert_eq!(motion.params["scale"].value.as_f64(), Some(100.0));
            assert_eq!(encode(&l.project, pretty), bytes, "and the file is written back the same");
            // a `null` where no "auto" exists is still a damaged file
            let broken = text.replacen("3840", "null", 1);
            assert!(matches!(decode(broken.as_bytes()), Err(FormatError::Corrupt(_))));
        }
    }

    #[test]
    fn envelope_has_explicit_schema_version() {
        let v: Value = serde_json::from_slice(&encode(&Project::new("x"), true)).unwrap();
        assert_eq!(v["schema_version"], SCHEMA_VERSION);
        assert_eq!(v["format"], FORMAT_ID);
        assert!(v["project"]["items"].is_object());
        assert!(v["project"].get("version").is_none());
    }

    /// A file of any other format version is refused, never upgraded or half-read.
    #[test]
    fn refuses_every_other_version() {
        for version in [0, 2, 13, 99] {
            let mut v: Value = serde_json::from_slice(&encode(&Project::new("x"), false)).unwrap();
            v["schema_version"] = Value::from(version);
            let e = decode(&serde_json::to_vec(&v).unwrap()).unwrap_err();
            assert!(matches!(e, FormatError::Unsupported { found, supported: 1 } if found == version), "{e}");
            assert!(e.to_string().contains("reads version 1 only"), "{e}");
        }
    }

    /// A bare project without the envelope is not a project file.
    #[test]
    fn refuses_a_bare_project() {
        let v: Value = serde_json::from_slice(&encode(&Project::new("x"), false)).unwrap();
        assert!(matches!(decode(&serde_json::to_vec(&v["project"]).unwrap()), Err(FormatError::NotAProject(_))));
    }

    /// The envelope holds its listed keys only: a file with another top-level key (a writer's
    /// name, a person's view) is refused as damaged, not read with the key dropped.
    #[test]
    fn refuses_an_unlisted_envelope_key() {
        let v: Value = serde_json::from_slice(&encode(&Project::new("x"), false)).unwrap();
        for (key, value) in [("generator", Value::from("Kition Film 0.1.0")), ("view", serde_json::json!({"open_sequences": []})), ("extra", Value::Null)] {
            let mut with = v.clone();
            with[key] = value;
            let e = decode(&serde_json::to_vec(&with).unwrap()).unwrap_err();
            assert!(matches!(e, FormatError::Corrupt(_)), "{key}: {e}");
            assert!(e.to_string().contains(key), "{key}: {e}");
        }
        assert!(decode(&serde_json::to_vec(&v).unwrap()).is_ok(), "the listed keys alone read");
    }

    #[test]
    fn rejects_foreign_and_damaged() {
        assert!(matches!(decode(br#"{"hello": 1}"#), Err(FormatError::NotAProject(_))));
        assert!(matches!(decode(br#"{"format":"other","schema_version":1}"#), Err(FormatError::NotAProject(_))));
        let b = encode(&Project::new("x"), false);
        assert!(matches!(decode(&b[..b.len() / 2]), Err(FormatError::Corrupt(_))));
    }
}
