import { test, expect, clips } from './fixtures.mjs'

for (const action of ['OK', 'Cancel', 'drag away']) {
  test(`F32 ${action} handles the speed field that still has focus without losing the click or submitting early`, async ({ film, page }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Speed commit' })
    await film.command('sequence.new', { name: 'Speed', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
    const { item } = await film.command('item.newBarsAndTone', { seconds: 0.5 })
    await film.command('timeline.place', { item, seconds: 0 })
    const history = await film.history()
    await film.menu('clip.speedDuration')
    const speed = film.kit.getByTestId('film-dialog-speedDuration-speed').locator('input')
    await speed.fill('200')
    await expect(speed).toBeFocused()
    if (action === 'drag away') {
      const box = await film.kit.getByTestId('film-dialog-ok').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width + 80, box.y + box.height + 80)
      await page.mouse.up()
      await expect(film.kit.getByTestId('film-dialog')).toBeVisible()
      expect(clips(await film.sequence())[0].speed).toBe(1)
      expect(await film.history()).toEqual(history)
      await film.kit.getByTestId('film-dialog-cancel').click()
    } else await film.kit.getByTestId(action === 'OK' ? 'film-dialog-ok' : 'film-dialog-cancel').click()
    await expect(film.kit.getByTestId('film-dialog')).toHaveCount(0)
    expect(clips(await film.sequence())[0].speed).toBe(action === 'OK' ? 2 : 1)
    if (action === 'OK') expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
    else expect(await film.history()).toEqual(history)
  })
}
