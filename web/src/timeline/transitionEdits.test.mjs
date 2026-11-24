import test from 'node:test'
import assert from 'node:assert/strict'
import { alignedMaxFrames, alignmentAt, boundsOf, dragEnd, dropAlignment, removeCommand, slideSpan, spanCommand } from './transitions.ts'

const F = 10
const clips = new Map([
  [1, { id: 1, start: 0, duration: 100 }],
  [2, { id: 2, start: 100, duration: 60 }],
])

test('a transition between two clips may sit anywhere over the cut inside them; its alignment reads its span', () => {
  assert.deepEqual(boundsOf({ from: 1, to: 2 }, clips), { lo: 0, cut: 100, hi: 160 })
  assert.deepEqual(boundsOf({ from: null, to: 2 }, clips), { lo: 100, cut: 100, hi: 160 })
  assert.deepEqual(boundsOf({ from: 2, to: null }, clips), { lo: 100, cut: 160, hi: 160 })
  assert.equal(boundsOf({ from: 7, to: null }, clips), null)
  assert.equal(alignmentAt({ from: 1, to: 2, start: 85, duration: 30 }, 100, F), 'center')
  assert.equal(alignmentAt({ from: 1, to: 2, start: 100, duration: 30 }, 100, F), 'start')
  assert.equal(alignmentAt({ from: 1, to: 2, start: 70, duration: 30 }, 100, F), 'end')
  assert.equal(alignmentAt({ from: 1, to: 2, start: 60, duration: 50 }, 100, F), 'custom')
  assert.equal(alignedMaxFrames({ from: 1, to: 2 }, clips, 'center', F), 12)
  assert.equal(alignedMaxFrames({ from: 1, to: 2 }, clips, 'start', F), 6)
  assert.equal(alignedMaxFrames({ from: 1, to: 2 }, clips, 'end', F), 10)
  assert.equal(alignedMaxFrames({ from: 1, to: 2 }, clips, 'custom', F), 16)
})

test('dragging the middle slides it over its cut on frames; a fade does not slide', () => {
  const t = { from: 1, to: 2, start: 85, duration: 30 }
  assert.deepEqual(slideSpan(t, clips, 12, F), { start: 100, duration: 30 }, 'its start stops at the cut')
  assert.deepEqual(slideSpan(t, clips, -6, F), { start: 80, duration: 30 })
  assert.deepEqual(slideSpan(t, clips, -100, F), { start: 70, duration: 30 }, 'its end stops at the cut')
  assert.deepEqual(slideSpan({ ...t, from: null }, clips, 10, F), { start: 85, duration: 30 })
})

test('an end of one moved off centre trims its own side only, over the cut and inside the clips', () => {
  const grab = { id: 9, cut: 100, alignment: 'custom', side: 1, end: 110, pressT: 110, frames: 5, limit: 16, lo: 0, hi: 160, other: 60 }
  assert.deepEqual(dragEnd(grab, 130, (t) => t, F), { frames: 7, start: 60, duration: 70 })
  assert.deepEqual(dragEnd(grab, 500, (t) => t, F), { frames: 10, start: 60, duration: 100 }, 'stops at the incoming clip’s end')
  assert.deepEqual(dragEnd(grab, 0, (t) => t, F), { frames: 4, start: 60, duration: 40 }, 'stops at the cut')
  const left = { ...grab, side: -1, end: 60, pressT: 60, other: 110 }
  assert.deepEqual(dragEnd(left, 30, (t) => t, F), { frames: 8, start: 30, duration: 80 })
  assert.deepEqual(dragEnd(left, -50, (t) => t, F), { frames: 11, start: 0, duration: 110 }, 'stops at the outgoing clip’s start')
  assert.deepEqual(dragEnd(left, 300, (t) => t, F), { frames: 1, start: 100, duration: 10 }, 'stops at the cut')
})

test('a drop on a cut: on it centred, left of it ending there, right of it starting there; at a free edge its one alignment', () => {
  const cut = { cut: 100, alignment: 'center' }
  assert.equal(dropAlignment(cut, 104, 8), 'center')
  assert.equal(dropAlignment(cut, 80, 8), 'end')
  assert.equal(dropAlignment(cut, 120, 8), 'start')
  assert.equal(dropAlignment({ cut: 0, alignment: 'start' }, 50, 8), 'start')
})

test('a drag, a new place or Clear is one sequence.setTransition or sequence.removeTransition', () => {
  const t = { id: 4, start: 85, duration: 30 }
  assert.equal(spanCommand(t, 85, 30), null)
  assert.deepEqual(spanCommand(t, 90, 30), { id: 'sequence.setTransition', params: { transition: 4, start: 90 } })
  assert.deepEqual(spanCommand(t, 85, 40), { id: 'sequence.setTransition', params: { transition: 4, start: 85, duration: 40 } })
  assert.deepEqual(removeCommand(t), { id: 'sequence.removeTransition', params: { transitions: [4] } })
})
