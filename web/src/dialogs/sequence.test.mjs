// Upstream's sequence dialogs (Task 13): Sequence Settings' `changes()`, New Sequence's two
// steps, Color Management's params, their preview kinds, and the ids they draw, against fake
// engine reads (`dialogDefaults`, as `bindings/wasm/src/dialogs.rs` answers it).
import test from 'node:test'
import assert from 'node:assert/strict'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { DIALOGS, changedDraft, dialogDeclarations, dialogSteps, fieldRows, optionText, rebaseDraft, sequenceGone, shownValue } from './registry.ts'
import { aspect, displayFormat, newSequenceSteps, parLabel, rateLabel, sequenceChanges, supportsDropFrame, timecodeFormats } from './sequence.ts'
import { routeOf } from '../session/invoke.ts'

const TIMEBASES = [
  [10, 1], [12, 1], [25, 2], [15, 1], [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48, 1], [50, 1], [60000, 1001], [60, 1], [120000, 1001], [120, 1],
].map(([num, den]) => ({ num, den, label: rateLabel({ num, den }), dropFrame: supportsDropFrame({ num, den }) }))
const SPACES = [['rec709', 'Rec. 709'], ['rec2100-pq', 'Rec. 2100 PQ'], ['rec2100-hlg', 'Rec. 2100 HLG']]

/** The active sequence as `dialogDefaults` reads it: 1920 × 1080 at 23.976, stereo at 48 kHz, named "Sequence 01". */
const current = { name: 'Sequence 01', fpsNum: 24000, fpsDen: 1001, width: 1920, height: 1080, dropFrame: false, mix: 'Stereo', sampleRate: 48000, maxRenderQuality: false, workingSpace: 'rec709', wideGamut: false, autoToneMap: true }
const info = (keys = current) => ({ current: keys, par: [1, 1], previewCodec: 'ProRes 422', maxBitDepth: false, audioDisplaySamples: true, timebases: TIMEBASES, workingSpaces: SPACES })
const draftOf = (keys, newSequence) => ({ tab: 'general', ...keys, newSequence, video: 3, audio: 3, scaleMotion: true })
const answers = {
  'sequence.settings': { params: draftOf(current, false), info: info() },
  'file.newSequence': { params: draftOf({ ...current, name: 'Sequence 02' }, true), info: info({ ...current, name: '' }) },
  'sequence.colorSettings': { params: { workingSpace: 'rec709', wideGamut: false, autoToneMap: true }, info: { workingSpaces: SPACES } },
}
const film = { fps: 24000 / 1001, activeSequence: 1, selection: [], tracks: [] }
const context = (reads = answers) => ({ film, session: null, params: {}, query: async () => null, read: async (name, command) => (name === 'dialogDefaults' ? (reads[command] ?? null) : null) })

const spec = (id) => {
  const found = DIALOGS.get(id)
  assert.ok(found, `${id} is registered`)
  return found
}
/** Every editable row of a dialog, by field. */
const rowsOf = (id) => new Map(fieldRows(spec(id).layout).map((row) => [row.field, row]))
/** The draft after setting each `[field, value]` through its row, as `fields.tsx` does. */
const setAll = (id, draft, changes, ctx) => changes.reduce((each, [field, value]) => changedDraft(rowsOf(id).get(field), each, value, ctx), draft)
const ok = async (id, changes = [], ctx = context()) => {
  const draft = setAll(id, await spec(id).defaults(ctx), changes, ctx)
  return dialogSteps(spec(id), draft, ctx)
}

test('Sequence Settings sends only what changed (changes()), and nothing at all when nothing did', async () => {
  assert.deepEqual(await ok('sequence.settings'), [], 'opened and OK: no command, no undo step')
  assert.deepEqual(await ok('sequence.settings', [['width', 1280], ['height', 720], ['maxRenderQuality', true]]), [{ command: 'sequence.settings', params: { width: 1280, height: 720, scaleMotion: true, maxRenderQuality: true } }])
  // Scale Motion travels only with a new frame size, as the box says.
  assert.deepEqual(await ok('sequence.settings', [['scaleMotion', false]]), [])
  assert.deepEqual(await ok('sequence.settings', [['width', 1080], ['scaleMotion', false]]), [{ command: 'sequence.settings', params: { width: 1080, height: 1080, scaleMotion: false } }])
  // The name travels when it changed; blank, or unchanged after trimming, it does not.
  assert.deepEqual(await ok('sequence.settings', [['name', '  Rough Cut  ']]), [{ command: 'sequence.settings', params: { name: 'Rough Cut' } }])
  assert.deepEqual(await ok('sequence.settings', [['name', '   ']]), [])
  assert.deepEqual(await ok('sequence.settings', [['name', ' Sequence 01 ']]), [])
  // The colour tab's three, each only when changed.
  assert.deepEqual(await ok('sequence.settings', [['workingSpace', 'rec2100-pq'], ['autoToneMap', false]]), [{ command: 'sequence.settings', params: { workingSpace: 'rec2100-pq', autoToneMap: false } }])
})

test('a 5.1 channel format sends mix "5.1", and a new sample rate its number', async () => {
  assert.deepEqual(await ok('sequence.settings', [['channelFormat', '5.1']]), [{ command: 'sequence.settings', params: { mix: '5.1' } }])
  assert.deepEqual(await ok('sequence.settings', [['sampleRate', '44100']]), [{ command: 'sequence.settings', params: { sampleRate: 44100 } }])
  const draft = setAll('sequence.settings', await spec('sequence.settings').defaults(context()), [['channelFormat', '5.1']], context())
  assert.equal(rowsOf('sequence.settings').get('channels').text(draft), '6', 'Number of Channels follows the format')
})

test('a new timebase starts on its usual timecode, and drop-frame only travels for a rate that has it', async () => {
  const ctx = context()
  const opened = await spec('sequence.settings').defaults(ctx)
  const ntsc = setAll('sequence.settings', opened, [['timebase', '30000/1001']], ctx)
  assert.equal(ntsc.dropFrame, true, 'a new NTSC rate starts on drop-frame')
  assert.equal(displayFormat(ntsc), 'df')
  assert.deepEqual(dialogSteps(spec('sequence.settings'), ntsc, ctx), [{ command: 'sequence.settings', params: { fps: 30000 / 1001, dropFrame: true } }])
  // Non-drop-frame is chosen; picking 29.97 again keeps it.
  const ndf = setAll('sequence.settings', ntsc, [['videoDisplay', 'ndf'], ['timebase', '30000/1001']], ctx)
  assert.equal(ndf.dropFrame, false)
  assert.deepEqual(dialogSteps(spec('sequence.settings'), ndf, ctx), [{ command: 'sequence.settings', params: { fps: 30000 / 1001 } }])
  // A rate without drop-frame never sends it, whatever the draft holds.
  assert.deepEqual(sequenceChanges({ ...opened, dropFrame: true }, current), {})
  assert.deepEqual(timecodeFormats({ num: 24000, den: 1001 }), [['tc', '{rate} fps Timecode', { rate: '23.976' }]])
  assert.deepEqual(timecodeFormats({ num: 30000, den: 1001 }).map(([id]) => id), ['df', 'ndf'])
  assert.equal(optionText(timecodeFormats({ num: 30000, den: 1001 })[0], (text) => text), '29.97 fps Drop-Frame Timecode')
  assert.deepEqual([60000, 120000].map((num) => supportsDropFrame({ num, den: 1001 })), [true, true])
  assert.equal(supportsDropFrame({ num: 24000, den: 1001 }), false)
  // The list shows the sequence's own rate first when upstream does not list it.
  const odd = setAll('sequence.settings', { ...opened, fpsNum: 23, fpsDen: 1 }, [], ctx)
  const options = rowsOf('sequence.settings').get('timebase').options(odd)
  assert.deepEqual([options[0][0], optionText(options[0], (text) => text)], ['23/1', '23 frames/second'])
  assert.equal(options.length, 16)
  assert.equal(shownValue(rowsOf('sequence.settings').get('timebase'), odd, ctx), '23/1')
})

test("upstream's labels: the aspect, the pixel aspect ratio, and the rates", () => {
  assert.deepEqual([aspect(1920, 1080), aspect(640, 360), aspect(1080, 1920), aspect(1440, 1080), aspect(4096, 2160)], ['16:9', '16:9', '9:16', '4:3', '1.90:1'])
  assert.deepEqual([parLabel([1, 1]), parLabel([10, 11]), parLabel([1, 0])], ['Square Pixels (1.0)', 'Custom (0.9091)', 'Custom'])
  assert.deepEqual(TIMEBASES.map((each) => each.label), ['10', '12', '12.5', '15', '23.976', '24', '25', '29.97', '30', '48', '50', '59.94', '60', '119.88', '120'])
})

test('New Sequence sends file.newSequence, and its second step only when drop-frame or Maximum Render Quality needs it', async () => {
  const name = await ok('file.newSequence', [['name', ' Shorts '], ['width', 1080], ['height', 1920], ['tracks.video', 2], ['tracks.audio', 4]])
  assert.deepEqual(name, [{ command: 'file.newSequence', params: { name: 'Shorts', width: 1080, height: 1920, fps: 24000 / 1001, sampleRate: 48000, mix: 'Stereo', video: 2, audio: 4 } }], 'everything else is the default: one step')
  const both = await ok('file.newSequence', [['name', ' '], ['timebase', '30000/1001'], ['maxRenderQuality', true]])
  assert.equal(both.length, 2)
  assert.equal(both[0].params.name, undefined, 'a blank name lets the command name it')
  assert.deepEqual(both[1], { command: 'sequence.settings', params: { dropFrame: true, maxRenderQuality: true } })
  // Non-drop-frame at 29.97 is the default: no second step.
  assert.equal((await ok('file.newSequence', [['timebase', '30000/1001'], ['videoDisplay', 'ndf']])).length, 1)
  // Its name opens as the engine names the next sequence, and it opens on three of each.
  const opened = await spec('file.newSequence').defaults(context())
  assert.deepEqual([opened.name, opened['tracks.video'], opened['tracks.audio'], opened.tab], ['Sequence 02', 3, 3, 'general'])
  // Track counts are upstream's 0 to 256.
  assert.deepEqual(newSequenceSteps({ ...opened, 'tracks.video': 900, 'tracks.audio': -2 })[0].params.video, 256)
  assert.deepEqual(newSequenceSteps({ ...opened, 'tracks.audio': -2 })[0].params.audio, 0)
})

test('Color Management sends the working space, wide gamut, and auto tone map, as upstream does', async () => {
  assert.deepEqual(await ok('sequence.colorSettings'), [{ command: 'sequence.colorSettings', params: { workingSpace: 'rec709', wideGamut: false, autoToneMap: true } }])
  assert.deepEqual(await ok('sequence.colorSettings', [['working', 'rec2100-pq'], ['wideGamut', true]]), [{ command: 'sequence.colorSettings', params: { workingSpace: 'rec2100-pq', wideGamut: true, autoToneMap: true } }])
  assert.equal(spec('sequence.colorSettings').title, 'Sequence Color Management')
})

test("each sequence dialog's preview kinds follow the plan's table", () => {
  assert.deepEqual(spec('sequence.settings').preview, ['picture', 'timeline'])
  assert.deepEqual(spec('file.newSequence').preview, ['project', 'timeline'])
  assert.deepEqual(spec('sequence.colorSettings').preview, ['picture'])
  // What changes() compares with is the active sequence; the selections do not move the preview.
  assert.deepEqual(spec('sequence.settings').dependsOn(context()), { sequence: 1 })
})

test("Sequence Settings' greyed fields stay drawn and disabled, as upstream draws them", () => {
  const rows = rowsOf('sequence.settings')
  for (const field of ['editingMode', 'par', 'fields', 'channels', 'audioDisplay', 'previewFormat', 'previewCodec', 'previewWidth', 'previewHeight', 'maxBitDepth', 'linearColor', 'vr.projection', 'vr.layout', 'vr.horizontal', 'vr.vertical', 'configure', 'reset']) {
    const row = rows.get(field)
    assert.ok(row, field)
    assert.equal(row.enabled({}), false, field)
    assert.ok(row.hint, `${field} says why`)
  }
  assert.equal(shownValue(rows.get('linearColor'), {}, context()), true, 'Composite in Linear Color is shown on')
})

test("every field upstream's sequence dialogs register has a declared id standing for it, each tab included", () => {
  const stands = new Set(dialogDeclarations(DIALOGS).flatMap((item) => item.upstream))
  const known = upstream.elements.map((element) => element.id).filter((id) => id.startsWith('sequenceSettings.') || ['colorDialog.working.{}', 'colorDialog.wideGamut', 'colorDialog.autoToneMap', 'colorDialog.ok', 'colorDialog.cancel'].includes(id))
  assert.equal(known.length, 43)
  assert.deepEqual(known.filter((id) => !stands.has(id)), [])
  const ids = new Set(dialogDeclarations(DIALOGS).map((item) => item.id))
  for (const tab of ['general', 'color', 'vr', 'tracks']) assert.ok(ids.has(`control:dialog.sequenceSettings.tab.${tab}`), tab)
  for (const space of ['rec709', 'rec2100-pq', 'rec2100-hlg']) assert.ok(ids.has(`control:dialog.colorDialog.working.${space}`), space)
})

test('the dialogs open with no params and run at once with them, as upstream routes them', () => {
  for (const id of ['sequence.settings', 'file.newSequence', 'sequence.colorSettings']) assert.equal(routeOf(id, {}, 'timeline'), 'dialog', id)
  assert.equal(routeOf('file.newSequence', { fromItem: 4 }, 'project'), 'session', 'New Sequence From Clip makes it at once')
  assert.equal(routeOf('sequence.settings', { width: 1280 }, 'timeline'), 'session')
  assert.equal(routeOf('sequence.colorSettings', { workingSpace: 'rec709' }, 'timeline'), 'session')
})

// Task 13 review: a peer's change while the dialog is open (the collaboration rebase), the active
// sequence changing under it, and upstream's rebranded hints.
const peer = (keys) => ({ ...answers, 'sequence.settings': { params: draftOf(keys, false), info: info(keys) } })

test("Sequence Settings rebases on a peer's change: fields left alone take the live value, and OK compares with the live sequence", async () => {
  const id = 'sequence.settings'
  const opened = await spec(id).defaults(context())
  assert.equal(spec(id).rebase, true)
  // A peer makes the sequence 1920 × 720 while the dialog is open; the person then types 1280.
  const live = { ...current, height: 720 }
  const fresh = await spec(id).defaults(context(peer(live)))
  const rebased = rebaseDraft(spec(id), opened, fresh)
  assert.equal(rebased.height, 720, 'the untouched height follows the peer')
  const typed = setAll(id, rebased, [['width', 1280]], context())
  assert.deepEqual(dialogSteps(spec(id), typed, context()), [{ command: 'sequence.settings', params: { width: 1280, height: 720, scaleMotion: true } }])
  // Opened and left alone: nothing to send after the peer's change (no undoing it).
  assert.deepEqual(dialogSteps(spec(id), rebased, context()), [])
  // A field set back to its open-time value after the peer's change is the person's, and is sent.
  const back = setAll(id, rebased, [['height', 1080]], context())
  assert.deepEqual(dialogSteps(spec(id), back, context()), [{ command: 'sequence.settings', params: { width: 1920, height: 1080, scaleMotion: true } }])
  // A field the person changed keeps their value through a rebase.
  const kept = rebaseDraft(spec(id), setAll(id, opened, [['maxRenderQuality', true]], context()), await spec(id).defaults(context(peer({ ...live, maxRenderQuality: false, sampleRate: 44100 }))))
  assert.deepEqual([kept.maxRenderQuality, kept.sampleRate], [true, 44100])
})

test('Color Management rebases too, and sends the live values of the fields left alone', async () => {
  const id = 'sequence.colorSettings'
  assert.equal(spec(id).rebase, true)
  const opened = await spec(id).defaults(context())
  const fresh = await spec(id).defaults(context({ ...answers, [id]: { params: { workingSpace: 'rec2100-hlg', wideGamut: true, autoToneMap: true }, info: { workingSpaces: SPACES } } }))
  const touched = setAll(id, opened, [['autoToneMap', false]], context())
  assert.deepEqual(dialogSteps(spec(id), rebaseDraft(spec(id), touched, fresh), context()), [{ command: id, params: { workingSpace: 'rec2100-hlg', wideGamut: true, autoToneMap: false } }])
})

test('Sequence Settings and Color Management close when another sequence becomes active; New Sequence does not rebase or close', () => {
  for (const id of ['sequence.settings', 'sequence.colorSettings']) {
    assert.equal(spec(id).sequenceBound, true, id)
    assert.equal(sequenceGone(spec(id), 1, { activeSequence: 2 }), true, id)
    assert.equal(sequenceGone(spec(id), 1, { activeSequence: 1 }), false, id)
  }
  assert.equal(spec('file.newSequence').rebase, undefined)
  assert.equal(sequenceGone(spec('file.newSequence'), 1, { activeSequence: 2 }), false)
})

test("the greyed fields' hints are upstream's rebranded catalog keys, so phrase() translates them", async () => {
  const { readFileSync } = await import('node:fs')
  const catalog = readFileSync(new URL('../i18n/upstream/es.tsv', import.meta.url), 'utf8')
  const rows = rowsOf('sequence.settings')
  for (const field of ['editingMode', 'linearColor', 'configure']) {
    const hint = rows.get(field).hint
    assert.ok(catalog.includes(`\t${hint}\t`), `${field}: ${hint}`)
  }
})
