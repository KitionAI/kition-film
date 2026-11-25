import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { test, expect, lendMedia, clips, editState, TICKS } from './fixtures.mjs'

// Original stereo PCM: left 440 Hz, right 880 Hz, so accidental channel mixing is measurable.
function stereoWav() {
  const rate = 48_000, frames = 2 * rate, bytes = Buffer.alloc(44 + frames * 4)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40)
  for (let sample = 0; sample < frames; sample += 1) {
    bytes.writeInt16LE(Math.round(32767 * 0.4 * Math.sin(2 * Math.PI * 440 * sample / rate)), 44 + sample * 4)
    bytes.writeInt16LE(Math.round(32767 * 0.2 * Math.sin(2 * Math.PI * 880 * sample / rate)), 46 + sample * 4)
  }
  return bytes
}

for (const split of [false, true]) {
  test(`F65 audio-only subclip ${split ? 'split channels' : 'right channel'} placement preserves routing through history, reopen and decoded export`, async ({ film, page }, testInfo) => {
    await film.open()
    await lendMedia(film, 'media/stereo-routing.wav', stereoWav())
    await film.command('file.newProject', { name: 'Audio subclip routing' })
    await film.command('sequence.new', { name: 'Right channel', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
    const { items: [parent] } = await film.command('file.import', { paths: ['../media/stereo-routing.wav'] })
    await film.command('project.select', { items: [parent] })
    await film.command('clip.audioChannels', { format: 'mono', clips: split ? [[1], [0]] : [[1]] })
    const { item } = await film.command('clip.makeSubclip', { item: parent, start: TICKS / 2, end: TICKS })
    const before = editState(await film.sequence())
    await film.command('timeline.place', { item, track: 'A1', seconds: 0 })
    const placed = editState(await film.sequence())
    expect(clips(placed)).toHaveLength(0)
    expect(clips(placed, 'audio')).toHaveLength(split ? 2 : 1)
    for (const clip of clips(placed, 'audio')) expect([clip.sourceIn, clip.duration]).toEqual([TICKS / 2, TICKS / 2])
    await film.undo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(before)
    await film.redo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(placed)
    if (split) await film.command('timeline.setTrack', { track: 'A2', muted: true })
    await film.saveReopen()
    await film.kit.getByTestId('film-export').click()
    await expect.poll(() => page.evaluate(() => window.devHost.files.has('films/Sample.mp4')), { timeout: 30_000 }).toBe(true)
    const output = testInfo.outputPath('routed-subclip.mp4')
    writeFileSync(output, Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes)))))
    const pcm = execFileSync(process.env.KITION_FILM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', output, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], { timeout: 30_000 })
    expect(pcm.length).toBeGreaterThanOrEqual(24_000 * 2 * 4)
    for (const channel of [0, 1]) {
      const amplitude = frequency => {
        let sin = 0, cos = 0
        for (let sample = 4800; sample < 19_200; sample += 1) {
          const value = pcm.readFloatLE((sample * 2 + channel) * 4), phase = 2 * Math.PI * frequency * sample / 48_000
          sin += value * Math.sin(phase); cos += value * Math.cos(phase)
        }
        return 2 * Math.hypot(sin, cos) / 14_400
      }
      expect(amplitude(880)).toBeGreaterThan(0.1)
      expect(amplitude(440)).toBeLessThan(0.002)
    }
  })
}
