import { test, expect, editState, TICKS } from './fixtures.mjs'

for (const display of ['audioWaveform', 'videoAndWaveform']) {
  for (const interruption of ['source', 'permission']) {
    test(`F87 ${display} held waveform scrub cannot survive ${interruption} interruption`, async ({ film, page }) => {
      await film.open()
      await film.command('file.newProject', { name: 'Waveform interruption' })
      await film.command('sequence.new', { width: 64, height: 36, fps: 24 })
      const first = (await film.command('item.newBarsAndTone', { seconds: 2 })).item
      const second = (await film.command('item.newBarsAndTone', { seconds: 1 })).item
      await film.command('source.open', { item: first })
      await film.kit.getByTestId('film-source-settings').click()
      await film.kit.getByTestId(`film-source-settings-display-${display}`).click()
      const waveform = film.kit.getByTestId('film-source-waveform')
      await expect(waveform).toHaveAttribute('data-state', 'drawn')
      const read = () => film.command('source.inspect')
      const time = async () => (await read()).playhead
      const history = await film.history()
      const sequence = editState(await film.sequence())
      await waveform.hover({ position: { x: 30, y: 20 } })
      const area = await waveform.boundingBox()
      await page.mouse.down()
      await page.mouse.move(area.x + area.width * 0.5, area.y + 20, { steps: 8 })
      // Pointer coordinates are rounded and seeks snap to frames; allow one 24 fps frame.
      await expect.poll(async () => Math.abs(await time() - TICKS)).toBeLessThanOrEqual(TICKS / 24)
      const held = await time()
      if (interruption === 'source') {
        await film.command('source.open', { item: second })
        await expect.poll(async () => (await read()).item).toBe(second)
        await expect(waveform).toHaveAttribute('data-state', 'drawn')
        // Opening another source starts at its own beginning. Cleanup of the old waveform
        // must not flush the old one-second seek into this new, shorter clip.
        expect(await time(), 'old waveform cleanup must not seek the replacement source').toBe(0)
      } else {
        await film.configure({ disable: ['control:source.waveform'] })
        await film.configure({ disable: [] })
      }
      const expected = interruption === 'source' ? 0 : held
      const current = await waveform.boundingBox()
      await page.mouse.move(current.x + current.width * 0.8, current.y + 20, { steps: 6 })
      await page.mouse.up()
      await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await time(), 'the interrupted waveform press cannot continue or commit').toBe(expected)
      const duration = (await read()).end
      await waveform.click({ position: { x: current.width * 0.25, y: 20 } })
      await expect.poll(async () => Math.abs(await time() - duration / 4)).toBeLessThanOrEqual(TICKS / 24)
      expect(await film.history()).toEqual(history)
      expect(editState(await film.sequence())).toEqual(sequence)
    })
  }
}
