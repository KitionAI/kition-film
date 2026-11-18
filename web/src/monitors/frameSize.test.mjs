// The Source monitor asks `itemFrame` for its drawn width, within the engine's caps.
import test from 'node:test'
import assert from 'node:assert/strict'
import { frameWidth } from './frameSize.ts'

test('the drawn width times the device scale', () => {
  assert.equal(frameWidth(548, 2, 9 / 16), 1096)
})

test('at most 2048 wide, and at most 4 MP for the picture the last frame showed', () => {
  assert.equal(frameWidth(3000, 1, 9 / 16), 2048)
  // A tall picture (portrait 1:2) fits 4,194,304 pixels at 1448 wide.
  const width = frameWidth(1800, 1, 2)
  assert.equal(width, 1448)
  assert.ok(width * width * 2 <= 4_194_304)
})

test('before any frame, only the width cap applies', () => {
  assert.equal(frameWidth(1200, 2, null), 2048)
})
