//! Read-only picture data for the colour panels: Scopes as numbers ([`FilmDocument::scopes`],
//! what `scopes.read` answers) and as the trace images upstream's panel draws
//! ([`FilmDocument::scope_images`]), the Effects panel's color preset thumbnails
//! ([`FilmDocument::color_preset_thumbnails`]). Each answer is bounded: nothing renders more
//! than [`MAX_ITEM_FRAME_PIXELS`], and no answer holds more pixels than that.

use kition_film_engine::Session;
use kition_film_engine::project::Sequence;
use kition_film_engine::render::color_presets::{self, ColorPreset};
use kition_film_engine::time::Tick;
use kition_film_scopes::{self as sc, Brightness, ColorSpace, ParadeType, Params, Scale, ScopeKind, WaveformType};
use serde_json::{Map, Value, json};

use crate::FilmDocument;
use crate::panels::MAX_ITEM_FRAME_PIXELS;

/// The widest color preset thumbnail (upstream draws them 64 and 160 wide).
pub const MAX_THUMBNAIL_WIDTH: u32 = 640;

/// The most thumbnails one [`FilmDocument::color_preset_thumbnails`] call renders: a call holds
/// the engine's worker, so the page asks for the rows it shows a few at a time.
pub const MAX_THUMBNAILS: usize = 8;

/// Upstream's scopes read the Program monitor's quarter-resolution frame, and an eighth for the
/// working-space render of HDR scopes (`panels/scopes.rs` `frame_signal`).
const SCOPE_SCALE: f32 = 0.25;
const SCOPE_SCALE_HDR: f32 = 0.125;

/// `scale` lowered so a `width × height` sequence renders at most [`MAX_ITEM_FRAME_PIXELS`].
fn capped_scale(width: u32, height: u32, scale: f32) -> f32 {
    let pixels = f64::from(width.max(1)) * f64::from(height.max(1));
    let most = (MAX_ITEM_FRAME_PIXELS as f64 / pixels).sqrt() as f32;
    scale.min(most)
}

/// Seconds from the page as the `seconds` a command reads: negative and non-finite are 0.
fn page_seconds(seconds: f64) -> f64 {
    if seconds.is_finite() { seconds.max(0.0) } else { 0.0 }
}

const NOT_A_LIST: &str = "scopes is not a list of scope names";

fn object(params: Value) -> Result<Map<String, Value>, String> {
    match params {
        Value::Object(map) => Ok(map),
        Value::Null => Ok(Map::new()),
        other => Err(format!("params are not an object: {other}")),
    }
}

fn active(session: &Session) -> Result<&Sequence, String> {
    session.active_sequence().ok_or_else(|| "no sequence is open".to_owned())
}

/// Upstream's trace colours (`panels/scopes.rs`).
const RED: [f32; 3] = [1.0, 0.16, 0.16];
const GREEN: [f32; 3] = [0.16, 1.0, 0.16];
const BLUE: [f32; 3] = [0.3, 0.38, 1.0];
const WHITE: [f32; 3] = [0.85, 0.85, 0.85];
const LUMA: [f32; 3] = [0.55, 1.0, 0.7];

fn trace_color(name: &str, waveform: Option<WaveformType>) -> [f32; 3] {
    match (name, waveform) {
        ("R", _) => RED,
        ("G", _) => GREEN,
        ("B" | "Cb" | "C", _) => BLUE,
        ("Cr", _) => [1.0, 0.45, 0.45],
        ("Y", Some(WaveformType::Luma)) => WHITE,
        ("Y", Some(_)) => LUMA,
        _ => WHITE,
    }
}

/// The parade's traces side by side in one image (upstream `parade_image`).
fn parade_image(w: &sc::Waveform, gain: f32) -> (usize, usize, Vec<u8>) {
    let n = w.traces.len();
    let Some(first) = w.traces.first() else { return (0, 0, Vec::new()) };
    let (cw, rows) = (first.cols, first.rows);
    let gap = (cw / 24).max(2);
    let width = cw * n + gap * (n - 1);
    let mut out = vec![0u8; width * rows * 4];
    for (i, g) in w.traces.iter().enumerate() {
        let (_, _, px) = sc::paint::grids(&[(g, trace_color(g.name, None))], sc::paint::waveform_reference(w.per_column), gain);
        let x0 = i * (cw + gap);
        for y in 0..rows {
            out[(y * width + x0) * 4..(y * width + x0 + cw) * 4].copy_from_slice(&px[y * cw * 4..(y + 1) * cw * 4]);
        }
    }
    (width, rows, out)
}

/// The histogram as an image: levels bottom to top, counts to the right, R, G, and B added
/// (upstream `histogram_image`).
fn histogram_image(h: &sc::Histogram, gain: f32) -> (usize, usize, Vec<u8>) {
    let (w, rows) = (256usize, sc::BINS);
    let max = h.r.iter().chain(&h.g).chain(&h.b).copied().max().unwrap_or(0).max(1) as f32;
    let len = |c: u32| ((c as f32 / max).sqrt() * w as f32).round() as usize;
    let mut out = vec![0u8; w * rows * 4];
    for bin in 0..rows {
        let y = rows - 1 - bin;
        let (lr, lg, lb) = (len(h.r[bin]), len(h.g[bin]), len(h.b[bin]));
        for x in 0..w {
            let c = [if x < lr { RED } else { [0.0; 3] }, if x < lg { GREEN } else { [0.0; 3] }, if x < lb { BLUE } else { [0.0; 3] }];
            let s = [c[0][0] + c[1][0] + c[2][0], c[0][1] + c[1][1] + c[2][1], c[0][2] + c[1][2] + c[2][2]].map(|v| (v * 0.75 * gain).min(1.0));
            let a = s[0].max(s[1]).max(s[2]);
            if a > 0.0 {
                out[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[
                    (s[0] * 255.0) as u8,
                    (s[1] * 255.0) as u8,
                    (s[2] * 255.0) as u8,
                    (a * 255.0) as u8,
                ]);
            }
        }
    }
    (w, rows, out)
}

/// Premultiplied RGBA8 (upstream's textures) as straight RGBA8, what a canvas `ImageData` takes.
fn straight(px: &mut [u8]) {
    for p in px.as_chunks_mut::<4>().0 {
        let a = u32::from(p[3]);
        if a > 0 && a < 255 {
            for c in &mut p[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

/// A named setting of the scope images: absent is the default; an unknown name is an error.
fn setting<T>(p: &Map<String, Value>, key: &str, parse: impl Fn(&str) -> Option<T>, default: T) -> Result<T, String> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::String(name)) => parse(name).ok_or_else(|| format!("unknown {key} `{name}`")),
        Some(other) => Err(format!("{key} is not a name: {other}")),
    }
}

fn named<T: Copy>(all: &[T], label: impl Fn(T) -> String) -> impl Fn(&str) -> Option<T> {
    move |name: &str| {
        let norm = |s: &str| s.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase();
        all.iter().copied().find(|k| norm(&label(*k)) == norm(name))
    }
}

impl FilmDocument {
    /// Scopes as numbers: exactly what `scopes.read` answers for `params` (`scopes`,
    /// `waveformType`, `paradeType`, `colorSpace`, `clamp`, `columns` 1–512, `peaks`, `bins`,
    /// `scale`), at `seconds` of the active sequence (snapped to its frame; any `time`, `frame`,
    /// or `timecode` in `params` is ignored), without the command path: it changes nothing. The
    /// render `scale` defaults to 0.25, the quarter frame upstream's panel reads (`scopes.read`'s
    /// own default is 0.5), and is lowered so the frame read is at most
    /// [`MAX_ITEM_FRAME_PIXELS`]. It is for numbers on demand, not a read per frame: the panel
    /// draws from [`Self::scope_images`]. An error without an open sequence, or for a `scopes`
    /// that is not a list.
    pub fn scopes(&self, seconds: f64, params: Value) -> Result<Value, String> {
        let sequence = active(&self.session)?;
        let mut p = object(params)?;
        for key in ["time", "frame", "timecode", "seconds"] {
            p.remove(key);
        }
        p.insert("seconds".into(), json!(page_seconds(seconds)));
        if p.get("scopes").is_some_and(|scopes| !scopes.is_array() && !scopes.is_null()) {
            return Err(NOT_A_LIST.to_owned());
        }
        let scale = p.get("scale").and_then(Value::as_f64).unwrap_or(f64::from(SCOPE_SCALE)).clamp(1.0 / 32.0, 1.0) as f32;
        p.insert("scale".into(), json!(capped_scale(sequence.settings.width, sequence.settings.height, scale)));
        kition_film_engine::scopes::read(&self.session, &Value::Object(p)).map_err(|error| error.to_string())
    }

    /// Scopes as upstream's panel draws them (`panels/scopes.rs` `draw_one`), at `seconds`
    /// of the active sequence. `params`, all optional, are upstream's scope settings:
    /// `scopes` (default `["parade"]`), `waveformType`, `paradeType`, `colorSpace`, `clamp`
    /// (default true), `brightness` (`dimmed`, `normal`, `bright`), `signalScale` (`8bit`,
    /// `float`, `hdr`: HDR plots an SDR frame on the PQ axis), and `rows`, the levels of a
    /// waveform, parade, or histogram plot (the plot's height in pixels, 64–256, default 256).
    ///
    /// The answer is `[headerLength u32 LE][header JSON, UTF-8]` then each scope's straight RGBA
    /// pixels, in the order of `header.scopes`, each at its `offset` from the end of the header.
    /// Empty cells are transparent, so the page draws the graticule under the traces, as upstream
    /// does. The header also has what the graticule needs: the levels' value `range`, a parade's
    /// `dividers`, and for vectorscopes the colour-bar targets, the HLS hue labels, the plane's
    /// `extent`, and the skin-tone angle; with `nits`, the cd/m² axis's levels. The frame is the
    /// Program monitor's at a quarter of the sequence size (an eighth for Rec. 2100 scopes of an
    /// HDR sequence), at most [`MAX_ITEM_FRAME_PIXELS`]; the signal is at most 480 × 270.
    pub fn scope_images(&self, seconds: f64, params: Value) -> Result<Vec<u8>, String> {
        let sequence = active(&self.session)?;
        let p = object(params)?;
        let kinds: Vec<ScopeKind> = match p.get("scopes") {
            None | Some(Value::Null) => vec![ScopeKind::Parade],
            Some(Value::Array(names)) => names
                .iter()
                .map(|name| name.as_str().and_then(ScopeKind::from_name).ok_or_else(|| format!("unknown scope {name}")))
                .collect::<Result<_, _>>()?,
            Some(_) => return Err(NOT_A_LIST.to_owned()),
        };
        let waveform_type = setting(&p, "waveformType", WaveformType::from_name, WaveformType::Rgb)?;
        let parade_type = setting(&p, "paradeType", ParadeType::from_name, ParadeType::Rgb)?;
        let space = setting(&p, "colorSpace", ColorSpace::from_name, ColorSpace::Auto)?;
        let brightness = setting(&p, "brightness", named(&Brightness::ALL, |b| b.label().to_owned()), Brightness::Normal)?;
        let signal_scale = setting(&p, "signalScale", Scale::from_name, Scale::Bits8)?;
        let clamp = match p.get("clamp") {
            None | Some(Value::Null) => true,
            Some(value) => value.as_bool().ok_or_else(|| format!("clamp is not true or false: {value}"))?,
        };
        let rows = match p.get("rows") {
            None | Some(Value::Null) => 256,
            Some(value) => value.as_u64().ok_or("rows is not a whole number")?,
        }
        .clamp(64, 256) as usize;

        let hdr_sequence = sequence.settings.color.working.is_hdr();
        let space = space.resolve(hdr_sequence);
        let pq = hdr_sequence && space == ColorSpace::Rec2100;
        let rate = sequence.settings.frame_rate;
        let time = rate.snap(Tick::from_seconds_f64(page_seconds(seconds)));
        let scale = capped_scale(sequence.settings.width, sequence.settings.height, if pq { SCOPE_SCALE_HDR } else { SCOPE_SCALE });
        let signal = kition_film_engine::scopes::scope_signal(&self.session, time, scale, pq).ok_or("no sequence is open")?;
        let nits = pq || signal_scale == Scale::Hdr;
        let plotted = if signal_scale == Scale::Hdr && !pq { signal.map(|c| c.map(sc::sdr_to_pq)) } else { signal.clone() };
        let params = Params { matrix: space.matrix(), clamp, rows, ..Params::default() };
        let gain = brightness.gain();

        let mut pixels = Vec::new();
        let mut scopes = Vec::new();
        for kind in kinds {
            let mut entry = json!({ "kind": kind.name() });
            let (w, h, mut px) = match kind {
                ScopeKind::Waveform => {
                    let waveform = sc::waveform(&plotted, waveform_type, &params);
                    let layers: Vec<(&sc::Grid, [f32; 3])> = waveform.traces.iter().map(|g| (g, trace_color(g.name, Some(waveform_type)))).collect();
                    entry["type"] = json!(waveform_type);
                    entry["label"] = json!(waveform_type.label());
                    entry["range"] = json!(params.range());
                    sc::paint::grids(&layers, sc::paint::waveform_reference(waveform.per_column), gain)
                }
                ScopeKind::Parade => {
                    entry["type"] = json!(parade_type);
                    entry["label"] = json!(parade_type.label());
                    entry["range"] = json!(params.range());
                    entry["dividers"] = json!(if parade_type == ParadeType::RgbWhite { 4 } else { 3 });
                    parade_image(&sc::parade(&plotted, parade_type, &params), gain)
                }
                ScopeKind::Histogram => {
                    entry["range"] = json!([0.0, 1.0]);
                    histogram_image(&sc::histogram(&plotted, &params), gain)
                }
                ScopeKind::VectorscopeYuv | ScopeKind::VectorscopeHls => {
                    let hls = kind == ScopeKind::VectorscopeHls;
                    let vectorscope = if hls { sc::vectorscope_hls(&signal, &params) } else { sc::vectorscope_yuv(&signal, &params) };
                    entry["extent"] = json!(sc::VECTOR_EXTENT);
                    if hls {
                        entry["hues"] = json!(sc::hls_targets(space.matrix()).map(|(name, cb, cr)| json!({ "name": name, "cb": cb, "cr": cr })));
                    } else {
                        let targets = |amplitude: f32| json!(sc::targets(space.matrix(), amplitude));
                        entry["targets"] = json!({ "75": targets(0.75), "100": targets(1.0) });
                        entry["skinToneDeg"] = json!(sc::SKIN_TONE_DEG);
                    }
                    sc::paint::vectorscope(&vectorscope, WHITE, gain, true)
                }
            };
            straight(&mut px);
            entry["width"] = json!(w);
            entry["height"] = json!(h);
            entry["offset"] = json!(pixels.len());
            pixels.extend_from_slice(&px);
            scopes.push(entry);
        }
        let mut header = json!({
            "time": time.0,
            "frame": rate.frame_at(time),
            "samples": [signal.w, signal.h],
            "colorSpace": space.label(),
            "pq": pq,
            "nits": nits,
            "clamp": clamp,
            "scopes": scopes,
        });
        if nits {
            header["nitsAxis"] = json!([0.0f32, 10.0, 100.0, 203.0, 1000.0, 4000.0, 10_000.0].map(|n| json!([n, sc::nits_to_pq(n)])));
        }
        let header = header.to_string().into_bytes();
        let length = u32::try_from(header.len()).map_err(|_| "the scope header is too long")?;
        let mut out = Vec::with_capacity(4 + header.len() + pixels.len());
        out.extend_from_slice(&length.to_le_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(&pixels);
        Ok(out)
    }

    /// The Effects panel's color preset thumbnails (upstream `panels/effects.rs`
    /// `preset_texture`: our Color effect on the procedural preview picture): `[count u32 LE][width u32
    /// LE][height u32 LE]` then each thumbnail's RGBA over black, `width` (16 to
    /// [`MAX_THUMBNAIL_WIDTH`]) by `width × 9 / 16`. `names` picks presets in that order; an
    /// empty list is every preset of `folder` (an empty folder is every folder), in
    /// `color.presets` order. An unknown folder or name, a name outside `folder`, or more than
    /// [`MAX_THUMBNAILS`] thumbnails (8 × 640 × 360 is under [`MAX_ITEM_FRAME_PIXELS`]) is an
    /// error. It reads no document.
    pub fn color_preset_thumbnails(folder: &str, names: &[String], width: u32) -> Result<Vec<u8>, String> {
        if !folder.is_empty() && !color_presets::FOLDERS.iter().any(|known| known.eq_ignore_ascii_case(folder)) {
            return Err(format!("no color preset folder `{folder}`"));
        }
        let in_folder = |preset: &ColorPreset| folder.is_empty() || preset.folder.eq_ignore_ascii_case(folder);
        let presets: Vec<ColorPreset> = if names.is_empty() {
            color_presets::presets().into_iter().filter(in_folder).collect()
        } else {
            names
                .iter()
                .map(|name| match color_presets::find(name) {
                    Some(preset) if in_folder(&preset) => Ok(preset),
                    Some(_) => Err(format!("color preset `{name}` is not in `{folder}`")),
                    None => Err(format!("no color preset `{name}`")),
                })
                .collect::<Result<_, _>>()?
        };
        if presets.len() > MAX_THUMBNAILS {
            return Err(format!("{} thumbnails asked; at most {MAX_THUMBNAILS} a call", presets.len()));
        }
        let w = width.clamp(16, MAX_THUMBNAIL_WIDTH) as usize;
        let h = (w * 9 / 16).max(1);
        let count = u32::try_from(presets.len()).map_err(|_| "too many presets")?;
        let mut out = Vec::with_capacity(12 + presets.len() * w * h * 4);
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&(w as u32).to_le_bytes());
        out.extend_from_slice(&(h as u32).to_le_bytes());
        for preset in &presets {
            out.extend_from_slice(&color_presets::thumbnail(preset, w, h).over_black_rgba8());
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::fixture;
    use kition_kit::KitDocument;

    /// The fixture (a 64 × 36 sequence with a red matte on V1 for 4 s) and the matte's clip id.
    fn with_clip() -> (FilmDocument, u64) {
        let doc = FilmDocument::open("Edit.kfilm", &fixture()).unwrap();
        let inspected = doc.inspect().unwrap();
        let clip = inspected["sequence"]["video"][0]["items"][0]["clip"].as_u64().unwrap_or_else(|| panic!("no clip in {inspected}"));
        (doc, clip)
    }

    /// What a read must leave alone: the replica version, the history, the inspected state, and
    /// the session's revision.
    fn state(doc: &mut FilmDocument) -> (Vec<u8>, Value, Value, u64) {
        let history = doc.session.execute("history.list", json!({})).unwrap();
        (doc.version().unwrap(), history, doc.inspect().unwrap(), doc.session.revision)
    }

    /// The header and the pixels of a [`FilmDocument::scope_images`] answer.
    fn split(bytes: &[u8]) -> (Value, &[u8]) {
        let length = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        (serde_json::from_slice(&bytes[4..4 + length]).unwrap(), &bytes[4 + length..])
    }

    fn image<'a>(header: &Value, pixels: &'a [u8], index: usize) -> (usize, usize, &'a [u8]) {
        let entry = &header["scopes"][index];
        let (w, h, offset) =
            (entry["width"].as_u64().unwrap() as usize, entry["height"].as_u64().unwrap() as usize, entry["offset"].as_u64().unwrap() as usize);
        (w, h, &pixels[offset..offset + w * h * 4])
    }

    #[test]
    fn scopes_answer_what_scopes_read_answers_and_change_nothing() {
        let (mut doc, _) = with_clip();
        let before = state(&mut doc);
        let params = json!({ "scopes": ["parade", "histogram", "waveform", "vectorscopeYuv", "vectorscopeHls"], "columns": 16, "peaks": 4, "scale": 0.5 });
        let ours = doc.scopes(1.0, params.clone()).unwrap();
        assert_eq!(state(&mut doc), before, "a read changes nothing");
        let mut command = params.clone();
        command["seconds"] = json!(1.0);
        let native = doc.session.execute("scopes.read", command).unwrap();
        assert_eq!(ours, native);
        // Over the red matte the parade's red levels are at the top and green and blue at the
        // bottom, and the histogram's red peaks in its top bin.
        let parade = &ours["parade"]["traces"];
        assert_eq!(parade["R"].as_array().unwrap().len(), 16);
        for column in parade["R"].as_array().unwrap() {
            assert!(column["min"].as_f64().unwrap() > 95.0, "red is high: {column}");
        }
        for trace in ["G", "B"] {
            for column in parade[trace].as_array().unwrap() {
                assert!(column["max"].as_f64().unwrap() < 5.0, "{trace} is low: {column}");
            }
        }
        assert_eq!(ours["histogram"]["peakBin"]["r"], 255);
        assert_eq!(ours["histogram"]["peakBin"]["g"], 0);
        // Past the matte the frame is black.
        let black = doc.scopes(10.0, json!({ "scopes": ["parade"] })).unwrap();
        assert!(black["parade"]["traces"]["R"].as_array().unwrap().iter().all(|c| c["max"].as_f64().unwrap() < 5.0));
        // `time` in the params never wins over the seconds asked for.
        assert_eq!(doc.scopes(10.0, json!({ "scopes": ["parade"], "time": 0 })).unwrap(), black);
    }

    #[test]
    fn scope_reads_are_errors_without_a_sequence_or_with_bad_settings() {
        let (mut doc, _) = with_clip();
        assert!(doc.scopes(0.0, json!({ "scopes": ["nope"] })).is_err());
        assert!(doc.scope_images(0.0, json!({ "scopes": ["nope"] })).unwrap_err().contains("unknown scope"));
        assert!(doc.scope_images(0.0, json!({ "brightness": "loud" })).unwrap_err().contains("brightness"));
        assert!(doc.scope_images(0.0, json!({ "signalScale": "12bit" })).unwrap_err().contains("signalScale"));
        assert!(doc.scope_images(0.0, json!([1])).is_err());
        assert_eq!(doc.scope_images(0.0, json!({ "scopes": "parade" })).unwrap_err(), "scopes is not a list of scope names");
        assert_eq!(doc.scopes(0.0, json!({ "scopes": "parade" })).unwrap_err(), "scopes is not a list of scope names");
        assert_eq!(doc.scope_images(0.0, json!({ "rows": 100.5 })).unwrap_err(), "rows is not a whole number");
        assert_eq!(doc.scope_images(0.0, json!({ "rows": "tall" })).unwrap_err(), "rows is not a whole number");
        doc.session.state.active_sequence = None;
        assert_eq!(doc.scopes(0.0, json!({})).unwrap_err(), "no sequence is open");
        assert_eq!(doc.scope_images(0.0, json!({})).unwrap_err(), "no sequence is open");
    }

    #[test]
    fn scope_images_are_upstreams_textures_of_the_engines_scopes() {
        let (mut doc, _) = with_clip();
        let before = state(&mut doc);
        let bytes = doc
            .scope_images(
                1.0,
                json!({ "scopes": ["waveform", "parade", "histogram", "vectorscopeYuv", "vectorscopeHls"], "rows": 128, "brightness": "bright" }),
            )
            .unwrap();
        assert_eq!(state(&mut doc), before, "a read changes nothing");
        let (header, pixels) = split(&bytes);
        assert_eq!(header["colorSpace"], "Rec. 709");
        assert_eq!(header["pq"], false);
        let kinds: Vec<&str> = header["scopes"].as_array().unwrap().iter().map(|s| s["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["waveform", "parade", "histogram", "vectorscopeYuv", "vectorscopeHls"]);
        let last = &header["scopes"][4];
        assert_eq!(pixels.len() as u64, last["offset"].as_u64().unwrap() + last["width"].as_u64().unwrap() * last["height"].as_u64().unwrap() * 4);

        // The waveform is the engine's own, painted as upstream paints it.
        let sequence = doc.session.active_sequence().unwrap();
        let time = sequence.settings.frame_rate.snap(Tick::from_seconds_f64(1.0));
        let signal = kition_film_engine::scopes::scope_signal(&doc.session, time, 0.25, false).unwrap();
        assert_eq!(header["samples"], json!([signal.w, signal.h]));
        let params = Params { rows: 128, ..Params::default() };
        let waveform = sc::waveform(&signal, WaveformType::Rgb, &params);
        let layers: Vec<(&sc::Grid, [f32; 3])> = waveform.traces.iter().map(|g| (g, trace_color(g.name, Some(WaveformType::Rgb)))).collect();
        let (w, h, mut expected) = sc::paint::grids(&layers, sc::paint::waveform_reference(waveform.per_column), Brightness::Bright.gain());
        straight(&mut expected);
        let (ww, wh, drawn) = image(&header, pixels, 0);
        assert_eq!((ww, wh), (w, h));
        assert_eq!((ww, wh), (signal.w, 128), "a column per sample, a row per level");
        assert_eq!(drawn, &expected[..]);

        // The parade over red: the red third lit in its top row, green and blue in their bottom row.
        let (pw, ph, parade) = image(&header, pixels, 1);
        assert_eq!(header["scopes"][1]["dividers"], 3);
        let third = (pw - 2 * (signal.w / 24).max(2)) / 3;
        let lit = |x: usize, y: usize| parade[(y * pw + x) * 4 + 3] > 0;
        assert!(lit(third / 2, 0) && !lit(third / 2, ph - 1), "red is at the top");
        let green = pw / 2;
        assert!(lit(green, ph - 1) && !lit(green, 0), "green is at the bottom");

        // The histogram is 256 levels high and the vectorscopes 255 cells square.
        assert_eq!(image(&header, pixels, 2).0, 256);
        assert_eq!(image(&header, pixels, 2).1, 256);
        assert_eq!((image(&header, pixels, 3).0, image(&header, pixels, 3).1), (255, 255));
        assert_eq!(header["scopes"][3]["targets"]["75"].as_array().unwrap().len(), 6);
        assert_eq!(header["scopes"][4]["hues"].as_array().unwrap().len(), 6);
        // The default is upstream's: the RGB parade at 256 levels.
        let (header, _) = split(&doc.scope_images(1.0, json!({})).unwrap());
        assert_eq!(header["scopes"].as_array().unwrap().len(), 1);
        assert_eq!((header["scopes"][0]["kind"].as_str(), header["scopes"][0]["height"].as_u64()), (Some("parade"), Some(256)));
        // HDR levels put the frame on the cd/m² axis.
        let (header, _) = split(&doc.scope_images(1.0, json!({ "signalScale": "hdr", "rows": 9 })).unwrap());
        assert_eq!(header["nits"], true);
        assert_eq!(header["nitsAxis"].as_array().unwrap().len(), 7);
        assert_eq!(header["scopes"][0]["height"], 64, "at least 64 levels");
    }

    #[test]
    fn scope_reads_render_at_most_four_megapixels() {
        assert_eq!(capped_scale(1920, 1080, 0.5), 0.5);
        let scale = capped_scale(7680, 4320, 1.0);
        let pixels = (7680.0 * scale).round() * (4320.0 * scale).round();
        assert!(pixels <= MAX_ITEM_FRAME_PIXELS as f32 * 1.001 && pixels > MAX_ITEM_FRAME_PIXELS as f32 * 0.99, "{pixels}");
        let mut doc = FilmDocument::create("Edit.kfilm", 7680, 4320).unwrap();
        let matte = doc.execute("file.newColorMatte", json!({ "color": "#ff0000", "seconds": 1.0 })).unwrap();
        doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0.0 })).unwrap();
        let read = doc.scopes(0.0, json!({ "scopes": ["histogram"], "scale": 1.0, "bins": false })).unwrap();
        assert_eq!(read["histogram"]["peakBin"]["r"], 255);
        let (header, _) = split(&doc.scope_images(0.0, json!({})).unwrap());
        assert_eq!(header["samples"], json!([480, 270]));
    }

    #[test]
    fn color_preset_thumbnails_are_the_built_ins_graded() {
        let all = color_presets::presets();
        let names: Vec<String> = all.iter().map(|p| p.name.to_owned()).collect();
        // Every built-in renders, eight at a time, at both of upstream's sizes.
        for width in [64usize, 160] {
            let height = width * 9 / 16;
            for (chunk, presets) in names.chunks(MAX_THUMBNAILS).zip(all.chunks(MAX_THUMBNAILS)) {
                let bytes = FilmDocument::color_preset_thumbnails("", chunk, width as u32).unwrap();
                let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
                assert_eq!((word(0), word(4), word(8)), (chunk.len(), width, height));
                assert_eq!(bytes.len(), 12 + chunk.len() * width * height * 4);
                for (k, preset) in presets.iter().enumerate() {
                    let expected = color_presets::thumbnail(preset, width, height).over_black_rgba8();
                    assert_eq!(&bytes[12 + k * width * height * 4..12 + (k + 1) * width * height * 4], &expected[..], "{}", preset.name);
                }
            }
        }
        let technical = FilmDocument::color_preset_thumbnails("technical", &[], 160).unwrap();
        assert_eq!(u32::from_le_bytes(technical[0..4].try_into().unwrap()) as usize, all.iter().filter(|p| p.folder == "Technical").count());
        assert_eq!(u32::from_le_bytes(technical[8..12].try_into().unwrap()), 90);
        let picked = FilmDocument::color_preset_thumbnails("", &[names[3].clone(), names[0].clone()], 16).unwrap();
        assert_eq!(&picked[12..12 + 16 * 9 * 4], &color_presets::thumbnail(&all[3], 16, 9).over_black_rgba8()[..], "in the order asked");
        assert!(FilmDocument::color_preset_thumbnails("", &["No Such Look".to_owned()], 64).unwrap_err().contains("No Such Look"));
        assert!(FilmDocument::color_preset_thumbnails("Nowhere", &[], 64).is_err());
        let outside = all.iter().find(|p| p.folder != "Technical").unwrap().name.to_owned();
        assert!(FilmDocument::color_preset_thumbnails("Technical", &[outside], 64).unwrap_err().contains("not in"));
        assert_eq!(u32::from_le_bytes(FilmDocument::color_preset_thumbnails("", &names[..2], 4000).unwrap()[4..8].try_into().unwrap()), 640);
        // More than eight in one call is an error, whether named or a whole folder list.
        assert!(FilmDocument::color_preset_thumbnails("", &names[..9], 16).unwrap_err().contains("at most 8"));
        assert!(FilmDocument::color_preset_thumbnails("", &[], 64).unwrap_err().contains("at most 8"));
    }

    #[test]
    fn scopes_default_to_upstreams_quarter_frame() {
        let (mut doc, _) = with_clip();
        let ours = doc.scopes(1.0, json!({ "scopes": ["parade"] })).unwrap();
        let native = doc.session.execute("scopes.read", json!({ "scopes": ["parade"], "seconds": 1.0, "scale": 0.25 })).unwrap();
        assert_eq!(ours, native);
        assert_eq!(ours["samples"], json!([16, 9]), "a quarter of 64 x 36");
    }

    /// A 1920 × 1080 sequence with a red matte on V1, its working space set by `settings`.
    fn graded(settings: Value) -> FilmDocument {
        let mut doc = FilmDocument::create("Edit.kfilm", 1920, 1080).unwrap();
        let matte = doc.execute("file.newColorMatte", json!({ "color": "#ff0000", "seconds": 2.0 })).unwrap();
        doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0.0 })).unwrap();
        doc.execute("sequence.colorSettings", settings).unwrap();
        doc
    }

    #[test]
    fn hdr_scopes_read_the_working_space_on_the_nits_axis() {
        let mut doc = graded(json!({ "workingSpace": "rec2100-pq" }));
        let before = state(&mut doc);
        let bytes = doc.scope_images(0.5, json!({ "scopes": ["waveform"], "rows": 128 })).unwrap();
        let (header, pixels) = split(&bytes);
        assert_eq!(state(&mut doc), before, "a read changes nothing");
        assert_eq!((header["pq"].as_bool(), header["nits"].as_bool(), header["colorSpace"].as_str()), (Some(true), Some(true), Some("Rec. 2100")));
        assert_eq!(header["samples"], json!([240, 135]), "an eighth of the frame for HDR scopes");
        let axis = header["nitsAxis"].as_array().unwrap();
        assert_eq!(axis.iter().map(|pair| pair[0].as_f64().unwrap()).collect::<Vec<_>>(), [0.0, 10.0, 100.0, 203.0, 1000.0, 4000.0, 10_000.0]);
        assert!((axis[6][1].as_f64().unwrap() - 1.0).abs() < 1e-3 && axis[0][1].as_f64().unwrap().abs() < 1e-3);
        // The traces are the engine's own, from its working-space PQ signal.
        let time = doc.session.active_sequence().unwrap().settings.frame_rate.snap(Tick::from_seconds_f64(0.5));
        let signal = kition_film_engine::scopes::scope_signal(&doc.session, time, 0.125, true).unwrap();
        let params = Params { matrix: ColorSpace::Rec2100.matrix(), rows: 128, ..Params::default() };
        let waveform = sc::waveform(&signal, WaveformType::Rgb, &params);
        let layers: Vec<(&sc::Grid, [f32; 3])> = waveform.traces.iter().map(|g| (g, trace_color(g.name, Some(WaveformType::Rgb)))).collect();
        let (_, _, mut expected) = sc::paint::grids(&layers, sc::paint::waveform_reference(waveform.per_column), 1.0);
        straight(&mut expected);
        assert_eq!(image(&header, pixels, 0).2, &expected[..]);
        // Rec. 709 scopes of the same sequence read the monitor picture, at a quarter.
        let (header, _) = split(&doc.scope_images(0.5, json!({ "colorSpace": "709" })).unwrap());
        assert_eq!((header["pq"].as_bool(), header["nits"].as_bool(), header["colorSpace"].as_str()), (Some(false), Some(false), Some("Rec. 709")));
        assert_eq!(header["samples"], json!([480, 270]));
        assert!(header.get("nitsAxis").is_none());
    }

    #[test]
    fn wide_gamut_scopes_read_the_monitor_picture() {
        let doc = graded(json!({ "workingSpace": "rec709", "wideGamut": true }));
        let bytes = doc.scope_images(0.5, json!({ "scopes": ["parade"] })).unwrap();
        let (header, pixels) = split(&bytes);
        assert_eq!((header["pq"].as_bool(), header["colorSpace"].as_str()), (Some(false), Some("Rec. 709")));
        let time = doc.session.active_sequence().unwrap().settings.frame_rate.snap(Tick::from_seconds_f64(0.5));
        let signal = kition_film_engine::scopes::scope_signal(&doc.session, time, 0.25, false).unwrap();
        let (_, _, mut expected) = parade_image(&sc::parade(&signal, ParadeType::Rgb, &Params::default()), 1.0);
        straight(&mut expected);
        let (w, _, drawn) = image(&header, pixels, 0);
        assert_eq!(drawn, &expected[..]);
        assert!(drawn[(w / 6) * 4 + 3] > 0, "the red matte stays at the top of the red third");
        // Rec. 2100 asked of an SDR sequence uses its matrix on the monitor picture, not PQ.
        let (header, _) = split(&doc.scope_images(0.5, json!({ "colorSpace": "2100" })).unwrap());
        assert_eq!((header["pq"].as_bool(), header["nits"].as_bool(), header["colorSpace"].as_str()), (Some(false), Some(false), Some("Rec. 2100")));
    }

    /// What the reads cost at realistic sizes, in release: `cargo test --release -p
    /// kition-film-kit --lib picture::tests::measures -- --ignored --nocapture`, with
    /// `KITION_FILM_PERF_CLIP=<a clip>` to read a real picture rather than a matte.
    #[test]
    #[ignore = "a measurement"]
    fn measures_the_picture_reads() {
        let _lock = crate::tests::HOST_ROOT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let clip_path = std::env::var_os("KITION_FILM_PERF_CLIP").map(std::path::PathBuf::from);
        let mut doc = FilmDocument::create("Edit.kfilm", 1920, 1080).unwrap();
        let item = match &clip_path {
            Some(path) => {
                kition_kit::host::set_root(path.parent().map(std::path::Path::to_path_buf));
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                doc.execute("file.import", json!({ "paths": [name] })).unwrap()["items"][0].clone()
            }
            None => doc.execute("file.newColorMatte", json!({ "color": "#3080c0", "seconds": 4.0 })).unwrap()["item"].clone(),
        };
        doc.execute("timeline.place", json!({ "item": item, "track": "V1", "seconds": 0.0 })).unwrap();
        let clip = doc.inspect().unwrap()["sequence"]["video"][0]["items"][0]["clip"].as_u64().unwrap();
        doc.execute("effects.apply", json!({ "clips": [clip], "effect": "color" })).unwrap();
        let timed = |label: &str, run: &mut dyn FnMut()| {
            run();
            let started = std::time::Instant::now();
            for _ in 0..5 {
                run();
            }
            eprintln!("{label}: {:?} each", started.elapsed() / 5);
        };
        timed("scopes JSON, all five, scale 0.25, 64 columns", &mut || {
            drop(
                doc.scopes(1.0, json!({ "scopes": ["waveform", "parade", "histogram", "vectorscopeYuv", "vectorscopeHls"], "scale": 0.25, "columns": 64 }))
                    .unwrap(),
            )
        });
        timed("scopes JSON, parade, default scale (0.25), 512 columns", &mut || {
            drop(doc.scopes(1.0, json!({ "scopes": ["parade"], "columns": 512 })).unwrap())
        });
        timed("scopeImages, parade (upstream's default)", &mut || drop(doc.scope_images(1.0, json!({})).unwrap()));
        timed("scopeImages, all five, 256 rows", &mut || {
            drop(doc.scope_images(1.0, json!({ "scopes": ["waveform", "parade", "histogram", "vectorscopeYuv", "vectorscopeHls"] })).unwrap())
        });
        let eight: Vec<String> = color_presets::presets().iter().take(MAX_THUMBNAILS).map(|p| p.name.to_owned()).collect();
        timed("colorPresetThumbnails, eight at 64", &mut || drop(FilmDocument::color_preset_thumbnails("", &eight, 64).unwrap()));
        timed("colorPresetThumbnails, eight at 160", &mut || drop(FilmDocument::color_preset_thumbnails("", &eight, 160).unwrap()));
        timed("colorPresetThumbnails, one at 160", &mut || {
            drop(FilmDocument::color_preset_thumbnails("", &["Teal Shadows, Warm Skin".to_owned()], 160).unwrap())
        });
        let item = item.as_u64().unwrap();
        timed("itemFrame without effects, 160 px", &mut || drop(doc.item_frame(item, 1.0, 160).unwrap()));
        kition_kit::host::set_root(None);
    }
}
