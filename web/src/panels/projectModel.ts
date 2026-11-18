// Imports carry `.ts` so `node --test` loads this module as it is.
import { TICKS_PER_SECOND, type FilmBin } from '../film.ts'

/**
 * The Project panel's model (upstream `panels/project.rs`, `project_views.rs`). The engine owns the
 * view settings, columns, sorting, and the selection (`project.view.*`, `project.items`,
 * `project.select`); this module keeps what upstream's `ProjectPanelUi` keeps on screen: the search
 * text, the open bins, the bin shown in place, the bin tabs, the selected bin, the inline rename,
 * and the hover-scrubbed card. Pure, so `node --test` runs it.
 */

/** A row of `project.items`: a bin, or an item with its cells and what its card draws. */
export type ProjectRow = {
  bin?: number
  item?: number
  name: string
  depth: number
  /** A bin's listed items, its sub-bins' included. */
  items?: number
  label?: string
  cells?: Record<string, string>
  type?: string
  kind?: 'media' | 'sequence' | 'subclip' | 'adjustmentLayer' | 'graphic'
  icon?: 'audio' | 'image' | 'film' | 'sequence' | 'adjust'
  /** Ticks. */
  start?: number
  duration?: number
  frame?: number
  poster?: number | null
  /** A sequence's content stamp (`project.items`), which its poster frame is drawn from; null for other items. */
  stamp?: string | null
  in?: number | null
  out?: number | null
  hasVideo?: boolean
  hasAudio?: boolean
  offline?: boolean
  /** Why it is offline (upstream `media_badge`): Offline, Media missing, or Unreadable. */
  offlineText?: string | null
  proxy?: boolean
  matte?: boolean
  /** Media from a file (Link Media, Make Offline, and Proxy apply). */
  file?: boolean
  info?: { videoInfo: string; mediaDuration: string; frameRate: string; audioInfo: string }
  usage?: [number, number]
  /** Icon order: the shown bin holds the item itself (not a sub-bin). */
  direct?: boolean
}

export type ProjectColumn = { name: string; width: number }
export type ProjectSort = { column: string; descending: boolean }
export type ProjectRows = { bin: number; columns: ProjectColumn[]; sort: ProjectSort; rows: ProjectRow[] }

/** `project.view.get`. */
export type ProjectView = {
  view: { mode: 'list' | 'icon' | 'freeform'; iconSize: number; fontSize: 'small' | 'medium' | 'large' | 'extraLarge'; columns: ProjectColumn[]; sort: ProjectSort; iconSort: ProjectSort }
  previewArea: boolean
  thumbnails: boolean
  thumbnailsShowEffects: boolean
  hoverScrub: boolean
  thumbnailControlsAllDevices: boolean
  currentPreset: number | null
  /** Freeform View Options (`project_panel::FreeformOptions`). */
  freeform?: { grid: number; snap: boolean; showNames: boolean; showDurations: boolean; cardSize: number }
}

/** Upstream's `FontSize::points`. */
export const FONT_POINTS: Readonly<Record<ProjectView['view']['fontSize'], number>> = { small: 10.5, medium: 12, large: 14, extraLarge: 16 }
/** Upstream's `FontSize::ALL` and `label`. */
export const FONT_SIZES: ReadonlyArray<[ProjectView['view']['fontSize'], string]> = [
  ['small', 'Small'],
  ['medium', 'Medium (default)'],
  ['large', 'Large'],
  ['extraLarge', 'Extra Large'],
]

/**
 * Whether a read of the view leaves the rows shown as they are: it only checks the view (a
 * refresh made elsewhere with no new revision, which may have changed it) and finds the same view,
 * in the same mode, of the same bin, as the rows were read for. Then `project.items` is not read
 * again.
 */
export function rowsStillShown({ onlyView, before, view, mode, bin }: { onlyView: boolean; before: { view: unknown; mode: string; bin: number | null } | null; view: unknown; mode: string; bin: number | null }) {
  return onlyView && before != null && before.mode === mode && before.bin === bin && JSON.stringify(before.view) === JSON.stringify(view)
}

/** `to_ascii_lowercase`: only A–Z change, as upstream folds the search and the names. */
export const asciiLower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

/** Upstream's `matches_filter`: the item's name holds the search text, without ASCII case. */
export function matchesSearch(row: Pick<ProjectRow, 'name'>, search: string) {
  return search === '' || asciiLower(row.name).includes(asciiLower(search))
}

/**
 * The List view's rows (upstream `list_bin`) from `project.items {recursive: true}`: a bin's rows
 * show while it is open (`expanded`, by bin id, so the state outlives the rows), every bin is open
 * during a search, and a search keeps the bins and the items whose name matches.
 */
export function listRows(rows: readonly ProjectRow[], expanded: ReadonlySet<number>, search: string): ProjectRow[] {
  const shown: ProjectRow[] = []
  // Rows deeper than this belong to a folded bin.
  let foldedAt = Infinity
  for (const row of rows) {
    if (row.depth > foldedAt) continue
    foldedAt = Infinity
    if (row.bin != null) {
      shown.push(row)
      if (search === '' && !expanded.has(row.bin)) foldedAt = row.depth
    } else if (matchesSearch(row, search)) shown.push(row)
  }
  return shown
}

/**
 * The Icon view's cards (upstream `icon_view`) from `project.items {order: "icon"}`: the bin's own
 * bins and items; during a search, no bins and every matching item under the bin.
 */
export function iconRows(rows: readonly ProjectRow[], search: string): ProjectRow[] {
  if (search === '') return rows.filter((row) => row.bin != null || row.direct !== false)
  return rows.filter((row) => row.item != null && matchesSearch(row, search))
}

/** Upstream's `count_items`: the listed items under the shown bin, search or not. */
export const itemCount = (rows: readonly ProjectRow[]) => rows.filter((row) => row.item != null).length

/** The items a view shows, in order (keyboard moves, upstream `visible_items`). */
export const itemIds = (rows: readonly ProjectRow[]) => rows.flatMap((row) => (row.item != null ? [row.item] : []))

/**
 * Upstream's `project_panel` moves (`panels/keyboard.rs`): Up and Down a row (a row of `columns`
 * cards in the Icon view), Left and Right a card in the Icon view only, ten rows a page, Home and
 * End; Shift extends from the selection's first item (the anchor) to the target, the anchor first.
 */
export function moveSelection(op: string, items: readonly number[], selection: readonly number[], columns: number, icon = columns > 1): number[] {
  const n = items.length
  if (!n) return []
  const cols = Math.max(1, icon ? columns : 1)
  const steps: Record<string, number> = {
    moveUp: -cols,
    moveDown: cols,
    moveLeft: icon ? -1 : 0,
    moveRight: icon ? 1 : 0,
    movePageUp: -10 * cols,
    movePageDown: 10 * cols,
    extendUp: -cols,
    extendDown: cols,
    extendLeft: icon ? -1 : 0,
    extendRight: icon ? 1 : 0,
  }
  const last = selection.length ? items.indexOf(selection[selection.length - 1]) : -1
  let target: number
  if (op === 'moveHome') target = 0
  else if (op === 'moveEnd') target = n - 1
  else if (op in steps) target = last >= 0 ? Math.min(n - 1, Math.max(0, last + steps[op])) : steps[op] < 0 ? n - 1 : 0
  else return [...selection]
  if (!op.startsWith('extend')) return [items[target]]
  const found = selection.length ? items.indexOf(selection[0]) : -1
  const anchor = found >= 0 ? found : target
  const span = items.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)
  return target < anchor ? span.reverse() : span
}

/**
 * The List view's local column widths still to show over the engine's: a width gives way once the
 * engine's reads back within half a point (it keeps f32 widths), or once its column goes. Unchanged,
 * the same object.
 */
export function keptWidths(local: Readonly<Record<string, number>>, columns: readonly ProjectColumn[]): Readonly<Record<string, number>> {
  const kept = Object.entries(local).filter(([name, width]) => columns.some((column) => column.name === name && Math.abs(column.width - width) >= 0.5))
  return kept.length === Object.keys(local).length ? local : Object.fromEntries(kept)
}

/** Upstream's `quantize`: thumbnail times on a quarter-second grid. */
export const quantize = (ticks: number) => Math.floor(ticks / (TICKS_PER_SECOND / 4)) * (TICKS_PER_SECOND / 4)

type ThumbnailRange = Pick<ProjectRow, 'start' | 'duration' | 'frame'>

/** Thumbnail reads use absolute media time, bounded to the item's actual source range. */
function inThumbnailRange(row: ThumbnailRange, ticks: number) {
  const start = row.start ?? 0
  return Math.max(start, Math.min(ticks, start + Math.max(0, (row.duration ?? 0) - (row.frame || 1))))
}

/** Cache ordinary scrubbing on a quarter-second grid without escaping a short subclip. */
export const thumbnailTicks = (row: ThumbnailRange, ticks: number) => inThumbnailRange(row, quantize(ticks))

/** Explicit posters keep the selected frame; the default is three tenths into the source range. */
export const posterTicks = (row: ThumbnailRange & Pick<ProjectRow, 'poster'>) => row.poster != null
  ? inThumbnailRange(row, row.poster)
  : thumbnailTicks(row, (row.start ?? 0) + Math.floor(((row.duration ?? 0) * 3) / 10))

/**
 * Upstream's `hover_time`: the media time under the pointer, `fraction` across the thumbnail, on
 * the item's frames, at most its last frame.
 */
export function hoverTicks(row: ThumbnailRange, fraction: number) {
  const duration = row.duration ?? 0
  const frame = row.frame || 1
  const at = Math.round((duration * Math.min(1, Math.max(0, fraction))) / frame) * frame
  return (row.start ?? 0) + Math.min(at, Math.max(0, duration - frame))
}

/**
 * The width a thumbnail is asked at: the drawn width × device scale, on a 32-pixel step (so a
 * slider drag does not ask for every width), at least 96 and at most 640 pixels (a 640 × 360
 * frame is under a quarter of a megapixel).
 */
export const thumbnailWidth = (drawn: number, scale: number) => Math.min(640, Math.max(96, Math.ceil((drawn * scale) / 32) * 32))

/** A bin opened in its own tab of the panel (upstream `BinTab`, docked): its view is its own. */
export type BinTab = { bin: number; nav: number | null; mode: ProjectView['view']['mode']; iconSize: number }

/**
 * A bin opened in a floating window (upstream `BinTab` with `floating`, Open in New Window and
 * Window ▸ New Project Panel): a panel instance of its own, with its own bin shown, view, icon
 * size, Icon view columns, Freeform width, and rename. `id` keys its rectangle in the kit store
 * (`FLOATING_BINS`): it names its bin, so a window of that bin opens where the last one was, on
 * this page or another; the windows themselves are this page's.
 */
export type BinWindow = BinTab & { id: string; iconColumns: number; freeformWidth: number; rename: ProjectUiState['rename'] }

/** The kit store the floating bin windows' rectangles live in (kit-editor `FloatingPanels`): `kit:film:floatingBins`. */
export const FLOATING_BINS = { kit: 'film', store: 'floatingBins' } as const

/** What the editor's focus reads while a floating bin window has it: `projectBin.<id>` (upstream's `projectBin.{k}` prefix). */
const BIN_WINDOW_FOCUS = 'projectBin.'
export const binWindowFocus = (id: string) => `${BIN_WINDOW_FOCUS}${id}`
/** The floating bin window `focused` names, or null. */
export const binWindowOf = (focused: string) => (focused.startsWith(BIN_WINDOW_FOCUS) ? focused.slice(BIN_WINDOW_FOCUS.length) : null)
/** The panel whose keys and frame the focus stands for: a floating bin window is the Project panel's. */
export const focusedPanel = (focused: string) => (binWindowOf(focused) != null ? 'project' : focused)

/**
 * Where focus goes when it names a floating bin window that is no longer drawn (closed, or one the
 * host hides): the Project panel; null while the focus is fine.
 */
export function windowFocusFallback(focused: string, drawn: readonly string[]): 'project' | null {
  const id = binWindowOf(focused)
  return id != null && !drawn.includes(id) ? 'project' : null
}

/** A new window's id for `bin`: `bin<id>`, or `bin<id>-<n>` with the lowest n from 2 another open window of that bin does not hold. */
export function binWindowId(bin: number, open: readonly { id: string }[]): string {
  const taken = new Set(open.map((each) => each.id))
  const first = `bin${bin}`
  if (!taken.has(first)) return first
  let n = 2
  while (taken.has(`${first}-${n}`)) n += 1
  return `${first}-${n}`
}

export type ProjectUiState = {
  search: string
  expanded: ReadonlySet<number>
  /** The bin the panel shows in place (null: the project's root). */
  bin: number | null
  tabs: readonly BinTab[]
  /** The tab shown: null for the project, else an index into `tabs`. */
  activeTab: number | null
  selectedBin: number | null
  rename: { item: number | null; bin: number | null; text: string } | null
  /** Cards per row in the Icon view, for the keyboard's Up and Down. */
  iconColumns: number
  /** The width the Freeform view lays its auto-placed cards out for (upstream's `rect.width()`); 0 before it is drawn. */
  freeformWidth: number
  /** Moves when a view setting changed outside a revision (the panel reads the view again). */
  viewTick: number
}

/** What a window's instance keeps of its own (the rest of the state is the panel's, as upstream's one `project_search`, `expanded_bins`, `selected_bin`). */
const WINDOW_OWN = new Set<keyof ProjectUiState>(['rename', 'iconColumns', 'freeformWidth'])
/** The instance's own place, which a window's state stands in for with its tab. */
const MAIN_ONLY = new Set<keyof ProjectUiState>(['bin', 'tabs', 'activeTab'])

/** The bins on the way down from `root` to `item` (outermost first), or null when no bin holds it; bounded as upstream's. */
export function binsTo(root: FilmBin, item: number, depth = 0): number[] | null {
  if (depth > 256) return null
  for (const child of root.children) {
    if (!('children' in child)) {
      if (child.item === item) return []
      continue
    }
    const inner = binsTo(child, item, depth + 1)
    if (inner) return [child.id, ...inner]
  }
  return null
}

/**
 * The panel's UI state outside React (upstream `ProjectPanelUi`, `expanded_bins`,
 * `project_search`): an unmounted panel (another tab shown) does no work, and finds its state
 * again when it is shown. `instance(id)` is a floating bin window's view of it (upstream
 * `Inst::Tab`), with the same methods: its own bin, view, and rename, the panel's search and folds.
 */
export function createProjectUi() {
  let state: ProjectUiState = { search: '', expanded: new Set(), bin: null, tabs: [], activeTab: null, selectedBin: null, rename: null, iconColumns: 1, freeformWidth: 0, viewTick: 0 }
  /**
   * The floating bin windows open on this page, bottom to top as opened (upstream's floating
   * `tabs`), kept apart from the panel's state: a window's own change (its width, a rename
   * keystroke) leaves the panel's state object, and so the docked panel, alone.
   */
  let windows: readonly BinWindow[] = []
  const listeners = new Set<() => void>()
  /**
   * The card under the pointer while Hover Scrub is on: its item and the media time (ticks), for I
   * and O and Set Poster Frame. It moves every animation frame, so it notifies nobody.
   */
  const hover: { current: { item: number; time: number } | null } = { current: null }
  const tell = () => {
    for (const listener of listeners) listener()
  }
  /**
   * One change, told once: `patch` to the panel's state, `own` to window `id`'s. A rename started
   * anywhere ends the others (upstream keeps one `rename`, with the instance editing it).
   */
  const apply = (patch: Partial<ProjectUiState>, id: string | null = null, own: Partial<BinWindow> = {}) => {
    const renaming = id != null ? own.rename != null : patch.rename != null
    // Only the windows that change are new objects (each window's state stays the same object otherwise).
    if ((id != null || renaming) && windows.some((each) => each.id === id || (renaming && each.rename != null)))
      windows = windows.map((each) => (each.id === id ? { ...each, ...own } : renaming && each.rename != null ? { ...each, rename: null } : each))
    // The panel's state is a new object only when something of its own changes.
    const asked: Partial<ProjectUiState> = { ...patch, ...(id != null && renaming && state.rename != null ? { rename: null } : {}) }
    const panel = Object.fromEntries(Object.entries(asked).filter(([key, value]) => state[key as keyof ProjectUiState] !== value))
    if (Object.keys(panel).length) state = { ...state, ...panel }
    tell()
  }
  const set = (patch: Partial<ProjectUiState>) => apply(patch)
  const windowOf = (id: string | null) => (id == null ? null : (windows.find((each) => each.id === id) ?? null))
  /** Sets the open windows, dropping the instances of the ones gone. */
  const setWindows = (next: readonly BinWindow[]) => {
    for (const id of [...instances.keys()]) if (!next.some((each) => each.id === id)) instances.delete(id)
    windows = next
    tell()
  }

  const main: ProjectUi = {
    get: () => state,
    /** The floating bin windows open on this page (the same array until one opens, closes, or changes). */
    windows: () => windows,
    set,
    hover,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    toggleBin(bin: number) {
      const expanded = new Set(state.expanded)
      if (expanded.has(bin)) expanded.delete(bin)
      else expanded.add(bin)
      set({ expanded })
    },
    viewChanged: () => set({ viewTick: state.viewTick + 1 }),
    /** A docked bin tab, or null for the panel itself. */
    shownTab: (): BinTab | null => (state.activeTab != null ? (state.tabs[state.activeTab] ?? null) : null),
    /** Shows a bin in place in the shown tab (upstream `navigate`); null is its top. */
    navigate(bin: number | null, root: number | null) {
      const k = state.activeTab
      if (k != null && state.tabs[k]) set({ tabs: state.tabs.map((tab, i) => (i === k ? { ...tab, nav: bin === tab.bin ? null : bin } : tab)), selectedBin: null })
      else set({ bin: bin === root ? null : bin, selectedBin: null })
    },
    /** Opens a bin in a new docked tab, or brings its open tab forward (upstream `open_bin`'s `openNewTab`). */
    openTab(bin: number, mode: BinTab['mode'], iconSize: number) {
      const open = state.tabs.findIndex((tab) => tab.bin === bin)
      if (open >= 0) return set({ activeTab: open })
      set({ tabs: [...state.tabs, { bin, nav: null, mode, iconSize }], activeTab: state.tabs.length })
    },
    /** Upstream `close_tab`. */
    closeTab(k: number) {
      if (k < 0 || k >= state.tabs.length) return
      const active = state.activeTab === k ? null : state.activeTab != null && state.activeTab > k ? state.activeTab - 1 : state.activeTab
      set({ tabs: state.tabs.filter((_, i) => i !== k), activeTab: active })
    },
    setTab(patch: Partial<BinTab>) {
      const k = state.activeTab
      if (k == null || !state.tabs[k]) return
      set({ tabs: state.tabs.map((tab, i) => (i === k ? { ...tab, ...patch } : tab)) })
    },
    /**
     * Opens `bin` in a floating window with this view and icon size, on top, and answers its id
     * (upstream `open_bin`'s `openNewWindow`, which with `reuse` answers the window already open on
     * the bin; `route`'s `newPanel` always opens another).
     */
    openWindow(bin: number, mode: BinTab['mode'], iconSize: number, { reuse }: { reuse: boolean }): string {
      const open = reuse ? windows.find((each) => each.bin === bin) : undefined
      if (open) return open.id
      const id = binWindowId(bin, windows)
      setWindows([...windows, { id, bin, nav: null, mode, iconSize, iconColumns: 1, freeformWidth: 0, rename: null }])
      return id
    },
    /** Closes window `id` (upstream `close_tab`); answers whether it was open. */
    closeWindow(id: string) {
      if (!windowOf(id)) return false
      setWindows(windows.filter((each) => each.id !== id))
      return true
    },
    /** Closes the windows whose bin `root` (the document's, once it has one) no longer has, as upstream's `floating`; answers their ids. */
    pruneWindows(root: FilmBin | null): string[] {
      if (!root) return []
      const gone = windows.filter((each) => !findBin(root, each.bin)).map((each) => each.id)
      if (gone.length) setWindows(windows.filter((each) => !gone.includes(each.id)))
      return gone
    },
    /** Window `id`'s instance of the panel, or the panel itself for null or a window no longer open. */
    instance(id: string | null): ProjectUi {
      return id != null && windowOf(id) ? windowUi(id) : main
    },
    /**
     * Upstream's `reveal_in_project`: the List view opens the bins on the way down to `item`; the
     * Icon and Freeform views show the bin that holds it. Either way the panel itself is shown
     * (not a bin tab), no bin is selected, and the search is cleared.
     */
    reveal(item: number, root: FilmBin | null, list: boolean) {
      const bins = root ? binsTo(root, item) : null
      const expanded = new Set(state.expanded)
      if (list) for (const bin of bins ?? []) expanded.add(bin)
      set({ bin: list || !bins ? null : (bins.at(-1) ?? null), expanded, activeTab: null, selectedBin: null, search: '' })
    },
    /**
     * Another document: nothing of the last one's panel stays but the floating windows, each at
     * its own bin, which close once the document shows it has no such bin (`pruneWindows`).
     */
    reset() {
      state = {
        search: '',
        expanded: new Set(),
        bin: null,
        tabs: [],
        activeTab: null,
        selectedBin: null,
        rename: null,
        iconColumns: 1,
        freeformWidth: state.freeformWidth,
        viewTick: state.viewTick + 1,
      }
      windows = windows.map((each) => ({ ...each, nav: null, rename: null }))
      hover.current = null
      tell()
    },
  }

  // Each open window's instance, made once; its state projected from the panel's, the same object while nothing it shows changed.
  const instances = new Map<string, ProjectUi>()
  function windowUi(id: string): ProjectUi {
    const made = instances.get(id)
    if (made) return made
    let last: { from: ProjectUiState; window: BinWindow; state: ProjectUiState } | null = null
    const get = (): ProjectUiState => {
      const window = windowOf(id)
      // Closed: the last state it showed (its panel unmounts with it).
      if (!window) return last?.state ?? state
      if (last && last.window === window && last.from.search === state.search && last.from.expanded === state.expanded && last.from.selectedBin === state.selectedBin && last.from.viewTick === state.viewTick) return last.state
      const shown: ProjectUiState = {
        ...state,
        bin: null,
        tabs: [{ bin: window.bin, nav: window.nav, mode: window.mode, iconSize: window.iconSize }],
        activeTab: 0,
        rename: window.rename,
        iconColumns: window.iconColumns,
        freeformWidth: window.freeformWidth,
      }
      last = { from: state, window, state: shown }
      return shown
    }
    const setOwn = (own: Partial<BinWindow>, patch: Partial<ProjectUiState> = {}) => {
      if (windowOf(id)) apply(patch, id, own)
      else if (Object.keys(patch).length) apply(patch)
    }
    const instance: ProjectUi = {
      ...main,
      get,
      set(patch: Partial<ProjectUiState>) {
        const own: Partial<BinWindow> = {}
        const shared: Partial<ProjectUiState> = {}
        for (const [key, value] of Object.entries(patch) as Array<[keyof ProjectUiState, never]>) {
          if (WINDOW_OWN.has(key)) (own as Record<string, unknown>)[key] = value
          else if (!MAIN_ONLY.has(key)) (shared as Record<string, unknown>)[key] = value
        }
        setOwn(own, shared)
      },
      shownTab: () => {
        const window = windowOf(id)
        return window ? { bin: window.bin, nav: window.nav, mode: window.mode, iconSize: window.iconSize } : null
      },
      navigate(bin: number | null) {
        const window = windowOf(id)
        if (window) setOwn({ nav: bin === window.bin ? null : bin }, { selectedBin: null })
      },
      setTab(patch: Partial<BinTab>) {
        const { bin, nav, mode, iconSize } = patch
        setOwn(Object.fromEntries(Object.entries({ bin, nav, mode, iconSize }).filter(([, value]) => value !== undefined)))
      },
      // A window has no docked tabs of its own: a tab opened from it is the panel's.
      closeTab: () => undefined,
    }
    instances.set(id, instance)
    return instance
  }
  return main
}

/** The panel's UI state, or a floating bin window's instance of it (`instance`). */
export type ProjectUi = {
  get: () => ProjectUiState
  windows: () => readonly BinWindow[]
  set: (patch: Partial<ProjectUiState>) => void
  hover: { current: { item: number; time: number } | null }
  subscribe: (listener: () => void) => () => void
  toggleBin: (bin: number) => void
  viewChanged: () => void
  shownTab: () => BinTab | null
  navigate: (bin: number | null, root: number | null) => void
  openTab: (bin: number, mode: BinTab['mode'], iconSize: number) => void
  closeTab: (k: number) => void
  setTab: (patch: Partial<BinTab>) => void
  openWindow: (bin: number, mode: BinTab['mode'], iconSize: number, options: { reuse: boolean }) => string
  closeWindow: (id: string) => boolean
  pruneWindows: (root: FilmBin | null) => string[]
  instance: (id: string | null) => ProjectUi
  reveal: (item: number, root: FilmBin | null, list: boolean) => void
  reset: () => void
}

/** A bin of `root`'s tree by id, or null. */
export function findBin(root: FilmBin | null, id: number | null): FilmBin | null {
  if (!root || id == null) return null
  if (root.id === id) return root
  for (const child of root.children)
    if ('children' in child) {
      const found = findBin(child, id)
      if (found) return found
    }
  return null
}

/**
 * The bin the panel (or its shown tab) shows and the top it goes up to, upstream `view_of`: a
 * bin that is gone (deleted, its creation undone) gives way to the tab's own bin, then to the root.
 */
export function shownBin(ui: ProjectUiState, root: FilmBin | null): { bin: number | null; top: number | null } {
  const rootId = root?.id ?? null
  const valid = (id: number | null) => (findBin(root, id) ? id : null)
  const tab = ui.activeTab != null ? ui.tabs[ui.activeTab] : undefined
  if (tab) {
    const top = valid(tab.bin) ?? rootId
    return { bin: valid(tab.nav) ?? top, top }
  }
  return { bin: valid(ui.bin) ?? rootId, top: rootId }
}
