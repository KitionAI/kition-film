import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect, clips, editState, TICKS } from './fixtures.mjs'

test('F25 Nest preserves two colored shots through history, reopen, and actual exported frames', async ({ film, page }, testInfo) => {
  await film.open()
  await film.command('file.newProject', { name: 'Nested colors' })
  const { sequence: outer } = await film.command('sequence.new', { name: 'Outer', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
  for (const [seconds, color] of [[0, '#ff0000'], [0.25, '#0000ff']]) {
    const { item } = await film.command('item.newColorMatte', { color, seconds: 0.25 })
    await film.command('timeline.place', { item, seconds, track: 'V1' })
  }
  const before = await film.sequence()
  await film.command('timeline.select', { clips: clips(before).map(clip => clip.clip) })
  const history = await film.history()
  await film.menu('clip.nest')
  await film.kit.getByTestId('film-dialog-nest-name').fill('双色 · Nested')
  await film.kit.getByTestId('film-dialog-ok').click()
  await expect.poll(async () => clips(await film.sequence()).length).toBe(1)
  const after = await film.sequence()
  const nested = clips(after)[0].item
  expect(clips(after)[0].durationFrames).toBe(12)
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
  await film.redo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
  await film.command('sequence.open', { item: nested })
  const inside = await film.sequence()
  expect(inside.name).toBe('双色 · Nested')
  expect(clips(inside).map(clip => [clip.startFrame, clip.durationFrames, clip.sourceIn])).toEqual([[0, 6, 0], [6, 6, 0]])
  await film.command('sequence.open', { item: outer })
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(editState(after))
  await film.kit.getByTestId('film-export').click()
  await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample.mp4')), { timeout: 30_000 }).toBe(true)
  const movie = testInfo.outputPath('nested-colors.mp4')
  writeFileSync(movie, Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes)))))
  const rgb = execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', movie, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
  expect(rgb.length).toBe(64 * 36 * 3 * 12)
  for (let frame = 0; frame < 12; frame += 1) {
    const sums = [0, 0, 0]
    for (let pixel = 0; pixel < 64 * 36; pixel += 1) for (let channel = 0; channel < 3; channel += 1) sums[channel] += rgb[(frame * 64 * 36 + pixel) * 3 + channel]
    const means = sums.map(sum => sum / (64 * 36))
    for (let channel = 0; channel < 3; channel += 1) {
      if (channel === (frame < 6 ? 0 : 2)) expect(means[channel], `frame ${frame} primary color`).toBeGreaterThan(230)
      else expect(means[channel], `frame ${frame} other channel ${channel}`).toBeLessThan(25)
    }
  }
})

for (const operation of ['lift', 'extract']) {
  test(`F26 ${operation} removes inclusive In/Out from linked media and preserves source ranges through history/reopen`, async ({ film }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Range editing' })
    await film.command('sequence.new', { name: 'Range', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
    const { item } = await film.command('item.newBarsAndTone', { seconds: 4 })
    await film.command('timeline.place', { item, seconds: 0 })
    await film.command('marker.markIn', { time: TICKS, target: 'program' })
    await film.command('marker.markOut', { time: 2 * TICKS - TICKS / 24, target: 'program' })
    const before = await film.sequence()
    const history = await film.history()
    await film.menu(`sequence.${operation}`)
    await expect.poll(async () => clips(await film.sequence()).length).toBe(2)
    const after = await film.sequence()
    expect(after.duration).toBe((operation === 'lift' ? 4 : 3) * TICKS)
    expect([after.in, after.out]).toEqual(operation === 'lift' ? [before.in, before.out] : [null, null])
    for (const kind of ['video', 'audio']) {
      expect(clips(after, kind).map(clip => [clip.startFrame, clip.durationFrames, clip.sourceIn, clip.sourceOut])).toEqual([
        [0, 24, 0, TICKS], [operation === 'lift' ? 48 : 24, 48, 2 * TICKS, 4 * TICKS],
      ])
    }
    expect(clips(after).map(clip => clip.link)).toEqual(clips(after, 'audio').map(clip => clip.link))
    expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
    await film.undo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
    expect([(await film.sequence()).in, (await film.sequence()).out]).toEqual([before.in, before.out])
    await film.redo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(editState(after))
  })
}
