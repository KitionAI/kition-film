//! Promo editing: sound effects placed by their loudest moment, stock sound phrases, transitions
//! on the beat and a music bed, each as one undo step.
//!
//! | command | what it does |
//! |---|---|
//! | `timeline.placeMany` | places several sounds, each on the first audio track with room for it, with gain, fades and (`alignPeak`) its loudest moment on the given frame |
//! | `transition.beatCut` | a transition (whip, flash, push, cross zoom, or a straight cut) centred on every cut that lies on a beat, and a whoosh or impact peak-aligned to it |
//! | `audio.bed` | music under the film: clip gain −9.4 dB (≈0.34), a 1 s fade in, a 1.7 s fade out, optionally ducked under dialogue |
//! | `sound.phrase` | a stock phrase from the caller's sounds: `closing` (riser → impact 35 f later at 0.55, the loudest → sparkle 25 f after), `titleIn` swoosh 0.4, `sceneIn` soft transition 0.4, `click` 0.6, `hitRun` (two samples in turn, 0.40 → 0.25, tightening spacing; one swoosh when the hits blur) |
//!
//! A sound's peak is the loudest sample of its media (read at [`RATE`], the first
//! [`MAX_PEAK_SECONDS`]), cached per media range. Placing with `alignPeak` starts the clip at
//! `frame − peak` rounded to the nearest frame, so the hit of a whoosh or an impact lands on the
//! frame rather than its (often silent) head. A sound that would start before the sequence loses
//! its head instead.

use std::sync::{Arc, Mutex, OnceLock, Weak};

use kition_film_edit as edit;
use kition_film_project::{ClipId, EffectKind, ItemId, TrackKind, Transition, TransitionId};
use kition_film_time::{Tick, TimeRange};
use serde_json::{Value, json};

use crate::commands::{CommandSpec, NewTracks, bad, f64_p, has_seq, item_p, place_item_on};
use crate::{EngineError, Result, Session};

/// Analysis rate of the peak search.
const RATE: u32 = 22_050;
/// Only the start of a long sound is searched for its peak.
const MAX_PEAK_SECONDS: i64 = 60;
/// At most this many sounds in one command.
const MAX_SOUNDS: usize = 512;

type Key = (i64, i64);
type Cached = (Weak<dyn kition_film_media::MediaSource>, Key, Tick);

fn cache() -> &'static Mutex<Vec<Cached>> {
    static C: OnceLock<Mutex<Vec<Cached>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Where the loudest sample of `item`'s media lies, from the item's start (media In). Cached.
pub(crate) fn peak_lag(s: &Session, item: ItemId, cmd: &str) -> Result<Tick> {
    let (from, span) = crate::beats::item_span(s, item, cmd)?;
    let span = span.min(Tick::from_seconds_f64(MAX_PEAK_SECONDS as f64));
    if span.0 <= 0 {
        return Ok(Tick::ZERO);
    }
    let m0 = from.to_units_floor(RATE as i64);
    let len = (from + span).to_units_floor(RATE as i64) - m0;
    let provider = s.media.provider(s.project.clone(), s.services.clone());
    let src = kition_film_render::SourceProvider::source(&provider, item).ok_or_else(|| bad(cmd, "the sound's media is offline"))?;
    let source = Arc::downgrade(&src);
    let key = (m0, len);
    if let Some((_, _, lag)) = cache().lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(s, k, _)| s.ptr_eq(&source) && *k == key) {
        return Ok(*lag);
    }
    let n = usize::try_from(len.max(0)).map_err(|_| bad(cmd, "the sound is too long"))?;
    let buf = src.audio(m0, n, RATE).map_err(|e| EngineError::Other(format!("{cmd}: reading the sound: {e}")))?;
    let mut best = (0usize, 0.0f32);
    for ch in &buf.channels {
        for (i, x) in ch.iter().enumerate() {
            let a = x.abs();
            if a.is_finite() && a > best.1 {
                best = (i, a);
            }
        }
    }
    let lag = Tick::from_units(best.0 as i64, RATE as i64);
    let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
    c.retain(|(source, _, _)| source.strong_count() > 0);
    c.push((source, key, lag));
    let excess = c.len().saturating_sub(64);
    c.drain(..excess);
    Ok(lag)
}

/// One sound to place.
#[derive(Clone, Debug)]
pub(crate) struct Sound {
    pub item: ItemId,
    /// Where the sound's start (or, with `align_peak`, its loudest moment) goes.
    pub at: Tick,
    pub gain_db: f64,
    pub fade_in: Tick,
    pub fade_out: Tick,
    pub align_peak: bool,
    /// Play at most this much of the sound.
    pub length: Option<Tick>,
}

impl Sound {
    pub fn new(item: ItemId, at: Tick, gain_db: f64, align_peak: bool) -> Self {
        Sound { item, at, gain_db, fade_in: Tick::ZERO, fade_out: Tick::ZERO, align_peak, length: None }
    }
}

/// Gain in dB of a linear volume (0.55 → −5.2 dB).
pub(crate) fn db(volume: f64) -> f64 {
    20.0 * volume.max(1e-6).log10()
}

/// "A3": the name of the audio track holding `clip`.
fn audio_track_name(s: &Session, clip: ClipId) -> Option<String> {
    let q = s.active_sequence()?;
    q.audio_tracks.iter().position(|t| t.items.iter().any(|i| i.id == clip)).map(|k| format!("A{}", k + 1))
}

/// Constant Gain fades on the clips' edges (an audio transition with nothing on one side).
fn fades(q: &mut kition_film_project::Sequence, ctx: &mut edit::EditCtx, clips: &[ClipId], fade_in: Tick, fade_out: Tick, label: &str) -> Result<()> {
    if fade_in.0 <= 0 && fade_out.0 <= 0 {
        return Ok(());
    }
    let def = kition_film_project::vtransition::find_transition("constant_gain", EffectKind::AudioTransition)
        .ok_or_else(|| bad(label, "the Constant Gain transition is missing"))?;
    for c in clips {
        let Some((track, it)) = q.find_item(*c).map(|(t, i)| (t, (i.start, i.duration))) else { continue };
        let (start, dur) = it;
        // fades longer than the clip share it in proportion
        let (mut fi, mut fo) = (fade_in.max(Tick::ZERO), fade_out.max(Tick::ZERO));
        let total = fi + fo;
        if total > dur && total.0 > 0 {
            fi = dur.mul_ratio(fi.0, total.0);
            fo = dur - fi;
        }
        if fi.0 > 0 {
            let tr = Transition {
                id: TransitionId(0),
                effect: def.instance(),
                start,
                duration: fi,
                from: None,
                to: Some(*c),
                align: Default::default(),
                reverse: false,
            };
            edit::add_transition(q, track, tr, ctx)?;
        }
        if fo.0 > 0 {
            let tr = Transition {
                id: TransitionId(0),
                effect: def.instance(),
                start: start + dur - fo,
                duration: fo,
                from: Some(*c),
                to: None,
                align: Default::default(),
                reverse: false,
            };
            edit::add_transition(q, track, tr, ctx)?;
        }
    }
    Ok(())
}

/// Place one sound on the first audio track with room for it (a new track when none has), set its
/// gain and fades. Answers where it went. Run inside a [`crate::graphic_templates::grouped_edit`]
/// to make several sounds one undo step.
pub(crate) fn place_sound(s: &mut Session, snd: &Sound, label: &str) -> Result<Value> {
    s.project.item(snd.item).ok_or_else(|| bad(label, format!("no item {}", snd.item.0)))?;
    let (m_in, span) = crate::beats::item_span(s, snd.item, label)?;
    let lag = if snd.align_peak { peak_lag(s, snd.item, label)? } else { Tick::ZERO };
    let rate = s.sequence_rate();
    let mut start = rate.snap_nearest(snd.at - lag);
    let mut src_in = m_in;
    let mut len = snd.length.map_or(span, |l| l.min(span));
    if start < Tick::ZERO {
        // starts before the sequence: drop the head
        let cut = Tick::ZERO - start;
        src_in += cut;
        len -= cut;
        start = Tick::ZERO;
    }
    if len.0 <= 0 {
        return Err(bad(label, "the sound ends before the sequence starts"));
    }
    let free = crate::commands::free_track(s, TrackKind::Audio, TimeRange::new(start, len));
    let new = NewTracks { video: false, audio: free.is_none() };
    let ids = place_item_on(s, snd.item, TimeRange::new(src_in, len), start, None, free, false, label, None, new)?;
    let gain = snd.gain_db.clamp(-96.0, 96.0);
    let (fi, fo) = (snd.fade_in, snd.fade_out);
    let clips = ids.clone();
    s.edit_sequence(label, |q, ctx, _| {
        for c in &clips {
            if let Some((_, it)) = q.find_item_mut(*c) {
                it.gain_db = gain;
            }
        }
        fades(q, ctx, &clips, fi, fo, label)
    })?;
    let track = ids.first().and_then(|c| audio_track_name(s, *c));
    let fps = rate.as_f64();
    let mut out = json!({
        "clips": ids.iter().map(|c| c.0).collect::<Vec<_>>(),
        "item": snd.item.0,
        "audioTrack": track,
        "frame": rate.frame_at(start),
        "gainDb": gain,
    });
    if snd.align_peak {
        out["peakFrame"] = json!(rate.frame_at(rate.snap_nearest(snd.at)));
        out["peakLagFrames"] = json!((lag.seconds() * fps * 1000.0).round() / 1000.0);
    }
    Ok(out)
}

/// A time in a JSON object: `frame` or `seconds` (or `time` in ticks).
fn when(s: &Session, v: &Value) -> Option<Tick> {
    crate::commands::time_p(s, v, "")
}

/// Ticks from `<key>Frames` or `<key>Seconds`.
fn span_p(s: &Session, v: &Value, key: &str) -> Option<Tick> {
    let rate = s.sequence_rate();
    if let Some(f) = v.get(format!("{key}Frames")).and_then(Value::as_f64) {
        return Some(Tick::from_seconds_f64(f.max(0.0) / rate.as_f64().max(1e-9)));
    }
    v.get(format!("{key}Seconds")).and_then(Value::as_f64).map(|x| Tick::from_seconds_f64(x.max(0.0)))
}

/// `timeline.placeMany`.
fn place_many(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "timeline.placeMany";
    if let Some(t) = p.get("tracks").and_then(Value::as_str)
        && t != "auto"
    {
        return Err(bad(CMD, "`tracks` must be \"auto\" (each sound on the first audio track with room for it)"));
    }
    let list = p.get("items").and_then(Value::as_array).ok_or_else(|| bad(CMD, "need `items`: [{item, frame | seconds, …}]"))?;
    if list.is_empty() {
        return Err(bad(CMD, "`items` is empty"));
    }
    if list.len() > MAX_SOUNDS {
        return Err(bad(CMD, format!("at most {MAX_SOUNDS} sounds at once")));
    }
    let mut sounds = Vec::with_capacity(list.len());
    for (k, v) in list.iter().enumerate() {
        let item = item_p(v, "item").ok_or_else(|| bad(CMD, format!("items[{k}]: need `item`")))?;
        let at = when(s, v).ok_or_else(|| bad(CMD, format!("items[{k}]: need `frame` or `seconds`")))?;
        let gain = match (f64_p(v, "gainDb"), f64_p(v, "volume")) {
            (Some(g), _) => g,
            (None, Some(vol)) => db(vol),
            (None, None) => 0.0,
        };
        if !gain.is_finite() {
            return Err(bad(CMD, format!("items[{k}]: `gainDb` must be a number")));
        }
        let mut snd = Sound::new(item, at, gain, v.get("alignPeak").and_then(Value::as_bool).unwrap_or(false));
        snd.fade_in = span_p(s, v, "fadeIn").unwrap_or_default();
        snd.fade_out = span_p(s, v, "fadeOut").unwrap_or_default();
        snd.length = span_p(s, v, "duration");
        sounds.push(snd);
    }
    let placed = crate::graphic_templates::grouped_edit(s, "Place Sounds", |s| {
        let mut out = Vec::with_capacity(sounds.len());
        for snd in &sounds {
            out.push(place_sound(s, snd, CMD)?);
        }
        Ok(out)
    })?;
    Ok(json!({"placed": placed}))
}

// ------------------------------------------------------------------------------- sound.phrase

/// Fewest frames between repeated hits that the ear still counts; closer hits blur into one sound.
const MIN_HIT_SPACING: f64 = 3.0;

/// `sound.phrase`: a stock sound phrase from the caller's sound items.
fn phrase(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "sound.phrase";
    let preset = crate::commands::str_p(p, "preset").ok_or_else(|| bad(CMD, "need `preset`: closing, titleIn, sceneIn, click or hitRun"))?;
    let at = when(s, p).ok_or_else(|| bad(CMD, "need `frame` (or `seconds`): where the phrase lands"))?;
    let items = p.get("items").cloned().unwrap_or(Value::Null);
    let item = |key: &str| item_p(&items, key);
    let need = |key: &str| item(key).ok_or_else(|| bad(CMD, format!("preset `{preset}` needs `items.{key}` (a sound item)")));
    let offset = f64_p(p, "gainOffsetDb").unwrap_or(0.0);
    if !offset.is_finite() {
        return Err(bad(CMD, "`gainOffsetDb` must be a number"));
    }
    let rate = s.sequence_rate();
    let frame = |f: f64| at + Tick::from_seconds_f64(f / rate.as_f64().max(1e-9));
    // (sound, at, linear volume, peak-aligned)
    let mut plan: Vec<(ItemId, Tick, f64, bool)> = Vec::new();
    let mut note = Value::Null;
    match preset {
        // riser from the shot start, the impact (the loudest sound of the film) ≈35 frames later,
        // a sparkle 25 frames after that
        "closing" => {
            let impact_after = f64_p(p, "impactAfterFrames").unwrap_or(35.0).max(0.0);
            let sparkle_after = f64_p(p, "sparkleAfterFrames").unwrap_or(25.0).max(0.0);
            plan.push((need("riser")?, at, 0.5, false));
            plan.push((need("impact")?, frame(impact_after), 0.55, true));
            if let Some(sp) = item("sparkle") {
                plan.push((sp, frame(impact_after + sparkle_after), 0.3, true));
            }
        }
        "titleIn" => plan.push((need("swoosh")?, at, 0.4, true)),
        "sceneIn" => plan.push((need("transition")?, at, 0.4, true)),
        "click" => plan.push((need("click")?, at, 0.6, true)),
        // repeated hits: two samples in turn, quieter along the run (0.40 → 0.25), the spacing
        // tightening with the animation; hits that blur together become one swoosh
        "hitRun" => {
            let hit = need("hit")?;
            let alt = item("hitAlt").unwrap_or(hit);
            let count = p.get("count").and_then(Value::as_u64).unwrap_or(6).clamp(1, 64) as usize;
            let first = f64_p(p, "spacingFrames").unwrap_or(5.0);
            let last = f64_p(p, "endSpacingFrames").unwrap_or(first);
            if !(first.is_finite() && last.is_finite()) || first <= 0.0 || last <= 0.0 {
                return Err(bad(CMD, "`spacingFrames` and `endSpacingFrames` must be positive"));
            }
            let gaps = count.saturating_sub(1);
            let gap = |k: usize| if gaps <= 1 { first } else { first + (last - first) * k as f64 / (gaps - 1) as f64 };
            let mut offsets = vec![0.0f64];
            for k in 0..gaps {
                let prev = offsets.last().copied().unwrap_or(0.0);
                offsets.push(prev + gap(k));
            }
            let blurred = gaps > 0 && first.min(last) < MIN_HIT_SPACING;
            if blurred {
                let sw = item("swoosh").ok_or_else(|| {
                    bad(CMD, format!("hits closer than {MIN_HIT_SPACING} frames blur together: pass `items.swoosh` to play one swoosh over the run instead, or widen the spacing"))
                })?;
                let mid = offsets.last().copied().unwrap_or(0.0) / 2.0;
                plan.push((sw, frame(mid), 0.4, true));
                note = json!("the hits blur together: one swoosh over the run");
            } else {
                for (k, off) in offsets.iter().enumerate() {
                    let vol = if count <= 1 { 0.4 } else { 0.4 - 0.15 * k as f64 / (count - 1) as f64 };
                    plan.push((if k % 2 == 0 { hit } else { alt }, frame(off.round()), vol, true));
                }
            }
        }
        other => return Err(bad(CMD, format!("unknown preset `{other}` (closing, titleIn, sceneIn, click, hitRun)"))),
    }
    let label = format!("Sound Phrase ({preset})");
    let placed = crate::graphic_templates::grouped_edit(s, &label, |s| {
        let mut out = Vec::with_capacity(plan.len());
        for (item, t, vol, align) in &plan {
            out.push(place_sound(s, &Sound::new(*item, *t, db(*vol) + offset, *align), CMD)?);
        }
        Ok(out)
    })?;
    let mut out = json!({"preset": preset, "placed": placed});
    if !note.is_null() {
        out["note"] = note;
    }
    Ok(out)
}

// ------------------------------------------------------------------------- transition.beatCut

/// A beat-cut effect: the transition id (None = a straight cut) and its default length in frames.
fn cut_effect(name: &str, cmd: &str) -> Result<(Option<&'static kition_film_project::EffectDef>, i64)> {
    let (id, frames) = match name.trim().to_ascii_lowercase().replace(['-', ' '], "_").as_str() {
        "cut" | "none" => return Ok((None, 0)),
        "whip" => ("whip", 8),
        "flash" => ("flash", 6),
        "push" => ("push", 10),
        "crosszoom" | "cross_zoom" => ("cross_zoom", 10),
        _ => (name, 8),
    };
    let def = kition_film_project::vtransition::find_transition(id, EffectKind::VideoTransition)
        .ok_or_else(|| bad(cmd, format!("unknown transition `{name}` (whip, flash, push, crossZoom, cut, or any video transition id from effects.list)")))?;
    Ok((Some(def), frames))
}

/// One string or item id, or an array of them, as a list.
fn one_or_many(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::Null) | None => Vec::new(),
        Some(x) => vec![x.clone()],
    }
}

/// `transition.beatCut`.
fn beat_cut(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "transition.beatCut";
    let rate = s.sequence_rate();
    let names = one_or_many(p.get("effect"));
    let names: Vec<String> = if names.is_empty() {
        vec!["whip".into()]
    } else {
        names.iter().map(|v| v.as_str().map(str::to_string).ok_or_else(|| bad(CMD, "`effect` is a name or a list of names"))).collect::<Result<_>>()?
    };
    let params = match p.get("params") {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => return Err(bad(CMD, "`params` must be an object")),
    };
    let mut effects = Vec::with_capacity(names.len());
    let mut used: Vec<&String> = Vec::new();
    for n in &names {
        let (def, frames) = cut_effect(n, CMD)?;
        let mut inst = def.map(|d| d.instance());
        if let (Some(i), Some(d)) = (inst.as_mut(), def) {
            // with several effects, each takes the parameters it has
            let own: serde_json::Map<String, Value> = params.iter().filter(|(k, _)| d.param(k).is_some()).map(|(k, v)| (k.clone(), v.clone())).collect();
            used.extend(params.keys().filter(|k| own.contains_key(*k)));
            crate::commands::set_transition_params(i, &Value::Object(own), CMD)?;
        }
        effects.push((n.clone(), inst, frames));
    }
    if let Some(k) = params.keys().find(|k| !used.contains(k)) {
        return Err(bad(CMD, format!("none of the effects has a param `{k}` (effects.list {{\"effect\": …}} lists them)")));
    }
    let frames = p.get("frames").and_then(Value::as_i64);
    if frames.is_some_and(|f| !(1..=600).contains(&f)) {
        return Err(bad(CMD, "`frames` must be 1–600"));
    }
    let sfx: Vec<ItemId> = one_or_many(p.get("sfx"))
        .iter()
        .map(|v| v.as_u64().map(ItemId).ok_or_else(|| bad(CMD, "`sfx` is a sound item id or a list of them")))
        .collect::<Result<_>>()?;
    let sfx_gain = match (f64_p(p, "sfxGainDb"), f64_p(p, "sfxVolume")) {
        (Some(g), _) => g,
        (None, Some(v)) => db(v),
        (None, None) => db(0.45),
    };
    if !sfx_gain.is_finite() {
        return Err(bad(CMD, "`sfxGainDb` must be a number"));
    }
    let tol = p.get("toleranceFrames").and_then(Value::as_i64).unwrap_or(1).clamp(0, 30);
    let on_beat = p.get("onBeat").and_then(Value::as_bool).unwrap_or(true);
    let at: Option<Vec<i64>> = match p.get("at") {
        Some(Value::Array(a)) => Some(a.iter().map(|v| v.as_i64().ok_or_else(|| bad(CMD, "`at` is a list of frames"))).collect::<Result<_>>()?),
        Some(_) => return Err(bad(CMD, "`at` is a list of frames")),
        None => None,
    };
    let only: Option<Vec<u64>> = p.get("clips").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect());

    // every cut on the video tracks: (frame, track, outgoing, incoming, track name)
    let q = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let mut cuts = Vec::new();
    for (k, tr) in q.video_tracks.iter().enumerate().filter(|(_, t)| !t.locked) {
        for w in tr.items.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            if a.end() != b.start {
                continue;
            }
            if only.as_ref().is_some_and(|o| !o.contains(&b.id.0)) {
                continue;
            }
            cuts.push((rate.frame_at(rate.snap_nearest(b.start)), tr.id, a.id, b.id, format!("V{}", k + 1)));
        }
    }
    let mut skipped = Vec::new();
    match &at {
        Some(frames) => {
            cuts.retain(|c| frames.iter().any(|f| (c.0 - f).abs() <= tol));
            for f in frames.iter().filter(|f| !cuts.iter().any(|c| (c.0 - **f).abs() <= tol)) {
                skipped.push(json!({"frame": f, "reason": "no cut between two clips here"}));
            }
        }
        None if on_beat => {
            let mut beats: Vec<i64> = crate::beats::sequence_beats(s).iter().map(|t| rate.frame_at(rate.snap_nearest(*t))).collect();
            let markers = q.markers.iter().map(|m| rate.frame_at(rate.snap_nearest(m.start)));
            if beats.is_empty() {
                beats.extend(markers);
            }
            if beats.is_empty() {
                return Err(bad(
                    CMD,
                    "the sequence has no beats: put music on an audio track (or run audio.detectBeats with markers: true), or name the cuts with `at`",
                ));
            }
            cuts.retain(|c| {
                let hit = beats.iter().any(|b| (c.0 - b).abs() <= tol);
                if !hit {
                    skipped.push(json!({"frame": c.0, "track": c.4, "reason": "not on a beat"}));
                }
                hit
            });
        }
        None => {}
    }
    if cuts.is_empty() {
        return Err(bad(CMD, "no cut to change: no two clips meet on a beat (or at the `at` frames)"));
    }
    cuts.sort_by_key(|c| (c.0, c.4.clone()));
    let label = "Beat Cut Transitions";
    let out = crate::graphic_templates::grouped_edit(s, label, |s| {
        let mut out = Vec::new();
        let mut frames_done: Vec<i64> = Vec::new();
        for (frame, track, from, to, name) in &cuts {
            let order = frames_done.iter().position(|f| f == frame).unwrap_or(frames_done.len());
            let (ename, inst, def_frames) = effects.get(order % effects.len().max(1)).ok_or_else(|| bad(CMD, "no effect"))?;
            let mut row = json!({"frame": frame, "track": name, "effect": ename});
            if let Some(inst) = inst {
                let len = frames.unwrap_or(*def_frames).max(1);
                let dur = rate.tick_of(len);
                let cut = rate.tick_of(*frame);
                let start = rate.snap(cut - dur.mul_ratio(1, 2));
                let tr = Transition {
                    id: TransitionId(0),
                    effect: inst.clone(),
                    start,
                    duration: dur,
                    from: Some(*from),
                    to: Some(*to),
                    align: Default::default(),
                    reverse: false,
                };
                let (track, title) = (*track, format!("Apply {}", inst.def().map_or("Transition", |d| d.name)));
                let id = s.edit_sequence(&title, |q, ctx, _| Ok(edit::add_transition(q, track, tr, ctx)?))?;
                row["transition"] = json!(id.0);
                row["frames"] = json!(len);
            }
            // one sound per cut frame, however many tracks cut there
            if !frames_done.contains(frame) {
                if !sfx.is_empty() {
                    let item = sfx.get(frames_done.len() % sfx.len()).copied().ok_or_else(|| bad(CMD, "no sound"))?;
                    row["sfx"] = place_sound(s, &Sound::new(item, rate.tick_of(*frame), sfx_gain, true), CMD)?;
                }
                frames_done.push(*frame);
            }
            out.push(row);
        }
        Ok(out)
    })?;
    Ok(json!({"cuts": out, "skipped": skipped}))
}

// -------------------------------------------------------------------------------- audio.bed

/// `audio.bed`: music under the whole film: gain, fades and (optionally) ducking, one undo step.
fn bed(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "audio.bed";
    let gain = match (f64_p(p, "gainDb"), f64_p(p, "volume")) {
        (Some(g), _) => g,
        (None, Some(v)) => db(v),
        (None, None) => -9.4,
    };
    if !gain.is_finite() {
        return Err(bad(CMD, "`gainDb` must be a number"));
    }
    let secs = |k: &str, d: f64| f64_p(p, k).unwrap_or(d).clamp(0.0, 600.0);
    let fade_in = Tick::from_seconds_f64(secs("fadeInSeconds", 1.0));
    let fade_out = Tick::from_seconds_f64(secs("fadeOutSeconds", 1.7));
    // ducking: against which audio types, by how much
    let duck = match p.get("duck") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => None,
        Some(d) => {
            let against: Vec<Value> = match one_or_many(d.get("against")) {
                v if v.is_empty() => vec![json!("dialogue")],
                v => v,
            };
            let mut types = Vec::with_capacity(against.len());
            for a in &against {
                let t = a
                    .as_str()
                    .and_then(kition_film_project::audio_mixing::AudioType::parse)
                    .ok_or_else(|| bad(CMD, "`duck.against` is dialogue, music, sfx or ambience (or a list)"))?;
                types.push(serde_json::to_value(t).map_err(|e| bad(CMD, e.to_string()))?);
            }
            let mut values = json!({"ducking.enabled": true, "ducking.against": types});
            for (k, key) in [("reduceDb", "ducking.reduceDb"), ("sensitivity", "ducking.sensitivity"), ("fadeSeconds", "ducking.fadeS")] {
                if let Some(v) = f64_p(d, k) {
                    values[key] = json!(v);
                }
            }
            Some(values)
        }
    };
    let rate = s.sequence_rate();
    let q = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let picture_end = q.video_tracks.iter().flat_map(|t| t.items.iter().map(|i| i.end())).max().unwrap_or(Tick::ZERO);
    let target = match (crate::commands::clip_p(p, "clip"), item_p(p, "item")) {
        (Some(_), Some(_)) => return Err(bad(CMD, "name a `clip` or an `item`, not both")),
        (Some(c), None) => {
            let (t, _) = q.find_item(c).ok_or_else(|| bad(CMD, "no such clip"))?;
            if q.track(t).is_none_or(|t| t.kind != TrackKind::Audio) {
                return Err(bad(CMD, "the bed is an audio clip: name the clip on the audio track"));
            }
            Err(c)
        }
        (None, Some(i)) => Ok(i),
        (None, None) => return Err(bad(CMD, "need the music: an audio `clip` on the timeline or a project `item`")),
    };
    let at = when(s, p).unwrap_or(Tick::ZERO);
    let label = "Music Bed";
    let (clips, ducked) = crate::graphic_templates::grouped_edit(s, label, |s| {
        let clips: Vec<ClipId> = match target {
            // a project item: placed from `at` to the end of the picture (or its own end)
            Ok(item) => {
                let mut snd = Sound::new(item, at, gain, false);
                if picture_end > at {
                    snd.length = Some(picture_end - at);
                }
                snd.fade_in = fade_in;
                snd.fade_out = fade_out;
                let placed = place_sound(s, &snd, CMD)?;
                placed["clips"].as_array().map(|a| a.iter().filter_map(Value::as_u64).map(ClipId).collect()).unwrap_or_default()
            }
            Err(c) => {
                let clips = crate::commands::with_links(s, &[c]);
                let clips: Vec<ClipId> = {
                    let q = s.active_sequence().ok_or(EngineError::NoSequence)?;
                    clips.into_iter().filter(|c| q.find_item(*c).and_then(|(t, _)| q.track(t)).is_some_and(|t| t.kind == TrackKind::Audio)).collect()
                };
                let cl = clips.clone();
                s.edit_sequence(label, |q, ctx, _| {
                    for c in &cl {
                        if let Some((_, it)) = q.find_item_mut(*c) {
                            it.gain_db = gain.clamp(-96.0, 96.0);
                        }
                    }
                    fades(q, ctx, &cl, fade_in, fade_out, CMD)
                })?;
                clips
            }
        };
        let ids: Vec<u64> = clips.iter().map(|c| c.0).collect();
        let mut ducked = Value::Null;
        if let Some(values) = &duck {
            s.execute("audioMixing.setType", json!({"clips": ids, "type": "music"}))?;
            s.execute("audioMixing.set", json!({"clips": ids, "values": values}))?;
            ducked = s.execute("audioMixing.generateDucking", json!({"clips": ids}))?;
            // the type's loudness match must not move the bed's gain
            s.edit_sequence(label, |q, _, _| {
                for c in &clips {
                    if let Some((_, it)) = q.find_item_mut(*c) {
                        it.gain_db = gain.clamp(-96.0, 96.0);
                    }
                }
                Ok(())
            })?;
        }
        Ok((clips, ducked))
    })?;
    let q = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let first = clips.first().and_then(|c| q.find_item(*c).map(|(_, i)| (i.start, i.end())));
    let mut out = json!({
        "clips": clips.iter().map(|c| c.0).collect::<Vec<_>>(),
        "audioTrack": clips.first().and_then(|c| audio_track_name(s, *c)),
        "gainDb": gain,
        "fadeInSeconds": fade_in.seconds(),
        "fadeOutSeconds": fade_out.seconds(),
        "frames": first.map(|(a, b)| json!([rate.frame_at(a), rate.frame_at(b)])),
    });
    if !ducked.is_null() {
        out["ducking"] = json!(ducked["clips"].as_array().map(|c| c.iter().map(|x| json!({"clip": x["clip"], "regions": x["regions"]})).collect::<Vec<_>>()));
    }
    Ok(out)
}

fn spec(id: &'static str, label: &'static str, params: &'static str, run: fn(&mut Session, &Value) -> Result<Value>) -> CommandSpec {
    CommandSpec { id, label, menu: &[], shortcut: None, params, enabled: has_seq, run, journal: true }
}

pub fn commands() -> Vec<CommandSpec> {
    vec![
        spec(
            "timeline.placeMany",
            "Place Sounds",
            r#"{"items":[{"item":id,"frame":i64|"seconds":f64,"gainDb":f64=0|"volume":f64?,"fadeInFrames":f64?|"fadeInSeconds":f64?,"fadeOutFrames":f64?|"fadeOutSeconds":f64?,"durationFrames":f64?|"durationSeconds":f64?,"alignPeak":bool=false}],"tracks":"auto"="auto"}"#,
            place_many,
        ),
        spec(
            "sound.phrase",
            "Sound Phrase",
            r#"{"preset":"closing"|"titleIn"|"sceneIn"|"click"|"hitRun","frame":i64|"seconds":f64,"items":{"riser":id,"impact":id,"sparkle":id?}|{"swoosh":id}|{"transition":id}|{"click":id}|{"hit":id,"hitAlt":id?,"swoosh":id?},"count":i64=6 (hitRun),"spacingFrames":f64=5 (hitRun),"endSpacingFrames":f64? (hitRun),"impactAfterFrames":f64=35 (closing),"sparkleAfterFrames":f64=25 (closing),"gainOffsetDb":f64=0}"#,
            phrase,
        ),
        spec(
            "transition.beatCut",
            "Beat Cut Transitions",
            r#"{"clips":[id]? (cuts into these clips)|"at":[frame]? (cuts at these frames),"effect":"whip"|"flash"|"push"|"crossZoom"|"cut"|id|[names, used in turn]="whip","frames":i64? (whip 8, flash 6, push 10, crossZoom 10),"params":{param:value}?,"sfx":id|[id, used in turn]?,"sfxGainDb":f64=-6.9|"sfxVolume":f64?,"toleranceFrames":i64=1,"onBeat":bool=true}"#,
            beat_cut,
        ),
        spec(
            "audio.bed",
            "Music Bed",
            r#"{"clip":id?|"item":id? (placed from frame/seconds, default 0, to the end of the picture),"frame":i64?|"seconds":f64?,"gainDb":f64=-9.4|"volume":f64?,"fadeInSeconds":f64=1,"fadeOutSeconds":f64=1.7,"duck":{"against":"dialogue"|"sfx"|…|[types]="dialogue","reduceDb":f64=-15,"sensitivity":0..10?,"fadeSeconds":f64?}?}"#,
            bed,
        ),
    ]
}
