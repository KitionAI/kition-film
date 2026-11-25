// The Source and Program monitors' arithmetic and tables, as upstream's `panels/monitor.rs`,
// `monitor_view.rs`, `source_range.rs`, and `source_drag.rs`, and the Film engine's
// `source_monitor::adjust_range` and the time crate's frame grid. Times are engine ticks. Pure,
// with `.ts` imports, so `node --test` runs it.
import { TICKS_PER_SECOND } from '../film.ts'
import { RESOLUTIONS } from './monitorView.ts'

export type Which = 'program' | 'source'

/** A frame rate as a fraction, so NTSC rates count frames exactly (29.97 is 30000/1001). */
export type Rate = { num: number; den: number }

/** The exact rate `fps` stands for: an NTSC fraction for 23.976, 29.97, 59.94, and the like. */
export function rateOf(fps: number): Rate {
  const safe = Number.isFinite(fps) && fps > 0 ? fps : 30
  const nominal = Math.round(safe * 1.001)
  if (!Number.isInteger(safe) && Math.abs(safe - (nominal * 1000) / 1001) < 0.005) return { num: nominal * 1000, den: 1001 }
  if (Number.isInteger(safe)) return { num: safe, den: 1 }
  // Any other fractional rate, to a thousandth.
  return { num: Math.round(safe * 1000), den: 1000 }
}

const TPS = BigInt(TICKS_PER_SECOND)
/** Floor division of bigints (`div_euclid` for a positive divisor). */
const floorDiv = (a: bigint, b: bigint) => (a >= 0n ? a / b : -((-a + b - 1n) / b))
const big = (value: number) => BigInt(Math.trunc(value))

/** `FrameRate::frame_duration`: one frame in ticks (floored). */
export function frameTicks(rate: Rate) {
  return Number((TPS * BigInt(rate.den)) / BigInt(rate.num))
}

/** `FrameRate::frame_at`: the index of the frame containing `ticks` (floor). */
export function frameAt(rate: Rate, ticks: number) {
  return Number(floorDiv(big(ticks) * BigInt(rate.num), TPS * BigInt(rate.den)))
}

/** `FrameRate::tick_of`: the first tick of frame `frame` (ceiling). */
export function tickOf(rate: Rate, frame: number) {
  const n = big(frame) * TPS * BigInt(rate.den)
  return Number(-floorDiv(-n, BigInt(rate.num)))
}

/** `FrameRate::snap`: `ticks` down to its frame's start. */
export function snapTicks(rate: Rate, ticks: number) {
  return tickOf(rate, frameAt(rate, ticks))
}

export type Span = { start: number; end: number }

/** `source_monitor::RangeEdge`: the In handle, the Out handle, or the whole marked range. */
export type RangeEdge = 'in' | 'out' | 'move'

/**
 * `source_monitor::adjust_range`: `range` with its In (`in`), its Out (`out`), or both (`move`)
 * moved by `delta` ticks, kept inside `bounds` and on the source's frame grid; null for a range
 * the engine calls invalid. Spans are `[start, end)`, Out being one frame before `end`.
 */
export function adjustRange(bounds: Span, range: Span, rate: Rate, edge: RangeEdge, delta: number): Span | null {
  if (bounds.start < 0 || bounds.end <= bounds.start || range.end <= range.start || range.start < bounds.start || range.end > bounds.end || rate.num <= 0 || rate.den <= 0) return null
  const num = BigInt(rate.num)
  const scale = TPS * BigInt(rate.den)
  const fd = scale / num
  if (fd <= 0n) return null
  const floor = (t: bigint) => floorDiv(floorDiv(t * num, scale) * scale, num)
  const nearest = (t: bigint) => {
    const a = floor(t)
    const b = floorDiv((floorDiv(t * num, scale) + 1n) * scale, num)
    return t - a <= b - t ? a : b
  }
  const clamp = (t: bigint, lo: bigint, hi: bigint) => (t < lo ? lo : t > hi ? hi : t)
  const max2 = (a: bigint, b: bigint) => (a > b ? a : b)
  const min2 = (a: bigint, b: bigint) => (a < b ? a : b)
  const [lo, hi, start, stop, d] = [big(bounds.start), big(bounds.end), big(range.start), big(range.end), big(delta)]
  let a: bigint
  let b: bigint
  if (edge === 'in') {
    const max = max2(floor(max2(stop - min2(fd, hi - lo), lo)), lo)
    a = clamp(nearest(clamp(start + d, lo, max)), lo, max)
    b = stop
  } else if (edge === 'out') {
    const last = max2(floor(max2(hi - fd, lo)), lo)
    if (start > last) return null
    const o = clamp(nearest(clamp(stop - fd + d, start, last)), start, last)
    a = start
    b = min2(o + fd, hi)
  } else {
    const min = -floor(-(lo - start))
    const max = floor(hi - stop)
    if (min > max) return null
    const moved = clamp(nearest(clamp(d, min, max)), min, max)
    a = start + moved
    b = stop + moved
  }
  return { start: Number(a), end: Number(b) }
}

/** What the Source monitor reads of `source.inspect`, in ticks. */
export type SourceView = {
  item: number
  media: number
  start: number
  end: number
  fps: number
  playhead: number
  markIn: number | null
  markOut: number | null
  /** The clip's markers (a subclip's inherited ones), with their label colour's name. */
  markers: ReadonlyArray<{ start: number; color: string }>
  subclip: { start: number; end: number; restrictTrims: boolean } | null
  width: number
  height: number
  hasVideo: boolean
  hasAudio: boolean
}

/** `source.inspect`'s answer as a `SourceView`, or null when the Source monitor is empty. */
export function sourceViewOf(raw: unknown): SourceView | null {
  const view = raw as Partial<Record<keyof SourceView, unknown>> | null
  if (!view || typeof view.item !== 'number') return null
  const num = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const mark = (value: unknown) => (typeof value === 'number' ? value : null)
  return {
    item: view.item,
    media: num(view.media, view.item),
    start: num(view.start),
    end: num(view.end),
    fps: num(view.fps, 30) || 30,
    playhead: num(view.playhead),
    markIn: mark(view.markIn),
    markOut: mark(view.markOut),
    markers: Array.isArray(view.markers) ? view.markers.map((marker: { start?: unknown; color?: unknown }) => ({ start: num(marker.start), color: typeof marker.color === 'string' ? marker.color : '' })) : [],
    subclip: (view.subclip as SourceView['subclip']) ?? null,
    width: num(view.width),
    height: num(view.height),
    hasVideo: view.hasVideo !== false,
    hasAudio: view.hasAudio !== false,
  }
}

/** `SourceView::selected_range`: In to one frame past Out, inside the clip. */
export function selectedRange(view: Pick<SourceView, 'start' | 'end' | 'markIn' | 'markOut'>, rate: Rate): Span {
  if (view.start < 0 || view.end <= view.start) return { start: view.start, end: view.start }
  const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))
  const start = clamp(view.markIn ?? view.start, view.start, view.end)
  const end = clamp(view.markOut != null ? view.markOut + frameTicks(rate) : view.end, start, view.end)
  return { start, end }
}

/** What a monitor shows along its time ruler: its span, playhead, and marks, in ticks. */
export type MonitorSpan = {
  /** Where the ruler starts (a subclip restricted to its range starts at its In). */
  origin: number
  /** Where it ends (the sequence's or the clip's end). */
  end: number
  rate: Rate
  /** The marks as shown: the Source monitor shows the whole clip as marked until marked. */
  markIn: number | null
  markOut: number | null
  /** Whether each mark is really set (the Source monitor draws no bracket for an implicit one). */
  hasIn: boolean
  hasOut: boolean
}

/** Upstream `show`'s marks: the Source monitor's implicit full-clip marks, the Program's as set; a range being dragged wins. */
export function monitorSpan(which: Which, view: { start: number; end: number; markIn: number | null; markOut: number | null }, rate: Rate, draft: Span | null = null): MonitorSpan {
  const fd = frameTicks(rate)
  const origin = which === 'source' ? view.start : 0
  const draftIn = draft?.start
  const draftOut = draft ? draft.end - fd : undefined
  const markIn = which === 'source' ? (draftIn ?? view.markIn ?? origin) : view.markIn != null ? (draftIn ?? view.markIn) : null
  const markOut = which === 'source' ? (draftOut ?? view.markOut ?? Math.max(view.end - fd, origin)) : view.markOut != null ? (draftOut ?? view.markOut) : null
  return { origin, end: view.end, rate, markIn, markOut, hasIn: view.markIn != null, hasOut: view.markOut != null }
}

/** The duration timecode at the row's right: Out (inclusive) or the end, less In or the ruler's start. */
export function shownDuration(span: MonitorSpan) {
  const end = span.markOut != null ? span.markOut + frameTicks(span.rate) : span.end
  return Math.max(0, end - (span.markIn ?? span.origin))
}

/** `mini_timeline`'s `xof`: where `ticks` falls along a ruler `width` wide. */
export function xOfTicks(span: Pick<MonitorSpan, 'origin' | 'end'>, ticks: number, width: number) {
  const duration = Math.max(1, span.end - span.origin)
  return Math.min(1, Math.max(0, (ticks - span.origin) / duration)) * width
}

/** A scrub at `x` along a ruler `width` wide: the frame there (snapped down, as `rate.snap`). */
export function ticksAtX(span: Pick<MonitorSpan, 'origin' | 'end' | 'rate'>, x: number, width: number) {
  const f = Math.min(1, Math.max(0, x / Math.max(1, width)))
  return snapTicks(span.rate, span.origin + Math.floor(f * Math.max(1, span.end - span.origin)))
}

/**
 * The playhead a resolution change's repaint sends (`ticks`), or null to send none: a move of
 * the playhead after the new scale was asked for (a step, a seek) repaints by itself, and the
 * repaint's older position would undo it.
 */
export function repaintTicks(movesAtStart: number, movesNow: number, ticks: number): number | null {
  return movesAtStart === movesNow ? ticks : null
}

/** A click on the marked range (`interact`'s click arm): the playhead to the frame under the point. */
export function rangeClickTicks(bounds: Span, rate: Rate, x: number, width: number) {
  const f = Math.min(1, Math.max(0, x / Math.max(1, width)))
  return snapTicks(rate, bounds.start + Math.floor(f * Math.max(1, bounds.end - bounds.start)))
}

/**
 * Whether a range drag that began on `drag.item` at engine revision `drag.revision` still holds
 * (`source_range::interact`): another revision (an edit, an undo, the agent) or another item ends
 * it, and its release then sends nothing.
 */
export function rangeDragLive(drag: { item: number; revision: number | null }, item: number | null, revision: number | null) {
  return item != null && drag.item === item && drag.revision === revision
}

/** `source_range::interact`'s `enabled`: a subclip's range cannot be dragged, nor an empty clip. */
export const rangeEditable = (view: { start: number; end: number; subclip?: unknown }) => !view.subclip && view.start >= 0 && view.end > view.start

/**
 * The `project.setMarks` a range drag sends on release (`source_range::interact`): the edge's own
 * mark (In at the range's start, Out one frame before its end), both for a move; null when the
 * range did not change.
 */
export function setMarksParams(item: number, edge: RangeEdge, original: Span, preview: Span, origin: number, rate: Rate): Record<string, number> | null {
  if (preview.start === original.start && preview.end === original.end) return null
  const params: Record<string, number> = { item }
  if (edge !== 'out') params.in = preview.start
  if (edge !== 'in') params.out = Math.max(preview.end - frameTicks(rate), origin)
  return params
}

/** Upstream's transport buttons (`monitor.rs` `transport`), with the shared Kit UI ids (rule 3). */
export type TransportEntry = {
  /** Upstream's command in the row (`program.transport.<key>`). */
  key: string
  /** Upstream's tooltip, a phrase. */
  label: string
  uiId: string
  icon: 'marker' | 'markIn' | 'markOut' | 'goToIn' | 'stepBack' | 'play' | 'stepForward' | 'goToOut' | 'insert' | 'overwrite' | 'lift' | 'extract' | 'camera' | 'proxy'
}

export const SOURCE_TRANSPORT: readonly TransportEntry[] = [
  { key: 'marker.add', label: 'Add Marker (M)', uiId: 'control:transport.addMarker', icon: 'marker' },
  { key: 'src.markIn', label: 'Mark In (I)', uiId: 'control:transport.markIn', icon: 'markIn' },
  { key: 'src.markOut', label: 'Mark Out (O)', uiId: 'control:transport.markOut', icon: 'markOut' },
  { key: 'src.goIn', label: 'Go to In (Shift+I)', uiId: 'control:transport.goToIn', icon: 'goToIn' },
  { key: 'src.stepBack', label: 'Step Back 1 Frame (Left)', uiId: 'control:transport.stepBack', icon: 'stepBack' },
  { key: 'source.playback.toggle', label: 'Play-Stop Toggle (Space)', uiId: 'control:transport.play', icon: 'play' },
  { key: 'src.stepFwd', label: 'Step Forward 1 Frame (Right)', uiId: 'control:transport.stepForward', icon: 'stepForward' },
  { key: 'src.goOut', label: 'Go to Out (Shift+O)', uiId: 'control:transport.goToOut', icon: 'goToOut' },
  { key: 'source.insert', label: 'Insert (,)', uiId: 'control:transport.insert', icon: 'insert' },
  { key: 'source.overwrite', label: 'Overwrite (.)', uiId: 'control:transport.overwrite', icon: 'overwrite' },
  { key: 'exportFrame', label: 'Export Frame', uiId: 'control:transport.exportFrame', icon: 'camera' },
  { key: 'media.toggleProxies', label: 'Toggle Proxies', uiId: 'control:transport.toggleProxies', icon: 'proxy' },
]

export const PROGRAM_TRANSPORT: readonly TransportEntry[] = [
  { key: 'marker.add', label: 'Add Marker (M)', uiId: 'control:transport.addMarker', icon: 'marker' },
  { key: 'marker.markIn', label: 'Mark In (I)', uiId: 'control:transport.markIn', icon: 'markIn' },
  { key: 'marker.markOut', label: 'Mark Out (O)', uiId: 'control:transport.markOut', icon: 'markOut' },
  { key: 'marker.goToIn', label: 'Go to In (Shift+I)', uiId: 'control:transport.goToIn', icon: 'goToIn' },
  { key: 'playhead.stepBack', label: 'Step Back 1 Frame (Left)', uiId: 'control:transport.stepBack', icon: 'stepBack' },
  { key: 'playback.toggle', label: 'Play-Stop Toggle (Space)', uiId: 'control:transport.play', icon: 'play' },
  { key: 'playhead.stepForward', label: 'Step Forward 1 Frame (Right)', uiId: 'control:transport.stepForward', icon: 'stepForward' },
  { key: 'marker.goToOut', label: 'Go to Out (Shift+O)', uiId: 'control:transport.goToOut', icon: 'goToOut' },
  { key: 'sequence.lift', label: 'Lift (;)', uiId: 'control:transport.lift', icon: 'lift' },
  { key: 'sequence.extract', label: "Extract (')", uiId: 'control:transport.extract', icon: 'extract' },
  { key: 'exportFrame', label: 'Export Frame', uiId: 'control:transport.exportFrame', icon: 'camera' },
  { key: 'media.toggleProxies', label: 'Toggle Proxies', uiId: 'control:transport.toggleProxies', icon: 'proxy' },
]

/** What a Source transport button does (`transport`'s click arm): a command for `invoke`, or a source playhead move. */
export type TransportAction = { command: string; params: Record<string, unknown> } | { seek: 'goIn' | 'goOut' | 'stepBack' | 'stepFwd' } | { disabled: true }

/** `transport`'s click arm: `src.*` marks with `target: "source"`, `src.go*` and steps move the source playhead, others run with `monitor`. */
export function transportAction(which: Which, key: string): TransportAction {
  if (key === 'exportFrame') return { disabled: true }
  if (key === 'src.markIn') return { command: 'marker.markIn', params: { target: 'source' } }
  if (key === 'src.markOut') return { command: 'marker.markOut', params: { target: 'source' } }
  if (key === 'src.goIn' || key === 'src.goOut' || key === 'src.stepBack' || key === 'src.stepFwd') return { seek: key.slice('src.'.length) as 'goIn' }
  return { command: key, params: { monitor: which } }
}

/** `source_nav`: where Go to In or Out, or a frame step, puts the source playhead. */
export function sourceNavTicks(view: Pick<SourceView, 'start' | 'end' | 'markIn' | 'markOut' | 'playhead'>, rate: Rate, seek: 'goIn' | 'goOut' | 'stepBack' | 'stepFwd') {
  const fd = frameTicks(rate)
  if (seek === 'goIn') return view.markIn ?? view.start
  if (seek === 'goOut') return view.markOut ?? view.end - fd
  return seek === 'stepBack' ? view.playhead - fd : view.playhead + fd
}

/** A Source drag's payload (`source_drag::begin`): the media and the marked span, the streams it has; null when nothing can go. */
export function sourceDragPayload(view: SourceView, video: boolean, audio: boolean) {
  const range = selectedRange(view, rateOf(view.fps))
  const withVideo = video && view.hasVideo
  const withAudio = audio && view.hasAudio
  if ((!withVideo && !withAudio) || range.end - range.start <= 0) return null
  return { item: view.media, sourceIn: range.start, duration: range.end - range.start, video: withVideo, audio: withAudio }
}

/** `monitor::quantize_scale`: buckets that keep cached frames useful while a panel resizes. */
export function quantizeScale(scale: number) {
  const buckets = [1 / 32, 1 / 16, 1 / 8, 0.1875, 0.25, 0.375, 0.5, 0.75, 1]
  return buckets.find((bucket) => bucket >= scale - 1e-4) ?? 1
}

/**
 * `show`'s render scale: the effective resolution's, no more than the picture needs on screen
 * (`screenScale`, device pixels per frame pixel), bucketed.
 */
export function renderScaleOf(res: keyof typeof RESOLUTIONS, screenScale: number) {
  return quantizeScale(Math.min(RESOLUTIONS[res].scale, Math.max(Math.min(screenScale, 1), 1 / 32)))
}

export type Box = { x: number; y: number; width: number; height: number }

/** `monitor::fit`: a `w` × `h` picture fitted in `area`, centred. */
export function fitBox(area: Box, w: number, h: number): Box {
  const s = Math.min(area.width / Math.max(1, w), area.height / Math.max(1, h))
  const width = w * s
  const height = h * s
  return { x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height }
}

/**
 * `monitor_view::picture_rect`: fitted, or magnified (1 is one frame pixel per device pixel, so a
 * CSS size of `w × zoom / dpr`) about the area's centre plus the pan, clamped so the picture
 * covers the area where it can.
 */
export function pictureBox(area: Box, w: number, h: number, zoom: number | null, pan: { x: number; y: number }, dpr: number): Box {
  if (zoom == null) return fitBox(area, w, h)
  const scale = Math.max(0.1, dpr)
  const width = (w * zoom) / scale
  const height = (h * zoom) / scale
  const maxX = Math.max(0, (width - area.width) / 2)
  const maxY = Math.max(0, (height - area.height) / 2)
  const px = Math.min(maxX, Math.max(-maxX, pan.x))
  const py = Math.min(maxY, Math.max(-maxY, pan.y))
  return { x: area.x + area.width / 2 + px - width / 2, y: area.y + area.height / 2 + py - height / 2, width, height }
}

/** The safe areas, (horizontal, vertical) percent of the picture outside each (Project Settings ▸ General). */
export type SafeAreaPercents = { title: readonly [number, number]; action: readonly [number, number] }

/** Whether two safe areas are the same. */
export const sameAreas = (a: SafeAreaPercents, b: SafeAreaPercents) => a.title[0] === b.title[0] && a.title[1] === b.title[1] && a.action[0] === b.action[0] && a.action[1] === b.action[1]

/**
 * Safe margins (`show`), centred: the action and title safe areas of the project (upstream draws
 * 90% and 80%, its defaults, whatever the project says; Film draws the project's, so a Project
 * Settings preview shows what OK changes).
 */
export function safeMargins(picture: Box, areas: SafeAreaPercents = { title: [20, 20], action: [10, 10] }): { action: Box; title: Box } {
  const scaled = ([h, v]: readonly [number, number]): Box => {
    const width = picture.width * (1 - Math.max(0, Math.min(100, h)) / 100)
    const height = picture.height * (1 - Math.max(0, Math.min(100, v)) / 100)
    return { x: picture.x + (picture.width - width) / 2, y: picture.y + (picture.height - height) / 2, width, height }
  }
  return { action: scaled(areas.action), title: scaled(areas.title) }
}

/** The zoom dropdown's text: Fit, or the percentage. */
export const zoomLabel = (zoom: number | null) => (zoom == null ? 'Fit' : `${Math.round(zoom * 100)}%`)
