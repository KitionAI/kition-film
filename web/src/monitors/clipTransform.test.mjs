// A video clip's Motion box on the Program monitor, against upstream's `transform_handles.rs`
// (`placement`, `grab_at`, `scale_factors`, `changes`, `clip_under`) and the engine's `motion_matrix`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { beginBoxDrag, boxChanges, clipUnder, followRotation, grabAt, motionMatrix, motionOf, pictureClips, placementOf, scaleFactors, sizeOfVideoLine } from './clipTransform.ts'

const SEQ = { width: 1920, height: 1080 }
const FIT = { zoom: 0.5, x: 0, y: 0 }
const motion = (over = {}) => ({ position: [960, 540], anchor: [320, 180], scale: 100, scaleWidth: 100, rotation: 0, uniform: true, enabled: true, ...over })
const clip = (over = {}, size = { width: 640, height: 360 }) => ({ clip: 7, size, motion: motion(over) })
const close = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} != ${b}`)

test('the matrix is the engine motion_matrix: translate to Position, rotate, scale, minus the anchor point', () => {
  const m = motionMatrix(clip({ scale: 200, rotation: 90 }), SEQ)
  // The anchor point lands on Position.
  close(m[0] * 320 + m[2] * 180 + m[4], 960, 'anchor x')
  close(m[1] * 320 + m[3] * 180 + m[5], 540, 'anchor y')
  // Rotated 90° clockwise on screen (y down): the clip's +x goes to screen +y, scaled 2.
  close(m[0], 0, 'a')
  close(m[1], 2, 'b')
  // Auto points are the frame's and the source's centres; a Motion that is off places the clip unscaled at the centre.
  const auto = motionMatrix(clip({ position: null, anchor: null }), SEQ)
  close(auto[4], 960 - 320, 'auto e')
  const off = motionMatrix(clip({ enabled: false, scale: 50, position: [0, 0] }), SEQ)
  close(off[0], 1, 'off scale')
  close(off[4], 640, 'off e')
})

test('the box on screen at the view, its handles grabbed before the box, the rotate zone just outside it', () => {
  const pl = placementOf(clip(), SEQ, FIT)
  assert.deepEqual(pl.quad.map((p) => [p.x, p.y]), [[320, 180], [640, 180], [640, 360], [320, 360]])
  assert.deepEqual(grabAt(pl, { x: 480, y: 270 }), { kind: 'anchor' })
  assert.deepEqual(grabAt(pl, { x: 643, y: 362 }), { kind: 'handle', n: 2 })
  assert.deepEqual(grabAt(pl, { x: 400, y: 200 }), { kind: 'move' })
  assert.deepEqual(grabAt(pl, { x: 660, y: 170 }), { kind: 'rotate' })
  assert.equal(grabAt(pl, { x: 700, y: 100 }), null, 'farther out takes nothing')
})

test('a move is Position plus the pointer travel in sequence pixels; the anchor point moves with Position following', () => {
  const pl = placementOf(clip(), SEQ, FIT)
  const move = beginBoxDrag(pl, { kind: 'move' }, { x: 400, y: 200 })
  assert.deepEqual(boxChanges(move, { x: 450, y: 210 }, { x: 50, y: 10 }), [['position', [1060, 560]]])
  const anchor = beginBoxDrag(pl, { kind: 'anchor' }, pl.anchorAt)
  assert.deepEqual(boxChanges(anchor, { x: 490, y: 270 }, { x: 10, y: 0 }), [['anchor', [340, 180]], ['position', [980, 540]]])
})

test('handles scale about the anchor point: uniform both ways, one side alone with Uniform Scale off', () => {
  const pl = placementOf(clip(), SEQ, FIT)
  const [fx, fy] = scaleFactors(pl, 2, pl.quad[2], { x: 800, y: 450 })
  close(fx, 2, 'corner fx')
  close(fy, 2, 'corner fy')
  const corner = beginBoxDrag(pl, { kind: 'handle', n: 2 }, pl.quad[2])
  assert.deepEqual(boxChanges(corner, { x: 800, y: 450 }, { x: 160, y: 90 }), [['scale', 200]])
  const free = placementOf(clip({ uniform: false }), SEQ, FIT)
  const side = beginBoxDrag(free, { kind: 'handle', n: 5 }, { x: 640, y: 270 })
  assert.deepEqual(boxChanges(side, { x: 560, y: 270 }, { x: -80, y: 0 }), [['scale_width', 50]])
  const both = beginBoxDrag(free, { kind: 'handle', n: 2 }, free.quad[2])
  assert.deepEqual(boxChanges(both, { x: 640, y: 450 }, { x: 0, y: 90 }).map(([param]) => param), ['scale', 'scale_width'])
})

test('a rotation adds up its turn about the anchor point, past a half turn', () => {
  const pl = placementOf(clip(), SEQ, FIT)
  const drag = beginBoxDrag(pl, { kind: 'rotate' }, { x: 580, y: 270 })
  for (const [x, y] of [[480, 370], [380, 270], [480, 170], [580, 270]]) followRotation(drag, { x, y })
  close(drag.turned, 360, 'a whole clockwise turn')
  assert.deepEqual(boxChanges(drag, { x: 580, y: 270 }, { x: 0, y: 0 }), [['rotation', 360]])
})

test('the clip under the pointer is the front-most whose box holds it', () => {
  const small = { ...clip({ scale: 50 }), clip: 9 }
  const big = clip()
  assert.equal(clipUnder([small, big], SEQ, FIT, { x: 480, y: 270 })?.clip, 9)
  assert.equal(clipUnder([small, big], SEQ, FIT, { x: 330, y: 190 })?.clip, 7)
  assert.equal(clipUnder([small, big], SEQ, FIT, { x: 10, y: 10 }), null)
})

test("Motion's values read from clipEffects or inspect, and a frame size from itemInfo's video line", () => {
  assert.deepEqual(motionOf({ enabled: true, params: [{ id: 'position', value: [1, 2] }, { id: 'scale', value: 50 }, { id: 'uniform_scale', value: false }] }), { position: [1, 2], anchor: null, scale: 50, scaleWidth: 100, rotation: 0, uniform: false, enabled: true })
  assert.equal(motionOf({ params: { rotation: { value: 30 } } }).rotation, 30)
  assert.equal(motionOf(null), null)
  assert.deepEqual(sizeOfVideoLine('30 fps, 1920 x 1080 (1.0000)'), { width: 1920, height: 1080 })
  assert.equal(sizeOfVideoLine(null), null)
})

test('the clips in the picture: enabled tracks top first, holding the playhead, graphics left out', () => {
  const state = {
    playhead: 10,
    project: { root: { children: [{ item: 1, type: 'Movie' }, { item: 2, type: 'Graphic' }, { item: 3, type: 'Still Image' }] } },
    sequence: {
      selection: [30],
      video: [
        { items: [{ clip: 10, item: 1, start: 0, end: 20 }] },
        { items: [{ clip: 20, item: 2, start: 0, end: 20 }] },
        { locked: true, items: [{ clip: 30, item: 3, start: 5, end: 11 }] },
        { enabled: false, items: [{ clip: 40, item: 1, start: 0, end: 20 }] },
      ],
    },
  }
  assert.deepEqual(pictureClips(state), [
    { clip: 30, item: 3, locked: true, selected: true },
    { clip: 10, item: 1, locked: false, selected: false },
  ])
  assert.deepEqual(pictureClips({ ...state, playhead: 20 }), [])
})
