import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Button, oneInFlight, type Phrases } from '@kition/sdk/editor'
import { MEDIA_TYPES } from '../film'
import type { DialogBodyProps } from './bodies'
import { MATCH_OPTIONS, chosenRow, createPickTicket, linkRowViews, locate, locatedOf, mediaStatuses, offlineAll, offlineTargets, setOffline, settleDraft, shownRows, type LinkRowView } from './media'
import { decodeFrame, sameKey, type PreviewEngine, type PreviewKey } from './preview'
import { fieldId } from './registry'
import { PreviewContext, usePreviewState } from './usePreview'

const parse = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Each item's status in the document (`media.status`), read again on each revision with one read
 * in flight (the newest revision is read after the one running); null until the first answer.
 */
function useDocumentStatuses(query: DialogBodyProps['ctx']['query'], revision: number | null): ReadonlyMap<number, string> | null {
  const ask = useRef(query)
  ask.current = query
  const mounted = useRef(true)
  const [statuses, setStatuses] = useState<ReadonlyMap<number, string> | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const read = useMemo(
    () =>
      oneInFlight(async () => {
        const answer = await ask.current('media.status', {})
        if (mounted.current) setStatuses(mediaStatuses(answer))
      }),
    [],
  )
  useEffect(() => {
    void read()
  }, [read, revision])
  return statuses
}

/** Each item's status in the open preview (`previewQuery('media.status')`), keyed on its document and serial (lesson 6); null while none is open. */
function usePreviewStatuses(): ReadonlyMap<number, string> | null {
  const context = useContext(PreviewContext)
  const state = usePreviewState()
  const [read, setRead] = useState<{
    serial: number
    document: number
    value: ReadonlyMap<number, string>
  } | null>(null)
  useEffect(() => {
    const engine = state.open ? context?.preview.engine() : null
    if (!engine) return undefined
    let live = true
    const { serial, document } = state
    void engine.invoke('previewQuery', 'media.status', '{}').then(
      (raw) => {
        const now = context?.preview.get()
        if (live && now?.open && now.serial === serial && now.document === document) setRead({ serial, document, value: mediaStatuses(parse(raw)) })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [context, state.open, state.serial, state.document])
  return state.open && read && read.serial === state.serial && read.document === state.document ? read.value : null
}

/** A row's picture in the preview (`previewItemFrame`), small, once per serial; an answer for another key is dropped. */
const PreviewIcon = memo(function PreviewIcon({ engine, item, previewKey }: { engine: () => PreviewEngine | null; item: number; previewKey: PreviewKey }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const keyNow = useRef(previewKey)
  keyNow.current = previewKey
  useEffect(() => {
    const on = engine()
    if (!on) return undefined
    let live = true
    const asked = previewKey
    void on
      .invoke<Uint8Array>('previewItemFrame', item, 0, Math.round(48 * (window.devicePixelRatio || 1)))
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
  return <canvas ref={canvas} className="film-link-icon" data-testid={`film-dialog-linkMedia-icon-${item}`} />
})

type RowProps = {
  view: LinkRowView
  status: 'missing' | 'offline'
  uiId: string
  choose: (item: number) => void
  engine: () => PreviewEngine | null
  previewKey: PreviewKey | null
  online: string
  phrase: Phrases
}

/**
 * One Link Media row (lesson 5): memoized, with the body's stable `choose`, so a preview that
 * relinks one row of 200 draws that row again only. While the preview shows it online, it draws
 * its picture from the preview.
 */
const LinkRow = memo(function LinkRow({ view, status, uiId, choose, engine, previewKey, online, phrase }: RowProps) {
  const { row, index, chosen } = view
  return (
    <div className="film-link-row" role="row" data-chosen={chosen || undefined}>
      <button type="button" className="film-link-name" aria-pressed={chosen} onClick={() => choose(row.item)} data-kit-ui-id={uiId} data-testid={`film-dialog-linkMedia-row-${index}`}>
        {row.name}
      </button>
      <span className="film-link-file">{row.fileName}</span>
      <span className="film-link-path" title={row.path}>
        {row.path}
      </span>
      {view.online && previewKey ? (
        <span className="film-link-status film-link-online" data-testid={`film-dialog-linkMedia-status-${row.item}`} data-preview="online">
          <PreviewIcon engine={engine} item={row.item} previewKey={previewKey} />
          {online}
        </span>
      ) : (
        <span className="film-link-status film-link-missing" data-testid={`film-dialog-linkMedia-status-${row.item}`}>
          {phrase(status === 'offline' ? 'Offline' : 'Missing')}
        </span>
      )}
    </div>
  )
})

/** Each view of `next` that shows the same as `before`'s is `before`'s own object, so its memoized row does not draw again. */
function keepViews(before: readonly LinkRowView[], next: LinkRowView[]): LinkRowView[] {
  const old = new Map(before.map((view) => [view.row.item, view]))
  return next.map((view) => {
    const was = old.get(view.row.item)
    return was && was.row === view.row && was.index === view.index && was.chosen === view.chosen && was.online === view.online ? was : view
  })
}

/**
 * Link Media (upstream `media_dialogs.rs` `link_media`): the clips that cannot find their media,
 * the match options, Align Timecode and Relink others automatically, then Offline All, Offline,
 * and Locate… (Cancel and Link are the dialog's own buttons). The rows are those the document
 * still has missing or offline (read once per revision): a row Link relinked, or one set Offline,
 * leaves, and the dialog closes with none left, as upstream's. While the preview is open, a row
 * the preview relinks (the one located, and with Relink others the others it finds) shows online
 * with its picture from the preview: Kition's, as upstream draws no preview.
 */
export function LinkMediaBody({ spec, draft, set, ctx, revision, phrase, t, actions }: DialogBodyProps) {
  const context = useContext(PreviewContext)
  const state = usePreviewState()
  const statuses = useDocumentStatuses(ctx.query, revision)
  const previewed = usePreviewStatuses()
  const rows = shownRows(draft, statuses)
  const chosen = chosenRow(draft, rows)
  const located = locatedOf(draft)
  // A row that went (linked, or set Offline) takes its located file with it; with no row left the dialog closes.
  const settled = settleDraft(draft, rows)
  useEffect(() => {
    if (settled !== draft) set('located', settled.located)
  }, [settled, draft, set])
  const closing = statuses != null && rows.length === 0
  useEffect(() => {
    if (closing) actions.close()
  }, [closing, actions])
  const draftNow = useRef(draft)
  draftNow.current = draft
  // A Locate… answer that a newer pick or another row has overtaken is dropped.
  const ticket = useMemo(createPickTicket, [])
  const replace = useCallback(
    (next: typeof draft) => {
      const shown = draftNow.current
      for (const key of ['row', 'located', 'skipped'] as const) if (next[key] !== shown[key]) set(key, next[key])
    },
    [set],
  )
  const choose = useCallback(
    (item: number) => {
      if (draftNow.current.row === item) return
      ticket.drop()
      replace({ ...draftNow.current, row: item, located: null })
    },
    [replace, ticket],
  )
  const onLocate = async () => {
    if (!chosen) return
    const pick = ticket.next()
    const path = await actions.pick('media', MEDIA_TYPES)
    if (path && ticket.current(pick)) replace(locate(draftNow.current, chosen, path))
  }
  const engine = context?.preview.engine ?? (() => null)
  const previewKey = useMemo<PreviewKey | null>(
    () => (state.open ? { document: state.document, revision: state.revision, serial: state.serial } : null),
    [state.open, state.document, state.revision, state.serial],
  )
  const views = useRef<LinkRowView[]>([])
  views.current = keepViews(views.current, linkRowViews(rows, chosen?.item ?? null, previewed))
  const online = t('media.online')
  const uiId = fieldId(spec, 'row')
  return (
    <>
      <p className="film-dialog-label">{phrase("{n} clip(s) can't find their media. Locate them, search a folder, or leave them offline.").replace('{n}', String(rows.length))}</p>
      <div className="film-link-rows" role="grid" aria-label={phrase('Link Media')}>
        <div className="film-link-row film-link-head" role="row">
          {['Clip Name', 'File Name', 'File Path', 'Status'].map((head) => (
            <strong key={head} role="columnheader">
              {phrase(head)}
            </strong>
          ))}
        </div>
        {views.current.map((view) => (
          <LinkRow key={view.row.item} view={view} status={view.row.status} uiId={uiId} choose={choose} engine={engine} previewKey={view.online ? previewKey : null} online={online} phrase={phrase} />
        ))}
      </div>
      <div className="film-link-options">
        <span>{phrase('Match file properties:')}</span>
        {MATCH_OPTIONS.map(([key, label]) => (
          <label key={key} className="kui-checkbox film-dialog-check">
            <input
              type="checkbox"
              checked={draft[key] === true}
              onChange={(event) => set(key, event.target.checked)}
              data-kit-ui-id={fieldId(spec, `match.${key}`)}
              data-testid={`film-dialog-linkMedia-match-${key}`}
            />
            {phrase(label)}
          </label>
        ))}
      </div>
      <div className="film-link-options">
        <label className="kui-checkbox film-dialog-check">
          <input
            type="checkbox"
            checked={draft.alignTimecode === true}
            onChange={(event) => set('alignTimecode', event.target.checked)}
            data-kit-ui-id={fieldId(spec, 'alignTimecode')}
            data-testid="film-dialog-linkMedia-alignTimecode"
          />
          {phrase('Align Timecode')}
        </label>
        <label className="kui-checkbox film-dialog-check">
          <input
            type="checkbox"
            checked={draft.relinkOthers === true}
            onChange={(event) => set('relinkOthers', event.target.checked)}
            data-kit-ui-id={fieldId(spec, 'relinkOthers')}
            data-testid="film-dialog-linkMedia-relinkOthers"
          />
          {phrase('Relink others automatically')}
        </label>
      </div>
      <p className="film-dialog-empty film-link-located" data-testid="film-dialog-linkMedia-located">
        {located ? t('media.located', { path: located.path }) : phrase('No candidates yet — Search a folder or Locate the file.')}
      </p>
      <div className="film-link-actions">
        <Button onClick={() => void offlineAll(actions)} data-kit-ui-id={fieldId(spec, 'offlineAll')} data-testid="film-dialog-linkMedia-offlineAll">
          {phrase('Offline All')}
        </Button>
        <Button disabled={!chosen} onClick={() => chosen && replace(setOffline(draft, chosen))} data-kit-ui-id={fieldId(spec, 'offline')} data-testid="film-dialog-linkMedia-offline">
          {phrase('Offline')}
        </Button>
        <Button disabled={!chosen} onClick={() => void onLocate()} data-kit-ui-id={fieldId(spec, 'locate')} data-testid="film-dialog-linkMedia-locate">
          {phrase('Locate…')}
        </Button>
      </div>
    </>
  )
}

/**
 * Make Offline (upstream `media_dialogs.rs` `make_offline`): its question with the Project
 * selection's count, and Media files remain on disk, the one choice the web keeps (deleting the
 * files is the host's). It is its own confirmation: OK makes them offline.
 */
export function MakeOfflineBody({ spec, draft, ctx, phrase }: DialogBodyProps) {
  // The selection's file items: what the engine makes offline.
  const count = offlineTargets(draft, ctx).length
  return (
    <>
      <p className="film-dialog-label" data-testid="film-dialog-makeOffline-question">
        {phrase('Make {n} selected clip(s) offline. Their clips show the offline slate until you link them again.').replace('{n}', String(count))}
      </p>
      <div className="film-dialog-radios" role="radiogroup">
        <label className="kui-checkbox film-dialog-check">
          <input type="radio" name={fieldId(spec, 'files')} checked readOnly data-kit-ui-id={fieldId(spec, 'keep')} data-testid="film-dialog-makeOffline-keep" />
          {phrase('Media files remain on disk')}
        </label>
      </div>
    </>
  )
}
