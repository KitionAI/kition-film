// The Source waveform's own summary of an item's peaks (upstream `monitor_view.rs` `waveform`),
// read through the Timeline's queue without filling the Timeline's peaks cache.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWaveformSummary, loadWaveform, shownSummary, PAIRS_PER_CHUNK } from './waveform.ts'
import { createMediaQueue } from '../timeline/mediaQueue.ts'
import { createPeaks } from '../timeline/peaks.ts'

const TPS = 254_016_000_000
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const chunk = (level, pairs = PAIRS_PER_CHUNK) => Float32Array.from({ length: pairs * 2 }, (_, index) => (index % 2 === 0 ? -level : level))

test("columns fold each pixel's bins from 0, across chunks; null where a chunk has not arrived; an empty chunk reads flat", () => {
  const summary = createWaveformSummary(8 * TPS)
  summary.add(0, chunk(0.25))
  assert.deepEqual(summary.columns(4).map((column) => column && [column.lo, column.hi]), [[-0.25, 0.25], [-0.25, 0.25], null, null])
  assert.deepEqual(summary.state(), { all: false, any: true, sound: true })
  summary.add(1, chunk(0.5))
  assert.deepEqual(summary.columns(4).map((column) => column && [column.lo, column.hi]), [[-0.25, 0.25], [-0.25, 0.25], [-0.5, 0.5], [-0.5, 0.5]])
  const silent = createWaveformSummary(8 * TPS)
  silent.add(0, new Float32Array(0))
  silent.add(1, new Float32Array(0))
  assert.deepEqual(silent.columns(2), [{ lo: 0, hi: 0 }, { lo: 0, hi: 0 }])
  assert.deepEqual(silent.state(), { all: true, any: true, sound: false })
})

test("a clip longer than the Timeline's peaks cache: every column fills, and the Timeline's chunks stay cached", async () => {
  const queue = createMediaQueue({ idle: () => true })
  const reads = { timeline: 0, waveform: 0 }
  const invoke = async (_name, item) => {
    reads[item === 1 ? 'timeline' : 'waveform'] += 1
    return chunk(item === 1 ? 0.1 : 0.4)
  }
  // The Timeline's own peaks: a few chunks of item 1 in its 1000-entry cache.
  const peaks = createPeaks({ invoke, queue, max: 1000 })
  const timeline = [0, 1, 2].map((index) => ({ item: 1, revision: null, chunk: index }))
  for (const spec of timeline) peaks.request(spec, () => undefined)
  await settle()
  assert.ok(timeline.every((spec) => peaks.has(spec)))
  // A 70-minute clip (1050 chunks) in the Source waveform.
  const summary = createWaveformSummary(4200 * TPS)
  assert.equal(summary.chunks, 1050)
  let changes = 0
  const frames = []
  loadWaveform({ summary, item: 2, revision: null, queue, read: (item, start, seconds) => invoke('itemPeaks', item, start, seconds), schedule: (task) => (frames.push(task), () => undefined), onChange: () => (changes += 1) })
  for (let round = 0; round < 1100 && summary.state().all === false; round += 1) await settle()
  assert.equal(summary.state().all, true)
  assert.equal(reads.waveform, 1050)
  const columns = summary.columns(800)
  assert.equal(columns.filter((column) => column === null).length, 0, 'no column stays empty')
  assert.ok(columns.every((column) => column.hi === Math.fround(0.4) && column.lo === -Math.fround(0.4)))
  // The Timeline's entries were never pushed out, so it reads nothing again.
  assert.ok(timeline.every((spec) => peaks.has(spec)), "the Timeline's chunks are still cached")
  // Arrivals are batched: at most one change per scheduled frame, however many chunks landed in it.
  assert.ok(frames.length >= 1 && frames.length < 1050 / 8, String(frames.length))
  for (const task of frames.splice(0)) task()
  assert.ok(changes >= 1 && changes < 1050 / 8)
})

test('a cancelled load sends nothing that waits', async () => {
  let ran = 0
  const queue = createMediaQueue({ idle: () => false })
  const summary = createWaveformSummary(12 * TPS)
  const cancel = loadWaveform({ summary, item: 2, revision: 4, queue, read: async () => (ran += 1, chunk(0.2)), schedule: (task) => (task(), () => undefined), onChange: () => undefined })
  assert.equal(queue.pending(), 3)
  cancel()
  assert.equal(queue.pending(), 0)
  assert.equal(ran, 0)
})

test("going back to the waveform while it loads: a new summary's chunk never joins the old one's read, so every chunk lands", async () => {
  const queue = createMediaQueue({ idle: () => true })
  const pending = []
  const read = (item, start) => new Promise((resolve) => pending.push(() => resolve(chunk(0.3))))
  const frame = (task) => (task(), () => undefined)
  // Audio Waveform, then Composite while chunk 0 is in flight, then Audio Waveform again (or clip A, B, A).
  const first = createWaveformSummary(12 * TPS)
  const cancel = loadWaveform({ summary: first, item: 2, revision: null, queue, read, schedule: frame, onChange: () => undefined })
  await settle()
  assert.equal(pending.length, 1, 'chunk 0 in flight')
  cancel()
  const again = createWaveformSummary(12 * TPS)
  loadWaveform({ summary: again, item: 2, revision: null, queue, read, schedule: frame, onChange: () => undefined })
  for (let round = 0; round < 20 && !again.state().all; round += 1) {
    for (const answer of pending.splice(0)) answer()
    await settle()
  }
  assert.equal(again.has(0), true)
  assert.equal(again.state().all, true)
  assert.equal(again.columns(30).filter((column) => column === null).length, 0)
})

test("the waveform keeps a small window of reads queued, so the Timeline's reads asked meanwhile wait behind a few, not all", async () => {
  let idle = false
  const queue = createMediaQueue({ idle: () => idle })
  const order = []
  const summary = createWaveformSummary(400 * TPS)
  loadWaveform({ summary, item: 2, revision: null, queue, read: async (item, start) => (order.push(`wave ${start / 4}`), chunk(0.2)), schedule: (task) => (task(), () => undefined), onChange: () => undefined })
  assert.equal(queue.pending(), 8)
  queue.want('timeline:1@-/0', async () => order.push('timeline'), () => undefined)
  idle = true
  queue.pump()
  for (let round = 0; round < 400 && !summary.state().all; round += 1) await settle()
  assert.equal(summary.state().all, true)
  assert.ok(order.indexOf('timeline') <= 8, `the Timeline's read came at ${order.indexOf('timeline')}`)
  assert.equal(order.length, 101)
})

test('a bin two chunks share fills only once both have landed', () => {
  // 75000 pairs over 101 bins (about 742.6 each): bin 1 holds pairs 743 to 1485, across chunks 0 and 1.
  const summary = createWaveformSummary(400 * TPS, 101)
  summary.add(0, chunk(0.5))
  const columns = summary.columns(101)
  assert.notEqual(columns[0], null)
  assert.equal(columns[1], null, 'half its pairs are still to come')
  summary.add(1, chunk(0.5))
  assert.notEqual(summary.columns(101)[1], null)
})

test("a new revision's summary is drawn once it has all arrived; until then the last complete one of the same item stays", () => {
  const old = createWaveformSummary(4 * TPS)
  old.add(0, chunk(0.2))
  const next = createWaveformSummary(4 * TPS)
  assert.equal(shownSummary(next, { summary: old, item: 2, doc: 'a' }, 2, 'a'), old)
  // Another item or document: its own, loading.
  assert.equal(shownSummary(next, { summary: old, item: 3, doc: 'a' }, 2, 'a'), next)
  assert.equal(shownSummary(next, { summary: old, item: 2, doc: 'b' }, 2, 'a'), next)
  assert.equal(shownSummary(next, null, 2, 'a'), next)
  next.add(0, chunk(0.4))
  assert.equal(shownSummary(next, { summary: old, item: 2, doc: 'a' }, 2, 'a'), next)
})
