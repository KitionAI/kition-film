//! Caption layout and burn-in.
//!
//! [`overlay`] lays out the caption showing on a track at a time with the track's
//! [`CaptionStyle`] (size relative to a 1080-line frame, colour, background box, outline,
//! alignment, anchor and margin; WebVTT `line:N%` and `align:` cue settings override the style)
//! and rasterises it into a small premultiplied linear-light RGBA [`Overlay`] positioned in the
//! frame. Renderers composite overlays over the finished picture. Inline `<b>`, `<i>` and `<u>`
//! are drawn; a caption with WebVTT word timestamps (`今<00:00:01.200>天`) is karaoke: the word
//! being sung takes the style's highlight colour and scale.

use kition_film_color::srgb_to_linear;
use kition_film_project::{Caption, CaptionAlign, CaptionAnchor, CaptionSpan, CaptionStyle, CaptionTrack, Sequence};
use kition_film_time::Tick;

use kition_film_text::{ParagraphStyle, TextStyle, layout, render};

/// A rendered caption: premultiplied linear-light RGBA f32 pixels at `(x, y)` in the frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Overlay {
    pub x: i32,
    pub y: i32,
    pub w: usize,
    pub h: usize,
    pub px: Vec<f32>,
}

impl Overlay {
    /// Composite over a premultiplied RGBA f32 canvas of `cw`×`ch` pixels.
    pub fn composite_onto(&self, canvas: &mut [f32], cw: usize, ch: usize) {
        for y in 0..self.h {
            let cy = self.y + y as i32;
            if cy < 0 || cy >= ch as i32 {
                continue;
            }
            for x in 0..self.w {
                let cx = self.x + x as i32;
                if cx < 0 || cx >= cw as i32 {
                    continue;
                }
                let s = &self.px[(y * self.w + x) * 4..(y * self.w + x) * 4 + 4];
                if s[3] <= 0.0 {
                    continue;
                }
                let i = (cy as usize * cw + cx as usize) * 4;
                let k = 1.0 - s[3];
                for c in 0..4 {
                    canvas[i + c] = s[c] + canvas[i + c] * k;
                }
            }
        }
    }
}

/// The caption face: the style's font family (the bundled Inter when the style names none), its
/// SemiBold or nearest weight, at `px`. A family that is not installed falls back to Inter, and
/// characters a face lacks (Chinese in Inter) to a face that has them.
fn caption_style(font: &str, px: f32) -> TextStyle {
    let family = if font.trim().is_empty() { kition_film_text::fonts::DEFAULT_FAMILY } else { font.trim() };
    TextStyle { family: family.into(), style: "SemiBold".into(), size: px, ..Default::default() }
}

fn measure(text: &str, font: &str, px: f32) -> f32 {
    kition_film_text::measure(text, &caption_style(font, px))
}

fn lin(c: [u8; 4]) -> [f32; 4] {
    let a = c[3] as f32 / 255.0;
    [srgb_to_linear(c[0] as f32 / 255.0) * a, srgb_to_linear(c[1] as f32 / 255.0) * a, srgb_to_linear(c[2] as f32 / 255.0) * a, a]
}

/// Chinese, Japanese and Korean characters (and their full-width punctuation): a line may break
/// between any two of them.
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF | 0x2E80..=0x2FDF | 0x2FF0..=0x303F | 0x3040..=0x31FF | 0x3200..=0x9FFF | 0xA960..=0xA97F
        | 0xAC00..=0xD7FF | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFFEF | 0x20000..=0x3FFFF)
}

/// Characters a line may not start with: closing brackets and quotes, sentence and clause
/// punctuation, the prolonged sound mark, iteration marks and small kana (the basic rules of
/// Chinese and Japanese line breaking).
fn no_line_start(c: char) -> bool {
    "、。，．・：；？！ー～〜…‥）」』】〕》〉｝］〙〗〟’”ヽヾゝゞ々ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ,.!?;:)]}%".contains(c)
}

/// Characters a line may not end with: opening brackets and quotes.
fn no_line_end(c: char) -> bool {
    "（「『【〔《〈｛［〘〖〝‘“([{".contains(c)
}

/// The pieces a line may break between: words (with whether a space came before them, which a
/// break drops) and, in Chinese, Japanese and Korean, single characters, kept together with the
/// punctuation that may not start or end a line.
fn break_units(line: &str) -> Vec<(bool, String)> {
    let mut out: Vec<(bool, String)> = Vec::new();
    let mut cur = String::new();
    let mut space = false;
    let mut prev: Option<char> = None;
    for c in line.chars() {
        if c == ' ' {
            if !cur.is_empty() {
                out.push((space, std::mem::take(&mut cur)));
            }
            space = true;
            prev = None;
            continue;
        }
        if let Some(p) = prev
            && (is_cjk(p) || is_cjk(c))
            && !no_line_start(c)
            && !no_line_end(p)
        {
            out.push((space, std::mem::take(&mut cur)));
            space = false;
        }
        cur.push(c);
        prev = Some(c);
    }
    if !cur.is_empty() {
        out.push((space, cur));
    }
    out
}

/// Wrap one line to `max_w` pixels: at spaces, and between the characters of Chinese, Japanese
/// and Korean text, never putting closing punctuation at the start of a line or opening
/// punctuation at its end.
fn wrap(line: &str, font: &str, px: f32, max_w: f32) -> Vec<String> {
    wrap_units(break_units(line), font, px, max_w)
}

/// Wrap break units (see [`break_units`]) to `max_w` pixels.
fn wrap_units(units: Vec<(bool, String)>, font: &str, px: f32, max_w: f32) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for (space, unit) in units {
        let cand = if cur.is_empty() {
            unit.clone()
        } else if space {
            format!("{cur} {unit}")
        } else {
            format!("{cur}{unit}")
        };
        if !cur.is_empty() && measure(&cand, font, px) > max_w {
            out.push(std::mem::take(&mut cur));
            cur = unit;
        } else {
            cur = cand;
        }
    }
    out.push(cur);
    out
}

/// Placement overrides from WebVTT cue settings.
fn vtt_overrides(settings: &str) -> (Option<f32>, Option<CaptionAlign>) {
    let mut line = None;
    let mut align = None;
    for kv in settings.split_whitespace() {
        let Some((k, v)) = kv.split_once(':') else { continue };
        match k {
            "line" => {
                let v = v.split(',').next().unwrap_or("");
                if let Some(p) = v.strip_suffix('%').and_then(|p| p.parse::<f32>().ok()) {
                    line = Some((p / 100.0).clamp(0.0, 1.0));
                }
            }
            "align" => {
                align = match v {
                    "start" | "left" => Some(CaptionAlign::Left),
                    "end" | "right" => Some(CaptionAlign::Right),
                    "center" | "middle" => Some(CaptionAlign::Center),
                    _ => None,
                }
            }
            _ => {}
        }
    }
    (line, align)
}

/// Lay out and rasterise one caption for a `w`×`h` frame (no karaoke highlight).
pub fn render_caption(c: &Caption, style: &CaptionStyle, w: usize, h: usize) -> Option<Overlay> {
    render_caption_at(c, style, w, h, None)
}

/// A drawn piece of a line: text with one style.
struct Seg {
    text: String,
    bold: bool,
    italic: bool,
    underline: bool,
    /// The word being sung at the drawn time.
    hot: bool,
}

/// The face of a styled run: SemiBold, Bold for `<b>`, italic for `<i>`.
fn seg_style(font: &str, px: f32, bold: bool, italic: bool) -> TextStyle {
    let mut st = caption_style(font, px);
    st.style = match (bold, italic) {
        (false, false) => "SemiBold",
        (true, false) => "Bold",
        (false, true) => "SemiBold Italic",
        (true, true) => "Bold Italic",
    }
    .into();
    st
}

/// Split a caption line's styled runs into wrapped lines of segments. `hot` is the karaoke
/// timestamp in effect at the drawn time.
fn styled_wrap(spans: &[CaptionSpan], hot: Option<Tick>, font: &str, px: f32, max_w: f32) -> Vec<Vec<Seg>> {
    // each character with the run it belongs to
    let chars: Vec<(char, usize)> = spans.iter().enumerate().flat_map(|(k, sp)| sp.text.chars().map(move |c| (c, k))).collect();
    let plain: String = chars.iter().map(|x| x.0).collect();
    // karaoke words stay whole: a line breaks between them (and at spaces), not inside a word
    let wrapped = if spans.iter().any(|sp| sp.time.is_some()) {
        let mut units: Vec<(bool, String)> = Vec::new();
        let mut lead = true;
        let mut after_space = false;
        for sp in spans {
            let starts_space = after_space || sp.text.starts_with(' ');
            if !sp.text.trim().is_empty() || sp.text.contains(' ') {
                after_space = sp.text.ends_with(' ') || (sp.text.trim().is_empty() && (after_space || sp.text.contains(' ')));
            }
            for (k, (space, piece)) in break_units(&sp.text).into_iter().enumerate() {
                let space = space || (k == 0 && starts_space);
                let glue_prev = k > 0 && !space;
                let no_start = !space && piece.chars().next().is_some_and(no_line_start);
                match units.last_mut() {
                    Some(last) if (glue_prev || no_start) && !lead => last.1.push_str(&piece),
                    _ => units.push((space, piece)),
                }
                lead = false;
            }
        }
        if let Some(first) = units.first_mut() {
            first.0 = false;
            first.1 = first.1.trim_start().to_string();
        }
        wrap_units(units, font, px, max_w)
    } else {
        wrap(plain.trim(), font, px, max_w)
    };
    let mut out = Vec::new();
    let mut pos = 0usize;
    for line in wrapped {
        let mut segs: Vec<(String, usize)> = Vec::new();
        for ch in line.chars() {
            // the wrapped line drops spaces at breaks and repeated spaces: skip them in the source
            while chars.get(pos).is_some_and(|x| x.0 != ch) {
                pos += 1;
            }
            let k = chars.get(pos).map_or(0, |x| x.1);
            pos += 1;
            match segs.last_mut() {
                Some((t, kk)) if *kk == k => t.push(ch),
                _ => segs.push((ch.to_string(), k)),
            }
        }
        out.push(
            segs.into_iter()
                .filter_map(|(text, k)| {
                    let sp = spans.get(k)?;
                    Some(Seg { text, bold: sp.bold, italic: sp.italic, underline: sp.underline, hot: hot.is_some() && sp.time == hot })
                })
                .collect(),
        );
    }
    out
}

/// Lay out and rasterise one caption for a `w`×`h` frame at timeline time `t`: a caption with
/// karaoke word timestamps draws the word being sung in the style's highlight colour and scale.
pub fn render_caption_at(c: &Caption, style: &CaptionStyle, w: usize, h: usize, t: Option<Tick>) -> Option<Overlay> {
    if w == 0 || h == 0 {
        return None;
    }
    let scale = h as f32 / 1080.0;
    let px = (style.size * scale).max(4.0);
    let max_w = w as f32 * 0.9;
    let styled = c.styled_lines();
    // the timestamp in effect at `t`: the last one at or before it
    let hot = t.and_then(|t| styled.iter().flatten().filter_map(|sp| sp.time).filter(|x| *x <= t).max());
    let hs = if style.highlight_scale.is_finite() { style.highlight_scale.clamp(0.25, 4.0) } else { 1.0 };
    let mut lines: Vec<Vec<Seg>> = Vec::new();
    // (speaker names are metadata; like Premiere, they are not burned in)
    for l in &styled {
        lines.extend(styled_wrap(l, hot, &style.font, px, max_w));
    }
    lines.retain(|l| l.iter().any(|s| !s.text.trim().is_empty()));
    if lines.is_empty() {
        return None;
    }
    let face = caption_style(&style.font, px);
    let vm = kition_film_text::fonts::face(kition_film_text::resolve(&face.family, &face.style).face).metrics(px);
    let (asc, desc) = (vm.ascent, vm.descent);
    let lh = px * style.line_spacing.max(0.8);
    let pad_x = (px * 0.3).round();
    let block_h = lh * lines.len() as f32;
    let (line_override, align_override) = vtt_overrides(&c.settings);
    let align = align_override.unwrap_or(style.align);
    let margin = style.margin.clamp(0.0, 0.45) * h as f32;
    let top = match (line_override, style.anchor) {
        (Some(f), _) => (f * h as f32).min(h as f32 - block_h),
        (None, CaptionAnchor::Top) => margin,
        (None, CaptionAnchor::Middle) => (h as f32 - block_h) / 2.0,
        (None, CaptionAnchor::Bottom) => h as f32 - margin - block_h,
    }
    .max(0.0)
    .round();
    let side = w as f32 * 0.05;
    // advance widths, spaces at a segment's ends included (a bar after the text keeps them), the
    // word being sung at its highlight size so it pushes its neighbours aside
    let seg_w: Vec<Vec<f32>> = lines
        .iter()
        .map(|l| {
            l.iter()
                .map(|sg| {
                    let st = seg_style(&style.font, px * if sg.hot { hs } else { 1.0 }, sg.bold, sg.italic);
                    if sg.text.ends_with(char::is_whitespace) {
                        (kition_film_text::measure(&format!("{}|", sg.text), &st) - kition_film_text::measure("|", &st)).max(0.0)
                    } else {
                        kition_film_text::measure(&sg.text, &st)
                    }
                })
                .collect()
        })
        .collect();
    let widths: Vec<f32> = seg_w.iter().map(|v| v.iter().sum()).collect();
    let xs: Vec<f32> = widths
        .iter()
        .map(|&lw| match align {
            CaptionAlign::Left => side + pad_x,
            CaptionAlign::Right => w as f32 - side - pad_x - lw,
            CaptionAlign::Center => (w as f32 - lw) / 2.0,
        })
        .collect();
    let outline = (style.outline * scale).max(0.0);
    // a highlighted word drawn larger reaches past its line
    let extra = if hot.is_some() { (px * (hs - 1.0)).max(0.0) } else { 0.0 };
    let grow = outline.ceil() + 1.0 + extra;
    let bx0 = xs.iter().zip(&widths).map(|(x, _)| x - pad_x - grow).fold(f32::MAX, f32::min).floor();
    let bx1 = xs.iter().zip(&widths).map(|(x, lw)| x + lw + pad_x + grow).fold(f32::MIN, f32::max).ceil();
    let by0 = (top - grow).floor();
    let by1 = (top + block_h + grow).ceil();
    let (ox, oy) = (bx0 as i32, by0 as i32);
    let ow = (bx1 - bx0).max(1.0) as usize;
    let oh = (by1 - by0).max(1.0) as usize;
    let mut cover = vec![0.0f32; ow * oh];
    let mut hcover = vec![0.0f32; ow * oh];
    let mut bg = vec![0.0f32; ow * oh];
    let fill = |m: &mut [f32], x0: f32, x1: f32, y0: f32, y1: f32| {
        for y in (y0.floor() as i32).max(oy)..(y1.ceil() as i32).min(oy + oh as i32) {
            let fy = ((y as f32 + 1.0).min(y1) - (y as f32).max(y0)).clamp(0.0, 1.0);
            for x in (x0.floor() as i32).max(ox)..(x1.ceil() as i32).min(ox + ow as i32) {
                let fx = ((x as f32 + 1.0).min(x1) - (x as f32).max(x0)).clamp(0.0, 1.0);
                if let Some(v) = m.get_mut((y - oy) as usize * ow + (x - ox) as usize) {
                    *v = (*v + fx * fy).min(1.0);
                }
            }
        }
    };
    for (i, line) in lines.iter().enumerate() {
        let lt = top + lh * i as f32;
        let (lx, lw) = (xs.get(i).copied().unwrap_or(0.0), widths.get(i).copied().unwrap_or(0.0));
        if style.background && style.background_color[3] > 0 {
            fill(&mut bg, lx - pad_x, lx + lw + pad_x, lt, lt + lh);
        }
        let baseline = lt + (lh - (asc + desc)) / 2.0 + asc;
        let mid = baseline - (asc - desc) / 2.0;
        let mut x = lx;
        for (k, sg) in line.iter().enumerate() {
            let sw = seg_w.get(i).and_then(|v| v.get(k)).copied().unwrap_or(0.0);
            let k_scale = if sg.hot { hs } else { 1.0 };
            let st = seg_style(&style.font, px * k_scale, sg.bold, sg.italic);
            // scaled about the line's middle, in the room measured for it
            let dx = x;
            let by = mid + (baseline - mid) * k_scale;
            let target = if sg.hot { &mut hcover } else { &mut cover };
            let l = layout(&sg.text, &st, &ParagraphStyle::default());
            let mut m = kition_film_text::Mask { w: ow, h: oh, a: std::mem::take(target) };
            render::draw(&l, &render::at(dx, by.round()), &mut m, (ox, oy));
            *target = m.a;
            if sg.underline {
                let uy = by + px * k_scale * 0.1;
                fill(target, dx, dx + sw, uy, uy + (px * k_scale * 0.06).max(1.0));
            }
            x += sw;
        }
    }
    let both: Vec<f32> = cover.iter().zip(&hcover).map(|(a, b)| a.max(*b)).collect();
    let stroke = if outline > 0.0 { dilate(&both, ow, oh, outline) } else { Vec::new() };
    let (tc, bc, oc, hc) = (lin(style.color), lin(style.background_color), lin(style.outline_color), lin(style.highlight_color));
    let mut out = vec![0.0f32; ow * oh * 4];
    for (j, px4) in out.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let mut p = [0.0f32; 4];
        let over = |p: &mut [f32; 4], c: [f32; 4], a: f32| {
            if a > 0.0 {
                for k in 0..4 {
                    p[k] = c[k] * a + p[k] * (1.0 - c[3] * a);
                }
            }
        };
        over(&mut p, bc, bg.get(j).copied().unwrap_or(0.0));
        if let Some(sv) = stroke.get(j) {
            over(&mut p, oc, *sv);
        }
        over(&mut p, tc, cover.get(j).copied().unwrap_or(0.0));
        over(&mut p, hc, hcover.get(j).copied().unwrap_or(0.0));
        *px4 = p;
    }
    Some(Overlay { x: ox, y: oy, w: ow, h: oh, px: out })
}

/// Max-filter a coverage mask with a disc of radius `r`.
fn dilate(m: &[f32], w: usize, h: usize, r: f32) -> Vec<f32> {
    let ri = r.ceil() as i32;
    let mut offs = Vec::new();
    for dy in -ri..=ri {
        for dx in -ri..=ri {
            let d = ((dx * dx + dy * dy) as f32).sqrt();
            if d <= r + 0.5 {
                offs.push((dx, dy, (r + 0.5 - d).clamp(0.0, 1.0)));
            }
        }
    }
    let mut out = vec![0.0f32; w * h];
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let mut v = 0.0f32;
            for &(dx, dy, wgt) in &offs {
                let (sx, sy) = (x + dx, y + dy);
                if sx >= 0 && sy >= 0 && sx < w as i32 && sy < h as i32 {
                    v = v.max(m[sy as usize * w + sx as usize] * wgt);
                }
            }
            out[y as usize * w + x as usize] = v;
        }
    }
    out
}

/// The overlay for a caption track at timeline time `t` (None when nothing shows).
pub fn track_overlay(track: &CaptionTrack, t: Tick, w: usize, h: usize) -> Option<Overlay> {
    if !track.enabled {
        return None;
    }
    let c = track.caption_at(t)?;
    render_caption_at(c, &track.style, w, h, Some(t))
}

/// Overlays of every visible caption track of a sequence at `t`, bottom track first.
pub fn sequence_overlays(seq: &Sequence, t: Tick, w: usize, h: usize) -> Vec<Overlay> {
    seq.caption_tracks.iter().rev().filter_map(|tr| track_overlay(tr, t, w, h)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kition_film_project::{CaptionFormat, ClipId, TrackId};

    fn cap(text: &str) -> Caption {
        Caption { id: ClipId(1), start: Tick(0), duration: Tick(100), text: text.into(), speaker: None, cue_id: None, settings: String::new() }
    }

    #[test]
    fn bottom_centre_with_box() {
        let st = CaptionStyle::default();
        let o = render_caption(&cap("Hello world"), &st, 1920, 1080).unwrap();
        // centred horizontally, in the lower part of the frame
        let cx = o.x as f32 + o.w as f32 / 2.0;
        assert!((cx - 960.0).abs() < 4.0, "centre {cx}");
        assert!(o.y > 800 && (o.y as usize + o.h) < 1080, "y {} h {}", o.y, o.h);
        // white text pixels exist and the box is dark translucent
        let mut white = 0;
        let mut boxy = 0;
        for p in o.px.chunks(4) {
            if p[3] > 0.99 && p[0] > 0.9 {
                white += 1;
            } else if p[3] > 0.7 && p[0] < 0.01 {
                boxy += 1;
            }
        }
        assert!(white > 500, "{white}");
        assert!(boxy > 1000, "{boxy}");
    }

    #[test]
    fn top_anchor_and_vtt_line() {
        let st = CaptionStyle { anchor: CaptionAnchor::Top, ..Default::default() };
        let o = render_caption(&cap("Top"), &st, 1280, 720).unwrap();
        assert!(o.y < 100);
        let mut c = cap("Line");
        c.settings = "line:50% align:start".into();
        let o = render_caption(&c, &CaptionStyle::default(), 1280, 720).unwrap();
        assert!((o.y - 360).abs() < 4, "{}", o.y);
        assert!(o.x < 120, "{}", o.x);
    }

    #[test]
    fn wraps_and_composites() {
        let long = "word ".repeat(60);
        let o = render_caption(&cap(&long), &CaptionStyle::default(), 640, 360).unwrap();
        assert!(o.w <= 640 && o.h > 40, "{}x{}", o.w, o.h);
        let mut canvas = vec![0.0f32; 640 * 360 * 4];
        o.composite_onto(&mut canvas, 640, 360);
        assert!(canvas.chunks(4).any(|p| p[0] > 0.9));
    }

    #[test]
    fn outline_draws_around_text() {
        let st = CaptionStyle { background: false, outline: 4.0, outline_color: [255, 0, 0, 255], ..Default::default() };
        let o = render_caption(&cap("O"), &st, 1920, 1080).unwrap();
        assert!(o.px.chunks(4).any(|p| p[0] > 0.9 && p[1] < 0.05 && p[3] > 0.9), "red outline pixels");
    }

    #[test]
    fn hidden_track_draws_nothing() {
        let mut t = CaptionTrack::new(TrackId(1), "S".into(), CaptionFormat::Subtitle);
        t.captions.push(cap("x"));
        assert!(track_overlay(&t, Tick(5), 100, 100).is_some());
        t.enabled = false;
        assert!(track_overlay(&t, Tick(5), 100, 100).is_none());
    }
}
