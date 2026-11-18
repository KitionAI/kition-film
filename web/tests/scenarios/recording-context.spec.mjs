import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect, clips, editState, TICKS } from './fixtures.mjs'

async function newSequence(film, name = 'Mix', video = 1) {
  return film.command('file.newSequence', { name, width: 64, height: 36, fps: 24, video, audio: 1 })
}

async function newProject(film) {
  await film.command('file.newProject', { name: 'Recording context' })
  return newSequence(film)
}

for (const interruption of ['project', 'sequence']) {
  test(`F48 held master fader is cancelled by a ${interruption} replacement; a fresh fader edit survives undo/reopen`, async ({ film }) => {
    await film.open()
    await newProject(film)
    await film.command('mixer.touch', { strip: 'Mix', lane: 'volume', value: -12, time: 0 })
    if (interruption === 'project') await newProject(film)
    else await newSequence(film, 'Other sequence')
    const before = await film.command('mixer.inspect')
    const master = view => view.strips.find(strip => strip.ref === 'Mix')
    expect(master(before).at.volumeDb).toBe(0)
    const history = await film.history()
    await film.command('mixer.release', { strip: 'Mix', lane: 'volume', time: 0 })
    expect(await film.command('mixer.inspect')).toEqual(before)
    expect(await film.history()).toEqual(history)
    await film.command('mixer.touch', { strip: 'Mix', lane: 'volume', value: -6, time: 0 })
    await film.command('mixer.release', { strip: 'Mix', lane: 'volume', time: 0 })
    const after = await film.command('mixer.inspect')
    expect(master(after).volumeDb).toBe(-6)
    expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
    await film.undo()
    expect(master(await film.command('mixer.inspect')).volumeDb).toBe(0)
    await film.redo()
    expect(master(await film.command('mixer.inspect')).volumeDb).toBe(-6)
    await film.saveReopen()
    expect(master(await film.command('mixer.inspect')).volumeDb).toBe(-6)
  })
}

test('F49 stale audio automation cannot write reused project IDs; a fresh pass writes one undoable set of keyframes', async ({ film }) => {
  await film.open()
  await newProject(film)
  await film.command('mixer.setStrip', { strip: 'A1', mode: 'Latch' })
  await film.command('mixer.recordStart', { time: 0 })
  await film.command('mixer.touch', { strip: 'A1', lane: 'volume', value: -12, time: 0 })
  await newProject(film)
  const before = await film.command('mixer.inspect')
  expect(before.recording).toBe(false)
  expect(before.strips[0].lanes).toEqual({})
  const history = await film.history()
  await film.command('mixer.recordStop', { time: TICKS })
  expect(await film.command('mixer.inspect')).toEqual(before)
  expect(await film.history()).toEqual(history)
  await film.command('mixer.setStrip', { strip: 'A1', mode: 'Latch' })
  const freshHistory = await film.history()
  await film.command('mixer.recordStart', { time: 0 })
  await film.command('mixer.touch', { strip: 'A1', lane: 'volume', value: -6, time: 0 })
  await film.command('mixer.recordStop', { time: TICKS })
  const after = await film.command('mixer.inspect')
  expect(after.strips[0].lanes.volume).toEqual([[0, -6], [TICKS, -6]])
  expect((await film.history()).undo).toHaveLength(freshHistory.undo.length + 1)
  await film.undo()
  expect((await film.command('mixer.inspect')).strips[0].lanes).toEqual({})
  await film.redo()
  expect((await film.command('mixer.inspect')).strips[0].lanes).toEqual(after.strips[0].lanes)
  await film.saveReopen()
  expect((await film.command('mixer.inspect')).strips[0].lanes).toEqual(after.strips[0].lanes)
})

async function multicamProject(film) {
  await film.command('file.newProject', { name: 'Original multicam colors' })
  const { sequence: source } = await newSequence(film, 'Cameras', 2)
  for (const [track, color] of [['V1', '#ff0000'], ['V2', '#0000ff']]) {
    const { item } = await film.command('file.newColorMatte', { color, seconds: 2 })
    await film.command('timeline.place', { item, track, seconds: 0 })
  }
  await newSequence(film, 'Program')
  await film.command('timeline.place', { item: source, seconds: 0 })
  await film.command('timeline.select', { clips: clips(await film.sequence()).map(clip => clip.clip) })
  await film.command('clip.multicamEnable', { enabled: true })
}

test('F50 stale multicam recording cannot reapply old cuts to a replacement project with identical IDs', async ({ film }) => {
  await film.open()
  await multicamProject(film)
  await film.command('multicam.recordStart', { time: 0 })
  await film.command('multicam.cut', { camera: 2, time: TICKS })
  expect(clips(await film.sequence())).toHaveLength(2)
  await multicamProject(film)
  const before = await film.sequence()
  const history = await film.history()
  const stopped = await film.command('multicam.recordStop', { time: 2 * TICKS })
  expect(stopped.cuts).toBe(0)
  expect(editState(await film.sequence())).toEqual(editState(before))
  expect(await film.history()).toEqual(history)
  await film.command('multicam.recordStart', { time: 0 })
  await film.command('multicam.cut', { camera: 2, time: TICKS })
  await film.command('multicam.recordStop', { time: 2 * TICKS })
  const after = await film.sequence()
  expect(clips(after).map(clip => [clip.startFrame, clip.durationFrames])).toEqual([[0, 24], [24, 24]])
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
  await film.redo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(editState(after))
})

test('F51 multicam camera cuts and Flatten retain all exported red/blue frames after save/reopen', async ({ film, page }, testInfo) => {
  await film.open()
  await multicamProject(film)
  await film.command('multicam.recordStart', { time: 0 })
  await film.command('multicam.cut', { camera: 2, time: TICKS })
  await film.command('multicam.recordStop', { time: 2 * TICKS })
  await film.saveReopen()
  for (const flattened of [false, true]) {
    if (flattened) {
      const before = await film.sequence()
      await film.command('timeline.select', { clips: clips(before).map(clip => clip.clip) })
      await film.menu('clip.multicamFlatten')
      await expect.poll(async () => clips(await film.sequence()).every(clip => clip.item !== clips(before)[0].item)).toBe(true)
      const after = await film.sequence()
      expect(clips(after).map(clip => [clip.startFrame, clip.durationFrames, clip.sourceIn])).toEqual([[0, 24, 0], [24, 24, TICKS]])
      await film.undo()
      await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
      await film.redo()
      await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
      await film.saveReopen()
    }
    const path = flattened ? 'films/Sample 2.mp4' : 'films/Sample.mp4'
    await film.kit.getByTestId('film-export').click()
    await expect.poll(() => page.evaluate(path => window.devHost.files.has(path), path), { timeout: 30_000 }).toBe(true)
    const movie = testInfo.outputPath(flattened ? 'flattened.mp4' : 'multicam.mp4')
    writeFileSync(movie, Buffer.from(await page.evaluate(path => Array.from(new Uint8Array(window.devHost.files.get(path).bytes)), path)))
    const rgb = execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', movie, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    expect(rgb.length).toBe(64 * 36 * 3 * 48)
    const wrong = []
    for (let frame = 0; frame < 48; frame += 1) {
      const sums = [0, 0, 0]
      for (let pixel = 0; pixel < 64 * 36; pixel += 1) for (let channel = 0; channel < 3; channel += 1) sums[channel] += rgb[(frame * 64 * 36 + pixel) * 3 + channel]
      const means = sums.map(sum => sum / (64 * 36))
      if (means.some((value, channel) => channel === (frame < 24 ? 0 : 2) ? value < 230 : value > 25)) wrong.push({ frame, means })
    }
    expect(wrong, `flattened=${flattened}`).toEqual([])
  }
})
