// Imports carry `.ts` so `node --test` loads this module as it is.
import type { FilmTrack } from '../film.ts'

/**
 * Sequence ▸ Close Gap from the menu, which names no track (the engine's `sequence.closeGap` needs
 * one): the track whose gap the playhead is in. A selected clip's track first, then the video
 * tracks from V1 up, then the audio tracks; a locked track, or one with a clip at the playhead or
 * none after it, has no gap there. Times are seconds; `frame` is one frame, the tolerance at a
 * clip's edge. Null when no track has a gap at the playhead.
 */
export function closeGapTrack(tracks: readonly FilmTrack[], playhead: number, frame: number): number | null {
  const half = Math.max(0, frame) / 2
  const gapAt = (track: FilmTrack) =>
    !track.locked &&
    !track.clips.some((clip) => clip.start - half <= playhead && playhead < clip.start + clip.duration - half) &&
    track.clips.some((clip) => clip.start > playhead - half)
  const selected = tracks.filter((track) => track.clips.some((clip) => clip.selected))
  const ordered = [...selected, ...tracks.filter((track) => track.kind === 'video'), ...tracks.filter((track) => track.kind === 'audio')]
  return ordered.find(gapAt)?.id ?? null
}
