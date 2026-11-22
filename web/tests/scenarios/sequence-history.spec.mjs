import { test, expect } from './fixtures.mjs'

test('F62 undo and redo restore a missing sequence tab while ordinary history respects closed tabs', async ({ film }) => {
  await film.open()
  await film.command('file.newProject', { name: 'History tabs' })
  const { sequence } = await film.command('file.newSequence', { name: 'First' })
  // The Program monitor, at the new sequence's render scale, repaints where the playhead rests
  // (its own `playhead.set`, after file.newSequence has answered): the state is read once that
  // has reached the editor state, not while it is still on its way.
  await expect.poll(async () => (await film.sequence())?.playhead ?? null).not.toBeNull()
  const original = await film.sequence()
  await film.undo()
  await expect.poll(() => film.sequence()).toBeNull()
  await film.redo()
  await expect.poll(() => film.sequence()).toEqual(original)
  await film.command('project.delete', { items: [sequence] })
  expect(await film.sequence()).toBeNull()
  await film.undo()
  await expect.poll(() => film.sequence()).toEqual(original)
  await film.saveReopen()
  expect(await film.sequence()).toEqual(original)
  await film.command('sequence.close', { item: sequence })
  await film.command('clip.rename', { item: sequence, name: 'Renamed' })
  await film.command('edit.undo')
  expect(await film.sequence()).toBeNull()
  await film.command('edit.redo')
  expect(await film.sequence()).toBeNull()
})
