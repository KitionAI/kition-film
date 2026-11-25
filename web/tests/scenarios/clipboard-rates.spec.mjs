import { test, expect, clips, editState, TICKS } from './fixtures.mjs'

for (const command of ['edit.paste', 'edit.pasteInsert']) {
  test(`F76 consecutive ${command} across 24 and 25 fps preserves the preceding linked copy and lands on complete destination frames`, async ({ film }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Clipboard rates' })
    await film.command('sequence.new', { name: '24 fps source', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
    const { item } = await film.command('item.newBarsAndTone', { seconds: 2 })
    await film.command('timeline.place', { item, seconds: 0, sourceIn: TICKS / 2, duration: TICKS / 2 })
    await film.command('timeline.select', { clips: clips(await film.sequence()).map(clip => clip.clip) })
    await film.command('edit.copy')
    await film.command('sequence.new', { name: '25 fps destination', width: 64, height: 36, fps: 25, video: 1, audio: 1 })
    await film.command(command)
    const first = editState(await film.sequence())
    await film.command(command)
    const after = editState(await film.sequence())
    for (const kind of ['video', 'audio']) {
      const old = clips(first, kind)[0], all = clips(after, kind)
      expect(all.find(clip => clip.clip === old.clip)).toEqual(old)
      expect(all.map(clip => [clip.start, clip.duration, clip.sourceIn])).toEqual([[0, 12 * TICKS / 25, TICKS / 2], [12 * TICKS / 25, 12 * TICKS / 25, TICKS / 2]])
    }
    expect(clips(after).map(clip => clip.link)).toEqual(clips(after, 'audio').map(clip => clip.link))
    expect(new Set(clips(after).map(clip => clip.link)).size).toBe(2)
    await film.undo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(first)
    await film.redo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(after)
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(after)
  })
}
