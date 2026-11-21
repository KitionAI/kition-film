import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { TesseraIcons } from '@kition/sdk/editor'
import { Button, PreviewDialog, useKitStore, type Phrases } from '@kition/sdk/editor'
import type { FilmInfo } from '../film'
import type { FilmSessionState } from '../session/useFilmSession'
import { BODIES, type DialogActions } from './bodies'
import { DialogFields } from './fields'
import { createPreviewFrames, decodeFrame, describeDiff, otherSequences, previewEnded, previewNames, sameKey, stripListing, stripShows, type PreviewEngine, type PreviewKey } from './preview'
import { DIALOG_BUTTONS, DIFF_KINDS, createReadGuard, followSequence, previewSteps, previewDepends, previewsInEngine, rebaseDraft, rememberDraft, runDialog, sequenceGone, stepsRan, stripHasLines, stripResults, viewLinesFor, type DialogContext, type DialogNotice, type DialogSpec, type Draft, type Params } from './registry'
import { chooseCorner, createLifter, framesFor } from './placement'
import { createSoundPlayer, type SoundContext } from './sound'
import { PreviewContext, animationFrame, useDrawers, usePreviewState } from './usePreview'


const Play = TesseraIcons.PlayIcon
const Square = TesseraIcons.SquareIcon

type T = (key: string, values?: Record<string, string | number>) => string

const NO_LINES: readonly string[] = []

/** A dialog open in the editor: its spec, the draft it opened with (`defaults()`), and what it read. */
export type OpenDialog = { spec: DialogSpec; draft: Draft; ctx: DialogContext; serial: number; current: () => boolean; captureSubmit: () => () => boolean }

/** The program playhead, in seconds, and its moves (the playback clock's, while it plays). */
export type PlayheadClock = { get: () => number; subscribe: (listener: () => void) => () => void }

/** How long the sound strip's Play plays from the playhead. */
const SOUND_SECONDS = 3

/** A command's answer as JSON (the session answers a string). */
const parsed = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw ?? null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

type Place = { x: number; y: number } | null
const validPlace = (raw: unknown): Place | undefined => {
  if (raw === null) return null
  const place = raw as { x?: unknown; y?: unknown } | undefined
  return typeof place?.x === 'number' && typeof place.y === 'number' && Number.isFinite(place.x) && Number.isFinite(place.y) ? { x: place.x, y: place.y } : undefined
}

/**
 * The open dialog (upstream `dialogs.rs` `show`; one at a time), on kit-editor's `PreviewDialog`.
 * Its preview follows the draft, the engine's revision, and what the dialog depends on (the
 * active sequence and the selections, `previewDepends`), and OK names what the preview did, so
 * OK changes what was previewed. OK runs the commands through `invoke` with their params, each
 * at once; an error shows in the dialog and leaves it open. A dialog that previews on the
 * engine leaves the editor its keys (the playhead can be scrubbed, a clip selected) and moves by
 * its title, its place kept for every Film page. A replaced document closes the dialog: what it
 * was drafted for is gone. A dialog that only shows information has one Close button.
 */
export function DialogHost({ open, film, session, revision, viewRefresh = 0, documentInspect, playhead, invoke, pick, onClose, status, t, phrase }: {
  open: OpenDialog
  film: FilmInfo | null
  session: FilmSessionState | null
  revision: number | null
  /** Moves when the Project panel's view or presets may have changed with no revision (`useFilmSession`'s `projectView`): a `viewRebase` dialog reads them again. */
  viewRefresh?: number
  /** The document's own `inspect()` JSON, for the names the strip shows. */
  documentInspect: unknown
  playhead: PlayheadClock
  invoke: (id: string, params?: Params, options?: { direct?: boolean; throws?: boolean }) => Promise<unknown>
  /** A file through the host's picker (Locate…), or null. */
  pick: DialogActions['pick']
  onClose: () => void
  /** Shows a message in the status bar (upstream's `app.ui.status`), through `phrase()`. */
  status?: (text: string) => void
  t: T
  phrase: Phrases
}) {
  const { spec } = open
  const mounted = useRef(false)
  const submission = useRef<(() => boolean) | null>(null)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const current = () => mounted.current && open.current() && (submission.current?.() ?? true)
  const context = useContext(PreviewContext)
  const state = usePreviewState()
  const [draft, setDraft] = useState<Draft>(open.draft)
  const draftNow = useRef(draft)
  draftNow.current = draft
  const ctx = useMemo<DialogContext>(() => ({ ...open.ctx, film: film ?? open.ctx.film, session: session ?? open.ctx.session }), [open.ctx, film, session])
  const ctxNow = useRef(ctx)
  ctxNow.current = ctx
  const revisionNow = useRef(revision)
  revisionNow.current = revision
  const handle = useMemo(() => context?.preview.handle() ?? null, [context])
  const drawers = useDrawers()
  const set = useCallback((field: string, value: unknown) => setDraft((shown) => ({ ...shown, [field]: value })), [])
  // A number commits on blur. Its new preview can move the action row between mouse-down
  // and mouse-up, losing the click. Keep the field focused until OK runs (Cancel discards it).
  useLayoutEffect(() => {
    const box = document.querySelector<HTMLElement>('[data-testid="film-dialog"]')
    if (!box) return undefined
    const keepField = (event: MouseEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return
      const button = event.target.closest<HTMLButtonElement>('[data-testid="film-dialog-ok"], [data-testid="film-dialog-cancel"]')
      const active = document.activeElement
      if (button && !button.disabled && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && box.contains(active)) event.preventDefault()
    }
    // Capture this OK's permissions before PreviewDialog awaits preview shutdown. A fresh
    // click after permissions recover gets its own intent, even if the draft stayed open.
    const captureSubmit = (event: Event) => {
      const button = box.querySelector<HTMLButtonElement>('[data-testid="film-dialog-ok"]')
      if (!button || button.disabled || !(event.target instanceof Element)) return
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.keyCode === 229) return
      } else if (!button.contains(event.target)) return
      submission.current = open.captureSubmit()
    }
    box.addEventListener('mousedown', keepField, true)
    box.addEventListener('click', captureSubmit, true)
    box.addEventListener('keydown', captureSubmit, true)
    return () => {
      box.removeEventListener('mousedown', keepField, true)
      box.removeEventListener('click', captureSubmit, true)
      box.removeEventListener('keydown', captureSubmit, true)
    }
  }, [open])
  // A dialog that edits the active sequence closes when another one becomes active (what it was drafted for is gone).
  const openedSequence = useRef(open.ctx.film?.activeSequence ?? null)
  useEffect(() => {
    if (sequenceGone(spec, openedSequence.current, film)) onClose()
  }, [spec, film, onClose])
  // The collaboration rebase: each new revision (a peer's change, an agent's), the dialog's
  // defaults are read again and the fields left alone take the live values; the newest read wins.
  const openedRevision = useRef(revision)
  const rebaseRead = useRef(0)
  const rebaseNow = useCallback(async () => {
    const mine = ++rebaseRead.current
    const fresh = await Promise.resolve(spec.defaults(ctxNow.current)).catch(() => null)
    if (!fresh || mine !== rebaseRead.current) return draftNow.current
    const next = rebaseDraft(spec, draftNow.current, fresh)
    draftNow.current = next
    setDraft(next)
    return next
  }, [spec])
  useEffect(() => {
    if (!spec.rebase || revision === openedRevision.current) return
    void rebaseNow()
  }, [spec, revision, rebaseNow])
  // Another sequence active under a dialog upstream keeps open: a rebase dialog reads its
  // defaults again for it (its track lists, its name), and `sequenceChanged` adjusts the draft.
  const shownSequence = useRef(open.ctx.film?.activeSequence ?? null)
  const activeSequence = film?.activeSequence ?? null
  useEffect(() => {
    if (spec.sequenceBound || activeSequence === shownSequence.current || film == null) return
    shownSequence.current = activeSequence
    if (spec.rebase) void rebaseNow()
    setDraft((shown) => {
      const next = followSequence(spec, shown, ctxNow.current)
      draftNow.current = next
      return next
    })
  }, [spec, activeSequence, film])
  // What the dialog says about a draft read again (presets another changed), until the next one.
  const [notice, setNotice] = useState<DialogNotice | null>(null)
  const replaceDraft = useCallback((next: Draft) => {
    draftNow.current = next
    setDraft(next)
  }, [])
  // State no revision follows (view presets) may have changed: a `viewRebase` dialog reads it again; the newest read wins.
  // OK in flight owns the draft: its own steps move the tick, and a read then would rebase on half-applied state.
  const viewRead = useMemo(createReadGuard, [])
  const openedView = useRef(viewRefresh)
  useEffect(() => {
    if (!spec.viewRebase || viewRefresh === openedView.current) return
    const mine = viewRead.read()
    if (mine == null) return
    void spec
      .viewRebase(draftNow.current, ctxNow.current)
      .then((rebased) => {
        if (!rebased || !viewRead.current(mine)) return
        replaceDraft(rebased.draft)
        if (rebased.notice) setNotice(rebased.notice)
      })
      .catch(() => undefined)
  }, [spec, viewRefresh, replaceDraft, viewRead])
  // A dialog that keeps its draft (upstream's `app.ui` drafts) is left with the one shown, Cancel or OK.
  useEffect(() => {
    if (spec.remembers) rememberDraft(spec.id, draft)
  }, [spec, draft])
  const kinds = spec.preview
  const engine = previewsInEngine(kinds)
  const request = useCallback(
    () => ({ kinds: spec.preview, steps: previewsInEngine(spec.preview) ? previewSteps(spec, draftNow.current, ctxNow.current) : null, job: spec.job, revision: revisionNow.current, copies: spec.copiesSequence, highlight: spec.highlight }),
    [spec],
  )
  // A dialog that stays open after OK (Find) shows what OK answered while no preview shows it (upstream's `info.result`).
  const [answered, setAnswered] = useState<{ result: unknown } | null>(null)
  // An engine refusal that is the preview's answer (`quietError`: Find's "no matches"), shown in the strip.
  const [quiet, setQuiet] = useState<string | null>(null)
  const quietly = useCallback(
    async (run: () => Promise<void>) => {
      try {
        await run()
        setQuiet(null)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!spec.quietError?.(message)) throw error
        setQuiet(message)
      }
    },
    [spec],
  )
  const informs = kinds.includes('none')
  const Body = BODIES[spec.id]
  // The document was replaced while the dialog was open (`file.newProject`, a reopen): close it.
  const openedOn = useRef(state.document)
  useEffect(() => {
    if (state.document !== openedOn.current) onClose()
  }, [state.document, onClose])
  // Where a moved dialog sits, for every Film page; null: the layout's place (bottom left).
  const [place, setPlace] = useKitStore<Place>('film', 'dialogPlace', { initial: null, validate: validPlace })
  // With no place kept, a previewing dialog opens in the corner that keeps clear of the panels
  // drawing its preview (the layout's bottom left first), measured once as it opens.
  const [autoPlace, setAutoPlace] = useState<Place>(null)
  const autoNow = useRef<Place>(null)
  autoNow.current = autoPlace
  const placed = useRef(false)
  // At most two lifts while it is open (`createLifter`).
  const lift = useMemo(createLifter, [])
  useLayoutEffect(() => {
    if (!engine || place != null || placed.current || !context) return
    const box = document.querySelector('[data-testid="film-dialog"]')
    const area = document.querySelector('.kui-workspace') ?? document.documentElement
    if (!box) return
    placed.current = true
    const size = box.getBoundingClientRect()
    const room = area.getBoundingClientRect()
    setAutoPlace(chooseCorner({ size: { width: size.width, height: size.height }, area: { x: room.left, y: room.top, width: room.width, height: room.height }, avoid: framesFor(kinds, context.drawers) }))
  })
  // The dialog's box, so a panel it still hides counts as not drawing (the strip lists its part).
  useLayoutEffect(() => {
    if (!context || !engine) return undefined
    const box = document.querySelector('[data-testid="film-dialog"]')
    if (!box) return undefined
    const tell = () => {
      const rect = box.getBoundingClientRect()
      context.drawers.occlude({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      // A dialog in the layout's place that grew after it was placed (its strip's picture came)
      // moves up to stay inside the workspace, its buttons in view; one taller than the
      // workspace keeps its place (the same object: no update loop).
      if (place == null && placed.current) {
        const room = (document.querySelector('.kui-workspace') ?? document.documentElement).getBoundingClientRect()
        // Lifted outside a state updater, which React may run twice: each lift counts once.
        const at = autoNow.current
        const next = lift(at, rect, room)
        if (next !== at) {
          autoNow.current = next
          setAutoPlace(next)
        }
      }
    }
    tell()
    // Occlusion changes the preview strip, which can resize this same dialog. Publish
    // on the next frame so a ResizeObserver delivery never changes its observed size.
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        tell()
      })
    }
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    resized?.observe(box)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      resized?.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [context, engine, place, autoPlace, lift])
  useEffect(() => () => context?.drawers.occlude(null), [context])
  const actions = useMemo<DialogActions>(() => ({ run: (command, params) => invoke(command, params, { direct: true, throws: true }), close: onClose, pick }), [invoke, onClose, pick])
  const depends = previewDepends(spec, ctx)
  // A view preference's preview (Metadata Display, Manage), which no diff shows: listed while the panels on screen do not draw it.
  const viewLines = state.open ? viewLinesFor(spec, draft, ctx, t, phrase, drawers.drawn) : NO_LINES
  const preview =
    informs || !handle
      ? undefined
      : {
          begin: () => quietly(() => handle.begin(request())),
          update: () => quietly(() => handle.update(request)),
          end: () => handle.end(),
          draft: { draft: spec.previewKey ? spec.previewKey(draft) : draft, revision, depends },
          // No strip while the panels on screen draw all of the preview (an empty box says nothing).
          // A refusal (`quietError`) shows too: a dialog without answers of its own (Link Media's mismatch) has no other place for it.
          strip: stripShows(kinds, state.open ? state.diff : null, drawers, state.progress) || stripHasLines(spec, quiet) || viewLines.length > 0 ? <PreviewStrip spec={spec} draft={draft} ctx={ctx} documentInspect={documentInspect} playhead={playhead} answered={answered} quiet={quiet} viewLines={viewLines} t={t} phrase={phrase} /> : undefined,
        }
  return (
    <PreviewDialog
      title={phrase(spec.title)}
      preview={preview}
      okLabel={spec.okLabel ? phrase(spec.okLabel) : undefined}
      okDisabled={spec.okEnabled ? !spec.okEnabled(draft) : undefined}
      cancelLabel={spec.cancelLabel ? phrase(spec.cancelLabel) : undefined}
      hideOk={spec.hideOk}
      keepOpen={spec.keepOpen}
      modal={!engine}
      position={engine ? (place ?? autoPlace) : undefined}
      onMove={
        engine
          ? (at) => {
              void setPlace(at)
              const rect = document.querySelector('[data-testid="film-dialog"]')?.getBoundingClientRect()
              if (rect && context) context.drawers.occlude({ x: at.x, y: at.y, width: rect.width, height: rect.height })
            }
          : undefined
      }
      ids={{ ok: DIALOG_BUTTONS.ok, cancel: spec.hideOk && spec.onlyOk ? DIALOG_BUTTONS.ok : DIALOG_BUTTONS.cancel, preview: DIALOG_BUTTONS.preview }}
      testId="film-dialog"
      onOk={async () => {
        // PreviewDialog may have awaited an engine reply before reaching this callback.
        // An unmounted/replaced dialog must never submit its old draft into a new context.
        if (!current()) { onClose(); return }
        // Publish the focused field's blur commit before reading the draft used by OK.
        const active = document.activeElement
        if ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.closest('[data-testid="film-dialog"]')) flushSync(() => active.blur())
        viewRead.okStart()
        try {
          // OK compares with the document as it is now (upstream's show() reads it every frame).
          let draftAtOk = spec.rebase ? await rebaseNow() : draftNow.current
          if (!current()) { onClose(); return }
          // State no revision follows (view presets) is read again first: where another changed what OK would run, OK is refused on the rebased draft.
          const checked = spec.checkOk ? await spec.checkOk(draftAtOk, ctxNow.current) : null
          if (!current()) { onClose(); return }
          // Rebased with nothing dropped: run on the state as it is.
          if (checked && !checked.notice) {
            replaceDraft(checked.draft)
            draftAtOk = checked.draft
          } else if (checked) {
            // The refusal says it (the dialog's notice line would repeat it).
            replaceDraft(checked.draft)
            setNotice(null)
            throw new Error(checked.notice ? t(checked.notice.key, checked.notice.values) : t('previewBusy'))
          }
          let results: unknown[]
          try {
            results = await runDialog(spec, draftAtOk, ctxNow.current, (command, params) => {
              if (!current()) {
                onClose()
                throw new DOMException('Dialog cancelled', 'AbortError')
              }
              return invoke(command, params, { direct: true, throws: true })
            })
          } catch (error) {
            // Steps that ran are in the document: the draft drops them and follows the document, so a second OK starts from it.
            if (current() && spec.afterFailure) {
              const rebased = await spec.afterFailure(draftAtOk, stepsRan(error), ctxNow.current).catch(() => null)
              if (rebased) {
                replaceDraft(rebased.draft)
                setNotice(rebased.notice)
              }
            }
            throw error
          }
          if (!current()) return
          if (spec.okStatus && results.length) status?.(typeof spec.okStatus === 'function' ? spec.okStatus(results.map(parsed), phrase) : spec.okStatus)
          // A dialog that stays open takes OK's answers into its draft at once (Link Media drops the
          // file it linked), so a second press runs nothing more.
          if (spec.keepOpen && spec.afterOk && results.length) {
            const next = spec.afterOk(draftNow.current, results.map(parsed))
            if (next !== draftNow.current) {
              draftNow.current = next
              setDraft(next)
            }
          }
          if (!spec.keepOpen) onClose()
          else if (results.length) setAnswered({ result: parsed(results[results.length - 1]) })
        } finally {
          viewRead.okEnd()
          submission.current = null
        }
      }}
      onCancel={
        spec.cancelSteps?.length
          ? () => {
              // Once the preview has ended (Cancel ends it first), as upstream runs them after its dialog.
              const steps = spec.cancelSteps ?? []
              // This dialog's preview: the one open now, as it closes (one dialog at a time).
              const serial = context?.preview.get().serial ?? 0
              void (async () => {
                if (context) await previewEnded(context.preview, serial)
                for (const step of steps) await invoke(step.command, step.params, { direct: true })
              })()
              onClose()
            }
          : onClose
      }
      onReset={informs ? undefined : () => setDraft(open.draft)}
    >
      <div className="film-dialog" data-dialog={spec.prefix} data-testid={`film-dialog-${spec.prefix}`}>
        {notice ? (
          <p className="film-dialog-empty kui-muted" role="status" data-testid="film-dialog-notice">
            {t(notice.key, notice.values)}
          </p>
        ) : null}
        {spec.layout ? <DialogFields spec={spec} rows={spec.layout} draft={draft} set={set} ctx={ctx} phrase={phrase} /> : Body ? <Body spec={spec} draft={draft} set={set} ctx={ctx} revision={revision} phrase={phrase} t={t} actions={actions} /> : null}
      </div>
    </PreviewDialog>
  )
}

/**
 * Under the fields: what OK will do (a summary), the sound's Play, a small frame while no Program
 * monitor shows the picture, the changes of the kinds no panel on screen draws, as text, and a
 * job's progress.
 */
function PreviewStrip({ spec, draft, ctx, documentInspect, playhead, answered, quiet, viewLines, t, phrase }: { spec: DialogSpec; draft: Draft; ctx: DialogContext; documentInspect: unknown; playhead: PlayheadClock; answered: { result: unknown } | null; quiet: string | null; viewLines: readonly string[]; t: T; phrase: Phrases }) {
  const context = useContext(PreviewContext)
  const state = usePreviewState()
  const drawers = useDrawers()
  const drawn = drawers.drawn
  const kinds = spec.preview
  // The names come from the preview's own inspect(), read once per serial.
  const [names, setNames] = useState<{ serial: number; document: number; value: ReturnType<typeof previewNames> } | null>(null)
  const diffKinds = kinds.filter((kind) => DIFF_KINDS.has(kind))
  /** A part of the diff goes in the strip when the dialog previews its kind and no panel on screen draws it. */
  const strip = stripListing(kinds, drawers)
  const drawnSomewhere = diffKinds.some((kind) => (kind === 'selection' ? drawn('selection:timeline') || drawn('selection:project') : drawn(kind)))
  useEffect(() => {
    if (!context || !state.open || diffKinds.length === 0) return
    let current = true
    const { serial, document } = state
    // Another sequence's tracks and clips (a nest's) are named from that sequence, the preview's
    // copy or the document's (a removed one), with the root bin's name.
    const shown = (documentInspect as { sequence?: { id?: number } | null } | null)?.sequence?.id ?? ctx.film?.activeSequence ?? null
    const others = otherSequences(state.diff, shown)
    const engine = context.preview.engine()
    const parse = (raw: unknown) => {
      try {
        return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : (raw ?? null)
      } catch {
        return null
      }
    }
    const sequences = Promise.all(
      others.flatMap((item) => [
        engine ? engine.invoke('previewQuery', 'sequence.inspect', JSON.stringify({ item })).then(parse, () => null) : Promise.resolve(null),
        ctx.query('sequence.inspect', { item }).catch(() => null),
      ]),
    )
    // A bin the preview adds may be a search bin (Create Search Bin): named from the copy's list.
    const searchBins = (state.diff?.bins?.added ?? []).length && engine ? engine.invoke('previewQuery', 'project.searchBins', '{}').then(parse, () => null) : Promise.resolve(null)
    void Promise.all([context.preview.inspect(), sequences, searchBins]).then(([inspected, read, bins]) => {
      if (current) setNames({ serial, document, value: previewNames(documentInspect, inspected, { sequences: read.filter((each) => each != null), root: t('preview.root'), searchBins: Array.isArray(bins) ? bins : [] }) })
    })
    return () => {
      current = false
    }
  }, [context, state.open, state.serial, state.document, diffKinds.length, documentInspect])
  if (kinds.includes('summary')) {
    const lines = spec.summary?.(draft, ctx, t, phrase) ?? []
    return (
      <ul className="film-preview-lines" data-testid="film-preview-summary">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    )
  }
  const fresh = names && names.serial === state.serial && names.document === state.document ? names.value : null
  const lines = state.open && fresh ? describeDiff(state.diff, fresh, t, strip) : []
  const engine = context?.preview.engine ?? (() => null)
  // The preview's answer, else what OK answered last (a dialog that stays open: Find's "Match n of total").
  // With no preview open, the refusal it answered (Find's "no matches") or what OK answered last.
  const results = stripResults(spec, { open: state.open, result: state.result, quiet, answered }, t)
  const item = state.open && spec.stripItem ? spec.stripItem(state.result) : null
  return (
    <div className="film-preview-strip" data-testid="film-preview-strip" data-serial={state.open ? state.serial : undefined}>
      {kinds.includes('sound') ? <SoundButton engine={engine} serial={state.open ? state.serial : null} playhead={playhead} t={t} /> : null}
      {results.length ? (
        <ul className="film-preview-lines" data-testid="film-preview-result">
          {results.map((line, index) => (
            <li key={`${index}:${line}`} className="tabular-nums">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {item != null ? <PreviewItemThumb engine={engine} item={item} previewKey={{ document: state.document, revision: state.revision, serial: state.serial }} /> : null}
      {kinds.includes('picture') && !drawn('picture') && state.open ? <PreviewThumb engine={engine} previewKey={{ document: state.document, revision: state.revision, serial: state.serial }} playhead={playhead} resting={ctx.film?.playhead ?? 0} /> : null}
      {viewLines.length ? (
        <ul className="film-preview-lines" data-testid="film-preview-view">
          {viewLines.map((line, index) => (
            <li key={`${index}:${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}
      {/* A view preference's preview has no diff: its own lines say what it shows. */}
      {diffKinds.length && (lines.length || (!drawnSomewhere && viewLines.length === 0)) ? (
        <ul className="film-preview-lines" data-testid="film-preview-diff">
          {state.open && fresh && lines.length === 0 ? <li className="kui-muted">{t('preview.nothing')}</li> : null}
          {lines.map((line, index) => (
            // Two clips of one name on one track make the same line twice.
            <li key={`${index}:${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}
      {state.progress != null ? (
        <div className="film-preview-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress * 100)} data-testid="film-preview-progress">
          <span style={{ width: `${state.progress * 100}%` }} />
        </div>
      ) : null}
    </div>
  )
}

/** The picture at the playhead, small, while no Program monitor on screen draws it; drawn again as the playhead moves. */
function PreviewThumb({ engine, previewKey, playhead, resting }: { engine: () => PreviewEngine | null; previewKey: PreviewKey; playhead: PlayheadClock; resting: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const keyNow = useRef(previewKey)
  keyNow.current = previewKey
  const pictures = useMemo(
    () =>
      createPreviewFrames({
        engine,
        schedule: animationFrame,
        current: () => keyNow.current,
        onFrame: (image) => {
          const element = canvas.current
          if (!element) return
          element.width = image.width
          element.height = image.height
          element.getContext('2d')?.putImageData(new ImageData(image.pixels as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0)
          element.dataset.drawn = String(image.key.serial)
        },
      }),
    [engine],
  )
  useEffect(() => () => pictures.dispose(), [pictures])
  useEffect(() => {
    const ask = () => pictures.request(keyNow.current, playhead.get(), 240 * (window.devicePixelRatio || 1))
    ask()
    return playhead.subscribe(ask)
  }, [pictures, previewKey.document, previewKey.revision, previewKey.serial, playhead, resting])
  return <canvas ref={canvas} className="film-preview-thumb" data-testid="film-preview-thumb" />
}

/**
 * An item only the preview has (a new Color Matte), drawn small from `previewItemFrame` once per
 * serial; an answer for another document, revision, or serial is dropped (lesson 6).
 */
function PreviewItemThumb({ engine, item, previewKey }: { engine: () => PreviewEngine | null; item: number; previewKey: PreviewKey }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const keyNow = useRef(previewKey)
  keyNow.current = previewKey
  useEffect(() => {
    const on = engine()
    if (!on) return undefined
    let live = true
    const asked = previewKey
    void on
      .invoke<Uint8Array>('previewItemFrame', item, 0, Math.round(240 * (window.devicePixelRatio || 1)))
      .then((bytes) => {
        const image = decodeFrame(bytes)
        const element = canvas.current
        if (!live || !image || !element || !sameKey(keyNow.current, asked)) return
        element.width = image.width
        element.height = image.height
        element.getContext('2d')?.putImageData(new ImageData(image.pixels as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0)
        element.dataset.drawn = String(asked.serial)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [engine, item, previewKey.document, previewKey.revision, previewKey.serial])
  return <canvas ref={canvas} className="film-preview-thumb" data-testid="film-preview-item" data-item={item} />
}

/** Plays 3 s of the preview's mix from the playhead (`previewAudio`); stops with the preview and on unmount. */
function SoundButton({ engine, serial, playhead, t }: { engine: () => PreviewEngine | null; serial: number | null; playhead: PlayheadClock; t: T }) {
  const [playing, setPlaying] = useState(false)
  const player = useMemo(() => createSoundPlayer({ audio: (rate) => new AudioContext({ sampleRate: rate }) as unknown as SoundContext, onChange: setPlaying }), [])
  // Another preview (or none) is not what was heard; an unmount stops it too.
  useEffect(() => () => player.stop(), [serial, player])
  const play = () => {
    const on = engine()
    if (on && serial != null) void player.play(on, playhead.get(), SOUND_SECONDS)
  }
  return (
    <Button disabled={serial == null} onClick={() => (playing ? player.stop() : play())} data-kit-ui-id={DIALOG_BUTTONS.play} data-testid="film-preview-play">
      {playing ? <Square size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
      {t(playing ? 'preview.stop' : 'preview.play')}
    </Button>
  )
}
