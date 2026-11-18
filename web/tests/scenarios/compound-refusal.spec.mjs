import { test, expect, editState } from './fixtures.mjs'

test('F74 failed Automate to Sequence restores content and the full history when its insert gap reached the history limit', async ({ film, page }) => {
  await film.open()
  await film.command('file.newProject', { name: 'Atomic automatic placement' })
  await film.command('file.newSequence', { name: 'Before', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
  const { item } = await film.command('file.newColorMatte', { color: '#ff0000', seconds: 0.5 })
  await film.command('timeline.place', { item, seconds: 0 })
  const renamed = await page.evaluate(async item => window.devHost.connection().ai.run(Array.from({ length: 205 }, (_, i) => ({ command: 'clip.rename', params: { item, name: `Take ${i}` } })), false), item)
  expect(renamed.failed).toBeFalsy()
  expect(renamed.completed).toHaveLength(205)
  const before = editState(await film.sequence()), history = await film.history()
  const error = await page.evaluate(async item => {
    try { await window.devHost.connection().ai.run([{ command: 'clip.automateToSequence', params: { items: [item], ignoreVideo: true, overlapFrames: 0 } }], false); return null }
    catch (error) { return String(error) }
  }, item)
  expect(error).toContain('no destination track')
  expect(editState(await film.sequence())).toEqual(before)
  expect(await film.history()).toEqual(history)
  await film.command('clip.automateToSequence', { items: [item], ignoreVideo: false, overlapFrames: 0, videoTransition: false, audioTransition: false })
  expect(editState(await film.sequence())).not.toEqual(before)
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(before)
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(before)
})
