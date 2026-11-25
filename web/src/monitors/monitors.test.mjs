// The Source and Program monitors' tables and arithmetic, against upstream's `monitor.rs`,
// `monitor_view.rs`, `source_range.rs`, `source_drag.rs`, and the engine's `adjust_range`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_VIEWS, ZOOMS, effectiveRes, monitorViewCommand, servesMonitorView } from './monitorView.ts'
import {
  PROGRAM_TRANSPORT,
  SOURCE_TRANSPORT,
  adjustRange,
  fitBox,
  frameAt,
  frameTicks,
  monitorSpan,
  pictureBox,
  quantizeScale,
  rateOf,
  renderScaleOf,
  safeMargins,
  setMarksParams,
  shownDuration,
  sourceDragPayload,
  sourceNavTicks,
  sourceViewOf,
  tickOf,
  ticksAtX,
  transportAction,
  xOfTicks,
  zoomLabel,
} from './model.ts'

const manifest = JSON.parse(readFileSync(new URL('../../parity/film-upstream.json', import.meta.url), 'utf8'))
const T = 254016000000

test("the transport rows are upstream's, in order, with its tooltips", () => {
  for (const [which, rows] of [['program', PROGRAM_TRANSPORT], ['source', SOURCE_TRANSPORT]]) {
    const upstream = manifest.elements.filter((element) => element.id.startsWith(`${which}.transport.`) && element.id !== `${which}.transport.buttonEditor`)
    assert.deepEqual(rows.map((row) => `${which}.transport.${row.key}`), upstream.map((element) => element.id))
    assert.deepEqual(rows.map((row) => row.label), upstream.map((element) => element.label))
  }
})

test('the two rows share ids where the meaning is the same; insert/overwrite are Source-only, lift/extract Program-only', () => {
  const ids = (rows) => rows.map((row) => row.uiId)
  const source = ids(SOURCE_TRANSPORT)
  const program = ids(PROGRAM_TRANSPORT)
  for (const id of ['control:transport.markIn', 'control:transport.play', 'control:transport.stepBack', 'control:transport.goToOut', 'control:transport.toggleProxies']) {
    assert.ok(source.includes(id) && program.includes(id), id)
  }
  assert.ok(source.includes('control:transport.insert') && source.includes('control:transport.overwrite'))
  assert.ok(!program.includes('control:transport.insert') && !program.includes('control:transport.overwrite'))
  assert.ok(program.includes('control:transport.lift') && program.includes('control:transport.extract'))
  assert.ok(!source.includes('control:transport.lift'))
})

test("a transport press: Source marks name their target, Source steps move its playhead, Export Frame waits, the rest run with the monitor", () => {
  assert.deepEqual(transportAction('source', 'src.markIn'), { command: 'marker.markIn', params: { target: 'source' } })
  assert.deepEqual(transportAction('source', 'src.goOut'), { seek: 'goOut' })
  assert.deepEqual(transportAction('source', 'source.insert'), { command: 'source.insert', params: { monitor: 'source' } })
  assert.deepEqual(transportAction('program', 'sequence.lift'), { command: 'sequence.lift', params: { monitor: 'program' } })
  assert.deepEqual(transportAction('program', 'exportFrame'), { disabled: true })
  assert.deepEqual(transportAction('program', 'media.toggleProxies'), { command: 'media.toggleProxies', params: { monitor: 'program' } })
})

test('effectiveRes follows upstream: Paused stopped, Playback playing, the higher with High Quality', () => {
  const view = DEFAULT_VIEWS.program
  assert.equal(effectiveRes(view, false), 'full')
  assert.equal(effectiveRes(view, true), 'half')
  assert.equal(effectiveRes({ ...view, highQuality: true }, true), 'full')
  assert.equal(effectiveRes({ ...view, highQuality: true, pausedRes: 'quarter' }, true), 'half')
  assert.equal(effectiveRes({ ...view, pausedRes: 'quarter' }, false), 'quarter')
})

test("the render scale is the resolution's, never more than the screen needs, in upstream's buckets", () => {
  assert.equal(renderScaleOf('full', 4), 1)
  assert.equal(renderScaleOf('quarter', 1), 0.25)
  assert.equal(renderScaleOf('full', 0.3), 0.375)
  // Upstream's floor is 1/32; the engine draws no smaller than 1/16.
  assert.equal(renderScaleOf('sixteenth', 0.001), 1 / 32)
  assert.equal(quantizeScale(0.2), 0.25)
  assert.equal(quantizeScale(0.0001), 1 / 32)
})

test("magnification: Fit, then upstream's ten levels, and their labels", () => {
  assert.deepEqual(ZOOMS.map(([level]) => level), ['10', '25', '50', '75', '100', '150', '200', '400', '800', '1600'])
  assert.deepEqual(ZOOMS.map(([, factor]) => factor), [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8, 16])
  assert.equal(zoomLabel(null), 'Fit')
  assert.equal(zoomLabel(1.5), '150%')
  for (const [level] of ZOOMS) assert.equal(servesMonitorView(`view.magnification.${level}`), true)
})

test('the Program and Source zoom keys set their own monitor to 100% or Fit, whichever has focus', () => {
  const hundred = monitorViewCommand(DEFAULT_VIEWS, 'view.sourceZoom100', {}, 'program')
  assert.equal(hundred.views.source.zoom, 1)
  assert.equal(hundred.views.program.zoom, null)
  assert.deepEqual(hundred.result, { zoom: 1 })
  assert.equal(monitorViewCommand(hundred.views, 'view.sourceZoomFit', {}, 'program').views.source.zoom, null)
  assert.equal(monitorViewCommand(DEFAULT_VIEWS, 'view.programZoom100', {}, 'source').views.program.zoom, 1)
  for (const id of ['view.programZoom100', 'view.programZoomFit', 'view.sourceZoom100', 'view.sourceZoomFit']) assert.equal(servesMonitorView(id), true, id)
})

test('picture_rect: fitted, or magnified with one frame pixel per device pixel and a clamped pan', () => {
  const area = { x: 0, y: 0, width: 400, height: 300 }
  assert.equal(Math.round(pictureBox(area, 1920, 1080, null, { x: 0, y: 0 }, 1).width), 400)
  const magnified = pictureBox(area, 1920, 1080, 1, { x: 10000, y: 0 }, 2)
  assert.equal(magnified.width, 960)
  assert.equal(magnified.x, 0)
  const small = pictureBox(area, 1920, 1080, 0.1, { x: 0, y: 0 }, 1)
  assert.equal(small.x + small.width / 2, 200)
  assert.deepEqual(fitBox({ x: 0, y: 0, width: 200, height: 200 }, 100, 50), { x: 0, y: 50, width: 200, height: 100 })
})

test('safe margins: action safe 90% and title safe 80%, centred', () => {
  const { action, title } = safeMargins({ x: 0, y: 0, width: 200, height: 100 })
  assert.deepEqual(action, { x: 10, y: 5, width: 180, height: 90 })
  assert.deepEqual(title, { x: 20, y: 10, width: 160, height: 80 })
})

test('frames: NTSC rates count exactly, and ticks snap down to their frame', () => {
  const ntsc = rateOf(24000 / 1001)
  assert.deepEqual(ntsc, { num: 24000, den: 1001 })
  assert.equal(frameTicks(ntsc), 10594584000)
  assert.equal(frameAt(ntsc, tickOf(ntsc, 12345)), 12345)
  assert.deepEqual(rateOf(25), { num: 25, den: 1 })
})

test("the Source monitor shows the whole clip as marked until it is; the Program only what is set", () => {
  const rate = rateOf(24)
  const fd = frameTicks(rate)
  const clip = { start: 0, end: 48 * fd, markIn: null, markOut: null }
  const source = monitorSpan('source', clip, rate)
  assert.deepEqual([source.markIn, source.markOut, source.hasIn, source.hasOut], [0, 47 * fd, false, false])
  assert.equal(shownDuration(source), 48 * fd)
  const program = monitorSpan('program', clip, rate)
  assert.deepEqual([program.markIn, program.markOut], [null, null])
  assert.equal(shownDuration(program), 48 * fd)
  const marked = monitorSpan('program', { ...clip, markIn: 10 * fd, markOut: 19 * fd }, rate)
  assert.equal(shownDuration(marked), 10 * fd)
  // A range being dragged shows in place of the marks.
  const dragged = monitorSpan('source', clip, rate, { start: 4 * fd, end: 8 * fd })
  assert.deepEqual([dragged.markIn, dragged.markOut], [4 * fd, 7 * fd])
})

test('the scrub bar: positions along the ruler and the frame under a point', () => {
  const rate = rateOf(24)
  const fd = frameTicks(rate)
  const span = { origin: 0, end: 100 * fd, rate }
  assert.equal(xOfTicks(span, 50 * fd, 200), 100)
  assert.equal(xOfTicks(span, 500 * fd, 200), 200)
  assert.equal(ticksAtX(span, 101, 200), 50 * fd)
  assert.equal(ticksAtX(span, -5, 200), 0)
})

test("adjust_range: In and Out stay on the frame grid and inside the clip, a move keeps the length", () => {
  const rate = rateOf(24)
  const fd = frameTicks(rate)
  const bounds = { start: 0, end: 100 * fd }
  const range = { start: 10 * fd, end: 20 * fd }
  assert.deepEqual(adjustRange(bounds, range, rate, 'in', 3.4 * fd), { start: 13 * fd, end: 20 * fd })
  assert.deepEqual(adjustRange(bounds, range, rate, 'in', 50 * fd), { start: 19 * fd, end: 20 * fd })
  assert.deepEqual(adjustRange(bounds, range, rate, 'out', 2.6 * fd), { start: 10 * fd, end: 23 * fd })
  assert.deepEqual(adjustRange(bounds, range, rate, 'out', -50 * fd), { start: 10 * fd, end: 11 * fd })
  assert.deepEqual(adjustRange(bounds, range, rate, 'move', -50 * fd), { start: 0, end: 10 * fd })
  assert.deepEqual(adjustRange(bounds, range, rate, 'move', 500 * fd), { start: 90 * fd, end: 100 * fd })
  assert.equal(adjustRange(bounds, { start: 10, end: 10 }, rate, 'in', 0), null)
})

test('a range drag sends project.setMarks with its own edge; nothing when unchanged', () => {
  const rate = rateOf(24)
  const fd = frameTicks(rate)
  const original = { start: 10 * fd, end: 20 * fd }
  assert.equal(setMarksParams(7, 'in', original, original, 0, rate), null)
  assert.deepEqual(setMarksParams(7, 'in', original, { start: 12 * fd, end: 20 * fd }, 0, rate), { item: 7, in: 12 * fd })
  assert.deepEqual(setMarksParams(7, 'out', original, { start: 10 * fd, end: 25 * fd }, 0, rate), { item: 7, out: 24 * fd })
  assert.deepEqual(setMarksParams(7, 'move', original, { start: 12 * fd, end: 22 * fd }, 0, rate), { item: 7, in: 12 * fd, out: 21 * fd })
})

test('source_nav: Go to In or Out (else the clip edges), and frame steps', () => {
  const rate = rateOf(24)
  const fd = frameTicks(rate)
  const view = { start: 0, end: 48 * fd, markIn: null, markOut: 30 * fd, playhead: 5 * fd }
  assert.equal(sourceNavTicks(view, rate, 'goIn'), 0)
  assert.equal(sourceNavTicks(view, rate, 'goOut'), 30 * fd)
  assert.equal(sourceNavTicks({ ...view, markOut: null }, rate, 'goOut'), 47 * fd)
  assert.equal(sourceNavTicks(view, rate, 'stepBack'), 4 * fd)
  assert.equal(sourceNavTicks(view, rate, 'stepFwd'), 6 * fd)
})

test("a Source drag carries the media and the marked span, and only the streams the media has", () => {
  const fd = T / 24
  const raw = { item: 9, media: 4, start: 0, end: 48 * fd, fps: 24, playhead: 0, markIn: 12 * fd, markOut: 23 * fd, markers: [], subclip: null, width: 640, height: 360, hasVideo: true, hasAudio: false }
  const view = sourceViewOf(raw)
  assert.deepEqual(sourceDragPayload(view, true, true), { item: 4, sourceIn: 12 * fd, duration: 12 * fd, video: true, audio: false })
  assert.equal(sourceDragPayload(view, false, true), null)
  assert.equal(sourceViewOf({ item: null }), null)
  // Markers keep their label colour (upstream draws them in `marker_rgb`).
  assert.deepEqual(sourceViewOf({ ...raw, markers: [{ start: fd, color: 'Green' }] }).markers, [{ start: fd, color: 'Green' }])
})

test('a scrub sends at most once per animation frame, the latest value, one in flight', async () => {
  const { frameLatest } = await import('./throttle.ts')
  const frames = []
  const sent = []
  let release = null
  const ask = frameLatest(
    (value) => {
      sent.push(value)
      return new Promise((resolve) => (release = resolve))
    },
    (callback) => {
      frames.push(callback)
      return () => frames.splice(frames.indexOf(callback), 1)
    },
  )
  ask(1)
  ask(2)
  ask(3)
  assert.deepEqual(sent, [], 'nothing before the frame')
  assert.equal(frames.length, 1, 'one frame asked for')
  frames.shift()()
  await Promise.resolve()
  assert.deepEqual(sent, [3])
  ask(4)
  ask(5)
  assert.equal(frames.length, 0, 'no frame while one is in flight')
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(sent, [3, 5], 'the latest once the first lands')
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  ask.flush(9)
  await Promise.resolve()
  assert.deepEqual(sent, [3, 5, 9], 'a release sends at once')
})

test('a flush while a send is in flight sends the flushed value once that send lands, without waiting for a frame', async () => {
  const { frameLatest } = await import('./throttle.ts')
  const frames = []
  const sent = []
  const releases = []
  const ask = frameLatest(
    (value) => {
      sent.push(value)
      return new Promise((resolve) => releases.push(resolve))
    },
    (callback) => {
      frames.push(callback)
      return () => frames.splice(frames.indexOf(callback), 1)
    },
  )
  ask.flush(1)
  await Promise.resolve()
  assert.deepEqual(sent, [1])
  ask(2)
  ask.flush(3)
  assert.equal(frames.length, 0, 'no frame asked for')
  releases.shift()()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(sent, [1, 3], 'the flushed value, not the scrub before it')
  releases.shift()()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(sent, [1, 3])
})

test('a click on the marked range lands on a frame', async () => {
  const { rangeClickTicks } = await import('./model.ts')
  const rate = rateOf(24)
  const fd = frameTicks(rate)
  const at = rangeClickTicks({ start: 0, end: 100 * fd }, rate, 101, 200)
  assert.equal(at % fd, 0)
  assert.equal(at, 50 * fd)
})

test("a range drag ends without an edit when the engine's revision or the item changes under it (upstream source_range::interact)", async () => {
  const { rangeDragLive } = await import('./model.ts')
  const drag = { item: 4, revision: 10 }
  assert.equal(rangeDragLive(drag, 4, 10), true)
  assert.equal(rangeDragLive(drag, 4, 11), false, 'another revision')
  assert.equal(rangeDragLive(drag, 5, 10), false, 'another item')
  assert.equal(rangeDragLive(drag, null, 10), false, 'no item')
})

test('choosing a magnification counts a pick, even the same level again; other view changes do not', () => {
  const picked = monitorViewCommand(DEFAULT_VIEWS, 'view.magnification.200', {}, 'program').views
  assert.equal(picked.program.zoomPick, DEFAULT_VIEWS.program.zoomPick + 1)
  const again = monitorViewCommand(picked, 'view.magnification.200', {}, 'program').views
  assert.equal(again.program.zoomPick, picked.program.zoomPick + 1)
  assert.equal(monitorViewCommand(again, 'view.programZoomFit', {}, 'source').views.program.zoomPick, again.program.zoomPick + 1)
  for (const id of ['view.safeMargins', 'view.pausedRes.quarter', 'view.playbackRes.eighth', 'view.highQualityPlayback']) {
    assert.equal(monitorViewCommand(again, id, {}, 'program').views.program.zoomPick, again.program.zoomPick, id)
  }
})

test("a resolution repaint leaves the playhead alone when it moved after the new scale was asked for", async () => {
  const { repaintTicks } = await import('./model.ts')
  assert.equal(repaintTicks(3, 3, 1000), 1000)
  assert.equal(repaintTicks(3, 4, 1000), null)
})
