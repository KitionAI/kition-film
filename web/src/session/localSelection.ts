import { useSyncExternalStore } from 'react'

/**
 * What the editor selects that the engine's state does not hold: the transition chosen on the
 * Timeline (upstream's `transition_selection`), and the effect chosen in Effect Controls (upstream's
 * `selected_effect`, `effects.select`). Delete reads them (`App.tsx`'s run). One store per page.
 */
export type LocalSelection = {
  transition: number | null
  effect: { clip: number; index: number } | null
  /** A keyframe chosen on an audio clip's Volume line (its media time names it to the engine). */
  keyframe: { clip: number; mediaTime: number } | null
}

const EMPTY: LocalSelection = { transition: null, effect: null, keyframe: null }

export function createLocalSelection() {
  let value = EMPTY
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    set(patch: Partial<LocalSelection>) {
      const next = { ...value, ...patch }
      if (next.transition === value.transition && JSON.stringify(next.effect) === JSON.stringify(value.effect) && JSON.stringify(next.keyframe) === JSON.stringify(value.keyframe)) return
      value = next
      for (const listener of listeners) listener()
    },
  }
}

export type LocalSelectionStore = ReturnType<typeof createLocalSelection>

/** The page's selection store. */
export const localSelection = createLocalSelection()

export function useLocalSelection<T>(pick: (value: LocalSelection) => T): T {
  return useSyncExternalStore(localSelection.subscribe, () => pick(localSelection.get()))
}
