import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayback } from './playback.ts'

const T = 254_016_000_000
function setup() {
  let context = {}
  let item = 5
  let position = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const seeks = []
  const streams = []
  const playback = createPlayback({
    now: () => 0,
    frame: () => () => undefined,
    sourceContext: () => context,
    program: () => ({ playhead: 0, duration: 10, in: null, out: null, frame: 1 / 24, sourceItem: item }),
    query: async id => id === 'source.inspect'
      ? { item, playhead: position, start: 0, end: 10 * T, fps: 24, markIn: T, markOut: 9 * T }
      : 0.25,
    run: async (id, params) => {
      assert.equal(id, 'source.setPlayhead')
      seeks.push({ item, time: params.time })
      position = params.time
      if (seeks.length === 1) await gate
      return { time: params.time }
    },
    audio: () => ({ resume() {}, stop() {}, elapsed: () => null, start: (feed, from) => streams.push({ feed, from }) }),
  })
  return { playback, seeks, streams, release, replace() { context = {}; item += 1; position = 0 } }
}

for (const [command, from] of [['source.playback.play', 7.5], ['playback.toOut', 7.5], ['playback.inToOut', 1], ['playback.inToOutPreroll', 0.75]]) {
  test(`Source ${command} starts after the latest queued scrub has landed`, async () => {
    const f = setup()
    try {
      f.playback.moveSource(2.5 * T)
      f.playback.moveSource(7.5 * T)
      const pending = f.playback.invoke(command, {}, 'source')
      // Drain the read/roll/start microtasks while the actual first seek stays pending.
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      const beforeRelease = [...f.streams]
      f.release()
      await pending
      f.playback.stopSource()
      await f.playback.readSource()
      assert.deepEqual(beforeRelease, [], 'audio must not start from an unsettled position')
      assert.deepEqual(f.seeks.map(x => x.time), [2.5 * T, 7.5 * T, from * T])
      assert.equal(f.streams.at(-1).from, from)
      assert.equal(f.playback.sourceTime(), from * T)
    } finally { f.release(); f.playback.dispose() }
  })
}

test('Stop cancels a play waiting for its latest scrub without losing that scrub', async () => {
  const f = setup()
  try {
    f.playback.moveSource(2.5 * T)
    f.playback.moveSource(7.5 * T)
    const pending = f.playback.invoke('source.playback.play', {}, 'source')
    f.playback.stopSource()
    f.release()
    await pending
    await f.playback.readSource()
    assert.deepEqual(f.seeks.map(x => x.time), [2.5 * T, 7.5 * T])
    assert.deepEqual(f.streams, [])
    assert.equal(f.playback.sourceTime(), 7.5 * T)
  } finally { f.release(); f.playback.dispose() }
})

for (const action of ['scrub', 'play']) {
  test(`a replacement Source can ${action} before the old seek acknowledgement arrives`, async () => {
    const f = setup()
    try {
      f.playback.moveSource(2.5 * T)
      f.playback.moveSource(7.5 * T)
      f.replace()
      let pending
      if (action === 'scrub') f.playback.moveSource(T)
      else pending = f.playback.invoke('source.playback.play', {}, 'source')
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      const sentBeforeRelease = [...f.seeks]
      f.release()
      await pending
      f.playback.stopSource()
      await f.playback.readSource()
      assert.deepEqual(sentBeforeRelease, [{ item: 5, time: 2.5 * T }, { item: 6, time: action === 'scrub' ? T : 0 }])
      assert.deepEqual(f.seeks, sentBeforeRelease, 'old completion cannot submit an obsolete position')
    } finally { f.release(); f.playback.dispose() }
  })
}
