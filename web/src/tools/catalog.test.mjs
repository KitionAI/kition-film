// Film's 17 tools, as upstream's `state.rs` `Tool` (`ALL`, `groups`, `shortcut`) and
// `panels/tools.rs`, its status-bar hints (`lib.rs` `hint_text`), and the Kit UI ids Film
// declares for them. Node loads the TypeScript modules directly.
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { FILM_TOOLS, VIEW, groupsThatFit, toolGroups } from './catalog.ts'
import { toolHint } from './hints.ts'
import { toolFromName } from '../session/invoke.ts'
import { keyTable, resolveKey } from '../session/keys.ts'
import { FILM_UI, KITION_ONLY, SHARED_ALIASES } from '../filmUi.ts'

const upstream = JSON.parse(readFileSync(new URL('../../parity/film-upstream.json', import.meta.url), 'utf8'))

test("the tools are the manifest's 17, in its order, groups, slots, and keys", () => {
  assert.equal(FILM_TOOLS.length, 17)
  assert.deepEqual(
    FILM_TOOLS.map(({ id, label, group, slot, shortcut }) => ({ id, label, shortcut, group, slot })),
    upstream.tools.map(({ id, label, group, slot, shortcut }) => ({ id, label, shortcut, group, slot })),
  )
})

test("upstream's 8 groups (`Tool::groups`), each in slot order", () => {
  assert.deepEqual(
    toolGroups().map((group) => group.map((tool) => tool.id)),
    [['Selection'], ['TrackSelectForward', 'TrackSelectBackward'], ['Ripple', 'Rolling', 'RateStretch', 'Remix'], ['Razor'], ['Slip', 'Slide'], ['Pen', 'Rectangle', 'Ellipse'], ['Hand', 'Zoom'], ['Type', 'VerticalType']],
  )
})

test('every tool has an icon and names what it drives', () => {
  for (const tool of FILM_TOOLS) {
    assert.ok(tool.icon, `${tool.id} has no icon`)
    assert.ok(tool.commands.length > 0, `${tool.id} drives nothing`)
  }
  assert.deepEqual(FILM_TOOLS.find((tool) => tool.id === 'Hand').commands, [VIEW])
  assert.deepEqual(FILM_TOOLS.find((tool) => tool.id === 'Razor').commands, ['timeline.razor'])
})

const engineDir = new URL('../../public/engine/', import.meta.url)
const built = existsSync(new URL('kition_film_kit_bg.wasm', engineDir))

test("every tool's command is an engine command, or the view", { skip: built ? false : 'the web engine is not built' }, async () => {
  const sdk = await import(new URL('kition_film_kit.js', engineDir).href)
  sdk.initSync({ module: readFileSync(new URL('kition_film_kit_bg.wasm', engineDir)) })
  const engine = new Set(JSON.parse(sdk.FilmDocument.create('Untitled', 1920, 1080).commands()).map((command) => command.id))
  const wrong = FILM_TOOLS.flatMap((tool) => tool.commands.filter((command) => command !== VIEW && !engine.has(command)).map((command) => `${tool.id}: ${command}`))
  assert.deepEqual(wrong, [])
})

test('`Tool::from_name` finds every tool by its id and by its label', () => {
  for (const tool of FILM_TOOLS) {
    assert.equal(toolFromName(tool.id), tool.id)
    assert.equal(toolFromName(tool.label), tool.id)
  }
})

test("each letter chooses its one tool, with no cycling; Shift+A is Track Select Backward", () => {
  const table = keyTable([], upstream, true)
  const press = (key, shift = false) => resolveKey({ key, code: `Key${key.toUpperCase()}`, metaKey: false, ctrlKey: false, shiftKey: shift, altKey: false }, 'timeline', table)
  for (const tool of FILM_TOOLS.filter((item) => item.shortcut)) {
    const [shift, key] = tool.shortcut.startsWith('Shift+') ? [true, tool.shortcut.slice(6)] : [false, tool.shortcut]
    const command = press(shift ? key : key.toLowerCase(), shift)
    assert.ok(command?.startsWith('tool.'), `${tool.shortcut} runs ${command}`)
    assert.equal(toolFromName(command.slice(5)), tool.id, `${tool.shortcut}`)
    // Pressed again, the same letter keeps the same tool.
    assert.equal(press(shift ? key : key.toLowerCase(), shift), command)
  }
  assert.equal(press('A', true), 'tool.trackSelectBackward')
  assert.equal(press('a'), 'tool.trackSelectForward')
})

test("`hint_text`: the manifest's hint, with Alt and Ctrl off macOS; none for the drawing tools", () => {
  assert.equal(toolHint('Selection', true), 'Click to select, or click in empty space and drag to marquee select. Use Shift, Opt, and Cmd for other options.')
  assert.equal(toolHint('Selection', false), 'Click to select, or click in empty space and drag to marquee select. Use Shift, Alt, and Ctrl for other options.')
  assert.equal(toolHint('Zoom', true), 'Click to zoom in; Opt-click to zoom out.')
  assert.equal(toolHint('Zoom', false), 'Click to zoom in; Alt-click to zoom out.')
  assert.equal(toolHint('Razor', false), 'Click to split a clip. Shift-click to split all tracks.')
  for (const tool of ['Pen', 'Rectangle', 'Ellipse', 'Type', 'VerticalType']) assert.equal(toolHint(tool, true), '')
  for (const hint of upstream.hints) assert.equal(toolHint(hint.tool, true), hint.text)
})

test('filmUi declares tool:<id> for the 17 tools and panel:<id> for the 26 panels', () => {
  assert.deepEqual(
    FILM_UI.tools.map((tool) => tool.id),
    upstream.tools.map((tool) => `tool:${tool.id}`),
  )
  assert.equal(upstream.panels.length, 26)
  assert.deepEqual(
    FILM_UI.panels.map((panel) => panel.id),
    upstream.panels.map((panel) => `panel:${panel.id}`),
  )
})

test("upstream draws a group only while it fits the frame (`break`): all 8 from 260 px, 7 at 230 px, always one", () => {
  assert.equal(groupsThatFit(900), 8)
  assert.equal(groupsThatFit(260), 8)
  assert.equal(groupsThatFit(259), 7)
  assert.equal(groupsThatFit(230), 7)
  assert.equal(groupsThatFit(100), 3)
  assert.equal(groupsThatFit(0), 1)
})

test("every declared control is an element upstream registers, or on filmUi's explicit Kition-only list", () => {
  // Upstream's ids with their run-time parts (`{}`) dropped: `workspaces.edit.row.{}` is `workspaces.edit.row`.
  const upstreamIds = new Set(upstream.elements.map((element) => element.id.replace(/\.?\{\}/g, '')))
  const kitionOnly = new Set(KITION_ONLY.map((item) => item.id))
  const controls = FILM_UI.controls.map((item) => item.id)
  assert.ok(controls.every((id) => id.startsWith('control:')))
  // A shared id (rule 3) stands for upstream's per-track ids, which must all exist.
  const aliased = (id) => SHARED_ALIASES[id]?.length > 0 && SHARED_ALIASES[id].every((each) => upstream.elements.some((element) => element.id === each))
  const unknown = controls.filter((id) => !upstreamIds.has(id.slice('control:'.length)) && !kitionOnly.has(id) && !aliased(id))
  assert.deepEqual(unknown, [])
  // Each Kition-only id names its area: `control:<area>.<field>`.
  for (const id of kitionOnly) assert.match(id, /^control:[a-zA-Z]+\.[a-zA-Z.]+$/)
})
