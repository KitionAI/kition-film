import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect, clips, editState } from './fixtures.mjs'

// The generated tone is original media. Compare actual decoded samples, independently of
// the engine's gain metadata: adding 6 dB multiplies RMS by 10 ** (6 / 20).
test('F36 Audio Gain preview cancels cleanly; committed +6 dB survives history/reopen and changes exported stereo samples', async ({ film, page }, testInfo) => {
  await film.open()
  await film.command('file.newProject', { name: 'Original gain comparison' })
  await film.command('sequence.new', { name: 'Gain', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
  const { item } = await film.command('item.newBarsAndTone', { seconds: 0.5 })
  await film.command('timeline.place', { item, seconds: 0 })
  const before = await film.sequence()
  const audio = clips(before, 'audio')[0].clip
  const exportRms = async (path, name) => {
    await film.kit.getByTestId('film-export').click()
    await expect.poll(() => page.evaluate(path => window.devHost.files.has(path), path), { timeout: 30_000 }).toBe(true)
    const movie = testInfo.outputPath(name)
    writeFileSync(movie, Buffer.from(await page.evaluate(path => Array.from(new Uint8Array(window.devHost.files.get(path).bytes)), path)))
    const pcm = execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', movie, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    expect(pcm.length).toBeGreaterThanOrEqual(48000 * 0.4 * 2 * 4)
    return [0, 1].map(channel => {
      let sum = 0
      let finite = true
      for (let sample = 4800; sample < 19200; sample += 1) {
        const value = pcm.readFloatLE((sample * 2 + channel) * 4)
        finite &&= Number.isFinite(value)
        sum += value * value
      }
      expect(finite).toBe(true)
      return Math.sqrt(sum / 14400)
    })
  }
  const baseline = await exportRms('films/Sample.mp4', 'gain-original.mp4')
  await film.command('timeline.select', { clips: [audio] })
  const history = await film.history()
  for (const outcome of ['cancel', 'ok']) {
    await film.menu('clip.audioGain')
    await film.kit.getByTestId('film-dialog-audioGain-set').check()
    await film.kit.getByTestId('film-dialog-audioGain-set-value').locator('input').fill('6')
    // Keep the number focused: the dialog must commit the final number on OK only.
    await film.kit.getByTestId(`film-dialog-${outcome}`).click()
    await expect(film.kit.getByTestId('film-dialog')).toHaveCount(0)
    if (outcome === 'cancel') {
      expect(editState(await film.sequence())).toEqual(editState(before))
      expect(await film.history()).toEqual(history)
    }
  }
  const after = await film.sequence()
  expect(clips(after, 'audio')[0].gainDb).toBe(6)
  expect(clips(after)).toEqual(clips(before))
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
  await film.undo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
  await film.redo()
  await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
  await film.saveReopen()
  expect(editState(await film.sequence())).toEqual(editState(after))
  const gained = await exportRms('films/Sample 2.mp4', 'gain-plus-six.mp4')
  for (let channel = 0; channel < 2; channel += 1) {
    expect(baseline[channel]).toBeGreaterThan(0.05)
    expect(Math.abs(gained[channel] / baseline[channel] - 10 ** (6 / 20))).toBeLessThan(0.03)
  }
})
