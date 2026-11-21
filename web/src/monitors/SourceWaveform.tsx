import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useUi, type KitEngine, type Phrases } from '@kition/sdk/editor'
import { endFilmDrag } from '../timeline/drop'
import type { MediaQueue } from '../timeline/mediaQueue'
import type { MonitorClock } from './Monitor'
import { createWaveformSummary, loadWaveform, shownSummary, type ShownWaveform } from './waveform'

type Props = {
  /** The engine, and the Timeline's one-in-flight queue (read only while nothing plays), which the peaks are read through. */
  doc: KitEngine | null
  queue: MediaQueue
  /** The item whose sound is drawn (a subclip's media) and the engine revision for a sequence item, else null. */
  item: number
  /** The actual Source item, distinct from shared parent media for subclips. */
  sourceItem: number
  revision: number | null
  /** The clip's end, in ticks: the waveform runs from the item's start to it, as upstream's. */
  duration: number
  /** The marks as the Source monitor shows them (the whole clip until marked), in ticks. */
  markIn: number
  markOut: number
  clock: MonitorClock
  /** Where it sits in the picture area: all of it, or under the picture in the split view. */
  style?: CSSProperties
  phrase: Phrases
  /** Moves the source playhead: while the press moves (`final` false) and once at its end. */
  onSeek: (ticks: number, final: boolean) => void
  /** Discard pending seeks and release the media queue without a final seek. */
  onCancelSeek: () => void
  /** A vertical drag: the marked audio goes to the Timeline (`source_drag::begin(app, ui, false, true)`). */
  onDragOut: (event: ReactDragEvent<HTMLElement>) => void
}

/** Upstream's waveform green and the marks' and centre line's white (`waveform`). */
const WAVE = '#4fc37a'

/**
 * The Source monitor's audio waveform (upstream `monitor_view.rs` `waveform`), for the Audio
 * Waveform mode, the split view, and a clip without a picture: the item's peaks over its length,
 * the marked range shaded, the centre line, and the source playhead. A press or a sideways drag
 * moves the source playhead; a drag mostly downwards or upwards takes the marked audio to the
 * Timeline. It reads peaks only while it has a size (a hidden panel has none).
 */
export function SourceWaveform({ doc, queue, item, sourceItem, revision, duration, markIn, markOut, clock, style, phrase, onSeek, onCancelSeek, onDragOut }: Props) {
  const ui = useUi()
  const permission = ui.state('control:source.waveform')
  const projectEpoch = (doc?.info.inspected as { project?: { epoch?: number } } | null)?.project?.epoch
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const line = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [arrivals, setArrivals] = useState(0)
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return undefined
    const measure = () => setSize((shown) => (shown.width === element.clientWidth && shown.height === element.clientHeight ? shown : { width: element.clientWidth, height: element.clientHeight }))
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // The item's peaks, folded chunk by chunk into the waveform's own summary (never the Timeline's
  // peaks cache), read while shown; arrivals redraw at most once per animation frame.
  const shown = size.width > 0 && size.height > 0
  const summary = useMemo(() => createWaveformSummary(duration), [doc, item, revision, duration])
  useEffect(() => {
    if (!shown || !doc) return undefined
    return loadWaveform({
      summary,
      item,
      revision,
      queue,
      read: (asked, start, seconds) => doc.invoke('itemPeaks', asked, start, seconds),
      schedule: (task) => {
        const id = requestAnimationFrame(task)
        return () => cancelAnimationFrame(id)
      },
      onChange: () => setArrivals((value) => value + 1),
    })
  }, [summary, shown, doc, queue, item, revision])
  // A sequence item's new revision draws over the last whole summary only once it has all
  // arrived: an edit does not blank the waveform.
  const whole = useRef<ShownWaveform | null>(null)
  const drawn = shownSummary(summary, whole.current, item, doc)
  if (summary.state().all) whole.current = { summary, item, doc }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => (shown ? drawn.columns(size.width) : []), [drawn, size.width, shown, arrivals])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loaded = useMemo(() => drawn.state(), [drawn, arrivals])
  const note = !loaded.any && drawn.chunks > 0 ? phrase('Generating waveform…') : loaded.all && !loaded.sound ? phrase('(no audio)') : null
  const xOf = (ticks: number, width: number) => Math.min(1, Math.max(0, ticks / Math.max(1, duration))) * width
  // The picture: the marked range, the centre line, then each pixel's peaks.
  useEffect(() => {
    const target = canvas.current
    if (!target || !shown) return
    const dpr = window.devicePixelRatio || 1
    const width = Math.round(size.width * dpr)
    const height = Math.round(size.height * dpr)
    if (target.width !== width || target.height !== height) {
      target.width = width
      target.height = height
    }
    const context = target.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, size.width, size.height)
    const a = xOf(markIn, size.width)
    const b = xOf(markOut, size.width)
    context.fillStyle = 'rgba(255, 255, 255, 0.055)'
    context.fillRect(a, 0, b - a, size.height)
    const mid = size.height / 2
    context.fillStyle = 'rgba(255, 255, 255, 0.12)'
    context.fillRect(0, Math.floor(mid), size.width, 1)
    const half = size.height * 0.45
    context.fillStyle = WAVE
    columns.forEach((column, x) => {
      if (!column || column.hi - column.lo <= 0.002) return
      const top = mid - Math.min(column.hi, 1) * half
      const bottom = mid - Math.max(column.lo, -1) * half + 1
      context.fillRect(x, top, 1, bottom - top)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, size, shown, markIn, markOut, duration])
  // The playhead follows the source clock outside React: only its line moves per frame.
  useEffect(() => {
    const place = () => {
      if (line.current) line.current.style.left = `${xOf(clock.get(), root.current?.clientWidth ?? 0)}px`
    }
    place()
    return clock.subscribe(place)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock, duration, size.width])

  // ---- the press: one tracker; a click or a sideways drag moves the source playhead, a vertical one drags the audio out
  const press = useRef<{ id: number; x: number; y: number; at: { x: number; y: number }; ticks: number; end: (commit: boolean) => void } | null>(null)
  const latest = useRef({ duration, onSeek, onCancelSeek })
  latest.current = { duration, onSeek, onCancelSeek }
  const ticksAt = (clientX: number) => {
    const box = root.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return 0
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
    return Math.round(f * latest.current.duration)
  }
  // A cancelled/unmounted waveform must never flush its old position into a new Source
  // item. Subscribe synchronously so a disable/restore pair cannot revive the press.
  useLayoutEffect(() => {
    const cancel = () => press.current?.end(false)
    const unsubscribe = ui.store.subscribe(cancel)
    return () => {
      unsubscribe()
      cancel()
    }
  }, [ui.store, doc, sourceItem, projectEpoch])
  const disabled = permission.disabled || permission.denied
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || disabled) return
    // The waveform's own press: the picture area's Hand pan does not start under it.
    event.stopPropagation()
    press.current?.end(false)
    const id = event.pointerId
    const move = (next: PointerEvent) => {
      const held = press.current
      if (!held || next.pointerId !== id) return
      held.at = { x: next.clientX, y: next.clientY }
      held.ticks = ticksAt(next.clientX)
      latest.current.onSeek(held.ticks, false)
    }
    // Only a normal release (or handing the press to a native audio drag) commits.
    const end = (commit: boolean) => {
      const held = press.current
      if (!held) return
      press.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', escape, true)
      if (commit) latest.current.onSeek(held.ticks, true)
      else latest.current.onCancelSeek()
    }
    const cancel = () => end(false)
    const up = (next: PointerEvent) => {
      if (next.pointerId === id) end(next.type === 'pointerup')
    }
    // Escape ends the press here: it is not the editor's key too.
    const escape = (next: KeyboardEvent) => {
      if (next.key !== 'Escape') return
      next.preventDefault()
      next.stopPropagation()
      cancel()
    }
    press.current = { id, x: event.clientX, y: event.clientY, at: { x: event.clientX, y: event.clientY }, ticks: ticksAt(event.clientX), end }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', escape, true)
    latest.current.onSeek(press.current.ticks, false)
  }
  /**
   * The browser starts a drag once the press has moved a few pixels (upstream waits for 6): a
   * mostly vertical one takes the marked audio out, as upstream's; any other is refused and the
   * press goes on scrubbing. The direction is the drag event's own point against the press, or
   * the last move's when the browser reports the press point there (Chromium does, rounded).
   */
  const onDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
    // The picture area's own drag (video and audio) is not this one.
    event.stopPropagation()
    const held = press.current
    const own = held && Math.max(Math.abs(event.clientX - held.x), Math.abs(event.clientY - held.y)) > 1
    const dx = held ? (own ? event.clientX : held.at.x) - held.x : 0
    const dy = held ? (own ? event.clientY : held.at.y) - held.y : 0
    if (disabled || !held || Math.abs(dy) <= Math.abs(dx)) {
      event.preventDefault()
      return
    }
    held.end(true)
    onDragOut(event)
  }
  if (permission.hidden) return null
  return (
    <div
      ref={root}
      className="film-source-waveform"
      style={style}
      data-kit-ui-id="control:source.waveform"
      data-testid="film-source-waveform"
      data-state={note ? (loaded.any ? 'silent' : 'loading') : 'drawn'}
      aria-label={phrase('audio waveform')}
      draggable={!disabled}
      onPointerDown={onPointerDown}
      onDragStart={onDragStart}
      onDragEnd={endFilmDrag}
    >
      <canvas ref={canvas} className="film-source-waveform-art" />
      <div ref={line} className="film-source-waveform-playhead" />
      {note ? <span className="film-source-waveform-note">{note}</span> : null}
    </div>
  )
}
