//! Through edits, gaps and range copies.
//!
//! - A **through edit** is a cut between two adjacent pieces of the same source that continue each
//!   other in media time (what Add Edit leaves behind). The timeline can mark them (Sequence ▸ Show
//!   Through Edits) and Join Through Edits heals them; the left piece's attributes win.
//! - A **gap** is empty time followed by material: on one track, or on every track at once (Sequence
//!   ▸ Go to Gap).
//! - [`clip_item_to`] trims a copy of an item to a time range (Make Subsequence).

use kition_film_project::{ClipId, Sequence, Track, TrackId, TrackItem};
use kition_film_time::{Tick, TimeRange};

use crate::remove_orphan_transitions;

/// Media-time slack when comparing the pieces of a cut (speed changes round each piece's source
/// range to whole ticks).
const MEDIA_SLACK: i64 = 2;

/// Whether the cut between adjacent items `a` (left) and `b` (right) is a through edit: same
/// source, same speed and direction, and `b` continues `a` in media time.
pub fn is_through_edit(a: &TrackItem, b: &TrackItem) -> bool {
    continues(a, b, a.duration, a.source_in)
}

fn continues(a: &TrackItem, b: &TrackItem, duration: Tick, source_in: Tick) -> bool {
    if a.start.0.checked_add(duration.0) != Some(b.start.0) || a.item != b.item || a.speed != b.speed || a.reverse != b.reverse || a.multicam != b.multicam {
        return false;
    }
    match (a.frame_hold, b.frame_hold) {
        (None, None) => {}
        (Some(x), Some(y)) => return x == y,
        _ => return false,
    }
    let source_out = |clip: &TrackItem, duration: Tick, source: Tick| {
        let consumed = (duration.0 as f64 * clip.speed.abs()).round();
        if !consumed.is_finite() || consumed < i64::MIN as f64 || consumed >= i64::MAX as f64 {
            return None;
        }
        source.0.checked_add(consumed as i64)
    };
    let diff = if a.reverse {
        source_out(b, b.duration, b.source_in).and_then(|end| end.checked_sub(source_in.0))
    } else {
        source_out(a, duration, source_in).and_then(|end| b.source_in.0.checked_sub(end))
    };
    diff.is_some_and(|diff| diff.unsigned_abs() <= MEDIA_SLACK as u64)
}

/// Identity-only result of joining a single named piece. Its previous neighbour
/// may absorb it; otherwise it absorbs each continuing following piece. The
/// accumulated source range uses the same predicate as the real operation.
#[derive(Debug, PartialEq, Eq)]
pub enum SingleJoinPlan {
    Complete(ClipId, Vec<ClipId>),
    TooLong,
}

pub fn single_join_plan(track: &Track, index: usize, limit: usize) -> Option<SingleJoinPlan> {
    let selected = track.items.get(index)?;
    if track.locked {
        return Some(SingleJoinPlan::Complete(selected.id, Vec::new()));
    }
    if let Some(previous) = index.checked_sub(1).and_then(|index| track.items.get(index))
        && is_through_edit(previous, selected)
    {
        return Some(if limit == 0 { SingleJoinPlan::TooLong } else { SingleJoinPlan::Complete(previous.id, vec![selected.id]) });
    }
    let mut removed = Vec::new();
    let (mut duration, mut source_in) = (selected.duration, selected.source_in);
    for next in track.items.get(index.checked_add(1)?..).into_iter().flatten() {
        if !continues(selected, next, duration, source_in) {
            break;
        }
        if removed.len() == limit {
            return Some(SingleJoinPlan::TooLong);
        }
        let Some(joined) = duration.0.checked_add(next.duration.0) else { break };
        duration = Tick(joined);
        if selected.reverse {
            source_in = next.source_in;
        }
        removed.push(next.id);
    }
    Some(SingleJoinPlan::Complete(selected.id, removed))
}

/// Identity-only all-track join plan, in one linear pass per track. Unlike a
/// single-target plan every surviving left piece remains eligible after a join.
pub fn all_join_plan(track: &Track) -> Vec<(ClipId, Vec<ClipId>)> {
    let mut out = Vec::new();
    if track.locked {
        return out;
    }
    let mut index = 0;
    while let Some(left) = track.items.get(index) {
        let (mut duration, mut source_in) = (left.duration, left.source_in);
        let mut removed = Vec::new();
        let Some(mut next) = index.checked_add(1) else { break };
        while let Some(right) = track.items.get(next) {
            if !continues(left, right, duration, source_in) {
                break;
            }
            let Some(joined) = duration.0.checked_add(right.duration.0) else { break };
            duration = Tick(joined);
            if left.reverse {
                source_in = right.source_in;
            }
            removed.push(right.id);
            let Some(after) = next.checked_add(1) else { break };
            next = after;
        }
        if !removed.is_empty() {
            out.push((left.id, removed));
        }
        index = next;
    }
    out
}

/// One through edit on a track.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThroughEdit {
    pub track: TrackId,
    pub left: ClipId,
    pub right: ClipId,
    pub time: Tick,
}

/// Through edits on one track, left to right.
pub fn track_through_edits(track: &Track) -> Vec<ThroughEdit> {
    track
        .items
        .windows(2)
        .filter(|w| is_through_edit(&w[0], &w[1]))
        .map(|w| ThroughEdit { track: track.id, left: w[0].id, right: w[1].id, time: w[1].start })
        .collect()
}

/// Through edits on every video and audio track.
pub fn through_edits(seq: &Sequence) -> Vec<ThroughEdit> {
    seq.all_tracks().flat_map(track_through_edits).collect()
}

/// Join through edits on unlocked tracks. With `only` non-empty, just the edits whose left or right
/// piece is listed. The left piece absorbs the right one (keeping its own effects and attributes);
/// a transition sitting on the cut is removed. Returns the number of edits joined.
pub fn join_through_edits(seq: &mut Sequence, only: &[ClipId]) -> usize {
    let mut n = 0;
    for tr in seq.all_tracks_mut() {
        if tr.locked {
            continue;
        }
        let mut i = 0;
        while i + 1 < tr.items.len() {
            let (a, b) = (&tr.items[i], &tr.items[i + 1]);
            let wanted = only.is_empty() || only.contains(&a.id) || only.contains(&b.id);
            if !(wanted && is_through_edit(a, b)) {
                i += 1;
                continue;
            }
            let (aid, bid) = (a.id, b.id);
            let (dur, b_source_in) = (b.duration, b.source_in);
            let left = &mut tr.items[i];
            left.duration += dur;
            if left.reverse {
                // reversed: the right piece shows the earlier media
                left.source_in = b_source_in;
            }
            tr.items.remove(i + 1);
            tr.transitions.retain(|t| !(t.from == Some(aid) && t.to == Some(bid)));
            for t in &mut tr.transitions {
                if t.from == Some(bid) {
                    t.from = Some(aid);
                }
                if t.to == Some(bid) {
                    t.to = Some(aid);
                }
            }
            n += 1;
        }
        remove_orphan_transitions(tr);
    }
    n
}

/// Start times of the gaps on one track: empty time from 0 or from the end of an item up to the
/// next item (trailing empty time after the last item is not a gap).
pub fn track_gaps(track: &Track) -> Vec<TimeRange> {
    gaps_of(track.items.iter().map(TrackItem::range))
}

/// Gaps of the whole sequence: time where no video or audio track has material, followed by
/// material.
pub fn sequence_gaps(seq: &Sequence) -> Vec<TimeRange> {
    let mut spans: Vec<TimeRange> = seq.all_tracks().flat_map(|t| t.items.iter().map(TrackItem::range)).collect();
    spans.sort_by_key(|r| r.start);
    gaps_of(spans.into_iter())
}

/// Gaps between `spans` (sorted by start), from time 0.
fn gaps_of(spans: impl Iterator<Item = TimeRange>) -> Vec<TimeRange> {
    let mut out = Vec::new();
    let mut covered = Tick::ZERO;
    for r in spans {
        if r.start > covered {
            out.push(TimeRange::from_bounds(covered, r.start));
        }
        covered = covered.max(r.end());
    }
    out
}

/// A copy of `it` trimmed to the timeline `range` (None when they don't overlap). Media time
/// follows the trim, so the copy shows the same frames at the same timeline times.
pub fn clip_item_to(it: &TrackItem, range: TimeRange) -> Option<TrackItem> {
    let a = it.start.max(range.start);
    let b = it.end().min(range.end());
    if b <= a {
        return None;
    }
    let mut c = it.clone();
    let head = a - it.start;
    let tail = it.end() - b;
    let speed = it.speed.abs();
    let src = |d: Tick| Tick((d.0 as f64 * speed).round() as i64);
    if it.frame_hold.is_none() {
        if it.reverse {
            c.source_in += src(tail);
        } else {
            c.source_in += src(head);
        }
    }
    c.start = a;
    c.duration = b - a;
    Some(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EditCtx, razor};
    use kition_film_project::{ItemId, Label, SequenceSettings, TrackKind};

    fn item(id: u64, start: i64, dur: i64, src: i64) -> TrackItem {
        TrackItem {
            id: ClipId(id),
            item: ItemId(1),
            name: "c".into(),
            label: Label::Iris,
            start: Tick(start),
            duration: Tick(dur),
            source_in: Tick(src),
            speed: 1.0,
            reverse: false,
            enabled: true,
            link: None,
            group: None,
            effects: vec![],
            markers: vec![],
            gain_db: 0.0,
            frame_hold: None,
            scale_to_frame: false,
            audio_mixing: None,
            multicam: None,
            time_interpolation: Default::default(),
            hold_filters: false,
            field_options: None,
            source_channels: Vec::new(),
            audio_stream: 0,
            graphic: None,
        }
    }

    fn seq_with(items: Vec<TrackItem>) -> Sequence {
        let mut p = kition_film_project::Project::new("t");
        let id = p.new_sequence("s", SequenceSettings::default(), 1, 1, None);
        let mut q = p.sequence(id).unwrap().clone();
        q.video_tracks[0].items = items;
        q
    }

    fn ctx(next: &mut u64) -> EditCtx<'_> {
        EditCtx { next_id: next, media_duration: &|_| None, media_start: &|_| Tick::ZERO, min_duration: Tick(1) }
    }

    #[test]
    fn razor_makes_a_through_edit_and_join_heals_it() {
        let mut q = seq_with(vec![item(10, 0, 100, 500)]);
        let orig = q.clone();
        let mut n = 1000;
        razor(&mut q, &[], Tick(40), &mut ctx(&mut n));
        let te = through_edits(&q);
        assert_eq!(te.len(), 1);
        assert_eq!(te[0].time, Tick(40));
        assert_eq!(join_through_edits(&mut q, &[]), 1);
        assert_eq!(q.video_tracks[0].items, orig.video_tracks[0].items);
    }

    #[test]
    fn reversed_and_speed_changed_pieces_join() {
        for (speed, reverse) in [(1.0, true), (1.5, false), (0.7, true)] {
            let mut it = item(10, 0, 99, 500);
            it.speed = speed;
            it.reverse = reverse;
            let mut q = seq_with(vec![it.clone()]);
            let mut n = 1000;
            razor(&mut q, &[], Tick(37), &mut ctx(&mut n));
            assert_eq!(through_edits(&q).len(), 1, "speed {speed} reverse {reverse}");
            join_through_edits(&mut q, &[]);
            let j = &q.video_tracks[0].items[0];
            assert_eq!((j.start, j.duration), (it.start, it.duration));
            assert!((j.source_in - it.source_in).0.abs() <= MEDIA_SLACK, "speed {speed} reverse {reverse}: {:?} vs {:?}", j.source_in, it.source_in);
        }
    }

    #[test]
    fn discontinuous_neighbours_are_not_through_edits() {
        let q = seq_with(vec![item(10, 0, 40, 500), item(11, 40, 60, 600)]);
        assert!(through_edits(&q).is_empty());
        let mut other = item(11, 40, 60, 540);
        other.item = ItemId(2);
        let q = seq_with(vec![item(10, 0, 40, 500), other]);
        assert!(through_edits(&q).is_empty());
    }

    #[test]
    fn hostile_through_source_arithmetic_returns_ineligible_without_panicking() {
        for (left, right) in [
            (item(10, 0, 40, i64::MAX), item(11, 40, 60, i64::MAX)),
            (item(10, 0, 40, i64::MIN), item(11, 40, 60, i64::MAX)),
            (item(10, i64::MAX, 40, 0), item(11, 40, 60, 40)),
        ] {
            let answer = std::panic::catch_unwind(|| is_through_edit(&left, &right));
            assert!(!answer.unwrap());
        }
    }

    #[test]
    fn hostile_through_difference_never_panics() {
        let left = item(10, 0, 40, i64::MAX - 40);
        let right = item(11, 40, 60, i64::MIN);
        assert!(!std::panic::catch_unwind(|| is_through_edit(&left, &right)).unwrap());
    }

    #[test]
    fn join_only_listed_edits() {
        let mut q = seq_with(vec![item(10, 0, 30, 0), item(11, 30, 30, 30), item(12, 60, 30, 60)]);
        assert_eq!(join_through_edits(&mut q, &[ClipId(12)]), 1);
        assert_eq!(q.video_tracks[0].items.len(), 2);
        assert_eq!(q.video_tracks[0].items[1].duration, Tick(60));
    }

    #[test]
    fn single_named_plans_match_the_operation_for_forward_reverse_and_rounded_chains() {
        for (speed, reverse) in [(1.0, false), (1.3, false), (0.7, true)] {
            let mut original = item(10, 0, 199, 500);
            original.speed = speed;
            original.reverse = reverse;
            let mut q = seq_with(vec![original]);
            let mut n = 1000;
            for time in [37, 81, 150] {
                razor(&mut q, &[], Tick(time), &mut ctx(&mut n));
            }
            for (index, selected) in q.video_tracks[0].items.iter().enumerate() {
                let SingleJoinPlan::Complete(survivor, removed) = single_join_plan(&q.video_tracks[0], index, usize::MAX).unwrap() else {
                    panic!("unbounded test plan");
                };
                let mut joined = q.clone();
                assert_eq!(join_through_edits(&mut joined, &[selected.id]), removed.len());
                assert!(joined.find_item(survivor).is_some());
                let actual: Vec<_> = q.video_tracks[0].items.iter().filter(|it| joined.find_item(it.id).is_none()).map(|it| it.id).collect();
                assert_eq!(removed, actual, "speed={speed}, reverse={reverse}, selected={:?}", selected.id);
            }
        }
    }

    #[test]
    fn a_bounded_join_plan_never_reports_a_truncated_recipient_list_as_complete() {
        let q = seq_with(vec![item(10, 0, 30, 0), item(11, 30, 30, 30), item(12, 60, 30, 60), item(13, 90, 30, 90)]);
        let track = &q.video_tracks[0];
        assert_eq!(single_join_plan(track, 0, 2), Some(SingleJoinPlan::TooLong));
        assert_eq!(single_join_plan(track, 0, 3), Some(SingleJoinPlan::Complete(ClipId(10), vec![ClipId(11), ClipId(12), ClipId(13)])));
        assert_eq!(single_join_plan(track, 1, 0), Some(SingleJoinPlan::TooLong));
        assert_eq!(single_join_plan(track, 1, 1), Some(SingleJoinPlan::Complete(ClipId(10), vec![ClipId(11)])));
    }

    #[test]
    fn all_join_plan_matches_forward_reverse_held_and_rounded_edits() {
        for reverse in [false, true] {
            for speed in [0.5, 1.0, 1.5] {
                for held in [false, true] {
                    let clips: Vec<_> = (0..6)
                        .map(|n| {
                            let source = if reverse { 5 - n } else { n };
                            let mut clip = item(10 + n, n as i64 * 10, 10, (source as f64 * 10.0 * speed) as i64);
                            clip.speed = speed;
                            clip.reverse = reverse;
                            clip.frame_hold = held.then_some(Tick(5));
                            clip
                        })
                        .collect();
                    let q = seq_with(clips);
                    let plans = all_join_plan(&q.video_tracks[0]);
                    let mut joined = q.clone();
                    let count = join_through_edits(&mut joined, &[]);
                    let removed: Vec<_> = plans.iter().flat_map(|(_, ids)| ids).copied().collect();
                    assert_eq!(count, removed.len());
                    for clip in &q.video_tracks[0].items {
                        assert_eq!(joined.find_item(clip.id).is_none(), removed.contains(&clip.id));
                    }
                    for (survivor, _) in plans {
                        assert!(joined.find_item(survivor).is_some());
                    }
                }
            }
        }
    }

    #[test]
    fn single_plans_do_not_compose_for_a_subset() {
        // The media slack is not transitive. A absorbs B and then C, but B/C
        // alone are not continuous. C's standalone plan wrongly includes D.
        let q = seq_with(vec![item(10, 0, 10, 0), item(11, 10, 10, 12), item(12, 20, 10, 19), item(13, 30, 10, 29)]);
        let track = &q.video_tracks[0];
        assert_eq!(single_join_plan(track, 1, 128), Some(SingleJoinPlan::Complete(ClipId(10), vec![ClipId(11)])));
        assert_eq!(single_join_plan(track, 2, 128), Some(SingleJoinPlan::Complete(ClipId(12), vec![ClipId(13)])));
        let mut joined = q.clone();
        assert_eq!(join_through_edits(&mut joined, &[ClipId(11), ClipId(12)]), 2);
        assert!(joined.find_item(ClipId(11)).is_none());
        assert!(joined.find_item(ClipId(12)).is_none());
        assert!(joined.find_item(ClipId(13)).is_some());
    }

    #[test]
    fn gaps_on_tracks_and_sequence() {
        let mut q = seq_with(vec![item(10, 10, 20, 0), item(11, 50, 10, 0)]);
        q.audio_tracks[0].items = vec![item(20, 0, 15, 0), item(21, 40, 15, 0)];
        assert_eq!(track_gaps(&q.video_tracks[0]), vec![TimeRange::from_bounds(Tick(0), Tick(10)), TimeRange::from_bounds(Tick(30), Tick(50))]);
        assert_eq!(sequence_gaps(&q), vec![TimeRange::from_bounds(Tick(30), Tick(40))]);
        assert_eq!(q.audio_tracks[0].kind, TrackKind::Audio);
    }

    #[test]
    fn clip_to_range_keeps_frames_in_place() {
        let it = item(10, 100, 100, 1000);
        let c = clip_item_to(&it, TimeRange::from_bounds(Tick(120), Tick(150))).unwrap();
        assert_eq!((c.start, c.duration, c.source_in), (Tick(120), Tick(30), Tick(1020)));
        assert_eq!(c.source_time_at(Tick(130)), it.source_time_at(Tick(130)));
        let mut r = it.clone();
        r.reverse = true;
        let c = clip_item_to(&r, TimeRange::from_bounds(Tick(120), Tick(150))).unwrap();
        assert_eq!(c.source_time_at(Tick(130)), r.source_time_at(Tick(130)));
        assert!(clip_item_to(&it, TimeRange::from_bounds(Tick(0), Tick(100))).is_none());
    }
}
