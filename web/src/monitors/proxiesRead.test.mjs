import test from 'node:test'
import assert from 'node:assert/strict'
import { createProxiesRead } from './useMonitorReads.ts'

function harness() {
  const pending = []
  const store = createProxiesRead(() => (id, params) => {
    assert.equal(id, 'prefs.get')
    assert.deepEqual(params, { key: 'media' })
    return new Promise((resolve, reject) => pending.push({ resolve, reject }))
  })
  const values = []
  store.subscribe(() => values.push(store.get()))
  return { store, pending, values }
}

const delivered = () => new Promise(resolve => setImmediate(resolve))

for (const enabled of [false, true]) {
  test(`a delayed proxy reply cannot overwrite newer ${enabled} preferences`, async () => {
    const { store, pending, values } = harness()
    const old = store.use(10)
    const current = store.use(11)
    pending[1].resolve({ enableProxies: enabled })
    await delivered()
    assert.equal(store.get(), enabled)
    const notified = [...values]
    pending[0].resolve({ enableProxies: !enabled })
    await delivered()
    assert.equal(store.get(), enabled)
    assert.deepEqual(values, notified, 'stale results must not notify either monitor')
    old()
    current()
  })
}

test('an older proxy read failure cannot invalidate a newer successful revision', async () => {
  const { store, pending, values } = harness()
  const old = store.use(10)
  const current = store.use(11)
  pending[1].resolve({ enableProxies: true })
  await delivered()
  pending[0].reject(new Error('old request failed'))
  await delivered()
  const anotherMonitor = store.use(11)
  assert.equal(pending.length, 2, 'the other monitor shares the current successful read')
  assert.equal(store.get(), true)
  assert.deepEqual(values, [true])
  old()
  current()
  anotherMonitor()
})

test('the current failed proxy read can retry and both monitors share its result', async () => {
  const { store, pending, values } = harness()
  const first = store.use(10)
  pending[0].reject(new Error('current request failed'))
  await delivered()
  const second = store.use(10)
  assert.equal(pending.length, 2)
  pending[1].resolve({ enableProxies: true })
  await delivered()
  const third = store.use(10)
  assert.equal(pending.length, 2)
  assert.equal(store.get(), true)
  assert.deepEqual(values, [true])
  first()
  second()
  third()
})
