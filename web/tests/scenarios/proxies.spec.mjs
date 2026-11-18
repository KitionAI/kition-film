import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect, editState, lendMedia } from './fixtures.mjs'

test('F52 attached proxy changes the monitor, full-resolution export stays original, and invalid proxy attachment is atomic', async ({ film, page }, testInfo) => {
  const ffmpeg = process.env.KITION_FILM_FFMPEG ?? 'ffmpeg'
  await film.open()
  const reads = []
  for (const [name, color, size, duration] of [['original', 'red', '64x36', 0.5], ['proxy', 'blue', '32x18', 0.5], ['short', 'green', '32x18', 0.125]]) {
    const path = testInfo.outputPath(`${name}.mp4`)
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=24:d=${duration}`, '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-bf', '0', '-movflags', '+faststart', '-y', path], { timeout: 30_000 })
    reads.push(await lendMedia(film, `clips/${name}.mp4`, readFileSync(path)))
  }
  await film.command('file.newProject', { name: 'Proxy review' })
  await film.command('file.newSequence', { name: 'Proxy preview', width: 64, height: 36, fps: 24, video: 1, audio: 0 })
  const imported = await film.command('file.import', { paths: ['../clips/original.mp4'] })
  expect(imported.errors).toEqual([])
  const item = imported.items[0]
  await film.command('timeline.place', { item, seconds: 0 })
  await film.command('playhead.set', { frame: 3 })
  const before = editState(await film.sequence())
  const center = () => film.kit.locator('[data-testid="film-program"] canvas').first().evaluate(canvas => {
    const pixel = canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data
    return Array.from(pixel).slice(0, 3)
  })
  const dominant = async () => { const rgb = await center(); return rgb.findIndex((value, primary) => value > 200 && rgb.every((other, channel) => channel === primary || other < 40)) }
  await expect.poll(dominant).toBe(0)
  await film.command('media.attachProxies', { item, path: '../clips/proxy.mp4' })
  expect((await film.command('media.status', { item }))[0].proxy).toEqual({ path: '../clips/proxy.mp4', online: true })
  await film.menu('media.toggleProxies')
  await expect.poll(dominant).toBe(2)
  expect(editState(await film.sequence())).toEqual(before)
  const history = await film.history()
  const failure = await page.evaluate(async item => {
    try { await window.devHost.connection().ai.run([{ command: 'media.attachProxies', params: { item, path: '../clips/short.mp4' } }], false); return null }
    catch (error) { return String(error) }
  }, item)
  expect(failure).toContain('long')
  expect((await film.command('media.status', { item }))[0].proxy.path).toBe('../clips/proxy.mp4')
  expect(await film.history()).toEqual(history)
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(before)
  expect((await film.command('media.status', { item }))[0].proxy.online).toBe(true)
  await film.command('media.toggleProxies', { enabled: true })
  await film.command('playhead.set', { frame: 3 })
  await expect.poll(dominant).toBe(2)
  await film.kit.getByTestId('film-export').click()
  await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample.mp4')), { timeout: 30_000 }).toBe(true)
  const movie = testInfo.outputPath('full-resolution.mp4')
  writeFileSync(movie, Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes)))))
  const rgb = execFileSync(ffmpeg, ['-v', 'error', '-i', movie, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
  expect(rgb.length).toBe(64 * 36 * 3 * 12)
  const unexpected = []
  for (let offset = 0; offset < rgb.length; offset += 3) if (rgb[offset] < 230 || rgb[offset + 1] > 25 || rgb[offset + 2] > 25) { unexpected.push(offset / 3); if (unexpected.length > 10) break }
  expect(unexpected, 'all exported pixels come from the red full-resolution source').toEqual([])
  for (const served of reads) expect(served.some(read => read.method === 'GET' && read.range != null)).toBe(true)
  await film.command('media.toggleProxies', { enabled: false })
  await expect.poll(dominant).toBe(0)
})
