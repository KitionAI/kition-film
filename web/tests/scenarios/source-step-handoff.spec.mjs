import { test, expect, editState, TICKS, holdWorkerCommandReply } from './fixtures.mjs'

async function queuedScrubs(film) {
  await film.open()
  await film.command('file.newProject', { name: 'Scrub then Source step' })
  await film.command('file.newSequence', { width: 64, height: 36, fps: 24 })
  const item = (await film.command('file.newBarsAndTone', { seconds: 10 })).item
  await film.command('source.open', { item })
  await film.command('project.setMarks', { item, in: TICKS, out: 9 * TICKS })
  await film.command('prefs.set', { key: 'playback.stepManyFrames', value: 7 })
  const bar = film.kit.getByTestId('film-source-scrub')
  await expect(bar).toBeVisible()
  const area = await bar.boundingBox()
  const gate = await holdWorkerCommandReply(film, 'source.setPlayhead')
  await bar.click({ position: { x: area.width * 0.25, y: 2 } })
  await gate.wait()
  const first = (await film.command('source.inspect')).playhead
  await bar.click({ position: { x: area.width * 0.75, y: 2 } })
  expect((await film.command('source.inspect')).playhead).toBe(first)
  return { bar, gate, history: await film.history(), sequence: editState(await film.sequence()) }
}

for (const [key, delta] of [['ArrowRight', 1], ['ArrowLeft', -1], ['Shift+ArrowRight', 7], ['Shift+ArrowLeft', -7]]) {
  test(`F94 ${key} uses the latest Source scrub and preserves its frame offset`, async ({ film, page }) => {
    const { bar, gate, history, sequence } = await queuedScrubs(film)
    await film.frame().evaluate(() => {
      const post = Worker.prototype.postMessage
      window.sourceStepSeeks = []
      Worker.prototype.postMessage = function(message, ...rest) {
        if (message?.request?.method === 'execute' && message.request.command === 'source.setPlayhead') {
          window.sourceStepSeeks.push(message.request.params)
        }
        return post.call(this, message, ...rest)
      }
    })
    await film.focus()
    await page.keyboard.press(key)
    await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await gate.release()
    await expect.poll(() => film.frame().evaluate(() => window.sourceStepSeeks.length)).toBeGreaterThanOrEqual(2)
    const sent = await film.frame().evaluate(() => window.sourceStepSeeks.slice(0, 2))
    expect(sent[0], 'the queued scrub must land before the relative frame step').toHaveProperty('time')
    const expectedFrame = Math.round(sent[0].time / TICKS * 24) + delta
    expect(sent[1]).toEqual({ frame: expectedFrame })
    await expect.poll(async () => (await film.command('source.inspect')).playhead).toBe(expectedFrame * TICKS / 24)
    await expect(bar).toHaveAttribute('aria-valuenow', String(expectedFrame * TICKS / 24))
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await film.command('source.inspect')).playhead).toBe((expectedFrame + 1) * TICKS / 24)
    expect(await film.history()).toEqual(history)
    expect(editState(await film.sequence())).toEqual(sequence)
  })
}

for (const [button, seconds] of [['src.goIn', 1], ['src.goOut', 9]]) {
  test(`F94 Source ${button} transport keeps its absolute destination after queued scrubs`, async ({ film }) => {
    const { bar, gate, history, sequence } = await queuedScrubs(film)
    await film.kit.getByTestId(`film-source-transport-${button}`).click()
    await gate.release()
    await expect.poll(async () => (await film.command('source.inspect')).playhead).toBe(seconds * TICKS)
    await expect(bar).toHaveAttribute('aria-valuenow', String(seconds * TICKS))
    expect(await film.history()).toEqual(history)
    expect(editState(await film.sequence())).toEqual(sequence)
  })
}
