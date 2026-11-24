import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { TesseraIcons } from '@kition/sdk/editor'
import { MenuButton, MenuItem, MenuSeparator, TimecodeField, isMac, useUi, type Phrases } from '@kition/sdk/editor'
import { projectItems, type FilmClip, type FilmInfo, type FilmProjectItem, type FilmTrack } from '../film'
import type { FilmLabels, FilmSessionState } from '../session/useFilmSession'
import { useProgramTime, type Playback } from '../session/playback'
import type { Scrub } from '../session/scrub'
import { ClipView } from './ClipView'
import { TrackHeader } from './TrackHeader'
import { Ruler, useDevicePixelRatio, type RenderSpan } from './Ruler'
import {
  DIVIDER_H,
  DRAG_MAX_TRACK_H,
  DRAG_MIN_TRACK_H,
  MASTER_H,
  RIGHT_GUTTER,
  RULER_H,
  SCROLLBAR_H,
  TOP_H,
  clampPps,
  DEFAULT_VIEW,
  clampSplit,
  fitTrackHeight,
  headerWidthFor,
  maxScroll,
  scrollHalf,
  throughEdits,
  timeAt,
  trackRows,
  xOf,
  wheelZoomFactor,
  zoomAt,
  zoomThumb,
  type TimelineView,
} from './layout'
import type { TimelineMedia } from './media'
import { useTimelineView, type TimelineViewStore } from './view'
import { editPointMarks, emptyDropCommand, type Row as GestureRow } from './gestures'
import { FILM_DRAG_TYPE, endFilmDrag, filmDrag } from './drop'
import { useDragView, type DragViewStore } from './dragView'
import { ClipMenu } from './ClipMenu'
import { useGestures, type GestureGeometry, type StillDuration, type TransitionDurations } from './useGestures'
import { TransitionMenu, TransitionDurationDialog } from './TransitionControls'
import { localSelection, useLocalSelection } from '../session/localSelection'
import { PreviewGhosts } from './PreviewGhosts'
import { fadeAt } from './fades'
import { LaneMenu, RulerMenu } from './TimelineMenus'
import { rulerTicks } from './menusAt'
import type { Thumbnails } from './thumbnails'
import { PreviewContext, previewCacheKey, useDrawsPreview, usePreviewFilm, usePreviewState } from '../dialogs/usePreview'
import { highlightsOnly, previewClickable, previewOnlyItems, previewPictureItems, previewTimeline, type TimelinePreview } from '../dialogs/previewViews'
import type { PreviewCovers } from '../dialogs/preview'
import type { PreviewKind } from '../dialogs/registry'

const Bookmark = TesseraIcons.BookmarkIcon
const Link = TesseraIcons.LinkIcon
const Magnet = TesseraIcons.MagnetIcon
const SquareStack = TesseraIcons.SquareStackIcon
const Wrench = TesseraIcons.WrenchIcon
const X = TesseraIcons.XIcon

/** The preview kinds the Timeline draws. */
const TIMELINE_KINDS: ReadonlySet<PreviewKind> = new Set(['timeline', 'markers', 'selection'])
const NO_KINDS: readonly PreviewKind[] = []
const NO_ITEMS: ReadonlySet<number> = new Set()

/** The waveform's drawn window moves in steps of this many points. */
const WAVE_STEP = 64

/** Upstream `draw_transition`'s crossing fade curves for an audio transition, 16 segments each, in a 16 × 16 box. */
const fade = (curve: (angle: number) => number) => Array.from({ length: 17 }, (_, index) => `${index},${16 * (1 - curve((index / 16) * (Math.PI / 2)))}`).join(' ')
const FADE_OUT = fade(Math.cos)
const FADE_IN = fade(Math.sin)

/** Settings ▸ Timeline and ▸ Trim, as the panel reads them. */
type Prefs = { autoScroll: string; mouseScrolling: string; still: StillDuration; rollRipple: boolean; transitions: TransitionDurations }
const DEFAULT_PREFS: Prefs = { autoScroll: 'pageScroll', mouseScrolling: 'vertical', still: { amount: 5, unit: 'seconds' }, rollRipple: false, transitions: { video: { duration: 30, unit: 'frames' }, audio: { duration: 1, unit: 'seconds' } } }

/** Transition names by effect id, and which effects are audio transitions (the engine's `effects.list`). */
type Transitions = { names: Record<string, string>; audio: ReadonlySet<string> }

export type TimelinePanelProps = {
  film: FilmInfo | null
  session: FilmSessionState | null
  labels: FilmLabels | null
  /** The engine's revision, which keys a sequence item's thumbnails and peaks. */
  revision: number | null
  playback: Playback
  playing: boolean
  store: TimelineViewStore
  media: TimelineMedia
  tool: string
  /** `invoke`: every command the panel runs. */
  invoke: (id: string, params?: Record<string, unknown>) => Promise<unknown>
  /** A read-only engine query, answered as parsed JSON. */
  query: (id: string, params?: Record<string, unknown>) => Promise<unknown>
  /** Scrubs the program playhead (quietly, not an edit): the ruler and the timecode drive it. */
  scrub: Scrub
  phrase: Phrases
  t: (key: string, values?: Record<string, string | number>) => string
  /** The open document: another one drops a gesture in progress. */
  doc: unknown
}

/** The source patching and targeting of the active sequence (`Session::targeting`: V1 and A1 patched and every track targeted until changed). */
function targetingOf(film: FilmInfo, session: FilmSessionState | null) {
  const raw = film.activeSequence != null ? (session?.targeting[String(film.activeSequence)] as { targeted?: number[]; video_dest?: number | null; audio_dest?: number | null } | undefined) : undefined
  const video = film.tracks.filter((track) => track.kind === 'video')
  const audio = film.tracks.filter((track) => track.kind === 'audio')
  if (!raw) return { targeted: new Set(film.tracks.map((track) => track.id)), videoDest: video.at(-1)?.id ?? null, audioDest: audio[0]?.id ?? null }
  return { targeted: new Set(raw.targeted ?? []), videoDest: raw.video_dest ?? null, audioDest: raw.audio_dest ?? null }
}

/** A toolbar button the host may hide or disable (upstream's 28 px toggles, "on" filled). */
function ToolbarButton({ id, label, on, onPress, children, testId }: { id: string; label: string; on?: boolean; onPress?: () => void; children: ReactNode; testId: string }) {
  const state = useUi().state(id)
  if (state.hidden) return null
  return (
    <button type="button" className="film-tl-toggle" title={label} aria-label={label} aria-pressed={on} disabled={state.disabled} tabIndex={0} onClick={onPress} data-kit-ui-id={id} data-testid={testId}>
      {children}
    </button>
  )
}

/** The playhead timecode (upstream's accent timecode): the program clock while playing; typing or dragging seeks. */
function PlayheadTimecode({ film, playback, onSeek, phrase }: { film: FilmInfo; playback: Playback; onSeek: (seconds: number, final: boolean) => void; phrase: Phrases }) {
  const seconds = useProgramTime(playback, film.playhead)
  return <TimecodeField value={seconds} fps={film.fps} dropFrame={film.dropFrame} accent label={phrase('Timecode')} uiId="control:timeline.timecode" testId="film-timeline-timecode" onChange={onSeek} />
}

/**
 * The playhead over the ruler and the tracks. It moves outside React: the program clock and the
 * view store set its transform directly, so playback redraws nothing else. While playing it pages
 * the view along (Settings ▸ Timeline ▸ Timeline Playback Auto-Scrolling, page scroll by default).
 */
function Playhead({ film, playback, store, width, autoScroll, onScrub, phrase }: { film: FilmInfo; playback: Playback; store: TimelineViewStore; width: number; autoScroll: string; onScrub: (seconds: number, phase: 'start' | 'move' | 'end') => void; phrase: Phrases }) {
  const element = useRef<HTMLDivElement>(null)
  // The line through the tracks is grabbed and dragged like the ruler (upstream's playhead line): the same scrub.
  const grabbed = useRef<number | null>(null)
  const timeOfPointer = (event: { clientX: number }) => {
    const area = element.current?.parentElement?.getBoundingClientRect()
    return Math.max(0, timeAt(store.get(), event.clientX - (area?.left ?? 0)))
  }
  const resting = useRef(film.playhead)
  resting.current = film.playhead
  const latest = useRef({ width, autoScroll })
  latest.current = { width, autoScroll }
  // Where the clock stopped, kept until the engine's playhead arrives, so the line does not flash back.
  const held = useRef<{ resting: number; at: number } | null>(null)
  const place = useCallback(() => {
    const target = element.current
    if (!target) return
    const playing = playback.programTime()
    // A scrub's position too, ahead of the engine's (it is held the same way once the scrub ends).
    const ahead = playing ?? playback.programScrub()
    let seconds = resting.current
    if (ahead != null) {
      held.current = { resting: resting.current, at: ahead }
      seconds = ahead
    } else if (held.current && held.current.resting === resting.current) seconds = held.current.at
    else {
      held.current = null
      seconds = playback.restingProgram(resting.current)
    }
    const view = store.get()
    const { width: shown, autoScroll: mode } = latest.current
    if (playing != null && view.follow && mode !== 'noScroll' && shown > 0) {
      const x = (seconds - view.scroll) * view.pps
      if (mode === 'smoothScroll' ? x > shown * 0.5 || x < 0 : x > shown * 0.95 || x < 0) {
        const scroll = Math.max(0, seconds - (mode === 'smoothScroll' ? shown * 0.5 : shown * 0.05) / view.pps)
        store.set({ scroll, targetScroll: scroll })
        return
      }
    }
    const x = xOf(view, seconds)
    target.style.transform = `translateX(${x}px)`
    target.style.visibility = x >= -1 && x <= shown + 1 ? 'visible' : 'hidden'
  }, [playback, store])
  useLayoutEffect(place)
  useEffect(() => {
    const stopClock = playback.subscribeProgramTime(place)
    const stopView = store.subscribe(place)
    return () => {
      stopClock()
      stopView()
    }
  }, [playback, store, place])
  return (
    <div ref={element} className="film-tl-playhead" data-testid="film-playhead">
      <span className="film-tl-playhead-head" />
      <span className="film-tl-playhead-line" />
      <span
        className="film-tl-playhead-grip"
        title={phrase('Playhead')}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.stopPropagation()
          event.currentTarget.setPointerCapture(event.pointerId)
          grabbed.current = event.pointerId
          element.current?.setAttribute('data-dragging', '')
          onScrub(timeOfPointer(event), 'start')
        }}
        onPointerMove={(event) => {
          if (grabbed.current !== event.pointerId) return
          event.stopPropagation()
          onScrub(timeOfPointer(event), 'move')
        }}
        onPointerUp={(event) => {
          if (grabbed.current !== event.pointerId) return
          event.stopPropagation()
          grabbed.current = null
          element.current?.removeAttribute('data-dragging')
          onScrub(timeOfPointer(event), 'end')
        }}
        onPointerCancel={(event) => {
          if (grabbed.current !== event.pointerId) return
          grabbed.current = null
          element.current?.removeAttribute('data-dragging')
          onScrub(timeOfPointer(event), 'end')
        }}
        data-kit-ui-id="control:timeline.playhead"
        data-testid="film-playhead-line"
      />
    </div>
  )
}

/** A vertical scroll bar of one half (upstream `vertical_scrollbar`; the video half's is inverted: its bottom shows V1). */
function VerticalBar({ top, height, value, max, invert, onValue }: { top: number; height: number; value: number; max: number; invert: boolean; onValue: (value: number) => void }) {
  const drag = useRef<number | null>(null)
  if (max <= 0.5 || height < 20) return null
  const thumb = Math.max(18, height * (height / (height + max)))
  const at = invert ? 1 - value / max : value / max
  return (
    <div
      className="film-tl-vbar"
      style={{ top, height }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = event.clientY
      }}
      onPointerMove={(event) => {
        if (drag.current == null) return
        const delta = ((event.clientY - drag.current) / Math.max(1, height - thumb)) * max
        drag.current = event.clientY
        onValue(Math.min(max, Math.max(0, value + (invert ? -delta : delta))))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
    >
      <span style={{ top: (height - thumb) * at, height: thumb }} />
    </div>
  )
}

/** The zoom scroll bar (upstream `zoom_scrollbar`): drag the thumb to scroll, its handles to zoom, press beside it to jump. */
function ZoomBar({ view, store, width, duration, testId }: { view: TimelineView; store: TimelineViewStore; width: number; duration: number; testId: string }) {
  const thumb = zoomThumb(width, duration, view.scroll, view.pps)
  const drag = useRef<{ grab: number; start: number; mode: 0 | 1 | 2; last: number } | null>(null)
  const state = useUi().state('control:timeline.zoomBar')
  if (state.hidden || width <= 0) return null
  const jump = (x: number) => {
    if (thumb.perPoint <= 0) return
    const scroll = Math.min(thumb.range, Math.max(0, (x - thumb.width / 2) * thumb.perPoint))
    store.set({ scroll, targetScroll: scroll })
  }
  return (
    <div
      className="film-tl-zoombar"
      style={{ width }}
      onPointerDown={(event) => {
        if (event.button !== 0 || state.disabled) return
        event.currentTarget.setPointerCapture(event.pointerId)
        const x = event.clientX - event.currentTarget.getBoundingClientRect().left
        let mode: 0 | 1 | 2 = 0
        if (x < thumb.left || x > thumb.left + thumb.width) jump(x)
        else if (Math.abs(x - thumb.left) < 9) mode = 1
        else if (Math.abs(x - thumb.left - thumb.width) < 9) mode = 2
        drag.current = { grab: x, start: store.get().targetScroll, mode, last: x }
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        const x = event.clientX - event.currentTarget.getBoundingClientRect().left
        const v = store.get()
        if (current.mode === 0) {
          const scroll = Math.min(thumb.range, Math.max(0, current.start + (x - current.grab) * thumb.perPoint))
          store.set({ scroll, targetScroll: scroll })
        } else {
          const visible = width / v.pps
          const dx = ((x - current.last) / Math.max(1, width)) * thumb.total
          if (current.mode === 1) {
            const end = v.scroll + visible
            const scroll = Math.min(Math.max(0, end - 0.05), Math.max(0, v.scroll + dx))
            const pps = clampPps(width / Math.max(0.05, end - scroll))
            store.set({ pps, targetPps: pps, scroll, targetScroll: scroll })
          } else {
            const end = Math.max(v.scroll + 0.05, v.scroll + visible + dx)
            const pps = clampPps(width / (end - v.scroll))
            store.set({ pps, targetPps: pps })
          }
        }
        current.last = x
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      data-kit-ui-id="control:timeline.zoomBar"
      data-testid={testId}
    >
      <span className="film-tl-zoombar-thumb" style={{ left: thumb.left, width: thumb.width }}>
        <span data-end="start" />
        <span data-end="end" />
      </span>
    </div>
  )
}

type HalfProps = {
  kind: 'video' | 'audio'
  tracks: FilmTrack[]
  rows: Array<{ index: number; top: number; height: number }>
  top: number
  height: number
  headerWidth: number
  contentWidth: number
  view: TimelineView
  film: FilmInfo
  session: FilmSessionState | null
  colors: Record<string, string>
  items: Map<number, FilmProjectItem>
  revision: number | null
  targeting: ReturnType<typeof targetingOf>
  transitions: Transitions
  media: TimelineMedia
  dpr: number
  /** A drag's live preview (the clips it moves or resizes), outside the engine. */
  dragView: DragViewStore
  /** Every clip by id, for one a drag carries onto another track. */
  clipsById: ReadonlyMap<number, FilmClip>
  /** The selected edit points' brackets, by track (ticks). */
  editMarks: ReadonlyMap<number, ReturnType<typeof editPointMarks>>
  run: (command: string, params: Record<string, unknown>) => void
  onResize: (kind: FilmTrack['kind'], delta: number) => void
  onToggleHeight: (kind: FilmTrack['kind']) => void
  phrase: Phrases
  /** A dialog's preview drawn over the tracks (Task 10), or null. */
  preview: TimelinePreview | null
  /** A dialog's preview is open: the headers' toggles take no press. */
  previewing: boolean
  /** The open preview's pictures, and the items that read them. */
  pictures: Thumbnails<HTMLCanvasElement> | undefined
  pictureItems: ReadonlySet<number>
  /** Items only the preview has. */
  previewOnly: ReadonlySet<number>
}

/** One half of the track area: its headers and lanes, clipped to it, the clips in view drawn on each lane's scrolling layer. */
function TrackHalf({ kind, tracks, rows, top, height, headerWidth, contentWidth, view, film, session, colors, items, revision, targeting, transitions, media, dpr, dragView, clipsById, editMarks, run, onResize, onToggleHeight, phrase, preview, previewing, pictures, pictureItems, previewOnly }: HalfProps) {
  const previews = useDragView(dragView, (shown) => shown.previews)
  const resized = useDragView(dragView, (shown) => shown.transition)
  const chosenTransition = useLocalSelection((selection) => selection.transition)
  const chosenKey = useLocalSelection((selection) => selection.keyframe)
  const volumeShown = useDragView(dragView, (shown) => shown.volume)
  const fadeShown = useDragView(dragView, (shown) => shown.fade)
  const fadeLabels = useMemo(() => ({ in: phrase('Fade In'), out: phrase('Fade Out') }), [phrase])
  if (height <= 0) return null
  const tps = film.ticksPerSecond
  const visibleFrom = timeAt(view, -2)
  const visibleTo = timeAt(view, contentWidth + 2)
  const shift = -view.scroll * view.pps
  const inOut = film.in != null || film.out != null ? { from: film.in ?? 0, to: film.out != null ? film.out + film.frame : film.duration } : null
  const animating = view.pps !== view.targetPps
  // A clip's fade handles, at its free ends (none while a drag or a preview shows it, or on a locked track).
  const fadeProps = (track: FilmTrack, id: number, none: boolean) => {
    if (none) return { fadeIn: null, fadeOut: null }
    const of = (edge: 'in' | 'out') => {
      const fade = fadeAt(track, id, edge, film.frame)
      return fade ? fade.duration * view.pps : null
    }
    return { fadeIn: of('in'), fadeOut: of('out') }
  }
  const thumbnailWidth = Math.round(160 * dpr)
  return (
    <div className="film-tl-half" data-kind={kind} style={{ top, height }} data-testid={`film-timeline-${kind}`}>
      {/* Top to bottom, so Tab moves through the headers as they are drawn (V2 above V1). */}
      {(kind === 'video' ? [...tracks.keys()].reverse() : [...tracks.keys()]).map((index) => {
        const track = tracks[index]
        const row = rows[index]
        if (!row || row.top + row.height <= 0 || row.top >= height) return null
        const patched = kind === 'video' ? targeting.videoDest === track.id : targeting.audioDest === track.id
        const through = session?.showThroughEdits ? throughEdits(track.clips, film.frame) : []
        const trackMark = preview?.tracks.get(track.id)
        return (
          <div key={track.id}>
            <TrackHeader
              track={track}
              index={row.index}
              top={row.top}
              height={row.height}
              width={headerWidth}
              patched={patched}
              targeted={targeting.targeted.has(track.id)}
              run={run}
              onResize={onResize}
              onToggleHeight={onToggleHeight}
              phrase={phrase}
              previewing={previewing}
            />
            <div className="film-tl-lane" data-alt={row.index % 2 === 1 || undefined} style={{ top: row.top, height: row.height, left: headerWidth, width: contentWidth }} data-testid={`film-track-${track.name}`}>
              {inOut ? <span className="film-tl-inout" style={{ left: Math.max(0, xOf(view, inOut.from)), width: Math.max(0, Math.min(contentWidth, xOf(view, inOut.to)) - Math.max(0, xOf(view, inOut.from))) }} /> : null}
              <div className="film-tl-layer" style={{ transform: `translateX(${shift}px)` }}>
                {/* Under the clips: a moved clip covers its old place where they overlap. */}
                <PreviewGhosts ghosts={preview?.ghosts.get(track.id)} pps={view.pps} rowHeight={row.height} from={visibleFrom} to={visibleTo} colors={colors} />
                {[
                  ...track.clips.map((clip) => ({ clip, shown: previews.get(clip.id) })),
                  // Clips a move carries here from another track (upstream draws them selected).
                  ...[...previews].flatMap(([id, shown]) => {
                    const carried = shown.track === track.id ? clipsById.get(id) : undefined
                    return carried && !track.clips.includes(carried) ? [{ clip: carried, shown }] : []
                  }),
                ].map(({ clip, shown }) => {
                  if (shown?.track != null && shown.track !== track.id) return null
                  const start = shown ? shown.start / tps : clip.start
                  const duration = shown ? shown.duration / tps : clip.duration
                  if (!shown && (start + duration < visibleFrom || start > visibleTo)) return null
                  const item = items.get(clip.item)
                  const sequenceItem = item?.type === 'Sequence'
                  const inRange = inOut != null && start < inOut.to && start + duration > inOut.from
                  const clipX = xOf(view, start)
                  const ownPictures = pictures && pictureItems.has(clip.item) ? pictures : undefined
                  // The waveform's window moves in 64 px steps, so scrolling redraws a waveform only every 64 px.
                  const from = Math.floor(-clipX / WAVE_STEP) * WAVE_STEP - WAVE_STEP
                  const to = Math.ceil((contentWidth - clipX) / WAVE_STEP) * WAVE_STEP + WAVE_STEP
                  return (
                    <ClipView
                      key={clip.id}
                      clip={clip}
                      kind={kind}
                      track={track.id}
                      pps={view.pps}
                      fps={film.fps}
                      rowHeight={row.height}
                      color={colors[clip.label.toLowerCase()] ?? '#5645d4'}
                      inRange={inRange}
                      noHead={clip.sourceIn <= 0}
                      noTail={item != null && item.duration > 0 && clip.sourceOut >= item.duration - film.frame}
                      thumbnail={kind === 'video' && view.showThumbnails}
                      thumbnailWidth={thumbnailWidth}
                      waveform={kind === 'audio' && view.showWaveforms}
                      dynamicWaveform={view.dynamicWaveforms}
                      revision={sequenceItem ? revision : null}
                      stamp={item?.stamp ?? null}
                      from={kind === 'audio' ? from : 0}
                      to={kind === 'audio' ? to : 0}
                      animating={animating}
                      dpr={dpr}
                      start={start}
                      duration={duration}
                      carried={shown?.track === track.id && !track.clips.includes(clip)}
                      media={media}
                      preview={preview?.clips.get(clip.id) as 'added' | 'changed' | undefined}
                      previewSelected={preview?.selected?.has(clip.id)}
                      pictures={ownPictures}
                      noPeaks={previewOnly.has(clip.item)}
                      volume={volumeShown?.clip === clip.id ? volumeShown : null}
                      selectedKey={chosenKey?.clip === clip.id ? chosenKey.mediaTime : null}
                      {...fadeProps(track, clip.id, shown != null || previewing || track.locked)}
                      fadeActive={fadeShown?.clip === clip.id ? fadeShown.edge : null}
                      fadeLabels={fadeLabels}
                    />
                  )
                })}
                {track.transitions.map((transition) => {
                  // A transition whose end is being dragged is drawn where the drag has it.
                  const span = resized?.id === transition.id ? { start: resized.start / tps, duration: resized.duration / tps } : transition
                  const left = span.start * view.pps
                  const width = span.duration * view.pps
                  const name = phrase(transitions.names[transition.effect] ?? transition.effect)
                  const selected = chosenTransition === transition.id
                  // Audio by the effect's kind (upstream `EffectKind::AudioTransition`): crossing fade curves, no name.
                  const audio = transitions.audio.has(transition.effect)
                  return (
                    <span key={transition.id} className="film-tl-transition" style={{ transform: `translateX(${left}px)`, width, height: Math.max(0, row.height - 18) }} title={name} data-audio={audio || undefined} data-selected={selected || undefined} aria-selected={selected} data-kit-ui-id="control:timeline.transition" data-testid={`film-transition-${transition.id}`}>
                      {audio ? (
                        <svg className="film-tl-fades" viewBox="0 0 16 16" preserveAspectRatio="none" aria-hidden="true">
                          <polyline points={FADE_OUT} vectorEffect="non-scaling-stroke" />
                          <polyline points={FADE_IN} vectorEffect="non-scaling-stroke" />
                        </svg>
                      ) : width > 34 ? (
                        <span>{name}</span>
                      ) : null}
                    </span>
                  )
                })}
                {(editMarks.get(track.id) ?? []).map((mark) => (
                  <span
                    key={`${mark.clip}:${mark.out}`}
                    className="film-tl-bracket"
                    data-selected
                    data-out={mark.out || undefined}
                    data-ripple={mark.ripple || undefined}
                    style={{ transform: `translateX(${(mark.time / tps) * view.pps - (mark.out ? 6 : 0)}px)`, top: 2, height: Math.max(0, row.height - 4) }}
                    data-testid="film-edit-point"
                  />
                ))}
                {through.map((edit) => (
                  <span key={edit.right} className="film-tl-through" style={{ transform: `translateX(${edit.time * view.pps}px)`, height: row.height }} title={phrase('Through edit')} data-kit-ui-id="control:timeline.throughEdit" />
                ))}
              </div>
            </div>
            {trackMark ? <span className="film-tl-track-mark" data-preview={trackMark} style={{ top: row.top, height: row.height, width: headerWidth + contentWidth }} data-testid={`film-preview-track-${track.id}`} /> : null}
          </div>
        )
      })}
    </div>
  )
}

/** Upstream's empty Timeline (`empty_state`): a project item dropped here makes a sequence from it; or open a sequence from the Project panel. */
function EmptyTimeline({ film, invoke, phrase }: { film: FilmInfo | null; invoke: (id: string, params?: Record<string, unknown>) => Promise<unknown>; phrase: Phrases }) {
  const sequences = film?.root ? [...projectItems(film.root).values()].some((item) => item.type === 'Sequence') : false
  return (
    <div
      className="film-tl-empty"
      data-testid="film-timeline-empty"
      onDragOver={(event) => {
        if (!film || !event.dataTransfer.types.includes(FILM_DRAG_TYPE)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        const payload = filmDrag(event.dataTransfer)
        if (!film || !payload) return
        event.preventDefault()
        endFilmDrag()
        const command = emptyDropCommand(payload)
        void invoke(command.id, command.params)
      }}
    >
      <p>{phrase('Drop media here to create sequence.')}</p>
      {sequences ? <p>{phrase('Double-click a sequence in the Project panel to open it here.')}</p> : null}
    </div>
  )
}

/**
 * The Timeline panel (upstream `panels/timeline.rs` `show`): the playhead timecode and toggles,
 * the ruler, the video tracks stacking up and the audio tracks down with their headers, the Mix
 * row, and the zoom bar. Tracks are DOM drawn only where in view, each lane's clips on a layer that
 * scrolls by a transform; thumbnails and waveforms are canvases fed through one queue on the
 * engine worker while nothing plays. Every press on the tracks goes through the tools' gestures
 * (`useGestures`, upstream `interact`): one engine command per gesture, its drag drawn locally.
 */
export function TimelinePanel(props: TimelinePanelProps) {
  const { film: documentFilm, session, labels, revision, playback, store, media, tool, invoke, query, scrub: scrubber, phrase, t, doc } = props
  const view = useTimelineView(store)
  // A dialog's preview (Task 10): the Timeline draws its timeline, markers, and selection kinds
  // while it shows a sequence (the strip lists them otherwise), laid out from the preview's
  // inspect() with this panel's own layout code, the diff marked on it.
  const previewState = usePreviewState()
  const previewContext = useContext(PreviewContext)
  const documentShows = documentFilm != null && documentFilm.activeSequence != null && documentFilm.tracks.length > 0
  const previewKinds = previewState.open ? previewState.kinds : NO_KINDS
  // A preview that only highlights (Find) draws the document with its highlight: no copy to read.
  const highlightOnly = highlightsOnly(previewKinds, previewState.highlight)
  const loaded = usePreviewFilm(documentShows && !highlightOnly && previewKinds.some((kind) => TIMELINE_KINDS.has(kind)))
  const highlight = highlightOnly ? previewState.highlight : null
  const preview = useMemo(() => {
    if (!documentFilm) return null
    if (highlight) return previewTimeline(documentFilm, documentFilm, null, ['selection'], { highlight })
    return loaded ? previewTimeline(documentFilm, loaded.film, loaded.diff, loaded.kinds, { copies: loaded.copies, highlight: loaded.highlight }) : null
  }, [loaded, documentFilm, highlight])
  const film = preview?.film ?? documentFilm
  // What it draws: the shown sequence's tracks and clips (the strip lists those of other sequences
  // and the captions, which Task 36 draws), that sequence's own markers, and its clip selection.
  const shownSequence = preview?.sequence ?? documentFilm?.activeSequence ?? null
  const coversTimeline = useCallback<PreviewCovers>((part, entry) => (part === 'sequences' ? entry.id === shownSequence : entry.sequence === shownSequence), [shownSequence])
  const coversMarkers = useCallback<PreviewCovers>((_, entry) => entry.ownerKind === 'sequence' && entry.owner === shownSequence, [shownSequence])
  const root = useRef<HTMLDivElement>(null)
  useDrawsPreview('timeline', documentShows, coversTimeline, shownSequence, root)
  useDrawsPreview('markers', documentShows, coversMarkers, shownSequence, root)
  useDrawsPreview('selection:timeline', documentShows, undefined, undefined, root)
  const pictureKey = previewCacheKey(previewState)
  const pictures = useMemo(() => (pictureKey && previewContext ? media.previewThumbnails(pictureKey, { engine: previewContext.preview.engine, current: () => previewCacheKey(previewContext.preview.get()) }) : undefined), [pictureKey, previewContext, media])
  const pictureItems = useMemo(() => previewPictureItems(loaded?.diff ?? null), [loaded])
  // While any preview is open, the tracks take only selection clicks on the document's clips.
  const documentClips = useMemo(() => (previewState.open && documentFilm ? previewClickable(documentFilm, preview) : null), [previewState.open, documentFilm, preview])
  // Items only the preview has draw no waveform (the document has no peaks of theirs).
  const previewOnly = useMemo(() => (loaded && documentFilm ? previewOnlyItems(documentFilm, loaded.film) : NO_ITEMS), [loaded, documentFilm])
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return undefined
    const measure = () => setSize((current) => (current.width === element.clientWidth && current.height === element.clientHeight ? current : { width: element.clientWidth, height: element.clientHeight }))
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [film == null])

  const items = useMemo(() => projectItems(film?.root ?? null), [film?.root])
  const colors = useMemo(() => Object.fromEntries(Object.entries(labels?.colors ?? {}).map(([key, value]) => [key, value.color])), [labels])
  const headerWidth = headerWidthFor(view.headerWidth, size.width)
  const contentWidth = Math.max(0, size.width - headerWidth - RIGHT_GUTTER)
  const duration = film?.duration ?? 0
  const hasSequence = film != null && film.activeSequence != null && film.tracks.length > 0

  useLayoutEffect(() => {
    store.setGeometry(contentWidth, duration)
  }, [store, contentWidth, duration])
  useEffect(() => {
    if (documentFilm) store.showSequence(documentFilm.activeSequence, doc)
  }, [store, documentFilm?.activeSequence, doc])

  // The ruler's render bar and the Mix level, read per engine revision through the media queue.
  const [renderBar, setRenderBar] = useState<RenderSpan[]>([])
  const [mixDb, setMixDb] = useState(0)
  useEffect(() => {
    if (!hasSequence || revision == null) return undefined
    const stopBar = media.read(`renderBar@${revision}`, async () => {
      const answer = (await query('sequence.renderBar')) as { segments?: Array<{ startSeconds?: number; endSeconds?: number; state?: string }> } | null
      setRenderBar((answer?.segments ?? []).filter((segment) => segment.state === 'yellow' || segment.state === 'red' || segment.state === 'green').map((segment) => ({ start: segment.startSeconds ?? 0, end: segment.endSeconds ?? 0, state: segment.state as RenderSpan['state'] })))
    })
    const stopMix = media.read(`mix@${revision}`, async () => {
      const answer = (await query('mixer.inspect')) as { strips?: Array<{ kind?: string; volumeDb?: number }> } | null
      setMixDb(answer?.strips?.find((strip) => strip.kind === 'mix')?.volumeDb ?? 0)
    })
    return () => {
      stopBar()
      stopMix()
    }
  }, [media, query, revision, hasSequence])
  // The transitions' names (the engine's effect list), and Settings ▸ Timeline, read once and after a preference changes.
  const [transitions, setTransitions] = useState<Transitions>({ names: {}, audio: new Set() })
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  useEffect(() => {
    if (!hasSequence) return undefined
    const stopNames = media.read('transitions', async () => {
      const names: Record<string, string> = {}
      const audio = new Set<string>()
      for (const kind of ['VideoTransition', 'AudioTransition']) {
        const list = (await query('effects.list', { kind })) as Array<{ id?: string; name?: string; kind?: string }> | { effects?: Array<{ id?: string; name?: string; kind?: string }> } | null
        for (const effect of Array.isArray(list) ? list : (list?.effects ?? [])) {
          if (!effect.id) continue
          if (effect.name) names[effect.id] = effect.name
          if (effect.kind === 'AudioTransition') audio.add(effect.id)
        }
      }
      setTransitions({ names, audio })
    })
    void Promise.all([query('prefs.get', { key: 'timeline' }), query('prefs.get', { key: 'trim' })])
      .then(([timeline, trim]) => {
        const value = timeline as { autoScroll?: string; mouseScrolling?: string; stillImageDuration?: number; stillImageUnit?: string; videoTransitionDuration?: number; videoTransitionUnit?: string; audioTransitionDuration?: number; audioTransitionUnit?: string } | null
        setPrefs({
          autoScroll: value?.autoScroll ?? DEFAULT_PREFS.autoScroll,
          mouseScrolling: value?.mouseScrolling ?? DEFAULT_PREFS.mouseScrolling,
          still: { amount: value?.stillImageDuration ?? DEFAULT_PREFS.still.amount, unit: value?.stillImageUnit ?? DEFAULT_PREFS.still.unit },
          rollRipple: (trim as { selectionToolRollRipple?: boolean } | null)?.selectionToolRollRipple ?? false,
          transitions: {
            video: { duration: value?.videoTransitionDuration ?? DEFAULT_PREFS.transitions.video.duration, unit: value?.videoTransitionUnit ?? DEFAULT_PREFS.transitions.video.unit },
            audio: { duration: value?.audioTransitionDuration ?? DEFAULT_PREFS.transitions.audio.duration, unit: value?.audioTransitionUnit ?? DEFAULT_PREFS.transitions.audio.unit },
          },
        })
      })
      .catch(() => undefined)
    return stopNames
  }, [media, query, labels, hasSequence])

  // The ruler and the timecode scrub the playhead (`session/scrub.ts`): the timecode moves at once, the pictures follow.
  const scrub = useCallback(
    (seconds: number, phase: 'start' | 'move' | 'end') => {
      if (phase === 'start') playback.stopProgram()
      scrubber[phase](seconds)
    },
    [playback, scrubber],
  )
  const typedSeek = useCallback(
    (seconds: number, final: boolean) => {
      playback.stopProgram()
      if (final) scrubber.end(seconds)
      else scrubber.move(seconds)
    },
    [playback, scrubber],
  )

  const run = useCallback((command: string, params: Record<string, unknown>) => void invoke(command, params), [invoke])
  // The ruler by hand: its In and Out marks dragged (one Mark In or Mark Out there), a marker double-clicked (its dialog), its menu.
  const fps = documentFilm?.fps ?? 30
  const tpsNow = documentFilm?.ticksPerSecond ?? 0
  const onMark = useCallback((which: 'in' | 'out', seconds: number) => void invoke(which === 'in' ? 'markers.markIn' : 'markers.markOut', { time: rulerTicks(seconds, fps, tpsNow) }), [invoke, fps, tpsNow])
  const onEditMarker = useCallback((marker: number) => void invoke('markers.edit', { marker }), [invoke])
  const [rulerMenu, setRulerMenu] = useState<{ at: { x: number; y: number }; seconds: number; marker: number | null } | null>(null)
  const onRulerMenu = useCallback((at: { x: number; y: number }, seconds: number, marker: number | null) => setRulerMenu({ at, seconds, marker }), [])
  const closeRulerMenu = useCallback(() => setRulerMenu(null), [])
  const onResize = useCallback(
    (kind: FilmTrack['kind'], delta: number) => {
      const key = kind === 'video' ? 'videoTrackHeight' : 'audioTrackHeight'
      store.set((current) => ({ ...current, [key]: Math.min(DRAG_MAX_TRACK_H, Math.max(DRAG_MIN_TRACK_H, current[key] + delta)) }))
    },
    [store],
  )
  const onToggleHeight = useCallback(
    (kind: FilmTrack['kind']) => {
      const key = kind === 'video' ? 'videoTrackHeight' : 'audioTrackHeight'
      store.set((current) => ({ ...current, [key]: current[key] < 50 ? 64 : 30 }))
    },
    [store],
  )

  const gestureGeometry = useRef<GestureGeometry>({ headerWidth, contentWidth, rows: [], maxVideo: 0 })
  const geometryOf = useCallback(() => gestureGeometry.current, [])
  const gestures = useGestures({ film, session, store, tool, invoke, rollRipple: prefs.rollRipple, still: prefs.still, transitionDurations: prefs.transitions, items, geometry: geometryOf, root, doc, previewClips: documentClips })
  const { scene } = gestures
  const editMarks = useMemo(() => {
    const byTrack = new Map<number, ReturnType<typeof editPointMarks>>()
    if (!scene || !session?.editPoints.length) return byTrack
    for (const mark of editPointMarks(scene, session.editPoints)) byTrack.set(mark.track, [...(byTrack.get(mark.track) ?? []), mark])
    return byTrack
  }, [scene, session])
  // A keyframe chosen on a Volume line is let go when the clip selection changes, so Delete then removes clips.
  const selectionKey = film?.selection.join() ?? ''
  useEffect(() => {
    localSelection.set({ keyframe: null })
  }, [selectionKey])
  const clipsById = useMemo(() => new Map((film?.tracks ?? []).flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const))), [film?.tracks])

  // The wheel, as upstream (Premiere on macOS): the tracks under the pointer up and down, Cmd
  // sideways, Option zoom about the pointer; a sideways gesture or Shift scrolls sideways, a pinch zooms.
  const geometry = useRef({ headerWidth, contentWidth, splitY: 0, duration, mouseScrolling: prefs.mouseScrolling, maxVideo: 0, maxAudio: 0 })
  useEffect(() => {
    const element = root.current
    if (!element) return undefined
    const onWheel = (event: WheelEvent) => {
      const { headerWidth: left, contentWidth: width, splitY, duration: seconds, mouseScrolling, maxVideo, maxAudio } = geometry.current
      const box = element.getBoundingClientRect()
      const x = event.clientX - box.left - left
      const y = event.clientY - box.top
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 400 : 1
      // egui's sign: positive moves the content right or down.
      const dx = -event.deltaX * unit
      const dy = -event.deltaY * unit
      const mac = isMac()
      const pinch = mac && event.ctrlKey && !event.metaKey
      const command = mac ? event.metaKey : event.ctrlKey
      event.preventDefault()
      const current = store.get()
      if (pinch || (event.altKey && dy !== 0)) {
        const factor = wheelZoomFactor(pinch, dy)
        const at = Math.max(0, Math.min(width, x))
        store.set(zoomAt(current, factor, timeAt(current, at), at))
        return
      }
      const sideways = Math.abs(dx) > Math.abs(dy) ? dx : (mouseScrolling === 'horizontal') !== command || event.shiftKey ? dy : null
      if (sideways != null) {
        const scroll = Math.min(maxScroll(seconds, width, current.pps), Math.max(0, current.targetScroll - sideways / current.pps))
        store.set({ scroll, targetScroll: scroll })
      } else if (y < splitY) store.set(scrollHalf(current, 'video', dy, maxVideo))
      else store.set(scrollHalf(current, 'audio', -dy, maxAudio))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [store, hasSequence])

  const divider = useRef<number | null>(null)
  const dpr = useDevicePixelRatio()
  // Upstream clamps the halves' scroll every frame: fewer or taller tracks, or a smaller frame, pull it back.
  const maxes = useRef({ video: 0, audio: 0 })
  useLayoutEffect(() => {
    const { video: maxVideo, audio: maxAudio } = maxes.current
    const current = store.get()
    if (current.vScroll > maxVideo || current.aScroll > maxAudio) store.set(scrollHalf(scrollHalf(current, 'video', 0, maxVideo), 'audio', 0, maxAudio))
  })

  // Tracks a preview adds (or, adding none, removes) are scrolled into view in each half, once per preview, so they are drawn.
  const reveal = useRef<Array<{ key: string; half: 'video' | 'audio'; delta: number; max: number }>>([])
  const revealed = useRef(new Set<string>())
  useLayoutEffect(() => {
    for (const want of reveal.current) {
      if (revealed.current.has(want.key)) continue
      revealed.current.add(want.key)
      if (want.delta) store.set(scrollHalf(store.get(), want.half, want.delta, want.max))
    }
    if (!previewState.open) revealed.current.clear()
  })

  // A newly shown sequence's tracks are fitted to the halves once their heights are known (`fitTrackHeight`).
  const fitInput = useRef<{ videoHeight: number; audioHeight: number; video: number; audio: number } | null>(null)
  useLayoutEffect(() => {
    const input = fitInput.current
    if (!input || !store.get().fitHeights) return
    store.set({ videoTrackHeight: fitTrackHeight(input.videoHeight, input.video, DEFAULT_VIEW.videoTrackHeight), audioTrackHeight: fitTrackHeight(input.audioHeight, input.audio, DEFAULT_VIEW.audioTrackHeight), fitHeights: false })
  })

  if (!film || !hasSequence) {
    fitInput.current = null
    return (
      <div ref={root} className="film-tl" data-testid="film-timeline">
        <EmptyTimeline film={film} invoke={invoke} phrase={phrase} />
      </div>
    )
  }

  const video = film.tracks.filter((track) => track.kind === 'video').reverse()
  const audio = film.tracks.filter((track) => track.kind === 'audio')
  const tracksTop = TOP_H
  const tracksHeight = Math.max(0, size.height - SCROLLBAR_H - tracksTop)
  const splitY = tracksTop + (tracksHeight - DIVIDER_H) * view.split
  const videoHeight = Math.max(0, splitY - tracksTop)
  const audioTop = splitY + DIVIDER_H
  const audioHeight = Math.max(0, tracksTop + tracksHeight - MASTER_H - audioTop)
  const rows = trackRows(view, { video: video.length, audio: audio.length, videoHeight, audioHeight })
  fitInput.current = size.height > 0 && tracksHeight > 0 && !preview ? { videoHeight, audioHeight, video: video.length, audio: audio.length } : null
  geometry.current = { headerWidth, contentWidth, splitY, duration, mouseScrolling: prefs.mouseScrolling, maxVideo: rows.maxVideoScroll, maxAudio: rows.maxAudioScroll }
  maxes.current = { video: rows.maxVideoScroll, audio: rows.maxAudioScroll }
  reveal.current = []
  if (preview && pictureKey) {
    for (const [half, list, placed, height, max] of [['video', video, rows.video, videoHeight, rows.maxVideoScroll], ['audio', audio, rows.audio, audioHeight, rows.maxAudioScroll]] as const) {
      // The first track it adds, else the first it removes (Delete Tracks' struck-through ones).
      const found = list.findIndex((track) => preview.tracks.get(track.id) === 'added')
      const index = found >= 0 ? found : list.findIndex((track) => preview.tracks.get(track.id) === 'removed')
      const row = placed[index]
      if (index < 0 || !row) continue
      const below = row.top + row.height - height
      // Video scrolls up as vScroll grows (its top track shows); audio down as aScroll grows.
      const delta = row.top < 0 ? (half === 'video' ? -row.top : row.top) : below > 0 ? (half === 'video' ? -below : below) : 0
      // Keyed on the serial the layout was drawn from (the preview's inspect() comes a little
      // after its serial is published): a reveal measured on the last serial's tracks is not
      // taken as this one's.
      reveal.current.push({ key: `${loaded?.document}:${loaded?.serial}:${list[index].id}`, half, delta, max })
    }
  }
  const targeting = targetingOf(film, session)
  // The rows the gestures hit, y from the panel's top: those of each half in view.
  const gestureRows: GestureRow[] = []
  for (const [list, placed, top, height] of [[video, rows.video, tracksTop, videoHeight], [audio, rows.audio, audioTop, audioHeight]] as const) {
    list.forEach((track, index) => {
      const row = placed[index]
      if (row && row.top + row.height > 0 && row.top < height) gestureRows.push({ track: track.id, kind: track.kind, index: row.index, top: top + row.top, height: row.height })
    })
  }
  gestureGeometry.current = { headerWidth, contentWidth, rows: gestureRows, maxVideo: rows.maxVideoScroll }
  const halfProps = { headerWidth, contentWidth, view, film, session, colors, items, revision, targeting, transitions, media, dpr, dragView: gestures.dragView, clipsById, editMarks, run, onResize, onToggleHeight, phrase, preview, previewing: previewState.open, pictures, pictureItems, previewOnly }
  const showThroughEdits = session?.showThroughEdits ?? false

  return (
    <div ref={root} className="film-tl" style={{ ['--film-tl-header' as string]: `${headerWidth}px` }} data-testid="film-timeline" {...gestures.handlers}>
      <div className="film-tl-top" style={{ height: TOP_H, width: headerWidth }}>
        <div className="film-tl-timecode">
          <PlayheadTimecode film={film} playback={playback} onSeek={typedSeek} phrase={phrase} />
        </div>
        <div className="film-tl-toolbar">
          <ToolbarButton id="control:timeline.toggle.nest" label={phrase('Insert and overwrite sequences as nests or individual clips')} on={!(session?.sequencesAsClips ?? false)} onPress={() => run('sequence.nestSequences', {})} testId="film-timeline-nest">
            <SquareStack size={14} aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton id="control:timeline.toggle.snap" label={phrase('Snap in Timeline (S)')} on={session?.snapping ?? true} onPress={() => run('sequence.snap', {})} testId="film-timeline-snap">
            <Magnet size={14} aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton id="control:timeline.toggle.linked" label={phrase('Linked Selection')} on={session?.linkedSelection ?? true} onPress={() => run('sequence.linkedSelection', {})} testId="film-timeline-linked">
            <Link size={14} aria-hidden="true" />
          </ToolbarButton>
          {/* Upstream's Caption track options is not drawn: it has no action (caption tracks are not built). */}
          <ToolbarButton id="control:timeline.toggle.marker" label={phrase('Add Marker (M)')} onPress={() => run('markers.add', {})} testId="film-timeline-marker">
            <Bookmark size={14} aria-hidden="true" />
          </ToolbarButton>
          <TimelineSettings view={view} store={store} showThroughEdits={showThroughEdits} run={run} phrase={phrase} />
        </div>
        {preview ? (
          <span className="film-preview-badge film-tl-preview-badge" data-testid="film-timeline-preview-badge">
            {phrase('Preview')}
          </span>
        ) : null}
      </div>
      <div className="film-tl-ruler-wrap" style={{ left: headerWidth, top: TOP_H - RULER_H, width: contentWidth }}>
        <Ruler film={film} pps={view.pps} scroll={view.scroll} width={contentWidth} renderBar={renderBar} phrase={phrase} onScrub={scrub} markerMarks={preview?.markers} markerSelected={preview?.selectedMarkers ?? undefined} onMark={preview ? undefined : onMark} onEditMarker={preview ? undefined : onEditMarker} onMenu={preview ? undefined : onRulerMenu} />
      </div>
      <TrackHalf kind="video" tracks={video} rows={rows.video} top={tracksTop} height={videoHeight} {...halfProps} />
      <div
        className="film-tl-divider"
        style={{ top: splitY, height: DIVIDER_H, right: RIGHT_GUTTER }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          divider.current = event.clientY
        }}
        onPointerMove={(event) => {
          if (divider.current == null) return
          const delta = event.clientY - divider.current
          divider.current = event.clientY
          store.set((current) => ({ ...current, split: clampSplit(current.split + delta / Math.max(1, tracksHeight - DIVIDER_H)) }))
        }}
        onPointerUp={() => {
          divider.current = null
        }}
        data-testid="film-timeline-divider"
      />
      <TrackHalf kind="audio" tracks={audio} rows={rows.audio} top={audioTop} height={audioHeight} {...halfProps} />
      <div className="film-tl-mix" style={{ top: audioTop + audioHeight, height: MASTER_H, right: RIGHT_GUTTER }}>
        <span className="film-tl-mix-name">{phrase('Mix')}</span>
        <span className="film-tl-mix-level" style={{ left: headerWidth - 12 }} data-testid="film-timeline-mix">
          {mixDb.toFixed(1)}
        </span>
      </div>
      <span className="film-tl-column" style={{ left: headerWidth - 1, top: tracksTop, height: Math.max(0, audioTop + audioHeight + MASTER_H - tracksTop) }} />
      <VerticalBar top={tracksTop} height={videoHeight} value={Math.min(view.vScroll, rows.maxVideoScroll)} max={rows.maxVideoScroll} invert onValue={(vScroll) => store.set({ vScroll })} />
      <VerticalBar top={audioTop} height={audioHeight} value={Math.min(view.aScroll, rows.maxAudioScroll)} max={rows.maxAudioScroll} invert={false} onValue={(aScroll) => store.set({ aScroll })} />
      <div className="film-tl-playhead-area" style={{ left: headerWidth, width: contentWidth, top: TOP_H - RULER_H, height: Math.max(0, size.height - SCROLLBAR_H - (TOP_H - RULER_H)) }}>
        <Playhead film={film} playback={playback} store={store} width={contentWidth} autoScroll={prefs.autoScroll} onScrub={scrub} phrase={phrase} />
      </div>
      <div className="film-tl-zoombar-wrap" style={{ left: headerWidth, top: size.height - SCROLLBAR_H + 2 }}>
        <ZoomBar view={view} store={store} width={contentWidth} duration={duration} testId="film-timeline-zoombar" />
      </div>
      <GestureOverlay dragView={gestures.dragView} left={headerWidth} width={contentWidth} top={TOP_H - RULER_H} bottom={audioTop + audioHeight} phrase={phrase} />
      {gestures.transitionMenu ? <TransitionMenu at={gestures.transitionMenu.at} onClose={gestures.closeTransitionMenu} onDuration={() => gestures.openDurationDialog(gestures.transitionMenu!.id)} onClear={() => gestures.clearTransition(gestures.transitionMenu!.id)} phrase={phrase} /> : null}
      {gestures.durationDialog != null ? <TransitionDurationDialog id={gestures.durationDialog} film={film} invoke={invoke} onClose={gestures.closeDurationDialog} phrase={phrase} /> : null}
      {gestures.laneMenu ? <LaneMenu at={gestures.laneMenu.at} track={gestures.laneMenu.track} seconds={gestures.laneMenu.seconds} film={film} invoke={invoke} onClose={gestures.closeLaneMenu} phrase={phrase} t={t} /> : null}
      {rulerMenu ? <RulerMenu at={rulerMenu.at} seconds={rulerMenu.seconds} marker={rulerMenu.marker} film={film} invoke={invoke} onClose={closeRulerMenu} phrase={phrase} /> : null}
      {gestures.menu ? <ClipMenu at={gestures.menu.at} onClose={gestures.closeMenu} film={film} labels={labels} clip={gestures.menu.clip} invoke={invoke} query={query} phrase={phrase} /> : null}
    </div>
  )
}

/**
 * What a gesture draws over the tracks (upstream `interact` and `show`): the snap indicator, the
 * marquee, the Razor's cut line, the edge brackets of what a press would trim (red for a ripple,
 * yellow otherwise), and where a drop would land. It alone redraws while the pointer moves.
 */
function GestureOverlay({ dragView, left, width, top, bottom, phrase }: { dragView: DragViewStore; left: number; width: number; top: number; bottom: number; phrase: Phrases }) {
  const shown = useDragView(dragView, (view) => view)
  const inside = (x: number) => x >= -1 && x <= width + 1
  return (
    <div className="film-tl-gesture" style={{ left, width, top: 0, height: bottom }}>
      {shown.snapX != null && inside(shown.snapX) ? <span className="film-tl-snap" style={{ left: shown.snapX, top: top + RULER_H, height: Math.max(0, bottom - top - RULER_H) }} data-testid="film-timeline-snap-line" /> : null}
      {shown.marquee ? <span className="film-tl-marquee" style={shown.marquee} data-testid="film-timeline-marquee" /> : null}
      {shown.razor && inside(shown.razor.x) ? <span className="film-tl-razor" style={{ left: shown.razor.x, top: shown.razor.top, height: shown.razor.height }} /> : null}
      {shown.brackets.map((bracket) => (
        <span key={`${bracket.x}:${bracket.out}`} className="film-tl-bracket" data-out={bracket.out || undefined} data-ripple={bracket.ripple || undefined} style={{ left: bracket.out ? bracket.x - 6 : bracket.x, top: bracket.top + 1, height: Math.max(0, bracket.height - 2) }} />
      ))}
      {shown.effectDrop ? (
        <>
          <span className="film-tl-effect-drop" data-transition={shown.effectDrop.transition || undefined} style={{ left: shown.effectDrop.x, width: shown.effectDrop.width, top: shown.effectDrop.top + 1, height: Math.max(0, shown.effectDrop.height - 2) }} data-kit-ui-id="control:timeline.effectDrop" data-testid="film-timeline-effect-drop" />
          {shown.effectDrop.cutX != null ? <span className="film-tl-effect-drop-cut" style={{ left: shown.effectDrop.cutX, top: shown.effectDrop.top + 1, height: Math.max(0, shown.effectDrop.height - 2) }} /> : null}
          {shown.effectDrop.label ? (
            <span className="film-tl-effect-drop-label" style={{ left: shown.effectDrop.x + shown.effectDrop.width / 2, top: shown.effectDrop.top + 2 }} data-testid="film-timeline-effect-drop-label">
              {phrase(shown.effectDrop.label)}
            </span>
          ) : null}
        </>
      ) : null}
      {shown.fade?.ramp && shown.fade.ramp.width > 0 ? (
        <svg className="film-tl-fade-ramp" style={{ left: shown.fade.ramp.x, top: shown.fade.ramp.top, width: shown.fade.ramp.width, height: shown.fade.ramp.height }} viewBox={`0 0 ${shown.fade.ramp.width} ${shown.fade.ramp.height}`} aria-hidden="true" data-testid="film-timeline-fade-ramp">
          <polygon points={shown.fade.edge === 'in' ? `0,0 0,${shown.fade.ramp.height} ${shown.fade.ramp.width},0` : `0,0 ${shown.fade.ramp.width},0 ${shown.fade.ramp.width},${shown.fade.ramp.height}`} />
        </svg>
      ) : null}
      {shown.tip ? (
        <span className="film-tl-tip" style={{ left: shown.tip.x, top: shown.tip.y }} data-testid="film-timeline-tip">
          {shown.tip.text}
        </span>
      ) : null}
      {shown.drop ? (
        <span className="film-tl-drop" style={{ left: shown.drop.x, width: Math.max(2, shown.drop.width), top: shown.drop.top + 1, height: Math.max(0, shown.drop.height - 2) }} data-testid="film-timeline-drop">
          {shown.drop.insert ? <span>{phrase('Insert')}</span> : null}
        </span>
      ) : null}
    </div>
  )
}

/** The wrench (upstream's Timeline Display Settings): thumbnails, waveforms, through edits, and all tracks' heights. */
function TimelineSettings({ view, store, showThroughEdits, run, phrase }: { view: TimelineView; store: TimelineViewStore; showThroughEdits: boolean; run: (command: string, params: Record<string, unknown>) => void; phrase: Phrases }) {
  const state = useUi().state('control:timeline.toggle.settings')
  if (state.hidden) return null
  return (
    <MenuButton
      trigger={({ open, toggle }) => (
        <button type="button" className="film-tl-toggle" title={phrase('Timeline Display Settings')} aria-label={phrase('Timeline Display Settings')} aria-haspopup="menu" aria-expanded={open} disabled={state.disabled} tabIndex={0} onClick={toggle} data-kit-ui-id="control:timeline.toggle.settings" data-testid="film-timeline-settings">
          <Wrench size={14} aria-hidden="true" />
        </button>
      )}
    >
      <MenuItem label={phrase('Show Video Thumbnails')} checked={view.showThumbnails} onSelect={() => store.set({ showThumbnails: !view.showThumbnails })} uiId="control:timeline.settings.showVideoThumbnails" testId="film-timeline-show-thumbnails" />
      <MenuItem label={phrase('Show Audio Waveform')} checked={view.showWaveforms} onSelect={() => store.set({ showWaveforms: !view.showWaveforms })} uiId="control:timeline.settings.showAudioWaveform" testId="film-timeline-show-waveforms" />
      <MenuSeparator />
      <MenuItem label={phrase('Show Through Edits')} checked={showThroughEdits} onSelect={() => run('sequence.showThroughEdits', { on: !showThroughEdits })} uiId="control:timeline.settings.showThroughEdits" testId="film-timeline-show-through-edits" />
      <MenuSeparator />
      <MenuItem label={phrase('Expand All Tracks')} onSelect={() => store.set({ videoTrackHeight: 64, audioTrackHeight: 64 })} uiId="control:timeline.settings.expandAllTracks" testId="film-timeline-expand-all" />
      <MenuItem label={phrase('Minimize All Tracks')} onSelect={() => store.set({ videoTrackHeight: 26, audioTrackHeight: 26 })} uiId="control:timeline.settings.minimizeAllTracks" testId="film-timeline-minimize-all" />
    </MenuButton>
  )
}

/** The Timeline frame's tab strip (upstream `draw_group_chrome`): one tab per open sequence while it is the active tab, else the active sequence's name. */
export function SequenceTabs({ active, film, session, invoke, phrase }: { active: boolean; film: FilmInfo | null; session: FilmSessionState | null; invoke: (id: string, params?: Record<string, unknown>) => Promise<unknown>; phrase: Phrases }) {
  const items = useMemo(() => projectItems(film?.root ?? null), [film?.root])
  const open = (session?.openSequences ?? []).filter((id) => items.get(id)?.type === 'Sequence')
  const current = film?.activeSequence ?? null
  // The sequence being dragged, and the index last asked for, so a move is sent once per place.
  const drag = useRef<{ item: number; pointer: number; sent: number | null } | null>(null)
  const tabs = useRef(new Map<number, HTMLElement>())
  // A preview that opens a sequence the frame has no tab for (New Sequence): a ghost tab for it.
  const previewState = usePreviewState()
  const previewed = usePreviewFilm(active && open.length > 0 && previewState.open && previewState.kinds.includes('timeline'))
  const ghost = previewed?.film.activeSequence != null && !open.includes(previewed.film.activeSequence) ? { id: previewed.film.activeSequence, name: projectItems(previewed.film.root).get(previewed.film.activeSequence)?.name ?? '' } : null
  if (!active || !open.length) {
    const name = current != null ? items.get(current)?.name : undefined
    return <span className="film-seq-title">{name ?? phrase('Timeline: (no sequences)')}</span>
  }
  return (
    <span className="film-seq-tabs" data-testid="film-sequence-tabs">
      {open.map((id, index) => {
        const shown = id === current
        return (
          <span
            key={id}
            ref={(element) => {
              if (element) tabs.current.set(id, element)
              else tabs.current.delete(id)
            }}
            className="film-seq-tab"
            data-active={(shown && !ghost) || undefined}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              drag.current = { item: id, pointer: event.pointerId, sent: null }
              event.currentTarget.setPointerCapture(event.pointerId)
              if (!shown) void invoke('sequence.open', { item: id })
            }}
            onPointerMove={(event) => {
              // Passing a neighbour's middle swaps places with it (upstream's sequence tab drag).
              const current = drag.current
              if (current?.item !== id) return
              const before = open[index - 1] != null ? tabs.current.get(open[index - 1])?.getBoundingClientRect() : undefined
              const after = open[index + 1] != null ? tabs.current.get(open[index + 1])?.getBoundingClientRect() : undefined
              const target = before && event.clientX < before.left + before.width / 2 ? Math.max(0, index - 1) : after && event.clientX > after.left + after.width / 2 ? index + 1 : null
              if (target == null || target === current.sent) return
              current.sent = target
              void invoke('sequence.moveTab', { item: id, index: target })
            }}
            onPointerUp={() => {
              drag.current = null
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return
              event.stopPropagation()
              void invoke('sequence.close', { item: id })
            }}
          >
            {shown ? (
              <button
                type="button"
                className="film-seq-close"
                aria-label={phrase('Close Sequence')}
                title={phrase('Close Sequence')}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  void invoke('sequence.close', { item: id })
                }}
                data-kit-ui-id="control:timeline.tab.close"
                data-testid={`film-sequence-tab-${id}-close`}
              >
                <X size={9} aria-hidden="true" />
              </button>
            ) : null}
            <button type="button" className="film-seq-label" aria-pressed={shown} data-kit-ui-id="control:timeline.tab" data-testid={`film-sequence-tab-${id}`}>
              {items.get(id)?.name ?? ''}
            </button>
          </span>
        )
      })}
      {ghost ? (
        <span className="film-seq-tab" data-active data-preview="added" data-testid={`film-sequence-tab-preview-${ghost.id}`}>
          <span className="film-seq-label">{ghost.name}</span>
        </span>
      ) : null}
    </span>
  )
}

/** The » list's rows for the Timeline frame: its open sequences, the shown one checked. */
export function SequenceRows({ film, session, invoke, close }: { film: FilmInfo | null; session: FilmSessionState | null; invoke: (id: string, params?: Record<string, unknown>) => Promise<unknown>; close: () => void }) {
  const items = projectItems(film?.root ?? null)
  return (
    <>
      {(session?.openSequences ?? []).map((id) => (
        <MenuItem
          key={id}
          label={items.get(id)?.name ?? ''}
          checked={id === film?.activeSequence}
          uiId="control:timeline.tabs.list"
          testId={`film-sequence-list-${id}`}
          onSelect={() => {
            close()
            if (id !== film?.activeSequence) void invoke('sequence.open', { item: id })
          }}
        />
      ))}
    </>
  )
}
