// The engine's events (`takeEvents`), handled as upstream's frame loop handles them (lib.rs drain_events).
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEvents, parseEvents } from './events.ts'

const record = () => {
  const calls = []
  return {
    calls,
    handlers: {
      toast: (level, message) => calls.push(['toast', level, message]),
      showTimeline: () => calls.push(['showTimeline']),
      activate: (panel) => calls.push(['activate', panel]),
      reveal: (item) => calls.push(['reveal', item]),
    },
  }
}

test('a toast shows at its level; the panel events show their panels, in order', () => {
  const { calls, handlers } = record()
  applyEvents(
    parseEvents(
      JSON.stringify([
        { kind: 'toast', message: 'Audio during scrubbing off', error: false },
        { kind: 'openSource', item: 4 },
        { kind: 'toast', message: 'Scene Edit Detection: failed', error: true },
        { kind: 'openSequence', item: 2 },
        { kind: 'revealInProject', item: 7 },
      ]),
    ),
    handlers,
  )
  assert.deepEqual(calls, [
    ['toast', 'info', 'Audio during scrubbing off'],
    ['activate', 'source'],
    ['toast', 'error', 'Scene Edit Detection: failed'],
    ['showTimeline'],
    ['reveal', 7],
  ])
})

test('an answer that is not a list of events is nothing', () => {
  assert.deepEqual(parseEvents('not json'), [])
  assert.deepEqual(parseEvents('{"kind":"toast"}'), [])
  assert.deepEqual(parseEvents(JSON.stringify([{ kind: 'toast' }, { kind: 'openSource', item: '3' }, { kind: 'projectChanged', revision: 2 }, null])), [])
})
