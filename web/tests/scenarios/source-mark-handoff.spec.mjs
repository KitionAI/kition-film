import { test, expect, editState, TICKS, holdWorkerCommandReply } from './fixtures.mjs'

async function setup(film) {
  await film.open()
  await film.command('file.newProject', { name: 'Source marks during queued seeks' })
  await film.command('sequence.new', { width: 64, height: 36, fps: 24 })
  const item = (await film.command('item.newBarsAndTone', { seconds: 10 })).item
  await film.command('source.open', { item })
  const bar = film.kit.getByTestId('film-source-scrub')
  await expect(bar).toBeVisible()
  return { item, bar, area: await bar.boundingBox(), history: await film.history(), sequence: editState(await film.sequence()) }
}

for (const [key, side] of [['i', 'markIn'], ['o', 'markOut']]) {
  for (const button of [false, true]) {
    test(`F96 Source ${key} ${button ? 'button' : 'key'} records the latest queued scrub and survives undo/save`, async ({ film, page }) => {
      const { item, bar, area, history, sequence } = await setup(film)
      const gate = await holdWorkerCommandReply(film, 'source.setPlayhead')
      await bar.click({ position: { x: area.width * 0.25, y: 2 } })
      await gate.wait()
      const first = (await film.command('source.inspect')).playhead
      await bar.click({ position: { x: area.width * 0.75, y: 2 } })
      await film.focus()
      if (button) await film.kit.getByTestId(`film-source-transport-src.${side}`).click()
      else await page.keyboard.press(key)
      // The mark must complete even while the earlier seek acknowledgement stays held.
      await expect.poll(async () => (await film.command('source.inspect'))[side]).toBeGreaterThan(7 * TICKS)
      expect((await film.command('source.inspect')).playhead).toBe(first)
      const marked = (await film.command('source.inspect'))[side]
      await gate.release()
      await expect.poll(async () => (await film.command('source.inspect')).playhead).toBe(marked)
      expect(editState(await film.sequence())).toEqual(sequence)
      await film.undo()
      await expect.poll(async () => (await film.command('source.inspect'))[side]).toBeNull()
      // Undo has one redo entry, so compare the depth rather than full history text.
      const undone = await film.history()
      expect(undone.undo).toEqual(history.undo)
      await film.redo()
      await expect.poll(async () => (await film.command('source.inspect'))[side]).toBe(marked)
      await film.saveReopen()
      await film.command('source.open', { item })
      expect((await film.command('source.inspect'))[side]).toBe(marked)
    })
  }
  test(`F96 Source ${key} marks the playing frame without waiting for a held seek`, async ({ film, page }) => {
    const { bar, area, sequence } = await setup(film)
    await bar.click({ position: { x: area.width * 0.25, y: 2 } })
    await expect.poll(async () => (await film.command('source.inspect')).playhead).toBeGreaterThan(2 * TICKS)
    await film.focus()
    const initial = (await film.command('source.inspect')).playhead
    await page.keyboard.press('Space')
    await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow'))).toBeGreaterThan(initial + TICKS / 4)
    const gate = await holdWorkerCommandReply(film, 'source.setPlayhead')
    await gate.wait()
    const first = (await film.command('source.inspect')).playhead
    await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow'))).toBeGreaterThan(first + TICKS / 2)
    const before = Number(await bar.getAttribute('aria-valuenow'))
    await page.keyboard.press(key)
    const after = Number(await bar.getAttribute('aria-valuenow'))
    await expect.poll(async () => (await film.command('source.inspect'))[side]).toBeGreaterThanOrEqual(before)
    const marked = (await film.command('source.inspect'))[side]
    expect(marked).toBeLessThanOrEqual(after)
    expect((await film.command('source.inspect')).playhead).toBe(first)
    await expect(film.kit.getByTestId('film-source-transport-source.playback.toggle')).toHaveAttribute('aria-pressed', 'true')
    await gate.release()
    await page.keyboard.press('k')
    await expect(film.kit.getByTestId('film-source-transport-source.playback.toggle')).toHaveAttribute('aria-pressed', 'false')
    expect((await film.command('source.inspect'))[side]).toBe(marked)
    expect(editState(await film.sequence())).toEqual(sequence)
  })
}
