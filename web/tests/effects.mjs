// Effects and transitions by hand, with a real pointer and keyboard: node tests/effects.mjs [chromium|webkit].
// The plan "Film usable by hand", phase 3: the Effects panel is a panel again (Window ▸ Effects, a
// tab of the Editing workspace) with its folder tree and search; a double-click applies an effect
// to the selected clip, a drag applies it to the clip under the pointer (outlined while it hovers)
// or to the clip Effect Controls shows; the applied effect's parameter scrubs in Effect Controls and
// the Program picture changes; its header selected, Delete removes it. A transition dragged onto a
// cut lands centred on it; a click selects it, dragging an end lengthens it, a double-click opens Set
// Transition Duration; Delete on it says it cannot be removed on its own. Every edit is one undo step.
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { CATALOGS } from '../src/strings.ts'
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
  const clipOf = async (id) => (await v1()).items.find((item) => item.clip === id) ?? null
  const effectsOf = async (id) => ((await clipOf(id))?.effects ?? []).map((effect) => effect.effect)
  const undoSteps = async () => (await frame.evaluate(() => window.filmPreview.history()))?.undo?.length ?? 0
  const message = async () => ((await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => '')) ?? '').trim()
  const undo = async () => {
    await kit.locator('.kui-app').focus()
    await page.keyboard.press(`${mod}+z`)
  }
  const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
  /** A real pointer drag from `from` to `to`, paced (WebKit delivers a drag's events a beat behind), with `hold` run before the release. */
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
  /** The Program picture's lit samples and a checksum of its pixels. */
  const picture = () =>
    frame.evaluate(() => {
      const canvas = document.querySelector('[data-testid="film-program"] canvas')
      if (!canvas || !canvas.width) return { lit: 0, sum: 0 }
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
      let lit = 0
      let sum = 0
      for (let at = 0; at < data.length; at += 16) {
        if (data[at] + data[at + 1] + data[at + 2] > 60) lit += 1
        sum = (sum * 31 + data[at] + data[at + 1] * 3 + data[at + 2] * 7) % 1000000007
      }
      return { lit, sum }
    })

  // Window lists Effects, and the Editing workspace has its tab.
  await kit.getByTestId('film-menu-Window').click()
  assert.equal(await kit.locator('[role="menu"] [data-kit-ui-id="control:window.panel.Effects"]').count(), 1, 'Window ▸ Effects is offered')
  await page.keyboard.press('Escape')
  await kit.getByTestId('film-workspace-tab-effects').click()
  const tree = kit.getByTestId('film-effects-tree')
  await kit.getByTestId('film-effects-folder-Video Effects').waitFor({ timeout: 10_000 })
  const tops = await tree.locator('[data-kit-ui-id="control:effects.folder"]').allTextContents()
  assert.deepEqual(tops, ['Presets', 'Audio Effects', 'Audio Transitions', 'Video Effects', 'Video Transitions', 'Legacy'].map(zh), 'the top folders, in Chinese, in upstream order')

  // A folder opens with a click; the search finds an effect by its Chinese or English name.
  await kit.getByTestId('film-effects-folder-Video Effects').click()
  await kit.getByTestId('film-effects-folder-Video Effects/Blur & Sharpen').click()
  assert.equal(await kit.getByTestId('film-effects-item-gaussian_blur').textContent(), zh('Gaussian Blur'), 'Video Effects ▸ Blur & Sharpen ▸ Gaussian Blur, opened by clicks')
  await kit.getByTestId('film-effects-folder-Video Effects').click()
  assert.equal(await kit.getByTestId('film-effects-item-gaussian_blur').count(), 0, 'a click closes the folder again')
  const search = kit.getByTestId('film-effects-search')
  await search.click()
  await page.keyboard.type('高斯')
  assert.ok(await until(async () => (await kit.getByTestId('film-effects-item-gaussian_blur').count()) === 1 && (await tree.locator('[data-kit-ui-id="control:effects.item"]').count()) <= 3), 'the search 高斯 shows Gaussian Blur and few else')
  await search.fill('cross dissolve')
  assert.ok(await until(async () => (await kit.getByTestId('film-effects-item-cross_dissolve').count()) === 1), 'the search "cross dissolve" (English) finds Cross Dissolve')
  await search.fill('gaussian')

  // Double-click with the clip selected applies it; one undo takes it back.
  await kit.getByTestId('film-clip-10').click()
  const steps = await undoSteps()
  await kit.getByTestId('film-effects-item-gaussian_blur').dblclick()
  assert.ok(await until(async () => (await effectsOf(10)).includes('gaussian_blur')), `a double-click applies Gaussian Blur to the selected clip: ${await effectsOf(10)} (${await message()})`)
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  await undo()
  assert.ok(await until(async () => !(await effectsOf(10)).includes('gaussian_blur')), 'undo takes it back')

  // A drag onto the clip outlines it while it hovers, and applies it there on release.
  await kit.getByTestId('film-timeline').click({ position: { x: 5, y: 5 } }).catch(() => undefined)
  let outlined = false
  const source = await kit.getByTestId('film-effects-item-gaussian_blur').boundingBox()
  const clip = await kit.getByTestId('film-clip-10').boundingBox()
  await drag(center(source), { x: clip.x + clip.width * 0.6, y: clip.y + clip.height / 2 }, async () => {
    outlined = await until(async () => (await kit.getByTestId('film-timeline-effect-drop').count()) === 1, 20)
  })
  assert.ok(outlined, 'the clip under the pointer is outlined while the effect hovers it')
  assert.ok(await until(async () => (await effectsOf(10)).includes('gaussian_blur')), `the drop applies Gaussian Blur to the clip: ${await effectsOf(10)} (${await message()})`)
  assert.equal(await kit.getByTestId('film-timeline-effect-drop').count(), 0, 'the outline goes with the drop')

  // Effect Controls shows it; scrubbing Blurriness changes it and the Program picture, one undo step.
  await frame.evaluate(() => window.filmPreview.run('playhead.set', { frame: 12 }))
  await kit.getByTestId('film-workspace-tab-effectControls').click()
  const hot = kit.getByTestId('film-ec-gaussian_blur-blurriness-value-value')
  await hot.waitFor({ timeout: 10_000 })
  await until(async () => (await picture()).lit > 50)
  const sharp = await picture()
  const blurred = async () => Number((await clipOf(10))?.effects.find((effect) => effect.effect === 'gaussian_blur')?.params.blurriness.value)
  const blurFrom = await blurred()
  const scrubSteps = await undoSteps()
  const hotBox = await hot.boundingBox()
  await drag(center(hotBox), { x: center(hotBox).x + 150, y: center(hotBox).y })
  assert.ok(await until(async () => (await blurred()) > blurFrom), `scrubbing Blurriness raises it: ${blurFrom} → ${await blurred()}`)
  assert.ok(await until(async () => (await picture()).sum !== sharp.sum), 'the Program picture changes with it')
  assert.ok(await until(async () => (await undoSteps()) === scrubSteps + 1), `the scrub is one undo step (${scrubSteps} → ${await undoSteps()})`)
  await undo()
  assert.ok(await until(async () => (await blurred()) === blurFrom), 'one undo restores Blurriness')

  // Its header selected, Delete removes it; undo brings it back; its menu's Clear removes it too.
  await kit.getByTestId('film-ec-effect-gaussian_blur').locator('.film-ec-effect-name').click()
  assert.equal(await kit.getByTestId('film-ec-effect-gaussian_blur').getAttribute('aria-selected'), 'true', 'a click on the header selects the effect')
  assert.equal(await kit.getByTestId('film-ec-gaussian_blur-blurriness').count(), 1, 'and leaves it open (only the arrow folds it)')
  await page.keyboard.press('Delete')
  assert.ok(await until(async () => !(await effectsOf(10)).includes('gaussian_blur')), `Delete removes the selected effect (${await message()})`)
  assert.ok((await effectsOf(10)).includes('motion'), 'the fixed effects stay')
  await undo()
  assert.ok(await until(async () => (await effectsOf(10)).includes('gaussian_blur')), 'undo brings it back')
  await kit.getByTestId('film-ec-effect-gaussian_blur').waitFor({ timeout: 5000 })
  await kit.getByTestId('film-ec-effect-gaussian_blur').click({ button: 'right' })
  await kit.getByTestId('film-ec-menu-remove').click()
  assert.ok(await until(async () => !(await effectsOf(10)).includes('gaussian_blur')), 'its menu ▸ Clear removes it')

  // An effect dragged onto Effect Controls goes on the clip it shows.
  await kit.getByTestId('film-workspace-tab-effects').click()
  const fromRow = await kit.getByTestId('film-effects-item-gaussian_blur').boundingBox()
  // The Effects tab shares a frame with Project, Effect Controls one with Source: both on screen.
  await kit.getByTestId('film-workspace-tab-effectControls').click()
  const panel = await kit.getByTestId('film-effect-controls').boundingBox()
  await drag(center(fromRow), center(panel))
  assert.ok(await until(async () => (await effectsOf(10)).includes('gaussian_blur')), `a drop on Effect Controls applies to its clip: ${await effectsOf(10)} (${await message()})`)
  await undo()
  assert.ok(await until(async () => !(await effectsOf(10)).includes('gaussian_blur')), 'undo takes it back')

  // Two standard effects swap places by dragging one's header over the other, one undo step; its
  // menu moves it up and down among the standard effects only (the fixed ones keep theirs).
  await kit.getByTestId('film-clip-10').click()
  await frame.evaluate(() => window.filmPreview.run('effects.apply', { clips: [10], effect: 'gaussian_blur' }))
  await frame.evaluate(() => window.filmPreview.run('effects.apply', { clips: [10], effect: 'invert' }))
  const standard = async () => (await effectsOf(10)).filter((effect) => ['gaussian_blur', 'invert'].includes(effect))
  assert.ok(await until(async () => (await standard()).join() === 'gaussian_blur,invert'), `Gaussian Blur then Invert: ${await effectsOf(10)}`)
  await kit.getByTestId('film-workspace-tab-effectControls').click()
  await kit.getByTestId('film-ec-effect-invert').waitFor({ timeout: 10_000 })
  const fixedBefore = (await effectsOf(10)).filter((effect) => !['gaussian_blur', 'invert'].includes(effect))
  // Both folded, so their headers are on screen together.
  for (const effect of ['gaussian_blur', 'invert']) {
    await kit.getByTestId(`film-ec-effect-${effect}-fold`).click()
    await until(async () => (await kit.getByTestId(`film-ec-effect-${effect}-fold`).getAttribute('aria-expanded')) === 'false', 20)
  }
  await kit.getByTestId('film-ec-effect-invert').scrollIntoViewIfNeeded()
  const orderSteps = await undoSteps()
  const invertName = await kit.getByTestId('film-ec-effect-invert').locator('.film-ec-effect-name').boundingBox()
  const blurHeader = await kit.getByTestId('film-ec-effect-gaussian_blur').boundingBox()
  let line = false
  await drag(center(invertName), { x: center(invertName).x, y: blurHeader.y + 3 }, async () => {
    line = (await kit.getByTestId('film-ec-reorder-line').count()) === 1
  })
  assert.ok(line, 'a line shows where the dragged effect would land')
  assert.ok(await until(async () => (await standard()).join() === 'invert,gaussian_blur'), `the drag puts Invert first: ${await effectsOf(10)} (${await message()})`)
  assert.deepEqual((await effectsOf(10)).filter((effect) => !['gaussian_blur', 'invert'].includes(effect)), fixedBefore, 'the fixed effects keep their places')
  assert.equal(await undoSteps(), orderSteps + 1, 'the move is one undo step')
  await undo()
  assert.ok(await until(async () => (await standard()).join() === 'gaussian_blur,invert'), 'one undo puts it back')
  await kit.getByTestId('film-ec-effect-gaussian_blur').locator('.film-ec-effect-name').click({ button: 'right' })
  assert.equal(await kit.getByTestId('film-ec-menu-move-up').isDisabled(), true, 'the first standard effect cannot move up past the fixed ones')
  assert.equal(await kit.getByTestId('film-ec-menu-move-down').textContent(), zh('Move Effect Down'), 'its menu says Move Effect Down in Chinese')
  await kit.getByTestId('film-ec-menu-move-down').click()
  assert.ok(await until(async () => (await standard()).join() === 'invert,gaussian_blur'), `Move Effect Down: ${await effectsOf(10)}`)
  await kit.getByTestId('film-ec-effect-gaussian_blur').locator('.film-ec-effect-name').click({ button: 'right' })
  await kit.getByTestId('film-ec-menu-move-up').click()
  assert.ok(await until(async () => (await standard()).join() === 'gaussian_blur,invert'), `Move Effect Up: ${await effectsOf(10)}`)
  for (const effect of ['gaussian_blur', 'invert']) await kit.getByTestId(`film-ec-effect-${effect}-fold`).click()
  for (const effect of ['invert', 'gaussian_blur']) {
    const index = (await clipOf(10)).effects.findIndex((each) => each.effect === effect)
    await frame.evaluate((at) => window.filmPreview.run('effects.remove', { clip: 10, index: at }), index)
  }
  assert.ok(await until(async () => (await standard()).length === 0), 'the two effects removed again')

  // Cut the clip in two with the Razor (C), back to Selection (V).
  await kit.getByTestId('film-clip-10').click()
  await page.keyboard.press('Home')
  const whole = await kit.getByTestId('film-clip-10').boundingBox()
  await page.keyboard.press('c')
  await page.mouse.click(whole.x + whole.width / 2, whole.y + whole.height / 2)
  await page.keyboard.press('v')
  assert.ok(await until(async () => (await v1()).items.length === 2), 'the Razor cut V1 in two')
  const [left, right] = (await v1()).items

  // A transition dragged near the cut on the right clip shows "Center at Cut" and lands centred there.
  await kit.getByTestId('film-workspace-tab-effects').click()
  await search.fill('cross dissolve')
  const dissolve = await kit.getByTestId('film-effects-item-cross_dissolve').boundingBox()
  const rightBox = await kit.getByTestId(`film-clip-${right.clip}`).boundingBox()
  let label = null
  const transitionSteps = await undoSteps()
  await drag(center(dissolve), { x: rightBox.x + 12, y: rightBox.y + rightBox.height / 2 }, async () => {
    await until(async () => (await kit.getByTestId('film-timeline-effect-drop-label').count()) === 1, 20)
    label = await kit.getByTestId('film-timeline-effect-drop-label').textContent().catch(() => null)
  })
  assert.equal(label, zh('Center at Cut'), 'the drop preview names its alignment')
  assert.ok(await until(async () => (await v1()).transitions.length === 1), `the drop adds a transition (${await message()})`)
  let [transition] = (await v1()).transitions
  assert.deepEqual([transition.effect, transition.from, transition.to], ['cross_dissolve', left.clip, right.clip], 'Cross Dissolve between the two clips')
  assert.ok(transition.start < right.start && transition.start + transition.duration > right.start, 'centred over the cut')
  assert.equal(await undoSteps(), transitionSteps + 1, 'one undo step')
  const drawn = () => kit.getByTestId(`film-transition-${transition.id}`)
  await drawn().waitFor({ timeout: 5000 })

  // A click selects it (drawn selected, the clips let go).
  await kit.getByTestId('film-workspace-tab-effectControls').click()
  const tBox = await drawn().boundingBox()
  await page.mouse.click(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2)
  assert.ok(await until(async () => (await drawn().getAttribute('aria-selected')) === 'true'), 'a click selects the transition')
  assert.ok(await until(async () => (await sequence()).selection.length === 0), 'and lets go of the clips')

  // Dragging its right end lengthens it, drawn as it goes; one undo restores it.
  const before = transition
  const resizeSteps = await undoSteps()
  let widened = false
  await drag({ x: tBox.x + tBox.width - 2, y: tBox.y + tBox.height / 2 }, { x: tBox.x + tBox.width + 60, y: tBox.y + tBox.height / 2 }, async () => {
    widened = (await drawn().boundingBox())?.width > tBox.width + 20
  })
  assert.ok(widened, 'the transition is drawn longer while its end is dragged')
  assert.ok(await until(async () => (await v1()).transitions[0]?.duration > before.duration), `releasing lengthens it: ${before.duration} → ${(await v1()).transitions[0]?.duration}`)
  transition = (await v1()).transitions[0]
  assert.equal(transition.effect, 'cross_dissolve', 'the same transition')
  assert.ok(transition.start < before.start, 'centred: both ends moved')
  assert.equal(await undoSteps(), resizeSteps + 1, 'the resize is one undo step')
  assert.ok(await until(async () => (await drawn().getAttribute('aria-selected')) === 'true'), 'it stays selected')
  await undo()
  assert.ok(await until(async () => (await v1()).transitions[0]?.duration === before.duration), 'one undo restores its length')
  transition = (await v1()).transitions[0]

  // A double-click opens Set Transition Duration; 10 frames typed and OK set it.
  const dBox = await drawn().boundingBox()
  await page.mouse.dblclick(dBox.x + dBox.width / 2, dBox.y + dBox.height / 2)
  const field = kit.getByTestId('film-transition-duration-value')
  await field.waitFor({ timeout: 5000 })
  await field.click()
  await page.keyboard.press(`${mod}+a`)
  await page.keyboard.type('10')
  await page.keyboard.press('Enter')
  await kit.getByTestId('film-transition-duration-ok').click()
  const frameTicks = Math.round(right.duration / right.durationFrames)
  assert.ok(await until(async () => Math.abs((await v1()).transitions[0]?.duration - 10 * frameTicks) <= 1), `Set Transition Duration sets 10 frames: ${(await v1()).transitions[0]?.duration / frameTicks}`)
  await undo()
  assert.ok(await until(async () => (await v1()).transitions[0]?.duration === transition.duration), 'one undo restores it')
  transition = (await v1()).transitions[0]

  // Its menu offers Set Transition Duration…; Delete on it says it cannot be removed on its own, and changes nothing.
  const mBox = await drawn().boundingBox()
  await page.mouse.click(mBox.x + mBox.width / 2, mBox.y + mBox.height / 2, { button: 'right' })
  assert.equal(await kit.getByTestId('film-transition-menu-duration').textContent(), zh('Set Transition Duration…'), 'the transition menu')
  await page.keyboard.press('Escape')
  await page.mouse.click(mBox.x + mBox.width / 2, mBox.y + mBox.height / 2)
  await page.keyboard.press('Delete')
  assert.ok(await until(async () => (await message()) === CATALOGS['zh-CN']['transition.cannotDelete']), `Delete says it cannot remove a transition: ${await message()}`)
  assert.equal((await v1()).items.length, 2, 'Delete removed no clip')
  assert.equal((await v1()).transitions.length, 1, 'the transition stays')
  await undo()
  assert.ok(await until(async () => (await v1()).transitions.length === 0), 'undo takes back the step that added it')

  // A transition's menu in the Effects panel makes it the default one.
  await kit.getByTestId('film-workspace-tab-effects').click()
  await search.fill('dip to black')
  await kit.getByTestId('film-effects-item-dip_to_black').click({ button: 'right' })
  await kit.getByTestId('film-effects-menu-default').click()
  const defaultOf = async () => {
    const state = await frame.evaluate(() => window.filmPreview.run('state.inspect', {}))
    return (typeof state === 'string' ? JSON.parse(state) : state)?.default_video_transition
  }
  assert.ok(await until(async () => (await defaultOf()) === 'dip_to_black'), `Set Selected as Default Transition: ${await defaultOf()}`)

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`effects ${which}: ok`)
} finally {
  await browser.close()
  await server.close()
}
