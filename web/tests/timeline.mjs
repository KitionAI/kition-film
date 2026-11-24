// The Timeline by hand, with a real pointer and keyboard: node tests/timeline.mjs [chromium|webkit].
// The plan "Film usable by hand", phase 4 (timeline completions):
// - a short Timeline shows every video track: V3 is not a sliver under the ruler;
// - the playhead's line through the tracks is grabbed and dragged (the ruler's scrub);
// - an audio clip's Volume line: dragged up or down it changes the clip's level (the level next to
//   the pointer), Cmd/Ctrl-click adds a keyframe, a keyframe dragged up or down changes its level and
//   sideways moves it in time, the line between two keyframes moves both, a chosen keyframe is
//   removed with Delete; every gesture one undo step;
// - fade handles at a free clip end's top corner: dragged in, a fade (a transition from or to
//   nothing) of that length, shown as a ramp while dragging; dragged again it changes, dragged back
//   to the end it is cleared; each one undo step;
// - the ruler: the In and Out marks dragged, a marker double-clicked opens its dialog;
// - context menus on empty track space and on the ruler, in Chinese, whose rows do what they say.
// Each step asserts the engine's state and what is on screen.
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { readCatalog } from '../parity/i18n.mjs'

const ZH = readCatalog(new URL('../src/i18n/upstream/zh-hans.tsv', import.meta.url)).table
const zh = (english) => ZH.get(english) ?? english
const which = process.argv[2] ?? 'chromium'
const shots = process.env.FILM_TIMELINE_SHOTS ?? null
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
const shot = async (name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, clip: { x: 0, y: 590, width: 1600, height: 390 } })
}
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/dev.html?locale=zh-CN`)
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 90_000 })
  const kit = page.frameLocator('#kit')
  await kit.getByTestId('film-clip-10').waitFor({ timeout: 60_000 })
  const frame = page.frames().find((candidate) => candidate.url().includes('index.html'))
  const sequence = async () => (await page.evaluate(() => window.devHost.connection().ai.inspect())).details.sequence
  const v1 = async () => (await sequence()).video[0]
  const a1 = async () => (await sequence()).audio[0]
  const undoSteps = async () => (await frame.evaluate(() => window.filmPreview.history()))?.undo?.length ?? 0
  const message = async () => ((await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => '')) ?? '').trim()
  const undo = async () => {
    await kit.locator('.kui-app').focus()
    await page.keyboard.press(`${mod}+z`)
  }
  const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
  const box = (testId) => kit.getByTestId(testId).boundingBox()
  /** A pointer drag in steps, `hold` run before the release. */
  const drag = async (from, to, hold = async () => undefined, steps = 12) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= steps; i += 1) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
      await page.waitForTimeout(30)
    }
    await page.waitForTimeout(120)
    await hold()
    await page.mouse.up()
  }
  const cursor = () => kit.getByTestId('film-timeline').evaluate((element) => element.style.cursor)
  if (process.env.DEBUG_TL) page.on('console', (m) => console.log('console:', m.text()))
  const tps = (await sequence()).ticksPerSecond ?? 254_016_000_000
  const clip10 = (await v1()).items[0]
  const frameTicks = Math.round(clip10.duration / clip10.durationFrames)

  // ---- B8: a short Timeline shows all three video tracks below the ruler, each whole.
  const ruler = await box('film-ruler')
  const videoHalf = await box('film-timeline-video')
  for (const name of ['Video 3', 'Video 2', 'Video 1']) {
    const lane = await box(`film-track-${name}`)
    assert.ok(lane && lane.y >= ruler.y + ruler.height - 0.5 && lane.y + lane.height <= videoHalf.y + videoHalf.height + 0.5, `${name} is whole below the ruler: ${JSON.stringify({ lane, ruler, videoHalf })}`)
    assert.ok(lane.height >= 30, `${name} is tall enough to use: ${lane.height}`)
  }
  const v3 = center(await box('film-track-Video 3'))
  const underPointer = await kit.locator('body').evaluate((_, at) => {
    const frameBox = window.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 }
    return document.elementFromPoint(at.x - frameBox.left, at.y - frameBox.top)?.closest('[data-testid]')?.getAttribute('data-testid') ?? null
  }, v3)
  assert.equal(underPointer, 'film-track-Video 3', 'a press in the middle of V3 lands on V3, not on the ruler')
  await shot('timeline-1-tracks')

  // ---- B4: the playhead's line through the tracks is dragged like the ruler: the timecode follows, the engine's playhead lands.
  const timecode = () => kit.getByTestId('film-timeline-timecode').locator('input').inputValue().catch(async () => (await kit.getByTestId('film-timeline-timecode').textContent()) ?? '')
  await kit.locator('.kui-app').focus()
  await page.keyboard.press('Home')
  assert.ok(await until(async () => (await sequence()).playhead === 0), 'Home puts the playhead at the start')
  const clipBox = await box('film-clip-10')
  const grip = await box('film-playhead-line')
  assert.ok(grip && grip.height > 100, `the line's grip runs through the tracks: ${JSON.stringify(grip)}`)
  const lane2 = await box('film-track-Video 2')
  const gripAt = { x: grip.x + grip.width / 2, y: lane2.y + lane2.height / 2 }
  await page.mouse.move(gripAt.x, gripAt.y)
  assert.equal(await kit.getByTestId('film-playhead-line').evaluate((element) => getComputedStyle(element).cursor), 'ew-resize', 'the line shows a sideways cursor')
  const playheadSteps = await undoSteps()
  const target = { x: clipBox.x + clipBox.width * 0.5, y: gripAt.y }
  let timecodeWhileDragging = null
  await drag(gripAt, target, async () => {
    timecodeWhileDragging = await timecode()
  })
  const expected = Math.round(((target.x - clipBox.x) / clipBox.width) * clip10.duration / frameTicks)
  assert.ok(await until(async () => Math.abs((await sequence()).playhead / frameTicks - expected) <= 1), `the playhead lands where the line was dropped: frame ${(await sequence()).playhead / frameTicks} for ${expected}`)
  assert.notEqual(timecodeWhileDragging, '00:00:00:00', `the timecode followed the line while dragging (${timecodeWhileDragging})`)
  assert.equal(await undoSteps(), playheadSteps, 'moving the playhead is no edit')
  await shot('timeline-2-playhead')

  // Taller audio tracks (the wrench's Expand All Tracks), so the Volume line has room.
  await kit.getByTestId('film-timeline-settings').click()
  await kit.getByTestId('film-timeline-expand-all').click()
  await page.keyboard.press('Escape')
  assert.ok(await until(async () => (await box('film-track-Audio 1')).height >= 60), 'the audio tracks are expanded')

  // ---- B1: the Volume line on A1's clip.
  const audioId = (await a1()).items[0].clip
  const volumeOf = async () => {
    const item = (await a1()).items.find((each) => each.clip === audioId)
    const level = item.effects.find((effect) => effect.effect === 'volume').params.level
    return { value: level.value, keys: level.keyframes }
  }
  /** The line's y at fraction `f` of the clip, in page points (read from what is drawn). */
  const lineAt = async (f) => {
    const svg = kit.getByTestId(`film-clip-volume-${audioId}`)
    const area = await svg.boundingBox()
    const points = (await svg.locator('.film-clip-volume-line').getAttribute('points')).split(' ').map((pair) => pair.split(',').map(Number))
    const x = area.width * f
    let y = points[0][1]
    for (let i = 1; i < points.length; i += 1) {
      const [x0, y0] = points[i - 1]
      const [x1, y1] = points[i]
      if (x <= x1) {
        y = x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1
        break
      }
    }
    return { x: area.x + x, y: area.y + y }
  }
  assert.equal((await volumeOf()).value, 0, 'the clip plays at 0 dB')
  let at = await lineAt(0.4)
  await page.mouse.move(at.x, at.y)
  assert.ok(await until(async () => (await cursor()) === 'ns-resize'), `the line shows an up-down cursor: ${await cursor()}`)
  assert.equal(await kit.getByTestId(`film-clip-volume-${audioId}`).getAttribute('data-hover'), 'true', 'the line is drawn thicker under the pointer')
  let steps = await undoSteps()
  let tip = null
  await drag(at, { x: at.x, y: at.y - 8 }, async () => {
    tip = await kit.getByTestId('film-timeline-tip').textContent().catch(() => null)
  })
  assert.ok(tip && /^\+\d+\.\d\d dB$/.test(tip), `the level shows next to the pointer while dragging: ${tip}`)
  assert.ok(await until(async () => (await volumeOf()).value > 1), `dragging the line up raises the level: ${(await volumeOf()).value} (${await message()})`)
  assert.equal(await undoSteps(), steps + 1, 'the drag is one undo step')
  const raised = (await volumeOf()).value
  assert.ok(Math.abs(Number.parseFloat(tip) - raised) < 0.01, `the level shown is the level set: ${tip} ${raised}`)
  await undo()
  assert.ok(await until(async () => (await volumeOf()).value === 0), 'one undo takes the drag back')
  await shot('timeline-3-volume')

  // Cmd/Ctrl-click on the line adds a keyframe, at a quarter and three quarters.
  for (const [f, count] of [[0.25, 1], [0.75, 2]]) {
    at = await lineAt(f)
    steps = await undoSteps()
    await page.mouse.move(at.x, at.y)
    await page.keyboard.down(mod)
    await page.mouse.down()
    await page.mouse.up()
    await page.keyboard.up(mod)
    assert.ok(await until(async () => (await volumeOf()).keys.length === count), `${mod}-click adds a keyframe: ${(await volumeOf()).keys.length} (${await message()})`)
    assert.equal(await undoSteps(), steps + 1, 'one undo step')
  }
  await kit.getByTestId(`film-clip-volume-key-${audioId}-1`).waitFor({ timeout: 5000 })
  const keyAt = async (index) => center(await box(`film-clip-volume-key-${audioId}-${index}`))
  // The first keyframe dragged down: its level falls, the other stays.
  let before = await volumeOf()
  steps = await undoSteps()
  at = await keyAt(0)
  await drag(at, { x: at.x, y: at.y + 10 })
  assert.ok(await until(async () => (await volumeOf()).keys[0].value < before.keys[0].value - 1), `the keyframe dragged down lowers it: ${JSON.stringify((await volumeOf()).keys)}`)
  assert.equal((await volumeOf()).keys[1].value, before.keys[1].value, 'the other keyframe stays')
  assert.equal((await volumeOf()).keys[0].mediaTime, before.keys[0].mediaTime, 'it stays in time')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  // The second keyframe dragged sideways: it moves in time, its level kept.
  before = await volumeOf()
  steps = await undoSteps()
  at = await keyAt(1)
  let drawnAway = false
  await drag(at, { x: at.x - 40, y: at.y }, async () => {
    drawnAway = Math.abs((await keyAt(1)).x - at.x) > 20
  })
  assert.ok(drawnAway, 'the keyframe is drawn where it is dragged')
  assert.ok(await until(async () => (await volumeOf()).keys[1].mediaTime < before.keys[1].mediaTime), `dragged left it moves earlier: ${JSON.stringify((await volumeOf()).keys)} (${await message()})`)
  assert.equal((await volumeOf()).keys[1].value, before.keys[1].value, 'its level is kept')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  // The line between the two dragged up: both keyframes rise by as much.
  before = await volumeOf()
  steps = await undoSteps()
  const k0 = await keyAt(0)
  const k1 = await keyAt(1)
  at = await lineAt(((k0.x + k1.x) / 2 - (await box(`film-clip-volume-${audioId}`)).x) / (await box(`film-clip-volume-${audioId}`)).width)
  await drag(at, { x: at.x, y: at.y - 10 })
  assert.ok(await until(async () => (await volumeOf()).keys[0].value > before.keys[0].value + 0.5), `the line between two keyframes raises both: ${JSON.stringify((await volumeOf()).keys)}`)
  const after = await volumeOf()
  assert.ok(Math.abs(after.keys[0].value - before.keys[0].value - (after.keys[1].value - before.keys[1].value)) < 0.01, 'both by as much')
  assert.equal(after.keys.length, 2, 'no keyframe added')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  // A click chooses the first keyframe; Delete removes it, one undo step.
  at = await keyAt(0)
  await page.mouse.click(at.x, at.y)
  assert.ok(await until(async () => (await kit.getByTestId(`film-clip-volume-key-${audioId}-0`).getAttribute('data-selected')) === 'true'), 'a click chooses the keyframe')
  steps = await undoSteps()
  const remaining = (await volumeOf()).keys[1].mediaTime
  await page.keyboard.press('Delete')
  assert.ok(await until(async () => (await volumeOf()).keys.length === 1), `Delete removes the chosen keyframe (${await message()})`)
  assert.equal((await volumeOf()).keys[0].mediaTime, remaining, 'the other one stays')
  assert.equal((await a1()).items.length, 1, 'the clip stays')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  await shot('timeline-4-keyframes')

  // ---- B2: fade handles. V1's clip: dragged in from its In, a fade in of that length.
  const handle = async (edge, id) => center(await box(`film-clip-fade-${edge}-${id}`))
  await page.mouse.move(center(await box('film-clip-10')).x, center(await box('film-clip-10')).y)
  assert.equal(await kit.getByTestId('film-clip-fade-in-10').evaluate((element) => getComputedStyle(element).opacity), '1', 'the fade handles show while the pointer is over the clip')
  let from = await handle('in', 10)
  await page.mouse.move(from.x, from.y)
  assert.ok(await until(async () => (await cursor()) === 'ew-resize'), `the handle shows a sideways cursor: ${await cursor()}`)
  steps = await undoSteps()
  let ramp = false
  await drag(from, { x: from.x + 60, y: from.y }, async () => {
    ramp = (await kit.getByTestId('film-timeline-fade-ramp').count()) === 1
    tip = await kit.getByTestId('film-timeline-tip').textContent().catch(() => null)
  })
  assert.ok(ramp, 'the ramp shows while dragging')
  assert.ok(tip && /^\d\d:\d\d:\d\d[:;]\d\d$/.test(tip), `the fade's length shows next to the pointer: ${tip}`)
  const fadeIn = async () => (await v1()).transitions.find((each) => each.to === 10 && each.from == null) ?? null
  assert.ok(await until(async () => (await fadeIn()) != null), `releasing makes a fade in (${await message()})`)
  let fade = await fadeIn()
  assert.equal(fade.start, clip10.start, 'it starts at the clip In')
  const [hh, mm, ss, ff] = tip.split(/[:;]/).map(Number)
  const shownFrames = ((hh * 60 + mm) * 60 + ss) * Math.round(tps / frameTicks) + ff
  assert.equal(Math.round(fade.duration / frameTicks), shownFrames, `its length is the one shown: ${fade.duration / frameTicks} frames, ${tip}`)
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  // Dragged further, the same fade is longer.
  from = await handle('in', 10)
  steps = await undoSteps()
  await drag(from, { x: from.x + 40, y: from.y })
  assert.ok(await until(async () => (await fadeIn())?.duration > fade.duration), 'dragged further it is longer')
  assert.equal((await fadeIn()).id, fade.id, 'the same fade')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  // Dragged back to the clip's In, it is cleared.
  from = await handle('in', 10)
  steps = await undoSteps()
  await drag(from, { x: (await box('film-clip-10')).x - 20, y: from.y })
  assert.ok(await until(async () => (await fadeIn()) == null), 'dragged back to the In the fade is cleared')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  // A1's clip: a fade out at its Out.
  from = await handle('out', audioId)
  steps = await undoSteps()
  await drag(from, { x: from.x - 50, y: from.y })
  const fadeOut = async () => (await a1()).transitions.find((each) => each.from === audioId && each.to == null) ?? null
  assert.ok(await until(async () => (await fadeOut()) != null), `an audio clip fades out from its Out (${await message()})`)
  const audioItem = (await a1()).items[0]
  assert.equal((await fadeOut()).start + (await fadeOut()).duration, audioItem.start + audioItem.duration, 'it ends at the clip Out')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  await shot('timeline-5-fades')

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`timeline ${which}: ok`)
} finally {
  await browser.close()
  await server.close()
}
