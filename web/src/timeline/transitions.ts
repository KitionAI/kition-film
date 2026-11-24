/**
 * Transitions on the Timeline, as the engine places them (`sequence.applyVideoTransition`'s
 * `apply_transition`, `edit::transitions`): a transition sits on a clip edge (the clip's In when
 * another clip ends there or nothing does, its Out at a free end); between two clips it is centred
 * on the cut, starts or ends there, or (moved) sits anywhere over it inside the two clips; at a
 * free In it starts there, at a free Out it ends there. A new length, alignment or place is one
 * `sequence.setTransition`: one command, one undo step. Times are ticks. Pure, so `node --test`
 * runs it.
 */

export type Command = { id: string; params: Record<string, unknown> }

/** A transition as the gestures read it (ticks), with the clips it joins and its settings. */
export type TransitionInfo = { id: number; effect: string; start: number; duration: number; from: number | null; to: number | null; params: Record<string, unknown>; reverse: boolean }

/** A clip as these helpers read it (ticks). */
export type SpanClip = { id: number; start: number; duration: number }

/** Where a transition sits on its cut: centred (both clips), starting at a free In, ending at a free Out. */
export type Alignment = 'center' | 'start' | 'end'

/** Where a transition sits as the engine reads its span: one of the alignments, or moved off them ("Custom Start"). */
export type SpanAlignment = Alignment | 'custom'

/** Upstream's alignment labels (`Alignment::label`), drawn over a drop's preview and offered by Set Transition Duration. */
export const ALIGNMENT_LABELS: Readonly<Record<SpanAlignment, string>> = { center: 'Center at Cut', start: 'Start at Cut', end: 'End at Cut', custom: 'Custom Start' }

export const alignmentOf = (from: number | null, to: number | null): Alignment => (from != null && to != null ? 'center' : to != null ? 'start' : 'end')

/** The span (ticks) the engine gives a transition `duration` long at `cut` with `alignment` (its start snapped down to a frame). */
export function transitionSpan(cut: number, duration: number, alignment: Alignment, frame: number): { start: number; duration: number } {
  const raw = alignment === 'center' ? cut - duration / 2 : alignment === 'start' ? cut : cut - duration
  const start = frame > 0 ? Math.floor(raw / frame + 1e-9) * frame : raw
  return { start, duration }
}

/**
 * Where a transition between `from` and `to` may be (upstream `edit::transitions::bounds`):
 * `lo` the outgoing clip's start, `cut`, `hi` the incoming clip's end; at a free In or Out the cut
 * is its clip's edge. Null when its clips are gone.
 */
export function boundsOf(transition: Pick<TransitionInfo, 'from' | 'to'>, clips: ReadonlyMap<number, SpanClip>): { lo: number; cut: number; hi: number } | null {
  const from = transition.from != null ? clips.get(transition.from) : undefined
  const to = transition.to != null ? clips.get(transition.to) : undefined
  if (from && to) return { lo: from.start, cut: to.start, hi: to.start + to.duration }
  if (to) return { lo: to.start, cut: to.start, hi: to.start + to.duration }
  if (from) return { lo: from.start, cut: from.start + from.duration, hi: from.start + from.duration }
  return null
}

/** A transition's alignment on `cut` as the engine reads it (upstream `alignment`): centred means within half a frame. */
export function alignmentAt(transition: Pick<TransitionInfo, 'from' | 'to' | 'start' | 'duration'>, cut: number, frame: number): SpanAlignment {
  if (transition.from == null && transition.to != null) return 'start'
  if (transition.from != null && transition.to == null) return 'end'
  if (transition.start === cut) return 'start'
  if (transition.start + transition.duration === cut) return 'end'
  if (Math.abs(transition.start * 2 + transition.duration - cut * 2) <= Math.max(0, frame)) return 'center'
  return 'custom'
}

/**
 * The longest a transition may be with `alignment`, in frames (at least 1), as the engine keeps it
 * inside the clips it joins: centred, twice the shorter side of the cut; Start at Cut, the
 * incoming clip; End at Cut, the outgoing clip; moved, both clips.
 */
export function alignedMaxFrames(transition: Pick<TransitionInfo, 'from' | 'to'>, clips: ReadonlyMap<number, SpanClip>, alignment: SpanAlignment, frame: number): number {
  const bounds = boundsOf(transition, clips)
  if (!bounds || !(frame > 0)) return 1
  const { lo, cut, hi } = bounds
  const two = transition.from != null && transition.to != null
  const room = !two ? hi - lo : alignment === 'start' ? hi - cut : alignment === 'end' ? cut - lo : alignment === 'center' ? 2 * Math.min(cut - lo, hi - cut) : hi - lo
  return Math.max(1, Math.floor(room / frame + 1e-9))
}

/**
 * Dragging the middle of a transition between two clips by `delta` ticks (upstream `drag_span`
 * with no edge): it slides over its cut, staying over the cut and inside the clips, its start on a
 * frame. A fade to or from nothing keeps its place.
 */
export function slideSpan(transition: Pick<TransitionInfo, 'from' | 'to' | 'start' | 'duration'>, clips: ReadonlyMap<number, SpanClip>, delta: number, frame: number): { start: number; duration: number } {
  const unchanged = { start: transition.start, duration: transition.duration }
  const bounds = boundsOf(transition, clips)
  if (!bounds || transition.from == null || transition.to == null) return unchanged
  const { lo, cut, hi } = bounds
  const d = transition.duration
  const min = Math.max(lo, cut - d)
  const max = Math.min(hi - d, cut)
  if (min > max) return unchanged
  const moved = frame > 0 ? Math.round((transition.start + delta) / frame) * frame : transition.start + delta
  return { start: Math.min(max, Math.max(min, moved)), duration: d }
}

/** The cut a transition sits on: its incoming clip's In, else its outgoing clip's Out. */
export function cutOf(transition: Pick<TransitionInfo, 'from' | 'to' | 'start' | 'duration'>, clips: ReadonlyMap<number, SpanClip>): number {
  const to = transition.to != null ? clips.get(transition.to) : undefined
  if (to) return to.start
  const from = transition.from != null ? clips.get(transition.from) : undefined
  if (from) return from.start + from.duration
  return transition.start + transition.duration / 2
}

/** The clip edge an apply names for a transition: the incoming clip's In, else the outgoing clip's Out. */
export function edgeOf(transition: Pick<TransitionInfo, 'from' | 'to'>): { clip: number; edge: 'in' | 'out' } | null {
  if (transition.to != null) return { clip: transition.to, edge: 'in' }
  if (transition.from != null) return { clip: transition.from, edge: 'out' }
  return null
}

/**
 * The longest a transition may be, in frames (at least 1): it stays inside the clips it joins (a
 * centred one at most twice the shorter clip, as each half lies over one of them).
 */
export function maxFrames(transition: Pick<TransitionInfo, 'from' | 'to'>, clips: ReadonlyMap<number, SpanClip>, frame: number): number {
  if (!(frame > 0)) return 1
  const from = transition.from != null ? clips.get(transition.from) : undefined
  const to = transition.to != null ? clips.get(transition.to) : undefined
  const longest = from && to ? 2 * Math.min(from.duration, to.duration) : (from ?? to)?.duration ?? frame
  return Math.max(1, Math.floor(longest / frame + 1e-9))
}

/**
 * Dragging an end of a transition to `t` (ticks): its new length in whole frames. A centred one
 * grows on both sides, so it is twice the distance to the cut; one at a free clip end grows from
 * the cut. Kept from 1 frame to `limit`.
 */
export function resizedFrames(cut: number, alignment: Alignment, t: number, frame: number, limit: number): number {
  if (!(frame > 0)) return 1
  const distance = alignment === 'center' ? 2 * Math.abs(t - cut) : Math.abs(t - cut)
  return Math.max(1, Math.min(limit, Math.round(distance / frame)))
}

/**
 * The one command that gives `transition` a length of `frames` (`sequence.setTransition`), resized
 * as its alignment says, or with `align` placed so on its cut first. One undo step.
 */
export function durationCommand(transition: TransitionInfo, _kind: 'video' | 'audio', frames: number, align?: Alignment): Command | null {
  if ((transition.from == null && transition.to == null) || !(frames >= 1)) return null
  const params: Record<string, unknown> = { transition: transition.id, frames: Math.round(frames) }
  if (align && transition.from != null && transition.to != null) params.align = align
  return { id: 'sequence.setTransition', params }
}

/** The one command that puts `transition` at `start` for `duration` ticks (a drag of its middle or an end): one undo step. */
export function spanCommand(transition: Pick<TransitionInfo, 'id' | 'start' | 'duration'>, start: number, duration: number): Command | null {
  if (start === transition.start && duration === transition.duration) return null
  return { id: 'sequence.setTransition', params: duration === transition.duration ? { transition: transition.id, start } : { transition: transition.id, start, duration } }
}

/** The one command that clears `transition` (Delete, its menu's Clear Transition): one undo step. */
export function removeCommand(transition: Pick<TransitionInfo, 'id'>): Command {
  return { id: 'sequence.removeTransition', params: { transitions: [transition.id] } }
}

/**
 * A transition dragged over a clip (upstream `effect_drop_preview`): the nearer edge of the clip
 * under the pointer, the cut there, and the alignment the engine gives it there (centred on a cut
 * between two clips, else at the free end).
 */
export function dropEdge(clip: SpanClip, neighbours: readonly SpanClip[], t: number): { edge: 'in' | 'out'; cut: number; alignment: Alignment } {
  const end = clip.start + clip.duration
  const edge = t - clip.start < end - t ? 'in' : 'out'
  const cut = edge === 'in' ? clip.start : end
  const across = neighbours.some((other) => other.id !== clip.id && (edge === 'in' ? other.start + other.duration === cut : other.start === cut))
  return { edge, cut, alignment: across ? 'center' : edge === 'in' ? 'start' : 'end' }
}

/**
 * Where a transition dropped at `t` on the cut between two clips sits (upstream's drop on a cut):
 * within `zone` ticks of the cut, centred on it; further on the outgoing clip, ending at the cut;
 * further on the incoming clip, starting at it. At a free clip edge the engine's one alignment.
 */
export function dropAlignment(drop: { cut: number; alignment: Alignment }, t: number, zone: number): Alignment {
  if (drop.alignment !== 'center') return drop.alignment
  if (Math.abs(t - drop.cut) <= zone) return 'center'
  return t < drop.cut ? 'end' : 'start'
}

/** Settings ▸ Timeline's default transition duration (`videoTransitionDuration` in `videoTransitionUnit`), in ticks. */
export function defaultDuration(prefs: { duration?: number; unit?: string } | null, frame: number, ticksPerSecond: number): number {
  const amount = prefs?.duration != null && Number.isFinite(prefs.duration) && prefs.duration > 0 ? prefs.duration : 1
  return prefs?.unit === 'frames' ? amount * frame : amount * ticksPerSecond
}

/** A press on an end of a transition: the cut it sits on, its alignment, which end (+1 the right one, -1 the left one), and where that end was. */
export type TransitionGrab = { id: number; cut: number; alignment: SpanAlignment; side: 1 | -1; end: number; pressT: number; frames: number; limit: number; lo?: number; hi?: number; other?: number }

/**
 * Which end of a transition spanning `start`–`start + duration` a press at `t` takes, or null in
 * its middle (`zone` ticks wide at each end; a narrow one is all ends). A centred one has both; one
 * at a free clip end only its end away from the cut.
 */
export function grabEnd(span: { start: number; duration: number }, cut: number, alignment: SpanAlignment, t: number, zone: number): 1 | -1 | null {
  const end = span.start + span.duration
  const narrow = span.duration <= 3 * zone
  const nearLeft = t - span.start <= zone
  const nearRight = end - t <= zone
  // Between two clips, not centred: both ends, each trimming its own side.
  if (alignment === 'custom') return narrow ? (t >= span.start + span.duration / 2 ? 1 : -1) : nearRight ? 1 : nearLeft ? -1 : null
  if (alignment === 'start') return narrow || nearRight ? 1 : null
  if (alignment === 'end') return narrow || nearLeft ? -1 : null
  if (narrow) return t >= cut ? 1 : -1
  return nearRight ? 1 : nearLeft ? -1 : null
}

/**
 * A drag of a transition's end to `t`: the grabbed end follows the pointer (`snap` pulls it), the
 * other moves as the engine places it, and the length is in whole frames from 1 to the limit.
 * Answers the frames and the span drawn while the drag lasts.
 */
export function dragEnd(grab: TransitionGrab, t: number, snap: (t: number) => number, frame: number): { frames: number; start: number; duration: number } {
  const moved = snap(grab.end + (t - grab.pressT))
  if (grab.alignment === 'custom') {
    // One end trims its own side only (upstream `drag_span`), the other stays; it stays over the
    // cut, at least a frame long, inside the clips.
    const step = frame > 0 ? frame : 1
    const other = grab.other ?? grab.cut
    const lo = grab.lo ?? Number.NEGATIVE_INFINITY
    const hi = grab.hi ?? Number.POSITIVE_INFINITY
    const at = frame > 0 ? Math.round(moved / frame) * frame : moved
    if (grab.side > 0) {
      const end = Math.min(hi, Math.max(Math.max(grab.cut, other + step), at))
      return { frames: Math.max(1, Math.round((end - other) / step)), start: other, duration: end - other }
    }
    const start = Math.max(lo, Math.min(Math.min(grab.cut, other - step), at))
    return { frames: Math.max(1, Math.round((other - start) / step)), start, duration: other - start }
  }
  const alignment = grab.alignment
  const frames = resizedFrames(grab.cut, alignment, grab.side > 0 ? Math.max(moved, grab.cut) : Math.min(moved, grab.cut), frame, grab.limit)
  return { frames, ...transitionSpan(grab.cut, frames * frame, alignment, frame) }
}

/** The transition id an apply answers (`{transition}`, as an object or its JSON text), or null. */
export function appliedTransition(answer: unknown): number | null {
  let value = answer
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  const id = (value as { transition?: unknown } | null)?.transition
  return typeof id === 'number' ? id : null
}
