import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatTimecode, type Phrases } from '@kition/sdk/editor'
import type { FilmInfo, FilmMarker } from '../film'
import { RULER_H, rulerSteps, xOf } from './layout'

/** A stretch of the render bar (`sequence.renderBar`), in seconds. */
export type RenderSpan = { start: number; end: number; state: 'yellow' | 'red' | 'green' }

/** Upstream's render bar colours and tooltips (`draw_top`). */
const RENDER: Record<RenderSpan['state'], { color: string; tip: string }> = {
  yellow: { color: '#f0f04f', tip: 'Unrendered: should play back in real time' },
  red: { color: '#e34850', tip: 'Unrendered: render to play back in real time' },
  green: { color: '#2d9d78', tip: 'Rendered preview' },
}

/** `Color::marker_rgb`: a marker's colour by its label name. */
export function markerColor(name: string) {
  switch (name.toLowerCase()) {
    case 'rose':
    case 'magenta':
    case 'red':
      return '#c13c3d'
    case 'purple':
    case 'violet':
    case 'lavender':
      return '#a98caf'
    case 'mango':
    case 'brown':
    case 'tan':
    case 'orange':
      return '#da7639'
    case 'yellow':
      return '#c9a344'
    case 'blue':
    case 'iris':
    case 'cerulean':
      return '#568bf4'
    case 'teal':
    case 'caribbean':
    case 'cyan':
      return '#72f0d7'
    default:
      return '#758542'
  }
}

/** A counter that moves when the host changes the theme (its tokens live on the root element), so canvases repaint. */
export function useThemeVersion() {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined
    const observer = new MutationObserver(() => setVersion((value) => value + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    return () => observer.disconnect()
  }, [])
  return version
}

/**
 * The device pixel ratio, following changes (the window moved to another display, the page
 * zoomed), so canvases redraw at the new scale.
 */
export function useDevicePixelRatio() {
  const [ratio, setRatio] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia(`(resolution: ${ratio}dppx)`)
    const changed = () => setRatio(window.devicePixelRatio || 1)
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [ratio])
  return ratio
}

/** `rgb(r, g, b)` (a computed colour) as numbers, or null. */
function rgbOf(color: string) {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/**
 * Upstream's In/Out band colour on the ruler (#5c5c5c over its #1d1d1d panel with #b0b0b0 text):
 * opaque, 43% of the way from the surface to the muted text, so it follows the theme.
 */
export function bandColor(muted: string, surface: string) {
  const a = rgbOf(muted)
  const b = rgbOf(surface)
  if (!a || !b) return '#5c5c5c'
  const mix = (index: number) => Math.round(b[index] + (a[index] - b[index]) * 0.43)
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}

type RulerProps = {
  film: FilmInfo
  pps: number
  scroll: number
  width: number
  renderBar: readonly RenderSpan[]
  phrase: Phrases
  /** A press or drag on the ruler: the time under the pointer (`final` on release). */
  onScrub: (seconds: number, phase: 'start' | 'move' | 'end') => void
  /** A dialog's preview: its marks on the markers drawn (added and changed outlined, removed faded). */
  markerMarks?: ReadonlyMap<number, 'added' | 'removed' | 'changed'>
  /** The markers a dialog's preview highlights (Find's marker matches), drawn dashed. */
  markerSelected?: ReadonlySet<number>
}

/**
 * The ruler (upstream `draw_top`'s right part): the markers row, timecode labels and ticks at
 * upstream's steps, the In/Out band, the split edit brackets, and the 2 px render bar. A press or
 * drag scrubs the playhead.
 */
export const Ruler = memo(function Ruler({ film, pps, scroll, width, renderBar, phrase, onScrub, markerMarks, markerSelected }: RulerProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const theme = useThemeVersion()
  const dpr = useDevicePixelRatio()
  const at = { pps, scroll }
  const dragging = useRef(false)
  useLayoutEffect(() => {
    const target = canvas.current
    if (!target || width <= 0) return
    const w = Math.round(width * dpr)
    const h = Math.round(RULER_H * dpr)
    if (target.width !== w) target.width = w
    if (target.height !== h) target.height = h
    const context = target.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, RULER_H)
    const ink = getComputedStyle(target).color
    const labelY = 24
    const tickBase = RULER_H - 3
    const view = { pps, scroll }
    // In/Out band.
    if (film.in != null || film.out != null) {
      const a = xOf(view, film.in ?? 0)
      const b = xOf(view, film.out != null ? film.out + film.frame : film.duration)
      context.fillStyle = bandColor(ink, getComputedStyle(target.parentElement ?? target).backgroundColor)
      context.fillRect(a, labelY + 7, b - a, tickBase - labelY - 7)
    }
    // Split edit brackets: V above, A below.
    const split = film.split
    const brackets: Array<[number | null, boolean, string, boolean]> = [
      [split.videoIn, true, 'V', false],
      [split.videoOut, false, 'V', false],
      [split.audioIn, true, 'A', true],
      [split.audioOut, false, 'A', true],
    ]
    context.strokeStyle = '#d0d0d0'
    context.fillStyle = '#d0d0d0'
    context.lineWidth = 1.5
    context.font = '8.5px system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (const [time, isIn, tag, low] of brackets) {
      if (time == null) continue
      const x = xOf(view, isIn ? time : time + film.frame)
      const y0 = low ? tickBase - 7 : labelY + 7
      const dx = isIn ? 4 : -4
      context.beginPath()
      context.moveTo(x + dx, y0)
      context.lineTo(x, y0)
      context.lineTo(x, y0 + 7)
      context.stroke()
      context.fillText(tag, x + 2 * dx, y0 + 3.5)
    }
    // Ticks and labels.
    const fps = film.fps
    const { label, minor } = rulerSteps(fps, pps)
    const firstFrame = Math.max(0, Math.floor(scroll * fps))
    const lastFrame = Math.floor((scroll + width / pps) * fps) + 1
    context.strokeStyle = ink
    context.fillStyle = ink
    context.lineWidth = 1
    context.font = '11px system-ui, sans-serif'
    context.textBaseline = 'middle'
    context.globalAlpha = 0.85
    context.beginPath()
    for (let frame = Math.floor(firstFrame / minor) * minor; frame <= lastFrame; frame += minor) {
      const x = Math.round(xOf(view, frame / fps)) + 0.5
      const major = frame % label === 0
      context.moveTo(x, tickBase - (major ? 10 : 4))
      context.lineTo(x, tickBase)
      if (major) context.fillText(formatTimecode(frame / fps, fps, film.dropFrame), x + 1, labelY)
    }
    context.stroke()
    context.globalAlpha = 1
  }, [film, pps, scroll, width, theme, dpr])

  const timeOf = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return Math.max(0, scroll + (event.clientX - box.left) / pps)
  }

  return (
    <div
      className="film-tl-ruler"
      style={{ width, height: RULER_H }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        dragging.current = true
        onScrub(timeOf(event), 'start')
      }}
      onPointerMove={(event) => {
        if (dragging.current) onScrub(timeOf(event), 'move')
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return
        dragging.current = false
        onScrub(timeOf(event), 'end')
      }}
      onPointerCancel={(event) => {
        if (!dragging.current) return
        dragging.current = false
        onScrub(timeOf(event), 'end')
      }}
      data-testid="film-ruler"
      data-kit-ui-id="control:timeline.ruler"
    >
      <canvas ref={canvas} className="film-tl-ruler-canvas" style={{ width, height: RULER_H }} />
      {renderBar.map((span, index) => {
        const left = Math.max(0, xOf(at, span.start))
        const right = Math.min(width, xOf(at, span.end))
        if (right <= left) return null
        return <span key={index} className="film-tl-render" style={{ left, width: right - left, background: RENDER[span.state].color }} title={phrase(RENDER[span.state].tip)} data-state={span.state} data-kit-ui-id="control:timeline.renderBar" />
      })}
      {film.markers.map((marker: FilmMarker) => {
        const x = xOf(at, marker.start)
        if (x < -40 || x > width + 4) return null
        const color = markerColor(marker.color)
        return (
          <span key={marker.id} className="film-tl-marker" style={{ left: x - 4 }} title={marker.name || undefined} data-preview={markerMarks?.get(marker.id)} data-preview-selected={markerSelected?.has(marker.id) || undefined} data-kit-ui-id="control:timeline.marker" data-testid={`film-marker-${marker.id}`}>
            {marker.duration > 0 ? <span className="film-tl-marker-span" style={{ width: marker.duration * pps, background: color }} /> : null}
            <span className="film-tl-marker-head" style={{ background: color }} />
          </span>
        )
      })}
    </div>
  )
})
