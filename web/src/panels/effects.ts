// Imports carry `.ts` so `node --test` loads this module as it is.
import { useEffect, useMemo, useRef, useState } from 'react'
import { frameLatest } from '../monitors/throttle.ts'

/**
 * Effect Controls' and Properties' model (upstream `panels/effect_controls.rs`): the clip they
 * show, its effects as the engine's `clipEffects` gives them, the value text, one history step per
 * drag, and where keyframes sit on the timeline. Pure but for `useClipEffects`.
 */

export type ParamKind = 'float' | 'point' | 'color' | 'bool' | 'choice' | 'angle' | 'text' | 'curve' | 'wheel' | 'path'

export type EffectKeyframe = { time: number; value: unknown; interpolation: string }

/** A parameter as `clipEffects` gives it: its schema, its value at the playhead, and its keyframes (media ticks). */
export type EffectParam = {
  id: string
  label: string
  group?: string | null
  animatable: boolean
  kind: ParamKind
  min?: number
  max?: number
  softMin?: number
  softMax?: number
  unit?: string
  decimals?: number
  choices?: string[]
  value: unknown
  default?: unknown
  keyframes: EffectKeyframe[]
  /** A LUT reference's name (upstream `luts::label`). */
  lutLabel?: string
}

export type ClipEffect = { index: number; id: string; name: string; kind: 'video' | 'audio'; enabled: boolean; intrinsic: boolean; params: EffectParam[] }

/** `clipEffects`: the clip (times in ticks) and its effects, the fixed ones first. */
export type ClipEffects = {
  clip: number
  name: string
  track: 'video' | 'audio'
  start: number
  duration: number
  sourceIn: number
  speed: number
  /** The playhead's media time, held inside the clip. */
  mediaTime: number
  effects: ClipEffect[]
}

/** The times `timelineTimeOf` and the keyframe moves need, in ticks. */
export type ClipTimes = { start: number; sourceIn: number; speed: number; duration: number }

type Phrase = (text: string) => string
const same: Phrase = (text) => text

/** Upstream `timeline_time_of`: the timeline time at which the clip shows media time `m` (a keyframe's place), truncated to a tick. */
export function timelineTimeOf(clip: ClipTimes, m: number): number {
  return clip.start + Math.trunc((m - clip.sourceIn) / Math.max(Math.abs(clip.speed), 1e-6))
}

/** The media time at timeline time `t` (upstream's keyframe drag: `source_in + (t - start) × |speed|`), truncated to a tick. */
export function mediaTimeOf(clip: ClipTimes, t: number): number {
  return clip.sourceIn + Math.trunc((t - clip.start) * Math.abs(clip.speed))
}

/**
 * Where a keyframe at media time `from`, dragged `deltaSeconds` along the lane, lands (upstream
 * `param_row`'s `drag_stopped`): the timeline time snapped to the nearest frame and kept from the
 * clip's start to its last frame, as media time.
 */
export function keyframeMoveTarget(clip: ClipTimes, from: number, deltaSeconds: number, frameTicks: number): number {
  const ticksPerSecond = 254_016_000_000
  const raw = timelineTimeOf(clip, from) + deltaSeconds * ticksPerSecond
  const snapped = frameTicks > 0 ? Math.round(raw / frameTicks) * frameTicks : Math.round(raw)
  const last = clip.start + clip.duration - Math.max(frameTicks, 1)
  return mediaTimeOf(clip, Math.max(clip.start, Math.min(last, snapped)))
}

export type RulerTick = { frame: number; x: number; labelled: boolean }

/**
 * Upstream `paint_ruler`: the keyframe lane's ruler over the clip's stretch of the sequence
 * (`start`, `duration` in ticks), `width` points wide. The labelled step is the first of
 * upstream's steps at least 80 points apart, the small one the first at least 8 points apart that
 * divides it; `x` is the fraction along the lane, `frame` the sequence frame (its timecode).
 */
export function laneRuler(start: number, duration: number, fps: number, width: number): RulerTick[] {
  if (!(duration > 0) || !(width > 0) || !Number.isFinite(width) || !(fps > 0)) return []
  const ticksPerSecond = 254_016_000_000
  const framePx = (width * (ticksPerSecond / fps)) / duration
  const base = Math.max(1, Math.round(fps))
  const steps = [1, 2, 5, 10, Math.floor(base / 2), base, base * 2, base * 5, base * 10, base * 15, base * 30, base * 60, base * 120, base * 300, base * 600, base * 1800, base * 3600]
  const label = steps.find((step) => step > 0 && step * framePx >= 80)
  const minor = steps.find((step) => step > 0 && step * framePx >= 8 && (label === undefined || label % step === 0))
  const frameAt = (t: number) => Math.floor((t * fps) / ticksPerSecond + 1e-9)
  const tickOf = (frame: number) => (frame * ticksPerSecond) / fps
  const [f0, f1] = [frameAt(start), frameAt(start + duration)]
  const out: RulerTick[] = []
  for (const [step, labelled] of [
    [minor, false],
    [label, true],
  ] as const) {
    if (step === undefined) continue
    let frame = Math.floor(f0 / step) * step
    for (let i = 0; i < 4096 && frame <= f1; i += 1, frame += step) {
      out.push({ frame, x: (tickOf(frame) - start) / duration, labelled })
    }
  }
  return out
}

/** Rust's `{:?}` of an `f64`: a whole number keeps `.0`. */
function rustFloat(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf'
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n}.0`
  return String(n).replace('e+', 'e')
}

const isIdentityCurve = (points: unknown) => Array.isArray(points) && points.length === 2 && JSON.stringify(points) === '[[0,0],[1,1]]'

/**
 * Upstream `param_text`: the read-only text of a parameter without an inline editor. A LUT
 * reference reads its name, empty text "None", a curve "Default" or "Custom (n points)", and any
 * other value upstream's Debug text of it (a colour wheel: `Vec2(Vec2 { x: 0.0, y: 0.0 })`).
 */
export function paramText(param: Pick<EffectParam, 'id' | 'kind' | 'value' | 'lutLabel'>, phrase: Phrase = same): string {
  const { id, kind, value } = param
  if (kind === 'text' && typeof value === 'string') {
    if (id.endsWith('_lut')) return param.lutLabel ?? (value === '' ? phrase('None') : value)
    return value === '' ? phrase('None') : value
  }
  if (kind === 'curve' && Array.isArray(value)) {
    return value.length === 0 || isIdentityCurve(value) ? phrase('Default') : phrase('Custom ({n} points)').replace('{n}', String(value.length))
  }
  if ((kind === 'point' || kind === 'wheel') && Array.isArray(value)) {
    const [x, y] = value.map((n) => (typeof n === 'number' ? n : Number.NaN))
    return `Vec2(Vec2 { x: ${rustFloat(x)}, y: ${rustFloat(y)} })`
  }
  if ((kind === 'float' || kind === 'angle') && typeof value === 'number') return `Float(${rustFloat(value)})`
  if (kind === 'bool') return `Bool(${String(value)})`
  if (kind === 'choice') return `Choice(${String(value)})`
  if (kind === 'color') return `Color(${String(value)})`
  if (kind === 'path') return 'Path(MaskPath { .. })'
  return String(value ?? '')
}

/** The step a hot number of `decimals` places rounds to (kit-editor's `NumberField` reads its precision from it). */
export function stepOf(decimals: number): number {
  return decimals <= 0 ? 1 : Number(`0.${'0'.repeat(decimals - 1)}1`)
}

/** Upstream `param_row`'s hot number for a float, angle, or point parameter: its range, drag speed per pixel, decimals, and suffix. */
export function numberSpec(param: EffectParam): { min: number; max: number; speed: number; decimals: number; unit: string } {
  if (param.kind === 'angle') return { min: -36000, max: 36000, speed: 0.5, decimals: 1, unit: '°' }
  if (param.kind === 'point') return { min: -100_000, max: 100_000, speed: 1, decimals: 1, unit: '' }
  const softMin = param.softMin ?? param.min ?? 0
  const softMax = param.softMax ?? param.max ?? 100
  return { min: param.min ?? -Infinity, max: param.max ?? Infinity, speed: Math.max((softMax - softMin) / 400, 0.01), decimals: param.decimals ?? 1, unit: param.unit ?? '' }
}

/** Upstream `selected_clip`: the first selected clip on a video track, else the first selected clip at all, with its track's kind. */
export function selectedClip<C extends { id: number }>(tracks: ReadonlyArray<{ kind: 'video' | 'audio'; clips: readonly C[] }>, selection: readonly number[]): { clip: C; kind: 'video' | 'audio' } | null {
  let best: { clip: C; kind: 'video' | 'audio' } | null = null
  for (const id of selection) {
    for (const track of tracks) {
      const clip = track.clips.find((each) => each.id === id)
      if (!clip) continue
      if (track.kind === 'video') return { clip, kind: 'video' }
      best ??= { clip, kind: track.kind }
    }
  }
  return best
}

/** Which parameter a value goes to: `effect` is its index on the clip or its id (`motion`). */
export type ParamTarget = { clip: number; effect: number | string; param: string }

type Run = (id: string, params: Record<string, unknown>, options?: { refresh?: 'all' | 'repaint' | 'none' }) => Promise<unknown>
type Frame = (callback: () => void) => () => void

/**
 * Upstream `run`'s undo steps for parameter changes, as one function, `edit(target, value, final)`:
 * the values of one drag (`final: false` while it moves, then `final: true` on release) are one
 * history step — the first one sent begins it (`begin: true`), and every one merges into it
 * (`merge: true`) — and a typed value or a click (`final: true` alone) is a step of its own. While a
 * drag moves, at most one value is sent per frame, the latest, and none while one is in flight
 * (rule 8); the release sends its value after them. The engine itself writes a keyframe at the
 * playhead's media time when the parameter is animated.
 */
export function createParamEdit(run: Run, frame: Frame, dragged: () => void = () => undefined, gate?: (target: ParamTarget) => Promise<boolean> | null) {
  type Drag = { begun: boolean }
  type Item = { target: ParamTarget; value: unknown; drag: Drag | null; final: boolean }
  const send = async (item: Item) => {
    // A value waiting on its effect's application (Crop's first change) keeps its place; a
    // refused application sends nothing.
    const waiting = gate?.(item.target)
    if (waiting && !(await waiting)) return
    const params: Record<string, unknown> = { ...item.target, value: item.value }
    if (item.drag) {
      params.merge = true
      params.begin = !item.drag.begun
      item.drag.begun = true
    }
    // While a drag moves, its values repaint the picture only: the editor (its model, the
    // Timeline, the host and collaborators) refreshes once, with the release, and the panels read
    // the effects again.
    if (!item.final) {
      await run('effect.setParam', params, { refresh: 'repaint' })
      dragged()
      return
    }
    await run('effect.setParam', params)
  }
  // Only the parameters being dragged keep a sender and their drag's last value; a final value
  // lets go of both.
  const senders = new Map<string, ReturnType<typeof frameLatest<Item>>>()
  const drags = new Map<string, { drag: Drag; last: Item }>()
  const edit = (target: ParamTarget, value: unknown, final: boolean) => {
    const key = `${target.clip}:${target.effect}:${target.param}`
    let sender = senders.get(key)
    if (!sender) {
      sender = frameLatest(send, frame)
      senders.set(key, sender)
    }
    const open = drags.get(key) ?? null
    if (!final) {
      const drag = open?.drag ?? { begun: false }
      const item: Item = { target, value, drag, final: false }
      drags.set(key, { drag, last: item })
      sender(item)
      return
    }
    drags.delete(key)
    senders.delete(key)
    sender.flush({ target, value, drag: open?.drag ?? null, final: true })
  }
  /**
   * The pointer press ended (upstream's `run` keys a drag's step to its press): a drag that got no
   * final value (cut short) ends with its last value, merged into its step and refreshing the
   * editor, so a later value starts a step of its own.
   */
  edit.pressEnded = () => {
    for (const [key, { last }] of drags) senders.get(key)?.flush({ ...last, final: true })
    drags.clear()
    senders.clear()
  }
  return edit
}

/** Calls `ended` once every pointer that went down is up again (several fingers end one press). */
export function createPressTracker(ended: () => void) {
  const down = new Set<number>()
  return {
    down: (pointer: number) => void down.add(pointer),
    up: (pointer: number) => {
      down.delete(pointer)
      if (down.size === 0) ended()
    },
  }
}

/** Moves with each drag value sent (repainted only): the panels shown read the effects again (the Program monitor's Motion box drags bump it too). */
export const dragTicks = (() => {
  let tick = 0
  const listeners = new Set<() => void>()
  return {
    get: () => tick,
    bump: () => {
      tick += 1
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
})()

/**
 * `createParamEdit` on the browser's animation frames, its drags ended with every pointer press
 * (after the press's own release handlers have sent their final values), and dropped when the
 * clip changes or the panel goes.
 */
export function useParamEdit(run: Run, clip: number | null, gate?: (target: ParamTarget) => Promise<boolean> | null) {
  const gateNow = useRef(gate)
  gateNow.current = gate
  const runNow = useRef(run)
  runNow.current = run
  const edit = useMemo(
    () =>
      createParamEdit(
        (id, params, options) => runNow.current(id, params, options),
        (callback) => {
          const id = requestAnimationFrame(callback)
          return () => cancelAnimationFrame(id)
        },
        dragTicks.bump,
        (target) => gateNow.current?.(target) ?? null,
      ),
    [],
  )
  useEffect(() => {
    // Downs are seen first (capture); releases bubble to the window after the element's own
    // pointerup handler (kit-editor's final value).
    const tracker = createPressTracker(edit.pressEnded)
    const down = (event: PointerEvent) => tracker.down(event.pointerId)
    const up = (event: PointerEvent) => tracker.up(event.pointerId)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      edit.pressEnded()
    }
  }, [edit])
  useEffect(() => edit.pressEnded, [edit, clip])
  return edit
}

type EffectsDoc = { invoke: (name: string, ...args: unknown[]) => Promise<unknown> }

/**
 * The last `clipEffects` read per document, by clip and stamp (revision and playhead): Effect
 * Controls and Properties shown together read it once, not once each.
 */
const lastRead = new WeakMap<object, { clip: number; stamp: string; answer: Promise<ClipEffects | null> }>()

/** `clipEffects` of `clip` at `stamp`, shared by every panel asking for the same one. */
export function readClipEffects(doc: EffectsDoc, clip: number, stamp: string): Promise<ClipEffects | null> {
  const last = lastRead.get(doc)
  if (last && last.clip === clip && last.stamp === stamp) return last.answer
  const answer = doc.invoke('clipEffects', clip).then(
    (text) => JSON.parse(String(text)) as ClipEffects,
    () => null,
  )
  lastRead.set(doc, { clip, stamp, answer })
  return answer
}

/** What a panel wants read: the document, the clip, and the stamp (revision and playhead) it is read at. */
export type EffectsWant = { doc: EffectsDoc; clip: number; stamp: string; revision?: number | null }

/**
 * Reads `clipEffects` for what is asked (`reader(want)`) at most once per frame, the latest, with
 * one read in flight (rule 8: while the program plays, the values follow the playhead without a
 * read per clock tick), and shows each answer.
 */
export function createEffectsReader(read: (want: EffectsWant) => Promise<ClipEffects | null>, show: (want: EffectsWant, answer: ClipEffects | null) => void, frame: Frame) {
  return frameLatest(async (want: EffectsWant) => show(want, await read(want)), frame)
}

/**
 * The clip's effects (`clipEffects`) while the panel is shown: read when the engine's revision or
 * the playhead (the clock's while playing) changes, at most once per frame with one read in
 * flight, and shared by the panels shown; a panel that is not shown is not mounted, so it reads
 * nothing (rule 8). Null without a clip, or until the first answer for this document and clip.
 */
export function useClipEffects(doc: EffectsDoc | null, clip: number | null, revision: number | null, playhead: number): ClipEffects | null {
  return useClipEffectsAt(doc, clip, revision, playhead).effects
}

/**
 * `useClipEffects`, and the engine revision what it shows was read at (`null` before the first
 * answer): the panel is settled, drawn from the engine's state now, when that is `revision`.
 */
export function useClipEffectsAt(doc: EffectsDoc | null, clip: number | null, revision: number | null, playhead: number): { effects: ClipEffects | null; readAt: number | null } {
  const [shown, setShown] = useState<{ doc: EffectsDoc; answer: ClipEffects } | null>(null)
  const [readAt, setReadAt] = useState<number | null>(null)
  const wanted = useRef<{ doc: EffectsDoc | null; clip: number | null }>({ doc, clip })
  wanted.current = { doc, clip }
  const reader = useMemo(
    () =>
      createEffectsReader(
        (want) => readClipEffects(want.doc, want.clip, want.stamp),
        (want, answer) => {
          const now = wanted.current
          if (!answer || now.doc !== want.doc || now.clip !== want.clip) return
          setShown((before) => (before && before.doc === want.doc && JSON.stringify(before.answer) === JSON.stringify(answer) ? before : { doc: want.doc, answer }))
          setReadAt(want.revision ?? null)
        },
        (callback) => {
          const id = requestAnimationFrame(callback)
          return () => cancelAnimationFrame(id)
        },
      ),
    [],
  )
  useEffect(() => () => reader.cancel(), [reader])
  const stamp = `${revision}:${playhead}`
  const stampNow = useRef(stamp)
  stampNow.current = stamp
  const revisionNow = useRef(revision)
  revisionNow.current = revision
  useEffect(() => {
    if (doc && clip != null) reader({ doc, clip, stamp: `${stamp}:${dragTicks.get()}`, revision })
  }, [reader, doc, clip, stamp, revision])
  // A drag's repainted value: read again, without drawing the panel for the tick itself.
  useEffect(
    () =>
      dragTicks.subscribe(() => {
        const { doc: open, clip: shownClip } = wanted.current
        if (open && shownClip != null) reader({ doc: open, clip: shownClip, stamp: `${stampNow.current}:${dragTicks.get()}`, revision: revisionNow.current })
      }),
    [reader],
  )
  const effects = doc && shown && shown.doc === doc && shown.answer.clip === clip ? shown.answer : null
  return { effects, readAt: effects ? readAt : null }
}
