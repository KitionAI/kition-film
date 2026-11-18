//! Read-only media data the editor's panels draw: reduced frames of a project item (timeline
//! thumbnails, the Source monitor, Project panel icons), waveform peaks of an item's sound, the
//! item's own audio (Source monitor playback), and the Program monitor's render scale (its
//! playback and paused resolution). Each answer is bounded: a frame is at most
//! [`MAX_ITEM_FRAME_WIDTH`] wide, [`MAX_ITEM_FRAME_PIXELS`] in all, and never larger than the
//! item, and it is rendered from a copy no larger than that either; peaks cover at most
//! [`MAX_PEAK_SECONDS`] per call, and audio at most [`FilmDocument::MAX_AUDIO_SECONDS`], so a long
//! clip is decoded only where it is asked for.
//!
//! It also gives Effect Controls and Properties a clip's effects with their parameter schemas
//! and typed values ([`FilmDocument::clip_effects`]), and the monitors the commands that act on
//! the Source monitor when it has focus ([`FilmDocument::source_commands`]), and the Info panel
//! what it shows about a project item ([`FilmDocument::item_info`]). The page drains the engine's
//! events (toasts, and the panels to show) with [`FilmDocument::take_events`].

use kition_film_engine::Event;
use kition_film_engine::commands::{interpolation_name, param_json};
use kition_film_engine::project::graphic::{LayerContent, eval_layer, layer_indices};
use kition_film_engine::project::{ClipId, EffectKind, ItemId, ItemKind, ParamDef, ParamKind, ParamValue, TrackKind};
use kition_film_engine::render::Image;
use kition_film_engine::render::audio::mix_sequence;
use kition_film_engine::render::graphic_clip::{layer_bounds_answer, layer_matrix, text_layout};
use kition_film_engine::render::motion_matrix;
use kition_film_engine::time::{Tick, TimeDisplay, format_time};
use kition_film_frame::AudioBuffer;
use serde_json::{Value, json};

use crate::FilmDocument;
use kition_film_engine::Session;

/// The widest frame [`FilmDocument::item_frame`] returns.
pub const MAX_ITEM_FRAME_WIDTH: u32 = 2048;

/// The most pixels [`FilmDocument::item_frame`] returns, and renders before reducing (4 MP): the
/// page's WebAssembly memory grows to its largest answer and never shrinks.
pub const MAX_ITEM_FRAME_PIXELS: u64 = 4_194_304;

/// The longest stretch [`FilmDocument::item_peaks`] reads in one call, in seconds.
pub const MAX_PEAK_SECONDS: f64 = 60.0;

/// Peaks and item audio are at 48 kHz, whatever the item's own rate, as upstream's are.
const RATE: u32 = 48_000;

/// The smallest Program monitor render scale, upstream's 1/16 resolution.
const MIN_RENDER_SCALE: f32 = 1.0 / 16.0;

/// One peak per this many samples at 48 kHz (upstream `request_peaks`).
const PEAK_SAMPLES: usize = 256;

/// Peaks are read in chunks of this many samples (4 s), as upstream reads them.
const PEAK_CHUNK: usize = RATE as usize * 4;

/// A project item or clip id as the page passes it (a JavaScript number): a whole number from 0
/// to 2^53 - 1. Anything else is an error, never a different id.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code, reason = "the web wrappers call it"))]
pub(crate) fn js_id(value: f64, what: &str) -> Result<u64, String> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= MAX_SAFE { Ok(value as u64) } else { Err(format!("{what} {value} is not an id")) }
}

/// An affine map's six numbers, `[a, b, c, d, e, f]`: `x' = a x + c y + e`, `y' = b x + d y + f`.
type Affine6 = [f64; 6];

/// The six numbers of one of the renderer's affine maps (its type is the renderer's own).
macro_rules! affine {
    ($m:expr) => {{
        let m = $m;
        [m.a, m.b, m.c, m.d, m.e, m.f]
    }};
}

/// `outer ∘ inner`: `inner` first, then `outer`.
fn compose(outer: &Affine6, inner: &Affine6) -> Affine6 {
    let [a, b, c, d, e, f] = *outer;
    let [p, q, r, s, t, u] = *inner;
    [a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s, a * t + c * u + e, b * t + d * u + f]
}

fn apply(m: &Affine6, x: f64, y: f64) -> [f64; 2] {
    [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/// A non-negative, finite number of seconds as 48 kHz samples.
fn samples(seconds: f64) -> i64 {
    if seconds.is_finite() { (seconds.max(0.0) * f64::from(RATE)).round() as i64 } else { 0 }
}

/// [`FilmDocument::item_frame`] of `session`: the document's, or a preview's copy
/// ([`crate::preview`]).
pub(crate) fn session_item_frame(session: &Session, item: u64, seconds: f64, max_width: u32) -> Result<Vec<u8>, String> {
    let id = ItemId(item);
    let project = &session.project;
    let found = project.item(id).ok_or_else(|| format!("no item {item}"))?;
    let (width, height) = match &found.kind {
        ItemKind::Sequence(sequence) => (sequence.settings.width, sequence.settings.height),
        _ => project
            .resolve_media(id)
            .and_then(|(_, media, _)| media.info.video.as_ref().map(|video| (video.width, video.height)))
            .ok_or_else(|| format!("item {item} has no picture"))?,
    };
    let (width, height) = (width.max(1), height.max(1));
    let (w, h) = item_frame_size(width, height, max_width);
    let rate = project.resolve_media(id).map_or_else(|| found.frame_rate(), |(_, media, _)| media.frame_rate());
    let time = if seconds.is_finite() { Tick::from_seconds_f64(seconds.max(0.0)) } else { Tick::ZERO };
    let time = rate.snap(time);
    let provider = session.media.provider(project.clone(), session.services.clone());
    let scale = match found.kind {
        // A sequence renders at exactly the frame's size.
        ItemKind::Sequence(_) => w as f32 / width as f32,
        // A quarter pixel under `w`, so float rounding never stops the decoder's reduction a
        // step short of the reduced copy `w` fits.
        _ => (w as f32 - 0.25).max(0.5) / width as f32,
    };
    let image =
        kition_film_engine::render::render_item(project, id, time, scale, &provider).ok_or_else(|| format!("item {item} has no picture at {seconds} s"))?;
    let mut out = vec![0u8; 8 + w as usize * h as usize * 4];
    out[0..4].copy_from_slice(&w.to_le_bytes());
    out[4..8].copy_from_slice(&h.to_le_bytes());
    over_black_into(&image, w as usize, h as usize, &mut out[8..]);
    Ok(out)
}

impl FilmDocument {
    /// The project item `item` at `seconds` of its own media time (snapped to its frame), as
    /// upstream's thumbnails and Source monitor draw it: `[width u32 LE][height u32 LE]` then
    /// `width × height` RGBA pixels over black, the item's aspect, at most `max_width` (1 to
    /// [`MAX_ITEM_FRAME_WIDTH`]) wide, never larger than the item, and at most
    /// [`MAX_ITEM_FRAME_PIXELS`] in all. A sequence item renders its program. It is rendered from
    /// a reduced copy of at most [`MAX_ITEM_FRAME_PIXELS`] (the item halved until it fits, then
    /// the decoder's own reduction), so a picture larger than that comes back no wider than its
    /// reduced copy. An unknown item, or one with no picture (audio only), is an error.
    pub fn item_frame(&self, item: u64, seconds: f64, max_width: u32) -> Result<Vec<u8>, String> {
        session_item_frame(&self.session, item, seconds, max_width)
    }

    /// Waveform peaks of item `item`'s sound from `start_seconds` for `seconds` (at most 60): one
    /// `(min, max)` pair per 256 samples at 48 kHz of its first channel, flattened as `[min, max,
    /// min, max, …]`, as upstream's `request_peaks` makes them. A sequence item gives its mix's.
    /// Empty past the end of the item and for an item without sound; an unknown item is an
    /// error. Only the asked stretch is decoded, in 4 s chunks.
    pub fn item_peaks(&self, item: u64, start_seconds: f64, seconds: f64) -> Result<Vec<f32>, String> {
        let id = ItemId(item);
        let start = samples(start_seconds);
        // `f64::min` would make a length that is not a number the longest one.
        let wanted = if seconds.is_finite() { samples(seconds.min(MAX_PEAK_SECONDS)) } else { 0 };
        let Some((end, read)) = self.item_sound(id)? else { return Ok(Vec::new()) };
        let total = usize::try_from(end.min(start.saturating_add(wanted)).saturating_sub(start)).unwrap_or(0);
        let mut out = Vec::with_capacity(total.div_ceil(PEAK_SAMPLES) * 2);
        let mut done = 0usize;
        while done < total {
            let n = PEAK_CHUNK.min(total - done);
            let Some(buffer) = read(start + done as i64, n) else { break };
            let Some(first) = buffer.channels.first() else { break };
            for bucket in first.chunks(PEAK_SAMPLES) {
                let (lo, hi) = bucket.iter().fold((0f32, 0f32), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
                out.extend([lo, hi]);
            }
            done += n;
        }
        Ok(out)
    }

    /// `frames` stereo samples of item `item`'s own sound from `start_seconds`, interleaved left
    /// and right at 48 kHz (mono doubled; a sequence item gives its mix), for the Source monitor
    /// to play. At most 10 s, as [`FilmDocument::audio`]; silence past the end and for an item
    /// without sound. An unknown item is an error.
    pub fn item_audio(&self, item: u64, start_seconds: f64, frames: u32) -> Result<Vec<f32>, String> {
        let frames = (frames as usize).min((Self::MAX_AUDIO_SECONDS * f64::from(RATE)) as usize);
        let start = samples(start_seconds);
        let mut out = vec![0.0; frames * 2];
        let Some((end, read)) = self.item_sound(ItemId(item))? else { return Ok(out) };
        let available = usize::try_from(end.saturating_sub(start)).unwrap_or(0).min(frames);
        if available == 0 {
            return Ok(out);
        }
        if let Some(buffer) = read(start, available) {
            let silence = Vec::new();
            let left = buffer.channels.first().unwrap_or(&silence);
            let right = buffer.channels.get(1).unwrap_or(left);
            for (index, pair) in out.as_chunks_mut::<2>().0.iter_mut().take(available).enumerate() {
                pair[0] = left.get(index).copied().unwrap_or(0.0);
                pair[1] = right.get(index).copied().unwrap_or(0.0);
            }
        }
        Ok(out)
    }

    /// Renders the Program monitor (`render`, `render_area`) at `scale` of the sequence's size
    /// and scales it up to the asked size, as upstream's playback and paused resolutions do
    /// (`1.0` Full, `0.5` 1/2, … `0.0625` 1/16). It is clamped to 1/16 to 1, so the picture is
    /// never too small to draw; zero, negative, or not a number is an error.
    pub fn set_render_scale(&self, scale: f32) -> Result<(), String> {
        if !scale.is_finite() || scale <= 0.0 {
            return Err(format!("render scale {scale} must be above 0"));
        }
        self.services.set_render_scale(scale.clamp(MIN_RENDER_SCALE, 1.0));
        Ok(())
    }

    /// The Program monitor's render scale ([`Self::set_render_scale`]).
    pub fn render_scale(&self) -> f32 {
        self.services.render_scale()
    }

    /// Effect Controls' model of clip `clip` in the active sequence, as upstream's
    /// `effect_controls::show` reads it: the clip (`clip`, `name`, `track` `"video"` or
    /// `"audio"`, `start`, `duration`, `sourceIn` in ticks, `speed`, and `mediaTime`, the media
    /// time of the playhead held inside the clip) and its `effects`, the fixed ones first. Each
    /// effect has its `index` on the clip (what the commands take), `id`, `name`, `kind`,
    /// `enabled`, `intrinsic`, and `params` in the definition's order, each with `id`, `label`,
    /// `group`, `animatable`, its `kind` and range, `value` at the playhead, `default`, and
    /// `keyframes` (`time` in media ticks, as `mediaTime` in the keyframe commands); a LUT
    /// reference (a text parameter whose id ends in `_lut`) also has its `lutLabel`. An unknown
    /// clip is an error.
    pub fn clip_effects(&self, clip: u64) -> Result<Value, String> {
        let sequence = self.session.active_sequence().ok_or("no active sequence")?;
        let (track, it) = sequence.find_item(ClipId(clip)).ok_or_else(|| format!("no clip {clip}"))?;
        let track = match sequence.track(track).map(|track| track.kind) {
            Some(TrackKind::Audio) => "audio",
            _ => "video",
        };
        let playhead = self.session.playhead();
        let media_time = it.source_time_at(playhead.clamp(it.start, (it.end() - Tick(1)).max(it.start)));
        // Upstream lists the fixed effects (Motion, Opacity, Time Remapping, Volume…) first.
        let mut order: Vec<usize> = (0..it.effects.len()).collect();
        order.sort_by_key(|index| !it.effects[*index].def().is_some_and(|def| def.intrinsic));
        let effects: Vec<Value> = order
            .into_iter()
            .filter_map(|index| {
                let effect = &it.effects[index];
                let def = effect.def()?;
                let params: Vec<Value> = def
                    .params
                    .iter()
                    .filter_map(|param_def| {
                        let param = effect.params.get(param_def.id)?;
                        let mut row = param_schema(param_def);
                        let value = param.value_at(media_time);
                        // Upstream's `param_text` names a LUT reference ("Teal & Orange", "None").
                        if let ParamValue::Text(spec) = &value
                            && param_def.id.ends_with("_lut")
                        {
                            row["lutLabel"] = json!(kition_film_engine::render::luts::label(Some(&self.session.project), spec));
                        }
                        row["value"] = param_json(&value);
                        row["keyframes"] = param
                            .keyframes
                            .iter()
                            .map(|key| json!({ "time": key.time.0, "value": param_json(&key.value), "interpolation": interpolation_name(key.interp) }))
                            .collect();
                        Some(row)
                    })
                    .collect();
                Some(json!({
                    "index": index,
                    "id": effect.effect,
                    "name": def.name,
                    "kind": match def.kind {
                        EffectKind::Audio | EffectKind::AudioTransition => "audio",
                        EffectKind::Video | EffectKind::VideoTransition => "video",
                    },
                    "enabled": effect.enabled,
                    "intrinsic": def.intrinsic,
                    "params": params,
                }))
            })
            .collect();
        Ok(json!({
            "clip": clip,
            "name": it.name,
            "track": track,
            "start": it.start.0,
            "duration": it.duration.0,
            "sourceIn": it.source_in.0,
            "speed": it.speed,
            "mediaTime": media_time.0,
            "effects": effects,
        }))
    }

    /// The graphic layers in the Program monitor's picture at the playhead, as upstream's
    /// `graphics.rs` `visible_layers` and `canvas_target` find them for the graphics tools. Each
    /// layer, front-most first, has its `clip`, `layer` index, `kind` (`"text"` or `"shape"`), and
    /// `quad`, its box's four corners in sequence pixels (top-left, top-right, bottom-right,
    /// bottom-left) with the clip's Motion applied, and `scale`, layer pixels to sequence pixels;
    /// a text layer also has its `text`, font `size` (layer pixels), `vertical`, and `paragraph`.
    /// For the handles (upstream's `LayerView` and `HandleDrag`), each layer also has its `local`
    /// box (`[x0, y0, x1, y1]`, layer pixels), `toSequence` (layer to sequence pixels) and
    /// `canvas` (the clip's canvas to sequence pixels, its Motion applied) as `[a, b, c, d, e, f]`,
    /// and its `transform` (`position` and `anchor` on the canvas, `scale` as fractions); a text
    /// layer its `box` (`[box_width, box_height]`, zero for point text) and `overflow` (paragraph
    /// text its box hides), laid out only for the selected graphic's selected layers, as upstream
    /// draws the red plus only on them, and null for the others.
    /// A disabled track, clip, or layer is not in the picture. `target` is where new layers go:
    /// the selected graphic clip under the playhead, with `matrix` (`[a, b, c, d, e, f]`) mapping
    /// its canvas to sequence pixels, or null when new layers make a new clip on the sequence's
    /// own canvas. `selected` is the first selected graphic clip (upstream's `selected_graphic`,
    /// wherever it is) with the selected layer indices, or null.
    pub fn graphic_layers(&self) -> Result<Value, String> {
        let Some(sequence) = self.session.active_sequence() else { return Ok(json!({ "layers": [], "target": null, "selected": null })) };
        let project = &self.session.project;
        let playhead = self.session.playhead();
        let canvas_of = |item: ItemId| match project.item(item).map(|p| &p.kind) {
            Some(ItemKind::Graphic { width, height, .. }) => Some((*width, *height)),
            _ => None,
        };
        // Upstream's `selected_graphic`: the first selected clip that is a graphic, wherever it is;
        // `canvas_target` takes it only while it is under the playhead.
        let selected = self.session.state.selection.iter().find_map(|clip| sequence.find_item(*clip).and_then(|(_, it)| Some((it, canvas_of(it.item)?))));
        let chosen = |clip: ClipId, layer: usize| selected.is_some_and(|(it, _)| it.id == clip) && self.session.state.graphic_layers.contains(&layer);
        let mut layers = Vec::new();
        for track in sequence.video_tracks.iter().rev().filter(|track| track.enabled) {
            let Some(it) = track.item_at(playhead).filter(|it| it.enabled) else { continue };
            let Some(size) = canvas_of(it.item) else { continue };
            let media_time = it.source_time_at(playhead);
            let base: Affine6 = affine!(motion_matrix(sequence, it, size, media_time));
            let indices = layer_indices(&it.effects);
            for (layer, &effect) in indices.iter().enumerate().rev() {
                // As upstream's `visible_layers`, the layer as `eval_layer` gives it: Responsive
                // Design's pins and a roll's offset are not applied (`item_layer_specs` would).
                let Some(spec) = eval_layer(&it.effects[effect], media_time, size).filter(|spec| spec.enabled) else { continue };
                let local = layer_bounds_answer(&spec);
                let to_sequence = compose(&base, &affine!(layer_matrix(&spec)));
                let quad: Vec<[f64; 2]> = [(local[0], local[1]), (local[2], local[1]), (local[2], local[3]), (local[0], local[3])]
                    .iter()
                    .map(|&(x, y)| apply(&to_sequence, x, y))
                    .collect();
                let transform = &spec.transform;
                let mut row = json!({
                    "clip": it.id.0,
                    "layer": layer,
                    "kind": "shape",
                    "quad": quad,
                    "scale": (to_sequence[0] * to_sequence[3] - to_sequence[1] * to_sequence[2]).abs().sqrt(),
                    "local": local,
                    "toSequence": to_sequence,
                    "canvas": base,
                    "transform": {
                        "position": [transform.position.x, transform.position.y],
                        "anchor": [transform.anchor.x, transform.anchor.y],
                        "scale": [transform.scale.x, transform.scale.y],
                    },
                });
                if let LayerContent::Text(text) = &spec.content {
                    let paragraph = text.box_width > 0.0 && !text.vertical;
                    row["kind"] = json!("text");
                    row["text"] = json!(text.text);
                    row["size"] = json!(text.size);
                    row["vertical"] = json!(text.vertical);
                    row["paragraph"] = json!(paragraph);
                    row["box"] = json!([text.box_width, text.box_height]);
                    // Upstream's red plus on the bottom-right handle: paragraph text its box hides,
                    // laid out, as upstream's, only for a selected layer (null for the others).
                    row["overflow"] = if chosen(it.id, layer) { json!(paragraph && text_layout(text).overflow) } else { Value::Null };
                }
                layers.push(row);
            }
        }
        let target = selected
            .filter(|(it, _)| it.range().contains(playhead))
            .map(|(it, size)| json!({ "clip": it.id.0, "matrix": affine!(motion_matrix(sequence, it, size, it.source_time_at(playhead))) }));
        let selected = selected.map(|(it, _)| json!({ "clip": it.id.0, "layers": self.session.state.graphic_layers }));
        Ok(json!({ "layers": layers, "target": target, "selected": selected }))
    }

    /// The commands that act on the Source monitor's clip when it has focus (upstream
    /// `menus.rs` `targets_source`): every command `source_monitor::source_command` accepts, in
    /// the registry's order.
    pub fn source_commands() -> Vec<String> {
        kition_film_engine::command_specs()
            .iter()
            .filter(|spec| kition_film_engine::source_monitor::source_command(spec.id))
            .map(|spec| spec.id.to_owned())
            .collect()
    }

    /// What upstream's Info panel (`misc.rs` `info`) shows about project item `item`: its `name`,
    /// `type` (the Media Type column's), for a media item its `video` line (`"30 fps, 1920 x 1080
    /// (1.0000)"`) and `codec`, and its `audio` line (`"48000 Hz - 2 ch - PCM"`), each null
    /// without that stream, and its `duration` as a timecode at the item's own rate. An unknown
    /// item is an error.
    pub fn item_info(&self, item: u64) -> Result<Value, String> {
        let it = self.session.project.item(ItemId(item)).ok_or_else(|| format!("no item {item}"))?;
        let media = it.as_media();
        let video = media.and_then(|m| m.info.video.as_ref());
        let audio = media.and_then(|m| m.info.audio());
        Ok(json!({
            "item": item,
            "name": it.name,
            "type": it.type_label(),
            "video": video.map(|v| format!("{} fps, {} x {} ({:.4})", v.frame_rate.label(), v.width, v.height, v.par.0 as f32 / v.par.1 as f32)),
            "codec": video.map(|v| v.codec.clone()),
            "audio": audio.map(|a| format!("{} Hz - {} ch - {}", a.sample_rate, a.channels, a.codec)),
            "duration": format_time(it.duration(), it.frame_rate(), false, TimeDisplay::Timecode, 48_000),
        }))
    }

    /// The engine's events since the last call, oldest first, as upstream's frame loop drains
    /// them (`lib.rs` `drain_events`): `{"kind": "toast", "message", "error"}` (a notice, an
    /// error when `error`), `{"kind": "openSequence", "item"}` (show that sequence in the
    /// Timeline), `{"kind": "openSource", "item"}` (show the Source monitor), and `{"kind":
    /// "revealInProject", "item"}` (show the item in the Project panel). The engine's
    /// `ProjectChanged` is left out: the page follows the revision. Every call empties the queue,
    /// so the events never pile up in the page's memory.
    pub fn take_events(&mut self) -> Value {
        Value::Array(
            self.session
                .drain_events()
                .into_iter()
                .filter_map(|event| match event {
                    Event::ProjectChanged { .. } => None,
                    Event::Toast { message, error } => Some(json!({ "kind": "toast", "message": message, "error": error })),
                    Event::OpenSequence(item) => Some(json!({ "kind": "openSequence", "item": item.0 })),
                    Event::OpenSource(item) => Some(json!({ "kind": "openSource", "item": item.0 })),
                    Event::RevealInProject(item) => Some(json!({ "kind": "revealInProject", "item": item.0 })),
                })
                .collect(),
        )
    }

    /// Where an item's sound ends (in 48 kHz samples) and how to read it: the media's decoder, or
    /// a sequence item's mix. `None` for an item without sound; an error for an unknown item.
    #[allow(clippy::type_complexity)]
    fn item_sound(&self, id: ItemId) -> Result<Option<(i64, Box<dyn Fn(i64, usize) -> Option<AudioBuffer> + '_>)>, String> {
        let project = &self.session.project;
        let found = project.item(id).ok_or_else(|| format!("no item {}", id.0))?;
        if let ItemKind::Sequence(sequence) = &found.kind {
            let end = sequence.duration().to_units_floor(i64::from(RATE)).max(0);
            let provider = self.session.media.provider(project.clone(), self.session.services.clone());
            let rate = sequence.settings.sample_rate.max(1);
            return Ok(Some((
                end,
                Box::new(move |start, frames| {
                    let mix = |start, frames| mix_sequence(project, sequence, start, frames, &provider);
                    // The mix is at the sequence's rate; peaks and playback are at 48 kHz.
                    Some(if rate == RATE { mix(start, frames) } else { resampled(rate, start, frames, mix) })
                }),
            )));
        }
        let Some(source) = self.session.source(id) else { return Ok(None) };
        if source.info().audio_streams.is_empty() {
            return Ok(None);
        }
        let end = source.info().duration.to_units_floor(i64::from(RATE)).max(0);
        Ok(Some((end, Box::new(move |start, frames| source.audio(start, frames, RATE).ok()))))
    }
}

/// A parameter's schema for Effect Controls: everything but its value and keyframes.
fn param_schema(def: &ParamDef) -> Value {
    let mut row = json!({
        "id": def.id,
        "label": def.label,
        "group": def.group,
        "animatable": def.animatable,
        "default": param_json(&def.default),
    });
    let kind = match &def.kind {
        ParamKind::Float { min, max, soft_min, soft_max, unit, decimals } => {
            for (key, value) in [
                ("min", json!(min)),
                ("max", json!(max)),
                ("softMin", json!(soft_min)),
                ("softMax", json!(soft_max)),
                ("unit", json!(unit)),
                ("decimals", json!(decimals)),
            ] {
                row[key] = value;
            }
            "float"
        }
        ParamKind::Point => "point",
        ParamKind::Color => "color",
        ParamKind::Bool => "bool",
        ParamKind::Choice(choices) => {
            row["choices"] = json!(choices);
            "choice"
        }
        ParamKind::Angle => "angle",
        ParamKind::Text => "text",
        ParamKind::Curve { hue } => {
            row["hue"] = json!(hue);
            "curve"
        }
        ParamKind::Wheel => "wheel",
        ParamKind::Path => "path",
    };
    row["kind"] = json!(kind);
    row
}

/// The size [`FilmDocument::item_frame`] answers for a `width × height` picture asked at most
/// `max_width` wide. The picture is first halved until it has at most [`MAX_ITEM_FRAME_PIXELS`]
/// (the render's own reduction, so its full-size copy is never made), then fitted to `max_width`
/// and [`MAX_ITEM_FRAME_WIDTH`], keeping its aspect.
fn item_frame_size(width: u32, height: u32, max_width: u32) -> (u32, u32) {
    let mut reduced = (width, height);
    let mut halvings = 0;
    while u64::from(reduced.0) * u64::from(reduced.1) > MAX_ITEM_FRAME_PIXELS && halvings < 4 {
        reduced = ((reduced.0 / 2).max(1), (reduced.1 / 2).max(1));
        halvings += 1;
    }
    let w = max_width.clamp(1, MAX_ITEM_FRAME_WIDTH).min(reduced.0);
    let h = ((f64::from(height) * f64::from(w) / f64::from(width)).round() as u32).max(1);
    // A picture over 16 times the cap after four halvings (a strip thousands of times longer than
    // it is wide) is cut to the cap's area rather than reduced further.
    let h = h.min(u32::try_from(MAX_ITEM_FRAME_PIXELS / u64::from(w)).unwrap_or(u32::MAX)).max(1);
    (w, h)
}

/// Writes `image` (linear, premultiplied) over black as sRGB RGBA into `out`, a `w × h` frame,
/// averaging each output pixel's area of the image in linear light. The image is the render's
/// reduced copy, at most twice the frame's size each way, so this reads every pixel once.
fn over_black_into(image: &Image, w: usize, h: usize, out: &mut [u8]) {
    let (iw, ih) = (image.w.max(1), image.h.max(1));
    if image.px.len() < iw * ih * 4 {
        return;
    }
    let span = |index: usize, of: usize, to: usize| {
        let first = index * of / to;
        (first, ((index + 1) * of / to).max(first + 1).min(of))
    };
    for (y, row) in out.chunks_exact_mut(w * 4).take(h).enumerate() {
        let (y0, y1) = span(y, ih, h);
        for (x, pixel) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let (x0, x1) = span(x, iw, w);
            let mut sum = [0f32; 3];
            for sy in y0..y1 {
                for source in image.px[(sy * iw + x0) * 4..(sy * iw + x1) * 4].as_chunks::<4>().0 {
                    sum = [sum[0] + source[0], sum[1] + source[1], sum[2] + source[2]];
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as f32;
            *pixel = [
                kition_film_color::linear_to_srgb_u8(sum[0] / count),
                kition_film_color::linear_to_srgb_u8(sum[1] / count),
                kition_film_color::linear_to_srgb_u8(sum[2] / count),
                255,
            ];
        }
    }
}

/// `frames` samples at 48 kHz from 48 kHz sample `start`, of a sound `mix` gives at `rate`
/// (`mix(start, frames)` in its own samples): a sequence mixed at a rate other than 48 kHz, for
/// peaks and playback. Each output sample is interpolated linearly at its exact position in the
/// mix, worked out from its absolute index, so consecutive calls join without a dropped or
/// repeated sample.
fn resampled(rate: u32, start: i64, frames: usize, mix: impl Fn(i64, usize) -> AudioBuffer) -> AudioBuffer {
    let empty = AudioBuffer { sample_rate: RATE, channels: Vec::new() };
    let Ok(last) = i64::try_from(frames) else { return empty };
    if frames == 0 {
        return empty;
    }
    // Sample `n` at 48 kHz is at `n * rate / RATE` in the mix: a whole sample and a fraction.
    let at = |n: i64| {
        let position = i128::from(n) * i128::from(rate);
        (i64::try_from(position.div_euclid(i128::from(RATE))).unwrap_or(i64::MAX), position.rem_euclid(i128::from(RATE)) as f32 / RATE as f32)
    };
    let first = at(start).0;
    let count = usize::try_from(at(start.saturating_add(last - 1)).0 - first + 2).unwrap_or(0);
    let mixed = mix(first, count);
    let channels = mixed
        .channels
        .iter()
        .map(|channel| {
            (0..last)
                .map(|index| {
                    let (whole, fraction) = at(start + index);
                    let offset = usize::try_from(whole - first).unwrap_or(0);
                    let a = channel.get(offset).copied().unwrap_or(0.0);
                    let b = channel.get(offset + 1).copied().unwrap_or(a);
                    a + (b - a) * fraction
                })
                .collect()
        })
        .collect();
    AudioBuffer { sample_rate: RATE, channels }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{HOST_ROOT, fixture, tone_wav};
    use kition_kit::KitDocument;
    use serde_json::json;

    fn size(frame: &[u8]) -> (u32, u32) {
        let w = u32::from_le_bytes(frame[0..4].try_into().unwrap());
        let h = u32::from_le_bytes(frame[4..8].try_into().unwrap());
        assert_eq!(frame.len(), 8 + w as usize * h as usize * 4, "header and pixels agree");
        (w, h)
    }

    /// The fixture's red matte item and the open document.
    fn with_matte() -> (FilmDocument, u64) {
        let doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let inspected = doc.inspect().unwrap();
        let item = inspected["sequence"]["video"][0]["items"][0]["item"].as_u64().unwrap_or_else(|| panic!("no item in {inspected}"));
        (doc, item)
    }

    /// Runs `body` with `tone.wav` (one second of 440 Hz) lent by the host and placed on A1.
    fn with_tone(body: impl FnOnce(&mut FilmDocument, u64)) {
        let _lock = HOST_ROOT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("kition-film-panels-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tone.wav"), tone_wav()).unwrap();
        kition_kit::host::set_root(Some(dir.clone()));
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        let imported = doc.execute("file.import", json!({ "paths": ["tone.wav"] })).unwrap();
        let item = imported["items"][0].as_u64().unwrap();
        body(&mut doc, item);
        kition_kit::host::set_root(None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_item_frame_is_a_reduced_copy_with_its_aspect() {
        let (doc, matte) = with_matte();
        let frame = doc.item_frame(matte, 1.0, 16).unwrap();
        assert_eq!(size(&frame), (16, 9));
        assert_eq!(&frame[8..12], &[255, 0, 0, 255], "a red matte is red");
        // Never larger than the item.
        assert_eq!(size(&doc.item_frame(matte, 0.0, 10_000).unwrap()), (64, 36));
        assert_eq!(size(&doc.item_frame(matte, 0.0, 0).unwrap()).0, 1);
    }

    #[test]
    fn n37_subclip_item_frames_use_the_parent_rate_instead_of_the_default_rate() {
        let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
        doc.execute("file.newSequence", json!({"width": 320, "height": 180, "fps": 60})).unwrap();
        let parent = doc.execute("file.newCountingLeader", json!({})).unwrap()["item"].as_u64().unwrap();
        let item = doc.execute("clip.makeSubclip", json!({"item": parent, "startFrame": 1, "endFrame": 60})).unwrap()["item"].as_u64().unwrap();
        assert_ne!(doc.item_frame(parent, 0.0, 160).unwrap(), doc.item_frame(parent, 3.0 / 60.0, 160).unwrap(), "the original leader must move");
        for frame in [1, 2, 3, 4, 12, 37, 59] {
            let seconds = f64::from(frame) / 60.0;
            assert_eq!(doc.item_frame(item, seconds, 160).unwrap(), doc.item_frame(parent, seconds, 160).unwrap(), "media frame {frame}");
        }
    }

    #[test]
    fn an_item_frame_is_at_most_2048_wide_and_four_megapixels() {
        // A DCI 4K sequence asked at 4096 px comes back at 2048 x 1080, red over its whole width.
        let mut doc = FilmDocument::create("Edit.kfilm", 4096, 2160).unwrap();
        let matte = doc.execute("file.newColorMatte", json!({ "color": "#ff0000", "seconds": 4.0 })).unwrap();
        doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0.0 })).unwrap();
        let sequence = doc.session.state.active_sequence.unwrap().0;
        let frame = doc.item_frame(sequence, 1.0, 4096).unwrap();
        assert_eq!(size(&frame), (2048, 1080));
        assert_eq!(&frame[8..12], &[255, 0, 0, 255]);
        assert_eq!(&frame[frame.len() - 4..], &[255, 0, 0, 255], "the last pixel too");
        let matte = matte["item"].as_u64().unwrap();
        assert!(size(&doc.item_frame(matte, 1.0, 4096).unwrap()).0 <= MAX_ITEM_FRAME_WIDTH);
        // Square and tall pictures are bounded by their area.
        for (w, h) in [(3000, 3000), (1000, 9000)] {
            doc.execute("file.newSequence", json!({ "name": format!("{w} x {h}"), "width": w, "height": h })).unwrap();
            let sequence = doc.session.state.active_sequence.unwrap().0;
            let (fw, fh) = size(&doc.item_frame(sequence, 0.0, 4096).unwrap());
            assert!(fw <= 2048 && u64::from(fw) * u64::from(fh) <= MAX_ITEM_FRAME_PIXELS, "{w} x {h} gave {fw} x {fh}");
            let aspect = f64::from(w) / f64::from(h);
            assert!((f64::from(fw) / f64::from(fh) - aspect).abs() / aspect < 0.02, "{w} x {h} keeps its aspect in {fw} x {fh}");
        }
    }

    #[test]
    fn a_sequence_item_frame_is_its_program() {
        let (doc, _) = with_matte();
        let sequence = doc.session.state.active_sequence.unwrap();
        let frame = doc.item_frame(sequence.0, 1.0, 32).unwrap();
        assert_eq!(size(&frame), (32, 18));
        assert_eq!(&frame[8..12], &[255, 0, 0, 255]);
        let after = doc.item_frame(sequence.0, 10.0, 32).unwrap();
        assert_eq!(&after[8..12], &[0, 0, 0, 255], "black past its end");
    }

    #[test]
    fn an_item_frame_of_nothing_or_of_sound_is_an_error() {
        let (doc, _) = with_matte();
        assert!(doc.item_frame(9_999, 0.0, 64).is_err());
        with_tone(|doc, tone| assert!(doc.item_frame(tone, 0.0, 64).is_err(), "audio only has no picture"));
    }

    #[test]
    fn item_peaks_are_min_max_pairs_per_256_samples() {
        with_tone(|doc, tone| {
            let peaks = doc.item_peaks(tone, 0.0, 4.0).unwrap();
            // The tone is one second long: 48 000 / 256 buckets, rounded up.
            assert_eq!(peaks.len(), 48_000usize.div_ceil(256) * 2);
            let max = peaks.chunks(2).map(|pair| pair[1]).fold(0f32, f32::max);
            let min = peaks.chunks(2).map(|pair| pair[0]).fold(0f32, f32::min);
            assert!(max > 0.3 && min < -0.3, "the tone's peaks ({min}, {max})");
            assert_eq!(doc.item_peaks(tone, 0.5, 0.25).unwrap().len(), (12_000usize).div_ceil(256) * 2, "a window");
            assert!(doc.item_peaks(tone, 5.0, 4.0).unwrap().is_empty(), "empty past the end");
            assert!(doc.item_peaks(9_999, 0.0, 4.0).is_err());
        });
        let (doc, matte) = with_matte();
        assert!(doc.item_peaks(matte, 0.0, 4.0).unwrap().is_empty(), "a matte has no sound");
    }

    #[test]
    fn ids_from_the_page_are_whole_numbers() {
        for good in [0.0, 1.0, 8.0, 9_007_199_254_740_991.0] {
            assert_eq!(js_id(good, "item"), Ok(good as u64));
        }
        for bad in [f64::NAN, -1.0, 0.5, 8.7, -0.5, f64::INFINITY, f64::NEG_INFINITY, 9_007_199_254_740_992.0] {
            assert!(js_id(bad, "item").is_err(), "{bad} is not an id");
        }
    }

    #[test]
    fn audio_at_another_rate_is_interpolated_and_joins_across_calls() {
        // A ramp at 44.1 kHz: sample n of the mix is n, so a 48 kHz sample i is i * 44.1 / 48.
        let ramp = |start: i64, frames: usize| AudioBuffer { sample_rate: 44_100, channels: vec![(start..start + frames as i64).map(|n| n as f32).collect()] };
        let step = 44_100.0 / 48_000.0;
        let mut joined = Vec::new();
        for (start, frames) in [(0, 1_001), (1_001, 999), (2_000, 37)] {
            let chunk = resampled(44_100, start, frames, ramp);
            assert_eq!(chunk.channels[0].len(), frames);
            joined.extend_from_slice(&chunk.channels[0]);
        }
        for (index, value) in joined.iter().enumerate() {
            assert!((value - index as f32 * step).abs() < 1e-3, "sample {index} is {value}, not {}", index as f32 * step);
        }
        assert!(joined.windows(2).all(|pair| (pair[1] - pair[0] - step).abs() < 1e-3), "no dropped or repeated sample at the chunk edges");
        assert!(resampled(44_100, 0, 0, ramp).channels.is_empty());
    }

    #[test]
    fn a_sequence_mixed_at_44_1_khz_plays_continuously_at_48_khz() {
        with_tone(|doc, tone| {
            doc.execute("file.newSequence", json!({ "name": "44.1", "width": 64, "height": 36, "sampleRate": 44_100 })).unwrap();
            doc.execute("timeline.place", json!({ "item": tone, "track": "A1", "seconds": 0.0 })).unwrap();
            let sequence = doc.session.state.active_sequence.unwrap().0;
            let whole = doc.item_audio(sequence, 0.1, 2_000).unwrap();
            let mut joined = doc.item_audio(sequence, 0.1, 1_000).unwrap();
            joined.extend(doc.item_audio(sequence, 0.1 + 1_000.0 / 48_000.0, 1_000).unwrap());
            assert!(whole.iter().any(|sample| sample.abs() > 0.05), "the tone is audible");
            for (index, (a, b)) in whole.iter().zip(&joined).enumerate() {
                assert!((a - b).abs() < 1e-4, "sample {} differs across the chunk edge: {a} against {b}", index / 2);
            }
            // A 440 Hz tone at this level moves less than 0.03 per 48 kHz sample.
            let left: Vec<f32> = joined.chunks(2).map(|pair| pair[0]).collect();
            assert!(left.windows(2).all(|pair| (pair[1] - pair[0]).abs() < 0.03), "continuous");
        });
    }

    #[test]
    fn peaks_of_a_length_that_is_not_a_number_are_empty() {
        with_tone(|doc, tone| {
            for length in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
                assert!(doc.item_peaks(tone, 0.0, length).unwrap().is_empty(), "{length} s");
            }
            for start in [-3.0, f64::NAN, f64::NEG_INFINITY] {
                assert_eq!(doc.item_peaks(tone, start, 0.25).unwrap(), doc.item_peaks(tone, 0.0, 0.25).unwrap(), "{start} s starts at 0");
                assert_eq!(doc.item_audio(tone, start, 4_800).unwrap(), doc.item_audio(tone, 0.0, 4_800).unwrap(), "{start} s starts at 0");
            }
        });
    }

    #[test]
    fn a_sequence_item_has_peaks_of_its_mix() {
        with_tone(|doc, tone| {
            doc.execute("timeline.place", json!({ "item": tone, "track": "A1", "seconds": 0.0 })).unwrap();
            let sequence = doc.session.state.active_sequence.unwrap();
            let peaks = doc.item_peaks(sequence.0, 0.0, 1.0).unwrap();
            assert!(!peaks.is_empty());
            assert!(peaks.chunks(2).any(|pair| pair[1] > 0.05), "the mix has the tone");
        });
    }

    #[test]
    fn item_audio_is_interleaved_stereo_capped_at_ten_seconds() {
        with_tone(|doc, tone| {
            let heard = doc.item_audio(tone, 0.25, 4_800).unwrap();
            assert_eq!(heard.len(), 4_800 * 2);
            assert!(heard.iter().any(|sample| sample.abs() > 0.05), "the tone is audible");
            assert!(heard.chunks(2).all(|pair| pair[0] == pair[1]), "mono doubled");
            assert_eq!(doc.item_audio(tone, 0.0, 48_000 * 20).unwrap().len(), 48_000 * 10 * 2, "at most 10 s");
            assert!(doc.item_audio(tone, 5.0, 4_800).unwrap().iter().all(|sample| *sample == 0.0), "silence past the end");
            assert!(doc.item_audio(9_999, 0.0, 4_800).is_err());
        });
    }

    /// The fixture's placed matte clip and the open document.
    fn with_clip() -> (FilmDocument, u64) {
        let doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let inspected = doc.inspect().unwrap();
        let clip = inspected["sequence"]["video"][0]["items"][0]["clip"].as_u64().unwrap_or_else(|| panic!("no clip in {inspected}"));
        (doc, clip)
    }

    fn param<'a>(effects: &'a Value, effect: &str, id: &str) -> &'a Value {
        let effect = effects["effects"].as_array().unwrap().iter().find(|e| e["id"] == effect).unwrap_or_else(|| panic!("no {effect} in {effects}"));
        effect["params"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap_or_else(|| panic!("no {id} in {effect}"))
    }

    #[test]
    fn clip_effects_list_the_fixed_effects_with_typed_params() {
        let (doc, clip) = with_clip();
        let fx = doc.clip_effects(clip).unwrap();
        assert_eq!(fx["clip"], clip);
        assert_eq!(fx["track"], "video");
        assert_eq!(fx["start"], 0);
        assert_eq!(fx["sourceIn"], 0);
        assert_eq!(fx["speed"], 1.0);
        assert!(fx["duration"].as_i64().unwrap() > 0);
        let effects = fx["effects"].as_array().unwrap();
        let names: Vec<_> = effects.iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names[..3], ["Motion", "Opacity", "Time Remapping"]);
        let motion = &effects[0];
        assert_eq!((motion["index"].as_u64(), motion["id"].as_str()), (Some(0), Some("motion")));
        assert_eq!((motion["enabled"].as_bool(), motion["intrinsic"].as_bool(), motion["kind"].as_str()), (Some(true), Some(true), Some("video")));

        let scale = param(&fx, "motion", "scale");
        assert_eq!(scale["label"], "Scale");
        assert_eq!(scale["kind"], "float");
        assert_eq!((scale["min"].as_f64(), scale["max"].as_f64()), (Some(0.0), Some(10_000.0)));
        assert_eq!((scale["softMin"].as_f64(), scale["softMax"].as_f64()), (Some(0.0), Some(100.0)));
        assert_eq!((scale["unit"].as_str(), scale["decimals"].as_u64()), (Some(""), Some(1)));
        assert_eq!((scale["value"].as_f64(), scale["default"].as_f64()), (Some(100.0), Some(100.0)));
        assert_eq!((scale["animatable"].as_bool(), scale["group"].is_null()), (Some(true), true));
        assert_eq!(scale["keyframes"], json!([]));

        let position = param(&fx, "motion", "position");
        assert_eq!(position["kind"], "point");
        assert_eq!(position["value"], json!([32.0, 18.0]), "placed at the frame's centre");
        assert_eq!(position["default"], json!([null, null]), "auto until placed");
        assert_eq!(param(&fx, "motion", "rotation")["kind"], "angle");
        let uniform = param(&fx, "motion", "uniform_scale");
        assert_eq!((uniform["kind"].as_str(), uniform["value"].as_bool(), uniform["animatable"].as_bool()), (Some("bool"), Some(true), Some(false)));
        let blend = param(&fx, "opacity", "blend");
        assert_eq!((blend["kind"].as_str(), blend["value"].as_u64()), (Some("choice"), Some(0)));
        assert_eq!(blend["choices"][0], "Normal");
        assert_eq!(param(&fx, "opacity", "opacity")["unit"], "%");
    }

    #[test]
    fn clip_effects_follow_edits_and_keyframes() {
        let (mut doc, clip) = with_clip();
        doc.execute("effects.setParam", json!({ "clip": clip, "effect": "opacity", "param": "opacity", "value": 50.0 })).unwrap();
        assert_eq!(param(&doc.clip_effects(clip).unwrap(), "opacity", "opacity")["value"], 50.0);

        let tick = |seconds: f64| Tick::from_seconds_f64(seconds).0;
        for seconds in [0.5, 2.0] {
            doc.execute("effects.addKeyframe", json!({ "clip": clip, "effect": "motion", "param": "scale", "time": tick(seconds) })).unwrap();
        }
        doc.execute("effects.setParam", json!({ "clip": clip, "effect": "motion", "param": "scale", "value": 50.0, "time": tick(2.0) })).unwrap();
        let fx = doc.clip_effects(clip).unwrap();
        let keyframes = param(&fx, "motion", "scale")["keyframes"].as_array().unwrap().clone();
        assert_eq!(keyframes.len(), 2);
        assert_eq!(keyframes[0], json!({ "time": tick(0.5), "value": 100.0, "interpolation": "linear" }));
        assert_eq!(keyframes[1], json!({ "time": tick(2.0), "value": 50.0, "interpolation": "linear" }), "times are media time, as the commands take them");
        doc.execute(
            "effects.setInterpolation",
            json!({ "clip": clip, "effect": "motion", "param": "scale", "mediaTime": tick(0.5), "interpolation": "autoBezier" }),
        )
        .unwrap();
        assert_eq!(param(&doc.clip_effects(clip).unwrap(), "motion", "scale")["keyframes"][0]["interpolation"], "autoBezier");

        // The value is the one at the playhead, as Effect Controls shows it.
        doc.execute("playhead.set", json!({ "seconds": 3.0 })).unwrap();
        let fx = doc.clip_effects(clip).unwrap();
        assert_eq!(fx["mediaTime"], doc.session.playhead().0, "the playhead on a clip at its start, at full speed");
        assert_eq!(param(&fx, "motion", "scale")["value"], 50.0);

        doc.execute("effects.apply", json!({ "clips": [clip], "effect": "tint" })).unwrap();
        doc.execute("effects.setParam", json!({ "clip": clip, "effect": "tint", "param": "black", "value": "#336699" })).unwrap();
        let fx = doc.clip_effects(clip).unwrap();
        let effects = fx["effects"].as_array().unwrap();
        let tint = &effects[3];
        assert_eq!(tint["id"], "tint", "listed after the fixed effects");
        let indexes: Vec<_> = effects.iter().map(|e| e["index"].as_u64().unwrap()).collect();
        assert_eq!(indexes, [1, 2, 3, 0], "each keeps its index on the clip, which the commands take");
        assert_eq!(tint["intrinsic"], false);
        let black = param(&fx, "tint", "black");
        assert_eq!((black["kind"].as_str(), black["value"].as_str(), black["default"].as_str()), (Some("color"), Some("#336699"), Some("#000000")));

        assert!(doc.clip_effects(9_999).is_err(), "an unknown clip");
    }

    #[test]
    fn clip_effects_name_a_lut_reference_as_upstream_param_text_reads_it() {
        let (mut doc, clip) = with_clip();
        doc.execute("effects.apply", json!({ "clips": [clip], "effect": "color" })).unwrap();
        doc.execute("effects.setParam", json!({ "clip": clip, "effect": "color", "param": "look_lut", "value": "builtin:look-teal-orange" })).unwrap();
        let fx = doc.clip_effects(clip).unwrap();
        assert_eq!(param(&fx, "color", "look_lut")["lutLabel"], "Teal & Orange");
        assert_eq!(param(&fx, "color", "input_lut")["lutLabel"], "None");
        assert!(param(&fx, "motion", "scale").get("lutLabel").is_none(), "only LUT references carry one");
    }

    #[test]
    fn source_commands_are_the_ones_the_source_monitor_takes() {
        let ids = FilmDocument::source_commands();
        for id in ["markers.markIn", "markers.goToSplitAudioIn", "markers.clearInOut"] {
            assert!(ids.iter().any(|known| known == id), "{id} in {ids:?}");
        }
        assert!(!ids.iter().any(|known| known == "sequence.lift"));
        assert!(ids.iter().all(|id| kition_film_engine::source_monitor::source_command(id)));
        assert!(ids.iter().all(|id| kition_film_engine::find_command(id).is_some()), "every id is a command");
    }

    /// What each query costs on a real clip: `KITION_FILM_PERF_CLIP=<path to a 1080p clip with
    /// sound> cargo test -p kition-film-kit --lib measures -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs a clip named by KITION_FILM_PERF_CLIP"]
    fn measures_the_queries_on_a_clip() {
        let Some(clip) = std::env::var_os("KITION_FILM_PERF_CLIP").map(std::path::PathBuf::from) else { return };
        let _lock = HOST_ROOT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        kition_kit::host::set_root(clip.parent().map(std::path::Path::to_path_buf));
        let name = clip.file_name().unwrap().to_string_lossy().into_owned();
        let mut doc = FilmDocument::create("Edit.kfilm", 1920, 1080).unwrap();
        let imported = doc.execute("file.import", json!({ "paths": [name] })).unwrap();
        let item = imported["items"][0].as_u64().unwrap();
        doc.execute("timeline.place", json!({ "item": item, "track": "V1", "seconds": 0.0 })).unwrap();
        let timed = |label: &str, run: &mut dyn FnMut()| {
            let started = std::time::Instant::now();
            run();
            eprintln!("{label}: {:?}", started.elapsed());
        };
        timed("itemFrame 320 px, first (index and seek)", &mut || drop(doc.item_frame(item, 0.0, 320).unwrap()));
        for (seconds, width) in [(12.0, 320), (12.5, 320), (20.0, 160), (20.0, 960), (20.0, 1920)] {
            timed(&format!("itemFrame {width} px at {seconds} s"), &mut || {
                let frame = doc.item_frame(item, seconds, width).unwrap();
                assert_eq!(size(&frame).0, width);
            });
        }
        timed("itemPeaks 4 s at 0 s", &mut || assert_eq!(doc.item_peaks(item, 0.0, 4.0).unwrap().len(), 750 * 2));
        timed("itemPeaks 4 s at 24 s", &mut || assert_eq!(doc.item_peaks(item, 24.0, 4.0).unwrap().len(), 750 * 2));
        timed("itemPeaks 4 s at 28 s (end)", &mut || drop(doc.item_peaks(item, 28.0, 4.0).unwrap()));
        timed("itemPeaks 30 s, whole clip", &mut || drop(doc.item_peaks(item, 0.0, 30.0).unwrap()));
        timed("itemAudio 0.5 s at 10 s", &mut || assert!(doc.item_audio(item, 10.0, 24_000).unwrap().iter().any(|v| v.abs() > 0.05)));
        // The Source monitor plays a clip frame after frame at its drawn width: from 5 s, which
        // nothing above has decoded, so the first frame pays for the seek.
        let rate = doc.session.project.item(ItemId(item)).unwrap().frame_rate();
        let first = rate.frame_at(Tick::from_seconds_f64(5.0));
        let times: Vec<std::time::Duration> = (0..30)
            .map(|n| {
                let started = std::time::Instant::now();
                let frame = doc.item_frame(item, rate.tick_of(first + n).seconds(), 960).unwrap();
                assert_eq!(size(&frame).0, 960);
                started.elapsed()
            })
            .collect();
        let steady = times[1..].iter().sum::<std::time::Duration>() / (times.len() as u32 - 1);
        eprintln!(
            "itemFrame 960 px, 30 frames in a row: first {:?}, then {steady:?} a frame on average, slowest {:?}",
            times[0],
            times[1..].iter().max().unwrap()
        );
        let sequence = doc.session.state.active_sequence.unwrap().0;
        timed("itemFrame sequence 320 px", &mut || drop(doc.item_frame(sequence, 5.0, 320).unwrap()));
        doc.execute("playhead.set", json!({ "seconds": 15.0 })).unwrap();
        for scale in [1.0, 0.5, 0.25] {
            doc.set_render_scale(scale).unwrap();
            drop(doc.render(0.0, 0.0, 0.5, 960, 540).unwrap());
            timed(&format!("program render at scale {scale} into 960 x 540"), &mut || drop(doc.render(0.0, 0.0, 0.5, 960, 540).unwrap()));
        }
        kition_kit::host::set_root(None);
    }

    #[test]
    fn a_render_scale_renders_smaller_and_scales_up() {
        let mut doc = FilmDocument::create("Edit.kfilm", 1920, 1080).unwrap();
        let matte = doc.execute("file.newColorMatte", json!({ "color": "#ff0000", "seconds": 4.0 })).unwrap();
        doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0.0 })).unwrap();
        let time = |doc: &FilmDocument| {
            (0..3)
                .map(|_| {
                    let started = std::time::Instant::now();
                    let out = doc.render(0.0, 0.0, 0.5, 960, 540).unwrap();
                    assert_eq!(out.len(), 960 * 540 * 4, "the output size is unchanged");
                    assert_eq!(&out[..4], &[255, 0, 0, 255]);
                    started.elapsed()
                })
                .min()
                .unwrap()
        };
        let full = time(&doc);
        assert_eq!(doc.frame().map(|(_, w, h)| (w, h)), Ok((1920, 1080)));
        doc.set_render_scale(0.5).unwrap();
        assert_eq!(doc.render_scale(), 0.5);
        assert_eq!(doc.frame().map(|(_, w, h)| (w, h)), Ok((960, 540)), "the program renders at half size");
        let half = time(&doc);
        eprintln!("program frame at 1920 x 1080: full {full:?}, half {half:?}");
        let area = doc.render_area(0, 0, 1920, 1080, 480, 270).unwrap();
        assert_eq!(area.len(), 480 * 270 * 4);
        assert_eq!(&area[..4], &[255, 0, 0, 255]);
        assert!(doc.set_render_scale(0.0).is_err());
        assert!(doc.set_render_scale(f32::NAN).is_err());
        assert!(doc.set_render_scale(-0.5).is_err());
        doc.set_render_scale(4.0).unwrap();
        assert_eq!(doc.render_scale(), 1.0, "above 1 is 1");
        // A tiny scale is 1/16, which still draws the picture.
        for tiny in [1e-6, 0.01] {
            doc.set_render_scale(tiny).unwrap();
            assert_eq!(doc.render_scale(), 1.0 / 16.0, "{tiny} is 1/16");
            assert_eq!(doc.frame().map(|(_, w, h)| (w, h)), Ok((120, 68)));
            assert_eq!(&doc.render(0.0, 0.0, 0.5, 960, 540).unwrap()[..4], &[255, 0, 0, 255], "not black at {tiny}");
        }
    }

    fn corners(layer: &Value) -> Vec<(f64, f64)> {
        layer["quad"].as_array().unwrap().iter().map(|p| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap())).collect()
    }

    fn near(a: &[(f64, f64)], b: &[(f64, f64)]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(p, q)| (p.0 - q.0).abs() < 0.01 && (p.1 - q.1).abs() < 0.01)
    }

    #[test]
    fn item_info_is_what_upstreams_info_panel_shows() {
        with_tone(|doc, tone| {
            let info = doc.item_info(tone).unwrap();
            assert_eq!(info["name"], "tone.wav", "{info}");
            assert_eq!(info["type"], "Audio", "{info}");
            assert!(info["video"].is_null() && info["codec"].is_null(), "{info}");
            let audio = info["audio"].as_str().unwrap_or_else(|| panic!("no audio line in {info}"));
            assert_eq!(audio, "48000 Hz - 1 ch - PCM");
            // One second at an audio item's default 23.976 fps is 23 whole frames, as upstream formats it.
            assert_eq!(info["duration"], "00:00:00:23", "{info}");
        });
        let (doc, matte) = with_matte();
        let info = doc.item_info(matte).unwrap();
        assert!(info["video"].as_str().is_some_and(|line| line.contains(" fps, ") && line.ends_with("(1.0000)")), "{info}");
        assert!(doc.item_info(9_999_999).is_err());
    }

    #[test]
    fn graphic_layers_are_the_visible_layers_in_sequence_pixels() {
        let mut doc = FilmDocument::create("Edit.kfilm", 1920, 1080).unwrap();
        assert_eq!(doc.graphic_layers().unwrap(), json!({ "layers": [], "target": null, "selected": null }), "nothing in the picture");
        let text = doc.execute("graphics.newText", json!({ "text": "Hello", "position": [400, 300], "size": 100 })).unwrap();
        let clip = text["clip"].as_u64().unwrap();
        doc.execute("graphics.newShape", json!({ "shape": "rectangle", "clip": clip, "position": [960, 540], "size": [200, 100] })).unwrap();
        let shown = doc.graphic_layers().unwrap();
        let layers = shown["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 2, "{shown}");
        // Front-most first, as upstream's `visible_layers`: the shape went in front of the text.
        assert_eq!((layers[0]["clip"].as_u64(), layers[0]["layer"].as_u64(), layers[0]["kind"].as_str()), (Some(clip), Some(1), Some("shape")));
        assert!(near(&corners(&layers[0]), &[(860.0, 490.0), (1060.0, 490.0), (1060.0, 590.0), (860.0, 590.0)]), "{}", layers[0]);
        let words = &layers[1];
        assert_eq!((words["layer"].as_u64(), words["kind"].as_str(), words["text"].as_str()), (Some(0), Some("text"), Some("Hello")));
        assert_eq!((words["vertical"].as_bool(), words["paragraph"].as_bool(), words["size"].as_f64()), (Some(false), Some(false), Some(100.0)));
        let quad = corners(words);
        assert!(
            quad[0].0 >= 395.0 && quad[0].0 < 420.0 && quad[0].1 < 300.0 && quad[2].0 > 500.0 && quad[2].1 > 280.0,
            "point text sits on its baseline at 400, 300: {quad:?}"
        );
        assert!((words["scale"].as_f64().unwrap() - 1.0).abs() < 1e-9);
        // The new graphic is selected and under the playhead: new layers go into it, on its canvas.
        assert_eq!(shown["target"]["clip"].as_u64(), Some(clip));
        assert_eq!(shown["target"]["matrix"], json!([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]));

        // The clip's Motion moves its layers: 50% about the frame's centre.
        doc.execute("effects.setParam", json!({ "clip": clip, "effect": "motion", "param": "scale", "value": 50.0 })).unwrap();
        let halved = doc.graphic_layers().unwrap();
        assert!(near(&corners(&halved["layers"][0]), &[(910.0, 515.0), (1010.0, 515.0), (1010.0, 565.0), (910.0, 565.0)]), "{}", halved["layers"][0]);
        assert_eq!(halved["target"]["matrix"], json!([0.5, 0.0, 0.0, 0.5, 480.0, 270.0]));
        assert!((halved["layers"][1]["scale"].as_f64().unwrap() - 0.5).abs() < 1e-9);

        // Nothing is selected: no target, the layers still show.
        doc.execute("edit.deselectAll", json!({})).unwrap();
        let unselected = doc.graphic_layers().unwrap();
        assert_eq!((unselected["layers"].as_array().map(Vec::len), unselected["target"].is_null()), (Some(2), true));

        // Past the clip's end nothing is in the picture.
        doc.execute("playhead.set", json!({ "seconds": 10.0 })).unwrap();
        assert_eq!(doc.graphic_layers().unwrap(), json!({ "layers": [], "target": null, "selected": null }));
    }

    #[test]
    fn graphic_layers_carry_what_the_handles_need() {
        let mut doc = FilmDocument::create("Edit.kfilm", 1920, 1080).unwrap();
        let text = doc.execute("graphics.newText", json!({ "text": "Hello", "position": [400, 300], "size": 100 })).unwrap();
        let clip = text["clip"].as_u64().unwrap();
        doc.execute("graphics.newShape", json!({ "shape": "rectangle", "clip": clip, "position": [960, 540], "size": [200, 100] })).unwrap();
        // Paragraph text whose box is too small for its words: the box hides some of them.
        doc.execute("graphics.newText", json!({ "text": "Some words that do not fit", "clip": clip, "position": [100, 700], "box": [120, 40], "size": 60 }))
            .unwrap();
        let unchanged = |doc: &mut FilmDocument| (doc.version().unwrap(), doc.session.execute("history.list", json!({})).unwrap(), doc.session.revision);
        let before = unchanged(&mut doc);
        let shown = doc.graphic_layers().unwrap();
        assert_eq!(unchanged(&mut doc), before, "a read changes nothing");
        let layers = shown["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 3, "{shown}");
        let (paragraph, shape, point) = (&layers[0], &layers[1], &layers[2]);
        // The shape: its box about its own origin, its transform, and both maps at the sequence's own canvas.
        assert_eq!(shape["local"], json!([-100.0, -50.0, 100.0, 50.0]), "{shape}");
        assert_eq!(shape["transform"], json!({ "position": [960.0, 540.0], "anchor": [0.0, 0.0], "scale": [1.0, 1.0] }), "{shape}");
        assert_eq!(shape["toSequence"], json!([1.0, 0.0, 0.0, 1.0, 960.0, 540.0]), "{shape}");
        assert_eq!(shape["canvas"], json!([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]), "{shape}");
        assert!(shape.get("box").is_none() && shape.get("overflow").is_none(), "a shape has no text box: {shape}");
        // Point text: no box; not selected, so its overflow is not laid out.
        assert_eq!((point["box"].clone(), point["overflow"].clone()), (json!([0.0, 0.0]), Value::Null), "{point}");
        assert_eq!(point["transform"]["position"], json!([400.0, 300.0]), "{point}");
        // Paragraph text: its box, and the words it hides.
        assert_eq!(
            (paragraph["paragraph"].as_bool(), paragraph["box"].clone(), paragraph["overflow"].as_bool()),
            (Some(true), json!([120.0, 40.0]), Some(true)),
            "{paragraph}"
        );
        // As upstream, the words a box hides are laid out only for a selected layer (its red plus):
        // with only the point text selected, the paragraph's overflow is not computed.
        doc.execute("graphics.selectLayer", json!({ "clip": clip, "layers": [0] })).unwrap();
        let point_only = doc.graphic_layers().unwrap();
        assert!(point_only["layers"][0]["overflow"].is_null(), "{}", point_only["layers"][0]);
        assert_eq!(point_only["layers"][2]["overflow"].as_bool(), Some(false), "the selected point text: {}", point_only["layers"][2]);
        doc.execute("graphics.selectLayer", json!({ "clip": clip, "layers": [2] })).unwrap();
        // Each corner of the quad is the local box mapped by toSequence.
        let m: Vec<f64> = shape["toSequence"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let l: Vec<f64> = shape["local"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let mapped = [(l[0], l[1]), (l[2], l[1]), (l[2], l[3]), (l[0], l[3])].map(|(x, y)| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
        assert!(near(&corners(shape), &mapped), "{shape}");

        // The clip's Motion at 50% about the frame's centre: the canvas map takes it, and the layer's map composes it.
        doc.execute("effects.setParam", json!({ "clip": clip, "effect": "motion", "param": "scale", "value": 50.0 })).unwrap();
        let halved = doc.graphic_layers().unwrap();
        let shape = &halved["layers"][1];
        assert_eq!(shape["canvas"], json!([0.5, 0.0, 0.0, 0.5, 480.0, 270.0]), "{shape}");
        assert_eq!(shape["toSequence"], json!([0.5, 0.0, 0.0, 0.5, 960.0, 540.0]), "{shape}");
        assert_eq!(shape["transform"]["position"], json!([960.0, 540.0]), "the layer's own transform is unchanged: {shape}");
    }

    #[test]
    fn the_target_is_the_first_selected_graphic_only_while_it_is_under_the_playhead() {
        let mut doc = FilmDocument::create("Edit.kfilm", 1920, 1080).unwrap();
        let tick = |seconds: f64| Tick::from_seconds_f64(seconds).0;
        // One graphic from 0 s to 2 s, another from 4 s to 6 s.
        let early = doc.execute("graphics.newText", json!({ "text": "Early", "seconds": 2.0, "time": tick(0.0) })).unwrap()["clip"].as_u64().unwrap();
        let late = doc.execute("graphics.newShape", json!({ "shape": "rectangle", "seconds": 2.0, "time": tick(4.0) })).unwrap()["clip"].as_u64().unwrap();
        doc.execute("timeline.select", json!({ "clips": [early, late] })).unwrap();
        doc.execute("playhead.set", json!({ "seconds": 5.0 })).unwrap();
        let shown = doc.graphic_layers().unwrap();
        assert_eq!(shown["layers"].as_array().map(Vec::len), Some(1), "the late shape is in the picture: {shown}");
        // Upstream's `selected_graphic` is the first selected graphic; it is not under the playhead, so `canvas_target` has none.
        assert!(shown["target"].is_null(), "{shown}");
        assert_eq!(shown["selected"]["clip"].as_u64(), Some(early));
        doc.execute("playhead.set", json!({ "seconds": 1.0 })).unwrap();
        assert_eq!(doc.graphic_layers().unwrap()["target"]["clip"].as_u64(), Some(early));
        // The selected layers come with the selected graphic.
        doc.execute("graphics.selectLayer", json!({ "clip": early, "layers": [0] })).unwrap();
        assert_eq!(doc.graphic_layers().unwrap()["selected"], json!({ "clip": early, "layers": [0] }));
    }

    #[test]
    fn take_events_drains_toasts_once_and_leaves_out_project_changes() {
        let mut doc = FilmDocument::create("Edit.kfilm", 64, 36).unwrap();
        // Creating the project changed it, and opened its sequence in the Timeline.
        let opened = doc.take_events();
        assert!(opened.as_array().unwrap().iter().all(|event| event["kind"] != "projectChanged"), "{opened}");
        doc.execute("audio.toggleScrubbing", json!({})).unwrap();
        let events = doc.take_events();
        assert_eq!(events, json!([{ "kind": "toast", "message": "Audio during scrubbing off", "error": false }]));
        assert_eq!(doc.take_events(), json!([]), "a second call finds the queue empty");
        doc.execute("audio.toggleScrubbing", json!({})).unwrap();
        doc.execute("audio.toggleScrubbing", json!({})).unwrap();
        let both = doc.take_events();
        assert_eq!(both.as_array().map(Vec::len), Some(2), "oldest first: {both}");
        assert_eq!(both[0]["message"], "Audio during scrubbing on");
    }

    #[test]
    fn take_events_names_the_panels_to_show() {
        let (mut doc, matte) = with_matte();
        let _ = doc.take_events();
        // Match Frame opens the clip under the playhead in the Source monitor.
        doc.execute("playhead.set", json!({ "seconds": 1.0 })).unwrap();
        doc.execute("sequence.matchFrame", json!({})).unwrap();
        assert_eq!(doc.take_events(), json!([{ "kind": "openSource", "item": matte }]));
        // A new sequence opens in the Timeline.
        doc.execute("file.newSequence", json!({ "name": "Second" })).unwrap();
        let sequence = doc.session.state.active_sequence.unwrap().0;
        let opened = doc.take_events();
        assert!(opened.as_array().unwrap().contains(&json!({ "kind": "openSequence", "item": sequence })), "{opened}");
        // Reveal Sequence in Project names the active sequence.
        doc.execute("sequence.revealInProject", json!({})).unwrap();
        assert_eq!(doc.take_events(), json!([{ "kind": "revealInProject", "item": sequence }]));
    }
}
