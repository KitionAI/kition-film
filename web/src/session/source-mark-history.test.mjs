import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvoke } from './invoke.ts'

function setup() {
  let context = {}, focus = 'source', reads = 0, failed = false, value = 1
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = [], errors = [], undo = [0], redo = []
  const invoke = createInvoke({
    run: async (id, params, options) => {
      calls.push({ id, params, options })
      if (id === 'edit.undo' && undo.length) { redo.push(value); value = undo.pop() }
      else if (id === 'edit.redo' && redo.length) { undo.push(value); value = redo.pop() }
      else if (id.startsWith('marker.')) {
        if (failed) throw new Error('mark refused')
        undo.push(value); redo.length = 0; value = params.time ?? 0
      }
      return value
    },
    query: async () => { if (++reads === 1) await gate; return { item: 5, fps: 24, playhead: 3, start: 0, end: 100 } },
    focused: () => focus, sourceContext: () => context, sourceMarkTime: () => undefined,
    settleSource: async () => undefined, status: e => errors.push(e), tool: () => true,
  })
  return { invoke, calls, errors, release, undo, redo, value: () => value,
    replace() { context = {} }, focus(panel) { focus = panel }, fail() { failed = true },
  }
}

for (const id of ['marker.markIn', 'marker.markOut']) {
  test(`Undo waits for pending ${id} instead of undoing the preceding edit`, async () => {
    const f = setup()
    const mark = f.invoke(id), undo = f.invoke('edit.undo')
    f.release(); await Promise.all([mark, undo])
    assert.deepEqual(f.calls.map(c => c.id), [id, 'edit.undo'])
    assert.equal(f.value(), 1); assert.deepEqual(f.undo, [0]); assert.deepEqual(f.redo, [3])
  })
}

test('pending mark, Undo, Redo and later explicit mark preserve gesture order', async () => {
  const f = setup()
  const commands = [f.invoke('marker.markIn'), f.invoke('edit.undo'), f.invoke('edit.redo'), f.invoke('marker.markOut', { time: 7 })]
  f.release(); await Promise.all(commands)
  assert.deepEqual(f.calls.map(c => c.id), ['marker.markIn', 'edit.undo', 'edit.redo', 'marker.markOut'])
  assert.equal(f.value(), 7); assert.deepEqual(f.undo, [0, 1, 3]); assert.deepEqual(f.redo, [])
})

test('Redo behind a pending mark cannot revive discarded earlier redo history', async () => {
  const f = setup(); await f.invoke('edit.undo'); f.calls.length = 0
  const mark = f.invoke('marker.markIn'), redo = f.invoke('edit.redo')
  f.release(); await Promise.all([mark, redo])
  assert.deepEqual(f.calls.map(c => c.id), ['marker.markIn', 'edit.redo'])
  assert.deepEqual(f.undo, [0]); assert.deepEqual(f.redo, []); assert.equal(f.value(), 3)
})

test('multiple queued Undo steps each consume exactly one edit', async () => {
  const f = setup()
  const commands = [f.invoke('marker.markIn'), f.invoke('marker.markOut', { time: 7 }), f.invoke('edit.undo'), f.invoke('edit.undo')]
  f.release(); await Promise.all(commands)
  assert.deepEqual(f.calls.map(c => c.id), ['marker.markIn', 'marker.markOut', 'edit.undo', 'edit.undo'])
  assert.equal(f.value(), 1); assert.deepEqual(f.undo, [0]); assert.deepEqual(f.redo, [7, 3])
})

test('queued history retains parameters and refresh options after panel focus changes', async () => {
  const f = setup(), mark = f.invoke('marker.markIn')
  f.focus('program')
  const undo = f.invoke('edit.undo', { custom: true }, { refresh: 'none' })
  f.release(); await Promise.all([mark, undo])
  assert.deepEqual(f.calls.at(-1), { id: 'edit.undo', params: { custom: true }, options: { refresh: 'none' } })
  assert.equal(f.value(), 1)
})

for (const reason of ['Source switch', 'project replacement with reused IDs']) {
  test(`${reason} cancels pending mark/history intent without blocking new-context edits`, async () => {
    const f = setup(), mark = f.invoke('marker.markIn'), undo = f.invoke('edit.undo')
    // Allow the old mark to enter its held inspection before invalidating the token.
    await Promise.resolve(); await Promise.resolve()
    f.replace()
    await f.invoke('marker.markOut', { time: 7 })
    await f.invoke('edit.undo')
    assert.equal(f.value(), 1)
    f.release(); await Promise.all([mark, undo])
    assert.deepEqual(f.calls.map(c => c.id), ['marker.markOut', 'edit.undo'])
    assert.equal(f.value(), 1)
  })
}

test('history after a completed mark survives Source replacement and runs normally', async () => {
  const f = setup(); f.release(); await f.invoke('marker.markIn'); f.replace()
  await f.invoke('edit.undo')
  assert.equal(f.value(), 1); assert.deepEqual(f.redo, [3])
})

test('history in a new context does not wait for an obsolete Source inspection', async () => {
  const f = setup(), mark = f.invoke('marker.markIn')
  await Promise.resolve(); await Promise.resolve(); f.replace()
  await f.invoke('edit.undo')
  assert.equal(f.value(), 0)
  f.release(); await mark
  assert.deepEqual(f.calls.map(c => c.id), ['edit.undo'])
})

test('a failed mark reports once and does not strand following history', async () => {
  const f = setup(); f.fail()
  const mark = f.invoke('marker.markIn'), undo = f.invoke('edit.undo')
  f.release(); await Promise.all([mark, undo])
  assert.deepEqual(f.calls.map(c => c.id), ['marker.markIn', 'edit.undo'])
  assert.deepEqual(f.errors, ['mark refused']); assert.equal(f.value(), 0)
})

test('ordinary history without pending Source work executes immediately', async () => {
  const f = setup()
  const undo = f.invoke('edit.undo')
  assert.equal(f.value(), 0)
  await undo; await f.invoke('edit.redo')
  assert.equal(f.value(), 1)
})
