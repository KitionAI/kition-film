//! Caption tracks.
//!
//! Premiere keeps captions in their own track area above the video tracks. A [`CaptionTrack`] has a
//! format (Subtitle, CEA-608, CEA-708, Teletext), a track style (font, size, colour, background box,
//! position) and a list of [`Caption`] blocks with exact in/out times in sequence ticks. Captions on
//! one track never overlap (like track items); [`CaptionTrack::check`] verifies it.
//!
//! Caption text is kept as written (lines separated by `\n`, inline `<i>`/`<b>`/`<u>` tags and
//! WebVTT cue settings preserved) so files round-trip; renderers strip markup for display.

use kition_film_time::{Tick, TimeRange};
use serde::{Deserialize, Serialize};

use crate::{ClipId, TrackId};

/// Caption stream format of a track (Premiere's "Caption Format" choices).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CaptionFormat {
    /// Open/sidecar subtitles (SRT, WebVTT).
    #[default]
    Subtitle,
    /// CEA-608 (line 21) closed captions.
    Cea608,
    /// CEA-708 (DTVCC) closed captions.
    Cea708,
    /// EBU Teletext subtitles.
    Teletext,
}

impl CaptionFormat {
    pub const ALL: [CaptionFormat; 4] = [CaptionFormat::Subtitle, CaptionFormat::Cea608, CaptionFormat::Cea708, CaptionFormat::Teletext];
    pub fn label(self) -> &'static str {
        match self {
            CaptionFormat::Subtitle => "Subtitle",
            CaptionFormat::Cea608 => "CEA-608",
            CaptionFormat::Cea708 => "CEA-708",
            CaptionFormat::Teletext => "Teletext",
        }
    }
    pub fn from_name(s: &str) -> Option<CaptionFormat> {
        let n = s.to_ascii_lowercase().replace(['-', ' ', '_'], "");
        Self::ALL.iter().copied().find(|f| f.label().to_ascii_lowercase().replace(['-', ' '], "") == n)
    }
    /// Characters per line limit used when wrapping (608 is fixed at 32 columns).
    pub fn max_columns(self) -> Option<usize> {
        match self {
            CaptionFormat::Cea608 => Some(32),
            CaptionFormat::Teletext => Some(40),
            CaptionFormat::Cea708 => Some(42),
            CaptionFormat::Subtitle => None,
        }
    }
}

/// Horizontal text alignment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CaptionAlign {
    Left,
    #[default]
    Center,
    Right,
}

/// Vertical placement of the caption block in the frame.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CaptionAnchor {
    Top,
    Middle,
    #[default]
    Bottom,
}

/// Track-level caption style (Premiere's caption track style / the Graphics Templates panel's text settings).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptionStyle {
    /// Font family name, drawn SemiBold (or its nearest weight) when captions are burned in; a
    /// family that is not installed falls back to the bundled Inter.
    pub font: String,
    /// Font size in pixels for a 1080-line frame (scaled with the frame height).
    pub size: f32,
    /// Text colour, sRGB + alpha.
    pub color: [u8; 4],
    /// Draw a background box behind each line.
    pub background: bool,
    /// Background box colour, sRGB + alpha.
    pub background_color: [u8; 4],
    pub align: CaptionAlign,
    pub anchor: CaptionAnchor,
    /// Distance from the anchored frame edge, as a fraction of the frame height.
    pub margin: f32,
    /// Line height as a multiple of the font size.
    pub line_spacing: f32,
    /// Text outline width in pixels at 1080 lines (0 = none).
    pub outline: f32,
    pub outline_color: [u8; 4],
    /// Karaoke: the colour of the word being sung (captions with WebVTT `<00:00:01.000>` word
    /// timestamps), sRGB + alpha.
    pub highlight_color: [u8; 4],
    /// Karaoke: the size of the word being sung relative to the others (1 = same size).
    pub highlight_scale: f32,
}

impl Default for CaptionStyle {
    fn default() -> Self {
        Self {
            font: "Inter".into(),
            size: 54.0,
            color: [255, 255, 255, 255],
            background: true,
            background_color: [0, 0, 0, 191],
            align: CaptionAlign::Center,
            anchor: CaptionAnchor::Bottom,
            margin: 0.08,
            line_spacing: 1.25,
            outline: 0.0,
            outline_color: [0, 0, 0, 255],
            highlight_color: [255, 214, 10, 255],
            highlight_scale: 1.0,
        }
    }
}

/// One caption block on a caption track.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Caption {
    pub id: ClipId,
    /// Timeline start (sequence ticks).
    pub start: Tick,
    pub duration: Tick,
    /// Caption text; lines separated by `\n`.
    pub text: String,
    /// Speaker name (WebVTT `<v Name>` voice span).
    #[serde(default)]
    pub speaker: Option<String>,
    /// WebVTT cue identifier, kept for round trips.
    #[serde(default)]
    pub cue_id: Option<String>,
    /// WebVTT cue settings (`line:90% align:start`…), kept verbatim.
    #[serde(default)]
    pub settings: String,
}

impl Caption {
    pub fn end(&self) -> Tick {
        self.start + self.duration
    }
    pub fn range(&self) -> TimeRange {
        TimeRange::new(self.start, self.duration)
    }
    /// The caption's text with markup removed and entities decoded (what is drawn).
    pub fn plain_lines(&self) -> Vec<String> {
        plain_text(&self.text).lines().map(str::to_string).collect()
    }
    /// The caption's lines as styled runs (what is drawn, with `<b>`, `<i>`, `<u>` and karaoke
    /// word timestamps).
    pub fn styled_lines(&self) -> Vec<Vec<Span>> {
        styled_text(&self.text)
    }
    /// Move the caption by `delta`, its karaoke word timestamps with it.
    pub fn shift(&mut self, delta: Tick) {
        self.start += delta;
        if self.text.contains('<') {
            self.text = shift_timestamps(&self.text, delta);
        }
    }
}

/// A run of caption text with one style.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Span {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// The karaoke timestamp the run follows (WebVTT `<00:00:01.000>`, sequence time): the run is
    /// sung from then until the next timestamp. Runs before the first timestamp have none.
    pub time: Option<Tick>,
}

/// A WebVTT timestamp tag's time (`00:00:01.500` or `00:01.500`).
pub fn parse_timestamp(tag: &str) -> Option<Tick> {
    let tag = tag.trim();
    let (hms, frac) = tag.split_once('.')?;
    if frac.len() != 3 || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parts: Vec<&str> = hms.split(':').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let mut secs: i64 = 0;
    for p in &parts {
        secs = secs.checked_mul(60)?.checked_add(p.parse::<i64>().ok()?)?;
    }
    let ms = secs.checked_mul(1000)?.checked_add(frac.parse::<i64>().ok()?)?;
    Some(Tick::from_units(ms, 1000))
}

/// A WebVTT timestamp (`00:00:01.500`) for a time (negative times are written as 0).
pub fn format_timestamp(t: Tick) -> String {
    let ms = t.to_units_floor(1000).max(0);
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

/// Move every karaoke timestamp of caption text by `delta`.
pub fn shift_timestamps(text: &str, delta: Tick) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('>') {
            Some(j) => {
                let tag = &after[..j];
                match parse_timestamp(tag) {
                    Some(t) => {
                        out.push('<');
                        out.push_str(&format_timestamp(t + delta));
                        out.push('>');
                    }
                    None => {
                        out.push('<');
                        out.push_str(tag);
                        out.push('>');
                    }
                }
                rest = &after[j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Caption text as lines of styled runs: `<b>`, `<i>`, `<u>` and karaoke timestamps are kept,
/// other tags (`<c.x>`, `<v Name>`, `<lang>`, `<ruby>`) and SSA override blocks are dropped and
/// entities decoded, as [`plain_text`] does.
pub fn styled_text(s: &str) -> Vec<Vec<Span>> {
    let mut lines: Vec<Vec<Span>> = vec![Vec::new()];
    let mut cur = Span::default();
    let flush = |lines: &mut Vec<Vec<Span>>, cur: &mut Span| {
        if !cur.text.is_empty() {
            let next = Span { text: String::new(), ..cur.clone() };
            if let Some(l) = lines.last_mut() {
                l.push(std::mem::replace(cur, next));
            }
        }
    };
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            '<' => {
                let rest = s.get(i + 1..).unwrap_or("");
                let Some(end) = rest.find('>') else {
                    cur.text.push('<');
                    continue;
                };
                let tag = rest.get(..end).unwrap_or("");
                for _ in 0..tag.chars().count() + 1 {
                    chars.next();
                }
                let name = tag.trim().to_ascii_lowercase();
                let (closing, name) = match name.strip_prefix('/') {
                    Some(n) => (true, n.to_string()),
                    None => (false, name),
                };
                let base = name.split(['.', ' ']).next().unwrap_or("");
                if let Some(t) = parse_timestamp(tag) {
                    flush(&mut lines, &mut cur);
                    keep_empty(&mut lines, &cur);
                    cur.time = Some(t);
                    continue;
                }
                match base {
                    "b" | "i" | "u" => {
                        flush(&mut lines, &mut cur);
                        let on = !closing;
                        match base {
                            "b" => cur.bold = on,
                            "i" => cur.italic = on,
                            _ => cur.underline = on,
                        }
                    }
                    _ => {}
                }
            }
            '{' if chars.peek().map(|x| x.1) == Some('\\') => {
                let rest = s.get(i + 1..).unwrap_or("");
                if let Some(end) = rest.find('}') {
                    for _ in 0..rest.get(..=end).unwrap_or("").chars().count() {
                        chars.next();
                    }
                } else {
                    cur.text.push('{');
                }
            }
            '&' => {
                let rest = s.get(i + 1..).unwrap_or("");
                let ents = [
                    ("amp;", '&'),
                    ("lt;", '<'),
                    ("gt;", '>'),
                    ("nbsp;", '\u{a0}'),
                    ("quot;", '"'),
                    ("apos;", '\''),
                    ("lrm;", '\u{200e}'),
                    ("rlm;", '\u{200f}'),
                ];
                if let Some((name, ch)) = ents.iter().find(|(n, _)| rest.starts_with(n)) {
                    for _ in 0..name.len() {
                        chars.next();
                    }
                    cur.text.push(*ch);
                } else {
                    cur.text.push('&');
                }
            }
            '\r' => {}
            '\n' => {
                flush(&mut lines, &mut cur);
                lines.push(Vec::new());
            }
            _ => cur.text.push(c),
        }
    }
    flush(&mut lines, &mut cur);
    keep_empty(&mut lines, &cur);
    lines
}

/// A timestamp with no text before the next one (a pause between words) still ends the word
/// before it: keep it as an empty run.
fn keep_empty(lines: &mut [Vec<Span>], cur: &Span) {
    if cur.time.is_none() {
        return;
    }
    let Some(line) = lines.last_mut() else { return };
    if line.last().is_none_or(|sp| sp.time != cur.time) {
        line.push(Span { text: String::new(), ..cur.clone() });
    }
}

/// A caption track (shown in the caption area above the video tracks).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CaptionTrack {
    pub id: TrackId,
    pub name: String,
    pub format: CaptionFormat,
    /// BCP-47 language tag (`en`, `fr-CA`…).
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub style: CaptionStyle,
    /// Track output (eye): shown in the Program monitor and burned in on export.
    pub enabled: bool,
    pub locked: bool,
    /// Follows inserts / extracts on other tracks.
    #[serde(default = "yes")]
    pub sync_lock: bool,
    /// Captions sorted by start, non-overlapping.
    pub captions: Vec<Caption>,
    /// WebVTT header blocks (STYLE / REGION / NOTE) kept for round trips.
    #[serde(default)]
    pub vtt_blocks: Vec<String>,
}

fn yes() -> bool {
    true
}

impl CaptionTrack {
    pub fn new(id: TrackId, name: String, format: CaptionFormat) -> Self {
        Self {
            id,
            name,
            format,
            language: "en".into(),
            style: CaptionStyle::default(),
            enabled: true,
            locked: false,
            sync_lock: true,
            captions: Vec::new(),
            vtt_blocks: Vec::new(),
        }
    }
    pub fn end(&self) -> Tick {
        self.captions.iter().map(Caption::end).max().unwrap_or(Tick::ZERO)
    }
    /// Caption covering `t`.
    pub fn caption_at(&self, t: Tick) -> Option<&Caption> {
        let idx = self.captions.partition_point(|c| c.start <= t);
        idx.checked_sub(1).map(|i| &self.captions[i]).filter(|c| t < c.end())
    }
    pub fn caption(&self, id: ClipId) -> Option<&Caption> {
        self.captions.iter().find(|c| c.id == id)
    }
    pub fn caption_mut(&mut self, id: ClipId) -> Option<&mut Caption> {
        self.captions.iter_mut().find(|c| c.id == id)
    }
    pub fn sort(&mut self) {
        self.captions.sort_by_key(|c| c.start);
    }
    /// Invariant check: captions sorted, positive duration, no overlaps.
    pub fn check(&self) -> Result<(), String> {
        self.check_bounds()?;
        for c in &self.captions {
            if c.duration.0 <= 0 {
                return Err(format!("{}: caption {:?} has non-positive duration", self.name, c.id));
            }
        }
        for w in self.captions.windows(2) {
            if w[0].end() > w[1].start {
                return Err(format!("{}: captions {:?} and {:?} overlap", self.name, w[0].id, w[1].id));
            }
        }
        Ok(())
    }
    /// Only the time bounds that keep caption arithmetic from overflowing (see `Track::check_bounds`).
    pub fn check_bounds(&self) -> Result<(), String> {
        for c in &self.captions {
            if !crate::bounded_time_range(c.start, c.duration) {
                return Err(format!("{}: caption {:?} is outside supported time bounds", self.name, c.id));
            }
        }
        Ok(())
    }
}

/// Strip `<…>` tags and decode the common HTML/WebVTT entities.
pub fn plain_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '<' => {
                // a tag runs to the next '>' (if none, keep the '<' literally)
                let rest: String = chars.clone().collect();
                if let Some(end) = rest.find('>') {
                    for _ in 0..rest[..=end].chars().count() {
                        chars.next();
                    }
                } else {
                    out.push('<');
                }
            }
            '{' if chars.peek() == Some(&'\\') => {
                // SSA-style override blocks some SRT files carry: {\an8}
                let rest: String = chars.clone().collect();
                if let Some(end) = rest.find('}') {
                    for _ in 0..rest[..=end].chars().count() {
                        chars.next();
                    }
                } else {
                    out.push('{');
                }
            }
            '&' => {
                let rest: String = chars.clone().take(8).collect();
                let ents = [
                    ("amp;", '&'),
                    ("lt;", '<'),
                    ("gt;", '>'),
                    ("nbsp;", '\u{a0}'),
                    ("quot;", '"'),
                    ("apos;", '\''),
                    ("lrm;", '\u{200e}'),
                    ("rlm;", '\u{200f}'),
                ];
                if let Some((name, ch)) = ents.iter().find(|(n, _)| rest.starts_with(n)) {
                    for _ in 0..name.len() {
                        chars.next();
                    }
                    out.push(*ch);
                } else {
                    out.push('&');
                }
            }
            '\r' => {}
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain() {
        assert_eq!(plain_text("<i>Hello</i> &amp; <b>bye</b>"), "Hello & bye");
        assert_eq!(plain_text("{\\an8}Top"), "Top");
        assert_eq!(plain_text("a < b"), "a < b");
        assert_eq!(plain_text("<v Bob>Hi</v>"), "Hi");
    }

    #[test]
    fn caption_at() {
        let mut t = CaptionTrack::new(TrackId(1), "Subtitle".into(), CaptionFormat::Subtitle);
        for (i, s) in [0i64, 100, 300].iter().enumerate() {
            t.captions.push(Caption {
                id: ClipId(i as u64),
                start: Tick(*s),
                duration: Tick(50),
                text: format!("c{i}"),
                speaker: None,
                cue_id: None,
                settings: String::new(),
            });
        }
        assert_eq!(t.caption_at(Tick(120)).unwrap().text, "c1");
        assert!(t.caption_at(Tick(160)).is_none());
        assert!(t.check().is_ok());
        assert_eq!(CaptionFormat::from_name("cea608"), Some(CaptionFormat::Cea608));
        assert_eq!(CaptionFormat::from_name("CEA-708"), Some(CaptionFormat::Cea708));
    }

    #[test]
    fn corrupt_caption_times_do_not_overflow_the_overlap_check() {
        let mut track = CaptionTrack::new(TrackId(1), "Subtitles".into(), CaptionFormat::Subtitle);
        for (id, start) in [(1, i64::MAX), (2, 10)] {
            track.captions.push(Caption {
                id: ClipId(id),
                start: Tick(start),
                duration: Tick(50),
                text: String::new(),
                speaker: None,
                cue_id: None,
                settings: String::new(),
            });
        }
        let result = std::panic::catch_unwind(|| track.check());
        assert!(result.is_ok());
        assert!(result.unwrap().is_err());
    }
}
