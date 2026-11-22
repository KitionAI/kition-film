// What the Timeline and the Markers panel draw of a dialog's preview (Task 10): the preview's
// sequence (`previewInspect`) laid out with the document's own objects wherever the diff
// (`previewDiff`, Task 3's "As shipped") names nothing, so the memoized clips and rows draw
// again only where it does; and the diff's marks on what is drawn. React-free, so `node --test`
// runs it. Imports carry `.ts` so `node --test` loads this module as it is.
import { projectItems, type FilmClip, type FilmInfo, type FilmMarker, type FilmTrack } from '../film.ts'
import type { DiffEntry, PreviewDiff } from './preview.ts'
import type { PreviewHighlight, PreviewKind } from './registry.ts'

/**
 * How a preview marks what it changed: `added` (a dashed accent outline), `removed` (faded and
 * struck through), `changed` (outlined at its new place, a ghost at its old place when it moved).
 */
export type PreviewMark = 'added' | 'removed' | 'changed'

/** The diff's marks on one sequence: its tracks, its clips (with a change's fields), and its own markers. */
export type SequenceMarks = {
  tracks: ReadonlyMap<number, PreviewMark>
  clips: ReadonlyMap<number, { mark: PreviewMark; fields?: readonly string[] }>
  markers: ReadonlyMap<number, PreviewMark>
}

/**
 * The diff's marks on `sequence`. Tracks, clips, and captions carry their sequence (a duplicated
 * sequence keeps its tracks' and clips' ids), so only that sequence's count: a clip Nest moves into
 * a new sequence is removed here and added there. Markers count when the sequence owns them.
 */
export function sequenceMarks(diff: PreviewDiff | null, sequence: number | null): SequenceMarks {
  const tracks = new Map<number, PreviewMark>()
  const clips = new Map<number, { mark: PreviewMark; fields?: readonly string[] }>()
  const markers = new Map<number, PreviewMark>()
  if (!diff || sequence == null) return { tracks, clips, markers }
  const each = (part: { added: DiffEntry[]; removed: DiffEntry[]; changed?: DiffEntry[] } | undefined, keep: (entry: DiffEntry) => boolean, set: (entry: DiffEntry, mark: PreviewMark) => void) => {
    if (!part) return
    for (const entry of part.added) if (keep(entry)) set(entry, 'added')
    for (const entry of part.removed) if (keep(entry)) set(entry, 'removed')
    for (const entry of part.changed ?? []) if (keep(entry)) set(entry, 'changed')
  }
  const here = (entry: DiffEntry) => entry.sequence === sequence
  each(diff.tracks, here, (entry, mark) => tracks.set(entry.id, mark))
  each(diff.clips, here, (entry, mark) => clips.set(entry.id, mark === 'changed' ? { mark, fields: entry.fields ?? [] } : { mark }))
  each(diff.markers, (entry) => entry.ownerKind === 'sequence' && entry.owner === sequence, (entry, mark) => markers.set(entry.id, mark))
  return { tracks, clips, markers }
}

/**
 * `shown` (the preview's list) with what `removed` names of `document` put back where it was:
 * each right after the nearest element before it in `document` that is in the list, else first.
 */
export function withRemoved<T>(shown: readonly T[], document: readonly T[], key: (value: T) => string | number, removed: (value: T) => boolean): T[] {
  const result = [...shown]
  const at = new Map(result.map((value, index) => [key(value), index]))
  let previous: string | number | null = null
  for (const value of document) {
    const id = key(value)
    if (removed(value) && !at.has(id)) {
      const index = previous != null && at.has(previous) ? at.get(previous)! + 1 : 0
      result.splice(index, 0, value)
      at.clear()
      result.forEach((each, place) => at.set(key(each), place))
    }
    if (at.has(id)) previous = id
  }
  return result
}

/** A clip as it was (`was`, the old place of a clip the preview moves or resizes) or as it goes (`removed`), drawn in its track's lane. */
export type PreviewGhost = { kind: 'removed' | 'was'; clip: FilmClip }

/** What the Timeline draws while a preview is open (`previewTimeline`). */
export type TimelinePreview = {
  /** What the Timeline lays out, with its own layout code: the preview's sequence, or the document's. */
  film: FilmInfo
  /** The sequence shown. */
  sequence: number | null
  /** Marks on the drawn clips (`added`, `changed`), the tracks (`removed` ones are kept in place), and the markers. */
  clips: ReadonlyMap<number, PreviewMark>
  tracks: ReadonlyMap<number, PreviewMark>
  markers: ReadonlyMap<number, PreviewMark>
  /** The ghosts in each track's lane, by track. */
  ghosts: ReadonlyMap<number, readonly PreviewGhost[]>
  /** The preview's clip selection, highlighted (dashed) under the `selection` kind; null without it. */
  selected: ReadonlySet<number> | null
  /** The markers the preview highlights under the `selection` kind (Find's marker matches); null without them. */
  selectedMarkers: ReadonlySet<number> | null
}

/** Each document clip's ghosts, made once: a ghost the next preview keeps is the same object, so its lane does not draw it again. */
const GHOSTS = new WeakMap<FilmClip, { was?: PreviewGhost; removed?: PreviewGhost }>()
function ghostOf(kind: PreviewGhost['kind'], clip: FilmClip): PreviewGhost {
  const made = GHOSTS.get(clip) ?? {}
  const found = made[kind]
  if (found) return found
  const ghost = { kind, clip }
  made[kind] = ghost
  GHOSTS.set(clip, made)
  return ghost
}

/** Fields that move a clip on the Timeline: its old place is ghosted. */
const PLACE = new Set(['start', 'duration', 'track'])

const sameMarker = (a: FilmMarker, b: FilmMarker) => a.id === b.id && a.start === b.start && a.duration === b.duration && a.kind === b.kind && a.name === b.name && a.comment === b.comment && a.color === b.color

/**
 * A sequence's markers as a preview shows them: the preview's, each unchanged one the document's
 * own object, with the removed ones put back where they were, and their marks.
 */
export function previewMarkers(document: readonly FilmMarker[], preview: readonly FilmMarker[], diff: PreviewDiff | null, sequence: number | null) {
  const marks = new Map(sequenceMarks(diff, sequence).markers)
  const before = new Map(document.map((marker) => [marker.id, marker]))
  const shown = preview.map((marker) => {
    const was = before.get(marker.id)
    if (!was) {
      if (!marks.has(marker.id)) marks.set(marker.id, 'added')
      return marker
    }
    if (sameMarker(was, marker)) return marks.has(marker.id) ? marker : was
    if (!marks.has(marker.id)) marks.set(marker.id, 'changed')
    return marker
  })
  const kept = new Set(preview.map((marker) => marker.id))
  const markers = withRemoved(shown, document, (marker) => marker.id, (marker) => !kept.has(marker.id))
  for (const marker of document) if (!kept.has(marker.id)) marks.set(marker.id, 'removed')
  return { markers, marks: marks as ReadonlyMap<number, PreviewMark> }
}

/**
 * Whether a preview only highlights (a `selection` preview with its `highlight`, Find's): the
 * Timeline draws the document with the highlight and reads no copy (`previewInspect`) for it.
 */
export const highlightsOnly = (kinds: readonly PreviewKind[], highlight: PreviewHighlight | null) => highlight != null && kinds.length > 0 && kinds.every((kind) => kind === 'selection')

/**
 * What the Timeline draws of a preview with `kinds` open, from the document's `doc` and the
 * preview's `preview` (both `describe`d) and the diff:
 * - `timeline`: the preview's sequence laid out. A clip or track the diff does not name is the
 *   document's own object (a memoized clip does not draw again); added ones are marked, changed
 *   ones drawn at their new place (with a ghost of their old place when it moved), removed clips
 *   ghosted in their lane, and removed tracks kept where they were with their clips as ghosts.
 * - `markers`: the preview's markers, the removed ones kept, each marked.
 * - `selection`: the preview's clip selection, highlighted beside the real one; with a
 *   `highlight` (Find's every match), its clips and markers in its place.
 * - `copies` (Simplify Sequence): the preview's new sequence is a copy of the shown one, compared
 *   with it page-side, as the diff lists all of a new sequence as added.
 *
 * The clips are drawn selected by the document's selection, never the preview's, and the undo
 * state and the playhead are the document's.
 */
export function previewTimeline(doc: FilmInfo, preview: FilmInfo, diff: PreviewDiff | null, kinds: readonly PreviewKind[], options: { copies?: boolean; highlight?: PreviewHighlight | null } = {}): TimelinePreview {
  const timeline = kinds.includes('timeline')
  const sequence = timeline ? (preview.activeSequence ?? doc.activeSequence) : doc.activeSequence
  const sameSequence = preview.activeSequence === doc.activeSequence
  // A new sequence made as a copy of the shown one (Simplify Sequence) is compared with it, its
  // tracks and clips under the ids of the source's they were copied from.
  const copy = timeline && options.copies === true && copiesShown(doc, preview, diff)
  if (copy) preview = copyOnSource(doc, preview)
  // The document as it is in the shown sequence (or the copy's source); null when the preview shows another one.
  const before = doc.activeSequence === sequence || copy ? doc : null
  const marks = copy ? copyMarks(doc, preview) : sequenceMarks(diff, sequence)
  const selection = new Set(doc.selection)
  const clipMarks = new Map<number, PreviewMark>()
  const trackMarks = new Map<number, PreviewMark>()
  const ghosts = new Map<number, PreviewGhost[]>()
  const ghost = (track: number, value: PreviewGhost) => ghosts.set(track, [...(ghosts.get(track) ?? []), value])

  let tracks = doc.tracks
  if (timeline) {
    const docTracks = new Map((before?.tracks ?? []).map((track) => [track.id, track]))
    const docClips = new Map((before?.tracks ?? []).flatMap((track) => track.clips.map((clip) => [clip.id, { clip, track: track.id }] as const)))
    const placed = (track: FilmTrack): FilmTrack => {
      const was = docTracks.get(track.id)
      const clips = track.clips.map((clip) => {
        const mark = marks.clips.get(clip.id)
        const old = docClips.get(clip.id)
        if (!mark && old && old.track === track.id) return old.clip
        clipMarks.set(clip.id, mark?.mark === 'added' || !old ? 'added' : 'changed')
        if (old && (mark?.fields ?? ['start', 'duration', 'track']).some((field) => PLACE.has(field)) && (old.clip.start !== clip.start || old.clip.duration !== clip.duration || old.track !== track.id)) ghost(old.track, ghostOf('was', old.clip))
        const selected = selection.has(clip.id)
        return clip.selected === selected ? clip : { ...clip, selected }
      })
      const mark = marks.tracks.get(track.id) ?? (was ? undefined : 'added')
      if (mark) trackMarks.set(track.id, mark)
      if (was && !mark && clips.length === was.clips.length && clips.every((clip, index) => clip === was.clips[index]) && sameTransitions(was, track)) return was
      return { ...track, clips }
    }
    const shownIds = new Set(preview.tracks.map((track) => track.id))
    const merge = (kind: FilmTrack['kind']) =>
      withRemoved(
        preview.tracks.filter((track) => track.kind === kind).map(placed),
        (before?.tracks ?? []).filter((track) => track.kind === kind),
        (track) => track.id,
        (track) => !shownIds.has(track.id),
      )
    tracks = [...merge('video'), ...merge('audio')].map((track) => {
      if (shownIds.has(track.id)) return track
      // A deleted track: kept where it was, struck through, its clips ghosts.
      trackMarks.set(track.id, 'removed')
      for (const clip of track.clips) ghost(track.id, ghostOf('removed', clip))
      return { ...track, clips: [] }
    })
    // Clips gone from the shown sequence (deleted, or moved into another one), in their lanes.
    const shownClips = new Set(preview.tracks.flatMap((track) => track.clips.map((clip) => clip.id)))
    for (const [id, old] of docClips) {
      if (shownClips.has(id) || !shownIds.has(old.track)) continue
      ghost(old.track, ghostOf('removed', old.clip))
    }
  }

  let markers = timeline ? preview.markers : doc.markers
  let markerMarks: ReadonlyMap<number, PreviewMark> = new Map()
  if (kinds.includes('markers') && (timeline || sameSequence)) {
    const merged = previewMarkers(before?.markers ?? [], preview.markers, diff, sequence)
    markers = merged.markers
    markerMarks = merged.marks
  }
  const selects = kinds.includes('selection') && (timeline || sameSequence)
  const highlight = selects ? (options.highlight ?? null) : null
  const selected = selects ? new Set(highlight?.clips ?? preview.selection) : null
  const selectedMarkers = highlight?.markers?.length ? new Set(highlight.markers) : null
  const base = timeline ? preview : doc
  const film: FilmInfo =
    tracks === doc.tracks && markers === doc.markers && base === doc
      ? doc
      : {
          ...base,
          tracks,
          markers,
          selection: doc.selection,
          playhead: doc.playhead,
          duration: Math.max(base.duration, before?.duration ?? 0),
          canUndo: doc.canUndo,
          canRedo: doc.canRedo,
          root: preview.root ?? doc.root,
        }
  return { film, sequence, clips: clipMarks, tracks: trackMarks, markers: markerMarks, ghosts, selected, selectedMarkers }
}

/**
 * Whether the preview shows a sequence it adds, as a dialog that copies the shown sequence
 * (`copiesSequence`, Simplify Sequence) makes: the copy, compared with the document's shown one.
 */
export function copiesShown(doc: FilmInfo, preview: FilmInfo, diff: PreviewDiff | null): boolean {
  if (preview.activeSequence == null || preview.activeSequence === doc.activeSequence) return false
  return (diff?.sequences?.added ?? []).some((entry) => entry.id === preview.activeSequence)
}

/** What a copy leaves of a clip as it was (Simplify Sequence moves, drops, and strips clips; it never retimes their source). */
const copiedClip = (clip: FilmClip) => `${clip.item}|${clip.sourceIn}|${clip.duration}|${clip.speed}|${clip.reverse}`

/**
 * The preview's copy of the document's shown sequence with each track and clip under the id of
 * the source's it was copied from. The engine gives a copy ids of its own (ids are project-wide;
 * `fresh_sequence`), so the Timeline pairs them here: tracks by kind and name, in order (a copy
 * only drops tracks); clips by what copying leaves alone (`copiedClip`), first come first paired;
 * a link follows its clips. Whatever pairs with nothing keeps its own id, so it shows as added.
 */
export function copyOnSource(doc: FilmInfo, preview: FilmInfo): FilmInfo {
  const trackIds = new Map<number, number>()
  for (const kind of ['video', 'audio'] as const) {
    const source = doc.tracks.filter((track) => track.kind === kind)
    let next = 0
    for (const track of preview.tracks.filter((each) => each.kind === kind)) {
      const at = source.findIndex((each, index) => index >= next && each.name === track.name)
      if (at < 0) continue
      trackIds.set(track.id, source[at].id)
      next = at + 1
    }
  }
  const waiting = new Map<string, FilmClip[]>()
  for (const track of doc.tracks) for (const clip of track.clips) waiting.set(copiedClip(clip), [...(waiting.get(copiedClip(clip)) ?? []), clip])
  const clipIds = new Map<number, number>()
  const links = new Map<number, number | null>()
  for (const track of preview.tracks)
    for (const clip of track.clips) {
      const was = waiting.get(copiedClip(clip))?.shift()
      if (!was) continue
      clipIds.set(clip.id, was.id)
      if (clip.link != null && !links.has(clip.link)) links.set(clip.link, was.link)
    }
  const tracks = preview.tracks.map((track) => ({
    ...track,
    id: trackIds.get(track.id) ?? track.id,
    clips: track.clips.map((clip) => ({ ...clip, id: clipIds.get(clip.id) ?? clip.id, link: clip.link == null ? null : (links.get(clip.link) ?? clip.link) })),
  }))
  const selection = preview.selection.map((id) => clipIds.get(id) ?? id)
  return { ...preview, tracks, selection }
}

/** A clip's fields a copy may change, by the diff's field names (`start`, `effects`, …). */
const CLIP_FIELDS: ReadonlyArray<readonly [string, (clip: FilmClip) => unknown]> = [
  ['start', (clip) => clip.start],
  ['duration', (clip) => clip.duration],
  ['sourceIn', (clip) => clip.sourceIn],
  ['speed', (clip) => clip.speed],
  ['reverse', (clip) => clip.reverse],
  ['enabled', (clip) => clip.enabled],
  ['link', (clip) => clip.link],
  ['name', (clip) => clip.name],
  ['gain', (clip) => clip.gainDb],
  ['effects', (clip) => JSON.stringify(clip.effects)],
]

/**
 * The marks on a copy of the shown sequence, compared with its source page-side (the diff lists
 * every track and clip of a new sequence as added): a clip in both whose fields differ is
 * changed, with those fields (a moved one is ghosted at its old place); one only the copy has is
 * added. Tracks and clips the copy dropped are found where the Timeline lays out the removed ones.
 */
function copyMarks(doc: FilmInfo, preview: FilmInfo): SequenceMarks {
  const clips = new Map<number, { mark: PreviewMark; fields?: readonly string[] }>()
  const before = new Map(doc.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, { clip, track: track.id }] as const)))
  for (const track of preview.tracks)
    for (const clip of track.clips) {
      const old = before.get(clip.id)
      if (!old) {
        clips.set(clip.id, { mark: 'added' })
        continue
      }
      const fields = CLIP_FIELDS.filter(([, read]) => read(old.clip) !== read(clip)).map(([field]) => field)
      if (old.track !== track.id) fields.push('track')
      if (fields.length) clips.set(clip.id, { mark: 'changed', fields })
    }
  return { tracks: new Map(), clips, markers: new Map() }
}

const sameTransitions = (a: FilmTrack, b: FilmTrack) =>
  a.transitions.length === b.transitions.length && a.transitions.every((transition, index) => transition.id === b.transitions[index].id && transition.start === b.transitions[index].start && transition.duration === b.transitions[index].duration && transition.effect === b.transitions[index].effect)

/** Item fields that change what an item's picture shows. */
const PICTURE_FIELDS = new Set(['media', 'contents', 'settings', 'interpret', 'offline', 'proxy', 'kind', 'parent', 'range', 'other'])

/**
 * The items whose pictures come from the preview (`previewItemFrame`): those it adds (a matte, a
 * subclip, a nest's sequence) and those whose picture it changes (a matte's colour, a sequence's
 * contents, a relink). The others keep the document's cached frames.
 */
export function previewPictureItems(diff: PreviewDiff | null): ReadonlySet<number> {
  const items = new Set<number>()
  if (!diff) return items
  for (const entry of [...(diff.items?.added ?? []), ...(diff.sequences?.added ?? [])]) items.add(entry.id)
  for (const entry of [...(diff.items?.changed ?? []), ...(diff.sequences?.changed ?? [])]) if ((entry.fields ?? []).some((field) => PICTURE_FIELDS.has(field))) items.add(entry.id)
  return items
}

/**
 * What a press on the tracks may send while a preview is open: selecting clips the document has
 * (the dialog follows the selection), or nothing. Every edit, and a clip only the preview has, is
 * dropped: the Timeline's editing gestures are off over a preview.
 */
export function previewCommands<C extends { id: string; params: Record<string, unknown> }>(commands: readonly C[], documentClips: ReadonlySet<number>): C[] {
  return commands.filter((command) => command.id === 'timeline.select' && ((command.params.clips as number[] | undefined) ?? []).every((id) => documentClips.has(id)))
}

/** The items the preview has and the document does not (a nest's sequence, a new matte or subclip): they have no peaks of the document's to draw. */
export function previewOnlyItems(doc: FilmInfo, preview: FilmInfo): ReadonlySet<number> {
  const before = projectItems(doc.root)
  return new Set([...projectItems(preview.root).keys()].filter((item) => !before.has(item)))
}

/**
 * The clips a press may select while a preview is open: the document's, while the Timeline shows
 * the document's sequence (or no timeline preview); none while it shows another one (New Sequence,
 * a duplicate), whose clips may share the document's ids but are the copy's.
 */
export function previewClickable(doc: FilmInfo, preview: TimelinePreview | null): ReadonlySet<number> {
  if (preview && preview.sequence !== doc.activeSequence) return new Set()
  return new Set(doc.tracks.flatMap((track) => track.clips.map((clip) => clip.id)))
}
