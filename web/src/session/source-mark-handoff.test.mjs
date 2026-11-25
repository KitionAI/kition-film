import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvoke } from './invoke.ts'
import { createPlayback } from './playback.ts'
import { rateOf, frameTicks, snapTicks } from '../monitors/model.ts'

const T = 254_016_000_000
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); promise.catch(() => undefined); return { promise, resolve, reject } }
function setup(fps = 24, start = 0, end = 10 * T) {
  let context = {}, item = 5, position = start, wall = 0, tick, focused = 'source'
  let seekGate, inspectGate, failSeek = false
  const marks = [], errors = [], reads = []
  const rate = rateOf(fps)
  const query = async () => {
    const view = { item, playhead: position, start, end, fps }
    reads.push(view)
    if (inspectGate) { const gate = inspectGate; inspectGate = null; await gate.promise }
    return view
  }
  const run = async (id, params, options) => {
    if (id === 'source.setPlayhead') {
      if (failSeek) throw new Error('seek failed')
      position = Math.max(start, snapTicks(rate, Math.min(Math.max(params.time, start), Math.max(start, end - frameTicks(rate)))))
      if (seekGate) { const gate = seekGate; seekGate = null; await gate.promise }
    } else marks.push({ id, params, time: params.time ?? position, item, options })
    return null
  }
  const playback = createPlayback({ now: () => wall, frame: cb => { tick = cb; return () => { tick = null } },
    program: () => ({ playhead: 0, duration: 10, in: null, out: null, frame: 1 / fps, sourceItem: item }),
    sourceContext: () => context, query, run, onError: e => errors.push(e),
  })
  const invoke = createInvoke({ run, query, sourceContext: () => context, focused: () => focused,
    sourceMarkTime: () => playback.sourceMarkTime?.(), settleSource: playback.settleSource,
    status: e => errors.push(e), tool: () => true, playback: (id, params) => playback.invoke(id, params, focused),
  })
  return { playback, invoke, marks, errors, reads,
    holdSeek() { return seekGate = deferred() }, holdInspect() { return inspectGate = deferred() },
    replace(sameId) { context = {}; if (!sameId) item += 1; position = start }, focus(panel) { focused = panel },
    advance(ms) { wall += ms; tick?.() }, externalSeek(time) { position = time }, failSeek() { failSeek = true },
  }
}

for (const id of ['marker.markIn', 'marker.markOut']) {
  test(`${id} captures the last queued scrub without waiting for its acknowledgement`, async () => {
    const f = setup(), gate = f.holdSeek()
    try {
      f.playback.moveSource(2.5 * T); f.playback.moveSource(7.5 * T)
      await f.invoke(id)
      assert.equal(f.marks.at(-1).time, 7.5 * T)
      assert.equal(f.marks.at(-1).params.target, 'source')
    } finally { gate.resolve(); await f.playback.settleSource(); f.playback.dispose() }
  })
  test(`${id} captures the clock frame while a seek is held and playback continues`, async () => {
    const f = setup(); let gate
    try {
      await f.invoke('source.playback.play'); await f.playback.settleSource()
      gate = f.holdSeek(); f.advance(250); f.advance(500)
      await f.invoke(id)
      assert.equal(f.marks.at(-1).time, 0.75 * T)
      assert.equal(f.playback.state().source.playing, true)
    } finally { gate?.resolve(); await f.playback.settleSource(); f.playback.dispose() }
  })
}

for (const [fps, start, end, wanted] of [[24, 0, 10 * T, 10 * T], [24, 3 * T, 6 * T, -T], [30000 / 1001, 0, 10 * T, 2.123 * T]]) {
  test(`pending mark follows native clamp/snap at ${fps} fps, requested ${wanted}`, async () => {
    const f = setup(fps, start, end), gate = f.holdSeek()
    try {
      f.playback.moveSource(start); f.playback.moveSource(wanted)
      await f.invoke('marker.markIn')
      gate.resolve(); await f.playback.readSource()
      assert.equal(f.marks.at(-1).time, f.playback.sourceTime())
    } finally { gate.resolve(); f.playback.dispose() }
  })
}

for (const sameId of [false, true]) {
  test(`pending mark cancels after ${sameId ? 'project replacement reusing IDs' : 'source replacement'}`, async () => {
    const f = setup(), gate = f.holdInspect()
    try {
      const old = f.invoke('marker.markIn'); f.replace(sameId)
      await f.invoke('marker.markOut')
      assert.equal(f.marks.length, 1)
      gate.resolve(); await old
      assert.equal(f.marks.length, 1)
      assert.equal(f.marks[0].id, 'marker.markOut')
      assert.deepEqual(f.errors, [])
    } finally { gate.resolve(); f.playback.dispose() }
  })
}

test('queued mark captures time and focus before a slow read, preserving key order', async () => {
  const f = setup(), seek = f.holdSeek()
  try {
    f.playback.moveSource(2 * T); f.playback.moveSource(3 * T)
    const read = f.holdInspect(), first = f.invoke('marker.markIn')
    f.playback.moveSource(4 * T)
    const second = f.invoke('marker.markIn')
    f.focus('program'); f.playback.moveSource(5 * T)
    await new Promise(resolve => setImmediate(resolve))
    read.resolve(); await Promise.all([first, second])
    assert.deepEqual(f.marks.map(m => [m.time, m.params.target]), [[3 * T, 'source'], [4 * T, 'source']])
  } finally { seek.resolve(); await f.playback.settleSource(); f.playback.dispose() }
})

test('explicit time and Program targeting retain parameters/options and avoid Source reads', async () => {
  const f = setup()
  try {
    const options = { refresh: 'none', throws: true }
    for (const params of [{ target: 'source', time: 123 }, { target: 'program' }, { target: 'invalid' }, { monitor: 'program' }]) {
      const reads = f.reads.length
      await f.invoke('marker.markIn', params, options)
      assert.deepEqual(f.marks.at(-1).params, params)
      assert.deepEqual(f.marks.at(-1).options, { refresh: 'none' })
      assert.equal(f.reads.length, reads)
    }
    f.focus('program'); await f.invoke('marker.markOut', { target: 'source' })
    assert.equal(f.marks.at(-1).params.target, 'source')
  } finally { f.playback.dispose() }
})

test('after seek settlement, external engine positioning is authoritative', async () => {
  const f = setup()
  try {
    f.playback.moveSource(2 * T); await f.playback.readSource()
    f.externalSeek(6 * T); await f.invoke('marker.markIn')
    assert.equal(f.marks.at(-1).time, 6 * T)
  } finally { f.playback.dispose() }
})

test('failed seek does not leave a stale marking position', async () => {
  const f = setup()
  try {
    f.failSeek(); f.playback.moveSource(8 * T); await f.playback.settleSource()
    f.externalSeek(T); await f.invoke('marker.markOut')
    assert.equal(f.marks.at(-1).time, T)
    assert.deepEqual(f.errors, ['seek failed'])
  } finally { f.playback.dispose() }
})

test('a failed mark read reports the error and does not block subsequent marks', async () => {
  const f = setup(), gate = f.holdInspect()
  try {
    const failed = f.invoke('marker.markIn')
    gate.reject(new Error('mark read failed')); await failed
    await f.invoke('marker.markOut')
    assert.deepEqual(f.errors, ['mark read failed'])
    assert.deepEqual(f.marks.map(m => m.id), ['marker.markOut'])
  } finally { gate.resolve(); f.playback.dispose() }
})
