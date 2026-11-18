import { test, expect, editState, TICKS, holdWorkerCommandReply } from './fixtures.mjs'

async function project(film) {
  await film.command('file.newProject', { name: 'Queued Source seeks' })
  await film.command('file.newSequence', { width: 64, height: 36, fps: 24 })
  return (await film.command('file.newBarsAndTone', { seconds: 2 })).item
}

for (const interruption of ['source', 'project', 'stop']) {
  test(`F92 queued Source scrub respects ${interruption}`, async ({ film, page }) => {
    await film.open()
    const first = await project(film)
    const second = (await film.command('file.newBarsAndTone', { seconds: 3 })).item
    await film.command('source.open', { item: first })
    const bar = film.kit.getByTestId('film-source-scrub')
    await expect(bar).toBeVisible()
    const area = await bar.boundingBox()
    const gate = await holdWorkerCommandReply(film, 'source.setPlayhead')
    await bar.click({ position: { x: area.width * 0.25, y: 2 } })
    await gate.wait()
    const firstTime = (await film.command('source.inspect')).playhead
    expect(firstTime).toBeGreaterThan(0)
    await bar.click({ position: { x: area.width * 0.75, y: 2 } })
    // The second real gesture is queued behind the first actual Worker reply.
    expect((await film.command('source.inspect')).playhead).toBe(firstTime)
    let replacement = first
    if (interruption === 'stop') {
      await film.focus()
      await page.keyboard.press('k')
    }
    else {
      replacement = interruption === 'project' ? await project(film) : second
      if (interruption === 'project') expect(replacement).toBe(first)
      await film.command('source.open', { item: replacement })
    }
    const history = await film.history()
    const sequence = editState(await film.sequence())
    await gate.release()
    const read = () => film.command('source.inspect')
    if (interruption === 'stop') {
      await expect.poll(async () => Math.abs((await read()).playhead - 1.5 * TICKS)).toBeLessThanOrEqual(TICKS / 24)
    } else {
      expect((await read()).playhead, 'old queued scrub must not move the replacement source').toBe(0)
      await expect(bar).toHaveAttribute('aria-valuenow', '0')
    }
    expect((await read()).item).toBe(replacement)
    const current = await bar.boundingBox()
    const duration = (await read()).end
    await bar.click({ position: { x: current.width * 0.5, y: 2 } })
    await expect.poll(async () => Math.abs((await read()).playhead - duration / 2)).toBeLessThanOrEqual(TICKS / 24)
    expect(await film.history()).toEqual(history)
    expect(editState(await film.sequence())).toEqual(sequence)
  })
}
