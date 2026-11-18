import { test, expect, editState, TICKS, holdWorkerCommandReply } from './fixtures.mjs'

async function queuedScrubs(film) {
  await film.open()
  await film.command('file.newProject', { name: 'Source mark navigation' })
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

for (const [key, seconds] of [['Shift+i', 1], ['Shift+o', 9]]) {
  test(`F95 ${key} keeps its destination after queued Source scrubs`, async ({ film, page }) => {
    const { bar, gate, history, sequence } = await queuedScrubs(film)
    await film.focus()
    await page.keyboard.press(key)
    // Let the keyboard's asynchronous read finish while the earlier seek reply is held.
    await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await gate.release()
    await expect.poll(async () => (await film.command('source.inspect')).playhead).toBe(seconds * TICKS)
    await expect(bar).toHaveAttribute('aria-valuenow', String(seconds * TICKS))
    expect(await film.history()).toEqual(history)
    expect(editState(await film.sequence())).toEqual(sequence)
  })
}

for (const [key, seconds] of [['Shift+i', 1], ['Shift+o', 3]]) {
  test(`F95 ${key} reanchors running Source playback`, async ({ film, page }) => {
    const { gate, sequence } = await queuedScrubs(film)
    await gate.release()
    await film.command('project.setMarks', { item: (await film.command('source.inspect')).item, out: 3 * TICKS })
    const history = await film.history()
    await film.focus()
    await page.keyboard.press('Space')
    const play = film.kit.getByTestId('film-source-transport-source.playback.toggle')
    await expect(play).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await film.command('source.inspect')).playhead).toBeGreaterThan(7 * TICKS)
    await page.keyboard.press(key)
    // Demand sustained motion from the new origin, rather than accepting one native seek
    // which the next clock frame can overwrite.
    for (let n = 0; n < 3; n += 1) {
      await expect.poll(async () => (await film.command('source.inspect')).playhead).toBeGreaterThan((seconds + 0.1) * TICKS)
      const position = (await film.command('source.inspect')).playhead
      expect(position).toBeLessThan((seconds + 0.9) * TICKS)
    }
    await expect(play).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('k')
    await expect(play).toHaveAttribute('aria-pressed', 'false')
    expect(await film.history()).toEqual(history)
    expect(editState(await film.sequence())).toEqual(sequence)
  })
}
