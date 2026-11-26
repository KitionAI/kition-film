// An agent's draft and a restored version in the editor (Kit UI protocol sections 7d and 7m),
// through the development host with `?replica=1&checkpoints=1`: node tests/drafts.mjs [chromium|webkit]
// - the person adds a marker (Markers ▸ Add Marker); an agent's draft adds a marker of its own; the
//   draft's comparison lists it and the document does not show it; the person adds another marker
//   meanwhile; the draft is accepted: the Markers panel lists all three;
// - one Undo (the editor's Undo button) takes back the draft's marker only, Redo brings it back;
// - a checkpoint of the saved film, a marker added after it, the checkpoint restored through the
//   host: the markers are the checkpoint's; one Undo brings the later marker back.
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

const which = process.argv[2] ?? 'chromium'
const server = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).pathname, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
await server.listen()
const browser = await (which === 'webkit' ? webkit : chromium).launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const kit = page.frameLocator('#kit')
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const until = async (check, message) => {
  for (let n = 0; n < 300; n += 1) {
    if (await check().catch(() => false)) return
    await page.waitForTimeout(100)
  }
  assert.fail(message)
}
const path = 'films/Sample.kfilm'
const T = 254_016_000_000 // ticks per second
const editor = () => page.frames().find((candidate) => candidate.url().includes('index.html'))
/** The open sequence's markers as the editor's inspect answer lists them: `name@start`, by time. */
const markers = async () => {
  const details = (await page.evaluate(async () => window.devHost.connection().ai.inspect())).details
  return (details.sequence?.markers ?? []).map((marker) => `${marker.name}@${marker.start}`).sort()
}
const named = async (name) => (await markers()).some((each) => each.startsWith(`${name}@`))
/** The agent runs `steps` in its draft. */
const inDraft = (steps) => page.evaluate(async (list) => window.devHost.connection().ai.run(list, false, { draft: true }), steps)
/** The person adds a marker at `seconds` with Markers ▸ Add Marker (the playhead put there first). */
const addMarker = async (seconds) => {
  const before = (await markers()).length
  await editor().evaluate(async (time) => window.filmPreview.run('playhead.set', { time }), Math.round(seconds * T))
  await kit.getByTestId('film-menu-Markers').click()
  await kit.getByTestId('film-cmd-marker.add').click()
  await until(async () => (await markers()).length === before + 1, `the person's marker at ${seconds} s shows`)
}
/** The Markers panel's rows, as the editor draws them. */
const rows = () => kit.locator('[data-testid^="film-markers-row-"]').allTextContents()
const press = async (testId) => {
  await until(() => kit.getByTestId(testId).isEnabled(), `${testId} is enabled`)
  await kit.getByTestId(testId).click()
}
const version = () => page.evaluate((name) => window.devHost.files.get(name)?.version ?? 0, path)
let failures = 0

try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/dev.html?locale=en-US&replica=1&checkpoints=1`)
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 90_000 })
  await kit.getByTestId('film-clip-10').waitFor({ timeout: 60_000 })
  const start = await markers()

  // (a) The person adds a marker; the agent's draft adds one of its own and is compared.
  await addMarker(0.5)
  const first = await markers()
  await inDraft([{ command: 'playhead.set', params: { time: Math.round(1 * T) } }, { command: 'marker.add', params: { name: 'From the draft' } }])
  const comparison = await page.evaluate(async () => window.devHost.connection().draft.compare())
  assert.ok(comparison.summary.created.length >= 1, `the comparison lists the draft's marker: ${JSON.stringify(comparison.summary)}`)
  assert.deepEqual(await markers(), first, 'comparing changes nothing in the document')
  // The person adds another marker meanwhile, then accepts the draft (the host passes the agent's origin).
  await addMarker(1.5)
  const mine = await markers()
  const merged = await page.evaluate(() => window.devHost.connection().draft.merge({ kind: 'agent', principal: 'agent:test' }))
  assert.equal(merged.merged, true, 'the draft merged')
  await until(() => named('From the draft'), 'the merged marker shows')
  const all = await markers()
  assert.equal(all.length, mine.length + 1, 'one marker from the draft')
  for (const each of mine) assert.ok(all.includes(each), `the person's marker ${each} stays`)
  await kit.getByTestId('film-menu-Window').click()
  await kit.getByTestId('film-cmd-window.panel.Markers').click()
  await until(async () => (await rows()).some((row) => row.includes('From the draft')) && (await rows()).length === all.length, `the Markers panel lists every marker (${JSON.stringify(await rows())})`)
  console.log(`PASS ${which}: a draft accepted over the person's edits keeps both`)

  // (b) One Undo takes back the draft's marker only; Redo brings it back.
  await press('film-undo')
  await until(async () => !(await named('From the draft')), 'Undo takes the draft back')
  assert.deepEqual(await markers(), mine, 'the person\'s markers stay')
  await press('film-redo')
  await until(() => named('From the draft'), 'Redo brings the draft back')
  assert.deepEqual(await markers(), all)
  console.log(`PASS ${which}: one Undo takes back the draft only, Redo brings it back`)

  // (d) A checkpoint of the saved film; a marker after it; the checkpoint restored; Undo.
  const saved = await version()
  await kit.getByTestId('film-save').click()
  await until(async () => (await version()) > saved, 'saved')
  await until(() => page.evaluate((name) => window.devHost.history.replica(name) !== null, path), 'the replica is stored with the save')
  const checkpoint = await page.evaluate(() => window.devHost.recordCheckpoint({ origin: 'save' }))
  assert.ok(checkpoint?.id, 'a checkpoint is recorded')
  await addMarker(2)
  const later = await markers()
  await page.evaluate((id) => window.devHost.restoreCheckpoint(id), checkpoint.id)
  await until(async () => JSON.stringify(await markers()) === JSON.stringify(all), 'the restore gives back the checkpoint\'s markers')
  await press('film-undo')
  await until(async () => JSON.stringify(await markers()) === JSON.stringify(later), 'Undo takes the restore back')
  assert.notDeepEqual(later, start)
  console.log(`PASS ${which}: a restored version is one step of the person's Undo`)
  assert.deepEqual(errors, [], 'no page errors')
} catch (error) {
  failures += 1
  console.log(`FAIL ${which}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
} finally {
  if (errors.length) console.log(`page errors:\n${errors.slice(0, 8).join('\n')}`)
  await browser.close()
  await server.close()
}
process.exit(failures ? 1 : 0)
