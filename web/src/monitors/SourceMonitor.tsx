import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { TesseraIcons } from '@kition/sdk/editor'
import { oneInFlight, useUi, type KitEngine, type Phrases } from '@kition/sdk/editor'
import { TICKS_PER_SECOND } from '../film'
import type { Playback } from '../session/playback'
import { endFilmDrag, startFilmDrag } from '../timeline/drop'
import { markerColor } from '../timeline/Ruler'
import type { MediaQueue } from '../timeline/mediaQueue'
import { frameWidth } from './frameSize'
import { Monitor, type MonitorClock } from './Monitor'
import { effectiveRes, type MonitorView } from './monitorView'
import { monitorSpan, pictureBox, rangeEditable, rateOf, renderScaleOf, setMarksParams, sourceDragPayload, sourceNavTicks, type Box, type SafeAreaPercents, type SourceView } from './model'
import { DISPLAY_LABELS, SPLIT, channelPass, isChannel, sourceLayout } from './displayModes'
import { SourceWaveform } from './SourceWaveform'
import { animationFrameLatest } from './throttle'
import { SafeMargins } from './SafeMargins'
import { GuideLayer } from './Guides'
import { RULER, type Guide, type GuideGeometry, type GuidePreview, type ValueStore } from './guideModel'
import { sourcePreviewMarkers } from '../dialogs/menu'
import { useDrawsPreview, usePreviewState } from '../dialogs/usePreview'


const AudioWaveform = TesseraIcons.AudioWaveformIcon
const Film = TesseraIcons.FilmIcon

type Props = {
  doc: KitEngine | null
  /** The engine's revision: the picture is drawn again when it moves (a relink, Toggle Proxies, an edit in a sequence shown here). */
  revision: number | null
  view: SourceView
  monitor: MonitorView
  playback: Playback
  playing: boolean
  looping: boolean
  proxies: boolean
  /** The tool: the Hand pans a magnified picture instead of dragging the clip out. */
  tool: string
  phrase: Phrases
  invoke: (id: string, params?: Record<string, unknown>) => unknown
  status: (text: string) => void
  /** The clip's name, which a double-click on the picture shows (upstream shows info, not the clip's settings). */
  name: string
  /** Pauses the Timeline's media queue while a scrub moves the source playhead. */
  setScrubbing: (scrubbing: boolean) => void
  onShowTransport: (show: boolean) => void
  /** Hears each frame drawn, for the frames-shown readout. */
  onDrawn?: () => void
  /** The project's Title and Action Safe Areas, which Safe Margins draw (Project Settings ▸ General). */
  safeAreas?: SafeAreaPercents
  /** The Timeline's queue the waveform reads its peaks through, and the engine revision when the clip's media is a sequence (else null). */
  queue: MediaQueue
  peaksRevision: number | null
  /** Where the picture is drawn, for the guides and rulers; a guide dialog's preview; a guide drag's release. */
  guideGeometry: ValueStore<GuideGeometry>
  guidePreview: ValueStore<GuidePreview>
  onGuides: (guides: readonly Guide[], show: boolean) => void
}

/**
 * The Source monitor (upstream `monitor.rs` `show` with `Which::Source`): the Source clip's
 * picture at the source playhead on its own canvas, from a reduced copy (`itemFrame` at the
 * drawn size, within the engine's cap and the resolution's scale), one request in flight, the
 * latest time replacing any other waiting, so playback drops frames by the clock rather than
 * queueing them. Dragging the picture, or one of the drag buttons, takes the marked range to the
 * Timeline (`source_drag.rs`). Its transport, marks, and keys are Source-targeted.
 */
export function SourceMonitor(props: Props) {
  const { view, monitor, playback, invoke, phrase } = props
  const rate = useMemo(() => rateOf(view.fps), [view.fps])
  const resting = useRef(view.playhead)
  resting.current = view.playhead
  const clock = useMemo<MonitorClock>(() => ({ subscribe: playback.subscribeSourceTime, get: () => playback.sourceTime() ?? resting.current }), [playback])
  const latest = useRef(props)
  latest.current = props
  // A scrub or a typed time: the latest position goes, one per frame; a playing clock carries on from there (upstream re-anchors it).
  const send = useMemo(() => animationFrameLatest(async (ticks: number) => latest.current.playback.moveSource(ticks)), [])
  useEffect(
    () => () => {
      send.cancel()
      latest.current.setScrubbing(false)
    },
    [send],
  )
  const onSeek = (ticks: number, final: boolean) => {
    props.setScrubbing(!final)
    if (final) send.flush(ticks)
    else send(ticks)
  }
  const onCancelSeek = () => {
    send.cancel()
    props.setScrubbing(false)
  }
  // A dialog's markers preview of the clip shown (Scene Edit Detection's on its media): drawn on
  // the bar, added and changed ones outlined; the strip lists the rest (Task 10's note).
  const previewState = usePreviewState()
  const previewDiff = previewState.open && previewState.kinds.includes('markers') ? previewState.diff : null
  const bar = useMemo(() => sourcePreviewMarkers(view, previewDiff), [view, previewDiff])
  const root = useRef<HTMLDivElement>(null)
  useDrawsPreview('markers', true, bar.covers, `${view.item}:${view.media}`, root)
  const barMarkers = useMemo(() => bar.markers.map((marker) => ({ start: marker.start, color: markerColor(marker.color), mark: marker.mark })), [bar.markers])
  const drag = (video: boolean, audio: boolean) => (event: ReactDragEvent<HTMLElement>) => {
    const payload = sourceDragPayload(latest.current.view, video, audio)
    if (!payload) {
      event.preventDefault()
      return
    }
    playback.stopSource()
    startFilmDrag(event.nativeEvent, payload)
  }
  return (
    <Monitor
      which="source"
      rootRef={root}
      view={monitor}
      marks={view}
      rate={rate}
      fps={view.fps}
      dropFrame={false}
      markers={barMarkers}
      clock={clock}
      playing={props.playing}
      looping={props.looping}
      proxies={props.proxies}
      editable={rangeEditable(view)}
      item={view.item}
      revision={props.revision}
      phrase={phrase}
      invoke={invoke}
      onSeek={onSeek}
      onCancelSeek={onCancelSeek}
      onSourceNav={(seek) => playback.moveSource(sourceNavTicks({ ...view, playhead: clock.get() }, rate, seek))}
      onRange={(change) => {
        if (change.phase === 'start') {
          playback.stopSource()
          return
        }
        const params = setMarksParams(view.item, change.edge, change.original, change.preview, view.start, rate)
        if (params) void invoke('project.setMarks', params)
      }}
      onShowTransport={props.onShowTransport}
      middle={<DragButtons view={view} phrase={phrase} onDragStart={drag} />}
      picture={
        <SourcePicture
          {...props}
          clock={clock}
          draggable={props.tool !== 'Hand' && view.hasVideo && view.width > 0}
          onDragStart={drag(true, true)}
          onDragAudio={drag(false, true)}
          onSeek={onSeek}
          onCancelSeek={onCancelSeek}
          rate={rate}
          onDoubleClick={() => props.status(props.name)}
        />
      }
    />
  )
}

/** `source_drag::controls`: Drag Video Only, Drag Audio Only, and Drag Video and Audio, each enabled by the streams the clip has. */
function DragButtons({ view, phrase, onDragStart }: { view: SourceView; phrase: Phrases; onDragStart: (video: boolean, audio: boolean) => (event: ReactDragEvent<HTMLElement>) => void }) {
  const ui = useUi()
  const buttons = [
    { id: 'control:source.drag.video', label: 'Drag Video Only', video: true, audio: false, enabled: view.hasVideo },
    { id: 'control:source.drag.audio', label: 'Drag Audio Only', video: false, audio: true, enabled: view.hasAudio },
    { id: 'control:source.drag.both', label: 'Drag Video and Audio', video: true, audio: true, enabled: view.hasVideo && view.hasAudio },
  ]
  return (
    <span className="film-source-drags">
      {buttons.map((button) => {
        const state = ui.state(button.id)
        if (state.hidden) return null
        const enabled = button.enabled && !state.disabled && !state.denied
        return (
          <button
            key={button.id}
            type="button"
            className="film-source-drag"
            title={phrase(button.label)}
            aria-label={phrase(button.label)}
            disabled={!enabled}
            draggable={enabled}
            data-kit-ui-id={button.id}
            data-testid={`film-${button.id.slice('control:'.length).replaceAll('.', '-')}`}
            onDragStart={onDragStart(button.video, button.audio)}
            onDragEnd={endFilmDrag}
          >
            {button.video ? <Film size={13} aria-hidden="true" /> : null}
            {button.audio ? <AudioWaveform size={13} aria-hidden="true" /> : null}
          </button>
        )
      })}
    </span>
  )
}

type PictureProps = Props & {
  clock: MonitorClock
  rate: ReturnType<typeof rateOf>
  draggable: boolean
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void
  onDragAudio: (event: ReactDragEvent<HTMLElement>) => void
  onSeek: (ticks: number, final: boolean) => void
  onCancelSeek: () => void
  onDoubleClick: () => void
}

/**
 * The picture area (upstream `show` for the Source): the picture, fitted or magnified about the
 * centre with a pan (the wheel, or the Hand tool), at the effective resolution, in the display
 * mode (a channel in grey by `channelPass`); the waveform in its place for Audio Waveform and a
 * clip with no picture, or under it in the split view. Only the picture renders as the source
 * playhead moves (the waveform moves its playhead line alone).
 */
function SourcePicture(props: PictureProps) {
  const { view, monitor, clock, tool, draggable, onDragStart, onDoubleClick, safeAreas, phrase } = props
  const display = monitor.display
  const hasPicture = view.hasVideo && view.width > 0 && view.height > 0
  const layout = sourceLayout(hasPicture, display)
  const area = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [pan, setPan] = useState({ x: 0, y: 0 })
  useEffect(() => {
    const element = area.current
    if (!element) return undefined
    const measure = () => setSize((shown) => (shown.width === element.clientWidth && shown.height === element.clientHeight ? shown : { width: element.clientWidth, height: element.clientHeight }))
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // A new magnification starts centred (upstream resets the pan).
  useEffect(() => setPan({ x: 0, y: 0 }), [monitor.zoom])
  const split = Math.round(size.height * SPLIT)
  // Rulers along the top and left of the picture's part (upstream: only while a picture shows).
  const inset = monitor.showRulers && layout.picture ? RULER : 0
  // The picture's part of the area: all of it, or the top of the split (`split - 2`), inside the rulers.
  const pictureArea = { x: inset, y: inset, width: Math.max(0, size.width - inset), height: Math.max(0, (layout.waveform === 'split' ? split - 2 : size.height) - inset) }
  const dpr = window.devicePixelRatio || 1
  const box: Box = pictureBox(pictureArea, view.width || 16, view.height || 9, monitor.zoom, pan, dpr)
  // The guides' and rulers' geometry, set when the layout changes (a playback frame does not move it).
  const { guideGeometry } = props
  const frameWide = view.width || 1920
  const frameHigh = view.height || 1080
  useLayoutEffect(() => {
    guideGeometry.set(layout.picture && size.width > 0 ? { area: pictureArea, pic: box, frame: { width: frameWide, height: frameHigh } } : null)
  })
  useEffect(() => () => guideGeometry.set(null), [guideGeometry])
  /** A press on a ruler or a guide: the picture's own drag (to the Timeline) waits. */
  const guidePress = useRef(false)
  const magnified = monitor.zoom != null
  const panBy = (dx: number, dy: number) => {
    const maxX = Math.max(0, (box.width - pictureArea.width) / 2)
    const maxY = Math.max(0, (box.height - pictureArea.height) / 2)
    setPan((at) => ({ x: Math.min(maxX, Math.max(-maxX, at.x + dx)), y: Math.min(maxY, Math.max(-maxY, at.y + dy)) }))
  }
  const panning = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!magnified || tool !== 'Hand' || event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    panning.current = { x: event.clientX, y: event.clientY }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = panning.current
    if (!from) return
    panBy(event.clientX - from.x, event.clientY - from.y)
    panning.current = { x: event.clientX, y: event.clientY }
  }
  // The marks as the monitor shows them: the whole clip until marked (`show`'s implicit marks).
  const span = monitorSpan('source', view, props.rate)
  return (
    <div
      ref={area}
      className="film-source"
      data-testid="film-source"
      data-kit-ui-id="control:monitor.picture"
      data-display={display}
      data-hand={(magnified && tool === 'Hand') || undefined}
      draggable={draggable && layout.picture}
      onDragStart={(event) => {
        if (guidePress.current) {
          event.preventDefault()
          return
        }
        onDragStart(event)
      }}
      onDragEnd={endFilmDrag}
      onDoubleClick={onDoubleClick}
      onWheel={(event) => magnified && layout.picture && panBy(-event.deltaX, -event.deltaY)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (panning.current = null)}
    >
      {layout.picture ? <SourceFrame {...props} box={box} /> : null}
      {monitor.safeMargins && layout.picture ? <SafeMargins box={box} areas={safeAreas} testId="film-source-safe-margins" /> : null}
      {layout.picture ? <GuideLayer monitor="source" view={monitor} geometry={guideGeometry} preview={props.guidePreview} root={area} onGuides={props.onGuides} busy={guidePress} /> : null}
      {layout.picture && display !== 'composite' ? (
        <span className="film-monitor-mode" data-testid="film-source-mode">
          {phrase(DISPLAY_LABELS[display])}
        </span>
      ) : null}
      {layout.waveform ? (
        <SourceWaveform
          doc={props.doc}
          queue={props.queue}
          item={view.media}
          sourceItem={view.item}
          revision={props.peaksRevision}
          duration={view.end}
          markIn={span.markIn ?? view.start}
          markOut={span.markOut ?? view.end}
          clock={clock}
          style={layout.waveform === 'split' ? { top: split + 2 } : undefined}
          phrase={phrase}
          onSeek={props.onSeek}
          onCancelSeek={props.onCancelSeek}
          onDragOut={props.onDragAudio}
        />
      ) : null}
    </div>
  )
}

/**
 * The Source clip's frame at the source playhead, from a reduced copy (`itemFrame`), in the
 * display mode: a channel goes through `channelPass` on that copy, as upstream's CPU path. It
 * alone renders as the source playhead moves.
 */
function SourceFrame({ doc, revision, view, monitor, playing, clock, onDrawn, box }: PictureProps & { box: Box }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const ticks = useSyncExternalStore(clock.subscribe, clock.get)
  const seconds = ticks / TICKS_PER_SECOND
  const display = monitor.display
  const dpr = window.devicePixelRatio || 1
  const scale = renderScaleOf(effectiveRes(monitor, playing), (box.width * dpr) / Math.max(1, view.width))
  // The width to ask for: the drawn width at device scale, within the engine's caps, no more than the resolution gives.
  const wantWidth = box.width > 0 ? Math.max(1, Math.min(frameWidth(box.width, dpr, view.height / view.width), Math.round(view.width * scale))) : 0
  const wanted = useRef({ doc, item: view.item, seconds, width: wantWidth, revision, display })
  wanted.current = { doc, item: view.item, seconds, width: wantWidth, revision, display }
  const drawn = useRef(onDrawn)
  drawn.current = onDrawn
  const draw = useMemo(
    () =>
      oneInFlight(async () => {
        const target = canvas.current
        const asked = wanted.current
        const { doc: engine, item, seconds: at, width } = asked
        if (!target || !engine || width <= 0) return
        let bytes: Uint8Array
        try {
          bytes = await engine.invoke<Uint8Array>('itemFrame', item, at, width)
        } catch (error) {
          // No picture there (an offline clip, an item gone): an empty picture, not the last one.
          target.getContext('2d')?.clearRect(0, 0, target.width, target.height)
          throw error
        }
        // Another clip, size, mode, or document was asked for meanwhile: its own draw follows; this one is stale.
        const now = wanted.current
        if (now.doc !== asked.doc || now.item !== asked.item || now.width !== asked.width || now.revision !== asked.revision || now.display !== asked.display) return
        const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const w = data.getUint32(0, true)
        const h = data.getUint32(4, true)
        if (target.width !== w || target.height !== h) {
          target.width = w
          target.height = h
        }
        const pixels = new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset + 8, w * h * 4)
        if (isChannel(asked.display)) channelPass(pixels, asked.display)
        target.getContext('2d')?.putImageData(new ImageData(pixels, w, h), 0, 0)
        target.dataset.display = asked.display
        drawn.current?.()
      }),
    [],
  )
  useEffect(() => {
    void draw().catch(() => undefined)
  }, [draw, doc, view.item, seconds, wantWidth, revision, display])
  return <canvas ref={canvas} className="film-source-picture" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />
}
