// Transitions by hand, with a real pointer and keyboard: node tests/transitions.mjs [chromium|webkit].
// The plan "Film usable by hand", phase 3's engine gaps: a transition dropped on a cut takes its
// alignment from where it lands (left of the cut it ends there, on the cut it is centred, right of
// it it starts there), named on the preview; the middle of one between two clips drags it over its
// cut; an end of one moved off centre trims its own side; Set Transition Duration chooses the
// alignment; Delete (and Backspace) on a selected transition clears it, and its menu's Clear
// Transition does too. Every edit is one undo step.
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { readCatalog } from '../parity/i18n.mjs'

const ZH = readCatalog(new URL('../src/i18n/upstream/zh-hans.tsv', import.meta.url)).table
const zh = (english) => ZH.get(english) ?? english
const which = process.argv[2] ?? 'chromium'
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
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/dev.html?locale=zh-CN`)
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 90_000 })
  const kit = page.frameLocator('#kit')
  await kit.getByTestId('film-clip-10').waitFor({ timeout: 60_000 })
  const frame = page.frames().find((candidate) => candidate.url().includes('index.html'))
  const sequence = async () => (await page.evaluate(() => window.devHost.connection().ai.inspect())).details.sequence
  const v1 = async () => (await sequence()).video[0]
  const undoSteps = async () => (await frame.evaluate(() => window.filmPreview.history()))?.undo?.length ?? 0
  const message = async () => ((await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => '')) ?? '').trim()
  const undo = async () => {
    await kit.locator('.kui-app').focus()
    await page.keyboard.press(`${mod}+z`)
  }
  const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
  const drag = async (from, to, hold = async () => undefined) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= 15; i += 1) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 15, from.y + ((to.y - from.y) * i) / 15)
      await page.waitForTimeout(30)
    }
    await page.mouse.move(to.x + 1, to.y)
    await page.waitForTimeout(60)
    await hold()
    await page.mouse.up()
  }

  // Cut the clip in two with the Razor (C), back to Selection (V); zoom in so a frame is wide.
  await kit.getByTestId('film-clip-10').click()
  await page.keyboard.press('Home')
  const whole = await kit.getByTestId('film-clip-10').boundingBox()
  await page.keyboard.press('c')
  await page.mouse.click(whole.x + whole.width / 2, whole.y + whole.height / 2)
  await page.keyboard.press('v')
  assert.ok(await until(async () => (await v1()).items.length === 2), 'the Razor cut V1 in two')
  const [left, right] = (await v1()).items
  const frameTicks = Math.round(right.duration / right.durationFrames)
  const only = async () => (await v1()).transitions[0] ?? null

  await kit.getByTestId('film-workspace-tab-effects').click()
  const search = kit.getByTestId('film-effects-search')
  await search.click()
  await search.fill('cross dissolve')
  const dissolve = () => kit.getByTestId('film-effects-item-cross_dissolve').boundingBox()
  const clipBox = (id) => kit.getByTestId(`film-clip-${id}`).boundingBox()
  /** Drags Cross Dissolve to `x` on V1, reads the preview's label, and answers it. */
  const dropAt = async (x) => {
    const rightBox = await clipBox(right.clip)
    let label = null
    let outlined = false
    await drag(center(await dissolve()), { x, y: rightBox.y + rightBox.height / 2 }, async () => {
      outlined = await until(async () => (await kit.getByTestId('film-timeline-effect-drop').count()) === 1, 20)
      label = await kit.getByTestId('film-timeline-effect-drop-label').textContent().catch(() => null)
    })
    assert.ok(outlined, 'the drop preview is drawn while it hovers')
    return label
  }

  // Dropped well left of the cut it ends at the cut; well right of it, it starts there; on it, centred. Each one undo step.
  const cutX = (await clipBox(right.clip)).x
  const steps = await undoSteps()
  assert.equal(await dropAt(cutX - 60), zh('End at Cut'), 'left of the cut the preview says End at Cut')
  assert.ok(await until(async () => (await only())?.start + (await only())?.duration === right.start), `it ends at the cut (${await message()})`)
  assert.equal((await only()).align, 'end')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  await undo()
  assert.ok(await until(async () => (await v1()).transitions.length === 0), 'undo takes it back')
  assert.equal(await dropAt(cutX + 60), zh('Start at Cut'), 'right of the cut the preview says Start at Cut')
  assert.ok(await until(async () => (await only())?.start === right.start), 'it starts at the cut')
  await undo()
  assert.ok(await until(async () => (await v1()).transitions.length === 0), 'undo takes it back')
  assert.equal(await dropAt(cutX + 2), zh('Center at Cut'), 'on the cut the preview says Center at Cut')
  assert.ok(await until(async () => (await only())?.align === 'center'), 'it is centred on the cut')
  let transition = await only()
  const drawn = () => kit.getByTestId(`film-transition-${transition.id}`)
  await drawn().waitFor({ timeout: 5000 })
  await kit.getByTestId('film-workspace-tab-effectControls').click()

  // Its middle dragged right slides it over the cut: same length, later start, one undo step.
  let box = await drawn().boundingBox()
  const slideSteps = await undoSteps()
  let moved = false
  await drag(center(box), { x: center(box).x + box.width / 4, y: center(box).y }, async () => {
    moved = Math.abs((await drawn().boundingBox()).x - box.x) > 4
  })
  assert.ok(moved, 'it is drawn moving while its middle is dragged')
  assert.ok(await until(async () => (await only())?.start > transition.start), `releasing moves it: ${transition.start} → ${(await only())?.start}`)
  assert.equal((await only()).duration, transition.duration, 'same length')
  assert.ok((await only()).start <= right.start && (await only()).start + (await only()).duration >= right.start, 'still over the cut')
  assert.equal((await only()).align, 'custom', 'off centre: Custom Start')
  assert.equal(await undoSteps(), slideSteps + 1, 'the move is one undo step')
  transition = await only()

  // Off centre, its left end dragged left trims that side only: the right end stays.
  box = await drawn().boundingBox()
  const trimSteps = await undoSteps()
  await drag({ x: box.x + 2, y: center(box).y }, { x: box.x - 40, y: center(box).y })
  assert.ok(await until(async () => (await only())?.start < transition.start), `the left end moves left: ${transition.start} → ${(await only())?.start}`)
  assert.equal((await only()).start + (await only()).duration, transition.start + transition.duration, 'the right end stays')
  assert.equal(await undoSteps(), trimSteps + 1, 'one undo step')
  await undo()
  assert.ok(await until(async () => (await only())?.start === transition.start), 'one undo restores it')

  // Set Transition Duration with Start at Cut chosen: it starts at the cut, 8 frames long, one undo step.
  box = await drawn().boundingBox()
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
  const field = kit.getByTestId('film-transition-duration-value')
  await field.waitFor({ timeout: 5000 })
  const alignment = kit.getByTestId('film-transition-duration-alignment')
  assert.equal(await alignment.inputValue(), 'custom', 'the dialog reads Custom Start')
  await alignment.selectOption('start')
  await field.click()
  await page.keyboard.press(`${mod}+a`)
  await page.keyboard.type('8')
  await page.keyboard.press('Enter')
  const dialogSteps = await undoSteps()
  await kit.getByTestId('film-transition-duration-ok').click()
  assert.ok(await until(async () => (await only())?.start === right.start && Math.abs((await only())?.duration - 8 * frameTicks) <= 1), `Start at Cut, 8 frames: ${JSON.stringify(await only())}`)
  assert.equal(await undoSteps(), dialogSteps + 1, 'one undo step')
  transition = await only()

  // A click selects it; Delete clears it, one undo step; undo brings it back.
  box = await drawn().boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  assert.ok(await until(async () => (await drawn().getAttribute('aria-selected')) === 'true'), 'a click selects the transition')
  const clearSteps = await undoSteps()
  await page.keyboard.press('Delete')
  assert.ok(await until(async () => (await v1()).transitions.length === 0), `Delete clears it (${await message()})`)
  assert.equal((await v1()).items.length, 2, 'the clips stay')
  assert.equal(await undoSteps(), clearSteps + 1, 'one undo step')
  await undo()
  assert.ok(await until(async () => (await v1()).transitions.length === 1), 'undo brings it back')

  // Backspace clears a selected one too.
  await drawn().waitFor({ timeout: 5000 })
  box = await drawn().boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  assert.ok(await until(async () => (await drawn().getAttribute('aria-selected')) === 'true'), 'selected again')
  await page.keyboard.press('Backspace')
  assert.ok(await until(async () => (await v1()).transitions.length === 0), `Backspace clears it (${await message()})`)
  await undo()
  assert.ok(await until(async () => (await v1()).transitions.length === 1), 'undo brings it back')

  // Its menu's Clear Transition (删除转场) clears it.
  await drawn().waitFor({ timeout: 5000 })
  box = await drawn().boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  const clear = kit.getByTestId('film-transition-menu-clear')
  assert.equal(await clear.textContent(), '删除转场', 'the menu names Clear Transition in Chinese')
  await clear.click()
  assert.ok(await until(async () => (await v1()).transitions.length === 0), 'its menu clears it')
  assert.equal((await v1()).items.map((item) => item.clip).join(), [left.clip, right.clip].join(), 'the clips stay')

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`transitions ${which}: ok`)
} finally {
  await browser.close()
  await server.close()
}
