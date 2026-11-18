// The status bar's message clears 8 s after its text was first seen (upstream lib.rs status_seen).
import test from 'node:test'
import assert from 'node:assert/strict'
import { STATUS_MS, nextStatus, statusLeft } from './status.ts'

test('the same text again keeps its first time; another text starts over', () => {
  const first = nextStatus(null, 'Open a Source clip first', 1000)
  const again = nextStatus(first, 'Open a Source clip first', 5000)
  assert.equal(again, first, 'the shown message is kept, so its timer is not restarted')
  assert.equal(statusLeft(again, 5000), STATUS_MS - 4000)
  const other = nextStatus(again, 'Not available in this editor yet', 6000)
  assert.deepEqual(other, { text: 'Not available in this editor yet', at: 6000 })
  assert.equal(statusLeft(other, 6000 + STATUS_MS), 0)
})
