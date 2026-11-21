import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { TesseraIcons } from '@kition/sdk/editor'
import { IconButton, MenuButton, RenameField, isMac, oneInFlight, type ContextMenuPoint, type Phrases } from '@kition/sdk/editor'
import type { FilmBin, FilmSearchBin } from '../film'
import type { FilmLabels } from '../session/useFilmSession'
import { endFilmDrag, filmDrag, startFilmDrag } from '../timeline/drop'
import { FONT_POINTS, binWindowFocus, findBin, keptWidths, iconRows, itemCount, listRows, posterTicks, rowsStillShown, shownBin, type ProjectColumn, type ProjectRow, type ProjectRows, type ProjectUi, type ProjectUiState, type ProjectView } from './projectModel'
import { BackgroundMenu, BinMenu, FreeformCanvasMenu, FreeformCardMenu, HeaderMenu, ItemMenu, NewItemRows, SearchBinMenu, SortIconsRows } from './projectMenus'
import { CardArt, ICONS, OFFLINE, Thumb, labelColor, shortDuration, type ProjectThumbnails } from './projectCards'
import { FreeformView, useFreeformLayout, type FreeformActions, type FreeformPreview } from './FreeformView'
import { cardMenuItems, freeformOptions, layoutCards, previewFreeformCards, visibleCards, type FreeformCard } from './freeform'
import { binPath, openBin, parentBin, type BinOpen, type ProjectRouteDeps } from './projectRoute'
import { previewProjectRows, previewProjectSelection, previewRowKey, previewSearchBins, projectCovers, searchBinMatches, searchBinsShown, thumbStamp, type RowMark, type SearchBinRow } from './projectPreview'
import type { PreviewPictureSource } from '../timeline/media'
import type { PreviewCovers, PreviewDiff } from '../dialogs/preview'
import { previewPictureItems } from '../dialogs/previewViews'
import { PreviewContext, previewCacheKey, useDrawsPreview, usePreviewState } from '../dialogs/usePreview'
import { focusAfterBlur } from '../workspace/editorFocus'

const ArrowDownWideNarrow = TesseraIcons.ArrowDownWideNarrowIcon
const ChevronDown = TesseraIcons.ChevronDownIcon
const ChevronRight = TesseraIcons.ChevronRightIcon
const FilePlus2 = TesseraIcons.FilePlusCornerIcon
const Film = TesseraIcons.FilmIcon
const Folder = TesseraIcons.FolderIcon
const FolderPlus = TesseraIcons.FolderPlusIcon
const FolderUp = TesseraIcons.FolderUpIcon
const LayoutGrid = TesseraIcons.LayoutGridIcon
const List = TesseraIcons.ListIcon
const Search = TesseraIcons.SearchIcon
const Shapes = TesseraIcons.ShapesIcon
const Trash2 = TesseraIcons.TrashIcon
const WandSparkles = TesseraIcons.WandSparklesIcon
const X = TesseraIcons.XIcon

type Invoke = (id: string, params?: Record<string, unknown>) => Promise<unknown>
type Query = (id: string, params?: Record<string, unknown>) => Promise<unknown>

export type { ProjectThumbnails }
type ViewMode = ProjectView['view']['mode']

/** The width of the label chip before the Name column (upstream `LEAD`). */
const LEAD = 26
/** Upstream's bin orange (`project_views.rs` `BIN_COLOR`). */
const BIN_COLOR = '#ed963a'
/** The project file's extension in the breadcrumb (kit.json's format; upstream shows its own project file's). */
const PROJECT_EXTENSION = 'kfilm'

type Data = { view: ProjectView; rows: ProjectRows | null; mode: ViewMode; bin: number | null }

/**
 * `project.items`' params for a view: the List view's whole tree; the Icon view's icon order, which
 * the Freeform view reads too (every item under the bin, for the count; its cards are the bin's own).
 */
const rowParams = (mode: ViewMode, params: { bin?: number }) => (mode === 'list' ? { ...params, recursive: true } : { ...params, order: 'icon' })

/** A row's key: its bin or item. */
const rowKey = (row: ProjectRow) => (row.bin != null ? `b${row.bin}` : `i${row.item}`)

/**
 * The rows read again, each unchanged row keeping the object it had, so a revision that changes
 * one item (a label) draws that row again and no other.
 */
export function shareRows(previous: readonly ProjectRow[] | undefined, next: ProjectRow[]): ProjectRow[] {
  if (!previous?.length) return next
  const old = new Map(previous.map((row) => [rowKey(row), row]))
  return next.map((row) => {
    const before = old.get(rowKey(row))
    return before && JSON.stringify(before) === JSON.stringify(row) ? before : row
  })
}

/**
 * What the panel reads from the engine: the view settings (`project.view.get`) and the rows of
 * the shown bin for the shown view (`project.items`, recursive for the List view, in icon order
 * for the Icon and Freeform views, the Freeform view's cards saying where each sits), one
 * read in flight, again on every revision and every view change. A
 * `viewRefresh` (the view may have changed with no revision) reads the view, and the rows only
 * when the view differs (`rowsStillShown`).
 */
function useProjectData(query: Query, revision: number | null, viewTick: number, viewRefresh: number, bin: number | null, tabMode: ViewMode | null) {
  const [data, setData] = useState<Data | null>(null)
  const want = useRef({ bin, tabMode })
  want.current = { bin, tabMode }
  // Full reads asked for and done (the rows stored): a read is view-only while every one asked is done.
  const fullAsked = useRef(1)
  const fullDone = useRef(0)
  const last = useRef<Data | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const read = useMemo(
    () =>
      oneInFlight(async () => {
        const asked = fullAsked.current
        const viewOnly = asked === fullDone.current
        const read = (await query('project.view.get')) as ProjectView | null
        if (!read) return
        const { bin: shown, tabMode: own } = want.current
        const mode = own ?? read.view.mode
        if (rowsStillShown({ onlyView: viewOnly, before: last.current, view: read, mode, bin: shown })) return
        const params = shown != null ? { bin: shown } : {}
        const answer = (await query('project.items', rowParams(mode, params))) as ProjectRows | null
        if (!mounted.current) return
        const before = last.current
        const view = before && JSON.stringify(before.view) === JSON.stringify(read) ? before.view : read
        const same = before?.rows && answer && before.mode === mode && JSON.stringify(before.rows.columns) === JSON.stringify(answer.columns)
        const rows = answer ? { ...answer, columns: same ? before.rows!.columns : answer.columns, rows: shareRows(before?.mode === mode ? before.rows?.rows : undefined, answer.rows) } : null
        const next = { view, rows, mode, bin: shown }
        last.current = next
        setData(next)
        // Done only once the rows are stored: a failed or empty read leaves the next one full.
        if (answer) fullDone.current = Math.max(fullDone.current, asked)
      }),
    [query],
  )
  useEffect(() => {
    fullAsked.current += 1
    void read()
  }, [read, revision, viewTick, bin, tabMode])
  const firstRefresh = useRef(true)
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false
      return
    }
    void read()
  }, [read, viewRefresh])
  return data
}

/**
 * The project's search bins with their matches (`project.searchBins`), read once per revision
 * while `on` (the List view of the root is shown), one read in flight; the last list stays while
 * the next loads, the same object while nothing in it changed.
 */
function useSearchBins(query: Query, revision: number | null, on: boolean): readonly FilmSearchBin[] {
  const [bins, setBins] = useState<readonly FilmSearchBin[]>(NO_SEARCH_BINS)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const read = useMemo(
    () =>
      oneInFlight(async () => {
        const answer = (await query('project.searchBins')) as FilmSearchBin[] | null
        if (!mounted.current || !Array.isArray(answer)) return
        setBins((shown) => (JSON.stringify(shown) === JSON.stringify(answer) ? shown : answer))
      }),
    [query],
  )
  useEffect(() => {
    if (on) void read()
  }, [read, revision, on])
  return on ? bins : NO_SEARCH_BINS
}

/** What the Project panel draws of a dialog's preview: the preview's view and rows of the bin shown, its selection, and its diff, all of one preview. */
/** `layout`: the Freeform view's cards on the preview's copy (`project.freeform.layout`), laid out for `width`. */
type PreviewData = { key: string; view: ProjectView | null; rows: ProjectRows | null; mode: Data['mode']; bin: number | null; diff: PreviewDiff | null; highlight: readonly number[] | null; searchBins: FilmSearchBin[]; layout: FreeformCard[] | null; width: number }

const parse = (raw: unknown) => {
  if (typeof raw !== 'string') return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * A dialog's preview as the Project panel reads it (Task 10): under the `project` kind its view
 * (`project.view.get`) and the shown bin's rows (`project.items`) through `previewQuery` on the
 * scratch session once per preview, one read in flight, and in the Freeform view its cards
 * (`project.freeform.layout` for the panel's width, Task 19); under `selection` its diff (the Project
 * selection is the document's with the diff's changes, `previewProjectSelection`). A read for another preview (or document) is dropped (lesson 6);
 * the last one stays while the next loads.
 */
function useProjectPreview(project: boolean, selection: boolean, bin: number | null, tabMode: ViewMode | null, width: number): PreviewData | null {
  const context = useContext(PreviewContext)
  const state = usePreviewState()
  const key = (project || selection) && context ? previewCacheKey(state) : null
  const [data, setData] = useState<PreviewData | null>(null)
  // The reads one after another: a read queued behind one in flight runs only if it is still wanted.
  const chain = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    if (!key || !context) {
      setData(null)
      return undefined
    }
    let live = true
    const current = () => live && previewCacheKey(context.preview.get()) === key
    const { diff, highlight } = context.preview.get()
    chain.current = chain.current.then(async () => {
      if (!current()) return
      const engine = context.preview.engine()
      if (!engine) return
      const ask = (command: string, params: Record<string, unknown> = {}) => engine.invoke('previewQuery', command, JSON.stringify(params)).then(parse, () => null)
      const view = project ? ((await ask('project.view.get')) as ProjectView | null) : null
      const mode = tabMode ?? view?.view.mode ?? 'icon'
      const params = bin != null ? { bin } : {}
      const rows = project && view ? ((await ask('project.items', rowParams(mode, params))) as ProjectRows | null) : null
      // The Freeform view's cards on the copy, once the panel's width is known.
      const layout = project && view && mode === 'freeform' && width > 0 ? layoutCards(await ask('project.freeform.layout', { ...params, width })) : null
      // A search bin the preview adds (Create Search Bin), with its matches: an added bin that is no search bin answers nothing.
      const searchBins: FilmSearchBin[] = []
      if (project && mode === 'list')
        for (const entry of diff?.bins?.added ?? []) {
          const found = (await ask('project.searchBinItems', { bin: entry.id })) as { bin?: number; name?: string; items?: number[] } | null
          if (found && Array.isArray(found.items)) searchBins.push({ bin: found.bin ?? entry.id, name: found.name ?? '', items: found.items })
        }
      if (!current()) return
      setData({ key, view, rows, mode, bin, diff, highlight: highlight?.items ?? null, searchBins, layout, width })
    }).catch(() => undefined)
    return () => {
      live = false
    }
  }, [key, context, project, selection, bin, tabMode, width])
  const open = state.open && data != null && data.key.split(':')[0] === String(state.document)
  return open ? data : null
}

/** `card` and `canvas`: the Freeform view's card menu (with the items it acts on, named as it opens) and canvas menu. */
type Menu = { kind: 'card'; at: ContextMenuPoint; row: ProjectRow; card: FreeformCard; items: readonly number[] } | { kind: 'canvas'; at: ContextMenuPoint } | { kind: 'item'; at: ContextMenuPoint; row: ProjectRow } | { kind: 'bin'; at: ContextMenuPoint; bin: number } | { kind: 'searchBin'; at: ContextMenuPoint; bin: number } | { kind: 'background'; at: ContextMenuPoint } | { kind: 'header'; at: ContextMenuPoint }

/** The rename in progress on one row, or null. */
type Renaming = { text: string } | null

/**
 * What a row or card does, the same object for the panel's life: it reads the panel's latest
 * selection, rows, and state when it acts, so the rows (memoized) do not draw again for it.
 */
type Actions = {
  clickItem: (event: ReactMouseEvent, item: number) => void
  nameClick: (event: ReactMouseEvent, row: ProjectRow) => void
  openItem: (row: ProjectRow) => void
  clickBin: (event: ReactMouseEvent, bin: number, toggleIfSelected: boolean) => void
  openBin: (event: ReactMouseEvent, bin: number) => void
  toggleBin: (bin: number) => void
  dragItem: (event: ReactDragEvent, item: number) => void
  binOver: (event: ReactDragEvent, bin: number) => void
  binLeave: (event: ReactDragEvent, bin: number) => void
  binDrop: (event: ReactDragEvent, bin: number) => void
  menu: (event: ReactMouseEvent, menu: { row: ProjectRow } | { bin: number } | { searchBin: number } | { header: true }) => void
  renameText: (text: string) => void
  renameDone: (commit: boolean) => void
  sort: (column: string) => void
  /** Answers whether the engine took the width. */
  resize: (column: string, width: number) => Promise<boolean>
}

export type ProjectPanelProps = {
  root: FilmBin | null
  projectName: string
  selection: readonly number[]
  labels: FilmLabels | null
  revision: number | null
  ui: ProjectUi
  /** Moves when the view may have changed with no revision (`useFilmSession`'s `projectView`). */
  viewRefresh: number
  thumbnails: ProjectThumbnails
  /** The open preview's pictures (`TimelineMedia.previewThumbnails`), for the items only it has or whose picture it changes. */
  previewPictures: (key: string, source: PreviewPictureSource) => ProjectThumbnails
  deps: ProjectRouteDeps
  invoke: Invoke
  query: Query
  phrase: Phrases
  notAvailable: string
  status: (text: string) => void
  /** The status bar for engine and error text (`App`'s `errorStatus`); `status` when absent. */
  errorStatus?: (text: string) => void
  /**
   * The floating bin window this instance draws (upstream `floating`'s body, `Inst::Tab`), with
   * `ui` its instance; absent for the panel itself. A window draws no tab strip.
   */
  window?: string
}

/**
 * The Project panel (upstream `panels/project.rs` and `project_views.rs`): bin tabs, the
 * breadcrumb with Up One Level, the search and item count, the Preview Area, the List or Icon
 * view, and the footer. View settings, sorting, columns, and the selection are the engine's;
 * the search, the open bins, the bin shown, and the rename are the panel's (`ProjectUi`).
 */
export const ProjectPanel = memo(function ProjectPanel({ root, projectName, selection, labels, revision, ui, viewRefresh, thumbnails, previewPictures, deps, invoke, query, phrase, notAvailable, status, errorStatus = status, window: floating }: ProjectPanelProps) {
  const state = useSyncExternalStore(ui.subscribe, ui.get)
  const rootId = root?.id ?? null
  const tab = state.activeTab != null ? (state.tabs[state.activeTab] ?? null) : null
  const { bin, top } = shownBin(state, root)
  const data = useProjectData(query, revision, state.viewTick, viewRefresh, bin, tab?.mode ?? null)
  // A dialog's preview (Task 10): the panel draws its project and selection kinds while shown.
  const previewState = usePreviewState()
  const previewContext = useContext(PreviewContext)
  const previewKinds = previewState.open ? previewState.kinds : NO_KINDS
  const previewData = useProjectPreview(previewKinds.includes('project'), previewKinds.includes('selection'), bin, tab?.mode ?? null, state.freeformWidth)
  const view = previewData?.view ?? data?.view ?? null
  const mode = tab?.mode ?? view?.view.mode ?? 'icon'
  const iconSizeShown = tab?.iconSize ?? view?.view.iconSize ?? 110
  const [dragSize, setDragSize] = useState<number | null>(null)
  const iconSize = dragSize ?? iconSizeShown
  const font = FONT_POINTS[view?.view.fontSize ?? 'medium']
  const documentRows = useMemo(() => (data && data.mode === mode && data.bin === bin ? (data.rows?.rows ?? []) : []), [data, mode, bin])
  // The preview's rows: each unchanged one the document's own object, so only the rows it changes draw again.
  const merged = useMemo(() => {
    if (!previewData?.rows || previewData.mode !== mode || previewData.bin !== bin) return null
    const comparable = data != null && data.mode === mode && data.bin === bin
    return comparable ? previewProjectRows(documentRows, previewData.rows.rows, previewData.diff) : { rows: previewData.rows.rows, marks: NO_MARKS }
  }, [previewData, data, documentRows, mode, bin])
  const rows = merged?.rows ?? documentRows
  const columns = (merged ? previewData?.rows?.columns : null) ?? data?.rows?.columns ?? view?.view.columns ?? []
  // The columns a preview shows that the document does not (Metadata Display), outlined in the header.
  const documentColumns = data?.rows?.columns
  const addedColumns = useMemo(() => (merged && previewData?.rows && documentColumns ? new Set(previewData.rows.columns.filter((column) => !documentColumns.some((each) => each.name === column.name)).map((column) => column.name)) : NO_NAMES), [merged, previewData, documentColumns])
  // Named by the open preview, as the Timeline names it: one cache, dropped when the preview closes.
  const pictureKey = previewData ? previewCacheKey(previewState) : null
  const previewView = useMemo<PreviewRows>(() => {
    const key = pictureKey
    const pictures = key && previewContext ? previewPictures(key, { engine: previewContext.preview.engine, current: () => previewCacheKey(previewContext.preview.get()) }) : undefined
    const chosen = previewData && previewKinds.includes('selection') ? previewProjectSelection(selection, previewData.diff, previewData.highlight) : null
    const stamps = merged ? new Map(documentRows.flatMap((row) => (row.item != null ? [[row.item, row.stamp] as const] : []))) : NO_STAMPS
    return { marks: merged?.marks ?? NO_MARKS, selection: chosen, pictures, pictureItems: previewPictureItems(previewData?.diff ?? null), stamps }
  }, [previewData, merged, documentRows, previewContext, previewPictures, pictureKey, previewKinds, selection])
  // The Freeform view (Task 19): the bin's cards where the engine puts them, read per document,
  // bin, revision, width, and options; an open preview's where its copy puts them, with the cards
  // it removes at their places. The search shows the cards of the items whose name holds it.
  const freeformShown = mode === 'freeform'
  const documentOptions = useMemo(() => (data ? freeformOptions(data.view) : null), [data?.view])
  const shownOptions = useMemo(() => freeformOptions(view), [view])
  const documentLayout = useFreeformLayout(query, { on: freeformShown, document: rootId, bin, revision, width: state.freeformWidth, options: documentOptions })
  const freeformCards = useMemo(() => {
    if (!freeformShown) return NO_CARDS
    const own = documentLayout ?? NO_CARDS
    return previewData?.layout && previewData.mode === 'freeform' && previewData.bin === bin ? previewFreeformCards(own, previewData.layout) : own
  }, [freeformShown, documentLayout, previewData, bin])
  const rowsByItem = useMemo(() => new Map(rows.flatMap((row) => (row.item != null ? [[row.item, row] as const] : []))), [rows])
  const shownCards = useMemo(() => (freeformShown ? visibleCards(freeformCards, rowsByItem, state.search) : NO_CARDS), [freeformShown, freeformCards, rowsByItem, state.search])
  const freeformPreview = useMemo<FreeformPreview>(() => ({ marks: previewView.marks, selection: previewView.selection, picture: (row) => ({ thumbnails: pictureSource(previewView, row, thumbnails), stamp: pictureStamp(previewView, row) }) }), [previewView, thumbnails])
  const colorOf = useCallback((row: ProjectRow) => labelColor(labels, row.label), [labels])
  const [menu, setMenu] = useState<Menu | null>(null)
  const selected = useMemo(() => new Set(selection), [selection])
  const parentForNew = bin != null && bin !== rootId ? bin : null
  const [dropBin, setDropBin] = useState<number | null>(null)

  // The latest of what the actions read.
  const now = useRef({ selection, selected, rows, root, state })
  now.current = { selection, selected, rows, root, state }
  const slow = useRef<number | null>(null)
  useEffect(() => () => {
    if (slow.current != null) window.clearTimeout(slow.current)
  }, [])

  const open = useCallback(
    (target: number, how: BinOpen | null, mods: { command?: boolean; alt?: boolean } = {}) => {
      // In place in this instance (the panel, or this window); a new tab or window is the panel's.
      void openBin({ ...deps, ui }, target, how, mods).catch((error: unknown) => errorStatus(error instanceof Error ? error.message : String(error)))
    },
    [deps, errorStatus, ui],
  )

  const actions = useMemo<Actions>(() => {
    const payloadOf = (event: ReactDragEvent) => {
      const payload = filmDrag(event.dataTransfer)
      return payload && payload.sourceIn === undefined ? payload : null
    }
    return {
      /** A click on an item (upstream `item_interactions`): Cmd (Ctrl) or Shift toggles it in the selection. */
      clickItem(event, item) {
        const { selection: chosen, selected: has, state: shown } = now.current
        const toggle = (isMac() ? event.metaKey : event.ctrlKey) || event.shiftKey
        const next = toggle ? (has.has(item) ? chosen.filter((each) => each !== item) : [...chosen, item]) : [item]
        if (shown.selectedBin != null) ui.set({ selectedBin: null })
        void invoke('project.select', { items: next })
      },
      /** A second click on the only selected item's name, after the double-click time, renames it (upstream `slow_click_rename`). */
      nameClick(event, row) {
        if (slow.current != null) window.clearTimeout(slow.current)
        slow.current = null
        const chosen = now.current.selection
        if (row.item == null || event.detail > 1 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        if (!(chosen.length === 1 && chosen[0] === row.item)) return
        const item = row.item
        slow.current = window.setTimeout(() => {
          slow.current = null
          ui.set({ rename: { item, bin: null, text: row.name } })
        }, 500)
      },
      /**
       * A double-click opens a sequence in the Timeline and anything else in the Source monitor; on
       * a Color Matte it selects it and opens its colour picker (upstream `item_interactions`).
       */
      openItem(row) {
        if (row.item == null) return
        if (row.matte) {
          const item = row.item
          void invoke('project.select', { items: [item] }).then(() => invoke('project.matteColor', {}))
          return
        }
        void invoke(row.kind === 'sequence' ? 'sequence.open' : 'source.open', { item: row.item })
      },
      /** A click on a bin selects it; in the List view a click on the selected bin folds or opens it. */
      clickBin(event, target, toggleIfSelected) {
        if (event.detail > 1) return
        if (toggleIfSelected && now.current.state.selectedBin === target) ui.toggleBin(target)
        ui.set({ selectedBin: target })
        void invoke('project.select', { items: [] })
      },
      openBin(event, target) {
        open(target, null, { command: isMac() ? event.metaKey : event.ctrlKey, alt: event.altKey })
      },
      toggleBin: (target) => ui.toggleBin(target),
      /** Dragging an item: onto the Timeline (its drop target), or onto a bin (upstream `accept_bin_drop`). */
      dragItem(event, item) {
        startFilmDrag(event.nativeEvent, { item })
      },
      binOver(event, target) {
        if (!payloadOf(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropBin((shown) => (shown === target ? shown : target))
      },
      /** Leaving the bin, not just moving onto one of its children. */
      binLeave(event, target) {
        const into = event.relatedTarget as Node | null
        if (into && event.currentTarget.contains(into)) return
        setDropBin((shown) => (shown === target ? null : shown))
      },
      binDrop(event, target) {
        const payload = payloadOf(event)
        setDropBin(null)
        if (!payload) return
        event.preventDefault()
        endFilmDrag()
        const { selection: chosen, selected: has } = now.current
        void invoke('project.moveToBin', { items: has.has(payload.item) ? [...chosen] : [payload.item], bin: target })
      },
      menu(event, which) {
        event.preventDefault()
        const at = { x: event.clientX, y: event.clientY }
        setMenu('row' in which ? { kind: 'item', at, row: which.row } : 'searchBin' in which ? { kind: 'searchBin', at, bin: which.searchBin } : 'header' in which ? { kind: 'header', at } : { kind: 'bin', at, bin: which.bin })
      },
      renameText(text) {
        const rename = ui.get().rename
        if (rename) ui.set({ rename: { ...rename, text } })
      },
      renameDone(commit) {
        const rename = ui.get().rename
        ui.set({ rename: null })
        if (!commit || !rename) return
        const name = rename.text.trim()
        if (!name) return
        if (rename.item != null) {
          if (now.current.rows.find((row) => row.item === rename.item)?.name !== name) void invoke('clip.rename', { item: rename.item, name })
        } else if (rename.bin != null && findBin(now.current.root, rename.bin)?.name !== name) void invoke('project.renameBin', { bin: rename.bin, name })
      },
      sort: (column) => void invoke('project.sort', { column }),
      resize: async (column, width) => {
        const answer = await invoke('project.columns.resize', { column, width })
        return answer != null
      },
    }
  }, [invoke, notAvailable, open, status, ui])

  // The Freeform view's actions: a card's own menu acts on the items named as it opens (the card,
  // or the selection holding it), never a selection that lands later.
  const emptyNow = useRef<{ onClick: () => void; onDoubleClick: () => void } | null>(null)
  const freeformActions = useMemo<FreeformActions>(
    () => ({
      clickItem: actions.clickItem,
      openItem: actions.openItem,
      renameText: actions.renameText,
      renameDone: actions.renameDone,
      cardMenu(event, row, card) {
        setMenu({ kind: 'card', at: { x: event.clientX, y: event.clientY }, row, card, items: cardMenuItems(now.current.selection, card.item) })
      },
      canvasMenu(event) {
        setMenu({ kind: 'canvas', at: { x: event.clientX, y: event.clientY } })
      },
      emptyClick: () => emptyNow.current?.onClick(),
      emptyDoubleClick: () => emptyNow.current?.onDoubleClick(),
      move: (params) => void invoke('project.freeform.move', params),
    }),
    [actions, invoke],
  )

  // A rename whose item or bin has left the rows (deleted, moved away) is dropped.
  useEffect(() => {
    const rename = state.rename
    if (!rename || !data) return
    const there = rows.some((row) => (rename.item != null ? row.item === rename.item : row.bin === rename.bin))
    if (!there) ui.set({ rename: null })
  }, [data, rows, state.rename, ui])

  const total = itemCount(previewView.marks.size ? rows.filter((row) => previewView.marks.get(previewRowKey(row))?.mark !== 'removed') : rows)
  const count =
    selection.length > 0
      ? (total === 1 ? phrase('{sel} of 1 item selected') : phrase('{sel} of {total} items selected').replace('{total}', String(total))).replace('{sel}', String(selection.length))
      : (total === 1 ? phrase('1 item') : phrase('{total} items').replace('{total}', String(total)))
  const crumb = [`${projectName}.${PROJECT_EXTENSION}`, ...binPath(root, bin)].join(' / ')
  const canUp = bin !== top

  // Upstream's footer `set_mode`: the Freeform view has no command of its own (a bin tab's view is its own).
  const setMode = (next: ViewMode) => {
    if (next !== 'freeform') return void invoke(next === 'list' ? 'projectPanel.viewList' : 'projectPanel.viewIcon', {})
    if (tab) ui.setTab({ mode: 'freeform' })
    else void invoke('project.view.set', { view: 'freeform' })
  }
  const commitSize = (size: number) => {
    setDragSize(null)
    if (size === iconSizeShown) return
    if (tab) ui.setTab({ iconSize: size })
    else void invoke('project.view.set', { iconSize: size })
  }
  const preview = view?.previewArea ? (rows.find((row) => row.item != null && row.item === selection[0]) ?? null) : null

  const empty = useMemo(
    () => ({
      onClick: () => {
        if (ui.get().selectedBin != null) ui.set({ selectedBin: null })
        void invoke('project.select', { items: [] })
      },
      onDoubleClick: () => void invoke('file.import', bin != null ? { bin } : {}),
      onContextMenu: (event: ReactMouseEvent) => {
        event.preventDefault()
        setMenu({ kind: 'background', at: { x: event.clientX, y: event.clientY } })
      },
    }),
    [bin, invoke, ui],
  )
  emptyNow.current = empty
  const shownList = useMemo(() => listRows(rows, state.expanded, state.search), [rows, state.expanded, state.search])
  // The search bins (upstream `search_bin_rows`): in the List view of the project's root, after
  // its rows, read once per revision while shown (`project.searchBins`).
  const listsSearchBins = searchBinsShown({ mode, tab: tab != null, bin, root: rootId })
  const searchBins = useSearchBins(query, revision, listsSearchBins)
  const previewSearch = previewData?.searchBins ?? null
  const shownSearchBins = useMemo(() => (listsSearchBins ? previewSearchBins(searchBins, previewSearch) : NO_SEARCH_BINS), [listsSearchBins, searchBins, previewSearch])
  const shownIcons = useMemo(() => iconRows(rows, state.search), [rows, state.search])
  // What it draws of a preview: the rows on show (the bin shown, its open bins, the search; the
  // Freeform view's cards); the strip lists the rest.
  const drawnKeys = useMemo(
    () => new Set([...(mode === 'list' ? shownList.map(previewRowKey) : mode === 'icon' ? shownIcons.map(previewRowKey) : shownCards.map((card) => `i${card.item}`)), ...shownSearchBins.map((each) => `b${each.bin}`)]),
    [mode, shownList, shownIcons, shownCards, shownSearchBins],
  )
  // A bin whose only change is its items is drawn once the rows it gains and loses are (projectCovers).
  const previewDiff = previewData?.diff ?? null
  const coversProject = useMemo<PreviewCovers>(() => projectCovers(drawnKeys, previewDiff), [drawnKeys, previewDiff])
  const coverKey = useMemo(() => ({ drawnKeys, previewDiff }), [drawnKeys, previewDiff])
  const panelRoot = useRef<HTMLDivElement>(null)
  useDrawsPreview('project', true, coversProject, coverKey, panelRoot)
  useDrawsPreview('selection:project', true, coversProject, coverKey, panelRoot)
  // The List view on screen draws a view preference's preview (Metadata Display's columns), and the
  // Freeform view Freeform View Options' (its cards laid out with them).
  useDrawsPreview('project:view', mode === 'list', undefined, undefined, panelRoot)
  useDrawsPreview('project:freeform', freeformShown, undefined, undefined, panelRoot)
  const shared = { state, selected, labels, revision, thumbnails, dropBin, phrase, actions, empty, preview: previewView }

  const body = !data ? null : mode === 'freeform' ? (
    <FreeformView
      cards={shownCards}
      rows={rowsByItem}
      options={shownOptions}
      font={font}
      hoverScrub={view?.hoverScrub ?? true}
      touchScrub={view?.thumbnailControlsAllDevices === true}
      selection={selection}
      selected={selected}
      state={state}
      colors={colorOf}
      revision={revision}
      preview={freeformPreview}
      ui={ui}
      actions={freeformActions}
      phrase={phrase}
    />
  ) : mode === 'list' ? (
    <ListView rows={shownList} searchBins={shownSearchBins} allRows={rows} columns={columns} addedColumns={addedColumns} sort={view?.view.sort ?? { column: 'Name', descending: false }} font={font} thumbs={view?.thumbnails === true} {...shared} />
  ) : (
    <IconView rows={shownIcons} size={iconSize} font={font} hoverScrub={view?.hoverScrub ?? true} touchScrub={view?.thumbnailControlsAllDevices === true} ui={ui} {...shared} />
  )

  return (
    <div ref={panelRoot} className="film-project" style={{ '--film-project-font': `${font}px` } as CSSProperties} data-testid={floating != null ? `film-project-window-${floating}` : 'film-project'} data-view={mode}>
      {state.tabs.length && floating == null ? (
        <div className="film-project-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={state.activeTab == null} className="film-project-tab" data-kit-ui-id="control:project.tab.project" data-testid="film-project-tab-project" onClick={() => ui.set({ activeTab: null })}>
            {phrase('Project: {name}').replace('{name}', projectName)}
          </button>
          {state.tabs.map((each, k) => (
            <span key={`${each.bin}-${k}`} className="film-project-tab" aria-selected={state.activeTab === k} data-kit-ui-id="control:project.tab">
              <button type="button" role="tab" aria-selected={state.activeTab === k} data-kit-ui-id="control:project.tab" data-testid={`film-project-tab-${k}`} onClick={() => ui.set({ activeTab: k })} onAuxClick={(event) => event.button === 1 && ui.closeTab(k)}>
                {phrase('Bin: {name}').replace('{name}', findBin(root, each.bin)?.name ?? '')}
              </button>
              <button type="button" className="film-project-tab-close" aria-label={phrase('Close')} title={phrase('Close')} data-kit-ui-id="control:project.tab.close" data-testid={`film-project-tab-${k}-close`} onClick={() => ui.closeTab(k)}>
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="film-project-head">
        <button
          type="button"
          className="film-project-up"
          disabled={!canUp}
          aria-label={phrase('Up one level')}
          title={phrase('Up one level')}
          data-kit-ui-id="control:project.up"
          data-testid="film-project-up"
          onClick={() => ui.navigate(parentBin(root, bin), rootId)}
        >
          <FolderUp size={14} aria-hidden="true" />
        </button>
        <span className="film-project-crumb" title={crumb} data-kit-ui-id="control:project.breadcrumb" data-testid="film-project-breadcrumb">
          {crumb}
        </span>
        {previewData ? (
          <span className="film-preview-badge film-project-preview-badge" data-testid="film-project-preview-badge">
            {phrase('Preview')}
          </span>
        ) : null}
      </div>
      <div className="film-project-search-row">
        <label className="film-project-search" data-kit-ui-id="control:project.search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={state.search}
            placeholder={phrase('Search')}
            aria-label={phrase('Search')}
            data-film-search={floating != null ? binWindowFocus(floating) : 'project'}
            data-testid="film-project-search"
            onChange={(event) => ui.set({ search: event.target.value })}
            onKeyDown={(event) => {
              event.stopPropagation()
              // Escape lets go of the field: its window (or the editor) keeps the keys (lesson 2).
              if (event.key === 'Escape') focusAfterBlur(event.currentTarget, document)
            }}
          />
        </label>
        <button type="button" className="film-project-tool" aria-label={phrase('Find…')} title={phrase('Find…')} data-kit-ui-id="control:project.find" data-testid="film-project-find" onClick={() => void invoke('edit.find', {})}>
          <Search size={14} aria-hidden="true" />
        </button>
        <span className="film-project-count" data-kit-ui-id="control:project.count" data-testid="film-project-count">
          {count}
        </span>
      </div>
      {/* The Preview Area's picture comes from the same cache, under the same stamp, as the item's row (`pictureSource`, `pictureStamp`). */}
      {view?.previewArea ? <PreviewArea row={preview} thumbnails={preview ? pictureSource(previewView, preview, thumbnails) : thumbnails} stamp={preview ? pictureStamp(previewView, preview) : null} revision={revision} phrase={phrase} /> : null}
      <div className="film-project-content">{body}</div>
      <div className="film-project-footer">
        <span className="film-project-footer-group">
          <IconButton icon={List} label={phrase('List View')} pressed={mode === 'list'} onClick={() => setMode('list')} data-kit-ui-id="control:project.view" data-testid="film-project-view-list" />
          <IconButton icon={LayoutGrid} label={phrase('Icon View')} pressed={mode === 'icon'} onClick={() => setMode('icon')} data-kit-ui-id="control:project.view" data-testid="film-project-view-icon" />
          <IconButton icon={Shapes} label={phrase('Freeform View')} pressed={mode === 'freeform'} onClick={() => setMode('freeform')} data-kit-ui-id="control:project.view" data-testid="film-project-view-freeform" />
          <input
            type="range"
            className="film-project-size"
            min={48}
            max={400}
            value={Math.round(iconSize)}
            style={{ '--film-project-size-fill': `${((iconSize - 48) / (400 - 48)) * 100}%` } as CSSProperties}
            aria-label={phrase('Zoom')}
            title={phrase('Zoom')}
            data-kit-ui-id="control:project.iconSize"
            data-testid="film-project-icon-size"
            onChange={(event) => setDragSize(Number(event.target.value))}
            onPointerUp={(event) => commitSize(Number(event.currentTarget.value))}
            onKeyUp={(event) => commitSize(Number(event.currentTarget.value))}
            onBlur={(event) => dragSize != null && commitSize(Number(event.currentTarget.value))}
          />
          {mode === 'icon' ? (
            <MenuButton placement="auto" trigger={({ toggle, open: shown }) => <IconButton icon={ArrowDownWideNarrow} label={phrase('Sort Icons')} aria-expanded={shown} onClick={toggle} data-kit-ui-id="control:project.sortIcons" data-testid="film-project-sort-icons" />}>
              <SortIconsRows sort={view?.view.iconSort ?? { column: '', descending: false }} phrase={phrase} run={(params) => void invoke('project.view.set', params)} />
            </MenuButton>
          ) : null}
        </span>
        <span className="film-project-footer-group">
          <IconButton icon={WandSparkles} label={phrase('Automate to Sequence')} onClick={() => void invoke('clip.automateToSequence', {})} data-kit-ui-id="control:project.button.clip.automateToSequence" data-testid="film-project-automate" />
          <IconButton icon={Search} label={phrase('Find')} onClick={() => void invoke('edit.find', {})} data-kit-ui-id="control:project.button.find" data-testid="film-project-footer-find" />
          <IconButton icon={FolderPlus} label={phrase('New Bin')} onClick={() => void invoke('file.newBin', { name: phrase('New Bin'), parent: parentForNew })} data-kit-ui-id="control:project.button.file.newBin" data-testid="film-project-new-bin" />
          <MenuButton align="end" placement="auto" trigger={({ toggle, open: shown }) => <IconButton icon={FilePlus2} label={phrase('New Item')} aria-expanded={shown} onClick={toggle} data-kit-ui-id="control:project.button.new-item" data-testid="film-project-new-item" />}>
            <NewItemRows invoke={invoke} phrase={phrase} />
          </MenuButton>
          <IconButton
            icon={Trash2}
            label={phrase('Clear (Delete)')}
            onClick={() => (selection.length ? void invoke('project.delete', {}) : status(phrase('Select items to clear')))}
            data-kit-ui-id="control:project.button.project.delete"
            data-testid="film-project-delete"
          />
        </span>
      </div>
      <FreeformCardMenu
        at={menu?.kind === 'card' ? menu.at : null}
        row={menu?.kind === 'card' ? menu.row : null}
        card={menu?.kind === 'card' ? menu.card : null}
        items={menu?.kind === 'card' ? menu.items : NO_ITEMS}
        cardSize={shownOptions.cardSize}
        width={state.freeformWidth}
        onClose={() => setMenu(null)}
        invoke={invoke}
        phrase={phrase}
        labels={labels}
        ui={ui}
      />
      <FreeformCanvasMenu at={menu?.kind === 'canvas' ? menu.at : null} bin={bin} root={rootId} width={state.freeformWidth} onClose={() => setMenu(null)} invoke={invoke} query={query} phrase={phrase} />
      <ItemMenu at={menu?.kind === 'item' ? menu.at : null} row={menu?.kind === 'item' ? menu.row : null} onClose={() => setMenu(null)} invoke={invoke} phrase={phrase} labels={labels} ui={ui} />
      <BinMenu at={menu?.kind === 'bin' ? menu.at : null} bin={menu?.kind === 'bin' ? menu.bin : null} onClose={() => setMenu(null)} invoke={invoke} phrase={phrase} open={(target, how) => open(target, how)} />
      <SearchBinMenu at={menu?.kind === 'searchBin' ? menu.at : null} bin={menu?.kind === 'searchBin' ? menu.bin : null} onClose={() => setMenu(null)} invoke={invoke} phrase={phrase} />
      <HeaderMenu at={menu?.kind === 'header' ? menu.at : null} onClose={() => setMenu(null)} invoke={invoke} phrase={phrase} />
      <BackgroundMenu at={menu?.kind === 'background' ? menu.at : null} onClose={() => setMenu(null)} invoke={invoke} phrase={phrase} bin={bin != null ? bin : null} />
    </div>
  )
})

/** Upstream's Preview Area: the selected item's poster frame and its properties. */
function PreviewArea({ row, thumbnails, stamp, revision, phrase }: { row: ProjectRow | null; thumbnails: ProjectThumbnails; stamp: string | null; revision: number | null; phrase: Phrases }) {
  if (!row)
    return (
      <div className="film-project-preview" data-kit-ui-id="control:project.previewArea" data-testid="film-project-preview">
        <span className="film-project-preview-empty">{phrase('Select an item to preview it')}</span>
      </div>
    )
  const info = row.info
  const lines = [
    `${phrase(row.type ?? '')}${row.hasVideo && info?.videoInfo ? `, ${info.videoInfo}` : ''}`,
    [info?.mediaDuration, info?.frameRate].filter(Boolean).join(', '),
    info?.audioInfo ?? '',
    phrase('Video Usage: {vu}  Audio Usage: {au}').replace('{vu}', String(row.usage?.[0] ?? 0)).replace('{au}', String(row.usage?.[1] ?? 0)),
  ].filter(Boolean)
  return (
    <div className="film-project-preview" data-kit-ui-id="control:project.previewArea" data-testid="film-project-preview">
      {/* Each item its own picture: the last item's never shows for the next (a sound after a movie). */}
      <Thumb key={row.item} row={row} width={142} height={80} ticks={posterTicks(row)} thumbnails={thumbnails} stamp={stamp} revision={revision} testId="film-project-preview-thumb" />
      <span className="film-project-preview-lines">
        <strong>{row.name}</strong>
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </div>
  )
}

/** What the rows draw of a preview: the marks by row key, the preview's selection, and its pictures with the items that read them. */
/** `stamps`: the document's rows' stamps while a preview shows its rows (`thumbStamp`). */
type PreviewRows = { marks: ReadonlyMap<string, RowMark>; selection: ReadonlySet<number> | null; pictures: ProjectThumbnails | undefined; pictureItems: ReadonlySet<number>; stamps: ReadonlyMap<number, string | null | undefined> }
const NO_STAMPS: ReadonlyMap<number, string | null | undefined> = new Map()
const NO_MARKS: ReadonlyMap<string, RowMark> = new Map()
const NO_SEARCH_BINS: readonly SearchBinRow[] = []
const NO_ROWS: readonly ProjectRow[] = []
const NO_KINDS: readonly string[] = []
const NO_CARDS: readonly FreeformCard[] = []
const NO_ITEMS: readonly number[] = []
const NO_NAMES: ReadonlySet<string> = new Set()

type ViewProps = {
  preview: PreviewRows
  state: ProjectUiState
  selected: ReadonlySet<number>
  labels: FilmLabels | null
  revision: number | null
  thumbnails: ProjectThumbnails
  dropBin: number | null
  phrase: Phrases
  actions: Actions
  empty: { onClick: () => void; onDoubleClick: () => void; onContextMenu: (event: ReactMouseEvent) => void }
}

/** Where a row's picture comes from: the open preview's, for an item only it has or whose picture it changes, else the panel's cache. */
const fromPreview = (preview: PreviewRows, row: ProjectRow) => preview.pictures != null && row.item != null && preview.pictureItems.has(row.item)
const pictureSource = (preview: PreviewRows, row: ProjectRow, own: ProjectThumbnails) => (fromPreview(preview, row) ? (preview.pictures as ProjectThumbnails) : own)
/** The stamp `row`'s thumbnail is keyed on, for the cache `pictureSource` names. */
const pictureStamp = (preview: PreviewRows, row: ProjectRow) => thumbStamp(row, fromPreview(preview, row), preview.stamps)

/** The rename field on a row or card. */
function RenameSpot({ renaming, actions, phrase, testId }: { renaming: NonNullable<Renaming>; actions: Actions; phrase: Phrases; testId: string }) {
  return (
    <span className="film-project-rename" data-kit-ui-id="control:project.rename">
      <RenameField value={renaming.text} label={phrase('Rename')} onChange={actions.renameText} onDone={actions.renameDone} testId={testId} />
    </span>
  )
}

/** The rename on this item or bin, or null. */
const renamingOf = (state: ProjectUiState, item: number | null, bin: number | null): Renaming => {
  const rename = state.rename
  return rename && rename.item === item && rename.bin === bin ? { text: rename.text } : null
}

/** Column widths for the rows: the engine's, a resize in progress over them. */
type ListLayout = { columns: readonly ProjectColumn[]; widths: readonly number[]; total: number; rowHeight: number; thumbs: boolean }

/**
 * The List view (upstream `list_view`, `list_bin`): a pinned header of the shown columns (a click
 * sorts, the edge resizes), bins that fold, and item rows with the label chip and each column's
 * text; the Label column shows the swatch and the label's name.
 */
function ListView({ rows, searchBins, allRows, columns, addedColumns, sort, font, thumbs, ...props }: ViewProps & { rows: ProjectRow[]; searchBins: readonly SearchBinRow[]; allRows: readonly ProjectRow[]; columns: readonly ProjectColumn[]; addedColumns: ReadonlySet<string>; sort: { column: string; descending: boolean }; font: number; thumbs: boolean }) {
  const { state, selected, labels, phrase, actions } = props
  const [widths, setWidths] = useState<Record<string, number>>({})
  // A local width gives way once the engine's agrees with it (the resize landed), or its column goes.
  useEffect(() => {
    setWidths((local) => keptWidths(local, columns) as Record<string, number>)
  }, [columns])
  const rowHeight = thumbs ? Math.max(font * 3.6, 44) : Math.max(font * 2, 22)
  const layout = useMemo<ListLayout>(() => {
    const shown = columns.map((column) => widths[column.name] ?? column.width)
    return { columns, widths: shown, total: LEAD + shown.reduce((sum, width) => sum + width, 0) + 8, rowHeight, thumbs }
  }, [columns, widths, rowHeight, thumbs])
  const byItem = useMemo(() => new Map(allRows.flatMap((row) => (row.item != null ? [[row.item, row] as const] : []))), [allRows])
  const headerHeight = Math.max(font * 1.8, 20)
  const header = useRef<HTMLDivElement>(null)
  const resize = (event: ReactPointerEvent<HTMLSpanElement>, column: ProjectColumn, start: number) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    let width = start
    const move = (next: PointerEvent) => {
      width = Math.round(Math.min(800, Math.max(30, start + next.clientX - startX)))
      setWidths((shown) => ({ ...shown, [column.name]: width }))
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      if (width === start) return
      // A width the engine refuses does not stay on screen.
      void actions.resize(column.name, width).then((took) => {
        if (!took)
          setWidths((local) => {
            const { [column.name]: _dropped, ...rest } = local
            return rest
          })
      })
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }
  return (
    <div className="film-project-list" data-testid="film-project-list">
      <div className="film-project-list-header" ref={header} style={{ height: headerHeight }}>
        <div className="film-project-list-header-row" style={{ width: layout.total, paddingLeft: LEAD }}>
          {columns.map((column, index) => (
            <span key={column.name} className="film-project-column" style={{ width: layout.widths[index] }} data-preview={addedColumns.has(column.name) ? 'added' : undefined}>
              <button type="button" className="film-project-column-label" title={phrase(column.name)} data-kit-ui-id="control:project.list.header" data-testid={`film-project-column-${column.name}`} onClick={() => actions.sort(column.name)} onContextMenu={(event) => actions.menu(event, { header: true })}>
                <span>{phrase(column.name)}</span>
                {sort.column === column.name ? <ChevronDown size={12} aria-hidden="true" style={sort.descending ? undefined : { transform: 'rotate(180deg)' }} /> : null}
              </button>
              <span
                className="film-project-column-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={phrase('Resize column')}
                data-kit-ui-id="control:project.list.resize"
                data-testid={`film-project-resize-${column.name}`}
                onPointerDown={(event) => resize(event, column, layout.widths[index])}
              />
            </span>
          ))}
        </div>
      </div>
      <div
        className="film-project-list-body"
        onScroll={(event) => {
          if (header.current) header.current.scrollLeft = event.currentTarget.scrollLeft
        }}
      >
        <div style={{ width: layout.total, minWidth: '100%' }}>
          {rows.map((row) =>
            row.bin != null ? (
              <ListBinRow
                key={`b${row.bin}`}
                row={row}
                mark={props.preview.marks.get(`b${row.bin}`)?.mark}
                open={state.search !== '' || state.expanded.has(row.bin)}
                selected={state.selectedBin === row.bin}
                dropping={props.dropBin === row.bin}
                renaming={renamingOf(state, null, row.bin)?.text ?? null}
                layout={layout}
                actions={actions}
                phrase={phrase}
              />
            ) : (
              <ListItemRow
                key={`i${row.item}`}
                row={row}
                mark={props.preview.marks.get(`i${row.item}`)?.mark}
                cells={props.preview.marks.get(`i${row.item}`)?.cells ?? ''}
                previewSelected={props.preview.selection?.has(row.item as number) ?? false}
                selected={selected.has(row.item as number)}
                renaming={renamingOf(state, row.item as number, null)?.text ?? null}
                color={labelColor(labels, row.label)}
                labelName={phrase(labels?.colors[(row.label ?? '').toLowerCase()]?.name ?? row.label ?? '')}
                layout={layout}
                revision={row.kind === 'sequence' ? props.revision : null}
                thumbnails={pictureSource(props.preview, row, props.thumbnails)}
                stamp={pictureStamp(props.preview, row)}
                actions={actions}
                phrase={phrase}
              />
            ),
          )}
          {searchBins.map((each) => (
            <SearchBinRows
              key={`s${each.bin}`}
              searchBin={each}
              open={each.mark === 'added' || state.expanded.has(each.bin)}
              byItem={byItem}
              layout={layout}
              preview={props.preview}
              selected={selected}
              labels={labels}
              revision={props.revision}
              thumbnails={props.thumbnails}
              phrase={phrase}
              actions={actions}
            />
          ))}
          <div className="film-project-empty" data-kit-ui-id="control:project.empty" data-testid="film-project-empty" {...props.empty} />
        </div>
      </div>
    </div>
  )
}

/**
 * A search bin's row (upstream `search_bin_rows`: a chevron, the search icon, and "<name> (<n>)";
 * a click folds or opens it, a right-click offers Delete Search Bin), and while open its matches
 * as item rows one level in. One only a preview has is outlined, open, its rows outlined too.
 */
type SearchBinRowsProps = Pick<ViewProps, 'preview' | 'selected' | 'labels' | 'revision' | 'thumbnails' | 'phrase' | 'actions'> & { searchBin: SearchBinRow; open: boolean; byItem: ReadonlyMap<number, ProjectRow>; layout: ListLayout }

const SearchBinRows = memo(function SearchBinRows({ searchBin, open, byItem, layout, ...props }: SearchBinRowsProps) {
  const { selected, labels, phrase, actions } = props
  // Each match is its item's own row object (one level in by the row's `depth` prop), so the memoized rows draw again only where they change.
  const matches = useMemo(() => (open ? searchBinMatches(searchBin, byItem) : NO_ROWS), [open, searchBin, byItem])
  const nameWidth = Math.max(80, (layout.widths[0] ?? 200) - 34)
  // The ghost bin a preview adds comes into view, as it is the preview (after the root's rows).
  const row = useRef<HTMLDivElement>(null)
  const added = searchBin.mark === 'added'
  useEffect(() => {
    if (added) row.current?.scrollIntoView({ block: 'nearest' })
  }, [added])
  return (
    <>
      <div
        ref={row}
        className="film-project-row"
        data-preview={searchBin.mark}
        style={{ height: layout.rowHeight }}
        data-kit-ui-id="control:project.searchBin"
        data-testid={`film-project-search-bin-${searchBin.bin}`}
        onClick={() => actions.toggleBin(searchBin.bin)}
        onContextMenu={(event) => actions.menu(event, { searchBin: searchBin.bin })}
      >
        <span style={{ width: LEAD, flex: 'none' }} />
        <span className="film-project-fold" aria-hidden="true">
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        </span>
        <Search size={13} aria-hidden="true" style={{ flex: 'none' }} />
        <span className="film-project-name" style={{ width: nameWidth }}>
          <span className="film-project-text">{`${searchBin.name} (${searchBin.items.length})`}</span>
        </span>
      </div>
      {matches.map((row) => (
        <ListItemRow
          key={`s${searchBin.bin}-i${row.item}`}
          row={row}
          mark={searchBin.mark}
          cells=""
          previewSelected={props.preview.selection?.has(row.item as number) ?? false}
          selected={selected.has(row.item as number)}
          renaming={null}
          color={labelColor(labels, row.label)}
          labelName={phrase(labels?.colors[(row.label ?? '').toLowerCase()]?.name ?? row.label ?? '')}
          layout={layout}
          revision={row.kind === 'sequence' ? props.revision : null}
          thumbnails={pictureSource(props.preview, row, props.thumbnails)}
          stamp={pictureStamp(props.preview, row)}
          actions={actions}
          phrase={phrase}
          testId={`film-project-search-bin-${searchBin.bin}-item-${row.item}`}
          depth={1}
        />
      ))}
    </>
  )
})

type BinRowProps = { row: ProjectRow; mark?: RowMark['mark']; open: boolean; selected: boolean; dropping: boolean; renaming: string | null; layout: ListLayout; actions: Actions; phrase: Phrases }

const ListBinRow = memo(function ListBinRow({ row, mark, open, selected, dropping, renaming, layout, actions, phrase }: BinRowProps) {
  const binId = row.bin as number
  const nameWidth = Math.max(80, (layout.widths[0] ?? 200) - row.depth * 14 - 34)
  return (
    <div
      className="film-project-row"
      data-preview={mark}
      aria-selected={selected}
      data-drop={dropping || undefined}
      style={{ height: layout.rowHeight }}
      data-kit-ui-id="control:project.bin"
      data-testid={`film-project-bin-${binId}`}
      onDragOver={(event) => actions.binOver(event, binId)}
      onDragLeave={(event) => actions.binLeave(event, binId)}
      onDrop={(event) => actions.binDrop(event, binId)}
      onClick={(event) => actions.clickBin(event, binId, true)}
      onDoubleClick={(event) => actions.openBin(event, binId)}
      onContextMenu={(event) => actions.menu(event, { bin: binId })}
    >
      <span style={{ width: LEAD + row.depth * 14, flex: 'none' }} />
      <button
        type="button"
        className="film-project-fold"
        aria-expanded={open}
        aria-label={phrase('Expand')}
        data-kit-ui-id="control:project.bin.toggle"
        data-testid={`film-project-bin-${binId}-toggle`}
        onClick={(event) => {
          event.stopPropagation()
          actions.toggleBin(binId)
        }}
      >
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      </button>
      <Folder size={14} color={BIN_COLOR} aria-hidden="true" style={{ flex: 'none' }} />
      <span className="film-project-name" style={{ width: nameWidth }}>
        {renaming != null ? <RenameSpot renaming={{ text: renaming }} actions={actions} phrase={phrase} testId={`film-project-rename-bin-${binId}`} /> : <span className="film-project-text">{row.name}</span>}
      </span>
    </div>
  )
})

type ItemRowProps = { row: ProjectRow; mark?: RowMark['mark']; cells: string; previewSelected: boolean; selected: boolean; renaming: string | null; color: string; labelName: string; layout: ListLayout; revision: number | null; thumbnails: ProjectThumbnails; stamp?: string | null; actions: Actions; phrase: Phrases; testId?: string; depth?: number }

const ListItemRow = memo(function ListItemRow({ row, mark, cells, previewSelected, selected, renaming, color, labelName, layout, revision, thumbnails, stamp, actions, phrase, testId, depth = row.depth }: ItemRowProps) {
  const item = row.item as number
  const { columns, widths, rowHeight, thumbs } = layout
  const changed = cells ? new Set(cells.split('\n')) : null
  return (
    <div
      className="film-project-row"
      data-preview={mark}
      data-preview-selected={previewSelected || undefined}
      aria-selected={selected}
      style={{ height: rowHeight }}
      draggable={renaming == null}
      data-kit-ui-id="control:project.item"
      data-testid={testId ?? `film-project-item-${item}`}
      onDragStart={(event) => actions.dragItem(event, item)}
      onDragEnd={() => endFilmDrag()}
      onClick={(event) => actions.clickItem(event, item)}
      onDoubleClick={() => actions.openItem(row)}
      onContextMenu={(event) => actions.menu(event, { row })}
    >
      <span className="film-project-lead" style={{ width: LEAD }}>
        <span className="film-project-chip" style={{ background: color }} title={row.label} data-kit-ui-id="control:project.item.label" />
      </span>
      <span className="film-project-cell film-project-name-cell" style={{ width: widths[0] ?? 200, paddingLeft: depth * 14 + 14 }} data-preview-cell={changed?.has('Name') || undefined}>
        {thumbs ? <Thumb row={row} width={((rowHeight - 6) * 16) / 9} height={rowHeight - 6} ticks={posterTicks(row)} thumbnails={thumbnails} revision={revision} stamp={stamp} /> : null}
        <ItemGlyph row={row} />
        <span className="film-project-name" onClick={(event) => actions.nameClick(event, row)}>
          {renaming != null ? (
            <RenameSpot renaming={{ text: renaming }} actions={actions} phrase={phrase} testId={`film-project-rename-${item}`} />
          ) : (
            <>
              <span className="film-project-text" style={row.offline ? { color: OFFLINE } : undefined}>
                {row.name}
              </span>
              <Badges row={row} phrase={phrase} />
            </>
          )}
        </span>
      </span>
      {columns.slice(1).map((column, index) => (
        <span key={column.name} className="film-project-cell" style={{ width: widths[index + 1] }} data-preview-cell={changed?.has(column.name) || undefined}>
          {column.name === 'Label' ? (
            <>
              <span className="film-project-swatch" style={{ background: color }} />
              <span className="film-project-text">{labelName}</span>
            </>
          ) : (
            <span className="film-project-text">{column.name === 'Media Type' ? phrase(row.cells?.[column.name] ?? '') : (row.cells?.[column.name] ?? '')}</span>
          )}
        </span>
      ))}
    </div>
  )
})

/** An item's kind icon (upstream `item_icon`). */
function ItemGlyph({ row }: { row: ProjectRow }) {
  const Glyph = ICONS[row.icon ?? 'film'] ?? Film
  return <Glyph size={14} className="film-project-glyph" aria-hidden="true" />
}

/** The offline and proxy badges (upstream `paint_badges`). */
function Badges({ row, phrase }: { row: ProjectRow; phrase: Phrases }) {
  return (
    <>
      {row.offline ? <span className="film-project-offline-dot" title={phrase(row.offlineText ?? 'Offline')} data-kit-ui-id="control:project.item.offline" /> : null}
      {row.proxy ? (
        <span className="film-project-proxy" data-kit-ui-id="control:project.item.proxy">
          P
        </span>
      ) : null}
    </>
  )
}

/**
 * The Icon view (upstream `icon_view`, `card`, `bin_card`): bin cards, then item cards with the
 * thumbnail, the In/Out bar, the stream badges, the label chip, the name, and the duration. With
 * Hover Scrub on, the pointer across a card shows the frame under it, one frame per animation
 * frame at most; a touch drag does too with Thumbnail controls for all pointing devices on.
 */
function IconView({ rows, size, font, hoverScrub, touchScrub, ui, ...props }: ViewProps & { rows: ProjectRow[]; size: number; font: number; hoverScrub: boolean; touchScrub: boolean; ui: ProjectUi }) {
  const { state, selected, labels, phrase, actions } = props
  const grid = useRef<HTMLDivElement>(null)
  const thumbHeight = (size * 9) / 16
  const cell = { width: size + 20, height: thumbHeight + 34 }
  useLayoutEffect(() => {
    const element = grid.current
    if (!element) return undefined
    const measure = () => {
      const columns = Math.max(1, Math.floor((element.clientWidth - 12) / cell.width))
      if (ui.get().iconColumns !== columns) ui.set({ iconColumns: columns })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [cell.width, ui])
  // Hover Scrub turned off: no card's time stays behind for I and O.
  useEffect(() => {
    if (!hoverScrub) ui.hover.current = null
  }, [hoverScrub, ui])
  return (
    <div className="film-project-icons" ref={grid} data-testid="film-project-icons">
      <div className="film-project-grid" style={{ gridTemplateColumns: `repeat(auto-fill, ${cell.width}px)`, gridAutoRows: `${cell.height}px` }}>
        {rows.map((row) =>
          row.bin != null ? (
            <BinCard key={`b${row.bin}`} row={row} mark={props.preview.marks.get(`b${row.bin}`)?.mark} size={size} font={font} selected={state.selectedBin === row.bin} dropping={props.dropBin === row.bin} renaming={renamingOf(state, null, row.bin)?.text ?? null} actions={actions} phrase={phrase} />
          ) : (
            <ItemCard
              key={`i${row.item}`}
              row={row}
              mark={props.preview.marks.get(`i${row.item}`)?.mark}
              previewSelected={props.preview.selection?.has(row.item as number) ?? false}
              size={size}
              font={font}
              hoverScrub={hoverScrub}
              touchScrub={touchScrub}
              selected={selected.has(row.item as number)}
              renaming={renamingOf(state, row.item as number, null)?.text ?? null}
              color={labelColor(labels, row.label)}
              revision={row.kind === 'sequence' ? props.revision : null}
              thumbnails={pictureSource(props.preview, row, props.thumbnails)}
              stamp={pictureStamp(props.preview, row)}
              ui={ui}
              actions={actions}
              phrase={phrase}
            />
          ),
        )}
      </div>
      <div className="film-project-empty" data-kit-ui-id="control:project.empty" data-testid="film-project-empty" {...props.empty} />
    </div>
  )
}

type BinCardProps = { row: ProjectRow; mark?: RowMark['mark']; size: number; font: number; selected: boolean; dropping: boolean; renaming: string | null; actions: Actions; phrase: Phrases }

const BinCard = memo(function BinCard({ row, mark, size, font, selected, dropping, renaming, actions, phrase }: BinCardProps) {
  const binId = row.bin as number
  const thumbHeight = (size * 9) / 16
  return (
    <div
      className="film-project-card"
      data-preview={mark}
      aria-selected={selected}
      data-drop={dropping || undefined}
      style={{ width: size }}
      data-kit-ui-id="control:project.bin"
      data-testid={`film-project-bin-${binId}`}
      onDragOver={(event) => actions.binOver(event, binId)}
      onDragLeave={(event) => actions.binLeave(event, binId)}
      onDrop={(event) => actions.binDrop(event, binId)}
      onClick={(event) => actions.clickBin(event, binId, false)}
      onDoubleClick={(event) => actions.openBin(event, binId)}
      onContextMenu={(event) => actions.menu(event, { bin: binId })}
    >
      <span className="film-project-bin-art" style={{ height: thumbHeight }}>
        <Folder size={thumbHeight * 0.6} color={BIN_COLOR} aria-hidden="true" />
      </span>
      <span className="film-project-card-line" style={{ fontSize: font - 0.5 }}>
        {renaming != null ? (
          <RenameSpot renaming={{ text: renaming }} actions={actions} phrase={phrase} testId={`film-project-rename-bin-${binId}`} />
        ) : (
          <>
            <span className="film-project-text">{row.name}</span>
            <span className="film-project-card-duration" style={{ fontSize: font - 1.5 }}>
              {(row.items ?? 0) === 1 ? phrase('1 item') : phrase('{n} items').replace('{n}', String(row.items ?? 0))}
            </span>
          </>
        )}
      </span>
    </div>
  )
})

/** `touchScrub`: Thumbnail controls for all pointing devices, so a touch drag across the card scrubs it too. */
type ItemCardProps = { row: ProjectRow; mark?: RowMark['mark']; previewSelected: boolean; size: number; font: number; hoverScrub: boolean; touchScrub: boolean; selected: boolean; renaming: string | null; color: string; revision: number | null; thumbnails: ProjectThumbnails; stamp?: string | null; ui: ProjectUi; actions: Actions; phrase: Phrases }

const ItemCard = memo(function ItemCard({ row, mark, previewSelected, size, font, hoverScrub, touchScrub, selected, renaming, color, revision, thumbnails, stamp, ui, actions, phrase }: ItemCardProps) {
  const item = row.item as number
  return (
    <div
      className="film-project-card"
      data-preview={mark}
      data-preview-selected={previewSelected || undefined}
      aria-selected={selected}
      style={{ width: size }}
      draggable={renaming == null}
      data-kit-ui-id="control:project.item"
      data-testid={`film-project-item-${item}`}
      onDragStart={(event) => actions.dragItem(event, item)}
      onDragEnd={() => endFilmDrag()}
      onClick={(event) => actions.clickItem(event, item)}
      onDoubleClick={() => actions.openItem(row)}
      onContextMenu={(event) => actions.menu(event, { row })}
    >
      <CardArt row={row} width={size} hoverScrub={hoverScrub} touchScrub={touchScrub} revision={revision} thumbnails={thumbnails} stamp={stamp} ui={ui} phrase={phrase} />
      <span className="film-project-card-line" style={{ fontSize: font - 0.5 }} onClick={(event) => actions.nameClick(event, row)}>
        {renaming != null ? (
          <RenameSpot renaming={{ text: renaming }} actions={actions} phrase={phrase} testId={`film-project-rename-${item}`} />
        ) : (
          <>
            <span className="film-project-card-chip" style={{ background: color }} data-kit-ui-id="control:project.item.label" />
            <span className="film-project-text" style={row.offline ? { color: OFFLINE } : undefined}>
              {row.name}
            </span>
            <span className="film-project-card-duration" style={{ fontSize: font - 1 }}>
              {shortDuration(row.duration ?? 0)}
            </span>
          </>
        )}
      </span>
    </div>
  )
})
