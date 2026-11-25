import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect, clips, editState, TICKS, lendMedia } from './fixtures.mjs'

test('F31 imported H.264 reverses and retimes real frames through Speed Duration, history and reopen', async ({ film, page }, testInfo) => {
  const ffmpeg = process.env.KITION_FILM_FFMPEG ?? 'ffmpeg'
  const source = testInfo.outputPath('original-red-blue.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24:d=0.25', '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=24:d=0.25', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '12', '-movflags', '+faststart', '-y', source], { timeout: 30_000 })
  await film.open()
  const reads = await lendMedia(film, 'clips/original-red-blue.mp4', readFileSync(source))
  await film.command('file.newProject', { name: 'Reverse imported footage' })
  await film.command('sequence.new', { name: 'Reverse', width: 64, height: 36, fps: 24, video: 1, audio: 0 })
  const imported = await film.command('file.import', { paths: ['../clips/original-red-blue.mp4'] })
  expect(imported.errors).toEqual([])
  expect(imported.items).toHaveLength(1)
  expect(reads.some(read => read.method === 'GET' && read.range != null)).toBe(true)
  await film.command('timeline.place', { item: imported.items[0], track: 'V1', seconds: 0 })
  for (const [speed, frameCount, exported] of [[100, 12, 'films/Sample.mp4'], [200, 6, 'films/Sample 2.mp4']]) {
    const before = await film.sequence()
    await film.command('timeline.select', { clips: [clips(before)[0].clip] })
    const history = await film.history()
    await film.menu('clip.speedDuration')
    await film.kit.getByTestId('film-dialog-speedDuration-speed').locator('input').fill(String(speed))
    await film.kit.getByTestId('film-dialog-speedDuration-reverse').check()
    await film.kit.getByTestId('film-dialog-ok').click()
    await expect.poll(async () => [clips(await film.sequence())[0].reverse, clips(await film.sequence())[0].speed]).toEqual([true, speed / 100])
    const after = await film.sequence()
    expect(after.duration).toBe(frameCount * TICKS / 24)
    expect([clips(after)[0].sourceIn, clips(after)[0].sourceOut]).toEqual([0, TICKS / 2])
    expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
    await film.undo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
    await film.redo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(editState(after))
    await film.kit.getByTestId('film-export').click()
    await expect.poll(() => page.evaluate(path => window.devHost.files.has(path), exported), { timeout: 30_000 }).toBe(true)
    const movie = testInfo.outputPath(`reversed-${speed}.mp4`)
    writeFileSync(movie, Buffer.from(await page.evaluate(path => Array.from(new Uint8Array(window.devHost.files.get(path).bytes)), exported)))
    const rgb = execFileSync(ffmpeg, ['-v', 'error', '-i', movie, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    expect(rgb.length).toBe(64 * 36 * 3 * frameCount)
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sums = [0, 0, 0]
      for (let pixel = 0; pixel < 64 * 36; pixel += 1) for (let channel = 0; channel < 3; channel += 1) sums[channel] += rgb[(frame * 64 * 36 + pixel) * 3 + channel]
      const means = sums.map(sum => sum / (64 * 36))
      for (let channel = 0; channel < 3; channel += 1) {
        if (channel === (frame < frameCount / 2 ? 2 : 0)) expect(means[channel], `speed ${speed}, frame ${frame}, primary`).toBeGreaterThan(230)
        else expect(means[channel], `speed ${speed}, frame ${frame}, channel ${channel}`).toBeLessThan(25)
      }
    }
  }
})
