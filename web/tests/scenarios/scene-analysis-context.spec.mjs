import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test, expect, clips, editState, lendMedia, holdWorkerCall, TICKS } from './fixtures.mjs'

test('F60 moving an analyzed clip discards obsolete scene cuts; a fresh analysis cuts at its new position and survives reopen', async ({ film }, testInfo) => {
  const movie = testInfo.outputPath('two-shots.mp4')
  execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24:d=0.5',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=24:d=0.5',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-bf', '0', '-movflags', '+faststart', '-y', movie,
  ], { timeout: 30_000 })
  await film.open()
  await lendMedia(film, 'media/two-shots.mp4', readFileSync(movie))
  await film.command('file.newProject', { name: 'Scene analysis edits' })
  await film.command('sequence.new', { name: 'Scenes', width: 64, height: 36, fps: 24, video: 1, audio: 0 })
  const { items: [item] } = await film.command('file.import', { paths: ['../media/two-shots.mp4'] })
  await film.command('timeline.place', { item, seconds: 0 })
  const clip = clips(await film.sequence())[0].clip
  await film.command('timeline.select', { clips: [clip] })
  const gate = await holdWorkerCall(film, 'jobsStep')
  const params = { generateMarkers: true, createSubclips: true }
  const { job } = await film.command('clip.sceneEditDetection', params)
  await gate.wait()
  await film.command('timeline.move', { moves: [{ clip, track: 'V1', time: TICKS / 4 }] })
  const before = editState(await film.sequence()), project = await film.command('project.items'), history = await film.history()
  await gate.release()
  await expect.poll(async () => (await film.command('job.list')).find(each => each.id === job)?.finished).toBe(true)
  expect(editState(await film.sequence())).toEqual(before)
  expect(await film.command('project.items')).toEqual(project)
  expect(await film.history()).toEqual(history)
  await film.command('timeline.select', { clips: [clip] })
  const fresh = await film.command('clip.sceneEditDetection', { ...params, wait: true })
  expect(fresh.clips[0].cuts).toEqual([3 * TICKS / 4])
  const after = editState(await film.sequence())
  expect(clips(after).map(clip => [clip.startFrame, clip.durationFrames, clip.sourceIn])).toEqual([[6, 12, 0], [18, 12, TICKS / 2]])
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(before)
  await film.redo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(after)
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(after)
})
