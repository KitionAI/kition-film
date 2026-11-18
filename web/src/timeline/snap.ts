/**
 * Upstream `panels/timeline.rs` `snap_to`: while Snap is on (the engine's `snapping`), a time
 * within `SNAP_PX` of a clip edge, the playhead, a sequence marker, or In or Out lands on it; the
 * nearest wins. Times are engine ticks; x is points from the left edge of the track content. Pure,
 * so `node --test` runs it.
 */

/** Upstream's `SNAP_PX`. */
export const SNAP_PX = 9

/** What snapping reads of the sequence: its clips, the playhead, markers, and marks, in ticks. */
export type SnapScene = {
  tracks: ReadonlyArray<{ clips: ReadonlyArray<{ id: number; start: number; duration: number }> }>
  playhead: number
  markers: readonly number[]
  in: number | null
  out: number | null
  /** The engine's ticks per second. */
  tps: number
  /** The engine's `snapping`. */
  snapping: boolean
}

/** The view: points per second and the time (seconds) at the left edge. */
export type SnapView = { pps: number; scroll: number }

/** `Layout::x_of` for a time in ticks. */
export function xOfTick(view: SnapView, ticks: number, tps: number) {
  return (ticks / tps - view.scroll) * view.pps
}

/**
 * `snap_to`: `t` (ticks) moved onto the nearest candidate within `SNAP_PX`, and the candidate's x
 * for the snap indicator (null when nothing pulled it). Clips in `exclude` (the ones being
 * dragged) are not candidates, nor is the playhead unless `toPlayhead` (a dragged playhead would
 * stick to itself).
 */
export function snapTo(scene: SnapScene, view: SnapView, t: number, exclude: readonly number[], toPlayhead: boolean): { time: number; x: number | null } {
  if (!scene.snapping) return { time: t, x: null }
  const x = xOfTick(view, t, scene.tps)
  let best: { d: number; time: number } | null = null
  const consider = (candidate: number) => {
    const d = Math.abs(xOfTick(view, candidate, scene.tps) - x)
    if (d < SNAP_PX && (best == null || d < best.d)) best = { d, time: candidate }
  }
  for (const track of scene.tracks) {
    for (const clip of track.clips) {
      if (exclude.includes(clip.id)) continue
      consider(clip.start)
      consider(clip.start + clip.duration)
    }
  }
  if (toPlayhead) consider(scene.playhead)
  for (const marker of scene.markers) consider(marker)
  if (scene.in != null) consider(scene.in)
  if (scene.out != null) consider(scene.out)
  const found = best as { d: number; time: number } | null
  return found ? { time: found.time, x: xOfTick(view, found.time, scene.tps) } : { time: t, x: null }
}
