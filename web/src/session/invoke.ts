// Imports carry `.ts` and the JSON its import attribute so `node --test` loads this module as it is.
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { TICKS_PER_SECOND } from '../film.ts'
import { targetsSource } from './target.ts'
import { frameTicks, rateOf, snapTicks } from '../monitors/model.ts'
import { DIALOGS } from '../dialogs/registry.ts'

type Params = Record<string, unknown>

/**
 * How `invoke` runs a command: what the editor refreshes after a session command (kit-editor's
 * `KitRunOptions`, all of it by default); `direct` runs a dialog's command at once even with no
 * params (the dialog's own OK); `throws` hands a failure to the caller (a dialog shows it) in place
 * of the status bar; `dialog` opens a dialog command's dialog with `params` as its starting values
 * (kit-editor's `ask`).
 */
export type InvokeOptions = { refresh?: 'all' | 'repaint' | 'none'; direct?: boolean; throws?: boolean; dialog?: boolean }

/** Where `invoke` sends a command: the part of the editor that owns it, or the engine session. */
export type InvokeRoute = 'tool' | 'workspace' | 'playback' | 'timelineView' | 'monitorView' | 'projectPanel' | 'program' | 'sourceStep' | 'dialog' | 'fileDialog' | 'unavailable' | 'session'

/** Upstream's own UI commands (`menus.rs` `UI_COMMANDS`, `keyboard::COMMANDS`, the Window panel rows): never engine commands. */
export const UI_COMMANDS: ReadonlySet<string> = new Set([
  ...upstream.menus.filter((row) => row.origin !== 'engine').map((row) => row.command),
  ...upstream.keys.filter((key) => key.origin === 'ui').map((key) => key.command),
])

/** `Tool::from_name`'s folding: lower case, without spaces, `_`, `-`, or the word "tool". */
const toolKey = (name: string) => name.toLowerCase().replace(/[\s_-]/g, '').replace(/tool/g, '')

/**
 * Upstream's `Tool::from_name`: the tool (its manifest id, `Razor`) a name means, matched without
 * case by id or by label (`razor`, `Razor Tool`, `rectangle`), or null. All 17 tools, so the Pen
 * flyout's Rectangle and Ellipse, which have no `tool.*` command, can be chosen too.
 */
export function toolFromName(name: string): string | null {
  const key = toolKey(name)
  return upstream.tools.find((tool) => toolKey(tool.id) === key || toolKey(tool.label) === key)?.id ?? null
}

const WORKSPACE_PREFIXES = ['window.panel.', 'window.workspace.', 'mode.']
const WORKSPACE_IDS = new Set(['window.maximizeFrame', 'window.maximizeFrameUnderCursor', 'window.nextPanel', 'window.prevPanel', 'window.toggleMonitorFocus', 'window.openSearch', 'panel.selectFindBox'])
const TIMELINE_VIEW_IDS = new Set([
  'view.zoomIn',
  'view.zoomOut',
  'view.zoomToSequence',
  'timeline.expandAllTracks',
  'timeline.minimizeAllTracks',
  'timeline.increaseVideoHeight',
  'timeline.decreaseVideoHeight',
  'timeline.increaseAudioHeight',
  'timeline.decreaseAudioHeight',
  'timeline.nextScreen',
  'timeline.prevScreen',
  'view.dynamicAudioWaveforms',
])
const MONITOR_VIEW_PREFIXES = ['view.playbackRes.', 'view.pausedRes.', 'view.magnification.', 'view.programZoom', 'view.sourceZoom', 'view.display.', 'view.guideTemplates.']
const MONITOR_VIEW_IDS = new Set(['view.highQualityPlayback', 'view.safeMargins', 'view.compare.setReference', 'view.showRulers', 'view.showGuides', 'view.lockGuides', 'view.clearGuides', 'view.addGuide', 'view.snapInProgramMonitor'])
const SOURCE_STEPS = new Set(['playhead.stepBack', 'playhead.stepForward', 'playhead.stepBack5', 'playhead.stepForward5'])
const SOURCE_MARK_EDITS = new Set(['marker.markIn', 'marker.markOut', 'marker.clearIn', 'marker.clearOut', 'marker.clearInOut'])
/** The Program monitor's own UI commands (`keyboard.rs`): Begin Text Editing for a Graphic Layer. */
const PROGRAM_IDS = new Set(['graphics.beginTextEditing'])
/** Upstream's About and Keyboard Shortcuts, and Kition's Help rows for them (`kit:help.about`, `kit:help.shortcuts`). */
const DIALOG_IDS = new Set(['app.about', 'app.keyboardShortcuts', 'help.shortcuts', 'help.about'])
/**
 * Upstream's file dialogs (`menus.rs` `invoke`, `lib.rs` `file_dialog`, `menu_dialogs.rs` and
 * `media_dialogs.rs` `route`) that Kition serves: File ▸ Import with no `paths` or `path` picks
 * media through the host, File ▸ Get Media File Properties for ▸ File… with no `path` picks one
 * and shows its Properties, File ▸ Export ▸ Media with no `path` runs Kition's stepped MP4 export,
 * and Clip ▸ Proxy ▸ Attach Proxies… and Reconnect Full Resolution Media… with no `path` pick a
 * video file for the Project selection's item. Each id with the parameters that skip the dialog.
 */
const FILE_DIALOGS: Readonly<Record<string, readonly string[]>> = {
  'file.import': ['paths', 'path'],
  'file.mediaPropertiesFile': ['path'],
  'file.exportMedia': ['path'],
  'media.attachProxies': ['path', 'paths'],
  'media.reconnectFullRes': ['path'],
}

/** The route of `id` with `params`, the Source monitor targeted or not by `focused` (upstream `invoke`'s order). */
export function routeOf(id: string, params: Params, focused: string): InvokeRoute {
  if (id.startsWith('tool.')) return 'tool'
  if (WORKSPACE_IDS.has(id) || WORKSPACE_PREFIXES.some((prefix) => id.startsWith(prefix))) return 'workspace'
  if (id.startsWith('playback.') || id.startsWith('source.playback.')) return 'playback'
  // Source absolute navigation must move the playback clock and its seek queue too.
  // An explicit target takes precedence; leave Program and invalid targets to the engine.
  if ((id === 'marker.goToIn' || id === 'marker.goToOut') &&
    (params.target === 'source' || (params.target === undefined && targetsSource(focused, params)))) return 'playback'
  if (TIMELINE_VIEW_IDS.has(id)) return 'timelineView'
  if (MONITOR_VIEW_IDS.has(id) || MONITOR_VIEW_PREFIXES.some((prefix) => id.startsWith(prefix))) return 'monitorView'
  // Upstream's `project.rs` `route` opens the panel's dialogs (Metadata Display…, the view presets) from its own commands.
  if (id.startsWith('projectPanel.')) return DIALOGS.opens(id, params) ? 'dialog' : 'projectPanel'
  // Clip ▸ Rename… without a name starts the Project panel's inline rename (upstream's
  // `project.rs` `start_rename`), whose Enter runs `clip.rename` with the name typed.
  if (id === 'clip.rename' && params.name === undefined) return 'projectPanel'
  if (PROGRAM_IDS.has(id)) return 'program'
  if (SOURCE_STEPS.has(id) && targetsSource(focused, params)) return 'sourceStep'
  // Upstream's routes: a dialog command called with no params opens its dialog; with params it runs at once.
  if (DIALOG_IDS.has(id) || DIALOGS.opens(id, params)) return 'dialog'
  if (Object.hasOwn(FILE_DIALOGS, id) && FILE_DIALOGS[id].every((key) => params[key] === undefined)) return 'fileDialog'
  if (UI_COMMANDS.has(id)) return 'unavailable'
  return 'session'
}

/**
 * A part of the editor that serves a route: it runs `id` or throws why not. Its own `serves`, when
 * it has one, names the ids of the route it runs; the others are not served yet.
 */
export type RouteHandler = ((id: string, params: Params) => unknown) & { serves?: (id: string) => boolean }

export type InvokeHandlers = {
  /** The targeted session's `run` (`useFilmSession`), with what the editor refreshes after it. */
  run: (id: string, params: Params, options?: InvokeOptions) => Promise<unknown>
  /** A read-only engine query, answered as parsed JSON. */
  query: (id: string, params?: Params) => Promise<unknown>
  /** The focused panel, read at each call. */
  focused: () => string
  /** Stable token for the current document/project/Source item; replaced even on a return to the same item. */
  sourceContext: () => unknown
  /** Waits for this Source's queued scrubs/clock seeks before reading a relative step's origin. */
  settleSource: () => Promise<void>
  /** Intended Source frame at the gesture, or undefined when the engine cursor is current. */
  sourceMarkTime: () => number | undefined
  /** Shows a message in the status bar (upstream's `app.ui.status`). */
  status: (message: string) => void
  /** Chooses the tool, by its manifest id (`tool.razor` → `Razor`): false when the editor refuses it (the host denies it). */
  tool: (tool: string) => boolean
  workspace?: RouteHandler
  playback?: RouteHandler
  timelineView?: RouteHandler
  monitorView?: RouteHandler
  projectPanel?: RouteHandler
  /** The Program monitor's UI commands (`PROGRAM_IDS`). */
  program?: RouteHandler
  dialog?: RouteHandler
  /** File ▸ Import, Get Media File Properties for ▸ File…, Export ▸ Media, Attach Proxies…, and Reconnect Full Resolution Media… without a path (`FILE_DIALOGS`). */
  fileDialog?: RouteHandler
  /** What the status bar says for a command no part of the editor serves yet. */
  unavailable?: string
}

type SourceView = { item?: number | null; fps?: number; playhead?: number; start?: number; end?: number }

/** Upstream's `playhead.step*` arm for the Source monitor: stop the source clock, then move the source playhead one frame, or the "step many" count. */
async function stepSource(id: string, handlers: InvokeHandlers, current: () => boolean) {
  if (!current()) return null
  try {
    await handlers.playback?.('source.playback.stop', {})
  } catch {
    // Nothing plays.
  }
  if (!current()) return null
  await handlers.settleSource()
  if (!current()) return null
  const view = (await handlers.query('source.inspect')) as SourceView | null
  if (!current()) return null
  if (view?.item == null) throw new Error('Open a Source clip first')
  const fps = view.fps ?? 0
  if (!(fps > 0)) throw new Error('Source clip is unavailable')
  const many = id.endsWith('5') ? Number(((await handlers.query('prefs.get', { key: 'playback' })) as { stepManyFrames?: number } | null)?.stepManyFrames ?? 5) : 1
  if (!current()) return null
  const direction = id.includes('Back') ? -1 : 1
  const frame = Math.round(((view.playhead ?? 0) / TICKS_PER_SECOND) * fps) + many * direction
  return handlers.run('source.setPlayhead', { frame })
}

const HANDLED: ReadonlySet<InvokeRoute> = new Set(['workspace', 'playback', 'timelineView', 'monitorView', 'projectPanel', 'program', 'dialog', 'fileDialog'])

/**
 * Film's single entry point, as upstream's `menus.rs` `invoke`: menus, keys, and transport buttons
 * call it. It answers the command's result, or null after showing why it failed in the status bar
 * (never a toast). `invoke.serves(id)` says whether some part of the editor runs `id` now: a key
 * whose command nothing serves is left to the browser and the operating system.
 */
export function createInvoke(handlers: InvokeHandlers) {
  const unavailable = handlers.unavailable ?? 'Not available in this editor yet'
  const serve = (handler: RouteHandler | undefined, id: string, params: Params) => {
    if (!handler || handler.serves?.(id) === false) throw new Error(unavailable)
    return handler(id, params)
  }
  // Source steps run one after another, each from the playhead the last one set, so fast presses keep every step.
  let sourceSteps: Promise<unknown> = Promise.resolve()
  let sourceStepsContext: unknown
  let sourceMarks: Promise<unknown> | null = null
  let sourceMarksContext: unknown
  // Gestures released but still sending their step (a Motion box drag's last Anchor Point and
  // Position), and the Undo or Redo waiting for them: history pressed then takes back the whole
  // step, never a part of it with the rest sent after.
  const gestures = new Set<Promise<unknown>>()
  let history: Promise<unknown> | null = null
  /** Keeps history (Undo, Redo) asked for from now until `closed` settles behind the gesture's step. */
  function gesture(closed: Promise<unknown>) {
    gestures.add(closed)
    const done = () => {
      gestures.delete(closed)
    }
    closed.then(done, done)
  }
  async function invoke(id: string, params: Params = {}, options?: InvokeOptions): Promise<unknown> {
    try {
      const routed = routeOf(id, params, handlers.focused())
      // A dialog's OK runs its command, whatever its params.
      const route = options?.dialog && DIALOGS.has(id) ? 'dialog' : options?.direct && routed === 'dialog' && !DIALOG_IDS.has(id) ? 'session' : routed
      switch (route) {
        case 'tool': {
          const tool = toolFromName(id.slice('tool.'.length))
          if (!tool) throw new Error(`unknown tool \`${id.slice('tool.'.length)}\``)
          if (handlers.tool(tool) === false) throw new Error(unavailable)
          return { tool }
        }
        case 'sourceStep': {
          // Capture before enqueueing: keys waiting behind a slow read still belong to
          // the Source that received them, not the one open when the queue resumes.
          const context = handlers.sourceContext()
          if (sourceStepsContext !== context) {
            sourceStepsContext = context
            // An obsolete slow read must not block keys in the new Source. Its old
            // queue keeps the context checks above and drains without seeking.
            sourceSteps = Promise.resolve()
          }
          const step = sourceSteps.catch(() => undefined).then(() => stepSource(id, handlers, () => handlers.sourceContext() === context))
          sourceSteps = step
          return await step
        }
        case 'unavailable':
          throw new Error(unavailable)
        case 'session': {
          const sourceEdit = SOURCE_MARK_EDITS.has(id) &&
            (params.target === 'source' || (params.target === undefined && targetsSource(handlers.focused(), params)))
          // History requested behind pending Source edits belongs to that same gesture queue.
          // Otherwise Undo can consume the previous edit before the mark is even committed.
          const queuedHistory = (id === 'edit.undo' || id === 'edit.redo') && sourceMarks !== null && sourceMarksContext === handlers.sourceContext()
          if (sourceEdit || queuedHistory) {
            const context = handlers.sourceContext()
            const implicit = (id === 'marker.markIn' || id === 'marker.markOut') && params.time === undefined
            const time = implicit ? handlers.sourceMarkTime() : undefined
            const markedParams: Params = sourceEdit ? { ...params, target: 'source' } : { ...params }
            if (sourceMarksContext !== context) {
              sourceMarksContext = context
              sourceMarks = null
            }
            // Capture the native cursor/bounds now, even if an earlier mark is still waiting.
            // Handle rejection immediately; each queued mark reports its own failure in order.
            const read = implicit ? handlers.query('source.inspect').then(
              view => ({ view: view as SourceView | null }), error => ({ error }),
            ) : null
            // Clear, explicit marks and history share the queue. Context replacement
            // cancels the pending gesture, including its queued Undo/Redo, as a whole.
            const mark = (sourceMarks ?? Promise.resolve()).catch(() => undefined).then(async () => {
              if (context !== handlers.sourceContext()) return null
              if (read) {
                const answer = await read
                if (context !== handlers.sourceContext()) return null
                if ('error' in answer) throw answer.error
                const view = answer.view
                if (view?.item == null) throw new Error('Open a Source clip first')
                const rate = rateOf(view.fps ?? 30)
                const start = view.start ?? 0
                const last = Math.max(start, (view.end ?? start) - frameTicks(rate))
                // Match source.setPlayhead: clamp to the clip, snap down, then respect its In.
                markedParams.time = time === undefined ? view.playhead ?? 0 : Math.max(start, snapTicks(rate, Math.min(Math.max(Math.round(time), start), last)))
              }
              return options?.refresh
                ? handlers.run(id, markedParams, { refresh: options.refresh })
                : handlers.run(id, markedParams)
            })
            sourceMarks = mark
            // Only pending work delays history. A completed Source edit must not bind
            // future global Undo/Redo to the Source that happened to create it.
            const settled = () => { if (sourceMarks === mark) sourceMarks = null }
            void mark.then(settled, settled)
            return await mark
          }
          // History behind a released gesture still sending its step waits for it (in turn with
          // any history already waiting), so one Undo takes back the whole gesture.
          if ((id === 'edit.undo' || id === 'edit.redo') && (gestures.size > 0 || history !== null)) {
            const open = [...gestures]
            const turn = (history ?? Promise.resolve())
              .catch(() => undefined)
              .then(() => Promise.allSettled(open))
              .then(() => (options?.refresh ? handlers.run(id, params, { refresh: options.refresh }) : handlers.run(id, params)))
            history = turn
            const settled = () => {
              if (history === turn) history = null
            }
            void turn.then(settled, settled)
            return await turn
          }
          return await (options?.refresh ? handlers.run(id, params, { refresh: options.refresh }) : handlers.run(id, params))
        }
        default:
          return await serve(handlers[route], id, params)
      }
    } catch (error) {
      if (options?.throws) throw error
      handlers.status(error instanceof Error ? error.message : String(error))
      return null
    }
  }
  /** Whether some part of the editor runs `id` with `params` now. */
  function serves(id: string, params: Params = {}) {
    const route = routeOf(id, params, handlers.focused())
    if (route === 'unavailable') return false
    if (!HANDLED.has(route)) return true
    const handler = handlers[route as keyof InvokeHandlers] as RouteHandler | undefined
    return handler != null && handler.serves?.(id) !== false
  }
  return Object.assign(invoke, { serves, gesture })
}

export type Invoke = ReturnType<typeof createInvoke>
