//! `document.text` (`KitText 1.0`, [`KitDocument::text`](kition_kit::KitDocument::text)): the project's words for a host's
//! full-text search, which the object model does not hold. Read-only: it reads the project and
//! changes nothing.
//!
//! Per sequence, in project order: its titles (the text layers of graphic clips on the video
//! tracks, in timeline order: by start, then from V1 up, each clip's layers back to front), one
//! part per title (`"Sequence 01 / Title 3"`), then each caption track's captions in time order,
//! one part per caption track (`"Sequence 01 / Subtitle"`). Each layer and each caption is a block;
//! blocks are separated by a newline. A disabled track, clip, or layer plays nothing and is left
//! out, as the Program monitor leaves it out; every caption track is in (a track whose captions
//! are hidden is still the sequence's subtitles). Captions are plain text, without their markup.

use kition_film_engine::project::{EffectInstance, ParamValue, Project, TrackItem, graphic};
use kition_film_time::Tick;
use kition_kit::text::{DocumentText, TextBuilder};

/// A part's blocks, each one's lines trimmed of trailing blanks and blank lines dropped, joined
/// by newlines.
#[derive(Default)]
struct Blocks(String);

impl Blocks {
    fn add(&mut self, text: &str) {
        for line in text.lines().map(str::trim_end).filter(|line| !line.trim().is_empty()) {
            if !self.0.is_empty() {
                self.0.push('\n');
            }
            self.0.push_str(line);
        }
    }
}

/// A text layer's words (its text at the clip's start, where a keyframed text begins).
fn layer_text(layer: &EffectInstance) -> Option<String> {
    if layer.effect != graphic::TEXT_LAYER || !layer.enabled {
        return None;
    }
    match layer.params.get("text").map(|param| param.value_at(Tick::ZERO)) {
        Some(ParamValue::Text(text)) => Some(text),
        _ => None,
    }
}

/// The words of `project`, at most `limit` characters.
pub fn document_text(project: &Project, limit: usize) -> DocumentText {
    let mut builder = TextBuilder::new(limit);
    for item in project.sequences() {
        let Some(sequence) = item.as_sequence() else { continue };
        let mut titles: Vec<(Tick, usize, &TrackItem)> = Vec::new();
        for (index, track) in sequence.video_tracks.iter().enumerate() {
            if !track.enabled {
                continue;
            }
            for clip in track.items.iter().filter(|clip| clip.enabled) {
                if clip.graphic_layers().any(|layer| layer_text(layer).is_some()) {
                    titles.push((clip.start, index, clip));
                }
            }
        }
        titles.sort_by_key(|(start, track, _)| (*start, *track));
        for (number, (_, _, clip)) in titles.iter().enumerate() {
            let mut blocks = Blocks::default();
            for text in clip.graphic_layers().filter_map(layer_text) {
                blocks.add(&text);
            }
            if !builder.part(format!("{} / Title {}", item.name, number + 1), &blocks.0) {
                return builder.finish();
            }
        }
        for track in &sequence.caption_tracks {
            let mut blocks = Blocks::default();
            for caption in &track.captions {
                blocks.add(&caption.plain_lines().join("\n"));
            }
            if !builder.part(format!("{} / {}", item.name, track.name), &blocks.0) {
                return builder.finish();
            }
        }
    }
    builder.finish()
}
