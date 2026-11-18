// Where a previewing dialog sits when no place is kept for it, and when a panel counts as hidden
// under it (Task 11 review): the dialog keeps off the panels that draw its preview, and a panel it
// still covers leaves its part of the preview to the strip. React-free, for `node --test`.
// Imports carry `.ts` so `node --test` loads this module as it is.
import type { PreviewKind } from './registry.ts'

/** A box in the editor's window, in CSS pixels. */
export type Rect = { x: number; y: number; width: number; height: number }

/** What a drawer names as its panel: an element, whose workspace frame (`.kui-ws-frame`) is the box when it has one. */
export type FrameElement = {
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number }
  closest?: (selector: string) => FrameElement | null
}

/** The box of `element`'s workspace frame, or its own. */
export function rectOf(element: FrameElement): Rect {
  const frame = element.closest?.('.kui-ws-frame') ?? element
  const box = frame.getBoundingClientRect()
  return { x: box.left, y: box.top, width: box.width, height: box.height }
}

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/** Whether `cover` hides half of `frame` or more (a frame of no size is never covered). */
export function coveredBy(frame: Rect, cover: Rect | null): boolean {
  const area = frame.width * frame.height
  return cover != null && area > 0 && overlap(frame, cover) >= area / 2
}

/** How far in from the area's edges a dialog sits. */
const INSET = 12

/**
 * The top left for a dialog of `size` in one of the corners of `area`: the layout's bottom left
 * first, then bottom right, top left, and top right; the first that covers none of `avoid`, else
 * the one covering least of them.
 */
export function chooseCorner({ size, area, avoid }: { size: { width: number; height: number }; area: Rect; avoid: readonly Rect[] }): { x: number; y: number } {
  const left = area.x + INSET
  const right = Math.max(left, area.x + area.width - INSET - size.width)
  const top = area.y + INSET
  const bottom = Math.max(top, area.y + area.height - INSET - size.height)
  const corners = [
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: left, y: top },
    { x: right, y: top },
  ]
  let best = corners[0]
  let least = Infinity
  for (const corner of corners) {
    const box = { ...corner, ...size }
    const covered = avoid.reduce((sum, frame) => sum + overlap(box, frame), 0)
    if (covered === 0) return corner
    if (covered < least) {
      least = covered
      best = corner
    }
  }
  return best
}

/** The panels each kind is drawn by (`useDrawsPreview`). */
const KIND_DRAWERS: Partial<Record<PreviewKind, readonly string[]>> = {
  picture: ['picture'],
  timeline: ['timeline'],
  project: ['project'],
  markers: ['markers'],
  selection: ['selection:timeline', 'selection:project'],
}

/** The boxes of the panels on screen that draw `kinds`, each once. */
export function framesFor(kinds: readonly PreviewKind[], drawers: { frames: (drawer: never) => Rect[] }): Rect[] {
  const frames: Rect[] = []
  for (const kind of kinds)
    for (const drawer of KIND_DRAWERS[kind] ?? [])
      for (const frame of (drawers.frames as (drawer: string) => Rect[])(drawer))
        if (!frames.some((each) => each.x === frame.x && each.y === frame.y && each.width === frame.width && each.height === frame.height)) frames.push(frame)
  return frames
}

/**
 * Where a dialog in the layout's place goes after it grew (its strip's picture came): moved up so
 * its bottom stays 12 px inside the workspace, never above the workspace's top. The same object
 * when it does not move by more than half a pixel, so a dialog taller than the workspace settles
 * rather than setting its place again on every resize it causes.
 */
export function liftedPlace<P extends { x: number; y: number }>(at: P | null, rect: { top: number; bottom: number }, room: { top: number; bottom: number }): P | { x: number; y: number } | null {
  if (!at) return at
  const over = rect.bottom - (room.bottom - INSET)
  if (over <= 0.5) return at
  // From the box's height, so one pass puts its bottom inside (or its top at the workspace's).
  const y = Math.max(room.top + INSET, room.bottom - INSET - (rect.bottom - rect.top))
  return Math.abs(y - at.y) <= 0.5 ? at : { x: at.x, y }
}

/** Lifts in a row (`createLifter`): a box whose height follows its place still settles. */
const MAX_LIFTS = 2
/** How long the lifts in a row are counted over, in ms: a dialog that grows again later lifts again. */
const LIFT_WINDOW_MS = 500

/**
 * `liftedPlace` for one open dialog, which moves it at most twice in a row (within half a second):
 * a box whose height changes with its place (a strip that wraps) could otherwise chase the
 * workspace's bottom, while a dialog that grows again later (its strip's picture came) still
 * moves up.
 */
export function createLifter(now: () => number = () => performance.now()) {
  let lifts: number[] = []
  return <P extends { x: number; y: number }>(at: P | null, rect: { top: number; bottom: number }, room: { top: number; bottom: number }) => {
    const time = now()
    lifts = lifts.filter((when) => time - when < LIFT_WINDOW_MS)
    if (lifts.length >= MAX_LIFTS) return at
    const next = liftedPlace(at, rect, room)
    if (next !== at) lifts.push(time)
    return next
  }
}

/** A box by its edges, in CSS pixels. */
type Edges = { left: number; top: number; right?: number; bottom: number }

/**
 * Where the colour picker's pop-up goes (a dialog's colour row): beside the dialog, at its
 * swatch's height (kept inside the window), on the side with room, the left first; with no room
 * on either side, under the swatch, or above it when that keeps clear of the dialog's title
 * (`header`, the title's bottom), else as high as the title allows.
 */
export function pickerPlace({ swatch, dialog, header, size, view }: { swatch: Edges; dialog: Required<Edges>; header: number; size: { width: number; height: number }; view: { width: number; height: number } }): { left: number; top: number } {
  const gap = 8
  const edge = 4
  const top = Math.max(edge, Math.min(swatch.top, view.height - edge - size.height))
  if (dialog.left - gap - size.width >= edge) return { left: dialog.left - gap - size.width, top }
  if (dialog.right + gap + size.width <= view.width - edge) return { left: dialog.right + gap, top }
  const left = Math.max(edge, Math.min(swatch.left, view.width - edge - size.width))
  const below = swatch.bottom + edge
  if (below + size.height <= view.height - edge) return { left, top: below }
  const above = swatch.top - edge - size.height
  return { left, top: above >= header ? above : header }
}

/** Whether a key closes an open colour picker: Escape, unless an input method is composing with it. */
export const closesPicker = (event: { key: string; isComposing: boolean; keyCode: number }) => event.key === 'Escape' && !event.isComposing && event.keyCode !== 229
