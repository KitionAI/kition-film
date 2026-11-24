//! The Program monitor's picture ([`FilmDocument::frame`]): how the monitor is moving (at rest,
//! playing, scrubbed), the decoding hints each motion takes, and the last exact picture kept so
//! the same state is not rendered twice.
//!
//! Only this picture takes the hints. Exports, `render`, `inspect`, previews, thumbnails and
//! scopes never do, and a picture at rest is always exact: a scrub's approximate pictures are
//! asked for by the editor alone (`setProgramMotion("scrub")`), and its end renders the exact one.

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use kition_film_media::cancel;
use kition_film_time::Tick;

use crate::FilmDocument;

/// How the Program monitor moves, as the editor tells it ([`FilmDocument::set_program_motion`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Motion {
    /// At rest: every picture is exact.
    Still = 0,
    /// Playing: draft decoding at 1/2 resolution or lower when Settings ▸ Playback ▸ Draft
    /// decoding is on.
    Playing = 1,
    /// A scrub of the playhead: a picture may be approximate (the nearest earlier frame a decoder
    /// has on its way to the wanted one) when the wanted frame takes longer than
    /// [`SCRUB_BUDGET`] to decode; the editor asks again until it is exact.
    Scrub = 2,
}

impl Motion {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Playing,
            2 => Self::Scrub,
            _ => Self::Still,
        }
    }

    fn parse(name: &str) -> Result<Self, String> {
        match name {
            "still" => Ok(Self::Still),
            "play" => Ok(Self::Playing),
            "scrub" => Ok(Self::Scrub),
            other => Err(format!("unknown program motion `{other}`: expected still, play or scrub")),
        }
    }
}

/// How long a scrub's picture decodes towards the wanted frame before it takes the nearest one
/// decoded on the way: short enough for about ten pictures a second while the pointer moves.
pub(crate) const SCRUB_BUDGET: Duration = Duration::from_millis(45);

/// Frames shown more than this before the wanted one are late on the way to it (a decoder seeking
/// from a keyframe skips their non-reference pictures, which leaves the wanted frame exactly as
/// it would be), while those nearer stay decoded for scrubbing back: upstream's policy for the
/// frame on screen.
const CATCH_UP_SECONDS: f64 = 2.0;

/// Moves with every font the page gives the engine: titles may draw differently after it.
pub(crate) static FONTS: AtomicU64 = AtomicU64::new(0);

/// What a Program picture is a function of (`Session::try_render_sequence_at`: the project, the
/// sequence and the time, at the render scale), with what else may draw it differently: the
/// revision, the preferences and the fonts.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Key {
    project: usize,
    revision: u64,
    sequence: Option<u64>,
    playhead: Tick,
    scale: u32,
    prefs: u64,
    fonts: u64,
}

/// A rendered Program picture: sRGB RGBA8 over black, its width and height.
pub(crate) type Picture = (Arc<[u8]>, u32, u32);

/// The Program monitor's per-document state (in `KitServices`, so every way of making a document
/// starts at rest with nothing kept).
#[derive(Default)]
pub(crate) struct ProgramState {
    motion: AtomicU8,
    /// Whether the last picture was exact (a scrub's may not be).
    exact: AtomicBool,
    /// The last exact picture and its key.
    kept: Mutex<Option<(Key, Picture)>>,
}

impl ProgramState {
    fn motion(&self) -> Motion {
        Motion::from_u8(self.motion.load(Ordering::Relaxed))
    }

    /// Forgets the kept picture: a command other than a playhead move may change what the
    /// picture shows in ways the key does not see (media relinked, a file read again).
    pub(crate) fn forget(&self) {
        *self.kept.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// Back at rest (a command other than a playhead move): a scrub the editor left on never
    /// makes a later picture approximate.
    pub(crate) fn settle(&self) {
        self.motion.store(Motion::Still as u8, Ordering::Relaxed);
        self.forget();
    }
}

impl FilmDocument {
    /// Sets how the Program monitor moves: `still` (at rest, every picture exact), `play`, or
    /// `scrub` (pictures may be approximate until asked for again; see [`Motion::Scrub`]). Any
    /// command other than `playhead.set` puts it back at rest.
    pub fn set_program_motion(&self, motion: &str) -> Result<(), String> {
        let motion = Motion::parse(motion)?;
        self.services.program.motion.store(motion as u8, Ordering::Relaxed);
        Ok(())
    }

    /// Whether the last Program picture was exact: false only for a scrub's approximate picture,
    /// which the editor renders again.
    pub fn program_frame_exact(&self) -> bool {
        self.services.program.exact.load(Ordering::Relaxed)
    }

    fn picture_key(&self, scale: f32) -> Key {
        Key {
            project: Arc::as_ptr(&self.session.project) as usize,
            revision: self.session.revision,
            sequence: self.session.state.active_sequence.map(|id| id.0),
            playhead: self.session.playhead(),
            scale: scale.to_bits(),
            prefs: self.session.prefs_revision,
            fonts: FONTS.load(Ordering::Relaxed),
        }
    }

    /// The program frame at the playhead, opaque over black as a monitor shows it, at the render
    /// scale ([`FilmDocument::set_render_scale`]; full size by default). The same state renders
    /// once: the last exact picture is kept and answered again.
    pub(crate) fn frame(&self) -> Result<Picture, String> {
        let program = &self.services.program;
        let scale = self.services.render_scale();
        let key = self.picture_key(scale);
        if let Some((kept, picture)) = program.kept.lock().unwrap_or_else(PoisonError::into_inner).as_ref()
            && *kept == key
        {
            program.exact.store(true, Ordering::Relaxed);
            return Ok(picture.clone());
        }
        let motion = program.motion();
        let draft = motion != Motion::Still && scale <= 0.5 && self.session.prefs.playback.draft_decode;
        let render = || self.session.try_render_program_at(scale, key.playhead);
        let (image, approximate) = cancel::with_catch_up(Some(Tick::from_seconds_f64(CATCH_UP_SECONDS)), || {
            cancel::with_draft(draft, || if motion == Motion::Scrub { cancel::with_approximate(SCRUB_BUDGET, render) } else { (render(), false) })
        });
        let image = image.map_err(|error| error.to_string())?;
        let (w, h) = (u32::try_from(image.w).map_err(|_| "frame too wide")?, u32::try_from(image.h).map_err(|_| "frame too tall")?);
        let picture: Picture = (image.over_black_rgba8().into(), w, h);
        let exact = !approximate && !draft;
        program.exact.store(exact, Ordering::Relaxed);
        if exact {
            *program.kept.lock().unwrap_or_else(PoisonError::into_inner) = Some((key, picture.clone()));
        }
        Ok(picture)
    }
}

#[cfg(test)]
mod tests {
    use kition_kit::KitDocument;
    use serde_json::json;

    use super::*;

    fn matte() -> FilmDocument {
        let mut doc = FilmDocument::create("Edit.kfilm", 320, 180).unwrap();
        let matte = doc.execute("file.newColorMatte", json!({ "color": "#ff0000", "seconds": 4.0 })).unwrap();
        doc.execute("timeline.place", json!({ "item": matte["item"], "track": "V1", "seconds": 0.0 })).unwrap();
        doc
    }

    #[test]
    fn the_same_state_renders_once_and_an_edit_renders_again() {
        let mut doc = matte();
        let (first, w, h) = doc.frame().unwrap();
        assert_eq!((w, h), (320, 180));
        assert!(doc.program_frame_exact());
        let (again, ..) = doc.frame().unwrap();
        assert!(Arc::ptr_eq(&first, &again), "the kept picture is answered again");
        doc.set_render_scale(0.5).unwrap();
        let (half, w, _) = doc.frame().unwrap();
        assert_eq!(w, 160, "another scale renders again");
        assert!(!Arc::ptr_eq(&first, &half));
        doc.set_render_scale(1.0).unwrap();
        doc.execute("playhead.set", json!({ "seconds": 1.0 })).unwrap();
        let (moved, ..) = doc.frame().unwrap();
        assert!(!Arc::ptr_eq(&first, &moved), "another playhead renders again");
        // An edit (a new revision) renders again too, even back at the same playhead.
        doc.execute("file.newColorMatte", json!({ "color": "#00ff00", "seconds": 1.0 })).unwrap();
        let (edited, ..) = doc.frame().unwrap();
        assert!(!Arc::ptr_eq(&moved, &edited));
    }

    #[test]
    fn a_motion_is_named_and_an_edit_puts_the_monitor_back_at_rest() {
        let mut doc = matte();
        assert!(doc.set_program_motion("glide").is_err());
        for motion in ["still", "play", "scrub"] {
            doc.set_program_motion(motion).unwrap();
        }
        assert_eq!(doc.services.program.motion(), Motion::Scrub);
        // A playhead move keeps the scrub; an edit ends it.
        doc.execute("playhead.set", json!({ "seconds": 1.0 })).unwrap();
        assert_eq!(doc.services.program.motion(), Motion::Scrub);
        // A still picture (a generator) is exact whatever the motion.
        doc.frame().unwrap();
        assert!(doc.program_frame_exact());
        doc.execute("file.newColorMatte", json!({ "color": "#00ff00", "seconds": 1.0 })).unwrap();
        assert_eq!(doc.services.program.motion(), Motion::Still);
    }
}
