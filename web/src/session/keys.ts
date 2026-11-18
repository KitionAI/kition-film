import { isHiddenCommand } from '../menus/hidden.ts'
import { focusedPanel } from '../panels/projectModel.ts'

/**
 * The key router, as upstream's `menus.rs` `bindings` and `parse_shortcut` and `lib.rs`
 * `handle_shortcuts`. The table is the engine's shortcut set (`shortcuts.list`) plus upstream's
 * own UI commands and their default keys (the parity manifest's UI rows and keys), which the web
 * engine does not hold. Pure, so `node --test` runs it.
 */

/** One key with the modifiers it needs: `command` is ⌘ on macOS and Control elsewhere; `ctrl` is Control on macOS only. */
export type Chord = { key: string; command: boolean; ctrl: boolean; shift: boolean; alt: boolean }

/** One binding: the command a chord runs, application-wide or in one panel (its lowerCamel id). */
export type KeyBinding = { chord: Chord; command: string; panel: string | null }

export type KeyTable = { mac: boolean; bindings: readonly KeyBinding[] }

/** A row of the engine's `shortcuts.list`; its bindings name their panel by title. */
export type ShortcutRow = { id: string; shortcuts: ReadonlyArray<{ keys: string; panel?: string | null }> }

/** What the table reads from the parity manifest. */
export type KeyManifest = {
  menus: ReadonlyArray<{ command: string; shortcut: string | null; origin: string; label?: string; path?: readonly string[] }>
  keys: ReadonlyArray<{ command: string; bindings: ReadonlyArray<{ keys: string; panel: string | null }>; origin: string; label?: string; shortcut?: string | null }>
  panels: ReadonlyArray<{ id: string; title: string }>
}

/** A frontend command for the engine's `shortcuts.registerExternal`. */
export type ExternalCommand = { id: string; label: string; menu?: string[]; shortcut?: string }

/**
 * Upstream's `external_commands` (`menus.rs`): its own UI commands (the menu rows and keys that
 * are not the engine's, the Window panel rows) with their labels, menus, and default keys, which
 * upstream registers with the engine's shortcut set at startup (`register_external`). Registered,
 * the engine's panel tables bind them too (the Project panel's arrows), and they can be rebound.
 */
export function externalCommands(manifest: KeyManifest): ExternalCommand[] {
  const out = new Map<string, ExternalCommand>()
  for (const row of manifest.menus) {
    if (row.origin === 'engine' || row.command.startsWith('kit:') || out.has(row.command)) continue
    out.set(row.command, { id: row.command, label: row.label ?? row.command, ...(row.path?.length ? { menu: [...row.path] } : {}), ...(row.shortcut ? { shortcut: row.shortcut } : {}) })
  }
  for (const key of manifest.keys) {
    if (key.origin !== 'ui' || out.has(key.command)) continue
    out.set(key.command, { id: key.command, label: key.label ?? key.command, ...(key.shortcut ? { shortcut: key.shortcut } : {}) })
  }
  return [...out.values()]
}

/** The fields of a browser key event the router reads. */
export type KeyPress = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

const NAMED: Readonly<Record<string, string>> = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space', Esc: 'Escape' }
const NAMED_KEYS = new Set(['Space', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Backspace', 'Enter', 'Escape', 'Tab', 'Insert'])
/**
 * Characters that are keys of their own (egui's `Key` has them). Other shifted characters (`~`,
 * `_`, `<`, `>`, `"`) are not, so they fall back to the physical key, as egui-winit does.
 */
const GLYPHS = new Set([',', '-', '.', '/', ';', '=', '[', '\\', ']', '`', "'", ':', '?', '+', '|', '!', '{', '}'])
const CODES: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
}
/** `shifted_key`: the key a US layout reports for a punctuation key with Shift held. */
const SHIFTED: Readonly<Record<string, string>> = { ';': ':', '/': '?', '=': '+', '\\': '|', '1': '!', '[': '{', ']': '}' }

/** A key name in a shortcut (`K`, `Left`, `F1`, `` ` ``) as the router names keys. */
function keyName(name: string): string | null {
  if (/^[a-z]$/i.test(name)) return name.toUpperCase()
  if (/^\d$/.test(name) || GLYPHS.has(name) || NAMED_KEYS.has(name) || /^F\d{1,2}$/.test(name)) return name
  return NAMED[name] ?? null
}

/** `parse_shortcut`: "Cmd+Shift+K" as the modifiers it needs and its key; off macOS `Ctrl` and `Cmd` are one key. */
export function parseShortcut(text: string, mac: boolean): Chord | null {
  const chord: Chord = { key: '', command: false, ctrl: false, shift: false, alt: false }
  const parts = text === '+' ? ['+'] : text.split('+')
  let key: string | null = null
  for (const part of parts) {
    if (part === 'Cmd') chord.command = true
    else if (part === 'Shift') chord.shift = true
    else if (part === 'Alt') chord.alt = true
    else if (part === 'Ctrl') {
      if (mac) chord.ctrl = true
      else chord.command = true
    } else key = keyName(part)
  }
  return key ? { ...chord, key } : null
}

/** The key a browser event names: its character when that is a key of its own, else its physical key (Alt on a Mac changes the character). */
function pressedKey(event: KeyPress): string | null {
  const own = keyName(event.key)
  if (own) return own
  const letter = /^Key([A-Z])$/.exec(event.code)
  if (letter) return letter[1]
  const digit = /^Digit(\d)$/.exec(event.code)
  if (digit) return digit[1]
  return CODES[event.code] ?? null
}

/** egui's `matches_logically`: the pattern's Alt and Shift must be held (extra ones are allowed); Command and Control must match. */
function matches(held: Omit<Chord, 'key'>, pattern: Chord) {
  if (pattern.alt && !held.alt) return false
  if (pattern.shift && !held.shift) return false
  if (!pattern.ctrl && !pattern.command) return !held.ctrl && !held.command
  if (pattern.ctrl && !held.ctrl) return false
  if (pattern.command && !held.command) return false
  return true
}

const weight = (chord: Chord) => Number(chord.command) + Number(chord.shift) + Number(chord.alt) + Number(chord.ctrl)

const sameChord = (a: Chord, b: Chord) => a.key === b.key && a.command === b.command && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt

/**
 * Whether `keys` ("Cmd+W") is one of the `reserved` chords (Kition's own keys, kit-editor's
 * `RESERVED_SHORTCUTS`, and the host's `init.shortcuts`): the editor never takes it, so it is not
 * shown as the editor's either. `keyTable` drops the same bindings.
 */
export function reservedKeys(reserved: Iterable<string>, mac: boolean): (keys: string) => boolean {
  const taken = [...reserved].map((text) => parseShortcut(text, mac)).filter((chord): chord is Chord => chord != null)
  return (keys) => {
    const chord = parseShortcut(keys, mac)
    return chord != null && taken.some((other) => sameChord(other, chord))
  }
}

/**
 * `bindings`: every binding of the engine's shortcut set, then upstream's UI commands with their
 * default keys; with Shift held, a punctuation key also arrives as its shifted glyph; most
 * modifiers first, so Shift+I does not also fire I. Bindings on a `reserved` chord (Kition's own
 * keys, kit-editor's `RESERVED_SHORTCUTS`, and the host's `init.shortcuts`) are dropped, so those keys
 * reach the host and the browser.
 */
export function keyTable(shortcuts: readonly ShortcutRow[], manifest: KeyManifest, mac: boolean, reserved: Iterable<string> = []): KeyTable {
  const isReserved = reservedKeys(reserved, mac)
  const panelIds = new Map(manifest.panels.map((panel) => [panel.title, panel.id]))
  const raw: Array<{ keys: string; command: string; panel: string | null }> = []
  for (const row of shortcuts) for (const binding of row.shortcuts) raw.push({ keys: binding.keys, command: row.id, panel: binding.panel ?? null })
  // A UI command the engine lists (registered, `externalCommands`) has the engine's bindings, its
  // panel tables' and a person's rebinding included; until the engine lists it, the manifest's.
  const listed = new Set(shortcuts.map((row) => row.id))
  for (const row of manifest.menus) if (row.origin !== 'engine' && row.shortcut && !listed.has(row.command)) raw.push({ keys: row.shortcut, command: row.command, panel: null })
  for (const key of manifest.keys) if (key.origin === 'ui' && !listed.has(key.command)) for (const binding of key.bindings) raw.push({ keys: binding.keys, command: key.command, panel: binding.panel })
  const bindings: KeyBinding[] = []
  for (const item of raw) {
    const chord = parseShortcut(item.keys, mac)
    // A panel the editor does not know keeps its title, so its bindings never apply.
    if (chord && !isReserved(item.keys)) bindings.push({ chord, command: item.command, panel: item.panel == null ? null : (panelIds.get(item.panel) ?? item.panel) })
  }
  const shifted = bindings.filter((binding) => binding.chord.shift && SHIFTED[binding.chord.key]).map((binding) => ({ ...binding, chord: { ...binding.chord, key: SHIFTED[binding.chord.key] } }))
  const all = [...bindings, ...shifted]
  // Array.prototype.sort is stable: equal weights keep the shortcut set's order.
  all.sort((a, b) => weight(b.chord) - weight(a.chord))
  return { mac, bindings: all }
}

/**
 * The command a key press runs with `focused` (a panel's lowerCamel id) focused, or null. The
 * focused panel's bindings come first, then application-wide ones; the first that matches wins. A
 * hidden command resolves to nothing, so the shell's own key (Save) runs; a command `serves` says
 * nothing runs yet is passed over for the next binding. Select All and Deselect
 * All act on the Project panel's items while it (or a floating bin window) has focus.
 */
export function resolveKey(event: KeyPress, focusedNow: string, table: KeyTable, serves: (command: string) => boolean = () => true): string | null {
  // A floating bin window takes the Project panel's keys.
  const focused = focusedPanel(focusedNow)
  const key = pressedKey(event)
  if (!key) return null
  const held = table.mac
    ? { command: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey }
    : { command: event.ctrlKey, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey }
  const inPanel = table.bindings.filter((binding) => binding.panel === focused)
  const appWide = table.bindings.filter((binding) => binding.panel == null)
  // A binding whose command no part of the editor serves yet (a later wave's panel command) gives
  // way to the next match, so the key still runs what it ran before (Backspace in the Text panel).
  const hit = [...inPanel, ...appWide].find((binding) => binding.chord.key === key && matches(held, binding.chord) && (isHiddenCommand(binding.command) || serves(binding.command)))
  if (!hit || isHiddenCommand(hit.command)) return null
  if (focused === 'project' && (hit.command === 'edit.selectAll' || hit.command === 'edit.deselectAll')) return hit.command.replace('edit.', 'project.')
  return hit.command
}
