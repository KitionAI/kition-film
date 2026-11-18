//! `snap` of programmatic edits: `timeline.place` and `timeline.move` land a clip's start, and
//! `timeline.trim` the trimmed edge, on the nearest sequence marker or music beat within
//! `toleranceFrames` (3 by default), the way a drag snaps in the Timeline.
//!
//! | `snap` | targets |
//! |---|---|
//! | `"markers"` | the start (and a range marker's end) of every sequence marker |
//! | `"beats"` | the beats of the sequence's audio clips that have one ([`crate::beats::sequence_beats`]) |
//! | `["markers", "beats"]` | both |
//!
//! Nothing within the tolerance: the edit happens where it was asked for, and the answer's
//! `snapped` is null. Asking to snap when the sequence has none of the targets is an error.

use kition_film_time::Tick;
use serde_json::{Value, json};

use crate::commands::bad;
use crate::{EngineError, Result, Session};

/// The largest `toleranceFrames` (an hour at 60 fps).
pub(crate) const MAX_TOLERANCE_FRAMES: i64 = 216_000;
/// `toleranceFrames` when the call does not say.
pub(crate) const DEFAULT_TOLERANCE_FRAMES: i64 = 3;

/// Snap targets of one edit, sorted, and how far a time may move to reach one.
pub(crate) struct Snap {
    targets: Vec<Tick>,
    tolerance: i128,
}

impl Snap {
    /// The `snap` and `toleranceFrames` parameters of `p` (None without `snap`).
    pub(crate) fn from_params(s: &Session, p: &Value, cmd: &str) -> Result<Option<Snap>> {
        let kinds: Vec<&str> = match p.get("snap") {
            None | Some(Value::Null) => return Ok(None),
            Some(Value::String(k)) => vec![k.as_str()],
            Some(Value::Array(a)) => {
                a.iter().map(|v| v.as_str().ok_or_else(|| bad(cmd, "`snap` lists \"markers\" and/or \"beats\""))).collect::<Result<_>>()?
            }
            Some(_) => return Err(bad(cmd, "`snap` is \"markers\", \"beats\" or a list of them")),
        };
        let frames = match p.get("toleranceFrames") {
            None | Some(Value::Null) => DEFAULT_TOLERANCE_FRAMES,
            Some(v) => v
                .as_i64()
                .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 1e15).map(|f| f as i64))
                .filter(|f| (0..=MAX_TOLERANCE_FRAMES).contains(f))
                .ok_or_else(|| bad(cmd, format!("`toleranceFrames` is a whole number of frames, 0 to {MAX_TOLERANCE_FRAMES}")))?,
        };
        let seq = s.active_sequence().ok_or(EngineError::NoSequence)?;
        let mut targets = Vec::new();
        for kind in &kinds {
            match *kind {
                "markers" => {
                    for m in &seq.markers {
                        targets.push(m.start);
                        if m.duration > Tick::ZERO {
                            targets.push(Tick(m.start.0.saturating_add(m.duration.0)));
                        }
                    }
                }
                "beats" => targets.extend(crate::beats::sequence_beats(s)),
                other => return Err(bad(cmd, format!("`snap`: unknown target {other:?} (markers, beats)"))),
            }
        }
        if targets.is_empty() {
            return Err(bad(
                cmd,
                format!("nothing to snap to: the sequence has no {} (beats come from audio clips with a beat, see audio.detectBeats)", kinds.join(" or ")),
            ));
        }
        targets.sort();
        targets.dedup();
        let rate = s.sequence_rate();
        Ok(Some(Snap { targets, tolerance: i128::from(rate.tick_of(frames).0) }))
    }

    /// The target nearest `t` within the tolerance (the earlier one of two as near).
    pub(crate) fn nearest(&self, t: Tick) -> Option<Tick> {
        let i = self.targets.partition_point(|x| *x < t);
        let dist = |x: Tick| (i128::from(x.0) - i128::from(t.0)).abs();
        [i.checked_sub(1).and_then(|k| self.targets.get(k)), self.targets.get(i)]
            .into_iter()
            .flatten()
            .copied()
            .filter(|x| dist(*x) <= self.tolerance)
            .min_by_key(|x| (dist(*x), *x))
    }
}

/// Where `t` lands with the call's snap (unchanged without one), and the answer's `snapped`:
/// `{from, to}` in ticks when it moved to a target, else null.
pub(crate) fn apply(snap: Option<&Snap>, t: Tick) -> (Tick, Value) {
    match snap.and_then(|sn| sn.nearest(t)) {
        Some(to) => (to, json!({"from": t.0, "to": to.0})),
        None => (t, Value::Null),
    }
}
