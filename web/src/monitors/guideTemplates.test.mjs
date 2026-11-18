// Guide templates in the engine's preferences (`prefs.guides.templates`, as upstream's); they reach
// other pages and the next session as every preference does (`session/prefsSync.test.mjs`).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuideTemplates } from './guideTemplates.ts'
import { saveTemplate } from './guideModel.ts'

/**
 * A page's engine: its preferences and their revision, read as `prefsValue` answers them and set
 * as `loadPrefs(json, expected)` sets them, only while the revision is still `expected`.
 * `hooks.beforeWrite` lets another page's preferences land between a read and its write.
 */
function engine(initial = [], hooks = {}) {
  const state = { values: { guides: { templates: initial }, trim: { offset: 5 } }, version: 0, writes: 0 }
  return {
    state,
    hooks,
    read: async () => ({ version: state.version, values: structuredClone(state.values) }),
    write: async (values, expected) => {
      await hooks.beforeWrite?.()
      if (expected !== state.version) return { loaded: false, version: state.version, values: structuredClone(state.values) }
      state.writes += 1
      state.values = structuredClone(values)
      state.version += 1
      return { loaded: true, version: state.version, values: structuredClone(state.values) }
    },
    changed: () => (state.changed = (state.changed ?? 0) + 1),
  }
}

const thirds = [{ vertical: true, position: 640 }, { vertical: true, position: 1280 }]
const names = (list) => list.map((template) => template.name)

test("changes run one at a time on the engine's templates as they are, so neither of two quick saves is lost", async () => {
  const page = engine([{ name: 'Old', guides: [] }])
  const templates = createGuideTemplates(page)
  await Promise.all([templates.change((list) => saveTemplate(list, 'One', thirds)), templates.change((list) => saveTemplate(list, 'Two', thirds))])
  assert.deepEqual(names(page.state.values.guides.templates), ['Old', 'One', 'Two'])
  assert.deepEqual(names(templates.list()), ['Old', 'One', 'Two'])
  assert.equal(page.state.changed, 2, 'the preferences sync hears of each change')
})

test("another page's template loaded between a change's read and its write is kept: the write waits for the revision it read", async () => {
  const page = engine([{ name: 'Old', guides: [] }])
  let once = true
  page.hooks.beforeWrite = async () => {
    if (!once) return
    once = false
    // The preferences sync loads another page's new template (and its other preferences).
    page.state.values.guides.templates = [...page.state.values.guides.templates, { name: 'Theirs', guides: [] }]
    page.state.values.trim.offset = 9
    page.state.version += 1
  }
  const templates = createGuideTemplates(page)
  await templates.change((list) => saveTemplate(list, 'Mine', thirds))
  assert.deepEqual(names(page.state.values.guides.templates), ['Old', 'Theirs', 'Mine'])
  assert.equal(page.state.values.trim.offset, 9, 'and the other preferences it brought')
})

test('a refresh shows what another set in the engine (another page’s preferences, an agent’s prefs.set), and tells the dialogs once', async () => {
  const page = engine()
  const templates = createGuideTemplates(page)
  let told = 0
  templates.subscribe(() => (told += 1))
  page.state.values.guides.templates = [{ name: 'Agent', guides: [] }]
  await templates.refresh()
  await templates.refresh()
  assert.deepEqual([templates.list(), told], [[{ name: 'Agent', guides: [] }], 1])
})

test('a change that leaves the list as it is writes nothing; a failed write changes nothing and reaches its caller', async () => {
  const page = engine([{ name: 'Kept', guides: [] }])
  const templates = createGuideTemplates(page)
  await templates.change((list) => list)
  assert.equal(page.state.writes, 0)
  const failing = createGuideTemplates({ ...page, write: async () => Promise.reject(new Error('preferences: refused')) })
  await failing.refresh()
  await assert.rejects(failing.change((list) => saveTemplate(list, 'Lost', thirds)), /refused/)
  assert.deepEqual(failing.list(), [{ name: 'Kept', guides: [] }])
})
