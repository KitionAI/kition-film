// Imports carry `.ts` and the JSON its import attribute so `node --test` loads these modules as they are.
import type { MenuRow } from '@kition/sdk/editor'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { monitorViewChecked, type MonitorViews } from '../monitors/monitorView.ts'
import { HELP_ROWS, KIT_TAKEOVERS } from './kitMenus.ts'

/** Upstream's `menus.rs` `MENUS`: the menu bar, in order. */
export const MENUS = ['File', 'Edit', 'Clip', 'Sequence', 'Markers', 'Graphics and Titles', 'View', 'Window', 'Help'] as const

const KIT = 'kit:'
const WORKSPACE = 'window.workspace.'
/** Upstream's `workspaces.rs` `ACTIONS`: the Workspaces rows that are not workspaces. */
const WORKSPACE_ACTIONS = ['reset', 'saveChanges', 'saveAs', 'edit', 'rename', 'delete']

type ManifestRow = MenuRow & { origin?: string }

/** `dock.rs` `slug`: `Captions and Graphics` → `captionsandgraphics`. */
export const workspaceSlug = (name: string) => name.toLowerCase().replaceAll(' ', '')

/**
 * A row's command in the menus: an engine row runs its engine command (or Kition's takeover), and
 * one of upstream's own UI rows becomes `kit:<id>`, which runs through `invoke`. Its parity key
 * keeps the upstream id.
 */
function menuCommand(row: ManifestRow) {
  if (KIT_TAKEOVERS[row.command]) return KIT_TAKEOVERS[row.command]
  return row.origin === 'engine' ? row.command : `${KIT}${row.command}`
}

const isWorkspaceRow = (row: MenuRow) => row.path.length === 2 && row.path[0] === 'Window' && row.path[1] === 'Workspaces'
const workspaceId = (row: MenuRow) => row.command.replace(KIT, '').slice(WORKSPACE.length)

/**
 * Upstream's `workspaces::menu`: Window ▸ Workspaces rebuilt where its first row is, with every
 * workspace in `names` sorted without case (`dock::names`), then the actions in table order.
 * Built-in workspaces keep their keys.
 */
export function withWorkspaces(rows: readonly MenuRow[], names: readonly string[]): MenuRow[] {
  const at = rows.findIndex(isWorkspaceRow)
  if (at < 0) return [...rows]
  const workspaces = rows.filter(isWorkspaceRow)
  const actions = workspaces.filter((row) => WORKSPACE_ACTIONS.includes(workspaceId(row)))
  const shortcuts = new Map(workspaces.map((row) => [workspaceId(row), row.shortcut]))
  const lower = (name: string) => name.toLowerCase()
  const sorted = [...new Set(names)].sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0))
  const named = sorted.map((name) => ({ path: ['Window', 'Workspaces'], label: name, shortcut: shortcuts.get(workspaceSlug(name)) ?? null, command: `${KIT}${WORKSPACE}${workspaceSlug(name)}` }))
  const rest = rows.filter((row) => !isWorkspaceRow(row))
  return [...rest.slice(0, at), ...named, ...actions, ...rest.slice(at)]
}

/**
 * Upstream's menus as `menu_items_for` lists them (the parity manifest: the engine's rows, upstream's
 * UI rows, and the Window panel rows), each menu's rows together in `MENUS` order as `menu_bar`
 * draws them, with Kition's Help rows at the end. Rows the web hides stay in the catalog; the menu
 * bar skips them (`isHiddenOnWeb`).
 */
export function buildMenus(rows: readonly ManifestRow[], workspaces: readonly string[]): MenuRow[] {
  const menus = rows.map((row): MenuRow => ({ path: row.path, label: row.label, shortcut: row.shortcut, command: menuCommand(row) }))
  const ordered = MENUS.flatMap((menu) => menus.filter((row) => row.path[0] === menu))
  return [...withWorkspaces(ordered, workspaces), ...HELP_ROWS]
}

export const FILM_MENUS: readonly MenuRow[] = buildMenus(
  upstream.menus,
  upstream.workspaces.map((workspace) => workspace.name),
)

/** Kition's own rows in `FILM_MENUS`: upstream's UI rows, the takeovers, and Help. */
export const KIT_ROWS: readonly MenuRow[] = FILM_MENUS.filter((row) => row.command.startsWith(KIT))

/** A row of the engine's `shortcut.list` (`session/keys.ts` `ShortcutRow`). */
type LiveShortcuts = ReadonlyArray<{ id: string; shortcuts: ReadonlyArray<{ keys: string; panel?: string | null }> }>

/**
 * `menu_items_for`'s `shortcuts.primary(id)`: each row shows its command's first application-wide
 * binding in the engine's live shortcut set, none (an empty string) when the set has the command
 * unbound, and the manifest's default for upstream's UI commands, which the web engine does not hold.
 */
export function withLiveShortcuts(rows: readonly MenuRow[], live: LiveShortcuts | null, reserved: (keys: string) => boolean = () => false): readonly MenuRow[] {
  // A key Kition or the host keeps (`reservedKeys`) is not the row's: the next binding shows, or none.
  const own = (keys: string | null | undefined) => (keys && reserved(keys) ? '' : keys)
  const byId = new Map((live ?? []).map((row) => [row.id, row.shortcuts.find((binding) => !binding.panel && !reserved(binding.keys))?.keys ?? '']))
  let changed = false
  const next = rows.map((row) => {
    const shortcut = live ? byId.get(row.command.startsWith(KIT) ? row.command.slice(KIT.length) : row.command) ?? own(row.shortcut) ?? undefined : own(row.shortcut) ?? undefined
    if (shortcut === undefined || shortcut === row.shortcut) return row
    changed = true
    return { ...row, shortcut }
  })
  return changed ? next : rows
}

const LABEL = 'edit.label.'

/** The label names and colours (`prefs.get {"key":"labels"}`), by lower-case label. */
type LabelPrefs = { colors: Readonly<Record<string, { name: string }>> } | null

/** `menu_items_for`: Edit ▸ Label rows carry the names from the label preferences. */
export function withLabelNames(rows: readonly MenuRow[], labels: LabelPrefs): readonly MenuRow[] {
  if (!labels) return rows
  return rows.map((row) => {
    const name = row.command.startsWith(LABEL) ? labels.colors[row.command.slice(LABEL.length)]?.name : undefined
    return name && name !== row.label ? { ...row, label: name } : row
  })
}

/** What the menus' check marks read. */
export type MenuState = {
  /** The workspace in use, or null before the workspace is known. */
  workspace: string | null
  views: MonitorViews
  /** The focused panel, which picks the monitor whose view the View rows show. */
  focused: string
  /** View ▸ Dynamic Audio Waveforms (the Timeline's view); unset reads as on, its default. */
  dynamicWaveforms?: boolean
}

/**
 * Upstream's `menu_items` check marks: the workspace in use among Window ▸ Workspaces' names, and
 * the focused monitor's view options among the `view.*` rows, and Dynamic Audio Waveforms
 * (`menu_dialogs.rs` `checked`). Other rows (the engine's toggles
 * too, as upstream) draw plain: undefined.
 */
export function menuChecked({ workspace, views, focused, dynamicWaveforms = true }: MenuState) {
  return (command: string): boolean | undefined => {
    const id = command.startsWith(KIT) ? command.slice(KIT.length) : command
    if (id === 'view.dynamicAudioWaveforms') return dynamicWaveforms
    if (id.startsWith(WORKSPACE)) {
      const slug = id.slice(WORKSPACE.length)
      if (workspace == null || WORKSPACE_ACTIONS.includes(slug)) return undefined
      return slug === workspaceSlug(workspace)
    }
    return id.startsWith('view.') ? monitorViewChecked(views, id, focused) : undefined
  }
}
