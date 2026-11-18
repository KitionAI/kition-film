import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect, lendMedia, clips, editState, TICKS } from './fixtures.mjs'

test('F64 converting a subclip to a master preserves its source range after deleting the former parent, history and reopen', async ({ film, page }, testInfo) => {
  const source = testInfo.outputPath('source.mp4')
  const ffmpeg = process.env.KITION_FILM_FFMPEG ?? 'ffmpeg'
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24:d=0.5', '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=24:d=0.5',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-bf', '0', '-y', source], { timeout: 30_000 })
  await film.open()
  await lendMedia(film, 'media/subclip-master.mp4', readFileSync(source))
  await film.command('file.newProject', { name: 'Independent master' })
  await film.command('file.newSequence', { name: 'Excerpt', width: 64, height: 36, fps: 24, video: 1, audio: 0 })
  const { items: [parent] } = await film.command('file.import', { paths: ['../media/subclip-master.mp4'] })
  const { item } = await film.command('clip.makeSubclip', { item: parent, startFrame: 6, endFrame: 18 })
  await film.command('timeline.place', { item, seconds: 0 })
  const timeline = editState(await film.sequence()), history = await film.history()
  expect(clips(timeline).map(clip => [clip.item, clip.sourceIn, clip.duration])).toEqual([[item, TICKS / 4, TICKS / 2]])
  await film.command('clip.editSubclip', { item, convertToMaster: true })
  await film.command('project.delete', { items: [parent] })
  expect(editState(await film.sequence())).toEqual(timeline)
  expect((await film.history()).undo).toHaveLength(history.undo.length + 2)
  await film.undo()
  await expect.poll(async () => (await film.history()).undo.length).toBe(history.undo.length + 1)
  await film.undo()
  await expect.poll(async () => (await film.history()).undo.length).toBe(history.undo.length)
  await film.command('source.open', { item })
  expect((await film.command('source.inspect')).media).toBe(parent)
  await film.redo()
  await expect.poll(async () => (await film.command('source.inspect')).media).toBe(item)
  await film.redo()
  await expect.poll(async () => (await film.history()).undo.length).toBe(history.undo.length + 2)
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(timeline)
  await film.kit.getByTestId('film-export').click()
  await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample.mp4')), { timeout: 30_000 }).toBe(true)
  const output = testInfo.outputPath('excerpt.mp4')
  writeFileSync(output, Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes)))))
  const rgb = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30_000 })
  expect(rgb.length).toBe(12 * 64 * 36 * 3)
  for (let frame = 0; frame < 12; frame += 1) {
    const pixel = [...rgb.subarray((frame * 64 * 36 + 18 * 64 + 32) * 3, (frame * 64 * 36 + 18 * 64 + 32) * 3 + 3)]
    expect(pixel[frame < 6 ? 0 : 2]).toBeGreaterThan(240)
    expect(pixel[frame < 6 ? 2 : 0]).toBeLessThan(15)
    expect(pixel[1]).toBeLessThan(15)
  }
})
