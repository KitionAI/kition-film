// Builds film-upstream.json from upstream's ui-egui source (menus.rs, panels/keyboard.rs, dock.rs,
// state.rs, lib.rs, and every element its automation registry names) and the built web engine
// (`pnpm --dir web engine`; upstream's engine, whose command registry upstream's menus draw), then
// adds any new item to film-status.json as `todo` (with the wave the plan's rules in waves.mjs
// give it, or `hidden` for the rows Rule 2 hides from the start) and drops entries whose item is
// gone. Existing entries are never changed: delete film-status.json to write it from scratch.
//
// Node, no dependencies: run `KITION_UPSTREAM_UI=<path to the upstream crates/ui-egui checkout>
// node web/parity/extract.mjs` whenever upstream or the engine's commands change; the output is
// committed, so this does not run in CI.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileWave, panelWave, ruleWaves, slug } from './waves.mjs'

const upstreamRoot = process.env.KITION_UPSTREAM_UI
if (!upstreamRoot) {
  console.error('KITION_UPSTREAM_UI is not set: point it at the upstream crates/ui-egui checkout (KitionAI/kition-film-archive at v0.5.0).')
  process.exit(1)
}

const srcDir = path.join(upstreamRoot, 'src')
if (!existsSync(path.join(srcDir, 'menus.rs'))) {
  console.error(`no upstream ui-egui source at ${srcDir}: KITION_UPSTREAM_UI must name the crates/ui-egui directory.`)
  process.exit(1)
}
const read = (name) => readFileSync(path.join(srcDir, name), 'utf8')

const menusText = read('menus.rs')
const keyboardText = read('panels/keyboard.rs')
const workspacesText = read('panels/workspaces.rs')
const dockText = read('dock.rs')
const stateText = read('state.rs')
const libText = read('lib.rs')

// ---------------------------------------------------------------------------------- helpers
// `unescapeRustString`, `balancedAfter`, and `balancedAt` are copied from kition-photo's
// web/parity/extract.mjs (repositories never import each other).

/** Unescapes the limited set of escapes the upstream source uses inside its string literals. */
function unescapeRustString(s) {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
}

/**
 * Finds the balanced bracket group whose opening bracket is the last character matched by
 * `anchor` (a regex that must end exactly on `{`, `[`, or `(`), then returns its contents.
 * Skips string literals, char literals, and line comments while counting depth, so brace-like
 * characters inside an i18n template string (`"{key}-click"`) or a `'\0'` char literal never
 * throw off the count.
 */
function balancedAfter(text, anchor) {
  const m = anchor.exec(text)
  if (!m) throw new Error(`anchor not found: ${anchor}`)
  const open = m.index + m[0].length - 1
  if (!'{[('.includes(text[open])) throw new Error(`anchor ${anchor} did not end on an opening bracket (got ${JSON.stringify(text[open])})`)
  return balancedAt(text, open)
}

/** The contents of the bracket group that opens at `open` (see `balancedAfter`). */
function balancedAt(text, open) {
  let depth = 0
  let i = open
  while (i < text.length) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (c === "'") {
      // A char literal ('V', '\0', '\\') closes within two or three characters; anything else
      // (a lifetime like `&'static`) is not, so only consume it as a literal when it does.
      let j = i + 1
      if (text[j] === '\\') j++
      j++
      if (text[j] === "'") {
        i = j + 1
        continue
      }
      i++
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    }
    i++
  }
  throw new Error(`unbalanced block starting at ${open}`)
}

/**
 * Splits the contents of a bracket group at its top-level commas (string literals, char
 * literals, comments, and nested brackets skipped), trimmed, without a trailing empty part.
 */
function splitTopLevel(body) {
  const parts = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if (c === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i++
      continue
    }
    if (c === '"') {
      i++
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (c === "'") {
      let j = i + 1
      if (body[j] === '\\') j++
      j++
      if (body[j] === "'") {
        i = j + 1
        continue
      }
    }
    // `|a, b|` closure parameters hold top-level commas too; they never appear in the argument
    // lists read here.
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i).trim())
      start = i + 1
    }
    i++
  }
  const last = body.slice(start).trim()
  if (last) parts.push(last)
  return parts
}

const STRING = /"((?:[^"\\]|\\.)*)"/g
/** Every string literal in `text`, unescaped, in order. */
const literals = (text) => [...text.matchAll(STRING)].map((m) => unescapeRustString(m[1]))
/** A literal (`"x"`, `&"x"`, `"x".into()`) or `tl!("x")`, else null. */
function literalOf(expr) {
  const m = /^&?(?:tl!\(\s*)?"((?:[^"\\]|\\.)*)"\s*\)?(?:\.(?:into|to_string|to_owned)\(\))?$/.exec(expr.trim())
  return m ? unescapeRustString(m[1]) : null
}
/** `Media Browser` → `mediaBrowser`, `Effect Controls` → `effectControls`. */
const lowerCamel = (s) =>
  s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1)))
    .join('')

// ---------------------------------------------------------------------------------- engine

/** The built web engine's commands, in its registry's order, and `shortcuts.list` by id. */
async function engine() {
  const dir = fileURLToPath(new URL('../public/engine/', import.meta.url))
  const wasm = path.join(dir, 'kition_film_kit_bg.wasm')
  if (!existsSync(wasm)) {
    console.error(`no built engine at ${dir}: run \`pnpm --dir web engine\` first.`)
    process.exit(1)
  }
  const sdk = await import(pathToFileURL(path.join(dir, 'kition_film_kit.js')).href)
  sdk.initSync({ module: readFileSync(wasm) })
  const doc = sdk.FilmDocument.create('Untitled', 1920, 1080)
  const commands = JSON.parse(doc.commands())
  const shortcuts = new Map(JSON.parse(doc.execute('shortcuts.list', '{}')).map((entry) => [entry.id, entry]))
  return { commands, shortcuts }
}

/** The engine's source (this repository's `crates/engine/engine/src`), for `specLabel`. */
const engineSourceDir = fileURLToPath(new URL('../../crates/engine/engine/src/', import.meta.url))
const engineSource = readdirSync(engineSourceDir)
  .filter((name) => name.endsWith('.rs') && !name.endsWith('_tests.rs'))
  .map((name) => readFileSync(path.join(engineSourceDir, name), 'utf8'))
  .join('\n')
let restoredEllipses = 0
/**
 * A command's label as its spec writes it: the title, with the `…` the binding trims when the
 * spec (its id, then within a few lines its label) has one.
 */
function specLabel(command) {
  const id = `"${command.id}"`
  for (let at = engineSource.indexOf(id); at >= 0; at = engineSource.indexOf(id, at + 1)) {
    const near = engineSource.slice(at + id.length, at + id.length + 300)
    // `spec("id", "Label", …)` or `CommandSpec { id: "id", label: "Label", … }`.
    const label = /^\s*,\s*(?:label:\s*)?"((?:[^"\\]|\\.)*)"/.exec(near)?.[1]
    if (label != null && unescapeRustString(label).replace(/…$/, '') === command.title) {
      if (label.endsWith('…')) restoredEllipses += 1
      return unescapeRustString(label)
    }
  }
  return command.title
}

// ---------------------------------------------------------------------------------- UI commands

/** `uic!("id", "Label", ["Menu", …], Some("Sc") | None)` rows of a `&[UiCommand]` table. */
function parseUic(text, name) {
  const body = balancedAfter(text, new RegExp(String.raw`pub const ${name}: &\[UiCommand\] = &\[`))
  const re = /uic!\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*\[((?:\s*"(?:[^"\\]|\\.)*"\s*,?)*)\s*\]\s*,\s*(?:Some\(\s*"((?:[^"\\]|\\.)*)"\s*\)|None)\s*\)/g
  return [...body.matchAll(re)].map((m) => ({
    id: unescapeRustString(m[1]),
    label: unescapeRustString(m[2]),
    menu: literals(m[3]),
    shortcut: m[4] != null ? unescapeRustString(m[4]) : null,
  }))
}

// ---------------------------------------------------------------------------------- dock

/** `match self { PanelKind::X => <value>, … }` arms of the function `fn` in dock.rs. */
function panelArms(fnName) {
  const body = balancedAfter(dockText, new RegExp(String.raw`pub fn ${fnName}\(self\)[^{]*\{`))
  const arms = new Map()
  for (const m of body.matchAll(/PanelKind::(\w+)\s*=>\s*(Some\(\s*"((?:[^"\\]|\\.)*)"\s*\)|"((?:[^"\\]|\\.)*)")/g)) arms.set(m[1], unescapeRustString(m[3] ?? m[4]))
  return arms
}

function parsePanels() {
  const all = balancedAfter(dockText, /pub const ALL: \[PanelKind; \d+\] = \[/)
  const kinds = [...all.matchAll(/PanelKind::(\w+)/g)].map((m) => m[1])
  const titles = panelArms('title')
  const shortcuts = panelArms('window_shortcut')
  const compactBody = balancedAfter(dockText, /pub fn compact\(self\) -> bool\s*\{/)
  const compact = new Set([...compactBody.matchAll(/PanelKind::(\w+)/g)].map((m) => m[1]))
  return kinds.map((kind) => ({ id: lowerCamel(kind), kind, title: titles.get(kind), shortcut: shortcuts.get(kind) ?? null, compact: compact.has(kind) }))
}

const WORKSPACE_NAMES = literals(balancedAfter(dockText, /pub const WORKSPACES: \[&str; \d+\] = \[/))

/**
 * `dock.rs` `workspace(name)`: a small recursive parser over `vsplit(…)`, `hsplit(…)`,
 * `tabs(&[…], n)`, the split sizes, and the `bottom_editing()` closure.
 */
function parseWorkspaces() {
  const fn = balancedAfter(dockText, /pub fn workspace\(name: &str\) -> DockNode\s*\{/)
  const closures = new Map()
  for (const m of fn.matchAll(/let (\w+) = \|\|\s*/g)) {
    const start = m.index + m[0].length
    const end = fn.indexOf(';', fn.indexOf('(', start) + balancedAt(fn, fn.indexOf('(', start)).length)
    closures.set(m[1], fn.slice(start, end).trim())
  }
  const size = (expr) => {
    const m = /^(?:SplitSize::)?(Ratio|FixedA|FixedB)\(\s*([\d.]+)\s*\)$/.exec(expr.trim())
    if (!m) throw new Error(`unknown split size: ${expr}`)
    return { [m[1] === 'Ratio' ? 'ratio' : m[1] === 'FixedA' ? 'fixedA' : 'fixedB']: Number(m[2]) }
  }
  const node = (expr) => {
    const e = expr.trim()
    const call = /^(\w+)\(/.exec(e)
    if (!call) throw new Error(`unknown layout node: ${e.slice(0, 60)}`)
    const args = splitTopLevel(balancedAt(e, call[0].length - 1))
    if (call[1] === 'vsplit' || call[1] === 'hsplit') return { split: call[1] === 'vsplit' ? 'column' : 'row', size: size(args[0]), a: node(args[1]), b: node(args[2]) }
    if (call[1] === 'tabs') return { tabs: [...args[0].matchAll(/(?:PanelKind::)?(\w+)/g)].map((m) => lowerCamel(rewordId(m[1]))), active: Number(args[1]) }
    if (closures.has(call[1]) && args.length === 0) return node(closures.get(call[1]))
    throw new Error(`unknown layout call: ${call[1]}`)
  }
  const match = balancedAfter(fn, /match name\s*\{/)
  const arms = new Map()
  let fallback = null
  for (const m of match.matchAll(/(?:"((?:[^"\\]|\\.)*)"|_)\s*=>\s*/g)) {
    // Only arms at the top of the match: their bodies are calls, so the arm text runs to the end of that call.
    const start = m.index + m[0].length
    const open = match.indexOf('(', start)
    if (!/^\w+$/.test(match.slice(start, open).trim())) continue
    const expr = match.slice(start, open + balancedAt(match, open).length + 2)
    if (m[1] != null) arms.set(unescapeRustString(m[1]), node(expr))
    else fallback = node(expr)
  }
  return WORKSPACE_NAMES.map((name) => ({ name, layout: arms.get(name) ?? fallback }))
}

// ---------------------------------------------------------------------------------- menus

/**
 * `menus.rs` `menu_items_for`, then `panels/workspaces.rs` `menu`: the engine's commands with a
 * menu path (registry order), upstream's UI commands with a menu (`UI_COMMANDS`, then
 * `keyboard::COMMANDS`), one Window row per panel, and the Workspaces submenu rebuilt as the
 * built-in workspaces sorted case-insensitively, then the layout actions. Upstream draws no
 * separators.
 */
function buildMenus(commands, shortcuts, uiCommands, panels) {
  const rows = []
  for (const command of commands) {
    if (!command.menu?.length) continue
    const listed = shortcuts.get(command.id)
    // The binding trims a trailing `…` from titles; `shortcuts.list` keeps the label as written,
    // and for the commands it does not list, the engine's own source does.
    const label = listed?.label ?? specLabel(command)
    const primary = listed ? (listed.shortcuts.find((s) => s.panel == null)?.keys ?? null) : (command.shortcut ?? null)
    rows.push({ path: [...command.menu], label, shortcut: primary, command: command.id, origin: 'engine' })
  }
  for (const c of uiCommands) if (c.menu.length) rows.push({ path: [...c.menu], label: c.label, shortcut: c.shortcut, command: c.id, origin: 'ui' })
  for (const p of panels) rows.push({ path: ['Window'], label: p.title, shortcut: p.shortcut, command: `window.panel.${p.kind}`, origin: 'panel' })

  const actions = literals(balancedAfter(workspacesText, /const ACTIONS: \[&str; \d+\] = \[/))
  const isWorkspaces = (row) => row.path.length === 2 && row.path[0] === 'Window' && row.path[1] === 'Workspaces'
  const at = rows.findIndex(isWorkspaces)
  const actionRows = rows.filter((row) => isWorkspaces(row) && actions.includes(row.command.replace(/^window\.workspace\./, '')))
  const uicById = new Map(uiCommands.map((c) => [c.id, c]))
  const workspaceRows = [...WORKSPACE_NAMES]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((name) => {
      const command = `window.workspace.${slug(name)}`
      return { path: ['Window', 'Workspaces'], label: name, shortcut: uicById.get(command)?.shortcut ?? null, command, origin: 'workspace' }
    })
  const spliced = [...workspaceRows, ...actionRows.map((row) => ({ ...row, origin: 'workspace' }))]
  const kept = rows.filter((row) => !isWorkspaces(row))
  kept.splice(at < 0 ? kept.length : rows.slice(0, at).filter((row) => !isWorkspaces(row)).length, 0, ...spliced)
  return kept
}

// ---------------------------------------------------------------------------------- tools

function parseTools() {
  const all = balancedAfter(stateText, /impl Tool\s*\{[\s\S]*?pub const ALL: \[Tool; \d+\] = \[/)
  const ids = [...all.matchAll(/Tool::(\w+)/g)].map((m) => m[1])
  const armsOf = (fnName) => {
    const body = balancedAfter(stateText, new RegExp(String.raw`impl Tool\s*\{[\s\S]*?pub fn ${fnName}\(self\) -> &'static str\s*\{`))
    const map = new Map()
    for (const m of body.matchAll(/((?:Tool::\w+)(?:\s*\|\s*Tool::\w+)*)\s*=>\s*"((?:[^"\\]|\\.)*)"/g)) for (const t of m[1].matchAll(/Tool::(\w+)/g)) map.set(t[1], unescapeRustString(m[2]))
    return map
  }
  const labels = armsOf('label')
  const keys = armsOf('shortcut')
  const groupsBody = balancedAfter(stateText, /pub fn groups\(\) -> Vec<Vec<Tool>>\s*\{/)
  const groups = [...groupsBody.matchAll(/vec!\[([^\[\]]*)\]/g)].map((m) => [...m[1].matchAll(/Tool::(\w+)/g)].map((t) => t[1])).filter((g) => g.length)
  const place = new Map()
  groups.forEach((group, g) => group.forEach((id, slot) => place.set(id, { group: g, slot })))
  const tools = ids.map((id) => ({ id, label: labels.get(id) ?? null, shortcut: keys.get(id) || null, group: place.get(id)?.group ?? null, slot: place.get(id)?.slot ?? null }))
  return { tools, groupCount: groups.length }
}

// ---------------------------------------------------------------------------------- hints

/** `lib.rs` `hint_text`: one entry per tool that has a hint; where upstream has both, the macOS text. */
function parseHints() {
  const fn = balancedAfter(libText, /fn hint_text\(&self\) -> String\s*\{/)
  const body = balancedAfter(fn, /match self\.ui\.tool\s*\{/)
  const hints = new Map()
  for (const m of body.matchAll(/state::Tool::(\w+)(\s+if\s+mac)?\s*=>\s*(\{)?\s*tl!\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
    const [, tool, mac, , text] = m
    if (mac || !hints.has(tool)) hints.set(tool, { tool, text: unescapeRustString(text), mac: Boolean(mac) })
  }
  return [...hints.values()].map(({ tool, text }) => ({ tool, text }))
}

// ---------------------------------------------------------------------------------- elements

function rustFiles(dir, base = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...rustFiles(path.join(dir, entry.name), rel))
    else if (entry.name.endsWith('.rs')) out.push(rel)
  }
  return out
}

/** Format placeholders that stay unresolved (`{x}`, `{}`, `{tl:?}`) become `{}`. */
const pattern = (id) => id.replace(/\{[^{}]*\}/g, '{}')
/** A string that can be (part of) an element id: no spaces. */
const idPart = (s) => s.length > 0 && !/\s/.test(s)
/** A string that names an engine or UI command: `clip.nest`, `file.newSequence`. */
const commandLike = (s) => /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(s)

/**
 * Prefix variables whose value is fixed by the file they appear in: the monitors draw the same
 * controls under `source` and `program`, and the Project panel's are under `project` (its bin
 * tabs and windows reuse them).
 */
const PREFIXES = {
  'monitor.rs': { prefix: ['source', 'program'], pfx: ['source', 'program'] },
  'monitor_view.rs': { prefix: ['source', 'program'], pfx: ['source', 'program'] },
  'project.rs': { pre: ['project'], 'v.prefix': ['project'] },
  'project_views.rs': { pre: ['project'], 'v.prefix': ['project'] },
}

/** An expression without its borrow and conversion: `&id.clone()` → `id`. */
const clean = (expr) =>
  expr
    .trim()
    .replace(/^(?:&\s*)+/, '')
    .replace(/(?:\.(?:as_str|clone|to_string|to_owned|into)\(\))+$/, '')
    .trim()

/** The index just past the statement that starts at `start` (its `;` at bracket depth 0). */
function statementEnd(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      if (depth === 0) return i
      depth--
    } else if (c === ';' && depth === 0) return i
  }
  return text.length
}

/** The start of the function containing `index`. */
function enclosingFnStart(text, index) {
  const before = text.slice(0, index)
  return Math.max(before.lastIndexOf('\nfn '), before.lastIndexOf(' fn '), 0)
}

/** The names a `for` pattern binds, flattened: `(i, (id, label))` → `i, id, label`. */
const names = (forPattern) =>
  forPattern
    .replace(/[()&]/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/**
 * The latest binding of `name` before `index` in its function: `let name = …;`, a `for` loop
 * (with its literal list, or the list a `let list = [ … ];` names, else none: a collection), or
 * the function's parameter.
 */
function bindingOf(text, index, name) {
  const start = enclosingFnStart(text, index)
  const scope = text.slice(start, index)
  const found = []
  for (const m of scope.matchAll(new RegExp(String.raw`let (?:mut )?${name}\b(?:\s*:[^=;]*)?\s*=\s*`, 'g'))) {
    const at = start + m.index + m[0].length
    found.push({ kind: 'let', at, expr: text.slice(at, statementEnd(text, at)) })
  }
  for (const m of scope.matchAll(/for\s+(\([^\n]*?\)|\w+)\s+in\s+/g)) {
    const all = names(m[1])
    const after = scope.slice(m.index + m[0].length)
    // The iterated expression: a literal list (which may span lines), else the text up to the body.
    const source = /^&?\[/.test(after) ? after.slice(0, after.indexOf('[') + 1) : after.slice(0, after.search(/\{\s*(?:\n|let|if)/)).trim()
    let list = null
    let listAt = -1
    let enumerated = /\.enumerate\(\)/.test(source)
    if (/^&?\[/.test(source)) {
      listAt = start + m.index + m[0].length + after.indexOf('[')
      list = balancedAt(text, listAt)
      enumerated = /^\s*(?:\.\w+\(\)\s*)*?\.enumerate\(\)/.test(text.slice(listAt + list.length + 2))
    }
    const fields = enumerated ? all.slice(1) : all
    if (!fields.includes(name)) continue
    if (list != null) {
      // read above
    } else if (/^&?\w+\(\)/.test(source) && LIST_FNS.includes(/^&?(\w+)/.exec(source)[1]) && listFn(text, /^&?(\w+)/.exec(source)[1])) {
      // A local function that answers a literal list: `for (k, l) in intrinsic_video()`.
      ;({ list, listAt } = listFn(text, /^&?(\w+)/.exec(source)[1]))
    } else {
      const listName = /^&?(\w+)/.exec(source)?.[1]
      const bound = listName && [...scope.matchAll(new RegExp(String.raw`let (?:mut )?${listName}\b[^=]*?=\s*(?:&?\[|vec!\[)`, 'g'))].at(-1)
      if (bound) {
        listAt = start + bound.index + bound[0].length - 1
        list = balancedAt(text, listAt)
      }
    }
    found.push({ kind: 'for', at: start + m.index, fields, list, listAt })
  }
  const latest = found.sort((a, b) => a.at - b.at).at(-1)
  if (latest) return latest
  const signature = /fn (\w+)(?:<[^>]*>)?\(/.exec(text.slice(start, index))
  if (!signature) return null
  const open = start + signature.index + signature[0].length - 1
  const params = splitTopLevel(balancedAt(text, open)).map((p) => p.split(':')[0].replace(/^mut\s+/, '').trim())
  return params.includes(name) ? { kind: 'param', fnName: signature[1], params, open } : null
}

/**
 * Functions answering a literal list that a loop registers ids from, and that is the only place
 * those ids appear: Paste and Remove Attributes' intrinsic checkboxes (clip_dialogs.rs). Other
 * list functions (`formats`, `hold_on`, `methods`) feed radios the manifest keeps as `{}` patterns.
 */
const LIST_FNS = ['intrinsic_video', 'intrinsic_audio']
/** The literal list a no-argument function of `text` answers (`fn formats() -> [..; 4] { [ … ] }`), or null. */
function listFn(text, name) {
  const m = new RegExp(String.raw`fn ${name}\(\)\s*->[^{]*\{\s*\[`).exec(text)
  if (!m) return null
  const listAt = m.index + m[0].length - 1
  return { list: balancedAt(text, listAt), listAt }
}

/** Tuples of a list literal (their parts split at top level). */
const tuples = (list) =>
  splitTopLevel(list)
    .filter((t) => t.startsWith('('))
    .map((t) => splitTopLevel(balancedAt(t, 0)))

/**
 * The values an expression can take where it is used, as `{ value, label?, command?, env? }`, or
 * null when it cannot be read from the source: a literal, `if … { "a" } else { "b" }`, a
 * `format!` (its placeholders resolved in turn, unresolved ones left as `{…}`), a file's fixed
 * prefix, a `let`, a loop over a literal list (with the row's label, when `labelVar` is bound by
 * the same loop, and a command the row names), or a parameter (what its callers in the file pass).
 */
function valuesOf(text, index, expr, file, labelVar = null, depth = 0) {
  if (depth > 5) return null
  const e = clean(expr)
  const fixed = PREFIXES[file.split('/').pop()]?.[e]
  if (fixed) return fixed.map((value) => ({ value }))
  if (/^format!\s*\(/.test(e)) return expandTemplate(text, index, e, file, labelVar, depth)
  if (/^tl!\(/.test(e) || /^"/.test(e) || /^if\b/.test(e)) {
    const found = literals(e).filter(idPart)
    return found.length ? found.map((value) => ({ value })) : null
  }
  const indexed = /^(\w+)\[(\d+)\]$/.exec(e)
  if (indexed) {
    const binding = bindingOf(text, index, indexed[1])
    if (binding?.kind !== 'let') return null
    const values = [...binding.expr.matchAll(/\[([^\[\]]*)\]/g)].map((b) => literals(b[1])[Number(indexed[2])]).filter(Boolean)
    return values.length ? values.map((value) => ({ value })) : null
  }
  if (!/^\w+$/.test(e)) return null
  const binding = bindingOf(text, index, e)
  if (!binding) return null
  if (binding.kind === 'let') {
    const values = valuesOf(text, binding.at, binding.expr, file, labelVar, depth + 1)
    if (values) return values
    // Another expression (`k.map_or("a.b".to_string(), |k| format!("a.{k}"))`): its dotted literals.
    const found = literals(binding.expr).filter((s) => idPart(s) && s.includes('.'))
    return found.length ? found.map((value) => ({ value })) : null
  }
  if (binding.kind === 'for') {
    if (binding.list == null) return null
    const at = binding.fields.indexOf(e)
    const labelAt = labelVar ? binding.fields.indexOf(labelVar) : -1
    const out = []
    for (const parts of tuples(binding.list)) {
      const label = labelAt >= 0 ? literalOf(parts[labelAt] ?? '') : null
      const command = parts.filter((_, i) => i !== at).map((p) => literalOf(p)).find((p) => p && commandLike(p)) ?? null
      const env = Object.fromEntries(binding.fields.map((field, i) => [field, literalOf(parts[i] ?? '')]))
      const inner = valuesOf(text, binding.listAt, parts[at] ?? '', file, null, depth + 1)
      for (const v of inner ?? [{ value: null }]) out.push({ value: v.value, label: label ?? v.label ?? null, command: command ?? v.command ?? null, env })
    }
    return out.some((v) => v.value != null) ? out.filter((v) => v.value != null) : null
  }
  // A parameter: what the callers in this file pass.
  const at = binding.params.indexOf(e)
  const labelAt = labelVar ? binding.params.indexOf(labelVar) : -1
  const out = []
  // The function's own text: a recursive call passes the parameter on, which says nothing new.
  const bodyOpen = text.indexOf('{', binding.open + balancedAt(text, binding.open).length + 2)
  const bodyEnd = bodyOpen + balancedAt(text, bodyOpen).length + 1
  for (const call of text.matchAll(new RegExp(String.raw`\b${binding.fnName}\(`, 'g'))) {
    if (call.index >= binding.open - binding.fnName.length - 4 && call.index <= bodyEnd) continue
    // A method of the same name (`ui.painter().text(…)`, `RichText::text(…)`) is another function.
    if (/(?:\.|::)\s*$/.test(text.slice(Math.max(0, call.index - 3), call.index))) continue
    let args
    try {
      args = splitTopLevel(balancedAt(text, call.index + call[0].length - 1))
    } catch {
      continue
    }
    const callerLabelVar = labelAt >= 0 && /^&?\w+$/.test((args[labelAt] ?? '').trim()) ? clean(args[labelAt]) : null
    const label = labelAt >= 0 ? literalOf(args[labelAt] ?? '') : null
    const command = args.filter((_, i) => i !== at).map((p) => literalOf(p)).find((p) => p && commandLike(p)) ?? null
    // The call's other arguments go with this value: a template naming two parameters takes both from one call.
    const env = Object.fromEntries(binding.params.map((param, i) => [param, literalOf(args[i] ?? '')]))
    for (const v of valuesOf(text, call.index, args[at] ?? '', file, callerLabelVar, depth + 1) ?? []) out.push({ value: v.value, label: label ?? v.label ?? null, command: command ?? v.command ?? null, env })
  }
  return out.length ? out : null
}

/**
 * A `format!` template with its placeholders resolved (named `{x}` and positional `{}` alike).
 * Placeholders bound by the same loop take the same row; one that cannot be read stays `{}`.
 */
function expandTemplate(text, index, formatExpr, file, labelVar, depth) {
  const args = splitTopLevel(balancedAt(formatExpr, formatExpr.indexOf('(')))
  const template = literals(args[0] ?? '')[0]
  if (template == null) return null
  const segments = []
  let positional = 0
  let last = 0
  for (const m of template.matchAll(/\{\{|\}\}|\{([^{}]*)\}/g)) {
    if (m[0] === '{{' || m[0] === '}}') continue
    segments.push(template.slice(last, m.index))
    const name = m[1].split(':')[0]
    segments.push({ expr: name === '' ? (args[1 + positional++] ?? '') : /^\d+$/.test(name) ? (args[1 + Number(name)] ?? '') : name })
    last = m.index + m[0].length
  }
  segments.push(template.slice(last))
  let variants = [{ parts: [], label: null, command: null, env: {} }]
  for (const segment of segments) {
    if (typeof segment === 'string') {
      for (const v of variants) v.parts.push(segment)
      continue
    }
    const key = clean(segment.expr)
    const next = []
    for (const v of variants) {
      if (Object.hasOwn(v.env, key)) {
        next.push({ ...v, parts: [...v.parts, v.env[key] ?? '{}'] })
        continue
      }
      const values = valuesOf(text, index, segment.expr, file, labelVar, depth + 1)
      if (!values) {
        next.push({ ...v, parts: [...v.parts, '{}'] })
        continue
      }
      // A value with spaces is a label, not part of an id.
      for (const value of values) next.push({ parts: [...v.parts, idPart(value.value) ? value.value : '{}'], label: value.label ?? v.label ?? null, command: v.command ?? value.command ?? null, env: { ...v.env, ...(value.env ?? {}) } })
    }
    variants = next
  }
  return variants.map((v) => ({ value: v.parts.join(''), label: v.label, command: v.command }))
}

/**
 * Buffered registrations, added later with `auto.add(&id, r, &l)` in a loop over a collection:
 * `push(&mut elems, <id>, &r, <label>)`, a `push(<id>, &r, <label>)` closure, and
 * `elems.push((<id>, r, <label>))`.
 */
function bufferedPushes(text, file) {
  const found = []
  for (const m of text.matchAll(/\bpush\(/g)) {
    let args
    try {
      args = splitTopLevel(balancedAt(text, m.index + m[0].length - 1))
    } catch {
      continue
    }
    if (args.length === 1 && args[0].startsWith('(')) args = splitTopLevel(balancedAt(args[0], 0))
    if (args[0]?.startsWith('&mut ') || args[0] === 'elems' || args[0] === 'out') args = args.slice(1)
    if (args.length < 3) continue
    const idExpr = clean(args[0])
    // Only ids written here: a literal, a format!, or a parameter of a helper (`combo(…, id, …)`,
    // whose callers pass the id); another pushed variable is some other list.
    const helperParam = /^\w+$/.test(idExpr) && bindingOf(text, m.index, idExpr)?.kind === 'param'
    if (!/^(?:"|format!)/.test(idExpr) && !helperParam) continue
    const values = valuesOf(text, m.index, idExpr, file, /^\w+$/.test(clean(args[2])) ? clean(args[2]) : null)
    for (const v of values ?? []) if (v.value.includes('.')) found.push({ id: v.value, label: v.label ?? literalOf(args[2]) ?? '' })
  }
  return found
}

/**
 * Every `auto.add(` and `reg.add(` registration upstream makes (except the credits and crash
 * screens), with the buffered ones; each site yields ids or is listed as unresolved.
 */
function parseElements() {
  const files = rustFiles(srcDir).filter((file) => !['credits.rs', 'crash.rs'].includes(path.basename(file)))
  const elements = []
  const unresolved = []
  for (const file of files) {
    const text = read(file)
    let pushes = null
    for (const m of text.matchAll(/\b(?:auto|reg)\.add\(/g)) {
      const args = splitTopLevel(balancedAt(text, m.index + m[0].length - 1))
      const labelVar = /^&?\w+$/.test((args[2] ?? '').trim()) ? clean(args[2]) : null
      const values = valuesOf(text, m.index, args[0] ?? '', file, labelVar)
      if (values) {
        for (const v of values) elements.push({ id: v.value, file, label: v.label ?? literalOf(args[2] ?? '') ?? '', command: v.command ?? null })
        continue
      }
      // A loop over a collection the file filled with `push(…)` earlier.
      const variable = clean(args[0] ?? '')
      const binding = /^\w+$/.test(variable) ? bindingOf(text, m.index, variable) : null
      if (binding?.kind === 'for' && binding.list == null) {
        if (pushes == null) {
          pushes = bufferedPushes(text, file)
          for (const p of pushes) elements.push({ id: p.id, file, label: p.label, command: null })
        }
        if (pushes.length) continue
      }
      const line = text.slice(0, m.index).split('\n').length
      unresolved.push(`${file}:${line} ${text.slice(m.index, text.indexOf('\n', m.index)).trim()}`)
    }
  }
  return { elements: elements.map((element) => ({ ...element, id: pattern(element.id) })), unresolved }
}

/** A function's body in `text`. */
const fnBody = (text, name) => balancedAfter(text, new RegExp(String.raw`fn ${name}\([^)]*\)[^{]*\{`))

/** The block of the closure opened by `opener` (`resp.context_menu(|ui| {`) that contains `marker`. */
function closureWith(text, opener, marker) {
  for (let at = text.indexOf(opener); at >= 0; at = text.indexOf(opener, at + 1)) {
    const body = balancedAt(text, at + opener.length - 1)
    if (body.includes(marker)) return body
  }
  throw new Error(`no ${opener} block contains ${marker}`)
}

/**
 * The rows of a menu or popup upstream draws without registering ids: its `for (label, cmd) in [
 * … ]` lists, and its buttons, check boxes, and submenus with a `tl!` label, in order. Each gets
 * the synthetic id `<prefix>.<label in lowerCamel>`, and the command its click runs when it
 * names one.
 */
function menuRows(block, prefix, file) {
  const rows = []
  const skip = []
  const ignored = (s) => ['project.select', 'playhead.set'].includes(s)
  for (const m of block.matchAll(/for\s+\([^\n]*?\)\s+in\s+&?\[/g)) {
    const listAt = m.index + m[0].length - 1
    const list = balancedAt(block, listAt)
    const bodyAt = block.indexOf('{', listAt + list.length + 1)
    skip.push([m.index, bodyAt])
    if (balancedAt(block, bodyAt).includes('auto.add(')) continue
    for (const parts of tuples(list)) {
      const label = parts.map((p) => literalOf(p)).find((p) => p != null && !commandLike(p) && !/^[a-z]\w*$/.test(p))
      if (!label) continue
      const command = parts.map((p) => literalOf(p)).find((p) => p && commandLike(p)) ?? null
      rows.push({ at: m.index, label, command })
    }
  }
  const control = /(?:ui\.button|ui\.menu_button|Button::new|ui\.checkbox\(\s*&mut [^,]+,|ui\.selectable_label\([^,]+,)\s*\(?\s*tl!\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g
  for (const m of block.matchAll(control)) {
    if (skip.some(([from, to]) => m.index > from && m.index < to)) continue
    const end = statementEnd(block, m.index)
    // Registered right after it is drawn (`let r = ui.add_enabled(…, Button::new(tl!(…))); app.auto.add(…)`).
    if (/^[\s);]*app\.auto\.add\(/.test(block.slice(end))) continue
    const label = unescapeRustString(m[1])
    let command = null
    const clicked = block.indexOf('.clicked()', m.index)
    if (clicked >= 0 && clicked < end) {
      const open = block.indexOf('{', clicked)
      const commands = literals(balancedAt(block, open)).filter((s) => commandLike(s) && !ignored(s))
      command = commands.at(-1) ?? null
    }
    rows.push({ at: m.index, label, command })
  }
  return rows
    .sort((a, b) => a.at - b.at)
    .map(({ label, command }) => ({ id: `${prefix}.${lowerCamel(label.replace(/[^A-Za-z0-9 ]+/g, ' '))}`, files: [file], label, command, synthetic: true }))
}

/**
 * The lists upstream draws from tables, expanded into concrete ids with the command each runs
 * (each replaces the pattern it expands), the menus and popups it draws without ids, and the
 * pointer gestures on its timeline that have no control.
 */
function expansions() {
  const monitor = read('panels/monitor.rs')
  const timeline = read('panels/timeline.rs')
  const header = read('header.rs')
  const mod = read('panels/mod.rs')
  const project = read('panels/project.rs')
  const projectViews = read('panels/project_views.rs')
  const effectControls = read('panels/effect_controls.rs')
  const out = []
  const drop = new Set()
  const add = (id, file, label, command = null, extra = {}) => out.push({ id, files: [file], label: label ?? '', command, ...extra })

  // Monitor transport buttons: the Source monitor's list, then the Program monitor's. Export Frame
  // is `file.exportFrame` (menus.rs invoke).
  const transport = fnBody(monitor, 'transport')
  const [sourceList, programList] = [...transport.matchAll(/vec!\[/g)].map((m) => balancedAt(transport, m.index + m[0].length - 1))
  for (const [prefix, list] of [
    ['source', sourceList],
    ['program', programList],
  ]) {
    for (const parts of tuples(list)) {
      const cmd = literalOf(parts[1])
      add(`${prefix}.transport.${cmd}`, 'panels/monitor.rs', literalOf(parts[2]), cmd === 'exportFrame' ? 'file.exportFrame' : cmd)
    }
    drop.add(`${prefix}.transport.{}`)
  }
  // The transport's "+" (Button Editor).
  if (!/"btn-editor"/.test(monitor)) throw new Error('monitor.rs no longer draws the Button Editor button')
  for (const prefix of ['source', 'program']) add(`${prefix}.transport.buttonEditor`, 'panels/monitor.rs', 'Button Editor', null, { synthetic: true })

  // Timeline toolbar toggles, with the command each runs.
  const toggles = balancedAfter(timeline, /let toggles: \[[^\]]*\] = \[/)
  const toggleCommands = Object.fromEntries([...timeline.matchAll(/"(\w+)"\s*=>\s*app\.session\.execute\("([\w.]+)"/g)].map((m) => [m[1], m[2]]))
  for (const parts of tuples(toggles)) {
    const key = literalOf(parts[1])
    add(`timeline.toggle.${key}`, 'panels/timeline.rs', literalOf(parts[4]), toggleCommands[key] ?? null)
  }
  drop.add('timeline.toggle.{}')
  // Timeline Display Settings (the wrench's popup).
  out.push(...menuRows(closureWith(timeline, 'egui::Popup::menu(&resp).show(|ui| {', 'Show Video Thumbnails'), 'timeline.settings', 'panels/timeline.rs'))

  // The clip context menu, and its Multi-Camera submenu's own rows.
  const clipMenu = balancedAfter(timeline, /pub\(crate\) const CLIP_MENU: &\[&\[\(&str, &str\)\]\] = &\[/)
  for (const m of clipMenu.matchAll(/\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) add(`timeline.clipMenu.${unescapeRustString(m[2])}`, 'panels/timeline.rs', unescapeRustString(m[1]), unescapeRustString(m[2]))
  const multicam = fnBody(timeline, 'multicam_menu')
  const multicamList = /for \(label, cmd\) in \[/.exec(multicam)
  for (const parts of tuples(balancedAt(multicam, multicamList.index + multicamList[0].length - 1))) {
    const cmd = literalOf(parts[1])
    add(`timeline.clipMenu.${cmd}`, 'panels/timeline.rs', literals(parts[0]).find((l) => !l.startsWith('✓')) ?? '', cmd)
  }
  drop.add('timeline.clipMenu.{}')

  // Gestures without a control: a track's height edge, and the video/audio divider.
  if (!/"trackh"/.test(timeline) || !/"tl-divider"/.test(timeline)) throw new Error('timeline.rs no longer has the track height edge or the divider')
  add('timeline.track.{}.heightEdge', 'panels/timeline.rs', 'Drag to resize the track', null, { synthetic: true, gesture: true })
  add('timeline.divider', 'panels/timeline.rs', 'Drag to share the height between video and audio tracks', null, { synthetic: true, gesture: true })

  // Header: the mode tabs, the right-hand buttons, and the workspaces popup.
  const modes = /for \(m, label, shown\) in \[/.exec(header)
  for (const parts of tuples(balancedAt(header, modes.index + modes[0].length - 1))) {
    const label = literalOf(parts[1])
    add(`header.mode.${label.toLowerCase()}`, 'header.rs', label, `mode.${label.toLowerCase()}`)
  }
  const headerCommands = { quickExport: 'file.exportMedia' }
  for (const m of header.matchAll(/btn\(ui,\s*Icon::\w+,\s*"(\w+)",\s*tl!\("((?:[^"\\]|\\.)*)"\)/g)) add(`header.${m[1]}`, 'header.rs', unescapeRustString(m[2]), headerCommands[m[1]] ?? null)
  drop.add('header.mode.{}')
  drop.add('header.{}')
  out.push(...menuRows(closureWith(header, 'egui::Frame::popup(ui.style()).show(ui, |ui| {', 'Reset to Saved Layout'), 'header.workspacesMenu', 'header.rs').map((row) => ({ ...row, command: row.label === 'Reset to Saved Layout' ? 'window.workspace.reset' : row.command })))

  // The panel menu's rows that upstream does not register by id (the Timeline rows it does are
  // literal ids already, with their commands here).
  const panelMenu = fnBody(mod, 'panel_menu_popup')
  for (const row of menuRows(panelMenu, 'panel.menu', 'panels/mod.rs')) {
    const inTimeline = panelMenu.indexOf(`tl!("${row.label}")`) > panelMenu.indexOf('if p == PanelKind::Timeline {')
    out.push({ ...row, id: inTimeline ? row.id.replace('panel.menu.', 'panel.menu.Timeline.') : row.id })
  }
  for (const m of panelMenu.matchAll(/auto\.add\("(panel\.menu\.[\w.]+)"[\s\S]*?execute\("([\w.]+)"/g)) add(m[1], 'panels/mod.rs', '', m[2])

  // Project panel ▸ New Item.
  const newItems = balancedAfter(project, /pub const NEW_ITEMS: \[\(&str, &str\); \d+\] = \[/)
  for (const m of newItems.matchAll(/\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) add(`project.newItem.${unescapeRustString(m[2])}`, 'panels/project.rs', unescapeRustString(m[1]), unescapeRustString(m[2]))
  drop.add('project.newItem.{}')
  // The Project panel's context menus: an item's, the background's, a bin's, and a card's.
  out.push(...menuRows(fnBody(projectViews, 'item_menu'), 'project.itemMenu', 'panels/project_views.rs'))
  out.push(...menuRows(fnBody(projectViews, 'background_menu'), 'project.backgroundMenu', 'panels/project_views.rs'))
  out.push(...menuRows(fnBody(projectViews, 'bin_menu'), 'project.binMenu', 'panels/project_views.rs'))
  out.push(...menuRows(closureWith(projectViews, 'ui.menu_button(tl!("Clip Size"), |ui| {', 'Larger'), 'project.cardMenu.clipSize', 'panels/project_views.rs'))

  // Effect Controls: a keyframe's menu (the interpolations and Clear), and an effect's Clear.
  out.push(...menuRows(closureWith(effectControls, 'resp.context_menu(|ui| {', 'Temporal Interpolation'), 'effectControls.keyframeMenu', 'panels/effect_controls.rs').map((row) => ({ ...row, command: row.command ?? null })))
  out.push(...menuRows(closureWith(effectControls, 'resp.context_menu(|ui| {', 'Save Preset…'), 'effectControls.effect.{}', 'panels/effect_controls.rs'))

  // A monitor's wrench menu (monitor_view.rs wrench_items): `pick` collects the rows' keys, and
  // the loop after registers each as `<source|program>.settings.<key>` and runs `view.<key>`. The
  // keys alone (read from `pick`'s pushes) are not ids: they become the rows they are. Display
  // modes: Composite and the RGBA channels on both monitors, Multi-Camera and Comparison View on
  // Program, the two waveform modes on Source; the resolutions stay one pattern per submenu.
  const monitorView = read('panels/monitor_view.rs')
  const wrench = fnBody(monitorView, 'wrench_items')
  const programOnly = wrench.slice(wrench.indexOf('if w == Which::Program {'), wrench.indexOf('} else {'))
  const sourceOnly = wrench.slice(wrench.indexOf('} else {'), wrench.indexOf('ui.separator();'))
  const common = wrench.slice(0, wrench.indexOf('if w == Which::Program {'))
  const picks = (block) => [...block.matchAll(/pick\(ui, &mut out, "(display\.\w+)", tl!\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => [m[1], unescapeRustString(m[2])])
  const channels = [...balancedAfter(common, /for \(k, l, m\) in \[/).matchAll(/\("(\w+)", tl!\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => [`display.${m[1]}`, unescapeRustString(m[2])])
  const rows = { source: [...picks(common), ...channels, ...picks(sourceOnly)], program: [...picks(common), ...channels, ...picks(programOnly)] }
  if (rows.source.length !== 7 || rows.program.length !== 7) throw new Error(`monitor_view.rs wrench_items: expected 7 display rows per monitor, read ${rows.source.length} and ${rows.program.length}`)
  for (const [prefix, list] of Object.entries(rows)) {
    for (const [key, label] of list) add(`${prefix}.settings.${key}`, 'panels/monitor_view.rs', label, `view.${key}`)
    for (const res of ['playbackRes', 'pausedRes']) add(`${prefix}.settings.${res}.{}`, 'panels/monitor_view.rs', '', `view.${res}.{}`)
  }
  for (const [key] of [...rows.source, ...rows.program]) drop.add(key)
  drop.add('playbackRes.{}')
  drop.add('pausedRes.{}')

  // Commands the guides and workspace dialogs run.
  const dialogCommands = [
    ['guides.add.', 'view.addGuide'],
    ['guides.save.', 'view.guideTemplates.save'],
    ['guides.manage.', 'view.guideTemplates.manage'],
    ['workspaces.save.', 'window.workspace.saveAs'],
    ['workspaces.edit.', 'window.workspace.edit'],
  ]
  return { out, drop, dialogCommands }
}

/** The keyframe menu's rows run `effects.setInterpolation` (with the row's key) and `effects.deleteKeyframe`. */
function keyframeMenuCommand(row) {
  return row.label === 'Clear' ? 'effects.deleteKeyframe' : 'effects.setInterpolation'
}

// ---------------------------------------------------------------------------------- keys

/**
 * Upstream's key router runs every binding of the engine's shortcut set (`menus.rs` `bindings`),
 * not only the `uic!` rows: the shortcut-only UI commands, then every `shortcuts.list` command
 * with a binding and no menu row, with its bindings and their panel scope.
 */
function buildKeys(uiCommands, shortcuts, menus) {
  const keys = uiCommands.filter((c) => !c.menu.length).map((c) => ({ command: c.id, label: c.label, shortcut: c.shortcut, bindings: c.shortcut ? [{ keys: c.shortcut, panel: null }] : [], origin: 'ui' }))
  const taken = new Set([...menus.map((row) => row.command), ...keys.map((key) => key.command)])
  for (const entry of shortcuts.values()) {
    if (!entry.shortcuts.length || taken.has(entry.id)) continue
    const bindings = entry.shortcuts.map((s) => ({ keys: s.keys, panel: s.panel ?? null }))
    keys.push({ command: entry.id, label: entry.label, shortcut: bindings[0].keys, bindings, origin: 'engine' })
  }
  return keys
}

// ---------------------------------------------------------------------------------- brand

/**
 * Other companies' product names are not Kition's feature names: panels named after them are
 * reworded to generic names, and the item says so (`reworded`, with the original id when the id
 * changes) (`TRADEMARK_LABELS`, `TRADEMARK_IDS`; panels and workspace tabs through `rewordedPanel`).
 */
const TRADEMARK_LABELS = [['Lumetri Color', 'Color'], ['Lumetri Scopes', 'Scopes'], ['Lumetri Presets', 'Color Presets'], ['Essential Graphics', 'Graphics Templates'], ['Essential Sound', 'Audio Mixing'], ['Lumetri', 'Color']]
const TRADEMARK_IDS = [['LumetriColor', 'Color'], ['LumetriScopes', 'Scopes'], ['EssentialGraphics', 'GraphicsTemplates'], ['EssentialSound', 'AudioMixing'], ['lumetriColor', 'color'], ['lumetriScopes', 'scopes'], ['essentialGraphics', 'graphicsTemplates'], ['essentialSound', 'audioMixing'], ['lumetriPreset', 'colorPreset'], ['lumetri.', 'color.']]
const replaceAllOf = (pairs) => (s) => pairs.reduce((text, [from, to]) => text.replaceAll(from, to), s)
const rewordLabel = replaceAllOf(TRADEMARK_LABELS)
const rewordId = replaceAllOf(TRADEMARK_IDS)
/** A panel (and so its id) under its reworded kind and title. */
const rewordedPanel = (panel) => ({ ...panel, id: lowerCamel(rewordId(panel.kind)), kind: rewordId(panel.kind), title: rewordLabel(panel.title) })
function reworded(item, labelField, idField) {
  const label = item[labelField]
  const id = idField ? item[idField] : null
  const next = { ...item }
  let changed = false
  if (typeof label === 'string' && rewordLabel(label) !== label) {
    next[labelField] = rewordLabel(label)
    changed = true
  }
  if (typeof id === 'string' && rewordId(id) !== id) {
    next[idField] = rewordId(id)
    next.idReworded = true
    changed = true
  }
  if (changed) next.reworded = true
  return next
}

// ---------------------------------------------------------------------------------- build

/**
 * Rows `menus.rs` `invoke` or a route answers with a dialog: invoke's own, `clip_dialogs` `meta`,
 * `menu_dialogs` `dialog_command`, `media_dialogs`, and `graphics_templates`. File pickers are
 * not dialogs here (they are hidden on the web), and Save as New Workspace… and Edit
 * Workspaces… are left out: Task 12 builds them in wave 1.
 */
function parseDialogs() {
  return [
    ...new Set([
      ...['file.exportFrame', 'file.exportAaf', 'file.exportOmf', 'clip.audioGain', 'clip.interpretFootage', 'clip.remix.properties', 'sequence.addTracks', 'sequence.deleteTracks', 'sequence.settings', 'file.newSequence', 'sequence.colorSettings', 'file.revert', 'file.recover', 'help.shortcuts', 'app.keyboardShortcuts', 'app.about'],
      ...[...fnBody(read('panels/clip_dialogs.rs'), 'meta').matchAll(/"([\w.]+)"\s*=>/g)].map((m) => m[1]),
      ...[...fnBody(read('panels/menu_dialogs.rs'), 'dialog_command').matchAll(/"([\w.]+)"\s*(?=\||=>)/g)].map((m) => m[1]),
      ...['media.linkMedia', 'media.makeOffline', 'media.createProxies', 'file.projectManager'],
      ...['graphics.template.export', 'file.exportGraphicsTemplate', 'file.replaceFonts'],
    ]),
  ].sort()
}

const { commands, shortcuts } = await engine()
const uiTable = parseUic(menusText, 'UI_COMMANDS')
const keyboardTable = parseUic(keyboardText, 'COMMANDS')
const uiCommands = [...uiTable, ...keyboardTable]
const upstreamPanels = parsePanels()
const menus = buildMenus(commands, shortcuts, uiCommands, upstreamPanels).map((row) => reworded(row, 'label', 'command'))
const panels = upstreamPanels.map(rewordedPanel)
const keys = buildKeys(uiCommands, shortcuts, menus).map((key) => reworded(key, 'label', 'command'))
const { tools, groupCount } = parseTools()
const workspaces = parseWorkspaces()
const hints = parseHints().map((hint) => reworded(hint, 'text'))
const { elements: rawElements, unresolved } = parseElements()
const { out: expanded, drop, dialogCommands } = expansions()

// One entry per id: every file that registers it (the lowest wave wins), its first label and command.
const byId = new Map()
for (const element of [...rawElements.filter((e) => !drop.has(e.id)).map(({ file, ...rest }) => ({ ...rest, files: [file] })), ...expanded]) {
  const known = byId.get(element.id)
  if (!known) {
    byId.set(element.id, { ...element, files: [...element.files] })
    continue
  }
  for (const file of element.files) if (!known.files.includes(file)) known.files.push(file)
  known.label ||= element.label
  known.command ??= element.command
  if (element.synthetic === false) known.synthetic = false
}
const elements = [...byId.values()].map((element) => {
  const command = element.command ?? dialogCommands.find(([prefix]) => element.id.startsWith(prefix))?.[1] ?? (element.id.startsWith('effectControls.keyframeMenu.') ? keyframeMenuCommand(element) : null)
  const files = [...element.files].sort((a, b) => fileWave(a) - fileWave(b) || a.localeCompare(b))
  const { id, label, synthetic, gesture } = element
  return reworded({ id, files, label: label ?? '', ...(command ? { command } : {}), ...(synthetic ? { synthetic } : {}), ...(gesture ? { gesture } : {}) }, 'label', 'id')
})

const manifest = {
  source: { repository: 'KitionAI/kition-film-archive', tag: 'v0.5.0', path: 'crates/ui-egui' },
  menus,
  keys,
  tools,
  panels,
  workspaces,
  elements,
  hints,
  dialogs: parseDialogs(),
  unresolved,
}

const outPath = fileURLToPath(new URL('./film-upstream.json', import.meta.url))
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)

const count = (list, field) => JSON.stringify(list.reduce((counts, item) => ({ ...counts, [item[field]]: (counts[item[field]] ?? 0) + 1 }), {}))
console.log(`menus: ${menus.length} rows (${count(menus, 'origin')}; ${restoredEllipses} trailing "…" restored from the engine's source for commands shortcuts.list lacks)`)
console.log(`keys: ${keys.length} (${count(keys, 'origin')})`)
console.log(`tools: ${tools.length} in ${groupCount} groups`)
console.log(`panels: ${panels.length}`)
console.log(`workspaces: ${workspaces.length}`)
console.log(`elements: ${rawElements.length} registrations, ${elements.length} ids (${expanded.length} from tables, menus, and gestures; ${elements.filter((e) => e.synthetic).length} synthetic; ${elements.filter((e) => e.files.length > 1).length} registered in several files)`)
console.log(`hints: ${hints.length}`)
console.log(`reworded: ${[...menus, ...keys, ...elements, ...hints].filter((item) => item.reworded).length}`)
console.log(`unresolved registrations (no id found): ${unresolved.length}${unresolved.map((site) => `\n  ${site}`).join('')}`)
console.log(`wrote ${outPath}`)

// ---------------------------------------------------------------------------------- status

/**
 * Rule 2: rows hidden on the web from the start, with why. Help's links and the community chat go
 * to upstream's former websites, About describes upstream's app (Kition's own About replaces it),
 * and quitting belongs to the host.
 */
const FORMER_SITE = "Links to upstream's former website."
const HIDDEN = {
  'help.discord': "Links to upstream's former community chat.",
  'help.website': FORMER_SITE,
  'help.appPage': FORMER_SITE,
  'help.github': "Links to upstream's former source repository.",
  'help.reportIssue': "Links to upstream's former issue tracker.",
  'help.kitionFilmHelp': "Opens online help the kit does not have.",
  'app.about': "Describes upstream's app; Kition's About (kit:help.about) replaces it.",
  'app.quit': 'The host owns the window and quitting.',
  'header.discord': "Links to upstream's former community chat.",
}

const statusPath = fileURLToPath(new URL('./film-status.json', import.meta.url))
const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : {}
const items = ruleWaves(manifest)
const badPanels = panels.filter((panel) => !panelWave(panel.id)).map((panel) => panel.id)
if (badPanels.length) throw new Error(`panels without a wave in the plan: ${badPanels.join(', ')}`)
const rewordedKeys = new Map()
for (const row of menus) if (row.reworded) rewordedKeys.set(`menu:${row.path.join('/')}/${row.command}`, row)
for (const key of keys) if (key.reworded) rewordedKeys.set(`key:${key.command}`, key)
for (const element of elements) if (element.reworded) rewordedKeys.set(`element:${element.id}`, element)
for (const hint of hints) if (hint.reworded) rewordedKeys.set(`hint:${hint.tool}`, hint)
const hiddenReason = (key) => HIDDEN[key.slice(key.lastIndexOf(key.startsWith('menu:') ? '/' : ':') + 1)]

const added = []
const removed = []
const next = {}
for (const [key, wave] of items) {
  if (status[key]) {
    next[key] = status[key]
    continue
  }
  const entry = { status: 'todo', wave }
  const reason = hiddenReason(key)
  if (reason) Object.assign(entry, { status: 'hidden', reason })
  const item = rewordedKeys.get(key)
  if (item) entry.note = item.idReworded ? 'upstream label and id reworded' : 'upstream label reworded'
  next[key] = entry
  added.push(key)
}
for (const key of Object.keys(status)) if (!items.has(key)) removed.push(key)
writeFileSync(statusPath, `${JSON.stringify(next, null, 2)}\n`)
console.log(`status: ${items.size} items (${added.length} added, ${removed.length} removed)`)
for (const key of removed) console.log(`  removed: ${key}`)
