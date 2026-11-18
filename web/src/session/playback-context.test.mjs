import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayback } from './playback.ts'

const T = 254_016_000_000
const cases = [
  ['play inspect', 'source.playback.play', 'inspect'],
  ['range inspect', 'playback.inToOut', 'inspect'],
  ['to-Out inspect', 'playback.toOut', 'inspect'],
  ['preroll', 'playback.inToOutPreroll', 'playback.prerollSeconds'],
  ['postroll', 'playback.inToOutPreroll', 'playback.postrollSeconds'],
  ['initial seek acknowledgement', 'source.playback.play', 'seek'],
]

for (const [name, command, stage] of cases) {
  for (const interruption of ['context', 'stop', 'new play']) {
    test(`Source ${name} cannot resume after ${interruption}`, async () => {
      let context = {}
      const source = { item: 5, start: 0, end: 2 * T, fps: 24, playhead: 0.75 * T, markIn: 0.5 * T, markOut: 1.5 * T }
      let release
      let entered
      const gate = new Promise(resolve => { release = resolve })
      const waiting = new Promise(resolve => { entered = resolve })
      let paused = false
      const pause = async at => {
        if (paused || at !== stage) return
        paused = true
        entered()
        await gate
      }
      const seeks = []
      const streams = []
      const playback = createPlayback({
        now: () => 0,
        frame: () => () => undefined,
        sourceContext: () => context,
        program: () => ({ playhead: 0, duration: 3, in: null, out: null, frame: 1 / 24, sourceItem: source.item }),
        query: async (id, params) => {
          if (id === 'source.inspect') {
            const view = { ...source }
            await pause('inspect')
            return view
          }
          await pause(params.key)
          return 0.25
        },
        run: async (id, params) => {
          assert.equal(id, 'source.setPlayhead')
          seeks.push(params.time)
          source.playhead = params.time
          await pause('seek')
          return JSON.stringify({ time: params.time })
        },
        audio: () => ({ resume() {}, stop() {}, elapsed: () => null, start: (feed, from) => streams.push({ feed, from }) }),
      })
      const pending = playback.invoke(command, {}, 'source')
      await waiting
      if (interruption === 'stop') playback.stopSource()
      else {
        // A replacement project can reuse the same source item ID.
        context = {}
        source.playhead = 0
        if (interruption === 'new play') await playback.invoke('source.playback.play', {}, 'source')
      }
      const priorSeeks = [...seeks]
      const priorStreams = [...streams]
      try {
        release()
        await pending
        assert.deepEqual(seeks, priorSeeks, 'obsolete completion cannot seek the current source')
        assert.deepEqual(streams, priorStreams, 'obsolete completion cannot start audio')
        assert.equal(playback.state().source.playing, interruption === 'new play')
        playback.stopSource()
        source.playhead = 0
        await playback.invoke('source.playback.play', {}, 'source')
        assert.equal(playback.state().source.playing, true)
        assert.equal(seeks.at(-1), 0)
        assert.equal(streams.at(-1).from, 0)
      } finally {
        playback.dispose()
      }
    })
  }
}

test('a current range-start failure still reports the error and leaves playback stopped', async () => {
  let reads = 0
  const playback = createPlayback({
    now: () => 0, frame: () => () => undefined,
    program: () => ({ playhead: 0, duration: 3, in: null, out: null, frame: 1 / 24, sourceItem: 5 }),
    query: async () => {
      if (++reads === 1) return { item: 5, start: 0, end: 2 * T, fps: 24, playhead: 0, markIn: 0, markOut: T }
      throw new Error('source read failed')
    },
    run: async () => assert.fail('a failed start must not seek'),
  })
  try {
    await assert.rejects(playback.invoke('playback.inToOut', {}, 'source'), /source read failed/)
    assert.equal(playback.state().source.playing, false)
  } finally { playback.dispose() }
})

for (const [command, start, last] of [
  ['playback.inToOut', 0.5, 1.5],
  ['playback.toOut', 0.75, 1.5],
  ['playback.inToOutPreroll', 0.25, 1.75],
]) {
  test(`uninterrupted ${command} keeps its range, inclusive Out and roll settings`, async () => {
    let wall = 0
    let tick
    const source = { item: 5, start: 0, end: 3 * T, fps: 24, playhead: 0.75 * T, markIn: 0.5 * T, markOut: 1.5 * T }
    const playback = createPlayback({
      now: () => wall,
      frame: callback => { tick = callback; return () => { tick = null } },
      program: () => ({ playhead: 0, duration: 3, in: null, out: null, frame: 1 / 24, sourceItem: 5 }),
      query: async id => id === 'source.inspect' ? { ...source } : 0.25,
      run: async (id, params) => {
        assert.equal(id, 'source.setPlayhead')
        source.playhead = params.time
        return JSON.stringify({ time: params.time })
      },
    })
    try {
      await playback.invoke(command, {}, 'source')
      assert.equal(source.playhead, start * T)
      assert.equal(playback.state().source.playing, true)
      wall = 4000
      tick()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(playback.state().source.playing, false)
      assert.equal(source.playhead, last * T)
    } finally { playback.dispose() }
  })
}
