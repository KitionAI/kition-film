//! `file.render`, the kit's agent preview (`agent.render` in kit.json; KHP A24, A39): what the
//! Program monitor shows of an explicit sequence at an explicit time, or a contact sheet of frames
//! over a range, each labelled with its time. It is a function of the project and the call alone:
//! it never reads or moves the playhead, never opens a sequence, never selects, and never makes
//! the document dirty, so the same call answers the same picture whatever the editor is doing.
//!
//! Which sequence: `target.sequence` (its item id), or `sequence:<id>` in a diagnostic's
//! `target.path`; without one, the project's main sequence, the only sequence no other sequence
//! holds (a nested sequence is part of the one it is in). A project with several such sequences
//! has no main one, and the call must name it; the refusal lists them.

use kition_film_engine::Session;
use kition_film_engine::project::{ClipId, ItemId, Project, Sequence};
use kition_film_engine::render::image::Image;
use kition_film_time::Tick;
use kition_kit::KitCommand;
use kition_kit::schema::{ParamError, refusal};
use serde_json::{Value, json};

/// The command's id.
pub const RENDER: &str = "file.render";

/// The largest `scale` (picture pixels per sequence pixel), and `maxSize`'s range and default
/// (pixels on the picture's longer side).
const MAX_SCALE: f64 = 2.0;
const MIN_SIZE: u64 = 16;
const MAX_SIZE: u64 = 4096;
const DEFAULT_SIZE: u64 = 1024;
/// How many frames a contact sheet holds, and how many a whole sequence's preview shows.
const MIN_FRAMES: u64 = 2;
const MAX_FRAMES: u64 = 12;
const WHOLE_FRAMES: u64 = 6;
/// Black pixels between a contact sheet's frames.
const GAP: u32 = 2;
/// Seconds an agent may name (well beyond any sequence, well within a tick count).
const MAX_SECONDS: f64 = 1.0e7;

/// The command as the catalog lists it.
pub fn command() -> KitCommand {
    KitCommand {
        id: RENDER.to_owned(),
        title: "Render Preview".to_owned(),
        description: "Renders what the Program monitor shows of a sequence at a time, as a PNG, without moving the playhead or opening the sequence: `target.time` (seconds from the sequence's start) for one frame, or `target.range` [from, to] with `target.frames` (2 to 12) for a contact sheet of frames laid out in a grid, each labelled with its time. `target.sequence` names the sequence by its item id; without it, the project's main sequence (the only one no other sequence holds). Without a target it answers a contact sheet of the whole sequence. Changes nothing.".to_owned(),
        params: Some(
            "{target?: {time?: seconds, sequence?: item id, range?: [from, to] seconds, frames?: 2-12, path?: \"sequence:<id>[/clip:<id>]\"}, scale?: >0-2 (default 1), maxSize?: 16-4096 (default 1024)} → {png (base64), mimeType, width, height, scale, sequence, frames: [{time, frame, label}], columns, rows}".to_owned(),
        ),
        schema: Some(json!({
            "target": {
                "type": "object",
                "additionalProperties": false,
                "description": "What to show. `time` alone shows one frame; `range` with `frames` a contact sheet; neither, the whole sequence as a contact sheet.",
                "properties": {
                    "time": { "type": "number", "description": "Seconds from the start of the sequence, from 0 to before its end. The frame showing at that time is drawn." },
                    "sequence": { "type": "integer", "description": "The sequence's item id (`item` in the project's items). Needed when the project has several sequences that no other sequence holds." },
                    "range": { "type": "array", "items": { "type": "number" }, "description": "[from, to]: seconds from the start of the sequence, from < to, within it. The frames are spread evenly from `from` to `to`, both included; `to` at the sequence's end shows its last frame." },
                    "frames": { "type": "integer", "description": "How many frames the contact sheet of `range` shows, 2 to 12 (default 6)." },
                    "path": { "type": "string", "description": "A diagnostic's target: `sequence:<id>` names the sequence, `sequence:<id>/clip:<id>` shows the middle of that clip unless `time` or `range` is given." },
                },
            },
            "scale": { "type": "number", "description": "Picture pixels per sequence pixel, above 0 and at most 2 (default 1). A contact sheet's frames are each drawn at this scale. Reduced so the picture fits `maxSize`." },
            "maxSize": { "type": "integer", "description": "The most pixels on the picture's longer side, 16 to 4096 (default 1024)." },
        })),
        output_schema: Some(json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "png": { "type": "string", "required": true, "description": "The picture as base64 PNG." },
                "mimeType": { "type": "string", "required": true },
                "width": { "type": "integer", "required": true },
                "height": { "type": "integer", "required": true },
                "scale": { "type": "number", "required": true, "description": "The scale each frame was drawn at, after `maxSize`." },
                "sequence": { "type": "integer", "required": true, "description": "The sequence drawn." },
                "frames": { "type": "array", "required": true, "items": { "type": "json" }, "description": "Each frame drawn, in reading order: {time (seconds at the frame's start), frame (counted from 0), label}." },
                "columns": { "type": "integer", "required": true },
                "rows": { "type": "integer", "required": true },
            },
        })),
        mutates: false,
        enabled: true,
        ..Default::default()
    }
}

/// A refusal of the parameter at `path` (a JSON Pointer), typed for the host (`invalid_params`).
fn wrong(path: &str, message: String, expected: &str) -> String {
    refusal(&[ParamError { path: path.to_owned(), message, expected: expected.to_owned() }])
}

/// Seconds as a short label: at most three decimals, no trailing zeros.
fn seconds(t: Tick) -> String {
    let text = format!("{:.3}", t.seconds());
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" { "0".to_owned() } else { text.to_owned() }
}

/// The sequences, by id, with their names and lengths, for a refusal.
fn listing(project: &Project, ids: &[ItemId]) -> String {
    ids.iter()
        .map(|id| {
            let name = project.item(*id).map_or("", |item| item.name.as_str());
            let length = project.sequence(*id).map_or(Tick::ZERO, Sequence::duration);
            format!("{} \"{name}\" ({} s)", id.0, seconds(length))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn all_sequences(project: &Project) -> Vec<ItemId> {
    project.sequences().map(|item| item.id).collect()
}

/// The sequences no other sequence holds as a clip.
fn top_level(project: &Project) -> Vec<ItemId> {
    let ids = all_sequences(project);
    let nested: std::collections::BTreeSet<ItemId> = ids
        .iter()
        .filter_map(|id| Some((*id, project.sequence(*id)?)))
        .flat_map(|(id, seq)| seq.all_tracks().flat_map(|track| track.items.iter()).map(|clip| clip.item).filter(move |item| *item != id))
        .filter(|item| project.sequence(*item).is_some())
        .collect();
    ids.into_iter().filter(|id| !nested.contains(id)).collect()
}

/// The main sequence: the only one no other sequence holds.
fn main_sequence(project: &Project) -> Result<ItemId, String> {
    let top = top_level(project);
    match top[..] {
        [one] => Ok(one),
        [] if all_sequences(project).is_empty() => {
            Err(wrong("/target/sequence", "the project has no sequence to render: make one with file.newSequence".to_owned(), "a sequence's item id"))
        }
        _ => {
            let candidates = if top.is_empty() { all_sequences(project) } else { top };
            Err(wrong(
                "/target/sequence",
                format!(
                    "the project has {} sequences that no other sequence holds, so none is its main one: pass `target.sequence`, one of {}",
                    candidates.len(),
                    listing(project, &candidates)
                ),
                "a sequence's item id",
            ))
        }
    }
}

fn number(value: &Value, path: &str, what: &str) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.abs() <= MAX_SECONDS)
        .ok_or_else(|| wrong(path, format!("`{}` is {value}: {what}", path.trim_start_matches('/').replace('/', ".")), what))
}

fn whole(value: &Value, path: &str, what: &str) -> Result<u64, String> {
    value
        .as_u64()
        .or_else(|| value.as_f64().filter(|n| n.fract() == 0.0 && (0.0..=9.0e15).contains(n)).map(|n| n as u64))
        .ok_or_else(|| wrong(path, format!("`{}` is {value}: {what}", path.trim_start_matches('/').replace('/', ".")), what))
}

/// `sequence:<id>` or `sequence:<id>/clip:<id>`.
fn parse_path(path: &str) -> Result<(ItemId, Option<ClipId>), String> {
    let refuse = || {
        wrong(
            "/target/path",
            format!(
                "`target.path` is {path:?}: this kit draws a sequence's frames, named `sequence:<id>` or `sequence:<id>/clip:<id>` (a diagnostic's target); for another target pass `target.sequence` and `target.time`"
            ),
            "sequence:<id>[/clip:<id>]",
        )
    };
    let (sequence, clip) = match path.split_once('/') {
        Some((sequence, clip)) => (sequence, Some(clip)),
        None => (path, None),
    };
    let sequence = sequence.strip_prefix("sequence:").and_then(|id| id.parse().ok()).map(ItemId).ok_or_else(refuse)?;
    let clip = match clip {
        Some(clip) => Some(clip.strip_prefix("clip:").and_then(|id| id.parse().ok()).map(ClipId).ok_or_else(refuse)?),
        None => None,
    };
    Ok((sequence, clip))
}

/// What a call asks for: the sequence and the times of its frames (one, or a contact sheet's).
struct View {
    sequence: ItemId,
    times: Vec<Tick>,
    sheet: bool,
}

/// `seconds` as a time on `seq`, from 0 to before its end (0 on an empty sequence).
fn time_on(seq: &Sequence, id: ItemId, name: &str, seconds_given: f64, path: &str) -> Result<Tick, String> {
    let duration = seq.duration();
    let t = Tick::from_seconds_f64(seconds_given);
    if t >= Tick::ZERO && (t < duration || (t == Tick::ZERO && duration == Tick::ZERO)) {
        return Ok(t);
    }
    let message = if duration <= Tick::ZERO {
        format!("{} s is outside sequence {} \"{name}\", which is empty: its only frame is at 0 s", seconds_given, id.0)
    } else {
        let last = seq.settings.frame_rate.snap(duration - Tick(1));
        format!(
            "{} s is outside sequence {} \"{name}\", which runs from 0 to {} s: pass a time from 0 to {} s (where its last frame starts)",
            seconds_given,
            id.0,
            seconds(duration),
            seconds(last)
        )
    };
    Err(wrong(path, message, "seconds from the start of the sequence"))
}

/// `n` times spread evenly from `from` to `to`, both included; a time at the sequence's end is
/// its last frame.
fn spread(from: Tick, to: Tick, n: u64, duration: Tick) -> Vec<Tick> {
    let span = i128::from(to.0) - i128::from(from.0);
    let steps = i128::from(n.saturating_sub(1).max(1));
    (0..n)
        .map(|i| {
            let t = i128::from(from.0) + span * i128::from(i) / steps;
            let t = Tick(i64::try_from(t).unwrap_or(i64::MAX));
            if t >= duration { Tick((duration.0 - 1).max(0)) } else { t }
        })
        .collect()
}

fn view(project: &Project, params: &Value) -> Result<View, String> {
    let target = match params.get("target") {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(target)) => target.clone(),
        Some(other) => return Err(wrong("/target", format!("`target` is {other}: an object such as {{\"time\": 1.5}}"), "an object")),
    };
    const KEYS: [&str; 5] = ["time", "sequence", "range", "frames", "path"];
    if let Some(key) = target.keys().find(|key| !KEYS.contains(&key.as_str())) {
        return Err(wrong(
            &format!("/target/{key}"),
            format!("this kit draws a sequence's frames and takes no `target.{key}`: it takes `time`, `sequence`, `range`, `frames` and `path`"),
            "time, sequence, range, frames or path",
        ));
    }
    let named = target.get("sequence").filter(|v| !v.is_null()).map(|v| whole(v, "/target/sequence", "a sequence's item id")).transpose()?.map(ItemId);
    let (from_path, clip) = match target.get("path").filter(|v| !v.is_null()) {
        Some(Value::String(path)) => {
            let (sequence, clip) = parse_path(path)?;
            (Some(sequence), clip)
        }
        Some(other) => return Err(wrong("/target/path", format!("`target.path` is {other}: a string such as \"sequence:7\""), "sequence:<id>[/clip:<id>]")),
        None => (None, None),
    };
    if let (Some(a), Some(b)) = (named, from_path)
        && a != b
    {
        return Err(wrong("/target/sequence", format!("`target.sequence` {} and `target.path` name different sequences ({})", a.0, b.0), "one sequence"));
    }
    let sequence = match named.or(from_path) {
        Some(id) => {
            if project.sequence(id).is_none() {
                return Err(wrong(
                    "/target/sequence",
                    format!("there is no sequence {}: the project's sequences are {}", id.0, listing(project, &all_sequences(project))),
                    "a sequence's item id",
                ));
            }
            id
        }
        None => main_sequence(project)?,
    };
    let Some(seq) = project.sequence(sequence) else {
        return Err(wrong("/target/sequence", format!("there is no sequence {}", sequence.0), "a sequence's item id"));
    };
    let name = project.item(sequence).map_or("", |item| item.name.as_str());
    let duration = seq.duration();
    let time = target.get("time").filter(|v| !v.is_null());
    let range = target.get("range").filter(|v| !v.is_null());
    let frames = target.get("frames").filter(|v| !v.is_null());
    if time.is_some() && range.is_some() {
        return Err(wrong("/target/time", "give `time` for one frame, or `range` (with `frames`) for a contact sheet, not both".to_owned(), "time or range"));
    }
    if frames.is_some() && range.is_none() {
        return Err(wrong("/target/frames", "`frames` counts the frames of a `range`: give `range` [from, to] too".to_owned(), "range"));
    }
    if let Some(time) = time {
        let t = time_on(seq, sequence, name, number(time, "/target/time", "seconds from the start of the sequence")?, "/target/time")?;
        return Ok(View { sequence, times: vec![t], sheet: false });
    }
    if let Some(range) = range {
        let ends = range
            .as_array()
            .filter(|ends| ends.len() == 2)
            .ok_or_else(|| wrong("/target/range", format!("`target.range` is {range}: [from, to] in seconds from the start of the sequence"), "[from, to]"))?;
        let from = number(&ends[0], "/target/range", "[from, to] in seconds")?;
        let to = number(&ends[1], "/target/range", "[from, to] in seconds")?;
        let (a, b) = (Tick::from_seconds_f64(from), Tick::from_seconds_f64(to));
        if !(a >= Tick::ZERO && a < b && b <= duration) {
            return Err(wrong(
                "/target/range",
                format!(
                    "`target.range` [{from}, {to}] is not a span of sequence {} \"{name}\", which runs from 0 to {} s: pass 0 <= from < to <= {}",
                    sequence.0,
                    seconds(duration),
                    seconds(duration)
                ),
                "[from, to] within the sequence",
            ));
        }
        let n = match frames {
            Some(frames) => whole(frames, "/target/frames", "a whole number from 2 to 12")?,
            None => WHOLE_FRAMES,
        };
        if !(MIN_FRAMES..=MAX_FRAMES).contains(&n) {
            return Err(wrong("/target/frames", format!("`target.frames` is {n}: a contact sheet shows {MIN_FRAMES} to {MAX_FRAMES} frames"), "2 to 12"));
        }
        return Ok(View { sequence, times: spread(a, b, n, duration), sheet: true });
    }
    if let Some(clip) = clip {
        let Some(item) = seq.all_tracks().flat_map(|track| track.items.iter()).find(|item| item.id == clip) else {
            return Err(wrong("/target/path", format!("sequence {} \"{name}\" has no clip {}", sequence.0, clip.0), "a clip of the sequence"));
        };
        let middle = Tick(item.start.0.saturating_add(item.duration.0 / 2));
        let t = if middle >= duration { Tick((duration.0 - 1).max(0)) } else { middle.max(Tick::ZERO) };
        return Ok(View { sequence, times: vec![t], sheet: false });
    }
    // The whole sequence: a contact sheet of it, or its one frame.
    let count = if duration > Tick::ZERO { u64::try_from(seq.settings.frame_rate.frame_at(duration - Tick(1))).unwrap_or(0).saturating_add(1) } else { 1 };
    let n = count.min(WHOLE_FRAMES);
    if n < MIN_FRAMES {
        return Ok(View { sequence, times: vec![Tick::ZERO], sheet: false });
    }
    Ok(View { sequence, times: spread(Tick::ZERO, duration, n, duration), sheet: true })
}

fn scale_of(params: &Value) -> Result<f64, String> {
    match params.get("scale") {
        None | Some(Value::Null) => Ok(1.0),
        Some(value) => value.as_f64().filter(|s| s.is_finite() && *s > 0.0 && *s <= MAX_SCALE).ok_or_else(|| {
            wrong("/scale", format!("`scale` is {value}: picture pixels per sequence pixel, above 0 and at most {MAX_SCALE}"), "above 0, at most 2")
        }),
    }
}

fn max_size_of(params: &Value) -> Result<u64, String> {
    match params.get("maxSize") {
        None | Some(Value::Null) => Ok(DEFAULT_SIZE),
        Some(value) => value.as_u64().filter(|size| (MIN_SIZE..=MAX_SIZE).contains(size)).ok_or_else(|| {
            wrong("/maxSize", format!("`maxSize` is {value}: the most pixels on the picture's longer side, {MIN_SIZE} to {MAX_SIZE}"), "16 to 4096")
        }),
    }
}

/// One frame of `sequence` at `t` and `scale`, as opaque sRGB RGBA8, with `label` burned in when
/// given.
fn frame(session: &Session, sequence: ItemId, scale: f64, t: Tick, label: Option<&str>) -> Result<(Vec<u8>, u32, u32), String> {
    let mut image: Image = session.try_render_sequence_at(sequence, scale as f32, t).map_err(|error| error.to_string())?;
    if let Some(label) = label {
        kition_film_engine::render::label::burn_label(&mut image, label);
    }
    let (w, h) = (u32::try_from(image.w).map_err(|_| "frame too wide")?, u32::try_from(image.h).map_err(|_| "frame too tall")?);
    Ok((image.over_black_rgba8(), w, h))
}

/// Runs `file.render` on `session`'s project: see the module.
pub fn render(session: &Session, params: &Value) -> Result<Value, String> {
    let scale = scale_of(params)?;
    let max_size = max_size_of(params)? as f64;
    let project = &session.project;
    let view = view(project, params)?;
    let Some(seq) = project.sequence(view.sequence) else { return Err(format!("there is no sequence {}", view.sequence.0)) };
    let rate = seq.settings.frame_rate;
    let (sw, sh) = (f64::from(seq.settings.width.max(1)), f64::from(seq.settings.height.max(1)));
    let count = view.times.len().max(1);
    let columns = if view.sheet { (count as f64).sqrt().ceil().max(1.0) as usize } else { 1 };
    let rows = count.div_ceil(columns);
    // Room for the gaps, and a pixel per frame for rounding, within maxSize.
    let room = |cells: usize| max_size - f64::from(GAP) * (cells.saturating_sub(1)) as f64 - if view.sheet { cells as f64 } else { 0.0 };
    let fitted = scale.min(room(columns) / (columns as f64 * sw)).min(room(rows) / (rows as f64 * sh));
    if !(fitted.is_finite() && fitted > 0.0) {
        return Err(wrong("/maxSize", format!("`maxSize` {max_size} is too small for {count} frames: give a larger one"), "a larger maxSize"));
    }
    let frames: Vec<Value> = view
        .times
        .iter()
        .map(|t| {
            let at = rate.snap(*t);
            json!({ "time": at.seconds(), "frame": rate.frame_at(at), "label": format!("{} s", seconds(at)) })
        })
        .collect();
    let (rgba, width, height) = if view.sheet {
        let mut cells = Vec::with_capacity(count);
        for (t, info) in view.times.iter().zip(&frames) {
            cells.push(frame(session, view.sequence, fitted, *t, info["label"].as_str())?);
        }
        let (cw, ch) = cells.first().map_or((1, 1), |(_, w, h)| (*w, *h));
        let width = cw.saturating_mul(columns as u32).saturating_add(GAP.saturating_mul(columns as u32 - 1));
        let height = ch.saturating_mul(rows as u32).saturating_add(GAP.saturating_mul(rows as u32 - 1));
        let mut sheet = [0u8, 0, 0, 255].repeat(width as usize * height as usize);
        for (index, (pixels, w, h)) in cells.iter().enumerate() {
            let (x0, y0) = ((index % columns) as u32 * (cw + GAP), (index / columns) as u32 * (ch + GAP));
            for y in 0..(*h).min(height.saturating_sub(y0)) {
                let row = (y * w * 4) as usize;
                let take = ((*w).min(width.saturating_sub(x0)) * 4) as usize;
                let at = (((y0 + y) * width + x0) * 4) as usize;
                if let (Some(to), Some(from)) = (sheet.get_mut(at..at + take), pixels.get(row..row + take)) {
                    to.copy_from_slice(from);
                }
            }
        }
        (sheet, width, height)
    } else {
        let t = view.times.first().copied().unwrap_or(Tick::ZERO);
        frame(session, view.sequence, fitted, t, None)?
    };
    let png = kition_film_engine::export::encode_png(rgba, width, height).map_err(|error| error.to_string())?;
    Ok(json!({
        "png": kition_film_engine::project::gtemplate::base64_encode(&png),
        "mimeType": "image/png",
        "width": width,
        "height": height,
        "scale": fitted,
        "sequence": view.sequence.0,
        "frames": frames,
        "columns": columns,
        "rows": rows,
    }))
}
