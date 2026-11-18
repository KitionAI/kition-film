// Imports carry `.ts` so `node --test` loads this module as it is.
import { parseTemplates, sameTemplates, type GuideTemplate } from './guideModel.ts'

type Prefs = Record<string, unknown>

export type GuideTemplateDeps = {
  /** The engine's preferences and their revision (`prefsValue`). */
  read: () => Promise<{ version: number; values: Prefs }>
  /**
   * Sets the engine's preferences while their revision is still `expected` (`loadPrefs(json,
   * expected)`), answering whether it did and the preferences as they are after.
   */
  write: (values: Prefs, expected: number) => Promise<{ loaded: boolean; version: number; values: Prefs }>
  /** The preferences changed: the preferences sync stores them (`prefsSync.ts` `check`). */
  changed: () => void
}

/** How many times a change reads again when the preferences keep moving under its write. */
const TRIES = 5

const templatesOf = (values: Prefs) => parseTemplates((values.guides as { templates?: unknown } | undefined)?.templates)

/**
 * Guide templates, as upstream keeps them: in the engine's preferences (`prefs.guides.templates`),
 * which Save, Apply, Delete, and Manage read and write. A change reads the preferences and writes
 * them back with the new list in one conditional step: only while the revision is the one it read,
 * so another page's preferences loaded in between (`prefsSync.ts`) are never written over; it then
 * reads again and retries. The preferences reach the other pages and the next session as every
 * preference does; this keeps the list the dialogs show, read again when the preferences may have
 * changed (`refresh`). Changes run one at a time.
 */
export function createGuideTemplates(deps: GuideTemplateDeps) {
  let shown: GuideTemplate[] = []
  const listeners = new Set<() => void>()
  let queue: Promise<unknown> = Promise.resolve()
  const tell = (next: GuideTemplate[]) => {
    if (sameTemplates(shown, next)) return
    shown = next
    for (const listener of [...listeners]) listener()
  }
  /** Runs `task` after every change before it; its failure reaches its caller alone. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }
  return {
    /** The templates as last read. */
    list: () => shown,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    /** Reads the engine's templates again (another page, an agent, or a new session may have changed them). */
    refresh: () =>
      serial(async () => {
        const live = templatesOf((await deps.read()).values)
        tell(live)
        return live
      }),
    /** Changes the templates: `change` gets the engine's as they are now; the result is set in the engine. */
    change: (change: (templates: GuideTemplate[]) => GuideTemplate[]) =>
      serial(async () => {
        let read = await deps.read()
        for (let attempt = 0; attempt < TRIES; attempt += 1) {
          const current = templatesOf(read.values)
          const next = change(current)
          if (sameTemplates(current, next)) {
            tell(current)
            return current
          }
          const values = { ...read.values, guides: { ...((read.values.guides as Prefs | undefined) ?? {}), templates: next } }
          const answer = await deps.write(values, read.version)
          if (answer.loaded) {
            tell(next)
            deps.changed()
            return next
          }
          read = { version: answer.version, values: answer.values }
        }
        throw new Error('the preferences kept changing; try again')
      }),
    dispose() {
      listeners.clear()
    },
  }
}

export type GuideTemplates = ReturnType<typeof createGuideTemplates>
