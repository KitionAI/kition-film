import { test, expect, clips, editState, lendMedia } from './fixtures.mjs'

// Original 120 BPM pulse-and-bass fixture; no recorded or third-party audio is used.
function wav(silent) {
  const rate = 8000, frames = rate * 16
  const bytes = Buffer.alloc(44 + frames * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40)
  if (!silent) for (let i = 0; i < frames; i += 1) {
    const time = i / rate, beat = time % 0.5
    const frequency = [220, 261.6256, 293.6648, 329.6276][Math.floor(time / 2) % 4]
    const value = 0.55 * Math.exp(-beat * 16) * Math.sin(2 * Math.PI * 90 * beat) + 0.15 * Math.exp(-beat * 5) * Math.sin(2 * Math.PI * frequency * time)
    bytes.writeInt16LE(Math.round(value * 32767), 44 + i * 2)
  }
  return bytes
}

for (const replacement of ['project', 'relink']) {
  test(`F58 Remix rejects silence after ${replacement} replaces previously analyzed music, then recovers on real music`, async ({ film, page }) => {
    await film.open()
    await lendMedia(film, 'media/rhythm.wav', wav(false))
    await lendMedia(film, 'media/silence.wav', wav(true))
    const setup = async path => {
      await film.command('file.newProject', { name: 'Music cache context' })
      await film.command('file.newSequence', { name: 'Music', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
      const { items: [item] } = await film.command('file.import', { paths: [path] })
      await film.command('timeline.place', { item, seconds: 0 })
      await film.command('timeline.select', { clips: clips(await film.sequence(), 'audio').map(clip => clip.clip) })
      return item
    }
    let item = await setup('../media/rhythm.wav')
    const report = await film.command('clip.remix', { seconds: 10 })
    expect(report.beats).toBeGreaterThan(25)
    expect(report.bpm).toBeGreaterThan(118)
    expect(report.bpm).toBeLessThan(122)
    expect(report.cuts.length).toBeGreaterThan(0)
    if (replacement === 'project') {
      const replacementItem = await setup('../media/silence.wav')
      expect(replacementItem).toBe(item)
      item = replacementItem
    } else {
      await film.command('clip.remix.revert')
      await film.command('media.relink', { item, path: '../media/silence.wav', force: true, relinkOthers: false })
    }
    const before = editState(await film.sequence()), history = await film.history()
    const error = await page.evaluate(async () => {
      try { await window.devHost.connection().ai.run([{ command: 'clip.remix', params: { seconds: 10 } }], false); return null }
      catch (error) { return String(error) }
    })
    expect(error).toContain('beat')
    expect(editState(await film.sequence())).toEqual(before)
    expect(await film.history()).toEqual(history)
    await film.command('media.relink', { item, path: '../media/rhythm.wav', force: true, relinkOthers: false })
    const restored = await film.command('clip.remix', { seconds: 10 })
    expect(restored.pieces).toEqual(report.pieces)
    const after = editState(await film.sequence())
    await film.undo()
    await expect.poll(async () => clips(await film.sequence(), 'audio')[0].durationFrames).toBe(384)
    await film.redo()
    await expect.poll(async () => editState(await film.sequence())).toEqual(after)
    await film.saveReopen()
    expect(editState(await film.sequence())).toEqual(after)
  })
}
