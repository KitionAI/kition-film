// Upstream's Find, Create Search Bin, and Automate To Sequence dialogs (Task 15, `menu_dialogs.rs`):
// their params against upstream's `run()` for the same choices, their preview kinds, the ids they
// draw, Find's highlight of every match (not only the one the copy selects), the search bins the
// Project panel lists, and Open Search and Select Find Box, against fake engine reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { describe as describeFilm } from '../film.ts'
import { DIALOGS, changedDraft, dialogDeclarations, dialogSteps, fieldRows, previewSteps, shownValue } from './registry.ts'
import { FIND_COLUMNS, FIND_OPERATORS, findLines, findMatches } from './find.ts'
import { createPreview, previewNames } from './preview.ts'
import { highlightsOnly, previewTimeline } from './previewViews.ts'
import { previewProjectSelection, previewSearchBins, searchBinMatches, searchBinsShown } from '../panels/projectPreview.ts'
import { routeOf } from '../session/invoke.ts'
import { createWorkspaceRoute } from '../workspace/route.ts'
import { FILM_WORKSPACES } from '../workspace/presets.ts'

const blank = { column: 'Name', operator: 'contains', text: '' }
const answers = {
  'edit.find': { params: { scope: 'project', rows: [{ column: 'Media Type', operator: 'beginsWith', text: 'Aud' }, blank], matchAll: true, caseSensitive: false, in: 'all' }, info: {} },
  'clip.automateToSequence': {
    params: { ordering: 'sort', placement: 'sequentially', method: 'insert', overlapFrames: 30, stillFrames: 150, videoTransition: true, audioTransition: true, ignoreAudio: false, ignoreVideo: false },
    info: { sequence: 'Sequence 01' },
  },
}
const film = { fps: 24, activeSequence: 1, name: 'Sequence 01', playhead: 0, selection: [], tracks: [] }
const context = ({ reads = answers, on = film, focused = 'project', projectSearch = '' } = {}) => ({ film: on, session: { projectSelection: [4, 5] }, params: {}, query: async () => null, read: async (name, command) => (name === 'dialogDefaults' ? (reads[command] ?? null) : null), focused, projectSearch })

const spec = (id) => {
  const found = DIALOGS.get(id)
  assert.ok(found, `${id} is registered`)
  return found
}
const rowsOf = (id) => new Map(fieldRows(spec(id).layout).map((row) => [row.field, row]))
const setAll = (id, draft, changes, ctx) => changes.reduce((each, [field, value]) => changedDraft(rowsOf(id).get(field), each, value, ctx), draft)
const opened = (id, ctx = context()) => Promise.resolve(spec(id).defaults(ctx))
const ok = async (id, changes = [], ctx = context()) => dialogSteps(spec(id), setAll(id, await opened(id, ctx), changes, ctx), ctx)

test("Find's two rows with Match Any send upstream's params; the Timeline sends only the first row", async () => {
  const [step] = await ok('edit.find', [
    ['row.0.column', 'Name'],
    ['row.0.operator', 'contains'],
    ['row.0.text', 'tone'],
    ['row.1.column', 'Label'],
    ['row.1.operator', 'matches'],
    ['row.1.text', 'Iris'],
    ['match', 'any'],
    ['caseSensitive', true],
  ])
  assert.deepEqual(step, {
    command: 'edit.find',
    params: {
      scope: 'project',
      rows: [
        { column: 'Name', operator: 'contains', text: 'tone' },
        { column: 'Label', operator: 'matches', text: 'Iris' },
      ],
      matchAll: false,
      caseSensitive: true,
      in: 'all',
    },
  })
  const [timeline] = await ok('edit.find', [['scope', 'timeline'], ['row.0.text', 'city'], ['in', 'markers']])
  assert.deepEqual(timeline.params, { scope: 'timeline', rows: [{ column: 'Media Type', operator: 'beginsWith', text: 'city' }], matchAll: true, caseSensitive: false, in: 'markers' })
  // The Match radios show the draft's matchAll.
  const draft = setAll('edit.find', await opened('edit.find'), [['match', 'any']], context())
  assert.equal(draft.matchAll, false)
  assert.equal(shownValue(rowsOf('edit.find').get('match'), draft, context()), 'any')
})

test('Find opens on the last project rows, on the Timeline only with the Timeline focused and a sequence open', async () => {
  const draft = await opened('edit.find')
  assert.equal(draft.scope, 'project')
  assert.deepEqual(draft.rows, answers['edit.find'].params.rows)
  assert.equal((await opened('edit.find', context({ focused: 'timeline' }))).scope, 'timeline')
  assert.equal((await opened('edit.find', context({ focused: 'timeline', on: { ...film, activeSequence: null } }))).scope, 'project')
  // Without the engine: two blank rows.
  assert.deepEqual((await opened('edit.find', context({ reads: {} }))).rows, [blank, blank])
})

test("Find with no text previews nothing, and OK still runs it for the engine's error; it stays open with Find and Done", async () => {
  const ctx = context({ reads: {} })
  const draft = await opened('edit.find', ctx)
  assert.deepEqual(previewSteps(spec('edit.find'), draft, ctx), [])
  assert.equal(dialogSteps(spec('edit.find'), draft, ctx).length, 1)
  const typed = setAll('edit.find', draft, [['row.1.text', 'x']], ctx)
  assert.equal(previewSteps(spec('edit.find'), typed, ctx).length, 1, 'the second row has text')
  // In the Timeline only the first row counts.
  assert.deepEqual(previewSteps(spec('edit.find'), { ...typed, scope: 'timeline' }, ctx), [])
  const find = spec('edit.find')
  assert.deepEqual([find.keepOpen, find.okLabel, find.cancelLabel, find.preview], [true, 'Find', 'Done', ['selection']])
  // No match is the preview's answer, shown in the strip, not a failed preview that turns it off.
  assert.equal(find.quietError('no matches'), true)
  assert.equal(find.quietError('command `edit.find` failed: `scope` is project or timeline'), false)
})

test("Find's strip says upstream's Match n of total, and its highlight is every match of the answer", () => {
  const t = (key, values) => `${key}:${JSON.stringify(values)}`
  assert.deepEqual(findLines({ item: 4, matches: 3, index: 0, items: [4, 5, 6] }, t), ['preview.findMatch:{"n":1,"total":3}'])
  assert.deepEqual(findLines(null, t), [])
  assert.deepEqual(findMatches({ item: 4, matches: 3, index: 0, items: [4, 5, 6] }), { items: [4, 5, 6], clips: [], markers: [] })
  assert.deepEqual(findMatches({ clip: 9, matches: 2, index: 0, clips: [9, 10], markers: [] }), { items: [], clips: [9, 10], markers: [] })
})

test('the preview publishes the highlight of its answer, and closing drops it', async () => {
  const engine = {
    async invoke(name) {
      if (name === 'previewBegin') return JSON.stringify({ item: 4, matches: 2, index: 0, items: [4, 6] })
      if (name === 'previewDiff') return JSON.stringify({ projectSelection: { added: [{ id: 4 }], removed: [] } })
      return null
    },
  }
  const preview = createPreview({ engine: () => engine, schedule: (task) => (task(), () => undefined) })
  const handle = preview.handle()
  await handle.begin({ kinds: ['selection'], steps: [{ command: 'edit.find', params: {} }], highlight: findMatches })
  assert.deepEqual(preview.get().highlight, { items: [4, 6], clips: [], markers: [] })
  await handle.end()
  assert.equal(preview.get().highlight, null)
})

test('the Project panel highlights every match, an already selected one too; the real selection is unchanged', () => {
  // Item 4 is selected already, so the diff selects only nothing new; Find matched 4 and 6.
  const diff = { projectSelection: { added: [], removed: [] } }
  assert.deepEqual([...previewProjectSelection([4], diff, [4, 6])].sort(), [4, 6])
  assert.deepEqual([...previewProjectSelection([4], diff)], [4], 'without a highlight: the diff on the document')
})

test('the Timeline highlights every clip and marker Find matched, where the copy selects only the first', () => {
  const T = 254_016_000_000
  const film = (selection) =>
    describeFilm({
      width: 1920,
      height: 1080,
      canUndo: false,
      canRedo: false,
      inspected: {
        ticksPerSecond: T,
        playhead: 0,
        project: { name: 'P', activeSequence: 50, root: { id: 1, name: 'root', children: [] } },
        sequence: {
          name: 'S',
          duration: 4 * T,
          video: [{ id: 1, name: 'V1', items: [9, 10].map((clip, k) => ({ clip, item: 8, name: 'city', start: k * 2 * T, duration: 2 * T, sourceIn: 0, sourceOut: 2 * T, speed: 1 })) }],
          audio: [],
          selection,
          markers: [{ id: 30, start: T, duration: 0, kind: 'Comment', name: 'city hall', comment: '', color: 'Green' }],
        },
      },
    })
  const view = previewTimeline(film([]), film([9]), { selection: { added: [{ id: 9 }], removed: [] } }, ['selection'], { highlight: { clips: [9, 10], markers: [30] } })
  assert.deepEqual([...view.selected].sort((a, b) => a - b), [9, 10])
  assert.deepEqual([...view.selectedMarkers], [30])
  // A preview that only highlights reads no copy: the document itself, with the highlight.
  assert.equal(highlightsOnly(['selection'], { clips: [9, 10] }), true)
  assert.equal(highlightsOnly(['selection'], null), false)
  assert.equal(highlightsOnly(['selection', 'timeline'], { clips: [9] }), false)
  const own = previewTimeline(film([]), film([]), null, ['selection'], { highlight: { clips: [9, 10], markers: [30] } })
  assert.deepEqual([...own.selected].sort((a, b) => a - b), [9, 10])
  assert.equal(own.film.selection.length, 0, 'the real selection is drawn as it is')
  const plain = previewTimeline(film([]), film([9]), null, ['selection'])
  assert.deepEqual([...plain.selected], [9])
  assert.equal(plain.selectedMarkers, null)
})

test('Create Search Bin opens on the Project search, sends its name as upstream (an empty one too), and previews nothing without text', async () => {
  const ctx = context({ projectSearch: 'tone' })
  const draft = await opened('file.newSearchBin', ctx)
  assert.deepEqual(draft, { name: '', column: 'All', operator: 'contains', text: 'tone' })
  assert.deepEqual(await ok('file.newSearchBin', [['column', 'Media Type'], ['text', 'Audio']], ctx), [{ command: 'file.newSearchBin', params: { name: '', column: 'Media Type', operator: 'contains', text: 'Audio' } }])
  assert.deepEqual((await ok('file.newSearchBin', [['name', 'Sounds']], ctx))[0].params, { name: 'Sounds', column: 'All', operator: 'contains', text: 'tone' })
  const empty = await opened('file.newSearchBin', context())
  assert.deepEqual(previewSteps(spec('file.newSearchBin'), empty, context()), [])
  assert.equal(dialogSteps(spec('file.newSearchBin'), empty, context()).length, 1, "OK runs it, for the engine's error")
  assert.deepEqual(spec('file.newSearchBin').preview, ['project'])
  // The lists are upstream's columns and operators.
  assert.deepEqual(rowsOf('file.newSearchBin').get('column').options.map(([value]) => value), [...FIND_COLUMNS])
  assert.deepEqual(rowsOf('file.newSearchBin').get('operator').options, FIND_OPERATORS)
})

test("Automate's ordering, placement, and method map to upstream's values, its frames are whole", async () => {
  const draft = await opened('clip.automateToSequence')
  assert.equal(draft.info.sequence, 'Sequence 01')
  // "To <sequence>": a plain label, empty without a sequence (upstream's info is null then).
  const to = spec('clip.automateToSequence').layout.find((row) => row.kind === 'readout')
  assert.equal(to.plain, true)
  assert.equal(to.value(draft, context()), 'Sequence 01')
  assert.equal(to.value({ ...draft, info: { sequence: null } }, context()), '')
  // Clip Overlap and Frames per Still are as wide as each other.
  const frames = rowsOf('clip.automateToSequence')
  assert.ok(frames.get('overlapFrames').width > 0)
  assert.equal(frames.get('overlapFrames').width, frames.get('stillFrames').width)
  const [step] = await ok('clip.automateToSequence', [
    ['ordering', 'selection'],
    ['placement', 'unnumberedMarkers'],
    ['method', 'overwrite'],
    ['overlapFrames', 12.4],
    ['stillFrames', 0],
    ['audioTransition', false],
    ['ignoreVideo', true],
  ])
  assert.deepEqual(step, {
    command: 'clip.automateToSequence',
    params: { ordering: 'selection', placement: 'unnumberedMarkers', method: 'overwrite', overlapFrames: 12, stillFrames: 1, videoTransition: true, audioTransition: false, ignoreAudio: false, ignoreVideo: true },
  })
  // Opened as upstream's defaults, OK sends them as they are.
  assert.deepEqual((await ok('clip.automateToSequence'))[0].params, answers['clip.automateToSequence'].params)
  const rows = rowsOf('clip.automateToSequence')
  assert.deepEqual(rows.get('ordering').options.map(([value]) => value), ['sort', 'selection'])
  assert.deepEqual(rows.get('placement').options.map(([value]) => value), ['sequentially', 'unnumberedMarkers'])
  assert.deepEqual(rows.get('method').options.map(([value]) => value), ['insert', 'overwrite'])
  assert.deepEqual(spec('clip.automateToSequence').preview, ['timeline'])
  // Its preview follows the Project selection and the playhead, where it places.
  const follows = spec('clip.automateToSequence').dependsOn
  assert.notDeepEqual(follows(context()), follows({ ...context(), film: { ...film, playhead: 2 } }))
})

test('the dialogs open with no params and run at once with them', () => {
  for (const id of ['edit.find', 'file.newSearchBin', 'clip.automateToSequence']) {
    assert.equal(routeOf(id, {}, 'project'), 'dialog', id)
    assert.equal(routeOf(id, { text: 'x' }, 'project'), 'session', id)
  }
})

test("every field upstream's Find, Create Search Bin, and Automate To Sequence register has a declared id standing for it", () => {
  const stands = new Set(dialogDeclarations(DIALOGS).flatMap((item) => item.upstream))
  const known = upstream.elements
    .map((element) => element.id)
    .filter((id) => /^(find|searchBin)\./.test(id) || /^\{\}\.(scope\.\{\}|caseSensitive|in\.\{\}|text|ordering\.\{\}|placement\.\{\}|method\.\{\}|overlapFrames|stillFrames|videoTransition|audioTransition|ignoreAudio|ignoreVideo|name)$/.test(id))
  assert.equal(known.length, 22)
  assert.deepEqual(known.filter((id) => !stands.has(id)), [])
  const ids = new Set(dialogDeclarations(DIALOGS).map((item) => item.id))
  for (const id of ['control:dialog.find.scope.timeline', 'control:dialog.find.match.any', 'control:dialog.find.row.1.operator', 'control:dialog.find.in.markers', 'control:dialog.searchBin.column', 'control:dialog.automate.method.overwrite', 'control:dialog.automate.overlapFrames']) assert.ok(ids.has(id), id)
})

test("a search bin's rows are its items' own row objects (memoized rows draw again only where they change)", () => {
  const five = { item: 5, name: 'Tone', depth: 0 }
  const six = { item: 6, name: 'Room', depth: 2 }
  const byItem = new Map([[5, five], [6, six]])
  const rows = searchBinMatches({ bin: 41, name: 'Audio', items: [6, 7, 5] }, byItem)
  assert.equal(rows[0], six)
  assert.equal(rows[1], five)
  assert.equal(rows.length, 2, 'an item the List view does not list is left out')
})

test('the search bins are read only while the List view shows the project root of the main panel', () => {
  assert.equal(searchBinsShown({ mode: 'list', tab: false, bin: null, root: 1 }), true)
  assert.equal(searchBinsShown({ mode: 'list', tab: false, bin: 1, root: 1 }), true)
  assert.equal(searchBinsShown({ mode: 'icon', tab: false, bin: null, root: 1 }), false)
  assert.equal(searchBinsShown({ mode: 'list', tab: true, bin: null, root: 1 }), false)
  assert.equal(searchBinsShown({ mode: 'list', tab: false, bin: 7, root: 1 }), false)
  // inspect() carries no search bins (they are read apart, once per revision).
  const film = describeFilm({ width: 1, height: 1, canUndo: false, canRedo: false, inspected: { project: { name: 'P', root: { id: 1, name: 'P', children: [] } }, sequence: null } })
  assert.equal('searchBins' in film, false)
})

test('the List view lists the search bins, then one only the preview has, marked added', () => {
  const kept = [{ bin: 40, name: 'Movies', items: [4] }]
  assert.equal(previewSearchBins(kept, null), kept)
  assert.deepEqual(previewSearchBins(kept, [{ bin: 41, name: 'Audio', items: [5, 6] }]), [kept[0], { bin: 41, name: 'Audio', items: [5, 6], mark: 'added' }])
  assert.equal(previewSearchBins(kept, [{ bin: 41, name: 'Audio', items: [] }])[0], kept[0], 'the document\'s own object')
})

test("the strip names a search bin only the preview has (the Icon view lists no search bins)", () => {
  const names = previewNames({ project: { root: { id: 1, name: 'P', children: [] } } }, { project: { root: { id: 1, name: 'P', children: [] } } }, { searchBins: [{ bin: 41, name: 'Audio', items: [5] }] })
  assert.equal(names.bin(41), 'Audio')
})

test("Open Search shows the Project panel and focuses its search; Select Find Box focuses the focused panel's", () => {
  const s = { tree: FILM_WORKSPACES.Editing, focused: 'timeline', searched: [] }
  const route = createWorkspaceRoute({
    workspaces: () => null,
    tree: () => s.tree,
    setTree: (tree) => (s.tree = tree),
    focused: () => s.focused,
    setFocused: (panel) => (s.focused = panel),
    maximized: () => null,
    setMaximized: () => undefined,
    underCursor: () => null,
    dialog: () => undefined,
    focusSearch: (panel) => s.searched.push(panel),
  })
  assert.deepEqual(route('panel.selectFindBox', {}), { panel: 'Timeline' })
  assert.deepEqual(route('window.openSearch', {}), { panel: 'Project' })
  assert.equal(s.focused, 'project')
  assert.deepEqual(s.searched, ['timeline', 'project'])
  assert.ok(route.serves('window.openSearch') && route.serves('panel.selectFindBox'))
  for (const id of ['window.openSearch', 'panel.selectFindBox']) assert.equal(routeOf(id, {}, 'project'), 'workspace', id)
})
