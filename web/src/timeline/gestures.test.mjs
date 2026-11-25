// The Timeline's tools and gestures (upstream `panels/timeline.rs` `interact`, `panels/timeline_hit.rs`):
// what a press grabs, and the one engine command each gesture sends. Pure, on a synthetic layout.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DRAG_THRESHOLD, begin, hitTest, isDrag, moveDrag, placeCommand, preview, release, selectionTrimKind, snapAt } from './gestures.ts'
import { SNAP_PX, snapTo } from './snap.ts'

const TPS = 254_016_000_000
const FRAME = TPS / 24
const at = (seconds) => Math.round(seconds * TPS)
const NONE = { shift: false, alt: false, command: false }
const SHIFT = { ...NONE, shift: true }
const ALT = { ...NONE, alt: true }
const CMD = { ...NONE, command: true }
const CMD_SHIFT = { ...NONE, command: true, shift: true }

/** A clip `x0`–`x1` px on screen (the layout is 100 px a second from x = 0, as upstream's fixture). */
const clip = (id, x0, x1, extra = {}) => ({ id, item: 1, start: at(x0 / 100), duration: at(x1 / 100) - at(x0 / 100), link: null, ...extra })

/**
 * V1 (track 1): A 100–300 (linked to A1's 11), B 300–500 sharing a cut with A, C 504–700 after a
 * 4 px gap, D 800–809 (9 px wide). V2 (track 2): E 1000–1200. A1 (track 3): 11 at 100–300.
 * Rows: V2 at y 40–100, V1 at y 100–160, A1 at y 170–230; the ruler above y 40.
 */
function scene(patch = {}) {
  return {
    tracks: [
      { id: 1, kind: 'video', index: 0, clips: [clip(1, 100, 300, { link: 7 }), clip(2, 300, 500), clip(3, 504, 700), clip(4, 800, 809)], transitions: [] },
      { id: 2, kind: 'video', index: 1, clips: [clip(5, 1000, 1200)], transitions: [] },
      { id: 3, kind: 'audio', index: 0, clips: [clip(11, 100, 300, { link: 7 })], transitions: [] },
    ],
    selection: [],
    playhead: at(20),
    markers: [],
    in: null,
    out: null,
    frame: FRAME,
    tps: TPS,
    snapping: true,
    linkedSelection: true,
    rollRipple: false,
    ...patch,
  }
}

const layout = (patch = {}) => ({
  pps: 100,
  scroll: 0,
  width: 2000,
  ruler: { top: 0, bottom: 40 },
  rows: [
    { track: 2, kind: 'video', index: 1, top: 40, height: 60 },
    { track: 1, kind: 'video', index: 0, top: 100, height: 60 },
    { track: 3, kind: 'audio', index: 0, top: 170, height: 60 },
  ],
  ...patch,
})

const V1 = 110
const edge = (track, clip, side, trim, extra = {}) => ({ kind: 'edge', track, clip, edge: side, trim, ...extra })
const body = (track, clip, side = null) => ({ kind: 'clip', track, clip, edge: side })

/** Presses at `x0`, then (a drag) moves to `x1` and releases there: the commands sent, in order. */
function gesture({ tool, x0, x1 = x0, y0 = V1, y1 = y0, mods = NONE, releaseMods = mods, s = scene(), l = layout() }) {
  const pressed = { x: x0, y: y0, grab: hitTest(s, l, x0, y0, tool, mods) }
  const clicked = !isDrag(x1 - x0, y1 - y0)
  const started = begin(s, l, pressed, tool, mods, clicked)
  const commands = [...started.commands]
  let drag = started.drag
  if (drag && !clicked) {
    drag = moveDrag(s, l, drag, x1, y1, mods).drag
    const last = release(s, l, drag, x1, y1, releaseMods)
    if (last) commands.push(last)
  }
  return { commands, started, drag }
}

test('the side of a cut picks the clip, and free edges reach into the gap', () => {
  const s = scene()
  const l = layout()
  assert.deepEqual(hitTest(s, l, 297, V1, 'Hand', NONE), body(1, 1, 'out'))
  assert.deepEqual(hitTest(s, l, 303, V1, 'Hand', NONE), body(1, 2, 'in'))
  assert.deepEqual(hitTest(s, l, 300, V1, 'Hand', NONE), body(1, 2, 'in'))
  assert.deepEqual(hitTest(s, l, 501, V1, 'Hand', NONE), body(1, 2, 'out'))
  assert.deepEqual(hitTest(s, l, 502, V1, 'Hand', NONE), body(1, 3, 'in'))
  assert.deepEqual(hitTest(s, l, 95, V1, 'Hand', NONE), body(1, 1, 'in'))
  assert.deepEqual(hitTest(s, l, 92, V1, 'Hand', NONE), { kind: 'empty', track: 1 })
  assert.deepEqual(hitTest(s, l, 200, V1, 'Hand', NONE), body(1, 1))
  // A 9 px clip keeps its middle third; 4 px outside is beyond its 3 px zone.
  assert.deepEqual(hitTest(s, l, 804.5, V1, 'Hand', NONE), body(1, 4))
  assert.deepEqual(hitTest(s, l, 796, V1, 'Hand', NONE), { kind: 'empty', track: 1 })
  assert.deepEqual(hitTest(s, l, 300, 20, 'Selection', NONE), { kind: 'ruler' })
  assert.deepEqual(hitTest(s, l, 300, 165, 'Selection', NONE), { kind: 'none' })
  for (const pps of [0, Number.NaN, Number.POSITIVE_INFINITY]) assert.notEqual(hitTest(s, layout({ pps }), 300, V1, 'Selection', NONE).kind, 'edge', `pps ${pps}`)
})

test('the Selection tool trims by modifier and setting, as `selection_trim_kind`', () => {
  const s = scene()
  const l = layout()
  const roll = { left: 1, right: 2 }
  assert.deepEqual(hitTest(s, l, 297, V1, 'Selection', NONE), edge(1, 1, 'out', 'trim'))
  assert.deepEqual(hitTest(s, l, 303, V1, 'Selection', CMD), edge(1, 2, 'in', 'ripple'))
  assert.deepEqual(hitTest(s, l, 303, V1, 'Selection', CMD_SHIFT), edge(1, 2, 'in', 'roll', roll))
  const pref = scene({ rollRipple: true })
  assert.deepEqual(hitTest(pref, l, 298, V1, 'Selection', NONE), edge(1, 1, 'out', 'roll', roll))
  assert.deepEqual(hitTest(pref, l, 305, V1, 'Selection', NONE), edge(1, 2, 'in', 'ripple'))
  // A roll with nothing on the other side of the cut is a regular trim.
  assert.deepEqual(hitTest(s, l, 102, V1, 'Selection', CMD_SHIFT), edge(1, 1, 'in', 'trim'))
  assert.equal(selectionTrimKind(false, false, false, 0, true), 'trim')
  assert.equal(selectionTrimKind(true, false, false, 2.5, true), 'roll')
  assert.equal(selectionTrimKind(true, false, false, 2.6, true), 'ripple')
})

test('which tools trim at an edge', () => {
  const s = scene()
  const l = layout()
  assert.deepEqual(hitTest(s, l, 297, V1, 'Ripple', NONE), edge(1, 1, 'out', 'ripple'))
  assert.deepEqual(hitTest(s, l, 303, V1, 'Rolling', NONE), edge(1, 2, 'in', 'roll', { left: 1, right: 2 }))
  assert.deepEqual(hitTest(s, l, 297, V1, 'RateStretch', NONE), edge(1, 1, 'out', 'stretch'))
  assert.deepEqual(hitTest(s, l, 297, V1, 'Remix', NONE), edge(1, 1, 'out', 'remix'))
  assert.deepEqual(hitTest(s, l, 303, V1, 'Remix', NONE), body(1, 2, 'in'))
  for (const tool of ['Razor', 'Slip', 'Slide', 'Hand', 'Zoom', 'TrackSelectForward']) assert.deepEqual(hitTest(s, l, 297, V1, tool, NONE), body(1, 1, 'out'), tool)
})

test(`a press that moves ${DRAG_THRESHOLD} px or less is a click (egui's \`distance > max_click_dist\`)`, () => {
  assert.equal(isDrag(5, 0), false)
  assert.equal(isDrag(3, 4), false)
  assert.equal(isDrag(DRAG_THRESHOLD, 0), false)
  assert.equal(isDrag(0, -6.01), true)
  assert.equal(isDrag(0, -7), true)
  // A click with Selection on a clip body selects it and moves nothing.
  const { commands } = gesture({ tool: 'Selection', x0: 200, x1: 204 })
  assert.deepEqual(commands, [{ id: 'timeline.select', params: { clips: [1] } }])
})

test('Razor cuts the clip at the frame nearest the press, and Shift cuts every track', () => {
  // 151.3 px is 1.513 s: frame 36.3, nearest frame 36 (1.5 s).
  assert.deepEqual(gesture({ tool: 'Razor', x0: 151.3 }).commands, [{ id: 'timeline.razor', params: { time: at(1.5), clip: 1 } }])
  const shifted = gesture({ tool: 'Razor', x0: 151.3, mods: SHIFT }).commands
  assert.deepEqual(shifted, [{ id: 'timeline.razor', params: { time: at(1.5) } }])
  assert.equal('clip' in shifted[0].params, false)
  // A drag cuts once, where it was pressed.
  assert.deepEqual(gesture({ tool: 'Razor', x0: 151.3, x1: 190 }).commands, [{ id: 'timeline.razor', params: { time: at(1.5), clip: 1 } }])
  // An empty track is not the Razor's: a click there clears the selection, a drag marquees (upstream's `Hit::Empty` arm).
  assert.deepEqual(gesture({ tool: 'Razor', x0: 50, s: scene({ selection: [1] }) }).commands, [{ id: 'timeline.select', params: { clips: [] } }])
  assert.deepEqual(gesture({ tool: 'Razor', x0: 50, y0: 50, x1: 1050, y1: 120 }).commands, [{ id: 'timeline.select', params: { clips: [1, 2, 3, 4, 5], add: false } }])
  assert.equal(gesture({ tool: 'Razor', x0: 50, x1: 90 }).started.drag.kind, 'marquee')
  // The playhead 6 px away pulls the cut onto it.
  assert.deepEqual(gesture({ tool: 'Razor', x0: 160, s: scene({ playhead: at(1.66) }) }).commands, [{ id: 'timeline.razor', params: { time: at(1.66), clip: 1 } }])
})

test('snapping pulls 6 px to the playhead, not 12 px, and only while Snap is on', () => {
  const l = layout()
  assert.equal(SNAP_PX, 9)
  // 15 s is clear of every clip edge.
  assert.deepEqual(snapTo(scene({ playhead: at(15.06) }), l, at(15), [], true), { time: at(15.06), x: 1506 })
  assert.deepEqual(snapTo(scene({ playhead: at(15.12) }), l, at(15), [], true), { time: at(15), x: null })
  assert.deepEqual(snapTo(scene({ playhead: at(15.06), snapping: false }), l, at(15), [], true), { time: at(15), x: null })
  // In, Out, markers, and clip edges; the nearest wins; excluded clips do not count.
  assert.equal(snapTo(scene({ in: at(15.05), markers: [at(15.03)] }), l, at(15), [], true).time, at(15.03))
  assert.equal(snapTo(scene({ out: at(14.95) }), l, at(15), [], true).time, at(14.95))
  assert.equal(snapTo(scene(), l, at(3.04), [], true).time, at(3))
  assert.equal(snapTo(scene(), l, at(3.04), [1, 2, 11], true).time, at(3.04))
  // The playhead dragged along the ruler does not snap to itself.
  assert.equal(snapTo(scene({ playhead: at(15.06) }), l, at(15), [], false).time, at(15))
})

test('a Selection drag on a clip selects it with its link, then moves both in one command', () => {
  const { commands } = gesture({ tool: 'Selection', x0: 200, x1: 250 })
  assert.deepEqual(commands, [
    { id: 'timeline.select', params: { clips: [1] } },
    { id: 'timeline.move', params: { moves: [{ clip: 1, track: 1, time: at(1.5) }, { clip: 11, track: 3, time: at(1.5) }], insert: false, linked: false } },
  ])
  // Onto V2: the picture changes track, its sound stays on A1 (the only audio track).
  const up = gesture({ tool: 'Selection', x0: 200, x1: 200, y1: 70 }).commands.at(-1)
  assert.deepEqual(up.params.moves, [{ clip: 1, track: 2, time: at(1) }, { clip: 11, track: 3, time: at(1) }])
  // Never before the start of the sequence.
  assert.equal(gesture({ tool: 'Selection', x0: 200, x1: 20 }).commands.at(-1).params.moves[0].time, 0)
})

test('Option held at the press or at the drop copies the clips there and leaves them (upstream `copy: mods.alt` or Alt at the release)', () => {
  // Alt-press on an unselected clip takes that side of its link only, and the drop copies it.
  const pressed = gesture({ tool: 'Selection', x0: 200, x1: 250, mods: ALT })
  assert.deepEqual(pressed.commands, [
    { id: 'timeline.select', params: { clips: [1], linked: false } },
    { id: 'timeline.move', params: { moves: [{ clip: 1, track: 1, time: at(1.5) }], insert: false, linked: false, copy: true } },
  ])
  // Alt held only at the drop: the selection (with its link) is copied.
  const dropped = gesture({ tool: 'Selection', x0: 200, x1: 250, releaseMods: ALT }).commands.at(-1)
  assert.deepEqual(dropped, { id: 'timeline.move', params: { moves: [{ clip: 1, track: 1, time: at(1.5) }, { clip: 11, track: 3, time: at(1.5) }], insert: false, linked: false, copy: true } })
  // With Cmd as well the copy inserts.
  assert.equal(gesture({ tool: 'Selection', x0: 200, x1: 250, releaseMods: { ...ALT, command: true } }).commands.at(-1).params.insert, true)
  // No Option at either end: a move.
  assert.equal(gesture({ tool: 'Selection', x0: 200, x1: 250 }).commands.at(-1).params.copy, undefined)
  // The preview draws a copy while Option is held (pressed then, or now), else the clip moving.
  const s = scene()
  const l = layout()
  const started = begin(s, l, { x: 200, y: V1, grab: hitTest(s, l, 200, V1, 'Selection', NONE) }, 'Selection', NONE, false)
  const moving = moveDrag(s, l, started.drag, 250, V1, NONE).drag
  assert.equal(preview(s, moving).get(1).copy, undefined)
  const copying = moveDrag(s, l, moving, 250, V1, ALT).drag
  assert.deepEqual(preview(s, copying).get(1), { start: at(1.5), duration: at(2), track: 1, copy: true })
  // Let go of Option before the drop: back to a move (it was not held at the press).
  assert.equal(moveDrag(s, l, copying, 250, V1, NONE).drag.copying, false)
})

test('Cmd held through a move still snaps (upstream `snap_to` reads Snap only), and its release inserts', () => {
  // The playhead 6 px from where the moved clip would start (1.5 s) pulls it there.
  const near = scene({ playhead: at(1.56) })
  const l = layout()
  const started = begin(near, l, { x: 200, y: V1, grab: hitTest(near, l, 200, V1, 'Selection', CMD) }, 'Selection', CMD, false)
  const moved = moveDrag(near, l, started.drag, 250, V1, CMD)
  assert.equal(moved.drag.offset, at(0.56))
  assert.equal(moved.snapX, 156)
  const sent = release(near, l, moved.drag, 250, V1, CMD)
  assert.equal(sent.id, 'timeline.move')
  assert.equal(sent.params.insert, true)
  assert.equal(sent.params.moves[0].time, at(1.56))
  // Without Cmd at the release it overwrites, snapped the same.
  const plain = release(near, l, moved.drag, 250, V1, NONE)
  assert.equal(plain.params.insert, false)
  assert.equal(plain.params.moves[0].time, at(1.56))
})

test('the Razor line and a drop snap where they land, with the snap indicator', () => {
  const l = layout()
  // 1.52 s is 2 px from the playhead at 1.54 s: the cut and its indicator go there; Snap off, the nearest frame.
  assert.deepEqual(snapAt(scene({ playhead: at(1.54) }), l, 152), { time: at(1.54), x: 154 })
  assert.deepEqual(snapAt(scene({ playhead: at(1.54), snapping: false }), l, 152), { time: at(1.5), x: null })
  // Never before 0.
  assert.deepEqual(snapAt(scene({ playhead: at(20) }), layout({ scroll: 0 }), -40), { time: 0, x: null })
})

test('Slip and Slide measure from where the press was on screen, so an auto-scroll does not add to them', () => {
  const s = scene()
  const pressed = { x: 200, y: V1, grab: hitTest(s, layout(), 200, V1, 'Slip', NONE) }
  const slip = begin(s, layout(), pressed, 'Slip', NONE, false).drag
  // The view scrolled 1 s while the pointer moved 50 px: the slip is 0.5 s, as upstream's `press_origin` read each frame.
  assert.equal(moveDrag(s, layout({ scroll: 1 }), slip, 250, V1, NONE).drag.delta, -at(0.5))
  const slide = begin(s, layout(), { ...pressed, grab: hitTest(s, layout(), 200, V1, 'Slide', NONE) }, 'Slide', NONE, false).drag
  assert.equal(moveDrag(s, layout({ scroll: 1 }), slide, 250, V1, NONE).drag.delta, at(0.5))
})

test('Shift toggles, Alt selects one side of a link, and a selected clip moves with the selection', () => {
  assert.deepEqual(gesture({ tool: 'Selection', x0: 200, mods: SHIFT }).commands, [{ id: 'timeline.select', params: { clips: [1], toggle: true } }])
  assert.deepEqual(gesture({ tool: 'Selection', x0: 200, mods: ALT }).commands, [{ id: 'timeline.select', params: { clips: [1], linked: false } }])
  const alone = gesture({ tool: 'Selection', x0: 200, x1: 250, mods: ALT }).commands.at(-1)
  assert.deepEqual(alone.params.moves.map((move) => move.clip), [1])
  const selected = scene({ selection: [2, 5] })
  const moved = gesture({ tool: 'Selection', x0: 400, x1: 450, s: selected }).commands
  assert.equal(moved.length, 1, 'no select for a clip already selected')
  assert.deepEqual(moved[0].params.moves.map((move) => move.clip), [2, 5])
})

test('edges: Selection trims, Ripple ripples, Rolling rolls, Rate Stretch stretches, Remix remixes', () => {
  // 50 px left is 0.5 s; the Out edge of A at 3 s goes to 2.5 s.
  assert.deepEqual(gesture({ tool: 'Selection', x0: 297, x1: 247 }).commands, [{ id: 'timeline.trim', params: { clip: 1, edge: 'out', mode: 'regular', delta: -at(0.5) } }])
  assert.deepEqual(gesture({ tool: 'Ripple', x0: 297, x1: 247 }).commands, [{ id: 'timeline.trim', params: { clip: 1, edge: 'out', mode: 'ripple', delta: -at(0.5) } }])
  assert.deepEqual(gesture({ tool: 'Rolling', x0: 303, x1: 353 }).commands, [{ id: 'timeline.roll', params: { left: 1, right: 2, delta: at(0.5) } }])
  assert.deepEqual(gesture({ tool: 'RateStretch', x0: 303, x1: 353 }).commands, [{ id: 'timeline.rateStretch', params: { clip: 2, edge: 'in', delta: at(0.5) } }])
  assert.deepEqual(gesture({ tool: 'Remix', x0: 297, x1: 347 }).commands, [{ id: 'clip.remix', params: { clip: 1, duration: at(2.5) } }])
  // The In edge of C (5.04 s) dragged 7 px left lands on B's Out at 5 s.
  assert.deepEqual(gesture({ tool: 'Selection', x0: 507, x1: 500 }).commands, [{ id: 'timeline.trim', params: { clip: 3, edge: 'in', mode: 'regular', delta: at(5) - at(5.04) } }])
  // A drag that ends where it began sends nothing.
  assert.deepEqual(gesture({ tool: 'Selection', x0: 297, x1: 297, y1: V1 + 8 }).commands, [])
})

test('a click on an edge selects it as an edit point', () => {
  assert.deepEqual(gesture({ tool: 'Selection', x0: 297 }).commands, [{ id: 'trim.selectEditPoint', params: { clip: 1, edge: 'out', kind: 'trim', add: false } }])
  assert.deepEqual(gesture({ tool: 'Selection', x0: 297, mods: SHIFT }).commands, [{ id: 'trim.selectEditPoint', params: { clip: 1, edge: 'out', kind: 'trim', add: true } }])
  assert.deepEqual(gesture({ tool: 'Selection', x0: 303, mods: CMD }).commands, [{ id: 'trim.selectEditPoint', params: { clip: 2, edge: 'in', kind: 'ripple', add: false } }])
  assert.deepEqual(gesture({ tool: 'Ripple', x0: 297 }).commands, [{ id: 'trim.selectEditPoint', params: { clip: 1, edge: 'out', kind: 'ripple', add: false } }])
  assert.deepEqual(gesture({ tool: 'Rolling', x0: 102 }).commands, [{ id: 'trim.selectEditPoint', params: { clip: 1, edge: 'in', kind: 'roll', add: false } }])
  // Rate Stretch has no edit point: a click on its edge does nothing.
  assert.deepEqual(gesture({ tool: 'RateStretch', x0: 297 }).commands, [])
})

test('Slip moves the source under the clip, Slide moves the clip between its neighbours', () => {
  assert.deepEqual(gesture({ tool: 'Slip', x0: 200, x1: 250 }).commands, [{ id: 'timeline.slip', params: { clip: 1, delta: -at(0.5) } }])
  assert.deepEqual(gesture({ tool: 'Slide', x0: 400, x1: 375 }).commands, [{ id: 'timeline.slide', params: { clip: 2, delta: -at(0.25) } }])
  assert.deepEqual(gesture({ tool: 'Slip', x0: 200 }).commands, [])
})

test('Track Select selects forward or backward on every track, or one with Shift', () => {
  assert.deepEqual(gesture({ tool: 'TrackSelectForward', x0: 450 }).commands, [{ id: 'timeline.select', params: { clips: [2, 3, 4, 5] } }])
  assert.deepEqual(gesture({ tool: 'TrackSelectBackward', x0: 450 }).commands, [{ id: 'timeline.select', params: { clips: [1, 2, 11] } }])
  assert.deepEqual(gesture({ tool: 'TrackSelectForward', x0: 450, mods: SHIFT }).commands, [{ id: 'timeline.select', params: { clips: [2, 3, 4] } }])
  assert.deepEqual(gesture({ tool: 'TrackSelectForward', x0: 50, y0: 70 }).commands, [{ id: 'timeline.select', params: { clips: [1, 2, 3, 4, 5, 11] } }])
})

test('Zoom doubles at a click, Alt halves, anchored at the pointer; Hand pans', () => {
  assert.deepEqual(gesture({ tool: 'Zoom', x0: 450 }).started.zoom, { factor: 2, time: 4.5, x: 450 })
  assert.deepEqual(gesture({ tool: 'Zoom', x0: 450, mods: ALT }).started.zoom, { factor: 0.5, time: 4.5, x: 450 })
  assert.equal(gesture({ tool: 'Zoom', x0: 450, x1: 500 }).commands.length, 0)
  const s = scene()
  const l = layout()
  const started = begin(s, l, { x: 400, y: V1, grab: hitTest(s, l, 400, V1, 'Hand', NONE) }, 'Hand', NONE, false)
  const moved = moveDrag(s, l, started.drag, 350, V1 + 10, NONE)
  assert.deepEqual(moved.pan, { dx: -50, dy: 10 })
  assert.equal(release(s, l, moved.drag, 350, V1 + 10, NONE), null)
})

test('a drag from empty space selects the clips it crosses; a click there clears the selection', () => {
  assert.deepEqual(gesture({ tool: 'Selection', x0: 760, y0: 50, x1: 1050, y1: 120 }).commands, [{ id: 'timeline.select', params: { clips: [4, 5], add: false } }])
  assert.deepEqual(gesture({ tool: 'Selection', x0: 760, y0: 50, x1: 1050, y1: 120, mods: SHIFT }).commands.at(-1).params.add, true)
  assert.deepEqual(gesture({ tool: 'Selection', x0: 760, s: scene({ selection: [1] }) }).commands, [{ id: 'timeline.select', params: { clips: [] } }])
})

test('the live preview moves only what the release will change', () => {
  const s = scene()
  const l = layout()
  const trim = begin(s, l, { x: 103, y: V1, grab: hitTest(s, l, 103, V1, 'Selection', NONE) }, 'Selection', NONE, false).drag
  const shown = preview(s, moveDrag(s, l, trim, 153, V1, NONE).drag)
  // The In edge moves 0.5 s right on A and on its linked sound.
  assert.deepEqual(shown.get(1), { start: at(1.5), duration: at(1.5), track: null })
  assert.deepEqual(shown.get(11), { start: at(1.5), duration: at(1.5), track: null })
  assert.equal(shown.has(2), false)
  const move = begin(s, l, { x: 200, y: V1, grab: hitTest(s, l, 200, V1, 'Selection', NONE) }, 'Selection', NONE, false).drag
  const moving = moveDrag(s, l, move, 200, 70, NONE)
  assert.deepEqual(preview(s, moving.drag).get(1), { start: at(1), duration: at(2), track: 2 })
  // A Slip changes the source, not the place: nothing moves on the timeline.
  const slip = begin(s, l, { x: 200, y: V1, grab: hitTest(s, l, 200, V1, 'Slip', NONE) }, 'Slip', NONE, false).drag
  assert.equal(preview(s, moveDrag(s, l, slip, 250, V1, NONE).drag).size, 0)
  // The snap indicator shows where the edge snapped.
  assert.equal(moveDrag(scene({ playhead: at(3.5) }), l, trim, 348, V1, NONE).snapX, 350)
})

test('a dropped item is placed on the paired tracks at the snapped time, inserting with Cmd', () => {
  const s = scene()
  const l = layout()
  assert.deepEqual(placeCommand(s, l, 1500, 70, { item: 9 }, NONE), { id: 'timeline.place', params: { item: 9, track: 2, audioTrack: 3, time: at(15), insert: false } })
  assert.deepEqual(placeCommand(s, l, 1500, 200, { item: 9 }, CMD).params, { item: 9, track: 1, audioTrack: 3, time: at(15), insert: true })
  // From the Source monitor: its In–Out range and which halves it carries; an audio-only drag skips video rows.
  const source = { item: 9, sourceIn: at(2), duration: at(3), video: false, audio: true }
  assert.equal(placeCommand(s, l, 1500, 70, source, NONE), null)
  assert.deepEqual(placeCommand(s, l, 1500, 200, source, NONE).params, { item: 9, track: 1, audioTrack: 3, time: at(15), insert: false, sourceIn: at(2), duration: at(3), video: false, audio: true })
  assert.equal(placeCommand(s, l, 1500, 165, { item: 9 }, NONE), null)
})

test("the clip menu is upstream's CLIP_MENU, the manifest's rows in order", async () => {
  const { CLIP_MENU, clipMenuState, opensDialog } = await import('./clipMenuRows.ts')
  const { default: upstream } = await import('../../parity/film-upstream.json', { with: { type: 'json' } })
  const manifest = upstream.elements.filter((element) => /^timeline\.clipMenu\.[a-z]+\.[A-Za-z]+$/.test(element.id) && !/multicam(Enable|Flatten)$/.test(element.id))
  // Multi-Camera is drawn by its own function (`multicam_menu`), so the manifest lists it first.
  const rows = (list) => list.filter(([, command]) => command !== 'clip.multicam')
  assert.deepEqual(rows(CLIP_MENU.flat().map(([label, command]) => [label, command])), rows(manifest.map((element) => [element.label, element.command])))
  assert.ok(manifest.some((element) => element.command === 'clip.multicam'))
  assert.deepEqual(CLIP_MENU.flat().filter(([label]) => opensDialog(label)).map(([, command]) => command), ['edit.pasteAttributes', 'edit.removeAttributes', 'clip.synchronize', 'clip.mergeClips', 'clip.nest', 'clip.speedDuration', 'clip.frameHoldOptions', 'clip.fieldOptions'])
  assert.deepEqual(clipMenuState([{ enabled: true, link: null }, { enabled: true, link: 4 }]), { any: true, allEnabled: true, linked: true })
  assert.deepEqual(clipMenuState([{ enabled: true, link: null }, { enabled: false, link: null }]), { any: true, allEnabled: false, linked: false })
  assert.deepEqual(clipMenuState([]), { any: false, allEnabled: false, linked: false })
})

test("selected edit points draw upstream's brackets: a roll marks both sides of its cut", async () => {
  const { editPointMarks } = await import('./gestures.ts')
  const s = scene()
  assert.deepEqual(editPointMarks(s, [{ clip: 1, out: true, kind: 'trim' }]), [{ clip: 1, track: 1, time: at(3), out: true, ripple: false }])
  assert.deepEqual(editPointMarks(s, [{ clip: 2, out: false, kind: 'ripple' }]), [{ clip: 2, track: 1, time: at(3), out: false, ripple: true }])
  assert.deepEqual(editPointMarks(s, [{ clip: 2, out: false, kind: 'roll' }]), [
    { clip: 1, track: 1, time: at(3), out: true, ripple: false },
    { clip: 2, track: 1, time: at(3), out: false, ripple: false },
  ])
  // A roll with nothing across the cut marks its own edge; a clip that is gone marks nothing.
  assert.deepEqual(editPointMarks(s, [{ clip: 1, out: false, kind: 'roll' }]), [{ clip: 1, track: 1, time: at(1), out: false, ripple: false }])
  assert.deepEqual(editPointMarks(s, [{ clip: 99, out: true, kind: 'trim' }]), [])
})

test('a drop on the empty Timeline makes a sequence from the item (upstream `empty_state`)', async () => {
  const { emptyDropCommand } = await import('./gestures.ts')
  assert.deepEqual(emptyDropCommand({ item: 9 }), { id: 'sequence.new', params: { fromItem: 9 } })
  assert.deepEqual(emptyDropCommand({ item: 9, sourceIn: at(1), duration: at(2), video: true, audio: true }), { id: 'sequence.new', params: { fromItem: 9 } })
})
