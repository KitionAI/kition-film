import { test, expect, holdWorkerCall, tinyMovie } from './fixtures.mjs'

test('F27 a host storage failure reports the error, preserves the document, and allows a fresh export', async ({ film, page }) => {
  await film.open()
  await tinyMovie(film)
  const before = await film.details()
  const history = await film.history()
  await page.evaluate(() => {
    const files = window.devHost.files
    const set = files.set
    files.set = function(path, value) {
      if (path.endsWith('.mp4') && path.startsWith('films/')) {
        files.set = set
        throw new Error('Review simulated storage full')
      }
      return set.call(this, path, value)
    }
  })
  await film.kit.getByTestId('film-export').click()
  await expect(film.kit.getByTestId('film-message')).toContainText('Review simulated storage full')
  await expect(film.kit.getByTestId('film-exporting')).toHaveCount(0)
  expect(await page.evaluate(() => window.devHost.files.has('films/Sample.mp4'))).toBe(false)
  expect(await film.details()).toEqual(before)
  expect(await film.history()).toEqual(history)
  await film.kit.getByTestId('film-export').click()
  await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample.mp4')), { timeout: 30_000 }).toBe(true)
  await expect(film.kit.getByTestId('film-exporting')).toHaveCount(0)
})

test('F28 permission revoke/restore during export byte transfer cancels the old export intent', async ({ film, page }) => {
  await film.open()
  await tinyMovie(film)
  const gate = await holdWorkerCall(film, 'takeFile')
  await film.kit.getByTestId('film-export').click()
  await gate.wait()
  await film.configure({ disable: ['command:file.exportMedia'] })
  await film.configure({ disable: [] })
  await gate.release()
  await expect(film.kit.getByTestId('film-exporting')).toHaveCount(0)
  expect(await page.evaluate(() => window.devHost.files.has('films/Sample.mp4'))).toBe(false)
  await film.kit.getByTestId('film-export').click()
  await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample.mp4')), { timeout: 30_000 }).toBe(true)
})
