// Upstream's track, sequence tool, and new item dialogs (Task 14): Add Tracks and Delete Tracks
// (`dialogs.rs`), Normalize Mix Track, Simplify Sequence, New Color Matte, and Color Matte Color
// (`menu_dialogs.rs`): their params against upstream's for the same choices, their preview kinds,
// the ids they draw, and Simplify's page-side compare of its new sequence with its source, against
// fake engine reads (`dialogDefaults`, as `bindings/wasm/src/dialogs.rs` answers it).
import test from 'node:test'
import assert from 'node:assert/strict'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { describe as describeFilm } from '../film.ts'
import { DIALOGS, DIRECT_ROWS, changedDraft, dialogDeclarations, dialogSteps, fieldRows, followSequence, optionsOf, optionText, rebaseDraft, sequenceGone, shownValue } from './registry.ts'
import { previewTimeline } from './previewViews.ts'
import { normalizeLines } from './tracks.ts'
import { routeOf } from '../session/invoke.ts'

const tracksInfo = { video: ['Video 1', 'Video 2'], audio: ['Audio 1'], submix: [] }
const answers = {
  'sequence.addTracks': {
    params: { video: 1, videoAfter: 2, audio: 1, audioAfter: 1, audioType: 'standard', submix: 0, submixAfter: 0, submixType: 'stereo' },
    info: { tracks: tracksInfo, current: { videoAfter: 2, audioAfter: 1, submixAfter: 0 } },
  },
  'sequence.simplify': {
    params: { name: 'Sequence 01 (Simplified)', removeDisabled: true, removeEmptyTracks: true, closeGaps: false, moveClipsDown: false, removeVideoEffects: false, removeAudioEffects: false, removeText: false, keep: 'both' },
    info: { current: { name: 'Sequence 01 (Simplified)' } },
  },
  'item.newColorMatte': { params: { color: '#000000', name: 'Color Matte', width: 1920, height: 1080, seconds: 5 }, info: null },
  'project.matteColor': { params: { item: 12, color: '#ff0000' }, info: { current: { color: '#ff0000' } } },
}
/** The active sequence: V1 and V2, A1. */
const film = {
  fps: 24,
  activeSequence: 1,
  selection: [],
  tracks: [
    { id: 1, name: 'Video 1', kind: 'video', clips: [] },
    { id: 2, name: 'Video 2', kind: 'video', clips: [] },
    { id: 3, name: 'Audio 1', kind: 'audio', clips: [] },
  ],
}
const context = (reads = answers, on = film) => ({ film: on, session: null, params: {}, query: async () => null, read: async (name, command) => (name === 'dialogDefaults' ? (reads[command] ?? null) : null) })

const spec = (id) => {
  const found = DIALOGS.get(id)
  assert.ok(found, `${id} is registered`)
  return found
}
const rowsOf = (id) => new Map(fieldRows(spec(id).layout).map((row) => [row.field, row]))
const setAll = (id, draft, changes, ctx) => changes.reduce((each, [field, value]) => changedDraft(rowsOf(id).get(field), each, value, ctx), draft)
const opened = (id, ctx = context()) => Promise.resolve(spec(id).defaults(ctx))
const ok = async (id, changes = [], ctx = context()) => dialogSteps(spec(id), setAll(id, await opened(id, ctx), changes, ctx), ctx)

test('Add Tracks with 0, 0, 0 sends nothing and previews nothing; otherwise all eight of upstream\'s params', async () => {
  assert.deepEqual(await ok('sequence.addTracks', [['video.amount', 0], ['audio.amount', 0], ['submix.amount', 0]]), [])
  assert.deepEqual(await ok('sequence.addTracks'), [
    { command: 'sequence.addTracks', params: { video: 1, videoAfter: 2, audio: 1, audioAfter: 1, audioType: 'standard', submix: 0, submixAfter: 0, submixType: 'stereo' } },
  ])
  // Two audio tracks after A1 (placement 1), 5.1; no video.
  assert.deepEqual(await ok('sequence.addTracks', [['video.amount', 0], ['audio.amount', 2], ['audio.placement', '1'], ['audio.type', '5.1']]), [
    { command: 'sequence.addTracks', params: { video: 0, videoAfter: 2, audio: 2, audioAfter: 1, audioType: '5.1', submix: 0, submixAfter: 0, submixType: 'stereo' } },
  ])
  // Amounts are whole, 0 to 99 (upstream's DragValue range).
  const [step] = await ok('sequence.addTracks', [['video.amount', 140.6], ['audio.amount', -3]])
  assert.deepEqual([step.params.video, step.params.audio], [99, 0])
})

test("Add Tracks' placement options list the current tracks, Before First Track first; with none of a kind it is greyed", async () => {
  const draft = await opened('sequence.addTracks')
  const rows = rowsOf('sequence.addTracks')
  // Upstream's `tlf!("After {name}")`: the template is translated, then the track's name filled in.
  const shown = (options) => options.map((option) => [option[0], optionText(option, (text) => text)])
  assert.deepEqual(optionsOf(rows.get('video.placement').options, draft, context())[1], ['1', 'After {name}', { name: 'Video 1' }])
  assert.equal(optionText(optionsOf(rows.get('video.placement').options, draft, context())[1], (text) => (text === 'After {name}' ? '[after] {name}' : text)), '[after] Video 1')
  assert.deepEqual(shown(optionsOf(rows.get('video.placement').options, draft, context())), [
    ['0', 'Before First Track'],
    ['1', 'After Video 1'],
    ['2', 'After Video 2'],
  ])
  assert.deepEqual(shown(optionsOf(rows.get('audio.placement').options, draft, context())), [
    ['0', 'Before First Track'],
    ['1', 'After Audio 1'],
  ])
  assert.equal(shownValue(rows.get('video.placement'), draft, context()), '2', 'after the last track')
  assert.equal(rows.get('submix.placement').enabled(draft), false, 'no submix track: nowhere to choose from')
  assert.equal(rows.get('video.placement').enabled(draft), true)
  assert.deepEqual(optionsOf(rows.get('audio.type').options, draft, context()).map(([value]) => value), ['standard', '5.1', 'adaptive', 'mono'])
  assert.deepEqual(optionsOf(rows.get('submix.type').options, draft, context()).map(([value]) => value), ['stereo', '5.1', 'adaptive', 'mono'])
  assert.equal(rows.has('video.type'), false, 'video tracks have no type')
  // A placement past the tracks there are now (a peer deleted one) is upstream's min(len).
  const [step] = dialogSteps(spec('sequence.addTracks'), { ...draft, videoAfter: 9 }, context())
  assert.equal(step.params.videoAfter, 2)
})

test('Add Tracks rebases its "after the last track" placements on a peer\'s new track, and keeps a placement the person chose', async () => {
  const id = 'sequence.addTracks'
  assert.equal(spec(id).rebase, true)
  const draft = await opened(id)
  const peer = { ...answers, [id]: { params: { ...answers[id].params, videoAfter: 3 }, info: { tracks: { ...tracksInfo, video: [...tracksInfo.video, 'Video 3'] }, current: { videoAfter: 3, audioAfter: 1, submixAfter: 0 } } } }
  const fresh = await opened(id, context(peer))
  assert.equal(rebaseDraft(spec(id), draft, fresh).videoAfter, 3, 'still after the last one')
  const chosen = setAll(id, draft, [['video.placement', '1']], context())
  assert.equal(rebaseDraft(spec(id), chosen, fresh).videoAfter, 1, "the person's choice stays")
  assert.equal(optionsOf(rowsOf(id).get('video.placement').options, rebaseDraft(spec(id), draft, fresh), context()).length, 4, 'the new track is listed')
})

test('Delete Tracks sends only the kinds checked, with All Empty Tracks or a track, and OK is off until one is', async () => {
  const id = 'sequence.deleteTracks'
  const draft = await opened(id)
  assert.deepEqual(draft, { video: false, videoTarget: 'empty', audio: false, audioTarget: 'empty' })
  assert.equal(spec(id).okEnabled(draft), false)
  assert.deepEqual(dialogSteps(spec(id), draft, context()), [])
  assert.deepEqual(await ok(id, [['video', true]]), [{ command: id, params: { video: 'empty' } }])
  assert.deepEqual(await ok(id, [['audio', true], ['audio.target', 'A1'], ['video.target', 'V2']]), [{ command: id, params: { audio: 'A1' } }])
  assert.equal(spec(id).okEnabled(setAll(id, draft, [['audio', true]], context())), true)
  const rows = rowsOf(id)
  assert.deepEqual(optionsOf(rows.get('video.target').options, draft, context()), [
    ['empty', 'All Empty Tracks'],
    ['V1', 'V1'],
    ['V2', 'V2'],
  ])
  assert.deepEqual(optionsOf(rows.get('audio.target').options, draft, context()).map(([value]) => value), ['empty', 'A1'])
  assert.equal(rows.get('video.target').enabled(draft), false, 'greyed until Delete Video Tracks is checked')
})

test('Normalize Mix Track sends db, and the strip names the gain it applies from the preview\'s result', async () => {
  assert.deepEqual(await ok('sequence.normalizeMixTrack'), [{ command: 'sequence.normalizeMixTrack', params: { db: 0 } }])
  assert.deepEqual(await ok('sequence.normalizeMixTrack', [['db', -3]]), [{ command: 'sequence.normalizeMixTrack', params: { db: -3 } }])
  const t = (key, values = {}) => `${key} ${JSON.stringify(values)}`
  assert.deepEqual(normalizeLines({ peakBeforeDb: -6.02, peakDb: -0.004, gainDb: 6.016, masterVolumeDb: 6.016 }, t), ['preview.normalizeGain {"gain":"+6.0 dB","before":"-6.0 dB","after":"-0.0 dB"}'])
  assert.deepEqual(normalizeLines(null, t), [])
  assert.deepEqual(spec('sequence.normalizeMixTrack').preview, ['sound'])
})

test("Simplify's keep maps to upstream's params, its name and remove options travel as upstream's run() sends them", async () => {
  const id = 'sequence.simplify'
  const base = { name: 'Sequence 01 (Simplified)', removeDisabled: true, removeEmptyTracks: true, closeGaps: false, moveClipsDown: false, removeVideoEffects: false, removeAudioEffects: false, removeText: false, keep: 'both' }
  assert.deepEqual(await ok(id), [{ command: id, params: base }])
  for (const keep of ['video', 'audio', 'both']) assert.deepEqual((await ok(id, [['keep', keep]]))[0].params.keep, keep)
  assert.deepEqual((await ok(id, [['closeGaps', true], ['removeEmptyTracks', false], ['name', 'Short']]))[0].params, { ...base, closeGaps: true, removeEmptyTracks: false, name: 'Short' })
  assert.equal(spec(id).okLabel, 'Simplify')
  assert.deepEqual(spec(id).preview, ['timeline', 'project'])
})

test('New Color Matte sends the colour, name, whole size, and seconds; Color Matte Color the item and colour', async () => {
  assert.deepEqual(await ok('item.newColorMatte', [['color', '#ff0000'], ['width', 640.4], ['height', 360]]), [{ command: 'item.newColorMatte', params: { color: '#ff0000', name: 'Color Matte', width: 640, height: 360, seconds: 5 } }])
  assert.deepEqual(await ok('project.matteColor', [['color', '#0000ff']]), [{ command: 'project.matteColor', params: { item: 12, color: '#0000ff' } }])
  assert.deepEqual(spec('item.newColorMatte').preview, ['project'])
  assert.equal(spec('item.newColorMatte').stripItem({ item: 31 }), 31, 'the strip shows the new matte')
  assert.deepEqual(spec('project.matteColor').preview, ['project', 'picture'])
  // Without the engine's answer the defaults are upstream's (black, the sequence's size, 5 s).
  const fallback = await opened('item.newColorMatte', context({}, { ...film, width: 1280, height: 720 }))
  assert.deepEqual([fallback.color, fallback.width, fallback.height, fallback.seconds], ['#000000', 1280, 720, 5])
})

test("Color Matte Color opens only on one selected matte (upstream's error otherwise), and rebases on a peer's colour", async () => {
  await assert.rejects(opened('project.matteColor', context({})), /select one Color Matte/)
  const id = 'project.matteColor'
  const draft = await opened(id)
  const fresh = await opened(id, context({ ...answers, [id]: { params: { item: 12, color: '#00ff00' }, info: { current: { color: '#00ff00' } } } }))
  assert.equal(rebaseDraft(spec(id), draft, fresh).color, '#00ff00')
  assert.equal(rebaseDraft(spec(id), { ...draft, color: '#0000ff' }, fresh).color, '#0000ff')
})

test('the dialogs open with no params and run at once with them; the new items and Add Submix stay direct', () => {
  for (const id of ['sequence.addTracks', 'sequence.deleteTracks', 'sequence.normalizeMixTrack', 'sequence.simplify', 'item.newColorMatte', 'project.matteColor']) {
    assert.equal(routeOf(id, {}, 'timeline'), 'dialog', id)
  }
  assert.equal(routeOf('sequence.addTracks', { video: 1 }, 'timeline'), 'session')
  assert.equal(routeOf('item.newColorMatte', { color: '#ff0000' }, 'project'), 'session')
  for (const id of ['item.newBarsAndTone', 'item.newBlackVideo', 'item.newCountingLeader', 'item.newTransparentVideo', 'item.newAdjustmentLayer', 'mixer.addSubmix']) {
    assert.ok(DIRECT_ROWS.has(id), id)
    assert.equal(routeOf(id, {}, 'project'), 'session', id)
  }
  // Upstream keeps them open on another active sequence (rule 6): none closes; only Sequence
  // Settings and Color Management, which edit the sequence they opened on, do.
  for (const id of ['sequence.addTracks', 'sequence.deleteTracks', 'sequence.normalizeMixTrack', 'sequence.simplify', 'item.newColorMatte', 'project.matteColor']) assert.equal(sequenceGone(spec(id), 1, { activeSequence: 2 }), false, id)
  for (const id of ['sequence.settings', 'sequence.colorSettings']) assert.equal(sequenceGone(spec(id), 1, { activeSequence: 2 }), true, id)
})

test("every field upstream's track, sequence tool, and new item dialogs register has a declared id standing for it", () => {
  const stands = new Set(dialogDeclarations(DIALOGS).flatMap((item) => item.upstream))
  const known = upstream.elements.map((element) => element.id).filter((id) => /^(addTracks|deleteTracks)\./.test(id) || /^\{\}\.(db|keep\.\{\}|color|width|height|seconds|removeDisabled|removeEmptyTracks|closeGaps|removeVideoEffects|removeAudioEffects|removeText|moveClipsDown)$/.test(id))
  assert.equal(known.length, 40)
  // Upstream draws no Track type for video tracks (`add_tracks` passes None for them): the
  // extractor reads those two ids from the format string every kind shares.
  const drawn = known.filter((id) => !id.startsWith('addTracks.video.type'))
  assert.equal(drawn.length, 38)
  assert.deepEqual(drawn.filter((id) => !stands.has(id)), [])
  assert.equal([...stands].some((id) => id.startsWith('addTracks.video.type')), false)
  const ids = new Set(dialogDeclarations(DIALOGS).map((item) => item.id))
  for (const keep of ['both', 'video', 'audio']) assert.ok(ids.has(`control:dialog.simplify.keep.${keep}`), keep)
  for (const id of ['control:dialog.addTracks.video.amount', 'control:dialog.addTracks.submix.type', 'control:dialog.deleteTracks.audio.target', 'control:dialog.normalizeMix.db', 'control:dialog.colorMatte.color', 'control:dialog.matteColor.color']) assert.ok(ids.has(id), id)
})

// ---- Simplify's page-side compare (Task 3's note): its new sequence keeps its source's track and
// clip ids, so the diff lists all of them as added there; the Timeline compares the new sequence
// with the source to draw what Simplify removed, moved, and changed.

const T = 254_016_000_000
function filmOf({ sequence, video = [], audio = [], effects = {} }) {
  const track = ([id, clips]) => ({ id, name: `T${id}`, items: clips.map(([clip, start, length]) => ({ clip, item: 8, name: `clip ${clip}`, start: start * T, duration: length * T, sourceIn: 0, sourceOut: length * T, speed: 1, effects: effects[clip] ?? [] })) })
  return describeFilm({ width: 1920, height: 1080, canUndo: true, canRedo: false, inspected: { ticksPerSecond: T, playhead: 0, project: { name: 'P', activeSequence: sequence, root: { id: 1, name: 'root', children: [] } }, sequence: { name: 'S', duration: 0, video: video.map(track), audio: audio.map(track), selection: [], markers: [] } } })
}

test("Simplify's Timeline preview compares the new sequence with its source: removed clips and tracks ghosted, closed gaps moved, stripped effects changed", () => {
  // Source: V1 [10 at 0–2, 11 at 4–6 (a gap before it)], V2 [12 disabled, removed], V3 empty; A1 [20 at 0–2 with an effect].
  const doc = filmOf({ sequence: 50, video: [[1, [[10, 0, 2], [11, 4, 2]]], [2, [[12, 0, 1]]], [5, []]], audio: [[3, [[20, 0, 2]]]], effects: { 20: [{ effect: 'reverb' }] } })
  // Simplified (Close Gaps, Remove Empty Tracks, Disabled, Audio Effects): V1 [10 at 0, 11 at 2], A1 [20 without its effect].
  const copy = filmOf({ sequence: 77, video: [[1, [[10, 0, 2], [11, 2, 2]]]], audio: [[3, [[20, 0, 2]]]] })
  const diff = { sequences: { added: [{ id: 77 }], removed: [], changed: [] }, tracks: { added: [1, 3].map((id) => ({ id, sequence: 77 })), removed: [], changed: [] }, clips: { added: [10, 11, 20].map((id) => ({ id, sequence: 77 })), removed: [], changed: [] } }
  const view = previewTimeline(doc, copy, diff, ['timeline', 'project'], { copies: spec('sequence.simplify').copiesSequence })
  assert.equal(view.sequence, 77)
  assert.equal(view.clips.has(10), false, 'an unchanged clip is not marked')
  assert.equal(view.clips.get(11), 'changed', 'moved by the closed gap')
  assert.equal(view.clips.get(20), 'changed', 'its effect removed')
  assert.deepEqual(view.ghosts.get(1)?.map((ghost) => [ghost.kind, ghost.clip.id]), [['was', 11]])
  assert.equal(view.tracks.get(2), 'removed')
  assert.equal(view.tracks.get(5), 'removed')
  assert.deepEqual(view.ghosts.get(2)?.map((ghost) => [ghost.kind, ghost.clip.id]), [['removed', 12]])
  assert.equal(view.tracks.has(1), false, 'a kept track is not marked added')
  assert.deepEqual(view.film.tracks.map((track) => track.id), doc.tracks.map((track) => track.id), 'removed tracks stay where they were (V3, V2, V1 top down, then A1)')
  // A new sequence that is no copy (New Sequence) still draws all of it added, nothing ghosted.
  const fresh = previewTimeline(doc, filmOf({ sequence: 78, video: [[90, []]] }), { sequences: { added: [{ id: 78 }], removed: [] }, tracks: { added: [{ id: 90, sequence: 78 }], removed: [] } }, ['timeline'])
  assert.deepEqual([...fresh.tracks], [[90, 'added']])
  assert.equal(fresh.ghosts.size, 0)
})

// ---- Task 14 review: another active sequence under an open dialog (upstream keeps it open).

test('another active sequence: Add Tracks and Simplify rebase (their track lists and name follow), Normalize re-previews, Delete Tracks drops a target the new sequence lacks', async () => {
  // Add Tracks: the other sequence has one video and two audio tracks.
  const other = { ...answers, 'sequence.addTracks': { params: { ...answers['sequence.addTracks'].params, videoAfter: 1, audioAfter: 2 }, info: { tracks: { video: ['Video 1'], audio: ['Audio 1', 'Audio 2'], submix: [] }, current: { videoAfter: 1, audioAfter: 2, submixAfter: 0 } } } }
  const id = 'sequence.addTracks'
  const opened = await spec(id).defaults(context())
  const moved = rebaseDraft(spec(id), opened, await spec(id).defaults(context(other)))
  assert.deepEqual([moved.videoAfter, moved.audioAfter], [1, 2])
  assert.deepEqual(optionsOf(rowsOf(id).get('video.placement').options, moved, context()).map((option) => optionText(option, (text) => text)), ['Before First Track', 'After Video 1'])
  // Simplify's name follows the other sequence's.
  const simplified = await spec('sequence.simplify').defaults(context())
  const renamed = { ...answers, 'sequence.simplify': { params: { ...answers['sequence.simplify'].params, name: 'Cut B (Simplified)' }, info: { current: { name: 'Cut B (Simplified)' } } } }
  assert.equal(rebaseDraft(spec('sequence.simplify'), simplified, await spec('sequence.simplify').defaults(context(renamed))).name, 'Cut B (Simplified)')
  for (const each of ['sequence.addTracks', 'sequence.simplify']) assert.equal(spec(each).rebase, true, each)
  // Normalize previews again for the new sequence: what it follows names it.
  const { previewDepends } = await import('./registry.ts')
  assert.notDeepEqual(previewDepends(spec('sequence.normalizeMixTrack'), context()), previewDepends(spec('sequence.normalizeMixTrack'), context(answers, { ...film, activeSequence: 2 })))
  // Delete Tracks: V2 is gone in a sequence with one video track; A1 is still there.
  const small = { ...film, activeSequence: 2, tracks: [film.tracks[0], film.tracks[2]] }
  const chosen = { video: true, videoTarget: 'V2', audio: true, audioTarget: 'A1' }
  assert.deepEqual(followSequence(spec('sequence.deleteTracks'), chosen, context(answers, small)), { ...chosen, videoTarget: 'empty' })
  const kept = { ...chosen, videoTarget: 'V1' }
  assert.equal(followSequence(spec('sequence.deleteTracks'), kept, context(answers, small)), kept, 'nothing to change: the same draft')
  assert.equal(followSequence(spec('sequence.addTracks'), opened, context()), opened, 'a dialog without its own rule keeps its draft')
})

test("Delete Tracks' track lists have an accessible name", () => {
  for (const kind of ['video', 'audio']) {
    const row = rowsOf('sequence.deleteTracks').get(`${kind}.target`)
    assert.equal(row.bare, true)
    assert.ok(row.label.trim().length > 0, kind)
  }
})
