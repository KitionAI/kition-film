import { memo, useEffect, useMemo, useState } from 'react'
import { formatTimecode, type KitEngine, type Phrases } from '@kition/kit-editor'
import { projectItems, type FilmInfo } from '../film'
import { useProgramTime, type Playback } from '../session/playback'
import { fpsLabel, itemsAtPlayhead } from './info'

/** What the `itemInfo` extra answers about a project item. */
type ItemInfo = { item: number; name: string; type: string; video: string | null; codec: string | null; audio: string | null; duration: string }

export type InfoPanelProps = {
  film: FilmInfo | null
  doc: KitEngine | null
  revision: number | null
  /** The first item selected in the Project panel (upstream's `project_selection.first()`), or null. */
  item: number | null
  playback: Playback
  phrase: Phrases
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="film-info-line">
      <span className="film-info-key">{label}</span>
      <span className="film-info-value">{value}</span>
    </div>
  )
}

/** The selected project item's part: read from the engine when the item or the revision changes. */
const ItemPart = memo(function ItemPart({ doc, item, revision, phrase }: { doc: KitEngine | null; item: number | null; revision: number | null; phrase: Phrases }) {
  const [info, setInfo] = useState<ItemInfo | null>(null)
  useEffect(() => {
    let open = true
    if (!doc || item == null) {
      setInfo(null)
      return undefined
    }
    doc
      .invoke<string>('itemInfo', item)
      .then((answer) => {
        if (open) setInfo(JSON.parse(answer) as ItemInfo)
      })
      .catch(() => {
        if (open) setInfo(null)
      })
    return () => {
      open = false
    }
  }, [doc, item, revision])
  if (!info || info.item !== item) return null
  return (
    <div className="film-info-part" data-testid="film-info-item">
      <div className="film-info-title">{info.name}</div>
      <Line label={phrase('Type:')} value={phrase(info.type)} />
      {info.video != null ? <Line label={phrase('Video:')} value={info.video} /> : null}
      {info.codec != null ? <Line label={phrase('Codec:')} value={info.codec} /> : null}
      {info.audio != null ? <Line label={phrase('Audio:')} value={info.audio} /> : null}
      <Line label={phrase('Duration:')} value={info.duration} />
      {/* Upstream draws a separator after the item's lines, whatever follows. */}
      <div className="film-info-separator" />
    </div>
  )
})

/** The active sequence's part, following the program clock (one render per animation frame while it plays). */
function SequencePart({ film, playback, phrase }: { film: FilmInfo; playback: Playback; phrase: Phrases }) {
  const seconds = useProgramTime(playback, film.playhead)
  // The bins change with a revision, not with the playhead: the name is not looked up every frame.
  const items = useMemo(() => projectItems(film.root), [film.root])
  const name = film.activeSequence != null ? (items.get(film.activeSequence)?.name ?? '') : ''
  return (
    <div className="film-info-part" data-testid="film-info-sequence">
      <div className="film-info-title">{name}</div>
      <Line label={phrase('Settings:')} value={`${film.width}x${film.height} · ${fpsLabel(film.fps)} fps · ${film.sampleRate} Hz`} />
      <Line label={phrase('Playhead:')} value={formatTimecode(seconds, film.fps, film.dropFrame)} />
      {itemsAtPlayhead(film.tracks, seconds).map((row) => (
        <Line key={`${row.phrase}${row.n}`} label={phrase(row.phrase).replace('{n}', String(row.n))} value={row.name} />
      ))}
    </div>
  )
}

/**
 * Info (upstream `misc.rs` `info`): the first item selected in the Project panel (its name, type,
 * video and codec, audio, and duration), then the active sequence (its name, settings, playhead,
 * and the clip each track plays there).
 */
export function InfoPanel({ film, doc, revision, item, playback, phrase }: InfoPanelProps) {
  return (
    <div className="film-info" data-testid="film-info">
      <ItemPart doc={doc} item={item} revision={revision} phrase={phrase} />
      {film && film.activeSequence != null ? <SequencePart film={film} playback={playback} phrase={phrase} /> : null}
    </div>
  )
}
