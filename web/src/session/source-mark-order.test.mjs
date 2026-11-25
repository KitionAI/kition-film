import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvoke } from './invoke.ts'

function setup() {
  let context = {}, focused = 'source', cursor = 3, item = 5, fail = false, reads = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = [], errors = []
  const invoke = createInvoke({
    run: async (id, params, options) => {
      calls.push({ id, params, item, options })
      if (fail && id === 'marker.markIn') throw new Error('mark refused')
      return id
    },
    query: async () => { const view = { item, playhead: cursor, fps: 24, start: 0, end: 100 }; if (++reads === 1) await gate; return view },
    focused: () => focused, sourceContext: () => context, sourceMarkTime: () => undefined,
    settleSource: async () => undefined, status: e => errors.push(e), tool: () => true,
  })
  return { invoke, calls, errors, release, reads: () => reads,
    focus(panel) { focused = panel }, seek(time) { cursor = time }, fail() { fail = true },
    replace(sameId) { context = {}; if (!sameId) item += 1; cursor = 0 },
  }
}

for (const clear of ['marker.clearIn', 'marker.clearOut', 'marker.clearInOut']) {
  test(`${clear} runs after earlier implicit Source marks and retains refresh options`, async () => {
    const f = setup()
    try {
      const first = f.invoke('marker.markIn')
      f.seek(8)
      const second = f.invoke('marker.markOut')
      const last = f.invoke(clear, {}, { refresh: 'none' })
      f.release(); await Promise.all([first, second, last])
      assert.deepEqual(f.calls.map(c => [c.id, c.params]), [
        ['marker.markIn', { target: 'source', time: 3 }], ['marker.markOut', { target: 'source', time: 8 }], [clear, { target: 'source' }],
      ])
      assert.deepEqual(f.calls.at(-1).options, { refresh: 'none' })
      assert.equal(f.reads(), 2)
    } finally { f.release() }
  })
}

for (const id of ['marker.markIn', 'marker.markOut']) {
  test(`explicit-time ${id} cannot be overwritten by an earlier pending implicit mark`, async () => {
    const f = setup()
    try {
      const first = f.invoke(id), explicit = f.invoke(id, { target: 'source', time: 27 })
      f.release(); await Promise.all([first, explicit])
      assert.deepEqual(f.calls.map(c => c.params.time), [3, 27])
      assert.equal(f.reads(), 1)
    } finally { f.release() }
  })
}

for (const sameId of [false, true]) {
  test(`queued clear cancels on ${sameId ? 'project ID reuse' : 'source replacement'} and fresh clear progresses`, async () => {
    const f = setup()
    try {
      const first = f.invoke('marker.markIn'), clear = f.invoke('marker.clearInOut')
      f.replace(sameId)
      await f.invoke('marker.clearOut')
      assert.deepEqual(f.calls.map(c => c.id), ['marker.clearOut'])
      f.release(); await Promise.all([first, clear])
      assert.deepEqual(f.calls.map(c => c.id), ['marker.clearOut'])
    } finally { f.release() }
  })
}

test('queued clear keeps its Source target if focus moves to Program', async () => {
  const f = setup()
  try {
    const first = f.invoke('marker.markIn'), clear = f.invoke('marker.clearIn')
    f.focus('program'); f.release(); await Promise.all([first, clear])
    assert.equal(f.calls.at(-1).id, 'marker.clearIn')
    assert.deepEqual(f.calls.at(-1).params, { target: 'source' })
  } finally { f.release() }
})

test('explicit Program and invalid targets bypass the Source edit queue unchanged', async () => {
  const f = setup()
  try {
    const first = f.invoke('marker.markIn')
    for (const params of [{ target: 'program' }, { target: 'invalid' }, { monitor: 'program' }]) {
      await f.invoke('marker.clearInOut', params)
      assert.deepEqual(f.calls.at(-1).params, params)
    }
    assert.equal(f.calls.length, 3)
    f.release(); await first
    assert.equal(f.calls.at(-1).id, 'marker.markIn')
  } finally { f.release() }
})

test('clear still runs after a refused mark, and current errors remain visible', async () => {
  const f = setup(); f.fail()
  try {
    const first = f.invoke('marker.markIn'), clear = f.invoke('marker.clearIn')
    f.release(); await Promise.all([first, clear])
    assert.deepEqual(f.calls.map(c => c.id), ['marker.markIn', 'marker.clearIn'])
    assert.deepEqual(f.errors, ['mark refused'])
  } finally { f.release() }
})
