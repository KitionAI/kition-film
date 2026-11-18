import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Playback } from '../session/playback'
import { sourceViewOf, type SourceView } from './model.ts'

type Query = (id: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * The Source monitor's clip (`source.inspect`: its span, marks, markers, size, and streams), read
 * again per engine revision or externally changed source playhead. The read that moves the source clock's resting playhead
 * (`readSource`) is the same one, so one `source.inspect` per revision; while the clock plays it
 * reads nothing, and the hook asks itself. Only the shown Source panel calls it (rule 8).
 */
export function useSourceView(query: Query, playback: Playback, item: number | null, revision: number | null, sourcePlayhead: number | null): SourceView | null {
  const [view, setView] = useState<SourceView | null>(null)
  useEffect(() => {
    if (item == null) {
      setView(null)
      return undefined
    }
    let current = true
    void (async () => {
      const read = await playback.readSource()
      const raw = read === undefined ? await query('source.inspect') : read
      if (current) setView(sourceViewOf(raw))
    })().catch(() => undefined)
    return () => {
      current = false
    }
  }, [query, playback, item, revision, sourcePlayhead])
  return view
}

/**
 * Preferences ▸ Media ▸ Enable proxies, which the monitors' Toggle Proxies shows: one
 * `prefs.get` per engine revision (Toggle Proxies moves it) for every monitor that shows it, and
 * none while no monitor does.
 */
export function createProxiesRead(query: () => Query) {
  let value = false
  let readFor: number | null | undefined
  let generation = 0
  let users = 0
  const listeners = new Set<() => void>()
  const read = (revision: number | null) => {
    if (users === 0 || readFor === revision) return
    readFor = revision
    const asked = ++generation
    void query()('prefs.get', { key: 'media' })
      .then((media) => {
        // A slow read must not replace a newer toggle's state in either monitor.
        if (asked !== generation) return
        const next = (media as { enableProxies?: boolean } | null)?.enableProxies === true
        if (next === value) return
        value = next
        for (const listener of listeners) listener()
      })
      .catch(() => {
        if (asked === generation) readFor = undefined
      })
  }
  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    /** A shown monitor uses the value at `revision` until the returned release. */
    use(revision: number | null) {
      users += 1
      read(revision)
      return () => {
        users -= 1
      }
    },
  }
}

export type ProxiesRead = ReturnType<typeof createProxiesRead>

/** Whether proxies are on, read while `enabled` (a monitor with its picture, not a placeholder). */
export function useProxies(store: ProxiesRead, revision: number | null, enabled: boolean) {
  useEffect(() => (enabled ? store.use(revision) : undefined), [store, revision, enabled])
  const value = useSyncExternalStore(store.subscribe, store.get)
  return useMemo(() => enabled && value, [enabled, value])
}
