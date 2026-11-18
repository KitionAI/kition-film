// The graphic layer handles on the Program monitor, against upstream's `panels/graphics.rs`
// (`HandleScale`, `HandleDrag::new`, `HandleDrag::quad`, `HandleDrag::props`, `handle_points`,
// `anchor_screen`, `unscale`, and `monitor_overlay`'s press, move, and anchor handling) and
// `monitor_view.rs` `snap_move`.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDLE_GRAB_PX,
  anchorProps,
  anchorScreen,
  dragProps,
  dragQuad,
  handleDrag,
  handlePoints,
  handleViews,
  interruptLayerDrag,
  isLayerClick,
  layerMarks,
  layerView,
  moveProps,
  parseLayerFrame,
  pressTarget,
  sameFrame,
  snappedMove,
} from './layerHandles.ts'

const close = (actual, expected, label = '') => {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${label} length`)
    expected.forEach((value, index) => close(actual[index], value, `${label}[${index}]`))
    return
  }
  if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label} keys`)
    for (const key of Object.keys(expected)) close(actual[key], expected[key], `${label}.${key}`)
    return
  }
  if (typeof expected === 'number') assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`)
  else assert.equal(actual, expected, label)
}

/** A layer as the engine's `graphicLayers` answers it, from its local box and transform (no rotation). */
function layer({ clip = 1, index = 0, kind = 'shape', local, position, anchor = [0, 0], scale = [1, 1], canvas = [1, 0, 0, 1, 0, 0], text = {} }) {
  const [a, b, c, d, e, f] = canvas
  const own = [scale[0], 0, 0, scale[1], position[0] - scale[0] * anchor[0], position[1] - scale[1] * anchor[1]]
  const toSequence = [a * own[0] + c * own[1], b * own[0] + d * own[1], a * own[2] + c * own[3], b * own[2] + d * own[3], a * own[4] + c * own[5] + e, b * own[4] + d * own[5] + f]
  const at = (x, y) => [toSequence[0] * x + toSequence[2] * y + toSequence[4], toSequence[1] * x + toSequence[3] * y + toSequence[5]]
  return {
    clip,
    layer: index,
    kind,
    quad: [at(local[0], local[1]), at(local[2], local[1]), at(local[2], local[3]), at(local[0], local[3])],
    scale: Math.sqrt(Math.abs(toSequence[0] * toSequence[3] - toSequence[1] * toSequence[2])),
    ...(kind === 'text' ? { text: 'Hello', size: 60, vertical: false, paragraph: false, ...text } : {}),
    frame: parseLayerFrame({ local, toSequence, canvas, transform: { position, anchor, scale }, ...(kind === 'text' ? { box: text.box ?? [0, 0], overflow: text.overflow ?? false } : {}) }),
  }
}

const HALF = { zoom: 0.5, x: 0, y: 0 }
const ONE = { zoom: 1, x: 0, y: 0 }
// A 200 x 100 rectangle centred at 960, 540 on the sequence's own canvas: on screen at half size, 430,245 to 530,295.
const rectangle = () => layer({ local: [-100, -50, 100, 50], position: [960, 540] })

test('a layer on screen: its quad, its eight handles, and its anchor point', () => {
  const view = layerView(rectangle(), HALF)
  close(view.quad, [{ x: 430, y: 245 }, { x: 530, y: 245 }, { x: 530, y: 295 }, { x: 430, y: 295 }], 'quad')
  close(handlePoints(view.quad).slice(4), [{ x: 480, y: 245 }, { x: 530, y: 270 }, { x: 480, y: 295 }, { x: 430, y: 270 }], 'edges: top, right, bottom, left')
  close(anchorScreen(view), { x: 480, y: 270 }, 'anchor')
  assert.equal(layerView({ ...rectangle(), frame: null }, HALF), null, 'no frame from the engine: no handles')
})

test('HandleDrag::props for a shape: Stretch, a corner both axes, an edge one, the pinned side still', () => {
  const view = layerView(rectangle(), HALF)
  // Bottom-right corner 50 points right and 25 down: half as large again, the top-left corner pinned.
  const corner = handleDrag(view, 2, { x: 530, y: 295 }, { x: 580, y: 320 })
  assert.equal(corner.kind, 'stretch')
  close(dragProps(corner, view, 2), { scale: 150, scale_width: 150, position: [1010, 565] }, 'corner')
  close(dragQuad(corner, view)[0], { x: 430, y: 245 }, 'the opposite corner stays')
  // Right edge 50 points right: only the width, the left edge pinned; edges are never uniform.
  const right = handleDrag(view, 5, { x: 530, y: 270 }, { x: 580, y: 270 })
  close(dragProps(right, view, 5), { scale: 100, scale_width: 150, position: [1010, 540], uniform_scale: false }, 'right edge')
  // Top edge 25 points up: only the height, the bottom edge pinned.
  const top = handleDrag(view, 4, { x: 480, y: 245 }, { x: 480, y: 220 })
  close(dragProps(top, view, 4), { scale: 150, scale_width: 100, position: [960, 515], uniform_scale: false }, 'top edge')
  close(dragQuad(top, view), [{ x: 430, y: 220 }, { x: 530, y: 220 }, { x: 530, y: 295 }, { x: 430, y: 295 }], 'top edge quad')
  // Left edge, and a layer already scaled: the factor multiplies its own scale.
  const scaled = layerView(layer({ local: [-100, -50, 100, 50], position: [960, 540], scale: [0.5, 2] }), ONE)
  const left = handleDrag(scaled, 7, { x: 910, y: 540 }, { x: 860, y: 540 })
  close(dragProps(left, scaled, 7), { scale: 200, scale_width: 75, position: [935, 540], uniform_scale: false }, 'left edge of a scaled layer')
  // A drag past the pinned side never flips the layer.
  const through = handleDrag(view, 2, { x: 530, y: 295 }, { x: 300, y: 100 })
  close(dragProps(through, view, 2).scale, 1, 'down to 1%')
})

test('HandleDrag::props for point text: Scale about the anchor, both axes alike, from one side of the box', () => {
  // Point text on its baseline at 400, 300: its box from 400, 220 to 600, 320 on screen at 100%.
  const text = layerView(layer({ kind: 'text', local: [0, -80, 200, 20], position: [400, 300] }), ONE)
  // The bottom-right corner sits 20 points below the anchor along the height: closer than NEAR_ANCHOR, so it counts 80.
  const corner = handleDrag(text, 2, { x: 600, y: 320 }, { x: 600, y: 360 })
  assert.equal(corner.kind, 'scale')
  close(dragProps(corner, text, 2), { scale: 150, scale_width: 150 }, 'corner')
  close(dragQuad(corner, text)[2], { x: 700, y: 330 }, 'the box scales about the anchor')
  // The right edge counts along the width (200 points from the anchor), and never sets uniform_scale.
  const right = handleDrag(text, 5, { x: 600, y: 270 }, { x: 700, y: 270 })
  close(dragProps(right, text, 5), { scale: 150, scale_width: 150 }, 'right edge')
  // The left edge sits on the anchor: it counts as just inside the box, so dragging it in grows.
  const left = handleDrag(text, 7, { x: 400, y: 270 }, { x: 430, y: 270 })
  close(dragProps(left, text, 7), { scale: 150, scale_width: 150 }, 'left edge on the anchor')
  // Vertical text is point text, whatever its box says.
  const vertical = layerView(layer({ kind: 'text', local: [0, -80, 200, 20], position: [400, 300], text: { vertical: true, box: [200, 0] } }), ONE)
  assert.equal(handleDrag(vertical, 2, { x: 600, y: 320 }, { x: 600, y: 360 }).kind, 'scale')
})

test('HandleDrag::props for paragraph text: Resize the box, the opposite side kept and the anchor renumbered', () => {
  const box = (text) => layerView(layer({ kind: 'text', local: [0, 0, 300, 100], position: [100, 700], text: { paragraph: true, ...text } }), ONE)
  const tall = box({ box: [300, 100] })
  const corner = handleDrag(tall, 2, { x: 400, y: 800 }, { x: 450, y: 820 })
  assert.equal(corner.kind, 'resize')
  close(dragProps(corner, tall, 2), { box_width: 350, box_height: 120, anchor: [0, 0] }, 'bottom-right corner')
  // The top-left corner moves the box's origin: the anchor point is renumbered to stay on its spot.
  close(dragProps(handleDrag(tall, 0, { x: 100, y: 700 }, { x: 140, y: 710 }), tall, 0), { box_width: 260, box_height: 90, anchor: [-40, -10] }, 'top-left corner')
  close(dragQuad(handleDrag(tall, 0, { x: 100, y: 700 }, { x: 140, y: 710 }), tall), [{ x: 140, y: 710 }, { x: 400, y: 710 }, { x: 400, y: 800 }, { x: 140, y: 800 }], 'resized quad')
  // Never smaller than half the font size (60): the box does not flip.
  close(dragProps(handleDrag(tall, 2, { x: 400, y: 800 }, { x: 0, y: 0 }), tall, 2), { box_width: 30, box_height: 30, anchor: [0, 0] }, 'smallest box')
  // A box with no height is as tall as its text: a side handle sets only its width.
  const free = box({ box: [300, 0] })
  close(dragProps(handleDrag(free, 5, { x: 400, y: 750 }, { x: 420, y: 750 }), free, 5), { box_width: 320, anchor: [0, 0] }, 'right edge, no height')
  close(dragProps(handleDrag(free, 6, { x: 250, y: 800 }, { x: 250, y: 830 }), free, 6), { box_width: 300, box_height: 130, anchor: [0, 0] }, 'bottom edge sets a height')
})

test('a move is the screen offset through the inverse of the canvas transform, as upstream', () => {
  // The clip's Motion at 50% about the frame's centre, the monitor at half size: a screen point is 4 canvas pixels.
  const halved = layerView(layer({ local: [-100, -50, 100, 50], position: [960, 540], canvas: [0.5, 0, 0, 0.5, 480, 270] }), HALF)
  close(moveProps(halved, { x: 10, y: -5 }), { position: [1000, 520] }, 'scaled')
  // A Motion rotated 90°: right on screen is up on the canvas.
  const turned = layerView(layer({ local: [-100, -50, 100, 50], position: [960, 540], canvas: [0, 1, -1, 0, 1500, -420] }), ONE)
  close(moveProps(turned, { x: 10, y: 0 }), { position: [960, 530] }, 'rotated')
  // The anchor moves over the layer and the position follows it: the layer stays where it is.
  const doubled = layerView(layer({ local: [-100, -50, 100, 50], position: [960, 540], scale: [2, 2] }), HALF)
  close(anchorProps(doubled, { x: 10, y: 4 }), { position: [980, 548], anchor: [10, 4] }, 'anchor')
})

test('a press takes the anchor point first (Selection only), then a handle, within 7 points; front-most first', () => {
  // The anchor point on the top-left corner.
  const cornered = layerView(layer({ local: [-100, -50, 100, 50], position: [860, 490], anchor: [-100, -50] }), HALF)
  const selected = { clip: 1, layers: [0] }
  assert.deepEqual(pressTarget([cornered], selected, 'Selection', { x: 432, y: 247 }), { kind: 'anchor', view: cornered, n: -1 })
  assert.deepEqual(pressTarget([cornered], selected, 'Type', { x: 432, y: 247 }), { kind: 'handle', view: cornered, n: 0 })
  const view = layerView(rectangle(), HALF)
  assert.equal(pressTarget([view], selected, 'Selection', { x: 530 + HANDLE_GRAB_PX, y: 295 })?.n, 2, 'at 7 points')
  assert.equal(pressTarget([view], selected, 'Selection', { x: 530 + HANDLE_GRAB_PX + 1, y: 295 }), null, 'at 8 points')
  assert.equal(pressTarget([view], { clip: 1, layers: [] }, 'Selection', { x: 530, y: 295 }), null, 'only the selected layers have handles')
  assert.equal(pressTarget([view], { clip: 2, layers: [0] }, 'Selection', { x: 530, y: 295 }), null, "another clip's selection")
  // Two selected layers with a handle at the same spot: the front-most (listed first) takes it.
  const front = layerView(layer({ index: 1, local: [-100, -50, 100, 50], position: [960, 540] }), HALF)
  assert.equal(pressTarget([front, view], { clip: 1, layers: [0, 1] }, 'Selection', { x: 530, y: 295 })?.view, front)
})

test('a drag under 2 points is a click; past it, it commits', () => {
  assert.equal(isLayerClick({ x: 100, y: 100 }, { x: 102, y: 100 }), true)
  assert.equal(isLayerClick({ x: 100, y: 100 }, { x: 101.5, y: 101.5 }), false)
  assert.equal(isLayerClick({ x: 100, y: 100 }, { x: 100, y: 100 }), true)
})

test('a move snaps its box through snap_move, and Cmd moves freely', () => {
  const view = layerView(rectangle(), HALF)
  const snap = { snap: true, showGuides: true, guides: [{ vertical: true, position: 600 }] }
  const pic = { x: 0, y: 0, width: 960, height: 540 }
  const frame = { width: 1920, height: 1080 }
  // The guide at 600 frame pixels is at 300 points; the box's left edge (430) moved 126 left is 4 points from it.
  const near = snappedMove(view, snap, pic, frame, { x: -126, y: -100 }, false)
  close(near.off, { x: -130, y: -100 }, 'snapped to the guide')
  assert.deepEqual(near.lines, [{ vertical: true, at: 300 }])
  close(snappedMove(view, snap, pic, frame, { x: -126, y: -100 }, true).off, { x: -126, y: -100 }, 'Cmd: free')
  close(snappedMove(view, { ...snap, snap: false }, pic, frame, { x: -126, y: -100 }, false).off, { x: -126, y: -100 }, 'snapping off')
  close(snappedMove(view, snap, pic, frame, { x: -122, y: -100 }, false).off, { x: -122, y: -100 }, '8 points away: no snap')
  // Unmoved, the box's centre is on the frame's: it stays, with the snap line drawn.
  assert.deepEqual(snappedMove(view, snap, pic, frame, { x: 0, y: 0 }, false).lines.length, 2)
})

test("the engine's layer frame is read defensively", () => {
  assert.equal(parseLayerFrame(null), null)
  assert.equal(parseLayerFrame({ local: [0, 0, 1], toSequence: [1, 0, 0, 1, 0, 0], canvas: [1, 0, 0, 1, 0, 0], transform: { position: [0, 0], anchor: [0, 0], scale: [1, 1] } }), null)
  assert.equal(parseLayerFrame({ local: [0, 0, 1, 1], toSequence: [1, 0, 0, 1, 0, 0], canvas: [1, 0, 0, 1, 0, 0], transform: { position: [0, 0], anchor: [0, 0] } }), null)
  const frame = parseLayerFrame({ local: [0, 0, 1, 1], toSequence: [1, 0, 0, 1, 0, 0], canvas: [1, 0, 0, 1, 0, 0], transform: { position: [5, 6], anchor: [1, 2], scale: [1, 1] }, box: [10, 0], overflow: true })
  assert.deepEqual(frame, { local: [0, 0, 1, 1], toSequence: [1, 0, 0, 1, 0, 0], canvas: [1, 0, 0, 1, 0, 0], position: [5, 6], anchor: [1, 2], scale: [1, 1], box: [10, 0], overflow: true })
})

test('every handle of every kind, table-driven: the props each of the 8 handles sends', () => {
  // Each drag goes outward: a shape's corners half again along their diagonal, its edges half again across.
  const shape = layerView(rectangle(), HALF)
  const shapeRows = [
    [0, { x: 430, y: 245 }, { x: 380, y: 220 }, { scale: 150, scale_width: 150, position: [910, 515] }],
    [1, { x: 530, y: 245 }, { x: 580, y: 220 }, { scale: 150, scale_width: 150, position: [1010, 515] }],
    [2, { x: 530, y: 295 }, { x: 580, y: 320 }, { scale: 150, scale_width: 150, position: [1010, 565] }],
    [3, { x: 430, y: 295 }, { x: 380, y: 320 }, { scale: 150, scale_width: 150, position: [910, 565] }],
    [4, { x: 480, y: 245 }, { x: 480, y: 220 }, { scale: 150, scale_width: 100, position: [960, 515], uniform_scale: false }],
    [5, { x: 530, y: 270 }, { x: 580, y: 270 }, { scale: 100, scale_width: 150, position: [1010, 540], uniform_scale: false }],
    [6, { x: 480, y: 295 }, { x: 480, y: 320 }, { scale: 150, scale_width: 100, position: [960, 565], uniform_scale: false }],
    [7, { x: 430, y: 270 }, { x: 380, y: 270 }, { scale: 100, scale_width: 150, position: [910, 540], uniform_scale: false }],
  ]
  // Point text on its baseline at 400, 300 (box 400,220 to 600,320): every handle scales both axes alike, never uniform_scale.
  const point = layerView(layer({ kind: 'text', local: [0, -80, 200, 20], position: [400, 300] }), ONE)
  const pointRows = [
    [0, { x: 400, y: 220 }, { x: 400, y: 180 }],
    [1, { x: 600, y: 220 }, { x: 600, y: 180 }],
    [2, { x: 600, y: 320 }, { x: 600, y: 360 }],
    [3, { x: 400, y: 320 }, { x: 400, y: 360 }],
    [4, { x: 500, y: 220 }, { x: 500, y: 180 }],
    [5, { x: 600, y: 270 }, { x: 700, y: 270 }],
    [6, { x: 500, y: 320 }, { x: 500, y: 360 }],
    [7, { x: 400, y: 270 }, { x: 430, y: 270 }],
  ].map(([n, from, to]) => [n, from, to, { scale: 150, scale_width: 150 }])
  // Paragraph text in a 300 x 100 box at 100, 700: each handle moves its own sides by 20 across and 10 down.
  const paragraph = layerView(layer({ kind: 'text', local: [0, 0, 300, 100], position: [100, 700], text: { paragraph: true, box: [300, 100] } }), ONE)
  const paragraphRows = [
    [0, { x: 100, y: 700 }, { x: 80, y: 690 }, { box_width: 320, box_height: 110, anchor: [20, 10] }],
    [1, { x: 400, y: 700 }, { x: 420, y: 690 }, { box_width: 320, box_height: 110, anchor: [0, 10] }],
    [2, { x: 400, y: 800 }, { x: 420, y: 810 }, { box_width: 320, box_height: 110, anchor: [0, 0] }],
    [3, { x: 100, y: 800 }, { x: 80, y: 810 }, { box_width: 320, box_height: 110, anchor: [20, 0] }],
    [4, { x: 250, y: 700 }, { x: 250, y: 690 }, { box_width: 300, box_height: 110, anchor: [0, 10] }],
    [5, { x: 400, y: 750 }, { x: 420, y: 750 }, { box_width: 320, box_height: 100, anchor: [0, 0] }],
    [6, { x: 250, y: 800 }, { x: 250, y: 810 }, { box_width: 300, box_height: 110, anchor: [0, 0] }],
    [7, { x: 100, y: 750 }, { x: 80, y: 750 }, { box_width: 320, box_height: 100, anchor: [20, 0] }],
  ]
  for (const [label, view, kind, rows] of [['shape', shape, 'stretch', shapeRows], ['point text', point, 'scale', pointRows], ['paragraph text', paragraph, 'resize', paragraphRows]]) {
    assert.equal(rows.length, 8, label)
    for (const [n, from, to, props] of rows) {
      close(handlePoints(view.quad)[n], from, `${label} handle ${n} sits at`)
      const drag = handleDrag(view, n, from, to)
      assert.equal(drag.kind, kind, `${label} handle ${n}`)
      close(dragProps(drag, view, n), props, `${label} handle ${n}`)
    }
  }
})

test("a host's hidden id draws none of that part: the box, the handles, and the anchor point each on their own", () => {
  const view = layerView(rectangle(), HALF)
  const all = { layer: true, handle: true, anchor: true }
  const ids = (parts) => parts.map((part) => part.attributes['data-kit-ui-id'] ?? null)
  const shown = layerMarks(view, all)
  assert.deepEqual(ids(shown).filter((id) => id === 'control:program.layer').length, 1)
  assert.deepEqual(ids(shown).filter((id) => id === 'control:program.layer.handle').length, 8)
  assert.deepEqual(ids(shown).filter((id) => id === 'control:program.layer.anchor').length, 1)
  // Every drawn part carries its id: a hidden one is not drawn at all, never drawn without its id.
  for (const hidden of ['layer', 'handle', 'anchor']) {
    const parts = layerMarks(view, { ...all, [hidden]: false })
    const id = hidden === 'layer' ? 'control:program.layer' : `control:program.layer.${hidden}`
    assert.equal(ids(parts).filter((each) => each === id).length, 0, `${hidden} hidden`)
    assert.equal(parts.filter((part) => part.className.split(' ').includes(hidden === 'layer' ? 'film-gfx-selected' : hidden === 'handle' ? 'film-gfx-handle' : 'film-gfx-anchor')).length, 0, `${hidden} hidden: no part drawn`)
  }
  // A paragraph box that hides text: its bottom-right handle is the red plus.
  const hiding = layerView(layer({ kind: 'text', local: [0, 0, 300, 100], position: [100, 700], text: { paragraph: true, box: [300, 100], overflow: true } }), ONE)
  assert.ok(layerMarks(hiding, all).some((part) => part.className.includes('film-gfx-overflow') && part.attributes['data-handle'] === 2))
})

test('sameFrame compares where the layer sits, not whether its box hides text', () => {
  const row = { local: [0, 0, 300, 100], toSequence: [1, 0, 0, 1, 100, 700], canvas: [1, 0, 0, 1, 0, 0], transform: { position: [100, 700], anchor: [0, 0], scale: [1, 1] }, box: [300, 100] }
  // Read before the press selected it (overflow not laid out: null) and after (true): the same place.
  assert.equal(sameFrame(parseLayerFrame({ ...row, overflow: null }), parseLayerFrame({ ...row, overflow: true })), true)
  assert.equal(sameFrame(parseLayerFrame(row), parseLayerFrame({ ...row, transform: { ...row.transform, position: [101, 700] } })), false, 'moved')
  assert.equal(sameFrame(parseLayerFrame(row), parseLayerFrame({ ...row, box: [320, 100] })), false, 'resized')
  assert.equal(sameFrame(parseLayerFrame(row), null), false, 'gone')
})

test('an Escape, a blur, or a lost capture: what the press remembers, drops, and detaches', () => {
  const at = (state) => ({ dragging: true, decided: false, released: false, cancelled: false, active: false, ...state })
  // A layer drag running: dropped, its listeners detached.
  assert.deepEqual(interruptLayerDrag(at({ decided: true, active: true }), 'escape'), { remember: false, drop: true, detach: true })
  assert.deepEqual(interruptLayerDrag(at({ decided: true, active: true }), 'lost'), { remember: false, drop: true, detach: true })
  // Before the press's read landed: remembered, so a layer drag it becomes is dropped then. A lost
  // capture or blur also detaches (the release may never come back to the canvas).
  assert.deepEqual(interruptLayerDrag(at({}), 'escape'), { remember: true, drop: false, detach: false })
  assert.deepEqual(interruptLayerDrag(at({}), 'lost'), { remember: true, drop: false, detach: true })
  assert.deepEqual(interruptLayerDrag(at({ dragging: false }), 'lost'), { remember: true, drop: false, detach: true })
  // Decided, and not a layer drag (a Type box drag): no cancel; a lost capture only detaches.
  assert.deepEqual(interruptLayerDrag(at({ decided: true }), 'escape'), { remember: false, drop: false, detach: false })
  assert.deepEqual(interruptLayerDrag(at({ decided: true }), 'lost'), { remember: false, drop: false, detach: true })
  // Before the drag began, an Escape is not the press's.
  assert.deepEqual(interruptLayerDrag(at({ dragging: false }), 'escape'), { remember: false, drop: false, detach: false })
  // Released or already dropped: nothing.
  for (const done of [{ released: true }, { cancelled: true }]) for (const cause of ['escape', 'lost']) assert.deepEqual(interruptLayerDrag(at({ ...done, active: true }), cause), { remember: false, drop: false, detach: false })
})

test("a press skips the parts a host does not let it use: a disabled anchor point leaves the handle under it", () => {
  const cornered = layerView(layer({ local: [-100, -50, 100, 50], position: [860, 490], anchor: [-100, -50] }), HALF)
  const selected = { clip: 1, layers: [0] }
  assert.equal(pressTarget([cornered], selected, 'Selection', { x: 432, y: 247 }, { anchor: false, handle: true })?.kind, 'handle')
  assert.equal(pressTarget([cornered], selected, 'Selection', { x: 432, y: 247 }, { anchor: true, handle: false })?.kind, 'anchor')
  assert.equal(pressTarget([cornered], selected, 'Selection', { x: 432, y: 247 }, { anchor: false, handle: false }), null)
})

test('the layer being typed into has no handles to grab: a press near its box is the text field\'s', () => {
  const text = layer({ kind: 'text', local: [0, -80, 200, 20], position: [400, 300] })
  const shape = layer({ index: 1, local: [-100, -50, 100, 50], position: [960, 540] })
  assert.deepEqual(handleViews([text, shape], ONE, null).map((view) => view.layer.layer), [0, 1])
  assert.deepEqual(handleViews([text, shape], ONE, { clip: 1, layer: 0 }).map((view) => view.layer.layer), [1])
})

test('a handle is named as upstream: "resize handle" on paragraph text, "scale handle" otherwise', () => {
  const all = { layer: true, handle: true, anchor: true }
  const labels = (view) => [...new Set(layerMarks(view, all).filter((part) => part.attributes['data-kit-ui-id'] === 'control:program.layer.handle').map((part) => part.attributes['aria-label']))]
  assert.deepEqual(labels(layerView(rectangle(), HALF)), ['scale handle'])
  assert.deepEqual(labels(layerView(layer({ kind: 'text', local: [0, -80, 200, 20], position: [400, 300] }), ONE)), ['scale handle'])
  assert.deepEqual(labels(layerView(layer({ kind: 'text', local: [0, 0, 300, 100], position: [100, 700], text: { paragraph: true, box: [300, 100] } }), ONE)), ['resize handle'])
})
