import { test, expect, editState, TICKS } from './fixtures.mjs'

for (const difference of ['dimensions', 'frame rate']) {
  test(`F75 Consolidate Duplicates preserves distinct generator ${difference} and remaps only a true duplicate's subclip`, async ({ film }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Distinct media formats' })
    await film.command('sequence.new', { name: 'First format', width: 64, height: 36, fps: 24, video: 1, audio: 0 })
    const { item: first } = await film.command('item.newColorMatte', { color: '#ff0000', seconds: 1 })
    const width = difference === 'dimensions' ? 128 : 64, height = difference === 'dimensions' ? 72 : 36, fps = difference === 'frame rate' ? 60 : 24
    await film.command('sequence.new', { name: 'Second format', width, height, fps, video: 1, audio: 0 })
    const { item: second } = await film.command('item.newColorMatte', { color: '#ff0000', seconds: 1 })
    await film.command('project.select', { items: [second] })
    const { items: [duplicate] } = await film.command('edit.duplicate')
    const { item: subclip } = await film.command('clip.makeSubclip', { item: duplicate, startFrame: 3, endFrame: 9 })
    await film.command('timeline.place', { item: subclip, seconds: 0 })
    const before = editState(await film.sequence())
    const consolidated = await film.command('edit.consolidateDuplicates')
    expect(consolidated.removed).toEqual([duplicate])
    const rows = (await film.command('project.items')).rows
    expect(rows.some(row => row.item === first)).toBe(true)
    expect(rows.some(row => row.item === second)).toBe(true)
    expect(rows.find(row => row.item === subclip).frame).toBe(TICKS / fps)
    await film.command('source.open', { item: subclip })
    expect(await film.command('source.inspect')).toMatchObject({ media: second, width, height })
    expect(editState(await film.sequence())).toEqual(before)
    await film.undo()
    await expect.poll(async () => (await film.command('source.inspect')).media).toBe(duplicate)
    await film.redo()
    await expect.poll(async () => (await film.command('source.inspect')).media).toBe(second)
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(before)
    await film.command('playhead.set', { frame: 2 })
    await expect.poll(() => film.kit.getByTestId('film-program').evaluate(program => {
      const canvas = program.querySelector('canvas'), context = canvas.getContext('2d')
      return [0.25, 0.5, 0.75].flatMap(x => [0.25, 0.5, 0.75].map(y => Array.from(context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data)))
    })).toEqual(Array.from({ length: 9 }, () => [255, 0, 0, 255]))
  })
}
