import { test, expect, clips, editState } from './fixtures.mjs'

async function copiedLayers(film) {
  await film.open()
  await film.command('file.newProject', { name: 'Clipboard boundaries' })
  const { sequence } = await film.command('file.newSequence', { name: 'Source', width: 64, height: 36, fps: 24, video: 2, audio: 1 })
  const sources = []
  for (const [track, color] of [['V1', '#ff0000'], ['V2', '#0000ff']]) {
    const { item } = await film.command('file.newColorMatte', { color, seconds: 1 })
    await film.command('timeline.place', { item, track, seconds: 0 })
    sources.push(item)
  }
  await film.command('timeline.select', { clips: clips(await film.sequence()).map(item => item.clip) })
  await film.command('edit.copy')
  return { sequence, sources }
}

async function refuse(film, command, reason) {
  const before = await film.sequence()
  const history = await film.history()
  const error = await film.attempt(command)
  expect(error, `${command} refused`).toContain(reason)
  expect(await film.sequence()).toEqual(before)
  expect(await film.history()).toEqual(history)
}

for (const command of ['edit.paste', 'edit.pasteInsert']) {
  test(`F45 ${command} refuses missing destination tracks, then preserves both layers after tracks are added`, async ({ film }) => {
    const { sources } = await copiedLayers(film)
    await film.command('file.newSequence', { name: 'Destination', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
    await refuse(film, command, 'track V2')
    await film.command('sequence.addTracks', { video: 1 })
    const before = await film.sequence()
    await film.menu(command)
    await expect.poll(async () => clips(await film.sequence()).length).toBe(2)
    const after = await film.sequence()
    expect(after.video.map(track => track.items.map(item => [item.item, item.startFrame, item.durationFrames]))).toEqual(sources.map(source => [[source, 0, 24]]))
    expect(new Set(clips(after).map(item => item.clip)).size).toBe(2)
    await film.undo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
    await film.redo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(editState(after))
  })

  test(`F46 ${command} refuses a deleted clipboard source and works again after undo restores it`, async ({ film }) => {
    const { sources } = await copiedLayers(film)
    await film.command('project.select', { items: [sources[0]] })
    await film.command('project.delete')
    await refuse(film, command, 'source is no longer in the project')
    await film.undo()
    await expect.poll(async () => clips(await film.sequence()).length).toBe(2)
    await film.command('playhead.set', { frame: 24 })
    await film.menu(command)
    await expect.poll(async () => clips(await film.sequence()).length).toBe(4)
    const after = await film.sequence()
    expect(after.video.map(track => track.items.map(item => [item.item, item.startFrame, item.durationFrames]))).toEqual(sources.map(source => [[source, 0, 24], [source, 24, 24]]))
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(editState(after))
  })
}

test('F47 clipboard refuses recursive sequence nesting and is cleared when the project is replaced', async ({ film }) => {
  const { sequence: source } = await copiedLayers(film)
  await film.command('file.newSequence', { name: 'Outer', width: 64, height: 36, fps: 24, video: 2, audio: 1 })
  await film.command('timeline.place', { item: source, seconds: 0 })
  await film.command('timeline.select', { clips: clips(await film.sequence()).map(item => item.clip) })
  await film.command('edit.copy')
  await film.command('sequence.open', { item: source })
  await refuse(film, 'edit.paste', 'cannot be nested inside itself')
  await film.command('file.newProject', { name: 'Replacement' })
  await film.command('file.newSequence', { name: 'Replacement', width: 64, height: 36, fps: 24, video: 2, audio: 1 })
  // IDs can be reused by a fresh project, but the old clipboard must not refer to them.
  await refuse(film, 'edit.paste', 'clipboard')
  await film.saveReopen()
  expect(clips(await film.sequence())).toEqual([])
})
