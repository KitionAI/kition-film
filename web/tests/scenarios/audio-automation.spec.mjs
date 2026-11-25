import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect, TICKS } from './fixtures.mjs'

test('F54 Latch automation holds after release, changes gain at the next touch, and exports the saved stereo envelope', async ({ film, page }, testInfo) => {
  await film.open()
  await film.command('file.newProject', { name: 'Original automation tone' })
  await film.command('sequence.new', { name: 'Latch', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
  const { item } = await film.command('item.newBarsAndTone', { seconds: 0.5 })
  await film.command('timeline.place', { item, seconds: 0 })
  const exportWindows = async (path, name) => {
    await film.kit.getByTestId('film-export').click()
    await expect.poll(() => page.evaluate(path => window.devHost.files.has(path), path), { timeout: 30_000 }).toBe(true)
    const movie = testInfo.outputPath(name)
    writeFileSync(movie, Buffer.from(await page.evaluate(path => Array.from(new Uint8Array(window.devHost.files.get(path).bytes)), path)))
    const pcm = execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', movie, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    expect(pcm.length).toBeGreaterThanOrEqual(21600 * 2 * 4)
    return [[7200, 9600], [16800, 19200]].map(([start, end]) => [0, 1].map(channel => {
      let sum = 0
      for (let sample = start; sample < end; sample += 1) sum += pcm.readFloatLE((sample * 2 + channel) * 4) ** 2
      return Math.sqrt(sum / (end - start))
    }))
  }
  const baseline = await exportWindows('films/Sample.mp4', 'flat-tone.mp4')
  await film.command('mixer.setStrip', { strip: 'A1', mode: 'Latch' })
  const history = await film.history()
  await film.command('mixer.recordStart', { time: 0 })
  await film.command('mixer.touch', { strip: 'A1', lane: 'volume', value: -6, time: 0 })
  await film.command('mixer.release', { strip: 'A1', lane: 'volume', time: TICKS / 8 })
  await film.command('mixer.touch', { strip: 'A1', lane: 'volume', value: 0, time: TICKS / 4 })
  await film.command('mixer.release', { strip: 'A1', lane: 'volume', time: 3 * TICKS / 8 })
  await film.command('mixer.recordStop', { time: TICKS / 2 })
  const lanes = (await film.command('mixer.inspect')).strips[0].lanes
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
  for (const [time, value] of [[TICKS / 5, -6], [2 * TICKS / 5, 0]]) expect((await film.command('mixer.inspect', { time })).strips[0].at.volumeDb).toBe(value)
  await film.undo()
  expect((await film.command('mixer.inspect')).strips[0].lanes).toEqual({})
  await film.redo()
  expect((await film.command('mixer.inspect')).strips[0].lanes).toEqual(lanes)
  await film.saveReopen()
  expect((await film.command('mixer.inspect')).strips[0].lanes).toEqual(lanes)
  const automated = await exportWindows('films/Sample 2.mp4', 'latched-tone.mp4')
  for (let window = 0; window < 2; window += 1) for (let channel = 0; channel < 2; channel += 1) {
    expect(baseline[window][channel]).toBeGreaterThan(0.05)
    expect(Math.abs(automated[window][channel] / baseline[window][channel] - (window === 0 ? 10 ** (-6 / 20) : 1))).toBeLessThan(0.03)
  }
})
