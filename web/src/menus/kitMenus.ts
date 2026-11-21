import type { MenuRow } from '@kition/sdk/editor'
import { isHiddenCommand } from './hidden.ts'

/**
 * Upstream's rows that Kition serves another way, in place, keeping upstream's label and key:
 * upstream command → Kition row. File ▸ Import picks media through the host (upstream's
 * `file_dialog`), and File ▸ Export ▸ Media runs Kition's stepped MP4 export (`movie.ts`) until
 * Export mode arrives. Both run through `invoke`'s `fileDialog` route.
 */
export const KIT_TAKEOVERS: Readonly<Record<string, string>> = {
  'file.import': 'kit:file.import',
  'file.exportMedia': 'kit:file.exportMedia',
}

/** Kition's Help rows (upstream's Help links to its former websites, which are hidden); their labels are phrases. */
export const HELP_ROWS: readonly MenuRow[] = [
  { path: ['Help'], label: 'Keyboard Shortcuts', shortcut: null, command: 'kit:help.shortcuts' },
  { path: ['Help'], label: 'About Kition Film', shortcut: null, command: 'kit:help.about' },
]

/**
 * `to` as seen from `folder`, both workspace paths: how the project names its media. A host
 * answers `host/pick` with a workspace path (the Kit UI protocol), `/`-separated;
 * a backslash separator or a leading `/` is read the same, so a Windows-style answer still names the file.
 */
export function relativePath(folder: string, to: string) {
  const parts = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean)
  const from = parts(folder)
  const target = parts(to)
  let shared = 0
  while (shared < from.length && shared < target.length - 1 && from[shared] === target[shared]) shared += 1
  return [...from.slice(shared).map(() => '..'), ...target.slice(shared)].join('/')
}

/** A row of the engine's `shortcuts.list`. */
export type ShortcutListRow = { id: string; label?: string; category?: string; shortcuts: ReadonlyArray<{ keys: string; panel?: string | null }> }

/** What the shortcuts list reads from the parity manifest: upstream's UI rows and keys, which the web engine does not hold. */
type ShortcutManifest = {
  menus: ReadonlyArray<{ path: readonly string[]; label: string; shortcut: string | null; command: string; origin: string }>
  keys: ReadonlyArray<{ command: string; label: string; bindings: ReadonlyArray<{ keys: string; panel: string | null }>; origin: string }>
}

/** One line of Help ▸ Keyboard Shortcuts. */
export type ShortcutItem = { command: string; label: string; category: string; keys: string; panel: string | null }

/**
 * Help ▸ Keyboard Shortcuts' list (read-only in wave 1): the engine's `shortcuts.list`, then
 * upstream's UI rows and keys (the manifest's) for the commands the engine does not list, once per
 * command, key, and panel, without the commands a browser hides and the keys `reserved` names.
 */
export function shortcutList(rows: readonly ShortcutListRow[], manifest: ShortcutManifest, reserved: (keys: string) => boolean = () => false): ShortcutItem[] {
  const out: ShortcutItem[] = []
  const seen = new Set<string>()
  const add = (item: ShortcutItem) => {
    const key = `${item.command} ${item.keys} ${item.panel ?? ''}`
    // A key Kition or the host keeps (`reservedKeys`) never reaches the editor: it is not listed.
    if (isHiddenCommand(item.command) || reserved(item.keys) || seen.has(key)) return
    seen.add(key)
    out.push(item)
  }
  for (const row of rows) for (const shortcut of row.shortcuts) add({ command: row.id, label: row.label ?? row.id, category: row.category ?? '', keys: shortcut.keys, panel: shortcut.panel ?? null })
  // A UI command the engine lists (registered with it) shows the engine's keys only.
  const listed = new Set(rows.map((row) => row.id))
  for (const row of manifest.menus) if (row.origin !== 'engine' && row.shortcut && !listed.has(row.command)) add({ command: row.command, label: row.label, category: row.path[0] ?? '', keys: row.shortcut, panel: null })
  for (const key of manifest.keys) if (key.origin !== 'engine' && !listed.has(key.command)) for (const binding of key.bindings) add({ command: key.command, label: key.label, category: '', keys: binding.keys, panel: binding.panel })
  return out
}
