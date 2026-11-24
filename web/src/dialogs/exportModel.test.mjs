import test from 'node:test'
import assert from 'node:assert/strict'
import { exportOptions, exportSize, frameOf, initialDraft, rateText, sequenceOf } from './exportModel.ts'

const seq = { id: 7, name: 'Main', width: 1280, height: 720, fps: 24000 / 1001, hasInOut: false, duration: 10 }

test('the dialog opens on the active sequence, the whole of it without In and Out marks, In to Out with them', () => {
  assert.deepEqual(initialDraft(seq), { sequence: 7, range: 'entire', size: 'sequence', rate: 'sequence', quality: 'default', bitrateMbps: 20 })
  assert.equal(initialDraft({ ...seq, hasInOut: true }).range, 'inOut')
  assert.equal(initialDraft(null).sequence, null)
})

test('left as it opens, the export names only the sequence and its range', () => {
  assert.deepEqual(exportOptions(initialDraft(seq), seq), { sequence: 7, range: 'entire' })
  // In to Out is only asked for a sequence that has both marks.
  assert.deepEqual(exportOptions({ ...initialDraft(seq), range: 'inOut' }, seq), { sequence: 7, range: 'entire' })
  assert.deepEqual(exportOptions({ ...initialDraft(seq), range: 'inOut' }, { ...seq, hasInOut: true }), { sequence: 7, range: 'inOut' })
})

test('a frame height keeps the sequence shape with an even width', () => {
  assert.deepEqual(frameOf(seq, 1080), { width: 1920, height: 1080 })
  assert.deepEqual(frameOf({ width: 1000, height: 1000 }, 360), { width: 360, height: 360 })
  assert.deepEqual(frameOf({ width: 1440, height: 1080 }, 540), { width: 720, height: 540 })
  assert.deepEqual(frameOf({ width: 0, height: 0 }, 720), { width: 1280, height: 720 })
  assert.deepEqual(exportSize({ ...initialDraft(seq), size: '540' }, seq), { width: 960, height: 540 })
})

test('size, rate, quality and bitrate become file.exportMedia parameters', () => {
  const draft = { ...initialDraft(seq), size: '360', rate: '25', quality: 'high' }
  assert.deepEqual(exportOptions(draft, seq), { sequence: 7, range: 'entire', width: 640, height: 360, fps: 25, quality: 90 })
  assert.deepEqual(exportOptions({ ...initialDraft(seq), quality: 'bitrate', bitrateMbps: 8.5 }, seq), { sequence: 7, range: 'entire', bitrateKbps: 8500 })
  assert.equal(exportOptions({ ...initialDraft(seq), quality: 'bitrate', bitrateMbps: 0 }, seq).bitrateKbps, 1000)
  assert.equal(exportOptions({ ...initialDraft(seq), quality: 'bitrate', bitrateMbps: 9999 }, seq).bitrateKbps, 200_000)
})

test('sequence.inspect answers are read for the dialog, and a malformed one is none', () => {
  const inspected = { settings: { width: 1920, height: 1080, frame_rate: { num: 30, den: 1 } }, in: 1, out: 2, duration: 5 }
  assert.deepEqual(sequenceOf(3, 'B', inspected), { id: 3, name: 'B', width: 1920, height: 1080, fps: 30, hasInOut: true, duration: 5 })
  assert.equal(sequenceOf(3, 'B', null), null)
  assert.equal(sequenceOf(3, 'B', { settings: { width: 0, height: 1 } }), null)
  assert.equal(rateText(30), '30')
  assert.equal(rateText(24000 / 1001), '23.976')
  assert.equal(rateText(29.97), '29.97')
})
