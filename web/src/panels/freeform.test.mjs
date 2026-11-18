// The Freeform view (Task 19, upstream `project_views.rs` `freeform_view`, `card_menu`, and
// `project_dialogs.rs`'s Freeform View Options and Save Arrangement): cards hit at the engine's
// places, a drag that moves the selection and whole stacks with one move, a drag cancelled with
// nothing sent, the layout read under its latest key, 200 cards drawn again one at a time, the
// keyboard's items, and the two dialogs with their previews. Run with `pnpm --dir web test:unit`.
import test from 'node:test'
import assert from 'node:assert/strict'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { DEFAULT_FREEFORM, cardAt, cardBox, cardMenuItems, canvasExtent, createCardDrag, createDragEvents, createLatestRead, draggedItem, drawOrder, layoutFor, freeformOptions, layoutCards, layoutKey, moveParams, movesWith, previewFreeformCards, shareCards, stackSizes, visibleCards } from './freeform.ts'
import { createProjectUi } from './projectModel.ts'
import { visibleItems } from './projectRoute.ts'
import { DIALOGS, dialogDeclarations, dialogSteps, previewSteps, previewsInEngine, rebaseDraft, specProblems, viewLinesFor } from '../dialogs/registry.ts'
import { freeformLines, freeformParams, rebaseView } from '../dialogs/project.ts'
import { routeOf } from '../session/invoke.ts'
import { createPreviewGate } from '../session/previewGate.ts'
import { changesProjectView } from '../session/reads.ts'
import { FILM_UI } from '../filmUi.ts'

/** Cards as `project.freeform.layout` answers them: a stack of three (5 first) and two loose cards. */
const CARDS = [
  { item: 5, x: 100, y: 100, size: 128, placed: true, stack: 5 },
  { item: 6, x: 106, y: 106, size: 128, placed: true, stack: 5 },
  { item: 7, x: 112, y: 112, size: 128, placed: true, stack: 5 },
  { item: 8, x: 400, y: 40, size: 128, placed: true, stack: null },
  { item: 9, x: 12, y: 300, size: 200, placed: false, stack: null },
]

const at = (card, fx, fy) => [card.x + card.size * fx, card.y + ((card.size * 9) / 16 + 20) * fy]

test("a press reaches the card the engine put under it: the stack's first card is drawn last, on top of the cards stacked behind it", () => {
  // Drawn deepest first: the stacked cards, then the loose ones, then the stack's first card.
  assert.deepEqual(drawOrder(CARDS).map((card) => card.item), [6, 7, 8, 9, 5])
  // Where the three stacked cards overlap, the press reaches the first one (on top).
  assert.equal(cardAt(CARDS, ...at(CARDS[2], 0.1, 0.1))?.item, 5)
  // Past the first card's corner, the deepest one drawn last there.
  assert.equal(cardAt(CARDS, 112 + 128 + 1, 112 + 92 + 1)?.item, 7)
  assert.equal(cardAt(CARDS, 106 + 128 + 1, 106 + 2)?.item, 6)
  // A loose card, at its own place and size (a Clip Size of its own).
  assert.equal(cardAt(CARDS, ...at(CARDS[4], 0.9, 0.9))?.item, 9)
  assert.equal(cardAt(CARDS, ...at(CARDS[3], 0.5, 0.5))?.item, 8)
  // The box reaches 2 points beyond the card (upstream's `r.expand(2.0)`), and no further.
  assert.deepEqual(cardBox(CARDS[3]), { x: 398, y: 38, width: 132, height: 132 * 0 + 128 * 9 / 16 + 24 })
  assert.equal(cardAt(CARDS, 398, 38)?.item, 8)
  assert.equal(cardAt(CARDS, 397, 60), null)
  // The empty canvas.
  assert.equal(cardAt(CARDS, 5, 5), null)
})

test('the stack badge counts every card of a stack, on its first card', () => {
  assert.deepEqual([...stackSizes(CARDS)], [[5, 3]])
})

test('a drag of a stacked card moves every card of its stack, its first card leading at its own place plus the offset', () => {
  assert.deepEqual([...movesWith(CARDS, 6, [])].sort(), [5, 6, 7])
  assert.deepEqual(moveParams(CARDS, 6, [], { x: 40, y: 20 }, 640), { items: [5, 6, 7], x: 140, y: 120, width: 640 })
  // The stack's first card dragged itself: the same.
  assert.deepEqual(moveParams(CARDS, 5, [], { x: -30, y: 5 }, 640), { items: [5, 6, 7], x: 70, y: 105, width: 640 })
  // Never above or left of the canvas.
  assert.deepEqual(moveParams(CARDS, 8, [], { x: -500, y: -90 }, 640), { items: [8], x: 0, y: 0, width: 640 })
})

test('a drag of a selected card moves the selection with it; an unselected one moves alone', () => {
  assert.deepEqual([...movesWith(CARDS, 8, [9, 8])].sort(), [8, 9])
  assert.deepEqual(moveParams(CARDS, 8, [9, 8], { x: 10, y: 10 }, 640), { items: [8, 9], x: 410, y: 50, width: 640 })
  assert.deepEqual([...movesWith(CARDS, 8, [9])], [8])
  assert.deepEqual(moveParams(CARDS, 8, [9], { x: 10, y: 10 }, 640)?.items, [8])
  // A selected stacked card: the selection, then the rest of its stack, the stack's first card leading.
  assert.deepEqual(moveParams(CARDS, 7, [7, 9], { x: 4, y: 4 }, 640), { items: [5, 7, 9, 6], x: 104, y: 104, width: 640 })
  // A drag of a point or less moves nothing, as upstream's `off.length() > 1.0`.
  assert.equal(moveParams(CARDS, 8, [], { x: 1, y: 0 }, 640), null)
})

test('one drag sends one move on release; Escape (or a drag dropped elsewhere) puts the cards back and sends nothing', () => {
  const sent = []
  const shown = []
  const drag = createCardDrag({ cards: () => CARDS, selection: () => [], width: () => 640, send: (params) => sent.push(params), onChange: (state) => shown.push(state && { item: state.item, offset: state.offset }) })
  drag.start(6, { x: 150, y: 150 })
  drag.move({ x: 170, y: 160 })
  drag.move({ x: 190, y: 170 })
  assert.deepEqual(shown.at(-1), { item: 6, offset: { x: 40, y: 20 } })
  // Escape: the drag ends where it was, the cards go back, and nothing is sent.
  drag.cancel()
  assert.equal(drag.active(), null)
  assert.equal(shown.at(-1), null)
  assert.deepEqual(sent, [])
  // A release after it (the browser's drop and dragend come in either order) sends nothing either.
  assert.equal(drag.drop({ x: 300, y: 300 }), null)
  assert.deepEqual(sent, [])
  // The next drag sends its move once, and the dragend that follows its drop sends nothing more.
  drag.start(6, { x: 150, y: 150 })
  drag.move({ x: 170, y: 160 })
  drag.drop({ x: 190, y: 170 })
  drag.cancel()
  assert.deepEqual(sent, [{ items: [5, 6, 7], x: 140, y: 120, width: 640 }])
  assert.equal(drag.active(), null)
})

/**
 * A drag tracker over CARDS with the browser's events (`createDragEvents`) and a frame queue run by
 * hand; `origin` is the canvas's place in the page (it moves as the canvas scrolls).
 */
function dragRig() {
  const origin = { x: 0, y: 0 }
  const sent = []
  const ended = []
  const frames = []
  const seen = []
  const tracker = createCardDrag({ cards: () => CARDS, selection: () => [], width: () => 640, send: (params) => sent.push(params), onChange: () => undefined })
  const events = createDragEvents({
    tracker,
    toCanvas: (at) => ({ x: at.x - origin.x, y: at.y - origin.y }),
    schedule: (task) => {
      frames.push(task)
      return () => frames.splice(frames.indexOf(task), 1)
    },
    endDrag: () => ended.push(true),
    onFrame: (at) => seen.push(at),
  })
  const runFrames = () => frames.splice(0).forEach((task) => task())
  return { sent, ended, seen, tracker, events, runFrames, origin }
}

test("the browser's Escape (a dragend with no drop) puts the cards back and sends nothing; a drop sends once and the dragend after it nothing more", () => {
  const rig = dragRig()
  rig.events.start(6, { x: 150, y: 150 })
  assert.equal(rig.events.move({ x: 170, y: 160 }), true)
  rig.events.move({ x: 190, y: 170 })
  rig.runFrames()
  assert.deepEqual(rig.tracker.active()?.offset, { x: 40, y: 20 })
  // Escape: the browser ends the drag with no drop.
  rig.events.move({ x: 200, y: 200 })
  rig.events.end()
  rig.runFrames()
  assert.equal(rig.tracker.active(), null)
  assert.deepEqual(rig.sent, [])
  assert.equal(rig.ended.length, 1)
  // Nothing of it is left: another end (the canvas unmounting) ends no item drag of anyone else's.
  rig.events.end()
  assert.equal(rig.ended.length, 1)
  // Nothing of it is left: a late dragover or drop does nothing.
  assert.equal(rig.events.move({ x: 300, y: 300 }), false)
  assert.equal(rig.events.drop({ x: 300, y: 300 }), false)
  assert.deepEqual(rig.sent, [])
  // The next drag: dropped in the view, sent once; its dragend sends nothing more.
  rig.events.start(6, { x: 150, y: 150 })
  rig.events.move({ x: 170, y: 160 })
  assert.equal(rig.events.drop({ x: 190, y: 170 }), true)
  rig.events.end()
  rig.runFrames()
  assert.deepEqual(rig.sent, [{ items: [5, 6, 7], x: 140, y: 120, width: 640 }])
})

test('a card drag keeps following the pointer outside the canvas and the panel (upstream keeps drawing it at the offset), once per frame', () => {
  const rig = dragRig()
  rig.events.start(8, { x: 100, y: 100 })
  // Many dragovers in one frame: one move, at the last point, even far outside the view.
  rig.events.move({ x: 120, y: 110 })
  rig.events.move({ x: 900, y: 600 })
  rig.runFrames()
  assert.deepEqual(rig.tracker.active()?.offset, { x: 800, y: 500 })
  assert.deepEqual(rig.seen, [{ x: 900, y: 600 }])
  rig.events.end()
  assert.deepEqual(rig.sent, [])
})

test("a drag in a canvas that scrolls under it (the browser's auto-scroll, a wheel) keeps the cards under the pointer and drops where they are shown", () => {
  const rig = dragRig()
  rig.events.start(8, { x: 450, y: 100 })
  rig.events.move({ x: 450, y: 180 })
  rig.runFrames()
  assert.deepEqual(rig.tracker.active()?.offset, { x: 0, y: 80 })
  // The canvas scrolls down 200 points with the pointer still: the card goes on with the canvas.
  rig.origin.y = -200
  rig.events.move({ x: 450, y: 180 })
  rig.runFrames()
  assert.deepEqual(rig.tracker.active()?.offset, { x: 0, y: 280 })
  rig.events.drop({ x: 460, y: 190 })
  assert.deepEqual(rig.sent, [{ items: [8], x: 410, y: 40 + 290, width: 640 }])
})

test("a drag whose dragend never comes (its card went mid-drag) ends on a drop anywhere or a pointer move with no button, ending the item drag; a blank dragover is ignored", () => {
  const rig = dragRig()
  rig.events.start(8, { x: 450, y: 100 })
  rig.events.move({ x: 470, y: 120 })
  rig.runFrames()
  // Some engines send a dragover at 0, 0 (and screen 0): the cards do not jump to minus their start.
  rig.events.move({ x: 0, y: 0, screenX: 0 })
  rig.runFrames()
  assert.deepEqual(rig.tracker.active()?.offset, { x: 20, y: 20 })
  // A move with a button still down is the drag going on.
  rig.events.pointer(1)
  assert.notEqual(rig.tracker.active(), null)
  rig.events.pointer(0)
  assert.equal(rig.tracker.active(), null)
  assert.equal(rig.ended.length, 1)
  assert.deepEqual(rig.sent, [])
  // A drop elsewhere in the document (the Timeline's) ends one too, once.
  rig.events.start(8, { x: 450, y: 100 })
  rig.events.end()
  rig.events.end()
  assert.equal(rig.ended.length, 2)
  // A blank drop moves where the pointer last was.
  rig.events.start(8, { x: 450, y: 100 })
  rig.events.move({ x: 480, y: 130 })
  rig.events.drop({ x: 0, y: 0, screenX: 0 })
  assert.deepEqual(rig.sent, [{ items: [8], x: 430, y: 70, width: 640 }])
})

test("the lost-dragend fallback ends a drag only on a buttonless move of the primary pointer of the kind it was pressed with (on iPadOS a hovering Pencil or trackpad ends no finger's drag)", () => {
  const rig = dragRig()
  rig.events.start(8, { x: 450, y: 100 }, 'touch')
  rig.events.pointer(0, { isPrimary: true, pointerType: 'pen' })
  rig.events.pointer(0, { isPrimary: true, pointerType: 'mouse' })
  rig.events.pointer(0, { isPrimary: false, pointerType: 'touch' })
  assert.notEqual(rig.tracker.active(), null)
  assert.equal(rig.ended.length, 0)
  rig.events.pointer(0, { isPrimary: true, pointerType: 'touch' })
  assert.equal(rig.tracker.active(), null)
  assert.equal(rig.ended.length, 1)
  // A mouse drag: the mouse's buttonless move ends it.
  rig.events.start(8, { x: 450, y: 100 }, 'mouse')
  rig.events.pointer(0, { isPrimary: true, pointerType: 'mouse' })
  assert.equal(rig.tracker.active(), null)
  assert.deepEqual(rig.sent, [])
})

test('a drag starts on the card pressed (its element and face), never a preview ghost', () => {
  const element = (attributes) => ({ closest: (selector) => (selector === '[data-item]' && attributes ? { getAttribute: (name) => attributes[name] ?? null } : null) })
  assert.equal(draggedItem(element({ 'data-item': '8' })), 8)
  assert.equal(draggedItem(element({ 'data-item': '8', 'data-preview': 'changed' })), 8)
  assert.equal(draggedItem(element({ 'data-item': '12', 'data-preview': 'added' })), null)
  assert.equal(draggedItem(element({ 'data-item': '5', 'data-preview': 'removed' })), null)
  assert.equal(draggedItem(element(null)), null)
  assert.equal(draggedItem(null), null)
})

test("the layout shown is only its own document's and bin's: another bin's places never show while the next read is in flight", () => {
  const key = (over) => layoutKey({ document: 1, bin: 3, revision: 4, width: 640, options: DEFAULT_FREEFORM, ...over })
  const read = { key: key({}), cards: CARDS }
  assert.equal(layoutFor(read, key({})), CARDS)
  // The same bin, a newer revision, width, or options: the last cards stay until the next read lands.
  assert.equal(layoutFor(read, key({ revision: 5 })), CARDS)
  assert.equal(layoutFor(read, key({ width: 700 })), CARDS)
  assert.equal(layoutFor(read, key({ options: { ...DEFAULT_FREEFORM, cardSize: 200 } })), CARDS)
  // Another bin or document: nothing until its own cards are read.
  assert.equal(layoutFor(read, key({ bin: 9 })), null)
  assert.equal(layoutFor(read, key({ document: 2 })), null)
  assert.equal(layoutFor(null, key({})), null)
  assert.equal(layoutFor(read, null), null)
})

test('the cards a search shows are those of the listed items whose name holds it, in ASCII case', () => {
  const rows = new Map([
    [5, { name: 'Beach.MOV' }],
    [6, { name: 'surf.wav' }],
    [8, { name: 'Beach 2.mov' }],
  ])
  assert.deepEqual(visibleCards(CARDS, rows, '').map((card) => card.item), [5, 6, 8])
  assert.deepEqual(visibleCards(CARDS, rows, 'BEACH').map((card) => card.item), [5, 8])
})

test("the layout is read under the latest key, one read in flight: a late answer for an older revision or width is dropped", async () => {
  const asked = []
  const applied = []
  const answers = new Map()
  const reader = createLatestRead({
    read: (key) => {
      asked.push(key)
      return new Promise((resolve) => answers.set(key, resolve))
    },
    apply: (key, value) => applied.push([key, value]),
  })
  const first = layoutKey({ document: 1, bin: 3, revision: 4, width: 640, options: DEFAULT_FREEFORM })
  const second = layoutKey({ document: 1, bin: 3, revision: 5, width: 640, options: DEFAULT_FREEFORM })
  const third = layoutKey({ document: 1, bin: 3, revision: 5, width: 700.4, options: DEFAULT_FREEFORM })
  reader.want(first)
  reader.want(second)
  reader.want(third)
  // One read in flight: the newer keys wait for it.
  assert.deepEqual(asked, [first])
  answers.get(first)('old')
  await new Promise((resolve) => setTimeout(resolve, 0))
  // The old answer is not drawn; the latest key is read next, once.
  assert.deepEqual(applied, [])
  assert.deepEqual(asked, [first, third])
  answers.get(third)('new')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(applied, [[third, 'new']])
  // The same key wanted again reads nothing; another options key (no revision: Freeform View Options) reads again.
  reader.want(third)
  assert.equal(asked.length, 2)
  reader.want(layoutKey({ document: 1, bin: 3, revision: 5, width: 700, options: { ...DEFAULT_FREEFORM, cardSize: 200 } }))
  assert.equal(asked.length, 3)
  // A width read again within a point keeps its key (no read per pixel of a resize).
  assert.equal(layoutKey({ document: 1, bin: 3, revision: 5, width: 700.4, options: null }), layoutKey({ document: 1, bin: 3, revision: 5, width: 700, options: null }))
})

test("200 cards read again after one moved keep 199 of their objects (the memoized cards draw one again), and an unchanged read keeps the list", () => {
  const before = Array.from({ length: 200 }, (_, index) => ({ item: index + 1, x: 12 + (index % 10) * 152, y: 12 + Math.floor(index / 10) * 116, size: 128, placed: false, stack: null }))
  const read = before.map((card) => ({ ...card }))
  read[57] = { ...read[57], x: 900, y: 40, placed: true }
  const shared = shareCards(before, read)
  assert.equal(shared.filter((card, index) => card === before[index]).length, 199)
  assert.notEqual(shared[57], before[57])
  assert.equal(shareCards(before, before.map((card) => ({ ...card }))), before)
})

test("a Project preview's cards: the preview's, each unchanged one the document's object, then the cards it removes at their document place", () => {
  const preview = [{ ...CARDS[0] }, { ...CARDS[1] }, { ...CARDS[2] }, { ...CARDS[4], size: 240 }, { item: 12, x: 12, y: 500, size: 128, placed: false, stack: null }]
  const cards = previewFreeformCards(CARDS, preview)
  assert.deepEqual(cards.map((card) => card.item), [5, 6, 7, 9, 12, 8])
  assert.equal(cards[0], CARDS[0])
  assert.equal(cards[3].size, 240)
  assert.equal(cards[5], CARDS[3])
})

test('the canvas grows to hold cards beyond the panel (upstream extent)', () => {
  assert.deepEqual(canvasExtent(CARDS, 300, 200), { width: 440 + 128, height: 300 + 112.5 + 60 })
  assert.deepEqual(canvasExtent([], 300, 200), { width: 300, height: 200 })
})

test("a card menu acts on the selection when its card is in it, else on its card (named in the params, never a selection that lands later)", () => {
  assert.deepEqual(cardMenuItems([8, 9], 9), [8, 9])
  assert.deepEqual(cardMenuItems([8, 9], 5), [5])
})

test("the engine's layout and options read as the view takes them", () => {
  assert.deepEqual(layoutCards({ bin: 3, cards: [{ item: 4, x: 1, y: 2, size: 128, placed: false, stack: null }, { item: 'x' }] }), [{ item: 4, x: 1, y: 2, size: 128, placed: false, stack: null }])
  assert.equal(layoutCards(null), null)
  assert.deepEqual(freeformOptions({ freeform: { grid: 40, snap: true } }), { ...DEFAULT_FREEFORM, grid: 40, snap: true })
})

test("the keyboard's items in the Freeform view are upstream's: the bin's own children in the bin's order (not the layout's, which lists placed cards first), listed, matching the search", async () => {
  const ui = createProjectUi()
  // Item 10 is a child the panel does not list (no row); 30 sits in a sub-bin.
  const root = { id: 1, name: 'root', children: [{ item: 5, name: 'Beach.MOV' }, { item: 10, name: 'Beach hidden' }, { item: 8, name: 'surf.wav' }, { item: 9, name: 'Beach 2.mov' }, { id: 2, name: 'Selects', children: [{ item: 30, name: 'Beach 3.mov' }] }] }
  const rows = [{ bin: 2, name: 'Selects', depth: 0 }, ...[5, 8, 9].map((item) => ({ item, name: '', depth: 0, direct: true })), { item: 30, name: 'Beach 3.mov', depth: 0, direct: false }]
  // The layout puts the placed card 9 first: the keyboard does not follow it.
  const query = async (id) => (id === 'project.view.get' ? { view: { mode: 'freeform' } } : id === 'project.freeform.layout' ? { cards: [9, 5, 8].map((item) => ({ item, x: 0, y: 0, size: 128, placed: item === 9, stack: null })) } : id === 'project.items' ? { bin: 1, columns: [], rows } : null)
  const deps = { ui, root: () => root, run: async () => null, query }
  assert.deepEqual(await visibleItems(deps), { icon: true, items: [5, 8, 9] })
  ui.set({ search: 'beach' })
  assert.deepEqual(await visibleItems(deps), { icon: true, items: [5, 9] })
})

test('a bin tab keeps the Freeform view as its own (upstream BinTab view)', () => {
  const ui = createProjectUi()
  ui.openTab(4, 'freeform', 110)
  assert.equal(ui.shownTab()?.mode, 'freeform')
})

// ---- Freeform View Options and Save Arrangement (`project_dialogs.rs`)

const spec = (id) => {
  const found = DIALOGS.get(id)
  assert.ok(found, `${id} is registered`)
  return found
}
const VIEW = { view: { mode: 'freeform' }, freeform: { grid: 20, snap: false, showNames: true, showDurations: true, cardSize: 128 } }
const context = (extra = {}) => ({
  film: null,
  session: null,
  params: {},
  query: async (id, params) => (id === 'project.view.get' ? VIEW : id === 'project.freeform.layout' ? { bin: params?.bin ?? 1, cards: CARDS.map((card) => ({ ...card, width: params?.width })) } : id === 'project.freeform.arrangements' ? { arrangements: ['A'] } : null),
  ...extra,
})

test('Freeform View Options opens on the preferences and its OK sends all five, as upstream; its preview runs it on the scratch session', async () => {
  const options = spec('projectPanel.freeformOptions')
  assert.equal(options.id, 'project.freeform.options')
  assert.deepEqual(specProblems(options), [])
  assert.ok(previewsInEngine(options.preview) && options.preview.includes('project'))
  const draft = await options.defaults(context())
  assert.deepEqual({ ...draft, info: undefined }, { ...VIEW.freeform, info: undefined })
  assert.deepEqual(draft.info.read, VIEW.freeform)
  const larger = { ...draft, cardSize: 200 }
  assert.deepEqual(dialogSteps(options, larger, context()), [{ command: 'project.freeform.options', params: { grid: 20, snap: false, showNames: true, showDurations: true, cardSize: 200 } }])
  assert.deepEqual(previewSteps(options, larger, context()), dialogSteps(options, larger, context()))
  // The preview restarts when what OK sends changes, and only then.
  assert.notDeepEqual(options.previewKey(larger), options.previewKey(draft))
  assert.deepEqual(options.previewKey({ ...draft, unrelated: 1 }), options.previewKey(draft))
  // Upstream's field ids, each declared.
  const stands = new Set(dialogDeclarations(DIALOGS).flatMap((item) => item.upstream))
  for (const id of ['projectDialog.grid', 'projectDialog.cardSize', 'projectDialog.snap', 'projectDialog.showNames', 'projectDialog.showDurations']) assert.ok(stands.has(id), id)
  assert.deepEqual(freeformParams({}), DEFAULT_FREEFORM)
})

test('Freeform View Options lists the options in the strip only while no Freeform view on screen draws them', () => {
  const options = spec('project.freeform.options')
  const t = (key, values = {}) => `${key}:${JSON.stringify(values)}`
  const phrase = (text) => text
  const draft = { ...VIEW.freeform, cardSize: 200, snap: true }
  const drawn = (on) => (drawer) => drawer === 'project:freeform' && on
  assert.deepEqual(viewLinesFor(options, draft, context(), t, phrase, drawn(true)), [])
  const lines = viewLinesFor(options, draft, context(), t, phrase, drawn(false))
  assert.equal(lines.length, 2)
  assert.match(lines[0], /"size":200,"grid":20/)
  assert.match(lines[1], /Snap to grid: freeform\.on/)
  assert.deepEqual(freeformLines(draft, t, phrase, true), [])
  // Another dialog's view lines still follow the List view (Metadata Display's columns).
  const metadata = spec('project.columns.set')
  assert.deepEqual(viewLinesFor(metadata, { columns: ['Name'] }, context(), t, phrase, (drawer) => drawer === 'project:view'), [])
})

test("while Freeform View Options previews, the panel's view commands are refused; card moves and arrangement restores are edits, refused for every preview", () => {
  const options = spec('project.freeform.options')
  const journaled = (id) => (id === 'project.freeform.layout' || id === 'project.freeform.arrangements' ? false : true)
  const gate = createPreviewGate({ open: () => true, own: () => new Set([options.id]), blocked: () => new Set(options.previewBlocks), journaled, message: 'busy' })
  for (const id of ['project.view.set', 'project.sort', 'project.freeform.move', 'project.freeform.restoreArrangement', 'project.freeform.stack']) assert.equal(gate.refusal(id), 'busy', id)
  assert.equal(gate.refusal('project.freeform.options'), null)
  assert.equal(gate.refusal('project.freeform.layout'), null)
  // The options make no revision: the panel reads its view (and so its layout) again after them.
  assert.equal(changesProjectView('project.freeform.options'), true)
})

test("Freeform View Options and Metadata Display follow another's change made while they are open (an agent's call, no revision): the fields left alone take it, the person's own stay, and OK runs on that", async () => {
  const options = spec('project.freeform.options')
  const draft = { ...(await options.defaults(context())), cardSize: 200 }
  const agent = { ...VIEW, freeform: { ...VIEW.freeform, grid: 40, cardSize: 96 } }
  const ctx = context({ query: async (id) => (id === 'project.view.get' ? agent : null) })
  const rebased = await options.viewRebase(draft, ctx)
  assert.equal(rebased.notice, null)
  assert.equal(rebased.draft.grid, 40)
  assert.equal(rebased.draft.cardSize, 200)
  assert.deepEqual(dialogSteps(options, rebased.draft, ctx)[0].params, { grid: 40, snap: false, showNames: true, showDurations: true, cardSize: 200 })
  // Read again before OK (the tick may not have come yet): the same.
  assert.equal((await options.checkOk(draft, ctx)).draft.grid, 40)
  // Nothing changed: nothing to do.
  assert.equal(await options.viewRebase(await options.defaults(context()), context()), null)
  // Metadata Display: the columns left alone follow; once the person has changed them, theirs stay.
  const metadata = spec('project.columns.set')
  const columnsView = (names) => ({ view: { mode: 'list', columns: names.map((name) => ({ name, width: 100 })) }, available: ['Name', 'Label', 'Scene'] })
  const opened = await metadata.defaults(context({ query: async () => columnsView(['Name', 'Label']) }))
  const agentCtx = context({ query: async () => columnsView(['Name', 'Scene']) })
  assert.deepEqual((await metadata.viewRebase(opened, agentCtx)).draft.columns, ['Name', 'Scene'])
  assert.deepEqual((await metadata.checkOk({ ...opened, columns: ['Name'] }, agentCtx)).draft.columns, ['Name'])
  assert.equal(rebaseView({ a: 1, info: { read: { a: 1 } } }, { a: 1, info: { read: { a: 1 } } }, ['a']), null)
})

test('Save Arrangement opens from the canvas menu on its bin and width, sends its name with them, greys OK with no name, and sums up what it records', async () => {
  const save = spec('projectPanel.saveArrangement')
  assert.equal(save.id, 'project.freeform.saveArrangement')
  assert.deepEqual(save.preview, ['summary'])
  assert.deepEqual(specProblems(save), [])
  // Opened with the canvas menu's place; a name runs at once.
  assert.equal(routeOf('projectPanel.saveArrangement', {}, 'project'), 'dialog')
  assert.equal(routeOf('projectPanel.saveArrangement', { bin: 3, width: 640 }, 'project'), 'dialog')
  assert.equal(routeOf('project.freeform.saveArrangement', { name: 'A' }, 'project'), 'session')
  assert.equal(routeOf('projectPanel.freeformOptions', {}, 'project'), 'dialog')
  assert.equal(routeOf('project.freeform.options', { cardSize: 200 }, 'project'), 'session')
  const ctx = context({ params: { bin: 3, width: 640 } })
  const draft = await save.defaults(ctx)
  assert.equal(draft.name, '')
  assert.equal(save.okEnabled(draft), false)
  assert.deepEqual(dialogSteps(save, draft, ctx), [])
  const t = (key, values = {}) => `${key}:${JSON.stringify(values)}`
  assert.deepEqual(save.summary(draft, ctx, t, (text) => text), ['freeform.needsName:{}'])
  const named = { ...draft, name: ' B ' }
  assert.equal(save.okEnabled(named), true)
  assert.deepEqual(dialogSteps(save, named, ctx), [{ command: 'project.freeform.saveArrangement', params: { name: 'B', bin: 3, width: 640 } }])
  assert.deepEqual(save.summary(named, ctx, t, (text) => text), ['freeform.saves:{"name":"B","count":5}'])
  assert.deepEqual(save.summary({ ...draft, name: 'A' }, ctx, t, (text) => text), ['freeform.replaces:{"name":"A","count":5}'])
  // Without the menu's place (a key, the palette): the bin and width the panel showed as it opened.
  const keyed = await save.defaults(context({ projectBin: 7, freeformWidth: 512 }))
  assert.deepEqual(dialogSteps(save, { ...keyed, name: 'C' }, context()), [{ command: 'project.freeform.saveArrangement', params: { name: 'C', bin: 7, width: 512 } }])
  // A revision reads the bin again (a card added meanwhile is recorded) and keeps the name typed.
  const fresh = await save.defaults(context({ params: { bin: 3, width: 640 }, query: async (id) => (id === 'project.freeform.layout' ? { cards: [...CARDS, { item: 13, x: 0, y: 0, size: 128, placed: false, stack: null }] } : { arrangements: [] }) }))
  const rebased = rebaseDraft(save, named, fresh)
  assert.equal(rebased.name, ' B ')
  assert.equal(rebased.info.cards, 6)
})

test("every id upstream's Freeform view and its menus register is declared in filmUi.ts", () => {
  const declared = new Set(FILM_UI.controls.map((item) => item.id))
  const freeform = upstream.elements.map((element) => element.id).filter((id) => /^project\.(freeform$|stack\.|cardMenu\.|canvasMenu\.)/.test(id) || id === 'project.menu.freeformOptions')
  assert.equal(freeform.length, 12)
  assert.deepEqual(freeform.map((id) => `control:${id.replace(/\.?\{\}/g, '')}`).filter((id) => !declared.has(id)), [])
})
