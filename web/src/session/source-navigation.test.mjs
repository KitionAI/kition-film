import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvoke, routeOf } from './invoke.ts'
import { createPlayback } from './playback.ts'

const T = 254_016_000_000
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function setup() {
  let context = {}, item = 5, position = 0, wall = 0, tick, focused = 'source'
  let seekGate, inspectGate, readError, marks = true
  const seeks = [], errors = [], audioStarts = [], session = []
  const view = () => ({ item, playhead: position, start: 0, end: 10 * T, fps: 24, markIn: marks ? T : null, markOut: marks ? 9 * T : null })
  const query = async () => {
    const answer = view()
    if (inspectGate) { const gate = inspectGate; inspectGate = null; await gate.promise }
    if (readError) throw new Error(readError)
    return answer
  }
  const run = async (id, params) => {
    if (id === 'source.setPlayhead') {
      position = params.time
      seeks.push({ item, time: position })
      if (seekGate) { const gate = seekGate; seekGate = null; await gate.promise }
    } else {
      session.push({ id, params })
      if (id === 'markers.goToIn') position = T
      if (id === 'markers.goToOut') position = 9 * T
    }
    return null
  }
  const playback = createPlayback({
    now: () => wall, frame: cb => { tick = cb; return () => { tick = null } },
    program: () => ({ playhead: 0, duration: 10, in: null, out: null, frame: 1 / 24, sourceItem: item }),
    sourceContext: () => context, query, run,
    audio: () => ({ resume() {}, start: (feed, from) => audioStarts.push({ feed, from }), elapsed: () => null, stop() {} }),
  })
  const invoke = createInvoke({ run, query, focused: () => focused, sourceContext: () => context,
    sourceMarkTime: playback.sourceMarkTime,
    settleSource: playback.settleSource, status: e => errors.push(e), tool: () => true,
    playback: (id, params) => playback.invoke(id, params, focused),
  })
  return { playback, invoke, seeks, errors, audioStarts, session,
    holdSeek() { return seekGate = deferred() }, holdInspect() { return inspectGate = deferred() },
    replace(sameId) { context = {}; if (!sameId) item += 1; position = 0 },
    unmark() { marks = false }, failRead() { readError = 'read failed' }, focus(panel) { focused = panel },
    async advance(ms) { wall += ms; tick?.(); await playback.settleSource() }, position: () => position,
  }
}

for (const [id, time] of [['markers.goToIn', T], ['markers.goToOut', 9 * T]]) {
  test(`${id} replaces queued scrubs with its absolute destination`, async () => {
    const f = setup(), gate = f.holdSeek()
    try {
      f.playback.moveSource(2.5 * T); f.playback.moveSource(7.5 * T)
      await f.invoke(id)
      gate.resolve(); await f.playback.readSource()
      assert.equal(f.position(), time)
      assert.equal(f.playback.sourceTime(), time)
      assert.deepEqual(f.errors, [])
    } finally { gate.resolve(); f.playback.dispose() }
  })
  test(`${id} reanchors the playing clock and audio`, async () => {
    const f = setup()
    try {
      f.playback.moveSource(5 * T); await f.playback.settleSource()
      await f.invoke('source.playback.play')
      await f.invoke(id)
      await f.advance(250)
      assert.equal(f.position(), time + T / 4)
      assert.equal(f.playback.state().source.playing, true)
      assert.deepEqual(f.audioStarts.at(-1), { feed: { kind: 'source', item: 5 }, from: time / T })
    } finally { f.playback.dispose() }
  })
  test(`${id} without marks uses the clip boundary`, async () => {
    const f = setup(); f.unmark()
    try {
      await f.invoke(id); await f.playback.readSource()
      assert.equal(f.position(), id.endsWith('In') ? 0 : 10 * T - T / 24)
    } finally { f.playback.dispose() }
  })
}

for (const sameId of [false, true]) {
  test(`navigation read cancels on ${sameId ? 'project replacement reusing IDs' : 'source replacement'}`, async () => {
    const f = setup(), gate = f.holdInspect()
    try {
      const old = f.invoke('markers.goToOut')
      f.replace(sameId)
      await f.invoke('markers.goToIn')
      await f.playback.settleSource()
      const before = [...f.seeks]
      gate.resolve(); await old; await f.playback.settleSource()
      assert.equal(f.position(), T)
      assert.deepEqual(f.seeks, before)
      assert.equal(f.seeks.length, 1)
    } finally { gate.resolve(); f.playback.dispose() }
  })
}

test('late navigation read cannot overwrite a newer navigation or scrub', async () => {
  for (const scrub of [false, true]) {
    const f = setup(), gate = f.holdInspect()
    try {
      const old = f.invoke('markers.goToOut')
      if (scrub) f.playback.moveSource(3 * T)
      else await f.invoke('markers.goToIn')
      gate.resolve(); await old; await f.playback.settleSource()
      assert.equal(f.position(), (scrub ? 3 : 1) * T)
    } finally { gate.resolve(); f.playback.dispose() }
  }
})

test('navigation keeps its Source target after focus changes during a read', async () => {
  const f = setup(), gate = f.holdInspect()
  try {
    const pending = f.invoke('markers.goToOut')
    f.focus('program'); gate.resolve(); await pending; await f.playback.settleSource()
    assert.equal(f.position(), 9 * T)
    assert.equal(f.session.length, 0)
  } finally { gate.resolve(); f.playback.dispose() }
})

test('explicit target wins over monitor and focus; invalid targets reach engine validation', () => {
  for (const id of ['markers.goToIn', 'markers.goToOut']) {
    for (const [params, focused, expected] of [
      [{}, 'source', 'playback'], [{}, 'program', 'session'],
      [{ monitor: 'source' }, 'program', 'playback'], [{ monitor: 'program' }, 'source', 'session'],
      [{ target: 'source', monitor: 'program' }, 'program', 'playback'],
      [{ target: 'program' }, 'source', 'session'], [{ target: 'invalid' }, 'source', 'session'],
    ]) assert.equal(routeOf(id, params, focused), expected)
  }
})

test('failed navigation read reports the error and sends no seek', async () => {
  const f = setup(); f.failRead()
  try {
    assert.equal(await f.invoke('markers.goToIn'), null)
    assert.deepEqual(f.errors, ['read failed'])
    assert.deepEqual(f.seeks, [])
  } finally { f.playback.dispose() }
})
