// Film's menus, built as upstream's `menus.rs` `menu_items` and `menu_bar` build them: the engine's
// rows, upstream's UI rows as Kition `kit:` rows that run through `invoke`, Window ▸ Workspaces as
// `workspaces::menu` rebuilds it, and Kition's Help. Node loads the TypeScript modules directly.
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DIALOGS } from '../dialogs/registry.ts'
import assert from 'node:assert/strict'
import { FILM_MENUS, KIT_ROWS, MENUS, menuChecked, withLabelNames, withLiveShortcuts, withWorkspaces } from './catalog.ts'
import { hiddenReason, isHiddenOnWeb } from './hidden.ts'
import { KIT_TAKEOVERS, relativePath, shortcutList } from './kitMenus.ts'
import { reservedKeys } from '../session/keys.ts'
import { routeOf } from '../session/invoke.ts'
import { DEFAULT_VIEWS } from '../monitors/monitorView.ts'

const upstream = JSON.parse(readFileSync(new URL('../../parity/film-upstream.json', import.meta.url), 'utf8'))
const at = (command) => FILM_MENUS.filter((row) => row.command === command)
const drawn = FILM_MENUS.filter((row) => !isHiddenOnWeb(row))

test("the menus are upstream's nine, in upstream's order", () => {
  assert.deepEqual(MENUS, ['File', 'Edit', 'Clip', 'Sequence', 'Markers', 'Graphics and Titles', 'View', 'Window', 'Help'])
  const tops = []
  for (const row of FILM_MENUS) if (!tops.includes(row.path[0])) tops.push(row.path[0])
  assert.deepEqual(tops, MENUS)
  // Each menu's rows stay together, so a menu is drawn once and in that order.
  const order = FILM_MENUS.map((row) => MENUS.indexOf(row.path[0]))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
})

test('Clip ▸ Video Options ▸ Time Interpolation nests under Video Options', () => {
  const rows = FILM_MENUS.filter((row) => row.path.join('/') === 'Clip/Video Options/Time Interpolation')
  assert.deepEqual(
    rows.map((row) => row.command),
    ['clip.timeInterpolation.frameSampling', 'clip.timeInterpolation.frameBlending', 'clip.timeInterpolation.opticalFlow'],
  )
  // `menu_level` draws a submenu where its first row is: Time Interpolation comes inside Video Options.
  const clip = FILM_MENUS.filter((row) => row.path[0] === 'Clip')
  const videoOptions = clip.findIndex((row) => row.path[1] === 'Video Options')
  const interpolation = clip.findIndex((row) => row.path[2] === 'Time Interpolation')
  assert.ok(videoOptions >= 0 && interpolation >= videoOptions)
})

test('no hidden row is drawn, and every web-hidden command has a reason', () => {
  for (const row of drawn) assert.equal(hiddenReason(row.command.replace(/^kit:/, '')), null, row.command)
  const commands = new Set(drawn.map((row) => row.command.replace(/^kit:/, '')))
  for (const command of ['file.save', 'file.saveAs', 'file.open', 'file.close', 'file.revert', 'app.quit', 'file.newProject', 'help.discord', 'help.website', 'help.github', 'help.kitionFilmHelp', 'app.about', 'view.theme.dark', 'app.language.english', 'window.toggleFullScreen']) {
    assert.equal(commands.has(command), false, command)
  }
  // The engine's render previews, Project Manager, and Scratch Disks need local folders (the first two refuse without one).
  for (const command of ['sequence.renderEffectsInToOut', 'sequence.renderInToOut', 'sequence.renderSelection', 'sequence.renderAudio', 'file.projectManager', 'file.projectSettings.scratchDisks']) {
    assert.match(hiddenReason(command) ?? '', /local/, command)
    assert.equal(commands.has(command), false, command)
  }
  for (const command of ['sequence.deleteRenderFiles', 'sequence.deleteRenderFilesInToOut']) {
    assert.equal(hiddenReason(command), 'Preview files never exist on the web.', command)
    assert.equal(commands.has(command), false, command)
  }
  // Link Media… is drawn: the host's picker will serve it (wave 2), as it serves Import.
  assert.equal(commands.has('media.linkMedia'), true)
})

test('Window ▸ Workspaces lists the nine built-ins sorted, then the actions', () => {
  const rows = FILM_MENUS.filter((row) => row.path.join('/') === 'Window/Workspaces')
  assert.deepEqual(
    rows.map((row) => row.label),
    ['All Panels', 'Assembly', 'Audio', 'Captions and Graphics', 'Color', 'Editing', 'Effects', 'Learning', 'Review', 'Reset to Saved Layout', 'Save Changes to this Workspace', 'Save as New Workspace…', 'Edit Workspaces…'],
  )
  assert.equal(at('kit:window.workspace.editing')[0].shortcut, 'Alt+Shift+1')
  // A saved workspace joins the names, sorted without case, before the actions (`dock::names`).
  const withCut = withWorkspaces(FILM_MENUS, [...upstream.workspaces.map((workspace) => workspace.name), 'cut'])
    .filter((row) => row.path.join('/') === 'Window/Workspaces')
    .map((row) => row.command)
  assert.equal(withCut.indexOf('kit:window.workspace.cut'), withCut.indexOf('kit:window.workspace.color') + 1)
  assert.equal(withCut.at(-1), 'kit:window.workspace.edit')
})

test('every kit: row has a route in invoke, and every engine row runs in the session or opens its dialog', () => {
  assert.ok(KIT_ROWS.length > 0)
  for (const row of KIT_ROWS) assert.notEqual(routeOf(row.command.slice(4), {}, 'timeline'), 'session', row.command)
  // A "…" row with a Film dialog (dialogs/registry.ts) opens it, as upstream's routes do; Clip ▸
  // Rename… starts the Project panel's inline rename (Task 12); Get Media File Properties for ▸
  // File… picks a file through the host first (Task 16), and so do Attach Proxies… and Reconnect
  // Full Resolution Media… (Task 17); the others run at once.
  const PICKS = new Set(['file.mediaPropertiesFile', 'media.attachProxies', 'media.reconnectFullRes'])
  const routeFor = (command) => (DIALOGS.has(command) ? 'dialog' : command === 'clip.rename' ? 'projectPanel' : PICKS.has(command) ? 'fileDialog' : 'session')
  for (const row of FILM_MENUS.filter((item) => !item.command.startsWith('kit:'))) assert.equal(routeOf(row.command, {}, 'timeline'), routeFor(row.command), row.command)
  assert.equal(routeOf('clip.speedDuration', {}, 'timeline'), 'dialog')
})

test("upstream's UI rows become kit: rows, keeping their parity key's command", () => {
  const ui = upstream.menus.filter((row) => row.origin !== 'engine' && !isHiddenOnWeb(row))
  for (const row of ui) assert.equal(at(`kit:${row.command}`).length, 1, row.command)
  assert.deepEqual(at('kit:view.playbackRes.quarter')[0].path, ['View', 'Playback Resolution'])
  // Engine rows stay engine commands, where upstream draws them.
  assert.deepEqual(at('markers.markIn')[0].path, ['Markers'])
})

test('File ▸ Import and File ▸ Export ▸ Media are taken over by Kition, in place', () => {
  assert.deepEqual(KIT_TAKEOVERS, { 'file.import': 'kit:file.import', 'file.exportMedia': 'kit:file.exportMedia' })
  assert.equal(at('file.import').length, 0)
  assert.deepEqual([at('kit:file.import')[0].label, at('kit:file.import')[0].shortcut], ['Import…', 'Cmd+I'])
  assert.deepEqual(at('kit:file.exportMedia')[0].path, ['File', 'Export'])
  assert.equal(routeOf('file.import', {}, 'timeline'), 'fileDialog')
  assert.equal(routeOf('file.import', { paths: ['a.mp4'] }, 'timeline'), 'session')
  assert.equal(routeOf('file.exportMedia', {}, 'timeline'), 'fileDialog')
})

test('Help ends with Keyboard Shortcuts and About', () => {
  const help = drawn.filter((row) => row.path[0] === 'Help').map((row) => row.command)
  assert.deepEqual(help.slice(-2), ['kit:help.shortcuts', 'kit:help.about'])
  assert.equal(FILM_MENUS.at(-1).command, 'kit:help.about')
  for (const id of ['help.about', 'help.shortcuts', 'app.keyboardShortcuts']) assert.equal(routeOf(id, {}, 'timeline'), 'dialog', id)
})

test('Edit ▸ Label rows show the names from the label preferences', () => {
  const named = withLabelNames(FILM_MENUS, { colors: { violet: { color: '#380ea7', name: 'Interviews' } }, defaults: {} })
  assert.equal(named.find((row) => row.command === 'edit.label.violet').label, 'Interviews')
  assert.equal(named.find((row) => row.command === 'edit.label.iris').label, 'Iris')
  assert.equal(withLabelNames(FILM_MENUS, null), FILM_MENUS)
})

test("check marks: the workspace in use and the focused monitor's view, as upstream's menu_items", () => {
  const checked = menuChecked({ workspace: 'Editing', views: DEFAULT_VIEWS, focused: 'timeline' })
  assert.equal(checked('kit:window.workspace.editing'), true)
  assert.equal(checked('kit:window.workspace.assembly'), false)
  assert.equal(checked('kit:window.workspace.reset'), undefined)
  // Program's defaults: Playback 1/2, Paused Full, Fit.
  assert.equal(checked('kit:view.playbackRes.half'), true)
  assert.equal(checked('kit:view.playbackRes.quarter'), false)
  assert.equal(checked('kit:view.pausedRes.full'), true)
  assert.equal(checked('kit:view.magnification.fit'), true)
  assert.equal(checked('kit:view.highQualityPlayback'), false)
  assert.equal(checked('kit:view.safeMargins'), false)
  // Upstream checks only `view.*` and workspace rows: the engine's toggles draw plain.
  for (const command of ['sequence.snap', 'sequence.linkedSelection', 'media.toggleProxies', 'markers.markIn', 'kit:help.about']) assert.equal(checked(command), undefined, command)
  // Before the workspace is known, its rows draw plain.
  assert.equal(menuChecked({ workspace: null, views: DEFAULT_VIEWS, focused: 'timeline' })('kit:window.workspace.editing'), undefined)
  // View ▸ Dynamic Audio Waveforms is checked while on, its default (upstream menu_dialogs.rs checked).
  assert.equal(menuChecked({ workspace: 'Editing', views: DEFAULT_VIEWS, focused: 'timeline' })('view.dynamicAudioWaveforms'), true)
  assert.equal(menuChecked({ workspace: 'Editing', views: DEFAULT_VIEWS, focused: 'timeline', dynamicWaveforms: false })('view.dynamicAudioWaveforms'), false)
})

test('imports name media relative to the project, as the project names them', () => {
  assert.equal(relativePath('films', 'films/media/a.mp4'), 'media/a.mp4')
  assert.equal(relativePath('films/cuts', 'media/a.mp4'), '../../media/a.mp4')
  assert.equal(relativePath('', 'a.mp4'), 'a.mp4')
})

test("the shortcuts list holds the engine's shortcuts and upstream's UI keys, without hidden commands", () => {
  const rows = [
    { id: 'markers.markIn', label: 'Mark In', category: 'Markers', shortcuts: [{ keys: 'I', panel: null }] },
    { id: 'file.save', label: 'Save', category: 'File', shortcuts: [{ keys: 'Cmd+S', panel: null }] },
    { id: 'edit.undo', label: 'Undo', category: 'Edit', shortcuts: [{ keys: 'Cmd+Z', panel: null }, { keys: 'Left', panel: 'History' }] },
  ]
  const list = shortcutList(rows, upstream)
  const find = (command) => list.filter((item) => item.command === command)
  assert.deepEqual(find('markers.markIn').map((item) => item.keys), ['I'])
  assert.deepEqual(find('edit.undo').map((item) => [item.keys, item.panel]), [['Cmd+Z', null], ['Left', 'History']])
  assert.equal(find('file.save').length, 0)
  // Upstream's UI keys, which the web engine does not hold.
  assert.deepEqual(find('playback.forward').map((item) => item.keys), ['L'])
  assert.deepEqual(find('window.workspace.editing').map((item) => item.keys), ['Alt+Shift+1'])
})

test("rows show the engine's live bindings (its first application-wide one), as menu_items_for's shortcuts.primary", () => {
  const live = [
    { id: 'markers.markIn', shortcuts: [{ keys: 'Q', panel: null }] },
    { id: 'markers.markOut', shortcuts: [{ keys: 'O', panel: 'Timeline' }] },
    { id: 'file.import', shortcuts: [{ keys: 'Cmd+Shift+I', panel: null }] },
  ]
  const rows = withLiveShortcuts(FILM_MENUS, live)
  const find = (command) => rows.find((row) => row.command === command)
  assert.equal(find('markers.markIn').shortcut, 'Q')
  // Unbound application-wide: no key shows (not the manifest's default).
  assert.equal(find('markers.markOut').shortcut, '')
  // A takeover row shows its engine command's binding.
  assert.equal(find('kit:file.import').shortcut, 'Cmd+Shift+I')
  // Upstream's UI commands keep their defaults; so does every row before the list is read.
  assert.equal(find('kit:window.workspace.editing').shortcut, 'Alt+Shift+1')
  assert.equal(withLiveShortcuts(FILM_MENUS, null), FILM_MENUS)
})

test("Help ▸ Keyboard Shortcuts and the menus leave out the keys Kition and the host keep (RESERVED_SHORTCUTS, init.shortcuts), as the key router does", async () => {
  const { RESERVED_SHORTCUTS } = await import('@kition/sdk/editor')
  const reserved = reservedKeys([...RESERVED_SHORTCUTS, 'Cmd+K'], true)
  const rows = [
    { id: 'sequence.close', label: 'Close Sequence', category: 'Sequence', shortcuts: [{ keys: 'Cmd+W', panel: 'Timeline' }] },
    { id: 'clip.setPosterFrame', label: 'Set Poster Frame', category: 'Clip', shortcuts: [{ keys: 'Cmd+P', panel: null }] },
    { id: 'sequence.addEdit', label: 'Add Edit', category: 'Sequence', shortcuts: [{ keys: 'Cmd+K', panel: null }] },
    { id: 'clip.clearPosterFrame', label: 'Clear Poster Frame', category: 'Clip', shortcuts: [{ keys: 'Alt+P', panel: null }] },
  ]
  const list = shortcutList(rows, upstream, reserved)
  const keysOf = (command) => list.filter((item) => item.command === command).map((item) => item.keys)
  assert.deepEqual(keysOf('sequence.close'), [])
  assert.deepEqual(keysOf('clip.setPosterFrame'), [])
  assert.deepEqual(keysOf('sequence.addEdit'), [], "the host's own key")
  assert.deepEqual(keysOf('clip.clearPosterFrame'), ['Alt+P'])
  assert.ok(!list.some((item) => reserved(item.keys)), 'no reserved key in the list')
  // The menus show no reserved key either.
  const menus = withLiveShortcuts(FILM_MENUS, rows, reserved)
  assert.ok(!menus.some((row) => row.shortcut && reserved(row.shortcut)), JSON.stringify(menus.filter((row) => row.shortcut && reserved(row.shortcut)).map((row) => row.command)))
})

test('no drawn row opens a panel the editor does not draw, a Preferences page, an interchange export, or a workspace of such panels', () => {
  const commands = drawn.map((row) => row.command.replace(/^kit:/, ''))
  const panels = commands.filter((command) => command.startsWith('window.panel.'))
  assert.deepEqual(panels, ['Project', 'Info', 'Effects', 'Markers', 'History', 'Source', 'EffectControls', 'Program', 'Timeline', 'Tools', 'AudioMeters', 'Properties'].map((kind) => `window.panel.${kind}`))
  assert.deepEqual(commands.filter((command) => command.startsWith('app.settings.')), [])
  for (const command of ['file.exportEdl', 'file.exportAle', 'file.exportOtio', 'file.exportFcp7Xml', 'file.exportFcpxml', 'file.exportAaf', 'file.exportOmf', 'mode.export', 'graphics.newFromFile', 'graphics.template.install', 'file.replaceFonts', 'clip.remix.enable', 'view.display.multicam', 'multicam.toggleView', 'help.systemCompatibilityReport', 'edit.editOriginal', 'clip.generateAudioWaveform']) {
    assert.equal(commands.includes(command), false, command)
    assert.ok(hiddenReason(command), command)
  }
  for (const slug of ['color', 'audio', 'captionsandgraphics']) assert.equal(commands.includes(`window.workspace.${slug}`), false, slug)
  // What a person still uses stays: Export Media, Close Gap, Multi-Camera's rows (a scenario flattens through the menu).
  for (const command of ['file.exportMedia', 'sequence.closeGap', 'clip.multicamFlatten', 'window.workspace.editing', 'window.workspace.effects']) assert.ok(commands.includes(command), command)
})
