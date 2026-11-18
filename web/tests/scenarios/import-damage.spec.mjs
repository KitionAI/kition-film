import { test, expect, lendMedia } from './fixtures.mjs'

test('F29 truncated media import reports its error, preserves the project, and allows a valid import', async ({ film, page }) => {
  await film.open()
  await film.command('file.newProject', { name: 'Damaged media' })
  await film.command('file.newSequence', { name: 'Recover', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
  const before = await film.details()
  const history = await film.history()
  await page.evaluate(() => {
    const files = window.devHost.files
    window.reviewGoodMedia = files.get('clips/bars.mp4')
    files.delete('clips/bars.mp4')
    // Truncate the project's own original sample; no external asset or reference data.
    files.set('clips/broken.mp4', { bytes: window.reviewGoodMedia.bytes.slice(0, 12), version: 1 })
  })
  const damaged = await page.evaluate(() => Array.from(new Uint8Array(window.reviewGoodMedia.bytes.slice(0, 12))))
  const reads = await lendMedia(film, 'clips/broken.mp4', damaged)
  await film.menu('file.import')
  await expect(film.kit.getByTestId('film-message')).toContainText('broken.mp4')
  expect(reads.some(read => read.method === 'GET' && read.range != null)).toBe(true)
  expect(await film.details()).toEqual(before)
  expect(await film.history()).toEqual(history)
  await page.evaluate(() => {
    window.devHost.files.delete('clips/broken.mp4')
    window.devHost.files.set('clips/bars.mp4', window.reviewGoodMedia)
    delete window.reviewGoodMedia
  })
  await film.menu('file.import')
  await expect.poll(async () => JSON.stringify((await film.details()).project.root).includes('bars.mp4')).toBe(true)
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
  await film.undo()
  await expect.poll(async () => (await film.details()).project.root).toEqual(before.project.root)
  await film.redo()
  await expect.poll(async () => JSON.stringify((await film.details()).project.root).includes('bars.mp4')).toBe(true)
  await film.saveReopen()
  expect(JSON.stringify((await film.details()).project.root)).toContain('bars.mp4')
})
