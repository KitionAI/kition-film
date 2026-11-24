// Working on the Program picture by hand, with a real pointer and keyboard: node tests/picture.mjs [chromium|webkit].
// The plan "Film usable by hand", phase 5: with the Selection tool a click on a video clip's
// picture selects the top-most clip there (in the Timeline too); the selected clip shows its Motion
// box (eight handles, the anchor point); dragging inside it moves the clip, a handle scales it, just
// outside it rotates it, each live in the picture and one undo step, Escape putting it back; at
// Fit, at a magnified and scrolled view, and at 1/2 resolution. A locked track's clip refuses in
// Chinese. Cmd+Arrow nudges. Text: a Chinese title draws real glyphs; the Type tool makes one; the
// Properties panel styles it (font, size, colour, alignment, bold, italic); the Selection tool moves
// and scales it and a double-click edits it again.
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { CATALOGS } from '../src/strings.ts'
import { readCatalog } from '../parity/i18n.mjs'

const ZH = readCatalog(new URL('../src/i18n/upstream/zh-hans.tsv', import.meta.url)).table
const zh = (english) => ZH.get(english) ?? english
const which = process.argv[2] ?? 'chromium'
const shots = process.env.PICTURE_SHOTS ?? null
const server = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).pathname, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const browser = await (which === 'webkit' ? webkit : chromium).launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const until = async (check, tries = 60) => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (await check()) return true
    await page.waitForTimeout(100)
  }
  return false
}
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/dev.html?locale=zh-CN`)
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 90_000 })
  const kit = page.frameLocator('#kit')
  await kit.getByTestId('film-clip-10').waitFor({ timeout: 60_000 })
  const frame = page.frames().find((candidate) => candidate.url().includes('index.html'))
  const person = (command, params = {}) => frame.evaluate(([c, p]) => window.filmPreview.run(c, p), [command, params])
  const sequence = async () => (await page.evaluate(() => window.devHost.connection().ai.inspect())).details.sequence
  const clipOf = async (id) => (await sequence()).video.flatMap((track) => track.items).find((item) => item.clip === id) ?? null
  const motion = async (id) => {
    const params = (await clipOf(id))?.effects.find((effect) => effect.effect === 'motion')?.params ?? {}
    return { position: params.position?.value, anchor: params.anchor?.value, scale: params.scale?.value, rotation: params.rotation?.value, keyframes: params.position?.keyframes?.length ?? 0 }
  }
  const selection = async () => (await sequence()).selection
  const undoSteps = async () => (await frame.evaluate(() => window.filmPreview.history()))?.undo?.length ?? 0
  const message = async () => ((await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => '')) ?? '').trim()
  const undo = async () => {
    await kit.locator('.kui-app').focus()
    await page.keyboard.press(`${mod}+z`)
  }
  const iframe = await page.locator('#kit').boundingBox()
  /** The overlay's Motion box, in page points: its corners, handles, and anchor point (null when none is drawn). */
  const clipBox = () =>
    frame.evaluate(() => {
      const svg = document.querySelector('[data-testid="film-program-graphics"]')
      const box = svg?.querySelector('[data-kit-ui-id="control:program.transform.box"]')
      if (!svg || !box) return null
      const at = svg.getBoundingClientRect()
      const quad = box
        .getAttribute('points')
        .split(' ')
        .map((pair) => pair.split(',').map(Number))
        .map(([x, y]) => ({ x: at.x + x, y: at.y + y }))
      const handles = [...svg.querySelectorAll('[data-kit-ui-id="control:program.transform.handle"]')].map((rect) => ({ x: at.x + Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2, y: at.y + Number(rect.getAttribute('y')) + Number(rect.getAttribute('height')) / 2 }))
      const circle = svg.querySelector('[data-kit-ui-id="control:program.transform.anchor"] circle')
      const anchor = circle ? { x: at.x + Number(circle.getAttribute('cx')), y: at.y + Number(circle.getAttribute('cy')) } : null
      return { clip: Number(box.getAttribute('data-clip')), quad, handles, anchor, drag: svg.getAttribute('data-clip-drag') }
    }).then((box) => (box ? { ...box, quad: box.quad.map((p) => ({ x: p.x + iframe.x, y: p.y + iframe.y })), handles: box.handles.map((p) => ({ x: p.x + iframe.x, y: p.y + iframe.y })), anchor: box.anchor && { x: box.anchor.x + iframe.x, y: box.anchor.y + iframe.y } } : null))
  /** The box once it has stayed put for a moment (after a layout change or a refresh). */
  const settledBox = async () => {
    let last = JSON.stringify(await clipBox())
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.waitForTimeout(150)
      const now = JSON.stringify(await clipBox())
      if (now === last && now !== 'null') return JSON.parse(now)
      last = now
    }
    return JSON.parse(last)
  }
  const centreOf = (quad) => ({ x: (quad[0].x + quad[2].x) / 2, y: (quad[0].y + quad[2].y) / 2 })
  /** A real pointer drag from `from` to `to`, paced, with `hold` run before the release. */
  const drag = async (from, to, hold = async () => undefined, steps = 15) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= steps; i += 1) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
      await page.waitForTimeout(30)
    }
    await page.waitForTimeout(60)
    await hold()
    await page.mouse.up()
  }
  /** The Program picture's checksum. */
  const picture = () =>
    frame.evaluate(() => {
      const canvas = document.querySelector('[data-testid="film-program"] canvas')
      if (!canvas || !canvas.width) return 0
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
      let sum = 0
      for (let at = 0; at < data.length; at += 16) sum = (sum * 31 + data[at] + data[at + 1] * 3 + data[at + 2] * 7) % 1000000007
      return sum
    })
  const shot = async (name) => {
    if (shots) await page.screenshot({ path: `${shots}/${name}.png` })
  }

  // The sample's clip is small (160×90 in a 1280×720 sequence): scaled up first, as the person would.
  await person('effects.setParam', { clip: 10, effect: 'motion', param: 'scale', value: 300 })
  assert.ok(await until(async () => (await motion(10)).scale === 300), 'set up: the clip at 300%')
  // Nothing selected: no box.
  await kit.getByTestId('film-timeline').click({ position: { x: 5, y: 5 } }).catch(() => undefined)
  await person('timeline.select', { clips: [] })
  assert.ok(await until(async () => (await selection()).length === 0), 'set up: nothing selected')
  const programBox = await kit.getByTestId('film-program').boundingBox()
  const middle = { x: programBox.x + programBox.width / 2, y: programBox.y + programBox.height / 2 - 20 }
  assert.equal(await clipBox(), null, 'no Motion box while nothing is selected')

  // A click on the clip's picture selects it (with its linked audio), and its box shows.
  await page.mouse.click(middle.x, middle.y)
  assert.ok(await until(async () => (await selection()).includes(10)), `a click on the picture selects the clip under it: ${await selection()}`)
  assert.ok(await until(async () => (await clipBox())?.clip === 10), 'the selected clip shows its Motion box')
  let box = await clipBox()
  assert.equal(box.handles.length, 8, 'eight handles')
  assert.ok(box.anchor, 'and its anchor point')
  console.log(JSON.stringify(box))

  // A drag inside the box moves the clip, live, one undo step.
  const before = await motion(10)
  const steps = await undoSteps()
  const shown = await picture()
  let liveMoved = false
  let livePicture = false
  // (Off the anchor point, which sits in the middle and is grabbed first.)
  const inBox = (b) => ({ x: b.quad[0].x + (b.quad[1].x - b.quad[0].x) * 0.3, y: b.quad[0].y + (b.quad[3].y - b.quad[0].y) * 0.3 })
  await drag(inBox(box), { x: inBox(box).x + 80, y: inBox(box).y + 40 }, async () => {
    liveMoved = await until(async () => (await motion(10)).position[0] > before.position[0] + 20, 20)
    livePicture = (await picture()) !== shown
  })
  assert.ok(liveMoved, 'the position changes while the pointer still holds the clip')
  assert.ok(livePicture, 'the picture changes during the drag')
  const after = await motion(10)
  assert.ok(after.position[0] > before.position[0] + 100 && after.position[1] > before.position[1] + 50, `the clip moved right and down: ${JSON.stringify(after.position)}`)
  assert.ok(await until(async () => (await undoSteps()) === steps + 1), `one undo step: ${await undoSteps()} after ${steps}`)
  // The box follows: drawn where the clip now is.
  const moved = await clipBox()
  assert.ok(near(moved.quad[0].x - box.quad[0].x, 80, 3) && near(moved.quad[0].y - box.quad[0].y, 40, 3), `the box moved with the pointer: ${JSON.stringify(moved.quad[0])} from ${JSON.stringify(box.quad[0])}`)
  await undo()
  assert.ok(await until(async () => JSON.stringify((await motion(10)).position) === JSON.stringify(before.position)), 'one undo puts it back')
  assert.ok(await until(async () => near((await clipBox()).quad[0].x, box.quad[0].x, 1)), 'and the box with it')

  // Effect Controls shows the value changing during a drag.
  await kit.getByTestId('film-workspace-tab-effectControls').click()
  const ecX = kit.getByTestId('film-ec-motion-position-value-x-value')
  await ecX.waitFor({ timeout: 10_000 })
  const ecText = async () => ((await ecX.count()) ? await ecX.textContent() : null)
  const ecBefore = await ecText()
  let ecLive = null
  box = await settledBox()
  await drag(inBox(box), { x: inBox(box).x - 60, y: inBox(box).y }, async () => {
    await until(async () => (await ecText()) !== ecBefore, 20)
    ecLive = await ecText()
  })
  assert.ok(ecBefore != null && ecLive !== ecBefore, `Effect Controls' Position X follows the drag: ${ecBefore} → ${ecLive}`)
  await undo()
  assert.ok(await until(async () => JSON.stringify((await motion(10)).position) === JSON.stringify(before.position)), 'undone')

  // A corner handle scales about the anchor point (Uniform Scale on: both ways), live, one undo step.
  box = await settledBox()
  let steps2 = await undoSteps()
  let liveScale = false
  await drag(box.handles[2], { x: box.handles[2].x + 60, y: box.handles[2].y + 34 }, async () => {
    liveScale = await until(async () => (await motion(10)).scale > 330, 20)
  })
  assert.ok(liveScale, 'the scale grows while the handle is held')
  assert.ok(await until(async () => (await undoSteps()) === steps2 + 1), `one undo step for the scale: ${await undoSteps()} after ${steps2}`)
  const scaled = await clipBox()
  assert.ok(scaled.quad[1].x - scaled.quad[0].x > box.quad[1].x - box.quad[0].x + 50, 'the box is wider')
  assert.ok(near(centreOf(scaled.quad).x, centreOf(box.quad).x, 2), 'about the anchor point: its middle stays')
  // A side handle scales too (Uniform Scale on).
  steps2 = await undoSteps()
  const larger = (await motion(10)).scale
  await drag(scaled.handles[5], { x: scaled.handles[5].x - 40, y: scaled.handles[5].y })
  assert.ok(await until(async () => (await undoSteps()) === steps2 + 1 && (await motion(10)).scale < larger - 20), `the right side handle scales it down, one step (${larger} → ${(await motion(10)).scale})`)
  await undo()
  await undo()
  assert.ok(await until(async () => (await motion(10)).scale === 300), `two undos put the scale back: ${(await motion(10)).scale}`)

  // Just outside a corner rotates about the anchor point, one undo step.
  box = await settledBox()
  steps2 = await undoSteps()
  const outside = { x: box.quad[1].x + 12, y: box.quad[1].y - 12 }
  let liveTurn = false
  await drag(outside, { x: box.quad[2].x + 30, y: box.quad[2].y + 10 }, async () => {
    liveTurn = await until(async () => (await motion(10)).rotation > 10, 20)
  })
  assert.ok(liveTurn, `the rotation turns clockwise while the pointer goes round: ${(await motion(10)).rotation}`)
  assert.ok(await until(async () => (await undoSteps()) === steps2 + 1), 'one undo step for the rotation')
  const turned = await clipBox()
  assert.ok(Math.abs(turned.quad[0].y - turned.quad[1].y) > 10, 'the box is drawn turned')
  await shot('picture-rotated')
  await undo()
  assert.ok(await until(async () => (await motion(10)).rotation === 0), 'undo turns it back')

  // Escape during a drag puts the clip back, with no undo step left.
  box = await settledBox()
  steps2 = await undoSteps()
  let heldAway = false
  await drag(inBox(box), { x: inBox(box).x + 70, y: inBox(box).y + 30 }, async () => {
    heldAway = await until(async () => (await motion(10)).position[0] !== before.position[0], 20)
    await page.keyboard.press('Escape')
  })
  assert.ok(heldAway, 'the drag had moved it')
  assert.ok(await until(async () => JSON.stringify((await motion(10)).position) === JSON.stringify(before.position)), `Escape puts it back: ${JSON.stringify((await motion(10)).position)}`)
  assert.ok(await until(async () => (await undoSteps()) === steps2), `and leaves no step: ${await undoSteps()} after ${steps2}`)

  // The anchor point moves without moving the picture.
  box = await settledBox()
  await drag(box.anchor, { x: box.anchor.x + 30, y: box.anchor.y + 15 })
  assert.ok(await until(async () => (await motion(10)).anchor[0] > 80 + 15), `the anchor point moved over the clip: ${JSON.stringify((await motion(10)).anchor)}`)
  const anchored = await clipBox()
  assert.ok(near(anchored.quad[0].x, box.quad[0].x, 1.5) && near(anchored.quad[0].y, box.quad[0].y, 1.5), 'the picture stays where it was')
  assert.ok(near(anchored.anchor.x, box.anchor.x + 30, 2), 'the anchor point is drawn where it was dropped')
  while (JSON.stringify((await motion(10)).anchor) !== JSON.stringify(before.anchor) && (await undoSteps()) > 0) {
    await undo()
    await page.waitForTimeout(150)
  }
  assert.ok(await until(async () => JSON.stringify((await motion(10)).position) === JSON.stringify(before.position)), 'undone')

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`picture ${which}: ok`)
} finally {
  await browser.close()
  await server.close()
}
