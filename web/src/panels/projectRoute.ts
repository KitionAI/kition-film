// Imports carry `.ts` so `node --test` loads this module as it is.
import { projectItems, type FilmBin } from '../film.ts'
import { findBin, iconRows, itemIds, listRows, matchesSearch, moveSelection, shownBin, type ProjectRows, type ProjectUi, type ProjectView } from './projectModel.ts'

type Params = Record<string, unknown>

/** The `projectPanel.*` commands this editor serves (upstream `project::route` and `keyboard::project_panel`). */
const SERVED = new Set([
  'viewList',
  'viewIcon',
  'toggleView',
  'hoverScrub',
  'thumbnailLarger',
  'thumbnailSmaller',
  'moveUp',
  'moveDown',
  'moveLeft',
  'moveRight',
  'moveHome',
  'moveEnd',
  'movePageUp',
  'movePageDown',
  'extendUp',
  'extendDown',
  'extendLeft',
  'extendRight',
  'markIn',
  'markOut',
  'rename',
  'openBin',
  'up',
  'closeBinTab',
  'newPanel',
])

/** Upstream's `open_bin` modes, from Settings ▸ General ▸ Bins or a `how`. */
export type BinOpen = 'openInPlace' | 'openNewTab' | 'openNewWindow'

/** The bin holding bin `id` in `root`'s tree, or null at the top (upstream `parent_bin`). */
export function parentBin(root: FilmBin | null, id: number | null): number | null {
  if (!root || id == null) return null
  const walk = (bin: FilmBin): number | null => {
    for (const child of bin.children) {
      if (!('children' in child)) continue
      if (child.id === id) return bin.id
      const found = walk(child)
      if (found != null) return found
    }
    return null
  }
  return walk(root)
}

/** The bin names from the project's root down to bin `id` (upstream `bin_path`, the breadcrumb). */
export function binPath(root: FilmBin | null, id: number | null): string[] {
  if (!root || id == null || root.id === id) return []
  const walk = (bin: FilmBin, path: string[]): string[] | null => {
    for (const child of bin.children) {
      if (!('children' in child)) continue
      const here = [...path, child.name]
      if (child.id === id) return here
      const found = walk(child, here)
      if (found) return found
    }
    return null
  }
  return walk(root, []) ?? []
}

export type ProjectRouteDeps = {
  ui: ProjectUi
  /** The project's bins and items (the inspect model). */
  root: () => FilmBin | null
  /** The targeted session's run. */
  run: (id: string, params: Params) => Promise<unknown>
  query: (id: string, params?: Params) => Promise<unknown>
  /**
   * The floating bin window keys and the panel's commands act on (the focused one), or null for
   * the panel itself. Upstream's route acts on the panel's shown tab only; here a focused window
   * takes them, as any focused panel does.
   */
  target?: () => string | null
}

const selectionOf = async (query: ProjectRouteDeps['query']) => (((await query('state.inspect')) as { project_selection?: number[] } | null)?.project_selection ?? [])

/**
 * Opens bin `bin` as `how` says, or as Settings ▸ General ▸ Bins says for a double-click with
 * these modifiers (upstream `open_bin`): in place in `deps.ui`'s instance (the panel, or a floating
 * window), in a docked tab of the panel, or in a floating window (the one open on the bin, else a
 * new one), each new tab or window with the panel's view and icon size.
 */
export async function openBin(deps: ProjectRouteDeps, bin: number, how: BinOpen | null, mods: { command?: boolean; alt?: boolean } = {}) {
  const root = deps.root()
  if (!findBin(root, bin)) throw new Error(`no bin ${bin}`)
  let mode = how
  if (!mode) {
    const general = ((await deps.query('prefs.get', { key: 'general' }).catch(() => null)) ?? {}) as { binsDoubleClick?: BinOpen; binsCmdDoubleClick?: BinOpen; binsOptDoubleClick?: BinOpen }
    mode = (mods.command ? general.binsCmdDoubleClick : mods.alt ? general.binsOptDoubleClick : general.binsDoubleClick) ?? (mods.command ? 'openNewTab' : mods.alt ? 'openNewWindow' : 'openInPlace')
  }
  if (mode === 'openInPlace') {
    deps.ui.navigate(bin, root?.id ?? null)
    return { opened: 'inPlace', bin }
  }
  if (mode === 'openNewTab' || mode === 'openNewWindow') {
    const view = (await deps.query('project.view.get')) as ProjectView | null
    const [shown, size] = [view?.view.mode ?? 'icon', view?.view.iconSize ?? 110]
    if (mode === 'openNewWindow') return { opened: 'window', bin, window: deps.ui.openWindow(bin, shown, size, { reuse: true }) }
    deps.ui.openTab(bin, shown, size)
    return { opened: 'tab', bin, tab: deps.ui.instance(null).get().activeTab }
  }
  throw new Error(`unknown bin open mode \`${String(mode)}\``)
}

/**
 * The items the shown tab lists, in order, as the person sees them (search and folds applied;
 * upstream `items_in_view`). The Freeform view's are upstream's Freeform arm: the bin's own items
 * in the bin's order (its children, not the layout's order, which puts placed cards first), those
 * listed (`project.items` rows) whose name holds the search.
 */
export async function visibleItems(deps: ProjectRouteDeps) {
  const state = deps.ui.get()
  const tab = deps.ui.shownTab()
  const view = (await deps.query('project.view.get')) as ProjectView | null
  const mode = tab ? tab.mode : (view?.view.mode ?? 'icon')
  const { bin } = shownBin(state, deps.root())
  const params = bin != null ? { bin } : {}
  if (mode === 'freeform') {
    const answer = (await deps.query('project.items', { ...params, order: 'icon' })) as ProjectRows | null
    const listed = new Set((answer?.rows ?? []).flatMap((row) => (row.item != null && row.direct !== false ? [row.item] : [])))
    const children = findBin(deps.root(), bin)?.children ?? []
    const items = children.flatMap((child) => ('children' in child || !listed.has(child.item) || !matchesSearch(child, state.search) ? [] : [child.item]))
    return { icon: true, items }
  }
  if (mode === 'list') {
    const answer = (await deps.query('project.items', { ...params, recursive: true })) as ProjectRows
    return { icon: false, items: itemIds(listRows(answer.rows, state.expanded, state.search)) }
  }
  const answer = (await deps.query('project.items', { ...params, order: 'icon' })) as ProjectRows
  return { icon: true, items: itemIds(iconRows(answer.rows, state.search)) }
}

/**
 * Upstream's `projectPanel.*` UI commands for `invoke`: the view switches, Hover Scrub and the
 * thumbnail size through `project.view.set` (a bin tab's view is its own), the keyboard's moves
 * through `project.select`, I and O over a hover-scrubbed card (`project.setMarks`, else Mark In
 * and Out), and Rename, Open Bin, Up One Level, and Close Bin on the panel's own state.
 */
export function createProjectRoute(deps: ProjectRouteDeps) {
  const { run, query } = deps
  const route = async (id: string, params: Params) => {
    // Clip ▸ Rename… with no name (invoke's route) is the panel's Rename.
    const op = id === 'clip.rename' ? 'rename' : id.slice('projectPanel.'.length)
    // The focused floating window's instance, else the panel's.
    const ui = deps.ui.instance(deps.target?.() ?? null)
    const scoped = { ...deps, ui }
    const tab = ui.shownTab()
    switch (op) {
      case 'viewList':
      case 'viewIcon':
      case 'toggleView': {
        const view = (await query('project.view.get')) as ProjectView | null
        const current = tab ? tab.mode : (view?.view.mode ?? 'icon')
        const mode = op === 'viewList' ? 'list' : op === 'viewIcon' ? 'icon' : current === 'list' ? 'icon' : 'list'
        if (tab) ui.setTab({ mode })
        else await run('project.view.set', { view: mode })
        return { view: mode }
      }
      case 'hoverScrub': {
        const view = (await query('project.view.get')) as ProjectView | null
        const on = !(view?.hoverScrub ?? true)
        await run('project.view.set', { hoverScrub: on })
        return { hoverScrub: on }
      }
      case 'thumbnailLarger':
      case 'thumbnailSmaller': {
        const view = (await query('project.view.get')) as ProjectView | null
        const size = Math.min(400, Math.max(48, (tab ? tab.iconSize : (view?.view.iconSize ?? 110)) * (op === 'thumbnailLarger' ? 1.25 : 0.8)))
        if (tab) ui.setTab({ iconSize: size })
        else await run('project.view.set', { iconSize: size })
        return { iconSize: size }
      }
      case 'markIn':
      case 'markOut': {
        const hover = ui.hover.current
        if (!hover) return run(op === 'markIn' ? 'markers.markIn' : 'markers.markOut', {})
        const key = op === 'markIn' ? 'in' : 'out'
        await run('project.setMarks', { item: hover.item, [key]: hover.time })
        return { item: hover.item, [key]: hover.time }
      }
      case 'rename': {
        let item = typeof params.item === 'number' ? params.item : null
        let bin = typeof params.bin === 'number' ? params.bin : null
        if (item == null && bin == null) {
          // An item selection wins over a bin clicked earlier.
          const selection = await selectionOf(query)
          if (selection.length) item = selection[0]
          else if (ui.get().selectedBin != null) bin = ui.get().selectedBin
          else throw new Error('select an item or bin to rename')
        }
        const root = deps.root()
        const text = item != null ? (projectItems(root).get(item)?.name ?? null) : (findBin(root, bin)?.name ?? null)
        if (text == null) throw new Error(item != null ? 'no such item' : 'no such bin')
        ui.set({ rename: { item, bin: item != null ? null : bin, text } })
        return { item, bin }
      }
      case 'openBin': {
        const bin = typeof params.bin === 'number' ? params.bin : ui.get().selectedBin
        if (bin == null) throw new Error('need `bin` (or select a bin)')
        const how = ({ inPlace: 'openInPlace', newTab: 'openNewTab', tab: 'openNewTab', newWindow: 'openNewWindow', window: 'openNewWindow' } as Record<string, BinOpen>)[String(params.how)] ?? (typeof params.how === 'string' ? (params.how as BinOpen) : null)
        return openBin(scoped, bin, how, { command: params.command === true, alt: params.alt === true })
      }
      case 'up': {
        const root = deps.root()
        const { bin, top } = shownBin(ui.get(), root)
        if (bin !== top) ui.navigate(parentBin(root, bin), root?.id ?? null)
        return { bin: shownBin(ui.get(), root).bin }
      }
      case 'closeBinTab': {
        // `{window: id}` closes a floating window, as upstream's `{tab: k}` closes a floating tab
        // (its windows are no tabs here); else the panel's docked tabs, whichever instance has focus.
        if (typeof params.window === 'string') {
          if (!deps.ui.closeWindow(params.window)) throw new Error('no such bin window')
          return null
        }
        const panel = deps.ui.instance(null)
        const k = typeof params.tab === 'number' ? params.tab : panel.get().activeTab
        if (k == null || !panel.get().tabs[k]) throw new Error('no such bin tab')
        panel.closeTab(k)
        return null
      }
      // Window ▸ New Project Panel: the project's root in a new floating window, the panel's view at icon size 110 (upstream's).
      case 'newPanel': {
        const root = deps.root()
        if (!root) throw new Error('no project')
        const view = (await query('project.view.get')) as ProjectView | null
        return { window: deps.ui.openWindow(root.id, view?.view.mode ?? 'icon', 110, { reuse: false }) }
      }
      default: {
        const { icon, items } = await visibleItems(scoped)
        if (!items.length) return { items: [] }
        const next = moveSelection(op, items, await selectionOf(query), ui.get().iconColumns, icon)
        await run('project.select', { items: next })
        return { items: next }
      }
    }
  }
  return Object.assign(route, { serves: (id: string) => id === 'clip.rename' || SERVED.has(id.slice('projectPanel.'.length)) })
}
