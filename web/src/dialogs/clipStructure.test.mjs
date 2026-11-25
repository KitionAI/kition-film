// Upstream's clip structure dialogs (Task 12): each one's draft (`defaults()`), its params on OK
// (`finish()`, multicam.rs's OK), its preview kinds, and the ids it draws, against fake engine reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { DIALOGS, dialogDeclarations, dialogSteps, fieldRows } from './registry.ts'
import { addAudioClips, channelFormat, framesTimecode, setChannel, syncParams } from './clipStructure.ts'
import { routeOf } from '../session/invoke.ts'

const film = {
  fps: 24,
  selection: [3, 4],
  activeSequence: 1,
  tracks: [
    { id: 2, kind: 'video', clips: [{ id: 3, item: 8, name: 'bars.mp4', start: 0, duration: 4, speed: 1, reverse: false }] },
    { id: 5, kind: 'audio', clips: [{ id: 4, item: 8, name: 'bars.mp4', start: 0, duration: 4, speed: 1, reverse: false }] },
  ],
}

/** A dialog context whose engine answers `reads` (extras) and `queries` (query commands) by name. */
const context = ({ params = {}, reads = {}, queries = {}, session = null, shown = film } = {}) => {
  const asked = []
  return {
    asked,
    film: shown,
    session,
    params,
    query: async (id, values) => {
      asked.push(['query', id, values])
      return typeof queries[id] === 'function' ? queries[id](values) : (queries[id] ?? null)
    },
    read: async (name, ...args) => {
      asked.push(['read', name, ...args])
      return typeof reads[name] === 'function' ? reads[name](...args) : (reads[name] ?? null)
    },
  }
}
/** An engine whose `dialogDefaults` answers `answers[command]`. */
const engine = (answers) => context({ reads: { dialogDefaults: (command) => answers[command] ?? null } })

const spec = (id) => {
  const found = DIALOGS.get(id)
  assert.ok(found, `${id} is registered`)
  return found
}
const ok = async (id, ctx, change = (draft) => draft) => dialogSteps(spec(id), change(await spec(id).defaults(ctx)), ctx)

test("Nest opens on the engine's next free name, autofocused, and OK sends it", async () => {
  const ctx = engine({ 'clip.nest': { params: { name: 'Nested Sequence 03' }, info: null } })
  assert.deepEqual(await ok('clip.nest', ctx), [{ command: 'clip.nest', params: { name: 'Nested Sequence 03' } }])
  assert.deepEqual(await ok('clip.nest', ctx, (draft) => ({ ...draft, name: 'Nest A' })), [{ command: 'clip.nest', params: { name: 'Nest A' } }])
  const name = fieldRows(spec('clip.nest').layout).find((row) => row.field === 'name')
  assert.equal(name.autoFocus, true, 'ready to type over, as upstream requests focus')
  assert.equal(name.width, 240)
  assert.equal(spec('clip.nest').title, 'Nested Sequence Name')
})

test('Make Subclip sends the name, the frames, and Restrict Trims, never what it only shows', async () => {
  const ctx = engine({ 'clip.makeSubclip': { params: { name: 'bars.mp4.Subclip', startFrame: 12, endFrame: 60, restrictTrims: true }, info: { fps: 24 } } })
  const steps = await ok('clip.makeSubclip', ctx, (draft) => ({ ...draft, startFrame: 24, restrictTrims: false }))
  assert.deepEqual(steps, [{ command: 'clip.makeSubclip', params: { name: 'bars.mp4.Subclip', startFrame: 24, endFrame: 60, restrictTrims: false } }])
  // Each frame field shows its timecode at the media's rate (upstream's `frames`).
  const start = fieldRows(spec('clip.makeSubclip').layout).find((row) => row.field === 'startFrame')
  assert.equal(start.kind, 'frames')
  assert.equal(framesTimecode(48, 24), '00:00:02:00')
  assert.equal(framesTimecode(30 * 61 + 5, 29.97), '00:01:01:05', 'non-drop, at the nominal rate')
  assert.equal(framesTimecode(10, 0), '00:00:00:10', 'no rate: 24, as upstream')
  // Upstream's timecode_base: the rate rounded up (12.3 counts 13 frames a second), three digits from 100.
  assert.equal(framesTimecode(13 * 2 + 5, 12.3), '00:00:02:05')
  assert.equal(framesTimecode(120 * 3 + 7, 119.88), '00:00:03:007')
  assert.equal(framesTimecode(24 * 60, 23.976), '00:01:00:00')
})

test('Edit Subclip sends the subclip, its frames, Restrict Trims, and Convert to Master Clip, and shows its name', async () => {
  const ctx = engine({ 'clip.editSubclip': { params: { item: 21, startFrame: 4, endFrame: 20, restrictTrims: false, convertToMaster: false }, info: { name: 'Short', fps: 25 } } })
  assert.deepEqual(await ok('clip.editSubclip', ctx, (draft) => ({ ...draft, convertToMaster: true })), [{ command: 'clip.editSubclip', params: { item: 21, startFrame: 4, endFrame: 20, restrictTrims: false, convertToMaster: true } }])
  const fields = fieldRows(spec('clip.editSubclip').layout).map((row) => row.field)
  assert.ok(!fields.includes('name'), 'Edit Subclip shows the name, it does not edit it')
  assert.ok(fields.includes('convertToMaster'))
  const shown = spec('clip.editSubclip').layout.find((row) => row.kind === 'readout')
  assert.equal(await shown.value(await spec('clip.editSubclip').defaults(ctx), ctx), 'Short')
})

test("Audio Channels' matrix maps to clips: [[ch]] for project items and to channels: [] for timeline clips", async () => {
  const items = engine({ 'clip.audioChannels': { params: { format: 'stereo', clips: [[0, 1], [2, 3]] }, info: { channels: 4, items: true } } })
  const draft = await spec('clip.audioChannels').defaults(items)
  // Mono: one clip per channel (upstream's AudioChannelMap::for_format), then channel 3 off clip 1.
  const mono = channelFormat(draft, 'mono')
  assert.deepEqual(mono.clips, [[0], [1], [2], [3]])
  const edited = setChannel(mono, 1, 3, true)
  assert.deepEqual(edited.clips, [[0], [1, 3], [2], [3]], 'kept sorted')
  assert.deepEqual(dialogSteps(spec('clip.audioChannels'), edited, items), [{ command: 'clip.audioChannels', params: { format: 'mono', clips: [[0], [1, 3], [2], [3]] } }])
  // Number of Audio Clips adds clips on the next channel (the last one past it) and drops clips from the end.
  assert.deepEqual(addAudioClips({ ...draft, clips: [[0, 1]] }, 3, 4).clips, [[0, 1], [1], [2]])
  assert.deepEqual(addAudioClips({ ...draft, clips: [[0], [1], [2], [3]] }, 2, 4).clips, [[0], [1]])
  assert.deepEqual(addAudioClips({ ...draft, clips: [[0]] }, 3, 2).clips, [[0], [1], [1]], 'never past the last channel')
  assert.deepEqual(channelFormat(draft, '5.1').clips, [[0, 1, 2, 3]])
  assert.deepEqual(channelFormat({ ...draft, info: { channels: 3, items: true } }, 'stereo').clips, [[0, 1], [2]])
  // Timeline clips: the source channels the selected audio clips play.
  const clips = engine({ 'clip.audioChannels': { params: { channels: [0, 1] }, info: { channels: 2, items: false } } })
  const timeline = await spec('clip.audioChannels').defaults(clips)
  const left = setChannel(timeline, 0, 1, false)
  assert.deepEqual(dialogSteps(spec('clip.audioChannels'), left, clips), [{ command: 'clip.audioChannels', params: { channels: [0] } }])
  assert.deepEqual(dialogSteps(spec('clip.audioChannels'), setChannel(left, 0, 1, false), clips)[0].params, { channels: [0] })
  assert.deepEqual(dialogSteps(spec('clip.audioChannels'), setChannel(setChannel(left, 0, 0, false), 0, 1, true), clips)[0].params, { channels: [1] })
})

test("Modify Timecode drops the timecode when Use the file's timecode is checked, as finish() does", async () => {
  const ctx = engine({ 'clip.setTimecode': { params: { timecode: '01:00:00:00', tapeName: 'A001' }, info: null } })
  assert.deepEqual(await ok('clip.setTimecode', ctx), [{ command: 'clip.setTimecode', params: { timecode: '01:00:00:00', tapeName: 'A001' } }])
  assert.deepEqual((await ok('clip.setTimecode', ctx, (draft) => ({ ...draft, reset: true })))[0].params, { tapeName: 'A001', reset: true })
  assert.deepEqual(await spec('clip.setTimecode').defaults(context()), { timecode: '00:00:00:00', tapeName: '' }, "upstream's draft without an item")
})

test('New Offline File drops an empty name, keeps a typed one, and disables the picture fields without video', async () => {
  const offline = { fileName: 'Offline.mov', name: '', tapeName: '', description: '', video: true, audio: true, width: 1920, height: 1080, fps: 24, timecode: '00:00:00:00', seconds: 10 }
  const ctx = engine({ 'item.newOfflineFile': { params: offline, info: null } })
  const { name, ...unnamed } = offline
  assert.deepEqual(await ok('item.newOfflineFile', ctx), [{ command: 'item.newOfflineFile', params: unnamed }])
  assert.equal(name, '')
  assert.deepEqual((await ok('item.newOfflineFile', ctx, (draft) => ({ ...draft, name: 'Lost' })))[0].params, { ...offline, name: 'Lost' })
  const rows = fieldRows(spec('item.newOfflineFile').layout)
  for (const field of ['width', 'height', 'fps']) assert.equal(rows.find((row) => row.field === field).enabled({ video: false }), false, field)
  assert.equal(rows.find((row) => row.field === 'seconds').min, 0.05)
  assert.equal(rows.find((row) => row.field === 'fps').max, 240)
  // Without the engine's answer, upstream's draft on a 1920 × 1080, 24 fps sequence.
  assert.equal((await spec('item.newOfflineFile').defaults(context())).fileName, 'Offline.mov')
})

test('Edit Offline File sends the item and its six fields as drafted', async () => {
  const draft = { item: 30, mediaName: 'Lost', tapeName: 'T1', description: '', scene: '4', shot: '2', logNote: '' }
  const ctx = engine({ 'clip.editOffline': { params: draft, info: null } })
  assert.deepEqual(await ok('clip.editOffline', ctx, (each) => ({ ...each, logNote: 'soft' })), [{ command: 'clip.editOffline', params: { ...draft, logNote: 'soft' } }])
})

const syncDraft = { items: [8, 9], name: '', method: 'audio', ignoreHours: false, marker: '', offset: 0, track: '', removeVideoAudio: false }

test("Synchronize by marker sends marker, drops an empty marker and track, and sends upstream's params exactly (the engine syncs the selection)", async () => {
  const ctx = engine({ 'clip.synchronize': { params: syncDraft, info: { names: ['bars.mp4', 'tone.wav'] } } })
  assert.deepEqual(await ok('clip.synchronize', ctx), [{ command: 'clip.synchronize', params: { method: 'audio', offset: 0, ignoreHours: false } }])
  assert.deepEqual((await ok('clip.synchronize', ctx, (draft) => ({ ...draft, method: 'marker', marker: 'Clap', track: 'A1', offset: -2 })))[0].params, { method: 'marker', offset: -2, ignoreHours: false, marker: 'Clap', track: 'A1' })
  assert.deepEqual(syncParams({ ...syncDraft, method: 'timecode', ignoreHours: true }, false), { method: 'timecode', offset: 0, ignoreHours: true })
  // The preview follows the selection (the default dependsOn), so OK syncs what was previewed.
  assert.equal(spec('clip.synchronize').dependsOn, undefined)
})

test("Merge Clips opens on \"<first> - Merged\" and sends the items, Remove Audio from AV Clip, and the name", async () => {
  const ctx = engine({ 'clip.mergeClips': { params: { ...syncDraft, name: 'bars.mp4 - Merged' }, info: { names: ['bars.mp4', 'tone.wav'] } } })
  assert.deepEqual(await ok('clip.mergeClips', ctx, (draft) => ({ ...draft, method: 'in', removeVideoAudio: true })), [
    { command: 'clip.mergeClips', params: { method: 'in', offset: 0, ignoreHours: false, items: [8, 9], removeVideoAudio: true, name: 'bars.mp4 - Merged' } },
  ])
  assert.ok(!('name' in (await ok('clip.mergeClips', ctx, (draft) => ({ ...draft, name: '' })))[0].params), 'an empty name: the engine names it')
  assert.ok(!('clips' in (await ok('clip.mergeClips', ctx))[0].params), 'Merge names its items, not clips')
  assert.deepEqual(syncParams({ ...syncDraft, name: 'M' }, true), { method: 'audio', offset: 0, ignoreHours: false, items: [8, 9], removeVideoAudio: false, name: 'M' })
})

test('Source Settings only shows the codec and its message: one OK button, nothing to preview', async () => {
  const answer = { item: 8, codec: 'h264', container: 'mp4', settings: [], message: 'H264 has no source settings in Kition Film.' }
  const ctx = context({ queries: { 'clip.sourceSettings': answer } })
  ctx.ask = async (id, values) => (ctx.asked.push(['ask', id, values]), answer)
  const draft = await spec('clip.sourceSettings').defaults(ctx)
  assert.deepEqual(ctx.asked.find((each) => each[1] === 'clip.sourceSettings'), ['ask', 'clip.sourceSettings', {}])
  assert.deepEqual(draft.info, answer)
  assert.deepEqual(spec('clip.sourceSettings').preview, ['none'])
  assert.equal(spec('clip.sourceSettings').hideOk, true)
  assert.equal(spec('clip.sourceSettings').cancelLabel, 'OK', "upstream's one button is OK")
  assert.deepEqual(dialogSteps(spec('clip.sourceSettings'), draft, ctx), [], 'OK runs nothing')
})

test("each clip structure dialog's preview kinds follow the plan's table", () => {
  const ids = ['clip.nest', 'clip.makeSubclip', 'clip.editSubclip', 'clip.audioChannels', 'clip.setTimecode', 'item.newOfflineFile', 'clip.editOffline', 'clip.synchronize', 'clip.mergeClips', 'clip.sourceSettings']
  assert.deepEqual(Object.fromEntries(ids.map((id) => [id, spec(id).preview])), {
    'clip.nest': ['timeline', 'project'],
    'clip.makeSubclip': ['project'],
    'clip.editSubclip': ['project'],
    'clip.audioChannels': ['timeline', 'project'],
    'clip.setTimecode': ['project'],
    'item.newOfflineFile': ['project'],
    'clip.editOffline': ['project'],
    'clip.synchronize': ['timeline'],
    'clip.mergeClips': ['project'],
    'clip.sourceSettings': ['none'],
  })
})

test('the dialogs that open on what the engine read keep their targets: a selection made meanwhile does not move the preview', () => {
  for (const id of ['clip.editSubclip', 'clip.editOffline', 'clip.mergeClips']) assert.deepEqual(spec(id).dependsOn(context()), { sequence: 1 }, id)
})

test("every field upstream's clip structure dialogs register has a declared id standing for it", () => {
  const stands = new Set(dialogDeclarations(DIALOGS).flatMap((item) => item.upstream))
  const fields = [
    ...['video', 'audio', 'restrictTrims', 'convertToMaster', 'reset', 'fileName', 'tapeName', 'description', 'timecode', 'fps', 'startFrame', 'endFrame', 'format.{}', 'count', 'clip.{}.ch.{}', 'clip.0.ch.{}', 'mediaName', 'scene', 'shot', 'logNote', 'ignoreHours', 'marker', 'offset', 'name', 'width', 'height', 'seconds', 'method.{}'].map((key) => `{}.${key}`),
    'sync.track',
    'merge.removeVideoAudio',
  ]
  const known = new Set(upstream.elements.map((element) => element.id))
  assert.deepEqual(fields.filter((id) => !known.has(id)), [], 'every id is upstream\'s')
  assert.deepEqual(fields.filter((id) => !stands.has(id)), [])
})

test('Clip ▸ Rename… starts the Project panel\'s inline rename, and with a name renames at once', () => {
  assert.equal(routeOf('clip.rename', {}, 'project'), 'projectPanel')
  assert.equal(routeOf('clip.rename', { item: 8 }, 'project'), 'projectPanel')
  assert.equal(routeOf('clip.rename', { item: 8, name: 'Take 2' }, 'project'), 'session')
})

test('the dialogs open with no params and run at once with them, as upstream routes them', () => {
  for (const id of ['clip.nest', 'clip.makeSubclip', 'clip.editSubclip', 'clip.audioChannels', 'clip.setTimecode', 'item.newOfflineFile', 'clip.editOffline', 'clip.synchronize', 'clip.mergeClips', 'clip.sourceSettings']) {
    assert.equal(routeOf(id, {}, 'timeline'), 'dialog', id)
  }
  assert.equal(routeOf('clip.nest', { name: 'X' }, 'timeline'), 'session')
  assert.equal(routeOf('clip.mergeClips', { method: 'in' }, 'project'), 'session')
})

test("Source Settings does not open when its query fails: the engine's error goes to the status bar, as upstream's `?`", async () => {
  const ctx = context()
  ctx.ask = async () => {
    throw new Error('select a clip')
  }
  await assert.rejects(spec('clip.sourceSettings').defaults(ctx), /select a clip/)
  // Without a document to ask, it does not open either.
  await assert.rejects(spec('clip.sourceSettings').defaults(context()))
})

test("Source Settings' one button is upstream's OK (sourceSettings.ok, as {}.ok), so it carries control:dialog.ok; About's has no upstream id", () => {
  const declared = Object.fromEntries(dialogDeclarations(DIALOGS).map((item) => [item.id, item.upstream]))
  assert.ok(declared['control:dialog.ok'].includes('{}.ok'))
  assert.equal(spec('clip.sourceSettings').onlyOk, true)
  // Upstream's About is a window closed by its title bar: its one button stays Kition's Close.
  assert.notEqual(spec('help.about').onlyOk, true)
})
