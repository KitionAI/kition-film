import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test, expect, lendMedia, TICKS } from './fixtures.mjs'

for (const subclip of [true, false]) {
test(`${subclip ? 'F69' : 'F70'} a 60 fps ${subclip ? 'subclip' : 'parent'} Source monitor shows each requested media frame after agent seeks`, async ({ film }, testInfo) => {
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]]
  const raw = Buffer.alloc(6 * 64 * 36 * 3)
  for (let frame = 0; frame < colors.length; frame += 1) for (let pixel = 0; pixel < 64 * 36; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) raw[(frame * 64 * 36 + pixel) * 3 + channel] = colors[frame][channel]
  }
  const movie = testInfo.outputPath('six-colors-60fps.mp4')
  execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '64x36', '-r', '60', '-i', 'pipe:0', '-frames:v', '6', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-bf', '0', '-y', movie], { input: raw, timeout: 30_000 })
  await film.open()
  await lendMedia(film, 'media/six-colors-60fps.mp4', readFileSync(movie))
  await film.command('file.newProject', { name: 'Subclip source frames' })
  await film.command('sequence.new', { name: '60 fps', width: 64, height: 36, fps: 60, video: 1, audio: 0 })
  const { items: [parent] } = await film.command('file.import', { paths: ['../media/six-colors-60fps.mp4'] })
  const item = subclip ? (await film.command('clip.makeSubclip', { item: parent, startFrame: 1, endFrame: 5 })).item : parent
  await film.command('source.open', { item })
  for (const frame of [1, 2, 3, 4, 2]) {
    await film.command('source.setPlayhead', { frame })
    expect((await film.command('source.inspect')).playhead).toBe(frame * TICKS / 60)
    await expect.poll(() => film.kit.locator('[data-testid="film-source"] canvas').first().evaluate((canvas, color) => {
      const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
      return color.every((value, channel) => Math.abs(pixel[channel] - value) < 15)
    }, colors[frame]), { message: `Source must show media frame ${frame}` }).toBe(true)
  }
  const rows = (await film.command('project.items')).rows
  expect(rows.find(row => row.item === item).frame).toBe(TICKS / 60)
  await film.saveReopen()
  await film.command('source.open', { item })
  expect((await film.command('source.inspect')).playhead).toBe(subclip ? TICKS / 60 : 0)
})
}
