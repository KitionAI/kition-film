import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { formatTimecode, useUi, type KitEngine, type Phrases } from '@kition/kit-editor'
import { TICKS_PER_SECOND } from '../film'
import { decodeFrame } from '../dialogs/preview'
import { frameWidth } from './frameSize'
import type { MonitorClock } from './Monitor'
import { fitBox, frameTicks, snapTicks, type Rate } from './model'
import { compareStep, createLatestRead } from './displayModes'

type Props = {
  doc: KitEngine | null
  /** The sequence shown (the reference is its own frame, `itemFrame` of the sequence item). */
  sequence: number
  /** The engine's revision: an edit draws the reference again (lesson 6). */
  revision: number | null
  /** The sequence's frame size. */
  width: number
  height: number
  rate: Rate
  fps: number
  dropFrame: boolean
  /** The reference (ticks), or null to follow the playhead (upstream's `compare_ref.unwrap_or(playhead)`). */
  reference: number | null
  /** The program playhead. */
  clock: MonitorClock
  /** The Paused Resolution's scale: the reference, a still, is read no larger than that, and not again on every play and stop. */
  scale: number
  /** The sequence's end, in ticks: ▶ stops at its last frame. */
  end: number
  /** Whether the monitor is on screen: a hidden one reads nothing (lesson 4). */
  shown: boolean
  phrase: Phrases
  invoke: (id: string, params?: Record<string, unknown>) => unknown
}

/** kit-editor's canvas fits a document inside a 32 px margin (`rasterViewport.ts` `FIT_MARGIN`). */
const FIT_MARGIN = 32
/** The reference's width is asked in steps of this many device pixels. */
const WIDTH_STEP = 64

type ReferenceKey = { doc: KitEngine; sequence: number; revision: number | null; ticks: number; width: number }
const sameReference = (a: ReferenceKey, b: ReferenceKey) => a.doc === b.doc && a.sequence === b.sequence && a.revision === b.revision && a.ticks === b.ticks && a.width === b.width

/** `compare_bar`'s buttons, right to left as upstream lays them out, here left to right. */
const BUTTONS = [
  { key: 'prev', text: '◀', tip: 'Reference: previous frame' },
  { key: 'next', text: '▶', tip: 'Reference: next frame' },
  { key: 'set', text: 'Set', tip: 'Set the reference to the playhead' },
] as const

/**
 * The reference stays when another sequence becomes active, as upstream's `compare_ref` (it is
 * never reset); its frame is then read from the sequence shown.
 *
 * The Comparison View's reference side (upstream `monitor.rs` `show` with Comparison, and
 * `monitor_view.rs` `compare_bar`): the sequence's frame at the reference on the left, fitted,
 * and under both pictures the bar with the reference timecode, ◀ and ▶ (one frame), and Set (the
 * playhead). The reference comes from a reduced copy (`itemFrame` of the sequence), read once per
 * document, sequence, revision, time, and width; a late answer for another is dropped.
 */
export function CompareView({ doc, sequence, revision, width, height, rate, fps, dropFrame, reference, clock, scale, end, shown, phrase, invoke }: Props) {
  const pane = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [drawn, setDrawn] = useState<number | null>(null)
  useEffect(() => {
    const element = pane.current
    if (!element) return undefined
    const measure = () => setSize((now) => (now.width === element.clientWidth && now.height === element.clientHeight ? now : { width: element.clientWidth, height: element.clientHeight }))
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // With no reference, it follows the playhead: only then does the playhead re-render this.
  const playhead = useSyncExternalStore(reference == null ? clock.subscribe : noSubscribe, reference == null ? clock.get : zero)
  const at = snapTicks(rate, reference ?? playhead)
  const reads = useMemo(
    () =>
      createLatestRead<ReferenceKey, Uint8Array>({
        read: (key) => key.doc.invoke<Uint8Array>('itemFrame', key.sequence, key.ticks / TICKS_PER_SECOND, key.width),
        same: sameReference,
        onValue: (key, bytes) => {
          const target = canvas.current
          const image = decodeFrame(bytes)
          if (!target || !image) return
          if (target.width !== image.width || target.height !== image.height) {
            target.width = image.width
            target.height = image.height
          }
          target.getContext('2d')?.putImageData(new ImageData(image.pixels as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0)
          setDrawn(key.ticks)
        },
        onError: () => {
          const target = canvas.current
          target?.getContext('2d')?.clearRect(0, 0, target.width, target.height)
          setDrawn(null)
        },
      }),
    [],
  )
  useEffect(() => () => reads.stop(), [reads])
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  // Fitted with the margin the canvas fits the current picture with, so the two show at one size.
  const fitted = fitBox({ x: FIT_MARGIN, y: FIT_MARGIN, width: Math.max(0, size.width - FIT_MARGIN * 2), height: Math.max(0, size.height - FIT_MARGIN * 2) }, width, height)
  // In steps of 64 px, so a resize does not read the reference again at every pixel.
  const cap = Math.min(frameWidth(Number.MAX_SAFE_INTEGER, 1, height / Math.max(1, width)), Math.round(width * scale))
  const want = fitted.width > 0 ? Math.max(1, Math.min(cap, Math.ceil((fitted.width * dpr) / WIDTH_STEP) * WIDTH_STEP)) : 0
  useEffect(() => {
    if (!shown || !doc || want <= 0) {
      reads.stop()
      return
    }
    reads.want({ doc, sequence, revision, ticks: at, width: want })
  }, [reads, shown, doc, sequence, revision, at, want])
  const press = (key: 'prev' | 'next' | 'set') => {
    if (key === 'set') void invoke('view.compare.setReference', {})
    else void invoke('view.compare.setReference', { time: compareStep(reference, clock.get(), frameTicks(rate), key, end) })
  }
  const timecode = formatTimecode((reference ?? playhead) / TICKS_PER_SECOND, fps, dropFrame)
  return (
    <>
      <div ref={pane} className="film-compare-reference" data-kit-ui-id="control:program.compare.reference" data-testid="film-program-reference">
        <canvas
          ref={canvas}
          className="film-compare-picture"
          data-shown={drawn != null ? 'true' : 'false'}
          data-ticks={drawn ?? undefined}
          style={{ left: fitted.x, top: fitted.y, width: fitted.width, height: fitted.height }}
        />
      </div>
      <div className="film-compare-bar" data-testid="film-program-compare-bar" data-reference={reference ?? undefined}>
        <span className="film-compare-label">{phrase('Reference  {tc}').replace('{tc}', timecode)}</span>
        {BUTTONS.map((button) => (
          <CompareButton key={button.key} which={button.key} text={button.key === 'set' ? phrase(button.text) : button.text} tip={phrase(button.tip)} onPress={press} />
        ))}
      </div>
    </>
  )
}

const noSubscribe = () => () => undefined
const zero = () => 0

function CompareButton({ which, text, tip, onPress }: { which: 'prev' | 'next' | 'set'; text: string; tip: string; onPress: (which: 'prev' | 'next' | 'set') => void }) {
  const uiId = `control:program.compare.${which}`
  const state = useUi().state(uiId)
  if (state.hidden) return null
  return (
    <button type="button" className="film-compare-button" title={tip} aria-label={tip} disabled={state.disabled} data-kit-ui-id={uiId} data-testid={`film-program-compare-${which}`} onClick={() => !state.denied && onPress(which)}>
      {text}
    </button>
  )
}
