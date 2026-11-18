import { useEffect, useState } from 'react'
import { ContextMenu, MenuItem, MenuSeparator, SubMenu, type ContextMenuPoint, type Phrases } from '@kition/kit-editor'
import { FILM_MENUS } from '../menus/catalog'
import type { FilmLabels } from '../session/useFilmSession'
import { FONT_SIZES, type ProjectRow, type ProjectUi, type ProjectView } from './projectModel'
import { LAYOUT_WIDTH, type FreeformCard } from './freeform'

type Invoke = (id: string, params?: Record<string, unknown>) => Promise<unknown>
type Query = (id: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * Upstream's `NEW_ITEMS` (`panels/project.rs`), the footer's and the empty space's New Item menu.
 * Sequence… opens New Sequence (Task 13) and Color Matte… New Color Matte (Task 14). Demo Footage
 * imports upstream's bundled media (wave 3): it is drawn disabled. The others make their item at
 * once.
 */
export const NEW_ITEMS: ReadonlyArray<{ label: string; command: string; later?: boolean }> = [
  { label: 'Sequence…', command: 'file.newSequence' },
  { label: 'Adjustment Layer…', command: 'file.newAdjustmentLayer' },
  { label: 'Bars and Tone…', command: 'file.newBarsAndTone' },
  { label: 'Black Video…', command: 'file.newBlackVideo' },
  { label: 'Color Matte…', command: 'file.newColorMatte' },
  { label: 'Universal Counting Leader…', command: 'file.newCountingLeader' },
  { label: 'Transparent Video…', command: 'file.newTransparentVideo' },
  { label: 'Demo Footage', command: 'file.importDemoFootage', later: true },
]

/** The New Item rows: each runs its command through `invoke`. */
export function NewItemRows({ invoke, phrase }: { invoke: Invoke; phrase: Phrases }) {
  return (
    <>
      {NEW_ITEMS.map((row) => (
        <MenuItem key={row.command} label={phrase(row.label)} disabled={row.later} uiId={`control:project.newItem.${row.command}`} testId={`film-project-new-${row.command}`} onSelect={() => void invoke(row.command, {})} />
      ))}
    </>
  )
}

/** Upstream's Sort Icons columns (`sort_icons_menu`), after User Order. */
const ICON_SORT_COLUMNS = ['Name', 'Label', 'Media Type', 'Frame Rate', 'Media Start', 'Media End', 'Media Duration', 'Video Info', 'Audio Info', 'Date Created']

/** The footer's Sort Icons menu (Icon view): User Order or a column, then Descending. */
export function SortIconsRows({ sort, run, phrase }: { sort: ProjectView['view']['iconSort']; run: (params: Record<string, unknown>) => void; phrase: Phrases }) {
  return (
    <>
      <MenuItem label={phrase('User Order')} checked={sort.column === ''} uiId="control:project.sortIcons.userOrder" testId="film-project-sort-userOrder" onSelect={() => run({ iconSort: { column: '', descending: false } })} />
      {ICON_SORT_COLUMNS.map((column) => (
        <MenuItem key={column} label={phrase(column)} checked={sort.column === column} uiId="control:project.sortIcons.column" testId={`film-project-sort-${column}`} onSelect={() => run({ iconSort: { column, descending: false } })} />
      ))}
      <MenuSeparator />
      <MenuItem label={phrase('Descending')} checked={sort.descending} uiId="control:project.sortIcons.descending" testId="film-project-sort-descending" onSelect={() => run({ iconSort: { descending: !sort.descending } })} />
    </>
  )
}

const LABEL_ROW = 'edit.label.'
/** Upstream's label rows (`Label::ALL`): the engine's name (`Violet`) and its key (`violet`). */
const LABELS = FILM_MENUS.filter((row) => row.command.startsWith(LABEL_ROW) && row.path.join('/') === 'Edit/Label').map((row) => ({ name: row.label, key: row.command.slice(LABEL_ROW.length) }))

/** A row upstream draws whose dialog comes in a later wave: drawn, disabled. */
function Later({ label, uiId, testId }: { label: string; uiId: string; testId: string }) {
  return <MenuItem label={label} disabled uiId={uiId} testId={testId} onSelect={() => undefined} />
}

type ItemMenuProps = { at: ContextMenuPoint | null; row: ProjectRow | null; onClose: () => void; invoke: Invoke; phrase: Phrases; labels: FilmLabels | null; ui: ProjectUi }

/** An item's context menu (upstream `item_menu`). */
export function ItemMenu({ at, row, onClose, ...props }: ItemMenuProps) {
  if (!row || row.item == null) return null
  return (
    <ContextMenu at={at} onClose={onClose} label={row.name} testId="film-project-item-menu">
      <ItemMenuRows row={row} {...props} />
    </ContextMenu>
  )
}

/**
 * The rows of an item's context menu (upstream `item_menu`), which the Freeform card menu draws
 * after its own. Rows that act on the selection select the item first, as upstream does; Set
 * Poster Frame takes the hover-scrubbed time over this card.
 */
function ItemMenuRows({ row, invoke, phrase, labels, ui }: Omit<ItemMenuProps, 'at' | 'onClose' | 'row'> & { row: ProjectRow }) {
  const item = row.item as number
  const select = () => invoke('project.select', { items: [item] })
  const then = (command: string, params: Record<string, unknown> = {}) => void select().then(() => invoke(command, params))
  return (
    <>
      <MenuItem label={phrase('Rename')} uiId="control:project.itemMenu.rename" testId="film-project-item-rename" onSelect={() => void invoke('projectPanel.rename', { item })} />
      <MenuItem label={phrase('Open in Source Monitor')} uiId="control:project.itemMenu.openInSourceMonitor" testId="film-project-item-source" onSelect={() => void invoke('source.open', { item })} />
      {row.kind === 'sequence' ? <MenuItem label={phrase('Open in Timeline')} uiId="control:project.itemMenu.openInTimeline" testId="film-project-item-timeline" onSelect={() => void invoke('sequence.open', { item })} /> : null}
      <MenuItem label={phrase('New Sequence From Clip')} uiId="control:project.itemMenu.newSequenceFromClip" testId="film-project-item-new-sequence" onSelect={() => void invoke('file.newSequence', { fromItem: item })} />
      <MenuItem label={phrase('Duplicate')} uiId="control:project.itemMenu.duplicate" testId="film-project-item-duplicate" onSelect={() => then('edit.duplicate')} />
      <MenuItem
        label={phrase('Set Poster Frame')}
        uiId="control:project.itemMenu.setPosterFrame"
        testId="film-project-item-poster"
        onSelect={() => {
          const hover = ui.hover.current
          then('clip.setPosterFrame', hover?.item === item ? { item, time: hover.time } : {})
        }}
      />
      {/* Upstream `item_menu` sends the item (`{"items": [id]}`), which opens Interpret Footage on it. */}
      <MenuItem label={phrase('Interpret Footage…')} uiId="control:project.itemMenu.interpretFootage" testId="film-project-item-interpret" onSelect={() => void invoke('clip.interpretFootage', { items: [item] })} />
      {/* Upstream selects the item, then sends Make Subclip… or Edit Subclip… with `{}`, which opens its dialog. */}
      {row.kind === 'media' ? <MenuItem label={phrase('Make Subclip…')} uiId="control:project.itemMenu" testId="film-project-item-make-subclip" onSelect={() => then('clip.makeSubclip')} /> : null}
      {row.kind === 'subclip' ? (
        <>
          <MenuItem label={phrase('Edit Subclip…')} uiId="control:project.itemMenu" testId="film-project-item-edit-subclip" onSelect={() => then('clip.editSubclip')} />
          <MenuItem label={phrase('Convert to Master Clip')} uiId="control:project.itemMenu" testId="film-project-item-convert" onSelect={() => then('clip.editSubclip', { item, convertToMaster: true })} />
        </>
      ) : null}
      <SubMenu label="Label" path="Label" uiId="control:project.itemMenu.label" testId="film-project-item-label">
        {LABELS.map((label) => (
          <MenuItem key={label.key} label={phrase(labels?.colors[label.key]?.name ?? label.name)} uiId={`command:${LABEL_ROW}${label.key}`} testId={`film-project-item-label-${label.key}`} onSelect={() => then('edit.label', { label: label.name })} />
        ))}
      </SubMenu>
      {row.file ? (
        <>
          <MenuSeparator />
          {/* Upstream selects the item, then sends each with `{}`: Link Media… and Make Offline… open their dialogs, Attach Proxies… and Reconnect… the host's picker. Make Offline… and the picker rows also name the item, as the selection lands after the call. */}
          <MenuItem label={phrase('Link Media…')} uiId="control:project.itemMenu.linkMedia" testId="film-project-item-link" onSelect={() => then('media.linkMedia')} />
          <MenuItem label={phrase('Make Offline…')} uiId="control:project.itemMenu.makeOffline" testId="film-project-item-offline" onSelect={() => then('media.makeOffline', { item })} />
          <SubMenu label="Proxy" path="Proxy" uiId="control:project.itemMenu.proxy" testId="film-project-item-proxy">
            {/* Create Proxies… is hidden on the web (`menus/hidden.ts`): its job writes files into a local folder. */}
            {/* The item is named (no path: the host's picker still opens), so the picker acts on it, not on a selection that lands later. */}
            <MenuItem label={phrase('Attach Proxies…')} uiId="control:project.itemMenu.attachProxies" testId="film-project-item-attach-proxies" onSelect={() => then('media.attachProxies', { item })} />
            <MenuItem label={phrase('Reconnect Full Resolution Media…')} uiId="control:project.itemMenu.reconnectFullResolutionMedia" testId="film-project-item-reconnect" onSelect={() => then('media.reconnectFullRes', { item })} />
            <MenuItem label={phrase('Detach Proxies')} uiId="control:project.itemMenu.detachProxies" testId="film-project-item-detach-proxies" onSelect={() => then('media.detachProxies')} />
          </SubMenu>
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem label={phrase('Clear')} uiId="control:project.itemMenu.clear" testId="film-project-item-clear" onSelect={() => void invoke('project.delete', { items: [item] })} />
    </>
  )
}

/**
 * A Freeform card's context menu (upstream `card_menu`): Stack (two or more items), Unstack (a
 * stacked card), and Clip Size ▸ Larger, Smaller, and Default (Freeform View Options' size), each
 * on `items` (the selection when the card is in it, else the card, named as the menu opened),
 * with the width the panel lays cards out for; then the item's own rows.
 */
export function FreeformCardMenu({ at, row, card, items, cardSize, width, onClose, ...props }: Omit<ItemMenuProps, 'row'> & { row: ProjectRow | null; card: FreeformCard | null; items: readonly number[]; cardSize: number; width: number }) {
  if (!row || row.item == null || !card) return null
  const wide = width > 0 ? width : LAYOUT_WIDTH
  const run = (command: string, params: Record<string, unknown>) => void props.invoke(command, { items: [...items], ...params, width: wide })
  return (
    <ContextMenu at={at} onClose={onClose} label={row.name} testId="film-project-card-menu">
      <MenuItem label={props.phrase('Stack')} disabled={items.length < 2} uiId="control:project.cardMenu.stack" testId="film-project-card-stack" onSelect={() => run('project.freeform.stack', {})} />
      <MenuItem label={props.phrase('Unstack')} disabled={card.stack == null} uiId="control:project.cardMenu.unstack" testId="film-project-card-unstack" onSelect={() => run('project.freeform.unstack', {})} />
      <SubMenu label={props.phrase('Clip Size')} path="Clip Size" uiId="control:project.cardMenu.clipSize" testId="film-project-card-clipSize">
        <MenuItem label={props.phrase('Larger')} uiId="control:project.cardMenu.clipSize.larger" testId="film-project-card-larger" onSelect={() => run('project.freeform.resize', { step: 1 })} />
        <MenuItem label={props.phrase('Smaller')} uiId="control:project.cardMenu.clipSize.smaller" testId="film-project-card-smaller" onSelect={() => run('project.freeform.resize', { step: -1 })} />
        <MenuItem label={props.phrase('Default')} uiId="control:project.cardMenu.clipSize.default" testId="film-project-card-default" onSelect={() => run('project.freeform.resize', { size: cardSize })} />
      </SubMenu>
      <MenuSeparator />
      <ItemMenuRows row={row} {...props} />
    </ContextMenu>
  )
}

/**
 * The Freeform canvas's context menu (upstream `canvas_menu`): Align to Grid and Reset to Grid on
 * the bin shown, Save Arrangement…, Restore and Delete Arrangement with the bin's arrangements
 * (`project.freeform.arrangements`, read as the menu opens; greyed with none), Freeform View
 * Options…, then the empty space's rows.
 */
export function FreeformCanvasMenu({ at, bin, root, width, onClose, invoke, query, phrase }: { at: ContextMenuPoint | null; bin: number | null; root: number | null; width: number; onClose: () => void; invoke: Invoke; query: Query; phrase: Phrases }) {
  // Read for this opening of the menu (`at`, a new point each time) and this bin: the list of an
  // earlier opening (before a Save or a Delete) never shows, and is dropped as the menu closes.
  const [names, setNames] = useState<{ at: ContextMenuPoint; bin: number | null; names: string[] } | null>(null)
  useEffect(() => {
    if (!at) {
      setNames(null)
      return undefined
    }
    let live = true
    void query('project.freeform.arrangements', bin != null ? { bin } : {})
      .then((answer) => {
        const list = (answer as { arrangements?: unknown } | null)?.arrangements
        if (live) setNames({ at, bin, names: Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : [] })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [at, bin, query])
  if (!at) return null
  const wide = width > 0 ? width : LAYOUT_WIDTH
  const place = { ...(bin != null ? { bin } : {}), width: wide }
  const saved = names && names.at === at && names.bin === bin ? names.names : []
  return (
    <ContextMenu at={at} onClose={onClose} label={phrase('Freeform canvas')} testId="film-project-canvas-menu">
      <MenuItem label={phrase('Align to Grid')} uiId="control:project.canvasMenu.alignToGrid" testId="film-project-canvas-alignToGrid" onSelect={() => void invoke('project.freeform.alignToGrid', place)} />
      <MenuItem label={phrase('Reset to Grid')} uiId="control:project.canvasMenu.resetToGrid" testId="film-project-canvas-resetToGrid" onSelect={() => void invoke('project.freeform.reset', place)} />
      <MenuSeparator />
      <MenuItem label={phrase('Save Arrangement…')} uiId="control:project.canvasMenu.saveArrangement" testId="film-project-canvas-saveArrangement" onSelect={() => void invoke('projectPanel.saveArrangement', place)} />
      {saved.length ? (
        <>
          <SubMenu label={phrase('Restore Arrangement')} path="Restore Arrangement" uiId="control:project.canvasMenu.restoreArrangement" testId="film-project-canvas-restoreArrangement">
            {saved.map((name) => (
              <MenuItem key={name} label={name} uiId="control:project.canvasMenu.restoreArrangement" testId={`film-project-canvas-restore-${name}`} onSelect={() => void invoke('project.freeform.restoreArrangement', { name, ...place })} />
            ))}
          </SubMenu>
          <SubMenu label={phrase('Delete Arrangement')} path="Delete Arrangement" uiId="control:project.canvasMenu.deleteArrangement" testId="film-project-canvas-deleteArrangement">
            {saved.map((name) => (
              <MenuItem key={name} label={name} uiId="control:project.canvasMenu.deleteArrangement" testId={`film-project-canvas-delete-${name}`} onSelect={() => void invoke('project.freeform.deleteArrangement', { name, ...(bin != null ? { bin } : {}) })} />
            ))}
          </SubMenu>
        </>
      ) : (
        <>
          <Later label={phrase('Restore Arrangement')} uiId="control:project.canvasMenu.restoreArrangement" testId="film-project-canvas-restoreArrangement" />
          <Later label={phrase('Delete Arrangement')} uiId="control:project.canvasMenu.deleteArrangement" testId="film-project-canvas-deleteArrangement" />
        </>
      )}
      <MenuSeparator />
      <MenuItem label={phrase('Freeform View Options…')} uiId="control:project.canvasMenu.options" testId="film-project-canvas-options" onSelect={() => void invoke('projectPanel.freeformOptions', {})} />
      <MenuSeparator />
      <BackgroundRows invoke={invoke} phrase={phrase} bin={bin != null && bin !== root ? bin : null} />
    </ContextMenu>
  )
}

/** A bin's context menu (upstream `bin_menu`): open it (in place, in a new tab, or in a floating window), rename it, or make a bin in it. */
export function BinMenu({ at, bin, onClose, invoke, phrase, open }: { at: ContextMenuPoint | null; bin: number | null; onClose: () => void; invoke: Invoke; phrase: Phrases; open: (bin: number, how: 'openInPlace' | 'openNewTab' | 'openNewWindow') => void }) {
  if (bin == null) return null
  return (
    <ContextMenu at={at} onClose={onClose} label={phrase('Bin')} testId="film-project-bin-menu">
      <MenuItem label={phrase('Open in Place')} uiId="control:project.binMenu.inPlace" testId="film-project-bin-in-place" onSelect={() => open(bin, 'openInPlace')} />
      <MenuItem label={phrase('Open in New Tab')} uiId="control:project.binMenu.newTab" testId="film-project-bin-new-tab" onSelect={() => open(bin, 'openNewTab')} />
      <MenuItem label={phrase('Open in New Window')} uiId="control:project.binMenu.newWindow" testId="film-project-bin-new-window" onSelect={() => open(bin, 'openNewWindow')} />
      <MenuSeparator />
      <MenuItem label={phrase('Rename')} uiId="control:project.binMenu.rename" testId="film-project-bin-rename" onSelect={() => void invoke('projectPanel.rename', { bin })} />
      <MenuItem label={phrase('New Bin')} uiId="control:project.binMenu.newBin" testId="film-project-bin-new-bin" onSelect={() => void invoke('file.newBin', { name: phrase('New Bin'), parent: bin })} />
    </ContextMenu>
  )
}

/** A search bin's context menu (upstream `search_bin_rows`): Delete Search Bin, at once, with no confirmation (rule 6). */
export function SearchBinMenu({ at, bin, onClose, invoke, phrase }: { at: ContextMenuPoint | null; bin: number | null; onClose: () => void; invoke: Invoke; phrase: Phrases }) {
  if (bin == null) return null
  return (
    <ContextMenu at={at} onClose={onClose} label={phrase('Search Bin')} testId="film-project-search-bin-menu">
      <MenuItem label={phrase('Delete Search Bin')} uiId="control:project.searchBin.delete" testId="film-project-search-bin-delete" onSelect={() => void invoke('project.deleteSearchBin', { bin })} />
    </ContextMenu>
  )
}

/** A List view column header's context menu (upstream `project_views.rs` `list_view`): Metadata Display…. */
export function HeaderMenu({ at, onClose, invoke, phrase }: { at: ContextMenuPoint | null; onClose: () => void; invoke: Invoke; phrase: Phrases }) {
  if (!at) return null
  return (
    <ContextMenu at={at} onClose={onClose} label={phrase('Metadata Display…')} testId="film-project-header-menu">
      <MenuItem label={phrase('Metadata Display…')} uiId="control:project.list.header.metadataDisplay" testId="film-project-header-metadataDisplay" onSelect={() => void invoke('projectPanel.metadataDisplay', {})} />
    </ContextMenu>
  )
}

/** The empty space's context menu (upstream `background_menu`). */
export function BackgroundMenu({ at, onClose, invoke, phrase, bin }: { at: ContextMenuPoint | null; onClose: () => void; invoke: Invoke; phrase: Phrases; bin: number | null }) {
  return (
    <ContextMenu at={at} onClose={onClose} label={phrase('Project')} testId="film-project-background-menu">
      <BackgroundRows invoke={invoke} phrase={phrase} bin={bin} />
    </ContextMenu>
  )
}

/** The rows of the empty space's context menu (upstream `background_menu`), which the Freeform canvas menu draws last. */
function BackgroundRows({ invoke, phrase, bin }: { invoke: Invoke; phrase: Phrases; bin: number | null }) {
  return (
    <>
      <MenuItem label={phrase('New Bin')} uiId="control:project.backgroundMenu.newBin" testId="film-project-background-new-bin" onSelect={() => void invoke('file.newBin', { name: phrase('New Bin'), parent: bin })} />
      <MenuItem label={phrase('New Search Bin')} uiId="control:project.backgroundMenu.newSearchBin" testId="film-project-background-search-bin" onSelect={() => void invoke('file.newSearchBin', {})} />
      <MenuItem label={phrase('Find…')} uiId="control:project.backgroundMenu.find" testId="film-project-background-find" onSelect={() => void invoke('edit.find', {})} />
      <MenuItem label={phrase('Automate to Sequence…')} uiId="control:project.backgroundMenu.automateToSequence" testId="film-project-background-automate" onSelect={() => void invoke('clip.automateToSequence', {})} />
      <MenuItem label={phrase('Import…')} uiId="control:project.backgroundMenu.import" testId="film-project-background-import" onSelect={() => void invoke('file.import', bin != null ? { bin } : {})} />
      <SubMenu label="New Item" path="New Item" uiId="control:project.backgroundMenu.newItem" testId="film-project-background-new-item">
        <NewItemRows invoke={invoke} phrase={phrase} />
      </SubMenu>
    </>
  )
}

export type ProjectMenuProps = {
  close: () => void
  view: ProjectView | null
  /** The shown view's mode (a bin tab's own). */
  mode: 'list' | 'icon' | 'freeform'
  selection: readonly number[]
  ui: ProjectUi
  /** The bin New Bin makes its bin in: the shown bin, or null at the project's root. */
  parent: number | null
  invoke: Invoke
  query: Query
  phrase: Phrases
}

type Presets = { presets: Array<{ slot: number; name: string | null }>; current: number | null }

/**
 * The Project panel's ≡ rows after the generic ones (upstream `panel_menu`). The project rows
 * (Close Project, Save Project, Reveal Project in Finder…) belong to the host and are not drawn;
 * New Project Shortcut is drawn disabled until its task. Freeform View Options… is greyed outside
 * the Freeform view, as upstream's.
 */
export function ProjectMenu({ close, view, mode, selection, ui, parent, invoke, query, phrase }: ProjectMenuProps) {
  const [presets, setPresets] = useState<Presets | null>(null)
  useEffect(() => {
    let live = true
    void query('project.viewPreset.list').then((answer) => {
      if (live) setPresets(answer as Presets | null)
    })
    return () => {
      live = false
    }
  }, [query])
  const run = (command: string, params: Record<string, unknown> = {}) => {
    close()
    void invoke(command, params)
  }
  const setView = (params: Record<string, unknown>) => run('project.view.set', params)
  // Upstream's `set_mode`: the Freeform view has no command of its own; a bin tab's view is its own.
  const setMode = (next: ProjectView['view']['mode']) => {
    close()
    if (next !== 'freeform') return void invoke(next === 'list' ? 'projectPanel.viewList' : 'projectPanel.viewIcon', {})
    if (ui.shownTab()) ui.setTab({ mode: 'freeform' })
    else void invoke('project.view.set', { view: 'freeform' })
  }
  const any = selection.length > 0
  const anyPreset = presets?.presets.some((preset) => preset.name != null) ?? false
  const toggles: ReadonlyArray<[keyof ProjectView, string, string | null]> = [
    ['previewArea', 'Preview Area', null],
    ['thumbnails', 'Thumbnails', null],
    ['thumbnailsShowEffects', 'Thumbnails show effects applied', null],
    ['hoverScrub', 'Hover Scrub', 'Shift+H'],
    ['thumbnailControlsAllDevices', 'Thumbnail controls for all pointing devices', null],
  ]
  return (
    <>
      <MenuSeparator />
      <MenuItem label={phrase('New Bin')} uiId="control:project.menu" testId="film-project-menu-newBin" onSelect={() => run('file.newBin', { name: phrase('New Bin'), parent })} />
      <MenuItem label={phrase('New Bin From Selection')} shortcut="Shift+B" disabled={!any} uiId="control:project.menu" testId="film-project-menu-newBinFromSelection" onSelect={() => run('file.newBinFromSelection')} />
      <MenuItem label={phrase('New Search Bin')} uiId="control:project.menu" testId="film-project-menu-newSearchBin" onSelect={() => run('file.newSearchBin')} />
      <Later label={phrase('New Project Shortcut')} uiId="control:project.menu" testId="film-project-menu-newProjectShortcut" />
      <MenuItem label={phrase('Rename')} disabled={!any && ui.get().selectedBin == null} uiId="control:project.menu" testId="film-project-menu-rename" onSelect={() => run('projectPanel.rename')} />
      <MenuItem label={phrase('Delete')} shortcut="Backspace" disabled={!any} uiId="control:project.menu" testId="film-project-menu-delete" onSelect={() => run('project.delete')} />
      <MenuSeparator />
      <MenuItem label={phrase('Automate to Sequence…')} disabled={!any} uiId="control:project.menu" testId="film-project-menu-automateToSequence" onSelect={() => run('clip.automateToSequence')} />
      <MenuItem label={phrase('Find…')} shortcut="Cmd+F" uiId="control:project.menu" testId="film-project-menu-find" onSelect={() => run('edit.find')} />
      <MenuSeparator />
      <MenuItem label={phrase('List')} shortcut="Cmd+PageUp" checked={mode === 'list'} uiId="control:project.menu.view" testId="film-project-menu-view-list" onSelect={() => setMode('list')} />
      <MenuItem label={phrase('Icon')} shortcut="Cmd+PageDown" checked={mode === 'icon'} uiId="control:project.menu.view" testId="film-project-menu-view-icon" onSelect={() => setMode('icon')} />
      <MenuItem label={phrase('Freeform')} checked={mode === 'freeform'} uiId="control:project.menu.view" testId="film-project-menu-view-freeform" onSelect={() => setMode('freeform')} />
      <MenuSeparator />
      {toggles.map(([key, label, shortcut]) => (
        <MenuItem key={key} label={phrase(label)} shortcut={shortcut} checked={view?.[key] === true} uiId={`control:project.menu.${key}`} testId={`film-project-menu-${key}`} onSelect={() => setView({ [key]: !(view?.[key] === true) })} />
      ))}
      <MenuSeparator />
      <SubMenu label="Font Size" path="Font Size" uiId="control:project.menu.fontSize" testId="film-project-menu-fontSize">
        {FONT_SIZES.map(([size, label]) => (
          <MenuItem key={size} label={phrase(label)} checked={view?.view.fontSize === size} uiId="control:project.menu.fontSize" testId={`film-project-menu-fontSize-${size}`} onSelect={() => setView({ fontSize: size })} />
        ))}
      </SubMenu>
      <MenuSeparator />
      <MenuItem
        label={phrase('Refresh Sort Order')}
        uiId="control:project.menu.refreshSortOrder"
        testId="film-project-menu-refreshSortOrder"
        onSelect={() => {
          // The same sort leaves the view as it was: the rows are read again all the same (a full read).
          close()
          void invoke('project.sort', { column: view?.view.sort.column ?? 'Name', descending: view?.view.sort.descending ?? false }).then(() => ui.viewChanged())
        }}
      />
      <MenuSeparator />
      <MenuItem label={phrase('Metadata Display…')} uiId="control:project.menu.metadataDisplay" testId="film-project-menu-metadataDisplay" onSelect={() => run('projectPanel.metadataDisplay')} />
      <MenuItem label={phrase('Save Current View Preset')} disabled={view?.currentPreset == null} uiId="control:project.menu.saveViewPreset" testId="film-project-menu-saveViewPreset" onSelect={() => run('project.viewPreset.save')} />
      <MenuItem label={phrase('Save As New View Preset')} uiId="control:project.menu.saveViewPresetAs" testId="film-project-menu-saveViewPresetAs" onSelect={() => run('projectPanel.saveViewPresetAs')} />
      {anyPreset ? (
        <SubMenu label="Restore View Preset" path="Restore View Preset" uiId="control:project.menu.restoreViewPreset" testId="film-project-menu-restoreViewPreset">
          {presets?.presets.map((preset) => (
            <MenuItem
              key={preset.slot}
              label={preset.name ?? phrase('Project View Preset {n}').replace('{n}', String(preset.slot))}
              disabled={preset.name == null}
              checked={presets.current === preset.slot}
              uiId="control:project.menu.restoreViewPreset"
              testId={`film-project-menu-restoreViewPreset-${preset.slot}`}
              onSelect={() => {
                run('project.viewPreset.restore', { slot: preset.slot })
              }}
            />
          ))}
        </SubMenu>
      ) : (
        <Later label={phrase('Restore View Preset')} uiId="control:project.menu.restoreViewPreset" testId="film-project-menu-restoreViewPreset" />
      )}
      <MenuItem label={phrase('Manage Saved View Presets')} disabled={!anyPreset} uiId="control:project.menu.manageViewPresets" testId="film-project-menu-manageViewPresets" onSelect={() => run('projectPanel.manageViewPresets')} />
      <MenuSeparator />
      <MenuItem label={phrase('Freeform View Options…')} disabled={mode !== 'freeform'} uiId="control:project.menu.freeformOptions" testId="film-project-menu-freeformOptions" onSelect={() => run('projectPanel.freeformOptions')} />
    </>
  )
}
