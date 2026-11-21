import { test, expect, clips, editState, TICKS } from './fixtures.mjs'

for (const removeBin of [false, true]) {
  test(`F57 deleting a subclip's ${removeBin ? 'parent bin' : 'parent source'} refuses atomically; explicit deletion and undo restore usable media`, async ({ film, page }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Subclip dependencies' })
    await film.command('file.newSequence', { name: 'Subclip', width: 64, height: 36, fps: 24, video: 1, audio: 0 })
    const { item: parent } = await film.command('file.newColorMatte', { color: '#ff0000', seconds: 2 })
    const { item: subclip } = await film.command('clip.makeSubclip', { item: parent, startFrame: 12, endFrame: 24, name: 'Half-second excerpt' })
    const { bin } = await film.command('file.newBin', { name: 'Originals' })
    await film.command('project.moveToBin', { items: [parent], bin })
    await film.command('timeline.place', { item: subclip, seconds: 0 })
    const timeline = editState(await film.sequence())
    expect(clips(await film.sequence()).map(clip => [clip.item, clip.startFrame, clip.durationFrames, clip.sourceIn])).toEqual([[subclip, 0, 12, TICKS / 2]])
    await film.command('project.select', { items: [removeBin ? bin : parent] })
    const history = await film.history()
    const project = await film.command('project.items')
    const error = await film.attempt('project.delete')
    expect(error).toContain('subclip')
    expect(await film.history()).toEqual(history)
    expect(await film.command('project.items')).toEqual(project)
    expect(editState(await film.sequence())).toEqual(timeline)
    await film.command('project.select', { items: [removeBin ? bin : parent, subclip] })
    await film.command('project.delete')
    expect(clips(await film.sequence())).toEqual([])
    await film.undo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(timeline)
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(timeline)
    await film.command('source.open', { item: subclip })
    await film.command('source.inspect')
    await film.command('playhead.set', { frame: 6 })
    // Check the real raster still resolves the parent after history and persistence.
    await expect.poll(() => film.kit.getByTestId('film-program').evaluate(program => {
      const canvas = program.querySelector('canvas')
      return Array.from(canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
    })).toEqual([255, 0, 0, 255])
  })
}
