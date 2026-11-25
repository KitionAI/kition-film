import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { TesseraIcons } from '@kition/sdk/editor'
import type { KitEngine, Phrases } from '@kition/sdk/editor'
import { useProgramTime, type Playback } from '../session/playback'
import type { InvokeOptions } from '../session/invoke'
import { TICKS_PER_SECOND, type FilmInfo } from '../film'
import type { FilmLabels } from '../session/useFilmSession'
import { Placeholder } from './Placeholder'
import { Choice } from '@kition/sdk/editor'
import { ColorValue, Hot, KeyframeNav, collapsedOf, type Invoke } from './EffectControls'
import { readClipEffects, selectedClip, useClipEffects, useParamEdit, type ClipEffect, type ClipEffects, type ClipTimes, type EffectParam } from './effects'

const ChevronDown = TesseraIcons.ChevronDownIcon
const ChevronRight = TesseraIcons.ChevronRightIcon
const RotateCcw = TesseraIcons.RotateCcwIcon
/** The Text section's alignment buttons (upstream `properties.rs`: Left, Center, Right Align Text, Justify; `align` 0–3) and style toggles (Faux Bold, Faux Italic). */
const ALIGNS = [
  { label: 'Left Align Text', Icon: TesseraIcons.TextAlignStartIcon },
  { label: 'Center Align Text', Icon: TesseraIcons.TextAlignCenterIcon },
  { label: 'Right Align Text', Icon: TesseraIcons.TextAlignEndIcon },
  { label: 'Justify', Icon: TesseraIcons.TextAlignJustifyIcon },
] as const
const STYLES = [
  { param: 'faux_bold', label: 'Faux Bold', Icon: TesseraIcons.BoldIcon },
  { param: 'faux_italic', label: 'Faux Italic', Icon: TesseraIcons.ItalicIcon },
] as const

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
  /** The selected graphic's selected layers (the session state's `graphic_layers`): the Text section styles the first of them that is text. */
  graphicLayers?: readonly number[]
}

/**
 * A graphic clip's text layer the Text section styles (its effect on the clip): the selected layer
 * when it is text, else the clip's first text layer. Layers are the clip's `graphic_text` and
 * `graphic_shape` effects in their order (the engine's `layer_indices`).
 */
export function textLayerOf(effects: ClipEffects, chosen: readonly number[]): ClipEffect | null {
  const layers = effects.effects.filter((effect) => effect.id === 'graphic_text' || effect.id === 'graphic_shape').sort((a, b) => a.index - b.index)
  const texts = layers.map((effect, layer) => ({ effect, layer })).filter((each) => each.effect.id === 'graphic_text')
  return (texts.find((each) => chosen.includes(each.layer)) ?? texts[0])?.effect ?? null
}

/** The font families the engine has (`font.list`), read once per document. */
const fontLists = new WeakMap<object, Promise<string[]>>()
function useFontFamilies(doc: KitEngine | null, invoke: Invoke, wanted: boolean): string[] {
  const [families, setFamilies] = useState<string[]>([])
  useEffect(() => {
    if (!doc || !wanted) return undefined
    let list = fontLists.get(doc)
    if (!list) {
      list = Promise.resolve(invoke('font.list', {}))
        .then((answer) => {
          const rows = typeof answer === 'string' ? (JSON.parse(answer) as unknown) : answer
          return Array.isArray(rows) ? rows.map((row) => (row as { family?: unknown })?.family).filter((family): family is string => typeof family === 'string') : []
        })
        .catch(() => [])
      fontLists.set(doc, list)
    }
    let open = true
    void list.then((names) => {
      if (open) setFamilies(names)
    })
    return () => {
      open = false
    }
  }, [doc, invoke, wanted])
  return families
}

/**
 * Properties (upstream `properties_panel`, Premiere 26): a compact inspector for the selected clip,
 * its label colour and name, then for a video clip Transform (Motion's position, anchor point,
 * scale, rotation, and Opacity) and Crop, for an audio clip its Level and Pan, each section with
 * its reset, each animatable row with its keyframe navigator, and the clip's speed. Its values
 * share Effect Controls' edits: a drag is one history step.
 */
export function PropertiesPanel({ film, doc, revision, playback, labels, invoke, phrase, graphicLayers = [] }: PropertiesPanelProps) {
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
          await invoke('effect.apply', { clips: [clip], effect })
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
  const textLayer = effects && chosen?.kind === 'video' ? textLayerOf(effects, graphicLayers) : null
  const families = useFontFamilies(doc, invoke, textLayer != null)
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
            <button type="button" className="film-props-reset" title={phrase('Reset Effect')} aria-label={`${phrase('Reset Effect')}: ${phrase(name)}`} data-kit-ui-id="control:effect.reset" data-testid={`film-props-${name.toLowerCase()}-reset`} onClick={() => void invoke('effect.reset', { clip: clip.id, index: reset.index })}>
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
          {textLayer ? section('Text', null, () => <TextStyle clip={clip.id} layer={textLayer} families={families} edit={edit} phrase={phrase} />) : null}
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
            void ensure(clip, row.effect).then((ok) => (ok ? invoke('effect.addKeyframe', { clip, effect: row.effect, param: row.param }) : null))
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

type TextStyleProps = {
  clip: number
  layer: ClipEffect
  families: readonly string[]
  edit: (target: { clip: number; effect: number; param: string }, value: unknown, final: boolean) => void
  phrase: Phrases
}

/**
 * The Text section for a graphic's text layer (upstream `graphics/properties.rs`'s Text rows):
 * Font (the engine's families), Font Size, Fill colour, Alignment, and Faux Bold and Italic. Each
 * is the layer's own parameter, set through Effect Controls' edit (`effect.setParam` on the
 * layer's effect): a size scrub or a colour drag is one history step, a click another.
 */
function TextStyle({ clip, layer, families, edit, phrase }: TextStyleProps) {
  const value = (id: string) => layer.params.find((param) => param.id === id)?.value
  const target = (param: string) => ({ clip, effect: layer.index, param })
  const set = (param: string, next: unknown, final: boolean) => edit(target(param), next, final)
  const font = typeof value('font') === 'string' ? (value('font') as string) : ''
  const size = typeof value('size') === 'number' ? (value('size') as number) : 0
  const fill = typeof value('fill_color') === 'string' ? (value('fill_color') as string) : '#ffffff'
  const align = typeof value('align') === 'number' ? (value('align') as number) : 0
  // The layer's font is offered even when the engine does not have it (a project from elsewhere).
  const choices = [...new Set([...families, ...(font ? [font] : [])])].map((family) => [family, family] as const)
  const testId = 'film-props-text'
  return (
    <>
      <div className="film-props-row" data-testid={`${testId}-font-row`}>
        <span className="film-props-label">{phrase('Font')}</span>
        <span className="film-props-value">
          <span className="film-ec-choice" data-kit-ui-id="control:effects.value">
            <Choice quiet label={phrase('Font')} value={font} choices={choices} onChange={(next) => set('font', next, true)} testId={`${testId}-font`} />
          </span>
        </span>
        <span className="film-kf-nav" />
      </div>
      <div className="film-props-row" data-testid={`${testId}-size-row`}>
        <span className="film-props-label">{phrase('Font Size')}</span>
        <span className="film-props-value">
          <Hot label={phrase('Font Size')} value={size} min={1} max={2000} decimals={0} speed={0.5} unit="" onChange={(next, final) => set('size', next, final)} testId={`${testId}-size`} />
        </span>
        <span className="film-kf-nav" />
      </div>
      <div className="film-props-row" data-testid={`${testId}-fill-row`}>
        <span className="film-props-label">{phrase('Fill')}</span>
        <span className="film-props-value">
          <ColorValue value={fill} label={phrase('Fill')} onChange={(hex, final) => set('fill_color', hex, final)} testId={`${testId}-fill`} />
        </span>
        <span className="film-kf-nav" />
      </div>
      <div className="film-props-row" data-testid={`${testId}-align-row`}>
        <span className="film-props-label">{phrase('Alignment')}</span>
        <span className="film-props-value film-props-buttons">
          {ALIGNS.map(({ label, Icon }, index) => (
            <button key={label} type="button" className="film-props-toggle" aria-pressed={align === index} aria-label={phrase(label)} title={phrase(label)} data-kit-ui-id="control:properties.text.align" data-testid={`${testId}-align-${index}`} onClick={() => set('align', index, true)}>
              <Icon size={13} aria-hidden="true" />
            </button>
          ))}
        </span>
        <span className="film-kf-nav" />
      </div>
      <div className="film-props-row" data-testid={`${testId}-style-row`}>
        <span className="film-props-label">{phrase('Style')}</span>
        <span className="film-props-value film-props-buttons">
          {STYLES.map(({ param, label, Icon }) => {
            const on = value(param) === true
            return (
              <button key={param} type="button" className="film-props-toggle" aria-pressed={on} aria-label={phrase(label)} title={phrase(label)} data-kit-ui-id="control:properties.text.style" data-testid={`${testId}-${param}`} onClick={() => set(param, !on, true)}>
                <Icon size={13} aria-hidden="true" />
              </button>
            )
          })}
        </span>
        <span className="film-kf-nav" />
      </div>
    </>
  )
}
