// Imports carry `.ts` and the JSON its import attribute so `node --test` loads this module as it is.
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import type { WorkspaceNode } from '@kition/sdk/editor/workspaceTree'
import { cyclePanel, panelFromName, showPanel, toggleMaximized } from './presets.ts'
import { focusedPanel } from '../panels/projectModel.ts'
import { hiddenPanelReason } from '../menus/hidden.ts'

type Params = Record<string, unknown>

/** What the route needs of kit-editor's `useWorkspaces`. */
export type NamedWorkspaces = {
  names: readonly string[]
  current: string
  switchTo: (name: string) => void
  reset: () => void
  saveChanges: () => string | null
  saveAs: (name: string) => string | null
  rename: (from: string, to: string) => string | null
  remove: (name: string) => string | null
  isBuiltin: (name: string) => boolean
}

export type WorkspaceRouteDeps = {
  workspaces: () => NamedWorkspaces
  /** The live layout, read at each call (it may have changed since the last render). */
  tree: () => WorkspaceNode
  setTree: (tree: WorkspaceNode) => void
  focused: () => string
  setFocused: (panel: string) => void
  maximized: () => string | null
  setMaximized: (panel: string | null) => void
  /** Whether a panel may be shown (the host hides some): Select Next and Previous Panel skip the others. */
  shown?: (panel: string) => boolean
  /** The shown panel under the pointer, or null (upstream `panel_under_pointer`). */
  underCursor: () => string | null
  /** Opens Save as New Workspace (`saveAs`) or Edit Workspaces (`edit`). */
  dialog: (which: 'saveAs' | 'edit') => void
  /**
   * Gives keyboard focus to `panel`'s search field once it is drawn (upstream's search fields take
   * it from `focus_find_box`); a panel without one does nothing.
   */
  focusSearch?: (panel: string) => void
}

const WORKSPACE = 'window.workspace.'
const PANEL = 'window.panel.'
const IDS = new Set(['window.maximizeFrame', 'window.maximizeFrameUnderCursor', 'window.nextPanel', 'window.prevPanel', 'window.toggleMonitorFocus', 'window.openSearch', 'panel.selectFindBox', 'mode.edit'])

const titleOf = (panel: string) => upstream.panels.find((item) => item.id === panel)?.title ?? panel
const slug = (name: string) => name.toLowerCase().replaceAll(' ', '')
const text = (params: Params, key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')

/** Throws a `useWorkspaces` refusal, as upstream's route answers `Err`. */
function check(reason: string | null) {
  if (reason !== null) throw new Error(reason)
}

/**
 * The `workspace` route of `invoke`: upstream's `window.panel.*` arm (`menus.rs`), the
 * `window.workspace.*` route (`panels/workspaces.rs` `route`), and the frame and panel keys of
 * `panels/keyboard.rs` (maximize, next and previous panel, monitor focus), with Edit, the one
 * mode this editor has. Each answers upstream's JSON, or throws why not.
 */
export function createWorkspaceRoute(deps: WorkspaceRouteDeps) {
  const show = (panel: string) => {
    const tree = deps.tree()
    const next = showPanel(tree, panel)
    if (next !== tree) deps.setTree(next)
    deps.setFocused(panel)
  }
  const maximize = (panel: string) => {
    const tree = deps.tree()
    const next = toggleMaximized(tree, deps.maximized(), panel)
    if (next.tree !== tree) deps.setTree(next.tree)
    deps.setMaximized(next.maximized)
    if (next.focused) deps.setFocused(next.focused)
    return { maximized: next.maximized ? titleOf(next.maximized) : null }
  }

  function workspace(key: string, params: Params): unknown {
    const named = deps.workspaces()
    switch (key) {
      case 'reset':
        named.reset()
        return { workspace: named.current }
      case 'saveChanges': {
        const name = named.current
        check(named.saveChanges())
        return { saved: name }
      }
      case 'saveAs': {
        if (typeof params.name !== 'string') {
          deps.dialog('saveAs')
          return { dialog: 'saveWorkspace' }
        }
        check(named.saveAs(params.name))
        const name = params.name.trim()
        return { saved: name, workspace: name }
      }
      case 'edit':
        deps.dialog('edit')
        return { dialog: 'editWorkspaces', workspaces: [...named.names] }
      case 'rename': {
        const from = text(params, 'from')
        const to = text(params, 'to')
        check(named.rename(from, to))
        return { renamed: from, to: to.trim() }
      }
      case 'delete': {
        const name = text(params, 'name')
        check(named.remove(name))
        return named.isBuiltin(name) ? { restored: name } : { deleted: name }
      }
      default: {
        const name = named.names.find((item) => slug(item) === key)
        if (name === undefined) throw new Error(`unknown workspace \`${key}\``)
        named.switchTo(name)
        return { workspace: name }
      }
    }
  }

  /** The focused panel's frame: a floating bin window stands for the Project panel's. */
  const frame = () => focusedPanel(deps.focused())

  function route(id: string, params: Params): unknown {
    if (id.startsWith(PANEL)) {
      const name = id.slice(PANEL.length)
      const panel = panelFromName(name)
      if (!panel) throw new Error(`unknown panel \`${name}\``)
      // A panel the editor does not draw is never opened (its Window row is hidden too).
      check(hiddenPanelReason(panel))
      show(panel)
      return null
    }
    if (id.startsWith(WORKSPACE)) return workspace(id.slice(WORKSPACE.length), params)
    switch (id) {
      case 'window.maximizeFrame':
        return maximize(frame())
      case 'window.maximizeFrameUnderCursor': {
        const named = typeof params.panel === 'string' ? panelFromName(params.panel) : null
        return maximize(named ?? deps.underCursor() ?? frame())
      }
      case 'window.nextPanel':
      case 'window.prevPanel': {
        const panel = cyclePanel(deps.tree(), frame(), id === 'window.nextPanel', deps.shown)
        if (panel === null) return null
        deps.setFocused(panel)
        return { focused: titleOf(panel) }
      }
      case 'window.toggleMonitorFocus': {
        const panel = deps.focused() === 'program' ? 'source' : 'program'
        show(panel)
        return { focused: titleOf(panel) }
      }
      // Upstream `keyboard.rs`: Open Search shows the Project panel and focuses its search field;
      // Select Find Box focuses the focused panel's.
      case 'window.openSearch':
        show('project')
        deps.focusSearch?.('project')
        return { panel: titleOf('project') }
      case 'panel.selectFindBox': {
        const panel = deps.focused()
        deps.focusSearch?.(panel)
        return { panel: titleOf(focusedPanel(panel)) }
      }
      case 'mode.edit':
        return null
      default:
        throw new Error(`unknown command \`${id}\``)
    }
  }

  /** The ids this route runs: Import and Export modes are wave 3, so `invoke` says they are not available. */
  const serves = (id: string) => IDS.has(id) || id.startsWith(PANEL) || id.startsWith(WORKSPACE)
  return Object.assign(route, { serves })
}
