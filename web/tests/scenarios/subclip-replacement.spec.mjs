import { test, expect, clips, editState, TICKS } from './fixtures.mjs'

for (const command of ['clip.replaceFromBin', 'clip.replaceFromSource', 'clip.replaceFromSourceMatchFrame']) {
  test(`F67 ${command} replaces both linked picture and sound with the subclip's nonzero source range`, async ({ film }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Replace linked media' })
    await film.command('file.newSequence', { name: 'Linked replacement', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
    const { item: old } = await film.command('file.newBarsAndTone', { seconds: 0.5 })
    await film.command('timeline.place', { item: old, seconds: 0 })
    const { item: parent } = await film.command('file.newBarsAndTone', { seconds: 2 })
    const { item } = await film.command('clip.makeSubclip', { item: parent, startFrame: 12, endFrame: 36 })
    await film.command('source.open', { item })
    await film.command('playhead.set', { frame: 0 })
    await film.command('timeline.select', { clips: [clips(await film.sequence())[0].clip], linked: true })
    const before = editState(await film.sequence()), history = await film.history()
    const result = await film.command(command, { item })
    const after = editState(await film.sequence())
    expect(result.clips).toHaveLength(2)
    for (const kind of ['video', 'audio']) {
      expect(clips(after, kind)).toHaveLength(1)
      const clip = clips(after, kind)[0]
      expect([clip.item, clip.start, clip.sourceIn, clip.duration]).toEqual([item, 0, TICKS / 2, TICKS / 2])
      expect(clip.link).toBe(clips(before, kind)[0].link)
    }
    expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
    await film.undo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(before)
    await film.redo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(after)
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(after)
  })
}
