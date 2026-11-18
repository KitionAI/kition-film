// When the editor reads its session state, labels, and keys again.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checksPrefs, createPrefsCheck, rereadsAfter, skipsStateRead } from './reads.ts'

test('the playheads never read the session state: playback moves them every frame', () => {
  assert.equal(skipsStateRead('playhead.set'), true)
  assert.equal(skipsStateRead('playhead.stepForward5'), true)
  assert.equal(skipsStateRead('source.setPlayhead'), true)
  assert.equal(skipsStateRead('sequence.snap'), false)
  assert.deepEqual(rereadsAfter('playhead.set', 4, 4), { state: false, labels: false, keys: false, projectView: false })
  assert.deepEqual(rereadsAfter('source.setPlayhead', 4, 4), { state: false, labels: false, keys: false, projectView: false })
})

test('a command that changes state without a new revision reads it once more; one with a new revision leaves it to the revision', () => {
  assert.equal(rereadsAfter('sequence.snap', 4, 4).state, true)
  assert.equal(rereadsAfter('markers.markIn', 4, 5).state, false)
})

test('preferences and shortcut changes read the labels and the key table again; their queries do not', () => {
  assert.equal(rereadsAfter('prefs.set', 4, 4).labels, true)
  assert.equal(rereadsAfter('prefs.get', 4, 4).labels, false)
  assert.equal(rereadsAfter('shortcuts.set', 4, 4).keys, true)
  assert.equal(rereadsAfter('shortcuts.list', 4, 4).keys, false)
  assert.equal(rereadsAfter('markers.markIn', 4, 5).keys, false)
})

test("the preferences' revision is asked after a command, not after a playhead move or a drag's merged steps (once on its release)", () => {
  assert.equal(checksPrefs('project.view.set', {}), true)
  assert.equal(checksPrefs('prefs.set', { key: 'trim.largeTrimOffset', value: 3 }), true)
  assert.equal(checksPrefs('playhead.set', { time: 0 }), false)
  assert.equal(checksPrefs('source.setPlayhead', {}), false)
  // A fader or slider drag: the first step and the release ask, the steps between do not.
  assert.equal(checksPrefs('mixer.setValue', { begin: true }), true)
  assert.equal(checksPrefs('mixer.setValue', { merge: true }), false)
  assert.equal(checksPrefs('mixer.setValue', {}), true)
})

test("a drag's merged steps ask the preferences' revision once, after the drag has rested, so its end or cancel (sent merged or not) is stored", () => {
  const timers = new Map()
  let next = 0
  let checks = 0
  const after = createPrefsCheck(() => (checks += 1), 250, (task, ms) => (timers.set((next += 1), { task, ms }), next), (id) => timers.delete(id))
  const fire = () => {
    const pending = [...timers.values()]
    timers.clear()
    for (const { task } of pending) task()
  }
  after('mixer.setValue', { begin: true })
  assert.equal(checks, 1, 'the first step asks')
  for (let i = 0; i < 30; i += 1) after('mixer.setValue', { merge: true })
  assert.equal(checks, 1, 'merged steps wait')
  assert.equal(timers.size, 1, 'one timer, moved on by each step')
  fire()
  assert.equal(checks, 2, 'once after the last merged step')
  after('playhead.set', { time: 0 })
  assert.equal(timers.size, 0)
  assert.equal(checks, 2, 'playheads never ask')
})
