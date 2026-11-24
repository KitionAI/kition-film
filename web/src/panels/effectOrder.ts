/**
 * Reordering a clip's standard effects in Effect Controls (`effects.move`): the fixed effects
 * (Motion, Opacity, Volume…) keep their places, so an effect moves only among the standard ones
 * next to it. Pure, so `node --test` runs it.
 */

/** An effect row as these helpers read it: its index on the clip, whether it is fixed, and (for a drag) its row's top and height on screen. */
export type OrderRow = { index: number; intrinsic: boolean; top?: number; height?: number }

/** The index an effect at `index` takes moved one place up (`-1`) or down (`1`) among the standard effects, or null at an end or for a fixed one. */
export function neighbourIndex(rows: readonly OrderRow[], index: number, step: -1 | 1): number | null {
  const self = rows.find((row) => row.index === index)
  if (!self || self.intrinsic) return null
  const next = rows.find((row) => row.index === index + step)
  return next && !next.intrinsic ? next.index : null
}

/**
 * Where the effect at `from` lands when it is dragged to `y` (upstream's drop between rows): the
 * standard effects' rows in order, the drop before the first whose middle is below `y`, as the
 * index `effects.move` takes (`to`); null where it would not move, and the y of the line drawn.
 */
export function dropIndex(rows: readonly OrderRow[], from: number, y: number): { to: number | null; lineY: number } | null {
  const movable = rows.filter((row) => !row.intrinsic && row.top != null && row.height != null).sort((a, b) => a.index - b.index)
  if (!movable.some((row) => row.index === from)) return null
  const before = movable.find((row) => y < (row.top ?? 0) + (row.height ?? 0) / 2)
  const last = movable[movable.length - 1]
  const lineY = before ? (before.top ?? 0) : (last.top ?? 0) + (last.height ?? 0)
  // Inserting before `before` (or after the last): the index it ends up at once taken out of its place.
  const to = before ? (before.index > from ? before.index - 1 : before.index) : last.index
  return { to: to === from ? null : to, lineY }
}
