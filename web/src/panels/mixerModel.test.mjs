import test from 'node:test'
import assert from 'node:assert/strict'
import { faderDb, faderY, levelText, panText, stripsOf } from './mixerModel.ts'

test('mixer.inspect reads into the audio tracks\' strips, then the Mix; submixes are left out', () => {
  const strips = stripsOf({
    strips: [
      { id: 0, ref: 'Mix', name: 'Mix', kind: 'mix', volumeDb: -3, pan: 0, muted: false, solo: false, at: { volumeDb: -3, pan: 0 } },
      { id: 5, ref: 'A1', name: 'Audio 1', kind: 'audio', volumeDb: 0, pan: 0, muted: true, solo: false, at: { volumeDb: -6, pan: -20 } },
      { id: 9, ref: 'S1', name: 'Submix 1', kind: 'submix' },
      null,
      { id: 6, ref: 'A2', name: 'Audio 2', kind: 'audio', volumeDb: 2, pan: 500, solo: true },
    ],
  })
  assert.deepEqual(strips, [
    { ref: 'A1', track: 5, name: 'Audio 1', kind: 'audio', volumeDb: -6, pan: -20, muted: true, solo: false },
    { ref: 'A2', track: 6, name: 'Audio 2', kind: 'audio', volumeDb: 2, pan: 100, muted: false, solo: true },
    { ref: 'Mix', track: 0, name: 'Mix', kind: 'mix', volumeDb: -3, pan: 0, muted: false, solo: false },
  ])
  assert.deepEqual(stripsOf(null), [])
})

test('the fader runs on upstream\'s taper: 0 dB three quarters up, silence at the foot', () => {
  assert.ok(Math.abs(faderY(100, 0) - 24) < 1e-9)
  assert.equal(faderY(100, 15), 0)
  assert.equal(faderY(100, -200), 100)
  assert.ok(Math.abs(faderDb(100, 24)) < 1e-9)
  assert.equal(faderDb(100, 100), -96)
  assert.equal(faderDb(100, -10), 15)
  for (const db of [-40, -12, -6, 3]) assert.ok(Math.abs(faderDb(160, faderY(160, db)) - db) < 1e-9, String(db))
})

test('levels and pans as a strip reads them', () => {
  assert.equal(levelText(0), '0.0')
  assert.equal(levelText(2.46), '+2.5')
  assert.equal(levelText(-12), '-12.0')
  assert.equal(levelText(-96), '-∞')
  assert.equal(panText(0.2), '0')
  assert.equal(panText(-40), 'L 40')
  assert.equal(panText(100), 'R 100')
})
