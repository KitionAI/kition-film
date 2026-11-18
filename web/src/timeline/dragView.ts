import { useSyncExternalStore } from 'react'
import type { Previewed } from './gestures.ts'

/** A bracket on a clip edge: what a press there would trim (upstream `paint_hover_bracket`). */
export type Bracket = { x: number; top: number; height: number; out: boolean; ripple: boolean }

/**
 * What the Timeline draws for a gesture, outside the engine: the clips a drag moves or resizes
 * (ticks), the snap indicator, the marquee, the hover feedback (the razor line, the edge
 * brackets), and a drop's preview. x is from the left of the track content, y from the panel's top.
 */
export type DragView = {
  previews: ReadonlyMap<number, Previewed>
  snapX: number | null
  marquee: { left: number; top: number; width: number; height: number } | null
  razor: { x: number; top: number; height: number } | null
  brackets: readonly Bracket[]
  drop: { x: number; width: number; top: number; height: number; insert: boolean } | null
}

const EMPTY: DragView = { previews: new Map(), snapX: null, marquee: null, razor: null, brackets: [], drop: null }

/** The store: a drag redraws the track halves and the overlay that read it, not the whole panel. */
export function createDragView() {
  let view = EMPTY
  const listeners = new Set<() => void>()
  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(patch: Partial<DragView>) {
      const next = { ...view, ...patch }
      if ((Object.keys(patch) as Array<keyof DragView>).every((key) => JSON.stringify(next[key] instanceof Map ? [...next[key].entries()] : next[key]) === JSON.stringify(view[key] instanceof Map ? [...(view[key] as Map<number, Previewed>).entries()] : view[key]))) return
      view = next
      for (const listener of listeners) listener()
    },
    clear() {
      if (view === EMPTY) return
      view = EMPTY
      for (const listener of listeners) listener()
    },
  }
}

export type DragViewStore = ReturnType<typeof createDragView>

export function useDragView<T>(store: DragViewStore, pick: (view: DragView) => T) {
  return useSyncExternalStore(store.subscribe, () => pick(store.get()))
}
