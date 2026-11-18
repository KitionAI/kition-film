import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { useUi, type Phrases } from '@kition/kit-editor'
import { adjustRange, frameTicks, rangeClickTicks, rangeDragLive, selectedRange, ticksAtX, xOfTicks, type MonitorSpan, type RangeEdge, type Span, type Which } from './model'
import type { MonitorClock, MonitorMarks } from './Monitor'

/** A marker on the scrub bar: its time in ticks and its colour. */
/** A marker on the bar; `mark` is a dialog's preview's (Task 10): added and changed ones outlined, removed ones faded. */
export type MiniMarker = { start: number; color: string; mark?: 'added' | 'removed' | 'changed' }

/** A range drag's start (the monitor's clock stops), and its release with the range it began with and where it went. */
export type RangeChange = { phase: 'start' } | { phase: 'end'; edge: RangeEdge; original: Span; preview: Span }

/** CSS pixels a press may move and still be a click (a click on the marked range moves the playhead). */
const CLICK_SLOP = 3
const HEIGHT = 22

type Drag =
  | { kind: 'scrub'; pointer: number; last: number }
  | { kind: 'range'; pointer: number; edge: RangeEdge; startX: number; bounds: Span; original: Span; preview: Span; moved: boolean; item: number; revision: number | null }

/**
 * Upstream's scrub bar (`monitor.rs` `mini_timeline`, `source_range.rs` `interact`): ticks, the
 * marked range shaded with its braces, the markers, and the playhead; a press or drag on the bar
 * or the playhead scrubs, and on an editable range its In or Out handle, or its body, drags the
 * range (shown in place until the release sends one `project.setMarks`). Escape, a host UI
 * configuration change, lost capture or window focus cancels unfinished input. Another engine
 * revision or item also ends a range drag with no edit. A click on the body moves the playhead
 * to the frame there.
 */
export function MiniTimeline({
  which,
  span,
  marks,
  markers,
  clock,
  editable,
  item,
  revision,
  phrase,
  onSeek,
  onCancelSeek,
  onDraft,
  onRange,
}: {
  which: Which
  span: MonitorSpan
  marks: MonitorMarks
  markers: readonly MiniMarker[]
  clock: MonitorClock
  editable: boolean
  /** The item the marks belong to (the Source clip, or the sequence), and the engine's revision: a range drag holds while both do. */
  item: number | null
  revision: number | null
  phrase: Phrases
  onSeek: (ticks: number, final: boolean) => void
  onCancelSeek: () => void
  onDraft: (draft: Span | null) => void
  onRange: (change: RangeChange) => void
}) {
  const ui = useUi()
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const drag = useRef<Drag | null>(null)
  const [scrubbing, setScrubbing] = useState<number | null>(null)
  const [hot, setHot] = useState<'in' | 'out' | null>(null)
  const live = useSyncExternalStore(clock.subscribe, clock.get)
  // Where a scrub let go, until the playhead it sent arrives (the line does not flash back).
  const [held, setHeld] = useState<{ at: number; base: number } | null>(null)
  useEffect(() => {
    if (held && live !== held.base) setHeld(null)
  }, [held, live])
  useEffect(() => {
    const element = root.current
    if (!element) return undefined
    setWidth(element.clientWidth)
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  /** Drop unfinished input without committing a range or sending another seek. */
  const cancelDrag = () => {
    const current = drag.current
    if (!current) return
    drag.current = null
    if (current.kind === 'range') onDraft(null)
    else {
      setScrubbing(null)
      setHeld(null)
      onCancelSeek()
    }
    const element = root.current
    if (element?.hasPointerCapture(current.pointer)) element.releasePointerCapture(current.pointer)
  }
  const latest = useRef({ item, revision, cancelDrag })
  latest.current = { item, revision, cancelDrag }
  // Cancel at the store notification, including disable/restore before React renders.
  useLayoutEffect(() => ui.store.subscribe(() => latest.current.cancelDrag()), [ui.store])
  useLayoutEffect(() => {
    const current = drag.current
    if (current?.kind === 'range' && !rangeDragLive(current, item, revision)) cancelDrag()
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return
      event.preventDefault()
      event.stopPropagation()
      latest.current.cancelDrag()
    }
    const onBlur = () => latest.current.cancelDrag()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  const time = scrubbing ?? (held && live === held.base ? held.at : live)
  const fd = frameTicks(span.rate)
  const x = (ticks: number) => xOfTicks(span, ticks, width)
  const a = x(span.markIn ?? span.origin)
  const b = Math.max(a, x(span.markOut != null ? span.markOut + fd : span.end))
  const marked = span.markIn != null || span.markOut != null
  const mid = (a + b) / 2
  // The Program monitor's handles need their marks (`interact` skips the others).
  const handles: Array<{ edge: RangeEdge; left: number; right: number; top: number }> = []
  if (editable) {
    const program = which === 'program'
    if (!program || (marks.markIn != null && marks.markOut != null)) handles.push({ edge: 'move', left: Math.min(a + 6, mid), right: Math.max(b - 6, mid), top: 8 })
    if (!program || marks.markIn != null) handles.push({ edge: 'in', left: a - 6, right: Math.min(a + 6, mid), top: 0 })
    if (!program || marks.markOut != null) handles.push({ edge: 'out', left: Math.max(b - 6, mid), right: b + 6, top: 0 })
  }
  const playheadX = x(time)
  const ticks = Math.max(2, Math.floor(width / 20))
  const area = `${which === 'program' ? 'program' : 'source'}`

  const localX = (event: { clientX: number }) => event.clientX - (root.current?.getBoundingClientRect().left ?? 0)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || width <= 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge as RangeEdge | undefined
    if (edge) {
      const bounds = { start: marks.start, end: marks.end }
      const original = selectedRange(marks, span.rate)
      if (item != null && adjustRange(bounds, original, span.rate, edge, 0)) {
        onRange({ phase: 'start' })
        drag.current = { kind: 'range', pointer: event.pointerId, edge, startX: event.clientX, bounds, original, preview: original, moved: false, item, revision }
        return
      }
    }
    const at = ticksAtX(span, localX(event), width)
    drag.current = { kind: 'scrub', pointer: event.pointerId, last: at }
    setScrubbing(at)
    onSeek(at, false)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current) {
      const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge
      setHot(edge === 'in' || edge === 'out' ? edge : null)
      return
    }
    if (current.pointer !== event.pointerId) return
    if (current.kind === 'scrub') {
      const at = ticksAtX(span, localX(event), width)
      if (at === current.last) return
      current.last = at
      setScrubbing(at)
      onSeek(at, false)
      return
    }
    const dx = event.clientX - current.startX
    if (!current.moved && Math.abs(dx) <= CLICK_SLOP) return
    current.moved = true
    const length = current.bounds.end - current.bounds.start
    const delta = Math.max(-length, Math.min(length, (dx / Math.max(1, width)) * length))
    const preview = adjustRange(current.bounds, current.original, span.rate, current.edge, delta)
    if (!preview) return
    current.preview = preview
    onDraft(preview)
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId) return
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (current.kind === 'scrub') {
      setScrubbing(null)
      setHeld({ at: current.last, base: live })
      onSeek(current.last, true)
      return
    }
    onDraft(null)
    if (!rangeDragLive(current, latest.current.item, latest.current.revision)) return
    if (current.moved) onRange({ phase: 'end', edge: current.edge, original: current.original, preview: current.preview })
    else if (current.edge === 'move') {
      // A click on the marked range moves the playhead there (`interact`'s click arm).
      const at = rangeClickTicks({ start: marks.start, end: marks.end }, span.rate, localX(event), width)
      setHeld({ at, base: live })
      onSeek(at, true)
    }
  }
  const brace = (at: number, direction: number) => {
    const top = 8
    const bottom = HEIGHT
    const middle = (top + bottom) / 2
    const p = (offset: number, y: number) => `${at + direction * offset},${y}`
    return [p(4, top), p(2.8, top), p(2, top + 1), p(2, middle - 2), p(1.4, middle - 1), p(0, middle), p(1.4, middle + 1), p(2, middle + 2), p(2, bottom - 1), p(2.8, bottom), p(4, bottom)].join(' ')
  }
  const showIn = span.markIn != null && hot !== 'in'
  const showOut = span.markOut != null && hot !== 'out'
  const barState = ui.state('control:monitor.scrubBar')
  if (barState.hidden) return <div className="film-monitor-bar" style={{ visibility: 'hidden' }} />
  return (
    <div
      ref={root}
      className="film-monitor-bar"
      role="slider"
      aria-label={phrase('scrub bar')}
      aria-valuemin={span.origin}
      aria-valuemax={span.end}
      aria-valuenow={Math.round(time)}
      data-kit-ui-id="control:monitor.scrubBar"
      data-testid={`film-${area}-scrub`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
      onPointerLeave={() => !drag.current && setHot(null)}
    >
      <svg className="film-monitor-bar-art" width={width} height={HEIGHT} aria-hidden="true">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const at = (width * i) / ticks
          const h = i % 5 === 0 ? 8 : 3.5
          return <line key={i} className="film-monitor-tick" x1={at} x2={at} y1={HEIGHT - h} y2={HEIGHT} />
        })}
        {marked ? <rect className="film-monitor-range" x={a} y={8} width={b - a} height={HEIGHT - 8} /> : null}
        {showIn ? <polyline className="film-monitor-brace" points={brace(a, 1)} /> : null}
        {showOut ? <polyline className="film-monitor-brace" points={brace(b, -1)} /> : null}
        {hot ? <TrimCue at={hot === 'in' ? a : b} inward={hot === 'in' ? 4 : -4} /> : null}
        {markers.map((marker, index) => {
          const at = x(marker.start)
          return <polygon key={index} className="film-monitor-marker" data-preview={marker.mark} points={`${at - 3.5},0 ${at + 3.5},0 ${at + 3.5},7 ${at},10 ${at - 3.5},7`} style={{ fill: marker.color }} />
        })}
        <polygon className="film-monitor-playhead" points={`${playheadX - 5.5},11 ${playheadX + 5.5},11 ${playheadX + 5.5},16 ${playheadX},20 ${playheadX - 5.5},16`} />
        <line className="film-monitor-playhead-line" x1={playheadX} x2={playheadX} y1={19} y2={HEIGHT} />
      </svg>
      {handles.map((handle) => (
        <span
          key={handle.edge}
          className="film-monitor-handle"
          data-edge={handle.edge}
          data-kit-ui-id={`control:monitor.range.${handle.edge === 'move' ? 'body' : handle.edge}`}
          title={phrase(handle.edge === 'move' ? 'Move marked range' : handle.edge === 'in' ? 'Drag In point' : 'Drag Out point')}
          style={{ left: handle.left, width: Math.max(0, handle.right - handle.left), top: handle.top }}
        />
      ))}
      <span className="film-monitor-playhead-hit" data-kit-ui-id="control:monitor.playhead" title={phrase('Scrub playhead')} style={{ left: playheadX - 7 }} />
    </div>
  )
}

/** `source_range::trim_cue`: a red bracket and a two-way arrow on a hovered In or Out handle. */
function TrimCue({ at, inward }: { at: number; inward: number }) {
  const top = 8
  const bottom = HEIGHT
  const middle = (top + bottom) / 2
  return (
    <g className="film-monitor-trim-cue">
      <polyline points={`${at + inward},${top} ${at},${top} ${at},${bottom} ${at + inward},${bottom}`} />
      <line x1={at - 9} x2={at + 9} y1={middle} y2={middle} />
      <polyline points={`${at - 6},${middle - 2.5} ${at - 9},${middle} ${at - 6},${middle + 2.5}`} />
      <polyline points={`${at + 6},${middle - 2.5} ${at + 9},${middle} ${at + 6},${middle + 2.5}`} />
    </g>
  )
}
