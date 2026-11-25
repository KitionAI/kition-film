// Upstream's Scene Edit Detection, Flash Cue Marker, Update Metadata, Properties, and Project
// Settings dialogs (Task 16, `menu_dialogs.rs` `defaults`, `show`, `run`), and the marker dialog
// a Markers row opens (Premiere's; upstream's panel opens none): their params against upstream's
// `run()` for the same choices, their preview kinds, the ids they draw, the job preview's end on
// Cancel, the summary that never begins a preview, and the safe areas and Source bar markers a
// preview draws, against fake engine reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { describe as describeFilm } from '../film.ts'
import { DIALOGS, changedDraft, dialogDeclarations, dialogSteps, fieldRows, previewDepends, previewSteps, rebaseDraft, shownValue } from './registry.ts'
import { MARKER_COLORS, propertyLines, sourcePreviewMarkers, updateMetadataTargets } from './menu.ts'
import { createPreview } from './preview.ts'
import { routeOf } from '../session/invoke.ts'
import { safeMargins } from '../monitors/model.ts'

const T = 254_016_000_000
const general = { renderer: 'Kition Film GPU Acceleration (wgpu)', videoDisplay: 'Timecode', audioDisplay: 'Audio Samples', captureFormat: 'DV', titleSafe: [20, 20], actionSafe: [10, 10] }
const ingest = { enabled: false, action: 'createProxies', destination: null, preset: '' }
const settings = (tab, current = { ...general, ingest }) => ({
  params: { ...current, tab },
  info: { project: 'Show', ingest: current.ingest, renderers: ['Kition Film GPU Acceleration (wgpu)', 'Kition Film Software Only (CPU)'], videoDisplays: ['Timecode', 'Feet + Frames 35mm', 'Feet + Frames 16mm', 'Frames', 'Audio Samples', 'Seconds'], current },
})
const answers = { 'file.projectSettings.general': settings('general'), 'project.ingestSettings': settings('ingest') }
const markers = [
  { id: 41, start: 2, duration: 0, kind: 'Comment', name: 'Cue', comment: 'note', color: 'Green' },
  { id: 42, start: 5, duration: 1.5, kind: 'Comment', name: '', comment: '', color: 'Iris' },
]
const film = { fps: 24, activeSequence: 1, name: 'Sequence 01', playhead: 5, selection: [7], tracks: [{ id: 2, kind: 'video', clips: [{ id: 7, item: 9, name: 'bars.mp4' }] }], markers, root: { id: 1, name: 'root', children: [{ item: 9, name: 'bars.mp4', type: 'Movie' }, { item: 12, name: 'tone.wav', type: 'Audio' }] } }
const context = ({ reads = answers, on = film, params = {}, command, projectSelection = [], asks = {} } = {}) => ({
  film: on,
  session: { projectSelection },
  params,
  command,
  query: async () => null,
  ask: async (id) => {
    if (!(id in asks)) throw new Error(`no answer for ${id}`)
    if (asks[id] instanceof Error) throw asks[id]
    return asks[id]
  },
  read: async (name, command) => (name === 'dialogDefaults' ? (reads[command] ?? null) : null),
})

const spec = (id) => {
  const found = DIALOGS.get(id)
  assert.ok(found, `${id} is registered`)
  return found
}
const rowsOf = (id) => new Map(fieldRows(spec(id).layout ?? []).map((row) => [row.field, row]))
const setAll = (id, draft, changes, ctx) => changes.reduce((each, [field, value]) => changedDraft(rowsOf(id).get(field), each, value, ctx), draft)
const opened = async (id, ctx = context()) => spec(id).defaults(ctx)
const ok = async (id, changes = [], ctx = context()) => dialogSteps(spec(id), setAll(id, await opened(id, ctx), changes, ctx), ctx)

/** A fake engine that records what it is asked; a job's settle stays pending. */
function fakeEngine() {
  const calls = []
  return {
    calls,
    named: (name) => calls.filter((call) => call[0] === name),
    async invoke(name, ...args) {
      calls.push([name, ...args])
      if (name === 'previewBegin' || name === 'previewBeginSteps') return JSON.stringify({ job: 1, frames: 200 })
      if (name === 'previewSettle') return JSON.stringify({ pending: true, progress: 0.25 })
      if (name === 'previewDiff') return JSON.stringify({ project: { changed: [] } })
      return null
    },
  }
}
function frames() {
  let tasks = []
  return {
    schedule: (task) => {
      tasks.push(task)
      return () => {
        tasks = tasks.filter((each) => each !== task)
      }
    },
    count: () => tasks.length,
    run: async () => {
      const now = tasks
      tasks = []
      for (const task of now) task()
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    },
  }
}

// ---- Scene Edit Detection

test("Scene Edit Detection opens on upstream's draft, OK is Analyze and sends upstream's params, and it previews as a job on the Timeline, the Project panel, and the markers", async () => {
  const scene = spec('clip.sceneEditDetection')
  assert.equal(scene.okLabel, 'Analyze')
  assert.equal(scene.job, true)
  assert.deepEqual([...scene.preview].sort(), ['markers', 'project', 'timeline'])
  const draft = await opened('clip.sceneEditDetection')
  assert.deepEqual(draft, { applyCuts: true, createSubclips: false, generateMarkers: false, sensitivity: 50 })
  const [step] = await ok('clip.sceneEditDetection', [
    ['applyCuts', false],
    ['generateMarkers', true],
    ['createSubclips', true],
    ['sensitivity', 87.5],
  ])
  assert.deepEqual(step, { command: 'clip.sceneEditDetection', params: { applyCuts: false, createSubclips: true, generateMarkers: true, sensitivity: 87.5 } })
  // The slider's range is upstream's 0 to 100.
  const [clamped] = await ok('clip.sceneEditDetection', [['sensitivity', 140]])
  assert.equal(clamped.params.sensitivity, 100)
  // Nothing chosen: nothing previews, and OK still runs for the engine's own refusal.
  const none = setAll('clip.sceneEditDetection', draft, [['applyCuts', false]], context())
  assert.deepEqual(previewSteps(scene, none, context()), [])
  assert.equal(dialogSteps(scene, none, context()).length, 1)
})

test("Scene Edit Detection's job preview settles each animation frame with its progress, and Cancel ends it: previewEnd once, no settle after", async () => {
  const scene = spec('clip.sceneEditDetection')
  const engine = fakeEngine()
  const clock = frames()
  const preview = createPreview({ engine: () => engine, schedule: clock.schedule })
  const handle = preview.handle()
  const draft = setAll('clip.sceneEditDetection', await opened('clip.sceneEditDetection'), [['generateMarkers', true]], context())
  await handle.begin({ kinds: scene.preview, steps: previewSteps(scene, draft, context()), job: scene.job })
  assert.deepEqual(JSON.parse(engine.named('previewBegin')[0][2]), { applyCuts: true, createSubclips: false, generateMarkers: true, sensitivity: 50 })
  assert.equal(preview.get().progress, 0)
  await clock.run()
  await clock.run()
  assert.equal(preview.get().progress, 0.25)
  const settled = engine.named('previewSettle').length
  assert.equal(settled, 2)
  // Cancel (the dialog's end): the job ends with the preview, and nothing settles it again.
  await handle.end()
  assert.equal(engine.named('previewEnd').length, 1)
  assert.equal(preview.get().open, false)
  assert.equal(preview.get().progress, null)
  await clock.run()
  await clock.run()
  assert.equal(engine.named('previewSettle').length, settled)
  assert.equal(clock.count(), 0)
})

// ---- Flash Cue Marker and the marker dialog

test('Flash Cue Marker sends its comment and drops an empty name, as upstream; it previews the marker and follows the playhead', async () => {
  const cue = spec('marker.addFlashCue')
  assert.deepEqual(cue.preview, ['markers'])
  assert.deepEqual(await opened('marker.addFlashCue'), { name: '', comment: '' })
  assert.deepEqual(await ok('marker.addFlashCue', [['comment', 'go']]), [{ command: 'marker.addFlashCue', params: { comment: 'go' } }])
  assert.deepEqual(await ok('marker.addFlashCue', [['name', 'Cue A']]), [{ command: 'marker.addFlashCue', params: { name: 'Cue A', comment: '' } }])
  assert.notDeepEqual(previewDepends(cue, context()), previewDepends(cue, context({ on: { ...film, playhead: 9 } })))
})

test('the marker dialog opens on the marker a Markers row names (or the one at the playhead) and sends marker.edit with its frames', async () => {
  const edit = spec('marker.edit')
  assert.deepEqual(edit.preview, ['markers'])
  assert.equal(routeOf('marker.edit', {}, 'markers'), 'dialog')
  assert.equal(routeOf('marker.edit', { marker: 41 }, 'markers'), 'dialog')
  assert.equal(routeOf('marker.edit', { marker: 41, name: 'X' }, 'markers'), 'session')
  const draft = await opened('marker.edit', context({ params: { marker: 41 } }))
  assert.equal(draft.marker, 41)
  assert.deepEqual([draft.name, draft.comment, draft.color, draft.duration], ['Cue', 'note', 'Green', 0])
  const [step] = await ok(
    'marker.edit',
    [
      ['name', 'Cue 2'],
      ['comment', 'two lines\nhere'],
      ['color', 'Rose'],
      ['duration', 2],
    ],
    context({ params: { marker: 41 } }),
  )
  assert.deepEqual(step, { command: 'marker.edit', params: { marker: 41, name: 'Cue 2', comment: 'two lines\nhere', color: 'Rose', durationFrames: 48 } })
  // No marker named: the one at the playhead (5 s), its own colour listed though the filter's seven lack it.
  const at = await opened('marker.edit')
  assert.equal(at.marker, 42)
  const colors = rowsOf('marker.edit').get('color').options(at, context())
  assert.deepEqual(colors.map(([value]) => value), [...MARKER_COLORS, 'Iris'])
  await assert.rejects(() => opened('marker.edit', context({ on: { ...film, playhead: 3 } })), /no marker at the playhead/)
})

test("the marker dialog rebases on a peer's change to a field left alone, and keeps the one the person changed", async () => {
  const edit = spec('marker.edit')
  assert.equal(edit.rebase, true)
  const ctx = context({ params: { marker: 41 } })
  const draft = setAll('marker.edit', await opened('marker.edit', ctx), [['name', 'Mine']], ctx)
  const peer = context({ params: { marker: 41 }, on: { ...film, markers: [{ ...markers[0], name: 'Theirs', color: 'Blue' }, markers[1]] } })
  const rebased = rebaseDraft(edit, draft, await opened('marker.edit', peer))
  assert.equal(rebased.name, 'Mine')
  assert.equal(rebased.color, 'Blue')
})

// ---- Update Metadata

test('Update Metadata is its own confirmation: a summary of the clips whose XMP it writes, never a preview, and OK sends {}', async () => {
  const update = spec('clip.updateMetadata')
  assert.deepEqual(update.preview, ['summary'])
  assert.notEqual(update.hideOk, true)
  assert.equal(routeOf('clip.updateMetadata', {}, 'project'), 'dialog')
  const ctx = context({ projectSelection: [12, 9] })
  const draft = await opened('clip.updateMetadata', ctx)
  assert.equal(draft.info.count, 2)
  assert.deepEqual(await ok('clip.updateMetadata', [], ctx), [{ command: 'clip.updateMetadata', params: {} }])
  const t = (key, values) => `${key}:${JSON.stringify(values ?? {})}`
  assert.deepEqual(update.summary(draft, ctx, t), ['preview.writesXmp:{"name":"tone.wav"}', 'preview.writesXmp:{"name":"bars.mp4"}'])
  // No Project selection: the timeline's clips' items (upstream's `targets`), each once.
  assert.deepEqual(updateMetadataTargets(context()), [9])
  assert.equal((await opened('clip.updateMetadata', context())).info.count, 1)
  // The preview never begins on the engine.
  const engine = fakeEngine()
  const preview = createPreview({ engine: () => engine, schedule: frames().schedule })
  await preview.handle().begin({ kinds: update.preview, steps: null })
  assert.equal(engine.named('previewBegin').length + engine.named('previewBeginSteps').length, 0)
  assert.equal(preview.get().open, false)
})

// ---- Properties

test("Properties shows upstream's lines for each file, with one Close; File… picks the file through the host first", async () => {
  const properties = spec('file.mediaProperties')
  assert.deepEqual(properties.preview, ['none'])
  assert.match(properties.note, /nothing to preview/)
  assert.equal(properties.hideOk && properties.onlyOk, true)
  assert.equal(properties.cancelLabel, 'Close')
  const info = [{ name: 'bars.mp4', path: 'clips/bars.mp4', type: 'Movie', container: 'mp4', fileSize: 37979, duration: { timecode: '00:00:05:00' }, dataRateKbps: 61, video: { codec: 'h264', width: 320, height: 180, pixelAspectRatio: '1:1', frameRateLabel: '30', pixelFormat: 'yuv420p', color: 'Bt709 / Bt709 / Bt709' }, audio: { codec: 'aac', sampleRate: 48000, channels: 2 } }]
  assert.deepEqual((await opened('file.mediaProperties', context({ asks: { 'file.mediaProperties': info } }))).info, info)
  assert.deepEqual((await opened('file.mediaProperties', context({ params: { properties: info } }))).info, info)
  await assert.rejects(() => opened('file.mediaProperties', context({ asks: { 'file.mediaProperties': new Error('select a clip') } })), /select a clip/)
  const phrase = (text) => text
  assert.deepEqual(propertyLines(info[0], phrase), [
    'File Path: clips/bars.mp4',
    'Type: Movie (mp4)',
    'File Size: 0.04 MB',
    'Total Duration: 00:00:05:00',
    'Average Data Rate: 61 kbit/s',
    'Video: h264 · 320 x 180 (1:1) · 30 fps · yuv420p',
    'Colour: Bt709 / Bt709 / Bt709',
    'Audio: aac · 48000 Hz · 2 channel(s)',
  ])
  // An empty or missing value draws no line (upstream's `line`).
  assert.deepEqual(propertyLines({ name: 'x', path: null, type: 'Still', container: 'png', fileSize: null, duration: { timecode: '00:00:05:00' }, dataRateKbps: null }, phrase), ['Type: Still (png)', 'Total Duration: 00:00:05:00'])
  assert.equal(routeOf('file.mediaPropertiesFile', {}, 'project'), 'fileDialog')
  assert.equal(routeOf('file.mediaPropertiesFile', { path: 'clips/bars.mp4' }, 'project'), 'session')
})

// ---- Project Settings

test('Project Settings opens on the General tab (Ingest Settings… on Ingest) from the engine, and OK sends General then Ingest only when it changed', async () => {
  const projectSettings = spec('file.projectSettings.general')
  assert.equal(DIALOGS.get('project.ingestSettings'), projectSettings)
  assert.deepEqual(projectSettings.preview, ['picture', 'timeline'])
  assert.equal((await opened('file.projectSettings.general', context({ command: 'file.projectSettings.general' }))).tab, 'general')
  assert.equal((await opened('file.projectSettings.general', context({ command: 'project.ingestSettings' }))).tab, 'ingest')
  const steps = await ok('file.projectSettings.general', [
    ['renderer', 'Kition Film Software Only (CPU)'],
    ['videoDisplay', 'Frames'],
    ['audioDisplay', 'Milliseconds'],
    ['captureFormat', 'HDV'],
    ['actionSafe.horizontal', 15],
    ['titleSafe.vertical', 22.5],
  ])
  assert.deepEqual(steps, [
    {
      command: 'file.projectSettings.general',
      params: { renderer: 'Kition Film Software Only (CPU)', videoDisplay: 'Frames', audioDisplay: 'milliseconds', captureFormat: 'HDV', titleSafe: [20, 22.5], actionSafe: [15, 10] },
    },
  ])
  // Upstream sends samples for Audio Samples; the safe areas stay within 0 to 50.
  const [same] = await ok('file.projectSettings.general', [['actionSafe.vertical', 80]])
  assert.equal(same.params.audioDisplay, 'samples')
  assert.deepEqual(same.params.actionSafe, [10, 50])
  const ingestSteps = await ok('file.projectSettings.general', [
    ['ingest.enabled', true],
    ['ingest.action', 'copy'],
  ])
  assert.deepEqual(ingestSteps[1], { command: 'project.ingestSettings', params: { enabled: true, action: 'copy', destination: null, preset: '' } })
  assert.equal(shownValue(rowsOf('file.projectSettings.general').get('titleSafe.horizontal'), await opened('file.projectSettings.general'), context()), 20)
})

test('Project Settings draws no Scratch Disks tab and no ingest destination (local folders, hidden on the web), and rebases on a peer', async () => {
  const projectSettings = spec('file.projectSettings.general')
  const tabs = projectSettings.layout.find((row) => row.kind === 'tabs')
  assert.deepEqual(tabs.tabs.map((tab) => tab.id), ['general', 'ingest'])
  assert.equal(rowsOf('file.projectSettings.general').has('ingest.destination'), false)
  assert.equal(projectSettings.rebase, true)
  const draft = setAll('file.projectSettings.general', await opened('file.projectSettings.general'), [['captureFormat', 'HDV']], context())
  const peer = { ...general, videoDisplay: 'Frames', captureFormat: 'DV' }
  const rebased = rebaseDraft(projectSettings, draft, settings('general', { ...peer, ingest }))
  assert.equal(rebased.videoDisplay, 'Frames')
  assert.equal(rebased.captureFormat, 'HDV')
})

test("the safe margins draw the project's areas (upstream's 90% and 80% by default)", () => {
  const picture = { x: 0, y: 0, width: 200, height: 100 }
  assert.deepEqual(safeMargins(picture), { action: { x: 10, y: 5, width: 180, height: 90 }, title: { x: 20, y: 10, width: 160, height: 80 } })
  assert.deepEqual(safeMargins(picture, { title: [20, 20], action: [15, 10] }).action, { x: 15, y: 5, width: 170, height: 90 })
  const shown = describeFilm({ width: 64, height: 36, canUndo: false, canRedo: false, inspected: { ticksPerSecond: T, project: { name: 'P', safeAreas: { title: [20, 20], action: [15, 12] } } } })
  assert.deepEqual(shown.safeAreas, { title: [20, 20], action: [15, 12] })
  assert.deepEqual(describeFilm({ width: 64, height: 36, canUndo: false, canRedo: false, inspected: { ticksPerSecond: T, project: { name: 'P' } } }).safeAreas, { title: [20, 20], action: [10, 10] })
})

// ---- the Source monitor's bar

test("the Source monitor's bar draws a preview's markers of the item it shows: added and changed outlined; others it leaves to the strip", () => {
  const view = { item: 9, media: 9, markers: [{ start: 2 * T, color: 'Green' }] }
  const diff = {
    markers: {
      added: [
        { id: 70, owner: 9, ownerKind: 'item', start: 1 * T, duration: 0, name: 'Scene Edit', color: 'Green' },
        { id: 71, owner: 33, ownerKind: 'item', start: 3 * T, color: 'Green' },
        { id: 72, owner: 1, ownerKind: 'sequence', sequence: 1, start: 3 * T, color: 'Green' },
      ],
      removed: [{ id: 73, owner: 9, ownerKind: 'item' }],
      changed: [{ id: 74, owner: 9, ownerKind: 'item', start: 4 * T, color: 'Rose', fields: ['color'] }],
    },
  }
  const { markers: drawn, covers } = sourcePreviewMarkers(view, diff)
  assert.deepEqual(drawn, [
    { start: 2 * T, color: 'Green' },
    { start: 1 * T, color: 'Green', mark: 'added' },
    { start: 4 * T, color: 'Rose', mark: 'changed' },
  ])
  assert.equal(covers('markers', diff.markers.added[0]), true)
  assert.equal(covers('markers', diff.markers.added[1]), false, "another item's")
  assert.equal(covers('markers', diff.markers.added[2]), false, "the sequence's (the ruler and the Markers panel draw them)")
  assert.equal(covers('markers', diff.markers.removed[0]), false, 'a removed one has no place on the bar')
  assert.equal(covers('markers', diff.markers.changed[0]), true)
  assert.deepEqual(sourcePreviewMarkers(view, null).markers, view.markers)
})

// ---- routes and ids

test('the dialogs open with no params and run at once with them; Add Chapter Marker stays direct', () => {
  for (const id of ['clip.sceneEditDetection', 'marker.addFlashCue', 'clip.updateMetadata', 'file.mediaProperties', 'file.projectSettings.general', 'project.ingestSettings']) {
    assert.equal(routeOf(id, {}, 'timeline'), 'dialog', id)
  }
  assert.equal(routeOf('clip.sceneEditDetection', { applyCuts: true }, 'timeline'), 'session')
  assert.equal(routeOf('marker.addFlashCue', { name: 'A' }, 'timeline'), 'session')
  assert.equal(routeOf('project.ingestSettings', { enabled: true }, 'project'), 'session')
  assert.equal(routeOf('marker.addChapter', {}, 'timeline'), 'session')
})

test("every field upstream's Scene Edit Detection, Flash Cue Marker, and Project Settings register has a declared id standing for it, the hidden ones aside", () => {
  const stands = new Set(dialogDeclarations(DIALOGS).flatMap((item) => item.upstream))
  const known = upstream.elements.map((element) => element.id).filter((id) => /^(sceneDetect|projectSettings)\./.test(id) || /^\{\}\.(name|comment|applyCuts|createSubclips|generateMarkers)$/.test(id))
  const hidden = known.filter((id) => /^projectSettings\.(scratch\.|tab\.scratchDisks|ingest\.destination)/.test(id))
  assert.equal(known.length, 30)
  assert.equal(hidden.length, 14)
  assert.deepEqual(known.filter((id) => !hidden.includes(id) && !stands.has(id)), [])
  assert.deepEqual(hidden.filter((id) => stands.has(id)), [], 'a hidden field is never declared')
  const ids = new Set(dialogDeclarations(DIALOGS).map((item) => item.id))
  for (const id of [
    'control:dialog.sceneDetect.sensitivity',
    'control:dialog.flashCue.name',
    'control:dialog.flashCue.comment',
    'control:dialog.marker.color',
    'control:dialog.marker.duration',
    'control:dialog.projectSettings.tab.general',
    'control:dialog.projectSettings.tab.ingest',
    'control:dialog.projectSettings.titleSafe.horizontal',
    'control:dialog.projectSettings.actionSafe.vertical',
    'control:dialog.projectSettings.ingest.action',
  ])
    assert.ok(ids.has(id), id)
})
