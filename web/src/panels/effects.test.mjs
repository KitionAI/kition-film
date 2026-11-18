// Effect Controls' and Properties' model (upstream `panels/effect_controls.rs`): the read-only
// value text (`param_text`), the hot numbers' text, one history step per drag (`run`), and where a
// keyframe sits on the timeline (`timeline_time_of`). Run with `pnpm --dir web test:unit`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEffectsReader, createParamEdit, createPressTracker, keyframeMoveTarget, laneRuler, mediaTimeOf, paramText, readClipEffects, selectedClip, timelineTimeOf } from './effects.ts'

const TPS = 254_016_000_000

test('param_text: a LUT reference reads its label, empty text reads None, other text itself', () => {
  assert.equal(paramText({ id: 'look_lut', kind: 'text', value: 'builtin:look-teal-orange', lutLabel: 'Teal & Orange' }), 'Teal & Orange')
  assert.equal(paramText({ id: 'input_lut', kind: 'text', value: '', lutLabel: 'None' }), 'None')
  assert.equal(paramText({ id: 'label', kind: 'text', value: '' }), 'None')
  assert.equal(paramText({ id: 'label', kind: 'text', value: 'Reel 3' }), 'Reel 3')
})

test('param_text: a curve reads Default when it is the identity or empty, else Custom (n points)', () => {
  assert.equal(paramText({ id: 'curve_luma', kind: 'curve', value: [[0, 0], [1, 1]] }), 'Default')
  assert.equal(paramText({ id: 'hue_vs_sat', kind: 'curve', value: [] }), 'Default')
  assert.equal(paramText({ id: 'curve_luma', kind: 'curve', value: [[0, 0], [0.5, 0.6], [1, 1]] }), 'Custom (3 points)')
})

test("param_text: the other kinds read as upstream's Debug text of the value", () => {
  assert.equal(paramText({ id: 'wheel_shadows', kind: 'wheel', value: [0, 0] }), 'Vec2(Vec2 { x: 0.0, y: 0.0 })')
  assert.equal(paramText({ id: 'wheel_midtones', kind: 'wheel', value: [0.25, -0.5] }), 'Vec2(Vec2 { x: 0.25, y: -0.5 })')
  assert.equal(paramText({ id: 'scale', kind: 'float', value: 100 }), 'Float(100.0)')
  assert.equal(paramText({ id: 'uniform_scale', kind: 'bool', value: true }), 'Bool(true)')
  assert.equal(paramText({ id: 'blend', kind: 'choice', value: 2 }), 'Choice(2)')
})

test('param_text goes through phrase, the point count filled in after', () => {
  const phrase = (text) => `<${text}>`
  assert.equal(paramText({ id: 'label', kind: 'text', value: '' }, phrase), '<None>')
  assert.equal(paramText({ id: 'c', kind: 'curve', value: [[0, 0], [0.2, 0.3], [0.6, 0.6], [1, 1]] }, phrase), '<Custom (4 points)>')
})

test('timeline_time_of: a keyframe at media time m sits at start + (m - sourceIn) / |speed|', () => {
  const clip = { start: 10 * TPS, sourceIn: 4 * TPS, speed: 1, duration: 5 * TPS }
  assert.equal(timelineTimeOf(clip, 6 * TPS), 12 * TPS)
  assert.equal(timelineTimeOf({ ...clip, speed: 2 }, 6 * TPS), 11 * TPS, 'twice as fast: half the distance')
  assert.equal(timelineTimeOf({ ...clip, speed: -0.5 }, 6 * TPS), 14 * TPS, 'reversed: the speed counts without its sign')
  assert.equal(timelineTimeOf({ ...clip, speed: 3 }, 5 * TPS), 10 * TPS + Math.trunc(TPS / 3), 'truncated to a tick, as Rust casts')
  assert.equal(mediaTimeOf({ ...clip, speed: 2 }, 11 * TPS), 6 * TPS)
})

test("a keyframe dragged in the lane lands on a frame inside the clip, in media time (upstream's drag_stopped)", () => {
  const frame = TPS / 24
  const clip = { start: 48 * frame, sourceIn: 24 * frame, speed: 1, duration: 48 * frame }
  // From media frame 24 (timeline 48) 0.51 s later: timeline frame 60.24 snaps to 60, media 36.
  assert.equal(keyframeMoveTarget(clip, 24 * frame, 0.51, frame), 36 * frame)
  // Past the clip's end it stops on its last frame.
  assert.equal(keyframeMoveTarget(clip, 24 * frame, 99, frame), 24 * frame + 47 * frame)
  // Before its start it stops on its first.
  assert.equal(keyframeMoveTarget(clip, 30 * frame, -99, frame), 24 * frame)
  // At speed 2 a timeline frame is two media frames.
  assert.equal(keyframeMoveTarget({ ...clip, speed: 2 }, 24 * frame, 1 / 24, frame), 26 * frame)
})

test("the lane's ruler labels a five-second clip 300 px wide every two seconds, in sequence frames (ruler_labels_sequence_timecode)", () => {
  const ticks = laneRuler(60 * TPS, 5 * TPS, 24, 300)
  assert.deepEqual(ticks.filter((tick) => tick.labelled).map((tick) => tick.frame), [24 * 60, 24 * 62, 24 * 64])
  const first = ticks.find((tick) => tick.labelled)
  assert.equal(first.x, 0)
  // The small ticks divide the labelled ones evenly: 12 frames, 2.4 px a frame.
  assert.deepEqual(ticks.filter((tick) => !tick.labelled).slice(0, 3).map((tick) => tick.frame), [1440, 1452, 1464])
  assert.deepEqual(laneRuler(0, 0, 24, 300), [], 'a clip without a duration draws no ticks')
  assert.deepEqual(laneRuler(0, TPS, 24, Number.NaN), [], 'nor does a lane without a width')
})

test('the clip shown is the first selected video clip, else the first selected audio clip (selected_clip)', () => {
  const tracks = [
    { kind: 'video', clips: [{ id: 1 }, { id: 2 }] },
    { kind: 'audio', clips: [{ id: 3 }] },
  ]
  assert.equal(selectedClip(tracks, [3, 2])?.clip.id, 2)
  assert.equal(selectedClip(tracks, [3])?.kind, 'audio')
  assert.equal(selectedClip(tracks, [9]), null)
})

/** A frame scheduler the test steps by hand. */
function frames() {
  const queue = []
  const frame = (callback) => {
    queue.push(callback)
    return () => queue.splice(queue.indexOf(callback) >>> 0, 1)
  }
  const step = async () => {
    for (const callback of queue.splice(0)) callback()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { frame, step }
}

const target = { clip: 7, effect: 1, param: 'opacity' }

test('one drag sends begin once, then merge, at most once per frame, and its release merges too', async () => {
  const sent = []
  const { frame, step } = frames()
  const edit = createParamEdit(async (id, params) => sent.push([id, params]), frame)
  edit(target, 90, false)
  edit(target, 80, false)
  await step()
  edit(target, 70, false)
  await step()
  edit(target, 70, true)
  await step()
  assert.deepEqual(
    sent.map(([, params]) => [params.value, params.begin ?? null, params.merge ?? null]),
    [
      [80, true, true],
      [70, false, true],
      [70, false, true],
    ],
  )
  assert.ok(sent.every(([id, params]) => id === 'effects.setParam' && params.clip === 7 && params.effect === 1 && params.param === 'opacity'))
})

test('a second drag begins its own step; a typed value is a step of its own, neither begun nor merged', async () => {
  const sent = []
  const { frame, step } = frames()
  const edit = createParamEdit(async (id, params) => sent.push(params), frame)
  edit(target, 50, false)
  await step()
  edit(target, 50, true)
  await step()
  edit(target, 40, false)
  await step()
  edit(target, 40, true)
  await step()
  edit(target, 33, true)
  await step()
  assert.deepEqual(
    sent.map((params) => [params.value, params.begin ?? null, params.merge ?? null]),
    [
      [50, true, true],
      [50, false, true],
      [40, true, true],
      [40, false, true],
      [33, null, null],
    ],
  )
})

test('a release that comes before the frame sends only the final value, which begins the step', async () => {
  const sent = []
  const { frame, step } = frames()
  const edit = createParamEdit(async (id, params) => sent.push(params), frame)
  edit(target, 60, false)
  edit(target, 61, true)
  await step()
  assert.deepEqual(
    sent.map((params) => [params.value, params.begin ?? null, params.merge ?? null]),
    [[61, true, true]],
  )
})

test('Effect Controls and Properties shown together read clipEffects once per revision and playhead', async () => {
  const asked = []
  const doc = { invoke: async (name, clip) => (asked.push([name, clip]), JSON.stringify({ clip, effects: [] })) }
  const [first, second] = await Promise.all([readClipEffects(doc, 7, '3:100'), readClipEffects(doc, 7, '3:100')])
  assert.equal(first, second)
  await readClipEffects(doc, 7, '4:100')
  await readClipEffects(doc, 8, '4:100')
  assert.deepEqual(asked, [
    ['clipEffects', 7],
    ['clipEffects', 7],
    ['clipEffects', 8],
  ])
})

test('a drag cut short (its press ended with no final value) closes with its last value, merged and refreshing all; the next typed value is a step of its own', async () => {
  const sent = []
  const { frame, step } = frames()
  const edit = createParamEdit(async (id, params, options) => sent.push([params, options?.refresh ?? 'all']), frame)
  edit(target, 80, false)
  await step()
  edit(target, 82, false)
  edit.pressEnded()
  await step()
  edit(target, 55, true)
  await step()
  assert.deepEqual(
    sent.map(([params, refresh]) => [params.value, params.begin ?? null, params.merge ?? null, refresh]),
    [
      [80, true, true, 'repaint'],
      [82, false, true, 'all'],
      [55, null, null, 'all'],
    ],
  )
})

test("a drag's release, sent before its press ends, still merges into the drag", async () => {
  const sent = []
  const { frame, step } = frames()
  const edit = createParamEdit(async (id, params) => sent.push(params), frame)
  edit(target, 80, false)
  await step()
  edit(target, 81, true)
  edit.pressEnded()
  await step()
  assert.deepEqual(
    sent.map((params) => [params.value, params.begin ?? null, params.merge ?? null]),
    [
      [80, true, true],
      [81, false, true],
    ],
  )
})

test('the reader asks clipEffects at most once per frame, the latest, with one read in flight', async () => {
  const { frame, step } = frames()
  const reads = []
  let release = null
  const shown = []
  const reader = createEffectsReader(
    (want) => {
      reads.push(want.stamp)
      return new Promise((resolve) => {
        release = () => resolve({ clip: want.clip, stamp: want.stamp })
      })
    },
    (want, answer) => shown.push([want.stamp, answer.stamp]),
    frame,
  )
  const doc = {}
  reader({ doc, clip: 7, stamp: 'a' })
  reader({ doc, clip: 7, stamp: 'b' })
  await step()
  assert.deepEqual(reads, ['b'])
  reader({ doc, clip: 7, stamp: 'c' })
  reader({ doc, clip: 7, stamp: 'd' })
  await step()
  assert.deepEqual(reads, ['b'], 'none while one is in flight')
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(reads, ['b', 'd'], 'then the latest')
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(shown, [
    ['b', 'b'],
    ['d', 'd'],
  ])
})

test("a drag's moving values repaint the picture only; its final value and a typed one refresh the editor", async () => {
  const sent = []
  const { frame, step } = frames()
  let dragged = 0
  const edit = createParamEdit(async (id, params, options) => sent.push([params.value, options?.refresh ?? 'all']), frame, () => (dragged += 1))
  edit(target, 10, false)
  await step()
  edit(target, 11, true)
  await step()
  edit(target, 12, true)
  await step()
  assert.deepEqual(sent, [
    [10, 'repaint'],
    [11, 'all'],
    [12, 'all'],
  ])
  assert.equal(dragged, 1, 'each repainted value asks the panels to read the effects again')
})

test('drags end once every pointer that was down is up (a second finger lifting first ends nothing)', () => {
  let ended = 0
  const tracker = createPressTracker(() => (ended += 1))
  tracker.down(1)
  tracker.down(2)
  tracker.up(2)
  assert.equal(ended, 0)
  tracker.up(1)
  assert.equal(ended, 1)
  tracker.up(7)
  assert.equal(ended, 2, 'a release whose press was not seen still ends the drags')
})

test("a value waiting on its effect's application (Crop's first change) keeps its place in the drag's step", async () => {
  const sent = []
  const { frame, step } = frames()
  let applied = null
  const gate = new Promise((resolve) => {
    applied = resolve
  })
  const edit = createParamEdit(async (id, params) => sent.push(params), frame, undefined, () => gate)
  edit(target, 5, false)
  await step()
  edit(target, 9, true)
  edit.pressEnded()
  await step()
  assert.deepEqual(sent, [], 'nothing before the effect is on the clip')
  applied(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    sent.map((params) => [params.value, params.begin ?? null, params.merge ?? null]),
    [
      [5, true, true],
      [9, false, true],
    ],
  )
})

test('a value whose effect could not be applied is not sent', async () => {
  const sent = []
  const { frame, step } = frames()
  const edit = createParamEdit(async (id, params) => sent.push(params), frame, undefined, async () => false)
  edit(target, 9, true)
  await step()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(sent, [])
})
