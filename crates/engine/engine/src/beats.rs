//! Audio ▸ Detect Beats: where the beats of a piece of music fall, for cutting picture on the beat
//! (analysis in [`kition_film_audio_dsp::remix::detect`]).
//!
//! | command | what it does |
//! |---|---|
//! | `audio.detectBeats` | reads the beats of an audio `clip` (in sequence time) or a project `item` (from its start); `markers: true` also adds a sequence marker on every beat, as one undo step |
//!
//! Snapping programmatic edits to beats (`timeline.place` / `timeline.move` / `timeline.trim` with
//! `snap: "beats"`, [`sequence_beats`]) uses the beats of the active sequence's audio clips, found
//! the same way. Speech, silence and noise have no beat. Analyses (and "no beat" answers) are
//! cached per media range, so asking again is instant. Everything is deterministic.

use std::sync::{Arc, Mutex, OnceLock, Weak};

use kition_film_audio_dsp::remix::{self as dsp, Beats, RemixError};
use kition_film_project::{ClipId, ItemId, Label, Marker, MarkerId, MarkerKind, TrackKind};
use kition_film_time::Tick;
use serde_json::{Value, json};

use crate::commands::{CommandSpec, bad, bool_p, clip_p, item_p, str_p};
use crate::{EngineError, Result, Session};

/// Analysis sample rate: enough for onsets, half the work of 44.1/48 kHz, and the same answer
/// whatever the sequence's audio rate is.
const RATE: u32 = 22_050;
/// Longest span analysed (seconds): a longer item or clip is refused rather than read whole.
const MAX_SECONDS: i64 = 30 * 60;

type Key = (i64, i64);
type Cached = (Weak<dyn kition_film_media::MediaSource>, Key, std::result::Result<Arc<Beats>, RemixError>);

fn cache() -> &'static Mutex<Vec<Cached>> {
    static C: OnceLock<Mutex<Vec<Cached>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Beats of `[from, from + dur)` (media time) of `item`'s media; the beat positions are samples
/// at [`RATE`] from `from`. Cached.
fn beats_of(s: &Session, item: ItemId, from: Tick, dur: Tick) -> Result<std::result::Result<Arc<Beats>, RemixError>> {
    if dur.0 <= 0 {
        return Ok(Err(RemixError::NoBeat));
    }
    if dur > Tick::from_seconds_f64(MAX_SECONDS as f64) {
        return Err(EngineError::Other(format!("beat detection reads at most {} minutes of audio", MAX_SECONDS / 60)));
    }
    let m0 = from.to_units_floor(RATE as i64);
    let len = (from + dur).to_units_floor(RATE as i64) - m0;
    let provider = s.media.provider(s.project.clone(), s.services.clone());
    let src = kition_film_render::SourceProvider::source(&provider, item).ok_or_else(|| EngineError::Other("the media is offline".into()))?;
    // Cache against the opened source itself (ids and paths can be reused); the Weak keeps its
    // identity without keeping the media open.
    let source = Arc::downgrade(&src);
    let key = (m0, len);
    if let Some((_, _, b)) = cache().lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(s, k, _)| s.ptr_eq(&source) && *k == key) {
        return Ok(b.clone());
    }
    let n = usize::try_from(len.max(0)).map_err(|_| EngineError::Other("the audio is too long".into()))?;
    let buf = src.audio(m0, n, RATE).map_err(|e| EngineError::Other(format!("reading the audio: {e}")))?;
    let refs: Vec<&[f32]> = buf.channels.iter().map(Vec::as_slice).collect();
    let found = dsp::detect(&refs, RATE).map(Arc::new);
    let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
    c.retain(|(source, _, _)| source.strong_count() > 0);
    c.push((source, key, found.clone()));
    let excess = c.len().saturating_sub(16);
    c.drain(..excess);
    Ok(found)
}

/// Where an audio clip's media plays: (media item, media In, media span, sequence start, speed).
/// Reversed, held, and remixed clips do not play their media straight, so they have no beat grid
/// of their own (detect on the project item instead).
fn clip_span(s: &Session, c: ClipId, cmd: &str) -> Result<(ItemId, Tick, Tick, Tick, f64)> {
    let seq = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let (t, it) = seq.find_item(c).ok_or_else(|| bad(cmd, "no such clip"))?;
    if seq.track(t).is_none_or(|t| t.kind != TrackKind::Audio) {
        return Err(bad(cmd, "beats are detected on audio clips: name the clip on the audio track"));
    }
    if s.project.resolve_media(it.item).is_none_or(|(_, m, _)| !m.info.has_audio()) {
        return Err(bad(cmd, "the clip has no audio media"));
    }
    if it.reverse || it.frame_hold.is_some() || kition_film_render::remix::is_remixed(it) || !(it.speed.is_finite() && it.speed > 0.0) {
        return Err(bad(cmd, "unsupported: the clip is reversed, held or remixed; detect the beats of its project `item` instead"));
    }
    let span = Tick((it.duration.0 as f64 * it.speed).round() as i64);
    Ok((it.item, it.source_in, span, it.start, it.speed))
}

/// Where a project item's media plays from: (media In, span); a subclip is its range.
pub(crate) fn item_span(s: &Session, item: ItemId, cmd: &str) -> Result<(Tick, Tick)> {
    let (_, media, range) = s.project.resolve_media(item).ok_or_else(|| bad(cmd, "the item is not audio media (or its media is missing)"))?;
    if !media.info.has_audio() {
        return Err(bad(cmd, "the item has no audio"));
    }
    Ok(range.map_or((Tick::ZERO, media.duration()), |r| (r.start, r.duration)))
}

/// The beats of every audio clip of the active sequence that has a beat, in sequence time,
/// sorted (for `snap: "beats"`). Clips without a beat (speech), offline media and clips that do not
/// play their media straight are skipped.
pub(crate) fn sequence_beats(s: &Session) -> Vec<Tick> {
    let Some(seq) = s.active_sequence() else { return Vec::new() };
    let clips: Vec<ClipId> = seq.audio_tracks.iter().flat_map(|t| t.items.iter().filter(|i| i.enabled).map(|i| i.id)).collect();
    let mut out = Vec::new();
    for c in clips {
        let Ok((item, from, span, start, speed)) = clip_span(s, c, "snap") else { continue };
        let Ok(Ok(b)) = beats_of(s, item, from, span) else { continue };
        out.extend(b.beats.iter().map(|&x| start + Tick((Tick::from_units(x, RATE as i64).0 as f64 / speed).round() as i64)));
    }
    out.sort();
    out.dedup();
    out
}

fn detect_beats(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "audio.detectBeats";
    let markers = bool_p(p, "markers").unwrap_or(false);
    // (media item, media In, span, where beat 0 s lands on the sequence, speed, timebase)
    let (item, from, span, origin, speed, timebase) = match (clip_p(p, "clip"), item_p(p, "item")) {
        (Some(_), Some(_)) => return Err(bad(CMD, "name a `clip` or an `item`, not both")),
        (Some(c), None) => {
            let (item, from, span, start, speed) = clip_span(s, c, CMD)?;
            (item, from, span, start, speed, "sequence")
        }
        (None, Some(i)) => {
            s.project.item(i).ok_or_else(|| bad(CMD, "no such item"))?;
            let (from, span) = item_span(s, i, CMD)?;
            (i, from, span, Tick::ZERO, 1.0, "item")
        }
        (None, None) => return Err(bad(CMD, "need an audio `clip` on the timeline or a project `item`")),
    };
    if markers && s.active_sequence().is_none() {
        return Err(EngineError::NoSequence);
    }
    let found = beats_of(s, item, from, span)?.map_err(|e| EngineError::Other(format!("{e}: speech, silence and noise have no beat")))?;
    let times: Vec<Tick> = found.beats.iter().map(|&x| origin + Tick((Tick::from_units(x, RATE as i64).0 as f64 / speed).round() as i64)).collect();
    let mut out = json!({
        "bpm": found.bpm / speed,
        "confidence": found.confidence,
        "timebase": timebase,
        "beats": times.iter().map(|t| t.seconds()).collect::<Vec<_>>(),
        "times": times.iter().map(|t| t.0).collect::<Vec<_>>(),
    });
    if let Some(seq) = s.active_sequence() {
        let rate = seq.settings.frame_rate;
        out["frames"] = json!(times.iter().map(|t| rate.frame_at(*t)).collect::<Vec<_>>());
    }
    if markers {
        // one undo step, the marker.add way: comment markers, sorted by time
        let name = str_p(p, "name").unwrap_or("Beat").to_string();
        let color = match str_p(p, "color") {
            Some(n) => Label::from_name(n).ok_or_else(|| bad(CMD, format!("unknown colour `{n}`")))?,
            None => Label::Green,
        };
        let ids = s.edit_sequence("Add Beat Markers", |q, ctx, _| {
            let mut ids = Vec::with_capacity(times.len());
            for &t in &times {
                let id = MarkerId(ctx.alloc());
                q.markers.push(Marker { id, start: t, duration: Tick::ZERO, name: name.clone(), comment: String::new(), kind: MarkerKind::Comment, color });
                ids.push(id.0);
            }
            q.markers.sort_by_key(|m| m.start);
            Ok(ids)
        })?;
        out["markers"] = json!(ids);
    }
    Ok(out)
}

pub fn commands() -> Vec<CommandSpec> {
    vec![CommandSpec {
        id: "audio.detectBeats",
        label: "Detect Beats",
        menu: &[],
        shortcut: None,
        params: r#"{"clip":id?,"item":id?,"markers":bool=false,"name":str="Beat"?,"color":label?}"#,
        enabled: crate::commands::always,
        run: detect_beats,
        journal: true,
    }]
}
