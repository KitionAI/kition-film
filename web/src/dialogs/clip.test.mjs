// Upstream's clip dialogs (Task 11): each one's draft (`defaults()`), its params on OK
// (`finish()`), its preview kinds, and the ids it draws, against fake engine reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { DIALOGS, dialogDeclarations, dialogSteps, fieldRows, rememberDraft, rememberedDraft } from './registry.ts'
import { attributesInfo, holdsAtTimecode, interpretItems, peakText, speedDurationReadout } from './clip.ts'
import { routeOf } from '../session/invoke.ts'

const film = {
  fps: 24,
  selection: [3, 4],
  activeSequence: 1,
  tracks: [
    { id: 2, kind: 'video', clips: [{ id: 3, item: 8, name: 'bars.mp4', start: 0, duration: 4, speed: 1, reverse: false, timeInterpolation: 'frameSampling' }] },
    { id: 5, kind: 'audio', clips: [{ id: 4, item: 8, name: 'bars.mp4', start: 0, duration: 4, speed: 1, reverse: false }, { id: 6, item: 9, name: 'tone.wav', start: 4, duration: 1, speed: 1, reverse: false }] },
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

const spec = (id) => {
  const found = DIALOGS.get(id)
  assert.ok(found, `${id} is registered`)
  return found
}
const ok = async (id, ctx, change = (draft) => draft) => {
  const draft = change(await spec(id).defaults(ctx))
  return dialogSteps(spec(id), draft, ctx)
}

const pasteDefaults = {
  params: { motion: true, opacity: true, timeRemapping: true, volume: false, channelVolume: false, panner: false, effects: ['gaussian_blur', 'color'], scaleTimes: true },
  info: { video: true, audio: false, effects: [['gaussian_blur', 'Gaussian Blur'], ['color', 'Color']] },
}

test('Paste Attributes opens on what the engine says was copied, and OK sends upstream\'s params for the selected clips', async () => {
  const ctx = context({ reads: { dialogDefaults: (command) => (command === 'edit.pasteAttributes' ? pasteDefaults : null) } })
  const steps = await ok('edit.pasteAttributes', ctx, (draft) => ({ ...draft, opacity: false, effects: ['color'] }))
  assert.deepEqual(ctx.asked.filter((each) => each[0] === 'read'), [['read', 'dialogDefaults', 'edit.pasteAttributes']])
  assert.deepEqual(steps, [{ command: 'edit.pasteAttributes', params: { clips: [3, 4], motion: true, opacity: false, timeRemapping: true, volume: false, channelVolume: false, panner: false, effects: ['color'], scaleTimes: true } }])
})

test('Paste Attributes lists one checkbox per effect of the copied clip, under one id for upstream\'s effect.<id>', async () => {
  const draft = await spec('edit.pasteAttributes').defaults(context({ reads: { dialogDefaults: pasteDefaults } }))
  const checklist = fieldRows(spec('edit.pasteAttributes').layout).find((row) => row.kind === 'checklist')
  assert.deepEqual(checklist.options(draft, context()), pasteDefaults.info.effects)
  const declared = Object.fromEntries(dialogDeclarations(DIALOGS).map((item) => [item.id, item.upstream]))
  assert.deepEqual(declared['control:dialog.pasteAttributes.effect'], ['{}.effect.{}'])
  // The audio attributes are drawn disabled when only video was copied, as upstream's `add_enabled`.
  const volume = fieldRows(spec('edit.pasteAttributes').layout).find((row) => row.field === 'volume')
  assert.equal(volume.enabled(draft), false)
  assert.deepEqual(attributesInfo({}), { video: true, audio: true, effects: [] }, "a missing kind is enabled, as upstream's unwrap_or(true)")
})

test('Remove Attributes has no Scale Attribute Times and opens empty without an engine answer', async () => {
  const steps = await ok('edit.removeAttributes', context())
  assert.deepEqual(steps[0].params, { clips: [3, 4], motion: false, opacity: false, timeRemapping: false, volume: false, channelVolume: false, panner: false, effects: [] })
  assert.ok(!fieldRows(spec('edit.removeAttributes').layout).some((row) => row.field === 'scaleTimes'))
})

test('Frame Hold Options sends the timecode only for Source Timecode and Sequence Time, as finish() drops it', async () => {
  const held = { params: { enabled: true, holdOn: 'in', timecode: '00:00:01:12', holdFilters: true }, info: null }
  const ctx = context({ reads: { dialogDefaults: held } })
  assert.deepEqual((await ok('clip.frameHoldOptions', ctx))[0].params, { clips: [3, 4], enabled: true, holdOn: 'in', holdFilters: true })
  assert.deepEqual((await ok('clip.frameHoldOptions', ctx, (draft) => ({ ...draft, holdOn: 'sourceTimecode' })))[0].params, { clips: [3, 4], enabled: true, holdOn: 'sourceTimecode', holdFilters: true, timecode: '00:00:01:12' })
  assert.deepEqual((await ok('clip.frameHoldOptions', ctx, (draft) => ({ ...draft, enabled: false })))[0].params, { clips: [3, 4], enabled: false, holdOn: 'in', holdFilters: true })
  // The Timecode field shows only while it applies, and Hold On off disables the rest.
  const rows = fieldRows(spec('clip.frameHoldOptions').layout)
  const timecode = rows.find((row) => row.field === 'timecode')
  assert.equal(timecode.shown({ holdOn: 'playhead' }), false)
  assert.equal(timecode.shown({ holdOn: 'sequenceTime' }), true)
  assert.equal(rows.find((row) => row.field === 'holdFilters').enabled({ enabled: false }), false)
  assert.equal(holdsAtTimecode('sourceTimecode'), true)
  // No answer: upstream's defaults with no clip.
  assert.deepEqual(await spec('clip.frameHoldOptions').defaults(context()), { enabled: true, holdOn: 'in', timecode: '00:00:00:00', holdFilters: false })
})

test("Field Options opens on upstream's defaults and sends its two fields", async () => {
  assert.deepEqual(await ok('clip.fieldOptions', context(), (draft) => ({ ...draft, processing: 'flickerRemoval', reverseFieldDominance: true })), [{ command: 'clip.fieldOptions', params: { clips: [3, 4], reverseFieldDominance: true, processing: 'flickerRemoval' } }])
  const declared = Object.fromEntries(dialogDeclarations(DIALOGS).map((item) => [item.id, item.upstream]))
  for (const option of ['none', 'alwaysDeinterlace', 'flickerRemoval']) assert.deepEqual(declared[`control:dialog.fieldOptions.processing.${option}`], [`{}.processing.${option}`])
})

test("Audio Gain sends the chosen mode with its row's dB, opens on Adjust, and keeps its draft for next time", async () => {
  const fresh = await spec('clip.audioGain').defaults(context())
  assert.equal(fresh.mode, 'adjust')
  assert.deepEqual(dialogSteps(spec('clip.audioGain'), { ...fresh, mode: 'set', set: 3, adjust: 6 }, context()), [{ command: 'clip.audioGain', params: { clips: [3, 4], mode: 'set', db: 3 } }])
  assert.deepEqual(dialogSteps(spec('clip.audioGain'), { ...fresh, adjust: 6 }, context())[0].params, { clips: [3, 4], mode: 'adjust', db: 6 })
  // An unknown mode sends Adjust's dB, as upstream's `_ => adjust_db`.
  assert.deepEqual(dialogSteps(spec('clip.audioGain'), { ...fresh, mode: 'loud', adjust: -2 }, context())[0].params, { clips: [3, 4], mode: 'adjust', db: -2 })
  rememberDraft('clip.audioGain', { ...fresh, mode: 'normalizeMax', normalizeMax: -1 })
  assert.deepEqual(await spec('clip.audioGain').defaults(context()), { ...fresh, mode: 'normalizeMax', normalizeMax: -1 })
  assert.equal(rememberedDraft('clip.audioGain').mode, 'normalizeMax')
  assert.equal(peakText(-12.04), '-12.0 dB')
  assert.equal(peakText(null), '—')
})

test('Audio Gain previews by ear, and its OK and Cancel stand for audioGain.ok and audioGain.cancel', () => {
  assert.deepEqual(spec('clip.audioGain').preview, ['sound'])
  const declared = Object.fromEntries(dialogDeclarations(DIALOGS).map((item) => [item.id, item.upstream]))
  assert.ok(declared['control:dialog.ok'].includes('audioGain.ok'))
  assert.ok(declared['control:dialog.cancel'].includes('audioGain.cancel'))
  for (const mode of ['set', 'adjust', 'normalizeMax', 'normalizeAll']) {
    assert.deepEqual(declared[`control:dialog.audioGain.${mode}`], [`audioGain.${mode}`])
    assert.deepEqual(declared[`control:dialog.audioGain.${mode}.value`], [`audioGain.${mode}.value`])
  }
})

test('Interpret Footage opens on the given items, or the Project selection, or the selected clips\' items; with a colorSpace it runs at once', async () => {
  assert.equal(routeOf('clip.interpretFootage', {}, 'timeline'), 'dialog')
  assert.equal(routeOf('clip.interpretFootage', { items: [8] }, 'project'), 'dialog')
  assert.equal(routeOf('clip.interpretFootage', { items: [8], colorSpace: 'rec709' }, 'project'), 'session')
  assert.deepEqual(interpretItems(context({ params: { items: [11] } })), [11])
  assert.deepEqual(interpretItems(context({ session: { projectSelection: [12, 13] } })), [12, 13])
  assert.deepEqual(interpretItems(context()), [8], 'a clip and its linked audio name their item once')
  const ctx = context({
    params: { items: [8] },
    queries: { 'media.colorInfo': { override: 'slog3-sgamut3cine', detectedLabel: 'Rec. 709' }, 'color.spaces': { colorSpaces: [{ id: 'rec709', label: 'Rec. 709' }, { id: 'slog3-sgamut3cine', label: 'S-Log3' }] } },
  })
  const draft = await spec('clip.interpretFootage').defaults(ctx)
  assert.deepEqual(ctx.asked.find((each) => each[1] === 'media.colorInfo'), ['query', 'media.colorInfo', { item: 8 }])
  assert.equal(draft.colorSpace, 'slog3-sgamut3cine', "the first item's override")
  assert.deepEqual(draft.info, { detected: 'Rec. 709', spaces: [['rec709', 'Rec. 709'], ['slog3-sgamut3cine', 'S-Log3']] })
  assert.deepEqual(dialogSteps(spec('clip.interpretFootage'), { ...draft, colorSpace: 'auto' }, ctx), [{ command: 'clip.interpretFootage', params: { items: [8], colorSpace: 'auto' } }])
  const none = await spec('clip.interpretFootage').defaults(context({ params: { items: [] } }))
  assert.equal(none.colorSpace, 'auto')
  assert.equal(none.info.detected, '—')
})

test("each clip dialog's preview kinds follow the plan's table", () => {
  const kinds = Object.fromEntries(['clip.speedDuration', 'clip.frameHoldOptions', 'clip.fieldOptions', 'edit.pasteAttributes', 'edit.removeAttributes', 'clip.audioGain', 'clip.interpretFootage'].map((id) => [id, spec(id).preview]))
  assert.deepEqual(kinds, {
    'clip.speedDuration': ['picture', 'timeline'],
    'clip.frameHoldOptions': ['picture'],
    'clip.fieldOptions': ['picture'],
    'edit.pasteAttributes': ['picture', 'timeline'],
    'edit.removeAttributes': ['picture', 'timeline'],
    'clip.audioGain': ['sound'],
    'clip.interpretFootage': ['picture', 'project'],
  })
})

test("every field upstream's clip dialogs register has a declared id standing for it", () => {
  const stands = new Set(dialogDeclarations(DIALOGS).flatMap((item) => item.upstream))
  const fields = upstream.elements
    .map((element) => element.id)
    .filter((id) => /^\{\}\.(motion|opacity|timeRemapping|volume|channelVolume|panner|effect\.\{\}|scaleTimes|enabled|holdOn\.\{\}|holdFilters|reverseFieldDominance|processing\.|speed|reverse|ripple|interpolation\.\{\}|timecode)$/.test(id) || id.startsWith('audioGain.') || id.startsWith('colorDialog.space.'))
  assert.ok(fields.length >= 30, `found ${fields.length}`)
  assert.deepEqual(fields.filter((id) => !stands.has(id)), [])
})

test('the Speed / Duration readout of 50% on a 4 s clip is 8 s', () => {
  assert.equal(speedDurationReadout({ speed: 50 }, context()), '00:00:08:00')
})

// ---- Task 11 review

test("Audio Gain's peak is read again for a new revision or selection, never for a playhead move", async () => {
  const { audioPeakKey } = await import('./clip.ts')
  const key = audioPeakKey(12, film)
  assert.equal(audioPeakKey(12, { ...film, playhead: 7.5 }), key, 'the playhead moved: no new read')
  assert.equal(audioPeakKey(12, { ...film, tracks: [...film.tracks] }), key, 'a new inspect() of the same document: no new read')
  assert.notEqual(audioPeakKey(13, film), key, 'an edit')
  assert.notEqual(audioPeakKey(12, { ...film, selection: [3] }), key, 'another selection')
})

test("a dialog reads only the engine extras it is allowed (dialogDefaults), and parses their JSON", async () => {
  const { DIALOG_EXTRAS, createReadExtra } = await import('./extras.ts')
  assert.deepEqual([...DIALOG_EXTRAS], ['dialogDefaults'])
  const calls = []
  const doc = { invoke: async (name, ...args) => (calls.push([name, ...args]), JSON.stringify({ params: { a: 1 } })) }
  const read = createReadExtra(() => doc)
  assert.deepEqual(await read('dialogDefaults', 'clip.fieldOptions'), { params: { a: 1 } })
  assert.equal(await read('previewEnd'), null, 'not a read a dialog may make')
  assert.equal(await read('loudnessReset'), null)
  assert.deepEqual(calls, [['dialogDefaults', 'clip.fieldOptions']])
  assert.equal(await createReadExtra(() => null)('dialogDefaults', 'x'), null, 'no document')
})

test("Frame Hold's Timecode field is upstream's 120 px wide", () => {
  const timecode = fieldRows(spec('clip.frameHoldOptions').layout).find((row) => row.field === 'timecode')
  assert.equal(timecode.width, 120)
})
