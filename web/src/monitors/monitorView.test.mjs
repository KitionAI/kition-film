// The monitors' view options, as upstream's `monitor_view.rs` `route` and `checked` and
// `MonitorView::effective_res`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VIEWS, effectiveRes, monitorViewChecked, monitorViewCommand, servesMonitorView } from './monitorView.ts'

test("starts at upstream's defaults: Playback 1/2, Paused Full, Fit, no safe margins, Composite with no reference, no rulers, guides shown and snapping on", () => {
  for (const view of [DEFAULT_VIEWS.program, DEFAULT_VIEWS.source]) assert.deepEqual(view, { res: 'half', pausedRes: 'full', highQuality: false, zoom: null, safeMargins: false, showTransport: true, zoomPick: 0, display: 'composite', compareRef: null, showRulers: false, showGuides: true, lockGuides: false, snap: true, guides: [] })
})

test('a command acts on params.monitor, else on the focused monitor (Program by default)', () => {
  const quarter = monitorViewCommand(DEFAULT_VIEWS, 'view.playbackRes.quarter', {}, 'timeline')
  assert.deepEqual(quarter.result, { monitor: 'program', playbackRes: '1/4' })
  assert.equal(quarter.views.program.res, 'quarter')
  assert.equal(quarter.views.source, DEFAULT_VIEWS.source)
  assert.equal(monitorViewCommand(DEFAULT_VIEWS, 'view.pausedRes.half', {}, 'source').views.source.pausedRes, 'half')
  assert.equal(monitorViewCommand(DEFAULT_VIEWS, 'view.pausedRes.half', { monitor: 'program' }, 'source').views.program.pausedRes, 'half')
  // The defaults are never changed in place.
  assert.equal(DEFAULT_VIEWS.program.res, 'half')
})

test('magnification, high quality, and safe margins', () => {
  const zoomed = monitorViewCommand(DEFAULT_VIEWS, 'view.magnification.200', {}, 'program')
  assert.deepEqual([zoomed.views.program.zoom, zoomed.result.zoom], [2, 2])
  assert.equal(monitorViewCommand(zoomed.views, 'view.magnification.fit', {}, 'program').views.program.zoom, null)
  const high = monitorViewCommand(DEFAULT_VIEWS, 'view.highQualityPlayback', {}, 'program')
  assert.equal(high.views.program.highQuality, true)
  assert.equal(monitorViewCommand(high.views, 'view.highQualityPlayback', {}, 'program').views.program.highQuality, false)
  assert.equal(monitorViewCommand(DEFAULT_VIEWS, 'view.safeMargins', { enabled: false }, 'program').views.program.safeMargins, false)
  assert.equal(monitorViewCommand(DEFAULT_VIEWS, 'view.safeMargins', {}, 'program').views.program.safeMargins, true)
})

test('answers the check marks of the focused monitor', () => {
  const views = monitorViewCommand(DEFAULT_VIEWS, 'view.playbackRes.quarter', {}, 'source').views
  assert.equal(monitorViewChecked(views, 'view.playbackRes.quarter', 'source'), true)
  assert.equal(monitorViewChecked(views, 'view.playbackRes.quarter', 'timeline'), false)
  assert.equal(monitorViewChecked(views, 'view.playbackRes.half', 'timeline'), true)
  assert.equal(monitorViewChecked(views, 'view.magnification.fit', 'timeline'), true)
  assert.equal(monitorViewChecked(views, 'view.magnification.100', 'timeline'), false)
  assert.equal(monitorViewChecked(views, 'view.zoomIn', 'timeline'), undefined)
})

test('serves the view options and refuses unknown ones', () => {
  for (const id of ['view.playbackRes.full', 'view.pausedRes.sixteenth', 'view.magnification.1600', 'view.highQualityPlayback', 'view.safeMargins', 'view.showRulers']) assert.equal(servesMonitorView(id), true, id)
  for (const id of ['view.showRuler', 'view.playbackRes.third', 'view.magnification.30']) assert.equal(servesMonitorView(id), false, id)
  assert.throws(() => monitorViewCommand(DEFAULT_VIEWS, 'view.playbackRes.third', {}, 'program'))
})

test("effectiveRes: Paused when stopped, Playback while playing, the higher with High Quality", () => {
  const view = { ...DEFAULT_VIEWS.program, res: 'quarter', pausedRes: 'half' }
  assert.equal(effectiveRes(view, false), 'half')
  assert.equal(effectiveRes(view, true), 'quarter')
  assert.equal(effectiveRes({ ...view, highQuality: true }, true), 'half')
  assert.equal(effectiveRes({ ...view, highQuality: true, pausedRes: 'eighth' }, true), 'quarter')
})
