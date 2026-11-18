import { test, expect } from './fixtures.mjs'

test('F83 fixed magnification survives a render before the first viewport layout', async ({ film }) => {
  await film.open()
  await film.command('file.newProject', { name: 'Monitor layout order' })
  await film.command('file.newSequence', { width: 64, height: 36, fps: 24 })
  const { item } = await film.command('file.newColorMatte', { color: '#ff0000', seconds: 1 })
  await film.command('timeline.place', { item, seconds: 0 })
  await film.kit.getByTestId('film-program-zoom').click()
  await film.kit.getByTestId('film-program-zoom-200').click()
  const zoom = () => film.kit.getByTestId('film-program').evaluate(element => Number(element.dataset.view.split(' ')[0]) * devicePixelRatio)
  await expect.poll(zoom).toBe(2)
  await film.frame().evaluate(() => {
    const Original = window.ResizeObserver
    let held = null
    let views = 0
    let released = false
    const watcher = new MutationObserver(records => { views += records.length })
    watcher.observe(document.querySelector('[data-testid="film-program"]'), { attributes: true, attributeFilter: ['data-view'] })
    window.ResizeObserver = class extends Original {
      constructor(callback) {
        super((entries, observer) => {
          if (!released && entries.some(entry => entry.target.matches('[data-testid="film-program"] canvas'))) {
            held = () => callback(entries, observer)
          } else callback(entries, observer)
        })
      }
    }
    window.monitorLayoutGate = {
      state: () => ({ held: held != null, views }),
      release: () => {
        released = true
        window.ResizeObserver = Original
        watcher.disconnect()
        const callback = held
        held = null
        callback()
      },
    }
  })
  await film.command('sequence.settings', { width: 320, height: 180, scaleMotion: true })
  await expect.poll(() => film.frame().evaluate(() => monitorLayoutGate.state())).toMatchObject({ held: true })
  await expect.poll(() => film.frame().evaluate(() => monitorLayoutGate.state().views)).toBeGreaterThan(0)
  await film.frame().evaluate(() => monitorLayoutGate.release())
  await expect.poll(zoom).toBe(2)
  await film.command('playhead.set', { frame: 12 })
  await film.command('sequence.addEdit', { frame: 12 })
  expect(await zoom()).toBe(2)
})
