import { test, expect, holdWorkerCall, clips } from './fixtures.mjs'

for (const destination of ['project', 'sequence']) {
test(`F14 an unfinished Pen path belongs to its original ${destination}`, async ({ film, page }) => {
  await film.open()
  await film.kit.getByTestId('film-tools').locator('.kui-tool-slot > button[data-kit-ui-id="tool:Pen"]').click()
  await expect(film.kit.getByTestId('film-tools')).toHaveAttribute('data-active', 'Pen')
  const box = await film.kit.locator('[data-testid="film-program"] canvas').first().boundingBox()
  for (const [x, y] of [[0.3, 0.3], [0.6, 0.3], [0.5, 0.6]]) {
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y)
  }
  await expect(film.kit.getByTestId('film-program-graphics')).toHaveAttribute('data-pen-points', '3')
  if (destination === 'project') await film.command('file.newProject', { name: 'Empty replacement' })
  await film.command('sequence.new', { name: 'Empty sequence', width: 64, height: 36, fps: 24 })
  const history = await film.history()
  const before = await film.details()
  await film.focus()
  await page.keyboard.press('Enter')
  await expect(film.kit.getByTestId('film-program-graphics')).toHaveAttribute('data-pen-points', '0')
  expect(await film.history()).toEqual(history)
  expect(await film.details()).toEqual(before)
})
}

test('F15 revoking Type permission while its layer read waits closes the pending field', async ({ film, page }) => {
  await film.open()
  await film.focus()
  await page.keyboard.press('t')
  await expect(film.kit.getByTestId('film-tools')).toHaveAttribute('data-active', 'Type')
  const history = await film.history()
  const before = await film.details()
  const gate = await holdWorkerCall(film, 'graphicLayers')
  const box = await film.kit.locator('[data-testid="film-program"] canvas').first().boundingBox()
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.35)
  await gate.wait()
  const field = film.kit.getByTestId('film-program-text-edit')
  await expect(field).toBeVisible()
  await field.fill('Cancelled title')
  await film.configure({ disable: ['command:graphics.newText'] })
  await film.configure({ disable: [] })
  await gate.release()
  await expect(field).toHaveCount(0)
  expect(await film.history()).toEqual(history)
  expect(await film.details()).toEqual(before)
})

test('F23 Type accepts Unicode and multiline text; Escape restores shortcuts and undo/redo/reopen preserve content', async ({ film, page }) => {
  await film.open()
  await film.command('file.newProject', { name: 'Unicode title' })
  await film.command('sequence.new', { name: 'Title', width: 640, height: 360, fps: 24, video: 1, audio: 0 })
  const previous = new Set(clips(await film.sequence()).map(clip => clip.clip))
  await film.focus()
  await page.keyboard.press('t')
  const box = await film.kit.locator('[data-testid="film-program"] canvas').first().boundingBox()
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3)
  const field = film.kit.getByTestId('film-program-text-edit')
  await expect(field).toBeFocused()
  const text = '你好 🌊\nFilm <&> "title"'
  await field.fill(text)
  await page.keyboard.press('Escape')
  await expect(field).toHaveCount(0)
  await page.keyboard.press('v')
  await expect(film.kit.getByTestId('film-tools')).toHaveAttribute('data-active', 'Selection')
  await expect.poll(async () => clips(await film.sequence()).filter(clip => !previous.has(clip.clip)).length).toBe(1)
  const clip = clips(await film.sequence()).find(clip => !previous.has(clip.clip)).clip
  const words = async () => (await film.command('graphics.list', { clip })).layers[0].text
  await expect.poll(words).toBe(text)
  await film.undo()
  await expect.poll(words).toBe('')
  await film.redo()
  await expect.poll(words).toBe(text)
  await film.saveReopen()
  expect(await words()).toBe(text)
})
