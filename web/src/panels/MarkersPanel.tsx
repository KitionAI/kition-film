import { memo, useCallback, useMemo, useRef } from 'react'
import { formatTimecode, useKitEditor, type Phrases } from '@kition/kit-editor'
import type { FilmMarker } from '../film'
import { markerColor } from '../timeline/Ruler'
import { Placeholder } from './Placeholder'
import { useDrawsPreview, usePreviewFilm, usePreviewState } from '../dialogs/usePreview'
import { previewMarkers, type PreviewMark } from '../dialogs/previewViews'
import type { PreviewCovers } from '../dialogs/preview'
import { MARKER_COLORS } from '../dialogs/menu'

/** Upstream's `MARKER_FILTER`: each chip stands for the labels that share its marker colour. */
const MARKER_FILTER = MARKER_COLORS

type Invoke = (id: string, params?: Record<string, unknown>) => Promise<unknown>

export type MarkersPanelProps = {
  /** The active sequence's markers, or null without a sequence. */
  markers: readonly FilmMarker[] | null
  /** The active sequence, whose markers a dialog's preview shows here. */
  sequence: number | null
  fps: number
  dropFrame: boolean
  ticksPerSecond: number
  /** The label names the filter hides (`state.inspect` `hidden_marker_colors`). */
  hidden: readonly string[]
  invoke: Invoke
  phrase: Phrases
}

type RowProps = { marker: FilmMarker; fps: number; dropFrame: boolean; phrase: Phrases; onGo: (marker: FilmMarker) => void; onEdit: (marker: FilmMarker) => void; mark?: PreviewMark }

/** Whether two markers draw the same row: the inspect model makes new marker objects on every refresh. */
const sameMarker = (a: FilmMarker, b: FilmMarker) => a.id === b.id && a.start === b.start && a.duration === b.duration && a.kind === b.kind && a.name === b.name && a.color === b.color

/** One marker: its colour bar, name, and start (with its duration, and "Chapter" for a chapter marker). */
const MarkerRow = memo(function MarkerRow({ marker, fps, dropFrame, phrase, onGo, onEdit, mark }: RowProps) {
  const name = marker.name || phrase('Marker')
  let tc = formatTimecode(marker.start, fps, dropFrame)
  if (marker.duration > 0) tc = `${tc}  (${formatTimecode(marker.duration, fps, dropFrame)})`
  if (marker.kind === 'Chapter') tc = phrase('{tc}  Chapter').replace('{tc}', tc)
  return (
    <button type="button" className="film-markers-row" data-preview={mark} data-kit-ui-id="control:markers.row" data-testid={`film-markers-row-${marker.id}`} onClick={() => onGo(marker)} onDoubleClick={() => onEdit(marker)}>
      <span className="film-markers-bar" style={{ background: markerColor(marker.color) }} aria-hidden="true" />
      <span className="film-markers-name">{name}</span>
      <span className="film-markers-time">{tc}</span>
    </button>
  )
}, (before, after) => sameMarker(before.marker, after.marker) && before.mark === after.mark && before.fps === after.fps && before.dropFrame === after.dropFrame && before.phrase === after.phrase && before.onGo === after.onGo && before.onEdit === after.onEdit)

/**
 * Markers (upstream `misc.rs` `markers`): the colour filter row (a chip shows or hides that colour,
 * `markers.filterColors`), then the active sequence's markers the filter shows; a click moves the
 * playhead to a marker's start, and a double-click opens the marker dialog on it (Premiere's;
 * upstream's panel opens none).
 */
export function MarkersPanel({ markers: documentMarkers, sequence, fps, dropFrame, ticksPerSecond, hidden, invoke, phrase }: MarkersPanelProps) {
  const { t } = useKitEditor()
  const hiddenColors = useMemo(() => new Set(hidden.map(markerColor)), [hidden])
  const onGo = useCallback((marker: FilmMarker) => void invoke('playhead.set', { time: Math.round(marker.start * ticksPerSecond) }), [invoke, ticksPerSecond])
  const onEdit = useCallback((marker: FilmMarker) => void invoke('markers.edit', { marker: marker.id }), [invoke])
  // A dialog's markers preview (Task 10): the preview's markers of this sequence, added and
  // changed ones outlined, removed ones faded where they were.
  // It draws the sequence's own markers; the strip lists those of clips and items.
  const coversMarkers = useCallback<PreviewCovers>((_, entry) => entry.ownerKind === 'sequence' && entry.owner === sequence, [sequence])
  const panelRoot = useRef<HTMLDivElement>(null)
  useDrawsPreview('markers', documentMarkers != null, coversMarkers, sequence, panelRoot)
  const previewState = usePreviewState()
  const loaded = usePreviewFilm(documentMarkers != null && previewState.open && previewState.kinds.includes('markers'))
  const preview = useMemo(() => (loaded && documentMarkers && loaded.film.activeSequence === sequence ? previewMarkers(documentMarkers, loaded.film.markers, loaded.diff, sequence) : null), [loaded, documentMarkers, sequence])
  const markers = preview?.markers ?? documentMarkers
  const shown = useMemo(() => (markers ?? []).filter((marker) => !hiddenColors.has(markerColor(marker.color))), [markers, hiddenColors])
  if (!markers) return <Placeholder text={phrase('(no sequence)')} panel="markers" />
  return (
    <div ref={panelRoot} className="film-markers" data-testid="film-markers">
      <div className="film-markers-filter">
        {MARKER_FILTER.map((label) => {
          const on = !hiddenColors.has(markerColor(label))
          return (
            <button
              key={label}
              type="button"
              className="film-markers-chip"
              data-on={on ? 'true' : 'false'}
              aria-pressed={on}
              aria-label={t(on ? 'markers.filterShown' : 'markers.filterHidden', { color: phrase(label) })}
              title={phrase('Show or hide {color} markers').replace('{color}', phrase(label))}
              style={{ ['--film-marker' as string]: markerColor(label) }}
              data-kit-ui-id="control:markers.filter"
              data-testid={`film-markers-filter-${label}`}
              onClick={() => void invoke('markers.filterColors', { color: label, visible: !on })}
            />
          )
        })}
        {preview ? (
          <span className="film-preview-badge film-markers-preview-badge" data-testid="film-markers-preview-badge">
            {phrase('Preview')}
          </span>
        ) : null}
      </div>
      <div className="film-markers-list">
        {shown.map((marker) => (
          <MarkerRow key={marker.id} marker={marker} fps={fps} dropFrame={dropFrame} phrase={phrase} onGo={onGo} onEdit={onEdit} mark={preview?.marks.get(marker.id)} />
        ))}
        {markers.length === 0 ? (
          <div className="film-markers-empty">{phrase('No markers. Press M to add one.')}</div>
        ) : shown.length === 0 ? (
          <div className="film-markers-empty">{phrase('All markers are hidden by the colour filter.')}</div>
        ) : null}
      </div>
    </div>
  )
}
