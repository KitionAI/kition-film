import test from 'node:test'
import assert from 'node:assert/strict'
import { isVisible, contains, closePanel } from '@kition/sdk/editor/workspaceTree'
import { FILM_WORKSPACES } from './presets.ts'
import { createWorkspaceRoute } from './route.ts'

/** A page's workspace state and the route over it, with `useWorkspaces` faked as upstream's `workspaces.rs` behaves. */
function page({ focused = 'timeline', under = null, hidden = [] } = {}) {
  const s = { tree: FILM_WORKSPACES.Editing, current: 'Editing', saved: [], focused, maximized: null, dialogs: [], calls: [] }
  const names = () => [...Object.keys(FILM_WORKSPACES), ...s.saved].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  const slug = (n) => n.toLowerCase().replaceAll(' ', '')
  const workspaces = {
    get names() {
      return names()
    },
    get current() {
      return s.current
    },
    find: (q) => names().find((n) => slug(n) === slug(q)),
    switchTo: (n) => {
      s.calls.push(['switchTo', n])
      s.current = n
      s.tree = FILM_WORKSPACES[n] ?? FILM_WORKSPACES.Editing
    },
    reset: () => s.calls.push(['reset']),
    saveChanges: () => (s.calls.push(['saveChanges']), null),
    saveAs: (n) => (n.trim() ? (s.saved.push(n.trim()), (s.current = n.trim()), null) : 'the workspace needs a name'),
    rename: (from, to) => (s.calls.push(['rename', from, to]), Object.hasOwn(FILM_WORKSPACES, from) ? `\`${from}\` is a built-in workspace and keeps its name` : null),
    remove: (n) => (s.calls.push(['remove', n]), null),
    isBuiltin: (n) => Object.hasOwn(FILM_WORKSPACES, n),
  }
  const route = createWorkspaceRoute({
    workspaces: () => workspaces,
    tree: () => s.tree,
    setTree: (tree) => (s.tree = tree),
    focused: () => s.focused,
    setFocused: (p) => (s.focused = p),
    maximized: () => s.maximized,
    setMaximized: (p) => (s.maximized = p),
    shown: (panel) => !hidden.includes(panel),
    underCursor: () => under,
    dialog: (which) => s.dialogs.push(which),
  })
  return { s, route }
}

test('window.panel.<Kind> shows the panel and focuses it (show_panel)', () => {
  const { s, route } = page()
  route('window.panel.EffectControls', {})
  assert.ok(isVisible(s.tree, 'effectControls'))
  assert.equal(s.focused, 'effectControls')
  assert.throws(() => route('window.panel.Nothing', {}), /unknown panel `Nothing`/)
})

test('a closed panel comes back near its neighbour', () => {
  const { s, route } = page()
  s.tree = closePanel(s.tree, 'history')
  route('window.panel.History', {})
  assert.ok(contains(s.tree, 'history') && isVisible(s.tree, 'history'))
})

test('window.workspace.<slug> switches by slug, and an unknown one says so', () => {
  const { s, route } = page()
  assert.deepEqual(route('window.workspace.captionsandgraphics', {}), { workspace: 'Captions and Graphics' })
  assert.equal(s.current, 'Captions and Graphics')
  assert.throws(() => route('window.workspace.nowhere', {}), /unknown workspace `nowhere`/)
})

test('reset, saveChanges, rename, and delete go to the named workspaces with upstream answers', () => {
  const { s, route } = page()
  assert.deepEqual(route('window.workspace.reset', {}), { workspace: 'Editing' })
  assert.deepEqual(route('window.workspace.saveChanges', {}), { saved: 'Editing' })
  assert.throws(() => route('window.workspace.rename', { from: 'Editing', to: 'X' }), /built-in workspace and keeps its name/)
  assert.deepEqual(route('window.workspace.delete', { name: 'Mine' }), { deleted: 'Mine' })
  assert.deepEqual(route('window.workspace.delete', { name: 'Color' }), { restored: 'Color' })
  assert.deepEqual(s.calls.slice(0, 2), [['reset'], ['saveChanges']])
})

test('saveAs with a name saves; without one it opens the dialog, as does edit', () => {
  const { s, route } = page()
  assert.deepEqual(route('window.workspace.saveAs', { name: 'Cut' }), { saved: 'Cut', workspace: 'Cut' })
  assert.throws(() => route('window.workspace.saveAs', { name: '  ' }), /needs a name/)
  assert.deepEqual(route('window.workspace.saveAs', {}), { dialog: 'saveWorkspace' })
  assert.deepEqual(route('window.workspace.edit', {}), { dialog: 'editWorkspaces', workspaces: s.saved.length ? [...Object.keys(FILM_WORKSPACES), 'Cut'].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : [] })
  assert.deepEqual(s.dialogs, ['saveAs', 'edit'])
})

test('Shift+` maximizes the focused frame and restores it', () => {
  const { s, route } = page({ focused: 'program' })
  assert.deepEqual(route('window.maximizeFrame', {}), { maximized: 'Program' })
  assert.equal(s.maximized, 'program')
  assert.deepEqual(route('window.maximizeFrame', {}), { maximized: null })
  assert.equal(s.maximized, null)
})

test('` maximizes the frame under the pointer, else a named panel, else the focused one', () => {
  const { s, route } = page({ focused: 'timeline', under: 'project' })
  route('window.maximizeFrameUnderCursor', {})
  assert.equal(s.maximized, 'project')
  assert.equal(s.focused, 'project')
  route('window.maximizeFrameUnderCursor', {})
  route('window.maximizeFrameUnderCursor', { panel: 'Effect Controls' })
  assert.equal(s.maximized, 'effectControls')
  assert.ok(isVisible(s.tree, 'effectControls'))
  const alone = page({ focused: 'timeline' })
  alone.route('window.maximizeFrameUnderCursor', {})
  assert.equal(alone.s.maximized, 'timeline')
})

test('next and previous panel cycle focus; toggleMonitorFocus swaps the monitors', () => {
  const { s, route } = page({ focused: 'timeline' })
  assert.deepEqual(route('window.nextPanel', {}), { focused: 'Source' })
  assert.deepEqual(route('window.prevPanel', {}), { focused: 'Timeline' })
  s.focused = 'program'
  assert.deepEqual(route('window.toggleMonitorFocus', {}), { focused: 'Source' })
  assert.equal(s.focused, 'source')
  assert.deepEqual(route('window.toggleMonitorFocus', {}), { focused: 'Program' })
})

test("from a floating bin window (focus `projectBin.<id>`), the frame keys act on the Project panel's frame", () => {
  const { s, route } = page({ focused: 'projectBin.bin7' })
  assert.deepEqual(route('window.maximizeFrame', {}), { maximized: 'Project' })
  assert.equal(s.maximized, 'project')
  route('window.maximizeFrame', {})
  s.focused = 'projectBin.bin7'
  const fromProject = page({ focused: 'project' })
  assert.deepEqual(route('window.nextPanel', {}), fromProject.route('window.nextPanel', {}))
  // Select Find Box in a window: its own search field, named as the Project panel's.
  s.focused = 'projectBin.bin7'
  assert.deepEqual(route('panel.selectFindBox', {}), { panel: 'Project' })
})

test('next panel skips the panels the host hides', () => {
  const { route } = page({ focused: 'source', hidden: ['program'] })
  assert.deepEqual(route('window.nextPanel', {}), { focused: 'Properties' })
})

test('Edit mode is served; Import and Export modes are not (wave 3)', () => {
  const { route } = page()
  assert.equal(route.serves('mode.edit'), true)
  assert.equal(route('mode.edit', {}), null)
  assert.equal(route.serves('mode.import'), false)
  assert.equal(route.serves('mode.export'), false)
  assert.equal(route.serves('window.panel.Project'), true)
  assert.equal(route.serves('window.workspace.editing'), true)
})
