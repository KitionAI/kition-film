import { test, expect, clips, editState } from './fixtures.mjs'

async function heldSourceDrag(film, page) {
  const source = await film.kit.getByTestId('film-source-drag-both').boundingBox()
  const clip = clips(await film.sequence())[0]
  const target = await film.kit.getByTestId(`film-clip-${clip.clip}`).boundingBox()
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(source.x + source.width / 2 + 10, source.y + source.height / 2, { steps: 3 })
  const x = target.x + target.width * 0.6
  const y = target.y + 10
  await page.mouse.move(x, y, { steps: 8 })
  await page.mouse.move(x + 1, y)
  await expect(film.kit.getByTestId('film-timeline-drop')).toBeVisible()
  return { x, y }
}

test('F43 revoking and restoring timeline placement cancels a held native source drag', async ({ film, page }) => {
  await film.open()
  const item = clips(await film.sequence())[0].item
  await film.command('source.open', { item })
  const before = editState(await film.sequence())
  const history = await film.history()
  const at = await heldSourceDrag(film, page)
  await film.configure({ disable: ['command:timeline.place'] })
  await film.configure({ disable: [] })
  await page.mouse.move(at.x + 2, at.y)
  await page.mouse.up()
  await film.command('playhead.set', { frame: 0 })
  expect(editState(await film.sequence())).toEqual(before)
  expect(await film.history()).toEqual(history)
  await heldSourceDrag(film, page)
  await page.mouse.up()
  await expect.poll(async () => clips(await film.sequence()).length).toBe(2)
  expect(clips(await film.sequence(), 'audio')).toHaveLength(2)
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(before)
})
