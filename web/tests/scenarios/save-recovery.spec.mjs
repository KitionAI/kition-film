import { test, expect, editState, holdHostRequest, TICKS } from './fixtures.mjs'

const projectFile = 'films/Sample.kfilm'
const stored = page => page.evaluate(path => {
  const file = window.devHost.files.get(path)
  return { version: file.version, bytes: Array.from(new Uint8Array(file.bytes)) }
}, projectFile)
const save = async (film, page) => {
  await film.focus()
  await page.keyboard.press('ControlOrMeta+s')
}

test('F38 a failed project save preserves the old file and unsaved edits; retry/reopen saves the exact timeline', async ({ film, page }) => {
  await film.open()
  const initial = await stored(page)
  await film.command('sequence.addEdit', { time: TICKS })
  const edited = editState(await film.sequence())
  const history = await film.history()
  await expect(film.kit.getByTestId('film-unsaved')).toBeVisible()
  await page.evaluate(path => {
    const files = window.devHost.files
    const set = files.set
    files.set = function(wanted, value) {
      if (wanted === path) {
        files.set = set
        throw new Error('Review project storage full')
      }
      return set.call(this, wanted, value)
    }
  }, projectFile)
  await save(film, page)
  await expect(film.kit.getByTestId('film-message')).toContainText('Review project storage full')
  expect(await stored(page)).toEqual(initial)
  await expect(film.kit.getByTestId('film-unsaved')).toBeVisible()
  expect(editState(await film.sequence())).toEqual(edited)
  expect(await film.history()).toEqual(history)
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(edited)
  await expect(film.kit.getByTestId('film-unsaved')).toHaveCount(0)
})

test('F39 editing while a real save waits for storage leaves the newer edit dirty; a second save/reopen retains both edits', async ({ film, page }) => {
  await film.open()
  await film.command('sequence.addEdit', { time: TICKS })
  const initial = await stored(page)
  const gate = await holdHostRequest(film, 'host/write')
  await save(film, page)
  await gate.wait()
  await film.command('sequence.addEdit', { time: TICKS / 2 })
  const after = editState(await film.sequence())
  const history = await film.history()
  await gate.release()
  await expect.poll(async () => (await stored(page)).version).not.toBe(initial.version)
  await expect(film.kit.getByTestId('film-unsaved')).toBeVisible()
  expect(editState(await film.sequence())).toEqual(after)
  expect(await film.history()).toEqual(history)
  const earlier = await stored(page)
  await film.saveReopen()
  expect((await stored(page)).bytes).not.toEqual(earlier.bytes)
  expect(editState(await film.sequence())).toEqual(after)
  await expect(film.kit.getByTestId('film-unsaved')).toHaveCount(0)
})
