// Select Find Box and Open Search (Task 15): a panel's search field takes focus once it is drawn,
// and a key or a press elsewhere meanwhile stops the wait (lesson 2: focus is never pulled from
// where the person went).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSearchFocus } from './focusSearch.ts'

function world() {
  const listeners = new Map()
  const tasks = []
  let now = 0
  let field = null
  const focus = createSearchFocus({
    find: () => field,
    schedule: (task) => tasks.push(task),
    now: () => now,
    listen: (type, listener) => {
      listeners.set(type, listener)
      return () => listeners.delete(type)
    },
  })
  return {
    focus,
    tick: (ms = 16) => {
      now += ms
      const due = tasks.splice(0)
      for (const task of due) task()
    },
    mount: () => (field = { focused: 0, focus() { this.focused += 1 }, select() {} }),
    field: () => field,
    fire: (type) => listeners.get(type)?.(),
    listening: () => listeners.size,
  }
}

test('a search field drawn a few frames later takes focus, and the wait ends', () => {
  const w = world()
  w.focus('project')
  w.tick()
  w.mount()
  w.tick()
  assert.equal(w.field().focused, 1)
  assert.equal(w.listening(), 0)
})

test('a key or a press elsewhere before the field is drawn stops the wait: focus stays where the person went', () => {
  for (const type of ['keydown', 'pointerdown']) {
    const w = world()
    w.focus('project')
    w.tick()
    w.fire(type)
    w.mount()
    w.tick()
    w.tick()
    assert.equal(w.field().focused, 0, type)
    assert.equal(w.listening(), 0, type)
  }
})

test('the wait gives up after a second', () => {
  const w = world()
  w.focus('project')
  for (let i = 0; i < 80; i += 1) w.tick()
  w.mount()
  w.tick()
  assert.equal(w.field().focused, 0)
  assert.equal(w.listening(), 0)
})
