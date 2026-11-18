/**
 * The Timeline's reads from the engine worker (thumbnails, peaks, its own queries), one in flight
 * for all of them: an `itemFrame` blocks the single worker for up to a quarter second mid-GOP, so
 * nothing is asked while playback runs or the playhead is scrubbed (`idle`), and a request whose
 * clip has scrolled out of view is dropped before it is sent. Pure, so `node --test` runs it.
 */

/** A cache that keeps the `max` entries used last; `onEvict` hears each entry it lets go (and each one `clear` drops). */
export function createLru<V>(max: number, onEvict?: (key: string, value: V) => void) {
  const map = new Map<string, V>()
  const drop = (key: string) => {
    if (!map.has(key)) return
    const value = map.get(key) as V
    map.delete(key)
    onEvict?.(key, value)
  }
  return {
    /** The entry, now the most recently used, or undefined. */
    get(key: string): V | undefined {
      if (!map.has(key)) return undefined
      const value = map.get(key) as V
      map.delete(key)
      map.set(key, value)
      return value
    },
    has: (key: string) => map.has(key),
    set(key: string, value: V) {
      if (map.has(key) && map.get(key) !== value) drop(key)
      map.delete(key)
      map.set(key, value)
      while (map.size > max) drop(map.keys().next().value as string)
    },
    delete: drop,
    keys: () => [...map.keys()],
    size: () => map.size,
    clear() {
      for (const key of [...map.keys()]) drop(key)
    },
  }
}

export type Lru<V> = ReturnType<typeof createLru<V>>

/**
 * A media cache keyed by `base` (what the entry shows: item, frame, width; or item, chunk) and the
 * engine revision for a sequence item (null for media). Only the newest revision of a base is
 * kept, and `show` answers it while a newer one loads, as upstream keeps the last peaks and
 * thumbnails on show until the new ones are ready.
 */
/** A cache entry's revision: the engine's (a number), a sequence's content stamp (a string), or null for media. */
export type CacheRevision = number | string | null

export function createRevisionCache<V>(max: number, onEvict?: (value: V) => void) {
  const newest = new Map<string, string>()
  const baseOf = new Map<string, string>()
  const lru = createLru<V>(max, (key, value) => {
    const base = baseOf.get(key)
    baseOf.delete(key)
    if (base != null && newest.get(base) === key) newest.delete(base)
    onEvict?.(value)
  })
  const full = (base: string, revision: CacheRevision) => `${base}@${revision ?? '-'}`
  return {
    key: full,
    /** The entry for exactly this revision, or undefined. */
    get: (base: string, revision: CacheRevision) => lru.get(full(base, revision)),
    has: (base: string, revision: CacheRevision) => lru.has(full(base, revision)),
    /** This revision's entry (`fresh`), else the newest older one while this one loads, else undefined. */
    show(base: string, revision: CacheRevision): { value: V; fresh: boolean } | undefined {
      const key = full(base, revision)
      const exact = lru.get(key)
      if (exact !== undefined) return { value: exact, fresh: true }
      const last = newest.get(base)
      const stale = last != null ? lru.get(last) : undefined
      return stale !== undefined ? { value: stale, fresh: false } : undefined
    },
    set(base: string, revision: CacheRevision, value: V) {
      const key = full(base, revision)
      const last = newest.get(base)
      if (last != null && last !== key) lru.delete(last)
      newest.set(base, key)
      baseOf.set(key, base)
      lru.set(key, value)
    },
    size: () => lru.size(),
    clear: () => lru.clear(),
  }
}

type Job = { run: (live: () => boolean) => Promise<void>; listeners: Set<() => void>; generation: number }

/**
 * Requests by key, sent one at a time in the order first asked (the clips in view ask as they are
 * drawn), only while `idle()`; call `pump` when it may have become idle. Asking for a key already
 * waiting or in flight joins it. `want` answers a cancel: a request nobody wants any more is never
 * sent (one in flight finishes, and its answer is kept). `clear` starts a new generation (another
 * document): what waits is dropped, the request in flight is forgotten, and its `run` sees
 * `live()` turn false, so it writes nothing to a cache.
 */
export function createMediaQueue({ idle }: { idle: () => boolean }) {
  const waiting = new Map<string, Job>()
  let running: { key: string; job: Job } | null = null
  let generation = 0
  const pump = () => {
    if (running || !idle()) return
    const next = waiting.entries().next()
    if (next.done) return
    const [key, job] = next.value
    waiting.delete(key)
    running = { key, job }
    const live = () => job.generation === generation
    void (async () => {
      try {
        await job.run(live)
      } catch {
        // The cache keeps what a failed read means; the queue goes on.
      }
      if (!live()) return
      running = null
      for (const listener of job.listeners) listener()
      pump()
    })()
  }
  return {
    want(key: string, run: (live: () => boolean) => Promise<void>, listener: () => void): () => void {
      const joined = running?.key === key && running.job.generation === generation ? running.job : waiting.get(key)
      const job = joined ?? { run, listeners: new Set<() => void>(), generation }
      job.listeners.add(listener)
      if (!joined) waiting.set(key, job)
      pump()
      return () => {
        job.listeners.delete(listener)
        if (!job.listeners.size && waiting.get(key) === job) waiting.delete(key)
      }
    },
    pump,
    /** Requests waiting to be sent. */
    pending: () => waiting.size,
    busy: () => running !== null,
    clear() {
      generation += 1
      waiting.clear()
      running = null
    },
  }
}

export type MediaQueue = ReturnType<typeof createMediaQueue>

/** An engine extra (`KitEngine.invoke`). */
export type EngineInvoke = (name: string, ...args: unknown[]) => Promise<unknown>
