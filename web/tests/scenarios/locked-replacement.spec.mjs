import { test, expect, clips, editState } from './fixtures.mjs'

for (const locked of ['V1', 'A1']) {
  test(`F68 replacing linked media refuses atomically when ${locked} is locked; unlocking restores replacement and undo`, async ({ film, page }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Locked replacement' })
    await film.command('file.newSequence', { name: 'Protected tracks', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
    const { item: original } = await film.command('file.newBarsAndTone', { seconds: 0.5 })
    await film.command('timeline.place', { item: original, seconds: 0 })
    const { item: replacement } = await film.command('file.newBarsAndTone', { seconds: 1 })
    await film.command('timeline.setTrack', { track: locked, locked: true })
    const sequence = await film.sequence()
    const ids = [...clips(sequence), ...clips(sequence, 'audio')].map(clip => clip.clip)
    const before = editState(sequence), history = await film.history()
    const error = await page.evaluate(async params => {
      try { await window.devHost.connection().ai.run([{ command: 'clip.replaceFromBin', params }], false); return null }
      catch (error) { return String(error) }
    }, { item: replacement, clips: ids })
    expect(editState(await film.sequence())).toEqual(before)
    expect(error).toContain('locked')
    expect(await film.history()).toEqual(history)
    await film.command('timeline.setTrack', { track: locked, locked: false })
    const unlocked = editState(await film.sequence())
    const result = await film.command('clip.replaceFromBin', { item: replacement, clips: ids })
    expect(result.clips.slice().sort()).toEqual(ids.slice().sort())
    const after = editState(await film.sequence())
    for (const kind of ['video', 'audio']) expect(clips(after, kind)[0].item).toBe(replacement)
    await film.undo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(unlocked)
    await film.redo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(after)
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(after)
  })
}
