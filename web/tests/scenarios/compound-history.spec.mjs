import { test, expect, clips } from './fixtures.mjs'

for (const edits of [0, 205]) {
  test(`F73 New Sequence From Clip remains one complete undo step after ${edits} prior edits`, async ({ film, page }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Compound history limit' })
    const { sequence: original } = await film.command('file.newSequence', { name: 'Original', width: 64, height: 36, fps: 24, video: 1, audio: 0 })
    const { item } = await film.command('file.newColorMatte', { color: '#ff0000', seconds: 0.5 })
    const renamed = await page.evaluate(async ([item, edits]) => window.devHost.connection().ai.run(Array.from({ length: edits }, (_, i) => ({ command: 'clip.rename', params: { item, name: `Take ${i}` } })), false), [item, edits])
    expect(renamed.failed).toBeFalsy()
    expect(renamed.completed).toHaveLength(edits)
    const before = await film.command('project.items')
    const { sequence, clips: placed } = await film.command('file.newSequenceFromClip', { items: [item] })
    expect(placed).toHaveLength(1)
    expect((await film.sequence()).id).toBe(sequence)
    expect(clips(await film.sequence()).map(clip => clip.item)).toEqual([item])
    await film.undo()
    await expect.poll(async () => (await film.command('project.items')).rows.map(row => row.item)).toEqual(before.rows.map(row => row.item))
    expect((await film.sequence()).id).toBe(original)
    await film.redo()
    await expect.poll(async () => (await film.command('project.items')).rows.some(row => row.item === sequence)).toBe(true)
    await film.command('sequence.open', { item: sequence })
    expect(clips(await film.sequence()).map(clip => clip.item)).toEqual([item])
    await film.saveReopen()
    expect(clips(await film.sequence()).map(clip => clip.item)).toEqual([item])
  })
}
