// The monitors' display modes, the Comparison View, and the Source waveform, as upstream's
// `monitor_view.rs` (`route`, `set_display`, `checked`, `channel_view`, `waveform`,
// `compare_bar`) and `monitor.rs` `show`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VIEWS, monitorViewChecked, monitorViewCommand, servesMonitorView } from './monitorView.ts'
import { channelPass, compareStep, createLatestRead, sourceLayout } from './displayModes.ts'

const TPS = 254_016_000_000

test("set_display: Audio Waveform and the split view go to Source, Comparison to Program with the reference at the playhead", () => {
  // Asked of the Program monitor, the Source's waveform modes still go to Source.
  const wave = monitorViewCommand(DEFAULT_VIEWS, 'view.display.audioWaveform', { monitor: 'program' }, 'program', 5 * TPS)
  assert.deepEqual(wave.result, { monitor: 'source', display: 'audioWaveform' })
  assert.equal(wave.views.source.display, 'audioWaveform')
  assert.equal(wave.views.program, DEFAULT_VIEWS.program)
  const split = monitorViewCommand(DEFAULT_VIEWS, 'view.display.videoAndWaveform', {}, 'timeline', 0)
  assert.deepEqual([split.result, split.views.source.display, split.views.program.display], [{ monitor: 'source', display: 'videoAndWaveform' }, 'videoAndWaveform', 'composite'])
  // Asked of the Source monitor, Comparison goes to Program, its reference at the program playhead.
  const compare = monitorViewCommand(DEFAULT_VIEWS, 'view.display.comparison', { monitor: 'source' }, 'source', 7 * TPS)
  assert.deepEqual(compare.result, { monitor: 'program', display: 'comparison' })
  assert.deepEqual([compare.views.program.display, compare.views.program.compareRef], ['comparison', 7 * TPS])
  assert.equal(compare.views.source, DEFAULT_VIEWS.source)
  // A reference already set stays when Comparison is chosen again.
  const back = monitorViewCommand(compare.views, 'view.display.composite', {}, 'program', 9 * TPS)
  assert.deepEqual([back.views.program.display, back.views.program.compareRef], ['composite', 7 * TPS])
  assert.equal(monitorViewCommand(back.views, 'view.display.comparison', {}, 'program', 9 * TPS).views.program.compareRef, 7 * TPS)
  // The channels and Composite act on params.monitor, else on the focused monitor (Program by default).
  assert.equal(monitorViewCommand(DEFAULT_VIEWS, 'view.display.red', { monitor: 'source' }, 'program', 0).views.source.display, 'red')
  assert.equal(monitorViewCommand(DEFAULT_VIEWS, 'view.display.alpha', {}, 'source', 0).views.source.display, 'alpha')
  const green = monitorViewCommand(DEFAULT_VIEWS, 'view.display.green', {}, 'timeline', 0)
  assert.deepEqual([green.result, green.views.program.display], [{ monitor: 'program', display: 'green' }, 'green'])
  // Multi-Camera comes with Multi-Camera (wave 3); an unknown mode is refused.
  assert.equal(servesMonitorView('view.display.multicam'), false)
  assert.equal(servesMonitorView('view.display.sepia'), false)
  assert.throws(() => monitorViewCommand(DEFAULT_VIEWS, 'view.display.sepia', {}, 'program', 0))
  for (const mode of ['composite', 'alpha', 'red', 'green', 'blue', 'audioWaveform', 'comparison', 'videoAndWaveform']) assert.equal(servesMonitorView(`view.display.${mode}`), true, mode)
  // The defaults are never changed in place.
  assert.deepEqual([DEFAULT_VIEWS.program.display, DEFAULT_VIEWS.program.compareRef, DEFAULT_VIEWS.source.display], ['composite', null, 'composite'])
})

test("checked: the waveform modes read the Source's view and Comparison the Program's, whichever monitor has focus", () => {
  const views = monitorViewCommand(monitorViewCommand(DEFAULT_VIEWS, 'view.display.audioWaveform', {}, 'program', 0).views, 'view.display.comparison', {}, 'source', 0).views
  assert.equal(monitorViewChecked(views, 'view.display.audioWaveform', 'program'), true)
  assert.equal(monitorViewChecked(views, 'view.display.comparison', 'source'), true)
  assert.equal(monitorViewChecked(views, 'view.display.videoAndWaveform', 'source'), false)
  // Composite and the channels read the focused monitor's.
  assert.equal(monitorViewChecked(views, 'view.display.composite', 'program'), false)
  assert.equal(monitorViewChecked(views, 'view.display.composite', 'timeline'), false)
  const red = monitorViewCommand(DEFAULT_VIEWS, 'view.display.red', {}, 'source', 0).views
  assert.equal(monitorViewChecked(red, 'view.display.red', 'source'), true)
  assert.equal(monitorViewChecked(red, 'view.display.red', 'program'), false)
  assert.equal(monitorViewChecked(red, 'view.display.composite', 'program'), true)
  assert.equal(monitorViewChecked(red, 'view.display.multicam', 'program'), undefined)
})

test('view.compare.setReference: its time in ticks, else its seconds, else the program playhead', () => {
  const at = (params) => monitorViewCommand(DEFAULT_VIEWS, 'view.compare.setReference', params, 'source', 3 * TPS)
  assert.deepEqual(at({ time: 2 * TPS }).result, { reference: 2 * TPS })
  assert.equal(at({ time: 2 * TPS }).views.program.compareRef, 2 * TPS)
  assert.equal(at({ seconds: 1.5 }).views.program.compareRef, 1.5 * TPS)
  assert.deepEqual(at({}).result, { reference: 3 * TPS })
  // It sets the reference only: the display mode stays.
  assert.equal(at({}).views.program.display, 'composite')
  assert.equal(servesMonitorView('view.compare.setReference'), true)
})

test('the channel pass (upstream channel_view): one channel in grey, colour channels premultiplied, opaque', () => {
  const red = () => new Uint8ClampedArray([255, 0, 0, 255])
  const pass = (mode, pixels = red()) => {
    channelPass(pixels, mode)
    return [...pixels]
  }
  assert.deepEqual(pass('red'), [255, 255, 255, 255], 'a red pixel is white under Red')
  assert.deepEqual(pass('green'), [0, 0, 0, 255], 'and black under Green')
  assert.deepEqual(pass('blue'), [0, 0, 0, 255])
  assert.deepEqual(pass('alpha'), [255, 255, 255, 255])
  // Upstream's own case: a colour and a transparent white.
  const two = () => new Uint8ClampedArray([200, 100, 50, 255, 255, 255, 255, 0])
  assert.deepEqual(pass('red', two()), [200, 200, 200, 255, 0, 0, 0, 255])
  assert.deepEqual(pass('green', two()).slice(0, 4), [100, 100, 100, 255])
  assert.deepEqual(pass('alpha', two()), [255, 255, 255, 255, 0, 0, 0, 255])
  // Half-transparent red reads half under Red.
  assert.deepEqual(pass('red', new Uint8ClampedArray([255, 0, 0, 128])), [128, 128, 128, 255])
})

test('the comparison reference steps one frame with the arrows (upstream compare_bar), never before 0; Set takes the playhead', () => {
  const frame = TPS / 25
  assert.equal(compareStep(10 * frame, 99 * frame, frame, 'next'), 11 * frame)
  assert.equal(compareStep(10 * frame, 99 * frame, frame, 'prev'), 9 * frame)
  assert.equal(compareStep(0, 99 * frame, frame, 'prev'), 0)
  assert.equal(compareStep(10 * frame, 99 * frame, frame, 'set'), 99 * frame)
  // With no reference yet, the arrows step from the playhead.
  assert.equal(compareStep(null, 5 * frame, frame, 'next'), 6 * frame)
  // ▶ stops at the sequence's last frame (its end less a frame).
  assert.equal(compareStep(99 * frame, 0, frame, 'next', 100 * frame), 99 * frame)
  assert.equal(compareStep(98 * frame, 0, frame, 'next', 100 * frame), 99 * frame)
})

test("the Source monitor's layout: no picture or Audio Waveform is all waveform; the split gives the picture 62%", () => {
  assert.deepEqual(sourceLayout(true, 'composite'), { picture: true, waveform: null })
  assert.deepEqual(sourceLayout(true, 'red'), { picture: true, waveform: null })
  assert.deepEqual(sourceLayout(true, 'audioWaveform'), { picture: false, waveform: 'full' })
  // A sound-only clip gets the waveform for a picture, whatever the mode.
  assert.deepEqual(sourceLayout(false, 'composite'), { picture: false, waveform: 'full' })
  assert.deepEqual(sourceLayout(false, 'videoAndWaveform'), { picture: false, waveform: 'full' })
  assert.deepEqual(sourceLayout(true, 'videoAndWaveform'), { picture: true, waveform: 'split' })
})

test('a read for a key no longer wanted is dropped, and the latest key is read next (lesson 6)', async () => {
  const asked = []
  const shown = []
  const answers = []
  const read = createLatestRead({
    read: (key) => {
      asked.push(key.time)
      return new Promise((resolve) => answers.push(() => resolve(`frame ${key.time}`)))
    },
    same: (a, b) => a.doc === b.doc && a.revision === b.revision && a.time === b.time,
    onValue: (key, value) => shown.push([key.time, value]),
  })
  const doc = {}
  read.want({ doc, revision: 1, time: 1 })
  read.want({ doc, revision: 1, time: 2 })
  read.want({ doc, revision: 1, time: 3 })
  // One in flight: 2 was replaced by 3 before it was asked.
  assert.deepEqual(asked, [1])
  answers.shift()()
  await new Promise((resolve) => setTimeout(resolve, 0))
  // 1 answered while 3 was wanted: dropped, and 3 asked.
  assert.deepEqual(shown, [])
  assert.deepEqual(asked, [1, 3])
  // A newer revision while 3 is in flight drops 3's answer too.
  read.want({ doc, revision: 2, time: 3 })
  answers.shift()()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(shown, [])
  answers.shift()()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(shown, [[3, 'frame 3']])
  // The key shown is not asked again; stop() drops the answer in flight.
  read.want({ doc, revision: 2, time: 3 })
  assert.equal(asked.length, 3)
  read.want({ doc, revision: 2, time: 4 })
  read.stop()
  answers.shift()()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(shown, [[3, 'frame 3']])
})

test('a failed read, or one the picture could not take, is read again when wanted again; a key replaced before it was read is told (a dropped frame)', async () => {
  const asked = []
  const answers = []
  const shown = []
  const errors = []
  const skipped = []
  let take = false
  const read = createLatestRead({
    read: (key) => {
      asked.push(key)
      return new Promise((resolve, reject) => answers.push({ resolve: () => resolve(`frame ${key}`), reject: () => reject(new Error('no frame')) }))
    },
    same: (a, b) => a === b,
    onValue: (key, value) => {
      shown.push(value)
      return take
    },
    onError: (key) => errors.push(key),
    onSkip: (key) => skipped.push(key),
  })
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  read.want(1)
  answers.shift().reject()
  await tick()
  assert.deepEqual(errors, [1])
  // Not shown: wanted again, it is read again.
  read.want(1)
  assert.deepEqual(asked, [1, 1])
  // The picture could not take it (onValue answers false): not shown either.
  answers.shift().resolve()
  await tick()
  read.want(1)
  assert.deepEqual(asked, [1, 1, 1])
  take = true
  answers.shift().resolve()
  await tick()
  read.want(1)
  assert.equal(asked.length, 3)
  // 2 is in flight; 3 waits and 4 replaces it before it is read: 3 is told as skipped, 4 is not.
  read.want(2)
  read.want(3)
  read.want(4)
  assert.deepEqual(skipped, [3])
  answers.shift().resolve()
  await tick()
  assert.deepEqual(asked.slice(3), [2, 4])
  answers.shift().resolve()
  await tick()
  assert.deepEqual(skipped, [3])
})
