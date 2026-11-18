import { test, expect, TICKS } from './fixtures.mjs'

async function setup(film) {
  await film.open()
  await film.command('file.newProject', { name: 'Caption scenes' })
  await film.command('file.newSequence', { name: 'Captions', width: 320, height: 180, fps: 24, video: 1, audio: 0 })
}

test('F55 invalid first caption leaves no empty track; the first valid cue and track are one saved undo step', async ({ film, page }) => {
  await setup(film)
  const history = await film.history()
  const result = await page.evaluate(async () => {
    try { await window.devHost.connection().ai.run([{ command: 'captions.add', params: { track: 'C9', text: 'Invalid' } }], false); return null }
    catch (error) { return String(error) }
  })
  expect(result).toContain('no such caption track')
  expect((await film.command('captions.list')).tracks).toEqual([])
  expect(await film.history()).toEqual(history)
  await film.menu('captions.add')
  await expect.poll(async () => (await film.command('captions.list')).tracks.length).toBe(1)
  const tracks = (await film.command('captions.list')).tracks
  expect(tracks[0].captions).toHaveLength(1)
  expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
  await film.undo()
  await expect.poll(async () => (await film.command('captions.list')).tracks).toEqual([])
  await film.redo()
  await expect.poll(async () => (await film.command('captions.list')).tracks).toEqual(tracks)
  await film.saveReopen()
  expect((await film.command('captions.list')).tracks).toEqual(tracks)
})

test('F56 caption pixels appear only in their cue interval, respect track visibility, and survive reopen', async ({ film }) => {
  await setup(film)
  const { item } = await film.command('file.newColorMatte', { color: '#000000', seconds: 1 })
  await film.command('timeline.place', { item, seconds: 0 })
  await film.command('captions.add', { time: TICKS / 4, durationSeconds: 0.25, text: 'Visible cue' })
  // Caption sizes are specified relative to a 1080-line frame: 144 gives 24 px at 180 lines.
  await film.command('captions.setStyle', { track: 'C1', size: 144, outline: 0, color: '#ffffff', background: false })
  await film.saveReopen()
  const bright = () => film.kit.getByTestId('film-program').evaluate(program => {
    const [zoom, x, y] = program.dataset.view.split(' ').map(Number)
    const canvas = program.querySelector('canvas')
    const ratio = canvas.width / canvas.clientWidth
    const left = Math.max(0, Math.ceil(-x * zoom * ratio))
    const top = Math.max(0, Math.ceil(-y * zoom * ratio))
    const width = Math.min(canvas.width - left, Math.floor(320 * zoom * ratio) - 2)
    const height = Math.min(canvas.height - top, Math.floor(180 * zoom * ratio) - 2)
    const { data } = canvas.getContext('2d').getImageData(left + 1, top + 1, width, height)
    let count = 0
    for (let pixel = 0; pixel < data.length; pixel += 4) if (data[pixel] > 230 && data[pixel + 1] > 230 && data[pixel + 2] > 230) count += 1
    return count
  })
  await film.command('playhead.set', { frame: 8 })
  await expect.poll(bright).toBeGreaterThan(20)
  for (const frame of [0, 12]) {
    await film.command('playhead.set', { frame })
    await expect.poll(bright).toBe(0)
  }
  await film.command('playhead.set', { frame: 8 })
  await expect.poll(bright).toBeGreaterThan(20)
  await film.command('captions.setTrack', { track: 'C1', enabled: false })
  await expect.poll(bright).toBe(0)
  await film.undo()
  await expect.poll(bright).toBeGreaterThan(20)
})
