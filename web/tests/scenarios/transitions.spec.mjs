import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect, clips, editState, TICKS } from './fixtures.mjs'

test('F34 default Cross Dissolve joins two shots with exact handles and the expected linear-light exported colors', async ({ film, page }, testInfo) => {
  await film.open()
  await film.command('file.newProject', { name: 'Original dissolve' })
  await film.command('file.newSequence', { name: 'Dissolve', width: 64, height: 36, fps: 24, video: 1, audio: 0 })
  for (const [seconds, color] of [[0, '#ff0000'], [0.5, '#0000ff']]) {
    const { item } = await film.command('file.newColorMatte', { color, seconds: 0.5 })
    await film.command('timeline.place', { item, track: 'V1', seconds })
  }
  await film.command('prefs.set', { values: { 'timeline.videoTransitionDuration': 6, 'timeline.videoTransitionUnit': 'frames' } })
  await film.command('playhead.set', { frame: 12 })
  const before = await film.sequence()
  const history = await film.history()
  await film.menu('sequence.applyVideoTransition')
  await expect.poll(async () => (await film.sequence()).video[0].transitions.length).toBe(1)
  const after = await film.sequence()
  expect(after.video[0].transitions[0]).toMatchObject({ effect: 'cross_dissolve', start: 9 * TICKS / 24, duration: 6 * TICKS / 24, from: clips(before)[0].clip, to: clips(before)[1].clip })
  expect(clips(after)).toEqual(clips(before))
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
  await film.redo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(editState(after))
  await film.kit.getByTestId('film-export').click()
  await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample.mp4')), { timeout: 30_000 }).toBe(true)
  const movie = testInfo.outputPath('original-dissolve.mp4')
  writeFileSync(movie, Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes)))))
  const rgb = execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', movie, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
  expect(rgb.length).toBe(64 * 36 * 3 * 24)
  // Mix red and blue in linear light, then apply the standard sRGB transfer function.
  const encoded = value => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)
  for (let frame = 0; frame < 24; frame += 1) {
    const mix = Math.max(0, Math.min(1, (frame - 9) / 6))
    const expected = [encoded(1 - mix), 0, encoded(mix)]
    const sums = [0, 0, 0]
    for (let pixel = 0; pixel < 64 * 36; pixel += 1) for (let channel = 0; channel < 3; channel += 1) sums[channel] += rgb[(frame * 64 * 36 + pixel) * 3 + channel]
    for (let channel = 0; channel < 3; channel += 1) expect(Math.abs(sums[channel] / (64 * 36) - expected[channel]), `frame ${frame}, channel ${channel}`).toBeLessThan(6)
  }
})
