import test from 'node:test'
import assert from 'node:assert/strict'
import { FILM_DRAG_TYPE, startFilmDrag, filmDrag, endFilmDrag, cancelFilmDrag } from './drop.ts'

function transfer() {
  const values = new Map()
  return { setData: (type, value) => values.set(type, value), getData: type => values.get(type) ?? '' }
}

test('a cancelled native drag cannot revive from the browser retained transfer data after dragend', () => {
  const data = transfer()
  startFilmDrag({ dataTransfer: data }, { item: 7, sourceIn: 20, duration: 80, video: true, audio: false })
  assert.equal(filmDrag().item, 7)
  cancelFilmDrag()
  assert.equal(filmDrag(), null)
  assert.equal(filmDrag(data), null)
  endFilmDrag()
  assert.equal(filmDrag(data), null)
})

test('a fresh drag after cancellation preserves its source range in the retained transfer data', () => {
  cancelFilmDrag()
  const data = transfer()
  const payload = { item: 9, sourceIn: 30, duration: 60, video: false, audio: true }
  startFilmDrag({ dataTransfer: data }, payload)
  assert.deepEqual(filmDrag(), payload)
  endFilmDrag()
  const { _filmDragEpoch, ...rest } = filmDrag(data)
  assert.equal(typeof _filmDragEpoch, 'number')
  assert.deepEqual(rest, payload)
})

test('legacy external item payloads remain readable while damaged drag data is ignored', () => {
  endFilmDrag()
  const data = transfer()
  data.setData(FILM_DRAG_TYPE, JSON.stringify({ item: 12 }))
  assert.deepEqual(filmDrag(data), { item: 12 })
  data.setData(FILM_DRAG_TYPE, '{damaged')
  assert.equal(filmDrag(data), null)
})
