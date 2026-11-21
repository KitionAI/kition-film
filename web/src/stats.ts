import { useSyncExternalStore } from 'react'
import type { RasterViewportStats } from '@kition/sdk/editor'

export type FilmStats = { render: RasterViewportStats | null; fps: number | null }

/**
 * The status bar's render time and frames shown per second, kept outside React state: the canvas
 * reports every frame it draws, and only the readout that shows them renders again.
 */
export function createStatsStore() {
  let current: FilmStats = { render: null, fps: null }
  const frames: number[] = []
  const listeners = new Set<() => void>()
  const set = (next: FilmStats) => {
    current = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    /** The program canvas drew a view. */
    rendered(render: RasterViewportStats) {
      set({ ...current, render })
    },
    /** A frame was shown while a clock plays: counts it into the last second. */
    frame(now = performance.now()) {
      while (frames.length && now - frames[0] >= 1000) frames.shift()
      frames.push(now)
      set({ ...current, fps: frames.length })
    },
  }
}

export type StatsStore = ReturnType<typeof createStatsStore>

export function useStats(store: StatsStore) {
  return useSyncExternalStore(store.subscribe, store.get)
}
