// Imports carry `.ts` and the JSON its import attribute so `node --test` loads this module as it is.
import {
  ArrowLeftRightIcon as ArrowLeftRight,
  ArrowLeftToLineIcon as ArrowLeftToLine,
  ArrowRightToLineIcon as ArrowRightToLine,
  BaselineIcon as Baseline,
  ChevronsRightLeftIcon as ChevronsRightLeft,
  CircleIcon as Circle,
  FoldHorizontalIcon as FoldHorizontal,
  HandIcon as Hand,
  MousePointer2Icon as MousePointer2,
  MoveHorizontalIcon as MoveHorizontal,
  MusicIcon as Music,
  PenToolIcon as PenTool,
  ScissorsIcon as Scissors,
  SquareIcon as Square,
  TypeIcon as Type,
  UnfoldHorizontalIcon as UnfoldHorizontal,
  ZoomInIcon as ZoomIn,
  type IconComponent,
} from '@kition/tessera/icons/react'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }

/** What the Hand and Zoom tools drive: the timeline's view (scroll and zoom), not an engine command. */
export const VIEW = 'view'

/**
 * One of upstream's 17 tools (`state.rs` `Tool`): its manifest id (`Razor`), upstream's English
 * label (shown through `phrase`), its group and slot in the Tools panel (`Tool::groups`), its key
 * (`Tool::shortcut`, `Shift+A`, or null), a Tessera icon, and the engine commands its gestures run
 * (or `VIEW`).
 */
export type FilmTool = { id: string; label: string; group: number; slot: number; shortcut: string | null; icon: IconComponent; commands: readonly string[] }

const ICONS: Readonly<Record<string, IconComponent>> = {
  Selection: MousePointer2,
  TrackSelectForward: ArrowRightToLine,
  TrackSelectBackward: ArrowLeftToLine,
  Ripple: ChevronsRightLeft,
  Rolling: FoldHorizontal,
  RateStretch: MoveHorizontal,
  Remix: Music,
  Razor: Scissors,
  Slip: UnfoldHorizontal,
  Slide: ArrowLeftRight,
  Pen: PenTool,
  Rectangle: Square,
  Ellipse: Circle,
  Hand,
  Zoom: ZoomIn,
  Type,
  VerticalType: Baseline,
}

/** The commands each tool's gestures run (the timeline's, Task 15; the Program monitor's, Task 17). Remix's gesture is wave 3. */
const COMMANDS: Readonly<Record<string, readonly string[]>> = {
  Selection: ['timeline.move', 'timeline.trim'],
  TrackSelectForward: ['timeline.select'],
  TrackSelectBackward: ['timeline.select'],
  Ripple: ['timeline.trim'],
  Rolling: ['timeline.roll'],
  RateStretch: ['timeline.rateStretch'],
  Remix: ['clip.remix'],
  Razor: ['timeline.razor'],
  Slip: ['timeline.slip'],
  Slide: ['timeline.slide'],
  Pen: ['graphics.newShape'],
  Rectangle: ['graphics.newShape'],
  Ellipse: ['graphics.newShape'],
  Hand: [VIEW],
  Zoom: [VIEW],
  Type: ['graphics.newText'],
  VerticalType: ['graphics.newVerticalText'],
}

/** Upstream's 17 tools in `Tool::ALL` order (the parity manifest's), which is also group and slot order. */
export const FILM_TOOLS: readonly FilmTool[] = upstream.tools.map((tool) => ({
  id: tool.id,
  label: tool.label,
  group: tool.group,
  slot: tool.slot,
  shortcut: tool.shortcut,
  icon: ICONS[tool.id],
  commands: COMMANDS[tool.id] ?? [],
}))

/** The tool upstream starts with (`Tool::default`). */
export const DEFAULT_TOOL = 'Selection'

/** `Tool::groups`: the Tools panel's 8 buttons, each its tools in slot order. */
export function toolGroups(): FilmTool[][] {
  const groups: FilmTool[][] = []
  for (const tool of FILM_TOOLS) (groups[tool.group] ??= []).push(tool)
  return groups.map((group) => [...group].sort((a, b) => a.slot - b.slot))
}

/** The Tools panel's geometry: a group's 28 px button, the 4 px between buttons, and 4 px above and below the column. */
export const TOOL_BUTTON = 28
export const TOOL_GAP = 4
export const TOOL_PADDING = 4

/**
 * How many of the 8 groups a Tools frame `height` px tall draws: upstream draws a group, then
 * stops (`break`) once the next one would not fit, so the first is always drawn. The groups past
 * that are neither drawn nor reachable by pointer; their keys still choose them.
 */
export function groupsThatFit(height: number): number {
  const fit = Math.floor((height - 2 * TOOL_PADDING + TOOL_GAP) / (TOOL_BUTTON + TOOL_GAP))
  return Math.min(toolGroups().length, Math.max(1, fit))
}
