import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test, expect, lendMedia, TICKS } from './fixtures.mjs'

async function showColor(film, item, color) {
  const canvas = film.kit.locator(`[data-testid="film-project-thumb-${item}"] canvas`)
  await expect(canvas).toHaveAttribute('data-drawn', '1')
  await expect.poll(() => canvas.evaluate((canvas, color) => {
    const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
    return color.every((value, channel) => Math.abs(pixel[channel] - value) < 15)
  }, color), { message: `Project thumbnail for ${item} must show ${color}` }).toBe(true)
}

async function coloredMedia(film, testInfo, colors, rate) {
  const raw = Buffer.alloc(colors.length * 64 * 36 * 3)
  for (let frame = 0; frame < colors.length; frame += 1) for (let pixel = 0; pixel < 64 * 36; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) raw[(frame * 64 * 36 + pixel) * 3 + channel] = colors[frame][channel]
  }
  const movie = testInfo.outputPath('thumbnail-colors.mp4')
  execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '64x36', '-r', String(rate), '-i', 'pipe:0', '-frames:v', String(colors.length), '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-bf', '0', '-y', movie], { input: raw, timeout: 30_000 })
  await film.open()
  await lendMedia(film, 'media/thumbnail-colors.mp4', readFileSync(movie))
  await film.command('file.newProject', { name: 'Project thumbnail ranges' })
  await film.command('file.newSequence', { name: 'Thumbnails', width: 64, height: 36, fps: rate, video: 1, audio: 0 })
  return (await film.command('file.import', { paths: ['../media/thumbnail-colors.mp4'] })).items[0]
}

for (const view of ['icon', 'freeform']) {
  test(`F71 ${view} subclip thumbnails and hover scrubbing stay inside a short nonzero source range`, async ({ film, page }, testInfo) => {
    const colors = Array.from({ length: 24 }, (_, frame) => frame >= 13 && frame < 17 ? [0, 0, 255] : [255, 0, 0])
    const parent = await coloredMedia(film, testInfo, colors, 24)
    const { item } = await film.command('clip.makeSubclip', { item: parent, startFrame: 13, endFrame: 17 })
    await film.command('project.view.set', { view, hoverScrub: true })
    await showColor(film, item, [0, 0, 255])
    const art = film.kit.getByTestId(`film-project-thumb-${item}`)
    const box = await art.boundingBox()
    for (const fraction of [0.01, 0.5, 0.99]) {
      await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2)
      const scrub = film.kit.getByTestId(`film-project-scrub-${item}`)
      await expect(scrub).toBeVisible()
      await showColor(film, item, [0, 0, 255])
      const expected = Math.min(3, Math.round(4 * fraction)) / 4 * 100
      await expect.poll(() => scrub.evaluate(node => parseFloat(node.style.left))).toBe(expected)
    }
    await page.mouse.move(5, 5)
    await film.saveReopen()
    await showColor(film, item, [0, 0, 255])
  })
}

for (const subclip of [false, true]) {
  test(`F72 an explicit ${subclip ? 'subclip' : 'parent'} poster preserves the exact 60 fps frame through history and reopen`, async ({ film }, testInfo) => {
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]]
    const parent = await coloredMedia(film, testInfo, colors, 60)
    const item = subclip ? (await film.command('clip.makeSubclip', { item: parent, startFrame: 1, endFrame: 5 })).item : parent
    await film.command('project.view.set', { view: 'icon' })
    for (const frame of [1, 2, 4]) {
      const result = await film.command('clip.setPosterFrame', { item, time: frame * TICKS / 60 })
      expect(result.posterFrame).toBe(frame * TICKS / 60)
      await showColor(film, item, colors[frame])
    }
    await film.undo()
    await expect.poll(async () => (await film.command('project.items')).rows.find(row => row.item === item).poster).toBe(2 * TICKS / 60)
    await showColor(film, item, colors[2])
    await film.redo()
    await expect.poll(async () => (await film.command('project.items')).rows.find(row => row.item === item).poster).toBe(4 * TICKS / 60)
    await showColor(film, item, colors[4])
    await film.saveReopen()
    await showColor(film, item, colors[4])
  })
}
