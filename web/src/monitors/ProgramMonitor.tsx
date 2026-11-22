import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MutableRefObject, type RefObject } from 'react'
import { KitDocumentCanvas, type KitCanvasHandle, type KitCanvasView, type KitEngine, type Phrases, type RasterView, type RasterViewportStats } from '@kition/sdk/editor'
import { TICKS_PER_SECOND, picturePanBounds, type FilmInfo } from '../film'
import type { Playback } from '../session/playback'
import { markerColor } from '../timeline/Ruler'
import { Monitor, type MonitorClock } from './Monitor'
import { RESOLUTIONS, effectiveRes, type MonitorView } from './monitorView'
import { rateOf, renderScaleOf, repaintTicks, sameAreas, setMarksParams } from './model'
import { frameWidth } from './frameSize'
import { CompareView } from './CompareView'
import { DISPLAY_LABELS, channelPass, createLatestRead, isChannel, type ChannelMode } from './displayModes'
import { animationFrameLatest } from './throttle'
import { SafeMargins } from './SafeMargins'
import { useProgramGraphics } from './useProgramGraphics'
import { GuideLayer } from './Guides'
import type { Guide, GuideGeometry, GuidePreview, ValueStore } from './guideModel'
import { createPreviewFrames, decodeFrame, type PreviewKey } from '../dialogs/preview'
import { PreviewContext, animationFrame, useDrawsPreview, usePreviewFilm, usePreviewState } from '../dialogs/usePreview'
import { previewMarkers } from '../dialogs/previewViews'

type Props = {
  film: FilmInfo
  doc: KitEngine | null
  canvas: RefObject<KitCanvasHandle | null>
  viewMemory: MutableRefObject<RasterView | null>
  monitor: MonitorView
  playback: Playback
  playing: boolean
  looping: boolean
  proxies: boolean
  phrase: Phrases
  invoke: (id: string, params?: Record<string, unknown>) => unknown
  /** Moves the program playhead (`playhead.set`, ticks) and refreshes the editor. */
  seekTicks: (ticks: number) => Promise<unknown>
  /** Repaints the program canvas without a document change (a new render scale), leaving the playhead at `ticks`. */
  repaint: (ticks: number) => Promise<unknown>
  /** Counts the playhead moves the editor asked for (see `repaintTicks`). */
  playheadMoves: () => number
  /** The engine's revision, which a range drag holds on. */
  revision: number | null
  setScrubbing: (scrubbing: boolean) => void
  onShowTransport: (show: boolean) => void
  /** The tool (upstream's `app.ui.tool`): the picture's presses go by it (Task 17's graphics tools, the Hand on a magnified picture). */
  tool: string
  /** The selected graphic's selected layers (the session state's `graphic_layers`): their boxes follow it. */
  graphicLayers: readonly number[]
  /** Why an edit would be refused now (a dialog's preview), or null: a layer drag is refused at its start, said in the status bar. */
  editRefusal: (id: string) => string | null
  status: (text: string) => void
  /** Where the monitor puts the keys its graphics tools take (the Pen's Enter and Escape), which the editor asks first. */
  graphicsKeys: MutableRefObject<((event: KeyboardEvent<HTMLElement>) => boolean) | null>
  /** Begin Text Editing for a Graphic Layer, set while the monitor is shown. */
  graphicsText: MutableRefObject<(() => Promise<unknown>) | null>
  /** What Begin Text Editing says when the layer is not in the picture (the editor's own string). */
  textNotShown: string
  /** What the status bar says when a layer drag is dropped because its layer changed meanwhile (the editor's own string). */
  layerChanged: string
  /** Every canvas view (a render while playing counts a frame shown). */
  onView: (view: KitCanvasView, stats: RasterViewportStats | null) => void
  /** A channel picture drawn while playing (the canvas is not painted then): counts a frame shown. */
  onFrameShown: () => void
  /** Set while a channel mode's picture covers the canvas: playback then leaves the canvas unpainted, as a picture preview does. */
  covered: MutableRefObject<boolean>
  /** Where the picture is drawn, for the guides and rulers (set as the canvas's view changes); a guide dialog's preview; a guide drag's release. */
  guideGeometry: ValueStore<GuideGeometry>
  guidePreview: ValueStore<GuidePreview>
  onGuides: (guides: readonly Guide[], show: boolean) => void
}

type ChannelKey = { doc: KitEngine; sequence: number; revision: number | null; ticks: number; width: number; mode: ChannelMode }
const sameChannel = (a: ChannelKey, b: ChannelKey) => a.doc === b.doc && a.sequence === b.sequence && a.revision === b.revision && a.ticks === b.ticks && a.width === b.width && a.mode === b.mode

/**
 * Upstream's dropped-frame dot (`show`), at the picture's top left while the Program plays:
 * yellow once the playback clock has dropped a frame in this play, else green. It reads the
 * playback controller's own count, and renders only when that turns.
 */
function DroppedDot({ playback }: { playback: Playback }) {
  // The clock's drops come with its moves; the channel picture's skipped frames on their own.
  const subscribe = useCallback(
    (listener: () => void) => {
      const moves = playback.subscribeProgramTime(listener)
      const skips = playback.subscribeDropped(listener)
      return () => {
        moves()
        skips()
      }
    },
    [playback],
  )
  const dropped = useSyncExternalStore(subscribe, () => playback.programDropped() > 0)
  return <span className="film-program-dropped" data-dropped={dropped ? 'true' : 'false'} data-testid="film-program-dropped" aria-hidden="true" />
}

/**
 * The Program monitor (upstream `monitor.rs` `show` with `Which::Program`): the document canvas
 * at the effective resolution (`setRenderScale`, upstream `MonitorView::effective_res` and the
 * on-screen size), magnified through the canvas's view, safe margins over it, and the shared
 * monitor chrome on the sequence's playhead and marks.
 */
export function ProgramMonitor(props: Props) {
  const { film, doc, canvas, viewMemory, monitor, playback, playing, phrase, invoke } = props
  const tps = film.ticksPerSecond
  const rate = useMemo(() => rateOf(film.fps), [film.fps])
  const resting = useRef(film.playhead)
  resting.current = film.playhead
  const clock = useMemo<MonitorClock>(() => ({ subscribe: playback.subscribeProgramTime, get: () => Math.round((playback.programTime() ?? playback.restingProgram(resting.current)) * tps) }), [playback, tps])
  const latest = useRef(props)
  latest.current = props
  const send = useMemo(() => animationFrameLatest((ticks: number) => latest.current.seekTicks(ticks)), [])
  useEffect(
    () => () => {
      send.cancel()
      latest.current.setScrubbing(false)
    },
    [send],
  )
  const onSeek = (ticks: number, final: boolean) => {
    playback.stopProgram()
    props.setScrubbing(!final)
    if (final) send.flush(ticks)
    else send(ticks)
  }
  const ticks = (seconds: number | null) => (seconds == null ? null : Math.round(seconds * tps))
  const marks = { start: 0, end: Math.round(film.duration * tps), markIn: ticks(film.in), markOut: ticks(film.out) }

  // ---- the render scale: the effective resolution, no more than the picture needs on screen
  const canvasView = useRef<KitCanvasView | null>(null)
  const applied = useRef<number | null>(null)
  const [shownScale, setShownScale] = useState<number | null>(null)
  const applyScale = useCallback(() => {
    const { doc: engine, monitor: view, playing: now } = latest.current
    if (!engine) return
    const zoom = canvasView.current?.zoom ?? 1
    const scale = renderScaleOf(effectiveRes(view, now), zoom * (window.devicePixelRatio || 1))
    if (scale === applied.current) return
    applied.current = scale
    const movesAtStart = latest.current.playheadMoves()
    void engine
      .invoke('setRenderScale', scale)
      .then(() => {
        if (applied.current !== scale) return undefined
        setShownScale(scale)
        // While playing, the clock's next frame paints at the new scale. Stopped, the canvas is
        // repainted where the playhead rests: the clock's stop position until the editor's model
        // catches up, never the model's stale playhead.
        if (latest.current.playing) return undefined
        // A step or a seek since then repaints by itself; this older position would undo it.
        const at = repaintTicks(movesAtStart, latest.current.playheadMoves(), clock.get())
        return at == null ? undefined : latest.current.repaint(at)
      })
      .catch(() => {
        applied.current = null
      })
  }, [clock])
  useEffect(() => {
    applied.current = null
  }, [doc])
  useEffect(() => {
    applyScale()
  }, [applyScale, doc, playing, monitor.res, monitor.pausedRes, monitor.highQuality])

  // ---- magnification: Fit, or the zoom (one frame pixel per device pixel at 100%) about the centre.
  // A wheel zoom on the canvas shows its own percentage in the dropdown until a level is chosen.
  /** The magnification pick last applied to the canvas (`MonitorView.zoomPick`); undefined until the canvas has a view. */
  const shownPick = useRef<number | undefined>(undefined)
  const [wheelZoom, setWheelZoom] = useState<number | null | undefined>(undefined)
  // Scrolling stops a margin past the picture: the wheel and the Hand never leave it for empty canvas.
  const [viewZoom, setViewZoom] = useState<number | null>(null)
  const panBounds = useMemo(() => picturePanBounds(film.width, film.height, viewZoom), [film.width, film.height, viewZoom])
  /** When the canvas last had a wheel (a Ctrl+wheel or pinch zooms it); a zoom soon after is the wheel's. Never at first: the first fit, early in a frame's life, is not a wheel's. */
  const wheeled = useRef(Number.NEGATIVE_INFINITY)
  const applyZoom = useCallback(() => {
    const handle = latest.current.canvas.current
    const { monitor: view, film: sequence } = latest.current
    // A render can report a view before ResizeObserver has placed this viewport. The canvas
    // fills viewMemory only after placement; wait for that first fit before consuming the pick.
    if (!handle || !latest.current.viewMemory.current || !handle.view() || shownPick.current === view.zoomPick) return
    // The first view after a mount takes the magnification in force (none to apply at Fit: the canvas fits by itself).
    const first = shownPick.current === undefined
    shownPick.current = view.zoomPick
    setWheelZoom(undefined)
    if (first && view.zoom == null) return
    if (view.zoom == null) {
      handle.fit()
      return
    }
    const zoom = view.zoom / (window.devicePixelRatio || 1)
    handle.zoomTo(zoom)
    const shown = handle.view()
    if (shown) handle.panTo(sequence.width / 2 - shown.width / (2 * zoom), sequence.height / 2 - shown.height / (2 * zoom))
  }, [])
  useEffect(() => {
    applyZoom()
    // Only a magnification chosen (a level picked again after a wheel zoom included) magnifies again.
  }, [applyZoom, monitor.zoomPick])
  useEffect(() => {
    // KitCanvas first fits its new viewport in ResizeObserver. Its first onView then reapplies
    // a chosen fixed magnification; applying here would be overwritten by that initial fit.
    shownPick.current = undefined
  }, [viewMemory])

  // ---- Snap in Program Monitor: the graphics tools' drags snap to the guides and the frame (upstream `snap_move`).
  const snapView = useCallback(() => latest.current.monitor, [])

  // ---- the graphics tools and the Hand on the picture (upstream `graphics.rs` `monitor_overlay`, `monitor_view.rs` `pan_input`)
  const graphics = useProgramGraphics({ doc, revision: props.revision, playhead: film.playhead, width: film.width, height: film.height, tool: props.tool, selection: film.selection, graphicLayers: props.graphicLayers, clock, phrase, invoke, textNotShown: props.textNotShown, snapping: snapView, editRefusal: props.editRefusal, status: props.status, layerChanged: props.layerChanged })
  const { graphicsKeys } = props
  useEffect(() => {
    graphicsKeys.current = graphics.keyDown
    return () => {
      if (graphicsKeys.current === graphics.keyDown) graphicsKeys.current = null
    }
  }, [graphicsKeys, graphics.keyDown])
  const { graphicsText } = props
  useEffect(() => {
    graphicsText.current = graphics.beginTextEditing
    return () => {
      if (graphicsText.current === graphics.beginTextEditing) graphicsText.current = null
    }
  }, [graphicsText, graphics.beginTextEditing])

  // ---- safe margins follow the canvas's view outside React
  const margins = useRef<HTMLDivElement>(null)
  const picture = useRef<HTMLDivElement>(null)
  const current = useRef<HTMLDivElement>(null)
  /**
   * The guides' and rulers' geometry (`GuideGeometry`) in the picture element's pixels: the current
   * picture's region and the frame in it at the canvas's view. Measured only when the view or the
   * layout changes, never per playback frame.
   */
  const measured = useRef('')
  const placeGuides = useCallback((force = false) => {
    const view = canvasView.current
    const region = current.current
    const { film: sequence, guideGeometry } = latest.current
    if (!view || !region) return
    const key = `${view.zoom} ${view.x} ${view.y} ${view.width} ${view.height} ${sequence.width} ${sequence.height}`
    if (!force && key === measured.current) return
    measured.current = key
    const area = { x: region.offsetLeft, y: region.offsetTop, width: region.clientWidth, height: region.clientHeight }
    guideGeometry.set({ area, pic: { x: area.x - view.x * view.zoom, y: area.y - view.y * view.zoom, width: sequence.width * view.zoom, height: sequence.height * view.zoom }, frame: { width: sequence.width, height: sequence.height } })
  }, [])
  /**
   * `placeGuides` on the next animation frame, once for every view that arrives before it. A view
   * can arrive inside a ResizeObserver delivery (KitCanvas places its viewport there), and the
   * geometry store re-renders the guides synchronously (`useSyncExternalStore`): rendering then
   * observes elements anew mid-delivery, which WebKit reports as a ResizeObserver loop.
   */
  const guidesFrame = useRef<number | null>(null)
  const placeGuidesSoon = useCallback(() => {
    if (guidesFrame.current !== null) return
    guidesFrame.current = requestAnimationFrame(() => {
      guidesFrame.current = null
      placeGuides()
    })
  }, [placeGuides])
  useEffect(
    () => () => {
      if (guidesFrame.current !== null) cancelAnimationFrame(guidesFrame.current)
      guidesFrame.current = null
    },
    [],
  )
  const previewPicture = useRef<HTMLCanvasElement>(null)
  const channelPicture = useRef<HTMLCanvasElement>(null)
  const placeMargins = useCallback(() => {
    const view = canvasView.current ?? latest.current.canvas.current?.view() ?? null
    if (!view) return
    const { film: sequence } = latest.current
    for (const element of [margins.current, previewPicture.current, channelPicture.current]) {
      if (!element) continue
      element.style.left = `${-view.x * view.zoom}px`
      element.style.top = `${-view.y * view.zoom}px`
      element.style.width = `${sequence.width * view.zoom}px`
      element.style.height = `${sequence.height * view.zoom}px`
    }
  }, [])

  // ---- a dialog's picture preview (Task 9): the preview's frame at the playhead in place of the
  // program, with a Preview badge, drawn again as the playhead moves. Frames for another serial,
  // revision, or document are dropped (lesson 6).
  const previewContext = useContext(PreviewContext)
  const previewState = usePreviewState()
  // The monitor draws the picture preview only while it is on screen (a hidden tab keeps it mounted
  // in no frame, but a collapsed or off-screen picture leaves it to the strip).
  const [onScreen, setOnScreen] = useState(true)
  useEffect(() => {
    const element = picture.current
    if (!element || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver((entries) => setOnScreen(entries.some((entry) => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useDrawsPreview('picture', onScreen, undefined, undefined, picture)
  // A markers preview shows on the bar's markers too (the Timeline's ruler and the Markers panel draw it in full).
  const markersPreview = usePreviewFilm(previewState.open && previewState.kinds.includes('markers'))
  const shownMarkers = useMemo(() => (markersPreview && markersPreview.film.activeSequence === film.activeSequence ? previewMarkers(film.markers, markersPreview.film.markers, markersPreview.diff, film.activeSequence) : null), [markersPreview, film.markers, film.activeSequence])
  const miniMarkers = useMemo(
    () => (shownMarkers?.markers ?? film.markers).map((marker) => ({ start: Math.round(marker.start * film.ticksPerSecond), color: markerColor(marker.color), mark: shownMarkers?.marks.get(marker.id) })),
    [shownMarkers, film.markers, film.ticksPerSecond],
  )
  const previewing = onScreen && previewState.open && previewState.kinds.includes('picture')
  // A preview that changes the project's settings (Project Settings) draws its safe areas, marked,
  // whether or not Safe Margins is on; the copy's inspect() is read only for such a preview.
  const settingsPreview = usePreviewFilm(previewing && (previewState.diff?.project?.changed ?? []).includes('settings'))
  const previewAreas = settingsPreview && !sameAreas(settingsPreview.film.safeAreas, film.safeAreas) ? settingsPreview.film.safeAreas : null
  const previewKey = useRef<PreviewKey | null>(null)
  // Keyed on the revision the preview began on (lesson 6), not the document's latest.
  previewKey.current = previewing ? { document: previewState.document, revision: previewState.revision, serial: previewState.serial } : null
  const [previewShown, setPreviewShown] = useState<number | null>(null)
  const pictures = useMemo(
    () =>
      previewContext
        ? createPreviewFrames({
            engine: previewContext.preview.engine,
            schedule: animationFrame,
            current: () => previewKey.current,
            onFrame: (image) => {
              const element = previewPicture.current
              if (!element) return
              element.width = image.width
              element.height = image.height
              element.getContext('2d')?.putImageData(new ImageData(image.pixels as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0)
              element.dataset.serial = String(image.key.serial)
              element.dataset.seconds = String(image.seconds)
              setPreviewShown(image.key.serial)
            },
          })
        : null,
    [previewContext],
  )
  useEffect(() => () => pictures?.dispose(), [pictures])
  const askPreview = useCallback(() => {
    const key = previewKey.current
    if (!key || !pictures) return
    const zoom = canvasView.current?.zoom ?? 1
    const { film: sequence } = latest.current
    pictures.request(key, clock.get() / sequence.ticksPerSecond, Math.min(2048, sequence.width * zoom * (window.devicePixelRatio || 1)))
  }, [pictures, clock])
  const askPreviewNow = useRef(askPreview)
  askPreviewNow.current = askPreview
  useEffect(() => {
    if (!previewing) {
      setPreviewShown(null)
      return undefined
    }
    placeMargins()
    askPreview()
    // Scrubbing the playhead while the dialog is open draws the preview there.
    return clock.subscribe(askPreview)
  }, [previewing, previewState.serial, previewState.document, previewState.revision, film.playhead, askPreview, clock, placeMargins])
  // Rulers shown or hidden, or the Comparison View, move the picture's region: measured once laid out.
  useEffect(() => {
    const id = requestAnimationFrame(() => placeGuides(true))
    return () => cancelAnimationFrame(id)
  }, [placeGuides, monitor.showRulers, monitor.display, film.width, film.height])
  useEffect(() => () => props.guideGeometry.set(null), [props.guideGeometry])
  const marginsShown = monitor.safeMargins || previewAreas != null
  useEffect(() => {
    if (marginsShown) placeMargins()
  }, [marginsShown, placeMargins, film.width, film.height])

  // ---- display modes (upstream `show`): a channel in grey over the picture, or the Comparison View.
  const display = monitor.display
  const compare = display === 'comparison'
  // A channel picture comes from a reduced copy of the sequence's frame (`itemFrame`, as upstream's
  // channel modes take the CPU path), through `channelPass`; while it covers the canvas, playback
  // leaves the canvas unpainted. Read only on screen, once per document, sequence, revision, time,
  // width, and channel (lesson 6), one in flight, at most once per frame of the clock.
  const channel = isChannel(display) && onScreen ? display : null
  const channelNow = useRef(channel)
  channelNow.current = channel
  const [channelShown, setChannelShown] = useState(false)
  // Another channel (or none) shows nothing until its own picture comes: never the last one under the new label.
  useEffect(() => setChannelShown(false), [channel])
  const channelReads = useMemo(
    () =>
      createLatestRead<ChannelKey, Uint8Array>({
        read: (key) => key.doc.invoke<Uint8Array>('itemFrame', key.sequence, key.ticks / TICKS_PER_SECOND, key.width),
        same: sameChannel,
        onValue: (key, bytes) => {
          const target = channelPicture.current
          const image = decodeFrame(bytes)
          // Not drawn (the canvas went, or no picture): not shown, so it is read again when wanted.
          if (!target || !image) return false
          channelPass(image.pixels, key.mode)
          if (target.width !== image.width || target.height !== image.height) {
            target.width = image.width
            target.height = image.height
          }
          target.getContext('2d')?.putImageData(new ImageData(image.pixels as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0)
          target.dataset.ticks = String(key.ticks)
          setChannelShown(true)
          if (latest.current.playing) latest.current.onFrameShown()
        },
        // No picture there: an empty picture, not the last one.
        onError: () => {
          const target = channelPicture.current
          target?.getContext('2d')?.clearRect(0, 0, target.width, target.height)
          setChannelShown(false)
        },
        // A clock frame replaced before it was read never showed: the dropped-frame dot counts it.
        onSkip: () => latest.current.playback.noteDropped(),
      }),
    [],
  )
  const askChannel = useCallback(() => {
    const { doc: engine, film: sequence, monitor: view, playing: now, revision } = latest.current
    const mode = isChannel(view.display) ? view.display : null
    if (!engine || !mode || sequence.activeSequence == null) return
    const zoom = canvasView.current?.zoom ?? 1
    const dpr = window.devicePixelRatio || 1
    const scale = renderScaleOf(effectiveRes(view, now), zoom * dpr)
    const width = Math.max(1, Math.min(frameWidth(sequence.width * zoom, dpr, sequence.height / Math.max(1, sequence.width)), Math.round(sequence.width * scale)))
    channelReads.want({ doc: engine, sequence: sequence.activeSequence, revision, ticks: clock.get(), width, mode })
  }, [channelReads, clock])
  const askChannelNow = useRef(askChannel)
  askChannelNow.current = askChannel
  const { covered } = props
  /** Whether the channel picture covered the canvas: leaving it while playing paints the canvas at once. */
  const wasCovered = useRef(false)
  /** The channel the reads were last asked for. */
  const readFor = useRef<ChannelMode | null>(null)
  useEffect(() => {
    if (!channel) {
      covered.current = false
      channelReads.stop()
      readFor.current = null
      if (wasCovered.current && latest.current.playing) void latest.current.repaint(clock.get())
      wasCovered.current = false
      return undefined
    }
    covered.current = true
    wasCovered.current = true
    // Another channel: what the reads showed is not this one's (Red, Green, Red again before Green
    // landed would otherwise count Red as shown and never read it again).
    if (readFor.current !== channel) {
      readFor.current = channel
      channelReads.stop()
    }
    placeMargins()
    askChannel()
    const stop = clock.subscribe(askChannel)
    return () => {
      stop()
      covered.current = false
    }
  }, [channel, covered, channelReads, askChannel, clock, placeMargins, doc, film.activeSequence, film.playhead, props.revision, playing, monitor.res, monitor.pausedRes, monitor.highQuality])
  useEffect(() => () => channelReads.stop(), [channelReads])
  // The Comparison View fits both pictures (upstream's `fit`); leaving it brings a magnification back.
  const compared = useRef(false)
  useEffect(() => {
    const handle = canvas.current
    if (compare) {
      compared.current = true
      if (monitor.zoom != null) handle?.fit()
      return undefined
    }
    if (!compared.current) return
    compared.current = false
    if (monitor.zoom == null || shownPick.current === undefined) return undefined
    // The canvas widens in this commit: magnify once its new size has been laid out and measured
    // (kit-editor's resize observer runs after layout), so the picture centres on the whole width.
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        shownPick.current = -1
        applyZoom()
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
    // Only entering or leaving the Comparison View fits or magnifies again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare])

  return (
    <Monitor
      which="program"
      view={monitor}
      marks={marks}
      rate={rate}
      fps={film.fps}
      dropFrame={film.dropFrame}
      markers={miniMarkers}
      clock={clock}
      playing={playing}
      looping={props.looping}
      proxies={props.proxies}
      editable={film.activeSequence != null && film.duration > 0}
      item={film.activeSequence}
      revision={props.revision}
      zoomShown={wheelZoom}
      phrase={phrase}
      invoke={invoke}
      onSeek={onSeek}
      onCancelSeek={() => {
        send.cancel()
        props.setScrubbing(false)
      }}
      onRange={(change) => {
        if (change.phase === 'start') {
          playback.stopProgram()
          return
        }
        if (film.activeSequence == null) return
        const params = setMarksParams(film.activeSequence, change.edge, change.original, change.preview, 0, rate)
        if (params) void invoke('project.setMarks', params)
      }}
      onShowTransport={props.onShowTransport}
      picture={
        <div
          ref={picture}
          className="film-program"
          data-testid="film-program"
          data-kit-ui-id="control:monitor.picture"
          data-display={display}
          data-rulers={monitor.showRulers || undefined}
          data-render-scale={shownScale ?? undefined}
          onWheelCapture={() => {
            wheeled.current = performance.now()
          }}
        >
          {/* The picture (the current one in the Comparison View): the canvas and what is drawn over it. */}
          <div ref={current} className="film-program-current">
            <KitDocumentCanvas
              canvas={canvas}
              viewMemory={viewMemory}
              panBounds={panBounds}
              tool={graphics.canvasTool}
              onView={(view, stats) => {
                const zoomed = canvasView.current?.zoom !== view.zoom
                canvasView.current = view
                // The view, for the flow test's checks (zoom and the document point at the top left).
                picture.current?.setAttribute('data-view', `${view.zoom} ${view.x} ${view.y}`)
                if (shownPick.current === undefined) applyZoom()
                if (zoomed) {
                  setViewZoom(view.zoom)
                  applyScale()
                  if (performance.now() - wheeled.current < 500) setWheelZoom(Math.round(view.zoom * (window.devicePixelRatio || 1) * 100) / 100)
                }
                if (latest.current.monitor.safeMargins || previewKey.current || isChannel(latest.current.monitor.display)) placeMargins()
                if (zoomed && previewKey.current) askPreviewNow.current()
                if (zoomed && channelNow.current) askChannelNow.current()
                graphics.onView(view)
                placeGuidesSoon()
                props.onView(view, stats)
              }}
            />
            {channel ? <canvas ref={channelPicture} className="film-program-channel" data-shown={channelShown ? 'true' : 'false'} data-mode={channel} data-testid="film-program-channel" /> : null}
            {previewing ? <canvas ref={previewPicture} className="film-program-preview" data-shown={previewShown != null ? 'true' : 'false'} data-testid="film-program-preview" /> : null}
            {previewing ? (
              <span className="film-preview-badge film-program-preview-badge" data-testid="film-program-preview-badge">
                {phrase('Preview')}
              </span>
            ) : null}
            {marginsShown ? <SafeMargins ref={margins} testId="film-program-safe-margins" areas={previewAreas ?? film.safeAreas} preview={previewAreas != null} /> : null}
            {/* The document's graphics handles are not the preview's: hidden over a preview frame. */}
            {previewing ? null : graphics.overlay}
            {display !== 'composite' && !compare && !previewing ? (
              <span className="film-monitor-mode" data-testid="film-program-mode">
                {phrase(DISPLAY_LABELS[display])}
              </span>
            ) : null}
            {playing ? <DroppedDot playback={playback} /> : null}
          </div>
          {compare && film.activeSequence != null ? (
            <CompareView
              doc={doc}
              sequence={film.activeSequence}
              revision={props.revision}
              width={film.width}
              height={film.height}
              rate={rate}
              fps={film.fps}
              dropFrame={film.dropFrame}
              reference={monitor.compareRef}
              clock={clock}
              scale={RESOLUTIONS[monitor.pausedRes].scale}
              end={Math.round(film.duration * film.ticksPerSecond)}
              shown={onScreen}
              phrase={phrase}
              invoke={invoke}
            />
          ) : null}
          <GuideLayer monitor="program" view={monitor} geometry={props.guideGeometry} preview={props.guidePreview} root={picture} onGuides={props.onGuides} />
        </div>
      }
    />
  )
}
