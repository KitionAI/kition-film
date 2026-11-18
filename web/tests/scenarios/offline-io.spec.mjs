import { test, expect, clips, editState } from './fixtures.mjs'

test('F35 a genuinely missing lent media file opens offline; restoring and relinking recovers without changing edits', async ({ film, page }) => {
  await film.open()
  const before = await film.sequence()
  const item = clips(before)[0].item
  const online = (await film.command('media.status', { item }))[0]
  expect(online.status).toBe('online')
  let missingReads = 0
  const missing = route => {
    missingReads += 1
    return route.fulfill({ status: 404, headers: { 'content-length': '0' }, body: '' })
  }
  const url = new URL('sample/clips/bars.mp4', page.url()).href
  await page.context().route(url, missing)
  await film.saveReopen()
  await expect.poll(async () => (await film.command('media.status', { item }))[0].status).toBe('missing')
  expect(missingReads).toBeGreaterThan(0)
  expect(editState(await film.sequence())).toEqual(editState(before))
  await page.context().unroute(url, missing)
  await film.command('media.relink', { item, path: online.path, force: true })
  await expect.poll(async () => (await film.command('media.status', { item }))[0].status).toBe('online')
  expect(editState(await film.sequence())).toEqual(editState(before))
  await film.saveReopen()
  expect((await film.command('media.status', { item }))[0].status).toBe('online')
  expect(editState(await film.sequence())).toEqual(editState(before))
})
