/**
 * The Motion box of a video clip on the Program monitor, as upstream's `transform_handles.rs`
 * draws and drags it: the clip's picture's box with eight handles, a rotate zone just outside it,
 * and the anchor point. Dragging inside the box changes Position; a handle changes Scale about the
 * anchor point (with Uniform Scale off a side handle changes only the width, a top or bottom
 * handle only the height); dragging just outside the box changes Rotation; the anchor point moves
 * without moving the picture (Position follows). Upstream reads no Shift on any of them.
 *
 * Here the box is computed from what the engine gives the page: the clip's Motion values at the
 * playhead (`clipEffects`), its source's size (`itemInfo`), and the sequence's size, as the
 * engine's `motion_matrix` places it (translate to Position, rotate, scale, translate by minus the
 * anchor point). Screen points are the canvas's CSS pixels (`screenOf`). Pure, so `node --test`
 * runs it. Imports carry `.ts` so `node --test` loads this module as it is.
 */
import { apply, compose, handlePoints, invert, screenOf, unscale, type Affine } from '../graphics/layerHandles.ts'
import type { CanvasView, Point } from './graphicsTools.ts'

/** Motion's values at the playhead: a null point is "auto" (the frame's or the source's centre). */
export type Motion = {
  position: readonly [number, number] | null
  anchor: readonly [number, number] | null
  /** Scale (the height when Uniform Scale is off) and Scale Width, in percent. */
  scale: number
  scaleWidth: number
  rotation: number
  uniform: boolean
  /** Whether the Motion effect is on: a clip whose Motion is off is placed as if it had none. */
  enabled: boolean
}

/** A clip in the picture at the playhead: its id, its source's size, and its Motion. */
export type ClipFrame = { clip: number; size: { width: number; height: number }; motion: Motion }

/** The clip's box on screen (upstream `Placement`). */
export type Placement = {
  clip: number
  /** Sequence pixels to screen (where Position is measured). */
  outer: Affine
  /** Source pixels to screen. */
  toScreen: Affine
  /** The box: TL, TR, BR, BL. */
  quad: readonly [Point, Point, Point, Point]
  anchorAt: Point
  position: readonly [number, number]
  anchor: readonly [number, number]
  scale: number
  scaleWidth: number
  rotation: number
  uniform: boolean
}

/** What a press takes hold of (upstream `Grab`): the box (move), handle `n`, the rotate zone, or the anchor point. */
export type Grab = { kind: 'move' } | { kind: 'handle'; n: number } | { kind: 'rotate' } | { kind: 'anchor' }

/** How close (points) the pointer must be to a handle (`GRAB`), and to the anchor point (`ANCHOR_GRAB`). */
export const GRAB = 8
export const ANCHOR_GRAB = 11
/** How far outside the box (points) the pointer rotates the picture (`ROTATE_REACH`). */
export const ROTATE_REACH = 24
/** The ranges Effect Controls' fields take. */
const POINT_RANGE = 100_000
const SCALE_MAX = 10_000
const ROTATION_RANGE = 36_000

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const pairOf = (value: unknown): readonly [number, number] | null => (Array.isArray(value) && value.length === 2 && value.every(isNumber) ? [value[0] as number, value[1] as number] : null)
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
const length = (a: Point) => Math.hypot(a.x, a.y)
const unit = (a: Point): Point => {
  const size = length(a)
  return size > 0 ? { x: a.x / size, y: a.y / size } : a
}

/**
 * Motion's values from the `params` of a clip's `motion` effect, as `clipEffects` (`[{id, value}]`)
 * or `inspect` (`{id: {value}}`) give them; null without them.
 */
export function motionOf(effect: { enabled?: boolean; params?: unknown } | null | undefined): Motion | null {
  if (!effect || effect.params == null || typeof effect.params !== 'object') return null
  const values = new Map<string, unknown>()
  if (Array.isArray(effect.params)) for (const param of effect.params as Array<{ id?: unknown; value?: unknown }>) values.set(String(param?.id), param?.value)
  else for (const [id, param] of Object.entries(effect.params as Record<string, { value?: unknown } | null>)) values.set(id, param?.value)
  const number = (id: string, fallback: number) => {
    const value = values.get(id)
    return isNumber(value) ? value : fallback
  }
  return {
    position: pairOf(values.get('position')),
    anchor: pairOf(values.get('anchor')),
    scale: number('scale', 100),
    scaleWidth: number('scale_width', 100),
    rotation: number('rotation', 0),
    uniform: values.get('uniform_scale') !== false,
    enabled: effect.enabled !== false,
  }
}

/** A frame size from an `itemInfo` video line (`"30 fps, 1920 x 1080 (1.0000)"`), or null. */
export function sizeOfVideoLine(line: unknown): { width: number; height: number } | null {
  if (typeof line !== 'string') return null
  const found = /(\d+)\s*x\s*(\d+)/.exec(line)
  if (!found) return null
  const width = Number(found[1])
  const height = Number(found[2])
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * The clip's source pixels to sequence pixels (the engine's `motion_matrix`): auto points are the
 * frame's centre (Position) and the source's (anchor point), a Motion that is off places the clip
 * at the centre unscaled.
 */
export function motionMatrix(frame: ClipFrame, sequence: { width: number; height: number }): Affine {
  const { motion, size } = frame
  const on = motion.enabled
  const [px, py] = (on && motion.position) || [sequence.width / 2, sequence.height / 2]
  const [ax, ay] = (on && motion.anchor) || [size.width / 2, size.height / 2]
  const sy = on ? motion.scale / 100 : 1
  const sx = on ? (motion.uniform ? motion.scale : motion.scaleWidth) / 100 : 1
  const radians = ((on ? motion.rotation : 0) * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  // translate(p) · rotate(r) · scale(sx, sy) · translate(−a)
  const a = cos * sx
  const b = sin * sx
  const c = -sin * sy
  const d = cos * sy
  return [a, b, c, d, px - (a * ax + c * ay), py - (b * ax + d * ay)]
}

/** The clip's box on the canvas at `view` (upstream `placement`), or null when it does not map to finite points. */
export function placementOf(frame: ClipFrame, sequence: { width: number; height: number }, view: CanvasView): Placement | null {
  const outer = screenOf(view)
  const toScreen = compose(outer, motionMatrix(frame, sequence))
  const { width, height } = frame.size
  const quad = [apply(toScreen, { x: 0, y: 0 }), apply(toScreen, { x: width, y: 0 }), apply(toScreen, { x: width, y: height }), apply(toScreen, { x: 0, y: height })] as const
  const { motion } = frame
  const position = motion.position ?? [sequence.width / 2, sequence.height / 2]
  const anchor = motion.anchor ?? [width / 2, height / 2]
  const anchorAt = apply(toScreen, { x: anchor[0], y: anchor[1] })
  if (![...quad, anchorAt].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) return null
  return { clip: frame.clip, outer, toScreen, quad, anchorAt, position, anchor, scale: motion.scale, scaleWidth: motion.scaleWidth, rotation: motion.rotation, uniform: motion.uniform }
}

/** Whether `p` is inside the quad (upstream `inside`). */
export function inside(quad: readonly Point[], p: Point) {
  let positive = false
  let negative = false
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i]
    const b = quad[(i + 1) % quad.length]
    const side = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    positive ||= side > 0
    negative ||= side < 0
  }
  return positive !== negative
}

/** The distance from `p` to the segment `a`–`b` (`seg_dist`). */
function segmentDistance(p: Point, a: Point, b: Point) {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0
  return length(sub(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }))
}

/** What a press at `p` takes hold of (upstream `grab_at`): the anchor point, a handle, the box, or the rotate zone just outside it. */
export function grabAt(pl: Placement, p: Point): Grab | null {
  if (length(sub(pl.anchorAt, p)) <= ANCHOR_GRAB) return { kind: 'anchor' }
  const n = handlePoints(pl.quad).findIndex((at) => length(sub(at, p)) <= GRAB)
  if (n >= 0) return { kind: 'handle', n }
  if (inside(pl.quad, p)) return { kind: 'move' }
  const near = pl.quad.some((a, i) => segmentDistance(p, a, pl.quad[(i + 1) % 4]) <= ROTATE_REACH)
  return near ? { kind: 'rotate' } : null
}

/**
 * The scale factors (width, height) dragging handle `n` from `start` to `cur` gives (upstream
 * `scale_factors`): the pointer's distance from the anchor point along the box's sides, relative
 * to where it started.
 */
export function scaleFactors(pl: Placement, n: number, start: Point, cur: Point): [number, number] {
  const [tl, tr, , bl] = pl.quad
  const ux = unit(sub(tr, tl))
  const uy = unit(sub(bl, tl))
  const from = sub(start, pl.anchorAt)
  const to = sub(cur, pl.anchorAt)
  const along = (dir: Point) => {
    const a = dot(from, dir)
    return Math.abs(a) < 1 ? 1 : Math.max(dot(to, dir) / a, 0)
  }
  if (n <= 3) {
    if (pl.uniform) {
      const f = along(unit(from))
      return [f, f]
    }
    return [along(ux), along(uy)]
  }
  if (n === 4 || n === 6) return pl.uniform ? [along(uy), along(uy)] : [1, along(uy)]
  return pl.uniform ? [along(ux), along(ux)] : [along(ux), 1]
}

/** The pointer's angle about the anchor point, in degrees (`angle_deg`). */
export const angleOf = (pl: Placement, p: Point) => (Math.atan2(p.y - pl.anchorAt.y, p.x - pl.anchorAt.x) * 180) / Math.PI

/** The turn from angle `from` to angle `to`, the short way round (a drag can go round more than once by adding them up). */
export const turnBetween = (from: number, to: number) => ((((to - from + 180) % 360) + 360) % 360) - 180

/** A drag of the box (upstream `Drag`): what it holds, where it began, the box then, and a rotation's turn so far. */
export type BoxDrag = { grab: Grab; start: Point; from: Placement; angle: number; turned: number }

export function beginBoxDrag(pl: Placement, grab: Grab, start: Point): BoxDrag {
  return { grab, start, from: pl, angle: angleOf(pl, start), turned: 0 }
}

/** The rotation drag follows the pointer to `cur`: its turn adds up, so a drag can go round more than once. */
export function followRotation(drag: BoxDrag, cur: Point) {
  if (drag.grab.kind !== 'rotate' || length(sub(cur, drag.from.anchorAt)) < 1) return
  const angle = angleOf(drag.from, cur)
  drag.turned += turnBetween(drag.angle, angle)
  drag.angle = angle
}

const clampPoint = (x: number, y: number) => (Number.isFinite(x) && Number.isFinite(y) ? [Math.min(POINT_RANGE, Math.max(-POINT_RANGE, x)), Math.min(POINT_RANGE, Math.max(-POINT_RANGE, y))] : null)
const clampScale = (value: number) => (Number.isFinite(value) ? Math.min(SCALE_MAX, Math.max(0, value)) : null)

/**
 * The Motion values a drag sets with the pointer at `cur` (upstream `changes`): `moved` is the
 * pointer's travel from the press, which Snap in Program Monitor may have adjusted. Each is a
 * `[param, value]` for `effects.setParam`.
 */
export function boxChanges(drag: BoxDrag, cur: Point, moved: Point): Array<[string, unknown]> {
  const pl = drag.from
  const out: Array<[string, unknown]> = []
  const push = (param: string, value: unknown) => {
    if (value != null) out.push([param, value])
  }
  switch (drag.grab.kind) {
    case 'move': {
      const delta = unscale(pl.outer, moved)
      push('position', clampPoint(pl.position[0] + delta.x, pl.position[1] + delta.y))
      break
    }
    case 'anchor': {
      const local = unscale(pl.toScreen, moved)
      const delta = unscale(pl.outer, moved)
      push('anchor', clampPoint(pl.anchor[0] + local.x, pl.anchor[1] + local.y))
      push('position', clampPoint(pl.position[0] + delta.x, pl.position[1] + delta.y))
      break
    }
    case 'handle': {
      const n = drag.grab.n
      const [fx, fy] = scaleFactors(pl, n, drag.start, cur)
      if (pl.uniform || n === 4 || n === 6) push('scale', clampScale(pl.scale * fy))
      else if (n === 5 || n === 7) push('scale_width', clampScale(pl.scaleWidth * fx))
      else {
        push('scale', clampScale(pl.scale * fy))
        push('scale_width', clampScale(pl.scaleWidth * fx))
      }
      break
    }
    case 'rotate': {
      const value = pl.rotation + drag.turned
      if (Number.isFinite(value)) push('rotation', Math.min(ROTATION_RANGE, Math.max(-ROTATION_RANGE, value)))
      break
    }
  }
  return out
}

/** The box as the drag's values would leave it, for its live outline: the clip placed again with them. */
export function draggedPlacement(frame: ClipFrame, sequence: { width: number; height: number }, view: CanvasView, changes: ReadonlyArray<[string, unknown]>): Placement | null {
  const motion: Motion = { ...frame.motion, enabled: true }
  for (const [param, value] of changes) {
    if (param === 'position') motion.position = value as [number, number]
    else if (param === 'anchor') motion.anchor = value as [number, number]
    else if (param === 'scale') motion.scale = value as number
    else if (param === 'scale_width') motion.scaleWidth = value as number
    else if (param === 'rotation') motion.rotation = value as number
  }
  return placementOf({ ...frame, motion }, sequence, view)
}

/** The top-most clip whose picture is under `p` (upstream `clip_under`): `frames` front-most first. */
export function clipUnder(frames: readonly ClipFrame[], sequence: { width: number; height: number }, view: CanvasView, p: Point): ClipFrame | null {
  return frames.find((frame) => {
    const pl = placementOf(frame, sequence, view)
    return pl != null && inside(pl.quad, p)
  }) ?? null
}

/** The resize cursor for a handle in direction `v` from the box's centre (`resize_cursor`). */
export function resizeCursor(v: Point) {
  const degrees = ((((Math.atan2(v.y, v.x) * 180) / Math.PI) % 180) + 180) % 180
  if (degrees < 22.5 || degrees >= 157.5) return 'ew-resize'
  if (degrees < 67.5) return 'nwse-resize'
  if (degrees < 112.5) return 'ns-resize'
  return 'nesw-resize'
}

/** The cursor over what a press would take hold of. */
export function grabCursor(pl: Placement, grab: Grab): string {
  if (grab.kind === 'move') return 'move'
  if (grab.kind === 'rotate') return 'alias'
  if (grab.kind === 'anchor') return 'default'
  const at = handlePoints(pl.quad)[grab.n]
  const centre = { x: (pl.quad[0].x + pl.quad[2].x) / 2, y: (pl.quad[0].y + pl.quad[2].y) / 2 }
  return resizeCursor(sub(at, centre))
}

/** The rotate zone's marks just outside each corner (upstream's `program.transform.rotate.<n>`), on screen. */
export function rotateMarks(pl: Placement): Point[] {
  const centre = { x: (pl.quad[0].x + pl.quad[2].x) / 2, y: (pl.quad[0].y + pl.quad[2].y) / 2 }
  return pl.quad.map((corner) => {
    const out = unit(sub(corner, centre))
    return { x: corner.x + out.x * 14, y: corner.y + out.y * 14 }
  })
}

/** Whether the inverse of the box's map exists (a clip scaled to nothing has no box to drag). */
export const placeable = (pl: Placement) => invert(pl.toScreen) != null

/** A clip in the picture at the playhead, as the engine's `inspect` lists it: what the box reads further. */
export type PictureClip = { clip: number; item: number; locked: boolean; selected: boolean }

type InspectedBinRow = { item?: number; type?: string | null; children?: InspectedBinRow[] }
type InspectedClip = { clip?: number; item?: number; start?: number; end?: number; enabled?: boolean }
type InspectedState = {
  project?: { root?: InspectedBinRow } | null
  sequence?: { video?: Array<{ enabled?: boolean; locked?: boolean; items?: InspectedClip[] }>; selection?: number[] } | null
  playhead?: number
} | null

/** Item types whose picture is not a frame of its own (a graphic's layers have their own handles; an adjustment layer covers the frame). */
const NOT_A_PICTURE = new Set(['Graphic', 'Adjustment Layer'])

/** Each project item's type (`inspect`'s bins), walked with a depth limit. */
export function itemTypes(root: InspectedBinRow | null | undefined): Map<number, string> {
  const types = new Map<number, string>()
  const walk = (row: InspectedBinRow, depth: number) => {
    if (depth > 64) return
    if (typeof row.item === 'number' && typeof row.type === 'string') types.set(row.item, row.type)
    for (const child of row.children ?? []) walk(child, depth + 1)
  }
  if (root) walk(root, 0)
  return types
}

/**
 * The clips whose picture the Program monitor shows at the playhead (upstream `clip_under`'s
 * walk): on enabled video tracks, front-most (the top track) first, each enabled and holding the
 * playhead; graphics and adjustment layers are left out (their own handles, or no picture).
 */
export function pictureClips(state: InspectedState): PictureClip[] {
  const sequence = state?.sequence
  const playhead = state?.playhead
  if (!sequence || typeof playhead !== 'number') return []
  const types = itemTypes(state?.project?.root)
  const selection = new Set(sequence.selection ?? [])
  const out: PictureClip[] = []
  for (const track of [...(sequence.video ?? [])].reverse()) {
    if (track.enabled === false) continue
    const clip = (track.items ?? []).find((each) => typeof each.start === 'number' && typeof each.end === 'number' && each.start <= playhead && playhead < each.end)
    if (!clip || clip.enabled === false || typeof clip.clip !== 'number' || typeof clip.item !== 'number') continue
    if (NOT_A_PICTURE.has(types.get(clip.item) ?? '')) continue
    out.push({ clip: clip.clip, item: clip.item, locked: track.locked === true, selected: selection.has(clip.clip) })
  }
  return out
}
