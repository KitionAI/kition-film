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

  /** A move drag of the selected clip from inside its box by (dx, dy): the box must follow the pointer, the picture change, and the drag be one undo step; then it is undone. */
  const moveFollows = async (label, dx, dy) => {
    const at = await settledBox()
    const from = await motion(10)
    const steps3 = await undoSteps()
    const was = await picture()
    let changed = false
    await drag(inBox(at), { x: inBox(at).x + dx, y: inBox(at).y + dy }, async () => {
      changed = await until(async () => (await picture()) !== was, 20)
    })
    assert.ok(changed, `${label}: the picture changes during the drag`)
    assert.ok(await until(async () => (await undoSteps()) === steps3 + 1), `${label}: one undo step`)
    const to = await settledBox()
    assert.ok(near(to.quad[0].x - at.quad[0].x, dx, 3) && near(to.quad[0].y - at.quad[0].y, dy, 3), `${label}: the box followed the pointer (${to.quad[0].x - at.quad[0].x}, ${to.quad[0].y - at.quad[0].y})`)
    await undo()
    assert.ok(await until(async () => JSON.stringify((await motion(10)).position) === JSON.stringify(from.position)), `${label}: undone`)
  }

  // Magnified to 200% and scrolled: the box is where the picture is, and a drag follows the pointer.
  await kit.getByTestId('film-program-zoom').click()
  await kit.getByTestId('film-program-zoom-200').click()
  assert.ok(await until(async () => (await kit.getByTestId('film-program-zoom').textContent()) === '200%'), 'at 200%')
  await page.mouse.move(middle.x, middle.y)
  await page.mouse.wheel(60, 40)
  await page.waitForTimeout(300)
  const zoomedBox = await settledBox()
  assert.ok(zoomedBox && zoomedBox.quad[1].x - zoomedBox.quad[0].x > (box.quad[1].x - box.quad[0].x) * 1.5, 'the box is drawn magnified')
  await moveFollows('at 200%, scrolled', -50, 30)
  await shot('picture-zoomed')
  await kit.getByTestId('film-program-zoom').click()
  await kit.getByTestId('film-program-zoom-fit').click()
  assert.ok(await until(async () => (await kit.getByTestId('film-program-zoom').textContent()) === zh('Fit')), 'back to Fit')

  // At 1/2 Paused Resolution: the same.
  const half = kit.getByTestId('film-program-settings-pausedRes-half')
  for (let attempt = 0; attempt < 4 && !(await half.isVisible().catch(() => false)); attempt += 1) {
    if ((await kit.locator('[role="menu"]').count()) === 0) await kit.getByTestId('film-program-settings').click()
    await kit.locator('[data-kit-ui-id="menu:View/Paused Resolution"]').hover({ timeout: 3000 }).catch(() => undefined)
    await page.waitForTimeout(200)
  }
  await half.click()
  assert.ok(await until(async () => (await kit.getByTestId('film-program').getAttribute('data-render-scale')) === '0.5'), 'the Program renders at 1/2')
  await moveFollows('at 1/2 resolution', 70, -20)

  // A clip on V2 over V1: a click selects the top-most under the pointer; a click off it selects V1's.
  await person('timeline.place', { item: 8, track: 'V2', seconds: 0 })
  const top = async () => (await sequence()).video[1].items[0]?.clip ?? null
  assert.ok(await until(async () => (await top()) != null), 'set up: a clip on V2')
  const upper = await top()
  await person('effects.setParam', { clip: upper, effect: 'motion', param: 'scale', value: 150 })
  await person('timeline.select', { clips: [] })
  await page.mouse.click(middle.x, middle.y)
  assert.ok(await until(async () => (await selection()).includes(upper) && !(await selection()).includes(10)), `the top-most clip under the pointer is selected: ${await selection()}`)
  assert.ok(await until(async () => (await clipBox())?.clip === upper), 'and shows its box')
  const lower = await settledBox()
  await page.mouse.click(lower.quad[0].x - 20, lower.quad[0].y - 10)
  assert.ok(await until(async () => (await selection()).includes(10) && !(await selection()).includes(upper)), `beside it, V1's clip is selected: ${await selection()}`)
  // Pressing on V2's clip while V1's is selected selects it and moves it at once.
  const v2Before = (await motion(upper)).position
  await drag({ x: middle.x + 10, y: middle.y + 8 }, { x: middle.x + 60, y: middle.y + 8 })
  assert.ok(await until(async () => (await selection()).includes(upper) && (await motion(upper)).position[0] > v2Before[0] + 50), `a drag on the other clip's picture selects and moves it: ${JSON.stringify((await motion(upper)).position)}`)
  await shot('picture-two-clips')

  // A locked track's clip refuses, in Chinese, and stays.
  await kit.getByTestId('film-track-V2-lock').click()
  assert.ok(await until(async () => (await sequence()).video[1].locked === true), 'V2 is locked')
  const lockedAt = (await motion(upper)).position
  const lockedBox = await settledBox()
  await drag(inBox(lockedBox), { x: inBox(lockedBox).x + 40, y: inBox(lockedBox).y })
  const refusal = await message()
  assert.ok(refusal.includes(zh('track is locked')), `the locked track says so in Chinese: ${refusal}`)
  assert.ok(!/`|effects\.setParam|not available/.test(refusal), `no command id or English: ${refusal}`)
  assert.deepEqual((await motion(upper)).position, lockedAt, 'the clip stays')
  await kit.getByTestId('film-track-V2-lock').click()
  assert.ok(await until(async () => (await sequence()).video[1].locked === false), 'V2 unlocked')

  // Cmd+Right with the Program monitor focused nudges the selected clip one pixel (upstream's Nudge Selected Object).
  const upperBox = await settledBox()
  await page.mouse.click(inBox(upperBox).x, inBox(upperBox).y)
  const nudgeFrom = (await motion(upper)).position
  await page.keyboard.press(`${mod}+ArrowRight`)
  assert.ok(await until(async () => near((await motion(upper)).position[0], nudgeFrom[0] + 1, 1e-6)), `Cmd+Right nudges it: ${JSON.stringify((await motion(upper)).position)} from ${JSON.stringify(nudgeFrom)}`)

  // Keyframed Position: a drag at another time writes a keyframe at the playhead.
  await person('effects.toggleAnimation', { clip: upper, effect: 'motion', param: 'position' })
  assert.ok(await until(async () => (await motion(upper)).keyframes === 1), 'set up: Position animated, one keyframe')
  await person('playhead.set', { frame: 20 })
  const keyedBox = await settledBox()
  await drag(inBox(keyedBox), { x: inBox(keyedBox).x - 40, y: inBox(keyedBox).y + 20 })
  assert.ok(await until(async () => (await motion(upper)).keyframes === 2), `a drag at frame 20 adds a keyframe there: ${(await motion(upper)).keyframes}`)

  // ---- a title: typed with the Type tool, in Chinese
  await page.keyboard.press('Escape')
  const tools = kit.locator('.kui-tool-slot > button[data-kit-ui-id="tool:Type"]')
  await tools.click()
  const before3 = new Set((await sequence()).video.flatMap((track) => track.items.map((item) => item.clip)))
  await page.mouse.click(programBox.x + programBox.width * 0.3, programBox.y + programBox.height * 0.2)
  await page.keyboard.type('中文标题 Hi')
  const title = async () => (await sequence()).video.flatMap((track) => track.items).find((item) => !before3.has(item.clip)) ?? null
  const layerOf = async (clip) => (await person('graphics.list', { clip }))?.layers?.[0] ?? null
  assert.ok(await until(async () => (await title()) != null && (await layerOf((await title()).clip))?.text === '中文标题 Hi'), `the typed Chinese is the title's text: ${JSON.stringify(await layerOf((await title())?.clip))}`)
  const titleClip = (await title()).clip
  await page.keyboard.press('Escape')
  assert.ok(await until(async () => (await kit.getByTestId('film-program-text-edit').count()) === 0), 'Escape ends the edit')
  // Chinese draws real glyphs: two different characters draw differently (a missing glyph draws the same box for both).
  const drawn = async (text) => {
    await person('graphics.setText', { clip: titleClip, layer: 0, text })
    await page.waitForTimeout(400)
    let sum = await picture()
    await until(async () => {
      const again = await picture()
      const same = again === sum
      sum = again
      return same
    }, 20)
    return sum
  }
  const one = await drawn('标')
  const other = await drawn('题')
  assert.notEqual(one, other, '标 and 题 draw differently: the engine has a CJK face')
  await drawn('中文标题 Hi')
  await shot('picture-title')

  // The Properties panel styles the selected text layer: font, size, fill, alignment, bold and italic.
  await page.keyboard.press('v')
  await kit.getByTestId('film-menu-Window').click()
  await kit.locator('[role="menu"] [data-kit-ui-id="control:window.panel.Properties"]').click()
  await kit.getByTestId('film-properties').waitFor({ timeout: 10_000 })
  await person('timeline.select', { clips: [titleClip] })
  await kit.getByTestId('film-props-text-size').waitFor({ timeout: 10_000 })
  const textParams = async () => {
    const effect = (await clipOf(titleClip))?.effects.find((each) => each.effect === 'graphic_text')
    return Object.fromEntries(Object.entries(effect?.params ?? {}).map(([key, param]) => [key, param.value]))
  }
  const style0 = await textParams()
  // Font: the engine's families.
  const fontField = kit.getByTestId('film-props-text-font')
  const offered = await fontField.locator('option').allTextContents()
  assert.ok(['Inter', 'Noto Serif', 'Droid Sans Fallback'].every((family) => offered.includes(family)), `the engine's families are offered: ${offered}`)
  await fontField.selectOption('Noto Serif')
  assert.ok(await until(async () => (await textParams()).font === 'Noto Serif'), `the font is Noto Serif: ${(await textParams()).font}`)
  // Size: a scrub, one undo step.
  const sizeSteps = await undoSteps()
  const sizeBox = await kit.getByTestId('film-props-text-size').boundingBox()
  await drag({ x: sizeBox.x + sizeBox.width / 2, y: sizeBox.y + sizeBox.height / 2 }, { x: sizeBox.x + sizeBox.width / 2 + 60, y: sizeBox.y + sizeBox.height / 2 })
  assert.ok(await until(async () => (await textParams()).size > style0.size + 10), `a scrub raises the size: ${style0.size} → ${(await textParams()).size}`)
  assert.ok(await until(async () => (await undoSteps()) === sizeSteps + 1), `the scrub is one undo step: ${await undoSteps()} after ${sizeSteps}`)
  // Alignment and Faux Bold, Faux Italic.
  await kit.getByTestId('film-props-text-align-1').click()
  assert.ok(await until(async () => (await textParams()).align === 1), 'Center Align Text')
  assert.equal(await kit.getByTestId('film-props-text-align-1').getAttribute('aria-pressed'), 'true')
  await kit.getByTestId('film-props-text-faux_bold').click()
  await kit.getByTestId('film-props-text-faux_italic').click()
  assert.ok(await until(async () => (await textParams()).faux_bold === true && (await textParams()).faux_italic === true), 'Faux Bold and Faux Italic on')
  // Fill: the swatch opens the colour picker; a click in it changes the colour.
  await kit.getByTestId('film-props-text-fill').click()
  const picker = kit.getByTestId('film-props-text-fill-picker')
  await picker.waitFor({ timeout: 5000 })
  const pickerBox = await picker.boundingBox()
  await page.mouse.click(pickerBox.x + pickerBox.width * 0.8, pickerBox.y + pickerBox.height * 0.2)
  assert.ok(await until(async () => (await textParams()).fill_color !== style0.fill_color), `the fill colour changes: ${style0.fill_color} → ${(await textParams()).fill_color}`)
  await page.keyboard.press('Escape')
  await shot('picture-title-styled')

  // The Selection tool moves the title, scales it with a handle, and a double-click edits it again.
  const textLayerAt = async () => (await layerOf(titleClip))?.position
  const layerBox = async () =>
    frame.evaluate(() => {
      const svg = document.querySelector('[data-testid="film-program-graphics"]')
      const box = svg?.querySelector('[data-kit-ui-id="control:program.layer"]')
      if (!svg || !box) return null
      const at = svg.getBoundingClientRect()
      return box.getAttribute('points').split(' ').map((pair) => pair.split(',').map(Number)).map(([x, y]) => ({ x: at.x + x, y: at.y + y }))
    }).then((quad) => quad && quad.map((p) => ({ x: p.x + iframe.x, y: p.y + iframe.y })))
  const titleMiddle = async () => {
    const list = await layerOf(titleClip)
    const view = ((await kit.getByTestId('film-program').getAttribute('data-view')) ?? '').split(' ').map(Number)
    const region = await kit.locator('[data-testid="film-program"] canvas').first().boundingBox()
    const [x, y] = [(list.quad[0][0] + list.quad[2][0]) / 2, (list.quad[0][1] + list.quad[2][1]) / 2]
    return { x: region.x + (x - view[1]) * view[0], y: region.y + (y - view[2]) * view[0] }
  }
  let titleAt = await titleMiddle()
  await page.mouse.click(titleAt.x, titleAt.y)
  assert.ok(await until(async () => (await layerBox()) != null), 'a click on the title selects its layer: its box shows')
  const fromAt = await textLayerAt()
  await drag(titleAt, { x: titleAt.x + 40, y: titleAt.y + 30 })
  assert.ok(await until(async () => (await textLayerAt())[0] > fromAt[0] + 20), `the title moved: ${JSON.stringify(await textLayerAt())}`)
  const quad = await layerBox()
  const scaleFrom = (await layerOf(titleClip)).scale
  await drag(quad[2], { x: quad[2].x + 30, y: quad[2].y + 30 })
  assert.ok(await until(async () => (await layerOf(titleClip)).scale > scaleFrom), `a handle scales the title: ${scaleFrom} → ${(await layerOf(titleClip)).scale}`)
  titleAt = await titleMiddle()
  await page.mouse.dblclick(titleAt.x, titleAt.y)
  assert.ok(await until(async () => (await kit.getByTestId('film-program-text-edit').count()) === 1), 'a double-click edits the text again')
  assert.equal(await kit.getByTestId('film-program-text-edit').inputValue(), '中文标题 Hi', 'with its text')
  await page.keyboard.press('Escape')

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`picture ${which}: ok`)
} finally {
  await browser.close()
  await server.close()
}
