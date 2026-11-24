import { useEffect, useMemo, useState } from 'react'
import { Button, Dialog, NumberField } from '@kition/sdk/editor'
import type { ExportOptions, ExportProgress } from '../movie'
import {
  BITRATE_MAX_MBPS,
  BITRATE_MIN_MBPS,
  EXPORT_HEIGHTS,
  EXPORT_RATES,
  exportOptions,
  exportRate,
  exportSize,
  frameOf,
  initialDraft,
  rateText,
  sequenceOf,
  type ExportDraft,
  type ExportSequence,
} from './exportModel'

type Strings = (key: string, values?: Record<string, string | number>) => string

/** Where the export the dialog started is: being set up, running, done, failed, or cancelled. */
export type ExportJob = { phase: 'setup' } | { phase: 'running'; progress: ExportProgress } | { phase: 'done'; name: string } | { phase: 'failed'; message: string } | { phase: 'cancelled' }

export type ExportDialogProps = {
  /** The project's sequences, in the project's order. */
  sequences: ReadonlyArray<{ id: number; name: string }>
  /** The active sequence, which the dialog opens on. */
  active: number | null
  /** `sequence.inspect` of a sequence (its size, rate, In and Out), or null when it fails. */
  inspect: (sequence: number) => Promise<unknown>
  /** The file the export writes (the project's name, `.mp4`). */
  target: string
  job: ExportJob
  onStart: (options: ExportOptions, sequence: string) => void
  onCancel: () => void
  onClose: () => void
  t: Strings
}

/** The engine's `format_eta`: `12 s`, `3:04`, `1:02:03`. */
function eta(seconds: number) {
  const s = Math.ceil(Math.max(0, seconds))
  const two = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)}:${two(s % 60)}`
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
}

/** One labelled drop-down of the dialog. */
function Row<V extends string>({ label, value, choices, disabled, onChange, field }: { label: string; value: V; choices: ReadonlyArray<readonly [V, string, boolean?]>; disabled: boolean; onChange: (value: V) => void; field: string }) {
  return (
    <label className="film-dialog-row film-export-row">
      <span>{label}</span>
      <select className="kui-field" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as V)} data-kit-ui-id={`control:export.${field}`} data-testid={`film-export-${field}`}>
        {choices.map(([key, text, off]) => (
          <option key={key} value={key} disabled={off}>
            {text}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * File ▸ Export ▸ Media… (plan "Film usable by hand", phase 6, C3): which sequence (the active one
 * first, by name), the whole sequence or In to Out, the frame size and rate (the sequence's, or a
 * preset of the same shape), the quality (the default, constant quality, or a bitrate), and the
 * file it writes beside the project. Export starts `file.exportMedia` with those parameters; while
 * it runs the dialog shows its progress, percentage and time left, and Cancel stops the job; then
 * it says the file was written or why not. The app bar's Export MP4 keeps its one click.
 */
export function ExportDialog({ sequences, active, inspect, target, job, onStart, onCancel, onClose, t }: ExportDialogProps) {
  const [draft, setDraft] = useState<ExportDraft>(() => ({ ...initialDraft(null), sequence: active ?? sequences[0]?.id ?? null }))
  const [shown, setShown] = useState<ExportSequence | null>(null)
  const [opened, setOpened] = useState(false)
  const chosen = draft.sequence
  const name = sequences.find((each) => each.id === chosen)?.name ?? ''
  // The chosen sequence's settings and marks, read when it is chosen; the first one read sets the range.
  useEffect(() => {
    if (chosen == null) return
    let open = true
    void inspect(chosen).then((answer) => {
      if (!open) return
      const read = sequenceOf(chosen, name, answer)
      setShown(read)
      if (read)
        setDraft((now) => (opened ? { ...now, range: read.hasInOut ? now.range : 'entire' } : { ...now, range: read.hasInOut ? 'inOut' : 'entire' }))
      setOpened(true)
    })
    return () => {
      open = false
    }
    // `opened` and `name` are read, not watched: a new choice of sequence reads again.
  }, [chosen, inspect])
  const running = job.phase === 'running'
  const put = (patch: Partial<ExportDraft>) => setDraft((now) => ({ ...now, ...patch }))
  const sizes = useMemo(() => {
    const base = shown ?? { width: 16, height: 9 }
    return [
      ['sequence', shown ? t('export.size.sequence', { width: shown.width, height: shown.height }) : t('export.asSequence')] as const,
      ...EXPORT_HEIGHTS.map((height) => {
        const frame = frameOf(base, Number(height))
        return [height, `${frame.width} × ${frame.height}`] as const
      }),
    ]
  }, [shown, t])
  const rates = useMemo(() => [['sequence', shown ? t('export.rate.sequence', { fps: rateText(shown.fps) }) : t('export.asSequence')] as const, ...EXPORT_RATES.map((rate) => [rate, `${rate} fps`] as const)], [shown, t])
  const summary = shown ? (() => {
    const size = exportSize(draft, shown)
    return t('export.summary', { width: size.width, height: size.height, fps: rateText(exportRate(draft, shown)) })
  })() : ''
  const fraction = job.phase === 'running' ? Math.min(1, Math.max(0, job.progress.fraction)) : 0
  const percent = Math.round(fraction * 100)
  const left = job.phase === 'running' && job.progress.secondsLeft != null ? t('export.left', { time: eta(job.progress.secondsLeft) }) : ''
  const actions = running ? (
    <>
      <Button onClick={onClose} data-testid="film-export-hide" data-kit-ui-id="control:export.hide">
        {t('export.hide')}
      </Button>
      <Button variant="primary" onClick={onCancel} data-testid="film-export-cancel" data-kit-ui-id="control:export.cancel">
        {t('export.cancel')}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose} data-testid="film-export-close" data-kit-ui-id="control:export.close">
        {t('close')}
      </Button>
      <Button variant="primary" disabled={!shown} onClick={() => shown && onStart(exportOptions(draft, shown), name)} data-testid="film-export-start" data-kit-ui-id="control:export.start">
        {t('export.start')}
      </Button>
    </>
  )
  return (
    <Dialog title={t('export.title')} actions={actions} onClose={onClose} testId="film-export-dialog" uiId="control:export.dialog">
      <div className="film-export" data-testid="film-export-body">
        <Row
          field="sequence"
          label={t('export.sequence')}
          value={String(chosen ?? '')}
          disabled={running}
          choices={sequences.map((each) => [String(each.id), each.id === active ? t('export.active', { name: each.name }) : each.name] as const)}
          onChange={(value) => put({ sequence: Number(value) })}
        />
        <Row
          field="range"
          label={t('export.range')}
          value={draft.range}
          disabled={running}
          choices={[
            ['entire', t('export.range.entire')],
            ['inOut', shown?.hasInOut ? t('export.range.inOut') : t('export.range.noInOut'), !shown?.hasInOut],
          ]}
          onChange={(range) => put({ range })}
        />
        <Row field="size" label={t('export.size')} value={draft.size} disabled={running} choices={sizes} onChange={(size) => put({ size })} />
        <Row field="rate" label={t('export.rate')} value={draft.rate} disabled={running} choices={rates} onChange={(rate) => put({ rate })} />
        <Row
          field="quality"
          label={t('export.quality')}
          value={draft.quality}
          disabled={running}
          choices={[
            ['default', t('export.quality.default')],
            ['high', t('export.quality.high')],
            ['medium', t('export.quality.medium')],
            ['small', t('export.quality.small')],
            ['bitrate', t('export.quality.bitrate')],
          ]}
          onChange={(quality) => put({ quality })}
        />
        {draft.quality === 'bitrate' ? (
          <div className="film-dialog-row film-export-row">
            <NumberField label={t('export.bitrate')} value={draft.bitrateMbps} min={BITRATE_MIN_MBPS} max={BITRATE_MAX_MBPS} step={0.5} unit="Mb/s" disabled={running} onChange={(value) => put({ bitrateMbps: value })} uiId="control:export.bitrate" testId="film-export-bitrate" />
          </div>
        ) : null}
        <p className="film-export-target" data-testid="film-export-target">
          {t('export.target', { name: target })}
        </p>
        {summary ? (
          <p className="kui-muted film-export-summary" data-testid="film-export-summary">
            {summary}
          </p>
        ) : null}
        {job.phase === 'running' ? (
          <div className="film-export-progress" data-testid="film-export-progress">
            <span className="film-status-job-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} data-kit-ui-id="control:export.progress" data-testid="film-export-progress-bar">
              <span style={{ width: `${fraction * 100}%` }} />
            </span>
            <span data-testid="film-export-progress-text">{`${t('export.running', { sequence: name })} ${percent}%${left}`}</span>
          </div>
        ) : null}
        {job.phase === 'done' ? (
          <p className="film-export-result" data-result="done" data-testid="film-export-result">
            {t('export.done', { name: job.name })}
          </p>
        ) : job.phase === 'failed' ? (
          <p className="film-export-result" data-result="failed" data-testid="film-export-result">
            {t('export.failed', { message: job.message })}
          </p>
        ) : job.phase === 'cancelled' ? (
          <p className="film-export-result" data-result="cancelled" data-testid="film-export-result">
            {t('export.cancelled')}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
