/**
 * What the ruler and the Timeline's menus read where the pointer is: a marker under it, where a
 * dragged In or Out mark lands, and what the menus on the ruler and on empty track space offer.
 * Pure, so `node --test` runs it. Times are seconds unless named ticks. Imports carry `.ts` so
 * `node --test` loads this module as it is.
 */
import type { FilmMarker } from '../film.ts'
import { xOf } from './layout.ts'

/** The frame nearest `seconds`, in ticks (where a mark or a marker set from a menu lands). */
export function rulerTicks(seconds: number, fps: number, ticksPerSecond: number) {
  if (!(fps > 0) || !Number.isFinite(seconds)) return 0
  const frames = Math.max(0, Math.round(seconds * fps))
  return Math.round((frames / fps) * ticksPerSecond)
}

/** What a track's empty space right-clicked at `seconds` offers: whether it is a gap before a clip, and the clips from there on. */
export function laneMenuState(track: { clips: ReadonlyArray<{ id: number; start: number; duration: number }> }, seconds: number, frame: number) {
  const half = Math.max(0, frame) / 2
  const inside = track.clips.some((clip) => clip.start - half <= seconds && seconds < clip.start + clip.duration - half)
  const gap = !inside && track.clips.some((clip) => clip.start > seconds - half)
  const forward = track.clips.filter((clip) => clip.start + clip.duration > seconds).map((clip) => clip.id)
  return { gap, forward }
}

/** The marker drawn at (`x`, `y`) on the ruler (its head, 10 points wide in the top 16, or its span), the last drawn first, or null. */
export function markerNear(markers: readonly FilmMarker[], view: { pps: number; scroll: number }, x: number, y: number) {
  if (y < 0 || y > 16) return null
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index]
    const left = xOf(view, marker.start)
    if (Math.abs(x - left) <= 5 || (marker.duration > 0 && x >= left && x <= left + marker.duration * view.pps)) return marker
  }
  return null
}

/**
 * Where a dragged mark lands (seconds): on a frame, the In at or before the Out's frame, the Out
 * (its own frame, the band ending a frame later) at or after the In; `t` is the time under the pointer.
 */
export function draggedMark(which: 'in' | 'out', t: number, fps: number, other: number | null) {
  const frame = 1 / Math.max(1e-9, fps)
  const snapped = Math.max(0, Math.round(t * fps) / fps)
  if (which === 'in') return other != null ? Math.min(snapped, other) : snapped
  const out = Math.max(0, snapped - frame)
  return other != null ? Math.max(out, other) : out
}
