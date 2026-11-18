import { test, expect } from './fixtures.mjs'

async function view(film, width, height) {
  return film.kit.getByTestId('film-program').evaluate((program, [width, height]) => {
    const [zoom, x, y] = (program.dataset.view ?? '').split(' ').map(Number)
    const canvas = program.querySelector('canvas')
    return {
      zoom, x, y,
      centerError: Math.max(Math.abs((width / 2 - x) * zoom - canvas.clientWidth / 2), Math.abs((height / 2 - y) * zoom - canvas.clientHeight / 2)),
      fittedFraction: zoom / Math.min(canvas.clientWidth / width, canvas.clientHeight / height),
      pixel: Array.from(canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data).slice(0, 3),
      dpr: window.devicePixelRatio,
    }
  }, [width, height])
}

for (const zoom of ['fit', '200']) {
  test(`F53 Program ${zoom} magnification recenters on a new frame size and preserves its view during edits`, async ({ film }) => {
    await film.open()
    await film.kit.getByTestId('film-program-zoom').click()
    await film.kit.getByTestId(`film-program-zoom-${zoom}`).click()
    await film.command('file.newProject', { name: 'Monitor dimensions' })
    await film.command('file.newSequence', { name: 'Tiny frame', width: 64, height: 36, fps: 24, video: 1, audio: 0 })
    const { item } = await film.command('file.newColorMatte', { color: '#ff0000', seconds: 1 })
    await film.command('timeline.place', { item, seconds: 0 })
    await expect.poll(async () => (await view(film, 64, 36)).centerError).toBeLessThan(2)
    const small = await view(film, 64, 36)
    expect(small.pixel[0]).toBeGreaterThan(230)
    expect(small.pixel[1] + small.pixel[2]).toBeLessThan(40)
    if (zoom === 'fit') expect(small.fittedFraction).toBeGreaterThan(0.5)
    else expect(Math.abs(small.zoom - 2 / small.dpr)).toBeLessThan(0.0001)
    await film.command('sequence.settings', { width: 320, height: 180, scaleMotion: true })
    await expect.poll(async () => (await view(film, 320, 180)).centerError).toBeLessThan(2)
    const resized = await view(film, 320, 180)
    if (zoom === 'fit') expect(resized.fittedFraction).toBeGreaterThan(0.5)
    else expect(Math.abs(resized.zoom - 2 / resized.dpr)).toBeLessThan(0.0001)
    await film.command('playhead.set', { frame: 12 })
    await film.command('sequence.addEdit', { frame: 12 })
    const edited = await view(film, 320, 180)
    expect([edited.zoom, edited.x, edited.y]).toEqual([resized.zoom, resized.x, resized.y])
    await film.saveReopen()
    await expect.poll(async () => (await view(film, 320, 180)).centerError).toBeLessThan(2)
  })
}
