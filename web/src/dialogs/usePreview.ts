import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { KitEngine, KitEngineInfo } from '@kition/kit-editor'
import { describe, type FilmInfo } from '../film'
import { createDrawers, createPreview, documentReplaced, type Preview, type PreviewCovers, type PreviewDiff, type PreviewDrawer, type PreviewDrawers, type PreviewState, type Schedule } from './preview'

/** The next animation frame (a page that is not shown runs none: its previews wait, as its panels do). */
export const animationFrame: Schedule = (task) => {
  const id = requestAnimationFrame(() => task())
  return () => cancelAnimationFrame(id)
}

export type PreviewContextValue = { preview: Preview; drawers: PreviewDrawers }

/** The editor's preview, which the panels read to draw it (`{ open, serial, kinds, diff }`). */
export const PreviewContext = createContext<PreviewContextValue | null>(null)

/**
 * The editor's one preview on `doc`. When the document is replaced (another document, a reopen
 * from the host, or `documentReplaced` between two `inspect()`s: `file.open`, `file.newProject`,
 * Revert), the open preview ends, every read keyed on the old document is dropped, and the open
 * dialog closes (`DialogHost`): a backstop to the engine, which ends the preview itself once a
 * command that replaced the document has run.
 */
export function usePreviewController(doc: KitEngine | null, inspected: unknown): PreviewContextValue {
  const docNow = useRef(doc)
  docNow.current = doc
  const preview = useMemo(() => createPreview({ engine: () => docNow.current, schedule: animationFrame }), [])
  const drawers = useMemo(createDrawers, [])
  const seen = useRef({ doc, inspected })
  useEffect(() => {
    const was = seen.current
    seen.current = { doc, inspected }
    const otherDocument = was.doc !== doc && was.doc != null
    if (otherDocument || (was.doc === doc && documentReplaced(was.inspected, inspected))) preview.replaced()
  }, [doc, inspected, preview])
  useEffect(() => () => preview.replaced(), [preview])
  return useMemo(() => ({ preview, drawers }), [preview, drawers])
}

const NO_PREVIEW: PreviewState = { open: false, serial: 0, kinds: [], result: null, diff: null, progress: null, document: 0, revision: null, copies: false, highlight: null }
const noSubscribe = () => () => undefined

/** The preview's state, redrawn when it changes; closed outside a provider. */
export function usePreviewState(): PreviewState {
  const context = useContext(PreviewContext)
  return useSyncExternalStore(context ? context.preview.subscribe : noSubscribe, context ? context.preview.get : () => NO_PREVIEW)
}

/**
 * Says, while mounted and `on`, that this panel draws `kind` (or that part of it): the strip leaves
 * out what it draws. `covers` names the entries it draws (the shown sequence's clips, the rows of
 * the bin shown), read when the strip asks; `coverKey` moves when they change, so the strip asks
 * again. Without `covers` it draws every entry. `frame` is the panel's element: an open dialog
 * keeps off its workspace frame, and while the dialog still hides most of it the strip lists its
 * part instead.
 */
export function useDrawsPreview(kind: PreviewDrawer, on = true, covers?: PreviewCovers, coverKey?: unknown, frame?: RefObject<Element | null>) {
  const context = useContext(PreviewContext)
  const coversNow = useRef(covers)
  coversNow.current = covers
  const hasCovers = covers != null
  useEffect(() => (context && on ? context.drawers.add(kind, () => (hasCovers ? coversNow.current : undefined), () => frame?.current ?? null) : undefined), [context, kind, on, hasCovers, frame])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    context?.drawers.changed()
  }, [context, coverKey])
}

const NO_DRAWERS: Pick<PreviewDrawers, 'drawn' | 'covers'> = { drawn: () => false, covers: () => false }

/** What the panels on screen draw of a preview now, drawn again when it changes. */
export function useDrawers(): Pick<PreviewDrawers, 'drawn' | 'covers'> {
  const context = useContext(PreviewContext)
  const version = useSyncExternalStore(context ? context.drawers.subscribe : noSubscribe, context ? context.drawers.version : () => 0)
  return useMemo(() => (context ? { drawn: context.drawers.drawn, covers: context.drawers.covers } : NO_DRAWERS), [context, version])
}

/** The preview's `inspect()` as the editor reads the document's, its diff, and its kinds: all of one serial. */
export type PreviewFilm = { serial: number; document: number; film: FilmInfo; diff: PreviewDiff | null; kinds: PreviewState['kinds']; copies: boolean; highlight: PreviewState['highlight'] }

/** Each `previewInspect` answer (one per serial, `Preview.inspect`), read once for every panel that draws it. */
const described = new WeakMap<object, FilmInfo>()

type InspectedSettings = { sequence?: { settings?: { width?: number; height?: number } } | null }

/**
 * The open preview's `inspect()` (`previewInspect`, read once per serial), as `describe` reads the
 * document's, while `want` holds (a panel on screen draws one of the preview's kinds); null
 * otherwise. Every read is keyed on the document and the serial (lesson 6): an answer for another
 * is dropped. While the next serial's answer loads, the last one stays, with its own diff, so a
 * draft being dragged does not flash the document back.
 */
export function usePreviewFilm(want: boolean): PreviewFilm | null {
  const context = useContext(PreviewContext)
  const state = usePreviewState()
  const on = want && state.open && context != null
  const [loaded, setLoaded] = useState<PreviewFilm | null>(null)
  useEffect(() => {
    if (!on || !context) {
      setLoaded(null)
      return undefined
    }
    let live = true
    const { serial, document, diff, kinds, copies, highlight } = context.preview.get()
    // A newer draft is on its way (a drag, keys held): its serial is read instead (latest wins at the read).
    if (context.preview.newer()) return undefined
    void context.preview.inspect().then((raw) => {
      const now = context.preview.get()
      if (!live || !raw || typeof raw !== 'object' || !now.open || now.serial !== serial || now.document !== document) return
      let film = described.get(raw)
      if (!film) {
        const settings = (raw as InspectedSettings).sequence?.settings
        film = describe({ inspected: raw as Record<string, unknown>, width: settings?.width ?? 0, height: settings?.height ?? 0, canUndo: false, canRedo: false } as KitEngineInfo)
        described.set(raw, film)
      }
      setLoaded({ serial, document, film, diff, kinds, copies, highlight })
    })
    return () => {
      live = false
    }
  }, [on, context, state.serial, state.document])
  return on && loaded && loaded.document === state.document ? loaded : null
}

/** The open preview's key (`PreviewKey` without the revision) as a string, or null: what a per-preview cache is named by. */
export const previewCacheKey = (state: Pick<PreviewState, 'open' | 'document' | 'serial'>) => (state.open ? `${state.document}:${state.serial}` : null)
