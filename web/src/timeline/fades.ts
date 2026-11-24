/**
 * A clip's fade handles: at a free clip end (no clip touches it there) a fade in or out is a
 * transition from or to nothing (the default video or audio transition: Cross Dissolve, Constant
 * Power), which the engine already places and sizes. The handle sits at the clip's top corner,
 * the fade's length in from that end; dragging it sets the length, to nothing clears it. Each drag
 * is one engine command, one undo step. Pure, so `node --test` runs it. Times are seconds.
 */
import type { Command } from './transitions.ts'

/** What a fade reads of a track: its clips and transitions (seconds). */
export type FadeTrack = {
  clips: ReadonlyArray<{ id: number; start: number; duration: number }>
  transitions: ReadonlyArray<{ id: number; start: number; duration: number; from: number | null; to: number | null }>
}

/** How near the handle's centre a press takes it (points), and how far down from the clip's top. */
export const HANDLE_HIT = 6
export const HANDLE_DEPTH = 9
/** The handle's size: it sits inside the clip, its outer side at the fade's length. */
export const HANDLE_SIZE = 8

/**
 * The fade at clip `id`'s `edge` on `track`: null where another clip touches that end (a cut, not a
 * free end), else the transition from or to nothing there, if any, and its length (0 without one).
 */
export function fadeAt(track: FadeTrack, id: number, edge: 'in' | 'out', frame: number) {
  const clip = track.clips.find((each) => each.id === id)
  if (!clip) return null
  const at = edge === 'in' ? clip.start : clip.start + clip.duration
  const slack = frame / 2
  const touching = track.clips.some((other) => other.id !== id && (edge === 'in' ? Math.abs(other.start + other.duration - at) < slack : Math.abs(other.start - at) < slack))
  if (touching) return null
  const transition = track.transitions.find((each) => (edge === 'in' ? each.to === id && each.from == null : each.from === id && each.to == null)) ?? null
  return { transition, duration: transition?.duration ?? 0 }
}

/** The handle's x in the clip body (its left side), for a fade `fadePx` long on a clip `width` points wide. */
export function handleX(edge: 'in' | 'out', fadePx: number, width: number) {
  return edge === 'in' ? Math.min(width - HANDLE_SIZE, Math.max(0, fadePx)) : Math.max(0, width - HANDLE_SIZE - Math.max(0, fadePx))
}

/** Whether a press at (`x`, `y`) in a clip body `width` wide takes the handle of a fade `fadePx` long at `edge`. */
export function onHandle(edge: 'in' | 'out', fadePx: number, width: number, x: number, y: number) {
  if (!(width > 3 * HANDLE_SIZE) || y < 0 || y > HANDLE_DEPTH) return false
  const centre = handleX(edge, fadePx, width) + HANDLE_SIZE / 2
  return Math.abs(x - centre) <= HANDLE_HIT
}

/**
 * The fade's length (whole frames, at most half the clip) a drag of its handle gives with the pointer
 * `x` points from the clip's left, `pps` points a second: the handle's outer side follows the pointer.
 */
export function draggedFrames(edge: 'in' | 'out', x: number, width: number, pps: number, frame: number, clipDuration: number) {
  if (!(pps > 0) || !(frame > 0)) return 0
  const px = edge === 'in' ? x : width - x
  const frames = Math.round(Math.max(0, px) / pps / frame)
  return Math.max(0, Math.min(frames, Math.floor(clipDuration / 2 / frame)))
}

/**
 * The one command a fade drag ends with, or null when it changed nothing: a new fade applies the
 * track's default transition at the free end with that length, a fade dragged to nothing is
 * cleared, any other length is set on the transition there.
 */
export function fadeCommand(kind: 'video' | 'audio', clip: number, edge: 'in' | 'out', existing: { id: number; duration: number } | null, frames: number, frame: number): Command | null {
  const current = existing ? Math.round(existing.duration / frame) : 0
  if (frames === current) return null
  if (!existing) return { id: kind === 'video' ? 'sequence.applyVideoTransition' : 'sequence.applyAudioTransition', params: { clip, edge, frames } }
  if (frames <= 0) return { id: 'sequence.removeTransition', params: { transitions: [existing.id] } }
  return { id: 'sequence.setTransition', params: { transition: existing.id, frames } }
}
