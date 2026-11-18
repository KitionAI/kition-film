import { memo } from 'react'
import type { PreviewGhost } from '../dialogs/previewViews'

type Props = {
  ghosts: readonly PreviewGhost[] | undefined
  pps: number
  rowHeight: number
  /** The part of the lane in view, in seconds: ghosts outside it are not drawn. */
  from: number
  to: number
  colors: Record<string, string>
}

/**
 * A lane's preview ghosts over its clips (Task 10): a clip the preview removes (deleted, or moved
 * out of the shown sequence), faded and struck through, and the old place of a clip it moves or
 * resizes, as a dashed outline. Plain boxes on the lane's scrolling layer, not clips: they take no
 * press, and drawing them draws no clip again.
 */
export const PreviewGhosts = memo(function PreviewGhosts({ ghosts, pps, rowHeight, from, to, colors }: Props) {
  if (!ghosts?.length) return null
  const height = Math.max(1, rowHeight - 2)
  return (
    <>
      {ghosts.map(({ kind, clip }) => {
        if (clip.start + clip.duration < from || clip.start > to) return null
        const width = Math.max(1, clip.duration * pps)
        return (
          <span
            key={`${kind}:${clip.id}`}
            className="film-tl-ghost"
            data-preview={kind}
            style={{ transform: `translateX(${clip.start * pps}px)`, width, height, ['--film-ghost' as string]: colors[clip.label.toLowerCase()] ?? '#5645d4' }}
            title={clip.name}
            data-testid={`film-clip-${kind}-${clip.id}`}
          >
            {kind === 'removed' && width > 24 ? <span className="film-clip-name">{clip.name}</span> : null}
          </span>
        )
      })}
    </>
  )
}, (before, after) => {
  // The lane's ghosts compare one by one: the next preview keeps the ghosts it shares (`previewTimeline`).
  const a = before.ghosts ?? []
  const b = after.ghosts ?? []
  return before.pps === after.pps && before.rowHeight === after.rowHeight && before.from === after.from && before.to === after.to && before.colors === after.colors && a.length === b.length && a.every((ghost, index) => ghost === b[index])
})
