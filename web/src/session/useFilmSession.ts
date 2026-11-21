import type { PreviewGate } from './previewGate.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RESERVED_SHORTCUTS, isMac, oneInFlight, type KitEngine, type KitEngineInfo, type KitRunOptions, type RasterRect } from '@kition/sdk/editor'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { externalCommands, keyTable, reservedKeys, type KeyTable, type ShortcutRow } from './keys.ts'
import { parseEvents, type EngineEvent } from './events.ts'
import { createPrefsCheck, createRefreshFrame, rereadsAfter, skipsStateRead } from './reads.ts'
import { sourceCommandsOf, targetedRun } from './target.ts'
import { createJobPump, type JobAnswer, type RunningJob } from './jobPump.ts'
import { createPrefsSync, type PrefsSync } from './prefsSync.ts'
import { PREFS_PAGE, kitPrefsStore } from './prefsStore.ts'

type Session = {
  doc: KitEngine | null
  /** The engine's info after the last command (its `revision` is the engine's, not kit-editor's local change counter). */
  info: KitEngineInfo | null
  /** `options.refresh` says what the editor refreshes after the command (kit-editor's `KitRefresh`). */
  run: (command: string, params?: Record<string, unknown>, damage?: RasterRect | null, options?: KitRunOptions) => Promise<string | null>
}

/** Session state the engine keeps outside `inspect()` (its `state.inspect`), which the editor shows. */
export type FilmSessionState = {
  snapping: boolean
  linkedSelection: boolean
  selectionFollowsPlayhead: boolean
  sequencesAsClips: boolean
  showThroughEdits: boolean
  /** Track targeting and source patching, as the engine keeps them. */
  targeting: Record<string, unknown>
  /** The sequences open as Timeline tabs. */
  openSequences: number[]
  /** The Source monitor's playhead, in ticks. */
  sourcePlayhead: number
  /** The selected edit points (trim mode): a clip's In or Out edge and its trim kind (`trim`, `ripple`, `roll`). */
  editPoints: Array<{ clip: number; out: boolean; kind: string }>
  /** The selected graphic's selected layers (`graphic_layers`), whose boxes the Program monitor draws. */
  graphicLayers: number[]
  /** The items selected in the Project panel (`project_selection`). */
  projectSelection: number[]
  /** The marker colours the Markers panel's filter hides (`hidden_marker_colors`), as label names (`Rose`). */
  hiddenMarkerColors: string[]
}

/** The label colours and names (`prefs.get {"key":"labels"}`), by lower-case label (`violet`). */
export type FilmLabels = {
  colors: Record<string, { color: string; name: string }>
  defaults: Record<string, string>
}

type RawState = {
  snapping?: boolean
  linked_selection?: boolean
  selection_follows_playhead?: boolean
  sequences_as_clips?: boolean
  show_through_edits?: boolean
  targeting?: Record<string, unknown>
  open_sequences?: number[]
  source_playhead?: number
  edit_points?: Array<{ clip?: number; out?: boolean; kind?: string }>
  graphic_layers?: number[]
  project_selection?: number[]
  hidden_marker_colors?: string[]
}

function sessionState(raw: RawState): FilmSessionState {
  return {
    snapping: raw.snapping ?? true,
    linkedSelection: raw.linked_selection ?? true,
    selectionFollowsPlayhead: raw.selection_follows_playhead ?? false,
    sequencesAsClips: raw.sequences_as_clips ?? false,
    showThroughEdits: raw.show_through_edits ?? false,
    targeting: raw.targeting ?? {},
    openSequences: raw.open_sequences ?? [],
    sourcePlayhead: raw.source_playhead ?? 0,
    editPoints: (raw.edit_points ?? []).map((point) => ({ clip: point.clip ?? 0, out: point.out ?? false, kind: point.kind ?? 'trim' })),
    graphicLayers: raw.graphic_layers ?? [],
    projectSelection: raw.project_selection ?? [],
    hiddenMarkerColors: raw.hidden_marker_colors ?? [],
  }
}

const NO_SHORTCUTS: readonly string[] = []

/** How long each animation frame's `jobsStep` may work on the document's background jobs, in ms. */
const JOB_STEP_MS = 10

/** Upstream's UI commands, registered with every document's shortcut set as it opens. */
const EXTERNAL = externalCommands(upstream)

async function query<T>(doc: KitEngine, id: string, params: Record<string, unknown> = {}): Promise<T> {
  return JSON.parse(await doc.execute(id, params)) as T
}

/**
 * The session the Film editor runs every command through (menus, keys, transport buttons, panels,
 * and canvas gestures), as upstream's `invoke` does: the commands the engine lists as source
 * commands get `target: "source"` while the Source monitor has focus (see `target.ts`). The agent's
 * `ai/run` calls are not aimed: they name their own target.
 *
 * It also keeps what the editor reads beside `inspect()`, one request in flight each (see
 * `reads.ts` for when): the session state (`state.inspect`), the label colours and names, and the
 * key table (`shortcuts.list` plus upstream's UI keys, without Kition's reserved keys and the
 * host's `hostShortcuts`, which reach the host).
 */
export function useFilmSession<S extends Session>(session: S, hostShortcuts: readonly string[] = NO_SHORTCUTS, onEvents?: (events: EngineEvent[]) => void, gate?: { readonly current: PreviewGate | null }, onError?: { readonly current: (message: string) => void }) {
  const onEventsNow = useRef(onEvents)
  onEventsNow.current = onEvents
  const [focused, setFocusedState] = useState('timeline')
  const focusedNow = useRef(focused)
  const setFocused = useCallback((panel: string) => {
    focusedNow.current = panel
    setFocusedState(panel)
  }, [])
  // The user preferences (`prefsSync.ts`): each session (new, open, replace, reopen) takes the
  // stored ones before the editor sees its document, so no panel reads the engine's defaults; the
  // engine's changes are stored after each command and outside refresh, and another page's arrive.
  const opened = session.doc
  const [prefsReady, setPrefsReady] = useState<KitEngine | null>(null)
  const prefs = useRef<PrefsSync | null>(null)
  const onErrorNow = useRef(onError)
  onErrorNow.current = onError
  const prefsLoaded = useRef<() => void>(() => undefined)
  useEffect(() => {
    if (!opened) {
      setPrefsReady(null)
      return undefined
    }
    const sync = createPrefsSync({
      engine: {
        value: async () => JSON.parse(await opened.invoke<string>('prefsValue')) as { version: number; values: Record<string, unknown> },
        version: () => opened.invoke<number>('prefsVersion'),
        load: async (json, expected) => JSON.parse(await opened.invoke<string>('loadPrefs', json, expected)) as { loaded: boolean; version: number; values: Record<string, unknown> },
      },
      store: kitPrefsStore(),
      page: PREFS_PAGE,
      onLoaded: () => prefsLoaded.current(),
      onError: (message) => onErrorNow.current?.current(message),
    })
    prefs.current = sync
    let live = true
    void sync
      .open()
      .catch((error: unknown) => onErrorNow.current?.current(`Could not load the preferences: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (live) setPrefsReady(opened)
      })
    return () => {
      live = false
      sync.dispose()
      if (prefs.current === sync) prefs.current = null
    }
  }, [opened])
  const checkPrefs = useCallback(() => {
    void prefs.current?.check().catch((error: unknown) => onErrorNow.current?.current(`Could not keep the preferences: ${error instanceof Error ? error.message : String(error)}`))
  }, [])
  const prefsAfter = useMemo(() => createPrefsCheck(checkPrefs, 250, (task, ms) => window.setTimeout(task, ms), (id) => window.clearTimeout(id as number)), [checkPrefs])
  const doc = prefsReady === opened ? opened : null
  const docNow = useRef(doc)
  docNow.current = doc

  // The source commands are the engine's, fixed for its build: asked once per document.
  const sources = useMemo(() => (doc ? sourceCommandsOf(doc) : Promise.resolve(new Set<string>() as ReadonlySet<string>)), [doc])
  const sourcesNow = useRef(sources)
  sourcesNow.current = sources

  const [filmState, setFilmState] = useState<FilmSessionState | null>(null)
  const [labels, setLabels] = useState<FilmLabels | null>(null)
  const reserved = useMemo(() => [...RESERVED_SHORTCUTS, ...hostShortcuts], [hostShortcuts])
  // The keys the editor never takes, which the menus and Help ▸ Keyboard Shortcuts do not show either.
  const isReserved = useMemo(() => reservedKeys(reserved, isMac()), [reserved])
  const reservedNow = useRef(reserved)
  reservedNow.current = reserved
  const [keys, setKeys] = useState<KeyTable>(() => keyTable([], upstream, isMac(), reserved))
  // The engine's live shortcut set (`shortcuts.list`), which the menus show; null until read.
  const [shortcuts, setShortcuts] = useState<ShortcutRow[] | null>(null)
  // Moves when the Project panel's view may have changed with no revision (its preferences: a
  // view, column, sort, or preset command of the editor's own, or a refresh made elsewhere, such
  // as the agent's `ai/run`), so the panel reads it again.
  const [projectView, setProjectView] = useState(0)
  const shownState = useRef('')

  const readers = useMemo(
    () => ({
      state: oneInFlight(async () => {
        const open = docNow.current
        if (!open) return
        const raw = await query<RawState>(open, 'state.inspect')
        const next = sessionState(raw)
        const text = JSON.stringify(next)
        // Unchanged state keeps its object, so nothing redraws.
        if (docNow.current === open && text !== shownState.current) {
          shownState.current = text
          setFilmState(next)
        }
      }),
      labels: oneInFlight(async () => {
        const open = docNow.current
        if (!open) return
        const raw = await query<{ colors?: FilmLabels['colors']; defaults?: FilmLabels['defaults'] }>(open, 'prefs.get', { key: 'labels' })
        if (docNow.current === open) setLabels({ colors: raw.colors ?? {}, defaults: raw.defaults ?? {} })
      }),
      // The engine's events (toasts, the panels to show), drained after every refresh, whoever ran the command.
      events: oneInFlight(async () => {
        const open = docNow.current
        if (!open) return
        const events = parseEvents(await open.invoke<string>('takeEvents').catch(() => '[]'))
        if (docNow.current === open && events.length > 0) onEventsNow.current?.(events)
      }),
      keys: oneInFlight(async () => {
        const open = docNow.current
        if (!open) return
        const rows = await query<ShortcutRow[]>(open, 'shortcuts.list')
        if (docNow.current === open) {
          setKeys(keyTable(rows, upstream, isMac(), reservedNow.current))
          setShortcuts(rows)
        }
      }),
    }),
    [],
  )

  // Preferences another page changed (or a session's stored ones) are in the engine: the views, the
  // labels, and the open dialogs that show preferences read them again (the dialogs' `viewRefresh`).
  prefsLoaded.current = () => {
    setProjectView((tick) => tick + 1)
    void readers.labels()
  }

  // The document's background jobs (a host without threads steps Scene Edit Detection): advanced
  // each animation frame while work is left, after any command or refresh, as upstream's frame
  // loop polls them; the running job shows in the status bar, and a result that moved the
  // revision refreshes the editor once (its replica step is the engine's, `poll_persistence`).
  const [job, setJob] = useState<RunningJob | null>(null)
  const shownJob = useRef('null')
  const baseRunNow = useRef(session.run)
  baseRunNow.current = session.run
  const jobs = useMemo(
    () =>
      createJobPump({
        step: async () => {
          const open = docNow.current
          if (!open) return null
          return JSON.parse(await open.invoke<string>('jobsStep', JOB_STEP_MS)) as JobAnswer
        },
        schedule: (task) => {
          const id = requestAnimationFrame(() => task())
          return () => cancelAnimationFrame(id)
        },
        revision: () => docNow.current?.info.revision ?? null,
        onJob: (running) => {
          const text = JSON.stringify(running)
          if (text === shownJob.current) return
          shownJob.current = text
          setJob(running)
        },
        // A query refreshes the editor's info (the revision, the replica's version for the host).
        onChanged: () => void baseRunNow.current('jobs.list', {}).catch(() => undefined),
      }),
    [],
  )
  useEffect(() => {
    jobs.reset()
    if (doc) jobs.kick()
    return () => jobs.reset()
  }, [doc, jobs])
  const cancelJob = useCallback((id: number) => void docNow.current?.invoke('cancelJob', id).catch(() => undefined), [])

  // Another document starts from nothing: the last one's state is not shown for it.
  useEffect(() => {
    shownState.current = ''
    setFilmState(null)
    setLabels(null)
    setShortcuts(null)
    if (!doc) return
    void readers.labels()
    // Upstream registers its UI commands with the shortcut set at startup (`register_external`):
    // the panel tables then bind them (the Project panel's arrows, I, O), and the keys are read after.
    void doc
      .execute('shortcuts.registerExternal', { commands: EXTERNAL })
      .catch(() => undefined)
      .then(() => readers.keys())
  }, [doc, readers])
  // The engine's own revision, not kit-editor's change counter, which moves on every command.
  const revision = session.info?.revision ?? null
  useEffect(() => {
    if (doc) void readers.state()
  }, [doc, readers, revision])
  useEffect(() => {
    if (doc) void readers.keys()
  }, [doc, readers, reserved])
  // A refresh the editor's own commands did not make (the agent's `ai/run`, a collaborator's
  // changes) drains the engine's events and reads the session state again, as a command may
  // change it without a new revision (the agent's `project.select`): the editor's own commands
  // do both in `run`.
  const ownInfos = useRef(new WeakSet<object>())
  const info = session.info
  // The reads after refreshes made elsewhere wait for the next animation frame, so an agent's
  // steps that land in one frame read once (the editor's own commands drain the events in `run`).
  // A refresh with no new revision may have changed the Project panel's view (an agent's
  // project.view.set): the frame keeps that, whichever of its refreshes it came with.
  const readsNow = useRef({ readers, jobs, checkPrefs })
  readsNow.current = { readers, jobs, checkPrefs }
  const foreign = useMemo(
    () =>
      createRefreshFrame(
        (task) => {
          const id = requestAnimationFrame(task)
          return () => cancelAnimationFrame(id)
        },
        (viewOnly) => {
          // A new revision reads the panel again through the revision itself.
          if (viewOnly) setProjectView((tick) => tick + 1)
          // An agent's step may have changed a preference.
          readsNow.current.checkPrefs()
          void readsNow.current.readers.state()
          void readsNow.current.readers.events()
          readsNow.current.jobs.kick()
        },
      ),
    [],
  )
  // The revision the last refresh showed.
  const infoRevision = useRef<number | null>(null)
  useEffect(() => {
    const before = infoRevision.current
    infoRevision.current = info?.revision ?? null
    if (!doc || !info || ownInfos.current.has(info)) return
    foreign.refresh(before === info.revision)
  }, [doc, info, foreign])
  useEffect(() => () => foreign.cancel(), [doc, foreign])

  // Stable, as the session's own `run` is: callers keep it across documents.
  const baseRun = session.run
  const run = useMemo(() => {
    const reading: typeof baseRun = async (command, params, damage, options) => {
      // While a dialog's preview is open the document is not editable (`previewGate.ts`).
      const refused = gate?.current?.refusal(command)
      if (refused) throw new Error(refused)
      const before = docNow.current?.info.revision ?? null
      try {
        return await baseRun(command, params, damage, options)
      } finally {
        const after = docNow.current?.info
        if (after) ownInfos.current.add(after)
        // Every command but the playheads' (which playback runs each frame, and which raise no
        // event) drains the engine's events here, whatever it refreshes: a 'repaint' or 'none'
        // command's toast shows too.
        // Any command may have changed a preference (every change moves the engine's prefsVersion);
        // a drag asks on its first step and once it has rested.
        prefsAfter(command, (params ?? {}) as Record<string, unknown>)
        if (!skipsStateRead(command)) {
          void readers.events()
          // A command may have started a background job (Scene Edit Detection's Analyze).
          jobs.kick()
        }
        const again = rereadsAfter(command, before, after?.revision ?? null, (params ?? {}) as Record<string, unknown>)
        if (again.state) void readers.state()
        if (again.labels) void readers.labels()
        if (again.keys) void readers.keys()
        if (again.projectView) setProjectView((tick) => tick + 1)
      }
    }
    return targetedRun(reading, () => sourcesNow.current, () => focusedNow.current)
  }, [baseRun, readers, gate, jobs, prefsAfter])
  // The editor sees the session once its preferences are in (the same object while they load is
  // a session with no document yet).
  const targeted = (doc ? { ...session, run } : { ...session, doc: null, info: null, state: null, run }) as S
  return { session: targeted, focused, setFocused, focusedNow, filmState, labels, keys, shortcuts, isReserved, job, cancelJob, projectView, checkPrefs }
}
