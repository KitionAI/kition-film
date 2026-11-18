import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { isMac, useUi, type ContextMenuPoint } from '@kition/kit-editor'
import type { FilmInfo, FilmProjectItem } from '../film'
import type { FilmSessionState } from '../session/useFilmSession'
import { scrollHalf, zoomAt } from './layout'
import type { TimelineViewStore } from './view'
import { CLICK_MS, begin, dropRow, findClip, hitAt, hitTest, isDrag, moveDrag, placeCommand, preview, release, sceneOf, snapAt, xOf, type Command, type Drag, type Layout, type Mods, type Pressed, type Row, type Scene } from './gestures'
import { createDragView, type Bracket } from './dragView'
import { FILM_DRAG_TYPE, endFilmDrag, filmDrag } from './drop'
import { previewCommands } from '../dialogs/previewViews'

/** Where the track rows are this render: the header's width, the content's, the rows (y from the panel's top), and the video half's scroll range. */
export type GestureGeometry = { headerWidth: number; contentWidth: number; rows: readonly Row[]; maxVideo: number }

/** Settings ▸ Timeline ▸ Still Image Default Duration, which a dropped still's preview spans. */
export type StillDuration = { amount: number; unit: string }

type Options = {
  film: FilmInfo | null
  session: FilmSessionState | null
  store: TimelineViewStore
  tool: string
  invoke: (id: string, params?: Record<string, unknown>) => Promise<unknown>
  rollRipple: boolean
  still: StillDuration
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
type Gesture = { pointer: number; pressed: Pressed; mods: Mods; started: boolean; drag: Drag | null; x: number; y: number; frame: number; timer: ReturnType<typeof setTimeout> | null }

/** Upstream's drag auto-scroll: within 20 px of the right edge or 10 px of the left, 6 px a frame. */
const EDGE_RIGHT = 20
const EDGE_LEFT = 10
const EDGE_STEP = 6

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
export function useGestures({ film, session, store, tool, invoke, rollRipple, still, items, geometry, root, doc, previewClips = null }: Options) {
  const { store: uiStore } = useUi()
  // A replacement project can reuse both this Worker and the same sequence/clip IDs.
  const projectEpoch = (doc as { info?: { inspected?: { project?: { epoch?: number } } } } | null)?.info?.inspected?.project?.epoch
  const epoch = useRef(0)
  const dragView = useMemo(createDragView, [])
  const scene = useMemo(() => (film ? sceneOf(film, session, rollRipple) : null), [film, session, rollRipple])
  const latest = useRef({ scene, tool, invoke, film, still, items, previewClips })
  latest.current = { scene, tool, invoke, film, still, items, previewClips }
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
  useLayoutEffect(() => {
    // Pending input belongs to the document/sequence and configuration that accepted it.
    // Subscribe synchronously: a deny/allow pair may arrive before React renders either one.
    // Restoring permission must never revive a held drag or its queued commands.
    const cancel = () => {
      epoch.current += 1
      finish()
      clearHover()
      setMenu(null)
    }
    cancel()
    const unsubscribe = uiStore.subscribe(cancel)
    return () => {
      unsubscribe()
      epoch.current += 1
      finish()
    }
  }, [doc, projectEpoch, film?.activeSequence, uiStore, finish, clearHover])

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
      const started = begin(scene, layoutNow(), current.pressed, tool, current.mods, false)
      send(started.commands)
      current.drag = started.drag
      if (current.drag) current.frame = requestAnimationFrame(autoScroll)
      update()
    },
    [autoScroll, layoutNow, send, update],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const { scene, tool } = latest.current
      if (event.button !== 0 || !scene || !(event.target as Element).closest('.film-tl-lane')) return
      const { x, y } = placeOf(event)
      const mods = modsOf(event)
      event.currentTarget.setPointerCapture(event.pointerId)
      const current: Gesture = { pointer: event.pointerId, pressed: { x, y, grab: hitTest(scene, layoutNow(), x, y, tool, mods) }, mods, started: false, drag: null, x, y, frame: 0, timer: null }
      // Held past egui's click time, a press is a drag where it is.
      current.timer = setTimeout(() => {
        current.timer = null
        if (gesture.current === current) startDrag(current)
      }, CLICK_MS)
      gesture.current = current
      hovered.current = null
      dragView.set({ razor: null, brackets: [], snapX: null })
    },
    [dragView, layoutNow, placeOf, startDrag],
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
      update()
    },
    [clearHover, hover, placeOf, root, startDrag, update],
  )

  const onPointerLeave = useCallback(() => {
    if (!gesture.current) clearHover()
  }, [clearHover])

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = gesture.current
      if (!current || event.pointerId !== current.pointer) return
      const { scene, tool } = latest.current
      const { x, y } = placeOf(event)
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
    [finish, layoutNow, placeOf, send, store],
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
      const clip = hit.kind === 'clip' ? hit.clip : null
      if (clip != null && !scene.selection.includes(clip)) send([{ id: 'timeline.select', params: { clips: [clip] } }])
      setMenu({ at: { x: event.clientX, y: event.clientY }, clip })
    },
    [layoutNow, placeOf, send],
  )
  const closeMenu = useCallback(() => setMenu(null), [])

  // A double-click on a nested sequence's clip opens it in its own Timeline tab.
  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const { scene, tool, items, previewClips: previewing } = latest.current
      if (!scene || previewing || tool !== 'Selection' || !(event.target as Element).closest('.film-tl-lane')) return
      const { x, y } = placeOf(event)
      const hit = hitAt(scene, layoutNow(), x, y)
      if (hit.kind !== 'clip') return
      const found = findClip(scene, hit.clip)
      if (!found || items.get(found.clip.item)?.type !== 'Sequence') return
      send([
        { id: 'timeline.select', params: { clips: [hit.clip] } },
        { id: 'sequence.revealNested', params: {} },
      ])
    },
    [layoutNow, placeOf, send],
  )

  // Drops from the Project panel and the Source monitor (`timeline.place`), previewed where they would land.
  const onDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const { scene, items, still, film, previewClips: previewing } = latest.current
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
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dragView.set({ drop: null, snapX: null })
    },
    [dragView],
  )
  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const { scene, previewClips: previewing } = latest.current
      if (previewing) return
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
  return { dragView, handlers, menu, closeMenu, scene }
}
