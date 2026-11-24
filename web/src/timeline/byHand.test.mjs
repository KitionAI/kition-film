// Pure geometry of the Timeline's direct manipulation (plan "Film usable by hand", phase 4):
// track heights fitted to a short panel, the Volume line's scale and hits, the fade handles.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_VIEW, FIT_MIN_TRACK_H, fitTrackHeight } from './layout.ts'
import { FADER_MAX_DB, FADER_MIN_DB, bandHit, bandOf, dbOfY, dbText, dbToPos, draggedDb, keysAround, keyTimeBetween, levelAt, linePoints, posToDb, yOfDb } from './volumeBand.ts'
import { HANDLE_SIZE, draggedFrames, fadeAt, fadeCommand, handleX, onHandle } from './fades.ts'

test('a newly shown sequence fits its tracks to a short half, never under the minimum', () => {
  // Three video tracks at 60 in a 128-point half: 42 each, all whole.
  assert.equal(fitTrackHeight(128, 3, 60), 42)
  assert.ok(3 * fitTrackHeight(128, 3, 60) <= 128)
  // Room enough: the default.
  assert.equal(fitTrackHeight(400, 3, 60), 60)
  // Too little room: the minimum, and the half scrolls.
  assert.equal(fitTrackHeight(60, 3, 56), FIT_MIN_TRACK_H)
  // No tracks or a damaged height: the default.
  assert.equal(fitTrackHeight(100, 0, 60), 60)
  assert.equal(fitTrackHeight(Number.NaN, 3, 60), 60)
  assert.equal(DEFAULT_VIEW.fitHeights, true, 'the first sequence shown is fitted too')
})

test('the Volume line uses the faders\' taper: positions and levels round-trip', () => {
  assert.equal(dbToPos(FADER_MIN_DB), 0)
  assert.equal(dbToPos(FADER_MAX_DB), 1)
  assert.ok(Math.abs(dbToPos(0) - 0.76) < 1e-12, '0 dB at upstream\'s 76%')
  for (const db of [-60, -40, -20, -12, -6, -3, 0, 2.5, 6, 12]) assert.ok(Math.abs(posToDb(dbToPos(db)) - db) < 1e-9, `${db}`)
  assert.equal(posToDb(0.0005), FADER_MIN_DB, 'within half a dB of the bottom is silence')
  assert.equal(posToDb(2), FADER_MAX_DB)
  assert.equal(dbToPos(Number.NaN), 0)
  assert.equal(posToDb(Number.NaN), FADER_MIN_DB)
})

test('the band runs under the name band, and a too-short clip has none', () => {
  assert.deepEqual(bandOf(62), { top: 17, bottom: 59, height: 42 })
  assert.equal(bandOf(24), null)
  const band = bandOf(62)
  assert.ok(Math.abs(dbOfY(band, yOfDb(band, -6)) + 6) < 1e-9)
  // Dragging up by the band's height moves the level a whole fader's travel.
  assert.equal(draggedDb(band, FADER_MIN_DB, 59, 17), FADER_MAX_DB)
  assert.ok(draggedDb(band, 0, 30, 20) > 0, 'up raises')
  assert.ok(draggedDb(band, 0, 30, 40) < 0, 'down lowers')
})

test('the level between keyframes is their straight line, held outside them', () => {
  const keys = [{ time: 1, mediaTime: 1, value: 0 }, { time: 3, mediaTime: 3, value: -20 }]
  assert.equal(levelAt([], -3, 2), -3, 'flat without keyframes')
  assert.equal(levelAt(keys, 5, 0), 0)
  assert.equal(levelAt(keys, 5, 2), -10)
  assert.equal(levelAt(keys, 5, 9), -20)
  assert.deepEqual(keysAround(keys, 2), [0, 1])
  assert.deepEqual(keysAround(keys, 0.5), [0])
  assert.deepEqual(keysAround(keys, 4), [1])
  assert.deepEqual(keysAround([], 4), [])
  const band = bandOf(62)
  const points = linePoints(keys, 0, 0, 4, 400, band)
  assert.equal(points.length, 4, 'both ends and each keyframe in view')
  assert.deepEqual(points[1], [100, yOfDb(band, 0)])
  assert.equal(linePoints([], -6, 0, 4, 400, band).length, 2, 'a flat line is two points')
})

test('a press takes a keyframe before the line, the line within 4 points, nothing elsewhere', () => {
  const keys = [{ time: 1, mediaTime: 1, value: 0 }]
  const band = bandOf(62)
  const keyY = yOfDb(band, 0)
  assert.deepEqual(bandHit(keys, 0, 0, 4, 400, 62, 101, keyY + 2), { kind: 'key', index: 0 })
  assert.deepEqual(bandHit(keys, 0, 0, 4, 400, 62, 300, keyY + 3), { kind: 'line' })
  assert.equal(bandHit(keys, 0, 0, 4, 400, 62, 300, keyY + 9), null)
  assert.equal(bandHit(keys, 0, 0, 4, 400, 20, 300, 10), null, 'a short clip has no band')
  assert.equal(bandHit(keys, 0, 0, 0, 400, 62, 300, keyY), null, 'nor a clip with no length')
})

test('a keyframe moved in time lands on a frame, a frame from its neighbours, inside the clip', () => {
  const keys = [{ time: 1, mediaTime: 0, value: 0 }, { time: 2, mediaTime: 0, value: 0 }, { time: 3, mediaTime: 0, value: 0 }]
  const frame = 0.1
  assert.ok(Math.abs(keyTimeBetween(keys, 1, 2.34, frame, 0, 5) - 2.3) < 1e-9)
  assert.ok(Math.abs(keyTimeBetween(keys, 1, 0.5, frame, 0, 5) - 1.1) < 1e-9, 'not onto the one before')
  assert.ok(Math.abs(keyTimeBetween(keys, 1, 9, frame, 0, 5) - 2.9) < 1e-9, 'not onto the one after')
  assert.ok(Math.abs(keyTimeBetween(keys, 2, 9, frame, 0, 5) - 4.9) < 1e-9, 'not past the clip')
  assert.equal(dbText(FADER_MIN_DB), '-∞ dB')
  assert.equal(dbText(3.14159), '+3.14 dB')
  assert.equal(dbText(-6), '-6.00 dB')
})

test('fade handles: only at a free clip end, at the fade\'s length, and the one command a drag sends', () => {
  const track = {
    clips: [{ id: 1, start: 0, duration: 4 }, { id: 2, start: 4, duration: 4 }, { id: 3, start: 10, duration: 2 }],
    transitions: [{ id: 9, start: 10, duration: 0.5, from: null, to: 3 }],
  }
  const frame = 0.04
  assert.equal(fadeAt(track, 1, 'out', frame), null, 'a cut is not a free end')
  assert.equal(fadeAt(track, 2, 'in', frame), null)
  assert.deepEqual(fadeAt(track, 1, 'in', frame), { transition: null, duration: 0 })
  assert.deepEqual(fadeAt(track, 3, 'in', frame), { transition: track.transitions[0], duration: 0.5 })
  assert.deepEqual(fadeAt(track, 3, 'out', frame), { transition: null, duration: 0 })
  assert.equal(fadeAt(track, 7, 'in', frame), null)
  // The handle sits inside the clip, its outer side the fade's length in from the end.
  assert.equal(handleX('in', 0, 200), 0)
  assert.equal(handleX('in', 50, 200), 50)
  assert.equal(handleX('out', 0, 200), 200 - HANDLE_SIZE)
  assert.equal(handleX('out', 500, 200), 0)
  assert.ok(onHandle('in', 0, 200, 4, 4))
  assert.ok(!onHandle('in', 0, 200, 4, 20), 'only at the top corner')
  assert.ok(!onHandle('in', 0, 20, 4, 4), 'a clip too narrow has none')
  // The drag: frames from the end, at most half the clip.
  assert.equal(draggedFrames('in', 50, 200, 100, frame, 2), 13)
  assert.equal(draggedFrames('out', 150, 200, 100, frame, 2), 13)
  assert.equal(draggedFrames('in', -30, 200, 100, frame, 2), 0)
  assert.equal(draggedFrames('in', 5000, 200, 100, frame, 2), 25)
  assert.equal(draggedFrames('in', 50, 200, 0, frame, 2), 0)
  assert.deepEqual(fadeCommand('audio', 3, 'out', null, 12, frame), { id: 'sequence.applyAudioTransition', params: { clip: 3, edge: 'out', frames: 12 } })
  assert.deepEqual(fadeCommand('video', 1, 'in', null, 12, frame), { id: 'sequence.applyVideoTransition', params: { clip: 1, edge: 'in', frames: 12 } })
  assert.equal(fadeCommand('video', 1, 'in', null, 0, frame), null, 'no fade, none made')
  assert.deepEqual(fadeCommand('video', 3, 'in', { id: 9, duration: 0.5 }, 20, frame), { id: 'sequence.setTransition', params: { transition: 9, frames: 20 } })
  assert.deepEqual(fadeCommand('video', 3, 'in', { id: 9, duration: 0.5 }, 0, frame), { id: 'sequence.removeTransition', params: { transitions: [9] } })
  assert.equal(fadeCommand('video', 3, 'in', { id: 9, duration: 0.5 }, 13, frame), null, 'unchanged')
})

test('the ruler: a marker by place, a dragged In or Out mark on a frame and on its side of the other', async () => {
  const { draggedMark, laneMenuState, markerNear, rulerTicks } = await import('./menusAt.ts')
  const markers = [{ id: 1, start: 1, duration: 0 }, { id: 2, start: 2, duration: 1 }]
  const view = { pps: 100, scroll: 0 }
  assert.equal(markerNear(markers, view, 103, 5)?.id, 1, 'its head')
  assert.equal(markerNear(markers, view, 250, 5)?.id, 2, 'its span')
  assert.equal(markerNear(markers, view, 103, 30), null, 'not below the markers row')
  assert.equal(markerNear(markers, view, 150, 5), null)
  const fps = 25
  assert.ok(Math.abs(draggedMark('in', 1.013, fps, null) - 1) < 1e-9, 'on a frame')
  assert.ok(Math.abs(draggedMark('in', 5, fps, 2) - 2) < 1e-9, 'the In stops at the Out')
  // The Out mark is its frame's start: the band's end, a frame later, follows the pointer.
  assert.ok(Math.abs(draggedMark('out', 3, fps, null) - (3 - 1 / fps)) < 1e-9)
  assert.ok(Math.abs(draggedMark('out', 0.5, fps, 2) - 2) < 1e-9, 'the Out stops at the In')
  assert.equal(draggedMark('in', -4, fps, null), 0)
  assert.equal(rulerTicks(1.013, fps, 1000), 1000)
  assert.equal(rulerTicks(Number.NaN, fps, 1000), 0)
  assert.equal(rulerTicks(1, 0, 1000), 0)
  const track = { clips: [{ id: 1, start: 0, duration: 2 }, { id: 2, start: 4, duration: 2 }] }
  assert.deepEqual(laneMenuState(track, 3, 0.04), { gap: true, forward: [2] })
  assert.deepEqual(laneMenuState(track, 1, 0.04), { gap: false, forward: [1, 2] })
  assert.deepEqual(laneMenuState(track, 7, 0.04), { gap: false, forward: [] })
})
