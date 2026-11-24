// Media in, film out, by hand: node tests/media.mjs [chromium|webkit]. The plan "Film usable by
// hand", phase 6:
// - C3: File ▸ Export ▸ Media… opens the Export dialog on the active sequence; In to Out, a frame
//   size, a frame rate and a quality chosen there are what the written MP4 has (its sample entry's
//   size and its frame count, read from the file); the progress shows with its percentage, Cancel
//   stops the job and no file is written, a failed write says why; the app bar's Export MP4 still
//   exports at once;
// - C1: the Project panel's Import… asks the host for several files at once (`links/pick`,
//   `multiple`) and imports them in one go, with one status message that names each file that did
//   not come in and why, in Chinese; the dev host's chooser takes several workspace files and
//   several files from the computer;
// - C2: files dropped from the computer (File objects) on the Project panel are written beside the
//   project and imported; dropped on the Timeline they are imported and placed where they landed;
// - C4: a double-click opens an item in the Source monitor, F2 renames it.
// Each step asserts the engine's state and what is on screen.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

const which = process.argv[2] ?? 'chromium'
// FILM_MEDIA_SHOTS names a folder for the help document's screenshots (no assertion changes).
const shots = process.env.FILM_MEDIA_SHOTS ?? null
const server = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).pathname, server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' })
await server.listen()
const browser = await (which === 'webkit' ? webkit : chromium).launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true
    await page.waitForTimeout(80)
  }
  return false
}
const shot = async (name, clip) => {
  // The editor's frame (or `clip`), without the dev host's bar.
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, clip: clip ?? (await page.locator('#kit').boundingBox()) })
}
const bars = readFileSync(new URL('../public/sample/clips/bars.mp4', import.meta.url))

/** A second of 440 Hz tone as a 16-bit mono WAV, made here (no fixture file). */
function toneWav() {
  const rate = 8000
  const samples = rate
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** An MP4's video size (its `avc1` sample entry) and frame count (the `stsz` after it). */
function mp4Video(bytes) {
  const buffer = Buffer.from(bytes)
  // The sample entry (the file type box may name `avc1` as a brand first).
  const avc1 = buffer.indexOf('avc1', buffer.indexOf('stsd'))
  assert.ok(avc1 > 0, 'the movie has an H.264 track')
  const width = buffer.readUInt16BE(avc1 + 4 + 24)
  const height = buffer.readUInt16BE(avc1 + 4 + 26)
  const stsz = buffer.indexOf('stsz', avc1)
  const frames = buffer.readUInt32BE(stsz + 4 + 8)
  return { width, height, frames }
}

try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/dev.html?locale=zh-CN&pick=chooser`)
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 90_000 })
  const kit = page.frameLocator('#kit')
  await kit.getByTestId('film-clip-10').waitFor({ timeout: 60_000 })
  const frame = page.frames().find((candidate) => candidate.url().includes('index.html'))
  const details = async () => (await page.evaluate(() => window.devHost.connection().ai.inspect())).details
  const sequence = async () => (await details()).sequence
  const projectNames = async () => {
    const names = []
    const walk = (node) => (node?.children ?? []).forEach((child) => (child.children ? walk(child) : names.push(child.name)))
    walk((await details()).project?.root)
    return names
  }
  const items = async () => {
    const out = []
    const walk = (node) => (node?.children ?? []).forEach((child) => (child.children ? walk(child) : out.push(child)))
    walk((await details()).project?.root)
    return out
  }
  const files = () => page.evaluate(() => [...window.devHost.files.keys()])
  const message = async () => ((await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => '')) ?? '').trim()
  const clearMessage = async () => {
    if (await kit.getByTestId('film-message').count()) await kit.getByTestId('film-message').click().catch(() => undefined)
  }
  const put = (path, bytes) => page.evaluate(([p, b]) => window.devHost.files.set(p, { bytes: new Uint8Array(b).buffer, version: 1 }), [path, Array.from(bytes)])
  const undoSteps = async () => (await frame.evaluate(() => window.filmPreview.history()))?.undo?.length ?? 0

  // ---- C3: the Export dialog. In and Out on the sample sequence (frames 12 and 30) by keys, each
  // key waited for by the engine's state (a key pressed while a step's seek is on its way may be
  // dropped, as in the flow test's steps).
  const settings = (await sequence()).settings
  const frameTicks = (254_016_000_000 * settings.frame_rate.den) / settings.frame_rate.num
  const frameNow = async () => Math.round((await sequence()).playhead / frameTicks)
  const press = async (key, check, what) => {
    await kit.locator('.kui-app').focus()
    await page.keyboard.press(key)
    assert.ok(await until(check), `${what}: ${JSON.stringify({ frame: await frameNow(), in: (await sequence()).in, out: (await sequence()).out })}`)
  }
  await press('Home', async () => (await frameNow()) === 0, 'Home puts the playhead at the start')
  const stepTo = async (frame) => {
    while ((await frameNow()) < frame) {
      const from = await frameNow()
      await press('ArrowRight', async () => (await frameNow()) === from + 1, `Right steps one frame from ${from}`)
    }
  }
  await stepTo(12)
  await press('i', async () => (await sequence()).in === (await sequence()).playhead, 'I marks In at the playhead (frame 12)')
  await stepTo(30)
  await press('o', async () => (await sequence()).out === (await sequence()).playhead && (await sequence()).in != null, 'O marks Out at the playhead (frame 30), In kept')
  const marked = await sequence()
  const fps = marked.settings.frame_rate.num / marked.settings.frame_rate.den
  // The Out mark includes its frame.
  const inOutSeconds = (marked.out - marked.in) / 254_016_000_000 + 1 / fps
  await kit.getByTestId('film-menu-File').click()
  await kit.locator('[data-kit-ui-id="menu:File/Export"]').hover()
  await kit.getByTestId('film-control-file.exportMedia').click()
  const dialog = kit.getByTestId('film-export-dialog')
  await dialog.waitFor({ timeout: 5000 })
  const sequenceShown = await kit.getByTestId('film-export-sequence').evaluate((select) => select.selectedOptions[0]?.textContent ?? '')
  assert.ok(sequenceShown.includes(marked.name) && sequenceShown.includes('当前序列'), `the dialog opens on the active sequence, by name: ${sequenceShown}`)
  assert.ok(await until(async () => (await kit.getByTestId('film-export-range').inputValue()) === 'inOut'), 'with In and Out marked, the range is In to Out')
  assert.match(await kit.getByTestId('film-export-target').textContent(), /Sample\.mp4/, 'the file it writes is named: the project\'s name')
  assert.match(await kit.getByTestId('film-export-size').evaluate((select) => select.selectedOptions[0].textContent), /与序列相同（1280 × 720）/, 'the size is the sequence\'s by default')
  await kit.getByTestId('film-export-size').selectOption('360')
  await kit.getByTestId('film-export-rate').selectOption('25')
  await kit.getByTestId('film-export-quality').selectOption('small')
  assert.match(await kit.getByTestId('film-export-summary').textContent(), /640 × 360，25 帧\/秒/, 'the summary shows what will be written')
  await shot('media-1-export-dialog', null)
  const moviesBefore = (await files()).filter((name) => name.endsWith('.mp4'))
  await kit.getByTestId('film-export-start').click()
  let sawProgress = null
  const done = await until(async () => {
    if (sawProgress == null && (await kit.getByTestId('film-export-progress-text').count())) sawProgress = await kit.getByTestId('film-export-progress-text').textContent()
    return (await kit.getByTestId('film-export-result').getAttribute('data-result')) === 'done'
  }, 60_000)
  assert.ok(done, `the export finishes: ${await kit.getByTestId('film-export-result').textContent().catch(() => null)} ${await message()}`)
  assert.equal(await kit.getByTestId('film-export-result').textContent(), '已导出为 Sample.mp4', 'and says where it went, in Chinese')
  assert.ok(sawProgress == null || /^正在导出 .+… \d+%/.test(sawProgress), `the progress shows its percentage: ${sawProgress}`)
  assert.ok(!moviesBefore.includes('films/Sample.mp4') && (await files()).includes('films/Sample.mp4'), 'the movie is written beside the project, under the project\'s name')
  const movie = mp4Video(await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.mp4').bytes))))
  assert.deepEqual([movie.width, movie.height], [640, 360], `the movie has the chosen size: ${JSON.stringify(movie)}`)
  const wanted = inOutSeconds * 25
  assert.ok(Math.abs(movie.frames - wanted) <= 1.5 && movie.frames < (marked.duration / 254_016_000_000) * 25 - 10, `the movie holds In to Out at 25 fps: ${movie.frames} frames for ${wanted.toFixed(1)} (the sequence plays ${(marked.duration / 254_016_000_000 * fps).toFixed(0)} frames at ${fps.toFixed(3)})`)
  await shot('media-3-export-done', null)

  // Cancel stops the job: no second file.
  await kit.getByTestId('film-export-range').selectOption('entire')
  await kit.getByTestId('film-export-size').selectOption('2160')
  await kit.getByTestId('film-export-quality').selectOption('high')
  await kit.getByTestId('film-export-start').click()
  assert.ok(await until(async () => (await kit.getByTestId('film-export-progress').count()) === 1, 10_000), 'the second export runs')
  await shot('media-2-export-progress', null)
  assert.equal(await kit.getByTestId('film-export-sequence').isDisabled(), true, 'its choices wait while it runs')
  await kit.getByTestId('film-export-cancel').click()
  assert.ok(await until(async () => (await kit.getByTestId('film-export-result').getAttribute('data-result')) === 'cancelled', 20_000), 'Cancel stops it')
  assert.equal(await kit.getByTestId('film-export-result').textContent(), '已取消导出，没有写出文件')
  await page.waitForTimeout(400)
  assert.deepEqual((await files()).filter((name) => name.endsWith('.mp4')).sort(), [...moviesBefore, 'films/Sample.mp4'].sort(), 'and no file is written')
  assert.equal(await kit.getByTestId('film-exporting').count(), 0, 'the status bar has no export left')

  // A write the host refuses says why, in the dialog.
  await kit.getByTestId('film-export-size').selectOption('360')
  await kit.getByTestId('film-export-quality').selectOption('small')
  await page.evaluate(() => {
    const store = window.devHost.files
    const set = store.set
    store.set = function (path, value) {
      if (path.endsWith('.mp4')) {
        store.set = set
        throw new Error('disk full')
      }
      return set.call(this, path, value)
    }
  })
  await kit.getByTestId('film-export-start').click()
  assert.ok(await until(async () => (await kit.getByTestId('film-export-result').getAttribute('data-result')) === 'failed', 60_000), 'a failed write is reported')
  assert.match(await kit.getByTestId('film-export-result').textContent(), /^导出失败：.*disk full/, 'with why, in Chinese')
  await kit.getByTestId('film-export-close').click()
  assert.equal(await dialog.count(), 0, 'Close closes the dialog')
  // The app bar's Export MP4 still exports at once, without the dialog.
  await clearMessage()
  await kit.getByTestId('film-export').click()
  assert.ok(await until(async () => (await files()).includes('films/Sample 2.mp4'), 60_000), 'Export MP4 exports with one click')
  assert.equal(await dialog.count(), 0, 'and opens no dialog')

  // ---- C1: several files at once from the Project panel's Import…
  await put('clips/two.mp4', bars)
  await put('clips/tone.wav', toneWav())
  await put('clips/broken.mp4', bars.subarray(0, 12))
  await clearMessage()
  const namesBefore = await projectNames()
  const stepsBefore = await undoSteps()
  await kit.getByTestId('film-project-import').click()
  const chooser = page.locator('[data-dev-host-chooser]')
  await chooser.waitFor({ timeout: 5000 })
  assert.match(await chooser.textContent(), /可多选/, 'the host\'s chooser takes several files')
  for (const path of ['clips/two.mp4', 'clips/tone.wav', 'clips/broken.mp4']) await chooser.locator(`button[data-path="${path}"]`).click()
  await shot('media-4-import-chooser', null)
  await chooser.locator('button[data-action="ok"]').click()
  assert.ok(await until(async () => (await projectNames()).length === namesBefore.length + 2, 20_000), `two of the three come in: ${JSON.stringify(await projectNames())}`)
  const names = await projectNames()
  assert.ok(names.includes('two.mp4') && names.includes('tone.wav') && !names.includes('broken.mp4'), JSON.stringify(names))
  assert.ok(await until(async () => /^已导入 2 个文件；没有导入：broken\.mp4（.+）$/.test(await message())), `one message, naming the file that did not come in: ${await message()}`)
  // The engine keeps one undo step per file imported (`Import two.mp4`, `Import tone.wav`), as upstream.
  assert.equal(await undoSteps(), stepsBefore + 2, `one undo step per file that came in: ${JSON.stringify((await frame.evaluate(() => window.filmPreview.history()))?.undo?.slice(-3))}`)

  // Several from the computer through the chooser's "从电脑选择…" (copied into the workspace).
  await clearMessage()
  await kit.getByTestId('film-project-import').click()
  await chooser.waitFor({ timeout: 5000 })
  await chooser.locator('input[type="file"]').setInputFiles([
    { name: 'computer-a.mp4', mimeType: 'video/mp4', buffer: bars },
    { name: 'computer-b.wav', mimeType: 'audio/wav', buffer: toneWav() },
  ])
  assert.ok(await until(async () => (await projectNames()).includes('computer-a.mp4') && (await projectNames()).includes('computer-b.wav'), 20_000), 'files chosen on the computer come in together')
  assert.ok(await until(async () => (await message()) === '已导入 2 个文件'), `with one message: ${await message()}`)

  // ---- C2: files dropped from the computer on the Project panel.
  const dropOn = async (testId, at, entries) => {
    const target = kit.getByTestId(testId)
    const point = await target.evaluate((element, where) => {
      const box = element.getBoundingClientRect()
      return { x: box.left + (where?.x ?? box.width / 2), y: box.top + (where?.y ?? box.height / 2) }
    }, at)
    const transfer = await frame.evaluateHandle((list) => {
      const data = new DataTransfer()
      for (const entry of list) data.items.add(new File([new Uint8Array(entry.bytes)], entry.name, { type: entry.type }))
      return data
    }, entries.map((entry) => ({ ...entry, bytes: Array.from(entry.bytes) })))
    const init = { dataTransfer: transfer, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true }
    await target.dispatchEvent('dragenter', init)
    await target.dispatchEvent('dragover', init)
    return { transfer, init, target }
  }
  await clearMessage()
  const projectDrop = await dropOn('film-project', null, [
    { name: 'dropped.mp4', type: 'video/mp4', bytes: bars },
    { name: 'dropped.wav', type: 'audio/wav', bytes: toneWav() },
    { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('not media') },
  ])
  assert.equal(await kit.getByTestId('film-project').getAttribute('data-files-over'), 'true', 'files dragged over the Project panel outline it')
  assert.equal(await kit.getByTestId('film-project-files-over').textContent(), '把文件拖到这里导入')
  await shot('media-5-drop-project', null)
  await projectDrop.target.dispatchEvent('drop', projectDrop.init)
  assert.ok(await until(async () => (await projectNames()).includes('dropped.mp4') && (await projectNames()).includes('dropped.wav'), 20_000), `the dropped media come in: ${JSON.stringify(await projectNames())}`)
  assert.ok((await files()).includes('films/dropped.mp4') && (await files()).includes('films/dropped.wav'), 'written beside the project')
  assert.ok(await until(async () => (await message()) === '已导入 2 个文件；没有导入：notes.txt（不支持这种文件）'), `one message: ${await message()}`)
  assert.equal(await kit.getByTestId('film-project').getAttribute('data-files-over'), null)

  // Dropped on the Timeline: imported and placed where it landed (V2, at the second second).
  const tps = 254_016_000_000
  const clip10 = (await sequence()).video[0].items[0]
  const clipBox = await kit.getByTestId('film-clip-10').boundingBox()
  const pps = clipBox.width / (clip10.duration / tps)
  const lane = await kit.getByTestId('film-track-Video 2').boundingBox()
  const timeline = await kit.getByTestId('film-timeline').evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { x: box.left, y: box.top }
  })
  const pageFrame = await page.locator('#kit').boundingBox()
  const at = { x: clipBox.x - pageFrame.x - timeline.x + pps * 0.5, y: lane.y - pageFrame.y - timeline.y + lane.height / 2 }
  const v2Before = (await sequence()).video[1].items.length
  const timelineDrop = await dropOn('film-timeline', at, [{ name: 'on-timeline.mp4', type: 'video/mp4', bytes: bars }])
  assert.equal(await kit.getByTestId('film-timeline-drop').count(), 1, 'the Timeline shows where it will land')
  await shot('media-6-drop-timeline', null)
  await timelineDrop.target.dispatchEvent('drop', timelineDrop.init)
  assert.ok(await until(async () => (await sequence()).video[1].items.length === v2Before + 1, 20_000), 'the dropped file is placed on V2')
  const placed = (await sequence()).video[1].items.at(-1)
  const placedItem = (await items()).find((item) => item.name === 'on-timeline.mp4')
  assert.ok(placedItem && placed.item === placedItem.item, `it is the dropped file: ${JSON.stringify({ placed, placedItem })}`)
  assert.ok(Math.abs(placed.start / tps - 0.5) <= 0.1, `where it was dropped: ${placed.start / tps} s`)
  assert.equal(await kit.getByTestId('film-timeline-drop').count(), 0)

  // ---- C4: a double-click opens an item in the Source monitor; F2 renames it.
  await kit.getByTestId('film-project-view-list').click()
  const row = kit.getByTestId(`film-project-item-${placedItem.item}`)
  await row.waitFor({ timeout: 5000 })
  await row.dblclick()
  assert.ok(await until(async () => (await details()).project?.sourceItem === placedItem.item), 'a double-click opens the item in the Source monitor')
  // F2 renames the selected item in place; Enter keeps the name.
  await row.click()
  assert.ok(await until(async () => (await row.getAttribute('aria-selected')) === 'true'), 'a click selects the item')
  await page.keyboard.press('F2')
  const field = kit.getByTestId(`film-project-rename-${placedItem.item}`)
  await field.waitFor({ timeout: 5000 })
  await field.fill('镜头一')
  await page.keyboard.press('Enter')
  assert.ok(await until(async () => (await projectNames()).includes('镜头一')), `F2 renames it: ${JSON.stringify(await projectNames())}`)

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`media (${which}): ok`)
} finally {
  await browser.close()
  await server.close()
}
