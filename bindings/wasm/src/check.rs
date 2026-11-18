//! What [`KitDocument::check`](kition_kit::KitDocument::check) reports on a project (KHP A21):
//! clips that point at a project item the project no longer has, clips of media made offline,
//! clips of media whose file the host does not lend (missing, or outside the workspace: a project
//! names its media by path, and a kit reads only what its host lends, KHP A29), clips that read
//! past the end of their media, sequences with no clips, gaps between clips on a sequence's first
//! video track, and disabled clips. Targets name the sequence (`sequence:<id>`) and the clip
//! (`clip:<id>`).
//!
//! Codes: `film.missing-item`, `film.offline-media`, `film.missing-media`, `film.past-media-end`,
//! `film.empty-sequence`, `film.gap`, `film.disabled-clip`, `film.font-missing` (a title or caption
//! track names a font family that is not available, so it draws in the default family), and
//! `film.truncated` when a code is found more often than [`PER_CODE`] times.

use std::collections::{BTreeMap, BTreeSet};

use kition_film_engine::project::graphic::{LayerContent, eval_layer, layer_indices};
use kition_film_engine::project::{ItemId, ItemKind, Project, Sequence, TrackItem, TrackKind};
use kition_film_media::MediaKind;
use kition_kit::diagnostics::{Diagnostic, Severity, Target};
use serde_json::json;

/// At most this many diagnostics of one code; the rest are counted in one `film.truncated`.
pub const PER_CODE: usize = 100;

/// Everything worth fixing in the project, errors first. `missing` are the media items whose file
/// the host does not lend (`kition_film_engine::relink::scan`).
pub fn check(project: &Project, missing: &BTreeSet<ItemId>) -> Vec<Diagnostic> {
    let mut found = Found { missing, list: Vec::new(), counts: BTreeMap::new() };
    for (id, item) in &project.items {
        if let ItemKind::Sequence(sequence) = &item.kind {
            sequence_check(project, id.0, &item.name, sequence, &mut found);
        }
    }
    found.finish()
}

struct Found<'a> {
    missing: &'a BTreeSet<ItemId>,
    list: Vec<Diagnostic>,
    counts: BTreeMap<String, usize>,
}

impl Found<'_> {
    fn push(&mut self, diagnostic: Diagnostic) {
        let count = self.counts.entry(diagnostic.code.clone()).or_default();
        *count += 1;
        if *count <= PER_CODE {
            self.list.push(diagnostic);
        }
    }

    fn finish(mut self) -> Vec<Diagnostic> {
        for (code, count) in &self.counts {
            if *count > PER_CODE {
                self.list.push(Diagnostic::new("film.truncated", Severity::Info, format!("{} more `{code}` diagnostics are not listed.", count - PER_CODE)));
            }
        }
        self.list.sort_by_key(|diagnostic| diagnostic.severity);
        self.list
    }
}

fn on(sequence: u64, clip: Option<u64>) -> Target {
    let path = match clip {
        Some(clip) => format!("sequence:{sequence}/clip:{clip}"),
        None => format!("sequence:{sequence}"),
    };
    Target { path: Some(path), ..Target::default() }
}

fn seconds(ticks: i64) -> f64 {
    (ticks as f64 / kition_film_engine::time::TICKS_PER_SECOND as f64 * 100.0).round() / 100.0
}

fn sequence_check(project: &Project, id: u64, name: &str, sequence: &Sequence, found: &mut Found) {
    let tracks = sequence.video_tracks.iter().chain(&sequence.audio_tracks);
    if tracks.clone().all(|track| track.items.is_empty()) {
        found.push(
            Diagnostic::new("film.empty-sequence", Severity::Warning, format!("Sequence \"{name}\" has no clips: it renders as black, silent frames."))
                .on(on(id, None)),
        );
        return;
    }
    for track in tracks {
        for clip in &track.items {
            clip_check(project, id, &track.name, clip, found);
            font_check(project, sequence, id, clip, found);
        }
    }
    for (index, track) in sequence.caption_tracks.iter().enumerate() {
        if missing_font(&track.style.font, "Regular") {
            found.push(missing_font_diagnostic(&format!("Caption track C{} (\"{}\")", index + 1, track.name), &track.style.font).on(on(id, None)));
        }
    }
    // Gaps on the first video track show as black between the clips around them.
    if let Some((index, track)) = sequence.video_tracks.iter().enumerate().find(|(_, track)| track.kind == TrackKind::Video) {
        let mut items: Vec<&TrackItem> = track.items.iter().collect();
        items.sort_by_key(|item| item.start);
        for pair in items.windows(2) {
            let [before, after] = pair else { continue };
            let (end, next) = (before.end().0, after.start.0);
            if next > end {
                found.push(
                    Diagnostic::new(
                        "film.gap",
                        Severity::Info,
                        format!(
                            "{} has {} s of black between \"{}\" and \"{}\" at {} s.",
                            track.name,
                            seconds(next - end),
                            before.name,
                            after.name,
                            seconds(end)
                        ),
                    )
                    .on(on(id, Some(after.id.0)))
                    .fix("sequence.closeGap", Some(json!({ "track": format!("V{}", index + 1), "time": end }))),
                );
            }
        }
    }
}

/// Whether `family` (with `style`) resolves to no face of that family, so text in it draws in the
/// default family.
fn missing_font(family: &str, style: &str) -> bool {
    !family.trim().is_empty() && kition_film_text::fonts::resolve(family, style).missing
}

fn missing_font_diagnostic(what: &str, family: &str) -> Diagnostic {
    Diagnostic::new(
        "film.font-missing",
        Severity::Warning,
        format!(
            "{what} uses the font \"{family}\", which is not available here: it draws in {}. Add the font or choose another.",
            kition_film_text::fonts::DEFAULT_FAMILY
        ),
    )
}

/// `film.font-missing` for each font family a graphic clip's text layers name and nobody has.
fn font_check(project: &Project, sequence: &Sequence, id: u64, clip: &TrackItem, found: &mut Found) {
    if !project.items.get(&clip.item).is_some_and(|item| matches!(item.kind, ItemKind::Graphic { .. })) {
        return;
    }
    let size = (sequence.settings.width, sequence.settings.height);
    let mut reported: Vec<String> = Vec::new();
    for index in layer_indices(&clip.effects) {
        let Some(layer) = clip.effects.get(index).and_then(|effect| eval_layer(effect, clip.source_in, size)) else { continue };
        if let LayerContent::Text(text) = &layer.content
            && !reported.iter().any(|family| family.eq_ignore_ascii_case(&text.font))
            && missing_font(&text.font, &text.style)
        {
            reported.push(text.font.clone());
            found.push(missing_font_diagnostic(&format!("Title \"{}\"", clip.name), &text.font).on(on(id, Some(clip.id.0))));
        }
    }
}

fn clip_check(project: &Project, sequence: u64, track: &str, clip: &TrackItem, found: &mut Found) {
    let target = on(sequence, Some(clip.id.0));
    if !clip.enabled {
        found.push(
            Diagnostic::new("film.disabled-clip", Severity::Info, format!("Clip \"{}\" on {track} is disabled: it neither shows nor plays.", clip.name))
                .on(target.clone())
                .fix("clip.enable", Some(json!({ "clips": [clip.id.0] }))),
        );
    }
    let Some(item) = project.items.get(&clip.item) else {
        found.push(
            Diagnostic::new(
                "film.missing-item",
                Severity::Error,
                format!("Clip \"{}\" on {track} refers to a project item the project does not have.", clip.name),
            )
            .on(target),
        );
        return;
    };
    let ItemKind::Media(media) = &item.kind else { return };
    if media.offline {
        found.push(
            Diagnostic::new(
                "film.offline-media",
                Severity::Error,
                format!("Clip \"{}\" on {track} uses \"{}\", which is offline: it renders the offline slate.", clip.name, item.name),
            )
            .on(target),
        );
        return;
    }
    if found.missing.contains(&clip.item) {
        let path = match &media.media {
            kition_film_engine::project::MediaRef::File { path } => path.as_str(),
            kition_film_engine::project::MediaRef::Generator(_) => "",
        };
        found.push(
            Diagnostic::new(
                "film.missing-media",
                Severity::Error,
                format!(
                    "Clip \"{}\" on {track} uses \"{}\", whose file \"{path}\" the host does not lend (it is missing, or outside the workspace): \
                     it renders the offline slate. Put the file in the workspace and link it with media.relink, or replace the clip.",
                    clip.name, item.name
                ),
            )
            .on(target),
        );
        return;
    }
    // Stills and generators (mattes, bars) last as long as their clip; only footage has an end.
    if !matches!(media.info.kind, MediaKind::Movie | MediaKind::AudioOnly | MediaKind::ImageSequence) {
        return;
    }
    let length = media.duration().0;
    let read = clip.source_in.0 + (clip.duration.0 as f64 * clip.speed.abs()).round() as i64;
    if length > 0 && read > length {
        found.push(
            Diagnostic::new(
                "film.past-media-end",
                Severity::Warning,
                format!(
                    "Clip \"{}\" on {track} reads {} s past the end of \"{}\": those frames hold the last one.",
                    clip.name,
                    seconds(read - length),
                    item.name
                ),
            )
            .on(target),
        );
    }
}
