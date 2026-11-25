import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { formatTimecode, isMac, useUi, type ContextMenuPoint } from '@kition/sdk/editor'
import type { FilmClip, FilmInfo, FilmProjectItem, FilmTrack } from '../film'
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
import { FADER_MAX_DB, FADER_MIN_DB, bandHit, bandOf, dbText, draggedDb, keysAround, keyTimeBetween, levelAt } from './volumeBand'
import { draggedFrames, fadeAt, fadeCommand, onHandle } from './fades'
import { ALIGNMENT_LABELS, alignedMaxFrames, alignmentAt, alignmentOf, boundsOf, cutOf, defaultDuration, dragEnd, dropAlignment, dropEdge, durationCommand, grabEnd, maxFrames, removeCommand, slideSpan, spanCommand, transitionSpan, type SpanClip, type TransitionGrab, type TransitionInfo } from './transitions'

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
  /** Scrubs the program playhead (the ruler's scrub): a press on the playhead's line on empty track space drags it. */
  scrub: (seconds: number, phase: 'start' | 'move' | 'end') => void
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
  /**
   * Files dropped from the computer (`App`'s `dropFiles`): imported, then placed where they were
   * dropped, one after another; absent where the Timeline takes no such drop.
   */
  dropFiles?: (files: readonly File[]) => Promise<number[]>
  /** A read-only engine query, answered as parsed JSON (where a placed clip ends). */
  query?: (id: string, params?: Record<string, unknown>) => Promise<unknown>
}

/** Whether a drag carries files from the computer (the browser's `Files` type). */
const carriesFiles = (data: DataTransfer | null) => data != null && Array.from(data.types).includes('Files')

/** A command's answer as JSON (a session answers a string). */
const answerOf = (answer: unknown) => {
  if (typeof answer !== 'string') return (answer ?? null) as Record<string, unknown> | null
  try {
    return JSON.parse(answer) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Where the clip `id` ends on the inspected sequence (`sequence.inspect`), in ticks, or null. */
function clipEnd(inspected: unknown, id: number): number | null {
  const sequence = inspected as { video?: Array<{ items?: Array<{ id: number; start?: number; duration?: number; end?: number }> }>; audio?: Array<{ items?: Array<{ id: number; start?: number; duration?: number; end?: number }> }> } | null
  for (const track of [...(sequence?.video ?? []), ...(sequence?.audio ?? [])])
    for (const item of track.items ?? []) if (item.id === id) return item.end ?? (item.start != null && item.duration != null ? item.start + item.duration : null)
  return null
}

/**
 * A press in progress: what it grabbed (with the modifiers at the press), whether it became a
 * drag, the drag, the modifiers of the latest pointer event, and the long-press timer.
 */
type Gesture = {
  pointer: number
  pressed: Pressed
  mods: Mods
  started: boolean
  drag: Drag | null
  x: number
  y: number
  frame: number
  timer: ReturnType<typeof setTimeout> | null
  transition?: { id: number; grab: TransitionGrab | null; frames: number; pressT: number; span: { start: number; duration: number } | null }
  /**
   * An audio clip's Volume line pressed (upstream `Grab::Volume`): the line (`key` null; a drag
   * changes the level there, or the keyframes either side of it) or one keyframe (a drag up or down
   * changes its level, sideways moves it in time, the way the drag first goes). Each drag is one
   * undo step: every level it sends is one `effects.setParam` merged under `merge`.
   */
  volume?: { clip: number; key: number | null; from: number; around: Array<{ ticks: number; value: number }>; axis: 'value' | 'time' | null; token: LiveToken; keyTime: number | null }
  /** The playhead's line pressed on empty track space: the press and the drag scrub it, as the ruler does. */
  playhead?: boolean
  /** A fade handle pressed: the clip, its end, its track's kind, the fade there (if any), and the length the drag gives (frames). */
  fade?: { clip: number; edge: 'in' | 'out'; kind: 'video' | 'audio'; existing: { id: number; duration: number } | null; frames: number }
}

/** Where a clip is drawn on the tracks: its track and clip (seconds), its body's left (content x), top (panel y), width and height. */
type Body = { track: FilmTrack; clip: FilmClip; left: number; top: number; width: number; height: number }

/** How near the playhead's line a press on empty track space grabs it (points). */
const PLAYHEAD_GRAB = 4

/** The Selection and Pen tools take the Volume line and the fade handles (upstream `grab_at`). */
const takesBand = (tool: string) => tool === 'Selection' || tool === 'Pen'
/** A drag's own merge key: its levels are one undo step, a new drag another; `begun` once its first level went out. */
type LiveToken = { merge: string; begun: boolean }
let volumeDrags = 0
const VOLUME = { effect: 'volume', param: 'level' }

/** Upstream's drag auto-scroll: within 20 px of the right edge or 10 px of the left, 6 px a frame. */
const EDGE_RIGHT = 20
const EDGE_LEFT = 10
const EDGE_STEP = 6
/** How far either side of a cut a dropped transition is centred on it; further out it starts or ends there. */
const DROP_CENTER_PX = 16
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
export function useGestures({ film, session, store, tool, invoke, scrub, rollRipple, still, transitionDurations, items, geometry, root, doc, previewClips = null, dropFiles, query }: Options) {
  const { store: uiStore } = useUi()
  // A replacement project can reuse both this Worker and the same sequence/clip IDs.
  const projectEpoch = (doc as { info?: { inspected?: { project?: { epoch?: number } } } } | null)?.info?.inspected?.project?.epoch
  const epoch = useRef(0)
  const dragView = useMemo(createDragView, [])
  const scene = useMemo(() => (film ? sceneOf(film, session, rollRipple) : null), [film, session, rollRipple])
  const latest = useRef({ scene, tool, invoke, film, still, items, previewClips, transitionDurations, scrub, dropFiles, query })
  latest.current = { scene, tool, invoke, film, still, items, previewClips, transitionDurations, scrub, dropFiles, query }
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

  /** An Option-drag's copy (`timeline.move` with `copy`), in turn with the rest; the copies it answers are then selected, as upstream's Copy leaves them. */
  const sendCopy = useCallback((command: Command) => {
    const generation = epoch.current
    queue.current = queue.current.catch(() => undefined).then(async () => {
      if (epoch.current !== generation) return
      const raw = await latest.current.invoke(command.id, command.params)
      // The engine's answer, as the session hands it on (its JSON text) or read already.
      let answer: { copied?: unknown } | null = null
      try {
        answer = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { copied?: unknown } | null
      } catch {
        answer = null
      }
      const copied = Array.isArray(answer?.copied) ? answer.copied.filter((id): id is number => typeof id === 'number') : []
      if (copied.length && epoch.current === generation) await latest.current.invoke('timeline.select', { clips: copied, linked: false })
    })
  }, [])

  // A live drag's levels: the latest waits while one is on its way, older ones are dropped.
  const live = useRef<{ busy: boolean; next: { token: LiveToken; commands: Command[] } | null }>({ busy: false, next: null })
  const sendLive = useCallback((token: LiveToken, commands: Command[]) => {
    const state = live.current
    if (state.busy) {
      state.next = { token, commands }
      return
    }
    state.busy = true
    const generation = epoch.current
    const run = async () => {
      for (const [index, command] of commands.entries()) {
        if (epoch.current !== generation) return
        // The drag's first level starts its undo step; the rest join it.
        const params = { ...command.params, merge: token.merge, begin: index === 0 && !token.begun }
        if (index === 0) token.begun = true
        await latest.current.invoke(command.id, params).catch(() => undefined)
      }
    }
    void run().finally(() => {
      state.busy = false
      const next = state.next
      state.next = null
      if (next) sendLive(next.token, next.commands)
    })
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

  /** The clip drawn at a point of the tracks (the document's, not a preview's), or null. */
  const bodyAt = useCallback(
    (x: number, y: number): Body | null => {
      const { film } = latest.current
      if (!film || latest.current.previewClips) return null
      const layout = layoutNow()
      const row = layout.rows.find((each) => each.top <= y && y < each.top + each.height)
      const track = row ? film.tracks.find((each) => each.id === row.track) : undefined
      if (!row || !track || x < 0 || x > layout.width) return null
      const t = layout.scroll + x / layout.pps
      const clip = track.clips.find((each) => each.start <= t && t < each.start + each.duration)
      if (!clip) return null
      return { track, clip, left: (clip.start - layout.scroll) * layout.pps, top: row.top + 1, width: Math.max(1, clip.duration * layout.pps), height: Math.max(1, row.height - 2) }
    },
    [layoutNow],
  )

  /**
   * Whether a press at (`x`, `y`) grabs the playhead's line: on a track, on empty space (a clip,
   * a transition or an edge there keeps its press), within `PLAYHEAD_GRAB` of the line.
   */
  const onPlayheadLine = useCallback(
    (x: number, y: number, grab: ReturnType<typeof hitTest>) => {
      const { scene, previewClips } = latest.current
      if (!scene || previewClips || grab.kind !== 'empty') return false
      const layout = layoutNow()
      if (!layout.rows.some((row) => row.top <= y && y < row.top + row.height)) return false
      return Math.abs(x - xOf(scene, layout, scene.playhead)) <= PLAYHEAD_GRAB
    },
    [layoutNow],
  )
  const markPlayhead = useCallback(
    (state: 'hover' | 'dragging', on: boolean) => {
      const line = root.current?.querySelector('.film-tl-playhead')
      if (line) line.toggleAttribute(`data-${state}`, on)
    },
    [root],
  )
  const timeOfX = useCallback((x: number) => {
    const layout = layoutNow()
    return Math.max(0, layout.scroll + x / layout.pps)
  }, [layoutNow])

  /**
   * What the Selection or Pen tool takes at a point of a clip: a fade handle (at a free clip end's
   * top corner), a keyframe of an audio clip's Volume line, or its line (away from the trim zones),
   * as upstream's `grab_at` puts the Volume line before the clip; or null.
   */
  const bandGrabAt = useCallback(
    (x: number, y: number, edgeFree: boolean): { body: Body; fade: 'in' | 'out' } | { body: Body; key: number | null } | null => {
      const { tool, film } = latest.current
      const body = bodyAt(x, y)
      if (!body || !film || !takesBand(tool) || body.track.locked) return null
      const pps = layoutNow().pps
      for (const edge of ['in', 'out'] as const) {
        const fade = fadeAt(body.track, body.clip.id, edge, film.frame)
        if (fade && onHandle(edge, fade.duration * pps, body.width, x - body.left, y - body.top)) return { body, fade: edge }
      }
      if (body.track.kind !== 'audio') return null
      // Keyframes are set through their timeline time, which names them exactly only at normal speed, forward, inside the clip.
      const exact = Math.abs(body.clip.speed - 1) < 1e-9 && !body.clip.reverse && body.clip.volumeKeys.every((key) => key.time >= body.clip.start && key.time <= body.clip.start + body.clip.duration)
      if (!exact) return null
      const hit = bandHit(body.clip.volumeKeys, body.clip.volumeDb, body.clip.start, body.clip.duration, body.width, body.height, x - body.left, y - body.top)
      if (!hit || (hit.kind === 'line' && !edgeFree)) return null
      return { body, key: hit.kind === 'key' ? hit.index : null }
    },
    [bodyAt, layoutNow],
  )

  const show = useCallback(
    (scene: Scene, drag: Drag, snapX: number | null) => {
      const marquee = drag.kind === 'marquee' ? { left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) } : null
      // An Option-drag copies: the pointer says so (Premiere's copy cursor).
      if (drag.kind === 'move' && root.current) root.current.style.cursor = drag.copying ? 'copy' : ''
      dragView.set({ previews: preview(scene, drag), snapX, marquee, razor: null, brackets: [] })
    },
    [dragView, root],
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
    // A copying drag's cursor goes with it.
    if (current?.drag?.kind === 'move' && root.current) root.current.style.cursor = ''
    // A drag of the playhead's line ends its scrub where the pointer is, however it ends.
    if (current?.playhead) {
      root.current?.querySelector('.film-tl-playhead')?.removeAttribute('data-dragging')
      const layout = layoutNow()
      latest.current.scrub(Math.max(0, layout.scroll + current.x / layout.pps), 'end')
    }
    dragView.clear()
  }, [dragView, layoutNow, root])
  useEffect(() => () => finish(), [finish])
  // A press's modifiers follow the keys while it lasts, so a hold that turns into a drag with no
  // pointer move acts with the keys held then (upstream reads them on the frame the drag starts).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!gesture.current) return
      gesture.current.mods = modsOf(event)
      // Option pressed or let go during a move: the drag shows whether it copies.
      if (gesture.current.drag?.kind === 'move' && event.key === 'Alt') update()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
    }
  }, [update])

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
      const bounds = boundsOf(info, clips)
      const two = info.from != null && info.to != null
      // Between two clips a centred one grows on both sides; one placed otherwise trims the end
      // dragged (upstream `drag_span`); one at a free clip edge grows from that edge.
      const actual = bounds ? alignmentAt(info, bounds.cut, scene.frame) : 'center'
      const alignment = !two ? alignmentOf(info.from, info.to) : actual === 'center' ? 'center' : 'custom'
      const zone = EDGE_ZONE / layout.pps * scene.tps
      const side = grabEnd(info, cut, alignment, t, zone)
      if (side == null) return null
      const frames = Math.max(1, Math.round(info.duration / scene.frame))
      const end = side > 0 ? info.start + info.duration : info.start
      const other = side > 0 ? info.start : info.start + info.duration
      return { id, cut, alignment, side, end, pressT: t, frames, limit: alignment === 'custom' ? alignedMaxFrames(info, clips, 'custom', scene.frame) : maxFrames(info, clips, scene.frame), lo: bounds?.lo, hi: bounds?.hi, other }
    },
    [layoutNow],
  )

  /** Where the pointer last hovered over the tracks with no button down, so a tool chosen by key redraws its feedback there. */
  const hovered = useRef<{ x: number; y: number; mods: Mods } | null>(null)
  /** No hover feedback: the default cursor, no edge brackets, no Razor line or its snap indicator. */
  const clearHover = useCallback(() => {
    hovered.current = null
    if (root.current) root.current.style.cursor = ''
    root.current?.querySelector('.film-tl-playhead')?.removeAttribute('data-hover')
    if (!gesture.current) dragView.set({ razor: null, brackets: [], snapX: null, volume: null, fade: null })
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
      if (tool === 'Selection' && grab.kind === 'transition') {
        // An end resizes it; the middle of one between two clips slides it over its cut.
        const found = findTransition(latest.current.film, grab.id)
        if (transitionGrabAt(grab.id, x)) element.style.cursor = 'col-resize'
        else if (found && found.info.from != null && found.info.to != null) element.style.cursor = 'ew-resize'
      }
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
      // The playhead's line on empty track space.
      const onLine = onPlayheadLine(x, y, grab)
      markPlayhead('hover', onLine)
      if (onLine) element.style.cursor = 'ew-resize'
      // The Volume line and the fade handles come before the clip (upstream `grab_at`).
      const band = bandGrabAt(x, y, grab.kind === 'clip' && grab.edge == null)
      let volume = null
      let fade = null
      if (band && 'fade' in band) {
        element.style.cursor = 'ew-resize'
        fade = { clip: band.body.clip.id, edge: band.fade, ramp: null }
        brackets.length = 0
      } else if (band) {
        element.style.cursor = band.key != null ? 'move' : mods.command || tool === 'Pen' ? 'copy' : 'ns-resize'
        volume = { clip: band.body.clip.id, line: band.key == null, key: band.key, keyTime: null }
      }
      dragView.set({ razor, brackets, snapX, volume, fade })
    },
    [bandGrabAt, clearHover, dragView, layoutNow, markPlayhead, onPlayheadLine, root],
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
  // Empty track space's menu: where it was opened, the track and the time there.
  const [laneMenu, setLaneMenu] = useState<{ at: ContextMenuPoint; track: number; seconds: number } | null>(null)
  useLayoutEffect(() => {
    // Pending input belongs to the document/sequence and configuration that accepted it.
    // Subscribe synchronously: a deny/allow pair may arrive before React renders either one.
    // Restoring permission must never revive a held drag or its queued commands.
    const cancel = () => {
      epoch.current += 1
      finish()
      clearHover()
      setMenu(null)
      setLaneMenu(null)
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

  /** A transition's drag where the pointer is now: an end resizes it (snapped as upstream snaps it), its middle slides it over its cut; its span drawn. */
  const updateTransition = useCallback(
    (current: Gesture) => {
      const { scene, film } = latest.current
      const dragging = current.transition
      if (!scene || !dragging) return
      const found = findTransition(film, dragging.id)
      if (!found) return
      const layout = layoutNow()
      const t = tickAt(scene, layout, current.x)
      const grab = dragging.grab
      if (!grab) {
        // The middle: a fade to or from nothing does not slide.
        if (found.info.from == null || found.info.to == null) return
        const span = slideSpan(found.info, found.clips, t - dragging.pressT, scene.frame)
        dragging.span = span
        dragView.set({ transition: { id: dragging.id, ...span }, snapX: null })
        return
      }
      let snapX: number | null = null
      const exclude = [found.info.from, found.info.to].filter((clip): clip is number => clip != null)
      const dragged = dragEnd(
        grab,
        t,
        (time) => {
          const snapped = snapTo(scene, layout, time, exclude, true)
          snapX = snapped.x
          return snapped.time
        },
        scene.frame,
      )
      dragging.frames = dragged.frames
      dragging.span = { start: dragged.start, duration: dragged.duration }
      dragView.set({ transition: { id: grab.id, start: dragged.start, duration: dragged.duration }, snapX })
    },
    [dragView, layoutNow],
  )

  /** Clip `id`'s body where it is drawn now, or null. */
  const bodyOf = useCallback(
    (id: number): Body | null => {
      const { film } = latest.current
      const layout = layoutNow()
      for (const track of film?.tracks ?? []) {
        const clip = track.clips.find((each) => each.id === id)
        const row = clip ? layout.rows.find((each) => each.track === track.id) : undefined
        if (clip && row) return { track, clip, left: (clip.start - layout.scroll) * layout.pps, top: row.top + 1, width: Math.max(1, clip.duration * layout.pps), height: Math.max(1, row.height - 2) }
      }
      return null
    },
    [layoutNow],
  )

  /**
   * A drag of the Volume line or one of its keyframes where the pointer is now (upstream
   * `timeline_volume::drag` and its keyframe drag): the line's level (or the keyframes either side
   * of the press, by as much) and a keyframe's level go to the engine as the pointer moves, heard
   * and drawn, every one merged into the drag's one undo step; a keyframe moved in time is drawn
   * where it would land and moved on release. The level shows next to the pointer.
   */
  const updateVolume = useCallback(
    (current: Gesture) => {
      const held = current.volume
      const { scene } = latest.current
      const body = held ? bodyOf(held.clip) : null
      const band = body ? bandOf(body.height) : null
      if (!held || !body || !band || !scene) return
      const key = held.key != null ? body.clip.volumeKeys[held.key] : undefined
      if (held.key != null && !key) return
      const dx = current.x - current.pressed.x
      const dy = current.y - current.pressed.y
      // A keyframe goes the way the drag first goes: sideways in time, else up or down in level.
      if (held.key != null && held.axis == null) {
        if (dx === 0 && dy === 0) return
        held.axis = Math.abs(dx) > Math.abs(dy) ? 'time' : 'value'
      }
      if (held.axis === 'time' && key) {
        const pps = layoutNow().pps
        const time = keyTimeBetween(body.clip.volumeKeys, held.key!, key.time + dx / pps, scene.frame / scene.tps, body.clip.start, body.clip.start + body.clip.duration)
        held.keyTime = time
        dragView.set({ volume: { clip: held.clip, line: false, key: held.key, keyTime: time }, tip: null })
        return
      }
      const db = draggedDb(band, held.from, current.pressed.y, current.y)
      const tip = { x: current.x, y: current.y, text: dbText(db) }
      // Nothing changed yet (a press held still): no undo step.
      if (!held.token.begun && Math.abs(db - held.from) < 1e-9) {
        dragView.set({ volume: { clip: held.clip, line: held.key == null, key: held.key, keyTime: null }, tip })
        return
      }
      const clamp = (value: number) => Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, value))
      const commands: Command[] = held.around.length
        ? held.around.map((each) => ({ id: 'effects.setParam', params: { clip: held.clip, ...VOLUME, time: each.ticks, value: clamp(each.value + db - held.from) } }))
        : [{ id: 'effects.setParam', params: { clip: held.clip, ...VOLUME, value: db } }]
      sendLive(held.token, commands)
      dragView.set({ volume: { clip: held.clip, line: held.key == null, key: held.key, keyTime: null }, tip })
    },
    [bodyOf, dragView, layoutNow, sendLive],
  )

  /** A fade handle's drag where the pointer is now: the ramp it would give, and its length next to the pointer. */
  const updateFade = useCallback(
    (current: Gesture) => {
      const held = current.fade
      const { scene, film } = latest.current
      const body = held ? bodyOf(held.clip) : null
      if (!held || !body || !scene || !film) return
      const pps = layoutNow().pps
      const frame = scene.frame / scene.tps
      held.frames = draggedFrames(held.edge, current.x - body.left, body.width, pps, frame, body.clip.duration)
      const width = held.frames * frame * pps
      const ramp = { x: held.edge === 'in' ? body.left : body.left + body.width - width, width, top: body.top, height: body.height }
      dragView.set({ fade: { clip: held.clip, edge: held.edge, ramp }, tip: { x: current.x, y: current.y, text: formatTimecode(held.frames * frame, film.fps, film.dropFrame) } })
    },
    [bodyOf, dragView, layoutNow],
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
      if (current.fade) {
        updateFade(current)
        return
      }
      if (current.volume) {
        updateVolume(current)
        return
      }
      // A transition's end resizes it, its middle moves it over its cut (upstream `Drag::Transition`).
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
    [autoScroll, layoutNow, send, update, updateFade, updateTransition, updateVolume],
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
      // The playhead's line on empty track space: scrubbed from the press, as the ruler does.
      if (onPlayheadLine(x, y, grab)) {
        current.playhead = true
        current.started = true
        gesture.current = current
        hovered.current = null
        markPlayhead('dragging', true)
        latest.current.scrub(timeOfX(x), 'start')
        return
      }
      const band = grab.kind === 'transition' ? null : bandGrabAt(x, y, grab.kind === 'clip' && grab.edge == null)
      // The Selection tool on a transition: a click selects it, a drag of an end resizes it, of its middle moves it.
      if (tool === 'Selection' && grab.kind === 'transition') {
        current.transition = { id: grab.id, grab: transitionGrabAt(grab.id, x), frames: 0, pressT: tickAt(scene, layoutNow(), x), span: null }
        localSelection.set({ keyframe: null })
      } else if (band && 'fade' in band) {
        // A fade handle: a drag sets the fade's length at that free end.
        const fade = latest.current.film ? fadeAt(band.body.track, band.body.clip.id, band.fade, latest.current.film.frame) : null
        current.fade = { clip: band.body.clip.id, edge: band.fade, kind: band.body.track.kind, existing: fade?.transition ? { id: fade.transition.id, duration: fade.transition.duration } : null, frames: 0 }
        // A click on it (no drag) is a click on the clip.
        current.pressed = { ...current.pressed, grab: { kind: 'clip', track: band.body.track.id, clip: band.body.clip.id, edge: null } }
        localSelection.set({ transition: null, keyframe: null })
      } else if (band) {
        // The Volume line or a keyframe on it: a keyframe pressed is chosen (Delete removes it).
        const { clip } = band.body
        const t = clip.start + (x - band.body.left) / Math.max(1e-9, layoutNow().pps)
        const key = band.key != null ? clip.volumeKeys[band.key] : undefined
        const around = band.key == null && clip.volumeKeys.length ? keysAround(clip.volumeKeys, t).map((index) => ({ ticks: Math.round(clip.volumeKeys[index].time * scene.tps), value: clip.volumeKeys[index].value })) : []
        const from = key ? key.value : levelAt(clip.volumeKeys, clip.volumeDb, t)
        current.volume = { clip: clip.id, key: band.key, from, around: key ? [{ ticks: Math.round(key.time * scene.tps), value: key.value }] : around, axis: null, token: { merge: `volume-line-${(volumeDrags += 1)}`, begun: false }, keyTime: null }
        localSelection.set({ transition: null, keyframe: key ? { clip: clip.id, mediaTime: key.mediaTime } : null })
      }
      // A press anywhere else on the tracks lets go of the transition and the keyframe chosen.
      else localSelection.set({ transition: null, keyframe: null })
      // Held past egui's click time, a press is a drag where it is.
      current.timer = setTimeout(() => {
        current.timer = null
        if (gesture.current === current) startDrag(current)
      }, CLICK_MS)
      gesture.current = current
      hovered.current = null
      dragView.set({ razor: null, brackets: [], snapX: null })
    },
    [bandGrabAt, dragView, layoutNow, markPlayhead, onPlayheadLine, placeOf, startDrag, timeOfX, transitionGrabAt],
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
      if (current.playhead) latest.current.scrub(timeOfX(x), 'move')
      else if (current.fade) updateFade(current)
      else if (current.volume) updateVolume(current)
      else if (current.transition) updateTransition(current)
      else update()
    },
    [clearHover, hover, placeOf, root, startDrag, timeOfX, update, updateFade, updateTransition, updateVolume],
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
  /** Sends the one command a transition's drag ends with (`sequence.setTransition`), keeping it selected. */
  const commitTransition = useCallback(async (id: number, command: Command | null) => {
    if (!command) return
    const generation = epoch.current
    await latest.current.invoke(command.id, command.params)
    if (epoch.current === generation) localSelection.set({ transition: id })
  }, [])

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = gesture.current
      if (!current || event.pointerId !== current.pointer) return
      const { scene, tool } = latest.current
      const { x, y } = placeOf(event)
      if (current.playhead) {
        current.x = x
        finish()
        return
      }
      if (current.fade && current.started) {
        const { clip, edge, kind, existing, frames } = current.fade
        finish()
        const command = scene ? fadeCommand(kind, clip, edge, existing, frames, scene.frame / scene.tps) : null
        if (command) send([command])
        return
      }
      if (current.volume && (current.started || current.volume.key != null)) {
        const { clip, key, axis, keyTime } = current.volume
        finish()
        // A keyframe moved in time: one `effects.moveKeyframe` (its level was not changed).
        const found = key != null ? bodyOf(clip)?.clip.volumeKeys[key] : undefined
        if (found && axis === 'time' && keyTime != null && scene && Math.abs(keyTime - found.time) * scene.tps >= 1) {
          send([{ id: 'effects.moveKeyframe', params: { clip, ...VOLUME, mediaTime: found.mediaTime, to: found.mediaTime + Math.round((keyTime - found.time) * scene.tps) } }])
        }
        return
      }
      // A Cmd/Ctrl-click on the Volume line, or a Pen click, adds a keyframe there (upstream `add_keyframe`).
      if (current.volume && scene && (modsOf(event).command || tool === 'Pen')) {
        const { clip } = current.volume
        finish()
        const t = Math.max(0, Math.round(tickAt(scene, layoutNow(), x) / scene.frame) * scene.frame)
        send([{ id: 'effects.addKeyframe', params: { clip, ...VOLUME, time: t } }])
        return
      }
      if (current.transition) {
        const { id, grab, frames, span } = current.transition
        finish()
        if (!current.started) selectTransition(id)
        else {
          // A centred one or one at a free edge takes its new length (it stays so aligned); one
          // trimmed or slid takes its new place: either is one command, one undo step.
          const found = findTransition(latest.current.film, id)
          if (!found) return
          if (grab && grab.alignment !== 'custom') {
            if (frames > 0 && frames !== grab.frames) void commitTransition(id, durationCommand(found.info, found.kind, frames))
          } else if (span) void commitTransition(id, spanCommand(found.info, span.start, span.duration))
        }
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
        if (last?.id === 'timeline.move' && last.params.copy) sendCopy(last)
        else if (last) send([last])
      }
      finish()
    },
    [bodyOf, commitTransition, finish, layoutNow, placeOf, selectTransition, send, sendCopy, store, timeOfX],
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
      localSelection.set({ transition: null, keyframe: null })
      // Empty track space: its own menu (paste, close the gap, select from here, add a track).
      if (hit.kind === 'empty') {
        setLaneMenu({ at: { x: event.clientX, y: event.clientY }, track: hit.track, seconds: tickAt(scene, layoutNow(), x) / scene.tps })
        return
      }
      const clip = hit.kind === 'clip' ? hit.clip : null
      if (clip != null && !scene.selection.includes(clip)) send([{ id: 'timeline.select', params: { clips: [clip] } }])
      setMenu({ at: { x: event.clientX, y: event.clientY }, clip })
    },
    [layoutNow, placeOf, selectTransition, send],
  )
  const closeMenu = useCallback(() => setMenu(null), [])
  const closeLaneMenu = useCallback(() => setLaneMenu(null), [])
  const closeTransitionMenu = useCallback(() => setTransitionMenu(null), [])
  const closeDurationDialog = useCallback(() => setDurationDialog(null), [])
  /** Clears transition `id` (its menu's Clear Transition): one undo step. */
  const clearTransition = useCallback((id: number) => {
    setTransitionMenu(null)
    localSelection.set({ transition: null })
    const found = findTransition(latest.current.film, id)
    if (found) void latest.current.invoke(removeCommand(found.info).id, removeCommand(found.info).params)
  }, [])

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
      const drop = dropEdge(clip, track.clips, t)
      const { edge, cut } = drop
      // On a cut between two clips the pointer picks the alignment: on the cut, centred; on the
      // outgoing clip, ending there; on the incoming one, starting there.
      const alignment = dropAlignment(drop, t, (DROP_CENTER_PX / layout.pps) * scene.tps)
      const span = transitionSpan(cut, defaultDuration(track.kind === 'video' ? transitionDurations.video : transitionDurations.audio, scene.frame, scene.tps), alignment, scene.frame)
      const left = xOf(scene, layout, span.start)
      return {
        // `effects.apply` takes no edge: the transition commands place it on the clip's edge the pointer is nearer.
        commands: [{ id: track.kind === 'video' ? 'sequence.applyVideoTransition' : 'sequence.applyAudioTransition', params: drop.alignment === 'center' ? { effect: payload.effect, clip: clip.id, edge, align: alignment } : { effect: payload.effect, clip: clip.id, edge } }],
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
      // Files from the computer: where the first one will land, on the row under the pointer.
      if (scene && film && !previewing && latest.current.dropFiles && carriesFiles(event.dataTransfer) && !event.dataTransfer.types.includes(FILM_DRAG_TYPE)) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        const { x, y } = placeOf(event)
        const layout = layoutNow()
        const row = x >= 0 && x <= layout.width ? dropRow(layout, y, { item: 0 }) : null
        const snapped = snapAt(scene, layout, x)
        dragView.set({ drop: row ? { x: xOf(scene, layout, snapped.time), width: 3, top: row.top, height: row.height, insert: modsOf(event).command } : null, snapX: row ? snapped.x : null })
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
      const placeFiles = latest.current.dropFiles
      if (scene && placeFiles && carriesFiles(event.dataTransfer) && !event.dataTransfer.types.includes(FILM_DRAG_TYPE)) {
        event.preventDefault()
        dragView.set({ drop: null, snapX: null })
        const { x, y } = placeOf(event)
        // The drop's track and time, as a project item's drop would have them.
        const template = placeCommand(scene, layoutNow(), x, y, { item: 0 }, modsOf(event))
        const files = Array.from(event.dataTransfer.files)
        if (!template || !files.length) return
        const generation = epoch.current
        void (async () => {
          const imported = await placeFiles(files)
          let time = template.params.time as number
          // Each new item where the one before it ends: one Place Clip each, in the order dropped.
          for (const item of imported) {
            if (epoch.current !== generation) return
            const placed = answerOf(await latest.current.invoke('timeline.place', { ...template.params, item, time }).catch(() => null))
            const clip = (placed?.clips as number[] | undefined)?.[0]
            const end = clip != null ? clipEnd(await latest.current.query?.('sequence.inspect').catch(() => null), clip) : null
            if (end == null) return
            time = end
          }
        })()
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
  return { dragView, handlers, menu, closeMenu, laneMenu, closeLaneMenu, scene, transitionMenu, closeTransitionMenu, durationDialog, openDurationDialog: setDurationDialog, closeDurationDialog, clearTransition }
}
