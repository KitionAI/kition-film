import test from 'node:test'
import assert from 'node:assert/strict'
import { alignmentOf, cutOf, dragEnd, dropEdge, durationCommand, grabEnd, maxFrames, resizedFrames, transitionSpan } from './transitions.ts'

const F = 10
const clips = new Map([
  [1, { id: 1, start: 0, duration: 100 }],
  [2, { id: 2, start: 100, duration: 60 }],
])

test('the engine places a transition centred on a cut, from a free In, or up to a free Out (start snapped down to a frame)', () => {
  assert.equal(alignmentOf(1, 2), 'center')
  assert.equal(alignmentOf(null, 2), 'start')
  assert.equal(alignmentOf(1, null), 'end')
  assert.deepEqual(transitionSpan(100, 30, 'center', F), { start: 80, duration: 30 })
  assert.deepEqual(transitionSpan(100, 30, 'start', F), { start: 100, duration: 30 })
  assert.deepEqual(transitionSpan(100, 30, 'end', F), { start: 70, duration: 30 })
  assert.equal(cutOf({ from: 1, to: 2, start: 85, duration: 30 }, clips), 100)
  assert.equal(cutOf({ from: 2, to: null, start: 130, duration: 30 }, clips), 160)
})

test('a new length is the same transition set again by its id: sequence.setTransition with its frames (its settings stay)', () => {
  const info = { id: 9, effect: 'dip_to_color', start: 85, duration: 30, from: 1, to: 2, params: { color: '#ff0000' }, reverse: true }
  // Between two clips: its length, and the alignment chosen with it.
  assert.deepEqual(durationCommand(info, 'video', 12), { id: 'sequence.setTransition', params: { transition: 9, frames: 12 } })
  assert.deepEqual(durationCommand(info, 'video', 12, 'start'), { id: 'sequence.setTransition', params: { transition: 9, frames: 12, align: 'start' } })
  assert.deepEqual(durationCommand(info, 'video', 12.4), { id: 'sequence.setTransition', params: { transition: 9, frames: 12 } }, 'whole frames')
  // A fade to or from nothing (audio here, at a clip's Out): its length only, it stays on its clip's edge.
  assert.deepEqual(durationCommand({ ...info, from: 2, to: null, params: {} }, 'audio', 3), { id: 'sequence.setTransition', params: { transition: 9, frames: 3 } })
  assert.deepEqual(durationCommand({ ...info, from: 2, to: null, params: {} }, 'audio', 3, 'start'), { id: 'sequence.setTransition', params: { transition: 9, frames: 3 } })
  assert.deepEqual(durationCommand({ ...info, from: null, to: 2 }, 'video', 5), { id: 'sequence.setTransition', params: { transition: 9, frames: 5 } })
  // No clips to sit on, or no length: nothing to send.
  assert.equal(durationCommand({ ...info, from: null, to: null }, 'video', 3), null)
  assert.equal(durationCommand(info, 'video', 0), null)
})

test('dragging an end resizes in whole frames, both sides of a centred one, kept within the clips', () => {
  assert.equal(maxFrames({ from: 1, to: 2 }, clips, F), 12)
  assert.equal(resizedFrames(100, 'center', 130, F, 12), 6)
  assert.equal(resizedFrames(100, 'center', 300, F, 12), 12)
  assert.equal(resizedFrames(100, 'center', 100, F, 12), 1)
  const span = { start: 85, duration: 30 }
  assert.equal(grabEnd(span, 100, 'center', 114, 3), 1)
  assert.equal(grabEnd(span, 100, 'center', 86, 3), -1)
  assert.equal(grabEnd(span, 100, 'center', 100, 3), null)
  const grab = { id: 9, cut: 100, alignment: 'center', side: 1, end: 115, pressT: 114, frames: 3, limit: 12 }
  assert.deepEqual(dragEnd(grab, 134, (t) => t, F), { frames: 7, start: 60, duration: 70 })
  // The left end of a centred one dragged left lengthens it too; past the cut it stops at a frame.
  assert.equal(dragEnd({ ...grab, side: -1, end: 85, pressT: 86 }, 66, (t) => t, F).frames, 7)
  assert.equal(dragEnd(grab, 0, (t) => t, F).frames, 1)
})

test('a transition dropped on a clip goes to its nearer edge, centred where another clip meets it', () => {
  const list = [...clips.values()]
  assert.deepEqual(dropEdge(clips.get(2), list, 110), { edge: 'in', cut: 100, alignment: 'center' })
  assert.deepEqual(dropEdge(clips.get(2), list, 150), { edge: 'out', cut: 160, alignment: 'end' })
  assert.deepEqual(dropEdge(clips.get(1), list, 10), { edge: 'in', cut: 0, alignment: 'start' })
})
