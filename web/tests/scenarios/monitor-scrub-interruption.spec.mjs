import { test, expect, clips, TICKS } from './fixtures.mjs'

for (const monitor of ['program', 'source']) {
  for (const interruption of ['permission', 'capture']) {
    test(`F86 ${monitor} scrub stops on ${interruption} interruption and a released pointer cannot seek`, async ({ film, page }) => {
      await film.open()
      await film.command('source.open', { item: clips(await film.sequence())[0].item })
      const readTime = async () => monitor === 'source'
        ? (await film.command('source.inspect')).playhead
        : (await film.details()).playhead
      const bar = film.kit.getByTestId(`film-${monitor}-scrub`)
      await bar.hover()
      const area = await bar.boundingBox()
      await bar.evaluate(element => element.addEventListener('gotpointercapture', event => {
        element.dataset.testPointer = String(event.pointerId)
      }))
      await page.mouse.move(area.x + area.width * 0.4, area.y + 2)
      await page.mouse.down()
      await page.mouse.move(area.x + area.width * 0.6, area.y + 2, { steps: 6 })
      await expect.poll(readTime).toBeGreaterThan(0)
      await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow')) - await readTime()).toBe(0)
      const stopped = await readTime()
      if (interruption === 'permission') {
        await film.configure({ disable: ['control:monitor.scrubBar'] })
        await film.configure({ disable: [] })
      } else {
        await bar.evaluate(element => {
          const pointer = Number(element.dataset.testPointer)
          if (!element.hasPointerCapture(pointer)) throw new Error('Expected a real captured scrub')
          element.releasePointerCapture(pointer)
        })
      }
      await page.mouse.move(area.x + area.width * 0.7, area.y - 30)
      await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await readTime(), 'the interrupted press cannot continue seeking while held').toBe(stopped)
      await page.mouse.up()
      // A new authoritative seek must replace the abandoned draft, and hovering without
      // any button held must not restart the old drag or overwrite that seek.
      await film.command(monitor === 'source' ? 'source.setPlayhead' : 'playhead.set', { time: TICKS / 4 })
      const parked = await readTime()
      await page.mouse.move(area.x + area.width * 0.8, area.y + 2, { steps: 6 })
      await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await readTime(), 'hovering after an interrupted scrub cannot seek').toBe(parked)
      await expect(bar).toHaveAttribute('aria-valuenow', String(parked))
      await page.mouse.click(area.x + area.width * 0.3, area.y + 2)
      await expect.poll(readTime).not.toBe(parked)
      await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow'))).toBe(await readTime())
    })
  }
}
