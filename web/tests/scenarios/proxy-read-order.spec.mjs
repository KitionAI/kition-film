import { test, expect, editState } from './fixtures.mjs'

/** Delay one actual media-preferences reply; later reads still reach the real engine.
 * Keep observing until a newer reply is delivered so unchanged button state cannot
 * accidentally satisfy the setup before the second read has completed. */
async function holdMediaPreferences(film) {
  await film.frame().evaluate(() => {
    const post = Worker.prototype.postMessage
    let held = null
    let newer = 0
    let worker = null
    let receive = null
    let first = null
    const reads = new Set()
    Worker.prototype.postMessage = function(message, ...rest) {
      const request = message?.request
      if (request?.method === 'execute' && request.command === 'prefs.get' && request.params?.key === 'media') {
        reads.add(message.id)
        if (!worker) {
          worker = this
          first = message.id
          receive = worker.onmessage
          worker.onmessage = function(event) {
            if (event.data?.id === first) { held = event; return }
            receive.call(this, event)
            if (reads.has(event.data?.id)) newer += 1
          }
        }
      }
      return post.call(this, message, ...rest)
    }
    window.reviewMediaPreferences = {
      pending: () => held != null,
      newer: () => newer,
      release: () => new Promise(resolve => {
        Worker.prototype.postMessage = post
        worker.onmessage = receive
        receive.call(worker, held)
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      }),
    }
  })
  return {
    wait: () => expect.poll(() => film.frame().evaluate(() => window.reviewMediaPreferences.pending())).toBe(true),
    newer: () => expect.poll(() => film.frame().evaluate(() => window.reviewMediaPreferences.newer())).toBeGreaterThan(0),
    release: () => film.frame().evaluate(() => window.reviewMediaPreferences.release()),
  }
}

for (const enabled of [false, true]) {
  test(`F88 late proxy preference read cannot overwrite the latest ${enabled ? 'enabled' : 'disabled'} state in either monitor`, async ({ film }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Proxy read ordering' })
    await film.command('sequence.new', { width: 64, height: 36, fps: 24 })
    const { item } = await film.command('item.newBarsAndTone', { seconds: 1 })
    await film.command('source.open', { item })
    const button = which => film.kit.getByTestId(`film-monitor-${which}`).locator('[data-kit-ui-id="control:transport.toggleProxies"]')
    const shown = async value => {
      for (const which of ['program', 'source']) await expect(button(which)).toHaveAttribute('aria-pressed', String(value))
    }
    await film.command('media.toggleProxies', { enabled })
    await shown(enabled)
    const sequence = editState(await film.sequence())
    const history = await film.history()
    const gate = await holdMediaPreferences(film)
    await film.command('media.toggleProxies', { enabled: !enabled })
    await gate.wait()
    await film.command('media.toggleProxies', { enabled })
    await gate.newer()
    await shown(enabled)
    await gate.release()
    await shown(enabled)
    expect((await film.command('prefs.get', { key: 'media' })).enableProxies).toBe(enabled)
    // Both transport buttons must remain functional after discarding the stale reply.
    await button('source').click()
    await shown(!enabled)
    expect((await film.command('prefs.get', { key: 'media' })).enableProxies).toBe(!enabled)
    await button('program').click()
    await shown(enabled)
    expect((await film.command('prefs.get', { key: 'media' })).enableProxies).toBe(enabled)
    expect(editState(await film.sequence())).toEqual(sequence)
    expect(await film.history()).toEqual(history)
  })
}
