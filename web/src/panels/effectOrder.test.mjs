import test from 'node:test'
import assert from 'node:assert/strict'
import { dropIndex, effectOrderKey, neighbourIndex } from './effectOrder.ts'

// Gaussian Blur (0), Invert (1), Tint (2), then Motion (3) and Opacity (4), drawn fixed first.
const rows = [
  { index: 3, intrinsic: true, top: 0, height: 20 },
  { index: 4, intrinsic: true, top: 20, height: 20 },
  { index: 0, intrinsic: false, top: 40, height: 20 },
  { index: 1, intrinsic: false, top: 60, height: 20 },
  { index: 2, intrinsic: false, top: 80, height: 20 },
]

test('move up and down step among the standard effects only', () => {
  assert.equal(neighbourIndex(rows, 1, -1), 0)
  assert.equal(neighbourIndex(rows, 1, 1), 2)
  assert.equal(neighbourIndex(rows, 0, -1), null, 'the first standard effect does not pass the fixed ones')
  assert.equal(neighbourIndex(rows, 2, 1), null, 'the last stays last')
  assert.equal(neighbourIndex(rows, 3, 1), null, 'a fixed effect does not move')
})

test('a drag lands before the row whose middle is below the pointer', () => {
  assert.deepEqual(dropIndex(rows, 2, 45), { to: 0, lineY: 40 }, 'Tint to the top of the standard effects')
  assert.deepEqual(dropIndex(rows, 0, 95), { to: 2, lineY: 100 }, 'Gaussian Blur to the end')
  assert.deepEqual(dropIndex(rows, 0, 75), { to: 1, lineY: 80 }, 'between Invert and Tint')
  assert.deepEqual(dropIndex(rows, 1, 65), { to: null, lineY: 60 }, 'its own place: no move')
  assert.deepEqual(dropIndex(rows, 2, 0), { to: 0, lineY: 40 }, 'above the fixed effects: the first standard place')
  assert.equal(dropIndex(rows, 3, 50), null, 'a fixed effect is not dragged')
})

// regressions/issue-effect-menu-stale-order: a right-click on a row drawn before an undo reordered
// the effects opened a menu that acted on the effect now at that row's index (Move Effect Down on
// Invert moved Gaussian Blur). The menu keeps the order its row was drawn from and closes when the
// panel draws another; the key tells the two apart.
test('the order key changes when two effects swap and only then', () => {
  const blurFirst = [{ index: 0, id: 'gaussian_blur' }, { index: 1, id: 'invert' }, { index: 2, id: 'motion' }]
  const invertFirst = [{ index: 0, id: 'invert' }, { index: 1, id: 'gaussian_blur' }, { index: 2, id: 'motion' }]
  assert.notEqual(effectOrderKey(10, blurFirst), effectOrderKey(10, invertFirst), 'a swap is another order')
  assert.equal(effectOrderKey(10, blurFirst), effectOrderKey(10, blurFirst.map((effect) => ({ ...effect, enabled: false }))), 'values do not change the order')
  assert.notEqual(effectOrderKey(10, blurFirst), effectOrderKey(11, blurFirst), 'another clip is another order')
})
