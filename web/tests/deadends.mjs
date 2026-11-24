// No dead ends for a person, with a real pointer and keyboard: node tests/deadends.mjs [chromium|webkit].
// The plan "Film usable by hand", phase 1: Window lists only the panels the editor draws, and no
// offered workspace shows a tab that only says "Not available in this editor yet"; Preferences, the
// interchange exports, Export Frame and Caption track options are gone; the Play button shows Pause
// while it plays; a refusal reads in Chinese without the command's id; Shift+Delete and
// Shift+Backspace in the Timeline ripple-delete (close the gap), Delete leaves it; Sequence ▸ Close
// Gap closes the gap the playhead is in, or says how to use it; the Program monitor's duration says
// when it is the In to Out length.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { CATALOGS } from '../src/strings.ts'
import { readCatalog } from '../parity/i18n.mjs'
import { WEB_PANEL_IDS, WEB_WORKSPACES } from '../src/workspace/presets.ts'

const ZH = readCatalog(new URL('../src/i18n/upstream/zh-hans.tsv', import.meta.url)).table
const zh = (english) => ZH.get(english) ?? english
const manifest = JSON.parse(readFileSync(new URL('../parity/film-upstream.json', import.meta.url), 'utf8'))
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
  const details = async () => (await page.evaluate(() => window.devHost.connection().ai.inspect())).details
  const v1 = async () => (await details()).sequence.video[0].items.map((item) => [item.startFrame, item.durationFrames])
  const message = async () => ((await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => '')) ?? '').trim()
  const clearMessage = async () => {
    if (await kit.getByTestId('film-message').count()) await kit.getByTestId('film-message').click().catch(() => undefined)
  }
  const notAvailable = CATALOGS['zh-CN'].notAvailable

  // Window: only the panels the editor draws.
  await kit.getByTestId('film-menu-Window').click()
  const windowRows = await kit.locator('[role="menu"] [data-kit-ui-id^="control:window.panel."]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-kit-ui-id').slice('control:window.panel.'.length)))
  await page.keyboard.press('Escape')
  const drawnKinds = manifest.panels.filter((panel) => WEB_PANEL_IDS.has(panel.id)).map((panel) => panel.kind)
  assert.deepEqual([...windowRows].sort(), [...drawnKinds].sort(), 'Window lists exactly the panels the editor draws')

  // Every offered workspace: its tabs are panels the editor draws, and none says "not available".
  for (const name of Object.keys(WEB_WORKSPACES)) {
    await kit.getByTestId('film-header-workspaces').click()
    await kit.getByTestId(`film-workspaces-${name.toLowerCase().replaceAll(' ', '')}`).click()
    await page.waitForTimeout(300)
    const tabs = await kit.locator('[data-testid^="film-workspace-tab-"]').evaluateAll((items) => items.map((item) => item.getAttribute('data-testid').slice('film-workspace-tab-'.length)))
    assert.ok(tabs.length > 0 && tabs.every((tab) => WEB_PANEL_IDS.has(tab)), `${name}: every tab is a panel the editor draws (${tabs.join(', ')})`)
    assert.equal(await kit.getByText(notAvailable).count(), 0, `${name}: no panel says "${notAvailable}"`)
  }
  await kit.getByTestId('film-header-workspaces').click()
  await kit.getByTestId('film-workspaces-editing').click()
  await page.waitForTimeout(300)
  await kit.getByTestId('film-header-workspaces').click()
  const offered = await kit.locator('[data-testid^="film-workspaces-"]').evaluateAll((items) => items.map((item) => item.getAttribute('data-testid')))
  await page.keyboard.press('Escape')
  for (const gone of ['color', 'audio', 'captionsandgraphics']) assert.ok(!offered.includes(`film-workspaces-${gone}`), `the ${gone} workspace is not offered`)

  // Edit has no Preferences; File ▸ Export only what exports.
  await kit.getByTestId('film-menu-Edit').click()
  assert.equal(await kit.locator('[data-kit-ui-id="menu:Edit/Preferences"]').count(), 0, 'Edit ▸ Preferences is gone')
  await page.keyboard.press('Escape')
  await kit.getByTestId('film-menu-File').click()
  await kit.locator('[data-kit-ui-id="menu:File/Export"]').hover()
  await kit.getByTestId('film-control-file.exportMedia').waitFor({ timeout: 5000 })
  const exportRows = await kit.locator('[role="menu"] [data-kit-ui-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-kit-ui-id')))
  await page.keyboard.press('Escape')
  for (const gone of ['file.exportEdl', 'file.exportAle', 'file.exportOtio', 'file.exportFcp7Xml', 'file.exportFcpxml', 'file.exportAaf', 'file.exportOmf', 'mode.export']) assert.ok(!exportRows.some((id) => id.endsWith(gone)), `File ▸ Export ▸ ${gone} is gone`)

  // Buttons that did nothing are not drawn.
  assert.equal(await kit.getByTestId('film-timeline-captions').count(), 0, 'the Timeline has no Caption track options button')
  assert.equal(await kit.locator('[data-kit-ui-id="control:transport.exportFrame"]').count(), 0, 'no monitor has an Export Frame button')

  // The Play button shows Pause while it plays.
  const play = kit.getByTestId('film-program-transport-playback.toggle')
  const icon = () => play.evaluate((button) => button.querySelector('svg')?.innerHTML ?? '')
  const stoppedIcon = await icon()
  await play.click()
  const playing = await until(async () => (await play.getAttribute('aria-pressed')) === 'true' && (await icon()) !== stoppedIcon)
  await play.click()
  const stopped = await until(async () => (await play.getAttribute('aria-pressed')) === 'false' && (await icon()) === stoppedIcon)
  assert.ok(playing && stopped, 'the Play button shows another icon (Pause) while it plays, and Play again once stopped')

  // Home, then cut the clip in two at frame 24 with the Razor (C), back to Selection (V).
  const timeline = kit.getByTestId('film-timeline')
  const clipBox = async (id) => kit.getByTestId(`film-clip-${id}`).boundingBox()
  await kit.getByTestId('film-clip-10').click()
  await page.keyboard.press('Home')
  const box = await clipBox(10)
  await page.keyboard.press('c')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.press('v')
  assert.ok(await until(async () => (await v1()).length === 2), `the Razor cut V1 in two: ${JSON.stringify(await v1())}`)
  const [left, right] = await v1()
  const leftClip = (await details()).sequence.video[0].items[0].clip

  // Nothing selected: Delete refuses, in Chinese, without the command's id.
  await clearMessage()
  await kit.locator('.kui-app').focus()
  await page.keyboard.press(`${mod}+Shift+A`)
  await until(async () => (await details()).selection?.length === 0 || (await details()).sequence.selection?.length === 0, 20)
  await timeline.hover()
  await page.keyboard.press('Delete')
  assert.ok(await until(async () => (await message()) !== ''), 'Delete with nothing selected says why')
  const refusal = await message()
  assert.equal(refusal, `${CATALOGS['zh-CN']['error.notNow'].replace('{reason}', zh('nothing selected'))}`, `the refusal reads in Chinese: ${refusal}`)
  assert.ok(!/`|edit\.clear|not available/.test(refusal), `no command id or English: ${refusal}`)

  // Shift+Delete and Shift+Backspace with the left piece selected (the Timeline focused) close the gap.
  for (const key of ['Shift+Delete', 'Shift+Backspace']) {
    const piece = await clipBox(leftClip)
    await page.mouse.click(piece.x + piece.width / 2, piece.y + piece.height / 2)
    await page.keyboard.press(key)
    const rippled = await until(async () => JSON.stringify(await v1()) === JSON.stringify([[0, right[1]]]))
    assert.ok(rippled, `${key} ripple-deletes: the right piece moves to frame 0 (${JSON.stringify(await v1())})`)
    await page.keyboard.press(`${mod}+z`)
    assert.ok(await until(async () => JSON.stringify(await v1()) === JSON.stringify([left, right])), `undo restores ${key}`)
  }

  // Delete leaves the gap; Sequence ▸ Close Gap with the playhead in it closes it.
  const piece = await clipBox(leftClip)
  await page.mouse.click(piece.x + piece.width / 2, piece.y + piece.height / 2)
  await page.keyboard.press('Delete')
  assert.ok(await until(async () => JSON.stringify(await v1()) === JSON.stringify([right])), `Delete leaves the gap (${JSON.stringify(await v1())})`)
  await page.keyboard.press('Home')
  await clearMessage()
  await kit.getByTestId('film-menu-Sequence').click()
  await kit.getByTestId('film-cmd-sequence.closeGap').click()
  assert.ok(await until(async () => JSON.stringify(await v1()) === JSON.stringify([[0, right[1]]])), `Close Gap closes the gap at the playhead (${JSON.stringify(await v1())}; ${await message()})`)
  // With the playhead on a clip there is no gap: it says how to use it, in Chinese.
  await kit.getByTestId('film-menu-Sequence').click()
  await kit.getByTestId('film-cmd-sequence.closeGap').click()
  assert.ok(await until(async () => (await message()) === CATALOGS['zh-CN']['closeGap.noGap']), `Close Gap with no gap says how to use it: ${await message()}`)

  // The Program monitor's duration says when it is the In to Out length.
  const duration = kit.getByTestId('film-program-duration')
  assert.equal(await duration.getAttribute('title'), zh('Duration'))
  await kit.locator('.kui-app').focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('i')
  assert.ok(await until(async () => (await duration.getAttribute('title')) === zh('In to Out duration') && (await duration.getAttribute('data-marked')) === 'true'), `with an In mark the duration says it is In to Out: ${await duration.getAttribute('title')}`)

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`deadends ${which}: ok`)
} finally {
  await browser.close()
  await server.close()
}
