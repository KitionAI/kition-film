import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect, editState, TICKS } from './fixtures.mjs'

for (const num of [30000, 60000]) {
  test(`F41 ${num}/1001 fps export retains the exact frame count, cut boundary, and audio duration`, async ({ film, page }, testInfo) => {
    await film.open()
    await film.command('file.newProject', { name: 'Original fractional rate footage' })
    await film.command('sequence.new', { name: 'NTSC export', width: 64, height: 36, fps: num / 1001, video: 2, audio: 1 })
    const frames = num / 1000
    const duration = TICKS * 1001 / 1000
    const { item: tone } = await film.command('item.newBarsAndTone', { seconds: 2 })
    await film.command('timeline.place', { item: tone, track: 'V1', time: 0, duration })
    for (const [time, color] of [[0, '#ff0000'], [duration / 2, '#0000ff']]) {
      const { item } = await film.command('item.newColorMatte', { color, seconds: 2 })
      await film.command('timeline.place', { item, track: 'V2', time, duration: duration / 2 })
    }
    const before = await film.sequence()
    expect(before.settings.frame_rate).toEqual({ num, den: 1001 })
    expect(before.duration).toBe(duration)
    expect(before.durationFrames).toBe(frames)
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(editState(before))
    await film.kit.getByTestId('film-export').click()
    await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample.mp4')), { timeout: 30_000 }).toBe(true)
    const movie = testInfo.outputPath(`original-${num}-1001.mp4`)
    writeFileSync(movie, Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes)))))
    const info = JSON.parse(execFileSync(process.env.KITION_FILM_FFPROBE ?? 'ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', movie], { encoding: 'utf8', timeout: 30_000 }))
    const video = info.streams.find(stream => stream.codec_type === 'video')
    const audio = info.streams.find(stream => stream.codec_type === 'audio')
    expect(video.r_frame_rate).toBe(`${num}/1001`)
    expect(Number(video.nb_read_frames)).toBe(frames)
    expect(Number(video.duration)).toBeCloseTo(1.001, 6)
    expect(Number(audio.sample_rate)).toBe(48000)
    expect(audio.channels).toBe(2)
    expect(Math.abs(Number(audio.duration) - 1.001)).toBeLessThan(0.03)
    const rgb = execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', movie, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    expect(rgb.length).toBe(64 * 36 * 3 * frames)
    for (let frame = 0; frame < frames; frame += 1) {
      const sums = [0, 0, 0]
      for (let pixel = 0; pixel < 64 * 36; pixel += 1) for (let channel = 0; channel < 3; channel += 1) sums[channel] += rgb[(frame * 64 * 36 + pixel) * 3 + channel]
      for (let channel = 0; channel < 3; channel += 1) {
        const mean = sums[channel] / (64 * 36)
        if (channel === (frame < frames / 2 ? 0 : 2)) expect(mean, `frame ${frame} primary`).toBeGreaterThan(230)
        else expect(mean, `frame ${frame} channel ${channel}`).toBeLessThan(25)
      }
    }
  })
}
