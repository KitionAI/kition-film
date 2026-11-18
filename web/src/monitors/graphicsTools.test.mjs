// The Program monitor's graphics tools, against upstream's `panels/graphics.rs` (`monitor_overlay`,
// `new_text_action`, `canvas_target`, `finish_pen`, `LayerView::hit`) and `monitor_view.rs` `pan_input`.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PEN_CLOSE_PX,
  editBox,
  hitsLayer,
  layerAt,
  newTextParams,
  outlinedLayers,
  parseGraphicLayers,
  penCloses,
  penShapeParams,
  pictureOverflows,
  pressKind,
  shapeParams,
  toCanvas,
  toSequence,
} from './graphicsTools.ts'

const near = (actual, expected, label) => {
  for (const key of Object.keys(expected)) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${label ?? ''} ${key}: ${actual[key]} != ${expected[key]}`)
}

test('canvas and sequence pixels map both ways at Fit', () => {
  // A 1920 x 1080 sequence fitted in a 960 x 600 canvas: half size, centred with 30 px above and below.
  const fit = { zoom: 0.5, x: 0, y: -60 }
  near(toSequence(fit, { x: 480, y: 300 }), { x: 960, y: 540 }, 'centre')
  near(toSequence(fit, { x: 0, y: 30 }), { x: 0, y: 0 }, 'top left of the picture')
  near(toCanvas(fit, { x: 1920, y: 1080 }), { x: 960, y: 570 }, 'bottom right of the picture')
  near(toCanvas(fit, toSequence(fit, { x: 123.5, y: 77.25 })), { x: 123.5, y: 77.25 }, 'round trip')
})

test('canvas and sequence pixels map both ways at 200% with a pan', () => {
  // 200% on a 1x display is two canvas pixels per sequence pixel; panned so (700, 400) is at the top left.
  const zoomed = { zoom: 2, x: 700, y: 400 }
  near(toSequence(zoomed, { x: 100, y: 50 }), { x: 750, y: 425 })
  near(toCanvas(zoomed, { x: 750, y: 425 }), { x: 100, y: 50 })
  near(toCanvas(zoomed, { x: 700, y: 400 }), { x: 0, y: 0 })
  near(toSequence(zoomed, toCanvas(zoomed, { x: 1234, y: 567 })), { x: 1234, y: 567 }, 'round trip')
})

test('the Pen closes on its first point within upstream radius (8 px on screen), from the third point on', () => {
  assert.equal(PEN_CLOSE_PX, 8, 'graphics.rs: `(fs - p).length() <= 8.0`')
  const view = { zoom: 0.5, x: 0, y: 0 }
  const points = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }]
  // The first point is at (50, 50) on the canvas.
  assert.equal(penCloses(points, { x: 58, y: 50 }, view), true, '8 px away closes')
  assert.equal(penCloses(points, { x: 54, y: 56 }, view), true, 'about 7 px away closes')
  assert.equal(penCloses(points, { x: 59, y: 50 }, view), false, '9 px away adds a point')
  assert.equal(penCloses(points.slice(0, 2), { x: 50, y: 50 }, view), false, 'two points never close')
  // At 200% the same canvas radius is a quarter of the sequence distance.
  assert.equal(penCloses(points, { x: 50 * 4 + 8, y: 50 * 4 }, { zoom: 2, x: 0, y: 0 }), true)
  assert.equal(penCloses(points, { x: 50 * 4 + 9, y: 50 * 4 }, { zoom: 2, x: 0, y: 0 }), false)
})

test("a finished Pen path is graphics.newShape's path about its centroid", () => {
  const points = [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 400 }]
  assert.deepEqual(penShapeParams(points, null), { shape: 'path', position: [300, 200], points: [[-200, -100], [100, -100], [100, 200]] })
  // Into the selected graphic, on its canvas (its Motion at 50% about the frame centre).
  const target = { clip: 7, matrix: [0.5, 0, 0, 0.5, 480, 270] }
  const params = penShapeParams([{ x: 480, y: 270 }, { x: 980, y: 270 }, { x: 980, y: 770 }], target)
  assert.equal(params.clip, 7)
  assert.deepEqual(params.position.map((value) => Math.round(value * 1000) / 1000), [666.667, 333.333])
  assert.equal(params.points.length, 3)
  assert.equal(penShapeParams(points.slice(0, 2), null), null, 'a path needs three points')
})

test('the Type tool: a click is point text at 100 px per 1080 lines, a drag a paragraph box', () => {
  assert.deepEqual(newTextParams(1080, null, { x: 400, y: 300 }), { text: '', position: [400, 300], size: 100 })
  assert.equal(newTextParams(720, null, { x: 0, y: 0 }).size, 67, 'size is rounded')
  assert.deepEqual(newTextParams(1080, null, { x: 500, y: 400 }, { x: 300, y: 300 }), { text: '', position: [300, 300], size: 100, box: [200, 100] })
  assert.deepEqual(newTextParams(1080, null, { x: 500, y: 400 }, { x: 497, y: 300 }), { text: '', position: [500, 400], size: 100 }, 'a box under 4 px wide was meant as a click')
  const target = { clip: 3, matrix: [0.5, 0, 0, 0.5, 480, 270] }
  assert.deepEqual(newTextParams(1080, target, { x: 480, y: 270 }), { text: '', position: [0, 0], size: 100, clip: 3 })
})

test('Rectangle and Ellipse drags are graphics.newShape about the centre, on the target canvas', () => {
  assert.deepEqual(shapeParams('Rectangle', null, { x: 300, y: 400 }, { x: 100, y: 200 }), { shape: 'rectangle', position: [200, 300], size: [200, 200] })
  assert.deepEqual(shapeParams('Ellipse', null, { x: 100, y: 100 }, { x: 500, y: 200 }), { shape: 'ellipse', position: [300, 150], size: [400, 100] })
  const target = { clip: 9, matrix: [0.5, 0, 0, 0.5, 480, 270] }
  assert.deepEqual(shapeParams('Rectangle', target, { x: 480, y: 270 }, { x: 580, y: 370 }), { shape: 'rectangle', position: [100, 100], size: [200, 200], clip: 9 })
})

test('a layer is hit inside its box and 4 screen pixels around it, front-most first', () => {
  const box = { clip: 1, layer: 0, kind: 'text', quad: [[100, 100], [300, 100], [300, 200], [100, 200]], scale: 1 }
  // At 50% four screen pixels are eight sequence pixels.
  assert.equal(hitsLayer(box, { x: 200, y: 150 }, 0.5), true)
  assert.equal(hitsLayer(box, { x: 93, y: 150 }, 0.5), true)
  assert.equal(hitsLayer(box, { x: 91, y: 150 }, 0.5), false)
  assert.equal(hitsLayer(box, { x: 200, y: 207 }, 0.5), true)
  assert.equal(hitsLayer(box, { x: 200, y: 210 }, 0.5), false)
  // A rotated box (45 degrees about its centre) is hit along its own sides.
  const r = Math.SQRT1_2 * 50
  const diamond = { ...box, quad: [[200, 150 - 2 * r], [200 + 2 * r, 150], [200, 150 + 2 * r], [200 - 2 * r, 150]] }
  assert.equal(hitsLayer(diamond, { x: 200, y: 150 }, 1), true)
  assert.equal(hitsLayer(diamond, { x: 200 - 2 * r + 10, y: 150 - 2 * r + 10 }, 1), false, 'the corner of its bounding box is outside')
  // An empty point text has no width yet: its line is still hit.
  const empty = { ...box, quad: [[400, 300], [400, 300], [400, 380], [400, 380]] }
  assert.equal(hitsLayer(empty, { x: 402, y: 340 }, 1), true)
  const shape = { clip: 1, layer: 1, kind: 'shape', quad: [[150, 120], [250, 120], [250, 180], [150, 180]], scale: 1 }
  assert.equal(layerAt([shape, box], { x: 200, y: 150 }, 1)?.layer, 1, 'the front-most layer')
  assert.equal(layerAt([shape, box], { x: 200, y: 150 }, 1, (layer) => layer.kind === 'text')?.layer, 0, 'the front-most text layer')
  assert.equal(layerAt([shape, box], { x: 900, y: 900 }, 1), null)
})

test('the in-place text field covers the layer on the canvas, at its font size', () => {
  const layer = { clip: 1, layer: 0, kind: 'text', text: 'Hi', size: 100, quad: [[400, 220], [600, 220], [600, 330], [400, 330]], scale: 1 }
  const view = { zoom: 0.5, x: 0, y: -60 }
  assert.deepEqual(editBox(layer, view), { left: 200, top: 140, width: 100, height: 55, fontSize: 50 })
  // A new, empty text still gets a field a caret fits in.
  const empty = { ...layer, text: '', quad: [[400, 220], [400, 220], [400, 330], [400, 330]] }
  const field = editBox(empty, view)
  assert.ok(field.width >= 25 && field.height >= 50, JSON.stringify(field))
})

test('graphicLayers answers are read defensively', () => {
  assert.deepEqual(parseGraphicLayers('{"layers":[],"target":null}'), { layers: [], target: null, selected: null })
  const read = parseGraphicLayers(JSON.stringify({ layers: [{ clip: 4, layer: 1, kind: 'text', text: 'A', size: 90, vertical: false, paragraph: true, quad: [[0, 0], [1, 0], [1, 1], [0, 1]], scale: 2 }, { clip: 4 }], target: { clip: 4, matrix: [1, 0, 0, 1, 0, 0] } }))
  assert.equal(read.layers.length, 1, 'a row without a quad is left out')
  assert.equal(read.layers[0].paragraph, true)
  assert.deepEqual(read.target, { clip: 4, matrix: [1, 0, 0, 1, 0, 0] })
  assert.deepEqual(parseGraphicLayers('not json'), { layers: [], target: null, selected: null })
  assert.deepEqual(parseGraphicLayers('{"layers":[],"target":null,"selected":{"clip":4,"layers":[0,2]}}').selected, { clip: 4, layers: [0, 2] })
  assert.equal(parseGraphicLayers('{"layers":[],"selected":{"clip":4,"layers":"x"}}').selected, null)
})

test("the Program picture's press goes by tool: Hand pans only a magnified picture (pan_input)", () => {
  for (const tool of ['Selection', 'Type', 'VerticalType', 'Rectangle', 'Ellipse', 'Pen']) assert.equal(pressKind(tool, false), 'graphics', tool)
  assert.equal(pressKind('Hand', true), 'pan')
  assert.equal(pressKind('Hand', false), 'none', 'a fitted picture does not pan')
  for (const tool of ['Razor', 'Ripple', 'Zoom', 'Slip', 'TrackSelectForward']) assert.equal(pressKind(tool, true), 'none', tool)
  // Magnified: the picture is larger than its area on either side.
  assert.equal(pictureOverflows({ zoom: 0.5, x: 0, y: -60, width: 960, height: 600 }, 1920, 1080), false)
  assert.equal(pictureOverflows({ zoom: 1, x: 480, y: 240, width: 960, height: 600 }, 1920, 1080), true)
  assert.equal(pictureOverflows({ zoom: 0.25, x: 0, y: 0, width: 960, height: 600 }, 1920, 1080), false, '25% is smaller than the area')
})

test("the selected graphic's selected layers carry an outline, except the one being typed into (graphics.rs boxes)", () => {
  const quad = [[0, 0], [1, 0], [1, 1], [0, 1]]
  const layers = [
    { clip: 1, layer: 2, kind: 'shape', quad, scale: 1 },
    { clip: 1, layer: 1, kind: 'text', quad, scale: 1 },
    { clip: 1, layer: 0, kind: 'text', quad, scale: 1 },
    { clip: 5, layer: 0, kind: 'shape', quad, scale: 1 },
  ]
  const shown = { layers, target: null, selected: { clip: 1, layers: [0, 2] } }
  assert.deepEqual(outlinedLayers(shown, null).map((layer) => [layer.clip, layer.layer]), [[1, 2], [1, 0]])
  assert.deepEqual(outlinedLayers(shown, { clip: 1, layer: 0 }).map((layer) => [layer.clip, layer.layer]), [[1, 2]], 'the edited text has the red box instead')
  assert.deepEqual(outlinedLayers({ ...shown, selected: null }, null), [])
})
