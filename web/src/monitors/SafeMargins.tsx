import { forwardRef } from 'react'
import { safeMargins, type Box, type SafeAreaPercents } from './model'

/**
 * Safe margins over a monitor's picture (upstream `show`): the action and title safe areas (90%
 * and 80% by default; the project's on the Program monitor), and a cross at the centre. With no
 * `box`, the caller places it (the Program monitor moves it with the canvas's view, outside
 * React). `preview`: a dialog's preview of other areas (Project Settings), marked as changed.
 */
export const SafeMargins = forwardRef<HTMLDivElement, { box?: Box; testId: string; areas?: SafeAreaPercents; preview?: boolean }>(function SafeMargins({ box, testId, areas, preview }, ref) {
  const place = box ? { left: box.x, top: box.y, width: box.width, height: box.height } : undefined
  const { action, title } = safeMargins({ x: 0, y: 0, width: 100, height: 100 }, areas)
  const percent = (part: Box) => ({ left: `${part.x}%`, top: `${part.y}%`, width: `${part.width}%`, height: `${part.height}%` })
  return (
    <div ref={ref} className="film-safe-margins" style={place} data-testid={testId} data-preview={preview ? 'changed' : undefined} aria-hidden="true">
      <span className="film-safe-action" style={percent(action)} />
      <span className="film-safe-title" style={percent(title)} />
      <span className="film-safe-cross" />
    </div>
  )
})
