import { test, expect, clips, editState } from './fixtures.mjs'

test('F21 Make Offline preview is isolated; relinking restores media without changing clip ranges', async ({ film }) => {
  await film.open()
  const before = await film.sequence()
  const item = clips(before)[0].item
  await film.command('project.select', { items: [item] })
  const status = async () => (await film.command('media.status', { item }))[0]
  const online = await status()
  expect(online.status).toBe('online')
  const history = await film.history()
  await film.menu('media.makeOffline')
  await expect(film.kit.getByTestId('film-dialog-makeOffline')).toBeVisible()
  await expect.poll(() => film.frame().evaluate(async item => {
    const raw = await window.filmPreview.query('media.status', { item })
    return raw ? JSON.parse(raw)[0]?.status : null
  }, item)).toBe('offline')
  expect((await status()).status).toBe('online')
  expect(await film.history()).toEqual(history)
  await film.kit.getByTestId('film-dialog-cancel').click()
  await expect(film.kit.getByTestId('film-dialog-makeOffline')).toHaveCount(0)
  expect((await status()).status).toBe('online')
  await film.menu('media.makeOffline')
  await film.kit.getByTestId('film-dialog-ok').click()
  await expect.poll(async () => (await status()).status).toBe('offline')
  expect(editState(await film.sequence())).toEqual(editState(before))
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
  await film.command('media.relink', { item, path: online.path, force: true })
  await expect.poll(async () => (await status()).status).toBe('online')
  expect(editState(await film.sequence())).toEqual(editState(before))
  await film.undo()
  await expect.poll(async () => (await status()).status).toBe('offline')
  await film.redo()
  await expect.poll(async () => (await status()).status).toBe('online')
  await film.saveReopen()
  expect((await status()).status).toBe('online')
  expect(editState(await film.sequence())).toEqual(editState(before))
})
