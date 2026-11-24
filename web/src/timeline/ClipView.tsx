import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FilmClip } from '../film'
import { CHUNK_SECONDS, PAIRS_PER_CHUNK, PEAK_RATE, PEAK_SAMPLES, sourceTimeAt, waveformBar, waveformDisplayGain } from './layout'
import type { TimelineMedia } from './media'
import { paintFrame, type Thumbnails } from './thumbnails'
import { bandOf, linePoints, yOfDb } from './volumeBand'
import { handleX } from './fades'

/** The name band's height (`draw_clip`'s `name_h`). */
const NAME_H = 16
/** The engine's built-in effects every clip has (upstream `has_standard_effects` counts the others). */
const INTRINSIC = new Set(['motion', 'opacity', 'time_remap', 'volume', 'channel_volume', 'panner'])
/** At most this many 4 s chunks are asked for one clip's view of its waveform. */
const MAX_CHUNKS = 256

/** `lighten`: towards white by `amount`. */
export function lighten(hex: string, amount: number) {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1]
  if (!value) return hex
  const channel = (offset: number) => {
    const v = Number.parseInt(value.slice(offset, offset + 2), 16)
    return Math.round(v + (255 - v) * amount)
  }
  return `rgb(${channel(0)}, ${channel(2)}, ${channel(4)})`
}

type ThumbnailProps = {
  /** Where the frame comes from: the Timeline's cache, or the open preview's (an item only the preview has). */
  thumbnails: Thumbnails<HTMLCanvasElement>
  item: number
  /** The engine revision for a sequence item, a media item's stamp (`FilmProjectItem.stamp`), or null. */
  revision: number | string | null
  frame: number
  seconds: number
  /** The width asked of the engine (160 × device scale). */
  request: number
  width: number
  height: number
  dpr: number
}

/**
 * A clip's head frame, left-aligned below the name band in its picture's aspect, cropped (not
 * squeezed) when the clip is narrower. A sequence item's last revision's frame shows while its new
 * one loads, as upstream keeps the old texture until the new one is ready.
 */
const ClipThumbnail = memo(function ClipThumbnail({ thumbnails, item, revision, frame, seconds, request, width, height, dpr }: ThumbnailProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [, arrived] = useState(0)
  const shown = thumbnails.show({ item, revision, frame, width: request })
  const fresh = shown?.fresh ?? false
  useEffect(() => {
    if (fresh) return undefined
    return thumbnails.request({ item, revision, frame, seconds, width: request }, () => arrived((count) => count + 1))
  }, [thumbnails, item, revision, frame, seconds, request, fresh])
  const image = shown?.image ?? null
  const th = height
  const aspect = image ? image.width / image.height : 0
  const tw = image ? Math.max(0, Math.min(th * aspect, width)) : 0
  useLayoutEffect(() => {
    const target = canvas.current
    if (!target || !image || tw <= 0 || th <= 0) return
    paintFrame(target, image, tw, th, dpr, 'crop')
  }, [image, tw, th, dpr])
  if (!image || tw <= 0) return null
  return <canvas ref={canvas} className="film-clip-thumb" style={{ top: NAME_H, left: 1, width: tw, height: th }} data-testid="film-clip-thumbnail" />
})

type WaveformProps = {
  media: TimelineMedia
  clip: FilmClip
  revision: number | null
  /** The clip body's size, and the part of it to draw (body x, already coarsened by the caller). */
  bodyWidth: number
  bodyHeight: number
  from: number
  to: number
  color: string
  /** The zoom is animating: stretch the last drawing instead of drawing again. */
  animating: boolean
  dpr: number
  /** View ▸ Dynamic Audio Waveforms: logarithmic bars, else linear. */
  dynamic: boolean
}

/**
 * `draw_waveform`: the clip's sound rectified in the lower 42% (logarithmic, −48 dB to full, as
 * upstream's default Dynamic Audio Waveforms) and its channel tag (the Volume line is `VolumeLine`), drawn for the part of the clip in view from the 4 s peak chunks it covers. While the
 * zoom animates, the last drawing is stretched to the clip's new width and drawn again once the
 * zoom settles, so a zoom costs no waveform drawing per frame.
 */
const ClipWaveform = memo(function ClipWaveform({ media, clip, revision, bodyWidth, bodyHeight, from, to, color, animating, dpr, dynamic }: WaveformProps) {
  const wave = waveOf(clip)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawn = useRef<{ from: number; to: number; bodyWidth: number } | null>(null)
  const [arrivals, arrived] = useState(0)
  const width = Math.max(0, to - from)
  const perPx = clip.duration / Math.max(1, bodyWidth)
  const a = sourceTimeAt(clip, clip.start + from * perPx)
  const b = sourceTimeAt(clip, clip.start + to * perPx)
  const first = Math.max(0, Math.floor(Math.min(a, b) / CHUNK_SECONDS))
  const last = Math.min(first + MAX_CHUNKS - 1, Math.max(first, Math.floor(Math.max(a, b) / CHUNK_SECONDS)))
  useEffect(() => {
    if (animating) return undefined
    const cancels: Array<() => void> = []
    for (let chunk = first; chunk <= last; chunk += 1) {
      const spec = { item: clip.item, revision, chunk }
      if (!media.peaks.has(spec)) cancels.push(media.peaks.request(spec, () => arrived((count) => count + 1)))
    }
    return () => {
      for (const cancel of cancels) cancel()
    }
  }, [media, clip.item, revision, first, last, animating])
  useLayoutEffect(() => {
    const target = canvas.current
    if (!target || width <= 0 || (animating && drawn.current)) return
    const w = Math.max(1, Math.round(width * dpr))
    const h = Math.max(1, Math.round(bodyHeight * dpr))
    if (target.width !== w) target.width = w
    if (target.height !== h) target.height = h
    const context = target.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, bodyHeight)
    drawn.current = { from, to, bodyWidth }
    target.style.left = `${from}px`
    target.style.width = `${width}px`
    const zone = Math.max(8, bodyHeight * 0.42)
    const bottom = bodyHeight - 1
    const loudest = media.peaks.loudest(clip.item, revision) || media.peaks.loudestShown(clip.item)
    const chunks = new Map<number, Float32Array | undefined>()
    const chunkOf = (index: number) => {
      if (!chunks.has(index)) chunks.set(index, media.peaks.show({ item: clip.item, revision, chunk: index }))
      return chunks.get(index)
    }
    if (loudest > 0) {
      const gain = waveformDisplayGain(loudest, clip.gainDb)
      context.fillStyle = color
      const pairsPerSecond = PEAK_RATE / PEAK_SAMPLES
      for (let x = 0; x < width; x += 1) {
        const s0 = sourceTimeAt(clip, clip.start + (from + x) * perPx) * pairsPerSecond
        const s1 = sourceTimeAt(clip, clip.start + (from + x + 1) * perPx) * pairsPerSecond
        const lo = Math.max(0, Math.floor(Math.min(s0, s1)))
        const hi = Math.max(lo + 1, Math.floor(Math.max(s0, s1)))
        let most = 0
        for (let pair = lo; pair < hi; pair += 1) {
          const chunk = chunkOf(Math.floor(pair / PAIRS_PER_CHUNK))
          if (!chunk) continue
          const at = (pair % PAIRS_PER_CHUNK) * 2
          if (at + 1 >= chunk.length) continue
          most = Math.max(most, Math.abs(chunk[at]), Math.abs(chunk[at + 1]))
        }
        const bar = waveformBar(most, gain, zone, dynamic)
        if (bar > 0.3) context.fillRect(x, bottom - bar, 1, bar)
      }
    }
    // The channel tag, at the clip's left edge when it is drawn.
    if (bodyWidth > 30 && from <= 3) {
      context.fillStyle = 'rgba(0, 0, 0, 0.63)'
      context.fillRect(3 - from, bodyHeight - 11, 8, 9)
      context.fillStyle = '#d9d9d9'
      context.font = '7.5px system-ui, sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText('1', 7 - from, bodyHeight - 6.5)
    }
    // `arrivals` redraws as chunks come in.
  }, [media, wave, revision, width, bodyWidth, bodyHeight, from, to, perPx, color, arrivals, animating, dpr, dynamic])
  if (width <= 0) return null
  // While the zoom animates, the last drawing stretched to the clip's width now.
  const scale = animating && drawn.current ? bodyWidth / Math.max(1, drawn.current.bodyWidth) : 1
  const left = animating && drawn.current ? drawn.current.from * scale : from
  const shownWidth = animating && drawn.current ? (drawn.current.to - drawn.current.from) * scale : width
  return <canvas ref={canvas} className="film-clip-wave" style={{ left, width: shownWidth, height: bodyHeight }} data-testid="film-clip-waveform" />
}, (before, after) => {
  for (const key of Object.keys(after) as Array<keyof WaveformProps>) if (key !== 'clip' && before[key] !== after[key]) return false
  return waveOf(before.clip) === waveOf(after.clip)
})

/**
 * What a clip's waveform is drawn from: everything but its place on the track, which the drawing
 * never reads (a source time is relative to the clip's start), so a clip a ripple or a preview
 * only moves does not draw its waveform again.
 */
const waveOf = (clip: FilmClip) => `${clip.item}|${clip.sourceIn}|${clip.sourceOut}|${clip.speed}|${clip.reverse}|${clip.duration}|${clip.gainDb}`

/** What the Volume line shows of a gesture: the line hovered or dragged, a keyframe hovered or dragged (and where a drag in time has it). */
export type VolumeShown = { line: boolean; key: number | null; keyTime: number | null }

/**
 * The Volume line on an audio clip (upstream `timeline_volume::paint`): white with a dark shadow
 * on the faders' scale, through its keyframes, drawn as diamonds (the selected one filled); drawn
 * thicker while the pointer is on it. A drag of the line or a keyframe is `useGestures`'s.
 */
const VolumeLine = memo(function VolumeLine({ clip, start, duration, width, height, shown, selectedKey }: { clip: FilmClip; start: number; duration: number; width: number; height: number; shown: VolumeShown | null; selectedKey: number | null }) {
  const band = bandOf(height)
  if (!band || width < 2) return null
  // A keyframe dragged in time is drawn where the drag has it.
  const keys = shown?.key != null && shown.keyTime != null ? clip.volumeKeys.map((key, index) => (index === shown.key ? { ...key, time: shown.keyTime! } : key)).sort((a, b) => a.time - b.time) : clip.volumeKeys
  const points = linePoints(keys, clip.volumeDb, start, duration, width, band)
  const path = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const xOf = (t: number) => (duration > 0 ? ((t - start) / duration) * width : 0)
  return (
    <svg className="film-clip-volume" width={width} height={height} data-hover={shown?.line || undefined} aria-hidden="true" data-kit-ui-id="control:timeline.clip.volume" data-testid={`film-clip-volume-${clip.id}`} data-level={clip.volumeDb.toFixed(2)}>
      <polyline className="film-clip-volume-shadow" points={path} transform="translate(0 1)" />
      <polyline className="film-clip-volume-line" points={path} />
      {keys.map((key, index) => {
        const x = xOf(key.time)
        if (x < -6 || x > width + 6) return null
        const y = yOfDb(band, key.value)
        const original = clip.volumeKeys.indexOf(clip.volumeKeys.find((each) => each.mediaTime === key.mediaTime) ?? key)
        return (
          <rect
            key={key.mediaTime}
            className="film-clip-volume-key"
            x={x - 3.5}
            y={y - 3.5}
            width={7}
            height={7}
            transform={`rotate(45 ${x} ${y})`}
            data-selected={selectedKey === key.mediaTime || undefined}
            data-hover={shown?.key === original || undefined}
            data-kit-ui-id="control:timeline.clip.volumeKey"
            data-testid={`film-clip-volume-key-${clip.id}-${original}`}
          />
        )
      })}
    </svg>
  )
})

export type ClipViewProps = {
  clip: FilmClip
  kind: 'video' | 'audio'
  track: number
  /** Points per second. */
  pps: number
  /** The sequence's frame rate, which the head frame snaps to. */
  fps: number
  rowHeight: number
  /** The clip's label colour (the engine's label preferences). */
  color: string
  inRange: boolean
  /** The clip reaches its media's first or last frame (no handles): white corner triangles. */
  noHead: boolean
  noTail: boolean
  /** Whether the head thumbnail is drawn (video, thumbnails shown), and the width asked of the engine. */
  thumbnail: boolean
  thumbnailWidth: number
  /** Whether the waveform is drawn (audio, waveforms shown). */
  waveform: boolean
  /** View ▸ Dynamic Audio Waveforms. */
  dynamicWaveform: boolean
  /** The engine revision for a sequence item (its media changes with edits), else null. */
  revision: number | null
  /** A media item's stamp (`FilmProjectItem.stamp`): its head thumbnail draws again when its media does (made offline, linked). */
  stamp?: string | null
  /** The part of the clip body to draw the waveform for (body x, coarsened); [0, 0] for video. */
  from: number
  to: number
  /** The zoom is animating. */
  animating: boolean
  dpr: number
  /** Where the clip is drawn, in seconds: its own place, or a drag's live preview (upstream `preview_drag`). */
  start: number
  duration: number
  /** Drawn as selected while a drag carries it to another track. */
  carried?: boolean
  media: TimelineMedia
  /** A dialog's preview: the clip is new (a dashed accent outline) or changed (an accent outline, at its new place). */
  preview?: 'added' | 'changed'
  /** In the preview's selection (Find): a dashed highlight beside the real selection. */
  previewSelected?: boolean
  /** The open preview's pictures, for a clip whose item only the preview has or whose picture it changes. */
  pictures?: Thumbnails<HTMLCanvasElement>
  /** Its item is one only the preview has: the document has no peaks of it to draw. */
  noPeaks?: boolean
  /** An audio clip's Volume line as a gesture shows it, and its selected keyframe (media time), if any. */
  volume?: VolumeShown | null
  selectedKey?: number | null
  /**
   * Its fade handles (a free clip end only, as a transition from or to nothing): the fade's length
   * there in points (0 without one), or null where a clip touches it; `fadeActive` the end a gesture holds.
   */
  fadeIn?: number | null
  fadeOut?: number | null
  fadeActive?: 'in' | 'out' | null
  /** The handles' tooltips (Fade In, Fade Out), in the person's language. */
  fadeLabels?: { in: string; out: string }
}

/**
 * One clip (upstream `draw_clip`): its label colour (brighter inside In/Out, a little brighter
 * selected, grey disabled), the name band with its speed, the fx badge, the head thumbnail or the
 * waveform, the corner triangles where it has no handles, and the selection outline. Drawn at its
 * place on the track's layer, which scrolls by a transform: scrolling does not redraw it.
 */
export const ClipView = memo(function ClipView(props: ClipViewProps) {
  const { clip, kind, track, pps, fps, rowHeight, color, inRange, noHead, noTail, thumbnail, thumbnailWidth, waveform, dynamicWaveform, revision, stamp, from, to, animating, dpr, start, duration, carried, media, preview, previewSelected, pictures, noPeaks, volume = null, selectedKey = null, fadeIn = null, fadeOut = null, fadeActive = null, fadeLabels } = props
  const left = start * pps
  const width = Math.max(1, duration * pps)
  const selected = clip.selected || Boolean(carried)
  const height = Math.max(1, rowHeight - 2)
  const fill = !clip.enabled ? '#2a2a2a' : inRange ? lighten(color, 0.12) : selected ? lighten(color, 0.06) : color
  const standard = clip.effects.some((effect) => !INTRINSIC.has(effect.effect))
  const modified = clip.effects.some((effect) => INTRINSIC.has(effect.effect) && (effect.keyframed.length > 0 || !effect.enabled))
  const speed = Math.abs(clip.speed - 1) > 1e-6 || clip.reverse ? ` [${Math.round((clip.reverse ? -1 : 1) * clip.speed * 100)}%]` : ''
  // `rate.snap(it.source_in)`: the head frame at the sequence's rate.
  const frame = Math.round(clip.sourceIn * fps)
  return (
    <div
      className="film-clip"
      data-kind={kind}
      data-selected={selected || undefined}
      data-track={track}
      data-disabled={!clip.enabled || undefined}
      data-preview={preview}
      data-preview-selected={previewSelected || undefined}
      style={{ transform: `translateX(${left}px)`, width, height, background: fill }}
      title={clip.name}
      data-testid={`film-clip-${clip.id}`}
      data-kit-ui-id="control:timeline.clip"
    >
      {thumbnail && height > 28 && width > 20 && clip.enabled ? (
        <ClipThumbnail thumbnails={pictures ?? media.thumbnails} item={clip.item} revision={pictures ? null : (revision ?? stamp ?? null)} frame={frame} seconds={frame / fps} request={thumbnailWidth} width={width - 2} height={height - NAME_H - 1} dpr={dpr} />
      ) : null}
      {/* An item only the preview has has no peaks of the document's to draw. */}
      {kind === 'audio' && waveform && !noPeaks && width > 3 ? (
        <ClipWaveform media={media} clip={clip} revision={revision} bodyWidth={width} bodyHeight={height} from={Math.max(0, from)} to={Math.min(width, to)} color={inRange ? '#c7e9fa' : '#79c0f9'} animating={animating} dpr={dpr} dynamic={dynamicWaveform} />
      ) : null}
      {width > 24 ? (
        <span className="film-clip-name">
          {clip.name}
          {speed}
        </span>
      ) : null}
      {(standard || modified) && width > 40 ? (
        <span className="film-clip-fx" data-standard={standard || undefined}>
          fx
        </span>
      ) : null}
      {kind === 'audio' ? <VolumeLine clip={clip} start={start} duration={duration} width={width} height={height} shown={volume} selectedKey={selectedKey} /> : null}
      {fadeIn != null && width > 24 ? <span className="film-clip-fade" data-edge="in" data-active={fadeActive === 'in' || undefined} style={{ left: handleX('in', fadeIn, width) }} title={fadeLabels?.in} data-kit-ui-id="control:timeline.clip.fadeIn" data-testid={`film-clip-fade-in-${clip.id}`} /> : null}
      {fadeOut != null && width > 24 ? <span className="film-clip-fade" data-edge="out" data-active={fadeActive === 'out' || undefined} style={{ left: handleX('out', fadeOut, width) }} title={fadeLabels?.out} data-kit-ui-id="control:timeline.clip.fadeOut" data-testid={`film-clip-fade-out-${clip.id}`} /> : null}
      {noHead && width > 12 ? <span className="film-clip-corner" data-side="head" /> : null}
      {noTail && width > 12 ? <span className="film-clip-corner" data-side="tail" /> : null}
    </div>
  )
})
