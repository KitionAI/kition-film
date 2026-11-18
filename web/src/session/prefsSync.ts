/**
 * Film's user preferences across reloads, documents, and pages, as upstream's preferences file
 * keeps them (`autosave::Preferences`, saved by `Session::set_prefs`). The web engine keeps them in
 * memory, one engine per page, so:
 * - each page's engine owns them (every command that changes one goes through `set_prefs`, which
 *   moves the engine's `prefsVersion`);
 * - the kit store keeps the one persistent copy (`kit:film:prefs`: `{ prefs, stamps }`), every
 *   preference that a page changed stamped with when and by which page;
 * - after anything that may have changed them (each command, an outside refresh) a page whose
 *   engine moved its revision stamps the preferences that changed since it last synced, merges
 *   them into the stored copy, and stores it;
 * - a page opening (a reload, another document) and a page hearing another's write load the merged
 *   preferences into the engine by `loadPrefs`, which runs no command: no journal, history,
 *   replica, or preview gate, and a preview's scratch copy keeps its own.
 * Merging goes by preference (a leaf of the preferences: a value or a list), the newer stamp
 * winning, so two pages changing different preferences lose neither, and the last writer wins for
 * the same one. A page only ever writes what its own engine changed, so a page that missed
 * another's write (a load that failed) never writes the old values back. Pure but for its deps,
 * so `node --test` runs it.
 */

export type Prefs = Record<string, unknown>
/** When and by which page a preference was last changed. */
export type Stamp = { t: number; page: string }
/** The stored copy: the preferences, and the stamps of those any page changed, by `pathKey`. */
export type StoredPrefs = { prefs: Prefs; stamps: Record<string, Stamp> }

type Path = readonly string[]
/** A preference's key in `stamps`: its path as JSON (keys may hold dots). */
export const pathKey = (path: Path) => JSON.stringify(path)

const isObject = (value: unknown): value is Record<string, unknown> => value != null && typeof value === 'object' && !Array.isArray(value)

/** Whether two JSON values are the same, whatever the order of their keys. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((each, index) => sameJson(each, b[index]))
  if (!isObject(a) || !isObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}

/** The preferences (leaves: values and lists; objects are walked) that differ between `a` and `b`, added and removed ones included. */
export function leafPaths(a: unknown, b: unknown, at: string[] = []): string[][] {
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    return keys.flatMap((key) => leafPaths(a[key], b[key], [...at, key]))
  }
  if (isObject(a) !== isObject(b) && (isObject(a) || isObject(b))) {
    // An object on one side only: each of its leaves changed (the whole object when it is empty).
    const side = (isObject(a) ? a : b) as Record<string, unknown>
    const keys = Object.keys(side)
    const leaves = keys.flatMap((key) => leafPaths(isObject(a) ? a[key] : undefined, isObject(b) ? b[key] : undefined, [...at, key]))
    // An object that becomes a value (or nothing) changes at the object's own path too, so a merge sets the value there.
    return isObject(a) && b !== undefined ? [...leaves, at] : leaves.length ? leaves : [at]
  }
  return sameJson(a, b) ? [] : [at]
}

function getPath(value: unknown, path: Path): unknown {
  let at = value
  for (const key of path) {
    if (!isObject(at)) return undefined
    at = at[key]
  }
  return at
}

/** `prefs` with the preference at `path` set to `value` (removed when undefined), in place. */
function setPath(prefs: Prefs, path: Path, value: unknown) {
  if (path.length === 0) return
  let at: Record<string, unknown> = prefs
  for (const key of path.slice(0, -1)) {
    if (!isObject(at[key])) {
      if (value === undefined) return
      at[key] = {}
    }
    at = at[key] as Record<string, unknown>
  }
  const last = path[path.length - 1]
  if (value === undefined) delete at[last]
  else at[last] = structuredClone(value)
}

/** Whether stamp `a` is after `b` (the page decides a tie, so every page agrees). */
export const newer = (a: Stamp, b: Stamp) => a.t > b.t || (a.t === b.t && a.page > b.page)

/** `base` with each preference `over` stamped later (or `base` never stamped) taken from `over`. */
export function mergePrefs(base: StoredPrefs, over: StoredPrefs): StoredPrefs {
  const prefs = structuredClone(base.prefs)
  const stamps = { ...base.stamps }
  for (const [key, stamp] of Object.entries(over.stamps)) {
    const held = base.stamps[key]
    if (held && !newer(stamp, held)) continue
    setPath(prefs, JSON.parse(key) as string[], getPath(over.prefs, JSON.parse(key) as string[]))
    stamps[key] = stamp
  }
  return { prefs, stamps }
}

/**
 * One page's sync: `local` is what it last synced (null as it opens: nothing it holds is a
 * change), `engine` its engine's preferences now, `stored` the store's copy. What changed in the
 * engine since `local` is stamped `stamp` and merged over the stored copy; `load` says the engine
 * must take the result, `store` that the store must.
 */
export function reconcile(local: StoredPrefs | null, engine: Prefs, stored: StoredPrefs | null, stamp: Stamp): { next: StoredPrefs; load: boolean; store: boolean } {
  const stamps = { ...(local?.stamps ?? {}) }
  if (local) for (const path of leafPaths(local.prefs, engine)) stamps[pathKey(path)] = stamp
  const mine: StoredPrefs = { prefs: engine, stamps }
  const next = stored ? mergePrefs(stored, mine) : mine
  return { next, load: !sameJson(next.prefs, engine), store: !stored || !sameJson(next, stored) }
}

/** The store's copy as far as it can be read: anything else is no copy. */
export function parseStored(raw: unknown): StoredPrefs | null {
  const value = raw as { prefs?: unknown; stamps?: unknown } | null | undefined
  if (!isObject(value) || !isObject(value.prefs)) return null
  const stamps: Record<string, Stamp> = {}
  if (isObject(value.stamps)) {
    for (const [key, stamp] of Object.entries(value.stamps)) {
      const each = stamp as { t?: unknown; page?: unknown }
      if (typeof each?.t === 'number' && typeof each.page === 'string') stamps[key] = { t: each.t, page: each.page }
    }
  }
  return { prefs: value.prefs, stamps }
}

export type PrefsEngine = {
  /** `prefsValue`: the preferences and their revision. */
  value: () => Promise<{ version: number; values: Prefs }>
  /** `prefsVersion`. */
  version: () => Promise<number>
  /**
   * `loadPrefs(json, expected)`: loads only while the revision is still `expected`, and answers
   * whether it did and the preferences as the engine holds them after.
   */
  load: (json: string, expected: number) => Promise<{ loaded: boolean; version: number; values: Prefs }>
}

export type PrefsStore = {
  read: () => unknown
  /** Answers what `writeKitStore` does: `stored`, or why not. */
  write: (value: StoredPrefs) => string | void
  /** Another page's write (the `storage` event); the sync reads the store again rather than trusting the event's value. */
  subscribe: (listener: (raw: unknown) => void) => () => void
}

export type PrefsSyncDeps = {
  engine: PrefsEngine
  store: PrefsStore
  /** This page, in stamps. */
  page: string
  now?: () => number
  /** Waits between load tries. */
  wait?: (ms: number) => Promise<void>
  /** The engine took preferences from elsewhere (open dialogs and panels read them again). */
  onLoaded?: () => void
  /** A load that failed after its tries, or a store that would not keep them: never swallowed. */
  onError: (message: string) => void
}

/** Load tries, and the waits between them. */
const RETRIES = [0, 100, 400]
/** How many times a sync merges again when commands keep moving the preferences under its load. */
const REFUSALS = 5

/** What a store's refusal means, in words (`writeKitStore`'s answers). */
const WRITE_FAILURES: Readonly<Record<string, string>> = {
  tooLarge: 'The preferences are too large for the browser to keep; changes hold for this page only',
  unavailable: "The browser's storage is full or unavailable; preference changes hold for this page only",
}

/** One page's preferences sync, for one engine (a new document makes a new one). */
export function createPrefsSync(deps: PrefsSyncDeps) {
  const now = deps.now ?? (() => Date.now())
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  /** What this page last synced (null until a sync went through: the next one opens). */
  let local: StoredPrefs | null = null
  let version: number | null = null
  /** A load failed: the next check syncs whatever the revision says. */
  let stale = false
  let disposed = false
  let checking = false
  /** Whether the last store write was kept (a refusal is reported once, until one is kept again). */
  let writing = true
  /** The leaves the last normalizing write added, so the same ones are never written twice running. */
  let normalized = ''
  /** The latest stamp time seen anywhere, so a clock that steps back still stamps later. */
  let latest = 0
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }
  const report = (prefix: string, error: unknown) => deps.onError(`${prefix}: ${error instanceof Error ? error.message : String(error)}`)
  const stamp = (seen: StoredPrefs | null): Stamp => {
    for (const each of [...Object.values(seen?.stamps ?? {}), ...Object.values(local?.stamps ?? {})]) latest = Math.max(latest, each.t)
    latest = Math.max(now(), latest + 1)
    return { t: latest, page: deps.page }
  }
  const write = (value: StoredPrefs) => {
    const kept = deps.store.write(value)
    const ok = !kept || kept === 'stored'
    if (!ok && writing) deps.onError(WRITE_FAILURES[kept as string] ?? "The browser would not keep the preference changes; they hold for this page only")
    writing = ok
  }
  /** `loadPrefs` tried a few times; null when it kept failing (reported). */
  const load = async (prefs: Prefs, expected: number) => {
    let last: unknown = null
    for (const ms of RETRIES) {
      if (ms) await wait(ms)
      if (disposed) return null
      try {
        return await deps.engine.load(JSON.stringify(prefs), expected)
      } catch (error) {
        last = error
      }
    }
    report('Could not load the preferences', last)
    return null
  }
  /** Merges the engine's changes and the store's, stores the result, and loads it into the engine when it differs there. */
  const sync = async () => {
    if (disposed) return
    let read = await deps.engine.value()
    for (let round = 0; round <= REFUSALS && !disposed; round += 1) {
      const stored = parseStored(deps.store.read())
      const result = reconcile(local, read.values, stored, stamp(stored))
      if (result.store) write(result.next)
      if (!result.load) {
        local = result.next
        version = read.version
        stale = false
        return
      }
      const answer = await load(result.next.prefs, read.version)
      if (!answer) {
        // The engine still holds what it held: only its own changes are ever written from it.
        local = { prefs: read.values, stamps: result.next.stamps }
        version = read.version
        stale = true
        return
      }
      if (!answer.loaded) {
        // A command changed a preference after the read: merge again from the engine as it is now,
        // so that change is stamped and kept (the stamps stay this sync's, the base the old one;
        // during the open, the first read's values, so only what moved since is stamped).
        local = { prefs: local ? local.prefs : read.values, stamps: result.next.stamps }
        read = { version: answer.version, values: answer.values }
        continue
      }
      // The engine holds what it made of them (a value filled in or repaired). Leaves the store
      // lacks go to it, unstamped, so the next sync finds nothing to load again. Never a delete or
      // an overwrite: pages on engines of other versions would undo each other's repairs forever
      // (one fills a preference the other drops); an engine that drops or repairs one just loads.
      const normal: StoredPrefs = { prefs: structuredClone(result.next.prefs), stamps: result.next.stamps }
      const added: string[] = []
      for (const path of leafPaths(normal.prefs, answer.values)) {
        if (normal.stamps[pathKey(path)] || getPath(normal.prefs, path) !== undefined || getPath(answer.values, path) === undefined) continue
        setPath(normal.prefs, path, getPath(answer.values, path))
        added.push(pathKey(path))
      }
      // A backstop: the same leaves added by the sync before mean another page keeps removing them; stop.
      const addedKey = added.join('|')
      if (added.length && addedKey !== normalized) write(normal)
      normalized = addedKey
      local = { prefs: answer.values, stamps: normal.stamps }
      version = answer.version
      stale = false
      deps.onLoaded?.()
      return
    }
    // Commands kept moving the preferences: the next check merges again.
    stale = true
  }
  const run = (what: string) => serial(sync).catch((error) => report(what, error))
  // Another page wrote: merge the store as it is when this page gets to it, not the event's own
  // value, which a third page's later write may already have replaced. Queued behind an open in
  // flight, never dropped.
  const unsubscribe = deps.store.subscribe(() => {
    if (!disposed) void run('Could not load the preferences')
  })
  return {
    /** A new engine (a session opened): it takes the stored preferences, or stores its own when there are none; a failure is reported and the next check opens again. */
    open: () => run('Could not load the preferences'),
    /** After something that may have changed the preferences: syncs when the engine's revision moved (or nothing went through yet, or a load failed). */
    check: () => {
      if (checking) return queue as Promise<void>
      checking = true
      return serial(async () => {
        checking = false
        if (disposed) return
        if (local != null && !stale && (await deps.engine.version()) === version) return
        await sync()
      }).catch((error) => report('Could not keep the preferences', error))
    },
    dispose() {
      disposed = true
      unsubscribe()
    },
  }
}

export type PrefsSync = ReturnType<typeof createPrefsSync>
