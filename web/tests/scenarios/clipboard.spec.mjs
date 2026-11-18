import { test, expect, clips, editState, TICKS } from './fixtures.mjs'

test('F37 Copy and Paste Insert duplicate linked sound/picture, ripple once, and give the new pair an independent link', async ({ film, page }) => {
  await film.open()
  await film.command('file.newProject', { name: 'Linked clipboard' })
  await film.command('file.newSequence', { name: 'Clipboard', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
  const { item } = await film.command('file.newBarsAndTone', { seconds: 2 })
  await film.command('timeline.place', { item, seconds: 0 })
  await film.command('sequence.addEdit', { time: TICKS })
  const before = await film.sequence()
  await film.command('timeline.select', { clips: [clips(before)[0].clip] })
  await film.focus()
  await page.keyboard.press('ControlOrMeta+c')
  await film.command('playhead.set', { frame: 24 })
  const history = await film.history()
  await film.menu('edit.pasteInsert')
  await expect.poll(async () => clips(await film.sequence()).length).toBe(3)
  const after = await film.sequence()
  for (const kind of ['video', 'audio']) {
    expect(clips(after, kind).map(clip => [clip.startFrame, clip.durationFrames, clip.sourceIn, clip.sourceOut])).toEqual([
      [0, 24, 0, TICKS], [24, 24, 0, TICKS], [48, 24, TICKS, 2 * TICKS],
    ])
    expect(new Set(clips(after, kind).map(clip => clip.link)).size).toBe(3)
  }
  expect(clips(after).map(clip => clip.link)).toEqual(clips(after, 'audio').map(clip => clip.link))
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
  await film.redo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
  // Selecting only the pasted picture and clearing removes its sound, but not the original.
  await film.command('timeline.select', { clips: [clips(after)[1].clip] })
  await film.menu('edit.clear')
  const cleared = await film.sequence()
  for (const kind of ['video', 'audio']) expect(clips(cleared, kind)).toEqual([clips(after, kind)[0], clips(after, kind)[2]])
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(editState(after))
})
