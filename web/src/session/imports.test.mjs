import test from 'node:test'
import assert from 'node:assert/strict'
import { failureReason, fileName, importMessage, importReport } from './imports.ts'

const t = (key, values = {}) => `${key}${Object.keys(values).length ? JSON.stringify(values) : ''}`

test('several files imported in one go are one message', () => {
  const report = importReport(['../clips/a.mp4', '../clips/b.wav', 'c.png'], { items: [4, 5, 6], errors: [] }, null)
  assert.deepEqual(report, { imported: 3, items: [4, 5, 6], failures: [] })
  assert.deepEqual(importMessage(report, t), { text: 'import.done{"count":3}', error: false })
})

test('the files that did not come in are named, each with its reason', () => {
  const report = importReport(['../clips/a.mp4', '../clips/broken.mp4', 'x.xyz'], { items: [4], errors: ['../clips/broken.mp4: media: truncated box', 'x.xyz: unsupported file type'] }, null)
  assert.deepEqual(report.failures, [
    { name: 'broken.mp4', reason: 'damaged' },
    { name: 'x.xyz', reason: 'format' },
  ])
  const message = importMessage(report, t)
  assert.equal(message.error, true)
  assert.match(message.text, /^import\.some\{"count":1,"failures":"import\.failure.*broken\.mp4.*import\.reason\.damaged.*x\.xyz.*import\.reason\.format/)
})

test('a refusal (no file came in) names every file from its joined errors', () => {
  const report = importReport(['../clips/broken.mp4', '../clips/gone.mp4'], null, '../clips/broken.mp4: bad header; ../clips/gone.mp4: media offline: ../clips/gone.mp4')
  assert.deepEqual(report, { imported: 0, items: [], failures: [{ name: 'broken.mp4', reason: 'damaged' }, { name: 'gone.mp4', reason: 'missing' }] })
  assert.match(importMessage(report, t).text, /^import\.none/)
  // A refusal that names no file is every file's.
  assert.deepEqual(importReport(['a.mp4'], null, 'command `file.import` is not available right now').failures, [{ name: 'a.mp4', reason: 'damaged' }])
})

test('reasons and names', () => {
  assert.equal(failureReason('media offline: x'), 'missing')
  assert.equal(failureReason('unsupported codec'), 'format')
  assert.equal(failureReason('moov box truncated'), 'damaged')
  assert.equal(fileName('../clips/a b.mp4'), 'a b.mp4')
  assert.equal(fileName('c:\\\\media\\\\x.wav'), 'x.wav')
})
