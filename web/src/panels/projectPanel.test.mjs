// The Project panel's model (upstream `panels/project.rs`, `project_views.rs`): the rows each view
// shows, the search, the fold state, keyboard moves, and the thumbnail times. Run with
// `pnpm --dir web test:unit`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectUi, keptWidths, shownBin, iconRows, itemCount, listRows, matchesSearch, moveSelection, posterTicks, hoverTicks, thumbnailTicks, thumbnailWidth } from './projectModel.ts'

const TPS = 254_016_000_000

/** `project.items {recursive: true}` rows: a Footage bin (with a Selects bin inside) and two loose items. */
const rows = (extra = []) => [
  ...extra,
  { bin: 7, name: 'Footage', depth: 0, items: 3 },
  { bin: 9, name: 'Selects', depth: 1, items: 1 },
  { item: 30, name: 'Take Three.mov', depth: 2, label: 'Violet', cells: { Name: 'Take Three.mov', 'Media Type': 'Movie' } },
  { item: 10, name: 'Beach.MOV', depth: 1, label: 'Iris', cells: { Name: 'Beach.MOV', 'Media Type': 'Movie' } },
  { item: 11, name: 'surf.wav', depth: 1, label: 'Forest', cells: { Name: 'surf.wav', 'Media Type': 'Audio' } },
  { item: 20, name: 'Sequence 01', depth: 0, label: 'Rose', cells: { Name: 'Sequence 01', 'Media Type': 'Sequence' } },
]

const names = (shown) => shown.map((row) => row.name)

test('the search matches names without case, as upstream (an ASCII-lowercased name contains the text)', () => {
  assert.equal(matchesSearch({ name: 'Beach.MOV' }, 'beach'), true)
  assert.equal(matchesSearch({ name: 'Beach.MOV' }, 'H.mo'), true)
  assert.equal(matchesSearch({ name: 'Beach.MOV' }, ''), true)
  assert.equal(matchesSearch({ name: 'Beach.MOV' }, 'surf'), false)
})

test('a search filters the List rows case-insensitively by name, opens every bin, and keeps the bins', () => {
  const ui = createProjectUi()
  // Upstream's `matches_filter` reads the name only: another visible column's text ("Movie") shows nothing by itself.
  assert.deepEqual(names(listRows(rows(), ui.get().expanded, 'MOV')), ['Footage', 'Selects', 'Take Three.mov', 'Beach.MOV'])
  assert.deepEqual(names(listRows(rows(), ui.get().expanded, 'movie')), ['Footage', 'Selects'])
  assert.deepEqual(names(listRows(rows(), ui.get().expanded, 'SEQ')), ['Footage', 'Selects', 'Sequence 01'])
})

test('without a search, folded bins hide what they hold', () => {
  const ui = createProjectUi()
  assert.deepEqual(names(listRows(rows(), ui.get().expanded, '')), ['Footage', 'Sequence 01'])
  ui.toggleBin(7)
  assert.deepEqual(names(listRows(rows(), ui.get().expanded, '')), ['Footage', 'Selects', 'Beach.MOV', 'surf.wav', 'Sequence 01'])
  ui.toggleBin(9)
  assert.deepEqual(names(listRows(rows(), ui.get().expanded, '')), ['Footage', 'Selects', 'Take Three.mov', 'Beach.MOV', 'surf.wav', 'Sequence 01'])
  ui.toggleBin(7)
  assert.deepEqual(names(listRows(rows(), ui.get().expanded, '')), ['Footage', 'Sequence 01'])
})

test('the fold state survives a revision: rows read again (a new bin first) keep the open bins open', () => {
  const ui = createProjectUi()
  ui.toggleBin(7)
  const before = names(listRows(rows(), ui.get().expanded, ''))
  // The next revision's rows: a new bin sorts before Footage, so every row moved.
  const next = rows([{ bin: 5, name: 'Audio', depth: 0, items: 0 }])
  assert.deepEqual(names(listRows(next, ui.get().expanded, '')), ['Audio', ...before])
  assert.equal(ui.get().expanded.has(7), true)
})

test('the Icon view shows the bin\'s own bins and items, and with a search every matching item under it', () => {
  const icon = [
    { bin: 7, name: 'Footage', depth: 0, items: 3 },
    { item: 30, name: 'Take Three.mov', depth: 0, direct: false },
    { item: 20, name: 'Sequence 01', depth: 0, direct: true },
    { item: 10, name: 'Beach.MOV', depth: 0, direct: false },
  ]
  assert.deepEqual(names(iconRows(icon, '')), ['Footage', 'Sequence 01'])
  assert.deepEqual(names(iconRows(icon, '.MOV')), ['Take Three.mov', 'Beach.MOV'])
  assert.equal(itemCount(icon), 3)
  assert.equal(itemCount(rows()), 4)
})

test('keyboard moves follow upstream: a column at a time in the Icon view, clamped, Shift extends from the anchor', () => {
  const items = [1, 2, 3, 4, 5, 6, 7]
  assert.deepEqual(moveSelection('moveDown', items, [], 1), [1])
  assert.deepEqual(moveSelection('moveUp', items, [], 1), [7])
  assert.deepEqual(moveSelection('moveDown', items, [2], 1), [3])
  assert.deepEqual(moveSelection('moveDown', items, [2], 3), [5])
  assert.deepEqual(moveSelection('moveRight', items, [2], 1, false), [2])
  assert.deepEqual(moveSelection('moveRight', items, [2], 3, true), [3])
  assert.deepEqual(moveSelection('moveEnd', items, [2], 1), [7])
  assert.deepEqual(moveSelection('moveHome', items, [5], 1), [1])
  assert.deepEqual(moveSelection('movePageDown', items, [1], 1), [7])
  assert.deepEqual(moveSelection('extendDown', items, [2, 3], 1), [2, 3, 4])
  assert.deepEqual(moveSelection('extendUp', items, [4], 1), [4, 3])
})

test('thumbnail times and widths: exact poster or a quantized default; drawn width × scale, capped', () => {
  assert.equal(posterTicks({ duration: 10 * TPS, poster: null }), 3 * TPS)
  assert.equal(posterTicks({ duration: 10 * TPS, poster: 2.6 * TPS }), 2.6 * TPS)
  const frame = TPS / 24
  assert.equal(hoverTicks({ duration: 10 * TPS, frame }, 0.5), 5 * TPS)
  assert.equal(hoverTicks({ duration: 10 * TPS, frame }, 1), 10 * TPS - frame)
  assert.equal(hoverTicks({ duration: 10 * TPS, frame }, -1), 0)
  assert.equal(thumbnailWidth(110, 2), 224)
  assert.equal(thumbnailWidth(40, 1), 96)
  assert.equal(thumbnailWidth(400, 2), 640)
})

test('subclip thumbnail defaults and scrubbing stay within a short absolute source range', () => {
  const frame = TPS / 24
  const row = { start: 13 * frame, duration: 4 * frame, frame }
  assert.equal(posterTicks(row), row.start)
  assert.equal(hoverTicks(row, 0), 13 * frame)
  assert.equal(hoverTicks(row, 0.5), 15 * frame)
  assert.equal(hoverTicks(row, 1), 16 * frame)
  for (const fraction of [0, 0.1, 0.5, 1]) {
    const time = thumbnailTicks(row, hoverTicks(row, fraction))
    assert.ok(time >= 13 * frame && time <= 16 * frame)
  }
  assert.equal(posterTicks({ ...row, poster: 0 }), 13 * frame)
  assert.equal(posterTicks({ ...row, poster: 24 * frame }), 16 * frame)
  assert.equal(posterTicks({ ...row, duration: 0 }), row.start)
})

test('a shown bin that no longer exists falls back as upstream view_of: the tab\'s own bin, else the root', () => {
  // Root 1 holds bin 7, which holds bin 9.
  const tree = { id: 1, name: 'Sample', children: [{ id: 7, name: 'Footage', children: [{ id: 9, name: 'Selects', children: [] }] }] }
  const ui = createProjectUi()
  ui.navigate(9, 1)
  assert.deepEqual(shownBin(ui.get(), tree), { bin: 9, top: 1 })
  // Bin 9 is gone (its creation undone): the panel shows the root, and Import goes there.
  const without9 = { ...tree, children: [{ id: 7, name: 'Footage', children: [] }] }
  assert.deepEqual(shownBin(ui.get(), without9), { bin: 1, top: 1 })
  // A tab of bin 7 navigated into 9: 9 gone shows 7; 7 gone shows the root.
  ui.openTab(7, 'list', 110)
  ui.navigate(9, 1)
  assert.deepEqual(shownBin(ui.get(), tree), { bin: 9, top: 7 })
  assert.deepEqual(shownBin(ui.get(), without9), { bin: 7, top: 7 })
  assert.deepEqual(shownBin(ui.get(), { ...tree, children: [] }), { bin: 1, top: 1 })
})

test('a column width resized locally gives way once the engine reads back within half a point (it keeps f32), or its column goes', () => {
  const local = { Name: 123.3, Label: 140 }
  // The engine took Name (123.3 as f32) and has not seen Label's width yet; Frame Rate is gone.
  assert.deepEqual(keptWidths(local, [{ name: 'Name', width: 123.30000305175781 }, { name: 'Label', width: 100 }]), { Label: 140 })
  assert.deepEqual(keptWidths({ Gone: 90 }, [{ name: 'Name', width: 200 }]), {})
  const same = { Label: 140 }
  assert.equal(keptWidths(same, [{ name: 'Label', width: 100 }]), same, 'unchanged: the same object')
})

test("Reveal in Project as upstream's reveal_in_project: the List view opens the bins on the way, the Icon view shows the bin holding the item", () => {
  const root = { id: 1, name: 'Project', children: [{ item: 2, name: 'a' }, { id: 3, name: 'Outer', children: [{ id: 4, name: 'Inner', children: [{ item: 5, name: 'deep' }] }] }] }
  const ui = createProjectUi()
  ui.set({ search: 'zzz', activeTab: 0, tabs: [{ bin: 3, nav: null, mode: 'list', iconSize: 64 }], selectedBin: 4 })
  ui.reveal(5, root, true)
  assert.deepEqual([...ui.get().expanded].sort(), [3, 4])
  assert.equal(ui.get().bin, null)
  assert.equal(ui.get().activeTab, null, 'the panel itself, not a bin tab')
  assert.equal(ui.get().selectedBin, null)
  assert.equal(ui.get().search, '')
  ui.reveal(5, root, false)
  assert.equal(ui.get().bin, 4, 'the Icon view goes into the bin that holds it')
  ui.reveal(2, root, false)
  assert.equal(ui.get().bin, null, 'an item at the top shows the top')
  ui.reveal(99, root, false)
  assert.equal(ui.get().bin, null, 'an item no bin holds shows the top')
})
