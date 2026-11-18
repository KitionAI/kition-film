// The floating windows' boxes are measured only when a window can have moved (Task 20 review).
import test from 'node:test'
import assert from 'node:assert/strict'
import { watchFloatingBoxes } from './floatingBoxes.ts'

/** A fake page: the area, maybe a layer, observers that record what they watch, and frames run by hand. */
function page() {
  const s = { layer: null, observers: [], sizes: null, frames: [], measured: 0, floating: [], changed: 0, resize: null }
  const deps = {
    layer: () => s.layer,
    boxes: () => {
      s.measured += 1
      return [{ x: 16, y: 16, width: 520, height: 360 }]
    },
    frames: () => ['frame:project', 'frame:timeline'],
    observeMutations: (target, options, callback) => {
      const observer = { target, options, callback, live: true }
      s.observers.push(observer)
      return () => (observer.live = false)
    },
    observeSizes: (callback) => {
      s.sizes = { callback, targets: [] }
      return { watch: (targets) => (s.sizes.targets = targets), stop: () => (s.sizes = null) }
    },
    onWindowResize: (callback) => ((s.resize = callback), () => (s.resize = null)),
    frame: (callback) => {
      s.frames.push(callback)
      return () => (s.frames = s.frames.filter((each) => each !== callback))
    },
    floating: (boxes) => s.floating.push(boxes),
    changed: () => (s.changed += 1),
  }
  const flush = () => {
    const tasks = s.frames.splice(0)
    tasks.forEach((task) => task())
    return tasks.length
  }
  /** A mutation where `target` is: only observers watching it (or, with subtree, an ancestor in `under`) hear it. */
  const mutate = (target, kind, under = []) => {
    for (const observer of s.observers) {
      if (!observer.live) continue
      const here = observer.target === target || (observer.options.subtree && under.includes(observer.target))
      if (here && (kind === 'childList' ? observer.options.childList : observer.options.attributes)) observer.callback()
    }
  }
  return { s, deps, flush, mutate }
}

test("style writes elsewhere in the workspace (the playhead every frame while playing) measure nothing; with no window open nothing is measured at all", () => {
  const { s, deps, flush, mutate } = page()
  const stop = watchFloatingBoxes('area', deps)
  assert.equal(s.measured, 0, 'no window: no box read')
  // The area is watched for its own children only, never its subtree.
  assert.deepEqual(s.observers.map((each) => [each.target, each.options.subtree]), [['area', false]])
  for (let frame = 0; frame < 60; frame += 1) mutate('playhead', 'attributes', ['timeline', 'area'])
  assert.equal(flush(), 0)
  // A window opens: the layer mounts in the area, and its windows are measured once.
  s.layer = 'layer'
  mutate('area', 'childList')
  mutate('area', 'childList')
  assert.equal(flush(), 1, 'one frame for both')
  assert.equal(s.measured, 1)
  // Playing for 60 frames with a window open: still nothing measured.
  for (let frame = 0; frame < 60; frame += 1) mutate('playhead', 'attributes', ['timeline', 'area'])
  assert.equal(flush(), 0)
  assert.equal(s.measured, 1)
  // The window dragged: its style changes in the layer; many writes, one measure per frame.
  for (let k = 0; k < 5; k += 1) mutate('window', 'attributes', ['layer', 'area'])
  flush()
  assert.equal(s.measured, 2)
  stop()
  assert.deepEqual(s.floating.at(-1), [])
})

test('the area resizing or moving (the page resized) measures again; a frame resizing under a window tells the strip to check again', () => {
  const { s, deps, flush } = page()
  watchFloatingBoxes('area', deps)
  assert.deepEqual(s.sizes.targets, ['area'], 'no window: the area alone')
  s.resize()
  flush()
  assert.equal(s.changed, 0, 'no window: nothing to check again')
  s.layer = 'layer'
  s.resize()
  flush()
  assert.deepEqual(s.sizes.targets, ['area', 'frame:project', 'frame:timeline'])
  const measured = s.measured
  // A gutter drag: the frames resize; once per frame.
  s.sizes.callback()
  s.sizes.callback()
  assert.equal(flush(), 1)
  assert.equal(s.changed, 1)
  assert.equal(s.measured, measured + 1)
})

test("a size batch mixing a real resize and first reports clears every first report: each target's next resize counts", async () => {
  const { firstSizeReports } = await import('./floatingBoxes.ts')
  const sizes = firstSizeReports()
  sizes.watch('area')
  assert.equal(sizes.moved(['area']), false, 'the first report is the size it starts at')
  sizes.watch('frame:project')
  sizes.watch('frame:timeline')
  // The area resized, in one batch with the two frames' first reports.
  assert.equal(sizes.moved(['area', 'frame:project', 'frame:timeline']), true)
  // Each frame's next report is a real resize.
  assert.equal(sizes.moved(['frame:timeline']), true)
  assert.equal(sizes.moved(['frame:project']), true)
})
