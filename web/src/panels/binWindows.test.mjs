// Floating bin panels (upstream `panels/project.rs` `open_bin` with `openNewWindow`, `floating`,
// and `route`'s `newPanel`): each window is a bin tab of its own (`BinTab` with `floating`), its
// rectangle in the kit store `film.floatingBins` under an id that names its bin, the windows
// themselves this page's. Run with `pnpm --dir web test:unit`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FLOATING_BINS, binWindowFocus, binWindowOf, createProjectUi, focusedPanel, shownBin, windowFocusFallback } from './projectModel.ts'
import { createProjectRoute, visibleItems } from './projectRoute.ts'

// Root 1 holds bin 7 (Footage, with bin 9 Selects inside) and item 5; bin 7 holds items 10 and 11.
const tree = {
  id: 1,
  name: 'Sample',
  children: [
    { item: 5, name: 'Beach.MOV' },
    { id: 7, name: 'Footage', children: [{ item: 10, name: 'Take 1.mov' }, { item: 11, name: 'Take 2.mov' }, { id: 9, name: 'Selects', children: [{ item: 30, name: 'Take 3.mov' }] }] },
  ],
}

/** The route over a page's ProjectUi, with a fake engine: the view is `view`, each run is recorded. */
function routeOf({ ui = createProjectUi(), root = tree, view = { view: { mode: 'list', iconSize: 90 } }, target = () => null } = {}) {
  const runs = []
  const query = async (id, params) => {
    if (id === 'project.view.get') return view
    if (id === 'state.inspect') return { project_selection: [] }
    if (id === 'project.items') {
      const bin = params?.bin ?? 1
      const rows = bin === 7 ? [{ item: 10, name: 'Take 1.mov', depth: 0, direct: true }, { item: 11, name: 'Take 2.mov', depth: 0, direct: true }] : [{ item: 5, name: 'Beach.MOV', depth: 0, direct: true }]
      return { bin, columns: [], rows }
    }
    if (id === 'prefs.get') return {}
    return null
  }
  const deps = { ui, root: () => root, run: async (id, params) => (runs.push([id, params]), null), query, target }
  return { ui, deps, route: createProjectRoute(deps), runs }
}

test('window ids name their bin and reuse the lowest free suffix, so a stored rectangle keyed by one is found again by the next window of that bin, on this page or another', () => {
  assert.deepEqual(FLOATING_BINS, { kit: 'film', store: 'floatingBins' })
  const page = createProjectUi()
  const first = page.openWindow(7, 'list', 110, { reuse: true })
  assert.equal(first, 'bin7')
  // Positions live in the store (JSON in localStorage), keyed by the window's id.
  const stored = JSON.parse(JSON.stringify({ [first]: { x: 40, y: 30, width: 520, height: 360 } }))
  page.closeWindow(first)
  assert.deepEqual(page.windows(), [])
  // Opened again on this page, and on a second page (its own ProjectUi, none of this page's windows).
  const again = page.openWindow(7, 'icon', 110, { reuse: true })
  const other = createProjectUi()
  assert.deepEqual(other.windows(), [], "a second page has none of this page's windows")
  const there = other.openWindow(7, 'list', 110, { reuse: true })
  assert.deepEqual([stored[again], stored[there]], [{ x: 40, y: 30, width: 520, height: 360 }, { x: 40, y: 30, width: 520, height: 360 }])
  // A second window of the same bin (New Project Panel twice) has an id of its own, the lowest free.
  assert.equal(page.openWindow(1, 'list', 110, { reuse: false }), 'bin1')
  assert.equal(page.openWindow(1, 'list', 110, { reuse: false }), 'bin1-2')
  assert.equal(page.openWindow(1, 'list', 110, { reuse: false }), 'bin1-3')
  page.closeWindow('bin1-2')
  assert.equal(page.openWindow(1, 'list', 110, { reuse: false }), 'bin1-2')
})

test('a window for a deleted bin closes (upstream floating: no bin, the window closes); the others stay', () => {
  const ui = createProjectUi()
  ui.openWindow(7, 'list', 110, { reuse: true })
  ui.openWindow(9, 'icon', 110, { reuse: true })
  ui.openWindow(1, 'list', 110, { reuse: false })
  // Bin 9 deleted: its window closes.
  const without9 = { ...tree, children: [tree.children[0], { ...tree.children[1], children: tree.children[1].children.slice(0, 2) }] }
  assert.deepEqual(ui.pruneWindows(without9), ['bin9'])
  assert.deepEqual(ui.windows().map((each) => each.id), ['bin7', 'bin1'])
  // No document yet (another one opening): nothing closes.
  assert.deepEqual(ui.pruneWindows(null), [])
  assert.equal(ui.windows().length, 2)
  // Bin 9 moved into the root (not deleted): a window of it stays.
  ui.openWindow(9, 'icon', 110, { reuse: true })
  const moved = { ...tree, children: [...tree.children, { id: 9, name: 'Selects', children: [] }] }
  assert.deepEqual(ui.pruneWindows(moved), [])
})

test("another document: the windows whose bins it has stay, each at its top with no rename; the others close", () => {
  const ui = createProjectUi()
  const footage = ui.instance(ui.openWindow(7, 'list', 110, { reuse: true }))
  footage.navigate(9, 1)
  footage.set({ rename: { item: 10, bin: null, text: 'x' } })
  ui.openWindow(9, 'icon', 110, { reuse: true })
  ui.reset()
  assert.deepEqual(ui.windows().map((each) => [each.id, each.nav, each.rename]), [['bin7', null, null], ['bin9', null, null]])
  // The new document has bin 7 only.
  assert.deepEqual(ui.pruneWindows({ id: 1, name: 'Other', children: [{ id: 7, name: 'B-roll', children: [] }] }), ['bin9'])
})

test("a window is a panel instance of its own (upstream Inst::Tab): its bin, view, icon size, columns, and Freeform width; the search, folds, and selected bin are the panel's", () => {
  const ui = createProjectUi()
  ui.set({ search: 'take', expanded: new Set([7]) })
  const id = ui.openWindow(7, 'icon', 72, { reuse: true })
  const win = ui.instance(id)
  const state = win.get()
  assert.equal(state.search, 'take')
  assert.deepEqual([...state.expanded], [7])
  assert.deepEqual(win.shownTab(), { bin: 7, nav: null, mode: 'icon', iconSize: 72 })
  assert.deepEqual(shownBin(state, tree), { bin: 7, top: 7 })
  assert.equal(win.get(), state, 'unchanged: the same object (useSyncExternalStore)')
  // Its own view and size, columns, and width; the main panel's stay.
  win.setTab({ mode: 'freeform', iconSize: 140 })
  win.set({ iconColumns: 4, freeformWidth: 480 })
  assert.deepEqual(win.shownTab(), { bin: 7, nav: null, mode: 'freeform', iconSize: 140 })
  assert.deepEqual([win.get().iconColumns, win.get().freeformWidth], [4, 480])
  assert.deepEqual([ui.get().iconColumns, ui.get().freeformWidth, ui.shownTab()], [1, 0, null])
  // Up and in: inside its own bin only.
  win.navigate(9, 1)
  assert.deepEqual(shownBin(win.get(), tree), { bin: 9, top: 7 })
  assert.equal(ui.get().bin, null)
  win.navigate(7, 1)
  assert.equal(win.shownTab().nav, null)
  // The search typed in a window is the panel's (upstream's one `project_search`).
  win.set({ search: 'beach' })
  assert.equal(ui.get().search, 'beach')
  // Another window's change leaves this one's state object alone.
  const before = win.get()
  ui.instance(ui.openWindow(1, 'list', 110, { reuse: false })).set({ iconColumns: 3 })
  assert.equal(win.get(), before)
  // A docked tab opened from a window is the panel's.
  win.openTab(9, 'list', 110)
  assert.deepEqual(ui.shownTab(), { bin: 9, nav: null, mode: 'list', iconSize: 110 })
})

test('one rename at a time across the panel and its windows (upstream Rename.panel)', () => {
  const ui = createProjectUi()
  const win = ui.instance(ui.openWindow(7, 'list', 110, { reuse: true }))
  ui.set({ rename: { item: 5, bin: null, text: 'Beach' } })
  win.set({ rename: { item: 10, bin: null, text: 'Take 1' } })
  assert.equal(ui.get().rename, null, "the window's rename ends the panel's")
  assert.deepEqual(win.get().rename, { item: 10, bin: null, text: 'Take 1' })
  ui.set({ rename: { item: 5, bin: null, text: 'Beach' } })
  assert.equal(win.get().rename, null, "the panel's ends the window's")
})

test("Open in New Window opens the bin in a window with the panel's view and icon size, or brings its open one back (upstream open_bin)", async () => {
  const { ui, route } = routeOf()
  assert.deepEqual(await route('projectPanel.openBin', { bin: 7, how: 'newWindow' }), { opened: 'window', bin: 7, window: 'bin7' })
  assert.deepEqual(ui.windows().map((each) => [each.id, each.bin, each.mode, each.iconSize]), [['bin7', 7, 'list', 90]])
  assert.equal(ui.get().activeTab, null, 'a window is no docked tab')
  assert.deepEqual(await route('projectPanel.openBin', { bin: 7, how: 'openNewWindow' }), { opened: 'window', bin: 7, window: 'bin7' })
  assert.equal(ui.windows().length, 1)
  await assert.rejects(route('projectPanel.openBin', { bin: 99, how: 'newWindow' }), /no bin 99/)
})

test("Window > New Project Panel opens the project's root in a new window each time, the panel's view at icon size 110 (upstream route newPanel)", async () => {
  const { ui, route } = routeOf()
  assert.equal(route.serves('projectPanel.newPanel'), true)
  assert.deepEqual(await route('projectPanel.newPanel', {}), { window: 'bin1' })
  assert.deepEqual(await route('projectPanel.newPanel', {}), { window: 'bin1-2' })
  assert.deepEqual(ui.windows().map((each) => [each.bin, each.mode, each.iconSize]), [[1, 'list', 110], [1, 'list', 110]])
})

test("keys and the panel's commands act on the focused window: its own view, bin, and items", async () => {
  const ui = createProjectUi()
  const id = ui.openWindow(7, 'list', 110, { reuse: true })
  let focused = binWindowFocus(id)
  const { route, runs, deps } = routeOf({ ui, target: () => binWindowOf(focused) })
  assert.equal(binWindowOf(focused), id)
  assert.equal(focusedPanel(focused), 'project', "a window takes the Project panel's keys")
  assert.equal(focusedPanel('timeline'), 'timeline')
  // View Icon: the window's own view; the engine's (the main panel's) is not set.
  assert.deepEqual(await route('projectPanel.viewIcon', {}), { view: 'icon' })
  assert.equal(ui.instance(id).shownTab().mode, 'icon')
  assert.deepEqual(runs, [])
  // End selects the window's bin's last item.
  assert.deepEqual(await route('projectPanel.moveEnd', {}), { items: [11] })
  assert.deepEqual(runs.at(-1), ['project.select', { items: [11] }])
  // Open in Place from the window goes into its sub-bin; Up comes back to its top and no further.
  await route('projectPanel.openBin', { bin: 9, how: 'inPlace' })
  assert.deepEqual(shownBin(ui.instance(id).get(), tree), { bin: 9, top: 7 })
  assert.deepEqual(await route('projectPanel.up', {}), { bin: 7 })
  assert.deepEqual(await route('projectPanel.up', {}), { bin: 7 })
  // Rename from the window's keys renames in the window.
  await route('projectPanel.rename', { item: 10 })
  assert.deepEqual(ui.instance(id).get().rename, { item: 10, bin: null, text: 'Take 1.mov' })
  assert.equal(ui.get().rename, null)
  // The main panel focused again: its own view and items.
  focused = 'project'
  assert.deepEqual(await route('projectPanel.viewIcon', {}), { view: 'icon' })
  assert.deepEqual(runs.at(-1), ['project.view.set', { view: 'icon' }])
  assert.deepEqual(await visibleItems(deps), { icon: false, items: [5] })
  // A window that closed meanwhile: its keys fall back to the main panel.
  focused = binWindowFocus(id)
  ui.closeWindow(id)
  assert.deepEqual(await route('projectPanel.moveEnd', {}), { items: [5] })
})

test("a window's own change (its width, a rename keystroke) leaves the docked panel's state object alone", () => {
  const ui = createProjectUi()
  const win = ui.instance(ui.openWindow(7, 'freeform', 110, { reuse: true }))
  const panel = ui.get()
  win.set({ freeformWidth: 512, iconColumns: 3 })
  win.set({ rename: { item: 10, bin: null, text: 'T' } })
  win.set({ rename: { item: 10, bin: null, text: 'Ta' } })
  win.setTab({ mode: 'list' })
  win.navigate(9, 1)
  assert.equal(ui.get(), panel)
  // A change of the panel's own (the search) is a new object.
  win.set({ search: 'x' })
  assert.notEqual(ui.get(), panel)
})

test('a closed window leaves no instance behind: opened again, it is a new one', () => {
  const ui = createProjectUi()
  const first = ui.instance(ui.openWindow(7, 'list', 110, { reuse: true }))
  ui.closeWindow('bin7')
  assert.equal(ui.instance('bin7'), ui, 'closed: the panel itself')
  const again = ui.instance(ui.openWindow(7, 'list', 110, { reuse: true }))
  assert.notEqual(again, first)
  ui.pruneWindows({ id: 1, name: 'Sample', children: [] })
  assert.notEqual(ui.instance(ui.openWindow(1, 'list', 110, { reuse: true })), again)
})

test("closeBinTab {window} closes a floating window (upstream's closeBinTab {tab} closes floating tabs too)", async () => {
  const { ui, route } = routeOf()
  await route('projectPanel.newPanel', {})
  assert.equal(await route('projectPanel.closeBinTab', { window: 'bin1' }), null)
  assert.deepEqual(ui.windows(), [])
  await assert.rejects(route('projectPanel.closeBinTab', { window: 'bin1' }), /no such bin window/)
})

test('focus on a window no longer drawn (closed, or hidden by the host) falls back to the Project panel', () => {
  assert.equal(windowFocusFallback('projectBin.bin7', ['bin7']), null)
  assert.equal(windowFocusFallback('projectBin.bin7', []), 'project')
  assert.equal(windowFocusFallback('timeline', []), null)
})

test('the panel and its windows reading the view in one turn share one project.view.get; a later read asks again', async () => {
  const { shareTurnReads } = await import('./sharedRead.ts')
  const asked = []
  const query = shareTurnReads(async (id, params) => (asked.push([id, params]), { id }), new Set(['project.view.get']))
  const answers = await Promise.all([query('project.view.get'), query('project.view.get'), query('project.view.get'), query('project.items', { bin: 7 }), query('project.items', { bin: 7 })])
  assert.deepEqual(asked.map(([id]) => id), ['project.view.get', 'project.items', 'project.items'])
  assert.equal(answers[0], answers[2])
  await query('project.view.get')
  assert.equal(asked.filter(([id]) => id === 'project.view.get').length, 2)
  // With params, never shared.
  await Promise.all([query('project.view.get', { x: 1 }), query('project.view.get', { x: 1 })])
  assert.equal(asked.filter(([id]) => id === 'project.view.get').length, 4)
})
