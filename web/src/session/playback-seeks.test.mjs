import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayback } from './playback.ts'

const T = 254_016_000_000

function setup(useContext = true, gateAt = 1) {
  let context = {}
  let item = 5
  let playhead = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const seeks = []
  const errors = []
  const playback = createPlayback({
    now: () => 0,
    frame: () => () => undefined,
    ...(useContext ? { sourceContext: () => context } : {}),
    program: () => ({ playhead: 0, duration: 3, in: null, out: null, frame: 1 / 24, sourceItem: item }),
    query: async () => ({ item, playhead, start: 0, end: 3 * T, fps: 24 }),
    run: async (id, params) => {
      assert.equal(id, 'source.setPlayhead')
      seeks.push({ item, time: params.time })
      playhead = params.time
      if (seeks.length === gateAt) await gate
      return { time: params.time }
    },
    onError: error => errors.push(error),
  })
  return {
    playback, seeks, errors, release,
    replace(sameId) { context = {}; if (!sameId) item += 1; playhead = 0 },
  }
}

for (const [name, useContext, sameId] of [['source', true, false], ['reused project item ID', true, true], ['item fallback', false, false]]) {
  test(`queued Source seeks cannot move a replacement ${name}`, async () => {
    const f = setup(useContext)
    try {
      f.playback.moveSource(T / 4)
      f.playback.moveSource(T)
      f.playback.moveSource(2 * T)
      assert.equal(f.seeks.length, 1, 'later seeks are genuinely queued')
      f.replace(sameId)
      f.release()
      await f.playback.readSource()
      assert.equal(f.seeks.length, 1, 'obsolete queued seek must never be sent')
      assert.equal(f.playback.sourceTime(), 0)
      f.playback.moveSource(T / 2)
      await f.playback.readSource()
      assert.equal(f.seeks.at(-1).time, T / 2)
      assert.equal(f.playback.sourceTime(), T / 2)
      assert.deepEqual(f.errors, [])
    } finally { f.release(); f.playback.dispose() }
  })
}

for (const stop of [false, true]) {
  test(`current Source queue keeps only the latest seek${stop ? ' after Stop' : ''}`, async () => {
    const f = setup()
    try {
      f.playback.moveSource(T / 4)
      f.playback.moveSource(T)
      f.playback.moveSource(2 * T)
      if (stop) f.playback.stopSource()
      f.release()
      await f.playback.readSource()
      assert.deepEqual(f.seeks.map(seek => seek.time), [T / 4, 2 * T])
      assert.equal(f.playback.sourceTime(), 2 * T)
    } finally { f.release(); f.playback.dispose() }
  })
}

test('a fresh Source seek replaces an obsolete waiting seek', async () => {
  const f = setup()
  try {
    f.playback.moveSource(T / 4)
    f.playback.moveSource(2 * T)
    f.replace(true)
    f.playback.moveSource(T / 2)
    f.release()
    await f.playback.readSource()
    assert.deepEqual(f.seeks.map(seek => seek.time), [T / 4, T / 2])
    assert.equal(f.playback.sourceTime(), T / 2)
  } finally { f.release(); f.playback.dispose() }
})

test('Stop during active Source playback settles its latest queued position', async () => {
  const f = setup(true, 2)
  try {
    await f.playback.invoke('source.playback.play', {}, 'source')
    f.playback.moveSource(T / 4)
    f.playback.moveSource(T)
    f.playback.moveSource(2 * T)
    f.playback.stopSource()
    f.release()
    await f.playback.readSource()
    assert.deepEqual(f.seeks.map(seek => seek.time), [0, T / 4, 2 * T])
    assert.equal(f.playback.sourceTime(), 2 * T)
    assert.equal(f.playback.state().source.playing, false)
  } finally { f.release(); f.playback.dispose() }
})
