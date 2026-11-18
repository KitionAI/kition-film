// The Audio Meters' ballistics and peak windows (upstream `panels/meters.rs`, `mixer.rs`
// `poll_meters`), the History panel's step arithmetic (`misc.rs` `history`), and the Info panel's
// lines (`misc.rs` `info`). Run with `pnpm --dir web test:unit`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HOLD_FALL_DB, LEVEL_FALL_DB, METER_FLOOR_DB, METER_WINDOW, createMeterFeed, linearToDb, metersAtRest, silentMeters, stepMeters } from './meters.ts'
import { createHistoryStepper, historyRows } from './history.ts'
import { fpsLabel, itemsAtPlayhead } from './info.ts'

const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) < epsilon

/** `frames` of interleaved stereo at `rate`, left at `left` and right at `right` (or a function of the frame). */
function chunk(frames, left, right = left) {
  const samples = new Float32Array(frames * 2)
  for (let frame = 0; frame < frames; frame += 1) {
    samples[frame * 2] = typeof left === 'function' ? left(frame) : left
    samples[frame * 2 + 1] = typeof right === 'function' ? right(frame) : right
  }
  return samples
}

test('a peak attacks at once, then the level falls 20 dB/s and the hold line 6 dB/s', () => {
  let levels = stepMeters(silentMeters(), 1 / 60, [0.5, 0.25])
  assert.ok(near(levels.level[0], linearToDb(0.5)) && near(levels.hold[0], linearToDb(0.5)))
  assert.ok(near(levels.level[1], linearToDb(0.25)))
  const peak = levels.level[0]
  // Half a second of silence in 0.05 s frames.
  for (let frame = 0; frame < 10; frame += 1) levels = stepMeters(levels, 0.05, null)
  assert.ok(near(levels.level[0], peak - LEVEL_FALL_DB * 0.5, 1e-9), `level ${levels.level[0]}`)
  assert.ok(near(levels.hold[0], peak - HOLD_FALL_DB * 0.5, 1e-9), `hold ${levels.hold[0]}`)
  // A quieter peak raises neither above where they fell to, a louder one both.
  const quiet = stepMeters(levels, 0, [0.01, 0.01])
  assert.ok(near(quiet.level[0], Math.max(levels.level[0], linearToDb(0.01))))
  assert.ok(near(quiet.hold[0], levels.hold[0]))
  const loud = stepMeters(levels, 0, [1, 1])
  assert.ok(near(loud.level[0], 0) && near(loud.hold[0], 0))
})

test("a frame's step is capped at 0.1 s, and nothing falls below -90 dB", () => {
  const levels = stepMeters(silentMeters(), 0, [1, 1])
  const late = stepMeters(levels, 2, null)
  assert.ok(near(late.level[0], -LEVEL_FALL_DB * 0.1) && near(late.hold[0], -HOLD_FALL_DB * 0.1))
  let resting = levels
  for (let frame = 0; frame < 200; frame += 1) resting = stepMeters(resting, 0.1, null)
  assert.deepEqual(resting, { level: [METER_FLOOR_DB, METER_FLOOR_DB], hold: [METER_FLOOR_DB, METER_FLOOR_DB] })
  assert.equal(metersAtRest(resting), true)
  assert.equal(metersAtRest(late), false)
  // Silence reads -90 dB, never -Infinity.
  assert.equal(stepMeters(silentMeters(), 0, [0, 0]).level[0], METER_FLOOR_DB)
  assert.ok(Number.isFinite(linearToDb(0)))
})

test('the feed hands over a window only once the audio clock reaches it', () => {
  const feed = createMeterFeed()
  feed.listen()
  const rate = 48_000
  // Half a second heard from 10 s on the audio clock: quiet, then loud from 0.25 s.
  feed.push(chunk(rate / 2, (frame) => (frame < rate / 4 ? 0.1 : 0.8), 0.05), 10, rate)
  assert.equal(feed.pending, 15, 'half a second is 15 windows of 1/30 s')
  assert.equal(feed.take(9.99), null, 'nothing is heard before the chunk starts')
  const first = feed.take(10.1)
  assert.ok(near(first[0], 0.1, 1e-6) && near(first[1], 0.05, 1e-6), JSON.stringify(first))
  assert.equal(feed.take(10.1), null, 'a window is taken once')
  const later = feed.take(10.3)
  assert.ok(near(later[0], 0.8, 1e-6), JSON.stringify(later))
  feed.clear()
  assert.equal(feed.pending, 0)
})

test('windows are aligned to the audio clock, not to the chunk', () => {
  const feed = createMeterFeed()
  feed.listen()
  const rate = 48_000
  // A chunk heard from 1/60 s: its first half window joins window 0, its loud frame at 1/30 s starts window 1.
  const loudAt = Math.round((METER_WINDOW - 1 / 60) * rate)
  feed.push(chunk(rate / 10, (frame) => (frame === loudAt ? 0.9 : 0.2)), 1 / 60, rate)
  const zero = feed.take(0)
  assert.ok(near(zero[0], 0.2, 1e-6), `window 0 holds the quiet half only: ${zero}`)
  const one = feed.take(METER_WINDOW)
  assert.ok(near(one[0], 0.9, 1e-6), `window 1 starts with the loud frame: ${one}`)
  // Two chunks meeting inside a window add up to one peak there.
  feed.push(chunk(800, 0.3), 1, rate)
  feed.push(chunk(800, 0.6), 1 + 800 / rate, rate)
  assert.ok(near(feed.take(1 + METER_WINDOW / 2)[0], 0.6, 1e-6))
})

test('the feed keeps nothing while no meter listens, counting every meter that does', () => {
  const feed = createMeterFeed()
  feed.push(chunk(4800, 0.5), 0, 48_000)
  assert.equal(feed.pending, 0)
  const first = feed.listen()
  const second = feed.listen()
  feed.push(chunk(4800, 0.5), 0, 48_000)
  assert.ok(feed.pending > 0)
  first()
  first()
  assert.ok(feed.pending > 0 && feed.listening, 'another meter still listens (and a second stop counts once)')
  second()
  assert.equal(feed.pending, 0, 'and forgets what it had once nobody listens')
  assert.equal(feed.listening, false)
})

test('windows the clock passed more than a second ago are dropped as new sound comes in', () => {
  const feed = createMeterFeed()
  feed.listen()
  let now = 0
  feed.setClock(() => now)
  // A hidden page: sound is scheduled for 10 s, and no meter takes it.
  for (let second = 0; second < 10; second += 0.5) {
    now = second
    feed.push(chunk(24_000, 0.5), second, 48_000)
  }
  // At most the second before the clock and the half second just scheduled are kept.
  assert.ok(feed.pending <= Math.ceil(2 / METER_WINDOW) + 1, `${feed.pending} windows kept`)
  assert.ok(feed.pending >= Math.floor(1.5 / METER_WINDOW) - 1, `${feed.pending} windows kept`)
})

test('History: Open, the undo steps with the last current, then the redo steps faint, in redo order', () => {
  const rows = historyRows({ undo: ['Add Marker', 'Razor', 'Move'], redo: ['Ripple Delete', 'Lift'] })
  assert.deepEqual(rows.map((row) => row.label), ['Open', 'Add Marker', 'Razor', 'Move', 'Lift', 'Ripple Delete'])
  assert.deepEqual(rows.map((row) => row.current), [false, false, false, true, false, false])
  assert.deepEqual(rows.map((row) => row.undone), [false, false, false, false, true, true])
  assert.equal(historyRows({ undo: [], redo: ['Move'] })[0].current, true, 'Open is current with nothing to undo')
})

/**
 * A fake engine's history behind a fake `invoke`: `edit.undo` and `edit.redo` move a name between
 * the stacks (and fail, as `invoke` does, answering null, when the stack is empty or `failing`
 * says so); `refreshes` counts the full refreshes.
 */
function fakeHistory(undo, redo = []) {
  const engine = { undo: [...undo], redo: [...redo], commands: [], refreshes: 0, failing: () => false, between: null }
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const stepper = createHistoryStepper({
    read: async () => {
      await tick()
      return { undo: [...engine.undo], redo: [...engine.redo] }
    },
    step: async (command) => {
      await tick()
      engine.commands.push(command)
      const [from, to] = command === 'edit.undo' ? [engine.undo, engine.redo] : [engine.redo, engine.undo]
      if (!from.length || engine.failing(engine.commands.length)) return null
      to.push(from.pop())
      engine.between?.(engine)
      return 'null'
    },
    refresh: async () => {
      engine.refreshes += 1
    },
  })
  return { engine, stepper }
}

test('History: clicking row k from current step n runs n-k undos, and a redo row its place in redos', async () => {
  const rows = historyRows({ undo: ['A', 'B', 'C', 'D'], redo: ['F', 'E'] })
  assert.deepEqual(rows.map((row) => row.target), [0, 1, 2, 3, 4, 5, 6])
  for (let k = 0; k <= 6; k += 1) {
    const { engine, stepper } = fakeHistory(['A', 'B', 'C', 'D'], ['F', 'E'])
    await stepper.goTo(rows[k].target)
    const want = k <= 4 ? Array(4 - k).fill('edit.undo') : Array(k - 4).fill('edit.redo')
    assert.deepEqual(engine.commands, want, `row ${k}`)
    assert.equal(engine.undo.length, k)
    assert.equal(engine.refreshes, 1, 'one full refresh per click')
  }
})

test('History: a double-click on a row lands on that row once', async () => {
  const { engine, stepper } = fakeHistory(['A', 'B', 'C', 'D', 'E'])
  const target = historyRows({ undo: engine.undo, redo: [] })[2].target
  await Promise.all([stepper.goTo(target), stepper.goTo(target)])
  assert.deepEqual(engine.undo, ['A', 'B'])
  assert.deepEqual(engine.commands, ['edit.undo', 'edit.undo', 'edit.undo'])
  // Two quick clicks on different rows: the second waits for nothing and is dropped while the first walks.
  const again = fakeHistory(['A', 'B', 'C', 'D'])
  await Promise.all([again.stepper.goTo(1), again.stepper.goTo(3)])
  assert.deepEqual(again.engine.undo, ['A'])
})

test('History: an edit made while the steps run stops them rather than undoing it', async () => {
  const { engine, stepper } = fakeHistory(['A', 'B', 'C', 'D'])
  engine.between = (state) => {
    if (state.commands.length === 1) {
      // The agent edits after the first undo: a new step, and the redo stack cleared.
      state.undo.push('Agent Edit')
      state.redo.length = 0
    }
  }
  await stepper.goTo(0)
  assert.deepEqual(engine.commands, ['edit.undo'])
  assert.deepEqual(engine.undo, ['A', 'B', 'C', 'Agent Edit'])
  assert.equal(engine.refreshes, 1)
})

test('History: a step that fails still refreshes the editor once', async () => {
  const { engine, stepper } = fakeHistory(['A', 'B', 'C'])
  engine.failing = (count) => count === 2
  await stepper.goTo(0)
  assert.deepEqual(engine.commands, ['edit.undo', 'edit.undo'], 'the walk stops at the failed step')
  assert.deepEqual(engine.undo, ['A', 'B'])
  assert.equal(engine.refreshes, 1)
  // A step that throws, too.
  const thrown = fakeHistory(['A', 'B'])
  thrown.engine.failing = () => {
    throw new Error('worker gone')
  }
  await thrown.stepper.goTo(0)
  assert.equal(thrown.engine.refreshes, 1)
})

test("Info: upstream's frame rate label, and the item each track plays at the playhead", () => {
  assert.equal(fpsLabel(30), '30')
  assert.equal(fpsLabel(30000 / 1001), '29.97')
  assert.equal(fpsLabel(24000 / 1001), '23.976')
  assert.equal(fpsLabel(25), '25')
  const clip = (name, start, duration) => ({ name, start, duration })
  const tracks = [
    { kind: 'video', clips: [clip('Title', 2, 1)] },
    { kind: 'video', clips: [clip('A', 0, 2), clip('B', 2, 3)] },
    { kind: 'audio', clips: [clip('A', 0, 2)] },
    { kind: 'audio', clips: [] },
  ]
  // Top video track first, numbered from the top (V2, V1), then the audio tracks in order; a clip owns its start, not its end.
  assert.deepEqual(itemsAtPlayhead(tracks, 2), [
    { phrase: 'Video {n}:', n: 2, name: 'Title' },
    { phrase: 'Video {n}:', n: 1, name: 'B' },
    { phrase: 'Audio {n}:', n: 1, name: '' },
    { phrase: 'Audio {n}:', n: 2, name: '' },
  ])
  assert.deepEqual(itemsAtPlayhead(tracks, 1.5).map((row) => row.name), ['', 'A', 'A', ''])
})
