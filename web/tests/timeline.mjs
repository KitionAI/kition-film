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
// - a keyframe dragged diagonally moves in time and level at once, one undo step;
// - the ruler: the In and Out marks dragged, a marker dragged along it, a marker double-clicked opens its dialog;
// - context menus on empty track space and on the ruler, in Chinese, whose rows do what they say;
// - an Option/Alt-drag of a clip copies it where it is dropped (drawn as a copy while dragging, the
//   copy cursor), the original stays, one undo step.
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
  assert.ok(await until(async () => (await cursor()) === 'ew-resize'), `the line shows a sideways cursor on empty track space: ${await cursor()}`)
  assert.equal(await kit.getByTestId('film-playhead').getAttribute('data-hover'), '', 'and is drawn thicker')
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
  // On a clip the line takes no press: a click there selects the clip, the playhead stays.
  const parked = (await sequence()).playhead
  const line = await box('film-playhead-line')
  await page.mouse.click(line.x + line.width / 2, center(await box('film-clip-10')).y)
  assert.ok(await until(async () => (await sequence()).selection?.includes(10)), 'a click on the clip under the line selects the clip')
  assert.equal((await sequence()).playhead, parked, 'and leaves the playhead')
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
    await shot('timeline-3-volume-drag')
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
  // The second keyframe dragged diagonally (left and down): earlier and quieter in one drag, one undo step.
  before = await volumeOf()
  steps = await undoSteps()
  at = await keyAt(1)
  let followed = false
  let drawnAt = null
  await drag(at, { x: at.x - 30, y: at.y + 10 }, async () => {
    const now = await keyAt(1)
    drawnAt = now
    followed = now.x < at.x - 15 && now.y > at.y + 5
    tip = await kit.getByTestId('film-timeline-tip').textContent().catch(() => null)
  })
  assert.ok(followed, `the keyframe is drawn under the pointer both ways while dragging: ${JSON.stringify({ at, drawnAt, keys: (await volumeOf()).keys })}`)
  assert.ok(tip && /dB$/.test(tip), `its level shows next to the pointer: ${tip}`)
  assert.ok(await until(async () => {
    const now = await volumeOf()
    return now.keys[1].mediaTime < before.keys[1].mediaTime && now.keys[1].value < before.keys[1].value - 0.5
  }), `dragged left and down it moves earlier and quieter: ${JSON.stringify((await volumeOf()).keys)} (${await message()})`)
  assert.equal((await volumeOf()).keys.length, 2, 'no keyframe added or lost')
  assert.equal((await volumeOf()).keys[0].value, before.keys[0].value, 'the other keyframe stays')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  await undo()
  assert.ok(await until(async () => JSON.stringify((await volumeOf()).keys) === JSON.stringify(before.keys)), `one undo takes the whole drag back: ${JSON.stringify((await volumeOf()).keys)}`)
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
  assert.ok(await until(async () => (await kit.getByTestId('film-clip-fade-in-10').evaluate((element) => getComputedStyle(element).opacity)) === '1'), 'the fade handles show while the pointer is over the clip')
  let from = await handle('in', 10)
  await page.mouse.move(from.x, from.y)
  assert.ok(await until(async () => (await cursor()) === 'ew-resize'), `the handle shows a sideways cursor: ${await cursor()}`)
  steps = await undoSteps()
  let ramp = false
  await drag(from, { x: from.x + 60, y: from.y }, async () => {
    ramp = (await kit.getByTestId('film-timeline-fade-ramp').count()) === 1
    tip = await kit.getByTestId('film-timeline-tip').textContent().catch(() => null)
    await shot('timeline-5-fade-drag')
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

  // ---- B6 (ruler) and B3: the ruler's menu sets In and Out where it was opened; the marks are dragged.
  const rulerAt = async (f) => {
    const clip = await box('film-clip-10')
    const area = await box('film-ruler')
    return { x: clip.x + clip.width * f, y: area.y + area.height / 2 }
  }
  const frameAt = (f) => Math.round(f * clip10.durationFrames)
  const near = (a, b) => Math.abs(a - b) <= 1
  const rulerMenu = async (f) => {
    const spot = await rulerAt(f)
    await page.mouse.click(spot.x, spot.y, { button: 'right' })
    await kit.getByTestId('film-ruler-menu').waitFor({ timeout: 5000 })
  }
  await rulerMenu(0.2)
  await shot('timeline-6-ruler-menu')
  assert.equal((await kit.getByTestId('film-ruler-menu-mark-in').textContent()).trim(), zh('Mark In'), 'the ruler menu reads 标记入点')
  assert.equal((await kit.getByTestId('film-ruler-menu-add-marker').textContent()).trim(), zh('Add Marker'))
  steps = await undoSteps()
  await kit.getByTestId('film-ruler-menu-mark-in').click()
  assert.ok(await until(async () => (await sequence()).in != null && near((await sequence()).in / frameTicks, frameAt(0.2))), `Mark In there: ${(await sequence()).in / frameTicks} for ${frameAt(0.2)} (${await message()})`)
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  await rulerMenu(0.7)
  await kit.getByTestId('film-ruler-menu-mark-out').click()
  assert.ok(await until(async () => (await sequence()).out != null && near((await sequence()).out / frameTicks + 1, frameAt(0.7))), `Mark Out there: ${(await sequence()).out / frameTicks}`)
  // The In mark's handle dragged right: drawn moving, then one Mark In there.
  let marks = await sequence()
  let handleBox = await box('film-ruler-in')
  assert.ok(handleBox, 'the In mark has a handle on the ruler')
  steps = await undoSteps()
  let moving = false
  await drag(center(handleBox), { x: center(handleBox).x + 60, y: center(handleBox).y }, async () => {
    moving = (await box('film-ruler-in')).x > handleBox.x + 30
  })
  assert.ok(moving, 'the In handle follows the drag')
  assert.ok(await until(async () => (await sequence()).in > marks.in + 2 * frameTicks), `the In mark moves later: ${marks.in / frameTicks} → ${(await sequence()).in / frameTicks}`)
  assert.equal((await sequence()).out, marks.out, 'the Out mark stays')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  // The Out mark's handle dragged left.
  marks = await sequence()
  handleBox = await box('film-ruler-out')
  steps = await undoSteps()
  await drag(center(handleBox), { x: center(handleBox).x - 50, y: center(handleBox).y })
  assert.ok(await until(async () => (await sequence()).out < marks.out - 2 * frameTicks), `the Out mark moves earlier: ${marks.out / frameTicks} → ${(await sequence()).out / frameTicks}`)
  assert.equal((await sequence()).in, marks.in, 'the In mark stays')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  // Dragged past the Out, the In stops at it.
  marks = await sequence()
  handleBox = await box('film-ruler-in')
  await drag(center(handleBox), { x: center(handleBox).x + 600, y: center(handleBox).y })
  assert.ok(await until(async () => (await sequence()).in === marks.out), `the In stops at the Out: ${(await sequence()).in / frameTicks} ${marks.out / frameTicks}`)
  await undo()
  assert.ok(await until(async () => (await sequence()).in === marks.in), 'undo')
  await shot('timeline-6-in-out')

  // A marker added from the ruler menu where it was opened; a double-click on it opens its dialog.
  await rulerMenu(0.4)
  steps = await undoSteps()
  await kit.getByTestId('film-ruler-menu-add-marker').click()
  assert.ok(await until(async () => (await sequence()).markers?.length === 1), `Add Marker there (${await message()})`)
  const marker = (await sequence()).markers[0]
  assert.ok(near(marker.start / frameTicks, frameAt(0.4)), `at the time right-clicked: ${marker.start / frameTicks} for ${frameAt(0.4)}`)
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  // Dragged along the ruler, the marker moves later: drawn moving, one marker.edit on release, one undo step.
  let markerFrom = await box(`film-marker-${marker.id}`)
  steps = await undoSteps()
  let markerMoving = false
  await drag({ x: markerFrom.x + 4, y: markerFrom.y + 5 }, { x: markerFrom.x + 64, y: markerFrom.y + 5 }, async () => {
    markerMoving = (await box(`film-marker-${marker.id}`)).x > markerFrom.x + 30
  })
  assert.ok(markerMoving, 'the marker follows the drag')
  const movedBy = Math.round((60 / (await box('film-clip-10')).width) * clip10.durationFrames)
  assert.ok(await until(async () => Math.abs((await sequence()).markers[0].start / frameTicks - (marker.start / frameTicks + movedBy)) <= 1), `the marker moves by the drag: ${(await sequence()).markers[0].start / frameTicks} for ${marker.start / frameTicks + movedBy} (${await message()})`)
  assert.equal((await sequence()).markers.length, 1, 'still one marker')
  assert.equal((await sequence()).markers[0].id, marker.id, 'the same marker')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  await undo()
  assert.ok(await until(async () => (await sequence()).markers[0].start === marker.start), 'one undo puts it back')
  assert.ok(await until(async () => Math.abs((await box(`film-marker-${marker.id}`)).x - markerFrom.x) < 1), 'and it is drawn back there')
  await shot('timeline-7-marker-drag')
  const markerBox = await box(`film-marker-${marker.id}`)
  await page.mouse.dblclick(markerBox.x + 4, markerBox.y + 5)
  await kit.getByTestId('film-dialog').waitFor({ timeout: 5000 })
  assert.ok(near((await sequence()).playhead / frameTicks, marker.start / frameTicks), 'a press on a marker puts the playhead on it')
  await kit.getByTestId('film-dialog-cancel').click()
  await kit.getByTestId('film-dialog').waitFor({ state: 'detached', timeout: 5000 })
  // The menu on the marker: Edit Marker… and Clear Selected Marker, which clears it.
  await page.mouse.click(markerBox.x + 4, markerBox.y + 5, { button: 'right' })
  await kit.getByTestId('film-ruler-menu').waitFor({ timeout: 5000 })
  assert.equal((await kit.getByTestId('film-ruler-menu-edit-marker').textContent()).trim(), zh('Edit Marker…'))
  steps = await undoSteps()
  await kit.getByTestId('film-ruler-menu-clear-marker').click()
  assert.ok(await until(async () => ((await sequence()).markers?.length ?? 0) === 0), `Clear Selected Marker clears it (${await message()})`)
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  // Clear In and Out.
  await rulerMenu(0.5)
  await kit.getByTestId('film-ruler-menu-clear-in-out').click()
  assert.ok(await until(async () => (await sequence()).in == null && (await sequence()).out == null), 'Clear In and Out')
  await shot('timeline-7-marker')

  // ---- B6 (tracks): empty track space's menu.
  // Places along the clip as it was before the cut below (the view does not move).
  const clipArea = await box('film-clip-10')
  const laneMenu = async (name, f) => {
    const lane = await box(`film-track-${name}`)
    const clip = clipArea
    await page.mouse.click(clip.x + clip.width * f, lane.y + lane.height / 2, { button: 'right' })
    await kit.getByTestId('film-lane-menu').waitFor({ timeout: 5000 })
  }
  await laneMenu('Video 2', 0.5)
  assert.equal((await kit.getByTestId('film-lane-menu-add-track').textContent()).trim(), zh('Add Track'), 'the menu reads 添加轨道')
  assert.equal(await kit.getByTestId('film-lane-menu-close-gap').getAttribute('aria-disabled').catch(() => null) ?? String(await kit.getByTestId('film-lane-menu-close-gap').isDisabled()), 'true', 'no gap on an empty track')
  steps = await undoSteps()
  const videoTracks = (await sequence()).video.length
  await kit.getByTestId('film-lane-menu-add-track').click()
  assert.ok(await until(async () => (await sequence()).video.length === videoTracks + 1), `Add Track adds a video track (${await message()})`)
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  await undo()
  assert.ok(await until(async () => (await sequence()).video.length === videoTracks), 'undo')
  // A gap on V1: the clip cut in two with the Razor, its first half cleared.
  await kit.locator('.kui-app').focus()
  const whole = await box('film-clip-10')
  await page.keyboard.press('c')
  await page.mouse.click(whole.x + whole.width / 2, whole.y + whole.height / 2)
  await page.keyboard.press('v')
  assert.ok(await until(async () => (await v1()).items.length === 2), 'the Razor cut V1 in two')
  const [firstHalf, secondHalf] = (await v1()).items
  await frame.evaluate((clip) => window.filmPreview.run('timeline.select', { clips: [clip], linked: false }), firstHalf.clip)
  await frame.evaluate(() => window.filmPreview.run('edit.delete', {}))
  assert.ok(await until(async () => (await v1()).items.length === 1), 'the first half is cleared: a gap')
  await laneMenu('Video 1', 0.25)
  await shot('timeline-8-lane-menu')
  steps = await undoSteps()
  await kit.getByTestId('film-lane-menu-close-gap').click()
  assert.ok(await until(async () => (await v1()).items[0].start === 0), `Close Gap moves the clip after it back (${await message()})`)
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  await undo()
  assert.ok(await until(async () => (await v1()).items[0].start === secondHalf.start), 'undo')
  // Select this track's clips from here: the second half (V1 only).
  await laneMenu('Video 1', 0.25)
  await kit.getByTestId('film-lane-menu-select-forward').click()
  // With Linked Selection on, the clip's sound joins it, as any selection does.
  const partner = (await a1()).items.find((item) => item.link != null && item.link === secondHalf.link)?.clip
  assert.ok(await until(async () => JSON.stringify([...(await sequence()).selection].sort()) === JSON.stringify([secondHalf.clip, partner].filter((id) => id != null).sort())), `the clips from here on V1 are selected: ${JSON.stringify((await sequence()).selection)}`)
  // Paste at the time right-clicked: the copied clip lands there on V1.
  await kit.locator('.kui-app').focus()
  await page.keyboard.press(`${mod}+c`)
  await page.waitForTimeout(200)
  await laneMenu('Video 1', 0.1)
  steps = await undoSteps()
  await kit.getByTestId('film-cmd-edit.paste').click()
  assert.ok(await until(async () => (await v1()).items.length === 2), `Paste puts a copy there (${await message()})`)
  assert.ok(near((await v1()).items[0].start / frameTicks, frameAt(0.1)), `at the time right-clicked: ${(await v1()).items[0].start / frameTicks} for ${frameAt(0.1)}`)
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  await shot('timeline-9-pasted')

  // ---- An Option/Alt-drag copies a clip: V1's last clip dropped on V2 further on.
  await frame.evaluate(() => window.filmPreview.run('timeline.select', { clips: [] }))
  assert.ok(await until(async () => ((await sequence()).selection?.length ?? 0) === 0), 'nothing selected')
  const source = (await v1()).items.at(-1)
  const sourceBox = await box(`film-clip-${source.clip}`)
  const lane2Box = await box('film-track-Video 2')
  const v1Count = (await v1()).items.length
  const audioCount = (await sequence()).audio.reduce((sum, track) => sum + track.items.length, 0)
  steps = await undoSteps()
  const grabAt = { x: sourceBox.x + Math.min(40, sourceBox.width / 2), y: sourceBox.y + sourceBox.height / 2 }
  const dropAt = { x: grabAt.x + 80, y: lane2Box.y + lane2Box.height / 2 }
  let copyShown = false
  let copyBox = null
  let copyCursor = ''
  let originalStays = false
  await page.keyboard.down('Alt')
  await drag(grabAt, dropAt, async () => {
    copyShown = (await kit.getByTestId(`film-clip-copy-${source.clip}`).count()) === 1
    copyBox = copyShown ? await box(`film-clip-copy-${source.clip}`) : null
    copyCursor = await cursor()
    originalStays = Math.abs((await box(`film-clip-${source.clip}`)).x - sourceBox.x) < 1
    await shot('timeline-10-copy-drag')
  })
  await page.keyboard.up('Alt')
  assert.ok(copyShown, 'the copy is drawn where it would land while dragging')
  assert.ok(copyBox.y >= lane2Box.y && copyBox.y + copyBox.height <= lane2Box.y + lane2Box.height + 0.5, 'on V2')
  assert.equal(copyCursor, 'copy', 'the pointer shows a copy')
  assert.ok(originalStays, 'the clip itself stays where it is while dragging')
  const v2 = async () => (await sequence()).video[1]
  assert.ok(await until(async () => (await v2()).items.length === 1), `the drop puts a copy on V2 (${await message()})`)
  const copy = (await v2()).items[0]
  assert.notEqual(copy.clip, source.clip, 'a new clip')
  assert.equal(copy.item, source.item, 'of the same media')
  assert.equal(copy.duration, source.duration, 'as long')
  // Where it was drawn when dropped (snapped as a move is).
  const drawnFrames = source.start / frameTicks + ((copyBox.x - sourceBox.x) / sourceBox.width) * (source.duration / frameTicks)
  assert.ok(Math.abs(copy.start / frameTicks - drawnFrames) <= 1, `where it was drawn when dropped: ${copy.start / frameTicks} for ${drawnFrames}`)
  assert.ok(copy.start > source.start, 'later than the original')
  const stayed = (await v1()).items.find((item) => item.clip === source.clip)
  assert.ok(stayed && stayed.start === source.start && stayed.duration === source.duration, 'the original stays where it was')
  assert.equal((await v1()).items.length, v1Count, 'nothing else on V1 changed')
  assert.equal((await sequence()).audio.reduce((sum, track) => sum + track.items.length, 0), audioCount, 'its sound was not copied (Alt-press takes one side)')
  assert.deepEqual((await sequence()).selection, [copy.clip], 'the copy is selected')
  assert.equal(await undoSteps(), steps + 1, 'one undo step')
  assert.ok(await until(async () => (await cursor()) !== 'copy'), 'the copy cursor goes with the drag')
  await undo()
  assert.ok(await until(async () => (await v2()).items.length === 0), 'one undo takes the copy away')
  assert.ok((await v1()).items.some((item) => item.clip === source.clip && item.start === source.start), 'and leaves the original')

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`timeline ${which}: ok`)
} finally {
  await browser.close()
  await server.close()
}
