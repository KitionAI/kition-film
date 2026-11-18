/**
 * The graphics tools on the Program monitor, as upstream's `panels/graphics.rs` `monitor_overlay`
 * handles them: the Type and Vertical Type tools make text (`graphics.newText`,
 * `graphics.newVerticalText`) and edit it in place (`graphics.setText`), Rectangle and Ellipse drag
 * out a shape, and the Pen clicks a path (`graphics.newShape`). Points are in sequence pixels (the
 * canvas's document pixels); the canvas's view maps them to its CSS pixels. Pure, so `node --test`
 * runs it. Imports carry `.ts` so `node --test` loads this module as it is.
 */
import { parseLayerFrame, type LayerFrame } from '../graphics/layerHandles.ts'

export type Point = { x: number; y: number }
/** The canvas's view: its zoom (CSS pixels per sequence pixel) and the sequence point at its top left. */
export type CanvasView = { zoom: number; x: number; y: number }

/** A graphic layer in the picture (the engine's `graphicLayers`): its box's corners in sequence pixels (TL, TR, BR, BL). */
export type GraphicLayer = {
  clip: number
  layer: number
  kind: 'text' | 'shape'
  quad: ReadonlyArray<readonly [number, number]>
  /** Layer pixels to sequence pixels. */
  scale: number
  text?: string
  /** The font size, in layer pixels. */
  size?: number
  vertical?: boolean
  paragraph?: boolean
  /** What the handles need (`layerHandles.ts`): its box, maps, and transform; null when the engine did not give them. */
  frame?: LayerFrame | null
}

/** Where new layers go: the selected graphic clip under the playhead, its canvas mapped to sequence pixels by `matrix` (`[a, b, c, d, e, f]`). */
export type GraphicTarget = { clip: number; matrix: readonly number[] }
/** The first selected graphic clip (upstream's `selected_graphic`) and its selected layers (`graphic_layers`). */
export type GraphicSelection = { clip: number; layers: number[] }
export type GraphicLayers = { layers: GraphicLayer[]; target: GraphicTarget | null; selected: GraphicSelection | null }

/** The tools whose presses the graphics overlay takes (upstream's `graphics_tool`). */
export const GRAPHICS_TOOLS: ReadonlySet<string> = new Set(['Selection', 'Type', 'VerticalType', 'Rectangle', 'Ellipse', 'Pen'])

/** Upstream closes a Pen path on a click this close to its first point, in screen points (`graphics.rs`: `<= 8.0`). */
export const PEN_CLOSE_PX = 8
/** A layer is hit this far outside its box, in screen points (`LayerView::hit`). */
export const HIT_PAD_PX = 4
/** A release this far from the press, in screen points, ends a drag that did something (`moved`). */
export const MOVED_PX = 2
/** A dragged text box smaller than this (canvas pixels) on either side was meant as a click (`new_text_action`). */
const MIN_TEXT_BOX = 4

export const toSequence = (view: CanvasView, point: Point): Point => ({ x: view.x + point.x / view.zoom, y: view.y + point.y / view.zoom })
export const toCanvas = (view: CanvasView, point: Point): Point => ({ x: (point.x - view.x) * view.zoom, y: (point.y - view.y) * view.zoom })

/**
 * What a press on the Program picture does with `tool` (upstream `monitor.rs`: `pan_input`, then
 * `graphics::monitor_overlay`): the graphics tools draw; the Hand pans a picture larger than its
 * area (`pan_input` does nothing at Fit); every other tool only focuses the monitor.
 */
export function pressKind(tool: string, magnified: boolean): 'graphics' | 'pan' | 'none' {
  if (GRAPHICS_TOOLS.has(tool)) return 'graphics'
  return tool === 'Hand' && magnified ? 'pan' : 'none'
}

/** Whether the picture at `view` is larger than its area on either side (upstream's `max` pan above zero). */
export function pictureOverflows(view: CanvasView & { width: number; height: number }, width: number, height: number) {
  return width * view.zoom > view.width + 0.5 || height * view.zoom > view.height + 0.5
}

/** A sequence point on the target's canvas (`to_canvas` with `canvas_target`); the sequence's own canvas with no target. */
export function canvasPoint(target: GraphicTarget | null, point: Point): Point {
  if (!target) return point
  const [a, b, c, d, e, f] = target.matrix
  const det = a * d - b * c
  if (Math.abs(det) < 1e-12) return { x: 0, y: 0 }
  const x = point.x - e
  const y = point.y - f
  return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det }
}

const withClip = <T extends Record<string, unknown>>(params: T, target: GraphicTarget | null) => (target ? { ...params, clip: target.clip } : params)

/**
 * `new_text_action`: `graphics.newText` for the Type tool at `at`, point text sized 100 px per
 * 1080 lines of the sequence, or paragraph text in the box from `at` to `corner` when that box
 * holds a letter (4 px on each side). New text starts empty.
 */
export function newTextParams(frameHeight: number, target: GraphicTarget | null, at: Point, corner?: Point) {
  const a = canvasPoint(target, at)
  const params: Record<string, unknown> = { text: '', position: [a.x, a.y], size: Math.round((100 * frameHeight) / 1080) }
  if (corner) {
    const b = canvasPoint(target, corner)
    const width = Math.abs(b.x - a.x)
    const height = Math.abs(b.y - a.y)
    if (width >= MIN_TEXT_BOX && height >= MIN_TEXT_BOX) {
      params.position = [Math.min(a.x, b.x), Math.min(a.y, b.y)]
      params.box = [width, height]
    }
  }
  return withClip(params, target)
}

/** The Rectangle or Ellipse drag from `start` to `end` as `graphics.newShape`: its centre and size on the target canvas. */
export function shapeParams(tool: string, target: GraphicTarget | null, start: Point, end: Point) {
  const a = canvasPoint(target, start)
  const b = canvasPoint(target, end)
  return withClip({ shape: tool === 'Ellipse' ? 'ellipse' : 'rectangle', position: [(a.x + b.x) / 2, (a.y + b.y) / 2], size: [Math.abs(b.x - a.x), Math.abs(b.y - a.y)] }, target)
}

/** Whether a Pen click at `pointer` (canvas CSS pixels) closes the path: three points or more, and within `PEN_CLOSE_PX` of the first. */
export function penCloses(points: readonly Point[], pointer: Point, view: CanvasView) {
  if (points.length < 3) return false
  const first = toCanvas(view, points[0])
  return Math.hypot(first.x - pointer.x, first.y - pointer.y) <= PEN_CLOSE_PX
}

/** `finish_pen`: the path as `graphics.newShape` (`shape: "path"`), its points about their centroid on the target canvas; null under three points. */
export function penShapeParams(points: readonly Point[], target: GraphicTarget | null) {
  if (points.length < 3) return null
  const onCanvas = points.map((point) => canvasPoint(target, point))
  const cx = onCanvas.reduce((sum, point) => sum + point.x, 0) / onCanvas.length
  const cy = onCanvas.reduce((sum, point) => sum + point.y, 0) / onCanvas.length
  return withClip({ shape: 'path', position: [cx, cy], points: onCanvas.map((point) => [point.x - cx, point.y - cy]) }, target)
}

/**
 * `LayerView::hit`: `point` (sequence pixels) is in the layer's box, or within `HIT_PAD_PX` screen
 * points of it at `zoom`. A box with no width (empty point text) is measured across the frame's x axis.
 */
export function hitsLayer(layer: GraphicLayer, point: Point, zoom: number) {
  const [q0, q1, , q3] = layer.quad
  const pad = HIT_PAD_PX / Math.max(zoom, 1e-6)
  const along = (to: readonly [number, number], fallback: Point) => {
    const dx = to[0] - q0[0]
    const dy = to[1] - q0[1]
    const length = Math.hypot(dx, dy)
    return length > 1e-9 ? { x: dx / length, y: dy / length, length } : { ...fallback, length: 0 }
  }
  const u = along(q1, { x: 1, y: 0 })
  const v = along(q3, { x: 0, y: 1 })
  const px = point.x - q0[0]
  const py = point.y - q0[1]
  const s = px * u.x + py * u.y
  const t = px * v.x + py * v.y
  return s >= -pad && s <= u.length + pad && t >= -pad && t <= v.length + pad
}

/** The front-most layer at `point` that `accept` takes, or null. */
export function layerAt(layers: readonly GraphicLayer[], point: Point, zoom: number, accept: (layer: GraphicLayer) => boolean = () => true) {
  return layers.find((layer) => accept(layer) && hitsLayer(layer, point, zoom)) ?? null
}

/**
 * Where the in-place text field goes over `layer` on the canvas (CSS pixels): the layer's box,
 * at the layer's font size on screen, and never too small for a caret (new text is empty).
 */
export function editBox(layer: GraphicLayer, view: CanvasView) {
  const corners = layer.quad.map(([x, y]) => toCanvas(view, { x, y }))
  const left = Math.min(...corners.map((corner) => corner.x))
  const top = Math.min(...corners.map((corner) => corner.y))
  const fontSize = (layer.size ?? 100) * layer.scale * view.zoom
  const width = Math.max(Math.max(...corners.map((corner) => corner.x)) - left, fontSize * 0.5)
  const height = Math.max(Math.max(...corners.map((corner) => corner.y)) - top, fontSize)
  return { left, top, width, height, fontSize }
}

const isPair = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'number' && Number.isFinite(part))

/** The engine's `graphicLayers` answer; rows it cannot place are left out, and anything unreadable is an empty picture. */
export function parseGraphicLayers(text: string): GraphicLayers {
  let raw: { layers?: unknown; target?: unknown; selected?: unknown }
  try {
    raw = JSON.parse(text) as typeof raw
  } catch {
    return { layers: [], target: null, selected: null }
  }
  const layers: GraphicLayer[] = []
  for (const row of Array.isArray(raw?.layers) ? (raw.layers as Array<Record<string, unknown>>) : []) {
    if (typeof row?.clip !== 'number' || typeof row.layer !== 'number' || !Array.isArray(row.quad) || row.quad.length !== 4 || !row.quad.every(isPair)) continue
    layers.push({
      clip: row.clip,
      layer: row.layer,
      kind: row.kind === 'text' ? 'text' : 'shape',
      quad: row.quad as Array<[number, number]>,
      scale: typeof row.scale === 'number' && row.scale > 0 ? row.scale : 1,
      ...(row.kind === 'text' ? { text: typeof row.text === 'string' ? row.text : '', size: typeof row.size === 'number' ? row.size : 100, vertical: row.vertical === true, paragraph: row.paragraph === true } : {}),
      frame: parseLayerFrame(row),
    })
  }
  const target = raw?.target as { clip?: unknown; matrix?: unknown } | null | undefined
  const matrix = Array.isArray(target?.matrix) && target.matrix.length === 6 && target.matrix.every((value) => typeof value === 'number') ? (target.matrix as number[]) : null
  const picked = raw?.selected as { clip?: unknown; layers?: unknown } | null | undefined
  const selected = typeof picked?.clip === 'number' && Array.isArray(picked.layers) && picked.layers.every((layer) => typeof layer === 'number') ? { clip: picked.clip, layers: picked.layers as number[] } : null
  return { layers, target: typeof target?.clip === 'number' && matrix ? { clip: target.clip, matrix } : null, selected }
}

/**
 * The layers that draw a box (upstream `monitor_overlay`'s boxes): the selected graphic's
 * selected layers in the picture. The one being typed into has its red box (the field) instead.
 */
export function outlinedLayers(shown: GraphicLayers, editing: { clip: number | null; layer: number | null } | null) {
  const selected = shown.selected
  if (!selected) return []
  return shown.layers.filter((layer) => layer.clip === selected.clip && selected.layers.includes(layer.layer) && !(editing && editing.clip === layer.clip && editing.layer === layer.layer))
}
