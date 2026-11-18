import { test, expect, editState, TICKS, holdWorkerCommandReply } from './fixtures.mjs'

const modes = [
  { name: 'play', key: 'Space' },
  { name: 'inToOut', key: 'Alt+k' },
  { name: 'toOut', key: 'Control+Space' },
  { name: 'preroll', key: 'Shift+Space', pref: 'playback.prerollSeconds' },
]

async function project(film) {
  await film.command('file.newProject', { name: 'Pending Source playback' })
  await film.command('file.newSequence', { width: 64, height: 36, fps: 24 })
  return (await film.command('file.newBarsAndTone', { seconds: 2 })).item
}

for (const mode of modes) {
  for (const interruption of ['source', 'project', 'stop']) {
    test(`F91 pending Source ${mode.name} cannot play after ${interruption} interruption`, async ({ film, page }) => {
      await film.open()
      const first = await project(film)
      const second = (await film.command('file.newBarsAndTone', { seconds: 3 })).item
      await film.command('source.open', { item: first })
      await film.command('project.setMarks', { item: first, in: TICKS / 2, out: 3 * TICKS / 2 })
      await film.command('prefs.set', { key: 'playback.prerollSeconds', value: 0.25 })
      await film.command('prefs.set', { key: 'playback.postrollSeconds', value: 0.25 })
      await film.command('source.setPlayhead', { frame: 18 })
      await expect(film.kit.getByTestId('film-source-time')).toHaveText('00:00:00:18')
      await film.kit.getByTestId('film-source').click()
      await film.focus()
      await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const gate = await holdWorkerCommandReply(film, mode.pref ? 'prefs.get' : 'source.inspect', mode.pref ? { key: mode.pref } : {})
      await page.keyboard.press(mode.key)
      await gate.wait()
      let replacement = first
      if (interruption === 'stop') await page.keyboard.press('k')
      else {
        replacement = interruption === 'project' ? await project(film) : second
        if (interruption === 'project') expect(replacement).toBe(first)
        await film.command('source.open', { item: replacement })
        await expect(film.kit.getByTestId('film-source')).toBeVisible()
      }
      const expected = interruption === 'stop' ? 18 * TICKS / 24 : 0
      const sequence = editState(await film.sequence())
      const history = await film.history()
      await gate.release()
      const play = film.kit.getByTestId('film-source-transport-source.playback.toggle')
      await expect(play, 'interrupted playback must not start').toHaveAttribute('aria-pressed', 'false')
      const source = await film.command('source.inspect')
      expect(source.item).toBe(replacement)
      expect(source.playhead, 'old playback must not seek the current source').toBe(expected)
      // A fresh gesture still starts this source and can be stopped normally.
      await film.command('source.setPlayhead', { frame: 0 })
      await film.kit.getByTestId('film-source').click()
      await film.focus()
      await page.keyboard.press('Space')
      await expect(play, 'fresh playback exposes its active state independently of its icon').toHaveAttribute('aria-pressed', 'true')
      await expect.poll(async () => (await film.command('source.inspect')).playhead).toBeGreaterThan(0)
      await page.keyboard.press('k')
      await expect(play).toHaveAttribute('aria-pressed', 'false')
      expect(editState(await film.sequence())).toEqual(sequence)
      expect(await film.history()).toEqual(history)
    })
  }
}
