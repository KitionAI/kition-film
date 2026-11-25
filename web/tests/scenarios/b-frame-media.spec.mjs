import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect, clips, editState, lendMedia, TICKS } from './fixtures.mjs'

test('F44 real H.264 B-frames decode in presentation order after a source trim, reopen and reverse export', async ({ film, page }, testInfo) => {
  const ffmpeg = process.env.KITION_FILM_FFMPEG ?? 'ffmpeg'
  const source = testInfo.outputPath('original-b-frames.mp4')
  const inputs = ['0xff0000', '0x00ff00', '0x0000ff', '0xffffff'].flatMap(color => ['-f', 'lavfi', '-i', `color=c=${color}:s=64x36:r=24:d=0.25`])
  execFileSync(ffmpeg, ['-v', 'error', ...inputs, '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-bf', '2', '-g', '24', '-x264-params', 'b-adapt=0:scenecut=0:keyint=24:min-keyint=24', '-movflags', '+faststart', '-y', source], { timeout: 30_000 })
  const probe = JSON.parse(execFileSync(process.env.KITION_FILM_FFPROBE ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=pict_type', '-of', 'json', source], { encoding: 'utf8', timeout: 30_000 }))
  expect(probe.frames).toHaveLength(24)
  expect(probe.frames.filter(frame => frame.pict_type === 'B').length).toBeGreaterThan(0)
  await film.open()
  const reads = await lendMedia(film, 'clips/original-b-frames.mp4', readFileSync(source))
  await film.command('file.newProject', { name: 'Presentation order' })
  await film.command('sequence.new', { name: 'B-frame trim', width: 64, height: 36, fps: 24, video: 1, audio: 0 })
  const imported = await film.command('file.import', { paths: ['../clips/original-b-frames.mp4'] })
  expect(imported.errors).toEqual([])
  expect(imported.items).toHaveLength(1)
  await film.command('timeline.place', { item: imported.items[0], track: 'V1', time: 0, sourceIn: TICKS / 4, duration: TICKS / 2 })
  for (const reversed of [false, true]) {
    if (reversed) {
      await film.command('timeline.select', { clips: [clips(await film.sequence())[0].clip] })
      await film.menu('clip.speedDuration')
      await film.kit.getByTestId('film-dialog-speedDuration-reverse').check()
      await film.kit.getByTestId('film-dialog-ok').click()
      await expect.poll(async () => clips(await film.sequence())[0].reverse).toBe(true)
    }
    const before = await film.sequence()
    expect(clips(before)[0]).toMatchObject({ sourceIn: TICKS / 4, sourceOut: TICKS * 3 / 4, durationFrames: 12, reverse: reversed })
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(editState(before))
    // Visit both ends first so export cannot depend on a decoder left at the first source frame.
    await film.command('playhead.set', { frame: 11 })
    await film.command('playhead.set', { frame: 0 })
    const path = reversed ? 'films/Sample 2.mp4' : 'films/Sample.mp4'
    await film.kit.getByTestId('film-export').click()
    await expect.poll(() => page.evaluate(path => window.devHost.files.has(path), path), { timeout: 30_000 }).toBe(true)
    const movie = testInfo.outputPath(reversed ? 'b-frames-reversed.mp4' : 'b-frames-trimmed.mp4')
    writeFileSync(movie, Buffer.from(await page.evaluate(path => Array.from(new Uint8Array(window.devHost.files.get(path).bytes)), path)))
    const rgb = execFileSync(ffmpeg, ['-v', 'error', '-i', movie, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    expect(rgb.length).toBe(64 * 36 * 3 * 12)
    for (let frame = 0; frame < 12; frame += 1) {
      const primary = (frame < 6) !== reversed ? 1 : 2
      const sums = [0, 0, 0]
      for (let pixel = 0; pixel < 64 * 36; pixel += 1) for (let channel = 0; channel < 3; channel += 1) sums[channel] += rgb[(frame * 64 * 36 + pixel) * 3 + channel]
      for (let channel = 0; channel < 3; channel += 1) {
        const mean = sums[channel] / (64 * 36)
        if (channel === primary) expect(mean, `reverse ${reversed}, frame ${frame} primary`).toBeGreaterThan(230)
        else expect(mean, `reverse ${reversed}, frame ${frame} channel ${channel}`).toBeLessThan(25)
      }
    }
  }
  expect(reads.some(read => read.method === 'GET' && read.range != null)).toBe(true)
})
