import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures.mjs'

// A project changed outside Kition keeps its replica (Kit UI protocol UI-R1, section 7;
// kit-editor's `replicaMergesFile`), and the person's view is their view state (section 7n),
// never the file's. Through the development host with a stored replica, checkpoints and view state.

const PATH = 'films/Sample.kfilm'
// The kit's schema, as Kition sends it with `ai/changes` (the engine does not describe its own).
const SCHEMA = JSON.parse(readFileSync(new URL('../../../crates/kdm/kdm-model/model/schema.json', import.meta.url), 'utf8'))
const version = page => page.evaluate(path => window.devHost.files.get(path).version, PATH)
const bytes = page => page.evaluate(path => Array.from(new Uint8Array(window.devHost.files.get(path).bytes)), PATH)
const text = list => Buffer.from(list).toString('utf8')

async function save(film, page) {
  const before = await version(page)
  await film.focus()
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => version(page), { timeout: 30_000 }).toBeGreaterThan(before)
}

test('UI-R1 a .kfilm changed outside merges into the stored replica as one import; its lineage and checkpoints stay', async ({ film, page }) => {
  test.setTimeout(120_000)
  await film.open('&replica=1&checkpoints=1&replica-merges-file=1')
  // The person's edit, saved: the host keeps the replica, and a checkpoint of that version.
  const { item } = await film.command('file.newColorMatte', { color: '#00ff00', seconds: 2 })
  expect(typeof item).toBe('number')
  await save(film, page)
  expect(await page.evaluate(path => window.devHost.history.replica(path) != null, PATH), 'the save stored the replica').toBe(true)
  const checkpoint = await page.evaluate(() => window.devHost.recordCheckpoint({ origin: 'save' }))
  expect(checkpoint, 'a checkpoint of the saved version').toBeTruthy()
  const since = await page.evaluate(() => window.devHost.connection().ai.version())
  const root = JSON.stringify((await film.details()).project.root)

  // Another program renames the sequence in the file; the document reopens with the stored replica.
  const saved = text(await bytes(page))
  expect(saved).toContain('"name":"Sequence 01"')
  const changed = Array.from(Buffer.from(saved.replace('"name":"Sequence 01"', '"name":"Changed outside"'), 'utf8'))
  await page.evaluate(list => window.devHost.reopenChanged(new Uint8Array(list).buffer), changed)
  await expect.poll(async () => JSON.stringify((await film.details()) ?? null).includes('Changed outside'), { timeout: 45_000 }).toBe(true)
  await film.kit.getByTestId('film-program-zoom').waitFor()
  const after = JSON.stringify((await film.details()).project.root)
  expect(after, 'the outside change shows').toContain('Changed outside')
  expect(after.replaceAll('Changed outside', 'Sequence 01'), 'and the rest is the project the person saved, their matte too').toEqual(root)

  // The replica's lineage continued: its history holds the version before the change, and what
  // changed since is the outside rename (one import), not a replica started over.
  const answer = await page.evaluate(([since, schema]) => window.devHost.connection().ai.changes(since, schema), [since, SCHEMA])
  expect(answer.changes, `the replica still holds the earlier version: ${JSON.stringify(answer).slice(0, 400)}`).not.toBeNull()
  expect(JSON.stringify(answer.changes)).toContain('Changed outside')
  expect(answer.changes.created ?? [], 'no object made anew').toEqual([])
  expect(answer.changes.deleted ?? [], 'no object dropped').toEqual([])
  expect(await page.evaluate(path => window.devHost.history.replica(path) != null, PATH), 'the replica is still kept').toBe(true)
  await save(film, page)
  const kept = await page.evaluate(path => window.devHost.history.checkpoints(path), PATH)
  expect(kept.some(entry => entry.id === checkpoint.id && entry.available), `the earlier checkpoint stays available: ${JSON.stringify(kept)}`).toBe(true)
})

test('7n the open sequence is the person\'s view state, kept by the host and put back on reopening, never in the file', async ({ film, page }) => {
  test.setTimeout(120_000)
  await film.open('&replica=1')
  const first = (await film.command('state.inspect')).active_sequence
  const { sequence } = await film.command('file.newSequence', { name: 'Second' })
  expect(sequence).not.toBe(first)
  // The editor keeps the view with the host as it changes, and again with each save.
  const viewState = () => page.evaluate(path => window.devHost.history.viewState(path), PATH)
  await expect.poll(async () => (await viewState()).state?.view?.active_sequence ?? null, { timeout: 15_000 }).toBe(sequence)
  await save(film, page)
  const kept = await viewState()
  expect(kept.state?.v, `the view state kept: ${JSON.stringify(kept)}`).toBe(1)
  expect(kept.state.view.active_sequence).toBe(sequence)
  expect(kept.state.view.open_sequences).toEqual([first, sequence])
  const file = text(await bytes(page))
  for (const field of ['open_sequences', 'active_sequence', '"view"']) expect(file, `the file holds no view (${field})`).not.toContain(field)

  // Reopened as its last save left it: the second sequence is open again, from the view state.
  await page.evaluate(() => window.devHost.reload())
  await expect.poll(() => film.frame()?.evaluate(() => typeof window.filmPreview?.run === 'function').catch(() => false), { timeout: 45_000 }).toBe(true)
  await expect.poll(async () => (await film.command('state.inspect').catch(() => null))?.active_sequence ?? null, { timeout: 45_000 }).toBe(sequence)
  expect((await film.command('state.inspect')).open_sequences).toEqual([first, sequence])
})
