import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { isMac, useUi, type ContextMenuPoint } from '@kition/sdk/editor'
import type { FilmInfo, FilmProjectItem } from '../film'
import type { FilmSessionState } from '../session/useFilmSession'
import { scrollHalf, zoomAt } from './layout'
import type { TimelineViewStore } from './view'
import { CLICK_MS, EDGE_PX, begin, dropRow, findClip, hitAt, hitTest, isDrag, moveDrag, placeCommand, preview, release, sceneOf, snapAt, tickAt, xOf, type Command, type Drag, type Layout, type Mods, type Pressed, type Row, type Scene } from './gestures'
import { createDragView, type Bracket } from './dragView'
import { FILM_DRAG_TYPE, endFilmDrag, filmDrag } from './drop'
import { previewCommands } from '../dialogs/previewViews'
import { snapTo } from './snap'
import { carriesEffect, effectDrag, endEffectDrag } from './effectDrag'
import { fitsTrack, isTransition, type EffectPayload } from '../panels/effectsTree'
import { localSelection } from '../session/localSelection'
import { ALIGNMENT_LABELS, appliedTransition, alignmentOf, cutOf, defaultDuration, dragEnd, dropEdge, durationCommand, grabEnd, maxFrames, transitionSpan, type SpanClip, type TransitionGrab, type TransitionInfo } from './transitions'

/** Where the track rows are this render: the header's width, the content's, the rows (y from the panel's top), and the video half's scroll range. */
export type GestureGeometry = { headerWidth: number; contentWidth: number; rows: readonly Row[]; maxVideo: number }

/** Settings ▸ Timeline ▸ Still Image Default Duration, which a dropped still's preview spans. */
export type StillDuration = { amount: number; unit: string }

/** Settings ▸ Timeline ▸ Video and Audio Transition Default Duration, which a dropped transition's preview spans. */
export type TransitionDurations = { video: { duration?: number; unit?: string }; audio: { duration?: number; unit?: string } }

/** A transition on the document as the gestures read it (ticks), with its track's kind, and the clips by id. */
export type FoundTransition = { info: TransitionInfo; kind: 'video' | 'audio'; track: number; clips: ReadonlyMap<number, SpanClip> }

/** The transition `id` of `film`, in ticks, or null. */
export function findTransition(film: FilmInfo | null, id: number): FoundTransition | null {
  if (!film) return null
  const tps = film.ticksPerSecond
  const ticks = (seconds: number) => Math.round(seconds * tps)
  for (const track of film.tracks) {
    const transition = track.transitions.find((each) => each.id === id)
    if (!transition) continue
    const clips = new Map(track.clips.map((clip) => [clip.id, { id: clip.id, start: ticks(clip.start), duration: ticks(clip.duration) }]))
    return { info: { ...transition, start: ticks(transition.start), duration: ticks(transition.duration) }, kind: track.kind, track: track.id, clips }
  }
  return null
}

type Options = {
  film: FilmInfo | null
  session: FilmSessionState | null
  store: TimelineViewStore
  tool: string
  invoke: (id: string, params?: Record<string, unknown>) => Promise<unknown>
  rollRipple: boolean
  still: StillDuration
  /** The default transition durations, which a dropped transition's preview spans. */
  transitionDurations: TransitionDurations
  items: ReadonlyMap<number, FilmProjectItem>
  geometry: () => GestureGeometry
  root: RefObject<HTMLDivElement | null>
  /** The open document: another one drops a gesture in progress. */
  doc: unknown
  /**
   * While a dialog's preview is open, the document's clips: the tracks draw the preview, and a
   * press only selects one of these (`previewCommands`). No drag, trim, cut, drop, or clip menu.
   */
  previewClips?: ReadonlySet<number> | null
}

/**
 * A press in progress: what it grabbed (with the modifiers at the press), whether it became a
 * drag, the drag, the modifiers of the latest pointer event, and the long-press timer.
 */
type Gesture = { pointer: number; pressed: Pressed; mods: Mods; started: boolean; drag: Drag | null; x: number; y: number; frame: number; timer: ReturnType<typeof setTimeout> | null; transition?: { id: number; grab: TransitionGrab | null; frames: number } }

/** Upstream's drag auto-scroll: within 20 px of the right edge or 10 px of the left, 6 px a frame. */
const EDGE_RIGHT = 20
const EDGE_LEFT = 10
const EDGE_STEP = 6
/** How far in from each end of a transition a press takes that end (upstream's edge zone). */
const EDGE_ZONE = EDGE_PX

const modsOf = (event: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }): Mods => ({ shift: event.shiftKey, alt: event.altKey, command: isMac() ? event.metaKey : event.ctrlKey })

/** Upstream's cursor for what a press would grab. */
function cursorFor(tool: string, grab: ReturnType<typeof hitTest>) {
  if (grab.kind === 'edge') return 'col-resize'
  if (tool === 'Razor' && grab.kind === 'clip') return 'crosshair'
  if ((tool === 'Slip' || tool === 'Slide') && grab.kind === 'clip') return 'ew-resize'
  if (tool === 'Hand') return 'grab'
  if (tool === 'Zoom') return 'zoom-in'
  return ''
}

/**
 * The Timeline's tools (upstream `interact`): every press on the tracks goes through `gestures.ts`.
 * A click or a drag start sends what upstream sends then (a select, a razor cut, an edit point);
 * the drag itself is drawn from the `dragView` store and sends its one command on release. Also
 * the cursor and hover feedback, the clip menu, a double-click into a nested sequence, and drops
 * from the Project panel or the Source monitor.
 */
export function useGestures({ film, session, store, tool, invoke, rollRipple, still, transitionDurations, items, geometry, root, doc, previewClips = null }: Options) {
  const { store: uiStore } = useUi()
  // A replacement project can reuse both this Worker and the same sequence/clip IDs.
  const projectEpoch = (doc as { info?: { inspected?: { project?: { epoch?: number } } } } | null)?.info?.inspected?.project?.epoch
  const epoch = useRef(0)
  const dragView = useMemo(createDragView, [])
  const scene = useMemo(() => (film ? sceneOf(film, session, rollRipple) : null), [film, session, rollRipple])
  const latest = useRef({ scene, tool, invoke, film, still, items, previewClips, transitionDurations })
  latest.current = { scene, tool, invoke, film, still, items, previewClips, transitionDurations }
  const gesture = useRef<Gesture | null>(null)
  // Commands go out one after another, in the order the gesture made them.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const send = useCallback((commands: readonly Command[]) => {
    const generation = epoch.current
    for (const command of commands) {
      queue.current = queue.current.catch(() => undefined).then(() => {
        if (epoch.current === generation) return latest.current.invoke(command.id, command.params)
      })
    }
  }, [])

  /** The gestures' layout now: the view's zoom and scroll, and this render's rows. */
  const layoutNow = useCallback((): Layout => {
    const { pps, scroll } = store.get()
    const { contentWidth, rows } = geometry()
    return { pps, scroll, width: contentWidth, rows, ruler: null }
  }, [store, geometry])
  /** A pointer event's place: x from the left of the track content, y from the panel's top. */
  const placeOf = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const box = root.current?.getBoundingClientRect()
      return { x: event.clientX - (box?.left ?? 0) - geometry().headerWidth, y: event.clientY - (box?.top ?? 0) }
    },
    [root, geometry],
  )

  const show = useCallback(
    (scene: Scene, drag: Drag, snapX: number | null) => {
      const marquee = drag.kind === 'marquee' ? { left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) } : null
      dragView.set({ previews: preview(scene, drag), snapX, marquee, razor: null, brackets: [] })
    },
    [dragView],
  )

  /** The drag with the pointer where it is now; a Hand drag pans the view. */
  const update = useCallback(() => {
    const current = gesture.current
    const { scene } = latest.current
    if (!current?.drag || !scene) return
    const moved = moveDrag(scene, layoutNow(), current.drag, current.x, current.y, current.mods)
    current.drag = moved.drag
    if (moved.pan) {
      const view = store.get()
      const targetScroll = Math.max(0, view.targetScroll - moved.pan.dx / view.pps)
      store.set({ ...scrollHalf(view, 'video', moved.pan.dy, geometry().maxVideo), targetScroll, scroll: targetScroll })
    }
    show(scene, moved.drag, moved.snapX)
  }, [geometry, layoutNow, show, store])

  /** Upstream scrolls while a drag is held near the left or right edge, every frame. */
  const autoScroll = useCallback(() => {
    const current = gesture.current
    if (!current?.drag) return
    current.frame = requestAnimationFrame(autoScroll)
    if (current.drag.kind === 'pan') return
    const view = store.get()
    const width = geometry().contentWidth
    let scroll = view.targetScroll
    if (current.x > width - EDGE_RIGHT) scroll += EDGE_STEP / view.pps
    else if (current.x < EDGE_LEFT && scroll > 0) scroll = Math.max(0, scroll - EDGE_STEP / view.pps)
    if (scroll === view.targetScroll) return
    store.set({ scroll, targetScroll: scroll })
    update()
  }, [geometry, store, update])

  const finish = useCallback(() => {
    const current = gesture.current
    gesture.current = null
    if (current?.frame) cancelAnimationFrame(current.frame)
    if (current?.timer) clearTimeout(current.timer)
    if (current && root.current?.hasPointerCapture(current.pointer)) root.current.releasePointerCapture(current.pointer)
    dragView.clear()
  }, [dragView, root])
  useEffect(() => () => finish(), [finish])
  // A press's modifiers follow the keys while it lasts, so a hold that turns into a drag with no
  // pointer move acts with the keys held then (upstream reads them on the frame the drag starts).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (gesture.current) gesture.current.mods = modsOf(event)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
    }
  }, [])

  /** The end of transition `id` a press at `x` takes (upstream `Hit::Transition`'s `edge`), or null in its middle. */
  const transitionGrabAt = useCallback(
    (id: number, x: number): TransitionGrab | null => {
      const { scene, film } = latest.current
      const found = findTransition(film, id)
      if (!scene || !found || !(scene.frame > 0)) return null
      const layout = layoutNow()
      const t = tickAt(scene, layout, x)
      const { info, clips } = found
      const cut = cutOf(info, clips)
      const alignment = alignmentOf(info.from, info.to)
      const zone = EDGE_ZONE / layout.pps * scene.tps
      const side = grabEnd(info, cut, alignment, t, zone)
      if (side == null) return null
      const frames = Math.max(1, Math.round(info.duration / scene.frame))
      return { id, cut, alignment, side, end: side > 0 ? info.start + info.duration : info.start, pressT: t, frames, limit: maxFrames(info, clips, scene.frame) }
    },
    [layoutNow],
  )

  /** Where the pointer last hovered over the tracks with no button down, so a tool chosen by key redraws its feedback there. */
  const hovered = useRef<{ x: number; y: number; mods: Mods } | null>(null)
  /** No hover feedback: the default cursor, no edge brackets, no Razor line or its snap indicator. */
  const clearHover = useCallback(() => {
    hovered.current = null
    if (root.current) root.current.style.cursor = ''
    if (!gesture.current) dragView.set({ razor: null, brackets: [], snapX: null })
  }, [dragView, root])

  /** The hover feedback: the cursor, the edge a press would trim, and the Razor's cut line (snapped, with the snap indicator). */
  const hover = useCallback(
    (x: number, y: number, mods: Mods) => {
      const { scene, tool, previewClips: previewing } = latest.current
      const element = root.current
      if (!scene || !element) return
      if (previewing) {
        clearHover()
        return
      }
      hovered.current = { x, y, mods }
      const layout = layoutNow()
      const grab = hitTest(scene, layout, x, y, tool, mods)
      element.style.cursor = cursorFor(tool, grab)
      if (tool === 'Selection' && grab.kind === 'transition' && transitionGrabAt(grab.id, x)) element.style.cursor = 'col-resize'
      const row = grab.kind === 'edge' || grab.kind === 'clip' ? layout.rows.find((each) => each.track === grab.track) : undefined
      let razor = null
      let snapX: number | null = null
      const brackets: Bracket[] = []
      if (tool === 'Razor' && grab.kind === 'clip' && row) {
        const snapped = snapAt(scene, layout, x)
        snapX = snapped.x
        razor = { x: xOf(scene, layout, snapped.time), top: row.top, height: row.height }
      }
      if (grab.kind === 'edge' && row) {
        const marks = grab.trim === 'roll' && grab.left != null && grab.right != null ? [{ clip: grab.left, out: true }, { clip: grab.right, out: false }] : [{ clip: grab.clip, out: grab.edge === 'out' }]
        for (const mark of marks) {
          const found = findClip(scene, mark.clip)
          if (!found) continue
          const t = mark.out ? found.clip.start + found.clip.duration : found.clip.start
          brackets.push({ x: xOf(scene, layout, t), top: row.top, height: row.height, out: mark.out, ripple: grab.trim === 'ripple' })
        }
      }
      dragView.set({ razor, brackets, snapX })
    },
    [clearHover, dragView, layoutNow, root],
  )
  // Another tool: what a press would grab changes under a pointer that stays put (upstream redraws it every frame).
  useEffect(() => {
    if (gesture.current) return
    const last = hovered.current
    if (last) hover(last.x, last.y, last.mods)
    else clearHover()
  }, [tool, hover, clearHover])
  // Another document: a gesture in progress, its feedback, and the clip menu belong to the old one.
  const [menu, setMenu] = useState<{ at: ContextMenuPoint; clip: number | null } | null>(null)
  // The transition menu (Set Transition Duration…), and the Set Transition Duration dialog's transition.
  const [transitionMenu, setTransitionMenu] = useState<{ at: ContextMenuPoint; id: number } | null>(null)
  const [durationDialog, setDurationDialog] = useState<number | null>(null)
  useLayoutEffect(() => {
    // Pending input belongs to the document/sequence and configuration that accepted it.
    // Subscribe synchronously: a deny/allow pair may arrive before React renders either one.
    // Restoring permission must never revive a held drag or its queued commands.
    const cancel = () => {
      epoch.current += 1
      finish()
      clearHover()
      setMenu(null)
      setTransitionMenu(null)
      setDurationDialog(null)
      localSelection.set({ transition: null })
    }
    cancel()
    const unsubscribe = uiStore.subscribe(cancel)
    return () => {
      unsubscribe()
      epoch.current += 1
      finish()
    }
  }, [doc, projectEpoch, film?.activeSequence, uiStore, finish, clearHover])

  /** A transition end's drag where the pointer is now: its span drawn, snapped as upstream snaps it. */
  const updateTransition = useCallback(
    (current: Gesture) => {
      const { scene, film } = latest.current
      const grab = current.transition?.grab
      if (!scene || !grab || !current.transition) return
      const found = findTransition(film, grab.id)
      const layout = layoutNow()
      let snapX: number | null = null
      const exclude = found ? [found.info.from, found.info.to].filter((clip): clip is number => clip != null) : []
      const dragged = dragEnd(
        grab,
        tickAt(scene, layout, current.x),
        (t) => {
          const snapped = snapTo(scene, layout, t, exclude, true)
          snapX = snapped.x
          return snapped.time
        },
        scene.frame,
      )
      current.transition.frames = dragged.frames
      dragView.set({ transition: { id: grab.id, start: dragged.start, duration: dragged.duration }, snapX })
    },
    [dragView, layoutNow],
  )

  /**
   * The press becomes a drag (upstream `drag_started`): what that sends now, with the modifiers of
   * the frame it starts on, and the drag it starts.
   */
  const startDrag = useCallback(
    (current: Gesture) => {
      const { scene, tool, previewClips: previewing } = latest.current
      // Over a preview a press never becomes a drag: it stays a click.
      if (!scene || current.started || previewing) return
      current.started = true
      if (current.timer) clearTimeout(current.timer)
      current.timer = null
      // A transition's end resizes it (upstream `Drag::Transition`); its middle does nothing: the
      // engine has no command that moves a transition along its cut.
      if (current.transition) {
        updateTransition(current)
        return
      }
      const started = begin(scene, layoutNow(), current.pressed, tool, current.mods, false)
      send(started.commands)
      current.drag = started.drag
      if (current.drag) current.frame = requestAnimationFrame(autoScroll)
      update()
    },
    [autoScroll, layoutNow, send, update, updateTransition],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const { scene, tool } = latest.current
      if (event.button !== 0 || !scene || !(event.target as Element).closest('.film-tl-lane')) return
      const { x, y } = placeOf(event)
      const mods = modsOf(event)
      event.currentTarget.setPointerCapture(event.pointerId)
      const current: Gesture = { pointer: event.pointerId, pressed: { x, y, grab: hitTest(scene, layoutNow(), x, y, tool, mods) }, mods, started: false, drag: null, x, y, frame: 0, timer: null }
      const grab = current.pressed.grab
      // The Selection tool on a transition: a click selects it, a drag of an end resizes it.
      if (tool === 'Selection' && grab.kind === 'transition') current.transition = { id: grab.id, grab: transitionGrabAt(grab.id, x), frames: 0 }
      // A press anywhere else on the tracks lets go of the transition chosen.
      else localSelection.set({ transition: null })
      // Held past egui's click time, a press is a drag where it is.
      current.timer = setTimeout(() => {
        current.timer = null
        if (gesture.current === current) startDrag(current)
      }, CLICK_MS)
      gesture.current = current
      hovered.current = null
      dragView.set({ razor: null, brackets: [], snapX: null })
    },
    [dragView, layoutNow, placeOf, startDrag, transitionGrabAt],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = gesture.current
      const { x, y } = placeOf(event)
      if (!current) {
        if ((event.target as Element).closest('.film-tl-lane')) hover(x, y, modsOf(event))
        else if (hovered.current || root.current?.style.cursor) clearHover()
        return
      }
      if (event.pointerId !== current.pointer) return
      current.x = x
      current.y = y
      current.mods = modsOf(event)
      if (!current.started) {
        if (isDrag(x - current.pressed.x, y - current.pressed.y)) startDrag(current)
        return
      }
      if (current.transition) updateTransition(current)
      else update()
    },
    [clearHover, hover, placeOf, root, startDrag, update, updateTransition],
  )

  const onPointerLeave = useCallback(() => {
    if (!gesture.current) clearHover()
  }, [clearHover])

  /** Selects transition `id` (upstream `timeline.select` with `transitions`): the clips are let go. */
  const selectTransition = useCallback(
    (id: number) => {
      localSelection.set({ transition: id })
      if ((latest.current.scene?.selection.length ?? 0) > 0) send([{ id: 'timeline.select', params: { clips: [] } }])
    },
    [send],
  )
  /** Gives transition `id` a length of `frames`: one apply of it again (`durationCommand`), and the new one selected. */
  const resizeTransition = useCallback(async (id: number, frames: number) => {
    const found = findTransition(latest.current.film, id)
    const command = found ? durationCommand(found.info, found.kind, frames) : null
    if (!command) return
    const generation = epoch.current
    const applied = appliedTransition(await latest.current.invoke(command.id, command.params))
    if (epoch.current === generation && applied != null) localSelection.set({ transition: applied })
  }, [])

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = gesture.current
      if (!current || event.pointerId !== current.pointer) return
      const { scene, tool } = latest.current
      const { x, y } = placeOf(event)
      if (current.transition) {
        const { id, grab, frames } = current.transition
        finish()
        if (!current.started) selectTransition(id)
        else if (grab && frames > 0 && frames !== grab.frames) void resizeTransition(id, frames)
        return
      }
      // A click acts with the modifiers held when it ends (upstream's `clicked` frame).
      if (scene && !current.started) {
        const clicked = begin(scene, layoutNow(), current.pressed, tool, modsOf(event), true)
        const previewing = latest.current.previewClips
        send(previewing ? previewCommands(clicked.commands, previewing) : clicked.commands)
        if (clicked.zoom) store.set((view) => ({ ...view, ...zoomAt(view, clicked.zoom!.factor, clicked.zoom!.time, clicked.zoom!.x) }))
      } else if (scene && current.drag) {
        const last = release(scene, layoutNow(), current.drag, x, y, modsOf(event))
        if (last) send([last])
      }
      finish()
    },
    [finish, layoutNow, placeOf, resizeTransition, selectTransition, send, store],
  )

  // The clip menu (upstream's `context_menu` on the tracks): a right-click selects an unselected clip first.
  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const { scene, previewClips: previewing } = latest.current
      if (!scene || !(event.target as Element).closest('.film-tl-lane')) return
      event.preventDefault()
      if (previewing) return
      // On macOS a browser turns Ctrl with the primary button into a context menu; upstream (winit's
      // `mouse_down`) gets the primary button with Ctrl held, which no tool reads, so it is a plain
      // press there and the pointer handlers already took it.
      if (isMac() && event.ctrlKey && event.button === 0) return
      const { x, y } = placeOf(event)
      const hit = hitAt(scene, layoutNow(), x, y)
      if (hit.kind === 'transition') {
        selectTransition(hit.id)
        setTransitionMenu({ at: { x: event.clientX, y: event.clientY }, id: hit.id })
        return
      }
      localSelection.set({ transition: null })
      const clip = hit.kind === 'clip' ? hit.clip : null
      if (clip != null && !scene.selection.includes(clip)) send([{ id: 'timeline.select', params: { clips: [clip] } }])
      setMenu({ at: { x: event.clientX, y: event.clientY }, clip })
    },
    [layoutNow, placeOf, selectTransition, send],
  )
  const closeMenu = useCallback(() => setMenu(null), [])
  const closeTransitionMenu = useCallback(() => setTransitionMenu(null), [])
  const closeDurationDialog = useCallback(() => setDurationDialog(null), [])

  // A double-click on a nested sequence's clip opens it in its own Timeline tab.
  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const { scene, tool, items, previewClips: previewing } = latest.current
      // The press's pointer capture makes the panel itself the double-click's target: its place decides (`hitAt`).
      const onLane = (event.target as Element).closest('.film-tl-lane') != null || event.target === event.currentTarget
      if (!scene || previewing || tool !== 'Selection' || !onLane) return
      const { x, y } = placeOf(event)
      const hit = hitAt(scene, layoutNow(), x, y)
      // A double-click on a transition: Set Transition Duration (upstream `open_duration`).
      if (hit.kind === 'transition') {
        selectTransition(hit.id)
        setDurationDialog(hit.id)
        return
      }
      if (hit.kind !== 'clip') return
      const found = findClip(scene, hit.clip)
      if (!found || items.get(found.clip.item)?.type !== 'Sequence') return
      send([
        { id: 'timeline.select', params: { clips: [hit.clip] } },
        { id: 'sequence.revealNested', params: {} },
      ])
    },
    [layoutNow, placeOf, selectTransition, send],
  )

  /**
   * An effect from the Effects panel over the tracks (upstream `effect_drop_preview`): the clip under
   * the pointer, if the effect fits its track, outlined; a transition's span on the nearer cut of
   * that clip, with its alignment; and the commands its drop sends (the apply, then the clip
   * selected, as upstream), or null where it cannot land.
   */
  const effectTarget = useCallback(
    (event: { clientX: number; clientY: number; dataTransfer: DataTransfer | null }): { commands: Command[]; view: NonNullable<ReturnType<typeof dragView.get>['effectDrop']> } | null => {
      const { scene, transitionDurations } = latest.current
      const payload: EffectPayload | null = effectDrag(event.dataTransfer)
      if (!scene || !payload) return null
      const { x, y } = placeOf(event)
      const layout = layoutNow()
      if (x < 0 || x > layout.width) return null
      const row = layout.rows.find((each) => each.top <= y && y < each.top + each.height)
      const track = row ? scene.tracks.find((each) => each.id === row.track) : undefined
      if (!row || !track) return null
      const t = tickAt(scene, layout, x)
      const clip = track.clips.find((each) => each.start <= t && t < each.start + each.duration)
      if (!clip) return null
      const box = { top: row.top, height: row.height }
      const clipView = { x: xOf(scene, layout, clip.start), width: (clip.duration / scene.tps) * layout.pps, ...box, transition: false, cutX: null, label: null }
      if ('preset' in payload) {
        if (track.kind !== 'video') return null
        return { commands: [{ id: 'presets.apply', params: { preset: payload.preset, clips: [clip.id] } }, { id: 'timeline.select', params: { clips: [clip.id] } }], view: clipView }
      }
      if (!fitsTrack(payload.kind, track.kind)) return null
      if (!isTransition(payload.kind)) return { commands: [{ id: 'effects.apply', params: { effect: payload.effect, clips: [clip.id] } }, { id: 'timeline.select', params: { clips: [clip.id] } }], view: clipView }
      const { edge, cut, alignment } = dropEdge(clip, track.clips, t)
      const span = transitionSpan(cut, defaultDuration(track.kind === 'video' ? transitionDurations.video : transitionDurations.audio, scene.frame, scene.tps), alignment, scene.frame)
      const left = xOf(scene, layout, span.start)
      return {
        // `effects.apply` takes no edge: the transition commands place it on the clip's edge the pointer is nearer.
        commands: [{ id: track.kind === 'video' ? 'sequence.applyVideoTransition' : 'sequence.applyAudioTransition', params: { effect: payload.effect, clip: clip.id, edge } }],
        view: { x: left, width: Math.max(2, (span.duration / scene.tps) * layout.pps), ...box, transition: true, cutX: xOf(scene, layout, cut), label: ALIGNMENT_LABELS[alignment] },
      }
    },
    [layoutNow, placeOf],
  )

  // Drops from the Project panel and the Source monitor (`timeline.place`), previewed where they would land.
  const onDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const { scene, items, still, film, previewClips: previewing } = latest.current
      if (scene && film && !previewing && carriesEffect(event.dataTransfer)) {
        event.preventDefault()
        const target = effectTarget(event)
        event.dataTransfer.dropEffect = target ? 'copy' : 'none'
        dragView.set({ effectDrop: target?.view ?? null })
        return
      }
      if (!scene || !film || previewing || !event.dataTransfer.types.includes(FILM_DRAG_TYPE)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      const payload = filmDrag()
      const { x, y } = placeOf(event)
      const layout = layoutNow()
      const row = payload ? dropRow(layout, y, payload) : null
      if (!payload || x < 0 || x > layout.width) {
        dragView.set({ drop: null, snapX: null })
        return
      }
      // Upstream snaps the drop's time whether or not a row takes it, so the snap indicator shows either way.
      const snapped = snapAt(scene, layout, x)
      if (!row) {
        dragView.set({ drop: null, snapX: snapped.x })
        return
      }
      const item = items.get(payload.item)
      const stillSeconds = still.unit === 'frames' ? still.amount * film.frame : still.amount
      const seconds = payload.duration != null ? payload.duration / scene.tps : item && item.duration > 0 && item.type !== 'Still' ? item.duration : stillSeconds
      dragView.set({ drop: { x: xOf(scene, layout, snapped.time), width: seconds * layout.pps, top: row.top, height: row.height, insert: modsOf(event).command }, snapX: snapped.x })
    },
    [dragView, layoutNow, placeOf],
  )
  const onDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dragView.set({ drop: null, snapX: null, effectDrop: null })
    },
    [dragView],
  )
  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const { scene, previewClips: previewing } = latest.current
      if (previewing) return
      if (carriesEffect(event.dataTransfer)) {
        event.preventDefault()
        const target = effectTarget(event)
        dragView.set({ effectDrop: null })
        endEffectDrag()
        if (target) send(target.commands)
        return
      }
      const payload = filmDrag(event.dataTransfer)
      dragView.set({ drop: null, snapX: null })
      if (!scene || !payload) return
      event.preventDefault()
      const { x, y } = placeOf(event)
      const command = placeCommand(scene, layoutNow(), x, y, payload, modsOf(event))
      endFilmDrag()
      if (command) send([command])
    },
    [dragView, layoutNow, placeOf, send],
  )

  const handlers = { onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onPointerCancel: finish, onLostPointerCapture: finish, onContextMenu, onDoubleClick, onDragOver, onDragLeave, onDrop }
  return { dragView, handlers, menu, closeMenu, scene, transitionMenu, closeTransitionMenu, durationDialog, openDurationDialog: setDurationDialog, closeDurationDialog }
}
