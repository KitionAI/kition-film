import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect, editState, TICKS } from './fixtures.mjs'

test('F40 opacity keyframes blend two video tracks in linear light; disabling the upper clip reveals the lower shot', async ({ film, page }, testInfo) => {
  await film.open()
  await film.command('file.newProject', { name: 'Original opacity animation' })
  await film.command('file.newSequence', { name: 'Opacity', width: 64, height: 36, fps: 24, video: 2, audio: 0 })
  for (const [track, color] of [['V1', '#ff0000'], ['V2', '#0000ff']]) {
    const { item } = await film.command('file.newColorMatte', { color, seconds: 0.5 })
    await film.command('timeline.place', { item, track, seconds: 0 })
  }
  const clip = (await film.sequence()).video[1].items[0].clip
  await film.command('playhead.set', { frame: 0 })
  const param = { clip, effect: 'opacity', param: 'opacity' }
  await film.command('effects.setParam', { ...param, value: 0 })
  await film.command('effects.toggleAnimation', param)
  const before = await film.sequence()
  await film.command('effects.setParam', { ...param, value: 100, time: 11 * TICKS / 24 })
  const after = await film.sequence()
  expect(after.video[1].items[0].effects.find(effect => effect.effect === 'opacity').params.opacity.keyframes).toBe(2)
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
  await film.redo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(editState(after))
  for (const disabled of [false, true]) {
    if (disabled) {
      await film.command('timeline.select', { clips: [clip] })
      await film.menu('clip.enable')
      await expect.poll(async () => (await film.sequence()).video[1].items[0].enabled).toBe(false)
    }
    const path = disabled ? 'films/Sample 2.mp4' : 'films/Sample.mp4'
    await film.kit.getByTestId('film-export').click()
    await expect.poll(() => page.evaluate(path => window.devHost.files.has(path), path), { timeout: 30_000 }).toBe(true)
    const movie = testInfo.outputPath(disabled ? 'upper-disabled.mp4' : 'animated-opacity.mp4')
    writeFileSync(movie, Buffer.from(await page.evaluate(path => Array.from(new Uint8Array(window.devHost.files.get(path).bytes)), path)))
    const rgb = execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', movie, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    expect(rgb.length).toBe(64 * 36 * 3 * 12)
    const encoded = value => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)
    for (let frame = 0; frame < 12; frame += 1) {
      const alpha = disabled ? 0 : frame / 11
      const expected = [encoded(1 - alpha), 0, encoded(alpha)]
      const sums = [0, 0, 0]
      for (let pixel = 0; pixel < 64 * 36; pixel += 1) for (let channel = 0; channel < 3; channel += 1) sums[channel] += rgb[(frame * 64 * 36 + pixel) * 3 + channel]
      for (let channel = 0; channel < 3; channel += 1) expect(Math.abs(sums[channel] / (64 * 36) - expected[channel]), `disabled ${disabled}, frame ${frame}, channel ${channel}`).toBeLessThan(6)
    }
  }
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
})
