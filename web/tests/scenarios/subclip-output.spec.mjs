import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect, clips, editState, TICKS } from './fixtures.mjs'

test('F59 a nonzero subclip range retains linked picture and tone through history, reopen, and actual export', async ({ film, page }, testInfo) => {
  await film.open()
  await film.command('file.newProject', { name: 'Subclip picture and sound' })
  await film.command('file.newSequence', { name: 'Subclip', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
  const { item: parent } = await film.command('file.newBarsAndTone', { seconds: 2 })
  const { item } = await film.command('clip.makeSubclip', { item: parent, startFrame: 12, endFrame: 24 })
  const before = editState(await film.sequence())
  await film.command('timeline.place', { item, seconds: 0 })
  const after = editState(await film.sequence())
  expect(clips(after)).toHaveLength(1)
  expect(clips(after, 'audio')).toHaveLength(1)
  for (const kind of ['video', 'audio']) expect(clips(after, kind).map(clip => [clip.item, clip.startFrame, clip.durationFrames, clip.sourceIn])).toEqual([[item, 0, 12, TICKS / 2]])
  await film.command('timeline.select', { clips: [clips(after)[0].clip], linked: true })
  expect((await film.sequence()).selection.slice().sort()).toEqual([clips(after)[0].clip, clips(after, 'audio')[0].clip].sort())
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(before)
  await film.redo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(after)
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(after)
  await film.kit.getByTestId('film-export').click()
  await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample.mp4')), { timeout: 30_000 }).toBe(true)
  const movie = testInfo.outputPath('subclip.mp4')
  writeFileSync(movie, Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes)))))
  const decode = args => execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', movie, ...args, 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
  const rgb = decode(['-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24'])
  expect(rgb.length).toBe(64 * 36 * 3 * 12)
  for (let frame = 0; frame < 12; frame += 1) {
    // The seven 75% bars sit between gray side margins. Sample each bar's interior.
    const colors = [[1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0], [1, 0, 1], [1, 0, 0], [0, 0, 1]]
    for (let bar = 0; bar < colors.length; bar += 1) {
      const x = Math.floor(8 + (bar + 0.5) * 48 / 7)
      const offset = (frame * 64 * 36 + 4 * 64 + x) * 3
      for (let channel = 0; channel < 3; channel += 1) {
        if (colors[bar][channel]) expect(rgb[offset + channel]).toBeGreaterThan(170)
        else expect(rgb[offset + channel]).toBeLessThan(35)
      }
    }
  }
  const pcm = decode(['-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le'])
  expect(pcm.length).toBeGreaterThanOrEqual(24_000 * 2 * 4)
  for (const channel of [0, 1]) {
    let energy = 0, crossings = 0, previous = 0
    for (let sample = 4800; sample < 19_200; sample += 1) {
      const value = pcm.readFloatLE((sample * 2 + channel) * 4)
      energy += value * value
      if (sample > 4800 && previous <= 0 && value > 0) crossings += 1
      previous = value
    }
    expect(Math.sqrt(energy / 14_400)).toBeGreaterThan(0.05)
    expect(Math.sqrt(energy / 14_400)).toBeLessThan(0.09)
    expect(Math.abs(crossings / 0.3 - 1000)).toBeLessThan(10)
  }
})
