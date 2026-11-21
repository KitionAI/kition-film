import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ColorPicker, NumberField, TimecodeField, parseHex, rgbToHex, type Phrases } from '@kition/sdk/editor'
import { isHiddenField } from '../menus/hidden'
import { framesTimecode } from './clipStructure'
import { closesPicker, pickerPlace } from './placement'
import { changedDraft, dialogFps, fieldId, optionId, optionsOf, optionText, shownValue, type DialogContext, type DialogSpec, type Draft, type FieldRow } from './registry'

export type FieldsProps = {
  spec: DialogSpec
  rows: readonly FieldRow[]
  draft: Draft
  /** Sets one field of the draft. */
  set: (field: string, value: unknown) => void
  ctx: DialogContext
  phrase: Phrases
}

const testIdOf = (spec: DialogSpec, field: string) => `film-dialog-${spec.prefix}-${field.replaceAll('.', '-')}`

/**
 * Upstream's dialog rows (`clip_dialogs.rs` `number`, `check`, `text`, the radios, the tabs, and
 * the others' `ui.horizontal` rows): each with upstream's label through `phrase()` and the id
 * `control:dialog.<prefix>.<field>` (a radio's options and a tab one each). A field the web
 * hides (`isHiddenField`) is not drawn.
 */
export function DialogFields({ spec, rows, draft, set, ctx, phrase }: FieldsProps) {
  return (
    <>
      {rows.map((row, index) => (
        <Row key={'field' in row ? row.field : `${row.kind}-${index}`} spec={spec} row={row} draft={draft} set={set} ctx={ctx} phrase={phrase} />
      ))}
    </>
  )
}

/** A readout's value: at once, or once its read answers (a newer draft's answer wins; an older one is dropped). */
function Readout({ spec, row, draft, ctx, phrase }: { spec: DialogSpec; row: Extract<FieldRow, { kind: 'readout' }>; draft: Draft; ctx: DialogContext; phrase: Phrases }) {
  // Read again only for a new draft or document, not on every render.
  const answer = useMemo(() => row.value(draft, ctx), [row, draft, ctx])
  const [read, setRead] = useState<string | null>(null)
  useEffect(() => {
    if (!(answer instanceof Promise)) return undefined
    let current = true
    void answer.then(
      (value) => current && setRead(value),
      () => current && setRead(null),
    )
    return () => {
      current = false
    }
  }, [answer])
  const value = answer instanceof Promise ? read : answer
  if (value == null) return null
  if (row.plain)
    return (
      <p className="film-dialog-label" data-testid={`film-dialog-${spec.prefix}-${row.testId}`}>
        {phrase(row.label)} {value}
      </p>
    )
  return (
    <div className="film-dialog-row">
      <span>{phrase(row.label)}</span>
      <span className="film-dialog-readout tabular-nums" data-testid={`film-dialog-${spec.prefix}-${row.testId}`}>
        {value}
      </span>
    </div>
  )
}

/**
 * Upstream's colour row (`menu_dialogs.rs` `color`, egui's `color_edit_button_srgb`): a swatch
 * that opens the colour picker in a pop-up beside the dialog (`pickerPlace`: never over its
 * title), then the `#rrggbb` it holds. The pop-up is drawn over the page, so the dialog keeps its
 * size, and follows the dialog when it is moved; a press outside it or Escape closes it (Escape
 * there does not cancel the dialog; an input method's Escape is the input method's).
 */
function ColorField({ id, testId, label, value, disabled, onChange }: { id: string; testId: string; label: string; value: string; disabled: boolean; onChange: (hex: string) => void }) {
  const [at, setAt] = useState<{ left: number; top: number; host: Element } | null>(null)
  const swatch = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const open = at != null
  useEffect(() => {
    if (!open) return undefined
    const escape = (event: KeyboardEvent) => {
      if (!closesPicker(event)) return
      event.stopPropagation()
      event.preventDefault()
      setAt(null)
    }
    const away = (event: PointerEvent) => {
      const target = event.target as Node
      if (!popup.current?.contains(target) && !swatch.current?.contains(target)) setAt(null)
    }
    window.addEventListener('keydown', escape, true)
    window.addEventListener('pointerdown', away, true)
    return () => {
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('pointerdown', away, true)
    }
  }, [open])
  // Beside the dialog, measured each animation frame while open, so it follows a dialog being
  // moved by its title; set only when it moves (half a pixel or more).
  useLayoutEffect(() => {
    if (!open) return undefined
    let frame = 0
    const follow = () => {
      const box = popup.current?.getBoundingClientRect()
      const button = swatch.current?.getBoundingClientRect()
      const dialog = swatch.current?.closest('.kui-dialog')
      if (box && button && dialog) {
        const edges = dialog.getBoundingClientRect()
        const header = dialog.querySelector('h2')?.getBoundingClientRect().bottom ?? edges.top
        const next = pickerPlace({ swatch: button, dialog: edges, header, size: { width: box.width, height: box.height }, view: { width: window.innerWidth, height: window.innerHeight } })
        setAt((shown) => (shown && (Math.abs(next.top - shown.top) > 0.5 || Math.abs(next.left - shown.left) > 0.5) ? { ...shown, ...next } : shown))
      }
      frame = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [open])
  const toggle = () => {
    const button = swatch.current
    if (open || !button) return setAt(null)
    const rect = button.getBoundingClientRect()
    setAt({ left: rect.left, top: rect.bottom + 4, host: button.closest('.kui-app') ?? document.body })
  }
  const rgb = parseHex(value) ?? [0, 0, 0]
  return (
    <div className="film-dialog-row">
      <span>{label}</span>
      <button ref={swatch} type="button" className="film-dialog-swatch" style={{ background: rgbToHex(rgb) }} aria-label={label} title={label} aria-expanded={open} disabled={disabled} onClick={toggle} data-kit-ui-id={id} data-testid={testId} />
      <span className="film-dialog-readout tabular-nums" data-testid={`${testId}-hex`}>
        {value}
      </span>
      {at
        ? createPortal(
            <div ref={popup} className="film-dialog-color-picker" style={{ left: at.left, top: at.top }} data-testid={`${testId}-popup`}>
              <ColorPicker value={rgb} disabled={disabled} onChange={(next) => onChange(rgbToHex(next))} uiId={id} testId={`${testId}-picker`} />
            </div>,
            at.host,
          )
        : null}
    </div>
  )
}

/** A box per option, each adding its value to the draft's list or taking it out, in the order checked (upstream's `retain` then `push`). */
function Checklist({ spec, row, draft, set, ctx, phrase }: Omit<FieldsProps, 'rows'> & { row: Extract<FieldRow, { kind: 'checklist' }> }) {
  const options = optionsOf(row.options, draft, ctx)
  const list = Array.isArray(draft[row.field]) ? (draft[row.field] as unknown[]) : []
  const disabled = row.enabled ? !row.enabled(draft, ctx) : false
  if (options.length === 0) return <p className="kui-muted film-dialog-empty">{phrase(row.empty)}</p>
  return (
    <div className="film-dialog-radios" role="group" aria-label={phrase(row.label)}>
      {options.map((option) => {
        const [value] = option
        return (
        <label key={value} className="kui-checkbox film-dialog-check" data-disabled={disabled || undefined}>
          <input
            type="checkbox"
            checked={list.includes(value)}
            disabled={disabled}
            onChange={(event) => set(row.field, [...list.filter((each) => each !== value), ...(event.target.checked ? [value] : [])])}
            data-kit-ui-id={fieldId(spec, row.item)}
            data-testid={`${testIdOf(spec, row.item)}-${value}`}
          />
          {optionText(option, phrase)}
        </label>
        )
      })}
    </div>
  )
}

function Row({ spec, row, draft, set, ctx, phrase }: Omit<FieldsProps, 'rows'> & { row: FieldRow }) {
  if (row.kind === 'heading') return <h3 className="film-dialog-heading">{phrase(row.label)}</h3>
  if (row.kind === 'separator') return <hr className="film-dialog-separator" />
  if (row.kind === 'readout') return <Readout spec={spec} row={row} draft={draft} ctx={ctx} phrase={phrase} />
  if ((row.kind === 'row' || row.kind === 'section') && row.shown && !row.shown(draft)) return null
  if (row.kind === 'row')
    return (
      <div className="film-dialog-row" data-disabled={row.enabled === false || undefined}>
        {row.label ? <span>{phrase(row.label)}</span> : null}
        <DialogFields spec={spec} rows={row.rows} draft={draft} set={set} ctx={ctx} phrase={phrase} />
      </div>
    )
  if (row.kind === 'section')
    return (
      <fieldset className="film-dialog-group film-dialog-section">
        <legend>{phrase(row.label)}</legend>
        <DialogFields spec={spec} rows={row.rows} draft={draft} set={set} ctx={ctx} phrase={phrase} />
      </fieldset>
    )
  if (row.kind === 'tabs') {
    const shown = row.tabs.filter((tab) => !isHiddenField(`${spec.prefix}.${row.field}.${tab.id}`))
    const active = shown.find((tab) => tab.id === draft[row.field]) ?? shown[0]
    return (
      <div className="film-dialog-tabs">
        {/* Pinned over the tab's rows, which scroll under it in a tall tab. */}
        <div className="film-dialog-pinned" data-testid={`film-dialog-${spec.prefix}-pinned`}>
          {row.lead ? <DialogFields spec={spec} rows={row.lead} draft={draft} set={set} ctx={ctx} phrase={phrase} /> : null}
          <div className="film-about-tabs" role="tablist">
            {shown.map((tab) => (
              <button key={tab.id} type="button" role="tab" className="film-about-tab" aria-selected={tab === active} onClick={() => set(row.field, tab.id)} data-kit-ui-id={fieldId(spec, `${row.field}.${tab.id}`)} data-testid={testIdOf(spec, `${row.field}.${tab.id}`)}>
                {phrase(tab.label)}
              </button>
            ))}
          </div>
        </div>
        {active ? (
          <div className="film-dialog" role="tabpanel">
            <DialogFields spec={spec} rows={active.rows} draft={draft} set={set} ctx={ctx} phrase={phrase} />
          </div>
        ) : null}
      </div>
    )
  }
  if (isHiddenField(`${spec.prefix}.${row.field}`)) return null
  if (row.shown && !row.shown(draft)) return null
  if (row.kind === 'checklist') return <Checklist spec={spec} row={row} draft={draft} set={set} ctx={ctx} phrase={phrase} />
  const id = fieldId(spec, row.field)
  const testId = testIdOf(spec, row.field)
  const disabled = row.enabled ? !row.enabled(draft, ctx) : false
  const value = shownValue(row, draft, ctx)
  const label = phrase(row.label)
  // Upstream's hover text on a greyed field.
  const hint = disabled && row.hint ? phrase(row.hint) : undefined
  // A field whose setting changes more than its own key sets each key it changes.
  const put = (next: unknown) => {
    if (!row.change) return set(row.field, next)
    const after = changedDraft(row, draft, next, ctx)
    for (const key of Object.keys(after)) if (after[key] !== draft[key]) set(key, after[key])
  }
  switch (row.kind) {
    case 'number':
      return (
        <div className="film-dialog-row">
          <NumberField
            label={row.bare ? '' : label}
            name={row.bare ? label : undefined}
            value={Number(value) || 0}
            min={row.min}
            max={row.max}
            step={row.step}
            unit={row.suffix || row.unit ? [row.suffix, row.unit ? phrase(row.unit) : ''].filter(Boolean).join(' ') : undefined}
            width={row.width}
            disabled={disabled}
            onChange={(next) => put(next)}
            uiId={id}
            testId={testId}
          />
        </div>
      )
    case 'fixed': {
      const text = row.text(draft, ctx)
      if (row.look === 'text')
        return (
          <span className="film-dialog-readout tabular-nums" data-kit-ui-id={id} data-testid={testId}>
            {text}
          </span>
        )
      const tip = row.hint ? phrase(row.hint) : undefined
      return (
        <label className="film-dialog-row" data-disabled title={tip}>
          {row.label && !row.labelAfter ? <span>{label}</span> : null}
          {row.look === 'list' ? (
            <select className="kui-field" disabled title={tip} aria-label={label} style={row.width ? { flex: 'none', width: row.width } : undefined} data-kit-ui-id={id} data-testid={testId}>
              <option>{phrase(text)}</option>
            </select>
          ) : (
            <button type="button" className="kui-button film-dialog-fixed" disabled title={tip} aria-label={label} data-kit-ui-id={id} data-testid={testId}>
              {text}
            </button>
          )}
          {row.label && row.labelAfter ? <span className="film-dialog-after-label">{label}</span> : null}
        </label>
      )
    }
    case 'inert': {
      // The hint on the button itself (its title and description), and on its wrapper, which
      // shows it where a browser gives a disabled button no hover.
      const tip = row.hint ? phrase(row.hint) : undefined
      return (
        <span title={tip}>
          <button type="button" className="kui-button" disabled title={tip} {...(tip ? { 'aria-description': tip } : {})} data-kit-ui-id={id} data-testid={testId}>
            {label}
          </button>
        </span>
      )
    }
    case 'frames':
      return (
        <div className="film-dialog-row">
          <NumberField label={label} value={Math.trunc(Number(value) || 0)} min={0} max={Number.MAX_SAFE_INTEGER / 4} step={1} unit="fr" disabled={disabled} onChange={(next) => put(Math.max(0, Math.round(next)))} uiId={id} testId={testId} />
          <span className="film-dialog-readout kui-muted tabular-nums" data-testid={`${testId}-timecode`}>
            {framesTimecode(Number(value) || 0, row.fps(draft))}
          </span>
        </div>
      )
    case 'timecode':
      return (
        <div className="film-dialog-row">
          <span>{label}</span>
          <TimecodeField label={label} value={Number(value) || 0} fps={dialogFps(ctx)} dropFrame={ctx.film?.dropFrame} onChange={(seconds) => put(seconds)} uiId={id} testId={testId} />
        </div>
      )
    case 'check':
      return (
        <label className="kui-checkbox film-dialog-check" data-disabled={disabled || undefined} title={hint}>
          <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => put(event.target.checked)} data-kit-ui-id={id} data-testid={testId} />
          {label}
        </label>
      )
    case 'radio':
      return (
        <div className="film-dialog-radios" role="radiogroup" aria-label={label}>
          {optionsOf(row.options, draft, ctx).map((each) => {
            const [option] = each
            return (
            <label key={option} className="kui-checkbox film-dialog-check" data-disabled={disabled || undefined}>
              <input type="radio" name={id} checked={value === option} disabled={disabled} onChange={() => put(option)} data-kit-ui-id={optionId(spec, row.field, option)} data-testid={`${testId}-${option}`} />
              {optionText(each, phrase)}
            </label>
            )
          })}
        </div>
      )
    case 'choice':
      return (
        <label className="film-dialog-row" data-disabled={disabled || undefined} title={hint}>
          {row.bare ? null : <span>{label}</span>}
          <select className="kui-field" value={String(value ?? '')} disabled={disabled} aria-label={row.bare ? label : undefined} style={row.width ? { flex: 'none', width: row.width } : undefined} onChange={(event) => put(event.target.value)} data-kit-ui-id={id} data-testid={testId}>
            {optionsOf(row.options, draft, ctx).map((each) => (
              <option key={each[0]} value={each[0]}>
                {optionText(each, phrase)}
              </option>
            ))}
            {(row.disabledOptions ?? []).map((text) => (
              <option key={`disabled-${text}`} disabled title={row.hint ? phrase(row.hint) : undefined}>
                {phrase(text)}
              </option>
            ))}
          </select>
        </label>
      )
    case 'text':
      return (
        <label className="film-dialog-row">
          {row.bare ? null : <span>{label}</span>}
          <input className="kui-field" type="text" value={String(value ?? '')} disabled={disabled} autoFocus={row.autoFocus} aria-label={row.bare ? label : undefined} style={row.width ? { flex: 'none', width: row.width, boxSizing: 'border-box' } : undefined} onChange={(event) => put(event.target.value)} data-kit-ui-id={id} data-testid={testId} />
        </label>
      )
    case 'multiline':
      return (
        <label className="film-dialog-row film-dialog-multiline">
          <span>{label}</span>
          <textarea className="kui-field" value={String(value ?? '')} disabled={disabled} onChange={(event) => put(event.target.value)} data-kit-ui-id={id} data-testid={testId} />
        </label>
      )
    case 'color':
      return <ColorField id={id} testId={testId} label={label} value={String(value ?? '')} disabled={disabled} onChange={put} />
  }
}
