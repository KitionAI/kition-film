import { memo, useCallback, useRef } from 'react'
import { TesseraIcons } from '@kition/sdk/editor'
import { Button, type Phrases } from '@kition/sdk/editor'
import type { DialogBodyProps } from './bodies'
import { addProperty, columnsOf, fieldViews, keepSlots, manageAction, managedSlots, moveColumn, selectedOf, stepsOf, toggleColumn, type FieldView, type ManageAction, type PresetSlot } from './project'
import { fieldId } from './registry'

const ChevronDown = TesseraIcons.ChevronDownIcon
const ChevronUp = TesseraIcons.ChevronUpIcon

/** One Project Metadata row (lesson 5): memoized, with the body's stable `toggle`, so a check draws that row again only. */
const FieldRow = memo(function FieldRow({ view, uiId, toggle, phrase }: { view: FieldView; uiId: string; toggle: (name: string, on: boolean) => void; phrase: Phrases }) {
  return (
    <label className="kui-checkbox film-dialog-check film-columns-field">
      <input type="checkbox" checked={view.on} disabled={view.locked} onChange={(event) => toggle(view.name, event.target.checked)} data-kit-ui-id={uiId} data-testid={`film-dialog-metadata-field-${view.name}`} />
      <span>{phrase(view.name)}</span>
    </label>
  )
})

/** One Column order row: ▲ from the third row, ▼ from the second to the last but one (upstream's), memoized with the body's stable `move`. */
const OrderRow = memo(function OrderRow({ name, index, canUp, canDown, ids, move, phrase }: { name: string; index: number; canUp: boolean; canDown: boolean; ids: { up: string; down: string }; move: (index: number, delta: -1 | 1) => void; phrase: Phrases }) {
  return (
    <div className="film-columns-order-row" data-testid={`film-dialog-metadata-order-${index}`}>
      <button type="button" className="film-columns-move" disabled={!canUp} aria-label={phrase('Move up')} title={phrase('Move up')} onClick={() => move(index, -1)} data-kit-ui-id={ids.up} data-testid={`film-dialog-metadata-up-${name}`}>
        <ChevronUp size={12} aria-hidden="true" />
      </button>
      <button type="button" className="film-columns-move" disabled={!canDown} aria-label={phrase('Move down')} title={phrase('Move down')} onClick={() => move(index, 1)} data-kit-ui-id={ids.down} data-testid={`film-dialog-metadata-down-${name}`}>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <span className="film-columns-name">{phrase(name)}</span>
    </div>
  )
})

/**
 * Metadata Display (upstream `project_dialogs.rs` `metadata_display`, a fixed 480 × 470 window):
 * Show: with the field search, then every field checked when shown (Name greyed) with Add
 * Property… under it, beside the shown columns in order with ▲ and ▼. The search's Enter is its
 * own (upstream's runs nothing), so it never presses OK.
 */
export function MetadataDisplayBody({ spec, draft, set, phrase }: DialogBodyProps) {
  const columns = columnsOf(draft)
  const filter = typeof draft.filter === 'string' ? draft.filter : ''
  const all = ((draft.info as { all?: string[] } | null | undefined)?.all ?? []) as string[]
  const columnsNow = useRef(columns)
  columnsNow.current = columns
  const toggle = useCallback((name: string, on: boolean) => set('columns', toggleColumn(columnsNow.current, name, on)), [set])
  const move = useCallback((index: number, delta: -1 | 1) => set('columns', moveColumn(columnsNow.current, index, delta)), [set])
  const views = useRef<FieldView[]>([])
  views.current = fieldViews(views.current, all, columns, filter)
  const fieldUi = fieldId(spec, 'field')
  const ids = useRef({ up: fieldId(spec, 'up'), down: fieldId(spec, 'down') }).current
  return (
    <div className="film-columns" data-testid="film-dialog-metadata">
      <div className="film-dialog-row">
        <span>{phrase('Show:')}</span>
        <input className="kui-field" type="search" value={filter} placeholder={phrase('Search fields')} aria-label={phrase('Search fields')} data-kui-own-enter="" onChange={(event) => set('filter', event.target.value)} data-kit-ui-id={fieldId(spec, 'filter')} data-testid="film-dialog-metadata-filter" />
      </div>
      <div className="film-columns-lists">
        <div className="film-columns-list">
          <strong>{phrase('Project Metadata')}</strong>
          <div className="film-columns-scroll" data-testid="film-dialog-metadata-fields">
            {views.current.map((view) => (
              <FieldRow key={view.name} view={view} uiId={fieldUi} toggle={toggle} phrase={phrase} />
            ))}
          </div>
          <div>
            <Button onClick={() => set('columns', addProperty(columns, filter))} data-kit-ui-id={fieldId(spec, 'addProperty')} data-testid="film-dialog-metadata-addProperty">
              {phrase('Add Property…')}
            </Button>
          </div>
        </div>
        <div className="film-columns-list">
          <strong>{phrase('Column order')}</strong>
          <div className="film-columns-scroll" data-testid="film-dialog-metadata-order">
            {columns.map((name, index) => (
              <OrderRow key={name} name={name} index={index} canUp={index > 1} canDown={index > 0 && index + 1 < columns.length} ids={ids} move={move} phrase={phrase} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** One view preset slot (`{n}. name` or `{n}. (empty)`), memoized with the body's stable `choose`. */
const PresetRow = memo(function PresetRow({ slot, chosen, uiId, choose, phrase }: { slot: PresetSlot; chosen: boolean; uiId: string; choose: (slot: number) => void; phrase: Phrases }) {
  const label = slot.name != null ? `${slot.slot}. ${slot.name}` : phrase('{n}. (empty)').replace('{n}', String(slot.slot))
  return (
    <button type="button" className="film-presets-row" aria-pressed={chosen} data-empty={slot.name == null || undefined} onClick={() => choose(slot.slot)} data-kit-ui-id={uiId} data-testid={`film-dialog-presets-slot-${slot.slot}`}>
      {label}
    </button>
  )
})

/**
 * Manage Saved View Presets (upstream `project_dialogs.rs` `manage_presets`): the ten slots, the
 * selected one's Name with Rename, then Restore, Delete, and Overwrite with Current View. Each
 * action joins the steps the preview runs (the list shows the slots after them, the Project panel
 * the view), and Done runs them for real, in order; upstream runs each at once. The name's Enter
 * is its own (upstream's runs nothing), so it never presses Done.
 */
export function ManagePresetsBody({ spec, draft, set, phrase, t }: DialogBodyProps) {
  // Each slot the object it had while it shows the same, so its memoized row draws again only when it changes.
  const kept = useRef<PresetSlot[]>([])
  kept.current = keepSlots(kept.current, managedSlots(draft))
  const slots = kept.current
  const selected = selectedOf(draft)
  const filled = slots.find((each) => each.slot === selected)?.name != null
  const name = typeof draft.name === 'string' ? draft.name : ''
  const draftNow = useRef(draft)
  draftNow.current = draft
  const choose = useCallback(
    (slot: number) => {
      if (selectedOf(draftNow.current) === slot) return
      set('selected', slot)
      set('name', managedSlots(draftNow.current).find((each) => each.slot === slot)?.name ?? '')
    },
    [set],
  )
  const act = (action: ManageAction) => {
    const next = manageAction(draftNow.current, action)
    if (next === draftNow.current) return
    set('steps', next.steps)
    set('name', next.name)
  }
  const pending = stepsOf(draft).length
  const uiId = fieldId(spec, 'preset')
  return (
    <div className="film-presets" data-testid="film-dialog-presets">
      <div className="film-presets-list" role="group" aria-label={phrase('Manage Saved View Presets')}>
        {slots.map((slot) => (
          <PresetRow key={slot.slot} slot={slot} chosen={slot.slot === selected} uiId={uiId} choose={choose} phrase={phrase} />
        ))}
      </div>
      <div className="film-dialog-row">
        <span>{phrase('Name:')}</span>
        <input className="kui-field" type="text" value={name} disabled={!filled} data-kui-own-enter="" onChange={(event) => set('name', event.target.value)} aria-label={phrase('Name')} data-kit-ui-id={fieldId(spec, 'name')} data-testid="film-dialog-presets-name" />
        <Button disabled={!filled || !name.trim()} onClick={() => act('rename')} data-kit-ui-id={fieldId(spec, 'rename')} data-testid="film-dialog-presets-rename">
          {phrase('Rename')}
        </Button>
      </div>
      <div className="film-presets-actions">
        <Button disabled={!filled} onClick={() => act('restore')} data-kit-ui-id={fieldId(spec, 'restore')} data-testid="film-dialog-presets-restore">
          {phrase('Restore')}
        </Button>
        <Button disabled={!filled} onClick={() => act('delete')} data-kit-ui-id={fieldId(spec, 'delete')} data-testid="film-dialog-presets-delete">
          {phrase('Delete')}
        </Button>
        <Button onClick={() => act('overwrite')} data-kit-ui-id={fieldId(spec, 'overwrite')} data-testid="film-dialog-presets-overwrite">
          {phrase('Overwrite with Current View')}
        </Button>
      </div>
      {pending ? (
        <p className="film-dialog-empty kui-muted" data-testid="film-dialog-presets-pending">
          {t('viewPreset.pending', { count: pending })}
        </p>
      ) : null}
    </div>
  )
}
