// The program playhead's scrub (`scrub.ts`): the timecode moves at once, one seek in flight, every
// seek's picture asked for after it, and the drag's playback resolution until the engine has the end.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createScrub } from './scrub.ts'

function harness() {
  const log = []
  const pending = []
  const scrub = createScrub({
    seek: (seconds) => {
      log.push(['seek', seconds])
      return new Promise((resolve) => pending.push(resolve))
    },
    paint: async () => log.push(['paint']),
    show: (seconds) => log.push(['show', seconds]),
    dragging: (on) => log.push(['dragging', on]),
  })
  const answer = async () => {
    pending.shift()?.()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }
  return { scrub, log, answer, pending }
}

test('a click shows the time at once, seeks once and paints after the seek', async () => {
  const { scrub, log, answer } = harness()
  scrub.start(2)
  scrub.end(2)
  assert.deepEqual(log, [['show', 2], ['seek', 2], ['show', 2]])
  await answer()
  // The same position again: sent once more (the release), then painted, then the scrub ends.
  assert.deepEqual(log.slice(3), [['paint'], ['seek', 2]])
  await answer()
  assert.deepEqual(log.slice(5), [['paint'], ['show', null]])
  assert.equal(scrub.active(), false)
})

test('a drag keeps one seek in flight, sends only the latest, and every seek is painted', async () => {
  const { scrub, log, answer } = harness()
  scrub.start(1)
  scrub.move(2)
  scrub.move(3)
  scrub.move(4)
  // Every move is shown at once; one seek is in flight; the drag asks for the playback resolution once.
  assert.deepEqual(
    log.filter(([kind]) => kind === 'show').map(([, at]) => at),
    [1, 2, 3, 4],
  )
  assert.deepEqual(log.filter(([kind]) => kind === 'seek'), [['seek', 1]])
  assert.deepEqual(log.filter(([kind]) => kind === 'dragging'), [['dragging', true]])
  await answer()
  // 2 and 3 were replaced while 1 was in flight: 4 goes next, after 1's picture was asked for.
  assert.deepEqual(log.slice(-2), [['paint'], ['seek', 4]])
  scrub.end(5)
  await answer()
  assert.deepEqual(log.slice(-2), [['paint'], ['seek', 5]])
  assert.equal(scrub.active(), true)
  await answer()
  // The engine has the end: its picture is asked for, then the scrub ends (back to the paused resolution).
  assert.deepEqual(log.slice(-3), [['paint'], ['show', null], ['dragging', false]])
  assert.equal(scrub.active(), false)
})

test('a cancelled scrub sends nothing more and ends once the seek in flight is answered', async () => {
  const { scrub, log, answer } = harness()
  scrub.start(1)
  scrub.move(2)
  scrub.cancel()
  assert.deepEqual(log.filter(([kind]) => kind === 'seek'), [['seek', 1]])
  await answer()
  assert.deepEqual(log.filter(([kind]) => kind === 'seek'), [['seek', 1]])
  assert.deepEqual(log.slice(-3), [['paint'], ['show', null], ['dragging', false]])
})

test('a seek the engine refuses still paints and lets the next one go', async () => {
  const log = []
  const scrub = createScrub({
    seek: async (seconds) => {
      log.push(['seek', seconds])
      throw new Error('no')
    },
    paint: async () => log.push(['paint']),
    show: () => undefined,
    dragging: () => undefined,
  })
  scrub.start(1)
  scrub.end(2)
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  assert.deepEqual(log, [['seek', 1], ['paint'], ['seek', 2], ['paint']])
})

test('negative times scrub to the start', () => {
  const { scrub, log } = harness()
  scrub.start(-3)
  assert.deepEqual(log.slice(0, 2), [['show', 0], ['seek', 0]])
})
