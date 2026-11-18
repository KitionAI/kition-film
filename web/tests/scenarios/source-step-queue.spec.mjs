import { test, expect, editState, TICKS, holdWorkerCommandReply } from './fixtures.mjs'

async function project(film) {
  await film.command('file.newProject', { name: 'Pending Source steps' })
  await film.command('file.newSequence', { width: 64, height: 36, fps: 24 })
  return (await film.command('file.newBarsAndTone', { seconds: 2 })).item
}

for (const read of ['inspect', 'preferences']) {
  for (const interruption of ['source', 'project', 'return']) {
    test(`F90 fresh Source keys respond before old ${read} returns after ${interruption} replacement`, async ({ film, page }) => {
      await film.open()
      const first = await project(film)
      const second = (await film.command('file.newBarsAndTone', { seconds: 3 })).item
      await film.command('source.open', { item: first })
      await film.command('prefs.set', { key: 'playback.stepManyFrames', value: 5 })
      await film.command('source.setPlayhead', { frame: 12 })
      await expect(film.kit.getByTestId('film-source-time')).toHaveText('00:00:00:12')
      await film.kit.getByTestId('film-source').click()
      await film.focus()
      await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const gate = await holdWorkerCommandReply(film, read === 'inspect' ? 'source.inspect' : 'prefs.get', read === 'inspect' ? {} : { key: 'playback' })
      const key = read === 'inspect' ? 'ArrowRight' : 'Shift+ArrowRight'
      await page.keyboard.press(key)
      await gate.wait()
      // These are queued behind the held read and still belong to the original context.
      await page.keyboard.press(key)
      await page.keyboard.press(key)
      let replacement = second
      if (interruption === 'project') {
        replacement = await project(film)
        expect(replacement, 'new project reuses the original source ID').toBe(first)
      }
      await film.command('source.open', { item: replacement })
      await expect(film.kit.getByTestId('film-source-time')).toHaveText('00:00:00:00')
      if (interruption === 'return') {
        await film.command('source.open', { item: first })
        await film.command('source.setPlayhead', { frame: 0 })
        await expect(film.kit.getByTestId('film-source-time')).toHaveText('00:00:00:00')
        replacement = first
      }
      const sequence = editState(await film.sequence())
      const history = await film.history()
      await film.kit.getByTestId('film-source').click()
      await film.focus()
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight')
      try {
        await expect.poll(async () => (await film.command('source.inspect')).playhead, {
          message: 'fresh keys must run while the old Source read is still held', timeout: 5000,
        }).toBe(3 * TICKS / 24)
        await expect(film.kit.getByTestId('film-source-time')).toHaveText('00:00:00:03')
      } finally {
        await gate.release()
      }
      const source = await film.command('source.inspect')
      expect(source.item).toBe(replacement)
      expect(source.playhead, 'completion of the old queue must preserve the new playhead').toBe(3 * TICKS / 24)
      await page.keyboard.press('Shift+ArrowRight')
      await expect.poll(async () => (await film.command('source.inspect')).playhead).toBe(8 * TICKS / 24)
      await page.keyboard.press('Shift+ArrowLeft')
      await expect.poll(async () => (await film.command('source.inspect')).playhead).toBe(3 * TICKS / 24)
      await expect(film.kit.getByTestId('film-source-time')).toHaveText('00:00:00:03')
      expect(editState(await film.sequence())).toEqual(sequence)
      expect(await film.history()).toEqual(history)
    })
  }
}
