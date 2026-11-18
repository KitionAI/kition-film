// Upstream's source targeting (`menus.rs` `targets_source` and the first lines of `invoke`): the
// commands the engine lists as source commands get `target: "source"` while the Source monitor has
// focus, or when their params name the Source monitor; everything else runs unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceCommandsOf, targetedRun, targetsSource } from './target.ts'

/** A fake engine: its `sourceCommands` extra, and every command the session runs. */
function fakeEngine(sources = ['markers.markIn', 'markers.markOut', 'markers.goToIn']) {
  const sent = []
  const doc = {
    async invoke(name) {
      if (name === 'sourceCommands') return JSON.stringify(sources)
      throw new Error(`no extra ${name}`)
    },
  }
  const run = async (command, params = {}) => {
    sent.push({ command, params })
    return null
  }
  return { doc, run, sent }
}

function session(focused) {
  const engine = fakeEngine()
  const panel = { focused }
  const run = targetedRun(engine.run, () => sourceCommandsOf(engine.doc), () => panel.focused)
  return { ...engine, run, panel }
}

test('Mark In with the Source monitor focused targets the source', async () => {
  const { run, sent } = session('source')
  await run('markers.markIn', {})
  assert.deepEqual(sent, [{ command: 'markers.markIn', params: { target: 'source' } }])
})

test('Mark In with the Program monitor focused targets nothing', async () => {
  const { run, sent } = session('program')
  await run('markers.markIn', {})
  assert.deepEqual(sent, [{ command: 'markers.markIn', params: {} }])
})

test('an explicit target is never changed', async () => {
  const { run, sent } = session('source')
  await run('markers.markIn', { target: 'program' })
  assert.deepEqual(sent, [{ command: 'markers.markIn', params: { target: 'program' } }])
})

test('a monitor named in the params overrides the focus, both ways, and is not sent', async () => {
  // `monitor` is the editor's hint; the engine takes `target`, and refuses a parameter its
  // command does not name (engine rule E7a).
  const fromTimeline = session('timeline')
  await fromTimeline.run('markers.markOut', { monitor: 'source' })
  assert.deepEqual(fromTimeline.sent[0].params, { target: 'source' })
  const fromSource = session('source')
  await fromSource.run('markers.markOut', { monitor: 'program' })
  assert.deepEqual(fromSource.sent[0].params, {})
})

test('commands the engine does not list as source commands are unchanged', async () => {
  const { run, sent } = session('source')
  await run('sequence.addEdit', { time: 5 })
  assert.deepEqual(sent, [{ command: 'sequence.addEdit', params: { time: 5 } }])
})

test('the focus is read at each run, so a focus change applies to the next command', async () => {
  const { run, sent, panel } = session('timeline')
  await run('markers.markIn', {})
  panel.focused = 'source'
  await run('markers.markIn', {})
  assert.deepEqual(sent.map((item) => item.params), [{}, { target: 'source' }])
})

test('targets_source: an explicit monitor wins over the focus', () => {
  assert.equal(targetsSource('source', {}), true)
  assert.equal(targetsSource('timeline', {}), false)
  assert.equal(targetsSource('timeline', { monitor: 'source' }), true)
  assert.equal(targetsSource('source', { monitor: 'program' }), false)
})

test('an engine without the sourceCommands extra targets nothing', async () => {
  const doc = { invoke: async () => { throw new Error('no extra') } }
  assert.deepEqual([...(await sourceCommandsOf(doc))], [])
})
