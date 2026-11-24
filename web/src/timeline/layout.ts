/**
 * The Timeline's geometry and view state, as upstream's `panels/timeline.rs` (`Layout`, `show`'s
 * animated zoom and scroll, `draw_top`'s ruler steps, `zoom_thumb`, `waveform_display_gain`) and
 * `panels/keyboard.rs` (the track height and screen commands) work them out. Pure, so `node --test`
 * runs it. Times are seconds; x is points from the left edge of the track content.
 */

/** Upstream's block heights: the timecode, toolbar, and ruler; the ruler; the zoom bar; the video/audio divider; the Mix row. */
export const TOP_H = 58
export const RULER_H = 44
export const SCROLLBAR_H = 17
export const DIVIDER_H = 5
export const MASTER_H = 34
/** Room right of the tracks for their vertical scroll bars. */
export const RIGHT_GUTTER = 10
export const MIN_PPS = 0.05
export const MAX_PPS = 24_000
/** The narrowest the zoom bar's thumb gets: room for its two handles. */
export const MIN_THUMB_W = 34
/** Track heights the keyboard sets (`keyboard.rs`), and a header drag (`draw_headers`). */
export const MIN_TRACK_H = 24
export const MAX_TRACK_H = 240
export const HEIGHT_STEP = 12
export const DRAG_MIN_TRACK_H = 22
export const DRAG_MAX_TRACK_H = 220
/** The lowest a newly shown sequence's tracks are fitted to: the name, lock and eye still show. */
export const FIT_MIN_TRACK_H = 36
/** The header column: upstream's fixed 204 px, kept between these so the tracks keep some width. */
export const MIN_HEADER_W = 150
export const MAX_HEADER_W = 400
/** Peaks: one (min, max) pair per 256 samples at 48 kHz, read 4 s at a time (`itemPeaks`). */
export const PEAK_SAMPLES = 256
export const PEAK_RATE = 48_000
export const CHUNK_SECONDS = 4
export const PAIRS_PER_CHUNK = (CHUNK_SECONDS * PEAK_RATE) / PEAK_SAMPLES

/** Upstream's `TimelineView`: the UI's own view of the Timeline. */
export type TimelineView = {
  /** Points per second, animated toward `targetPps`. */
  pps: number
  targetPps: number
  /** The time at the left edge, animated toward `targetScroll`. */
  scroll: number
  targetScroll: number
  /** The video and audio halves' own vertical scroll. */
  vScroll: number
  aScroll: number
  /** The video half's share of the track area. */
  split: number
  videoTrackHeight: number
  audioTrackHeight: number
  headerWidth: number
  showThumbnails: boolean
  showWaveforms: boolean
  /** View ▸ Dynamic Audio Waveforms (upstream's `extras.dynamic_waveforms`, on by default and not kept). */
  dynamicWaveforms: boolean
  /** Follow the playhead while playing. */
  follow: boolean
  /** Fit the sequence on the next frame (Zoom to Sequence, a newly shown sequence). */
  fitPending: boolean
  /** The zoom a fit gave an empty sequence: the first clip to arrive fits again, unless the zoom changed meanwhile. */
  fitEmpty: number | null
  /** The heights before Expand or Minimize All Tracks, which pressing it again restores. */
  savedHeights: [number, number] | null
  /** Where a wheel zoom is anchored: a time and its x, kept under the pointer while zooming. */
  zoomAnchor: { time: number; x: number } | null
  /** Fit the track heights to the halves once the panel's height is known (a newly shown sequence). */
  fitHeights: boolean
}

export const DEFAULT_VIEW: TimelineView = {
  pps: 40,
  targetPps: 40,
  scroll: 0,
  targetScroll: 0,
  vScroll: 0,
  aScroll: 0,
  split: 0.5,
  videoTrackHeight: 60,
  audioTrackHeight: 56,
  headerWidth: 204,
  showThumbnails: true,
  showWaveforms: true,
  dynamicWaveforms: true,
  follow: true,
  fitPending: true,
  fitEmpty: null,
  savedHeights: null,
  zoomAnchor: null,
  fitHeights: true,
}

/** The fields kept in the kit store (`timeline`); zoom, scroll, and track heights follow the sequence shown, as upstream. */
export type StoredView = Pick<TimelineView, 'split' | 'headerWidth' | 'showThumbnails' | 'showWaveforms' | 'follow'>

export function storedView(view: TimelineView): StoredView {
  return { split: view.split, headerWidth: view.headerWidth, showThumbnails: view.showThumbnails, showWaveforms: view.showWaveforms, follow: view.follow }
}

/** A stored value as the view it keeps, or undefined when it is not one (corrupt, an older shape). */
export function validStoredView(raw: unknown): StoredView | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const number = (key: string) => (typeof value[key] === 'number' && Number.isFinite(value[key]) ? (value[key] as number) : undefined)
  const flag = (key: string) => (typeof value[key] === 'boolean' ? (value[key] as boolean) : undefined)
  const split = number('split')
  const headerWidth = number('headerWidth')
  const showThumbnails = flag('showThumbnails')
  const showWaveforms = flag('showWaveforms')
  const follow = flag('follow')
  if (split === undefined || headerWidth === undefined || showThumbnails === undefined || showWaveforms === undefined || follow === undefined) return undefined
  return { split: clampSplit(split), headerWidth: Math.min(MAX_HEADER_W, Math.max(MIN_HEADER_W, headerWidth)), showThumbnails, showWaveforms, follow }
}

type At = { pps: number; scroll: number }

/** `Layout::x_of`: the x of `seconds`, from the left edge of the track content. */
export function xOf(view: At, seconds: number) {
  return (seconds - view.scroll) * view.pps
}

/** `Layout::tick_at`: the time at `x`. */
export function timeAt(view: At, x: number) {
  return view.scroll + x / view.pps
}

/** How far the Timeline reaches: ten minutes past the end of the sequence (as Premiere's). */
export function timelineExtent(seconds: number) {
  return Math.max(0, seconds) + 600
}

/** The latest time the left edge of a view `width` points wide can show at `pps`. */
export function maxScroll(seconds: number, width: number, pps: number) {
  if (!(pps > 0) || !Number.isFinite(pps)) return 0
  return Math.max(0, timelineExtent(seconds) - width / pps)
}

/** A zoom kept between `MIN_PPS` and `MAX_PPS`. */
export const clampPps = (pps: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, pps))

/**
 * Upstream's zoom about the pointer (the Zoom tool's click, Option+wheel, a pinch): the target
 * zoom times `factor`, kept in bounds, with `time` (seconds) held under `x` while it eases there.
 */
export function zoomAt(view: Pick<TimelineView, 'targetPps'>, factor: number, time: number, x: number): Pick<TimelineView, 'targetPps' | 'zoomAnchor'> {
  return { targetPps: clampPps(view.targetPps * factor), zoomAnchor: { time, x } }
}

/**
 * The zoom factor of one wheel event (`dy`, CSS pixels, positive towards the content's right):
 * a pinch (macOS sends it as Ctrl+wheel) by egui's `exp(dy / 200)`, the zoom upstream's pinch
 * gets, and Option+wheel by upstream's `1 + dy · 0.01`; either at most 2× or ½× per event, so one
 * mouse-wheel notch zooms 2× rather than several times.
 */
export function wheelZoomFactor(pinch: boolean, dy: number) {
  const factor = pinch ? Math.exp(dy / 200) : 1 + dy * 0.01
  return Number.isFinite(factor) ? Math.min(2, Math.max(0.5, factor)) : 1
}

/** `zoom_about`: zoom by `factor` keeping `anchor` (seconds) under the same x, or about the middle when it is off screen. */
export function zoomAbout(view: TimelineView, factor: number, anchor: number, width: number): TimelineView {
  const old = view.targetPps
  const next = clampPps(old * factor)
  let x = (anchor - view.targetScroll) * old
  if (!(x >= 0 && x <= width)) x = width / 2
  return { ...view, targetPps: next, targetScroll: Math.max(0, anchor - x / next) }
}

/** The video half's share of the track area, between 10% and 90% (upstream's divider drag). */
export function clampSplit(split: number) {
  if (!Number.isFinite(split)) return 0.5
  return Math.min(0.9, Math.max(0.1, split))
}

/** The header column drawn in a panel `width` wide: the view's, leaving the tracks at least 160 px, never under 150. */
export function headerWidthFor(headerWidth: number, width: number) {
  const wanted = Math.min(MAX_HEADER_W, Math.max(MIN_HEADER_W, headerWidth))
  return Math.max(MIN_HEADER_W, Math.min(wanted, width - 160))
}

/** What a step needs to know: the content's width and the sequence's duration. */
export type StepContext = { width: number; duration: number }

/**
 * One frame of `show`'s view work: a pending fit, the zoom and scroll eased toward their targets
 * (critically damped, anchored under a wheel zoom's pointer), and the view kept inside the
 * Timeline's extent. `animating` says whether another frame is needed.
 */
export function stepView(view: TimelineView, dt: number, { width, duration }: StepContext): { view: TimelineView; animating: boolean } {
  const v = { ...view }
  const empty = duration <= 0
  const span = Math.max(1, duration)
  if (v.fitEmpty != null && (!empty || v.targetPps !== v.fitEmpty)) {
    v.fitPending = v.fitPending || v.targetPps === v.fitEmpty
    v.fitEmpty = null
  }
  if (v.fitPending && width > 50) {
    v.targetPps = clampPps((width * 0.94) / span)
    v.targetScroll = 0
    v.fitPending = false
    v.fitEmpty = empty ? v.targetPps : null
  }
  const k = 1 - Math.exp(-Math.min(0.05, Math.max(0, dt)) * 20)
  const zooming = Math.abs(v.pps - v.targetPps) / v.targetPps > 0.001
  v.pps += (v.targetPps - v.pps) * k
  if (v.zoomAnchor && zooming) {
    v.scroll = Math.max(0, v.zoomAnchor.time - v.zoomAnchor.x / v.pps)
    v.targetScroll = Math.max(0, v.zoomAnchor.time - v.zoomAnchor.x / v.targetPps)
  } else {
    v.scroll += (v.targetScroll - v.scroll) * k
    v.zoomAnchor = null
  }
  if (Math.abs(v.pps - v.targetPps) / v.targetPps < 0.0005) v.pps = v.targetPps
  if (Math.abs(v.scroll - v.targetScroll) * v.pps < 0.05) v.scroll = v.targetScroll
  if (!Number.isFinite(v.scroll) || !Number.isFinite(v.targetScroll)) {
    v.scroll = 0
    v.targetScroll = 0
  }
  v.scroll = Math.min(Math.max(0, v.scroll), maxScroll(duration, width, v.pps))
  v.targetScroll = Math.min(Math.max(0, v.targetScroll), maxScroll(duration, width, v.targetPps))
  return { view: v, animating: v.pps !== v.targetPps || v.scroll !== v.targetScroll }
}

/** Where `invoke`'s view commands read the editor: the program playhead and the track content's last width. */
export type ViewContext = { playhead: number; width: number }

const heights = (view: TimelineView) => ({ videoTrackHeight: view.videoTrackHeight, audioTrackHeight: view.audioTrackHeight })

/**
 * Upstream's UI commands on the Timeline view (`menus.rs` `view.zoom*`, `keyboard.rs` track
 * heights and screens) and the panel's own (`timeline.setSplit`): the next view and the command's
 * answer, or null for an id this does not run.
 */
export function applyViewCommand(view: TimelineView, id: string, params: Record<string, unknown>, context: ViewContext): { view: TimelineView; result: unknown } | null {
  switch (id) {
    case 'view.zoomIn':
    case 'view.zoomOut':
      return { view: zoomAbout(view, id === 'view.zoomIn' ? 1.6 : 1 / 1.6, context.playhead, context.width), result: null }
    case 'view.zoomToSequence':
      return { view: { ...view, fitPending: true }, result: null }
    case 'timeline.expandAllTracks':
    case 'timeline.minimizeAllTracks': {
      const target = id === 'timeline.expandAllTracks' ? 120 : MIN_TRACK_H
      const atTarget = view.videoTrackHeight === target && view.audioTrackHeight === target
      const next: TimelineView =
        atTarget && view.savedHeights
          ? { ...view, videoTrackHeight: view.savedHeights[0], audioTrackHeight: view.savedHeights[1], savedHeights: null }
          : { ...view, savedHeights: [view.videoTrackHeight, view.audioTrackHeight], videoTrackHeight: target, audioTrackHeight: target }
      return { view: next, result: heights(next) }
    }
    case 'timeline.increaseVideoHeight':
    case 'timeline.decreaseVideoHeight':
    case 'timeline.increaseAudioHeight':
    case 'timeline.decreaseAudioHeight': {
      const delta = id.includes('increase') ? HEIGHT_STEP : -HEIGHT_STEP
      const key = id.includes('Video') ? 'videoTrackHeight' : 'audioTrackHeight'
      const next = { ...view, [key]: Math.min(MAX_TRACK_H, Math.max(MIN_TRACK_H, view[key] + delta)) }
      return { view: next, result: heights(next) }
    }
    case 'timeline.nextScreen':
    case 'timeline.prevScreen': {
      // As upstream: the content's width less the header again.
      const page = (Math.max(200, context.width) - view.headerWidth) / Math.max(1e-6, view.pps)
      const targetScroll = Math.max(0, view.targetScroll + (id === 'timeline.nextScreen' ? page : -page))
      return { view: { ...view, targetScroll }, result: { scroll: targetScroll } }
    }
    case 'view.dynamicAudioWaveforms': {
      const on = typeof params.on === 'boolean' ? params.on : !view.dynamicWaveforms
      return { view: { ...view, dynamicWaveforms: on }, result: { dynamicAudioWaveforms: on } }
    }
    case 'timeline.setSplit':
      return { view: { ...view, split: clampSplit(Number(params.split)) }, result: null }
    default:
      return null
  }
}

/** Upstream's `FrameRate::timecode_base`: frames per timecode second (24 for 23.976). */
export function timecodeBase(fps: number) {
  return Math.max(1, Math.round(fps))
}

/**
 * `draw_top`'s ruler steps, in frames: labels at least 110 px apart and ticks at least 12 px
 * apart, from 1, 2, 5, and 10 frames up to an hour.
 */
export function rulerSteps(fps: number, pps: number) {
  const base = timecodeBase(fps)
  const steps = [1, 2, 5, 10, Math.floor(base / 2), base, base * 2, base * 5, base * 10, base * 15, base * 30, base * 60, base * 120, base * 300, base * 600, base * 1800, base * 3600]
  const framePx = pps / fps
  const label = steps.find((step) => step * framePx >= 110) ?? base * 3600
  const minor = steps.find((step) => step * framePx >= 12) ?? label
  return { label, minor }
}

/** One track row: its index (V1 and A1 are 0) and top within its half. */
export type TrackRow = { index: number; top: number; height: number }

/**
 * `show`'s rows: V1 at the bottom of the video half with the higher tracks stacked upward (its
 * scroll brings them in), A1 at the top of the audio half stacking downward.
 */
export function trackRows(view: TimelineView, { video, audio, videoHeight, audioHeight }: { video: number; audio: number; videoHeight: number; audioHeight: number }) {
  const vh = view.videoTrackHeight
  const ah = view.audioTrackHeight
  const videoTotal = video * vh
  const offset = Math.max(0, videoHeight - videoTotal)
  const maxVideoScroll = Math.max(0, videoTotal - videoHeight)
  const vScroll = Math.min(maxVideoScroll, Math.max(0, view.vScroll))
  const maxAudioScroll = Math.max(0, audio * ah - audioHeight)
  const aScroll = Math.min(maxAudioScroll, Math.max(0, view.aScroll))
  return {
    video: Array.from({ length: video }, (_, index) => ({ index, top: offset + (video - 1 - index) * vh - (maxVideoScroll - vScroll), height: vh })),
    audio: Array.from({ length: audio }, (_, index) => ({ index, top: index * ah - aScroll, height: ah })),
    maxVideoScroll,
    maxAudioScroll,
  }
}

/**
 * A half's track height for a newly shown sequence: `preferred` (the default) when its `count`
 * tracks fit in `room` points, else as tall as lets them all show, never under `FIT_MIN_TRACK_H`
 * (then the half scrolls). Without it a short Timeline showed V3 as a sliver under the ruler.
 */
export function fitTrackHeight(room: number, count: number, preferred: number) {
  if (!(count > 0) || !Number.isFinite(room) || count * preferred <= room) return preferred
  return Math.max(Math.min(FIT_MIN_TRACK_H, preferred), Math.min(preferred, Math.floor(Math.max(0, room) / count)))
}

/**
 * Scrolls one half by `delta` points (positive shows higher video tracks, or lower audio tracks),
 * kept between 0 and the half's `max`: upstream clamps the halves every frame, so scrolling past
 * the end leaves no dead zone to scroll back through.
 */
export function scrollHalf(view: TimelineView, half: 'video' | 'audio', delta: number, max: number): TimelineView {
  const key = half === 'video' ? 'vScroll' : 'aScroll'
  const value = Math.min(Math.max(0, max), Math.max(0, view[key] + delta))
  return value === view[key] ? view : { ...view, [key]: value }
}

/**
 * `zoom_thumb`: the zoom bar's thumb (left edge and width in a bar `bar` wide) and the seconds of
 * scroll per point of thumb travel. The thumb is the share of the Timeline in view, never
 * narrower than its handles, and its travel covers the whole scroll range.
 */
export function zoomThumb(bar: number, seconds: number, scroll: number, pps: number) {
  const visible = bar / Math.max(1e-9, pps)
  const total = Math.max(timelineExtent(seconds), visible)
  const width = Math.min(bar, Math.max(Math.min(MIN_THUMB_W, bar), (visible / total) * bar))
  const travel = Math.max(0, bar - width)
  const range = Math.max(0, total - visible)
  const left = range > 0 ? Math.min(1, Math.max(0, scroll / range)) * travel : 0
  return { left, width, perPoint: travel > 0.5 ? range / travel : 0, range, total, visible }
}

/** `waveform_display_gain`: the clip's gain, plus normalisation of the source to full scale by at most +12 dB. */
export function waveformDisplayGain(sourcePeak: number, clipGainDb: number) {
  const boost = Math.min(1 / Math.max(1e-9, sourcePeak), 3.981072)
  return 10 ** (clipGainDb / 20) * boost
}

/**
 * `draw_waveform`'s bar for a pixel whose loudest sample is `peak`, displayed at `gain`, in a
 * waveform `zone` tall: View ▸ Dynamic Audio Waveforms (the default) scales it logarithmically,
 * −48 dB to nothing and 0 dB to full; off, it is the linear amplitude.
 */
export function waveformBar(peak: number, gain: number, zone: number, dynamic: boolean) {
  if (!dynamic) return Math.min(1, Math.max(0, peak * gain)) * zone
  const db = 20 * Math.log10(Math.max(1e-5, peak * gain))
  return Math.min(1, Math.max(0, (db + 48) / 48)) * zone
}

/** What a clip's time mapping reads. */
export type ClipTiming = { start: number; duration: number; sourceIn: number; sourceOut: number; speed: number; reverse: boolean }

/** `TrackItem::source_time_at`: the source time shown at sequence time `t`. */
export function sourceTimeAt(clip: ClipTiming, t: number) {
  const along = (t - clip.start) * clip.speed
  return clip.reverse ? clip.sourceOut - along : clip.sourceIn + along
}

/** A clip as `throughEdits` reads it. */
export type ThroughPiece = ClipTiming & { id: number; item: number }

/**
 * Upstream's `track_through_edits` (`is_through_edit`): cuts between adjacent pieces of the same
 * source, at the same speed and direction, where the right piece continues the left in media
 * time (within a tolerance: a tenth of a frame).
 */
export function throughEdits(clips: readonly ThroughPiece[], frame: number) {
  const out: Array<{ left: number; right: number; time: number }> = []
  const slack = frame / 10
  for (let index = 0; index + 1 < clips.length; index += 1) {
    const a = clips[index]
    const b = clips[index + 1]
    if (Math.abs(a.start + a.duration - b.start) > slack || a.item !== b.item || a.speed !== b.speed || a.reverse !== b.reverse) continue
    const diff = a.reverse ? b.sourceOut - a.sourceIn : b.sourceIn - a.sourceOut
    if (Math.abs(diff) <= slack) out.push({ left: a.id, right: b.id, time: b.start })
  }
  return out
}
