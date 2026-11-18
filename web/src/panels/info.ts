/**
 * The Info panel's lines (upstream `misc.rs` `info`) that do not need React, pure so `node --test`
 * runs them.
 */

/** Upstream's `FrameRate::label`: a whole rate as it is, any other to three places without trailing zeros. */
export function fpsLabel(fps: number) {
  if (Number.isInteger(fps)) return String(fps)
  return fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

type TrackLike = { kind: 'video' | 'audio'; clips: ReadonlyArray<{ name: string; start: number; duration: number }> }

/**
 * Upstream's `Video {n}:` and `Audio {n}:` lines (the phrase and its number): the name of the clip each track plays at `seconds`
 * (empty where it plays none). `tracks` is the editor's order, the top video track first, so the
 * video lines read from the top track down, as upstream's `video_tracks.iter().rev()`.
 */
export function itemsAtPlayhead(tracks: readonly TrackLike[], seconds: number) {
  const video = tracks.filter((track) => track.kind === 'video')
  const audio = tracks.filter((track) => track.kind === 'audio')
  const at = (track: TrackLike) => track.clips.find((clip) => clip.start <= seconds && seconds < clip.start + clip.duration)?.name ?? ''
  return [
    ...video.map((track, index) => ({ phrase: 'Video {n}:', n: video.length - index, name: at(track) })),
    ...audio.map((track, index) => ({ phrase: 'Audio {n}:', n: index + 1, name: at(track) })),
  ]
}
