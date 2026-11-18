// The Timeline's geometry and view state (upstream `panels/timeline.rs`, `panels/keyboard.rs`), and
// its thumbnail and peak requests: pure, so `node --test` runs them.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_VIEW,
  MAX_PPS,
  MIN_PPS,
  applyViewCommand,
  clampSplit,
  headerWidthFor,
  maxScroll,
  rulerSteps,
  scrollHalf,
  sourceTimeAt,
  stepView,
  throughEdits,
  timeAt,
  trackRows,
  waveformBar,
  waveformDisplayGain,
  xOf,
  zoomAbout,
  zoomThumb,
} from './layout.ts'
import { createLru, createMediaQueue } from './mediaQueue.ts'
import { createThumbnails, thumbnailKey } from './thumbnails.ts'
import { createPeaks, peakKey } from './peaks.ts'

const view = (patch = {}) => ({ ...DEFAULT_VIEW, ...patch })

test('time and x round-trip at several zooms and scrolls', () => {
  for (const pps of [MIN_PPS, 0.5, 40, 1234.5, MAX_PPS]) {
    for (const scroll of [0, 3.25, 600]) {
      const at = { pps, scroll }
      for (const seconds of [0, 1 / 24, 12.5, 3599.99]) {
        assert.ok(Math.abs(timeAt(at, xOf(at, seconds)) - seconds) < 1e-9, `${pps} ${scroll} ${seconds}`)
      }
      assert.equal(xOf(at, scroll), 0)
    }
  }
})

test('the ruler chooses upstream steps: labels 110 px apart, ticks 12 px apart', () => {
  // 23.976 fps counts 24-frame timecode seconds; 40 px a second is 1.67 px a frame.
  assert.deepEqual(rulerSteps(24000 / 1001, 40), { label: 120, minor: 10 })
  // A frame 50 px wide: a label every 5 frames, a tick every frame.
  assert.deepEqual(rulerSteps(24, 1200), { label: 5, minor: 1 })
  // Base / 2 is in the list: 12 frames at 24 fps, 15 at 30.
  assert.deepEqual(rulerSteps(30, 30 * 110 / 15), { label: 15, minor: 2 })
  // Zoomed far out: the largest step, an hour.
  assert.deepEqual(rulerSteps(25, MIN_PPS), { label: 25 * 3600, minor: 25 * 300 })
})

test('the view stays inside ten minutes past the sequence', () => {
  assert.equal(maxScroll(30, 600, 10), 630 - 60)
  assert.equal(maxScroll(0, 600, 0), 0)
  assert.equal(maxScroll(5, 1e9, 1), 0)
})

test('the split and the header width hold their bounds', () => {
  assert.equal(clampSplit(0), 0.1)
  assert.equal(clampSplit(1), 0.9)
  assert.equal(clampSplit(0.42), 0.42)
  assert.equal(clampSplit(Number.NaN), 0.5)
  // Upstream's 204 px header, kept unless the panel is too narrow to show any time.
  assert.equal(headerWidthFor(204, 900), 204)
  assert.equal(headerWidthFor(204, 300), 150)
  assert.equal(headerWidthFor(10, 900), 150)
  assert.equal(headerWidthFor(5000, 2000), 400)
})

test('a divider drag past either end stops at 10% and 90% (applyViewCommand keeps the rest)', () => {
  const next = applyViewCommand(view({ split: 0.85 }), 'timeline.setSplit', { split: 3 }, { playhead: 0, width: 800 })
  assert.equal(next.view.split, 0.9)
})

test('zoom keeps the anchor under the same x, and clamps', () => {
  const at = view({ pps: 40, targetPps: 40, scroll: 10, targetScroll: 10 })
  const next = zoomAbout(at, 1.6, 15, 800)
  assert.equal(next.targetPps, 64)
  // 15 s was 200 px in: it stays 200 px in.
  assert.ok(Math.abs((15 - next.targetScroll) * next.targetPps - 200) < 1e-9)
  // An anchor off screen zooms about the middle.
  const off = zoomAbout(at, 2, 500, 800)
  assert.ok(Math.abs((500 - off.targetScroll) * off.targetPps - 400) < 1e-6)
  assert.equal(zoomAbout(view({ targetPps: MAX_PPS }), 10, 0, 800).targetPps, MAX_PPS)
})

test('= and - zoom about the playhead by 1.6, \\ fits the sequence with a 1 s minimum', () => {
  const at = view({ pps: 40, targetPps: 40, scroll: 0, targetScroll: 0, fitPending: false })
  const zoomedIn = applyViewCommand(at, 'view.zoomIn', {}, { playhead: 2, width: 800 })
  assert.equal(zoomedIn.view.targetPps, 64)
  const zoomedOut = applyViewCommand(at, 'view.zoomOut', {}, { playhead: 2, width: 800 })
  assert.equal(zoomedOut.view.targetPps, 25)
  const fit = applyViewCommand(at, 'view.zoomToSequence', {}, { playhead: 0, width: 800 })
  assert.equal(fit.view.fitPending, true)
  // The fit happens on the next step, with the panel's width: 94% of it over the sequence.
  const fitted = stepView(fit.view, 0.016, { width: 800, duration: 10 }).view
  assert.equal(fitted.targetPps, 800 * 0.94 / 10)
  assert.equal(fitted.targetScroll, 0)
  const short = stepView(fit.view, 0.016, { width: 800, duration: 0.2 }).view
  assert.equal(short.targetPps, 800 * 0.94)
})

test('zoom animates toward its target, one step per frame', () => {
  let at = view({ pps: 40, targetPps: 80, fitPending: false })
  const first = stepView(at, 1 / 60, { width: 800, duration: 10 })
  assert.ok(first.animating)
  assert.ok(first.view.pps > 40 && first.view.pps < 80)
  at = first.view
  for (let frame = 0; frame < 120; frame += 1) at = stepView(at, 1 / 60, { width: 800, duration: 10 }).view
  assert.equal(at.pps, 80)
  assert.equal(stepView(at, 1 / 60, { width: 800, duration: 10 }).animating, false)
})

test('track heights: Shift+= and Shift+- set all and restore, Cmd/Alt+= step by 12 within 24..240', () => {
  const at = view()
  const expanded = applyViewCommand(at, 'timeline.expandAllTracks', {}, { playhead: 0, width: 800 })
  assert.deepEqual([expanded.view.videoTrackHeight, expanded.view.audioTrackHeight], [120, 120])
  const back = applyViewCommand(expanded.view, 'timeline.expandAllTracks', {}, { playhead: 0, width: 800 })
  assert.deepEqual([back.view.videoTrackHeight, back.view.audioTrackHeight], [60, 56])
  const minimized = applyViewCommand(at, 'timeline.minimizeAllTracks', {}, { playhead: 0, width: 800 })
  assert.deepEqual([minimized.view.videoTrackHeight, minimized.view.audioTrackHeight], [24, 24])
  const up = applyViewCommand(at, 'timeline.increaseVideoHeight', {}, { playhead: 0, width: 800 })
  assert.deepEqual(up.result, { videoTrackHeight: 72, audioTrackHeight: 56 })
  const floor = applyViewCommand(view({ audioTrackHeight: 30 }), 'timeline.decreaseAudioHeight', {}, { playhead: 0, width: 800 })
  assert.equal(floor.view.audioTrackHeight, 24)
})

test('Page Down shows the next screen (upstream subtracts the header from the width)', () => {
  const at = view({ pps: 10, targetPps: 10, targetScroll: 0 })
  const next = applyViewCommand(at, 'timeline.nextScreen', {}, { playhead: 0, width: 804 })
  assert.equal(next.view.targetScroll, 60)
  const prev = applyViewCommand(next.view, 'timeline.prevScreen', {}, { playhead: 0, width: 804 })
  assert.equal(prev.view.targetScroll, 0)
})

test('video tracks stack upward from the divider, audio downward, each half scrolling alone', () => {
  const rows = trackRows(view({ videoTrackHeight: 60, audioTrackHeight: 56 }), { video: 3, audio: 3, videoHeight: 100, audioHeight: 80 })
  // V1 sits at the bottom of the video half; V3 above it, partly out of view (scrolled to the bottom).
  assert.deepEqual(rows.video.map((row) => row.top), [40, -20, -80])
  assert.equal(rows.maxVideoScroll, 80)
  assert.deepEqual(rows.audio.map((row) => row.top), [0, 56, 112])
  assert.equal(rows.maxAudioScroll, 88)
  // Scrolling the video half up brings the higher tracks in.
  const scrolled = trackRows(view({ vScroll: 80 }), { video: 3, audio: 3, videoHeight: 100, audioHeight: 80 })
  assert.deepEqual(scrolled.video.map((row) => row.top), [120, 60, 0])
  // A short stack sits at the bottom of the video half.
  const few = trackRows(view(), { video: 1, audio: 1, videoHeight: 200, audioHeight: 80 })
  assert.deepEqual(few.video.map((row) => row.top), [140])
})

test('a half never scrolls past its end, so scrolling back moves at once (upstream clamps every frame)', () => {
  const far = scrollHalf(view({ vScroll: 0 }), 'video', 2000, 80)
  assert.equal(far.vScroll, 80)
  const back = scrollHalf(far, 'video', -100, 80)
  assert.equal(back.vScroll, 0)
  assert.equal(scrollHalf(view({ aScroll: 10 }), 'audio', -50, 88).aScroll, 0)
  assert.equal(scrollHalf(view({ aScroll: 10 }), 'audio', 500, 88).aScroll, 88)
  // A half that fits its tracks does not scroll.
  assert.equal(scrollHalf(view(), 'video', 40, 0).vScroll, 0)
})

test('the zoom bar thumb spans the share in view and reaches both ends', () => {
  const start = zoomThumb(500, 100, 0, 10)
  assert.equal(start.left, 0)
  assert.ok(Math.abs(start.width - 500 * 50 / 700) < 1e-9)
  const end = zoomThumb(500, 100, maxScroll(100, 500, 10), 10)
  assert.ok(Math.abs(end.left + end.width - 500) < 1e-9)
  // Never narrower than its two handles.
  assert.equal(zoomThumb(500, 100000, 0, 1).width, 34)
})

test('waveform display gain normalises to full scale by at most +12 dB, after the clip gain', () => {
  assert.ok(Math.abs(waveformDisplayGain(0.5, 0) - 2) < 1e-9)
  assert.ok(Math.abs(waveformDisplayGain(1e-6, 0) - 3.981072) < 1e-6)
  assert.ok(Math.abs(waveformDisplayGain(1, -6) - 10 ** (-6 / 20)) < 1e-9)
})

test('a clip maps sequence time to its source, forward, sped up, and reversed', () => {
  const clip = { start: 10, duration: 4, sourceIn: 2, sourceOut: 10, speed: 2, reverse: false }
  assert.equal(sourceTimeAt(clip, 11), 4)
  assert.equal(sourceTimeAt({ ...clip, reverse: true }, 11), 8)
})

test('through edits: adjacent pieces of one source that continue each other', () => {
  const piece = (id, start, duration, sourceIn, item = 8) => ({ id, item, start, duration, sourceIn, sourceOut: sourceIn + duration, speed: 1, reverse: false })
  const track = [piece(1, 0, 2, 0), piece(2, 2, 3, 2), piece(3, 5, 1, 9), piece(4, 6, 1, 10, 9)]
  assert.deepEqual(throughEdits(track, 1 / 24), [{ left: 1, right: 2, time: 2 }])
})

/** A fake engine call: resolves when the test says, and counts the calls in flight. */
function fakeEngine() {
  const calls = []
  let flying = 0
  let most = 0
  const invoke = (name, ...args) =>
    new Promise((resolve) => {
      flying += 1
      most = Math.max(most, flying)
      calls.push({ name, args, finish: (value) => {
        flying -= 1
        resolve(value)
      } })
    })
  return { calls, invoke, most: () => most }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the LRU evicts the least recently used entry, and says so', () => {
  const evicted = []
  const lru = createLru(2, (key, value) => evicted.push([key, value]))
  lru.set('a', 1)
  lru.set('b', 2)
  assert.equal(lru.get('a'), 1)
  lru.set('c', 3)
  assert.equal(lru.has('b'), false)
  assert.deepEqual(lru.keys(), ['a', 'c'])
  assert.deepEqual(evicted, [['b', 2]])
  lru.clear()
  assert.deepEqual(evicted, [['b', 2], ['a', 1], ['c', 3]])
})

test('a reset while a request is in flight: its answer is not cached, and the next request is sent anew', async () => {
  const engine = fakeEngine()
  const queue = createMediaQueue({ idle: () => true })
  const thumbnails = createThumbnails({ invoke: engine.invoke, queue, max: 10, decode: (bytes) => bytes })
  const spec = { item: 1, revision: null, frame: 0, seconds: 0, width: 320 }
  const heard = []
  thumbnails.request(spec, () => heard.push('old'))
  await tick()
  assert.equal(engine.calls.length, 1)
  // Another document: the caches and the queue start over while the old request is still in the worker.
  queue.clear()
  thumbnails.clear()
  thumbnails.request(spec, () => heard.push('new'))
  await tick()
  assert.equal(engine.calls.length, 2, 'the new document asks for itself, not joining the old request')
  engine.calls[0].finish('old document')
  await tick()
  await tick()
  assert.equal(thumbnails.get(thumbnailKey(spec)), undefined, "the old document's frame is not kept")
  assert.deepEqual(heard, [])
  engine.calls[1].finish('new document')
  await tick()
  await tick()
  assert.equal(thumbnails.get(thumbnailKey(spec)), 'new document')
  assert.deepEqual(heard, ['new'])
})

test("a sequence item's thumbnail: the last revision's shows while the new one loads, then it is dropped", async () => {
  const engine = fakeEngine()
  const queue = createMediaQueue({ idle: () => true })
  const thumbnails = createThumbnails({ invoke: engine.invoke, queue, max: 10, decode: (bytes) => bytes })
  const at = (revision) => ({ item: 7, revision, frame: 0, seconds: 0, width: 320 })
  thumbnails.request(at(1), () => {})
  await tick()
  engine.calls[0].finish('rev 1')
  await tick()
  assert.deepEqual(thumbnails.show(at(1)), { image: 'rev 1', fresh: true })
  assert.deepEqual(thumbnails.show(at(2)), { image: 'rev 1', fresh: false })
  thumbnails.request(at(2), () => {})
  await tick()
  engine.calls[1].finish('rev 2')
  await tick()
  assert.deepEqual(thumbnails.show(at(2)), { image: 'rev 2', fresh: true })
  assert.equal(thumbnails.get(thumbnailKey(at(1))), undefined, 'the older revision no longer fills the cache')
  assert.equal(thumbnails.show({ ...at(2), frame: 5 }), undefined)
})

test('thumbnails: one request in flight, cached, the oldest evicted, and none while playing', async () => {
  const engine = fakeEngine()
  let idle = false
  const queue = createMediaQueue({ idle: () => idle })
  const thumbnails = createThumbnails({ invoke: engine.invoke, queue, max: 2, decode: (bytes) => bytes })
  const seen = []
  const ask = (item) => thumbnails.request({ item, revision: null, frame: 0, seconds: 0, width: 320 }, () => seen.push(item))
  ask(1)
  ask(2)
  ask(3)
  await tick()
  assert.equal(engine.calls.length, 0, 'nothing is asked while playback is not idle')
  idle = true
  queue.pump()
  await tick()
  assert.equal(engine.calls.length, 1)
  assert.deepEqual(engine.calls[0].args, [1, 0, 320])
  engine.calls[0].finish('one')
  await tick()
  await tick()
  assert.equal(engine.calls.length, 2)
  engine.calls[1].finish('two')
  await tick()
  await tick()
  engine.calls[2].finish('three')
  await tick()
  assert.equal(engine.most(), 1)
  assert.deepEqual(seen, [1, 2, 3])
  // Two kept: item 1, the oldest, went.
  assert.equal(thumbnails.get(thumbnailKey({ item: 1, revision: null, frame: 0, width: 320 })), undefined)
  assert.equal(thumbnails.get(thumbnailKey({ item: 3, revision: null, frame: 0, width: 320 })), 'three')
  // A cached thumbnail asks nothing.
  ask(3)
  await tick()
  assert.equal(engine.calls.length, 3)
})

test('a request for a clip scrolled out of view is cancelled before it is sent', async () => {
  const engine = fakeEngine()
  const queue = createMediaQueue({ idle: () => true })
  const thumbnails = createThumbnails({ invoke: engine.invoke, queue, max: 10, decode: (bytes) => bytes })
  thumbnails.request({ item: 1, revision: null, frame: 0, seconds: 0, width: 320 }, () => {})
  const cancel = thumbnails.request({ item: 2, revision: null, frame: 0, seconds: 0, width: 320 }, () => {})
  await tick()
  cancel()
  engine.calls[0].finish('one')
  await tick()
  await tick()
  assert.equal(engine.calls.length, 1)
  assert.equal(queue.pending(), 0)
})

test('keys: sequence items carry the engine revision, media items do not', () => {
  assert.equal(thumbnailKey({ item: 4, revision: null, frame: 12, width: 320 }), '4@-/12/320')
  assert.notEqual(thumbnailKey({ item: 4, revision: 7, frame: 12, width: 320 }), thumbnailKey({ item: 4, revision: 8, frame: 12, width: 320 }))
  assert.equal(peakKey({ item: 4, revision: null, chunk: 3 }), '4@-/3')
})

test('peaks: 4 s chunks through the same one-in-flight queue as thumbnails', async () => {
  const engine = fakeEngine()
  const queue = createMediaQueue({ idle: () => true })
  const thumbnails = createThumbnails({ invoke: engine.invoke, queue, max: 10, decode: (bytes) => bytes })
  const peaks = createPeaks({ invoke: engine.invoke, queue, max: 10 })
  thumbnails.request({ item: 1, revision: null, frame: 0, seconds: 0, width: 320 }, () => {})
  peaks.request({ item: 2, revision: null, chunk: 3 }, () => {})
  await tick()
  assert.equal(engine.calls.length, 1)
  engine.calls[0].finish('one')
  await tick()
  await tick()
  assert.deepEqual([engine.calls[1].name, ...engine.calls[1].args], ['itemPeaks', 2, 12, 4])
  engine.calls[1].finish(new Float32Array([-0.5, 0.25, -0.125, 0.75]))
  await tick()
  assert.deepEqual([...peaks.get(peakKey({ item: 2, revision: null, chunk: 3 }))], [-0.5, 0.25, -0.125, 0.75])
  assert.equal(peaks.loudest(2, null), 0.75)
  assert.equal(engine.most(), 1)
})

test("peaks: an older revision's chunk shows while the new one loads, and the loudest peak follows the newest revision only", async () => {
  const engine = fakeEngine()
  const queue = createMediaQueue({ idle: () => true })
  const peaks = createPeaks({ invoke: engine.invoke, queue, max: 10 })
  peaks.request({ item: 7, revision: 1, chunk: 0 }, () => {})
  await tick()
  engine.calls[0].finish(new Float32Array([-1, 1]))
  await tick()
  assert.deepEqual([...peaks.show({ item: 7, revision: 2, chunk: 0 })], [-1, 1])
  peaks.request({ item: 7, revision: 2, chunk: 0 }, () => {})
  await tick()
  engine.calls[1].finish(new Float32Array([-0.25, 0.5]))
  await tick()
  assert.equal(peaks.loudest(7, 2), 0.5)
  assert.equal(peaks.loudest(7, 1), 0, 'the older revision is dropped')
  assert.equal(peaks.get(peakKey({ item: 7, revision: 1, chunk: 0 })), undefined)
})

test('two thumbnail caches on one queue never join each other\'s requests: each is asked and filled', async () => {
  const engine = fakeEngine()
  const queue = createMediaQueue({ idle: () => true })
  // The Timeline's frame is a frame index, the Project panel's a quarter-second index: the same numbers mean other times.
  const timeline = createThumbnails({ invoke: engine.invoke, queue, max: 10, decode: (bytes) => bytes })
  const project = createThumbnails({ invoke: engine.invoke, queue, max: 10, decode: (bytes) => bytes, prefix: 'project' })
  const heard = []
  timeline.request({ item: 1, revision: null, frame: 4, seconds: 4 / 24, width: 320 }, () => heard.push('timeline'))
  project.request({ item: 1, revision: null, frame: 4, seconds: 1, width: 320 }, () => heard.push('project'))
  await tick()
  engine.calls[0].finish('timeline frame')
  await tick()
  await tick()
  assert.equal(engine.calls.length, 2, 'the Project panel asks for its own time')
  assert.equal(engine.calls[1].args[1], 1)
  engine.calls[1].finish('project frame')
  await tick()
  await tick()
  assert.equal(timeline.show({ item: 1, revision: null, frame: 4, width: 320 })?.image, 'timeline frame')
  assert.equal(project.show({ item: 1, revision: null, frame: 4, width: 320 })?.image, 'project frame')
  assert.deepEqual(heard, ['timeline', 'project'])
})

test("View ▸ Dynamic Audio Waveforms: logarithmic bars from −48 dB by default, the linear amplitude when off, and the view command toggles it", () => {
  // Half scale is −6 dB: seven eighths of the zone logarithmically, half linearly.
  assert.ok(Math.abs(waveformBar(0.5, 1, 48, true) - 48 * (1 - 6.0206 / 48)) < 0.01)
  assert.equal(waveformBar(0.5, 1, 48, false), 24)
  assert.equal(waveformBar(0.001, 1, 48, true), 0, '−60 dB is below the scale')
  assert.equal(waveformBar(2, 1, 48, false), 48, 'clamped to the zone')
  const context = { playhead: 0, width: 800 }
  assert.equal(DEFAULT_VIEW.dynamicWaveforms, true)
  const off = applyViewCommand(DEFAULT_VIEW, 'view.dynamicAudioWaveforms', {}, context)
  assert.deepEqual([off.view.dynamicWaveforms, off.result], [false, { dynamicAudioWaveforms: false }])
  assert.equal(applyViewCommand(off.view, 'view.dynamicAudioWaveforms', {}, context).view.dynamicWaveforms, true)
  assert.equal(applyViewCommand(DEFAULT_VIEW, 'view.dynamicAudioWaveforms', { on: true }, context).view.dynamicWaveforms, true)
})

test("a sequence poster keyed on its content stamp is asked once while the stamp stays, and again when it moves", async () => {
  const engine = fakeEngine()
  const queue = createMediaQueue({ idle: () => true })
  const thumbnails = createThumbnails({ invoke: engine.invoke, queue, max: 10, decode: (bytes) => bytes })
  const at = (stamp) => ({ item: 7, revision: stamp, frame: 0, seconds: 0, width: 320 })
  thumbnails.request(at('18446744073709551557'), () => {})
  await tick()
  engine.calls[0].finish('first')
  await tick()
  // Other revisions of the project leave the stamp: nothing is asked again.
  thumbnails.request(at('18446744073709551557'), () => {})
  await tick()
  assert.equal(engine.calls.length, 1)
  assert.deepEqual(thumbnails.show(at('18446744073709551557')), { image: 'first', fresh: true })
  assert.equal(thumbnails.get(thumbnailKey(at('18446744073709551557'))), 'first', 'a stamp past 2^53 is its own key')
  thumbnails.request(at('42'), () => {})
  await tick()
  assert.equal(engine.calls.length, 2)
  assert.deepEqual(thumbnails.show(at('42')), { image: 'first', fresh: false })
})
