import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, NumberField, PreviewDialog, useKitStore, type Phrases } from '@kition/sdk/editor'
import { chooseCorner, createLifter } from '../dialogs/placement'
import type { GuideTemplates } from './guideTemplates'
import {
  GUIDE_DIALOG_IDS,
  addGuideParams,
  addGuidePreview,
  guideLines,
  manageApply,
  manageCommit,
  manageDelete,
  manageDeletes,
  manageRebase,
  manageShown,
  type AddGuideDraft,
  type Guide,
  type GuidePreview,
  type ManageDraft,
  type ValueStore,
} from './guideModel'
import type { MonitorId, MonitorViews } from './monitorView'

type T = (key: string, values?: Record<string, string | number>) => string

/** An open guide dialog (upstream's `app.ui.guide_dialog`): Add Guide…, Save Guides as Template…, or Manage Guides…, for one monitor. */
export type GuideDialogState =
  | { kind: 'add'; monitor: MonitorId; draft: AddGuideDraft; serial: number }
  | { kind: 'save'; monitor: MonitorId; name: string; serial: number }
  | { kind: 'manage'; monitor: MonitorId; serial: number }


const BUTTONS = { ok: 'control:dialog.ok', cancel: 'control:dialog.cancel', preview: 'control:dialog.preview' }

type Place = { x: number; y: number } | null
const validPlace = (raw: unknown): Place | undefined => {
  if (raw === null) return null
  const place = raw as { x?: unknown; y?: unknown } | undefined
  return typeof place?.x === 'number' && typeof place.y === 'number' && Number.isFinite(place.x) && Number.isFinite(place.y) ? { x: place.x, y: place.y } : undefined
}

/**
 * Where a guide dialog sits: where the person last moved a dialog (the dialogs' shared place),
 * else the corner of the workspace that keeps clear of its monitor, so its preview shows; a
 * dialog there that grows (its strip's lines came) moves up to stay inside the workspace.
 */
function usePlace(monitor: MonitorId) {
  const [place, setPlace] = useKitStore<Place>('film', 'dialogPlace', { initial: null, validate: validPlace })
  const [corner, setCorner] = useState<Place>(null)
  const cornerNow = useRef<Place>(null)
  cornerNow.current = corner
  const lift = useMemo(createLifter, [])
  useLayoutEffect(() => {
    if (place != null) return undefined
    const box = document.querySelector('[data-testid="film-guide-dialog"]')
    const area = () => (document.querySelector('.kui-workspace') ?? document.documentElement).getBoundingClientRect()
    if (!box) return undefined
    if (cornerNow.current == null) {
      const size = box.getBoundingClientRect()
      const room = area()
      const shown = document.querySelector(`[data-testid="film-monitor-${monitor}"]`)?.getBoundingClientRect()
      const avoid = shown ? [{ x: shown.left, y: shown.top, width: shown.width, height: shown.height }] : []
      const at = chooseCorner({ size: { width: size.width, height: size.height }, area: { x: room.left, y: room.top, width: room.width, height: room.height }, avoid })
      cornerNow.current = at
      setCorner(at)
    }
    const grown = () => {
      const at = cornerNow.current
      const next = lift(at, box.getBoundingClientRect(), area())
      if (next === at) return
      cornerNow.current = next
      setCorner(next)
    }
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(grown) : null
    watch?.observe(box)
    return () => watch?.disconnect()
  }, [place, monitor, lift])
  return { position: place ?? corner, onMove: (at: { x: number; y: number }) => void setPlace(at) }
}

type Props = {
  dialog: GuideDialogState
  views: MonitorViews
  templates: GuideTemplates
  /** The guides an open dialog previews on its monitor (UI only, never the engine). */
  preview: ValueStore<GuidePreview>
  /** Runs a command through the editor's `invoke`, its failure thrown (the dialog shows it). */
  run: (id: string, params: Record<string, unknown>) => Promise<unknown>
  /** Upstream's `guideTemplates.apply`: the monitor takes the guides, shown. */
  applyGuides: (monitor: MonitorId, guides: readonly Guide[]) => void
  onClose: () => void
  t: T
  phrase: Phrases
}

/** The monitor's name in the strip's lines (the editor's own string). */
const monitorName = (monitor: MonitorId, t: T) => t(monitor === 'program' ? 'guides.programMonitor' : 'guides.sourceMonitor')

/**
 * Upstream's guide dialogs (`monitor_view.rs` `dialogs`): Add Guide…, Save Guides as Template…,
 * and Manage Guides…, each acting on the monitor it opened for. Upstream's have no preview; these
 * preview without the engine (guides are UI state): Add Guide draws its guide on the monitor,
 * Manage ▸ Apply draws the template's guides there until Close or Cancel, and Save lists the
 * guides it saves. The strip always lists them too, so a hidden or off-screen monitor still shows
 * the preview. Cancel ends the preview and changes nothing.
 */
export function GuideDialogs(props: Props) {
  const { dialog } = props
  if (dialog.kind === 'add') return <AddGuide key={dialog.serial} {...props} dialog={dialog} />
  if (dialog.kind === 'save') return <SaveTemplate key={dialog.serial} {...props} dialog={dialog} />
  return <ManageGuides key={dialog.serial} {...props} dialog={dialog} />
}

function Lines({ lines, testId }: { lines: readonly string[]; testId: string }) {
  return (
    <ul className="film-preview-lines" data-testid={testId}>
      {lines.map((line, index) => (
        <li key={`${index}:${line}`} className="tabular-nums">
          {line}
        </li>
      ))}
    </ul>
  )
}

/** Add Guide…: Orientation (Vertical, Horizontal) and Position; OK runs `view.addGuide`. */
function AddGuide({ dialog, preview, run, onClose, t, phrase }: Props & { dialog: Extract<GuideDialogState, { kind: 'add' }> }) {
  const { monitor } = dialog
  const [draft, setDraft] = useState<AddGuideDraft>(dialog.draft)
  const draftNow = useRef(draft)
  draftNow.current = draft
  const place = usePlace(monitor)
  const show = useCallback(() => preview.set(addGuidePreview(draftNow.current, monitor)), [preview, monitor])
  const end = useCallback(() => preview.set(null), [preview])
  useEffect(() => () => preview.set(null), [preview])
  return (
    <PreviewDialog
      title={phrase('Add Guide')}
      preview={{ begin: show, update: show, end, draft, strip: <Lines lines={[t('guides.adds', { monitor: monitorName(monitor, t), guide: guideLines([draft], t)[0] })]} testId="film-guide-dialog-lines" /> }}
      modal={false}
      position={place.position}
      onMove={place.onMove}
      ids={BUTTONS}
      testId="film-guide-dialog"
      onOk={async () => {
        await run('view.addGuide', addGuideParams(draftNow.current, monitor))
        onClose()
      }}
      onCancel={onClose}
      onReset={() => setDraft(dialog.draft)}
    >
      <div className="film-dialog" data-dialog="guides.add" data-testid="film-guide-dialog-add">
        <div className="film-dialog-row">
          <span>{phrase('Orientation:')}</span>
          <div className="film-dialog-radios" role="radiogroup" aria-label={phrase('Orientation:')}>
            {([true, false] as const).map((vertical) => (
              <label key={String(vertical)} className="kui-checkbox film-dialog-check">
                <input
                  type="radio"
                  name="film-guide-orientation"
                  checked={draft.vertical === vertical}
                  onChange={() => setDraft((shown) => ({ ...shown, vertical }))}
                  data-kit-ui-id={vertical ? GUIDE_DIALOG_IDS.vertical : GUIDE_DIALOG_IDS.horizontal}
                  data-testid={`film-guide-add-${vertical ? 'vertical' : 'horizontal'}`}
                />
                {phrase(vertical ? 'Vertical' : 'Horizontal')}
              </label>
            ))}
          </div>
        </div>
        <div className="film-dialog-row">
          <NumberField label={phrase('Position:')} value={draft.position} min={-100000} max={100000} step={1} unit="px" onChange={(position) => setDraft((shown) => ({ ...shown, position }))} uiId={GUIDE_DIALOG_IDS.position} testId="film-guide-add-position" />
        </div>
      </div>
    </PreviewDialog>
  )
}

/** Save Guides as Template…: Name; OK runs `view.guideTemplates.save {name}` with the monitor's guides. */
function SaveTemplate({ dialog, views, templates, run, onClose, t, phrase }: Props & { dialog: Extract<GuideDialogState, { kind: 'save' }> }) {
  const { monitor } = dialog
  const [name, setName] = useState(dialog.name)
  const nameNow = useRef(name)
  nameNow.current = name
  const place = usePlace(monitor)
  const list = useSyncExternalStore(templates.subscribe, templates.list)
  // What OK saves: the monitor's guides as they are (a guide dragged meanwhile included).
  const guides = views[monitor].guides
  const trimmed = name.trim()
  const lines = trimmed
    ? [t(list.some((template) => template.name === trimmed) ? 'guides.replaces' : 'guides.saves', { name: trimmed, count: guides.length }), ...guideLines(guides, t)]
    : [t('guides.needsName')]
  const nothing = useCallback(() => undefined, [])
  return (
    <PreviewDialog
      title={phrase('Save Guides as Template')}
      preview={{ begin: nothing, update: nothing, end: nothing, draft: { name, guides }, strip: <Lines lines={lines} testId="film-guide-dialog-lines" /> }}
      modal={false}
      position={place.position}
      onMove={place.onMove}
      okDisabled={!trimmed}
      ids={BUTTONS}
      testId="film-guide-dialog"
      onOk={async () => {
        await run('view.guideTemplates.save', { monitor, name: nameNow.current })
        onClose()
      }}
      onCancel={onClose}
      onReset={() => setName(dialog.name)}
    >
      <div className="film-dialog" data-dialog="guides.save" data-testid="film-guide-dialog-save">
        <label className="film-dialog-row">
          <span>{phrase('Name:')}</span>
          <input className="kui-field" type="text" value={name} autoFocus data-kui-own-enter="" onChange={(event) => setName(event.target.value)} data-kit-ui-id={GUIDE_DIALOG_IDS.name} data-testid="film-guide-save-name" />
        </label>
      </div>
    </PreviewDialog>
  )
}

/**
 * Manage Guides…: the saved templates, Apply and Delete (no confirmation, as upstream's). Upstream
 * runs each at once and Apply closes the dialog; here Apply draws the template's guides on the
 * monitor and Delete takes the template off the list, both until Close runs them (maintainer
 * decision 3) or Cancel drops them. Templates another page or an agent changes meanwhile come into
 * the list, and the actions on them are dropped with a notice; Close reads them again first.
 */
function ManageGuides({ dialog, templates, preview, applyGuides, onClose, t, phrase }: Props & { dialog: Extract<GuideDialogState, { kind: 'manage' }> }) {
  const { monitor } = dialog
  const list = useSyncExternalStore(templates.subscribe, templates.list)
  const [draft, setDraftState] = useState<ManageDraft>(() => ({ templates: list, selected: null, applied: null, deleted: [] }))
  const draftNow = useRef(draft)
  const setDraft = useCallback((next: ManageDraft) => {
    draftNow.current = next
    setDraftState(next)
  }, [])
  const [notice, setNotice] = useState<string | null>(null)
  const place = usePlace(monitor)
  // Close in flight owns the draft: its own write changes the list, which is not another's change.
  const closing = useRef(false)
  useEffect(() => {
    void templates.refresh().catch(() => undefined)
  }, [templates])
  useEffect(() => {
    if (closing.current) return
    const rebased = manageRebase(draftNow.current, list)
    if (rebased.draft === draftNow.current) return
    setDraft(rebased.draft)
    if (rebased.dropped) setNotice(t('guides.dropped', { count: rebased.dropped }))
  }, [list, setDraft, t])
  const show = useCallback(() => {
    const applied = draftNow.current.applied
    preview.set(applied ? { monitor, guides: applied.guides, replace: true } : null)
  }, [preview, monitor])
  const end = useCallback(() => preview.set(null), [preview])
  useEffect(() => () => preview.set(null), [preview])
  const shown = manageShown(draft)
  const selected = draft.selected != null && shown.some((template) => template.name === draft.selected) ? draft.selected : null
  const lines = [
    ...(draft.applied ? [t('guides.applies', { name: draft.applied.name, monitor: monitorName(monitor, t), count: draft.applied.guides.length }), ...guideLines(draft.applied.guides, t)] : []),
    ...draft.deleted.map((name) => t('guides.deletes', { name })),
  ]
  return (
    <PreviewDialog
      title={phrase('Manage Guides')}
      preview={{
        begin: show,
        update: show,
        end,
        draft: { applied: draft.applied, deleted: draft.deleted },
        strip: lines.length ? (
          <>
            <Lines lines={lines} testId="film-guide-dialog-lines" />
            <p className="film-dialog-empty kui-muted">{t('guides.pending')}</p>
          </>
        ) : undefined,
      }}
      modal={false}
      position={place.position}
      onMove={place.onMove}
      okLabel={phrase('Close')}
      ids={BUTTONS}
      testId="film-guide-dialog"
      onOk={async () => {
        closing.current = true
        try {
          const fresh = await templates.refresh()
          const rebased = manageRebase(draftNow.current, fresh)
          if (rebased.dropped) {
            setDraft(rebased.draft)
            setNotice(null)
            throw new Error(t('guides.changedBeforeClose', { count: rebased.dropped }))
          }
          const { guides } = manageCommit(rebased.draft, fresh)
          // Deleted only while each is the template the dialog showed: one another page or an
          // agent changed between the read above and the write is kept, and Close is refused.
          let dropped = 0
          if (rebased.draft.deleted.length)
            await templates.change((now) => {
              const done = manageDeletes(now, rebased.draft)
              dropped = done.dropped
              return dropped ? now : done.templates
            })
          if (dropped) {
            setDraft(manageRebase(rebased.draft, await templates.refresh()).draft)
            setNotice(null)
            throw new Error(t('guides.changedBeforeClose', { count: dropped }))
          }
          if (guides) applyGuides(monitor, guides)
          onClose()
        } finally {
          closing.current = false
        }
      }}
      onCancel={onClose}
    >
      <div className="film-dialog film-presets" data-dialog="guides.manage" data-testid="film-guide-dialog-manage">
        {notice ? (
          <p className="film-dialog-empty kui-muted" role="status" data-testid="film-guide-dialog-notice">
            {notice}
          </p>
        ) : null}
        {shown.length === 0 ? <p className="film-dialog-empty kui-muted">{phrase('No saved guide templates.')}</p> : null}
        <div className="film-presets-list" role="group" aria-label={phrase('Manage Guides')}>
          {shown.map((template) => (
            <button
              key={template.name}
              type="button"
              className="film-presets-row"
              aria-pressed={selected === template.name}
              data-applied={draft.applied?.name === template.name || undefined}
              onClick={() => setDraft({ ...draftNow.current, selected: template.name })}
              data-kit-ui-id={GUIDE_DIALOG_IDS.row}
              data-testid={`film-guide-manage-row-${template.name}`}
            >
              {template.name}
            </button>
          ))}
        </div>
        <div className="film-presets-actions">
          <Button disabled={selected == null} onClick={() => selected != null && setDraft(manageApply(draftNow.current, selected))} data-kit-ui-id={GUIDE_DIALOG_IDS.apply} data-testid="film-guide-manage-apply">
            {phrase('Apply')}
          </Button>
          <Button disabled={selected == null} onClick={() => selected != null && setDraft(manageDelete(draftNow.current, selected))} data-kit-ui-id={GUIDE_DIALOG_IDS.delete} data-testid="film-guide-manage-delete">
            {phrase('Delete')}
          </Button>
        </div>
      </div>
    </PreviewDialog>
  )
}
