import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { HAND_TOOL, oneInFlight, useUi, type KitCanvasView, type KitEngine, type KitPointer, type KitTool, type Phrases } from '@kition/sdk/editor'
import { documentReplaced } from '../dialogs/preview'
import { CLICK_MS, DRAG_THRESHOLD } from '../timeline/gestures'
import {
  GRAPHICS_TOOLS,
  MOVED_PX,
  editBox,
  hitsLayer,
  layerAt,
  newTextParams,
  outlinedLayers,
  parseGraphicLayers,
  penCloses,
  penShapeParams,
  pictureOverflows,
  pressKind,
  shapeParams,
  toCanvas,
  toSequence,
  type GraphicLayer,
  type GraphicLayers,
  type Point,
} from './graphicsTools'
import { snapMove, snapPoint, type SnapLine, type SnapView } from './guideModel'
import {
  beginBoxDrag,
  boxChanges,
  clipUnder,
  draggedPlacement,
  followRotation,
  grabAt,
  grabCursor,
  motionOf,
  pictureClips,
  placementOf,
  sizeOfVideoLine,
  type BoxDrag,
  type ClipFrame,
  type Grab,
  type Placement,
} from './clipTransform'
import { dragTicks } from '../panels/effects'
import {
  ANCHOR_ID,
  HANDLE_ID,
  LAYER_ID,
  anchorProps,
  anchorScreen,
  boundsOf,
  crosshair,
  dragProps,
  dragQuad,
  handleDrag,
  handlePoints,
  handleViews,
  interruptLayerDrag,
  isLayerClick,
  layerMarks,
  layerView,
  moveProps,
  pointsOf,
  pressTarget,
  sameFrame,
  snappedMove,
  type LayerView,
  type OverlayPart,
} from '../graphics/layerHandles'

type Options = {
  doc: KitEngine | null
  /** The engine's revision and the playhead (seconds): the layers in the picture are read again when either moves. */
  revision: number | null
  playhead: number
  /** The sequence's size, in pixels. */
  width: number
  height: number
  tool: string
  /** The selected clips: a change reads the layers once, to find a selected graphic whose layers' boxes are drawn. */
  selection: readonly number[]
  /** The selected graphic's selected layers, as the session state keeps them: a change reads the layers again. */
  graphicLayers: readonly number[]
  /** The program clock: while it plays, the selected layers' boxes follow the picture (a read per frame at most). */
  clock: { subscribe: (listener: () => void) => () => void }
  phrase: Phrases
  invoke: (id: string, params?: Record<string, unknown>, options?: { refresh?: 'all' | 'repaint' | 'none' }) => unknown
  /** An engine-style refusal for the status bar in the person's words (`errorStatus`): a Motion box drag on a locked track. */
  errorStatus?: (text: string) => void
  /** What Begin Text Editing says when the text layer is not in the picture. */
  textNotShown: string
  /** The Program monitor's Snap in Program Monitor and guides: the shape and text box drags and the layer moves snap through `snap_move` (Cmd moves freely). */
  snapping?: () => SnapView
  /** Why an edit command would be refused now (a dialog's preview is open), or null: a layer drag is refused at its start, with this said. */
  editRefusal?: (id: string) => string | null
  /** Shows a message in the status bar. */
  status?: (text: string) => void
  /** What the status bar says when a layer drag is dropped because its layer changed meanwhile (the editor's own string). */
  layerChanged?: string
}

/**
 * The text layer being typed into (upstream's `GfxEdit`), and where to put its field until the
 * engine has drawn it. A new text's `clip` and `layer` are null until the engine has made it: the
 * field takes keys from the click on (upstream opens the edit in the same frame), and what is typed
 * meanwhile is sent once they come. `session` names the field, so it stays mounted meanwhile.
 */
type Editing = { session: number; clip: number | null; layer: number | null; text: string; at: Point; size: number; vertical: boolean; since: number; selectAll?: boolean }

/** A Rectangle, Ellipse, or Type drag in progress, in sequence pixels, with the lines its corners snapped to (canvas pixels). */
type Preview = { kind: 'shape' | 'textBox'; ellipse: boolean; start: Point; end: Point; lines: readonly SnapLine[] }

/**
 * A layer drag with the Selection or a Type tool (upstream's `DragKind::Move`, `Handle(n)`,
 * `Anchor`), in canvas pixels: the layer as the press found it, where the press was and the
 * pointer is, and a move's snapped offset with its snap lines. Nothing is sent until the release.
 */
type LayerDrag = { kind: 'move' | 'handle' | 'anchor'; n: number; view: LayerView; start: Point; cur: Point; off: Point; lines: readonly SnapLine[]; sync: (() => void) | null }

/**
 * A drag of a video clip's Motion box (upstream `transform_handles.rs`'s `Drag`), in canvas
 * pixels: what it holds and the box then (`drag`), the clip's frame it was placed from, the Motion
 * values the pointer gives now (`changes`) and a move's snap lines. A drag sends its values to the
 * engine as the pointer moves, at most one per animation frame and none while one is in flight,
 * all merged into one undo step by the drag's own key (`effects.setParam`'s `merge` with a name,
 * the first call with `begin`), so the picture follows live, also for a drag that changes two
 * parameters (the anchor point: Anchor Point and Position; a corner with Uniform Scale off: Scale
 * Height and Width).
 */
/** Counts Motion box drags, so each has its own merge key. */
let boxDrags = 0

type ClipBoxDrag = {
  drag: BoxDrag
  frame: ClipFrame
  changes: Array<[string, unknown]>
  lines: readonly SnapLine[]
  /** The drag's merge key: every value it sends goes into one undo step. */
  key: string
  /** The pointer went past 2 points: from then on the values are sent (a press that stays is a click). */
  moved: boolean
  /** Whether a value was sent yet (the first begins the step); whether any was applied. */
  begun: boolean
  sent: boolean
  /** The values waiting for the next frame, the send in flight, and the frame asked for. */
  wanted: Array<[string, unknown]> | null
  busy: Promise<void> | null
  frameId: number
  /** Released or dropped: nothing more is sent by the pointer. */
  over: boolean
  sync: (() => void) | null
}

/** What the clip boxes were read from: the clips in the picture (front-most first), the ones on locked tracks, and the selected one. */
type ClipBoxes = { frames: ClipFrame[]; locked: ReadonlySet<number>; selected: number | null }
const NO_CLIPS: ClipBoxes = { frames: [], locked: new Set(), selected: null }

/** The Kit UI ids of a video clip's Motion box (upstream `program.transform.box`, `.handle.<n>`, `.anchor`). */
export const CLIP_BOX_ID = 'control:program.transform.box'
export const CLIP_HANDLE_ID = 'control:program.transform.handle'
export const CLIP_ANCHOR_ID = 'control:program.transform.anchor'

/** One press on the canvas to its release (kit-editor's gesture, which its index does not export). */
type KitGesture = Exclude<ReturnType<KitTool['begin']>, void>

const SVG = 'http://www.w3.org/2000/svg'
const EMPTY: GraphicLayers = { layers: [], target: null, selected: null }

const answerOf = (answer: unknown): Record<string, unknown> | null => {
  if (typeof answer === 'string') {
    try {
      return JSON.parse(answer) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : null
}

/** What a read of the layers was made at: another document, revision, or playhead reads them again. */
type ReadAt = { doc: KitEngine | null; revision: number | null; playhead: number }
const readAtOf = ({ doc, revision, playhead }: ReadAt): ReadAt => ({ doc, revision, playhead })
const sameReadAt = (a: ReadAt | null, b: ReadAt) => a != null && a.doc === b.doc && a.revision === b.revision && a.playhead === b.playhead

function cursorOf(tool: string, magnified: boolean) {
  if (tool === 'Type' || tool === 'VerticalType') return 'text'
  if (tool === 'Rectangle' || tool === 'Ellipse' || tool === 'Pen') return 'crosshair'
  return tool === 'Hand' && magnified ? HAND_TOOL.cursor : 'default'
}

/**
 * The Program monitor's graphics tools (upstream `graphics.rs` `monitor_overlay`, the press,
 * drag, click, and Pen handling) and its Hand (`monitor_view.rs` `pan_input`): the canvas tool
 * for the picture, the overlay drawn over it (the Pen's path and a drag's outline, redrawn at most
 * once per animation frame, outside React), the in-place text field, and the Pen's Enter and
 * Escape; and the selected layers' handles (`HandleDrag`): a Selection drag moves a layer, a
 * handle scales, stretches, or resizes it, and the anchor point moves alone, each shown live as an
 * outline and sent once on release (`layerHandles.ts`).
 */
export function useProgramGraphics(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const { doc, revision, playhead, tool } = options
  const documentState = doc?.info.inspected as { project?: { epoch?: number; activeSequence?: number | null } } | null
  const projectEpoch = documentState?.project?.epoch
  const activeSequence = documentState?.project?.activeSequence
  const selectionKey = options.selection.join(',')
  const chosenKey = `${selectionKey}|${options.graphicLayers.join(',')}`
  // Whether the last read found a selected graphic (upstream's `selected_graphic`), whose layers' boxes show.
  const [graphicSelected, setGraphicSelected] = useState(false)

  const view = useRef<KitCanvasView | null>(null)
  const [magnified, setMagnified] = useState(false)
  const layers = useRef<GraphicLayers>(EMPTY)
  const [editing, setEditingState] = useState<Editing | null>(null)
  const editingNow = useRef<Editing | null>(null)
  const setEditing = useCallback((next: Editing | null) => {
    editingNow.current = next
    setEditingState(next)
  }, [])
  const pen = useRef<Point[]>([])
  // Whether the Pen has points, which keeps the layers read (its path goes into the target).
  const [penDrawing, setPenDrawing] = useState(false)
  const setPen = useCallback((points: Point[]) => {
    pen.current = points
    setPenDrawing(points.length > 0)
  }, [])
  const interactionEpoch = useRef(0)
  const sessions = useRef(0)
  /** What was typed into a new text before the engine made it, per edit: sent once it is made, even if the edit has ended. */
  const typedEarly = useRef(new Map<number, string>())
  const hover = useRef<Point | null>(null)
  const preview = useRef<Preview | null>(null)
  const layerDrag = useRef<LayerDrag | null>(null)
  /** The video clips in the picture and their Motion (`clipTransform.ts`), and a Motion box drag in progress. */
  const clipBoxes = useRef<ClipBoxes>(NO_CLIPS)
  const boxDrag = useRef<ClipBoxDrag | null>(null)
  const [clipSelected, setClipSelected] = useState(false)
  /** While a Type box drag is held: it has no cancel, so Escape pressed during it changes nothing. */
  const typeBoxHeld = useRef<(() => boolean) | null>(null)
  // A Type box drag ends on its release whatever happens (as upstream's): Escape pressed during it
  // reaches nothing. Listened to on the window from the monitor's first layout, before the canvas's
  // own Escape (kit-editor drops any held gesture on Escape, registered in its effect).
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (!typeBoxHeld.current?.()) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const svg = useRef<SVGSVGElement>(null)
  // What a host lets the layers' boxes, handles, and anchor point do (hidden: not drawn; disabled or denied: no drag).
  const ui = useUi()
  const allowed = (id: string) => {
    const state = ui.state(id)
    return { shown: !state.hidden, usable: !state.hidden && !state.disabled && !state.denied }
  }
  const grants = { layer: allowed(LAYER_ID), handle: allowed(HANDLE_ID), anchor: allowed(ANCHOR_ID) }
  const granted = useRef(grants)
  granted.current = grants
  const grantsKey = Object.values(grants).map((grant) => `${grant.shown}${grant.usable}`).join()
  const field = useRef<HTMLTextAreaElement>(null)

  // ---- the overlay: drawn from the refs, at most once per animation frame
  const frame = useRef(0)
  const paint = useCallback(() => {
    frame.current = 0
    const element = svg.current
    const shown = view.current
    if (!element) return
    const parts: SVGElement[] = []
    const make = (name: string, attributes: Record<string, string | number>) => {
      const part = document.createElementNS(SVG, name)
      for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, String(value))
      parts.push(part)
      return part
    }
    /** Appends an overlay part (and its children) as SVG. */
    const append = (part: OverlayPart, into?: SVGElement) => {
      const element = document.createElementNS(SVG, part.name)
      if (part.className) element.setAttribute('class', part.className)
      for (const [key, value] of Object.entries(part.attributes)) element.setAttribute(key, key === 'aria-label' ? latest.current.phrase(String(value)) : String(value))
      for (const child of part.children ?? []) append(child, element)
      if (into) into.appendChild(element)
      else parts.push(element)
    }
    // Upstream's `draw_snap_lines`: across the picture, in the snap colour.
    const snapLines = (lines: readonly SnapLine[], at: KitCanvasView) => {
      const { width, height } = latest.current
      const top = toCanvas(at, { x: 0, y: 0 })
      const bottom = toCanvas(at, { x: width, y: height })
      for (const line of lines) make('line', { class: 'film-gfx-snap', ...(line.vertical ? { x1: line.at, x2: line.at, y1: top.y, y2: bottom.y } : { x1: top.x, x2: bottom.x, y1: line.at, y2: line.at }) })
    }
    let handles = 0
    if (shown) {
      // The selected layers' boxes (upstream: with the graphics tools only), in the accent, with
      // their eight handles and anchor point; a paragraph box that hides text turns its
      // bottom-right handle into a red plus.
      if (GRAPHICS_TOOLS.has(latest.current.tool)) {
        const grant = granted.current
        const allowedParts = { layer: grant.layer.shown, handle: grant.handle.shown, anchor: grant.anchor.shown }
        for (const layer of outlinedLayers(layers.current, editingNow.current)) {
          const onScreen = layerView(layer, shown)
          if (!onScreen) {
            // No frame from the engine: the box alone, as before the handles.
            if (grant.layer.shown) make('polygon', { class: 'film-gfx-selected', points: pointsOf(layer.quad.map(([x, y]) => toCanvas(shown, { x, y }))), 'data-kit-ui-id': LAYER_ID })
            continue
          }
          for (const part of layerMarks(onScreen, allowedParts)) {
            if (part.attributes['data-kit-ui-id'] === HANDLE_ID) handles += 1
            append(part)
          }
        }
      }
      // The selected video clip's Motion box with the Selection tool (upstream `transform_handles.rs`
      // `draw`): its box in the accent, eight handles, and the anchor point; during a drag, where
      // the drag's values put it (they reach the picture as it moves).
      let clipBox: number | null = null
      let clipHandles = 0
      const boxing = boxDrag.current
      // The drag's last pointer sample, followed once per animation frame.
      if (boxing?.sync) {
        boxing.sync()
        boxing.sync = null
      }
      if (latest.current.tool === 'Selection') {
        const size = { width: latest.current.width, height: latest.current.height }
        const chosen = boxing ? boxing.frame : clipBoxes.current.frames.find((each) => each.clip === clipBoxes.current.selected)
        const pl = boxing ? draggedPlacement(boxing.frame, size, shown, boxing.changes) : chosen ? placementOf(chosen, size, shown) : null
        if (pl) {
          clipBox = pl.clip
          make('polygon', { class: boxing ? 'film-clip-box film-gfx-live' : 'film-clip-box', points: pointsOf(pl.quad), 'data-clip': pl.clip, 'data-kit-ui-id': CLIP_BOX_ID })
          handlePoints(pl.quad).forEach((at, n) => {
            const half = n < 4 ? 2.5 : 2
            const mark = make('rect', { class: n < 4 ? 'film-gfx-handle' : 'film-gfx-handle film-gfx-edge', x: at.x - half, y: at.y - half, width: half * 2, height: half * 2, 'data-handle': n, 'data-clip': pl.clip, 'data-kit-ui-id': CLIP_HANDLE_ID })
            mark.setAttribute('aria-label', latest.current.phrase('scale handle'))
            clipHandles += 1
          })
          const at = pl.anchorAt
          append({
            name: 'g',
            className: 'film-clip-anchor',
            attributes: { 'data-kit-ui-id': CLIP_ANCHOR_ID, 'data-clip': pl.clip, 'aria-label': 'anchor point' },
            children: [
              { name: 'circle', className: '', attributes: { cx: at.x, cy: at.y, r: 7 } },
              { name: 'line', className: '', attributes: { x1: at.x - 7, x2: at.x + 7, y1: at.y, y2: at.y } },
              { name: 'line', className: '', attributes: { x1: at.x, x2: at.x, y1: at.y - 7, y2: at.y + 7 } },
            ],
          })
        }
        if (boxing) snapLines(boxing.lines, shown)
      }
      element.setAttribute('data-clip-box', clipBox == null ? '' : String(clipBox))
      element.setAttribute('data-clip-handles', String(clipHandles))
      if (boxing) element.setAttribute('data-clip-drag', boxing.drag.grab.kind)
      else element.removeAttribute('data-clip-drag')
      // A layer drag's live outline, in white (upstream draws it over the box): nothing is sent until the release.
      const moving = layerDrag.current
      // The drag's last pointer sample, followed (and snapped) once per animation frame.
      if (moving?.sync) {
        moving.sync()
        moving.sync = null
      }

      if (moving) {
        if (moving.kind === 'move') {
          make('polygon', { class: 'film-gfx-outline film-gfx-live', points: pointsOf(moving.view.quad.map((point) => ({ x: point.x + moving.off.x, y: point.y + moving.off.y }))) })
          snapLines(moving.lines, shown)
        } else if (moving.kind === 'handle') make('polygon', { class: 'film-gfx-outline film-gfx-live', points: pointsOf(dragQuad(handleDrag(moving.view, moving.n, moving.start, moving.cur), moving.view)) })
        else {
          const at = anchorScreen(moving.view)
          append(crosshair({ x: at.x + moving.cur.x - moving.start.x, y: at.y + moving.cur.y - moving.start.y }, 'film-gfx-anchor film-gfx-live'))
        }
      }
      const drag = preview.current
      if (drag) {
        const a = toCanvas(shown, drag.start)
        const b = toCanvas(shown, drag.end)
        const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
        if (drag.ellipse) make('ellipse', { class: 'film-gfx-outline', cx: box.x + box.width / 2, cy: box.y + box.height / 2, rx: box.width / 2, ry: box.height / 2 })
        else make('rect', { class: drag.kind === 'textBox' ? 'film-gfx-outline film-gfx-edit' : 'film-gfx-outline', ...box })
        snapLines(drag.lines, shown)
      }
      const points = pen.current.map((point) => toCanvas(shown, point))
      if (points.length > 0) {
        make('polyline', { class: 'film-gfx-pen', points: points.map((point) => `${point.x},${point.y}`).join(' ') })
        const last = points[points.length - 1]
        if (hover.current) make('line', { class: 'film-gfx-pen film-gfx-rubber', x1: last.x, y1: last.y, x2: hover.current.x, y2: hover.current.y })
        points.forEach((point, index) => make('rect', { class: index === 0 ? 'film-gfx-point film-gfx-first' : 'film-gfx-point', x: point.x - 3, y: point.y - 3, width: 6, height: 6 }))
      }
    }
    element.replaceChildren(...parts)
    element.setAttribute('data-pen-points', String(pen.current.length))
    element.setAttribute('data-snapped', String(preview.current?.lines.length ?? layerDrag.current?.lines.length ?? 0))
    element.setAttribute('data-outlined', String(element.querySelectorAll('.film-gfx-selected').length))
    element.setAttribute('data-handles', String(handles))
    if (layerDrag.current) element.setAttribute('data-layer-drag', layerDrag.current.kind)
    else element.removeAttribute('data-layer-drag')
  }, [])
  const draw = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(paint)
  }, [paint])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // ---- the text field over the layer being edited, placed from the canvas's view outside React
  const placeField = useCallback(() => {
    const element = field.current
    const shown = view.current
    const edit = editingNow.current
    if (!element || !shown || !edit) return
    const layer = edit.clip == null ? undefined : layers.current.layers.find((each) => each.clip === edit.clip && each.layer === edit.layer)
    let box: { left: number; top: number; width: number; height: number; fontSize: number }
    if (layer) box = editBox(layer, shown)
    else {
      // Not drawn yet: at the click, the new text's first baseline.
      const at = toCanvas(shown, edit.at)
      const fontSize = edit.size * shown.zoom
      box = { left: at.x, top: at.y - fontSize * 0.8, width: fontSize * 0.5, height: fontSize, fontSize }
    }
    Object.assign(element.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, fontSize: `${box.fontSize}px`, lineHeight: `${box.fontSize}px` })
  }, [])

  // ---- the layers in the picture (`graphicLayers`), read while a graphics tool or an edit needs them
  const asked = useRef(0)
  /** The document, revision, and playhead the layers were last read at: a hover reads them again only when one moved. */
  const readAt = useRef<ReadAt | null>(null)
  const read = useMemo(
    () =>
      oneInFlight(async () => {
        const open = latest.current.doc
        if (!open) return
        const generation = asked.current
        const context = interactionEpoch.current
        const at = readAtOf(latest.current)
        const next = parseGraphicLayers(await open.invoke<string>('graphicLayers'))
        if (latest.current.doc !== open || interactionEpoch.current !== context) return
        layers.current = next
        readAt.current = at
        setGraphicSelected(next.selected != null)
        const edit = editingNow.current
        // The layer being edited is gone (undone, deleted, the playhead left it): the edit ends, as upstream's.
        if (edit && edit.clip != null && generation > edit.since && !next.layers.some((each) => each.clip === edit.clip && each.layer === edit.layer)) endEditNow.current()
        else placeField()
        draw()
      }),
    [placeField, draw],
  )
  /** Reads the layers now (a press needs them): answers once a read made after this ask has finished. */
  const readNow = useCallback(() => {
    asked.current += 1
    return read()
  }, [read])

  // ---- the video clips in the picture (`clipTransform.ts`): their Motion at the playhead and their source's size
  /** Each item's frame size (`itemInfo`'s video line) per document; null when the engine gives none (the sequence's size stands in). */
  const sizes = useRef(new WeakMap<KitEngine, Map<number, { width: number; height: number } | null>>())
  /** What the clip boxes were last read at. */
  const clipsAt = useRef<ReadAt | null>(null)
  const readClips = useMemo(
    () =>
      oneInFlight(async () => {
        const open = latest.current.doc
        if (!open) return
        const context = interactionEpoch.current
        const at = readAtOf(latest.current)
        const listed = pictureClips(open.info.inspected as Parameters<typeof pictureClips>[0])
        let known = sizes.current.get(open)
        if (!known) {
          known = new Map()
          sizes.current.set(open, known)
        }
        const frames: ClipFrame[] = []
        for (const each of listed) {
          if (!known.has(each.item)) {
            const info = await open.invoke<string>('itemInfo', each.item).then(
              (text) => JSON.parse(String(text)) as { video?: unknown },
              () => null,
            )
            known.set(each.item, sizeOfVideoLine(info?.video))
          }
          const effects = await open.invoke<string>('clipEffects', each.clip).then(
            (text) => JSON.parse(String(text)) as { effects?: Array<{ id?: string; enabled?: boolean; params?: unknown }> },
            () => null,
          )
          const motion = motionOf(effects?.effects?.find((effect) => effect.id === 'motion'))
          if (motion) frames.push({ clip: each.clip, size: known.get(each.item) ?? { width: latest.current.width, height: latest.current.height }, motion })
        }
        if (latest.current.doc !== open || interactionEpoch.current !== context) return
        clipBoxes.current = { frames, locked: new Set(listed.filter((each) => each.locked).map((each) => each.clip)), selected: listed.find((each) => each.selected)?.clip ?? null }
        clipsAt.current = at
        setClipSelected(clipBoxes.current.selected != null)
        draw()
      }),
    [draw],
  )
  // The selected clip's box shows with the Selection tool: read again as the document, the playhead, or the selection moves.
  const boxTool = tool === 'Selection'
  useEffect(() => {
    if (!doc) return
    if (boxTool && selectionKey !== '') void readClips()
    else if (clipBoxes.current.selected != null) {
      clipBoxes.current = { ...clipBoxes.current, selected: null }
      setClipSelected(false)
      draw()
    }
  }, [doc, boxTool, selectionKey, revision, playhead, readClips, draw])

  /** The run that sends a Motion box drag's values: each `effects.setParam` merged into the drag's step by its key, the first with `begin`; `final` (the release) refreshes the whole editor once. */
  const sendBox = useCallback(async (drag: ClipBoxDrag, changes: ReadonlyArray<[string, unknown]>, final: boolean) => {
    const open = latest.current.doc
    if (!open) return
    for (const [param, value] of changes) {
      const before = open.info.revision
      const params = { clip: drag.frame.clip, effect: 'motion', param, value, merge: drag.key, begin: !drag.begun }
      drag.begun = true
      try {
        await latest.current.invoke('effects.setParam', params, final ? undefined : { refresh: 'repaint' })
      } catch {
        // The status bar says why (invoke's own report).
      }
      if (open.info.revision !== before) drag.sent = true
    }
    // Effect Controls and Properties read the values again.
    if (!final) dragTicks.bump()
  }, [])
  /** A live drag's latest values go at the next animation frame, none while one is in flight. */
  const pumpBox = useCallback(
    (drag: ClipBoxDrag) => {
      drag.wanted = drag.changes
      if (drag.frameId || drag.busy) return
      drag.frameId = requestAnimationFrame(() => {
        drag.frameId = 0
        const pump = async () => {
          while (drag.wanted && !drag.over) {
            const next = drag.wanted
            drag.wanted = null
            await sendBox(drag, next, false)
          }
        }
        drag.busy = pump().finally(() => {
          drag.busy = null
        })
      })
    },
    [sendBox],
  )
  /** Takes a Motion box drag off the overlay, unless another has begun. */
  const clearBox = useCallback(
    (drag: ClipBoxDrag) => {
      if (boxDrag.current !== drag) return
      boxDrag.current = null
      draw()
    },
    [draw],
  )
  /** Stops a Motion box drag's sending: no more values go, and the one in flight finishes. */
  const stopBox = (drag: ClipBoxDrag) => {
    drag.over = true
    drag.sync = null
    drag.wanted = null
    if (drag.frameId) cancelAnimationFrame(drag.frameId)
    drag.frameId = 0
    return drag.busy ?? Promise.resolve()
  }
  /** Drops a Motion box drag (Escape, a lost capture or focus): what it already applied is undone, as one step, so the clip is where it was. */
  const cancelBox = useCallback(
    (drag: ClipBoxDrag) => {
      if (drag.over) return
      const busy = stopBox(drag)
      void (async () => {
        await busy
        try {
          if (drag.sent) await latest.current.invoke('edit.undo', {})
        } finally {
          await readClips()
          clearBox(drag)
        }
      })()
    },
    [clearBox, readClips],
  )
  // Kept live only while something shows them or needs them as the document changes: an edit, a
  // Pen path, or a selected graphic's boxes; a press reads them anyway. A new selection is read
  // once with a graphics tool, to find out whether it holds a graphic.
  const graphicsTool = GRAPHICS_TOOLS.has(tool)
  const live = editing != null || penDrawing || (graphicsTool && graphicSelected)
  useEffect(() => {
    if (doc && live) void readNow()
  }, [doc, live, revision, playhead, readNow])
  useEffect(() => {
    if (!doc) return
    if (selectionKey === '') {
      // Nothing selected: no selected graphic, no boxes.
      layers.current = { ...layers.current, target: null, selected: null }
      setGraphicSelected(false)
      draw()
    } else if (graphicsTool) void readNow()
  }, [doc, graphicsTool, chosenKey, selectionKey, readNow, draw])
  // While the program plays, the boxes follow the picture: one read per frame at most.
  const { clock } = options
  const boxesShown = graphicsTool && graphicSelected
  useEffect(() => {
    if (!doc || !boxesShown) return undefined
    let frameId = 0
    const unsubscribe = clock.subscribe(() => {
      if (frameId) return
      frameId = requestAnimationFrame(() => {
        frameId = 0
        void readNow()
      })
    })
    return () => {
      unsubscribe()
      cancelAnimationFrame(frameId)
    }
  }, [doc, boxesShown, clock, readNow])
  // The boxes go with the graphics tools, and the handles with what the host lets them do.
  useEffect(() => {
    draw()
  }, [tool, grantsKey, draw])

  // Another tool drops the Pen's path (upstream clears `pen_points` off the Pen).
  useEffect(() => {
    if (tool !== 'Pen' && pen.current.length > 0) {
      setPen([])
      draw()
    }
  }, [tool, draw, setPen])

  const run = useCallback(async (id: string, params: Record<string, unknown>) => answerOf(await latest.current.invoke(id, params)), [])
  /** Selects a clip whose picture was clicked, as the Timeline would (its linked audio with it), unless it is selected already (upstream `monitor_overlay`'s double-click). */
  const selectClip = useCallback(
    (clip: number) => {
      if (latest.current.selection.includes(clip)) return
      void run('timeline.select', { clips: [clip] })
    },
    [run],
  )
  /** The editor, which has the keyboard when no field does (the shell's key router listens there). */
  const focusEditor = useCallback(() => {
    field.current?.parentElement?.closest<HTMLElement>('[tabindex]')?.focus({ preventScroll: true })
  }, [])
  /** Ends the edit; the keyboard goes back to the editor if the field had it, so shortcuts work at once. */
  const endEdit = useCallback(() => {
    if (!editingNow.current) return
    if (field.current && document.activeElement === field.current) focusEditor()
    setEditing(null)
    draw()
  }, [draw, focusEditor, setEditing])
  const endEditNow = useRef(endEdit)
  endEditNow.current = endEdit
  const startEdit = useCallback(
    (layer: GraphicLayer) => {
      sessions.current += 1
      setEditing({ session: sessions.current, clip: layer.clip, layer: layer.layer, text: layer.text ?? '', at: { x: layer.quad[0][0], y: layer.quad[0][1] }, size: layer.size ?? 100, vertical: layer.vertical ?? false, since: asked.current })
      draw()
      void run('graphics.selectLayer', { clip: layer.clip, layers: [layer.layer] })
    },
    [draw, run, setEditing],
  )
  /**
   * Upstream's `begin_text_editing` (Begin Text Editing for a Graphic Layer, Cmd+Alt+'): the
   * graphic `graphics.list` targets (the selected one, else the top one under the playhead), its
   * selected text layer or else its last one, selected, and its whole text selected so typing
   * replaces it. The field opens while that layer is in the picture.
   */
  const beginTextEditing = useCallback(async () => {
    const open = latest.current.doc
    if (!open) return null
    const context = interactionEpoch.current
    const session = sessions.current
    const inspection = open.info.inspected
    const selection = () => ((open.info.inspected as { sequence?: { selection?: number[] } } | null)?.sequence?.selection ?? []).join(',')
    let expectedSelection = selection()
    // The shortcut may wait on three engine reads. A permission or document change,
    // or another text field opened meanwhile, cancels this original request.
    const current = () => latest.current.doc === open && interactionEpoch.current === context && sessions.current === session && !documentReplaced(inspection, open.info.inspected) && selection() === expectedSelection
    // Without a graphic the engine refuses graphics.list and says why in the status bar.
    const list = await run('graphics.list', {})
    if (!current() || !list) return null
    if (typeof list.clip !== 'number') throw new Error(latest.current.phrase('select a graphic clip'))
    const listed = Array.isArray(list.layers) ? (list.layers as Array<{ layer?: number; kind?: string; text?: string | null }>) : []
    const texts = listed.filter((layer) => layer.kind === 'text' && typeof layer.layer === 'number')
    const chosen = latest.current.graphicLayers[0]
    const pick = texts.find((layer) => layer.layer === chosen) ?? texts.at(-1)
    if (!pick) throw new Error(latest.current.phrase('the graphic has no text layer'))
    const clip = list.clip
    const layer = pick.layer as number
    // Selecting this request's own layer is intentional; a subsequent user selection is not.
    expectedSelection = String(clip)
    await run('graphics.selectLayer', { clip, layers: [layer] })
    if (!current()) return null
    await readNow()
    if (!current()) return null
    const shown = layers.current.layers.find((each) => each.clip === clip && each.layer === layer)
    // The layer is selected either way; its field opens only where the picture shows it.
    if (!shown) throw new Error(latest.current.textNotShown)
    sessions.current += 1
    setEditing({ session: sessions.current, clip, layer, text: shown.text ?? pick.text ?? '', at: { x: shown.quad[0][0], y: shown.quad[0][1] }, size: shown.size ?? 100, vertical: shown.vertical ?? false, since: asked.current, selectAll: true })
    draw()
    return { clip, layer }
  }, [draw, readNow, run, setEditing])
  /** Opens the field at `at` before its layer exists (a Type click: the keys typed from now on are the text's). */
  const openPending = useCallback(
    (at: Point, vertical: boolean) => {
      sessions.current += 1
      setEditing({ session: sessions.current, clip: null, layer: null, text: '', at, size: Math.round((100 * latest.current.height) / 1080), vertical, since: asked.current })
      return sessions.current
    },
    [setEditing],
  )
  /** A pending field turns out to be over a text layer: it edits that one, with what was typed meanwhile at its end. */
  const adopt = useCallback(
    (session: number, layer: GraphicLayer) => {
      const edit = editingNow.current
      if (edit?.session !== session) return
      const typed = typedEarly.current.get(session) ?? ''
      typedEarly.current.delete(session)
      const text = (layer.text ?? '') + typed
      setEditing({ ...edit, clip: layer.clip, layer: layer.layer, text, at: { x: layer.quad[0][0], y: layer.quad[0][1] }, size: layer.size ?? edit.size, vertical: layer.vertical ?? false, since: asked.current })
      const element = field.current
      if (element) {
        element.value = text
        element.setSelectionRange(text.length, text.length)
      }
      void run('graphics.selectLayer', { clip: layer.clip, layers: [layer.layer] })
      if (typed) void run('graphics.setText', { clip: layer.clip, layer: layer.layer, text, merge: true })
    },
    [run, setEditing],
  )
  /** `newText#edit`: the field opens at once (or is open, `session`); the text it types goes to the layer once the engine has made it. */
  const newText = useCallback(
    async (command: string, params: Record<string, unknown>, at: Point, vertical: boolean, pending?: number) => {
      const session = pending ?? openPending(at, vertical)
      if (editingNow.current?.session !== session) return
      const made = await run(command, params)
      const typed = typedEarly.current.get(session) ?? null
      typedEarly.current.delete(session)
      const madeIt = typeof made?.clip === 'number' && typeof made.layer === 'number'
      // What was typed before the layer existed is its text, even if the edit has ended since (upstream keeps it).
      if (madeIt && typed) void run('graphics.setText', { clip: made.clip, layer: made.layer, text: typed, merge: true })
      const edit = editingNow.current
      // The edit ended (Escape, a click elsewhere) or another began while the engine worked.
      if (edit?.session !== session) return
      if (!madeIt) {
        endEdit()
        return
      }
      setEditing({ ...edit, clip: made.clip as number, layer: made.layer as number, since: asked.current })
    },
    [endEdit, openPending, run, setEditing],
  )
  /** The field's text to the layer (`graphics.setText`, one undo step per edit), or kept until the layer exists. */
  const sendText = useCallback(
    (text: string) => {
      const edit = editingNow.current
      if (!edit) return
      if (edit.clip == null || edit.layer == null) typedEarly.current.set(edit.session, text)
      else void run('graphics.setText', { clip: edit.clip, layer: edit.layer, text, merge: true })
    },
    [run],
  )
  const finishPen = useCallback(() => {
    const params = penShapeParams(pen.current, layers.current.target)
    setPen([])
    draw()
    if (params) void run('graphics.newShape', params)
  }, [draw, run, setPen])

  // A transient deny/allow pair must cancel the old intent even if React batches the updates.
  useLayoutEffect(() => ui.store.subscribe(() => {
    interactionEpoch.current += 1
    endEdit()
    typedEarly.current.clear()
    preview.current = null
    layerDrag.current = null
    if (boxDrag.current) cancelBox(boxDrag.current)
    setPen([])
    draw()
  }), [ui.store, draw, endEdit, setPen, cancelBox])

  // A path or text field belongs to the project and sequence where it began, including
  // replacements that reuse this Worker. Clear before a key can commit it to the next one.
  useLayoutEffect(() => {
    interactionEpoch.current += 1
    layers.current = EMPTY
    setGraphicSelected(false)
    editingNow.current = null
    setEditingState(null)
    typedEarly.current.clear()
    setPen([])
    preview.current = null
    layerDrag.current = null
    if (boxDrag.current) stopBox(boxDrag.current)
    boxDrag.current = null
    clipBoxes.current = NO_CLIPS
    setClipSelected(false)
    hover.current = null
    draw()
  }, [doc, projectEpoch, activeSequence, draw, setPen])

  // ---- presses on the picture
  const zoom = () => view.current?.zoom ?? 1
  const click = useCallback(
    (current: string, point: Point, canvas: Point) => {
      const { height } = latest.current
      const shown = layers.current
      // A click inside the text being typed into is the field's (upstream: `_ if in_edit => {}`).
      const edit = editingNow.current
      if (edit && edit.clip != null && shown.layers.some((layer) => layer.clip === edit.clip && layer.layer === edit.layer && layer.kind === 'text' && layerAt([layer], point, zoom()))) return
      switch (current) {
        case 'Type':
        case 'VerticalType': {
          // The field opened on the release (`pending`); the layers now say what it edits.
          const open = editingNow.current
          const pending = open && open.clip == null ? open.session : undefined
          const text = layerAt(shown.layers, point, zoom(), (layer) => layer.kind === 'text')
          if (text) {
            if (pending != null) adopt(pending, text)
            else startEdit(text)
            return
          }
          if (pending == null) endEdit()
          // Vertical text is always point text: a click, never a drawn box.
          const vertical = current === 'VerticalType'
          void newText(vertical ? 'graphics.newVerticalText' : 'graphics.newText', newTextParams(height, shown.target, point), point, vertical, pending)
          return
        }
        case 'Selection': {
          const layer = layerAt(shown.layers, point, zoom())
          // A layer the host does not let a press use takes the click, doing nothing.
          if (layer && !granted.current.layer.usable) return
          if (layer) {
            endEdit()
            void run('graphics.selectLayer', { clip: layer.clip, layers: [layer.layer] })
            return
          }
          if (editingNow.current) endEdit()
          // A click on empty picture drops the selected layers, the clip staying selected.
          else if (shown.selected && shown.selected.layers.length > 0) void run('graphics.selectLayer', { clip: shown.selected.clip, layers: [], keepSelection: true })
          // A click on a video clip's picture selects it: the top-most at the playhead under the pointer.
          const shownView = view.current
          const under = shownView ? clipUnder(clipBoxes.current.frames, { width: latest.current.width, height: latest.current.height }, shownView, canvas) : null
          if (under) selectClip(under.clip)
          return
        }
        case 'Pen': {
          const shownView = view.current
          if (shownView && penCloses(pen.current, canvas, shownView)) finishPen()
          else {
            setPen([...pen.current, point])
            draw()
          }
          return
        }
        default:
      }
    },
    [adopt, draw, endEdit, finishPen, newText, run, selectClip, setPen, startEdit],
  )

  /** The picture in canvas pixels, for `snap_move` (`pic`). */
  const pictureRect = useCallback((shown: KitCanvasView) => {
    const { width, height } = latest.current
    return { x: -shown.x * shown.zoom, y: -shown.y * shown.zoom, width: width * shown.zoom, height: height * shown.zoom }
  }, [])
  /** The canvas surface (its cursor follows the layer under the pointer). */
  const surfaceNow = useRef<HTMLCanvasElement | null>(null)
  const canvasElement = useCallback(() => {
    if (surfaceNow.current?.isConnected) return surfaceNow.current
    surfaceNow.current = svg.current?.parentElement?.querySelector<HTMLCanvasElement>('.kui-canvas-surface') ?? null
    return surfaceNow.current
  }, [])

  const graphicsGesture = useCallback(
    (start: KitPointer): KitGesture => {
      const current = latest.current.tool
      const pressed = performance.now()
      const origin: Point = { x: start.x, y: start.y }
      const press: Point = { x: start.canvasX, y: start.canvasY }
      // The layers (and with the Selection tool the video clips' boxes) as the document is now: what the press decides goes by them.
      const ready = current === 'Selection' ? Promise.all([readNow(), readClips()]).then(() => undefined) : readNow()
      const pressDoc = latest.current.doc
      const pressInspection = pressDoc?.info.inspected
      const pressEpoch = interactionEpoch.current
      const pressCurrent = () => latest.current.doc != null && latest.current.doc === pressDoc && interactionEpoch.current === pressEpoch && !documentReplaced(pressInspection, pressDoc?.info.inspected)
      let dragging = false
      let decidedOnce = false
      let kind: Preview['kind'] | null = null
      let last: Point = origin
      let lastCanvas: Point = press
      let lastFree = start.meta
      /** The layer drag this press became (upstream's Move, Handle, or Anchor). */
      let layer: LayerDrag | null = null
      /** The Motion box drag this press became (upstream `transform_handles.rs`: Move, Handle, Rotate, or Anchor). */
      let box: ClipBoxDrag | null = null
      /** Escape, a lost capture, a pointercancel, or a lost window focus dropped the drag: nothing is sent. */
      let cancelled = false
      let released = false
      /** An Escape, a blur, or a lost capture came before the press's read decided the drag: a layer drag it becomes is dropped then. */
      let interruptedEarly = false
      /**
       * A corner snapped through `snap_move` (Snap in Program Monitor; Cmd or Ctrl held moves
       * freely, as upstream's moves): to the guides and the frame's edges and centre within 6 points.
       */
      const snapped = (point: Point, free: boolean): { point: Point; lines: SnapLine[] } => {
        const shown = view.current
        const snap = latest.current.snapping?.()
        if (!shown || !snap || free) return { point, lines: [] }
        const { width, height } = latest.current
        const at = snapPoint(snap, pictureRect(shown), { width, height }, toCanvas(shown, point))
        return { point: at.lines.length ? toSequence(shown, at.point) : point, lines: at.lines }
      }
      const free = start.meta
      // The drag's first corner, snapped once as the drag starts; the other follows the pointer.
      const anchor = snapped(origin, free)
      let tip = { point: origin, lines: [] as SnapLine[] }
      /** A layer drag follows the pointer (`cur`), a move snapped through `snap_move` unless Cmd or Ctrl is held now. */
      const follow = (drag: LayerDrag, at: Point, freely: boolean) => {
        drag.cur = at
        const off = { x: at.x - drag.start.x, y: at.y - drag.start.y }
        const shown = view.current
        const { width, height } = latest.current
        const moved = drag.kind === 'move' && shown ? snappedMove(drag.view, latest.current.snapping?.() ?? null, pictureRect(shown), { width, height }, off, freely) : { off, lines: [] }
        drag.off = moved.off
        drag.lines = moved.lines
      }
      /**
       * A Motion box drag follows the pointer (`cur`): a rotation adds up its turn, a move snaps
       * through `snap_move` unless Cmd or Ctrl is held now, and once the pointer has gone past 2
       * points a live drag's values go to the engine.
       */
      const followBox = (drag: ClipBoxDrag, at: Point, freely: boolean) => {
        followRotation(drag.drag, at)
        let moved = { x: at.x - drag.drag.start.x, y: at.y - drag.drag.start.y }
        let lines: SnapLine[] = []
        const shown = view.current
        const snap = latest.current.snapping?.()
        if (drag.drag.grab.kind === 'move' && shown && snap && !freely) {
          const { width, height } = latest.current
          const snappedOff = snapMove(snap, pictureRect(shown), { width, height }, boundsOf(drag.drag.from.quad), moved)
          moved = snappedOff.off
          lines = snappedOff.lines
        }
        drag.changes = boxChanges(drag.drag, at, moved)
        drag.lines = lines
        if (!isLayerClick(drag.drag.start, at)) drag.moved = true
        if (drag.moved && !drag.over) pumpBox(drag)
      }
      /** Takes this press's outline off the overlay, unless a newer press has put its own there. */
      const clearOutline = () => {
        if (layer != null && layerDrag.current === layer) {
          layerDrag.current = null
          draw()
        }
      }
      // ---- dropping a layer drag: its own listeners, beside kit-editor's gesture (which hears only pointercancel)
      const surface = canvasElement()
      const interrupt = (cause: 'escape' | 'lost') => {
        const next = interruptLayerDrag({ dragging, decided: decidedOnce, released, cancelled, active: layer != null || box != null }, cause)
        if (next.remember) interruptedEarly = true
        if (next.detach) detach()
        if (!next.drop) return false
        // Only a layer or Motion box drag has a cancel (the plan's rule for drags); a Type box
        // drag, as before and as upstream, has none: it ends on its release whatever happened.
        cancelled = true
        clearOutline()
        if (box) cancelBox(box)
        return true
      }
      const onKey = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || !interrupt('escape')) return
        // Escape is the drag's alone: nothing else hears it.
        event.preventDefault()
        event.stopPropagation()
      }
      const onLost = () => {
        interrupt('lost')
      }
      const listening = current === 'Selection' || current === 'Type' || current === 'VerticalType'
      if (listening) {
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('blur', onLost)
        surface?.addEventListener('lostpointercapture', onLost)
      }
      let attached = listening
      const detach = () => {
        if (!attached) return
        attached = false
        window.removeEventListener('keydown', onKey, true)
        window.removeEventListener('blur', onLost)
        surface?.removeEventListener('lostpointercapture', onLost)
      }
      /** Starts a layer drag, unless the document takes no edit now (a dialog's preview): then it says so and nothing is drawn. */
      const startLayer = (dragKind: LayerDrag['kind'], on: LayerView, n: number) => {
        if (interruptedEarly || cancelled) {
          // Escape, a blur, or a lost capture came while the press was being read: dropped, nothing sent.
          cancelled = true
          detach()
          return
        }
        const refused = latest.current.editRefusal?.('graphics.set')
        if (refused) {
          latest.current.status?.(refused)
          return
        }
        layer = { kind: dragKind, n, view: on, start: press, cur: press, off: { x: 0, y: 0 }, lines: [], sync: null }
        follow(layer, lastCanvas, lastFree)
        layerDrag.current = layer
        draw()
      }
      /**
       * Starts a Motion box drag of `frame`'s clip, whose box is `pl` (upstream's drag start),
       * unless the document takes no edit now (a dialog's preview) or the clip's track is locked:
       * then it says so and nothing moves.
       */
      const startBox = (frame: ClipFrame, pl: Placement, grab: Grab) => {
        if (interruptedEarly || cancelled) {
          cancelled = true
          detach()
          return
        }
        const refused = latest.current.editRefusal?.('effects.setParam')
        if (refused) {
          latest.current.status?.(refused)
          return
        }
        if (clipBoxes.current.locked.has(frame.clip)) {
          // The engine sets Motion on a locked track's clip; the editor refuses it as it refuses other edits there.
          latest.current.errorStatus?.('command `effects.setParam` is not available right now: track is locked')
          return
        }
        boxDrags += 1
        box = { drag: beginBoxDrag(pl, grab, press), frame, changes: [], lines: [], key: `motion-box-${boxDrags}`, moved: false, begun: false, sent: false, wanted: null, busy: null, frameId: 0, over: false, sync: null }
        boxDrag.current = box
        followBox(box, lastCanvas, lastFree)
        draw()
      }
      /**
       * The release of a Motion box drag: its last values, merged into the drag's one step, and
       * the editor refreshed once. A press that never went
       * past 2 points sends nothing.
       */
      const finishBox = async (drag: ClipBoxDrag, at: Point, freely: boolean) => {
        drag.sync = null
        const busy = stopBox(drag)
        followBox(drag, at, freely)
        draw()
        await busy
        if (!drag.moved || !pressCurrent()) {
          clearBox(drag)
          return
        }
        try {
          await sendBox(drag, drag.changes, true)
          await readClips()
        } finally {
          clearBox(drag)
        }
      }
      const beginDrag = () => {
        dragging = true
        if (current === 'Rectangle' || current === 'Ellipse') kind = 'shape'
        else void ready.then(() => decideDrag())
      }
      const decideDrag = () => {
        if (decidedOnce || cancelled || !pressCurrent()) return
        decidedOnce = true
        const shown = layers.current
        const shownView = view.current
        // Of the selected layers, the anchor point (Selection only) and then a handle (the Selection and Type tools).
        // The layer being typed into has none: a press near its box is the field's.
        const views = shownView && (current === 'Selection' || current === 'Type' || current === 'VerticalType') ? handleViews(shown.layers, shownView, editingNow.current) : []
        const grant = granted.current
        const target = pressTarget(views, shown.selected, current, press, { anchor: grant.anchor.usable, handle: grant.handle.usable })
        if (current === 'Rectangle' || current === 'Ellipse') kind = 'shape'
        else if (target) startLayer(target.kind, target.view, target.n)
        else if (current === 'Type' && !layerAt(shown.layers, origin, zoom(), (each) => each.kind === 'text')) {
          kind = 'textBox'
          const held = () => !released && !cancelled && kind === 'textBox'
          typeBoxHeld.current = held
        }
        else if (current === 'Selection') {
          const hit = layerAt(shown.layers, origin, zoom())
          // The selected video clip's Motion box (upstream `transform_handles.rs` `grab_at`): its
          // anchor point, handles, and rotate zone come before a layer under the pointer; inside
          // it, a layer over the clip is the layer's.
          const size = { width: latest.current.width, height: latest.current.height }
          const boxes = clipBoxes.current
          const chosen = boxes.frames.find((each) => each.clip === boxes.selected)
          const pl = chosen && shownView ? placementOf(chosen, size, shownView) : null
          // Inside the box, a clip shown over it is the one the pointer is on: that one is taken.
          const over = shownView ? clipUnder(boxes.frames, size, shownView, press) : null
          const covered = chosen != null && over != null && boxes.frames.indexOf(over) < boxes.frames.indexOf(chosen)
          const grab = pl && !(covered && grabAt(pl, press)?.kind === 'move') ? grabAt(pl, press) : null
          if (chosen && pl && grab && grab.kind !== 'move') startBox(chosen, pl, grab)
          else if (hit && grant.layer.usable) {
            // Upstream ends the edit, selects the layer if it is not, and moves it.
            endEdit()
            if (!(shown.selected?.clip === hit.clip && shown.selected.layers.includes(hit.layer))) void run('graphics.selectLayer', { clip: hit.clip, layers: [hit.layer] })
            const on = shownView ? layerView(hit, shownView) : null
            if (on) startLayer('move', on, -1)
          } else if (chosen && pl && grab) startBox(chosen, pl, grab)
          else if (!hit && shownView) {
            // Another clip's picture: it is selected and moves with the drag.
            const under = over
            const placed = under ? placementOf(under, size, shownView) : null
            if (under && placed) {
              endEdit()
              selectClip(under.clip)
              startBox(under, placed, { kind: 'move' })
            }
          }
        }
        showPreview()
      }
      const showPreview = () => {
        if (!kind || cancelled || !pressCurrent()) return
        preview.current = { kind, ellipse: kind === 'shape' && current === 'Ellipse', start: anchor.point, end: tip.point, lines: [...anchor.lines, ...tip.lines] }
        draw()
      }
      /**
       * The release of a layer drag: one `graphics.set` (one history step), from the layer as the
       * press found it, when the pointer moved past 2 points; a shorter one is a click. A layer
       * another page or an agent changed meanwhile drops the drag.
       */
      const finishLayer = async (drag: LayerDrag, at: Point, freely: boolean) => {
        // A pointer sample still queued for the next frame would redraw the outline one sample short of the release.
        drag.sync = null
        const { clip, layer: index } = drag.view.layer
        // Back within 2 points: nothing more is sent (upstream has no click after a drag began; its
        // start already selected a layer that was not), so a multi-layer selection stays.
        if (isLayerClick(drag.start, at)) {
          clearOutline()
          return
        }
        follow(drag, at, freely)
        draw()
        const props = drag.kind === 'move' ? moveProps(drag.view, drag.off) : drag.kind === 'anchor' ? anchorProps(drag.view, { x: at.x - drag.start.x, y: at.y - drag.start.y }) : dragProps(handleDrag(drag.view, drag.n, drag.start, at), drag.view, drag.n)
        await readNow()
        // Another document since the press: nothing of this one is sent there.
        if (!pressCurrent()) {
          clearOutline()
          return
        }
        const now = layers.current.layers.find((each) => each.clip === clip && each.layer === index)
        if (!now || !sameFrame(now.frame, drag.view.layer.frame)) {
          // Another page or an agent changed (or removed) the layer meanwhile: dropped, and said.
          clearOutline()
          if (latest.current.layerChanged) latest.current.status?.(latest.current.layerChanged)
          return
        }
        // A dialog's preview opened during the drag: refused, and said, as at the start.
        const refused = latest.current.editRefusal?.('graphics.set')
        if (refused) {
          clearOutline()
          latest.current.status?.(refused)
          return
        }
        // The outline stays where it was released until the change has been drawn (or failed), so the box does not snap back meanwhile.
        try {
          await run('graphics.set', { clip, layer: index, props })
          await readNow()
        } finally {
          clearOutline()
        }
      }
      const decided = (pointer: KitPointer) => Math.hypot(pointer.canvasX - start.canvasX, pointer.canvasY - start.canvasY) > DRAG_THRESHOLD || performance.now() - pressed >= CLICK_MS
      return {
        move: (pointer) => {
          if (!pressCurrent()) return
          last = { x: pointer.x, y: pointer.y }
          lastCanvas = { x: pointer.canvasX, y: pointer.canvasY }
          lastFree = pointer.meta
          tip = snapped(last, pointer.meta)
          if (!dragging && decided(pointer)) beginDrag()
          if (cancelled) return
          if (layer) {
            // Followed on the next animation frame, from the last sample (kit-editor calls move for each coalesced one).
            const drag = layer
            drag.sync = () => follow(drag, lastCanvas, lastFree)
            draw()
          } else if (box) {
            const drag = box
            drag.sync = () => followBox(drag, lastCanvas, lastFree)
            draw()
          } else if (dragging) showPreview()
        },
        end: (pointer) => {
          released = true
          typeBoxHeld.current = null
          detach()
          if (preview.current) {
            preview.current = null
            draw()
          }
          if (cancelled || !pressCurrent()) {
            clearOutline()
            return
          }
          const end: Point = { x: pointer.x, y: pointer.y }
          const endCanvas: Point = { x: pointer.canvasX, y: pointer.canvasY }
          const isClick = !dragging && !decided(pointer)
          const moved = Math.hypot(pointer.canvasX - start.canvasX, pointer.canvasY - start.canvasY) > MOVED_PX
          const wasDragging = dragging
          dragging = false
          // A Type click takes the keyboard now, as upstream opens its edit in the same frame; what
          // it edits is decided once the layers are read. A click in the open field's layer is the field's.
          const edit = editingNow.current
          const inEdit = edit != null && edit.clip != null && layers.current.layers.some((each) => each.clip === edit.clip && each.layer === edit.layer && layerAt([each], end, zoom()))
          if (isClick && !inEdit && (current === 'Type' || current === 'VerticalType')) openPending(end, current === 'VerticalType')
          void ready.then(() => {
            if (cancelled || !pressCurrent()) return
            if (isClick) {
              click(current, end, endCanvas)
              return
            }
            if (!wasDragging || !kind) decideDrag()
            preview.current = null
            draw()
            if (layer) {
              void finishLayer(layer, endCanvas, pointer.meta)
              return
            }
            if (box) {
              void finishBox(box, endCanvas, pointer.meta)
              return
            }
            if (!moved) return
            const target = layers.current.target
            const corner = snapped(end, pointer.meta).point
            const first = anchor.point
            if (kind === 'textBox') {
              endEdit()
              void newText('graphics.newText', newTextParams(latest.current.height, target, first, corner), first, false)
            } else if (kind === 'shape') void run('graphics.newShape', shapeParams(current, target, first, corner))
          })
        },
        cancel: () => {
          released = true
          cancelled = true
          typeBoxHeld.current = null
          detach()
          clearOutline()
          if (box) cancelBox(box)
          preview.current = null
          draw()
        },
      }
    },
    [canvasElement, cancelBox, clearBox, click, draw, endEdit, newText, openPending, pictureRect, pumpBox, readClips, readNow, run, selectClip, sendBox],
  )

  /**
   * The Selection tool's cursor over the picture (`monitor_overlay`'s cursors): Text over the text
   * being typed into, Move over any layer. The layers are read again only when the document,
   * revision, or playhead moved since the last read.
   */
  const hovered = useRef<{ at: Point; canvas: Point } | null>(null)
  const hoverCursor = useCallback(
    (point: Point, canvasAt: Point) => {
      hovered.current = { at: point, canvas: canvasAt }
      const decide = () => {
        const now = hovered.current
        const element = canvasElement()
        if (!now || !element || latest.current.tool !== 'Selection' || boxDrag.current) return
        const { at, canvas } = now
        const shown = layers.current.layers
        const edit = editingNow.current
        const overEdit = edit != null && edit.clip != null && shown.some((each) => each.clip === edit.clip && each.layer === edit.layer && hitsLayer(each, at, zoom()))
        // The selected clip's Motion box: a resize cursor over a handle, a turning one in the rotate zone, Move inside.
        const boxes = clipBoxes.current
        const chosen = boxes.frames.find((each) => each.clip === boxes.selected)
        const shownView = view.current
        const pl = chosen && shownView ? placementOf(chosen, { width: latest.current.width, height: latest.current.height }, shownView) : null
        const grab = pl ? grabAt(pl, canvas) : null
        // A layer the host does not let a press use shows no Move cursor.
        const overLayer = granted.current.layer.usable && layerAt(shown, at, zoom())
        const cursor = overEdit ? 'text' : pl && grab && grab.kind !== 'move' ? grabCursor(pl, grab) : overLayer ? 'move' : pl && grab ? grabCursor(pl, grab) : cursorOf('Selection', false)
        if (element.style.cursor !== cursor) element.style.cursor = cursor
      }
      const fresh = sameReadAt(readAt.current, latest.current) && (!clipSelected || sameReadAt(clipsAt.current, latest.current))
      if (fresh) decide()
      else void Promise.all([readNow(), clipSelected ? readClips() : undefined]).then(decide)
    },
    [canvasElement, readNow, readClips, clipSelected],
  )

  const canvasTool = useMemo<KitTool>(
    () => ({
      id: `program-${tool}`,
      cursor: cursorOf(tool, magnified),
      begin: (pointer, context) => {
        const shown = view.current
        const kind = pressKind(latest.current.tool, shown != null && pictureOverflows(shown, latest.current.width, latest.current.height))
        if (kind === 'pan') return HAND_TOOL.begin(pointer, context)
        if (kind === 'graphics') return graphicsGesture(pointer)
        return undefined
      },
      hover: (pointer) => {
        if (latest.current.tool === 'Selection') hoverCursor({ x: pointer.x, y: pointer.y }, { x: pointer.canvasX, y: pointer.canvasY })
        if (latest.current.tool !== 'Pen' || pen.current.length === 0) return
        hover.current = { x: pointer.canvasX, y: pointer.canvasY }
        draw()
      },
      leave: () => {
        hovered.current = null
        if (!hover.current) return
        hover.current = null
        draw()
      },
      doubleClick: (pointer) => {
        if (latest.current.tool !== 'Selection') return
        // After the second press's click (its read was asked first).
        void readNow().then(() => {
          const text = layerAt(layers.current.layers, { x: pointer.x, y: pointer.y }, zoom(), (layer) => layer.kind === 'text')
          if (text) startEdit(text)
        })
      },
    }),
    [tool, magnified, graphicsGesture, draw, readNow, startEdit, hoverCursor],
  )
  // Another tool, or the picture magnified: the canvas takes the tool's own cursor again.
  useEffect(() => {
    const element = canvasElement()
    if (element) element.style.cursor = cursorOf(tool, magnified)
  }, [tool, magnified, canvasElement])

  /** Every view of the canvas: the overlay and the field follow it. */
  const onView = useCallback(
    (next: KitCanvasView) => {
      view.current = next
      const over = pictureOverflows(next, latest.current.width, latest.current.height)
      setMagnified((was) => (was === over ? was : over))
      draw()
      placeField()
    },
    [draw, placeField],
  )

  /** The Pen's keys while it has points (upstream reads them whatever has focus): Enter closes the path, Escape drops it. */
  const keyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (latest.current.tool !== 'Pen' || pen.current.length === 0) return false
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      if (plain && event.key === 'Enter' && pen.current.length >= 3) {
        finishPen()
        return true
      }
      if (event.key === 'Escape') {
        setPen([])
        draw()
        return true
      }
      return false
    },
    [draw, finishPen, setPen],
  )

  // The field takes the keyboard when an edit starts, and is placed at once, the caret after the
  // text (upstream puts it where the click was, in its own text layout).
  const session = editing?.session
  useEffect(() => {
    const element = field.current
    if (session == null || !element) return
    placeField()
    element.focus({ preventScroll: true })
    // Begin Text Editing selects the whole text, so typing replaces it (upstream's anchor 0).
    element.setSelectionRange(editingNow.current?.selectAll ? 0 : element.value.length, element.value.length)
  }, [session, placeField])
  // A new text's field moves onto its layer once the engine has made it.
  useEffect(() => {
    placeField()
  }, [editing, placeField])

  const overlay: ReactNode = (
    <>
      <svg ref={svg} className="film-gfx-overlay" data-testid="film-program-graphics" aria-hidden="true" />
      {editing ? (
        <textarea
          key={editing.session}
          ref={field}
          className="film-text-edit"
          data-testid="film-program-text-edit"
          data-kit-ui-id="control:program.textEdit"
          data-vertical={editing.vertical || undefined}
          aria-label={options.phrase('Text layer')}
          defaultValue={editing.text}
          spellCheck={false}
          onInput={(event) => {
            // An input method's text goes in when it is finished (upstream commits finished text).
            if ((event.nativeEvent as InputEvent).isComposing) return
            sendText(event.currentTarget.value)
          }}
          onCompositionEnd={(event) => sendText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
            event.preventDefault()
            event.stopPropagation()
            endEdit()
          }}
          onBlur={(event) => {
            if (editingNow.current?.session !== editing.session) return
            // Focus left for nowhere (not another control): the editor takes the keyboard back.
            if (!event.relatedTarget) focusEditor()
            endEdit()
          }}
        />
      ) : null}
    </>
  )

  return { canvasTool, overlay, onView, keyDown, beginTextEditing }
}
