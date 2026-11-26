// Scrubbing the program playhead by hand on a long-GOP video, with a real pointer:
// node tests/scrub.mjs [chromium|webkit]. The plan "Film usable by hand", phase 2.
//
// The fixture is made here with ffmpeg (KITION_FILM_FFMPEG, as the scenario tests do) and never
// committed: 30 s of a moving test pattern at 1280×720, 30 fps, H.264 with B-frames and one
// keyframe only, so a frame far from the start takes a long decode, as camera and screen
// recordings with keyframes seconds apart do (and more frames than the decoded-frame cache keeps). It is lent to the engine through the dev host's
// workspace, ranged reads included.
//
// Checked: during a held drag on the ruler the timecode follows the pointer at once and pictures
// land on the Program monitor (before, every render was dropped by the next seek's refresh and
// the picture froze until the pointer stopped); after the release the picture becomes exact, the
// same as the picture a plain seek to that frame renders; a click on the ruler moves the timecode
// at once and a picture follows. First, as soon as the editor shows (five page loads): Home and
// Right tapped twelve times without waiting between presses end twelve frames on (keys pressed
// before the editor had its document's state or the engine's key table were lost or ran out of
// turn); then ten rounds of the same once it has settled, all while the host polls `ai.inspect()`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import oracles from './scenarios/oracles.mjs'

const which = process.argv[2] ?? 'chromium'
// On CI with no ffmpeg on the PATH, the scenarios' pinned static build (fetched and checked once).
await oracles()
const ffmpeg = process.env.KITION_FILM_FFMPEG ?? 'ffmpeg'
const dir = mkdtempSync(join(tmpdir(), 'film-scrub-'))
const movie = join(dir, 'long-gop.mp4')
execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=30', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '32', '-bf', '2', '-g', '900', '-x264-params', 'keyint=900:min-keyint=900:scenecut=0', '-movflags', '+faststart', '-y', movie], { timeout: 120_000 })
const bytes = readFileSync(movie)

const server = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).pathname, server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' })
await server.listen()
const browser = await (which === 'webkit' ? webkit : chromium).launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await page.waitForTimeout(50)
  }
  return false
}
try {
  const address = `http://127.0.0.1:${server.httpServer.address().port}/dev.html?locale=zh-CN`
  const inspected = async () => (await page.evaluate(() => window.devHost.connection().ai.inspect())).details.sequence
  /**
   * Home and Right tapped `taps` times without waiting between presses, while the host polls
   * `ai.inspect()` as fast as it answers (as an agent's reads do): the engine's playhead ends
   * `taps` frames on. `fresh`: as soon as the editor shows, before it has read its preferences
   * and the engine's key table.
   */
  const tapRights = async (taps, label) => {
    await kit.locator('.kui-app').focus()
    let polling = true
    const poll = (async () => {
      while (polling) await inspected().catch(() => null)
    })()
    await page.keyboard.press('Home')
    for (let i = 0; i < taps; i += 1) await page.keyboard.press('ArrowRight')
    polling = false
    await poll
    const rate = (await inspected()).settings.frame_rate
    const stepTicks = (254_016_000_000 * rate.den) / rate.num
    const frameNow = async () => Math.round((await inspected()).playhead / stepTicks)
    assert.ok(await until(async () => (await frameNow()) === taps), `${label}: ${taps} taps of Right are ${taps} frames: frame ${await frameNow()}`)
  }
  const kit = page.frameLocator('#kit')
  let frame = null
  // regressions/issue-keys-before-state: Right tapped twelve times at once, as soon as the editor
  // shows, five times over (the page loaded again each time): twelve frames on each time. A key
  // pressed before the editor had its document's state (its preferences still loading) was
  // dropped, and one pressed between the render that read the engine's key table and the effect
  // that ran the held keys ran ahead of them; WebKit ended on frame 11 once.
  for (let load = 0; load < 5; load += 1) {
    if (load === 0) await page.goto(address)
    else await page.reload()
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 90_000 })
    frame = page.frames().find((candidate) => candidate.url().includes('index.html'))
    await frame.waitForFunction(() => typeof window.filmPreview?.run === 'function', null, { timeout: 30_000 })
    await kit.locator('.kui-app').waitFor({ timeout: 30_000 })
    await tapRights(12, `load ${load}`)
  }
  const person = (command, params = {}) => frame.evaluate(([c, p]) => window.filmPreview.run(c, p), [command, params])
  // Then, the editor settled, ten rounds of twelve taps while the host polls: none is lost.
  for (let round = 0; round < 10; round += 1) await tapRights(12, `round ${round}`)

  // Lend the fixture as the scenario tests' `lendMedia` does: the engine reads it in ranges.
  const path = 'clips/scrub-long-gop.mp4'
  const root = await page.evaluate(() => window.devHost.lendRoot)
  const url = new URL(path, root).href
  await page.context().route(url, async (route) => {
    const request = route.request()
    if (request.method() !== 'GET' && request.method() !== 'HEAD') return route.fallback()
    const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' }
    if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...headers, 'content-length': String(bytes.length) }, body: Buffer.alloc(0) })
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers().range ?? '')
    if (!match) return route.fulfill({ status: 200, headers, body: bytes })
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), bytes.length - 1)
    return route.fulfill({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}` }, body: bytes.subarray(start, end + 1) })
  })
  await page.evaluate(([p, b]) => window.devHost.files.set(p, { bytes: new Uint8Array(b).buffer, version: 1 }), [path, Array.from(bytes)])
  await person('sequence.new', { name: 'Long GOP', width: 1280, height: 720, fps: 30, video: 1, audio: 0 })
  const imported = await person('file.import', { paths: [`../${path}`] })
  assert.deepEqual(imported.errors, [], 'the fixture imports')
  await person('timeline.place', { item: imported.items[0], track: 'V1', time: 0 })

  // Pictures that land on the Program canvas: a newly rendered bitmap drawn on screen for the
  // first time (a render dropped before it lands is never drawn).
  await frame.evaluate(() => {
    const draw = CanvasRenderingContext2D.prototype.drawImage
    const seen = new WeakSet()
    window.__landed = 0
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...rest) {
      if (image instanceof HTMLCanvasElement && image.width >= 160 && image.height >= 90 && !seen.has(image)) {
        seen.add(image)
        window.__landed += 1
      }
      return draw.call(this, image, ...rest)
    }
  })
  const landed = () => frame.evaluate(() => window.__landed)
  const exact = () => frame.evaluate(() => window.filmPreview.programExact())
  const timecode = async () => (await kit.getByTestId('film-timecode').innerText()).trim()
  const picture = async () => createHash('sha1').update(await kit.getByTestId('film-program').screenshot({ animations: 'disabled' })).digest('hex')
  /** The picture once the engine says it is exact and it has stayed the same for a moment. */
  const restingPicture = async () => {
    assert.ok(await until(exact, 30_000), 'the picture becomes exact')
    let last = await picture()
    for (let tries = 0; tries < 40; tries += 1) {
      await page.waitForTimeout(250)
      const now = await picture()
      if (now === last && (await exact())) return now
      last = now
    }
    assert.fail('the picture settles')
  }

  const ruler = await kit.getByTestId('film-ruler').boundingBox()
  const y = ruler.y + ruler.height / 2
  // The new sequence is fitted in the timeline: 90 % down to 10 % of the ruler is a drag back
  // from about 27 s to 3 s, where every frame is decoded from the one keyframe at 0 (the frames
  // decoded on the way to 27 s are mostly no longer cached).
  const x0 = ruler.x + ruler.width * 0.9
  const x1 = ruler.x + ruler.width * 0.1
  await page.mouse.click(x0, y)
  await restingPicture()

  // A held drag: the timecode follows at once, and pictures land while the pointer moves.
  const before = await landed()
  const approximateBefore = (await person('perf.stats')).decode.approximateFrames
  const shown = new Set()
  await page.mouse.move(x0, y)
  await page.mouse.down()
  const start = Date.now()
  while (Date.now() - start < 3000) {
    await page.mouse.move(x0 + (x1 - x0) * ((Date.now() - start) / 3000), y)
    shown.add(await timecode())
    await page.waitForTimeout(30)
  }
  const during = (await landed()) - before
  await page.mouse.up()
  const approximate = (await person('perf.stats')).decode.approximateFrames - approximateBefore
  console.log(`scrub ${which}: ${shown.size} timecodes and ${during} pictures during a 3 s drag (${approximate} approximate decodes)`)
  assert.ok(shown.size >= 15, `the timecode follows the pointer: ${shown.size} values in 3 s`)
  assert.ok(during >= 6, `pictures land during the drag: ${during} in 3 s`)

  // After the release: the exact frame, the same as a plain seek to it renders.
  const stopped = await timecode()
  const scrubbed = await restingPicture()
  const [h, m, s, f] = stopped.split(/[:;]/).map(Number)
  const frameShown = ((h * 60 + m) * 60 + s) * 30 + f
  assert.ok(frameShown > 30, `the drag went past the first second: ${stopped}`)
  await person('playhead.set', { frame: 0 })
  assert.ok(await until(async () => (await picture()) !== scrubbed, 30_000), 'a seek away changes the picture')
  await person('playhead.set', { frame: frameShown })
  assert.equal(await timecode(), stopped, 'back at the frame the scrub stopped on')
  assert.equal(await restingPicture(), scrubbed, 'the scrub ends on the exact frame')

  // A click: the timecode moves at once, and a picture lands soon after.
  const clickBefore = await landed()
  const tc = await timecode()
  const clicked = Date.now()
  await page.mouse.click(ruler.x + ruler.width * 0.7, y)
  assert.ok(await until(async () => (await timecode()) !== tc, 2000), 'a click moves the timecode')
  const timecodeMs = Date.now() - clicked
  assert.ok(await until(async () => (await landed()) > clickBefore, 15_000), 'a picture lands after a click')
  console.log(`scrub ${which}: a click moved the timecode in ${timecodeMs} ms and landed a picture in ${Date.now() - clicked} ms`)
  await restingPicture()

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`scrub ${which}: ok`)
} finally {
  await browser.close()
  await server.close()
}
