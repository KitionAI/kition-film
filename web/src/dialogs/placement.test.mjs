// Where a previewing dialog sits by default, and the strip's backstop (Task 11 review): a dialog
// keeps off the panels that draw its preview, and a panel it covers counts as not drawing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseCorner, closesPicker, coveredBy, createLifter, framesFor, liftedPlace, pickerPlace } from './placement.ts'
import { createDrawers, describeDiff, previewNames, stripListing, stripShows } from './preview.ts'

const rect = (x, y, width, height) => ({ x, y, width, height })
const element = (box) => ({ getBoundingClientRect: () => ({ left: box.x, top: box.y, width: box.width, height: box.height, right: box.x + box.width, bottom: box.y + box.height }) })
// The 1100 × 700 Editing layout, roughly: the Project panel bottom left, the Program monitor top
// middle, the Timeline bottom middle.
const area = rect(0, 110, 1100, 560)
const project = rect(0, 430, 385, 240)
const program = rect(325, 110, 320, 315)
const timeline = rect(390, 430, 590, 240)

test('a frame counts as covered when the dialog hides half of it or more', () => {
  assert.equal(coveredBy(project, rect(12, 150, 360, 510)), true)
  assert.equal(coveredBy(program, rect(12, 150, 360, 510)), false, 'a sliver of the Program monitor')
  assert.equal(coveredBy(project, null), false)
  assert.equal(coveredBy(rect(0, 0, 0, 0), rect(0, 0, 10, 10)), false, 'a frame of no size is not covered')
})

test("the default corner is the layout's bottom left unless it covers a panel the preview draws; then the first that covers none", () => {
  const size = { width: 360, height: 510 }
  assert.deepEqual(chooseCorner({ size, area, avoid: [] }), { x: 12, y: 148 }, 'bottom left, 12 px in')
  // Interpret Footage (picture and project): bottom left hides the Project panel; bottom right hides neither.
  assert.deepEqual(chooseCorner({ size, area, avoid: [project, program] }), { x: 728, y: 148 })
})

test('when every corner covers a drawer, the one covering least wins', () => {
  const size = { width: 360, height: 400 }
  const chosen = chooseCorner({ size, area, avoid: [program, timeline] })
  assert.deepEqual(chosen, { x: 12, y: 258 }, 'bottom left only clips the Program monitor')
})

test("the frames to keep clear are those of the drawers for the dialog's kinds", () => {
  const drawers = createDrawers()
  drawers.add('project', undefined, () => element(project))
  drawers.add('picture', undefined, () => element(program))
  drawers.add('timeline', undefined, () => element(timeline))
  assert.deepEqual(framesFor(['picture', 'project'], drawers), [program, project])
  assert.deepEqual(framesFor(['sound'], drawers), [])
  assert.deepEqual(framesFor(['selection'], drawers), [], 'no selection drawer on screen')
})

test('a drawer whose frame the dialog covers does not count as drawing: the strip lists its part', () => {
  const drawers = createDrawers()
  drawers.add('project', undefined, () => element(project))
  const diff = { items: { added: [], removed: [], changed: [{ id: 8, fields: ['interpret'] }] } }
  const t = (key, values = {}) => ({ 'preview.changesFields': '{what}: {fields}', 'preview.noun.items': 'item' })[key]?.replace(/\{(\w+)\}/g, (_, name) => String(values[name])) ?? key
  assert.equal(drawers.drawn('project'), true)
  assert.equal(stripShows(['project'], diff, drawers, null), false)
  drawers.occlude(rect(12, 150, 360, 510))
  assert.equal(drawers.drawn('project'), false)
  assert.equal(stripShows(['project'], diff, drawers, null), true)
  assert.deepEqual(describeDiff(diff, previewNames(null, null), t, stripListing(['project'], drawers)), ['item #8: interpret'])
  drawers.occlude(null)
  assert.equal(drawers.drawn('project'), true)
  // A drawer that names no frame is never covered.
  const bare = createDrawers()
  bare.add('timeline')
  bare.occlude(rect(0, 0, 5000, 5000))
  assert.equal(bare.drawn('timeline'), true)
})

test('a workspace panel a floating window hides half of or more does not count as drawing; a panel inside a window does', () => {
  const drawers = createDrawers()
  drawers.add('project:view', undefined, () => element(project))
  const inWindow = { ...element(rect(16, 126, 520, 360)), closest: (selector) => (selector === '.kui-floating-panel' ? {} : null) }
  drawers.add('project:freeform', undefined, () => inWindow)
  assert.equal(drawers.drawn('project:view'), true)
  let told = 0
  drawers.subscribe(() => (told += 1))
  // A Project bin window over the docked Project panel's List view.
  drawers.floating([rect(0, 400, 400, 280)])
  assert.equal(told, 1)
  assert.equal(drawers.drawn('project:view'), false, "the List view's columns go to the strip")
  // The window's own panel draws, whatever window covers it.
  drawers.floating([rect(0, 400, 400, 280), rect(10, 120, 540, 380)])
  assert.equal(drawers.drawn('project:freeform'), true)
  // The same boxes again tell nobody; a window moved off the panel lets it draw again.
  drawers.floating([rect(0, 400, 400, 280), rect(10, 120, 540, 380)])
  assert.equal(told, 2)
  drawers.floating([rect(600, 120, 400, 280)])
  assert.equal(drawers.drawn('project:view'), true)
})

// ---- Task 14 review: a dialog that grows after it is placed, and the colour picker's pop-up.

test('a dialog that grew past the workspace moves up to its bottom, and one taller than it stays the same place (no update loop)', () => {
  const room = { top: 110, bottom: 670 }
  const at = { x: 12, y: 300 }
  // 300 + 420 = 720 runs 62 px past 670 - 12: up by 62.
  assert.deepEqual(liftedPlace(at, { top: 300, bottom: 720 }, room), { x: 12, y: 238 })
  // Inside: the same object (React keeps its state and draws nothing again).
  assert.equal(liftedPlace(at, { top: 300, bottom: 600 }, room), at)
  // Taller than the workspace: pinned at the top, then the same object each time after.
  const pinned = liftedPlace({ x: 12, y: 200 }, { top: 200, bottom: 900 }, room)
  assert.deepEqual(pinned, { x: 12, y: 122 })
  assert.equal(liftedPlace(pinned, { top: 122, bottom: 822 }, room), pinned)
  // Within half a pixel is no move.
  const close = { x: 12, y: 238.3 }
  assert.equal(liftedPlace(close, { top: 238.3, bottom: 658.4 }, room), close)
  assert.equal(liftedPlace(null, { top: 0, bottom: 900 }, room), null)
})

test("the colour picker's pop-up sits beside the dialog, at its swatch's height, never over the dialog's title", () => {
  const view = { width: 1100, height: 700 }
  const size = { width: 248, height: 330 }
  // A dialog on the right: the pop-up goes to its left, its top at the swatch's.
  const right = { left: 746, top: 128, right: 1086, bottom: 620 }
  assert.deepEqual(pickerPlace({ swatch: { left: 812, top: 186, bottom: 206 }, dialog: right, header: 176, size, view }), { left: 746 - 8 - 248, top: 186 })
  // A dialog on the left: to its right.
  const left = { left: 12, top: 128, right: 352, bottom: 620 }
  assert.deepEqual(pickerPlace({ swatch: { left: 80, top: 186, bottom: 206 }, dialog: left, header: 176, size, view }), { left: 352 + 8, top: 186 })
  // Low in the window: moved up to fit, still beside the dialog.
  assert.deepEqual(pickerPlace({ swatch: { left: 812, top: 600, bottom: 620 }, dialog: right, header: 176, size, view }), { left: 490, top: 700 - 4 - 330 })
  // No room beside it (a dialog as wide as the window): under the swatch, or above it only when
  // that keeps clear of the title; else as high as the title's bottom allows.
  const wide = { left: 4, top: 100, right: 1096, bottom: 690 }
  assert.deepEqual(pickerPlace({ swatch: { left: 60, top: 160, bottom: 180 }, dialog: wide, header: 148, size, view }), { left: 60, top: 184 })
  assert.deepEqual(pickerPlace({ swatch: { left: 60, top: 600, bottom: 620 }, dialog: wide, header: 148, size, view }), { left: 60, top: 600 - 4 - 330 })
  assert.deepEqual(pickerPlace({ swatch: { left: 60, top: 400, bottom: 420 }, dialog: wide, header: 148, size, view }), { left: 60, top: 148 })
})

test("Escape closes the colour picker, but not while an input method composes (WebKit: keyCode 229)", () => {
  assert.equal(closesPicker({ key: 'Escape', isComposing: false, keyCode: 27 }), true)
  assert.equal(closesPicker({ key: 'Escape', isComposing: true, keyCode: 27 }), false)
  assert.equal(closesPicker({ key: 'Escape', isComposing: false, keyCode: 229 }), false)
  assert.equal(closesPicker({ key: 'Enter', isComposing: false, keyCode: 13 }), false)
})

// ---- Task 15 review: a lift converges in one pass, and at most two per open.

test('a lift puts the bottom inside in one pass, from the box as it is, whatever its top was', () => {
  const room = { top: 110, bottom: 670 }
  // The place and the box disagree (the box drawn a frame late): the lift is from the box's height.
  assert.deepEqual(liftedPlace({ x: 12, y: 300 }, { top: 320, bottom: 740 }, room), { x: 12, y: 238 })
})

test('a box whose height changes with its place is lifted at most twice in a row, so it always settles; it lifts again when it grows later', () => {
  const room = { top: 110, bottom: 670 }
  // Each lift makes it taller (its strip wraps as it moves): it would chase the bottom for ever.
  const heightAt = (y) => 420 + (670 - y) * 0.5
  let time = 0
  const lift = createLifter(() => time)
  let at = { x: 12, y: 300 }
  let moves = 0
  for (let frame = 0; frame < 20; frame += 1) {
    const next = lift(at, { top: at.y, bottom: at.y + heightAt(at.y) }, room)
    if (next !== at) moves += 1
    at = next
  }
  assert.ok(moves <= 2, `${moves} lifts`)
  assert.ok(moves >= 1)
  // A second later its strip's picture comes and it grows past the bottom: it moves up again.
  time += 1000
  const later = { x: 12, y: 300 }
  const grown = lift(later, { top: 300, bottom: room.bottom + 40 }, room)
  assert.ok(grown.y < later.y, 'lifted again')
  // A new open lifts again.
  const again = createLifter()
  assert.notEqual(again({ x: 12, y: 300 }, { top: 300, bottom: 720 }, room).y, 300)
})
