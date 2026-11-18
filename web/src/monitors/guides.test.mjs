// Rulers, guides, guide templates, and Snap in Program Monitor, against upstream's
// `panels/monitor_view.rs` (`route`, `snap_axis`, `snap_move`, `rulers`, `nice_step`, `guides`,
// and `dialogs`).
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VIEWS, monitorViewChecked, monitorViewCommand, servesMonitorView } from './monitorView.ts'
import {
  RULER,
  SNAP_PX,
  addGuideDraft,
  addGuidePreview,
  addGuideParams,
  deleteTemplates,
  dragGuides,
  endGuideDrag,
  guideLines,
  manageApply,
  manageDeletes,
  manageCommit,
  manageDelete,
  manageRebase,
  manageShown,
  niceStep,
  parseTemplates,
  rulerTicks,
  saveTemplate,
  shownGuides,
  snapAxis,
  snapMove,
  snapPoint,
} from './guideModel.ts'

// A 1920 x 1080 frame drawn at half size from (10, 20): k = 0.5 screen points per frame pixel.
const PIC = { x: 10, y: 20, width: 960, height: 540 }
const FRAME = { width: 1920, height: 1080 }
const AREA = { x: 0, y: 0, width: 980, height: 600 }

test('nice_step: the first of 1, 2, 5, 10 … 2000 frame pixels at least 50 points apart, else 5000', () => {
  assert.equal(niceStep(1), 50)
  assert.equal(niceStep(0.5), 100)
  assert.equal(niceStep(0.45), 200)
  assert.equal(niceStep(10), 5)
  assert.equal(niceStep(50), 1)
  assert.equal(niceStep(60), 1)
  assert.equal(niceStep(0.03), 2000)
  assert.equal(niceStep(0.01), 5000)
  assert.equal(RULER, 16)
})

test('ruler ticks: a fifth of the step apart, every fifth one major and labelled, from the picture origin', () => {
  // k 0.5: a step of 100 frame pixels, ticks every 20 (10 points), majors every 100 (50 points).
  const ticks = rulerTicks(0, 120, PIC.x, 0.5)
  assert.deepEqual(
    ticks.filter((tick) => tick.major).map((tick) => [tick.at, tick.value]),
    [
      [10, 0],
      [60, 100],
      [110, 200],
    ],
  )
  assert.equal(ticks.find((tick) => tick.value === 20)?.at, 20)
  assert.equal(ticks.find((tick) => tick.value === 20)?.major, false)
  // Before the picture's origin the values run negative, as upstream's.
  assert.equal(ticks[0].value, -20)
  assert.ok(ticks.every((tick) => tick.at >= -10 && tick.at <= 130))
})

test('snap_axis picks the closest target within reach (upstream test)', () => {
  assert.deepEqual(snapAxis([10, 20, 30], [0, 33, 100], 6), { delta: 3, target: 33 })
  assert.equal(snapAxis([10, 20, 30], [50], 6), null)
  assert.deepEqual(snapAxis([10, 20, 30], [8, 21], 6), { delta: 1, target: 21 })
})

test('snap_move snaps a box to a guide within 6 points and not 8, and to the frame edges and centre', () => {
  assert.equal(SNAP_PX, 6)
  const view = { snap: true, showGuides: true, guides: [{ vertical: true, position: 600 }] }
  // The guide at x 600 is at 10 + 300 = 310 on screen. A 40-point box whose left edge is 6 away snaps to it.
  const box = { x: 304, y: 200, width: 40, height: 20 }
  const six = snapMove(view, PIC, FRAME, box, { x: 0, y: 0 })
  assert.deepEqual(six.off, { x: 6, y: 0 })
  assert.deepEqual(six.lines, [{ vertical: true, at: 310 }])
  // 8 points away: no snap on x (the frame's edges and centre are far too).
  const eight = snapMove(view, PIC, FRAME, { ...box, x: 302 }, { x: 0, y: 0 })
  assert.deepEqual(eight, { off: { x: 0, y: 0 }, lines: [] })
  // The drag offset counts: the box moved by 8 lands 2 from the guide, and snaps the last 2.
  assert.deepEqual(snapMove(view, PIC, FRAME, { ...box, x: 300 }, { x: 8, y: 0 }).off, { x: 10, y: 0 })
  // The frame's centre (y 20 + 270 = 290) takes the box's centre on y.
  const centred = snapMove(view, PIC, FRAME, { x: 500, y: 276, width: 20, height: 20 }, { x: 0, y: 0 })
  assert.deepEqual(centred.off, { x: 0, y: 4 })
  assert.deepEqual(centred.lines, [{ vertical: false, at: 290 }])
  // Guides hidden: only the frame's edges and centre; snapping off: nothing.
  assert.deepEqual(snapMove({ ...view, showGuides: false }, PIC, FRAME, box, { x: 0, y: 0 }).lines, [])
  assert.deepEqual(snapMove({ ...view, snap: false }, PIC, FRAME, { x: 12, y: 22, width: 4, height: 4 }, { x: 1, y: 1 }), { off: { x: 1, y: 1 }, lines: [] })
  // A point (a shape tool's corner) snaps as a box with no size.
  assert.deepEqual(snapPoint(view, PIC, FRAME, { x: 314, y: 150 }), { point: { x: 310, y: 150 }, lines: [{ vertical: true, at: 310 }] })
  assert.deepEqual(snapPoint(view, PIC, FRAME, { x: 318, y: 150 }).point, { x: 318, y: 150 })
})

test('a guide dragged inside the picture area moves to the pointer, rounded to a frame pixel', () => {
  const guides = [
    { vertical: true, position: 600 },
    { vertical: false, position: 100 },
  ]
  const moved = dragGuides(guides, { kind: 'move', index: 1 }, { x: 400, y: 120.6 }, AREA, PIC, FRAME)
  assert.deepEqual(moved.guides, [guides[0], { vertical: false, position: 201 }])
  assert.equal(moved.outside, false)
  assert.deepEqual(endGuideDrag(guides, { kind: 'move', index: 1 }, { x: 400, y: 120.6 }, AREA, PIC, FRAME), moved.guides)
})

test('a guide dropped outside the picture area is removed; dragged outside it keeps its place until the drop', () => {
  const guides = [
    { vertical: true, position: 600 },
    { vertical: false, position: 100 },
  ]
  // Outside (onto the ruler, x < 0): the guide stays drawn where it was, marked to go.
  const outside = dragGuides(guides, { kind: 'move', index: 0 }, { x: -5, y: 300 }, AREA, PIC, FRAME)
  assert.equal(outside.outside, true)
  assert.equal(outside.guides, guides)
  assert.deepEqual(endGuideDrag(guides, { kind: 'move', index: 0 }, { x: -5, y: 300 }, AREA, PIC, FRAME), [guides[1]])
  assert.deepEqual(endGuideDrag(guides, { kind: 'move', index: 1 }, { x: 300, y: 700 }, AREA, PIC, FRAME), [guides[0]])
  // The guides passed in are never changed in place.
  assert.equal(guides.length, 2)
})

test('dragging out of a ruler adds a guide on release inside the picture area, nothing outside', () => {
  const guides = [{ vertical: true, position: 600 }]
  // The left ruler makes a vertical guide, the top ruler a horizontal one.
  const shown = dragGuides(guides, { kind: 'new', vertical: true }, { x: 110, y: 300 }, AREA, PIC, FRAME)
  assert.equal(shown.guides, guides)
  assert.deepEqual(shown.line, { vertical: true, at: 110 })
  assert.deepEqual(endGuideDrag(guides, { kind: 'new', vertical: true }, { x: 110, y: 300 }, AREA, PIC, FRAME), [...guides, { vertical: true, position: 200 }])
  assert.deepEqual(endGuideDrag(guides, { kind: 'new', vertical: false }, { x: 300, y: 290 }, AREA, PIC, FRAME), [...guides, { vertical: false, position: 540 }])
  // Released back on the ruler: no guide, and the same list.
  assert.equal(endGuideDrag(guides, { kind: 'new', vertical: false }, { x: 300, y: -4 }, AREA, PIC, FRAME), guides)
  assert.equal(dragGuides(guides, { kind: 'new', vertical: false }, { x: 300, y: -4 }, AREA, PIC, FRAME).line, null)
})

test("Add Guide's preview draws the guide at its position and orientation, and Cancel leaves the guides as they were", () => {
  const views = monitorViewCommand(DEFAULT_VIEWS, 'view.addGuide', { position: 300, orientation: 'vertical' }, 'program').views
  const before = views.program.guides
  // The dialog opens vertical at the frame's middle, as upstream's route.
  const draft = addGuideDraft(FRAME)
  assert.deepEqual(draft, { vertical: true, position: 960 })
  const typed = { vertical: false, position: 540 }
  const preview = addGuidePreview(typed, 'program')
  const drawn = shownGuides(views.program, preview, 'program')
  assert.deepEqual(
    drawn.map((each) => [each.guide, each.preview]),
    [
      [{ vertical: true, position: 300 }, false],
      [{ vertical: false, position: 540 }, true],
    ],
  )
  // Not on the other monitor, and drawn even while guides are hidden (OK shows them, as upstream's addGuide).
  assert.deepEqual(shownGuides(views.source, preview, 'source'), [])
  assert.deepEqual(
    shownGuides({ ...views.program, showGuides: false }, preview, 'program').map((each) => each.preview),
    [true],
  )
  // Cancel ends the preview: the views were never touched, so the guides are exactly the ones before.
  assert.equal(views.program.guides, before)
  assert.deepEqual(
    shownGuides(views.program, null, 'program').map((each) => each.guide),
    [{ vertical: true, position: 300 }],
  )
  // OK runs upstream's addGuide with the typed values on the monitor the dialog opened for.
  assert.deepEqual(addGuideParams(typed, 'source'), { monitor: 'source', orientation: 'horizontal', position: 540 })
  // The strip lists the guide, so a monitor hidden or off screen still shows the preview: the
  // editor's own strings (not upstream's labels), through t().
  const t = (key, values) => `${key}:${values.position}`
  assert.deepEqual(guideLines([typed, { vertical: true, position: 12.5 }], t), ['guides.horizontal:540', 'guides.vertical:12.5'])
})

test("route: Show Rulers, Show Guides, Lock Guides, Snap, Clear Guides, and Add Guide with a position, upstream's defaults", () => {
  for (const view of [DEFAULT_VIEWS.program, DEFAULT_VIEWS.source]) assert.deepEqual([view.showRulers, view.showGuides, view.lockGuides, view.snap, view.guides], [false, true, false, true, []])
  const rulers = monitorViewCommand(DEFAULT_VIEWS, 'view.showRulers', {}, 'timeline')
  assert.deepEqual(rulers.result, { monitor: 'program', showRulers: true })
  assert.equal(monitorViewCommand(DEFAULT_VIEWS, 'view.showRulers', { monitor: 'source' }, 'program').views.source.showRulers, true)
  assert.deepEqual(monitorViewCommand(DEFAULT_VIEWS, 'view.showGuides', { enabled: false }, 'program').result, { monitor: 'program', showGuides: false })
  assert.deepEqual(monitorViewCommand(DEFAULT_VIEWS, 'view.lockGuides', {}, 'source').result, { monitor: 'source', lockGuides: true })
  // Snap in Program Monitor is the Program's whichever monitor asks, and answers no monitor.
  const snap = monitorViewCommand(DEFAULT_VIEWS, 'view.snapInProgramMonitor', { monitor: 'source' }, 'source')
  assert.deepEqual([snap.result, snap.views.program.snap, snap.views.source.snap], [{ snap: false }, false, true])
  // Add Guide with a position: vertical unless "horizontal", shown, counted.
  const hidden = monitorViewCommand(DEFAULT_VIEWS, 'view.showGuides', { enabled: false }, 'program').views
  const added = monitorViewCommand(hidden, 'view.addGuide', { position: 540, orientation: 'horizontal' }, 'program')
  assert.deepEqual(added.result, { monitor: 'program', guides: 1 })
  assert.deepEqual([added.views.program.guides, added.views.program.showGuides], [[{ vertical: false, position: 540 }], true])
  const second = monitorViewCommand(added.views, 'view.addGuide', { position: 12.5 }, 'program')
  assert.deepEqual(second.views.program.guides[1], { vertical: true, position: 12.5 })
  const cleared = monitorViewCommand(second.views, 'view.clearGuides', {}, 'program')
  assert.deepEqual([cleared.result, cleared.views.program.guides], [{ monitor: 'program', cleared: 2 }, []])
  for (const id of ['view.showRulers', 'view.showGuides', 'view.lockGuides', 'view.snapInProgramMonitor', 'view.clearGuides', 'view.addGuide', 'view.guideTemplates.save', 'view.guideTemplates.manage', 'view.guideTemplates.apply', 'view.guideTemplates.delete']) assert.equal(servesMonitorView(id), true, id)
  // The check marks: the focused monitor's, Snap the Program's.
  assert.equal(monitorViewChecked(rulers.views, 'view.showRulers', 'timeline'), true)
  assert.equal(monitorViewChecked(rulers.views, 'view.showRulers', 'source'), false)
  assert.equal(monitorViewChecked(DEFAULT_VIEWS, 'view.showGuides', 'source'), true)
  assert.equal(monitorViewChecked(snap.views, 'view.snapInProgramMonitor', 'source'), false)
  assert.equal(monitorViewChecked(DEFAULT_VIEWS, 'view.addGuide', 'program'), undefined)
})

test('templates: Save keeps one per name at the end, trimmed; Delete removes by name; anything unreadable is no template', () => {
  const guides = [{ vertical: true, position: 640 }]
  const one = saveTemplate([], ' Thirds ', guides)
  assert.deepEqual(one, [{ name: 'Thirds', guides }])
  const two = saveTemplate([...one, { name: 'Centre', guides: [] }], 'Thirds', [{ vertical: false, position: 1 }])
  assert.deepEqual(two.map((template) => template.name), ['Centre', 'Thirds'])
  assert.throws(() => saveTemplate(one, '  ', guides), /the template needs a name/)
  assert.deepEqual(deleteTemplates(two, ['Centre']), [{ name: 'Thirds', guides: [{ vertical: false, position: 1 }] }])
  assert.deepEqual(parseTemplates([{ name: 'A', guides: [{ vertical: true, position: 3 }, { position: 'x' }] }, { guides: [] }, 7]), [{ name: 'A', guides: [{ vertical: true, position: 3 }] }])
  assert.deepEqual(parseTemplates(null), [])
})

test('Manage: Apply and Delete are previewed and run on Close; another change to their templates drops them', () => {
  const thirds = { name: 'Thirds', guides: [{ vertical: true, position: 640 }, { vertical: true, position: 1280 }] }
  const centre = { name: 'Centre', guides: [{ vertical: false, position: 540 }] }
  let draft = { templates: [thirds, centre], selected: 'Thirds', applied: null, deleted: [] }
  draft = manageApply(draft, 'Thirds')
  assert.deepEqual(draft.applied, thirds)
  draft = manageDelete(draft, 'Centre')
  assert.deepEqual([draft.deleted, draft.selected], [['Centre'], null])
  assert.deepEqual(manageShown(draft).map((template) => template.name), ['Thirds'])
  // Close: the templates without the deleted one, and the applied template's guides for the monitor.
  assert.deepEqual(manageCommit(draft, [thirds, centre]), { templates: [thirds], guides: thirds.guides })
  // Unchanged elsewhere: nothing dropped.
  assert.deepEqual(manageRebase(draft, [thirds, centre]), { draft, dropped: 0 })
  // Another page changed Thirds and deleted Centre: both actions go, and the list follows.
  const changed = { ...thirds, guides: [{ vertical: false, position: 10 }] }
  const rebased = manageRebase(draft, [changed])
  assert.equal(rebased.dropped, 2)
  assert.deepEqual([rebased.draft.templates, rebased.draft.applied, rebased.draft.deleted], [[changed], null, []])
  // A new template elsewhere keeps the queued actions.
  const added = manageRebase(draft, [thirds, centre, { name: 'New', guides: [] }])
  assert.deepEqual([added.dropped, added.draft.applied, added.draft.deleted], [0, thirds, ['Centre']])
})

test("Manage's Close deletes a template only while it is the one the dialog showed; one changed meanwhile is kept, counted", () => {
  const thirds = { name: 'Thirds', guides: [{ vertical: true, position: 640 }] }
  const centre = { name: 'Centre', guides: [{ vertical: false, position: 540 }] }
  const draft = { templates: [thirds, centre], selected: null, applied: null, deleted: ['Thirds', 'Centre'] }
  // Unchanged: both go.
  assert.deepEqual(manageDeletes([thirds, centre, { name: 'New', guides: [] }], draft), { templates: [{ name: 'New', guides: [] }], dropped: 0 })
  // Thirds re-saved elsewhere since: it stays, and the drop is counted; one already gone is no drop.
  const resaved = { name: 'Thirds', guides: [{ vertical: true, position: 1 }] }
  assert.deepEqual(manageDeletes([resaved, centre], draft), { templates: [resaved], dropped: 1 })
  assert.deepEqual(manageDeletes([centre], draft), { templates: [], dropped: 0 })
})
