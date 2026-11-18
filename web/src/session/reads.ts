/**
 * When the editor reads again what it keeps beside `inspect()` (`useFilmSession`). The session
 * state (`state.inspect`) is read on every new engine revision; a command that changes it without
 * a new revision (snapping, linked selection, targeting) reads it once more. The playheads are not
 * part of it that the editor follows there: playback moves them every frame, so their commands
 * never read it. Label colours and names are read again after a preference changes, and the key
 * table after a shortcut changes, and the Project panel's view after a command that changes it.
 * Pure, so `node --test` runs it.
 */

/** Commands that never read the session state again: the program and source playheads. */
export function skipsStateRead(command: string) {
  return command.startsWith('playhead.') || command === 'source.setPlayhead'
}

/**
 * Whether to ask the engine's preferences revision after `command` (`prefsSync.ts`): not after a
 * playhead move (playback runs them every frame) nor a drag's merged steps (`merge: true`, one per
 * frame), whose first step and release ask.
 */
export function checksPrefs(command: string, params: Record<string, unknown> = {}) {
  return !skipsStateRead(command) && params.merge !== true
}

/**
 * After each command: asks the preferences' revision at once when `checksPrefs` says so, and
 * after a drag's merged steps once they have rested `ms` (each step moves the wait on), so a drag
 * ended or cancelled with a merged step is stored too, without a worker round trip per frame.
 */
export function createPrefsCheck(check: () => void, ms: number, setTimer: (task: () => void, ms: number) => unknown, clearTimer: (id: unknown) => void) {
  let timer: unknown = null
  return (command: string, params: Record<string, unknown> = {}) => {
    if (checksPrefs(command, params)) {
      check()
      return
    }
    if (params.merge !== true || skipsStateRead(command)) return
    if (timer != null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      check()
    }, ms)
  }
}

const QUERIES = new Set(['prefs.get', 'shortcuts.list', 'shortcuts.get', 'shortcuts.conflicts'])

/**
 * Commands that change the Project panel's view (its preferences: view, columns, sort, presets)
 * and make no revision, so the panel reads its view again after them, whoever runs them.
 */
const PROJECT_VIEW = /^project\.(view\.set|columns\.(set|resize)|sort|viewPreset\.(save|saveAs|restore|rename|delete)|freeform\.options)$/
/** The preferences' category the Project panel keeps its view and presets in (`Preferences::project_panel`). */
const PANEL_PREFS = 'projectPanel'
const panelKey = (key: unknown) => typeof key === 'string' && (key === PANEL_PREFS || key.startsWith(`${PANEL_PREFS}.`))
export function changesProjectView(command: string, params: Record<string, unknown> = {}) {
  if (PROJECT_VIEW.test(command)) return true
  // prefs.set {key, value} or {values}, and prefs.reset of every category (the panel's is no category of its own).
  if (command === 'prefs.set') return panelKey(params.key) || Object.keys((params.values as Record<string, unknown> | null) ?? {}).some(panelKey)
  if (command === 'prefs.reset') return params.category === undefined
  return false
}

/** What to read again after `command` ran, the engine's revision `before` and `after` it. */
export function rereadsAfter(command: string, before: number | null, after: number | null, params: Record<string, unknown> = {}) {
  return {
    // A new revision reads the state through the revision itself.
    state: !skipsStateRead(command) && before === after,
    labels: command.startsWith('prefs.') && !QUERIES.has(command),
    keys: command.startsWith('shortcuts.') && !QUERIES.has(command),
    projectView: changesProjectView(command, params),
  }
}

/**
 * The reads after refreshes made elsewhere (the agent's `ai/run`, a collaborator's changes): one
 * per scheduled frame, however many refreshes land before it, with `viewOnly` true when any of
 * them came with no new revision (so it may have changed the Project panel's view).
 */
export function createRefreshFrame(schedule: (task: () => void) => (() => void) | void, run: (viewOnly: boolean) => void) {
  let pending = false
  let viewOnly = false
  let cancelFrame: (() => void) | void
  return {
    refresh(only: boolean) {
      viewOnly ||= only
      if (pending) return
      pending = true
      cancelFrame = schedule(() => {
        pending = false
        const was = viewOnly
        viewOnly = false
        run(was)
      })
    },
    cancel() {
      cancelFrame?.()
      cancelFrame = undefined
      pending = false
      viewOnly = false
    },
  }
}
