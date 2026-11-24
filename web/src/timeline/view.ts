import { useSyncExternalStore } from 'react'
import { readKitStore, writeKitStore } from '@kition/sdk/editor'
import { DEFAULT_VIEW, applyViewCommand, stepView, storedView, validStoredView, type StoredView, type TimelineView } from './layout'

const STORE = 'timeline'

const sameStored = (a: StoredView, b: StoredView) => a.split === b.split && a.headerWidth === b.headerWidth && a.showThumbnails === b.showThumbnails && a.showWaveforms === b.showWaveforms && a.follow === b.follow

function same(a: TimelineView, b: TimelineView) {
  for (const key of Object.keys(a) as Array<keyof TimelineView>) if (a[key] !== b[key]) return false
  return true
}

/**
 * The Timeline's view (upstream `app.ui.timeline`), outside React: the panel draws from it, and
 * `invoke`'s view commands (zoom, fit, track heights, screens) change it whether or not the panel
 * is shown. Zoom and scroll ease toward their targets one animation frame per step while the panel
 * reports its width; the toggles, split, and header width are kept in the kit store `timeline`.
 */
export function createTimelineView(kit = 'film') {
  let view: TimelineView = { ...DEFAULT_VIEW, ...(readKitStore(kit, STORE, validStoredView) ?? {}) }
  let geometry = { width: 0, duration: 0 }
  let shownSequence: number | null | undefined
  let shownDocument: unknown
  let frame = 0
  let last = 0
  let writeTimer = 0
  let written = storedView(view)
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const persist = () => {
    const next = storedView(view)
    if (sameStored(next, written)) return
    window.clearTimeout(writeTimer)
    writeTimer = window.setTimeout(() => {
      written = storedView(view)
      writeKitStore(kit, STORE, written)
    }, 300)
  }
  const tick = (now: number) => {
    frame = 0
    const dt = last ? (now - last) / 1000 : 1 / 60
    last = now
    if (geometry.width <= 0) return
    const { view: next, animating } = stepView(view, dt, geometry)
    if (!same(next, view)) {
      view = next
      notify()
    }
    if (animating || view.fitPending) schedule()
    else last = 0
  }
  const schedule = () => {
    if (frame || typeof requestAnimationFrame === 'undefined') return
    frame = requestAnimationFrame(tick)
  }
  const set = (update: Partial<TimelineView> | ((current: TimelineView) => TimelineView)) => {
    const next = typeof update === 'function' ? update(view) : { ...view, ...update }
    if (same(next, view)) return
    view = next
    notify()
    persist()
    schedule()
  }
  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set,
    /** The track content's width and the sequence's duration, which fitting and clamping need. */
    setGeometry(width: number, duration: number) {
      if (geometry.width === width && geometry.duration === duration) return
      geometry = { width, duration }
      schedule()
    },
    width: () => geometry.width,
    /**
     * Another sequence shown: as upstream's `timeline_view_of` without a stored view, its tracks
     * scroll to the start at the default heights (lowered so every track shows, when the panel is
     * short: `fitTrackHeight`) and it fits on the next frame. A sequence of
     * another `document` (the file reopened after it changed on disk) is another sequence, though
     * its id may be the same.
     */
    showSequence(sequence: number | null, document: unknown = null) {
      if (sequence === shownSequence && document === shownDocument) return
      shownSequence = sequence
      shownDocument = document
      set((current) => ({ ...current, vScroll: 0, aScroll: 0, videoTrackHeight: DEFAULT_VIEW.videoTrackHeight, audioTrackHeight: DEFAULT_VIEW.audioTrackHeight, fitPending: true, fitEmpty: null, savedHeights: null, fitHeights: true }))
    },
    /** One of `invoke`'s Timeline view commands, about the program playhead (`playhead`, seconds); its answer. */
    command(id: string, params: Record<string, unknown>, playhead: number) {
      const next = applyViewCommand(view, id, params, { playhead, width: geometry.width })
      if (!next) throw new Error(`unknown Timeline view command \`${id}\``)
      set(next.view)
      return next.result
    },
    dispose() {
      if (frame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame)
      frame = 0
      window.clearTimeout(writeTimer)
      if (!sameStored(storedView(view), written)) writeKitStore(kit, STORE, storedView(view))
    },
  }
}

export type TimelineViewStore = ReturnType<typeof createTimelineView>

export function useTimelineView(store: TimelineViewStore) {
  return useSyncExternalStore(store.subscribe, store.get)
}
