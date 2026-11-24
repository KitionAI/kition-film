// Imports carry `.ts` and the JSON its import attribute so `node --test` loads this module as it is.
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { activate, openNear, restoreBeside, validateTree, visiblePanels, type WorkspaceNode } from '@kition/sdk/editor/workspaceTree'
import { hiddenPanelReason, hiddenWorkspaceReason } from '../menus/hidden.ts'

/** Upstream's `PanelKind::ALL` as lowerCamel ids, in its order. */
export const FILM_PANEL_IDS: ReadonlySet<string> = new Set(upstream.panels.map((panel) => panel.id))

/**
 * Upstream's `dock.rs` `workspace`: the nine built-in layouts by name, in its order, each checked
 * as a stored layout is. That drops one upstream bug: its Effects layout lists Effect Controls in
 * two frames, and only the first can ever show it (`activate` stops there), so the second frame's
 * tab is dead; two tabs of one panel would also give the page two elements with one id.
 */
export const FILM_WORKSPACES: Readonly<Record<string, WorkspaceNode>> = Object.fromEntries(
  upstream.workspaces.map((workspace) => [workspace.name, validateTree(workspace.layout, FILM_PANEL_IDS) as WorkspaceNode]),
)

/** The panels the editor draws: upstream's without those it leaves out (`menus/hidden.ts` `hiddenPanelReason`). */
export const WEB_PANEL_IDS: ReadonlySet<string> = new Set([...FILM_PANEL_IDS].filter((panel) => hiddenPanelReason(panel) == null))

/**
 * The built-in workspaces the editor offers: upstream's (`FILM_WORKSPACES`) without those whose
 * panels it does not draw (`hiddenWorkspaceReason`), each tree without the panels it leaves out
 * (a frame left with no tab goes, and its split with it).
 */
export const WEB_WORKSPACES: Readonly<Record<string, WorkspaceNode>> = Object.fromEntries(
  Object.entries(FILM_WORKSPACES)
    .filter(([name]) => hiddenWorkspaceReason(name) == null)
    .map(([name, tree]) => [name, validateTree(tree, WEB_PANEL_IDS) as WorkspaceNode]),
)

/** The workspace opened first, and after deleting the user workspace in use (`workspaces.rs` `delete`). */
export const FALLBACK_WORKSPACE = 'Editing'

/** Upstream's `PanelKind::compact`: no tab strip, and left out of Select Next and Previous Panel. */
export const COMPACT_PANELS: ReadonlySet<string> = new Set(upstream.panels.filter((panel) => panel.compact).map((panel) => panel.id))

const fold = (name: string) => name.toLowerCase().replace(/[\s_-]/g, '')

/** Upstream's `PanelKind::from_name`: the panel a name means, by kind (`EffectControls`) or title (`Effect Controls`), without case; or null. */
export function panelFromName(name: string): string | null {
  const key = fold(name)
  return upstream.panels.find((panel) => fold(panel.kind) === key || fold(panel.title) === key)?.id ?? null
}

/** `show_panel`'s neighbour for a panel the tree lacks: Program, Source, or else Project. */
function nearOf(panel: string) {
  if (['color', 'graphicsTemplates', 'audioMixing', 'properties'].includes(panel)) return 'program'
  if (['source', 'effectControls', 'audioClipMixer', 'metadata', 'scopes', 'audioTrackMixer', 'text', 'referenceMonitor', 'timecode'].includes(panel)) return 'source'
  return 'project'
}

/** The Audio Meters frame's width beside a restored Timeline (`restore_timeline`). */
const METERS_WIDTH = 116

/**
 * Upstream's `lib.rs` `show_panel`: the Timeline comes back beside a lone Audio Meters frame
 * (`restore_timeline`), any other panel the tree lacks opens as a tab near its neighbour, else
 * near Project, else near Program (`open_near`); then the panel is made its frame's active tab.
 * The caller focuses it.
 */
export function showPanel(tree: WorkspaceNode, panel: string): WorkspaceNode {
  let next = tree
  if (panel === 'timeline') next = restoreBeside(next, 'timeline', 'audioMeters', METERS_WIDTH, 'project')
  next = openNear(next, panel, [nearOf(panel), 'project', 'program'])
  return activate(next, panel)
}

/**
 * Upstream's `keyboard.rs` `cycle_panel`: the panel after (or before) `focused` among the frames'
 * shown, non-compact panels in tree order; a focused panel not among them counts as the first.
 * Null when no panel is shown.
 */
export function cyclePanel(tree: WorkspaceNode, focused: string, forward: boolean, shown: (panel: string) => boolean = () => true): string | null {
  const panels = visiblePanels(tree, (panel) => shown(panel) && !COMPACT_PANELS.has(panel))
  if (panels.length === 0) return null
  const at = Math.max(panels.indexOf(focused), 0)
  return panels[(at + (forward ? 1 : panels.length - 1)) % panels.length]
}

/**
 * Upstream's `keyboard.rs` `toggle_maximize` (` and Shift+`): a maximized frame is restored;
 * otherwise `panel` fills the area, made its frame's active tab and focused. The tree itself is
 * kept. `focused` is the panel to focus, or null to leave focus alone.
 */
export function toggleMaximized(tree: WorkspaceNode, maximized: string | null, panel: string): { tree: WorkspaceNode; maximized: string | null; focused: string | null } {
  if (maximized !== null) return { tree, maximized: null, focused: null }
  return { tree: activate(tree, panel), maximized: panel, focused: panel }
}
