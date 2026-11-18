import { test, expect, holdWorkerReply } from './fixtures.mjs'

for (const interruption of ['replacement project', 'permissions', 'newer dialog']) {
  test(`F33 a dialog waiting to end its preview cannot submit after ${interruption}`, async ({ film }) => {
    await film.open()
    await film.menu('file.newSequence')
    await film.kit.getByTestId('film-dialog-sequenceSettings-name').fill('Old dialog must not create this')
    await expect.poll(() => film.frame().evaluate(async () => Boolean(await window.filmPreview.inspect()))).toBe(true)
    const gate = await holdWorkerReply(film, 'previewEnd')
    await film.kit.getByTestId('film-dialog-ok').click()
    await gate.wait()
    if (interruption === 'replacement project') await film.command('file.newProject', { name: 'Replacement stays empty' })
    else if (interruption === 'permissions') {
      await film.configure({ disable: ['command:file.newSequence'] })
      await film.configure({ disable: [] })
    } else {
      await film.menu('sequence.settings')
      await film.kit.getByTestId('film-dialog-sequenceSettings-name').fill('Keep the newer settings draft')
    }
    const before = await film.details()
    const history = await film.history()
    await gate.release()
    if (interruption === 'newer dialog') {
      await expect(film.kit.getByTestId('film-dialog')).toBeVisible()
      await expect(film.kit.getByTestId('film-dialog-sequenceSettings-name')).toHaveValue('Keep the newer settings draft')
    } else await expect(film.kit.getByTestId('film-dialog')).toHaveCount(0)
    expect(await film.history()).toEqual(history)
    expect(await film.details()).toEqual(before)
  })
}

test('F33 a fresh OK after permissions recover still submits the open draft', async ({ film }) => {
  await film.open()
  await film.menu('file.newSequence')
  await film.kit.getByTestId('film-dialog-sequenceSettings-name').fill('Fresh authorized sequence')
  await film.configure({ disable: ['command:file.newSequence'] })
  await film.configure({ disable: [] })
  const history = await film.history()
  await film.kit.getByTestId('film-dialog-ok').click()
  await expect(film.kit.getByTestId('film-dialog')).toHaveCount(0)
  await expect.poll(async () => (await film.sequence()).name).toBe('Fresh authorized sequence')
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
})
