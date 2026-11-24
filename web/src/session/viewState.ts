/**
 * The person's view of the project (Kit UI protocol 7n, capability `view-state`): the open
 * sequence tabs, the active one, the Timeline's nest toggle and how each sequence is shown. It is
 * never written into the `.kfilm`: the engine answers it (`viewState`, the same fields its
 * `state.inspect` carries, which the editor reads after every change anyway, so it is taken from
 * there) and puts it back (`restoreView`, no edit); the host keeps it when it changes
 * (`writeViewState`) and after each
 * save through `useKitSession`'s `viewState` option, and gives it back when the document opens
 * (`readViewState`). Without the capability it is kept for this page only.
 */
import { readViewState, writeViewState, type HostConnection, type KitEngine } from '@kition/sdk/editor'

/** The engine's view state: `{ v: 1, view: {...} }`, the kit's own payload. */
export type FilmViewState = Record<string, unknown>

export type FilmViewStateKeeper = {
  /** The latest view the engine answered (what the next save keeps), or what a reopened document carries. */
  kept: { current: FilmViewState | null }
  /** Puts the kept view (the host's, else this page's) back into a document that just opened. */
  restore: (engine: KitEngine) => Promise<void>
  /** Takes the view from the engine's `state.inspect` answer and keeps a changed one with the host. */
  take: (state: Record<string, unknown>) => void
  /** `useKitSession`'s `viewState` option. */
  option: () => { state: FilmViewState } | undefined
}

const isObject = (value: unknown): value is FilmViewState => typeof value === 'object' && value !== null && !Array.isArray(value)

export function createFilmViewState(host: HostConnection): FilmViewStateKeeper {
  const kept: { current: FilmViewState | null } = { current: null }
  return {
    kept,
    async restore(engine) {
      const stored = (await readViewState(host.files, host.init.document.path))?.state
      const state = isObject(stored) ? stored : kept.current
      if (!state) return
      try {
        await engine.invoke<boolean>('restoreView', JSON.stringify(state))
      } catch (error) {
        console.warn('[film] could not restore the view', error)
      }
    },
    take(raw) {
      // The engine's `viewState`: `{ v: 1, view: ProjectView }`, whose fields `state.inspect` names the same.
      const view = {
        sequences_as_clips: raw.sequences_as_clips ?? false,
        open_sequences: raw.open_sequences ?? [],
        active_sequence: raw.active_sequence ?? null,
        sequences: raw.timeline_views ?? {},
      }
      const state: FilmViewState = { v: 1, view }
      if (JSON.stringify(state) === JSON.stringify(kept.current)) return
      kept.current = state
      void writeViewState(host.files, host.init.document.path, { state })
    },
    option: () => (kept.current ? { state: kept.current } : undefined),
  }
}
