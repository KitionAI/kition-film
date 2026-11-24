/**
 * Transitions on the Timeline, as the engine places them (`sequence.applyVideoTransition`'s
 * `apply_transition`): a transition sits on a clip edge (the clip's In when another clip ends
 * there or nothing does, its Out at a free end), centred on a cut between two clips, starting at a
 * free In, ending at a free Out. Applying one where one already is replaces it, so a new duration
 * is one apply with the same effect, settings and `frames`: one command, one undo step. Times are
 * ticks. Pure, so `node --test` runs it.
 */

export type Command = { id: string; params: Record<string, unknown> }

/** A transition as the gestures read it (ticks), with the clips it joins and its settings. */
export type TransitionInfo = { id: number; effect: string; start: number; duration: number; from: number | null; to: number | null; params: Record<string, unknown>; reverse: boolean }

/** A clip as these helpers read it (ticks). */
export type SpanClip = { id: number; start: number; duration: number }

/** Where a transition sits on its cut: centred (both clips), starting at a free In, ending at a free Out. */
export type Alignment = 'center' | 'start' | 'end'

/** Upstream's alignment labels (`Alignment::label`), drawn over a drop's preview. */
export const ALIGNMENT_LABELS: Readonly<Record<Alignment, string>> = { center: 'Center at Cut', start: 'Start at Cut', end: 'End at Cut' }

export const alignmentOf = (from: number | null, to: number | null): Alignment => (from != null && to != null ? 'center' : to != null ? 'start' : 'end')

/** The span (ticks) the engine gives a transition `duration` long at `cut` with `alignment` (its start snapped down to a frame). */
export function transitionSpan(cut: number, duration: number, alignment: Alignment, frame: number): { start: number; duration: number } {
  const raw = alignment === 'center' ? cut - duration / 2 : alignment === 'start' ? cut : cut - duration
  const start = frame > 0 ? Math.floor(raw / frame + 1e-9) * frame : raw
  return { start, duration }
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

/** The one command that gives `transition` (on a `kind` track) a length of `frames`: the same transition applied again on its edge. */
export function durationCommand(transition: TransitionInfo, kind: 'video' | 'audio', frames: number): Command | null {
  const edge = edgeOf(transition)
  if (!edge || !(frames >= 1)) return null
  const params: Record<string, unknown> = { clip: edge.clip, edge: edge.edge, effect: transition.effect, frames: Math.round(frames), reverse: transition.reverse }
  if (Object.keys(transition.params).length) params.params = transition.params
  return { id: kind === 'audio' ? 'sequence.applyAudioTransition' : 'sequence.applyVideoTransition', params }
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

/** Settings ▸ Timeline's default transition duration (`videoTransitionDuration` in `videoTransitionUnit`), in ticks. */
export function defaultDuration(prefs: { duration?: number; unit?: string } | null, frame: number, ticksPerSecond: number): number {
  const amount = prefs?.duration != null && Number.isFinite(prefs.duration) && prefs.duration > 0 ? prefs.duration : 1
  return prefs?.unit === 'frames' ? amount * frame : amount * ticksPerSecond
}

/** A press on an end of a transition: the cut it sits on, its alignment, which end (+1 the right one, -1 the left one), and where that end was. */
export type TransitionGrab = { id: number; cut: number; alignment: Alignment; side: 1 | -1; end: number; pressT: number; frames: number; limit: number }

/**
 * Which end of a transition spanning `start`–`start + duration` a press at `t` takes, or null in
 * its middle (`zone` ticks wide at each end; a narrow one is all ends). A centred one has both; one
 * at a free clip end only its end away from the cut.
 */
export function grabEnd(span: { start: number; duration: number }, cut: number, alignment: Alignment, t: number, zone: number): 1 | -1 | null {
  const end = span.start + span.duration
  const narrow = span.duration <= 3 * zone
  const nearLeft = t - span.start <= zone
  const nearRight = end - t <= zone
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
  const frames = resizedFrames(grab.cut, grab.alignment, grab.side > 0 ? Math.max(moved, grab.cut) : Math.min(moved, grab.cut), frame, grab.limit)
  return { frames, ...transitionSpan(grab.cut, frames * frame, grab.alignment, frame) }
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
