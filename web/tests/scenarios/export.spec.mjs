import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect, holdWorkerCall, tinyMovie } from './fixtures.mjs'

test('F08 cancelling while finished export bytes are being collected writes no movie and allows another export', async ({ film, page }) => {
  await film.open()
  await tinyMovie(film)
  const gate = await holdWorkerCall(film, 'takeFile')
  await film.kit.getByTestId('film-export').click()
  await gate.wait()
  await film.kit.getByTestId('film-exporting-cancel').click()
  await gate.release()
  await expect(film.kit.getByTestId('film-exporting')).toHaveCount(0)
  const movies = () => page.evaluate(() => [...window.devHost.files.keys()].filter(path => path.startsWith('films/') && path.endsWith('.mp4')))
  expect(await movies()).toEqual([])
  await film.kit.getByTestId('film-export').click()
  await expect.poll(movies, { timeout: 30_000 }).toEqual(['films/Sample.mp4'])
  const bytes = await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes)))
  expect(String.fromCharCode(...bytes.slice(4, 8))).toBe('ftyp')
  expect(bytes.length).toBeGreaterThan(100)
})


test('F12 exported original six-frame movie has the expected codec, size, rate and red pixels', async ({ film, page }, testInfo) => {
  await film.open()
  await tinyMovie(film)
  await film.kit.getByTestId('film-export').click()
  await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample.mp4')), { timeout: 30_000 }).toBe(true)
  const bytes = Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes))))
  const movie = testInfo.outputPath('six-red-frames.mp4')
  writeFileSync(movie, bytes)
  const ffprobe = process.env.KITION_FILM_FFPROBE ?? 'ffprobe'
  const ffmpeg = process.env.KITION_FILM_FFMPEG ?? 'ffmpeg'
  const metadata = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_streams', '-of', 'json', movie], { encoding: 'utf8', timeout: 30_000 }))
  const stream = metadata.streams[0]
  expect({ codec: stream.codec_name, width: stream.width, height: stream.height, rate: stream.r_frame_rate, frames: Number(stream.nb_read_frames) }).toEqual({ codec: 'h264', width: 64, height: 36, rate: '24/1', frames: 6 })
  expect(Number(stream.duration)).toBeCloseTo(0.25, 5)
  const rgb = execFileSync(ffmpeg, ['-v', 'error', '-i', movie, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
  expect(rgb.length).toBe(64 * 36 * 3 * 6)
  for (let frame = 0; frame < 6; frame += 1) {
    const sum = [0, 0, 0]
    for (let pixel = 0; pixel < 64 * 36; pixel += 1) for (let channel = 0; channel < 3; channel += 1) sum[channel] += rgb[(frame * 64 * 36 + pixel) * 3 + channel]
    const mean = sum.map(value => value / (64 * 36))
    expect(mean[0], `frame ${frame} red channel`).toBeGreaterThan(230)
    expect(mean[1], `frame ${frame} green channel`).toBeLessThan(25)
    expect(mean[2], `frame ${frame} blue channel`).toBeLessThan(25)
  }
  await film.kit.getByTestId('film-export').click()
  await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample 2.mp4')), { timeout: 30_000 }).toBe(true)
  const first = Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes))))
  expect(first).toEqual(bytes)
})

test('F20 exported sound is a 1 kHz stereo tone; muting its track produces silence', async ({ film, page }, testInfo) => {
  await film.open()
  await film.command('file.newProject', { name: 'Original bars and tone' })
  await film.command('file.newSequence', { name: 'Tone', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
  const { item } = await film.command('file.newBarsAndTone', { seconds: 0.5 })
  await film.command('timeline.place', { item, seconds: 0 })
  const ffmpeg = process.env.KITION_FILM_FFMPEG ?? 'ffmpeg'
  const ffprobe = process.env.KITION_FILM_FFPROBE ?? 'ffprobe'
  for (const muted of [false, true]) {
    if (muted) await film.command('timeline.setTrack', { track: 'A1', muted: true })
    await film.kit.getByTestId('film-export').click()
    const exported = muted ? 'films/Sample 2.mp4' : 'films/Sample.mp4'
    await expect.poll(() => page.evaluate(path => window.devHost.files.has(path), exported), { timeout: 30_000 }).toBe(true)
    const bytes = Buffer.from(await page.evaluate(path => Array.from(new Uint8Array(window.devHost.files.get(path).bytes)), exported))
    const movie = testInfo.outputPath(muted ? 'muted.mp4' : 'tone.mp4')
    writeFileSync(movie, bytes)
    const metadata = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', movie], { encoding: 'utf8', timeout: 30_000 }))
    const sound = metadata.streams.find(stream => stream.codec_type === 'audio')
    expect(sound).toBeTruthy()
    expect({ codec: sound.codec_name, rate: Number(sound.sample_rate), channels: sound.channels }).toEqual({ codec: 'aac', rate: 48000, channels: 2 })
    expect(Math.abs(Number(sound.duration) - 0.5)).toBeLessThan(0.03)
    const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', movie, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    expect(pcm.length).toBeGreaterThanOrEqual(48000 * 0.45 * 2 * 4)
    for (let channel = 0; channel < 2; channel += 1) {
      let squares = 0
      let finite = true
      let crossings = 0
      let previous = pcm.readFloatLE((4800 * 2 + channel) * 4)
      for (let sample = 4800; sample < 19200; sample += 1) {
        const value = pcm.readFloatLE((sample * 2 + channel) * 4)
        finite &&= Number.isFinite(value)
        squares += value * value
        if (previous <= 0 && value > 0) crossings += 1
        previous = value
      }
      expect(finite).toBe(true)
      const rms = Math.sqrt(squares / 14400)
      if (muted) expect(rms).toBeLessThan(0.001)
      else {
        expect(rms).toBeGreaterThan(0.05)
        expect(rms).toBeLessThan(0.09)
        expect(Math.abs(crossings / 0.3 - 1000)).toBeLessThan(15)
      }
    }
  }
})
