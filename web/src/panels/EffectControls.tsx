import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { TesseraIcons } from '@kition/sdk/editor'
import { Checkbox, Choice, ColorPicker, ContextMenu, KeyframeLane, MenuItem, MenuSeparator, NumberField, formatTimecode, parseHex, rgbToHex, type ContextMenuPoint, type KitEngine, type Phrases, type RGB } from '@kition/sdk/editor'
import { TICKS_PER_SECOND, type FilmInfo } from '../film'
import { animationFrameLatest } from '../monitors/throttle'
import type { InvokeOptions } from '../session/invoke'
import { useProgramTime, type Playback } from '../session/playback'
import { Placeholder } from './Placeholder'
import { keyframeMoveTarget, laneRuler, numberSpec, paramText, selectedClip, stepOf, timelineTimeOf, useClipEffects, useParamEdit, type ClipEffect, type ClipTimes, type EffectParam, type ParamTarget } from './effects'

const ChevronDown = TesseraIcons.ChevronDownIcon
const ChevronRight = TesseraIcons.ChevronRightIcon
const RotateCcw = TesseraIcons.RotateCcwIcon
const Timer = TesseraIcons.TimerIcon

export type Invoke = (id: string, params?: Record<string, unknown>, options?: InvokeOptions) => Promise<unknown>
type Edit = (target: ParamTarget, value: unknown, final: boolean) => void

/** Upstream's temporal interpolations, in its keyframe menu's order (`param_row`'s `context_menu`). */
const INTERPOLATIONS: ReadonlyArray<readonly [string, string]> = [
  ['Linear', 'linear'],
  ['Bezier', 'bezier'],
  ['Auto Bezier', 'autoBezier'],
  ['Continuous Bezier', 'continuousBezier'],
  ['Hold', 'hold'],
  ['Ease In', 'easeIn'],
  ['Ease Out', 'easeOut'],
]

/**
 * The folds shut (upstream `app.ui.collapsed_fx`: Effect Controls' `<clip>:<index>`, Properties'
 * `props:<section>`), per document, kept while a panel is hidden.
 */
const folds = new WeakMap<object, Set<string>>()
export function collapsedOf(doc: object | null): Set<string> {
  if (!doc) return new Set()
  let set = folds.get(doc)
  if (!set) {
    set = new Set()
    folds.set(doc, set)
  }
  return set
}

/**
 * Gives the keys back to the editor once a field's edit ends (its shortcuts skip a focused field),
 * but only when the focus went nowhere: a click that ended the edit by focusing another field (or
 * a menu, or another panel) keeps it there.
 */
export function focusEditor() {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (active && active !== document.body) return
    document.querySelector<HTMLElement>('.kui-app')?.focus({ preventScroll: true })
  })
}

/** The number of ticks in one frame at `fps`. */
export const frameTicksOf = (fps: number) => (fps > 0 ? Math.round(TICKS_PER_SECOND / fps) : 0)

/** Upstream `Icon::Keyframe` and its outline: the navigator's add/remove diamond (Tessera's keyframe icons). */
function Diamond({ on }: { on: boolean }) {
  const Icon = on ? TesseraIcons.KeyframeOnIcon : TesseraIcons.KeyframeIcon
  return <Icon size={12} aria-hidden="true" />
}

function Triangle({ left }: { left: boolean }) {
  const Icon = left ? TesseraIcons.KeyframePreviousIcon : TesseraIcons.KeyframeNextIcon
  return <Icon size={10} aria-hidden="true" />
}

/**
 * Upstream `keyframe_nav`: a diamond that adds a keyframe at the playhead or removes the one there
 * (filled while the playhead is on one), and, once the parameter is animated, arrows to the
 * previous and the next keyframe, which move the playhead there.
 */
export function KeyframeNav({ param, mediaTime, times, tip, onToggle, invoke, phrase, testId }: { param: EffectParam | null; mediaTime: number; times: ClipTimes; tip: string; onToggle: () => void; invoke: Invoke; phrase: Phrases; testId: string }) {
  const keys = param?.keyframes ?? []
  const animated = keys.length > 0
  const prev = [...keys].reverse().find((key) => key.time < mediaTime) ?? null
  const next = keys.find((key) => key.time > mediaTime) ?? null
  const on = keys.some((key) => key.time === mediaTime)
  const go = (time: number | null) => {
    if (time != null) void invoke('playhead.set', { time: timelineTimeOf(times, time) })
  }
  return (
    <span className="film-kf-nav">
      {animated ? (
        <button type="button" className="film-kf-arrow" disabled={!prev} title={phrase('Go to previous keyframe')} aria-label={phrase('Go to previous keyframe')} data-kit-ui-id="control:effects.prevKeyframe" data-testid={`${testId}-prev`} onClick={() => go(prev?.time ?? null)}>
          <Triangle left />
        </button>
      ) : (
        <span className="film-kf-arrow" />
      )}
      <button type="button" className="film-kf-add" data-on={on || undefined} title={phrase(tip)} aria-label={phrase(tip)} aria-pressed={on} data-kit-ui-id="control:effects.addKeyframe" data-testid={`${testId}-add`} onClick={onToggle}>
        <Diamond on={on} />
      </button>
      {animated ? (
        <button type="button" className="film-kf-arrow" disabled={!next} title={phrase('Go to next keyframe')} aria-label={phrase('Go to next keyframe')} data-kit-ui-id="control:effects.nextKeyframe" data-testid={`${testId}-next`} onClick={() => go(next?.time ?? null)}>
          <Triangle left={false} />
        </button>
      ) : (
        <span className="film-kf-arrow" />
      )}
    </span>
  )
}

/** A hot number for one value of a parameter (upstream `hot_number`). */
export function Hot({ label, value, min, max, decimals, speed, unit, onChange, testId }: { label: string; value: number; min: number; max: number; decimals: number; speed: number; unit: string; onChange: (value: number, final: boolean) => void; testId: string }) {
  return <NumberField hot label={label} value={Number.isFinite(value) ? value : 0} min={min} max={max} step={stepOf(decimals)} speed={speed} unit={unit} onChange={onChange} onDone={focusEditor} uiId="control:effects.value" testId={testId} />
}

/** A colour parameter: its swatch, which opens kit-editor's colour picker below it (upstream `color_edit_button_rgba`, opaque). */
function ColorValue({ value, label, onChange, testId }: { value: string; label: string; onChange: (hex: string, final: boolean) => void; testId: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const rgb: RGB = parseHex(value.slice(0, 7)) ?? [0, 0, 0]
  // The alpha a colour carries is kept: upstream edits it opaque.
  const alpha = value.length === 9 ? value.slice(7) : ''
  useEffect(() => {
    if (!open) return undefined
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [open])
  return (
    <span ref={box} className="film-ec-color" data-kit-ui-id="control:effects.value">
      <button type="button" className="film-ec-swatch" style={{ background: value.slice(0, 7) }} aria-label={label} title={label} aria-expanded={open} data-testid={testId} onClick={() => setOpen(!open)} />
      {open ? (
        <span className="film-ec-color-popover">
          <ColorPicker value={rgb} onChange={(next, final) => onChange(`${rgbToHex(next)}${alpha}`, final)} testId={`${testId}-picker`} uiId="control:effects.value" />
        </span>
      ) : null}
    </span>
  )
}

/** A free-text parameter, edited in a buffer and set (one undo step) when the field loses focus, as upstream. */
function TextValue({ value, label, onCommit, testId }: { value: string; label: string; onCommit: (text: string) => void; testId: string }) {
  const [text, setText] = useState<string | null>(null)
  // The edit's buffer and whether Escape dropped it, read by the blur that ends it.
  const buffer = useRef<string | null>(null)
  const cancelled = useRef(false)
  const write = (next: string | null) => {
    buffer.current = next
    setText(next)
  }
  return (
    <input
      className="kui-field film-ec-text"
      value={text ?? value}
      aria-label={label}
      data-kit-ui-id="control:effects.text"
      data-testid={testId}
      onFocus={() => {
        cancelled.current = false
        write(value)
      }}
      onChange={(event) => write(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          cancelled.current = true
          event.currentTarget.blur()
        }
      }}
      onBlur={() => {
        const typed = buffer.current
        if (!cancelled.current && typed !== null && typed !== value) onCommit(typed)
        cancelled.current = false
        write(null)
        focusEditor()
      }}
    />
  )
}

/** A parameter's value as upstream `param_row` edits it: hot numbers, a check box, a choice, a colour, text, or `param_text`. */
function ParamValue({ param, target, edit, invoke, phrase, testId }: { param: EffectParam; target: ParamTarget; edit: Edit; invoke: Invoke; phrase: Phrases; testId: string }) {
  const label = phrase(param.label)
  const { value } = param
  const spec = param.kind === 'float' || param.kind === 'angle' || param.kind === 'point' ? numberSpec(param) : null
  if (spec && (param.kind === 'float' || param.kind === 'angle') && typeof value === 'number') {
    return <Hot label={label} value={value} {...spec} onChange={(next, final) => edit(target, next, final)} testId={testId} />
  }
  if (spec && param.kind === 'point' && Array.isArray(value)) {
    const [x, y] = value as Array<number | null>
    return (
      <span className="film-ec-pair">
        <Hot label={`${label} X`} value={x ?? 0} {...spec} onChange={(next, final) => edit(target, [next, y ?? next], final)} testId={`${testId}-x`} />
        <Hot label={`${label} Y`} value={y ?? 0} {...spec} onChange={(next, final) => edit(target, [x ?? next, next], final)} testId={`${testId}-y`} />
      </span>
    )
  }
  if (param.kind === 'bool' && typeof value === 'boolean') {
    return (
      <span data-kit-ui-id="control:effects.value">
        <Checkbox label="" checked={value} onChange={(checked) => edit(target, checked, true)} testId={testId} />
      </span>
    )
  }
  if (param.kind === 'choice' && typeof value === 'number') {
    const choices = (param.choices ?? []).map((choice, index) => [String(index), phrase(choice)] as const)
    return (
      <span className="film-ec-choice" data-kit-ui-id="control:effects.value">
        <Choice quiet label={label} value={String(value)} choices={choices} onChange={(next) => edit(target, Number(next), true)} testId={testId} />
      </span>
    )
  }
  if (param.kind === 'color' && typeof value === 'string') {
    return <ColorValue value={value} label={label} onChange={(hex, final) => edit(target, hex, final)} testId={testId} />
  }
  if (param.kind === 'text' && typeof value === 'string' && !param.id.endsWith('_lut')) {
    return <TextValue value={value} label={label} onCommit={(text) => void invoke('effects.setParam', { ...target, value: text })} testId={testId} />
  }
  // Curves, colour wheels, mask paths, and LUT references are read-only here (wave 2: the Color panel and masks).
  return (
    <span className="film-ec-readonly" data-testid={testId}>
      {paramText(param, phrase)}
    </span>
  )
}

type MenuTarget = { kind: 'keyframe'; at: ContextMenuPoint; clip: number; effect: number; param: string; time: number } | { kind: 'effect'; at: ContextMenuPoint; clip: number; effect: number; intrinsic: boolean }

type RowProps = {
  clip: number
  effect: ClipEffect
  param: EffectParam
  mediaTime: number
  times: ClipTimes
  fps: number
  edit: Edit
  invoke: Invoke
  phrase: Phrases
  onMenu: (target: MenuTarget) => void
}

/** One parameter's row (upstream `param_row`): stopwatch, name, value, keyframe navigator, and its keyframe lane on the right. */
const ParamRow = memo(function ParamRow({ clip, effect, param, mediaTime, times, fps, edit, invoke, phrase, onMenu }: RowProps) {
  const target: ParamTarget = { clip, effect: effect.index, param: param.id }
  const animated = param.keyframes.length > 0
  const testId = `film-ec-${effect.id}-${param.id}`
  // A keyframe pressed in the lane, which a click (not a drag) moves the playhead to, as upstream.
  const pending = useRef<{ id: string; x: number } | null>(null)
  // The keyframe chosen in the lane (its media time), kept through its moves: upstream draws the
  // one under the playhead selected, and the one being dragged; the lane's arrow keys move it.
  const [chosen, setChosen] = useState<number | null>(null)
  const frameTicks = frameTicksOf(fps)
  const lane = { start: times.start / TICKS_PER_SECOND, end: (times.start + times.duration) / TICKS_PER_SECOND }
  const keyframes = animated
    ? param.keyframes.map((key) => ({ id: String(key.time), time: timelineTimeOf(times, key.time) / TICKS_PER_SECOND, selected: key.time === mediaTime || key.time === chosen, interpolation: key.interpolation as 'linear' }))
    : []
  return (
    <div className="film-ec-row" data-testid={testId}>
      <div className="film-ec-left">
        <span className="film-ec-twirl" />
        {param.animatable ? (
          <button
            type="button"
            className="film-ec-stopwatch"
            data-on={animated || undefined}
            aria-pressed={animated}
            title={phrase('Toggle animation')}
            aria-label={`${phrase('Toggle animation')}: ${phrase(param.label)}`}
            data-kit-ui-id="control:effects.stopwatch"
            data-testid={`${testId}-stopwatch`}
            onClick={() => void invoke('effects.toggleAnimation', { clip, effect: effect.index, param: param.id })}
          >
            <Timer size={13} aria-hidden="true" />
          </button>
        ) : (
          <span className="film-ec-stopwatch" />
        )}
        <span className="film-ec-name" title={phrase(param.label)}>
          {phrase(param.label)}
        </span>
        <span className="film-ec-value">
          <ParamValue param={param} target={target} edit={edit} invoke={invoke} phrase={phrase} testId={`${testId}-value`} />
        </span>
        {param.animatable && animated ? (
          <KeyframeNav param={param} mediaTime={mediaTime} times={times} tip="Add/Remove Keyframe" onToggle={() => void invoke('effects.addKeyframe', { clip, effect: effect.index, param: param.id })} invoke={invoke} phrase={phrase} testId={`${testId}-nav`} />
        ) : (
          <span className="film-kf-nav" />
        )}
      </div>
      <div
        className="film-ec-lanecell"
        data-kit-ui-id="control:effects.lane"
        onPointerDownCapture={(event) => {
          pending.current = { id: '', x: event.clientX }
        }}
        onClick={(event) => {
          const press = pending.current
          pending.current = null
          // A press that moved (a drag, even one brought back) is not a click.
          if (press?.id && Math.abs(event.clientX - press.x) <= 2) void invoke('playhead.set', { time: timelineTimeOf(times, Number(press.id)) })
        }}
      >
        {animated ? (
          <KeyframeLane
            keyframes={keyframes}
            start={lane.start}
            end={lane.end}
            fps={fps}
            snap={(time) => (fps > 0 ? Math.round(time * fps) / fps : time)}
            onSelect={(ids) => {
              if (pending.current) pending.current.id = ids[0] ?? ''
              setChosen(ids.length ? Number(ids[0]) : null)
            }}
            onMove={(ids, delta) => {
              pending.current = null
              for (const id of ids) {
                const from = Number(id)
                const to = keyframeMoveTarget(times, from, delta, frameTicks)
                if (to === from) continue
                setChosen(to)
                void invoke('effects.moveKeyframe', { clip, effect: effect.index, param: param.id, mediaTime: from, to })
              }
            }}
            onMenu={(id, at) => onMenu({ kind: 'keyframe', at, clip, effect: effect.index, param: param.id, time: Number(id) })}
            uiId="control:effects.keyframe"
            testId={`${testId}-lane`}
          />
        ) : null}
      </div>
    </div>
  )
}, sameRow)

/**
 * Whether a row shows the same: every `clipEffects` answer is new objects, so a drag of one value
 * would draw every row again; a row compares its parameter by what it holds.
 */
function sameRow(before: RowProps, after: RowProps) {
  return (
    before.clip === after.clip &&
    before.effect.index === after.effect.index &&
    before.effect.id === after.effect.id &&
    before.mediaTime === after.mediaTime &&
    before.times === after.times &&
    before.fps === after.fps &&
    before.edit === after.edit &&
    before.invoke === after.invoke &&
    before.phrase === after.phrase &&
    before.onMenu === after.onMenu &&
    (before.param === after.param || JSON.stringify(before.param) === JSON.stringify(after.param))
  )
}

type EffectHeaderProps = {
  clip: number
  index: number
  id: string
  name: string
  enabled: boolean
  intrinsic: boolean
  open: boolean
  foldKey: string
  onFold: (key: string) => void
  onMenu: (target: MenuTarget) => void
  invoke: Invoke
  phrase: Phrases
}

/** An effect's row (upstream `show`): a click anywhere on it but the fx switch and the reset folds it; a right-click opens its menu. */
const EffectHeader = memo(function EffectHeader({ clip, index, id, name, enabled, intrinsic, open, foldKey, onFold, onMenu, invoke, phrase }: EffectHeaderProps) {
  return (
    <div
      className="film-ec-row film-ec-effect"
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu({ kind: 'effect', at: { x: event.clientX, y: event.clientY }, clip, effect: index, intrinsic })
      }}
      data-testid={`film-ec-effect-${id}`}
    >
      <div
        className="film-ec-left"
        data-kit-ui-id="control:effects.effect"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest('.film-ec-fx, .film-ec-reset')) onFold(foldKey)
        }}
      >
        <button type="button" className="film-ec-fold" aria-expanded={open} aria-label={phrase(name)} data-testid={`film-ec-effect-${id}-fold`}>
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="film-ec-fx"
          data-off={!enabled || undefined}
          aria-pressed={enabled}
          aria-label={`fx ${phrase(name)}`}
          title={phrase('Toggle Effect')}
          data-kit-ui-id="control:effects.enabled"
          data-testid={`film-ec-effect-${id}-enabled`}
          onClick={() => void invoke('effects.toggleEnabled', { clip, index })}
        >
          fx
        </button>
        <span className="film-ec-effect-name">{phrase(name)}</span>
        <button type="button" className="film-ec-reset" title={phrase('Reset Effect')} aria-label={`${phrase('Reset Effect')}: ${phrase(name)}`} data-kit-ui-id="control:effects.reset" data-testid={`film-ec-effect-${id}-reset`} onClick={() => void invoke('effects.reset', { clip, index })}>
          <RotateCcw size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="film-ec-lanecell" />
    </div>
  )
})

/** The lane's time ruler (upstream `paint_ruler`): ticks and sequence timecode across the clip. */
const LaneRuler = memo(function LaneRuler({ times, fps, dropFrame }: { times: ClipTimes; fps: number; dropFrame: boolean }) {
  const element = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = element.current
    if (!node) return undefined
    setWidth(node.clientWidth)
    const observer = new ResizeObserver(() => setWidth(node.clientWidth))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const ticks = laneRuler(times.start, times.duration, fps, width)
  return (
    <div ref={element} className="film-ec-ruler-ticks">
      {ticks.map((tick) => (
        <span key={`${tick.labelled ? 'l' : 'm'}${tick.frame}`} className="film-ec-tick" data-labelled={tick.labelled || undefined} style={{ left: `${tick.x * 100}%` }}>
          {tick.labelled ? <span className="film-ec-tick-label">{formatTimecode(tick.frame / fps, fps, dropFrame)}</span> : null}
        </span>
      ))}
    </div>
  )
})

export type EffectControlsProps = {
  film: FilmInfo
  doc: KitEngine | null
  revision: number | null
  /** The program clock, whose playhead the panel follows while it plays. */
  playback: Playback
  invoke: Invoke
  /** Moves the program playhead to `ticks` (a scrub on the lane's ruler). */
  seekTicks: (ticks: number) => Promise<unknown>
  phrase: Phrases
}

/**
 * Effect Controls (upstream `panels/effect_controls.rs` `show`): the selected clip's effects, the
 * fixed ones first, each a fold with its `fx` switch and reset, its parameters with stopwatches,
 * values, and keyframe navigators, and on the right the clip's stretch of the sequence with its
 * ruler, the playhead, and a keyframe lane per animated parameter.
 */
export function EffectControls({ film, doc, revision, playback, invoke, seekTicks, phrase }: EffectControlsProps) {
  const chosen = selectedClip(film.tracks, film.selection)
  // Upstream follows the playhead every frame: the clock's while the program plays.
  const playheadSeconds = useProgramTime(playback, film.playhead)
  const playheadTicks = Math.round(playheadSeconds * TICKS_PER_SECOND)
  const effects = useClipEffects(doc, chosen?.clip.id ?? null, revision, playheadTicks)
  const run = useCallback((id: string, params: Record<string, unknown>, options?: InvokeOptions) => invoke(id, params, options), [invoke])
  const edit = useParamEdit(run, chosen?.clip.id ?? null)
  const [, setFolds] = useState(0)
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const onMenu = useCallback((target: MenuTarget) => setMenu(target), [])
  const scrub = useRef<{ pointerId: number } | null>(null)
  // The ruler's scrub moves the playhead at most once per frame, the latest, one move in flight.
  const seekNow = useRef(seekTicks)
  seekNow.current = seekTicks
  const seek = useMemo(() => animationFrameLatest((ticks: number) => seekNow.current(ticks)), [])
  useEffect(() => () => seek.cancel(), [seek])
  const fold = useCallback(
    (key: string) => {
      const collapsed = collapsedOf(doc)
      if (collapsed.has(key)) collapsed.delete(key)
      else collapsed.add(key)
      setFolds((count) => count + 1)
    },
    [doc],
  )
  // One object per clip timing, so the rows (memoized) draw again only when something they show changes.
  const [start, sourceIn, speed, duration] = effects ? [effects.start, effects.sourceIn, effects.speed, effects.duration] : [0, 0, 0, -1]
  const times = useMemo<ClipTimes | null>(() => (duration < 0 ? null : { start, sourceIn, speed, duration }), [start, sourceIn, speed, duration])
  if (!chosen) return <Placeholder text={phrase('(no clip selected)')} panel="effectControls" />
  const collapsed = collapsedOf(doc)
  if (film.activeSequence == null) return <Placeholder text={phrase('(no sequences)')} panel="effectControls" />
  const name = chosen.clip.name
  const fps = film.fps
  const onClip = times != null && playheadTicks >= times.start && playheadTicks <= times.start + times.duration
  const playheadAt = times && times.duration > 0 ? Math.min(1, Math.max(0, (playheadTicks - times.start) / times.duration)) : 0

  const scrubTo = (event: ReactPointerEvent<HTMLDivElement>, final: boolean) => {
    if (!times) return
    const box = event.currentTarget.getBoundingClientRect()
    const fraction = box.width > 0 ? Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) : 0
    const frame = frameTicksOf(fps)
    const raw = times.start + fraction * times.duration
    const ticks = frame > 0 ? Math.round(raw / frame) * frame : raw
    if (final) seek.flush(ticks)
    else seek(ticks)
  }
  const endScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrub.current?.pointerId !== event.pointerId) return
    scrub.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }


  const rows: ReactNode[] = []
  if (effects && times) {
    for (const effect of effects.effects) {
      const key = `${effects.clip}:${effect.index}`
      const open = !collapsed.has(key)
      rows.push(<EffectHeader key={`fx-${effects.clip}-${effect.index}`} clip={effects.clip} index={effect.index} id={effect.id} name={effect.name} enabled={effect.enabled} intrinsic={effect.intrinsic} open={open} onFold={fold} foldKey={key} onMenu={onMenu} invoke={invoke} phrase={phrase} />)
      if (!open) continue
      for (const param of effect.params) {
        rows.push(<ParamRow key={`p-${effects.clip}-${effect.index}-${param.id}`} clip={effects.clip} effect={effect} param={param} mediaTime={effects.mediaTime} times={times} fps={fps} edit={edit} invoke={invoke} phrase={phrase} onMenu={onMenu} />)
      }
    }
  }

  return (
    <div className="film-ec" data-testid="film-effect-controls">
      <div className="film-ec-head">
        <div className="film-ec-left film-ec-pills">
          <span className="film-ec-pill" title={phrase('Source · {name}').replace('{name}', name)}>
            {phrase('Source · {name}').replace('{name}', name)}
          </span>
          <span className="film-ec-pill" data-active="true" title={`${film.name} · ${name}`} data-testid="film-ec-sequence-pill">
            {`${film.name} · ${name}`}
          </span>
        </div>
        <div
          className="film-ec-scrub"
          data-kit-ui-id="control:effects.ruler"
          data-testid="film-ec-ruler"
          onPointerDown={(event) => {
            if (event.button !== 0 || !times) return
            event.currentTarget.setPointerCapture?.(event.pointerId)
            scrub.current = { pointerId: event.pointerId }
            if (playback.programTime() != null) void invoke('playback.stop', {})
            scrubTo(event, false)
          }}
          onPointerMove={(event) => {
            if (scrub.current?.pointerId !== event.pointerId) return
            // A release that never arrived: the button is up, so the scrub is over.
            if ((event.buttons & 1) === 0) endScrub(event)
            else scrubTo(event, false)
          }}
          onPointerUp={(event) => {
            if (scrub.current?.pointerId !== event.pointerId) return
            scrubTo(event, true)
            endScrub(event)
          }}
          onPointerCancel={endScrub}
          onLostPointerCapture={endScrub}
        >
          <div className="film-ec-ruler">{times ? <LaneRuler times={times} fps={fps} dropFrame={film.dropFrame} /> : null}</div>
          <div className="film-ec-clipbar">
            <span>{name}</span>
          </div>
        </div>
      </div>
      <div className="film-ec-body">
        <div className="film-ec-heading">{phrase(chosen.kind === 'video' ? 'Video' : 'Audio')}</div>
        {rows}
      </div>
      {onClip ? (
        <div className="film-ec-playhead" style={{ ['--ph' as string]: playheadAt }} data-kit-ui-id="control:effects.playhead" data-testid="film-ec-playhead">
          <span className="film-ec-playhead-head" />
        </div>
      ) : null}
      <div className="film-ec-foot" data-testid="film-ec-timecode">
        {formatTimecode(playheadSeconds, fps, film.dropFrame)}
      </div>
      {menu ? (
        <ContextMenu at={menu.at} onClose={() => setMenu(null)} label={phrase(menu.kind === 'keyframe' ? 'Temporal Interpolation' : 'Effect')} testId="film-ec-menu">
          {menu.kind === 'keyframe' ? (
            <>
              <div className="film-menu-heading">{phrase('Temporal Interpolation')}</div>
              {INTERPOLATIONS.map(([label, key]) => (
                <MenuItem
                  key={key}
                  label={phrase(label)}
                  uiId={`control:effects.keyframeMenu.${key}`}
                  testId={`film-ec-menu-${key}`}
                  onSelect={() => void invoke('effects.setInterpolation', { clip: menu.clip, effect: menu.effect, param: menu.param, mediaTime: menu.time, interpolation: key })}
                />
              ))}
              <MenuSeparator />
              <MenuItem label={phrase('Clear')} uiId="control:effects.keyframeMenu.clear" testId="film-ec-menu-clear" onSelect={() => void invoke('effects.deleteKeyframe', { clip: menu.clip, effect: menu.effect, param: menu.param, mediaTime: menu.time })} />
            </>
          ) : (
            <>
              {/* Save Preset… opens upstream's preset dialog, which comes with the Effects panel (wave 2). */}
              <MenuItem label={phrase('Save Preset…')} disabled uiId="control:effects.effect.savePreset" testId="film-ec-menu-save-preset" onSelect={() => undefined} />
              {menu.intrinsic ? null : <MenuItem label={phrase('Clear')} uiId="control:effects.effect.clear" testId="film-ec-menu-remove" onSelect={() => void invoke('effects.remove', { clip: menu.clip, index: menu.effect })} />}
            </>
          )}
        </ContextMenu>
      ) : null}
    </div>
  )
}
