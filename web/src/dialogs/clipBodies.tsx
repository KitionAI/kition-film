import { Fragment, useContext, useEffect, useRef, useState } from 'react'
import { NumberField } from '@kition/sdk/editor'
import type { DialogBodyProps } from './bodies'
import { AUDIO_GAIN_MODES, audioPeakKey, peakText, type InterpretInfo } from './clip'
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
 * Audio Gain (upstream `dialogs.rs` `audio_gain`): each mode a radio with its dB field, enabled
 * while its mode is chosen, then the selection's Peak Amplitude, read once per revision as
 * upstream caches it. While the preview is open, the peak after the gain (`clip.audioPeak` on the
 * preview's copy, read once per serial) shows next to it: Kition's, as upstream draws no preview.
 */
export function AudioGainBody({ spec, draft, set, ctx, revision, phrase, t }: DialogBodyProps) {
  // Read again for an edit or another selection only, never a playhead move; the last value
  // stays shown until the new one arrives (an older answer is dropped).
  const key = audioPeakKey(revision, ctx.film)
  const query = useRef(ctx.query)
  query.current = ctx.query
  const [peak, setPeak] = useState<unknown>(null)
  useEffect(() => {
    let live = true
    void query.current('clip.audioPeak', {}).then(
      (answer) => live && setPeak((answer as { peakDb?: unknown } | null)?.peakDb ?? null),
      () => live && setPeak(null),
    )
    return () => {
      live = false
    }
  }, [key])
  const after = usePreviewPeak()
  const peakLine = phrase('Peak Amplitude: {peak}').replace('{peak}', peakText(peak))
  return (
    <>
      <div className="film-dialog-grid">
        {AUDIO_GAIN_MODES.map(([mode, label]) => (
          <Fragment key={mode}>
            <label className="kui-checkbox film-dialog-check">
              <input type="radio" name={fieldId(spec, 'mode')} checked={draft.mode === mode} onChange={() => set('mode', mode)} data-kit-ui-id={fieldId(spec, mode)} data-testid={`film-dialog-audioGain-${mode}`} />
              {phrase(label)}
            </label>
            {/* "dB" is the field's scrub handle, as upstream's DragValue drags by its text. */}
            <NumberField label="dB" name={phrase(label)} value={Number(draft[mode]) || 0} min={-96} max={96} step={0.1} width={112} disabled={draft.mode !== mode} onChange={(value) => set(mode, value)} uiId={fieldId(spec, `${mode}.value`)} testId={`film-dialog-audioGain-${mode}-value`} />
          </Fragment>
        ))}
      </div>
      <div className="film-dialog-row">
        <span className="tabular-nums" data-kit-ui-id={fieldId(spec, 'peak')} data-testid="film-dialog-audioGain-peak">
          {peakLine}
        </span>
        {after ? (
          <span className="film-dialog-after tabular-nums" data-testid="film-dialog-audioGain-after" data-serial={after.serial}>
            {t('preview.afterGain', { peak: peakText(after.value) })}
          </span>
        ) : null}
      </div>
    </>
  )
}

/** The open preview's selection peak (`previewQuery('clip.audioPeak')`), keyed on its document and serial (lesson 6); null while none is open. */
function usePreviewPeak(): { serial: number; value: unknown } | null {
  const context = useContext(PreviewContext)
  const state = usePreviewState()
  const [read, setRead] = useState<{ serial: number; document: number; value: unknown } | null>(null)
  useEffect(() => {
    const engine = state.open ? context?.preview.engine() : null
    if (!engine) return undefined
    let live = true
    const { serial, document } = state
    void engine.invoke('previewQuery', 'clip.audioPeak', '{}').then(
      (raw) => {
        const now = context?.preview.get()
        if (live && now?.open && now.serial === serial && now.document === document) setRead({ serial, document, value: (parse(raw) as { peakDb?: unknown } | null)?.peakDb })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [context, state.open, state.serial, state.document])
  return state.open && read && read.serial === state.serial && read.document === state.document ? { serial: read.serial, value: read.value } : null
}

/**
 * Interpret Footage (upstream `color_dialogs.rs`, Color Management): how many items, the colour
 * space the first one's metadata gives, and the override, Use file metadata or one colour space,
 * in a list that scrolls past 300 px as upstream's.
 */
export function InterpretBody({ spec, draft, set, phrase }: DialogBodyProps) {
  const info = (draft.info ?? { detected: '—', spaces: [] }) as InterpretInfo
  const count = Array.isArray(draft.items) ? draft.items.length : 0
  const radio = (value: string, label: string, id: string) => (
    <label key={value} className="kui-checkbox film-dialog-check">
      <input type="radio" name={fieldId(spec, 'space')} checked={draft.colorSpace === value} onChange={() => set('colorSpace', value)} data-kit-ui-id={id} data-testid={`film-dialog-colorDialog-space-${value}`} />
      {label}
    </label>
  )
  return (
    <>
      <h3 className="film-dialog-heading">{phrase(count === 1 ? 'Color Management · {n} item' : 'Color Management · {n} items').replace('{n}', String(count))}</h3>
      <p className="film-dialog-empty" data-testid="film-dialog-colorDialog-detected">
        {phrase('Media colour space (from file metadata): {detected}').replace('{detected}', info.detected)}
      </p>
      <span>{phrase('Override media colour space:')}</span>
      <div className="film-dialog-radios" role="radiogroup" aria-label={phrase('Override media colour space:')}>
        {radio('auto', phrase('Use file metadata'), fieldId(spec, 'space.auto'))}
        <div className="film-dialog-radios film-dialog-scroll">{info.spaces.map(([value, label]) => radio(value, label, fieldId(spec, 'space')))}</div>
      </div>
    </>
  )
}
