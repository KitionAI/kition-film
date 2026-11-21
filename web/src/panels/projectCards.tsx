import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { type IconComponent } from '@kition/sdk/editor'
import { TesseraIcons } from '@kition/sdk/editor'
import { deviceScale, type Phrases } from '@kition/sdk/editor'
import { TICKS_PER_SECOND } from '../film'
import type { FilmLabels } from '../session/useFilmSession'
import { paintFrame, type Thumbnails } from '../timeline/thumbnails'
import { hoverTicks, posterTicks, thumbnailTicks, thumbnailWidth, type ProjectRow, type ProjectUi } from './projectModel'


const AudioLines = TesseraIcons.AudioLinesIcon
const Clapperboard = TesseraIcons.ClapperboardIcon
const Film = TesseraIcons.FilmIcon
const Image = TesseraIcons.ImageIcon
const Layers = TesseraIcons.LayersIcon

// What the Icon view's and the Freeform view's cards share (upstream `project_views.rs` `card`,
// `thumb`, `hover_time`): the picture from the one thumbnail cache, the In/Out bar, the hover
// scrub, the stream, offline, and proxy badges, and the label colours and short duration.

export type ProjectThumbnails = Thumbnails<HTMLCanvasElement>

/** Upstream's offline red (`project_views.rs` `OFFLINE`). */
export const OFFLINE = '#e85c5c'
/** Upstream's In/Out bar and hover playhead blue. */
export const MARK_BLUE = '#5a9bf0'

export const ICONS: Readonly<Record<string, IconComponent>> = { audio: AudioLines, image: Image, film: Film, sequence: Clapperboard, adjust: Layers }

/** A label's colour from the engine's label preferences (by lower-case name). */
export const labelColor = (labels: FilmLabels | null, label: string | undefined) => (label ? labels?.colors[label.toLowerCase()]?.color : undefined) ?? 'transparent'

/** `m:ss` or `h:mm:ss` (upstream's card duration). */
export function shortDuration(ticks: number) {
  const secs = Math.max(0, Math.floor(ticks / TICKS_PER_SECOND))
  const pad = (n: number) => String(n).padStart(2, '0')
  return secs >= 3600 ? `${Math.floor(secs / 3600)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}` : `${Math.floor(secs / 60)}:${pad(secs % 60)}`
}

/** What a picture asks for and draws. */
/** `stamp`: what the picture is keyed on, when not the row's own (`thumbStamp`: the document's, for a preview row drawn from the document's cache). */
type ThumbProps = { row: ProjectRow; width: number; height: number; ticks: number; thumbnails: ProjectThumbnails; revision: number | null; stamp?: string | null; testId?: string }

/**
 * An item's picture (upstream `thumb`): `itemFrame` at the drawn width × device scale, asked
 * while it is on screen (the cards in view ask first, one request in flight through the shared
 * queue), fitted into its box; the last picture stays while the next loads. An item with no
 * picture (sound, a frame the engine cannot give) shows its icon. It draws again only when its
 * picture or size changes.
 */
export const Thumb = memo(function Thumb({ row, width, height, ticks, thumbnails, revision, stamp = row.stamp ?? null, testId }: ThumbProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [, setReady] = useState(0)
  const scale = deviceScale()
  // A sequence's poster follows its own content (its stamp), not every revision of the project; a
  // media item's follows its media (its stamp: its file, offline or not, its proxy shown), as
  // upstream's `item_revision`, so Make Offline and Link Media draw it again.
  const spec = { item: row.item ?? 0, revision: row.kind === 'sequence' ? (stamp ?? revision) : stamp, frame: ticks, width: thumbnailWidth(width, scale) }
  useEffect(() => {
    const element = canvas.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible || !row.hasVideo) return undefined
    return thumbnails.request({ ...spec, seconds: ticks / TICKS_PER_SECOND }, () => setReady((n) => n + 1))
    // The spec's fields are its key.
  }, [visible, row.hasVideo, spec.item, spec.revision, spec.frame, spec.width, thumbnails])
  const shown = row.hasVideo ? thumbnails.show(spec) : undefined
  const image = shown?.image ?? null
  const fresh = shown?.fresh ?? false
  const missing = !row.hasVideo || (shown !== undefined && image == null)
  useLayoutEffect(() => {
    const element = canvas.current
    if (!element || shown === undefined) return
    paintFrame(element, image, width, height, scale, 'contain')
    // `shown` itself is a new object each render: its picture and freshness are what change.
  }, [image, fresh, width, height, scale])
  const Glyph = ICONS[row.icon ?? 'film'] ?? Film
  return (
    <span className="film-project-thumb" style={{ width, height }} data-testid={testId} data-missing={missing || undefined}>
      <canvas ref={canvas} style={{ width, height }} data-drawn={!row.hasVideo ? '1' : shown === undefined ? undefined : fresh ? '1' : '0'} />
      {missing ? <Glyph className="film-project-thumb-glyph" size={Math.min(28, height) * 0.8} aria-hidden="true" /> : null}
    </span>
  )
})

/** `touchScrub`: Thumbnail controls for all pointing devices, so a touch drag across the card scrubs it too. */
type CardArtProps = { row: ProjectRow; width: number; hoverScrub: boolean; touchScrub: boolean; revision: number | null; thumbnails: ProjectThumbnails; stamp?: string | null; ui: ProjectUi; phrase: Phrases }

/**
 * A card's picture (upstream `card` above its name line): the thumbnail, the In/Out bar, the
 * stream badges, and the offline band and proxy badge. With Hover Scrub on, the pointer across it
 * shows the frame under it, one frame per animation frame at most, and keeps that time for I and
 * O; a touch drag does too with Thumbnail controls for all pointing devices on.
 */
export function CardArt({ row, width, hoverScrub, touchScrub, revision, thumbnails, stamp, ui, phrase }: CardArtProps) {
  const item = row.item as number
  const thumbHeight = (width * 9) / 16
  const [hover, setHover] = useState<number | null>(null)
  const frame = useRef<number | null>(null)
  const pointerX = useRef(0)
  const box = useRef<HTMLSpanElement>(null)
  // Gone (deleted, filtered out, the view switched): no animation frame waits, and its time is not kept for I and O.
  useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current)
      if (ui.hover.current?.item === item) ui.hover.current = null
    },
    [item, ui],
  )
  const duration = row.duration ?? 0
  const scrubs = hoverScrub && duration > 0
  useEffect(() => {
    if (!scrubs) setHover(null)
  }, [scrubs])
  const onMove = (event: ReactPointerEvent) => {
    // Touch scrubs only with Thumbnail controls for all pointing devices on.
    if (!scrubs || (event.pointerType === 'touch' && !touchScrub)) return
    pointerX.current = event.clientX
    if (frame.current != null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const rect = box.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      const ticks = hoverTicks(row, (pointerX.current - rect.left) / rect.width)
      ui.hover.current = { item, time: ticks }
      setHover(ticks)
    })
  }
  const onLeave = () => {
    if (frame.current != null) cancelAnimationFrame(frame.current)
    frame.current = null
    if (ui.hover.current?.item === item) ui.hover.current = null
    setHover(null)
  }
  const start = row.start ?? 0
  const fx = (ticks: number) => `${Math.min(100, Math.max(0, ((ticks - start) / Math.max(1, duration)) * 100))}%`
  const marked = (row.in != null || row.out != null) && duration > 0
  const markA = row.in ?? start
  const markB = row.out != null ? row.out + (row.frame ?? 0) : start + duration
  return (
    // While touch scrubs, a sideways drag scrubs and an upward or downward one still scrolls the grid (lifting the finger leaves the card).
    <span ref={box} className="film-project-card-art" style={{ height: thumbHeight, touchAction: scrubs && touchScrub ? 'pan-y' : undefined }} onPointerMove={onMove} onPointerLeave={onLeave}>
      <Thumb row={row} width={width} height={thumbHeight} ticks={hover != null ? thumbnailTicks(row, hover) : posterTicks(row)} thumbnails={thumbnails} revision={revision} stamp={stamp} testId={`film-project-thumb-${item}`} />
      {marked ? <span className="film-project-inout" style={{ left: fx(markA), width: `max(2px, calc(${fx(markB)} - ${fx(markA)}))`, background: MARK_BLUE }} data-kit-ui-id="control:project.item.inOut" /> : null}
      {hover != null ? <span className="film-project-scrub" style={{ left: fx(hover), background: MARK_BLUE }} data-testid={`film-project-scrub-${item}`} /> : null}
      <span className="film-project-streams">
        {row.kind === 'sequence' ? <Clapperboard size={11} aria-hidden="true" /> : null}
        {row.hasVideo && row.kind !== 'sequence' ? <Film size={11} aria-hidden="true" /> : null}
        {row.hasAudio ? <AudioLines size={11} aria-hidden="true" /> : null}
      </span>
      {row.offline ? (
        <span className="film-project-offline-band" data-kit-ui-id="control:project.item.offline">
          {phrase(row.offlineText ?? 'Offline')}
        </span>
      ) : null}
      {row.proxy ? (
        <span className="film-project-proxy film-project-proxy-card" data-kit-ui-id="control:project.item.proxy">
          P
        </span>
      ) : null}
    </span>
  )
}
