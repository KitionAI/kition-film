//! Caption commands: caption tracks, caption editing, caption file import/export.
//!
//! Ids (`captions.*`) follow Premiere's Sequence ▸ Captions menu and the Text panel's Captions tab.
//! Captions are addressed by id (`caption`, `captions`); without one, commands use the caption
//! selection (`EditorState::caption_selection`) or the caption under the playhead. Caption tracks
//! are addressed by id or `"C1"`, `"C2"`… (top first); the default is the first caption track.

use serde_json::{Value, json};

use kition_film_captions::{Document, Format, WriteOptions};
use kition_film_edit as edit;
use kition_film_edit::Edge;
use kition_film_project::{CaptionAlign, CaptionAnchor, CaptionFormat, CaptionStyle, CaptionTrack, ClipId, SequenceSettings, TrackId};
use kition_film_time::{Tick, TimeDisplay, format_time};

use crate::commands::{CommandSpec, always, bad, bool_p, f64_p, has_seq, str_p, time_p, u64_p};
use crate::{EngineError, Result, Session};

type Run = fn(&mut Session, &Value) -> Result<Value>;
type Enabled = fn(&Session) -> std::result::Result<(), String>;

fn spec(
    id: &'static str,
    label: &'static str,
    menu: &'static [&'static str],
    shortcut: Option<&'static str>,
    params: &'static str,
    enabled: Enabled,
    run: Run,
) -> CommandSpec {
    CommandSpec { id, label, menu, shortcut, params, enabled, run, journal: true }
}

fn has_caption_track(s: &Session) -> std::result::Result<(), String> {
    has_seq(s)?;
    if s.active_sequence().is_some_and(|q| !q.caption_tracks.is_empty()) { Ok(()) } else { Err("the sequence has no caption track".into()) }
}

fn has_captions(s: &Session) -> std::result::Result<(), String> {
    has_caption_track(s)?;
    if s.active_sequence().is_some_and(|q| q.caption_tracks.iter().any(|t| !t.captions.is_empty())) { Ok(()) } else { Err("there are no captions".into()) }
}

/// The caption track named by `track` (id or "C1"…), else the first one.
pub fn track_param(s: &Session, p: &Value) -> Option<TrackId> {
    let seq = s.active_sequence()?;
    match p.get("track") {
        Some(Value::Number(n)) => n.as_u64().map(TrackId).filter(|t| seq.caption_track(*t).is_some()),
        Some(Value::String(name)) => {
            let idx: usize = name.trim_start_matches(['C', 'c']).parse().ok()?;
            seq.caption_tracks.get(idx.checked_sub(1)?).map(|t| t.id)
        }
        _ => seq.caption_tracks.first().map(|t| t.id),
    }
}

pub(crate) fn caption_ids(s: &Session, p: &Value) -> Vec<ClipId> {
    if let Some(a) = p.get("captions").and_then(Value::as_array) {
        return a.iter().filter_map(Value::as_u64).map(ClipId).collect();
    }
    if let Some(c) = u64_p(p, "caption") {
        return vec![ClipId(c)];
    }
    if !s.state.caption_selection.is_empty() {
        return s.state.caption_selection.clone();
    }
    // the caption under the playhead on the first caption track that has one
    let t = s.playhead();
    s.active_sequence().and_then(|q| q.caption_tracks.iter().find_map(|tr| tr.caption_at(t).map(|c| c.id))).into_iter().collect()
}

fn one_caption(s: &Session, p: &Value, cmd: &str) -> Result<ClipId> {
    caption_ids(s, p).first().copied().ok_or_else(|| bad(cmd, "no caption (pass `caption` or select one)"))
}

fn parse_color(v: &Value) -> Option<[u8; 4]> {
    if let Some(a) = v.as_array() {
        let c: Vec<u8> = a.iter().filter_map(|x| x.as_u64().map(|n| n.min(255) as u8)).collect();
        return match c.len() {
            3 => Some([c[0], c[1], c[2], 255]),
            4 => Some([c[0], c[1], c[2], c[3]]),
            _ => None,
        };
    }
    let h = v.as_str()?.trim_start_matches('#');
    let b = |i: usize| u8::from_str_radix(h.get(i..i + 2)?, 16).ok();
    match h.len() {
        6 => Some([b(0)?, b(2)?, b(4)?, 255]),
        8 => Some([b(0)?, b(2)?, b(4)?, b(6)?]),
        _ => None,
    }
}

fn hex(c: [u8; 4]) -> String {
    format!("#{:02x}{:02x}{:02x}{:02x}", c[0], c[1], c[2], c[3])
}

/// The caption format of a file, if it is one (extension `.srt` / `.vtt` / `.scc` / `.mcc` /
/// `.stl` / `.ttml` / `.dfxp` / `.xml`, confirmed by content).
pub fn detect(path: &str, bytes: &[u8]) -> Option<Format> {
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !matches!(ext.as_deref(), Some("srt" | "vtt" | "scc" | "webvtt" | "mcc" | "stl" | "ttml" | "dfxp" | "xml")) {
        return None;
    }
    kition_film_captions::detect(bytes, ext.as_deref())
}

/// Import a caption file as a new caption track in the active sequence (a new sequence is made
/// when none is open), snapped to the sequence's frames. One undo step.
pub fn import(s: &mut Session, path: &str, bytes: &[u8], format: Format, name: Option<&str>) -> Result<Value> {
    let mut doc = kition_film_captions::parse(bytes, format).map_err(|e| EngineError::Other(format!("{path}: {e}")))?;
    let stem = std::path::Path::new(path).file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Captions".into());
    let track_name = name.map(str::to_string).unwrap_or_else(|| stem.clone());
    let existing = s.state.active_sequence.filter(|id| s.project.sequence(*id).is_some());
    let rate = existing.and_then(|id| s.project.sequence(id)).map(|q| q.settings.frame_rate).unwrap_or_default();
    doc.snap_to_frames(rate);
    let n = doc.cues.len();
    let warnings = doc.warnings.clone();
    let (seq_id, tid) = s.edit(&format!("Import Captions {stem}"), |p, st| {
        let seq_id = match existing {
            Some(id) => id,
            None => {
                let id = p.new_sequence(&stem, SequenceSettings::default(), 3, 3, None);
                st.active_sequence = Some(id);
                st.open_sequences.push(id);
                id
            }
        };
        let tid = TrackId(p.alloc_id());
        let mut next = p.next_id;
        let mut alloc = || {
            let v = next;
            next += 1;
            v
        };
        let mut track = kition_film_captions::track_from_document(&doc, tid, &track_name, format.track_format(), &mut alloc);
        if format == Format::Scc {
            track.style.background_color = [0, 0, 0, 255];
        }
        p.next_id = next;
        let q = p.sequence_mut(seq_id).ok_or(EngineError::NoSequence)?;
        q.caption_tracks.push(track);
        q.check().map_err(EngineError::Other)?;
        st.caption_selection.clear();
        Ok((seq_id, tid))
    })?;
    Ok(json!({"format": format.name(), "sequence": seq_id.0, "track": tid.0, "captions": n, "warnings": warnings}))
}

/// Delete captions (Clear / Ripple Delete with captions selected).
pub fn delete(s: &mut Session, ids: &[ClipId], ripple: bool) -> Result<Value> {
    if ids.is_empty() {
        return Err(bad("caption.delete", "no captions"));
    }
    let ids = ids.to_vec();
    let n = s.edit_sequence(if ripple { "Ripple Delete Captions" } else { "Delete Captions" }, |q, _, st| {
        let n = edit::captions::delete_captions(q, &ids, ripple)?;
        st.caption_selection.retain(|c| !ids.contains(c));
        Ok(n)
    })?;
    Ok(json!({"deleted": n}))
}

fn caption_json(s: &Session, c: &kition_film_project::Caption) -> Value {
    let q = s.active_sequence();
    let (rate, df) = q.map(|q| (q.settings.frame_rate, q.settings.drop_frame)).unwrap_or_default();
    let tc = |t: Tick| format_time(t, rate, df, TimeDisplay::Timecode, 48_000);
    json!({
        "id": c.id.0,
        "start": c.start.0,
        "end": c.end().0,
        "in": tc(c.start),
        "out": tc(c.end()),
        "duration": tc(c.duration),
        "text": c.text,
        "speaker": c.speaker,
        "settings": c.settings,
    })
}

fn track_json(s: &Session, t: &CaptionTrack, index: usize) -> Value {
    json!({
        "id": t.id.0,
        "label": format!("C{}", index + 1),
        "name": t.name,
        "format": t.format.label(),
        "language": t.language,
        "enabled": t.enabled,
        "locked": t.locked,
        "syncLock": t.sync_lock,
        "style": {
            "font": t.style.font, "size": t.style.size, "color": hex(t.style.color),
            "background": t.style.background, "backgroundColor": hex(t.style.background_color),
            "align": format!("{:?}", t.style.align).to_lowercase(), "anchor": format!("{:?}", t.style.anchor).to_lowercase(),
            "margin": t.style.margin, "lineSpacing": t.style.line_spacing, "outline": t.style.outline, "outlineColor": hex(t.style.outline_color),
            "highlightColor": hex(t.style.highlight_color), "highlightScale": t.style.highlight_scale,
        },
        "captions": t.captions.iter().map(|c| caption_json(s, c)).collect::<Vec<_>>(),
    })
}

fn export(s: &mut Session, p: &Value) -> Result<Value> {
    let path = str_p(p, "path").ok_or_else(|| bad("caption.export", "need `path`"))?.to_string();
    let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("");
    let format = str_p(p, "format").and_then(Format::from_name).or_else(|| Format::from_name(ext)).unwrap_or(Format::Srt);
    let tid = track_param(s, p).ok_or_else(|| bad("caption.export", "no caption track"))?;
    let seq = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let track = seq.caption_track(tid).ok_or_else(|| bad("caption.export", "no such caption track"))?;
    let doc: Document = kition_film_captions::document_from_track(track, Tick::ZERO);
    let df = bool_p(p, "dropFrame").unwrap_or(true);
    let bytes = kition_film_captions::write(&doc, format, WriteOptions { drop_frame: df, rate: Some(seq.settings.frame_rate) });
    let n = doc.cues.len();
    s.services.write_file(&path, &bytes).map_err(|e| EngineError::Other(e.to_string()))?;
    Ok(json!({"path": path, "format": format.name(), "captions": n, "bytes": bytes.len()}))
}

fn delta_p(s: &Session, p: &Value) -> Option<Tick> {
    if let Some(d) = p.get("delta").and_then(Value::as_i64) {
        return Some(Tick(d));
    }
    p.get("deltaFrames").and_then(Value::as_i64).map(|f| s.sequence_rate().tick_of(f))
}

/// Chinese, Japanese and Korean characters: karaoke words in these scripts join without a space.
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF | 0x2E80..=0x2FDF | 0x2FF0..=0x303F | 0x3040..=0x31FF | 0x3200..=0x9FFF | 0xA960..=0xA97F
        | 0xAC00..=0xD7FF | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFFEF | 0x20000..=0x3FFFF)
}

/// Escape caption markup characters in a karaoke word.
fn escape(t: &str) -> String {
    t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `caption.add` `words`: the caption text with a WebVTT timestamp before each word (and one at
/// each word's end when a pause follows), and the span of the words. Words in Chinese, Japanese
/// and Korean join without a space, others with one.
fn karaoke_words(p: &Value) -> Result<Option<(String, Tick, Tick)>> {
    const CMD: &str = "caption.add";
    let Some(list) = p.get("words") else { return Ok(None) };
    let list = list.as_array().ok_or_else(|| bad(CMD, "`words` is a list of {text, start, end} (seconds)"))?;
    if list.is_empty() {
        return Err(bad(CMD, "`words` is empty"));
    }
    if list.len() > 2000 {
        return Err(bad(CMD, "at most 2000 words in one caption"));
    }
    let mut words = Vec::with_capacity(list.len());
    for (k, w) in list.iter().enumerate() {
        let text = str_p(w, "text").ok_or_else(|| bad(CMD, format!("words[{k}]: need `text`")))?;
        let a = f64_p(w, "start").filter(|x| x.is_finite() && *x >= 0.0).ok_or_else(|| bad(CMD, format!("words[{k}]: need `start` (seconds, ≥ 0)")))?;
        let b = f64_p(w, "end").filter(|x| x.is_finite() && *x >= a).ok_or_else(|| bad(CMD, format!("words[{k}]: need `end` (seconds, ≥ start)")))?;
        words.push((text.replace(['\n', '\r'], " "), Tick::from_seconds_f64(a), Tick::from_seconds_f64(b)));
    }
    words.sort_by_key(|w| w.1);
    let ts = |t: Tick| format!("<{}>", kition_film_project::caption::format_timestamp(t));
    let mut text = String::new();
    let mut prev: Option<(char, Tick)> = None;
    for (word, a, b) in &words {
        let first = word.chars().next().unwrap_or(' ');
        if let Some((last, end)) = prev {
            // a pause: the word before stops being sung at its end
            if *a > end + Tick::from_units(1, 1000) {
                text.push_str(&ts(end));
            }
            let joined = (is_cjk(last) && is_cjk(first)) || last.is_whitespace() || first.is_whitespace();
            if !joined {
                text.push(' ');
            }
        }
        text.push_str(&ts(*a));
        text.push_str(&escape(word));
        prev = Some((word.chars().last().unwrap_or(' '), *b));
    }
    let start = words.first().map_or(Tick::ZERO, |w| w.1);
    let end = words.iter().map(|w| w.2).max().unwrap_or(start);
    if let Some((_, e)) = prev {
        text.push_str(&ts(e));
    }
    Ok(Some((text, start, end)))
}

pub fn commands() -> Vec<CommandSpec> {
    vec![
        spec(
            "caption.newTrack",
            "Add New Caption Track…",
            &["Sequence", "Captions"],
            Some("Cmd+Alt+A"),
            r#"{"format":"Subtitle|CEA-608|CEA-708|Teletext","name":str?,"language":str?}"#,
            has_seq,
            |s, p| {
                let format = str_p(p, "format").and_then(CaptionFormat::from_name).unwrap_or_default();
                let name = str_p(p, "name").map(str::to_string).unwrap_or_else(|| format.label().to_string());
                let lang = str_p(p, "language").unwrap_or("en").to_string();
                let seq = s.state.active_sequence.ok_or(EngineError::NoSequence)?;
                let (id, index) = s.edit("Add Caption Track", |pr, _| {
                    let id = TrackId(pr.alloc_id());
                    let mut t = CaptionTrack::new(id, name, format);
                    t.language = lang;
                    if format == CaptionFormat::Cea608 {
                        t.style.background_color = [0, 0, 0, 255];
                    }
                    // after the existing tracks: C1, C2… keep naming the tracks they named
                    let tracks = &mut pr.sequence_mut(seq).ok_or(EngineError::NoSequence)?.caption_tracks;
                    tracks.push(t);
                    Ok((id, tracks.len()))
                })?;
                Ok(json!({"track": id.0, "label": format!("C{index}")}))
            },
        ),
        spec("caption.deleteTrack", "Delete Caption Track", &[], None, r#"{"track":id|"C1"}"#, has_caption_track, |s, p| {
            let tid = track_param(s, p).ok_or_else(|| bad("caption.deleteTrack", "no such caption track"))?;
            s.edit_sequence("Delete Caption Track", |q, _, st| {
                q.caption_tracks.retain(|t| t.id != tid);
                st.caption_selection.retain(|c| q.find_caption(*c).is_some());
                Ok(())
            })?;
            Ok(Value::Null)
        }),
        spec(
            "caption.setTrack",
            "Caption Track Settings",
            &[],
            None,
            r#"{"track":id|"C1","name":str?,"format":str?,"language":str?,"enabled":bool?,"locked":bool?,"syncLock":bool?}"#,
            has_caption_track,
            |s, p| {
                let tid = track_param(s, p).ok_or_else(|| bad("caption.setTrack", "no such caption track"))?;
                let p = p.clone();
                s.edit("Caption Track Settings", |pr, st| {
                    let seq = st.active_sequence.ok_or(EngineError::NoSequence)?;
                    let t = pr.sequence_mut(seq).and_then(|q| q.caption_track_mut(tid)).ok_or(EngineError::NoSequence)?;
                    if let Some(n) = str_p(&p, "name") {
                        t.name = n.to_string();
                    }
                    if let Some(f) = str_p(&p, "format") {
                        t.format = CaptionFormat::from_name(f).ok_or_else(|| bad("caption.setTrack", "unknown format"))?;
                    }
                    if let Some(l) = str_p(&p, "language") {
                        t.language = l.to_string();
                    }
                    if let Some(b) = bool_p(&p, "enabled") {
                        t.enabled = b;
                    }
                    if let Some(b) = bool_p(&p, "locked") {
                        t.locked = b;
                    }
                    if let Some(b) = bool_p(&p, "syncLock") {
                        t.sync_lock = b;
                    }
                    Ok(())
                })?;
                Ok(Value::Null)
            },
        ),
        spec(
            "caption.setStyle",
            "Caption Track Style",
            &[],
            None,
            r##"{"track":id|"C1","font":str?,"size":f32?,"color":"#rrggbb[aa]"?,"background":bool?,"backgroundColor":"#rrggbbaa"?,"align":"left|center|right"?,"anchor":"top|middle|bottom"?,"margin":0..0.45 (fraction of frame height)?,"lineSpacing":f32?,"outline":f32?,"outlineColor":str?,"highlightColor":"#rrggbb[aa]" (karaoke word)?,"highlightScale":0.25..4 (karaoke word size)?,"reset":bool?}"##,
            has_caption_track,
            |s, p| {
                let tid = track_param(s, p).ok_or_else(|| bad("caption.setStyle", "no such caption track"))?;
                let p = p.clone();
                s.edit("Caption Style", |pr, st| {
                    let seq = st.active_sequence.ok_or(EngineError::NoSequence)?;
                    let t = pr.sequence_mut(seq).and_then(|q| q.caption_track_mut(tid)).ok_or(EngineError::NoSequence)?;
                    let y = &mut t.style;
                    if bool_p(&p, "reset").unwrap_or(false) {
                        *y = CaptionStyle::default();
                    }
                    if let Some(v) = str_p(&p, "font") {
                        y.font = v.to_string();
                    }
                    if let Some(v) = f64_p(&p, "size") {
                        y.size = (v as f32).clamp(4.0, 400.0);
                    }
                    if let Some(c) = p.get("color").and_then(parse_color) {
                        y.color = c;
                    }
                    if let Some(b) = bool_p(&p, "background") {
                        y.background = b;
                    }
                    if let Some(c) = p.get("backgroundColor").and_then(parse_color) {
                        y.background_color = c;
                    }
                    if let Some(c) = p.get("outlineColor").and_then(parse_color) {
                        y.outline_color = c;
                    }
                    if let Some(c) = p.get("highlightColor").and_then(parse_color) {
                        y.highlight_color = c;
                    }
                    if let Some(v) = f64_p(&p, "highlightScale").filter(|v| v.is_finite()) {
                        y.highlight_scale = (v as f32).clamp(0.25, 4.0);
                    }
                    if let Some(v) = f64_p(&p, "outline") {
                        y.outline = (v as f32).clamp(0.0, 40.0);
                    }
                    if let Some(v) = f64_p(&p, "margin") {
                        y.margin = (v as f32).clamp(0.0, 0.45);
                    }
                    if let Some(v) = f64_p(&p, "lineSpacing") {
                        y.line_spacing = (v as f32).clamp(0.8, 4.0);
                    }
                    match str_p(&p, "align") {
                        Some("left") => y.align = CaptionAlign::Left,
                        Some("right") => y.align = CaptionAlign::Right,
                        Some("center") => y.align = CaptionAlign::Center,
                        Some(o) => return Err(bad("caption.setStyle", format!("unknown align `{o}`"))),
                        None => {}
                    }
                    match str_p(&p, "anchor") {
                        Some("top") => y.anchor = CaptionAnchor::Top,
                        Some("middle") => y.anchor = CaptionAnchor::Middle,
                        Some("bottom") => y.anchor = CaptionAnchor::Bottom,
                        Some(o) => return Err(bad("caption.setStyle", format!("unknown anchor `{o}`"))),
                        None => {}
                    }
                    Ok(())
                })?;
                Ok(Value::Null)
            },
        ),
        spec(
            "caption.add",
            "Add Caption at Playhead",
            &["Sequence", "Captions"],
            Some("Cmd+Alt+C"),
            r#"{"track":id|"C1"?,"text":str?,"words":[{"text":str,"start":seconds,"end":seconds}]? (karaoke; the caption spans them unless seconds/durationSeconds are given),"time":ticks?,"seconds":f64?,"durationSeconds":f64=3}"#,
            has_seq,
            |s, p| {
                let tid = track_param(s, p);
                let first_track = match p.get("track") {
                    None | Some(Value::Null) => true,
                    Some(Value::String(name)) => name.trim_start_matches(['C', 'c']).parse::<usize>().ok() == Some(1),
                    _ => false,
                };
                let create_track = s.active_sequence().is_some_and(|q| q.caption_tracks.is_empty()) && first_track;
                if tid.is_none() && !create_track {
                    return Err(bad("caption.add", "no such caption track"));
                }
                let words = karaoke_words(p)?;
                let rate = s.sequence_rate();
                let (t, dur, text) = match &words {
                    Some((text, a, b)) => {
                        let t = time_p(s, p, "").unwrap_or(*a);
                        let dur = f64_p(p, "durationSeconds").map(Tick::from_seconds_f64).unwrap_or(*b - t);
                        (t, dur, text.clone())
                    }
                    None => (
                        time_p(s, p, "").unwrap_or(s.playhead()),
                        Tick::from_seconds_f64(f64_p(p, "durationSeconds").unwrap_or(edit::captions::DEFAULT_SECONDS as f64)),
                        str_p(p, "text").unwrap_or("New caption").to_string(),
                    ),
                };
                // In and Out each land on the frame that shows their time (as the playhead does),
                // at least one frame apart
                let end = rate.snap(t + dur.max(Tick::ZERO));
                let t = rate.snap(t);
                let dur = (end - t).max(rate.frame_duration());
                let id = s.edit_sequence("Add Caption", |q, ctx, st| {
                    // The automatic first track and its caption are one transaction. A refused
                    // caption must not leave an empty track, and one undo removes the action.
                    let tid = match tid {
                        Some(tid) => tid,
                        None => {
                            let id = TrackId(ctx.alloc());
                            let format = CaptionFormat::default();
                            q.caption_tracks.push(CaptionTrack::new(id, format.label().to_string(), format));
                            id
                        }
                    };
                    let id = edit::captions::add_caption(q, tid, t, dur, &text, ctx)?;
                    st.caption_selection = vec![id];
                    st.selection.clear();
                    Ok(id)
                })?;
                Ok(json!({"caption": id.0}))
            },
        ),
        spec("caption.split", "Split Caption", &[], None, r#"{"caption":id?,"time":ticks?}"#, has_captions, |s, p| {
            let t = time_p(s, p, "").unwrap_or(s.playhead());
            let explicit = u64_p(p, "caption").map(ClipId);
            let ids = s.edit_sequence("Split Caption", |q, ctx, st| {
                let ids = match explicit {
                    Some(c) => vec![edit::captions::split_caption(q, c, t, ctx)?],
                    None => edit::captions::split_captions_at(q, &[], t, ctx),
                };
                if ids.is_empty() {
                    return Err(edit::EditError::Nothing.into());
                }
                st.caption_selection = ids.clone();
                Ok(ids)
            })?;
            Ok(json!({"captions": ids.iter().map(|c| c.0).collect::<Vec<_>>()}))
        }),
        spec("caption.merge", "Merge Captions", &[], None, r#"{"captions":[id]?}"#, has_captions, |s, p| {
            let ids = caption_ids(s, p);
            let id = s.edit_sequence("Merge Captions", |q, _, st| {
                let id = edit::captions::merge_captions(q, &ids)?;
                st.caption_selection = vec![id];
                Ok(id)
            })?;
            Ok(json!({"caption": id.0}))
        }),
        spec("caption.setText", "Edit Caption Text", &[], None, r#"{"caption":id?,"text":str?,"speaker":str|null?}"#, has_captions, |s, p| {
            let id = one_caption(s, p, "caption.setText")?;
            let text = str_p(p, "text").map(str::to_string);
            let speaker: Option<Option<String>> = match p.get("speaker") {
                None => None,
                Some(Value::Null) => Some(None),
                Some(v) => Some(v.as_str().map(str::to_string)),
            };
            if text.is_none() && speaker.is_none() {
                return Err(bad("caption.setText", "need `text` or `speaker`"));
            }
            s.edit_sequence("Edit Caption", |q, _, _| Ok(edit::captions::set_caption(q, id, text.as_deref(), speaker.as_ref().map(|o| o.as_deref()))?))?;
            Ok(Value::Null)
        }),
        spec(
            "caption.setTimes",
            "Set Caption In/Out",
            &[],
            None,
            r#"{"caption":id?,"startTime":ticks?,"startFrame":i64?,"startSeconds":f64?,"startTimecode":str?,"endTime":ticks?,"endFrame":i64?,"endSeconds":f64?,"endTimecode":str?}"#,
            has_captions,
            |s, p| {
                let id = one_caption(s, p, "caption.setTimes")?;
                let cur = s
                    .active_sequence()
                    .and_then(|q| q.find_caption(id))
                    .map(|(_, c)| (c.start, c.end()))
                    .ok_or(EngineError::Edit(edit::EditError::NoItem(id)))?;
                let rate = s.sequence_rate();
                let start = time_p(s, p, "start").map(|t| rate.snap_nearest(t)).unwrap_or(cur.0);
                let end = time_p(s, p, "end").map(|t| rate.snap_nearest(t)).unwrap_or(cur.1);
                s.edit_sequence("Caption Timing", |q, ctx, _| Ok(edit::captions::set_caption_times(q, id, start, end, ctx)?))?;
                Ok(json!({"start": start.0, "end": end.0}))
            },
        ),
        spec("caption.trim", "Trim Caption", &[], None, r#"{"caption":id,"edge":"in|out","delta":ticks|"deltaFrames":i64}"#, has_captions, |s, p| {
            let id = one_caption(s, p, "caption.trim")?;
            let edge = if str_p(p, "edge") == Some("in") { Edge::In } else { Edge::Out };
            let d = delta_p(s, p).ok_or_else(|| bad("caption.trim", "need `delta` or `deltaFrames`"))?;
            let applied = s.edit_sequence("Trim Caption", |q, ctx, _| Ok(edit::captions::trim_caption(q, id, edge, d, ctx)?))?;
            Ok(json!({"applied": applied.0}))
        }),
        spec("caption.move", "Move Captions", &[], None, r#"{"captions":[id]?,"delta":ticks|"deltaFrames":i64}"#, has_captions, |s, p| {
            let ids = caption_ids(s, p);
            let d = delta_p(s, p).ok_or_else(|| bad("caption.move", "need `delta` or `deltaFrames`"))?;
            let applied = s.edit_sequence("Move Captions", |q, _, _| Ok(edit::captions::move_captions(q, &ids, d)?))?;
            Ok(json!({"applied": applied.0}))
        }),
        spec("caption.delete", "Delete Captions", &[], None, r#"{"captions":[id]?,"ripple":bool=false}"#, has_captions, |s, p| {
            let ids = caption_ids(s, p);
            delete(s, &ids, bool_p(p, "ripple").unwrap_or(false))
        }),
        spec("caption.select", "Select Captions", &[], None, r#"{"captions":[id],"add":bool?}"#, has_seq, |s, p| {
            let ids: Vec<ClipId> =
                p.get("captions").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).map(ClipId).collect()).unwrap_or_default();
            let seq = s.active_sequence().ok_or(EngineError::NoSequence)?;
            let ids: Vec<ClipId> = ids.into_iter().filter(|c| seq.find_caption(*c).is_some()).collect();
            if bool_p(p, "add").unwrap_or(false) {
                for c in ids {
                    if !s.state.caption_selection.contains(&c) {
                        s.state.caption_selection.push(c);
                    }
                }
            } else {
                s.state.caption_selection = ids;
                s.state.selection.clear();
            }
            Ok(json!({"captions": s.state.caption_selection.iter().map(|c| c.0).collect::<Vec<_>>()}))
        }),
        spec("caption.goTo", "Go to Caption", &[], None, r#"{"caption":id}"#, has_captions, |s, p| {
            let id = one_caption(s, p, "caption.goTo")?;
            let start = s.active_sequence().and_then(|q| q.find_caption(id)).map(|(_, c)| c.start).ok_or(EngineError::Edit(edit::EditError::NoItem(id)))?;
            s.set_playhead(start);
            s.state.caption_selection = vec![id];
            s.state.selection.clear();
            Ok(json!({"time": start.0}))
        }),
        spec("caption.next", "Go to Next Caption Segment", &["Sequence", "Captions"], Some("Cmd+Alt+Down"), "{}", has_captions, |s, _| step(s, true)),
        spec("caption.previous", "Go to Previous Caption Segment", &["Sequence", "Captions"], Some("Cmd+Alt+Up"), "{}", has_captions, |s, _| step(s, false)),
        spec("caption.showAll", "Show All Caption Tracks", &["Sequence", "Captions"], None, "{}", has_caption_track, |s, _| show_all(s, true)),
        spec("caption.hideAll", "Hide All Caption Tracks", &["Sequence", "Captions"], None, "{}", has_caption_track, |s, _| show_all(s, false)),
        spec("caption.import", "Import Captions…", &[], None, r#"{"path":str,"name":str?}"#, always, |s, p| {
            let path = str_p(p, "path").ok_or_else(|| bad("caption.import", "need `path`"))?.to_string();
            let bytes = s.services.read_file(&path).map_err(|e| EngineError::Other(format!("{path}: {e}")))?;
            let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
            let format = kition_film_captions::detect(&bytes, ext.as_deref()).ok_or_else(|| EngineError::Other(format!("{path}: not a caption file")))?;
            import(s, &path, &bytes, format, str_p(p, "name"))
        }),
        spec(
            "caption.export",
            "Captions…",
            &["File", "Export"],
            None,
            r#"{"path":str,"format":"srt|vtt|scc|mcc|stl|ttml|dfxp"? (default: from the extension),"track":id|"C1"?,"dropFrame":bool=true}"#,
            has_caption_track,
            export,
        ),
        CommandSpec {
            id: "caption.list",
            label: "List Captions",
            menu: &[],
            shortcut: None,
            params: r#"{"track":id|"C1"?}"#,
            enabled: always,
            run: |s, p| {
                let Some(seq) = s.active_sequence() else { return Ok(json!({"tracks": []})) };
                let only = p.get("track").and_then(|_| track_param(s, p));
                let tracks: Vec<Value> =
                    seq.caption_tracks.iter().enumerate().filter(|(_, t)| only.is_none_or(|o| o == t.id)).map(|(i, t)| track_json(s, t, i)).collect();
                Ok(json!({"tracks": tracks, "selection": s.state.caption_selection.iter().map(|c| c.0).collect::<Vec<_>>()}))
            },
            journal: false,
        },
    ]
}

fn step(s: &mut Session, forward: bool) -> Result<Value> {
    let t = s.playhead();
    let seq = s.active_sequence().ok_or(EngineError::NoSequence)?;
    let mut starts: Vec<(Tick, ClipId)> = seq.caption_tracks.iter().filter(|t| t.enabled).flat_map(|t| t.captions.iter().map(|c| (c.start, c.id))).collect();
    starts.sort();
    let hit = if forward { starts.iter().find(|(st, _)| *st > t).copied() } else { starts.iter().rev().find(|(st, _)| *st < t).copied() };
    let (time, id) = hit.ok_or_else(|| EngineError::Other("no more captions".into()))?;
    s.set_playhead(time);
    s.state.caption_selection = vec![id];
    Ok(json!({"time": time.0, "caption": id.0}))
}

fn show_all(s: &mut Session, on: bool) -> Result<Value> {
    s.edit(if on { "Show All Caption Tracks" } else { "Hide All Caption Tracks" }, |p, st| {
        let seq = st.active_sequence.ok_or(EngineError::NoSequence)?;
        for t in &mut p.sequence_mut(seq).ok_or(EngineError::NoSequence)?.caption_tracks {
            t.enabled = on;
        }
        Ok(())
    })?;
    Ok(Value::Null)
}

#[cfg(test)]
#[path = "captions_tests.rs"]
mod tests;
