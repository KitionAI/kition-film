// The program playhead's scrub (`scrub.ts`): the timecode moves at once, one seek in flight, every
// seek's picture rendered and asked again while it is approximate, the engine told the scrub's
// motion, and the drag's playback resolution until the engine has the end.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createScrub } from './scrub.ts'

/** A fake editor: seeks wait for `answer`, pictures are exact unless `approximate` says otherwise. */
function harness({ approximate = () => false } = {}) {
  const log = []
  const pending = []
  let painted = 0
  const scrub = createScrub({
    seek: (seconds) => {
      log.push(['seek', seconds])
      return new Promise((resolve) => pending.push(resolve))
    },
    paint: async () => {
      painted += 1
      log.push(['paint'])
    },
    motion: async (motion) => log.push(['motion', motion]),
    exact: async () => !approximate(painted),
    show: (seconds) => log.push(['show', seconds]),
    dragging: (on) => log.push(['dragging', on]),
  })
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  }
  const answer = async () => {
    pending.shift()?.()
    await settle()
  }
  return { scrub, log, answer, settle }
}

const kinds = (log, kind) => log.filter(([k]) => k === kind)

test('a click shows the time at once, scrubs, seeks, paints, and ends exact', async () => {
  const { scrub, log, answer } = harness()
  scrub.start(2)
  scrub.end(2)
  assert.deepEqual(log.slice(0, 3), [['motion', 'scrub'], ['show', 2], ['seek', 2]])
  await answer()
  await answer()
  // The end: back to exact pictures, the picture where it stopped painted, the time handed back.
  assert.deepEqual(log.slice(-3), [['motion', 'still'], ['paint'], ['show', null]])
  assert.deepEqual(kinds(log, 'motion'), [['motion', 'scrub'], ['motion', 'still']])
  assert.equal(scrub.active(), false)
})

test('a drag keeps one seek in flight, sends only the latest, and paints every seek', async () => {
  const { scrub, log, answer } = harness()
  scrub.start(1)
  scrub.move(2)
  scrub.move(3)
  scrub.move(4)
  assert.deepEqual(kinds(log, 'show').map(([, at]) => at), [1, 2, 3, 4])
  assert.deepEqual(kinds(log, 'seek'), [['seek', 1]])
  assert.deepEqual(kinds(log, 'dragging'), [['dragging', true]])
  await answer()
  // 2 and 3 were replaced while 1 was in flight: 4 goes next, after 1's picture.
  assert.deepEqual(log.slice(-2), [['paint'], ['seek', 4]])
  scrub.end(5)
  await answer()
  assert.deepEqual(log.slice(-2), [['paint'], ['seek', 5]])
  assert.equal(scrub.active(), true)
  await answer()
  assert.deepEqual(log.slice(-4), [['motion', 'still'], ['paint'], ['show', null], ['dragging', false]])
  assert.equal(scrub.active(), false)
})

test('an approximate picture is asked for again while the pointer rests, and a new position wins', async () => {
  // The first three pictures are approximate.
  const { scrub, log, answer, settle } = harness({ approximate: (painted) => painted <= 3 })
  scrub.start(1)
  scrub.move(6)
  await answer()
  // 1's picture was approximate, but 6 waited: it goes first.
  assert.deepEqual(log.slice(-2), [['paint'], ['seek', 6]])
  await answer()
  await settle()
  // 6's picture: approximate twice more, then exact; no seek meanwhile.
  assert.equal(kinds(log, 'paint').length, 4)
  assert.equal(kinds(log, 'seek').length, 2)
  assert.equal(scrub.active(), true, 'the drag goes on')
  scrub.end(6)
  await answer()
  assert.deepEqual(log.slice(-4), [['motion', 'still'], ['paint'], ['show', null], ['dragging', false]])
})

test('the release does not wait for an approximate picture to become exact', async () => {
  const { scrub, log, answer } = harness({ approximate: () => true })
  scrub.start(3)
  scrub.end(3)
  await answer()
  await answer()
  // Approximate each time, but the scrub ended: the exact picture is the still one.
  assert.deepEqual(log.slice(-3), [['motion', 'still'], ['paint'], ['show', null]])
  assert.equal(kinds(log, 'paint').length, 3)
})

test('a cancelled scrub sends nothing more and ends once the seek in flight is answered', async () => {
  const { scrub, log, answer } = harness()
  scrub.start(1)
  scrub.move(2)
  scrub.cancel()
  await answer()
  assert.deepEqual(kinds(log, 'seek'), [['seek', 1]])
  assert.deepEqual(log.slice(-4), [['motion', 'still'], ['paint'], ['show', null], ['dragging', false]])
})

test('a seek or a question the engine refuses still lets the scrub go on and end', async () => {
  const log = []
  const scrub = createScrub({
    seek: async (seconds) => {
      log.push(['seek', seconds])
      throw new Error('no')
    },
    paint: async () => log.push(['paint']),
    motion: async () => {
      throw new Error('an engine without motions')
    },
    exact: async () => {
      throw new Error('an engine without motions')
    },
    show: () => undefined,
    dragging: () => undefined,
  })
  scrub.start(1)
  scrub.end(2)
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
  assert.deepEqual(log, [['seek', 1], ['paint'], ['seek', 2], ['paint'], ['paint']])
  assert.equal(scrub.active(), false)
})

test('negative times scrub to the start', () => {
  const { scrub, log } = harness()
  scrub.start(-3)
  assert.deepEqual(log.slice(0, 3), [['motion', 'scrub'], ['show', 0], ['seek', 0]])
})
