import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { TesseraIcons } from '@kition/sdk/editor'
import type { KitEngine, Phrases } from '@kition/sdk/editor'
import { useProgramTime, type Playback } from '../session/playback'
import type { InvokeOptions } from '../session/invoke'
import { TICKS_PER_SECOND, type FilmInfo } from '../film'
import type { FilmLabels } from '../session/useFilmSession'
import { Placeholder } from './Placeholder'
import { Hot, KeyframeNav, collapsedOf, type Invoke } from './EffectControls'
import { readClipEffects, selectedClip, useClipEffects, useParamEdit, type ClipEffects, type ClipTimes, type EffectParam } from './effects'

const ChevronDown = TesseraIcons.ChevronDownIcon
const ChevronRight = TesseraIcons.ChevronRightIcon
const RotateCcw = TesseraIcons.RotateCcwIcon

type Row = { label: string; effect: string; param: string; decimals: number; unit: string; speed: number; range: readonly [number, number]; nav: boolean }

/** Upstream `properties_panel`'s Transform rows (Motion, then Opacity), each with its hot number's decimals, suffix, speed, and range. */
const TRANSFORM: readonly Row[] = [
  { label: 'Position', effect: 'motion', param: 'position', decimals: 0, unit: '', speed: 1, range: [-100_000, 100_000], nav: true },
  { label: 'Anchor point', effect: 'motion', param: 'anchor', decimals: 0, unit: '', speed: 1, range: [-100_000, 100_000], nav: true },
  { label: 'Scale', effect: 'motion', param: 'scale', decimals: 0, unit: ' %', speed: 0.5, range: [0, 10_000], nav: true },
  { label: 'Rotation', effect: 'motion', param: 'rotation', decimals: 1, unit: ' °', speed: 0.5, range: [-36_000, 36_000], nav: true },
  { label: 'Opacity', effect: 'opacity', param: 'opacity', decimals: 0, unit: ' %', speed: 0.5, range: [0, 100], nav: true },
]

const CROP: readonly Row[] = (['Left', 'Top', 'Right', 'Bottom'] as const).map((label) => ({ label, effect: 'crop', param: label.toLowerCase(), decimals: 1, unit: ' %', speed: 0.2, range: [0, 100] as const, nav: true }))

const AUDIO: readonly Row[] = [
  { label: 'Level', effect: 'volume', param: 'level', decimals: 1, unit: ' dB', speed: 0.1, range: [-96, 15], nav: true },
  { label: 'Pan', effect: 'panner', param: 'balance', decimals: 0, unit: '', speed: 0.5, range: [-100, 100], nav: false },
]

const effectOf = (effects: ClipEffects, id: string) => effects.effects.find((effect) => effect.id === id) ?? null
const paramOf = (effects: ClipEffects, effect: string, param: string): EffectParam | null => effectOf(effects, effect)?.params.find((each) => each.id === param) ?? null

export type PropertiesPanelProps = {
  film: FilmInfo
  doc: KitEngine | null
  revision: number | null
  /** The program clock, whose playhead the panel follows while it plays. */
  playback: Playback
  labels: FilmLabels | null
  invoke: Invoke
  phrase: Phrases
}

/**
 * Properties (upstream `properties_panel`, Premiere 26): a compact inspector for the selected clip,
 * its label colour and name, then for a video clip Transform (Motion's position, anchor point,
 * scale, rotation, and Opacity) and Crop, for an audio clip its Level and Pan, each section with
 * its reset, each animatable row with its keyframe navigator, and the clip's speed. Its values
 * share Effect Controls' edits: a drag is one history step.
 */
export function PropertiesPanel({ film, doc, revision, playback, labels, invoke, phrase }: PropertiesPanelProps) {
  const chosen = selectedClip(film.tracks, film.selection)
  const playheadTicks = Math.round(useProgramTime(playback, film.playhead) * TICKS_PER_SECOND)
  const clipId = chosen?.clip.id ?? null
  const effects = useClipEffects(doc, clipId, revision, playheadTicks)
  const run = useCallback((id: string, params: Record<string, unknown>, options?: InvokeOptions) => invoke(id, params, options), [invoke])
  // An effect a value waits on (Crop's first change): the value keeps its place in its drag.
  const gate = useCallback((target: { clip: number | string; effect: number | string }) => {
    const shown = effectsNow.current
    if (target.effect !== 'crop' || (shown && shown.clip === target.clip && effectOf(shown, 'crop'))) return null
    return ensureNow.current(Number(target.clip), 'crop')
  }, [])
  const edit = useParamEdit(run, clipId, gate)
  const [, setFolds] = useState(0)
  const effectsNow = useRef(effects)
  effectsNow.current = effects
  const ensureNow = useRef<(clip: number, effect: string) => Promise<boolean>>(async () => false)
  // An effect being applied (Crop's first change), so a drag's later values wait for it rather
  // than apply it again: each answers whether the effect is on the clip once applied.
  const applying = useRef(new Map<string, Promise<boolean>>())
  // Once the clip shows an effect, or another clip is shown, its application is no longer waited for.
  useEffect(() => {
    for (const key of [...applying.current.keys()]) {
      const [owner, effect] = key.split(':')
      if (Number(owner) !== clipId || (effects && effectOf(effects, effect))) applying.current.delete(key)
    }
  }, [clipId, effects])
  const [start, sourceIn, speed, duration] = effects ? [effects.start, effects.sourceIn, effects.speed, effects.duration] : [0, 0, 0, 0]
  const times = useMemo<ClipTimes>(() => ({ start, sourceIn, speed, duration }), [start, sourceIn, speed, duration])
  /**
   * An effect the clip does not have yet (Crop) is applied first, once, as upstream: answers
   * whether it is on the clip then. A refused application is not kept: the next change asks again.
   */
  const ensure = useCallback(
    (clip: number, effect: string): Promise<boolean> => {
      const shown = effectsNow.current
      if (shown && shown.clip === clip && effectOf(shown, effect)) return Promise.resolve(true)
      const key = `${clip}:${effect}`
      let pending = applying.current.get(key)
      if (!pending) {
        pending = (async () => {
          await invoke('effects.apply', { clips: [clip], effect })
          const now = doc ? await readClipEffects(doc, clip, `apply:${key}:${Date.now()}`) : null
          const ok = now != null && effectOf(now, effect) != null
          if (!ok) applying.current.delete(key)
          return ok
        })()
        applying.current.set(key, pending)
      }
      return pending
    },
    [doc, invoke],
  )
  ensureNow.current = ensure
  if (!chosen) return <Placeholder text={phrase('Select a clip to see its properties')} panel="properties" />
  const clip = chosen.clip
  const swatch = labels?.colors[clip.label.toLowerCase()]?.color ?? 'transparent'
  const collapsed = collapsedOf(doc)

  const section = (name: string, reset: { index: number } | null, body: () => ReactNode) => {
    const key = `props:${name}`
    const open = !collapsed.has(key)
    const toggle = () => {
      if (open) collapsed.add(key)
      else collapsed.delete(key)
      setFolds((count) => count + 1)
    }
    return (
      <section className="film-props-section" key={name}>
        <div className="film-props-section-head">
          <button type="button" className="film-props-fold" aria-expanded={open} data-kit-ui-id="control:properties.section" data-testid={`film-props-${name.toLowerCase()}-fold`} onClick={toggle}>
            {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            <span>{phrase(name)}</span>
          </button>
          {reset ? (
            <button type="button" className="film-props-reset" title={phrase('Reset Effect')} aria-label={`${phrase('Reset Effect')}: ${phrase(name)}`} data-kit-ui-id="control:effects.reset" data-testid={`film-props-${name.toLowerCase()}-reset`} onClick={() => void invoke('effects.reset', { clip: clip.id, index: reset.index })}>
              <RotateCcw size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {open ? body() : null}
      </section>
    )
  }

  const rows = (list: readonly Row[]) =>
    effects
      ? list.map((row) => (
          <PropRow
            key={`${clip.id}.${row.effect}.${row.param}`}
            row={row}
            clip={clip.id}
            param={paramOf(effects, row.effect, row.param)}
            applied={effectOf(effects, row.effect) != null}
            mediaTime={effects.mediaTime}
            times={times}
            edit={edit}
            ensure={ensure}
            invoke={invoke}
            phrase={phrase}
          />
        ))
      : null

  const index = (id: string) => (effects ? (effectOf(effects, id)?.index ?? null) : null)
  const resetOf = (id: string) => {
    const at = index(id)
    return at == null ? null : { index: at }
  }
  return (
    <div className="film-props" data-testid="film-properties">
      <div className="film-props-head">
        <span className="film-props-swatch" style={{ background: swatch }} />
        <span className="film-props-name" title={clip.name}>
          {clip.name}
        </span>
      </div>
      {chosen.kind === 'video' ? (
        <>
          {section('Transform', resetOf('motion'), () => rows(TRANSFORM))}
          {section('Crop', resetOf('crop'), () => rows(CROP))}
        </>
      ) : (
        section('Audio', resetOf('volume'), () => rows(AUDIO))
      )}
      <div className="film-props-speed" data-testid="film-props-speed">
        {phrase('Speed {n}%').replace('{n}', (clip.speed * 100).toFixed(0))}
      </div>
    </div>
  )
}

type PropRowProps = {
  row: Row
  clip: number
  param: EffectParam | null
  applied: boolean
  mediaTime: number
  times: ClipTimes
  edit: (target: { clip: number; effect: string; param: string }, value: unknown, final: boolean) => void
  ensure: (clip: number, effect: string) => Promise<boolean>
  invoke: Invoke
  phrase: Phrases
}

/** One Properties row: its label, hot values, and keyframe navigator (upstream `row` and `properties_nav`). */
const PropRow = memo(function PropRow({ row, clip, param, applied, mediaTime, times, edit, ensure, invoke, phrase }: PropRowProps) {
  const testId = `film-props-${row.effect}-${row.param}`
  const target = { clip, effect: row.effect, param: row.param }
  // Crop's first change waits for its application inside the edit (its `gate`), keeping its place in a drag.
  const set = (value: unknown, final: boolean) => edit(target, value, final)
  // Upstream reads a missing Crop, Volume, or Panner as 0; Motion and Opacity show nothing.
  const value = param?.value ?? (row.effect === 'crop' || row.effect === 'volume' || row.effect === 'panner' ? 0 : null)
  const keys = param?.keyframes ?? []
  const tip = keys.some((key) => key.time === mediaTime) ? 'Remove keyframe' : keys.length ? 'Add keyframe' : 'Turn on animation and add keyframe'
  const hot = (label: string, number: number, unit: string, onChange: (value: number, final: boolean) => void, id: string) => (
    <Hot label={label} value={number} min={row.range[0]} max={row.range[1]} decimals={row.decimals} speed={row.speed} unit={unit} onChange={onChange} testId={id} />
  )
  let field: ReactNode = null
  if (Array.isArray(value)) {
    const [x, y] = value as Array<number | null>
    field = (
      <>
        {hot(`${phrase(row.label)} X`, x ?? 0, ' X', (next, final) => set([next, y ?? next], final), `${testId}-x`)}
        {hot(`${phrase(row.label)} Y`, y ?? 0, ' Y', (next, final) => set([x ?? next, next], final), `${testId}-y`)}
      </>
    )
  } else if (typeof value === 'number') {
    field = hot(phrase(row.label), value, row.unit, set, testId)
  }
  return (
    <div className="film-props-row" data-testid={`${testId}-row`}>
      <span className="film-props-label">{phrase(row.label)}</span>
      <span className="film-props-value">{field}</span>
      {row.nav ? (
        <KeyframeNav
          param={param}
          mediaTime={mediaTime}
          times={times}
          tip={tip}
          invoke={invoke}
          phrase={phrase}
          testId={`${testId}-nav`}
          onToggle={() => {
            void ensure(clip, row.effect).then((ok) => (ok ? invoke('effects.addKeyframe', { clip, effect: row.effect, param: row.param }) : null))
          }}
        />
      ) : (
        <span className="film-kf-nav" />
      )}
    </div>
  )
}, samePropRow)

/** Whether a row shows the same: every `clipEffects` answer is new objects, so a row compares its parameter by what it holds. */
function samePropRow(before: PropRowProps, after: PropRowProps) {
  return (
    before.row === after.row &&
    before.clip === after.clip &&
    before.applied === after.applied &&
    before.mediaTime === after.mediaTime &&
    before.times === after.times &&
    before.edit === after.edit &&
    before.ensure === after.ensure &&
    before.invoke === after.invoke &&
    before.phrase === after.phrase &&
    (before.param === after.param || JSON.stringify(before.param) === JSON.stringify(after.param))
  )
}
