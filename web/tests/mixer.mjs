// The Audio Track Mixer by hand: node tests/mixer.mjs [chromium|webkit]. The plan "Film usable by
// hand", phase 7:
// - D1: Window ▸ Audio Track Mixer shows one strip per audio track and the Mix, named; a fader
//   dragged with a real pointer follows it (its level shown) and sets the track's volume on
//   release as one undo step, on upstream's taper; a double-click puts it back at 0 dB; the pan
//   slider sets the pan as one undo step; the Mix strip's meter moves while the program plays;
// - D2: Mute and Solo in the mixer are the track headers' own, both ways.
// Each step asserts the engine's state (mixer.inspect) and what is on screen.
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

const which = process.argv[2] ?? 'chromium'
// FILM_MIXER_SHOTS names a folder for the help document's screenshots (no assertion changes).
const shots = process.env.FILM_MIXER_SHOTS ?? null
const server = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).pathname, server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' })
await server.listen()
const browser = await (which === 'webkit' ? webkit : chromium).launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true
    await page.waitForTimeout(80)
  }
  return false
}
/** The taper of upstream's faders (`volumeBand.ts`), for where a level sits on the track. */
const TAPER = [[-96, 0], [-60, 0.05], [-40, 0.14], [-30, 0.24], [-20, 0.38], [-12, 0.52], [-6, 0.64], [0, 0.76], [6, 0.88], [15, 1]]
const dbToPos = (db) => {
  for (let i = 1; i < TAPER.length; i += 1) if (db <= TAPER[i][0]) return TAPER[i - 1][1] + (TAPER[i][1] - TAPER[i - 1][1]) * ((db - TAPER[i - 1][0]) / (TAPER[i][0] - TAPER[i - 1][0]))
  return 1
}

try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/dev.html?locale=zh-CN`)
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 90_000 })
  const kit = page.frameLocator('#kit')
  await kit.getByTestId('film-clip-10').waitFor({ timeout: 60_000 })
  const frame = page.frames().find((candidate) => candidate.url().includes('index.html'))
  await frame.waitForFunction(() => typeof window.filmPreview?.run === 'function', null, { timeout: 30_000 })
  const mixer = async () => frame.evaluate(() => window.filmPreview.run('mixer.inspect', {}))
  const strip = async (ref) => {
    const answer = await mixer()
    const value = typeof answer === 'string' ? JSON.parse(answer) : answer
    return value.strips.find((each) => each.ref === ref)
  }
  const undoSteps = async () => (await frame.evaluate(() => window.filmPreview.history()))?.undo?.length ?? 0
  const sequence = async () => (await page.evaluate(() => window.devHost.connection().ai.inspect())).details.sequence

  // ---- D1: Window ▸ Audio Track Mixer.
  await kit.getByTestId('film-menu-Window').click()
  const row = kit.getByTestId('film-control-window.panel.AudioTrackMixer')
  assert.equal((await row.textContent()).trim().startsWith('音频轨道混合器'), true, `the Window row reads in Chinese: ${await row.textContent()}`)
  await row.click()
  await kit.getByTestId('film-mixer').waitFor({ timeout: 10_000 })
  const audioTracks = (await sequence()).audio.length
  const strips = await kit.locator('[data-testid^="film-mixer-strip-"]').evaluateAll((items) => items.map((item) => item.getAttribute('data-testid').slice('film-mixer-strip-'.length)))
  assert.deepEqual(strips, [...Array.from({ length: audioTracks }, (_, index) => `A${index + 1}`), 'Mix'], 'one strip per audio track, then the Mix')
  assert.match(await kit.getByTestId('film-mixer-name-A1').textContent(), /^A1/, 'each strip is named')
  assert.equal(await kit.getByTestId('film-mixer-name-Mix').textContent(), '混合', 'the Mix reads in Chinese')
  assert.equal(await kit.getByTestId('film-mixer-level-A1').textContent(), '0.0', 'a new track is at 0 dB')
  if (shots) await kit.getByTestId('film-mixer').screenshot({ path: `${shots}/mixer-1-strips.png` })

  // A1's fader dragged down to −12 dB: the level follows while dragging, the engine has it on release, one undo step.
  const fader = await kit.getByTestId('film-mixer-fader-A1').boundingBox()
  const yOf = (db) => fader.y + (1 - dbToPos(db)) * fader.height
  const x = fader.x + fader.width / 2
  const steps = await undoSteps()
  await page.mouse.move(x, yOf(0))
  await page.mouse.down()
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(x, yOf(0) + ((yOf(-12) - yOf(0)) * i) / 10)
    await page.waitForTimeout(30)
  }
  await page.waitForTimeout(150)
  const whileDragging = await kit.getByTestId('film-mixer-level-A1').textContent()
  if (shots) await kit.getByTestId('film-mixer').screenshot({ path: `${shots}/mixer-2-fader-drag.png` })
  await page.mouse.up()
  assert.ok(Math.abs(Number(whileDragging) + 12) <= 0.6, `the level follows the pointer while dragging: ${whileDragging}`)
  assert.ok(await until(async () => Math.abs((await strip('A1')).volumeDb + 12) <= 0.6), `the track's volume is −12 dB: ${(await strip('A1')).volumeDb}`)
  assert.ok(await until(async () => (await undoSteps()) === steps + 1), `one drag, one undo step: ${(await undoSteps()) - steps}`)
  assert.ok(await until(async () => Math.abs(Number(await kit.getByTestId('film-mixer-level-A1').textContent()) + 12) <= 0.6), 'the strip shows the level it has')
  await kit.locator('.kui-app').focus()
  await page.keyboard.press(`${mod}+z`)
  assert.ok(await until(async () => Math.abs((await strip('A1')).volumeDb) < 0.01), 'one undo takes the drag back')
  assert.ok(await until(async () => (await kit.getByTestId('film-mixer-level-A1').textContent()) === '0.0'))
  // Dragged again to the bottom: silence; a double-click puts it back at 0 dB.
  await page.mouse.move(x, yOf(0))
  await page.mouse.down()
  await page.mouse.move(x, fader.y + fader.height + 20, { steps: 8 })
  await page.mouse.up()
  assert.ok(await until(async () => (await strip('A1')).volumeDb <= -95), `at the bottom the track is silent: ${(await strip('A1')).volumeDb}`)
  assert.equal(await kit.getByTestId('film-mixer-level-A1').textContent(), '-∞')
  await kit.getByTestId('film-mixer-fader-A1').dblclick()
  assert.ok(await until(async () => Math.abs((await strip('A1')).volumeDb) < 0.01), 'a double-click puts it back at 0 dB')

  // The pan: a click three quarters along pans right, one undo step.
  const pan = await kit.getByTestId('film-mixer-pan-A1').boundingBox()
  const panSteps = await undoSteps()
  await page.mouse.click(pan.x + pan.width * 0.75, pan.y + pan.height / 2)
  // Where the click lands on the slider (its thumb's travel is a little shorter than the slider).
  assert.ok(await until(async () => (await strip('A1')).pan > 30 && (await strip('A1')).pan === Number(await kit.getByTestId('film-mixer-pan-A1').inputValue())), `the pan follows the click: ${(await strip('A1')).pan}`)
  assert.ok(await until(async () => (await undoSteps()) === panSteps + 1), `one undo step: ${(await undoSteps()) - panSteps}`)
  assert.match(await kit.getByTestId('film-mixer-pan-value-A1').textContent(), /^R \d+$/, 'and reads right of centre')

  // ---- D2: Mute and Solo are the track headers' own, both ways.
  await kit.getByTestId('film-mixer-mute-A1').click()
  assert.ok(await until(async () => (await strip('A1')).muted === true), 'Mute in the mixer mutes the track')
  assert.ok(await until(async () => (await kit.getByTestId('film-track-A1-mute').getAttribute('aria-pressed')) === 'true'), 'and the track header shows it')
  if (shots) await page.screenshot({ path: `${shots}/mixer-3-mute-both.png`, clip: await page.locator('#kit').boundingBox() })
  await kit.getByTestId('film-track-A1-mute').click()
  assert.ok(await until(async () => (await kit.getByTestId('film-mixer-mute-A1').getAttribute('aria-pressed')) === 'false'), 'the header unmutes it in the mixer')
  await kit.getByTestId('film-track-A1-solo').click()
  assert.ok(await until(async () => (await kit.getByTestId('film-mixer-solo-A1').getAttribute('aria-pressed')) === 'true' && (await strip('A1')).solo === true), 'the header\'s Solo shows in the mixer')
  await kit.getByTestId('film-mixer-solo-A1').click()
  assert.ok(await until(async () => (await kit.getByTestId('film-track-A1-solo').getAttribute('aria-pressed')) === 'false'), 'and the mixer\'s in the header')

  // The Mix meter moves while the program plays, and falls after a stop.
  const meterDb = () => kit.locator('[data-testid^="film-mixer-meter-Mix-"]').evaluateAll((items) => Math.max(...items.map((item) => Number(item.dataset.db))))
  await kit.locator('.kui-app').focus()
  await page.keyboard.press('Home')
  await page.keyboard.press(' ')
  let loudest = -Infinity
  const metered = await until(async () => (loudest = Math.max(loudest, await meterDb())) > -30, 8000)
  if (shots) await kit.getByTestId('film-mixer').screenshot({ path: `${shots}/mixer-4-playing.png` })
  await page.keyboard.press(' ')
  const fell = await until(async () => (await meterDb()) <= -60, 10_000)
  assert.ok(metered && fell, `the Mix meter shows the sound while it plays and falls after: ${JSON.stringify({ loudest, after: await meterDb() })}`)

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`mixer (${which}): ok`)
} finally {
  await browser.close()
  await server.close()
}
