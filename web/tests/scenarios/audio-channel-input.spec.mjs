import { test, expect, clips, editState } from './fixtures.mjs'

for (const target of ['source', 'timeline']) {
  test(`F66 invalid ${target} audio channel numbers are rejected without changing routing or history`, async ({ film }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Channel input validation' })
    await film.command('file.newSequence', { name: 'Stereo', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
    const { item } = await film.command('file.newBarsAndTone', { seconds: 0.5 })
    await film.command('timeline.place', { item, seconds: 0 })
    await film.command('project.select', { items: target === 'source' ? [item] : [] })
    const audio = clips(await film.sequence(), 'audio')[0].clip
    await film.command('timeline.select', { clips: [audio] })
    const before = editState(await film.sequence()), history = await film.history()
    for (const channel of [65536, 4294967296, 2, -1, 0.5, '1', null]) {
      const params = target === 'source' ? { format: 'mono', clips: [[channel]] } : { channels: [channel] }
      const error = await film.attempt('clip.audioChannels', params)
      expect(error, `reject channel ${JSON.stringify(channel)}`).toContain('channel')
      expect(await film.history()).toEqual(history)
      expect(editState(await film.sequence())).toEqual(before)
    }
    const valid = target === 'source' ? { format: 'mono', clips: [[1]] } : { channels: [1] }
    await film.command('clip.audioChannels', valid)
    expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
    await film.undo()
    await expect.poll(async () => (await film.history()).undo.length).toBe(history.undo.length)
    await film.redo()
    await expect.poll(async () => (await film.history()).undo.length).toBe(history.undo.length + 1)
    await film.saveReopen()
  })
}
