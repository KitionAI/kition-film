import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvoke } from './invoke.ts'
import { createPlayback } from './playback.ts'

const T = 254_016_000_000
function setup() {
  let context = {}
  let item = 5
  let position = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const seeks = []
  const errors = []
  const query = async id => id === 'source.inspect'
    ? { item, playhead: position, start: 0, end: 10 * T, fps: 24 }
    : { stepManyFrames: 7 }
  const run = async (id, params) => {
    assert.equal(id, 'source.setPlayhead')
    seeks.push({ item, ...params })
    position = params.time ?? params.frame * T / 24
    if (seeks.length === 1) await gate
    return { time: position }
  }
  const playback = createPlayback({
    now: () => 0,
    frame: () => () => undefined,
    sourceContext: () => context,
    program: () => ({ playhead: 0, duration: 10, in: null, out: null, frame: 1 / 24, sourceItem: item }),
    query, run,
  })
  const invoke = createInvoke({
    run, query,
    settleSource: () => playback.settleSource(),
    sourceMarkTime: playback.sourceMarkTime,
    focused: () => 'source',
    sourceContext: () => context,
    status: error => errors.push(error),
    tool: () => true,
    playback: (id, params) => playback.invoke(id, params, 'source'),
  })
  return { playback, invoke, seeks, errors, release,
    replace(sameId) { context = {}; if (!sameId) item += 1; position = 0 },
  }
}

for (const [command, delta] of [['playhead.stepForward', 1], ['playhead.stepBack', -1], ['playhead.stepForward5', 7], ['playhead.stepBack5', -7]]) {
  test(`Source ${command} steps from the latest queued scrub`, async () => {
    const f = setup()
    try {
      f.playback.moveSource(2.5 * T)
      f.playback.moveSource(7.5 * T)
      const pending = f.invoke(command)
      await new Promise(resolve => setImmediate(resolve))
      f.release()
      await pending
      await f.playback.readSource()
      assert.deepEqual(f.seeks, [{ item: 5, time: 2.5 * T }, { item: 5, time: 7.5 * T }, { item: 5, frame: 180 + delta }])
      assert.equal(f.playback.sourceTime(), (180 + delta) * T / 24)
      assert.deepEqual(f.errors, [])
    } finally { f.release(); f.playback.dispose() }
  })
}

test('rapid Source steps preserve every key after the latest scrub', async () => {
  const f = setup()
  try {
    f.playback.moveSource(2.5 * T)
    f.playback.moveSource(7.5 * T)
    const pending = Array.from({ length: 3 }, () => f.invoke('playhead.stepForward'))
    await new Promise(resolve => setImmediate(resolve))
    f.release()
    await Promise.all(pending)
    await f.playback.readSource()
    assert.deepEqual(f.seeks.filter(s => s.frame != null).map(s => s.frame), [181, 182, 183])
    assert.equal(f.playback.sourceTime(), 183 * T / 24)
  } finally { f.release(); f.playback.dispose() }
})

for (const sameId of [false, true]) {
  test(`Source steps waiting for a scrub cancel on ${sameId ? 'reused project ID' : 'source replacement'}`, async () => {
    const f = setup()
    try {
      f.playback.moveSource(2.5 * T)
      f.playback.moveSource(7.5 * T)
      const old = [f.invoke('playhead.stepForward'), f.invoke('playhead.stepForward5')]
      await new Promise(resolve => setImmediate(resolve))
      f.replace(sameId)
      await f.invoke('playhead.stepForward')
      await f.playback.readSource()
      assert.equal(f.playback.sourceTime(), T / 24, 'fresh keys progress with the old acknowledgement held')
      const before = [...f.seeks]
      f.release()
      await Promise.all(old)
      await f.playback.readSource()
      assert.deepEqual(f.seeks, before, 'old completion cannot submit queued scrubs or keys')
      assert.equal(f.playback.sourceTime(), T / 24)
      assert.deepEqual(f.errors, [])
    } finally { f.release(); f.playback.dispose() }
  })
}
