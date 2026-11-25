//! Read-only sound data for the audio panels: the mixer strips' peak levels per meter window of
//! each chunk the page mixed ([`FilmDocument::levels_at`], upstream `panels/mixer.rs`
//! `poll_meters`), a
//! BS.1770 loudness meter the page feeds with what it plays ([`FilmDocument::loudness_feed`],
//! upstream `panels/meters.rs` `feed_loudness`), and an audio effect's frequency response and
//! dynamics transfer curves ([`FilmDocument::fx_response`], upstream `audio_fx_editor.rs`).
//!
//! None of them mixes anything: the levels are the ones the mix itself posts while
//! [`FilmDocument::audio`] (or a preview's [`FilmDocument::preview_audio`]) mixes a chunk, kept
//! with the chunk, so reading them costs nothing on the playback path.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};

use kition_film_audio_dsp::channels::Layout;
use kition_film_audio_dsp::{AudioEffect, LoudnessMeter};
use kition_film_engine::Session;
use kition_film_engine::project::mixer::MASTER_STRIP;
use kition_film_engine::project::{ClipId, ParamValue, Sequence, TrackId};
use kition_film_engine::render::mixer::{meter_window, width_of};
use kition_film_engine::time::Tick;
use serde_json::{Map, Value, json};

use crate::FilmDocument;

/// Frequency responses span upstream's plot, 20 Hz to 20 kHz, log-spaced.
const F_MIN: f64 = 20.0;
const F_MAX: f64 = 20_000.0;

/// The most response points one [`FilmDocument::fx_response`] answers.
pub const MAX_RESPONSE_POINTS: u32 = 2_048;

/// Upstream evaluates the effect editors' curves at 48 kHz.
const FX_RATE: u32 = 48_000;

/// Transfer curves run from −60 dB to 0 dB input in 0.5 dB steps (upstream's 121 points).
const TRANSFER_POINTS: usize = 121;

/// The most bands a transfer curve is asked for (the multiband compressor has four).
const MAX_TRANSFER_BANDS: usize = 8;

/// How many mixed chunks' levels are kept.
pub const LEVEL_CHUNKS: usize = 64;

/// Loudness at or below this reads as no value (upstream `lufs_text`).
const LOUDNESS_FLOOR: f64 = -70.0;

/// The longest stretch one [`FilmDocument::loudness_feed`] call takes, in frames (10 s at 48 kHz).
pub const MAX_LOUDNESS_FRAMES: usize = 480_000;

/// A peak as dBFS, as upstream's meters convert it.
fn dbfs(peak: f32) -> f64 {
    (20.0 * f64::from(peak.max(1e-6)).log10() * 100.0).round() / 100.0
}

/// The loudness meter the page feeds, with the rate it was fed at and where the last chunk
/// ended (in samples at that rate).
pub(crate) struct Loudness {
    rate: u32,
    end: i64,
    meter: LoudnessMeter,
}

/// The strips' levels of one mixed chunk: per strip (its label and width) the peaks per meter
/// window, for the session (`owner`, its mixer's id), sequence, and revision that mixed it.
pub(crate) struct ChunkLevels {
    owner: u64,
    sequence: u64,
    revision: u64,
    start: i64,
    frames: usize,
    rate: u32,
    strips: Vec<(String, usize, Vec<(i64, Vec<f32>)>)>,
}

/// The last [`LEVEL_CHUNKS`] chunks' levels, newest last.
pub(crate) type LevelRing = Mutex<VecDeque<ChunkLevels>>;

/// Keeps the levels `session`'s mix posted for the chunk of `frames` samples from sample `start`
/// it just mixed. Every strip of the sequence gets every window of the chunk; a strip the mix
/// skipped (no sound, or played from a rendered audio preview) reads silence.
pub(crate) fn record_levels(session: &Session, ring: &LevelRing, start: i64, frames: usize) {
    let mut posted = session.previews.live.take_windows();
    let (Some(id), Some(sequence)) = (session.state.active_sequence, session.active_sequence()) else { return };
    let rate = sequence.settings.sample_rate.max(1);
    let window = meter_window(rate);
    let grid: Vec<i64> = (start.div_euclid(window)..=(start + frames.max(1) as i64 - 1).div_euclid(window)).map(|k| k * window).collect();
    let strips = sequence
        .strip_ids()
        .into_iter()
        .map(|strip| {
            let width = if strip == MASTER_STRIP {
                width_of(sequence.settings.audio_master)
            } else {
                sequence.strip(strip).map_or(2, |track| width_of(track.channels))
            };
            let mut windows = posted.remove(&strip).unwrap_or_default();
            let width = windows.values().map(Vec::len).max().unwrap_or(width);
            let peaks = grid.iter().map(|at| (*at, windows.remove(at).unwrap_or_else(|| vec![0.0; width]))).collect();
            (kition_film_engine::mixer::strip_label(sequence, strip), width, peaks)
        })
        .collect();
    let mut ring = ring.lock().unwrap_or_else(PoisonError::into_inner);
    ring.retain(|chunk| !(chunk.owner == session.previews.live.id() && chunk.sequence == id.0 && chunk.start == start));
    if ring.len() >= LEVEL_CHUNKS {
        ring.pop_front();
    }
    ring.push_back(ChunkLevels { owner: session.previews.live.id(), sequence: id.0, revision: session.revision, start, frames, rate, strips });
}

/// The levels of `session`'s newest chunk mixed from `start_seconds` (see
/// [`FilmDocument::levels_at`]), or null.
pub(crate) fn session_levels_at(session: &Session, ring: &LevelRing, start_seconds: f64) -> Result<Value, String> {
    let id = session.state.active_sequence.ok_or("no sequence is open")?;
    let rate = crate::session_audio_rate(session);
    let start = crate::audio_start(start_seconds, rate);
    let ring = ring.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(chunk) = ring.iter().rev().find(|chunk| chunk.owner == session.previews.live.id() && chunk.sequence == id.0 && chunk.start == start) else {
        return Ok(Value::Null);
    };
    let strips: Vec<Value> = chunk
        .strips
        .iter()
        .map(|(strip, width, windows)| {
            json!({
                "strip": strip,
                "channels": Layout::from_channels(*width).names(),
                "windows": windows.iter().map(|(at, peaks)| json!({
                    "start": at,
                    "peaks": peaks,
                    "db": peaks.iter().map(|peak| dbfs(*peak)).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({
        "sequence": chunk.sequence,
        "revision": chunk.revision,
        "start": chunk.start,
        "frames": chunk.frames,
        "rate": chunk.rate,
        "window": meter_window(chunk.rate),
        "strips": strips,
    }))
}

/// Upstream's `Ed::preview`: `effect` with the editor's uncommitted values in `drafts`.
fn with_drafts(effect: &mut kition_film_engine::project::EffectInstance, drafts: &Map<String, Value>) -> Result<(), String> {
    for (key, value) in drafts {
        let number = match value {
            Value::Bool(on) => f64::from(u8::from(*on)),
            other => other.as_f64().filter(|v| v.is_finite()).ok_or_else(|| format!("draft {key} is not a number: {other}"))?,
        };
        let default = effect.def().and_then(|def| def.param(key)).map(|param| param.default.clone());
        let param = match (effect.params.get_mut(key), default) {
            (Some(param), _) => param,
            (None, Some(default)) => effect.params.entry(key.clone()).or_insert_with(|| kition_film_engine::project::Param::new(default)),
            (None, None) => return Err(format!("{} has no parameter {key}", effect.effect)),
        };
        param.keyframes.clear();
        param.value = match param.value {
            ParamValue::Bool(_) => ParamValue::Bool(number >= 0.5),
            ParamValue::Choice(_) => ParamValue::Choice(number.max(0.0) as u32),
            _ => ParamValue::Float(number),
        };
    }
    Ok(())
}

/// What an effect editor edits (upstream `FxTarget`): `{clip, index}` (a clip effect) or
/// `{strip, slot}` (a mixer insert; `strip` is `A1`, `S1`, `Mix`, or a track id), with the time
/// its curves are evaluated at: the clip's media time under the playhead, or the playhead.
fn target_effect(session: &Session, sequence: &Sequence, target: &Value) -> Result<(kition_film_engine::project::EffectInstance, Tick), String> {
    let playhead = session.playhead();
    if let Some(clip) = target.get("clip") {
        let clip = clip.as_f64().ok_or("clip is not an id").and_then(|id| crate::panels::js_id(id, "clip").map_err(|_| "clip is not an id"))?;
        let index = target.get("index").and_then(Value::as_u64).ok_or("need the effect's index")? as usize;
        let (_, item) = sequence.find_item(ClipId(clip)).ok_or_else(|| format!("no clip {clip}"))?;
        let effect = item.effects.get(index).ok_or_else(|| format!("clip {clip} has no effect {index}"))?.clone();
        let time = item.source_time_at(playhead.clamp(item.start, (item.end() - Tick(1)).max(item.start)));
        return Ok((effect, time));
    }
    if let Some(strip) = target.get("strip") {
        let id: TrackId = kition_film_engine::mixer::strip_ref(sequence, strip).ok_or_else(|| format!("no strip {strip}"))?;
        let slot = target.get("slot").and_then(Value::as_u64).ok_or("need the insert's slot")? as usize;
        let track = sequence.strip(id).ok_or_else(|| format!("no strip {strip}"))?;
        let effect = track.effects.get(slot).ok_or_else(|| format!("strip {strip} has no insert {slot}"))?.clone();
        return Ok((effect, playhead));
    }
    Err("the target is {clip, index} or {strip, slot}".to_owned())
}

impl FilmDocument {
    /// The mixer strips' levels in the chunk [`Self::audio`] mixed from `start_seconds`, as
    /// upstream's meters read them while it plays (`LiveMix`, per 1/30 s meter window on the
    /// absolute sample grid): the page keys a chunk's levels by the time it asked for, and reads
    /// them when it is heard. Reading never drains, so any number of panels read the same
    /// chunk. `null` when that chunk is not among the last [`LEVEL_CHUNKS`] mixed. Otherwise
    /// `{sequence, revision, start, frames, rate, window, strips: [{strip, channels, windows:
    /// [{start, peaks, db}]}]}`: the chunk's sequence and the revision that mixed it (the page's
    /// stale guard), its first sample and length, the sample rate and window length, and every
    /// strip in mixer order (`A1`…, `S1`…, `Mix`) with its channel names (2, or L, R, C, LFE, Ls,
    /// Rs for 5.1) and, per window (`start` is the window's first sample; a window cut by the
    /// chunk's edge holds the chunk's part), one post-fader peak per channel, linear and in dBFS
    /// (−120 for silence). A strip the mix skipped, or a stretch played from a rendered audio
    /// preview, reads silence, as upstream's. An error without an open sequence.
    pub fn levels_at(&self, start_seconds: f64) -> Result<Value, String> {
        session_levels_at(&self.session, &self.services.levels, start_seconds)
    }

    /// [`Self::levels_at`] of the open preview's copy, whose own mix [`Self::preview_audio`]
    /// plays (a dialog heard before OK). A new preview starts with none.
    pub fn preview_levels_at(&self, start_seconds: f64) -> Result<Value, String> {
        self.with_preview(|scratch| session_levels_at(scratch, &self.services.levels, start_seconds))
    }

    /// Feeds the loudness meter with `samples` the page played: interleaved stereo at `rate`
    /// (8 to 384 kHz), from `start_seconds` of the sequence, at most [`MAX_LOUDNESS_FRAMES`]
    /// frames a call. Feed what is heard, as it is heard. The meter starts again, as upstream's
    /// `feed_loudness` does, when a chunk starts before the last one's end (a seek back) or more
    /// than 1 s after it (a jump), and when the rate changes. An odd number of samples, a sample
    /// or time that is not a finite number, or a rate out of range is an error.
    pub fn loudness_feed(&self, samples: &[f32], rate: u32, start_seconds: f64) -> Result<(), String> {
        if !samples.len().is_multiple_of(2) {
            return Err("samples are interleaved stereo: an even number".to_owned());
        }
        if samples.len() / 2 > MAX_LOUDNESS_FRAMES {
            return Err(format!("at most {MAX_LOUDNESS_FRAMES} frames a call"));
        }
        if samples.iter().any(|sample| !sample.is_finite()) {
            return Err("a sample is not a number".to_owned());
        }
        if !(8_000..=384_000).contains(&rate) {
            return Err(format!("rate {rate} is not a sample rate"));
        }
        if !start_seconds.is_finite() {
            return Err("the start is not a number".to_owned());
        }
        let start = crate::audio_start(start_seconds, rate);
        let end = start + (samples.len() / 2) as i64;
        let mut slot = self.services.loudness.lock().unwrap_or_else(PoisonError::into_inner);
        let fresh = match slot.as_ref() {
            Some(fed) => fed.rate != rate || start < fed.end || start - fed.end > i64::from(rate),
            None => true,
        };
        if fresh {
            *slot = Some(Loudness { rate, end: start, meter: LoudnessMeter::new(f64::from(rate), 2) });
        }
        if let Some(fed) = slot.as_mut() {
            fed.meter.process_interleaved(samples);
            fed.end = end;
        }
        Ok(())
    }

    /// The loudness of what was fed since the last reset, as upstream's Audio Meters show it:
    /// `{momentary, shortTerm, integrated}` in LUFS and `truePeak` in dBTP, each `null` until it
    /// has a value.
    pub fn loudness_read(&self) -> Value {
        let slot = self.services.loudness.lock().unwrap_or_else(PoisonError::into_inner);
        // Upstream shows "—" at -70 or below: the gate's floor, and what an empty window reads.
        let finite = |v: f64| if v.is_finite() && v > LOUDNESS_FLOOR { json!((v * 100.0).round() / 100.0) } else { Value::Null };
        match slot.as_ref() {
            Some(Loudness { meter, .. }) => json!({
                "momentary": finite(meter.momentary()),
                "shortTerm": finite(meter.short_term()),
                "integrated": finite(meter.integrated()),
                "truePeak": finite(meter.true_peak_dbtp()),
            }),
            None => json!({ "momentary": null, "shortTerm": null, "integrated": null, "truePeak": null }),
        }
    }

    /// Clears the loudness meter (upstream resets it on a seek back or a jump over 1 s).
    pub fn loudness_reset(&self) {
        *self.services.loudness.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// An audio effect's curves as upstream's effect editors draw them (`audio_fx_editor.rs`),
    /// from the effect's own DSP (`render::audio_fx::configured` at 48 kHz) at the playhead:
    /// `target` is `{clip, index}` or `{strip, slot}`, and `drafts` the editor's uncommitted
    /// values by parameter id. The answer is `{effect, frequencies, responseDb, transferInputDb,
    /// transferDb}`: the response at `points` (2 to [`MAX_RESPONSE_POINTS`]) frequencies
    /// log-spaced from 20 Hz to 20 kHz (`responseDb` is `null` for an effect without one), and
    /// the output level per band at inputs from −60 to 0 dB in 0.5 dB steps (`transferDb` is
    /// empty for an effect without dynamics; the dynamics rack has one band, the multiband
    /// compressor four). An unknown target, an effect without DSP, or a draft for a parameter the
    /// effect lacks is an error.
    pub fn fx_response(&self, target: &Value, points: u32, drafts: &Value) -> Result<Value, String> {
        let sequence = self.session.active_sequence().ok_or("no sequence is open")?;
        let (mut effect, time) = target_effect(&self.session, sequence, target)?;
        match drafts {
            Value::Null => {}
            Value::Object(drafts) => with_drafts(&mut effect, drafts)?,
            other => return Err(format!("drafts are not an object: {other}")),
        }
        let dsp: Box<dyn AudioEffect> = kition_film_engine::render::audio_fx::configured(&effect, time, FX_RATE)
            .ok_or_else(|| format!("{} is not an audio effect with DSP", effect.effect))?;
        let points = points.clamp(2, MAX_RESPONSE_POINTS) as usize;
        let frequencies: Vec<f64> = (0..points).map(|i| F_MIN * (F_MAX / F_MIN).powf(i as f64 / (points - 1) as f64)).collect();
        let response: Vec<Option<f64>> = frequencies.iter().map(|f| dsp.response_db(*f)).collect();
        let response = if response.iter().all(Option::is_none) {
            Value::Null
        } else {
            json!(response.iter().map(|db| db.map(|db| (db * 1000.0).round() / 1000.0)).collect::<Vec<_>>())
        };
        let inputs: Vec<f32> = (0..TRANSFER_POINTS).map(|i| -60.0 + 0.5 * i as f32).collect();
        let transfer: Vec<Vec<Option<f32>>> = (0..MAX_TRANSFER_BANDS)
            .map(|band| inputs.iter().map(|x| dsp.transfer_db(band, *x)).collect::<Vec<_>>())
            .take_while(|curve| curve.iter().any(Option::is_some))
            .collect();
        Ok(json!({
            "effect": effect.effect,
            "frequencies": frequencies.iter().map(|f| (f * 100.0).round() / 100.0).collect::<Vec<_>>(),
            "responseDb": response,
            "transferInputDb": inputs,
            "transferDb": transfer,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{HOST_ROOT, tone_wav};
    use kition_kit::KitDocument;

    /// What a read must leave alone: the replica version, the history, the inspected state, and
    /// the session's revision.
    fn state(doc: &mut FilmDocument) -> (Vec<u8>, Value, Value, u64) {
        let history = doc.session.execute("history.list", json!({})).unwrap();
        (doc.version().unwrap(), history, doc.inspect().unwrap(), doc.session.revision)
    }

    /// Runs `body` with `tone.wav` (one second of 440 Hz, about −8.7 dBFS) placed on A1 of a new
    /// 64 × 36 project.
    fn with_tone(body: impl FnOnce(&mut FilmDocument)) {
        with_tone_at(0.0, body);
    }

    /// [`with_tone`] with the tone placed at `seconds` on A1.
    fn with_tone_at(seconds: f64, body: impl FnOnce(&mut FilmDocument)) {
        let _lock = HOST_ROOT.lock().unwrap_or_else(PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("kition-film-sound-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tone.wav"), tone_wav()).unwrap();
        kition_kit::host::set_root(Some(dir.clone()));
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let imported = doc.execute("file.import", json!({ "paths": ["tone.wav"] })).unwrap();
        doc.execute("timeline.place", json!({ "item": imported["items"][0], "track": "A1", "seconds": seconds })).unwrap();
        body(&mut doc);
        kition_kit::host::set_root(None);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn strip<'a>(levels: &'a Value, name: &str) -> &'a Value {
        levels["strips"].as_array().unwrap().iter().find(|s| s["strip"] == name).unwrap_or_else(|| panic!("no {name} in {levels}"))
    }

    /// A strip's loudest window, per channel, in dBFS.
    fn db(levels: &Value, name: &str) -> Vec<f64> {
        let windows = strip(levels, name)["windows"].as_array().unwrap();
        let width = strip(levels, name)["channels"].as_array().unwrap().len();
        (0..width).map(|c| windows.iter().map(|w| w["db"][c].as_f64().unwrap()).fold(f64::NEG_INFINITY, f64::max)).collect()
    }

    #[test]
    fn levels_are_the_windows_of_the_chunk_mixed_at_that_time() {
        with_tone(|doc| {
            let before = state(doc);
            assert_eq!(doc.levels_at(0.1).unwrap(), Value::Null, "nothing mixed yet");
            let chunk = doc.audio(0.1, 4_800).unwrap();
            let levels = doc.levels_at(0.1).unwrap();
            assert_eq!(
                (levels["start"].as_i64(), levels["frames"].as_u64(), levels["rate"].as_u64(), levels["window"].as_u64()),
                (Some(4_800), Some(4_800), Some(48_000), Some(1_600))
            );
            assert_eq!(levels["sequence"].as_u64(), doc.session.state.active_sequence.map(|id| id.0));
            assert_eq!(levels["revision"].as_u64(), Some(doc.session.revision));
            let names: Vec<&str> = levels["strips"].as_array().unwrap().iter().map(|s| s["strip"].as_str().unwrap()).collect();
            assert_eq!((names.first(), names.last()), (Some(&"A1"), Some(&"Mix")));
            for name in ["A1", "Mix"] {
                assert_eq!(strip(&levels, name)["channels"], json!(["L", "R"]));
                let windows = strip(&levels, name)["windows"].as_array().unwrap();
                let starts: Vec<i64> = windows.iter().map(|w| w["start"].as_i64().unwrap()).collect();
                assert_eq!(starts, [4_800, 6_400, 8_000], "{name}: a window per 1/30 s on the sample grid");
                assert!(db(&levels, name).iter().all(|v| *v > -12.0), "{name} plays the tone");
            }
            // Each Mix window is the loudest sample of that window of the chunk the page got.
            for (k, window) in strip(&levels, "Mix")["windows"].as_array().unwrap().iter().enumerate() {
                for channel in 0..2 {
                    let loudest = chunk.chunks(2).skip(k * 1_600).take(1_600).fold(0f32, |a, frame| a.max(frame[channel].abs()));
                    assert!((window["peaks"][channel].as_f64().unwrap() - f64::from(loudest)).abs() < 1e-6);
                }
            }
            // Reading never drains: a second reader gets the same answer.
            assert_eq!(doc.levels_at(0.1).unwrap(), levels);
            // The windows follow the sound inside a chunk: the tone ends at 1 s.
            doc.audio(0.9, 9_600).unwrap();
            let across = doc.levels_at(0.9).unwrap();
            for window in strip(&across, "A1")["windows"].as_array().unwrap() {
                let loud = window["db"][0].as_f64().unwrap() > -12.0;
                assert_eq!(loud, window["start"].as_i64().unwrap() < 48_000, "{window}");
            }
            // A chunk off the grid starts with its part of a window.
            doc.audio(0.31, 4_800).unwrap();
            assert_eq!(strip(&doc.levels_at(0.31).unwrap(), "Mix")["windows"][0]["start"], 14_400);
            assert_eq!(doc.levels_at(0.1).unwrap(), levels, "earlier chunks stay");
            assert_eq!(state(doc), before, "levels change nothing");
            // After an edit the old chunk keeps its revision (the page's stale guard), and a new
            // mix at the same time is the newest.
            doc.execute("mixer.setStrip", json!({ "strip": "A1", "muted": true })).unwrap();
            assert_eq!(doc.levels_at(0.1).unwrap()["revision"], levels["revision"]);
            doc.audio(0.1, 4_800).unwrap();
            let muted = doc.levels_at(0.1).unwrap();
            assert_eq!(muted["revision"].as_u64(), Some(doc.session.revision));
            assert!(db(&muted, "A1").iter().all(|v| *v <= -119.0));
        });
    }

    #[test]
    fn a_muted_strip_reads_silence_and_a_5_1_mix_has_six_named_channels() {
        with_tone(|doc| {
            doc.execute("mixer.setStrip", json!({ "strip": "A1", "muted": true })).unwrap();
            doc.audio(0.1, 4_800).unwrap();
            let levels = doc.levels_at(0.1).unwrap();
            assert!(db(&levels, "A1").iter().all(|v| *v <= -119.0), "{levels}");
            assert!(db(&levels, "Mix").iter().all(|v| *v <= -119.0));
            doc.execute("mixer.setStrip", json!({ "strip": "A1", "muted": false })).unwrap();
            doc.execute("sequence.settings", json!({ "mix": "5.1" })).unwrap();
            doc.audio(0.1, 4_800).unwrap();
            let levels = doc.levels_at(0.1).unwrap();
            assert_eq!(strip(&levels, "Mix")["channels"], json!(["L", "R", "C", "LFE", "Ls", "Rs"]));
            let mix = db(&levels, "Mix");
            assert_eq!(mix.len(), 6);
            // A stereo track pans to L and R of a 5.1 Mix, in L, R, C, LFE, Ls, Rs order.
            assert!(mix[0] > -12.0 && mix[1] > -12.0, "the tone is on L and R: {mix:?}");
            assert!(mix[2..].iter().all(|v| *v <= -119.0), "C, LFE, Ls, and Rs are silent: {mix:?}");
            assert!(db(&levels, "A1").iter().all(|v| *v > -12.0));
        });
    }

    #[test]
    fn a_strip_the_mix_skipped_reads_silence_at_its_width() {
        with_tone(|doc| {
            doc.execute("sequence.addTracks", json!({ "video": 0, "audio": 1 })).unwrap();
            doc.audio(0.1, 4_800).unwrap();
            let levels = doc.levels_at(0.1).unwrap();
            let a2 = &strip(&levels, "A2")["windows"];
            assert_eq!(a2.as_array().unwrap().len(), 3);
            assert_eq!(a2[0]["peaks"], json!([0.0, 0.0]));
        });
    }

    #[test]
    fn a_previews_levels_are_its_own_mix() {
        with_tone(|doc| {
            assert!(doc.preview_levels_at(0.1).unwrap_err().contains("no preview"));
            let clip = doc.inspect().unwrap()["sequence"]["audio"][0]["items"][0]["clip"].as_u64().unwrap();
            doc.preview_begin("clip.audioGain", json!({ "clips": [clip], "mode": "set", "db": -20.0 })).unwrap();
            let before = state(doc);
            doc.preview_audio(0.1, 4_800).unwrap();
            let quiet = doc.preview_levels_at(0.1).unwrap();
            assert_eq!(doc.levels_at(0.1).unwrap(), Value::Null, "the document mixed nothing");
            doc.audio(0.1, 4_800).unwrap();
            let loud = doc.levels_at(0.1).unwrap();
            let (quiet, loud) = (db(&quiet, "A1")[0], db(&loud, "A1")[0]);
            assert!((loud - quiet - 20.0).abs() < 0.5, "the preview is 20 dB down: {loud} vs {quiet}");
            assert_eq!(state(doc), before);
            doc.preview_end();
            // A new preview has none of the last one's levels.
            doc.preview_begin("clip.audioGain", json!({ "clips": [clip], "mode": "set", "db": -10.0 })).unwrap();
            assert_eq!(doc.preview_levels_at(0.1).unwrap(), Value::Null);
            doc.preview_end();
        });
    }

    #[test]
    fn levels_keep_the_last_chunks() {
        with_tone(|doc| {
            for k in 0..(LEVEL_CHUNKS + 2) {
                doc.audio(k as f64 * 0.01, 480).unwrap();
            }
            assert_eq!(doc.levels_at(0.0).unwrap(), Value::Null, "the oldest chunks are gone");
            assert_ne!(doc.levels_at((LEVEL_CHUNKS + 1) as f64 * 0.01).unwrap(), Value::Null);
        });
    }

    /// A 1 kHz sine at `dbfs` in both channels, `seconds` long, at 48 kHz, interleaved.
    fn sine(dbfs: f64, seconds: f64) -> Vec<f32> {
        let amplitude = 10f64.powf(dbfs / 20.0);
        (0..(seconds * 48_000.0) as usize)
            .flat_map(|i| {
                let v = (amplitude * (std::f64::consts::TAU * 1_000.0 * i as f64 / 48_000.0).sin()) as f32;
                [v, v]
            })
            .collect()
    }

    #[test]
    fn loudness_reads_ebu_tech_3341s_reference_signal() {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let before = state(&mut doc);
        assert_eq!(doc.loudness_read(), json!({ "momentary": null, "shortTerm": null, "integrated": null, "truePeak": null }));
        let signal = sine(-23.0, 4.0);
        // Fed in playback-sized chunks, as the page plays them.
        for (k, chunk) in signal.chunks(9_600).enumerate() {
            doc.loudness_feed(chunk, 48_000, k as f64 * 0.1).unwrap();
        }
        let read = doc.loudness_read();
        let integrated = read["integrated"].as_f64().unwrap();
        assert!((integrated + 23.0).abs() <= 0.5, "{read}");
        assert!((read["momentary"].as_f64().unwrap() + 23.0).abs() <= 0.5);
        assert!((read["shortTerm"].as_f64().unwrap() + 23.0).abs() <= 0.5);
        assert!((read["truePeak"].as_f64().unwrap() + 23.0).abs() <= 0.5);
        doc.loudness_reset();
        assert_eq!(doc.loudness_read()["integrated"], Value::Null);
        assert!(doc.loudness_feed(&[0.0], 48_000, 0.0).is_err(), "odd");
        assert!(doc.loudness_feed(&[f32::NAN, 0.0], 48_000, 0.0).is_err());
        assert!(doc.loudness_feed(&vec![0.0; (MAX_LOUDNESS_FRAMES + 1) * 2], 48_000, 0.0).is_err());
        assert!(doc.loudness_feed(&[0.0, 0.0], 0, 0.0).is_err(), "no rate");
        assert!(doc.loudness_feed(&[0.0, 0.0], 48_000, f64::NAN).is_err(), "no time");
        assert_eq!(state(&mut doc), before, "the meter changes nothing");
    }

    #[test]
    fn a_parametric_eqs_response_is_its_dsps() {
        with_tone(|doc| {
            let clip = doc.inspect().unwrap()["sequence"]["audio"][0]["items"][0]["clip"].as_u64().unwrap();
            doc.execute("effect.apply", json!({ "clips": [clip], "effect": "parametric_eq" })).unwrap();
            let effects = doc.clip_effects(clip).unwrap();
            let index = effects["effects"].as_array().unwrap().iter().position(|e| e["id"] == "parametric_eq").unwrap();
            doc.execute("effect.setParam", json!({ "clip": clip, "effect": index, "param": "mid_gain", "value": 6.0 })).unwrap();
            let before = state(doc);
            let target = json!({ "clip": clip, "index": index });
            let curve = doc.fx_response(&target, 241, &Value::Null).unwrap();
            assert_eq!(state(doc), before, "a read changes nothing");
            let frequencies: Vec<f64> = curve["frequencies"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            assert_eq!((frequencies.len(), frequencies[0], frequencies[240]), (241, 20.0, 20_000.0));
            let at = |curve: &Value, hz: f64| {
                let k = frequencies.iter().enumerate().min_by(|a, b| (a.1 - hz).abs().total_cmp(&(b.1 - hz).abs())).unwrap().0;
                curve["responseDb"][k].as_f64().unwrap()
            };
            assert!((at(&curve, 1_000.0) - 6.0).abs() < 0.3, "about +6 dB at 1 kHz: {}", at(&curve, 1_000.0));
            assert!(at(&curve, 50.0).abs() < 0.5 && at(&curve, 15_000.0).abs() < 0.5, "flat far from it");
            // The same as the DSP the mix runs.
            let sequence = doc.session.active_sequence().unwrap();
            let (effect, time) = target_effect(&doc.session, sequence, &target).unwrap();
            let dsp = kition_film_engine::render::audio_fx::configured(&effect, time, 48_000).unwrap();
            assert_eq!(curve["responseDb"][120].as_f64().unwrap(), (dsp.response_db(frequencies[120]).unwrap() * 1000.0).round() / 1000.0);
            assert_eq!(curve["transferDb"], json!([]), "an EQ has no transfer curve");
            // A draft is drawn without being committed.
            let draft = doc.fx_response(&target, 241, &json!({ "mid_gain": -12.0 })).unwrap();
            assert!((at(&draft, 1_000.0) + 12.0).abs() < 0.3);
            assert_eq!(state(doc), before);
            assert!(doc.fx_response(&target, 241, &json!({ "nope": 1 })).unwrap_err().contains("nope"));
            assert!(doc.fx_response(&json!({ "clip": clip, "index": 99 }), 16, &Value::Null).is_err());
            assert!(doc.fx_response(&json!({ "strip": "A9", "slot": 0 }), 16, &Value::Null).is_err());
            assert!(doc.fx_response(&json!({}), 16, &Value::Null).is_err());
            assert_eq!(doc.fx_response(&target, 100_000, &Value::Null).unwrap()["frequencies"].as_array().unwrap().len(), MAX_RESPONSE_POINTS as usize);
        });
    }

    #[test]
    fn dynamics_inserts_have_transfer_curves_per_band() {
        with_tone(|doc| {
            doc.execute("mixer.addInsert", json!({ "strip": "A1", "effect": "multiband_compressor" })).unwrap();
            doc.execute("mixer.addInsert", json!({ "strip": "Mix", "effect": "dynamics_rack" })).unwrap();
            let before = state(doc);
            let multiband = doc.fx_response(&json!({ "strip": "A1", "slot": 0 }), 32, &Value::Null).unwrap();
            assert_eq!(multiband["effect"], "multiband_compressor");
            assert_eq!(multiband["transferInputDb"].as_array().unwrap().len(), 121);
            assert_eq!(multiband["transferDb"].as_array().unwrap().len(), 4, "four bands");
            let rack = doc.fx_response(&json!({ "strip": "Mix", "slot": 0 }), 32, &Value::Null).unwrap();
            let curve = rack["transferDb"][0].as_array().unwrap();
            assert_eq!(curve.len(), 121);
            // The DSP's own transfer curve.
            let sequence = doc.session.active_sequence().unwrap();
            let (effect, time) = target_effect(&doc.session, sequence, &json!({ "strip": "Mix", "slot": 0 })).unwrap();
            let dsp = kition_film_engine::render::audio_fx::configured(&effect, time, 48_000).unwrap();
            assert_eq!(curve[60].as_f64().map(|v| v as f32), dsp.transfer_db(0, -30.0));
            assert_eq!(state(doc), before);
        });
    }

    #[test]
    fn sound_reads_need_a_sequence() {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        doc.session.state.active_sequence = None;
        assert_eq!(doc.levels_at(0.0).unwrap_err(), "no sequence is open");
        assert_eq!(doc.fx_response(&json!({ "strip": "Mix", "slot": 0 }), 16, &Value::Null).unwrap_err(), "no sequence is open");
    }

    #[test]
    fn loudness_gates_silence_and_reads_the_true_peak() {
        let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        // The reference tone, then 4 s of silence: the gates leave the silence out of Integrated,
        // and Momentary and Short-term have no value once only silence is in their windows.
        let mut signal = sine(-23.0, 4.0);
        signal.extend(std::iter::repeat_n(0.0, 4 * 48_000 * 2));
        doc.loudness_feed(&signal, 48_000, 0.0).unwrap();
        let read = doc.loudness_read();
        let integrated = read["integrated"].as_f64().unwrap();
        assert!((integrated + 23.16).abs() <= 0.1, "{read}");
        assert_eq!((&read["momentary"], &read["shortTerm"]), (&Value::Null, &Value::Null), "silence has no loudness: {read}");
        // A sine at a quarter of the sample rate, 45 degrees off its peaks: every sample is at
        // -9.03 dBFS, the waveform between them at -6.02, which the true peak finds.
        doc.loudness_reset();
        let quarter: Vec<f32> = (0..48_000)
            .flat_map(|i| {
                let v = (0.5 * (std::f64::consts::FRAC_PI_2 * f64::from(i) + std::f64::consts::FRAC_PI_4).sin()) as f32;
                [v, v]
            })
            .collect();
        let sample_peak = 20.0 * f64::from(quarter.iter().fold(0f32, |a, x| a.max(x.abs()))).log10();
        assert!((sample_peak + 9.03).abs() < 0.01);
        doc.loudness_feed(&quarter, 48_000, 0.0).unwrap();
        let true_peak = doc.loudness_read()["truePeak"].as_f64().unwrap();
        assert!((true_peak + 6.07).abs() <= 0.15, "true peak {true_peak}");
    }

    #[test]
    fn loudness_restarts_on_upstreams_seek_rule() {
        let doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let integrated = || doc.loudness_read()["integrated"].as_f64().unwrap();
        // Played on: 3 s at -23 then 3 s at -33, chunk after chunk, is one programme.
        let feed = |signal: &[f32], from: f64| {
            for (k, chunk) in signal.chunks(9_600).enumerate() {
                doc.loudness_feed(chunk, 48_000, from + k as f64 * 0.1).unwrap();
            }
        };
        feed(&sine(-23.0, 3.0), 0.0);
        feed(&sine(-33.0, 3.0), 3.0);
        let joined = integrated();
        assert!(joined > -27.0 && joined < -24.0, "one programme: {joined}");
        // A seek back (a chunk before the last one's end) starts again.
        feed(&sine(-33.0, 3.0), 1.0);
        assert!((integrated() + 33.0).abs() <= 0.5, "after a seek back: {}", integrated());
        // A gap of up to 1 s is the same programme; a jump of more starts again.
        feed(&sine(-23.0, 3.0), 4.5);
        let joined = integrated();
        assert!(joined > -30.0 && joined < -24.0, "a 0.5 s gap goes on: {joined}");
        feed(&sine(-13.0, 3.0), 9.0);
        assert!((integrated() + 13.0).abs() <= 0.5, "after a jump of 1.5 s: {}", integrated());
        // Another rate starts again too.
        doc.loudness_feed(&sine(-23.0, 1.0), 44_100, 12.0).unwrap();
        assert_ne!(doc.loudness_read()["truePeak"], json!(-13.0));
        assert!((doc.loudness_read()["truePeak"].as_f64().unwrap() + 23.0).abs() < 0.5);
    }

    #[test]
    fn a_keyframed_response_is_read_at_the_clips_media_time_and_drafts_replace_keyframes() {
        // The tone at 1 s: its media time is the timeline's less one second.
        with_tone_at(1.0, |doc| {
            let clip = doc.inspect().unwrap()["sequence"]["audio"][0]["items"][0]["clip"].as_u64().unwrap();
            doc.execute("effect.apply", json!({ "clips": [clip], "effect": "parametric_eq" })).unwrap();
            let effects = doc.clip_effects(clip).unwrap();
            let index = effects["effects"].as_array().unwrap().iter().position(|e| e["id"] == "parametric_eq").unwrap();
            let key = json!({ "clip": clip, "effect": index, "param": "mid_gain" });
            // mid_gain 0 dB at media 0 s and +12 dB at media 0.9 s.
            doc.execute("playhead.set", json!({ "seconds": 1.0 })).unwrap();
            doc.execute("effect.addKeyframe", key.clone()).unwrap();
            doc.execute("playhead.set", json!({ "seconds": 1.9 })).unwrap();
            doc.execute("effect.addKeyframe", key.clone()).unwrap();
            doc.execute("effect.setParam", json!({ "clip": clip, "effect": index, "param": "mid_gain", "value": 12.0 })).unwrap();
            let target = json!({ "clip": clip, "index": index });
            let at_1k = |curve: &Value| {
                let frequencies = curve["frequencies"].as_array().unwrap();
                let k = (0..frequencies.len())
                    .min_by(|a, b| (frequencies[*a].as_f64().unwrap() - 1_000.0).abs().total_cmp(&(frequencies[*b].as_f64().unwrap() - 1_000.0).abs()))
                    .unwrap();
                curve["responseDb"][k].as_f64().unwrap()
            };
            // Halfway, at timeline 1.45 s (media 0.45 s): +6 dB. Timeline time would read +12.
            doc.execute("playhead.set", json!({ "seconds": 1.45 })).unwrap();
            let halfway = at_1k(&doc.fx_response(&target, 241, &Value::Null).unwrap());
            assert!((halfway - 6.0).abs() < 0.4, "media time: {halfway}");
            // A draft replaces the animation: -3 dB wherever the playhead is.
            for seconds in [1.0, 1.45, 1.9] {
                doc.execute("playhead.set", json!({ "seconds": seconds })).unwrap();
                let draft = at_1k(&doc.fx_response(&target, 241, &json!({ "mid_gain": -3.0 })).unwrap());
                assert!((draft + 3.0).abs() < 0.3, "draft at {seconds}: {draft}");
            }
        });
    }

    /// The program's sound from 0.5 s for 0.5 s after mixing [0, 0.5 s) (`warm`), with a long
    /// reverb on A1. `between` runs between the two chunks.
    fn reverb_tail(between: impl FnOnce(&mut FilmDocument, u64)) -> Vec<f32> {
        let mut out = Vec::new();
        with_tone(|doc| {
            doc.execute("mixer.addInsert", json!({ "strip": "A1", "effect": "studio_reverb" })).unwrap();
            let clip = doc.inspect().unwrap()["sequence"]["audio"][0]["items"][0]["clip"].as_u64().unwrap();
            between(doc, clip);
            out = doc.audio(0.5, 24_000).unwrap();
        });
        out
    }

    #[test]
    fn a_previews_mix_never_hands_its_effect_state_to_the_document() {
        // The document alone: its second chunk starts fresh (nothing mixed before it).
        let alone = reverb_tail(|_, _| {});
        // A preview 30 dB quieter mixes [0, 0.5 s) first: the document's chunk must not pick up
        // the preview's reverb state where that chunk ended.
        let after_preview = reverb_tail(|doc, clip| {
            doc.preview_begin("clip.audioGain", json!({ "clips": [clip], "mode": "set", "db": -30.0 })).unwrap();
            doc.preview_audio(0.0, 24_000).unwrap();
        });
        let difference = alone.iter().zip(&after_preview).fold(0f32, |a, (x, y)| a.max((x - y).abs()));
        assert!(difference < 1e-6, "the preview's reverb state reached the document: {difference}");
    }

    #[test]
    fn a_previews_clip_effects_never_hand_their_state_to_the_document() {
        let tail = |preview_first: bool| {
            let mut out = Vec::new();
            with_tone(|doc| {
                let clip = doc.inspect().unwrap()["sequence"]["audio"][0]["items"][0]["clip"].as_u64().unwrap();
                doc.execute("effect.apply", json!({ "clips": [clip], "effect": "studio_reverb" })).unwrap();
                if preview_first {
                    // Clip gain applies after clip effects, so the preview changes what the
                    // reverb hears with the speed instead.
                    doc.preview_begin("clip.speedDuration", json!({ "clips": [clip], "speed": 50.0 })).unwrap();
                    doc.preview_audio(0.0, 24_000).unwrap();
                }
                out = doc.audio(0.5, 24_000).unwrap();
            });
            out
        };
        let (alone, after_preview) = (tail(false), tail(true));
        let difference = alone.iter().zip(&after_preview).fold(0f32, |a, (x, y)| a.max((x - y).abs()));
        assert!(difference < 1e-6, "the preview's clip reverb state reached the document: {difference}");
    }

    #[test]
    fn the_documents_mix_never_hands_its_effect_state_to_a_preview() {
        let preview_tail = |document_first: bool| {
            let mut out = Vec::new();
            with_tone(|doc| {
                doc.execute("mixer.addInsert", json!({ "strip": "A1", "effect": "studio_reverb" })).unwrap();
                let clip = doc.inspect().unwrap()["sequence"]["audio"][0]["items"][0]["clip"].as_u64().unwrap();
                doc.preview_begin("clip.audioGain", json!({ "clips": [clip], "mode": "set", "db": -30.0 })).unwrap();
                if document_first {
                    doc.audio(0.0, 24_000).unwrap();
                }
                out = doc.preview_audio(0.5, 24_000).unwrap();
            });
            out
        };
        let alone = preview_tail(false);
        let after_document = preview_tail(true);
        let difference = alone.iter().zip(&after_document).fold(0f32, |a, (x, y)| a.max((x - y).abs()));
        assert!(difference < 1e-6, "the document's reverb state reached the preview: {difference}");
    }

    /// What the reads cost, in release: `RAYON_NUM_THREADS=1 cargo test --release -p
    /// kition-film-kit --lib sound::tests::measures -- --ignored --nocapture`.
    #[test]
    #[ignore = "a measurement"]
    fn measures_the_sound_reads() {
        with_tone(|doc| {
            doc.execute("sequence.addTracks", json!({ "video": 0, "audio": 7 })).unwrap();
            doc.execute("mixer.addInsert", json!({ "strip": "A1", "effect": "parametric_eq" })).unwrap();
            doc.execute("mixer.addInsert", json!({ "strip": "Mix", "effect": "multiband_compressor" })).unwrap();
            let timed = |label: &str, run: &mut dyn FnMut()| {
                run();
                let started = std::time::Instant::now();
                for _ in 0..20 {
                    run();
                }
                eprintln!("{label}: {:?} each", started.elapsed() / 20);
            };
            timed("audio 0.1 s chunk (for comparison)", &mut || drop(doc.audio(0.1, 4_800).unwrap()));
            timed("levelsAt", &mut || drop(doc.levels_at(0.1).unwrap()));
            let chunk = sine(-20.0, 0.1);
            let mut at = 0.0;
            timed("loudnessFeed 0.1 s", &mut || {
                doc.loudness_feed(&chunk, 48_000, at).unwrap();
                at += 0.1;
            });
            timed("loudnessRead", &mut || drop(doc.loudness_read()));
            timed("fxResponse parametric EQ, 241 points", &mut || drop(doc.fx_response(&json!({ "strip": "A1", "slot": 0 }), 241, &Value::Null).unwrap()));
            timed("fxResponse multiband, 241 points + 4 transfer curves", &mut || {
                drop(doc.fx_response(&json!({ "strip": "Mix", "slot": 0 }), 241, &Value::Null).unwrap())
            });
        });
    }
}
