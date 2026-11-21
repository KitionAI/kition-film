import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { contains, isVisible, panelsOf } from '@kition/sdk/editor/workspaceTree'
import { FILM_WORKSPACES, FILM_PANEL_IDS, COMPACT_PANELS, panelFromName, showPanel, cyclePanel, toggleMaximized } from './presets.ts'

const manifest = JSON.parse(readFileSync(new URL('../../parity/film-upstream.json', import.meta.url), 'utf8'))
const tabs = (panels, active = 0) => ({ tabs: panels, active })
const row = (size, a, b) => ({ split: 'row', size, a, b })

test('the nine built-in workspaces are the manifest trees, in its order, each panel in one frame', () => {
  assert.deepEqual(Object.keys(FILM_WORKSPACES), manifest.workspaces.map((w) => w.name))
  for (const { name, layout } of manifest.workspaces) {
    const all = panelsOf(FILM_WORKSPACES[name])
    assert.deepEqual(all.filter((panel, at) => all.indexOf(panel) !== at), [], `${name} lists each panel once`)
    assert.ok(all.every((panel) => FILM_PANEL_IDS.has(panel)), `${name} holds only known panels`)
    if (name !== 'Effects') assert.deepEqual(FILM_WORKSPACES[name], layout, name)
  }
})

test("upstream's Effects layout loses only its dead second Effect Controls tab", () => {
  const frames = (node) => ('split' in node ? [...frames(node.a), ...frames(node.b)] : [node])
  const before = frames(manifest.workspaces.find((w) => w.name === 'Effects').layout)
  const after = frames(FILM_WORKSPACES.Effects)
  assert.deepEqual(before.at(-1), { tabs: ['effectControls', 'graphicsTemplates'], active: 1 })
  assert.deepEqual(after.at(-1), { tabs: ['graphicsTemplates'], active: 0 })
  assert.deepEqual(after.slice(0, -1), before.slice(0, -1))
})

test('the panel ids are the manifest 26, and Tools and Audio Meters are compact', () => {
  assert.deepEqual([...FILM_PANEL_IDS], manifest.panels.map((p) => p.id))
  assert.equal(FILM_PANEL_IDS.size, 26)
  assert.deepEqual([...COMPACT_PANELS].sort(), ['audioMeters', 'tools'])
})

test('panelFromName folds case, spaces, and separators, by kind or by title (PanelKind::from_name)', () => {
  assert.equal(panelFromName('EffectControls'), 'effectControls')
  assert.equal(panelFromName('effect controls'), 'effectControls')
  assert.equal(panelFromName('Audio_Meters'), 'audioMeters')
  assert.equal(panelFromName('History'), 'history')
  assert.equal(panelFromName('Nope'), null)
})

test('showPanel activates a panel already in the tree', () => {
  const editing = FILM_WORKSPACES.Editing
  const next = showPanel(editing, 'effectControls')
  assert.ok(isVisible(next, 'effectControls'))
  assert.deepEqual(panelsOf(next), panelsOf(editing))
})

test('showPanel opens a closed panel near its upstream neighbour', () => {
  // History, Info, Markers... go near Project.
  const noHistory = { split: 'row', size: { ratio: 0.5 }, a: tabs(['project', 'info']), b: tabs(['program']) }
  assert.deepEqual(showPanel(noHistory, 'history'), { ...noHistory, a: tabs(['project', 'info', 'history'], 2) })
  // Effect Controls, Metadata, Text... go near Source.
  const withSource = row({ ratio: 0.5 }, tabs(['source']), tabs(['program']))
  assert.deepEqual(showPanel(withSource, 'effectControls'), row({ ratio: 0.5 }, tabs(['source', 'effectControls'], 1), tabs(['program'])))
  // Properties, Color, Graphics Templates, Audio Mixing go near Program.
  assert.deepEqual(showPanel(withSource, 'properties'), row({ ratio: 0.5 }, tabs(['source']), tabs(['program', 'properties'], 1)))
})

test('showPanel falls back to Project, then Program, as open_near does', () => {
  const noSource = row({ ratio: 0.5 }, tabs(['project']), tabs(['program']))
  assert.deepEqual(showPanel(noSource, 'metadata'), row({ ratio: 0.5 }, tabs(['project', 'metadata'], 1), tabs(['program'])))
  const programOnly = tabs(['program'])
  assert.deepEqual(showPanel(programOnly, 'history'), tabs(['program', 'history'], 1))
  const neither = tabs(['tools'])
  assert.deepEqual(showPanel(neither, 'history'), neither)
})

test('showPanel restores the Timeline beside a lone Audio Meters frame (restore_timeline)', () => {
  const meters = row({ fixedA: 64 }, tabs(['tools']), tabs(['audioMeters']))
  assert.deepEqual(showPanel(meters, 'timeline'), row({ fixedA: 64 }, tabs(['tools']), row({ fixedB: 116 }, tabs(['timeline']), tabs(['audioMeters']))))
  const noMeters = row({ ratio: 0.5 }, tabs(['project']), tabs(['program']))
  assert.deepEqual(showPanel(noMeters, 'timeline'), row({ ratio: 0.5 }, tabs(['project', 'timeline'], 1), tabs(['program'])))
})

test('closing History in Editing and showing it again brings it back into the Project frame', async () => {
  const { closePanel } = await import('@kition/sdk/editor/workspaceTree')
  const closed = closePanel(FILM_WORKSPACES.Editing, 'history')
  assert.ok(!contains(closed, 'history'))
  const shown = showPanel(closed, 'history')
  assert.ok(isVisible(shown, 'history'))
  const group = (node) => ('split' in node ? group(node.a) ?? group(node.b) : node.tabs.includes('history') ? node : undefined)
  assert.ok(group(shown).tabs.includes('project'))
})

test('cyclePanel moves focus through the shown, non-compact panels in tree order', () => {
  const editing = FILM_WORKSPACES.Editing
  // Editing shows Source, Program, Properties, Project, (Tools), Timeline, (Audio Meters).
  assert.equal(cyclePanel(editing, 'timeline', true), 'source')
  assert.equal(cyclePanel(editing, 'source', true), 'program')
  assert.equal(cyclePanel(editing, 'source', false), 'timeline')
  // A focused panel that is not shown counts as the first.
  assert.equal(cyclePanel(editing, 'history', true), 'program')
  assert.equal(cyclePanel(tabs(['tools']), 'tools', true), null)
})

test('toggleMaximized: off when on; else maximizes the panel and shows and focuses it (toggle_maximize)', () => {
  const editing = FILM_WORKSPACES.Editing
  const on = toggleMaximized(editing, null, 'effectControls')
  assert.equal(on.maximized, 'effectControls')
  assert.equal(on.focused, 'effectControls')
  assert.ok(isVisible(on.tree, 'effectControls'))
  const off = toggleMaximized(on.tree, 'effectControls', 'program')
  assert.equal(off.maximized, null)
  assert.equal(off.focused, null)
  assert.equal(off.tree, on.tree)
})
