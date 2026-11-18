import { test, expect, clips, editState } from './fixtures.mjs'

test('F42 replacing a project with the same sequence and clip IDs cancels a held timeline drag', async ({ film, page }) => {
  await film.open()
  await film.command('file.openDemoProject')
  const before = await film.sequence()
  const clip = clips(before)[0]
  const element = film.kit.getByTestId(`film-clip-${clip.clip}`)
  await expect(element).toHaveAttribute('title', clip.name)
  // The replacement reuses clip IDs while the timeline fits its new duration. Hover waits
  // for the actual target's layout to settle before taking coordinates or pressing it.
  await element.hover()
  const box = await element.boundingBox()
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 75, box.y + box.height / 2, { steps: 6 })
  await expect.poll(async () => (await film.kit.getByTestId(`film-clip-${clip.clip}`).boundingBox()).x).toBeGreaterThan(box.x + 30)
  expect(clips(await film.sequence())[0].start).toBe(clip.start)
  // The real replacement is one engine command and intentionally reuses the demo's IDs.
  await film.command('file.openDemoProject')
  const replaced = await film.sequence()
  expect(replaced.id).toBe(before.id)
  expect(clips(replaced)[0].clip).toBe(clip.clip)
  const history = await film.history()
  await page.mouse.up()
  await film.command('playhead.set', { frame: 0 })
  expect(editState(await film.sequence())).toEqual(editState(replaced))
  expect(await film.history()).toEqual(history)
  // The replacement remains editable with a newly started gesture.
  await element.hover()
  const fresh = await element.boundingBox()
  await page.mouse.down()
  await page.mouse.move(fresh.x + fresh.width / 2 + 75, fresh.y + fresh.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => clips(await film.sequence()).find(item => item.clip === clip.clip)?.start).not.toBe(clip.start)
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(replaced))
})
