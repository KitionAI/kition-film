// Focus given back to the editor when what held it goes (lesson 2): never from another field or the host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { focusAfterBlur, giveKeysBack } from './editorFocus.ts'

/** A page with a body, an editor root, and a field elsewhere; `focused` is whether the page has focus. */
function page({ focused = true } = {}) {
  const doc = { focused, activeElement: null, hasFocus: () => doc.focused, querySelector: (selector) => (selector === '.kui-app' ? app : null) }
  const body = { name: 'body' }
  doc.body = body
  doc.activeElement = body
  const app = { focus: () => (doc.activeElement = app), name: 'app' }
  return { doc, body, app }
}
const now = (task) => task()

test('a floating window gone with focus in it: the editor takes focus, so its keys work without a click', () => {
  const { doc, app } = page()
  giveKeysBack(doc, now)
  assert.equal(doc.activeElement, app)
})

test('focus that went somewhere (another field), or a page without focus (the host has it), is left alone', () => {
  const { doc } = page()
  const field = { name: 'field' }
  doc.activeElement = field
  giveKeysBack(doc, now)
  assert.equal(doc.activeElement, field)
  const host = page({ focused: false })
  giveKeysBack(host.doc, now)
  assert.equal(host.doc.activeElement, host.body)
})

test('the check waits for its frame (the window unmounts first)', () => {
  const { doc, app } = page()
  const tasks = []
  const field = { name: 'field in the closing window' }
  doc.activeElement = field
  giveKeysBack(doc, (task) => tasks.push(task))
  doc.activeElement = doc.body
  tasks.forEach((task) => task())
  assert.equal(doc.activeElement, app)
})

test("Escape's blur in a window's search field focuses the window; in the docked panel, the editor", () => {
  const { doc, app } = page()
  const window = { focus: () => (doc.activeElement = window) }
  const field = (inWindow) => ({ closest: (selector) => (selector === '.kui-floating-panel' ? (inWindow ? window : null) : selector === '.kui-app' ? app : null), blur: () => (doc.activeElement = doc.body) })
  doc.activeElement = 'search'
  focusAfterBlur(field(true), doc)
  assert.equal(doc.activeElement, window)
  focusAfterBlur(field(false), doc)
  assert.equal(doc.activeElement, app)
  // A blur that sent focus somewhere (the host took it) is left alone.
  const elsewhere = { closest: field(true).closest, blur: () => (doc.activeElement = 'host') }
  focusAfterBlur(elsewhere, doc)
  assert.equal(doc.activeElement, 'host')
})
