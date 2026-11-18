import { TICKS_PER_SECOND } from '../film.ts'
import { displayChecked, isDisplayMode, setDisplay, type DisplayMode } from './displayModes.ts'
import type { Guide } from './guideModel.ts'

/**
 * The monitors' view options, as upstream's `monitor_view.rs`: Playback and Paused Resolution,
 * High Quality Playback, Magnification, Safe Margins, the display mode (with the Comparison
 * View's reference), and the rulers, guides, and Snap in Program Monitor, one set per monitor
 * (guides in frame pixels). The UI owns them
 * (upstream's `MonitorView`, never the engine's). The `view.*` commands change them through
 * `invoke` and act on `params.monitor`, else on the focused monitor (Program by default). Pure,
 * so `node --test` runs it.
 */

export type Resolution = 'full' | 'half' | 'quarter' | 'eighth' | 'sixteenth'
export type MonitorId = 'program' | 'source'

/** Upstream's `PlaybackRes`: each resolution's scale and label, in menu order. */
export const RESOLUTIONS: Readonly<Record<Resolution, { scale: number; label: string }>> = {
  full: { scale: 1, label: 'Full' },
  half: { scale: 0.5, label: '1/2' },
  quarter: { scale: 0.25, label: '1/4' },
  eighth: { scale: 0.125, label: '1/8' },
  sixteenth: { scale: 0.0625, label: '1/16' },
}

/** Upstream's `ZOOMS`: View ▸ Magnification's levels and their factors (Fit is null). */
export const ZOOMS: ReadonlyArray<readonly [string, number]> = [
  ['10', 0.1],
  ['25', 0.25],
  ['50', 0.5],
  ['75', 0.75],
  ['100', 1],
  ['150', 1.5],
  ['200', 2],
  ['400', 4],
  ['800', 8],
  ['1600', 16],
]

export type MonitorView = {
  /** Playback Resolution, used while playing. */
  res: Resolution
  /** Paused Resolution, used while stopped. */
  pausedRes: Resolution
  /** High Quality Playback: play at the paused resolution when it is higher. */
  highQuality: boolean
  /** Magnification: null is Fit, else the zoom factor (1 is one frame pixel per screen pixel). */
  zoom: number | null
  safeMargins: boolean
  /** Show Transport Controls (the wrench menu): the transport row under the scrub bar. */
  showTransport: boolean
  /** Counts the magnifications chosen (a level picked again included), so the picture is magnified again only then. */
  zoomPick: number
  /** Display Mode (`view.display.*`): Composite, a channel, the Source's waveform modes, or the Program's Comparison View. */
  display: DisplayMode
  /** The Comparison View's reference frame (ticks, the Program's); null until Comparison or Set Comparison Reference sets it. */
  compareRef: number | null
  showRulers: boolean
  showGuides: boolean
  /** Lock Guides: a guide cannot be dragged or dropped away. */
  lockGuides: boolean
  /** Snap in Program Monitor (the Program's alone counts): graphic drags snap to the guides, the frame's edges and centre. */
  snap: boolean
  guides: readonly Guide[]
}

export type MonitorViews = Readonly<Record<MonitorId, MonitorView>>

/** Upstream's `MonitorView::default`. */
const DEFAULT_VIEW: MonitorView = { res: 'half', pausedRes: 'full', highQuality: false, zoom: null, safeMargins: false, showTransport: true, zoomPick: 0, display: 'composite', compareRef: null, showRulers: false, showGuides: true, lockGuides: false, snap: true, guides: [] }
export const DEFAULT_VIEWS: MonitorViews = { program: DEFAULT_VIEW, source: DEFAULT_VIEW }

type Params = Record<string, unknown>

/** `keyboard.rs`'s Zoom Program/Source Monitor to 100% or Fit: each names its monitor. */
const ZOOM_KEY = /^view\.(program|source)Zoom(100|Fit)$/

/** `which_of`: the monitor a `view.*` command acts on, `params.monitor` else the focused monitor. */
export function monitorOf(focused: string, params: Params = {}): MonitorId {
  if (params.monitor === 'source' || params.monitor === 'program') return params.monitor
  return focused === 'source' ? 'source' : 'program'
}

const isResolution = (name: string): name is Resolution => Object.hasOwn(RESOLUTIONS, name)
const zoomOf = (name: string) => (name === 'fit' ? null : (ZOOMS.find(([level]) => level === name)?.[1] ?? undefined))

/** A change to one monitor's view, with upstream's answer; null for an id this module does not run. */
function change(id: string, view: MonitorView, params: Params): { next: Partial<MonitorView>; answer: Params } | null {
  const rest = id.startsWith('view.') ? id.slice('view.'.length) : null
  if (rest == null) return null
  const key = ZOOM_KEY.exec(id)
  if (key) {
    const zoom = key[2] === '100' ? 1 : null
    return { next: { zoom, zoomPick: view.zoomPick + 1 }, answer: { zoom } }
  }
  const toggled = (current: boolean) => (typeof params.enabled === 'boolean' ? params.enabled : !current)
  if (rest.startsWith('playbackRes.')) {
    const res = rest.slice('playbackRes.'.length)
    return isResolution(res) ? { next: { res }, answer: { playbackRes: RESOLUTIONS[res].label } } : null
  }
  if (rest.startsWith('pausedRes.')) {
    const res = rest.slice('pausedRes.'.length)
    return isResolution(res) ? { next: { pausedRes: res }, answer: { pausedRes: RESOLUTIONS[res].label } } : null
  }
  if (rest.startsWith('magnification.')) {
    const zoom = zoomOf(rest.slice('magnification.'.length))
    return zoom === undefined ? null : { next: { zoom, zoomPick: view.zoomPick + 1 }, answer: { zoom } }
  }
  if (rest === 'highQualityPlayback') {
    const highQuality = toggled(view.highQuality)
    return { next: { highQuality }, answer: { highQuality } }
  }
  if (rest === 'safeMargins') {
    const safeMargins = toggled(view.safeMargins)
    return { next: { safeMargins }, answer: { safeMargins } }
  }
  if (rest === 'showRulers') {
    const showRulers = toggled(view.showRulers)
    return { next: { showRulers }, answer: { showRulers } }
  }
  if (rest === 'showGuides') {
    const showGuides = toggled(view.showGuides)
    return { next: { showGuides }, answer: { showGuides } }
  }
  if (rest === 'lockGuides') {
    const lockGuides = toggled(view.lockGuides)
    return { next: { lockGuides }, answer: { lockGuides } }
  }
  if (rest === 'clearGuides') return { next: { guides: [] }, answer: { cleared: view.guides.length } }
  // Add Guide with a position (without one it opens the dialog, which the editor's route does).
  if (rest === 'addGuide' && typeof params.position === 'number' && Number.isFinite(params.position)) {
    const guides = [...view.guides, { vertical: params.orientation !== 'horizontal', position: params.position }]
    return { next: { guides, showGuides: true }, answer: { guides: guides.length } }
  }
  return null
}

const DISPLAY = 'view.display.'
const SET_REFERENCE = 'view.compare.setReference'
const SNAP = 'view.snapInProgramMonitor'
/**
 * The guide commands the editor's route runs around this module: Add Guide… with no position and
 * Save Guides as Template… with no name open their dialogs, Manage Guides… opens its own, and the
 * templates (in the engine's preferences) are read and written for Save, Apply, and Delete.
 */
export const GUIDE_ROUTE: ReadonlySet<string> = new Set(['view.addGuide', 'view.guideTemplates.save', 'view.guideTemplates.manage', 'view.guideTemplates.apply', 'view.guideTemplates.delete'])

/** Whether this module (or the editor's guide route, `GUIDE_ROUTE`) runs `id` (Multi-Camera comes in wave 3). */
export function servesMonitorView(id: string) {
  if (id.startsWith(DISPLAY)) return isDisplayMode(id.slice(DISPLAY.length))
  return id === SET_REFERENCE || id === SNAP || GUIDE_ROUTE.has(id) || change(id, DEFAULT_VIEW, {}) != null
}

/** The reference `view.compare.setReference` sets: `params.time` (ticks), else `params.seconds`, else the program playhead. */
function referenceOf(params: Params, playhead: number) {
  if (typeof params.time === 'number' && Number.isFinite(params.time)) return Math.trunc(params.time)
  if (typeof params.seconds === 'number' && Number.isFinite(params.seconds)) return Math.round(params.seconds * TICKS_PER_SECOND)
  return playhead
}

/**
 * Upstream's `monitor_view::route`: the views after `id`, and its answer. Throws for an id it does
 * not run. `playhead` is the program playhead in ticks, which Comparison and Set Comparison
 * Reference take.
 */
export function monitorViewCommand(views: MonitorViews, id: string, params: Params, focused: string, playhead = 0): { views: MonitorViews; result: Params } {
  if (id.startsWith(DISPLAY)) {
    const mode = id.slice(DISPLAY.length)
    if (!isDisplayMode(mode)) throw new Error(`unknown display mode \`${mode}\``)
    return setDisplay(views, monitorOf(focused, params), mode, playhead)
  }
  if (id === SET_REFERENCE) {
    const reference = referenceOf(params, playhead)
    return { views: { ...views, program: { ...views.program, compareRef: reference } }, result: { reference } }
  }
  // Snap in Program Monitor is the Program's, whichever monitor asks (upstream answers no monitor).
  if (id === SNAP) {
    const snap = typeof params.enabled === 'boolean' ? params.enabled : !views.program.snap
    return { views: { ...views, program: { ...views.program, snap } }, result: { snap } }
  }
  const key = ZOOM_KEY.exec(id)
  const monitor: MonitorId = key ? (key[1] as MonitorId) : monitorOf(focused, params)
  const done = change(id, views[monitor], params)
  if (!done) throw new Error(`unknown view command \`${id}\``)
  // The zoom keys answer the zoom alone, as upstream's `keyboard.rs` arm.
  return { views: { ...views, [monitor]: { ...views[monitor], ...done.next } }, result: key ? done.answer : { monitor, ...done.answer } }
}

/** Upstream's `monitor_view::checked`: a `view.*` row's check mark for the focused monitor, or undefined for a row that does not toggle. */
export function monitorViewChecked(views: MonitorViews, id: string, focused: string): boolean | undefined {
  const view = views[monitorOf(focused)]
  if (id.startsWith('view.playbackRes.')) return isResolution(id.slice('view.playbackRes.'.length)) ? view.res === id.slice('view.playbackRes.'.length) : undefined
  if (id.startsWith('view.pausedRes.')) return isResolution(id.slice('view.pausedRes.'.length)) ? view.pausedRes === id.slice('view.pausedRes.'.length) : undefined
  if (id.startsWith('view.magnification.')) {
    const zoom = zoomOf(id.slice('view.magnification.'.length))
    return zoom === undefined ? undefined : view.zoom === zoom
  }
  if (id === 'view.highQualityPlayback') return view.highQuality
  if (id === 'view.safeMargins') return view.safeMargins
  if (id === 'view.showRulers') return view.showRulers
  if (id === 'view.showGuides') return view.showGuides
  if (id === 'view.lockGuides') return view.lockGuides
  if (id === SNAP) return views.program.snap
  if (id.startsWith(DISPLAY)) {
    const mode = id.slice(DISPLAY.length)
    return isDisplayMode(mode) ? displayChecked(views, mode, monitorOf(focused)) : undefined
  }
  return undefined
}

/** Upstream's `guideTemplates.apply`: the monitor takes the template's guides, shown. */
export function applyGuides(views: MonitorViews, monitor: MonitorId, guides: readonly Guide[]): MonitorViews {
  return { ...views, [monitor]: { ...views[monitor], guides: guides.map((guide) => ({ ...guide })), showGuides: true } }
}

/** `views` with `monitor`'s view changed in a way no command makes (the wrench menu's Show Transport Controls, a guide dragged). */
export function setMonitorView(views: MonitorViews, monitor: MonitorId, next: Partial<MonitorView>): MonitorViews {
  return { ...views, [monitor]: { ...views[monitor], ...next } }
}

/** `MonitorView::effective_res`: Paused Resolution when stopped; Playback Resolution while playing, or Paused with High Quality when it is higher. */
export function effectiveRes(view: MonitorView, playing: boolean): Resolution {
  return !playing || (view.highQuality && RESOLUTIONS[view.pausedRes].scale > RESOLUTIONS[view.res].scale) ? view.pausedRes : view.res
}
