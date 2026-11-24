//! Cooperative cancellation of frame requests.
//!
//! A frame worker runs a job inside [`with_cancel`]; sources that do long work for a request (a
//! decoder seeking back to a keyframe and decoding forward) poll [`cancelled`] and give up with
//! [`MediaError::Cancelled`](crate::MediaError::Cancelled) once the job is no longer wanted, e.g.
//! playback has moved past its frame. The flag travels through a thread-local, so the
//! [`MediaSource`](crate::MediaSource) API is unchanged.
//!
//! The same way, [`with_catch_up`] tells sources which frames before the requested one are late
//! (playback has passed them): a decoder that has to decode forward to the frame may skip
//! pictures that only produce late frames and that nothing else references.
//!
//! [`with_draft`] marks reduced-resolution playback (opt-in): decoders may take spec-safe
//! shortcuts that only change pictures nothing references (H.264: no deblocking of non-reference
//! pictures). Never set for exports, renders or a frame shown while paused.
//!
//! [`with_approximate`] marks a monitor's picture during a scrub (opt-in, per request): a source
//! whose exact frame is not ready within a decoding budget may answer the nearest earlier frame it
//! decoded on the way, and says so ([`note_approximate`]); the monitor asks again until the frame
//! is exact. Never set for exports, renders, thumbnails, previews or a frame shown at rest;
//! [`with_exact`] turns it off inside (an effect reading other frames for an analysis it caches).
//!
//! [`with_background`] marks work nobody waits on interactively (thumbnails of the Project panel,
//! the Media Browser and the timeline): sources should not keep expensive state, such as a
//! frame-threaded 4K decoder, for it once it is done.

use std::cell::{Cell, RefCell};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use kition_film_time::Tick;

thread_local! {
    static CURRENT: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
    static CATCH_UP: Cell<Option<Tick>> = const { Cell::new(None) };
    static DRAFT: Cell<bool> = const { Cell::new(false) };
    static BACKGROUND: Cell<bool> = const { Cell::new(false) };
    static APPROXIMATE: Cell<Option<Duration>> = const { Cell::new(None) };
    static APPROXIMATED: Cell<bool> = const { Cell::new(false) };
}

/// Run `f` accepting approximate frames (a monitor's picture during a scrub): a source may spend
/// about `budget` decoding towards a frame it does not have, then answer the nearest earlier
/// frame it decoded on the way ([`note_approximate`]) and keep its decoder where it stopped, so
/// the next request for the same frame goes on from there. Answers `f`'s result and whether any
/// source answered approximately. The previous hints are restored however `f` ends.
pub fn with_approximate<R>(budget: Duration, f: impl FnOnce() -> R) -> (R, bool) {
    struct Restore(Option<Duration>, bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            APPROXIMATE.with(|c| c.set(self.0));
            APPROXIMATED.with(|c| c.set(self.1));
        }
    }
    let restore = Restore(APPROXIMATE.with(|c| c.replace(Some(budget))), APPROXIMATED.with(|c| c.replace(false)));
    let r = f();
    let approximated = APPROXIMATED.with(Cell::get);
    // An outer approximate request learns of this one's approximations too.
    let outer = restore.1 || approximated;
    drop(restore);
    APPROXIMATED.with(|c| c.set(outer));
    (r, approximated)
}

/// Run `f` with exact frames only, whatever the caller accepts (restoring the hint after): work
/// whose result outlives the request, such as an analysis an effect caches, never sees an
/// approximate frame.
pub fn with_exact<R>(f: impl FnOnce() -> R) -> R {
    struct Restore(Option<Duration>);
    impl Drop for Restore {
        fn drop(&mut self) {
            APPROXIMATE.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(APPROXIMATE.with(|c| c.replace(None)));
    f()
}

/// The decoding budget of the work running on this thread when it accepts approximate frames
/// (None, the default: only exact frames).
pub fn approximate() -> Option<Duration> {
    APPROXIMATE.with(Cell::get)
}

/// A source answered the request running on this thread with an approximate frame (see
/// [`with_approximate`]). Nothing outside [`with_approximate`] reads it.
pub fn note_approximate() {
    APPROXIMATED.with(|c| c.set(true));
}

/// Run `f` as background work when `on` (restoring the previous hint after): a thumbnail, not a
/// frame a monitor or playback waits for.
pub fn with_background<R>(on: bool, f: impl FnOnce() -> R) -> R {
    /// Restores the previous hint however `f` ends (a panic caught further up must not leave the
    /// worker thread marked as background).
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            BACKGROUND.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(BACKGROUND.with(|c| c.replace(on)));
    f()
}

/// Whether the work running on this thread is background work (off unless inside
/// [`with_background`]`(true, …)`).
pub fn background() -> bool {
    BACKGROUND.with(Cell::get)
}

/// Run `f` with the draft-decoding hint `on` (restoring the previous one after). Frames decoded
/// in draft mode are only handed to requests made in draft mode.
pub fn with_draft<R>(on: bool, f: impl FnOnce() -> R) -> R {
    let prev = DRAFT.with(|c| c.replace(on));
    let r = f();
    DRAFT.with(|c| c.set(prev));
    r
}

/// Whether the work running on this thread accepts draft-quality decoding (off unless inside
/// [`with_draft`]`(true, …)`).
pub fn draft() -> bool {
    DRAFT.with(Cell::get)
}

/// Run `f` with the catch-up hint `margin` (restoring the previous one after): frames shown more
/// than `margin` before the requested time are late (`Some(Tick::ZERO)`: everything before it).
/// The margin is measured in media time at normal speed; a wrong guess (a sped-up or reversed
/// clip) only costs a later re-seek, never a wrong frame.
pub fn with_catch_up<R>(margin: Option<Tick>, f: impl FnOnce() -> R) -> R {
    let prev = CATCH_UP.with(|c| c.replace(margin));
    let r = f();
    CATCH_UP.with(|c| c.set(prev));
    r
}

/// The catch-up margin of the work running on this thread (None: no frame is late).
pub fn catch_up() -> Option<Tick> {
    CATCH_UP.with(Cell::get)
}

/// Run `f` with `flag` as this thread's cancellation flag (restoring the previous one after).
pub fn with_cancel<R>(flag: &Arc<AtomicBool>, f: impl FnOnce() -> R) -> R {
    let prev = CURRENT.with(|c| c.replace(Some(flag.clone())));
    let r = f();
    CURRENT.with(|c| *c.borrow_mut() = prev);
    r
}

/// Whether the work running on this thread has been cancelled.
pub fn cancelled() -> bool {
    CURRENT.with(|c| c.borrow().as_ref().is_some_and(|f| f.load(Ordering::Relaxed)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_is_scoped_to_the_closure() {
        let flag = Arc::new(AtomicBool::new(false));
        assert!(!cancelled());
        with_cancel(&flag, || {
            assert!(!cancelled());
            flag.store(true, Ordering::Relaxed);
            assert!(cancelled());
        });
        assert!(!cancelled());
    }

    #[test]
    fn draft_is_off_by_default_and_scoped() {
        assert!(!draft());
        with_draft(true, || {
            assert!(draft());
            with_draft(false, || assert!(!draft()));
            assert!(draft());
        });
        assert!(!draft());
    }

    #[test]
    fn background_is_off_by_default_and_scoped() {
        assert!(!background());
        with_background(true, || {
            assert!(background());
            with_background(false, || assert!(!background()));
            assert!(background());
        });
        assert!(!background());
    }

    #[test]
    fn a_panic_inside_background_work_does_not_leave_the_thread_marked() {
        let r = std::panic::catch_unwind(|| with_background(true, || panic!("boom")));
        assert!(r.is_err());
        assert!(!background());
    }

    #[test]
    fn approximate_is_off_by_default_scoped_and_reported() {
        assert_eq!(approximate(), None);
        let budget = Duration::from_millis(40);
        let ((), approximated) = with_approximate(budget, || {
            assert_eq!(approximate(), Some(budget));
            with_exact(|| assert_eq!(approximate(), None));
            assert_eq!(approximate(), Some(budget));
        });
        assert!(!approximated, "nothing answered approximately");
        let ((), approximated) = with_approximate(budget, note_approximate);
        assert!(approximated);
        assert_eq!(approximate(), None);
        // A note outside any approximate request reports nothing to the next one.
        note_approximate();
        let ((), approximated) = with_approximate(budget, || ());
        assert!(!approximated);
    }

    #[test]
    fn a_panic_inside_approximate_work_restores_exact_frames() {
        let r = std::panic::catch_unwind(|| with_approximate(Duration::from_millis(1), || panic!("boom")));
        assert!(r.is_err());
        assert_eq!(approximate(), None);
    }

    #[test]
    fn catch_up_is_scoped_to_the_closure() {
        assert_eq!(catch_up(), None);
        with_catch_up(Some(Tick(5)), || {
            assert_eq!(catch_up(), Some(Tick(5)));
            with_catch_up(None, || assert_eq!(catch_up(), None));
            assert_eq!(catch_up(), Some(Tick(5)));
        });
        assert_eq!(catch_up(), None);
    }
}
