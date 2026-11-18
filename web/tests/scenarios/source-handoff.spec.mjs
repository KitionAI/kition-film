import { test, expect, editState, TICKS, holdWorkerCommandReply } from './fixtures.mjs'

async function project(film) {
  await film.command('file.newProject', { name: 'Source scrub to play' })
  await film.command('file.newSequence', { width: 64, height: 36, fps: 24 })
  return (await film.command('file.newBarsAndTone', { seconds: 10 })).item
}

async function queuedScrubs(film) {
  const bar = film.kit.getByTestId('film-source-scrub')
  await expect(bar).toBeVisible()
  const area = await bar.boundingBox()
  const gate = await holdWorkerCommandReply(film, 'source.setPlayhead')
  await bar.click({ position: { x: area.width * 0.25, y: 2 } })
  await gate.wait()
  const first = (await film.command('source.inspect')).playhead
  await bar.click({ position: { x: area.width * 0.75, y: 2 } })
  expect((await film.command('source.inspect')).playhead).toBe(first)
  return { bar, gate }
}

for (const [name, key, from] of [['play', 'Space', 7.5], ['toOut', 'Control+Space', 7.5], ['inToOut', 'Alt+k', 1], ['preroll', 'Shift+Space', 0.75]]) {
  test(`F93 Source ${name} honors the last scrub before starting`, async ({ film, page }) => {
    await film.open()
    const item = await project(film)
    await film.command('source.open', { item })
    await film.command('project.setMarks', { item, in: TICKS, out: 9 * TICKS })
    await film.command('prefs.set', { key: 'playback.prerollSeconds', value: 0.25 })
    await film.command('prefs.set', { key: 'playback.postrollSeconds', value: 0.25 })
    const { gate } = await queuedScrubs(film)
    const history = await film.history()
    const sequence = editState(await film.sequence())
    // Observe actual requests to the real Worker; never replace their results.
    await film.frame().evaluate(() => {
      const post = Worker.prototype.postMessage
      window.handoffSeeks = []
      Worker.prototype.postMessage = function(message, ...rest) {
        if (message?.request?.method === 'execute' && message.request.command === 'source.setPlayhead') {
          window.handoffSeeks.push(message.request.params.time)
        }
        return post.call(this, message, ...rest)
      }
    })
    await film.focus()
    await page.keyboard.press(key)
    await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await gate.release()
    await expect.poll(() => film.frame().evaluate(() => window.handoffSeeks.length)).toBeGreaterThanOrEqual(2)
    const sent = await film.frame().evaluate(() => window.handoffSeeks.slice(0, 2))
    await page.keyboard.press('k')
    expect(Math.abs(sent[0] - 7.5 * TICKS), 'latest queued scrub must settle before playback starts').toBeLessThanOrEqual(TICKS / 24)
    expect(Math.abs(sent[1] - from * TICKS), 'playback must start from the latest position or requested range').toBeLessThanOrEqual(TICKS / 24)
    expect(editState(await film.sequence())).toEqual(sequence)
    expect(await film.history()).toEqual(history)
  })
}

for (const interruption of ['source', 'project']) {
  test(`F93 fresh scrub progresses during an obsolete ${interruption} seek acknowledgement`, async ({ film }) => {
    await film.open()
    const first = await project(film)
    const second = (await film.command('file.newBarsAndTone', { seconds: 10 })).item
    await film.command('source.open', { item: first })
    const { bar, gate } = await queuedScrubs(film)
    let released = false
    try {
      const item = interruption === 'project' ? await project(film) : second
      if (interruption === 'project') expect(item).toBe(first)
      await film.command('source.open', { item })
      const history = await film.history()
      const sequence = editState(await film.sequence())
      await expect(bar, 'replacement Source must load while the old reply is still held').toBeVisible()
      const area = await bar.boundingBox()
      await bar.click({ position: { x: area.width * 0.5, y: 2 } })
      await expect.poll(async () => Math.abs((await film.command('source.inspect')).playhead - 5 * TICKS), 'new source must respond while the old reply is still held').toBeLessThanOrEqual(TICKS / 24)
      const position = (await film.command('source.inspect')).playhead
      await gate.release()
      released = true
      expect((await film.command('source.inspect')).playhead).toBe(position)
      await expect(bar).toHaveAttribute('aria-valuenow', String(position))
      expect(editState(await film.sequence())).toEqual(sequence)
      expect(await film.history()).toEqual(history)
    } finally {
      if (!released) await gate.release()
    }
  })
}
