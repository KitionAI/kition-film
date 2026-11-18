import { test, expect, clips, editState, TICKS } from './fixtures.mjs'

for (const monitor of ['program', 'source']) {
  for (const edge of ['in', 'out', 'move']) {
    for (const interruption of ['permission', 'capture']) {
      test(`F85 ${monitor} ${edge} range drag is cancelled on ${interruption} interruption and recovers through history/reopen`, async ({ film, page }) => {
        await film.open()
        const source = clips(await film.sequence())[0].item
        await film.command('source.open', { item: source })
        const item = monitor === 'source' ? source : (await film.sequence()).id
        const initial = { in: TICKS / 4, out: 30 * TICKS / 24 }
        await film.command('project.setMarks', { item, ...initial })
        const marks = async () => {
          if (monitor === 'source') {
            const view = await film.command('source.inspect')
            return { in: view.markIn, out: view.markOut }
          }
          const view = await film.sequence()
          return { in: view.in, out: view.out }
        }
        expect(await marks()).toEqual(initial)
        const bar = film.kit.getByTestId(`film-${monitor}-scrub`)
        const shape = () => bar.locator('.film-monitor-range').evaluate(element => ({
          x: Number(element.getAttribute('x')), width: Number(element.getAttribute('width')),
        }))
        const handle = bar.locator(`[data-edge="${edge}"]`)
        await handle.hover()
        const before = await shape()
        const content = editState(await film.sequence())
        const history = await film.history()
        const begin = async () => {
          await handle.hover()
          await page.mouse.down()
          const at = await handle.boundingBox()
          const area = await bar.boundingBox()
          // The preview replaces this handle's position; retain the original pointer coordinates.
          await page.mouse.move(at.x + at.width / 2 + 40, area.y + area.height / 2, { steps: 6 })
          await expect.poll(shape).not.toEqual(before)
        }
        // Observe the browser's actual pointer ID; releasing its real capture emits lostpointercapture.
        await bar.evaluate(element => element.addEventListener('gotpointercapture', event => {
          element.dataset.testPointer = String(event.pointerId)
        }))
        await begin()
        expect(await marks()).toEqual(initial)
        if (interruption === 'permission') {
          await film.configure({ disable: [`control:monitor.range.${edge === 'move' ? 'body' : edge}`] })
          await film.configure({ disable: [] })
        } else {
          await bar.evaluate(element => {
            const pointer = Number(element.dataset.testPointer)
            if (!element.hasPointerCapture(pointer)) throw new Error('Expected a real captured range drag')
            element.releasePointerCapture(pointer)
          })
          // A real next pointer event makes the browser process the pending capture release.
          const area = await bar.boundingBox()
          await page.mouse.move(area.x + area.width * 0.8, area.y + area.height / 2)
        }
        await page.mouse.up()
        await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        expect(await marks(), 'interrupted range must not commit marks').toEqual(initial)
        expect(await shape(), 'interrupted range must discard its draft').toEqual(before)
        expect(await film.history()).toEqual(history)
        await begin()
        await page.mouse.up()
        await expect.poll(marks).not.toEqual(initial)
        const changed = await marks()
        if (edge === 'in') expect(changed.out).toBe(initial.out)
        if (edge === 'out') expect(changed.in).toBe(initial.in)
        if (edge === 'move') expect(changed.out - changed.in).toBe(initial.out - initial.in)
        expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
        await film.undo()
        await expect.poll(marks).toEqual(initial)
        await film.redo()
        await expect.poll(marks).toEqual(changed)
        await film.saveReopen()
        if (monitor === 'source') await film.command('source.open', { item: source })
        expect(await marks()).toEqual(changed)
        expect(editState(await film.sequence())).toEqual(content)
      })
    }
  }
}
