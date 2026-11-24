// Sequence ▸ Close Gap from the menu: the track whose gap the playhead is in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { closeGapTrack } from './closeGap.ts'

const clip = (id, start, duration, selected = false) => ({ id, start, duration, selected })
const track = (id, kind, clips, locked = false) => ({ id, kind, clips, locked })
const F = 1 / 30

test("the playhead in a gap on V1: V1's", () => {
  const tracks = [track(1, 'video', [clip(10, 0, 1), clip(11, 2, 1)]), track(2, 'video', []), track(3, 'audio', [clip(20, 0, 3)])]
  assert.equal(closeGapTrack(tracks, 1.5, F), 1)
})

test('a selected clip names the track first', () => {
  const tracks = [track(1, 'video', [clip(10, 0, 1), clip(11, 2, 1)]), track(2, 'video', [clip(12, 0, 1), clip(13, 3, 1, true)])]
  assert.equal(closeGapTrack(tracks, 1.5, F), 2)
})

test('no gap: a clip at the playhead, nothing after it, or a locked track', () => {
  assert.equal(closeGapTrack([track(1, 'video', [clip(10, 0, 3)])], 1.5, F), null)
  assert.equal(closeGapTrack([track(1, 'video', [clip(10, 0, 1)])], 1.5, F), null)
  assert.equal(closeGapTrack([track(1, 'video', [clip(10, 0, 1), clip(11, 2, 1)], true)], 1.5, F), null)
  // The playhead on a clip's first frame is on the clip, not in the gap before it.
  assert.equal(closeGapTrack([track(1, 'video', [clip(10, 0, 1), clip(11, 2, 1)])], 2, F), null)
})
