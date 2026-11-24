// The labels Film draws through phrase() (upstream's English labels), read from the source, the
// parity manifest, the dialog registry, and the Kit UI declaration, for the completeness check in
// check.test.mjs (Task 23b, maintainer decision 11): every one has a zh-CN entry. Node, no
// dependencies beyond the editor's own modules.
//
// The rule ("what Film draws"):
// - every string literal in the argument of a `phrase(…)` call in web/src;
// - the menu rows the web menu bar draws (every manifest row not hidden on the web) and their menu
//   names, every panel title (tabs and Window rows), every tool's label and status-bar hint, and
//   every workspace name;
// - the labels of the manifest's `done` elements and keys (Film draws them; `todo` ones it does not);
// - every dialog of the registry: its title, OK and Cancel labels, status line, and each field's
//   label, hint, unit, empty text, options, and tabs;
// - the Kit UI declaration's labels (FILM_UI), which kit-editor's catalog shows a host;
// - with the web engine built, every engine command's title and menu names, which kit-editor's catalog
//   draws through phrase().
// Labels read at run time (engine data: effect and parameter names, shortcut categories) are
// checked by the flow test, which fails on any label drawn on its zh-CN page without an entry.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { needsPhrase } from '../src/i18n/phrases.ts'
import { parsePhrases } from '@kition/sdk/editor'

/** Whether a label has words to translate (not a symbol, a number, or an id): the editor's own rule. */
export const hasWords = (text) => typeof text === 'string' && needsPhrase(text)

const unescape = (text) => text.replace(/\\(.)/g, (_, next) => (next === 'n' ? '\n' : next === 't' ? '\t' : next))

/** A catalog's English → translation entries (`es.tsv`'s format, as kit-editor's `parsePhrases` reads it), and the sources listed twice. */
export function readCatalog(path) {
  const text = readFileSync(path, 'utf8')
  // The table as the editor reads it (kit-editor's parser); the sources listed twice, read here.
  const table = parsePhrases(text)
  const seen = new Set()
  const twice = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [, source, translation] = line.split('\t')
    if (!source || !translation) continue
    if (seen.has(unescape(source))) twice.push(unescape(source))
    seen.add(unescape(source))
  }
  return { table, twice }
}

const STRING = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^`\\])*)`/g

/** The source files of the editor (not its tests). */
export function sources(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (/\.tsx?$/.test(name) && !name.includes('.test.')) out.push(path)
  }
  return out
}

/** The text of a call's argument list from `start` (just after its `(`), quotes and nesting respected. */
function callArgument(text, start) {
  let depth = 1
  let at = start
  while (at < text.length && depth > 0) {
    const char = text[at]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === "'" || char === '"' || char === '`') {
      at += 1
      while (at < text.length && text[at] !== char) at += text[at] === '\\' ? 2 : 1
    }
    at += 1
  }
  return text.slice(start, at - 1)
}

/** Every string literal in a `phrase(…)` argument in `files` (template literals without `${}`), by file. */
export function phraseLiterals(files) {
  const found = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (let at = text.indexOf('phrase('); at >= 0; at = text.indexOf('phrase(', at + 7)) {
      // `phrase(` itself, or a member's (`editor.phrase(`), not `usePhrase(` or a declaration.
      if (/[A-Za-z0-9_$]/.test(text[at - 1] ?? '')) continue
      if (/function\s+$/.test(text.slice(Math.max(0, at - 12), at))) continue
      const argument = callArgument(text, at + 'phrase('.length)
      for (const match of argument.matchAll(STRING)) {
        if (match[3] != null && match[3].includes('${')) continue
        // A value compared or indexed (`edge === 'in' ? …`, `View['mode']`), not a label.
        if (/(===|!==|==|!=|\[)\s*$/.test(argument.slice(0, match.index))) continue
        const literal = (match[2] ?? match[3]).replace(/\\(.)/g, '$1')
        if (hasWords(literal) && !found.has(literal)) found.set(literal, file)
      }
    }
  }
  return found
}

/** `text` without its comments; `//` and `/*` inside a string or template literal stay. */
export function withoutComments(text) {
  let out = ''
  for (let at = 0; at < text.length; ) {
    const char = text[at]
    // A string or template literal is kept whole: a `//` or `/*` inside it is text.
    if (char === "'" || char === '"' || char === '`') {
      let end = at + 1
      while (end < text.length && text[end] !== char && !(char !== '`' && text[end] === '\n')) end += text[end] === '\\' ? 2 : 1
      out += text.slice(at, end + 1)
      at = end + 1
    } else if (char === '/' && text[at + 1] === '/') {
      const end = text.indexOf('\n', at)
      at = end < 0 ? text.length : end
    } else if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2)
      at = end < 0 ? text.length : end + 2
    } else {
      out += char
      at += 1
    }
  }
  return out
}

/** Every string literal in `files` outside comments (template literals without `${}`), by text, with the first place it is. */
export function sourceLiterals(files) {
  const found = new Map()
  for (const file of files) {
    const text = withoutComments(readFileSync(file, 'utf8'))
    for (const match of text.matchAll(STRING)) {
      if (match[3] != null && match[3].includes('${')) continue
      // A value compared or indexed (`item.type !== 'Still'`), not a label.
      if (/(===|!==|==|!=|\[)\s*$/.test(text.slice(Math.max(0, match.index - 8), match.index))) continue
      const literal = (match[2] ?? match[3]).replace(/\\(.)/g, '$1')
      if (hasWords(literal) && !found.has(literal)) found.set(literal, file)
    }
  }
  return found
}

/** Every string literal in a `status(…)` argument (the status bar draws its text through phrase()). */
export function statusLiterals(files) {
  const found = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (let at = text.indexOf('status('); at >= 0; at = text.indexOf('status(', at + 7)) {
      if (/[A-Za-z0-9_$]/.test(text[at - 1] ?? '')) continue
      const argument = callArgument(text, at + 'status('.length)
      for (const match of argument.matchAll(STRING)) {
        if (match[3] != null && match[3].includes('${')) continue
        // A key of the editor's own strings (`status(t('exported', …))`): t() draws it.
        if (/\bt\(\s*$/.test(argument.slice(0, match.index))) continue
        const literal = (match[2] ?? match[3]).replace(/\\(.)/g, '$1')
        if (hasWords(literal) && !found.has(literal)) found.set(literal, file)
      }
    }
  }
  return found
}

/** A dialog's field rows, flattened through rows, sections, and tabs. */
function* rowsOf(rows) {
  for (const row of rows ?? []) {
    yield row
    if (row.rows) yield* rowsOf(row.rows)
    if (row.lead) yield* rowsOf(row.lead)
    for (const tab of row.tabs ?? []) yield* rowsOf(tab.rows)
  }
}

/** The labels the registry's dialogs draw through phrase(). */
export function dialogLabels(specs) {
  const labels = []
  for (const spec of specs) {
    labels.push(spec.title, spec.okLabel, spec.cancelLabel, typeof spec.okStatus === 'string' ? spec.okStatus : null)
    for (const control of spec.controls ?? []) labels.push(control.label)
    for (const row of rowsOf(spec.layout)) {
      labels.push(row.label, row.hint, row.unit, row.empty, ...(row.disabledOptions ?? []))
      if (Array.isArray(row.options)) labels.push(...row.options.map(([, label]) => label))
      for (const tab of row.tabs ?? []) labels.push(tab.label)
    }
  }
  return labels.filter(hasWords)
}

/**
 * Every label Film draws through phrase() that the rule above can read without a browser, with
 * where it comes from. `engineCommands` (the built engine's `commands()`) is optional.
 */
export async function drawnLabels({ engineCommands = null } = {}) {
  const web = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(new URL('./film-upstream.json', import.meta.url), 'utf8'))
  const status = JSON.parse(readFileSync(new URL('./film-status.json', import.meta.url), 'utf8'))
  const { isHiddenOnWeb } = await import(new URL('../src/menus/hidden.ts', import.meta.url).href)
  const { DIALOGS } = await import(new URL('../src/dialogs/registry.ts', import.meta.url).href)
  const { FILM_UI } = await import(new URL('../src/filmUi.ts', import.meta.url).href)
  const done = (key) => status[key]?.status === 'done'
  const labels = new Map()
  const add = (text, origin) => {
    if (hasWords(text) && !labels.has(text)) labels.set(text, origin)
  }
  for (const [literal, file] of phraseLiterals(sources(`${web}src`))) add(literal, `phrase() in ${file.slice(web.length)}`)
  for (const [literal, file] of statusLiterals(sources(`${web}src`))) add(literal, `status() in ${file.slice(web.length)}`)
  // A literal that is one of upstream's catalogued labels is a label, wherever it is written: tables
  // and constants drawn as phrase(TABLE[key].tip) or passed on to status() (upstream's catalogs list
  // every label its UI draws; Film draws the ones it ports through phrase()).
  const upstreamKeys = new Set()
  for (const name of readdirSync(`${web}src/i18n/upstream`)) if (name.endsWith('.tsv') && name !== 'zh-hans.tsv') for (const key of readCatalog(`${web}src/i18n/upstream/${name}`).table.keys()) upstreamKeys.add(key)
  // Not labels: the editor's own strings (t() draws them), key names (`Home`), and lower-case values (`'in'`, `'seconds'`).
  const notLabelFiles = ['src/strings.ts', 'src/session/keys.ts']
  for (const [literal, file] of sourceLiterals(sources(`${web}src`).filter((each) => !notLabelFiles.some((name) => each.endsWith(name))))) {
    if (upstreamKeys.has(literal) && /^[A-Z{]/.test(literal)) add(literal, `upstream label in ${file.slice(web.length)}`)
  }
  // The named tables drawn through phrase() by a variable: their labels, catalogued upstream or not.
  const tables = tableLabels(`${web}src`)
  if (tables.lost.length) throw new Error(`label tables not found (update LABEL_TABLES): ${tables.lost.join(', ')}`)
  for (const label of tables.labels) add(label, 'label table')
  for (const row of manifest.menus) {
    if (isHiddenOnWeb(row)) continue
    add(row.label, 'menu row')
    for (const name of row.path) add(name, 'menu name')
  }
  for (const panel of manifest.panels) add(panel.title, 'panel title')
  for (const tool of manifest.tools) add(tool.label, 'tool')
  // The manifest keeps the macOS wording; elsewhere upstream draws its Alt and Ctrl strings (`toolHint`).
  const { toolHint } = await import(new URL('../src/tools/hints.ts', import.meta.url).href)
  for (const hint of manifest.hints) for (const mac of [true, false]) add(toolHint(hint.tool, mac), 'tool hint')
  for (const workspace of manifest.workspaces) add(workspace.name, 'workspace')
  for (const element of manifest.elements) if (done(`element:${element.id}`)) add(element.label, 'done element')
  for (const key of manifest.keys) if (done(`key:${key.command}`)) add(key.label, 'done key')
  for (const label of dialogLabels(DIALOGS.specs)) add(label, 'dialog')
  // A declared label that is a key of the editor's strings (`exportMovie`) is read through t().
  const { CATALOGS } = await import(new URL('../src/strings.ts', import.meta.url).href)
  for (const group of Object.values(FILM_UI)) for (const item of group ?? []) if (!(item.label in CATALOGS['en-US'])) add(item.label, 'Kit UI declaration')
  for (const command of engineCommands ?? []) {
    add(command.title, 'engine command')
    for (const name of command.menu ?? []) add(name, 'engine menu')
  }
  return labels
}

/**
 * The constant tables and consts Film draws through phrase() by a variable argument
 * (`phrase(RENDER[state].tip)`, `phrase(DISPLAY_LABELS[mode])`, `onError: status` with the audio
 * messages), by file and name. `fields` names the properties that are labels; without it, every
 * literal of the declaration that starts with a capital is one. A table moved or renamed fails here.
 *
 * A new table or const of labels drawn through a variable (`phrase(TABLE[key])`, a message passed
 * on to `status`) must be registered here, unless its labels are already keys of an upstream
 * catalog (es, ja, pt-br), which the check reads wherever they are written.
 */
export const LABEL_TABLES = [
  { file: 'timeline/Ruler.tsx', name: 'RENDER', fields: ['tip'] },
  { file: 'monitors/displayModes.ts', name: 'DISPLAY_LABELS' },
  { file: 'monitors/monitorView.ts', name: 'RESOLUTIONS', fields: ['label'] },
  { file: 'monitors/model.ts', name: 'SOURCE_TRANSPORT', fields: ['label'] },
  { file: 'monitors/model.ts', name: 'PROGRAM_TRANSPORT', fields: ['label'] },
  { file: 'monitors/CompareView.tsx', name: 'BUTTONS', fields: ['text', 'tip'] },
  { file: 'audio.ts', name: 'AUDIO_FAILED' },
  { file: 'audio.ts', name: 'AUDIO_STALLED' },
  { file: 'audio.ts', name: 'SOURCE_AUDIO_STALLED' },
  { file: 'dialogs/menu.ts', name: 'MARKER_COLORS' },
  { file: 'dialogs/project.ts', name: 'VIEW_LABELS' },
  { file: 'panels/projectModel.ts', name: 'FONT_SIZES' },
  { file: 'session/errors.ts', name: 'ENGINE_REASONS', fields: ['reason'] },
]

/** The text of the declaration `const <name> =` in `text`: up to the end of its value (balanced brackets, or its line). */
function declaration(text, name, bracketed) {
  const match = new RegExp(`\\bconst ${name}\\b[^=]*=\\s*`).exec(text)
  if (!match) return null
  const start = match.index + match[0].length
  if (!'[{'.includes(text[start])) {
    // A fields table is an object or an array: anything else is not the table this names.
    if (bracketed) return null
    return text.slice(start, text.indexOf('\n', start))
  }
  let depth = 0
  for (let at = start; at < text.length; at += 1) {
    const char = text[at]
    if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
    else if (char === "'" || char === '"' || char === '`') {
      at += 1
      while (at < text.length && text[at] !== char) at += text[at] === '\\' ? 2 : 1
    }
    if (depth === 0) return text.slice(start, at + 1)
  }
  return null
}

/** The labels of `LABEL_TABLES`, with the tables it cannot find. */
export function tableLabels(srcDir) {
  const labels = []
  const lost = []
  for (const table of LABEL_TABLES) {
    const body = declaration(readFileSync(`${srcDir}/${table.file}`, 'utf8'), table.name, Boolean(table.fields))
    if (body == null) {
      lost.push(`${table.file} ${table.name}`)
      continue
    }
    const pattern = table.fields ? new RegExp(`\\b(?:${table.fields.join('|')})\\s*:\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`, 'g') : STRING
    for (const match of body.matchAll(pattern)) {
      const literal = (table.fields ? match[2] : (match[2] ?? match[3])).replace(/\\(.)/g, '$1')
      if (hasWords(literal) && (table.fields || /^[A-Z]/.test(literal))) labels.push(literal)
    }
  }
  return { labels, lost }
}

/** The `{name}` placeholders of a label, sorted. */
export const placeholders = (text) => [...text.matchAll(/\{(\w*)\}/g)].map((match) => match[0]).sort()
