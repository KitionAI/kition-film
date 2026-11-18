/**
 * The graphic layer handles on the Program monitor, as upstream's `panels/graphics.rs`
 * `monitor_overlay` draws and drags them: the selected layers' boxes with corner handles 0–3 and
 * edge handles 4–7 (`handle_points`), the anchor point, and what a drag does (`HandleDrag`:
 * Stretch for shapes, Scale for point text, Resize for paragraph text), committed on release as
 * one `graphics.set`. Upstream works on screen points; here they are the canvas's CSS pixels
 * (`toCanvas`), the layer's maps from the engine's `graphicLayers` composed with the canvas's view.
 * Pure, so `node --test` runs it. Imports carry `.ts` so `node --test` loads this module as it is.
 */
import type { CanvasView, GraphicLayer, Point } from '../monitors/graphicsTools.ts'
import { snapMove, type FrameSize, type Rect, type SnapLine, type SnapView } from '../monitors/guideModel.ts'

/** An affine map `[a, b, c, d, e, f]`: (x, y) to (a·x + c·y + e, b·x + d·y + f). */
export type Affine = readonly [number, number, number, number, number, number]
type Pair = readonly [number, number]

/** What the handles need of a layer (the engine's `graphicLayers` row), in its own and its canvas's pixels. */
export type LayerFrame = {
  /** The layer's box in its own pixels, `[x0, y0, x1, y1]` (`layer_local_bounds`). */
  local: readonly [number, number, number, number]
  /** Layer pixels to sequence pixels (`layer_matrix` after the clip's Motion). */
  toSequence: Affine
  /** The clip's canvas to sequence pixels (its Motion). */
  canvas: Affine
  /** The layer's transform: `position` and `anchor` (canvas and layer pixels), `scale` as fractions. */
  position: Pair
  anchor: Pair
  scale: Pair
  /** A text layer's box (`box_width`, `box_height`), zero for point text; null for a shape. */
  box: Pair | null
  /** Paragraph text its box hides (upstream's red plus). */
  overflow: boolean
}

/** A layer on screen (upstream `LayerView`): its maps to the canvas's CSS pixels and its quad there (TL, TR, BR, BL). */
export type LayerView = { layer: GraphicLayer; frame: LayerFrame; toScreen: Affine; canvasToScreen: Affine; quad: readonly [Point, Point, Point, Point] }

/** Handles and the anchor point are grabbed this close, in screen points (`<= 7.0`). */
export const HANDLE_GRAB_PX = 7
/** A drag shorter than this, in screen points, commits nothing (`moved`: `> 2.0`). */
export const LAYER_MOVED_PX = 2
/**
 * A handle closer than this (points) to the anchor point scales point text as if it were this far
 * (upstream's `NEAR_ANCHOR`, measured in Premiere Pro 26 at Fit).
 */
export const NEAR_ANCHOR = 60

// ---- affine maps and vectors

export const compose = (outer: Affine, inner: Affine): Affine => {
  const [a, b, c, d, e, f] = outer
  const [p, q, r, s, t, u] = inner
  return [a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s, a * t + c * u + e, b * t + d * u + f]
}
export const apply = (m: Affine, point: Point): Point => ({ x: m[0] * point.x + m[2] * point.y + m[4], y: m[1] * point.x + m[3] * point.y + m[5] })
export function invert(m: Affine): Affine | null {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}
/** A screen offset in the units `m` maps to the screen, its translation left out (`unscale`); zero when `m` cannot be inverted. */
export function unscale(m: Affine, off: Point): Point {
  const inverse = invert([m[0], m[1], m[2], m[3], 0, 0])
  return inverse ? apply(inverse, off) : { x: 0, y: 0 }
}
/** Sequence pixels to the canvas's CSS pixels at `view` (`toCanvas`). */
export const screenOf = (view: CanvasView): Affine => [view.zoom, 0, 0, view.zoom, -view.x * view.zoom, -view.y * view.zoom]

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const times = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k })
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
const length = (a: Point) => Math.hypot(a.x, a.y)
/** A unit vector, or the vector itself when it has no length (egui's `normalized`). */
const unit = (a: Point): Point => {
  const size = length(a)
  return size > 0 ? times(a, 1 / size) : a
}

// ---- the engine's rows

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const numbers = (value: unknown, count: number): number[] | null => (Array.isArray(value) && value.length === count && value.every(isNumber) ? (value as number[]) : null)

/** The handle fields of an engine `graphicLayers` row, or null when any is missing or unreadable. */
export function parseLayerFrame(row: unknown): LayerFrame | null {
  if (!row || typeof row !== 'object') return null
  const raw = row as Record<string, unknown>
  const transform = raw.transform as Record<string, unknown> | null | undefined
  const local = numbers(raw.local, 4)
  const toSequence = numbers(raw.toSequence, 6)
  const canvas = numbers(raw.canvas, 6)
  const position = numbers(transform?.position, 2)
  const anchor = numbers(transform?.anchor, 2)
  const scale = numbers(transform?.scale, 2)
  if (!local || !toSequence || !canvas || !position || !anchor || !scale) return null
  const box = numbers(raw.box, 2)
  return {
    local: local as unknown as LayerFrame['local'],
    toSequence: toSequence as unknown as Affine,
    canvas: canvas as unknown as Affine,
    position: position as unknown as Pair,
    anchor: anchor as unknown as Pair,
    scale: scale as unknown as Pair,
    box: box as Pair | null,
    overflow: raw.overflow === true,
  }
}

/**
 * Whether two reads of a layer place it the same (a drag whose layer changed underneath it is
 * dropped). `overflow` is left out: it says whether the box hides text, not where the layer sits,
 * and the engine lays it out only once the layer is selected (a press selects it).
 */
export function sameFrame(a: LayerFrame | null | undefined, b: LayerFrame | null | undefined) {
  if (!a || !b) return false
  const same = (x: readonly number[] | null, y: readonly number[] | null) => x === y || (x != null && y != null && x.length === y.length && x.every((value, index) => Math.abs(value - y[index]) < 1e-9))
  return same(a.local, b.local) && same(a.toSequence, b.toSequence) && same(a.canvas, b.canvas) && same(a.position, b.position) && same(a.anchor, b.anchor) && same(a.scale, b.scale) && same(a.box, b.box)
}

// ---- the layer on screen

/** The layer on the canvas at `view`; null without the engine's frame. */
export function layerView(layer: GraphicLayer, view: CanvasView): LayerView | null {
  const frame = layer.frame
  if (!frame) return null
  const screen = screenOf(view)
  const toScreen = compose(screen, frame.toSequence)
  const [x0, y0, x1, y1] = frame.local
  const quad = [apply(toScreen, { x: x0, y: y0 }), apply(toScreen, { x: x1, y: y0 }), apply(toScreen, { x: x1, y: y1 }), apply(toScreen, { x: x0, y: y1 })] as const
  return { layer, frame, toScreen, canvasToScreen: compose(screen, frame.canvas), quad }
}

/** The eight handles of a quad (`handle_points`): the corners (0–3), then the middles of the top, right, bottom, and left edges (4–7). */
export function handlePoints(quad: readonly Point[]): Point[] {
  const mid = (i: number) => add(quad[i], times(sub(quad[(i + 1) % 4], quad[i]), 0.5))
  return [quad[0], quad[1], quad[2], quad[3], mid(0), mid(1), mid(2), mid(3)]
}

/** The layer's anchor point on screen (`anchor_screen`). */
export const anchorScreen = (v: LayerView): Point => apply(v.toScreen, { x: v.frame.anchor[0], y: v.frame.anchor[1] })

/** Paragraph text (`is_paragraph`): wrapped in a box; vertical text never is. */
const isParagraph = (v: LayerView) => v.layer.kind === 'text' && (v.frame.box?.[0] ?? 0) > 0 && !v.layer.vertical

/** The quad's bounding box (`Rect::from_points`). */
export function boundsOf(quad: readonly Point[]): Rect {
  const xs = quad.map((point) => point.x)
  const ys = quad.map((point) => point.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

// ---- dragging a handle

/** `HandleScale`: the box grows towards the pointer, the opposite corner or edge staying put. */
export type HandleScale = { pin: Point; ux: Point; uy: Point; fx: number; fy: number }

export function handleScale(quad: readonly Point[], handle: number, start: Point, cur: Point): HandleScale {
  const points = handlePoints(quad)
  const n = Math.min(handle, 7)
  const pin = n < 4 ? points[(n + 2) % 4] : points[4 + ((n - 4 + 2) % 4)]
  const ux = unit(sub(quad[1], quad[0]))
  const uy = unit(sub(quad[3], quad[0]))
  // The factor along `dir`: how far the pointer is from the pinned side, relative to the start.
  const along = (dir: Point) => {
    const from = dot(sub(start, pin), dir)
    return Math.abs(from) < 1 ? 1 : Math.max(dot(sub(cur, pin), dir) / from, 0.01)
  }
  if (n <= 3) {
    const f = along(unit(sub(start, pin)))
    return { pin, ux, uy, fx: f, fy: f }
  }
  return n === 4 || n === 6 ? { pin, ux, uy, fx: 1, fy: along(uy) } : { pin, ux, uy, fx: along(ux), fy: 1 }
}

/** Where a screen point of the layer ends up (`HandleScale::apply`). */
export function applyScale(h: HandleScale, point: Point): Point {
  const w = sub(point, h.pin)
  return add(add(h.pin, times(h.ux, dot(w, h.ux) * h.fx)), times(h.uy, dot(w, h.uy) * h.fy))
}

/**
 * What dragging handle `n` from `start` to `cur` does (`HandleDrag::new`): a shape stretches away
 * from its opposite side, point text scales about its anchor point, and a paragraph-text box is
 * resized (its text re-wraps at the same size).
 */
export type HandleDrag =
  | { kind: 'stretch'; scale: HandleScale }
  | { kind: 'scale'; anchor: Point; f: number }
  /** The text box becomes `rect` (`[x0, y0, x1, y1]`, layer pixels; it was `from`); `tall`: the drag sets its height too. */
  | { kind: 'resize'; rect: [number, number, number, number]; from: [number, number, number, number]; tall: boolean }

export function handleDrag(v: LayerView, handle: number, start: Point, cur: Point): HandleDrag {
  const n = Math.min(handle, 7)
  const quad = v.quad
  if (v.layer.kind !== 'text') return { kind: 'stretch', scale: handleScale(quad, n, start, cur) }
  if (isParagraph(v)) {
    const [boxWidth, boxHeight] = v.frame.box ?? [0, 0]
    // A box without a height is as tall as its text.
    const from: [number, number, number, number] = boxHeight > 0 ? [0, 0, boxWidth, boxHeight] : [0, v.frame.local[1], boxWidth, v.frame.local[3]]
    const inverse = invert(v.toScreen)
    const a = inverse ? apply(inverse, start) : null
    const b = inverse ? apply(inverse, cur) : null
    const dx = a && b ? b.x - a.x : 0
    const dy = a && b ? b.y - a.y : 0
    // The handle follows the pointer and the opposite side stays; the box does not flip.
    const min = Math.max((v.layer.size ?? 100) * 0.5, 1)
    let [x0, y0, x1, y1] = from
    if (n === 0 || n === 3 || n === 7) x0 = Math.min(x0 + dx, x1 - min)
    if (n === 1 || n === 2 || n === 5) x1 = Math.max(x1 + dx, x0 + min)
    if (n === 0 || n === 1 || n === 4) y0 = Math.min(y0 + dy, y1 - min)
    if (n === 2 || n === 3 || n === 6) y1 = Math.max(y1 + dy, y0 + min)
    return { kind: 'resize', rect: [x0, y0, x1, y1], from, tall: boxHeight > 0 || !(n === 5 || n === 7) }
  }
  // Every handle scales both axes alike. Only the pointer's travel along one side of the box
  // counts: along its width for the two side handles, along its height for all the others.
  const anchor = anchorScreen(v)
  const axis = n === 5 || n === 7 ? unit(sub(quad[1], quad[0])) : unit(sub(quad[3], quad[0]))
  const at = handlePoints(quad)[n]
  const from = dot(sub(at, anchor), axis)
  // Away from the anchor grows. A handle on the anchor counts as just inside the box, so dragging it into the box grows.
  const centre = add(quad[0], times(sub(quad[2], quad[0]), 0.5))
  const away = Math.abs(from) > 0.5 ? Math.sign(from) : dot(sub(centre, at), axis) < 0 ? -1 : 1
  const reach = Math.abs(from) + (Math.abs(from) < NEAR_ANCHOR ? NEAR_ANCHOR : 0)
  const f = 1 + (dot(sub(cur, start), axis) * away) / reach
  return { kind: 'scale', anchor, f: Number.isFinite(f) ? Math.max(f, 0.01) : 1 }
}

/** The layer's box on screen as the drag leaves it (`HandleDrag::quad`). */
export function dragQuad(drag: HandleDrag, v: LayerView): Point[] {
  switch (drag.kind) {
    case 'stretch':
      return v.quad.map((point) => applyScale(drag.scale, point))
    case 'scale':
      return v.quad.map((point) => add(drag.anchor, times(sub(point, drag.anchor), drag.f)))
    case 'resize': {
      const [x0, y0, x1, y1] = drag.rect
      return [apply(v.toScreen, { x: x0, y: y0 }), apply(v.toScreen, { x: x1, y: y0 }), apply(v.toScreen, { x: x1, y: y1 }), apply(v.toScreen, { x: x0, y: y1 })]
    }
  }
}

/** The `graphics.set` properties that carry out the drag of handle `n` (`HandleDrag::props`). */
export function dragProps(drag: HandleDrag, v: LayerView, n: number): Record<string, unknown> {
  const { position, anchor, scale } = v.frame
  switch (drag.kind) {
    case 'stretch': {
      // The layer scales about its anchor, so it also moves to keep the pinned side still.
      const a = anchorScreen(v)
      const delta = unscale(v.canvasToScreen, sub(applyScale(drag.scale, a), a))
      const props: Record<string, unknown> = { scale: scale[1] * 100 * drag.scale.fy, scale_width: scale[0] * 100 * drag.scale.fx, position: [position[0] + delta.x, position[1] + delta.y] }
      // An edge stretches one axis only.
      if (n >= 4) props.uniform_scale = false
      return props
    }
    case 'scale':
      return { scale: scale[1] * 100 * drag.f, scale_width: scale[0] * 100 * drag.f }
    case 'resize': {
      // The box's top-left corner is the layer's origin: when it moves, the anchor point is
      // renumbered so that it (and the position) stay on the same spot.
      const { rect, from, tall } = drag
      const props: Record<string, unknown> = { box_width: rect[2] - rect[0], anchor: [anchor[0] - (rect[0] - from[0]), anchor[1] - (rect[1] - from[1])] }
      if (tall) props.box_height = rect[3] - rect[1]
      return props
    }
  }
}

// ---- moving the layer or its anchor point

/** A move by screen offset `off` (`DragKind::Move`): the offset through the inverse of the canvas transform, on the position. */
export function moveProps(v: LayerView, off: Point): Record<string, unknown> {
  const delta = unscale(v.canvasToScreen, off)
  return { position: [v.frame.position[0] + delta.x, v.frame.position[1] + delta.y] }
}

/** The anchor point moved by screen offset `off` (`DragKind::Anchor`): it moves over the layer, the position follows it, so the layer stays. */
export function anchorProps(v: LayerView, off: Point): Record<string, unknown> {
  const canvas = unscale(v.canvasToScreen, off)
  const local = unscale(v.toScreen, off)
  return { position: [v.frame.position[0] + canvas.x, v.frame.position[1] + canvas.y], anchor: [v.frame.anchor[0] + local.x, v.frame.anchor[1] + local.y] }
}

/**
 * A move's offset snapped through `snap_move` (Snap in Program Monitor): the layer's box on screen
 * to the guides and the frame's edges and centre. `free` (Cmd or Ctrl held, read per move) moves
 * freely. `pic` is the picture in canvas pixels.
 */
export function snappedMove(v: LayerView, snap: SnapView | null, pic: Rect, frame: FrameSize, off: Point, free: boolean): { off: Point; lines: SnapLine[] } {
  if (!snap || free) return { off, lines: [] }
  return snapMove(snap, pic, frame, boundsOf(v.quad), off)
}

// ---- presses

/** What a press grabs of the selected layers: the anchor point, or handle `n`. */
export type PressTarget = { kind: 'anchor' | 'handle'; view: LayerView; n: number }

/**
 * What a press at `point` (screen) grabs (`monitor_overlay`'s presses): of the selected graphic's
 * selected layers, front-most first, the anchor point first (it can sit on a handle; Selection tool
 * only), then a handle, each within `HANDLE_GRAB_PX`. Null when it grabs neither: a Selection press
 * on a layer then moves it.
 */
export function pressTarget(
  views: readonly LayerView[],
  selected: { clip: number; layers: readonly number[] } | null,
  tool: string,
  point: Point,
  usable: { anchor: boolean; handle: boolean } = { anchor: true, handle: true },
): PressTarget | null {
  if (!selected) return null
  const chosen = views.filter((view) => view.layer.clip === selected.clip && selected.layers.includes(view.layer.layer))
  // A part the host does not let a press use is skipped, so it never hides another under it.
  const anchor = tool === 'Selection' && usable.anchor ? chosen.find((view) => length(sub(anchorScreen(view), point)) <= HANDLE_GRAB_PX) : undefined
  if (anchor) return { kind: 'anchor', view: anchor, n: -1 }
  if (!usable.handle) return null
  for (const view of chosen) {
    const n = handlePoints(view.quad).findIndex((at) => length(sub(at, point)) <= HANDLE_GRAB_PX)
    if (n >= 0) return { kind: 'handle', view, n }
  }
  return null
}

/**
 * The layers on the canvas at `view` whose handles a press can grab: all but the one being typed
 * into, whose box is the text field's (upstream: a press near the edited box selects text).
 */
export function handleViews(layers: readonly GraphicLayer[], view: CanvasView, editing: { clip: number | null; layer: number | null } | null): LayerView[] {
  return layers.filter((layer) => !(editing && editing.clip === layer.clip && editing.layer === layer.layer)).map((layer) => layerView(layer, view)).filter((each): each is LayerView => each != null)
}

/** Where a press stands when an Escape, a window blur, or a lost pointer capture comes. */
export type PressState = { dragging: boolean; decided: boolean; released: boolean; cancelled: boolean; active: boolean }

/**
 * What an Escape or a lost capture (or window blur) does to a press with the Selection or a Type
 * tool: a running layer drag (`active`) is dropped with nothing sent; before the press's read has
 * decided the drag, it is remembered (`remember`), so a layer drag the press becomes is dropped
 * then; a lost capture also detaches the press's listeners, since its release may never reach the
 * canvas. A decided drag that is not a layer drag (a Type box drag) has no cancel, and an Escape
 * before the drag began is not the press's.
 */
export function interruptLayerDrag(state: PressState, cause: 'escape' | 'lost'): { remember: boolean; drop: boolean; detach: boolean } {
  if (state.released || state.cancelled) return { remember: false, drop: false, detach: false }
  if (state.active) return { remember: false, drop: true, detach: true }
  if (cause === 'lost') return { remember: !state.decided, drop: false, detach: true }
  return { remember: state.dragging && !state.decided, drop: false, detach: false }
}

/** Whether a layer drag released at `end` (screen) is a click: it moved `LAYER_MOVED_PX` or less, so it commits nothing. */
export const isLayerClick = (start: Point, end: Point) => length(sub(end, start)) <= LAYER_MOVED_PX

// ---- what a selected layer draws

/** One SVG part of the overlay: its element, class, attributes, and children. */
export type OverlayPart = { name: 'polygon' | 'rect' | 'line' | 'circle' | 'g'; className: string; attributes: Record<string, string | number>; children?: OverlayPart[] }

export const LAYER_ID = 'control:program.layer'
export const HANDLE_ID = 'control:program.layer.handle'
export const ANCHOR_ID = 'control:program.layer.anchor'

export const pointsOf = (quad: readonly Point[]) => quad.map((point) => `${point.x},${point.y}`).join(' ')

/** The anchor point's crosshair at `at` (`monitor_overlay`: a 4-point circle and two 12-point strokes). */
export function crosshair(at: Point, className: string, attributes: Record<string, string | number> = {}): OverlayPart {
  return {
    name: 'g',
    className,
    attributes,
    children: [
      { name: 'circle', className: '', attributes: { cx: at.x, cy: at.y, r: 4 } },
      { name: 'line', className: '', attributes: { x1: at.x - 6, x2: at.x + 6, y1: at.y, y2: at.y } },
      { name: 'line', className: '', attributes: { x1: at.x, x2: at.x, y1: at.y - 6, y2: at.y + 6 } },
    ],
  }
}

/**
 * What a selected layer draws (`monitor_overlay`'s boxes): its box in the accent, its 8 handles
 * (7-point corners, 5-point edges; a paragraph box that hides text has a red plus for handle 2),
 * and its anchor point. `shown` says which of the three a host lets draw: a hidden one draws
 * nothing, and every part drawn carries its Kit UI id.
 */
export function layerMarks(v: LayerView, shown: { layer: boolean; handle: boolean; anchor: boolean }): OverlayPart[] {
  const parts: OverlayPart[] = []
  const tag = `${v.layer.clip}.${v.layer.layer}`
  if (shown.layer) parts.push({ name: 'polygon', className: 'film-gfx-selected', attributes: { points: pointsOf(v.quad), 'data-layer': tag, 'data-kit-ui-id': LAYER_ID } })
  if (shown.handle) {
    handlePoints(v.quad).forEach((at, n) => {
      // Upstream's names: a paragraph box's handles resize it, every other layer's scale it.
      const marks = { 'data-kit-ui-id': HANDLE_ID, 'data-handle': n, 'data-layer': tag, 'aria-label': isParagraph(v) ? 'resize handle' : 'scale handle' }
      if (n >= 4) parts.push({ name: 'rect', className: 'film-gfx-handle film-gfx-edge', attributes: { x: at.x - 2.5, y: at.y - 2.5, width: 5, height: 5, ...marks } })
      else if (n === 2 && v.frame.overflow) {
        parts.push({ name: 'rect', className: 'film-gfx-handle film-gfx-overflow', attributes: { x: at.x - 4.5, y: at.y - 4.5, width: 9, height: 9, ...marks } })
        parts.push({ name: 'line', className: 'film-gfx-plus', attributes: { x1: at.x - 3, x2: at.x + 3, y1: at.y, y2: at.y } })
        parts.push({ name: 'line', className: 'film-gfx-plus', attributes: { x1: at.x, x2: at.x, y1: at.y - 3, y2: at.y + 3 } })
      } else parts.push({ name: 'rect', className: 'film-gfx-handle', attributes: { x: at.x - 3.5, y: at.y - 3.5, width: 7, height: 7, ...marks } })
    })
  }
  if (shown.anchor) parts.push(crosshair(anchorScreen(v), 'film-gfx-anchor', { 'data-kit-ui-id': ANCHOR_ID, 'data-layer': tag }))
  return parts
}
