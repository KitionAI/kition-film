// Film's user preferences across reloads, documents, and pages (upstream's preferences file):
// each page's engine owns them, the kit store keeps one copy, and pages merge by the preference
// that changed, the last writer winning for the same one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrefsSync, leafPaths, mergePrefs, reconcile } from './prefsSync.ts'

const DEFAULTS = { labels: { violet: 'Violet', iris: 'Iris' }, guides: { templates: [] }, projectPanel: { view: { mode: 'icon' }, presets: [] }, trim: { offset: 5 } }
const clone = (value) => structuredClone(value)

/** `defaults` with `value` over it: what a preferences file read fills in. */
const filled = (defaults, value) => {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) || !value || typeof value !== 'object' || Array.isArray(value)) return value === undefined ? clone(defaults) : value
  const out = {}
  for (const key of new Set([...Object.keys(defaults), ...Object.keys(value)])) out[key] = filled(defaults[key], value[key])
  return out
}

/**
 * A page's engine: its preferences, a revision that moves with each change, and the conditional
 * load (`loadPrefs(json, expected)`), which fills missing preferences from the defaults as a
 * preferences file read does. `hooks.beforeLoad` runs a command as a load arrives; a load can be made to fail.
 */
function engine(initial = DEFAULTS, hooks = {}) {
  const state = { values: clone(initial), version: 0, loads: 0, failLoads: 0, failValues: 0 }
  return {
    state,
    hooks,
    /** A command that changes a preference (prefs.set, project.viewPreset.*, …). */
    change(edit) {
      edit(state.values)
      state.version += 1
    },
    value: async () => {
      if (state.failValues > 0) {
        state.failValues -= 1
        throw new Error('the engine is not ready')
      }
      await hooks.beforeValue?.()
      return { version: state.version, values: clone(state.values) }
    },
    version: async () => state.version,
    load: async (json, expected) => {
      state.loads += 1
      await hooks.beforeLoad?.()
      if (state.failLoads > 0) {
        state.failLoads -= 1
        throw new Error('the engine is busy')
      }
      if (expected !== state.version) return { loaded: false, version: state.version, values: clone(state.values) }
      const next = (hooks.read ?? ((value) => filled(DEFAULTS, value)))(JSON.parse(json))
      if (JSON.stringify(next) !== JSON.stringify(state.values)) state.version += 1
      state.values = next
      const answer = { loaded: true, version: state.version, values: clone(state.values) }
      // A command that lands right after the load, before its answer reaches the editor.
      await hooks.afterLoad?.()
      return answer
    },
  }
}

/**
 * localStorage as pages share it: a write tells every other page (the `storage` event), never the
 * writer. `hold` delays the telling, and other pages read the value as it was when held (two
 * processes racing on the same key).
 */
function sharedStore() {
  let value
  let heldValue
  const pages = []
  const held = []
  let holding = false
  let writer = null
  return {
    page() {
      const me = { listeners: new Set() }
      pages.push(me)
      return {
        read: () => {
          const shown = holding && writer !== me ? heldValue : value
          return shown === undefined ? undefined : JSON.parse(shown)
        },
        write: (next) => {
          if (holding && writer == null) writer = me
          value = JSON.stringify(next)
          const raw = value
          for (const other of pages) if (other !== me) for (const listener of other.listeners) (holding ? (task) => held.push(task) : (task) => task())(() => listener(JSON.parse(raw)))
          return 'stored'
        },
        subscribe: (listener) => {
          me.listeners.add(listener)
          return () => me.listeners.delete(listener)
        },
      }
    },
    value: () => (value === undefined ? undefined : JSON.parse(value)),
    hold() {
      holding = true
      heldValue = value
    },
    release() {
      holding = false
      writer = null
      for (const task of held.splice(0)) task()
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
let clock = 1000
const page = (name, store, own = engine(), errors = []) => ({
  engine: own,
  errors,
  sync: createPrefsSync({ engine: own, store: store.page(), page: name, now: () => (clock += 1), wait: async () => undefined, onError: (message) => errors.push(message) }),
})

test('leaf paths: objects are walked, arrays and values are leaves, added and removed keys count', () => {
  assert.deepEqual(leafPaths({ a: { b: 1, c: [1] }, d: 2 }, { a: { b: 1, c: [1, 2] }, d: 2 }), [['a', 'c']])
  assert.deepEqual(leafPaths({ a: { b: 1 } }, { a: { b: 1, e: { f: 3 } } }), [['a', 'e', 'f']])
  assert.deepEqual(leafPaths({ a: { b: 1, gone: true } }, { a: { b: 1 } }), [['a', 'gone']])
  assert.deepEqual(leafPaths({ a: 1 }, { a: 1 }), [])
})

test('merge: the newer stamp of each preference wins; preferences one side never stamped keep the other side', () => {
  const store = { prefs: { a: 1, b: 1, c: 1 }, stamps: { '["a"]': { t: 5, page: 'B' } } }
  const mine = { prefs: { a: 2, b: 2, c: 2 }, stamps: { '["a"]': { t: 4, page: 'A' }, '["b"]': { t: 6, page: 'A' } } }
  assert.deepEqual(mergePrefs(store, mine), { prefs: { a: 1, b: 2, c: 1 }, stamps: { '["a"]': { t: 5, page: 'B' }, '["b"]': { t: 6, page: 'A' } } })
  // reconcile stamps what changed in the engine since the page last synced, and nothing else.
  const local = { prefs: { a: 1, b: 1 }, stamps: {} }
  const result = reconcile(local, { a: 1, b: 9 }, { prefs: { a: 7, b: 1 }, stamps: { '["a"]': { t: 3, page: 'B' } } }, { t: 10, page: 'A' })
  assert.deepEqual(result.next.prefs, { a: 7, b: 9 })
  assert.deepEqual([result.load, result.store], [true, true])
})

test('a page opens with the stored preferences; the first page with none stores its own', async () => {
  const store = sharedStore()
  const first = page('A', store)
  first.engine.change((values) => (values.trim.offset = 9))
  await first.sync.open()
  assert.equal(store.value().prefs.trim.offset, 9)
  const second = page('B', store)
  await second.sync.open()
  assert.equal(second.engine.state.values.trim.offset, 9, 'a new page (a reload, another document) takes them')
})

test('two pages changing different preferences at once lose neither, whichever writes last', async () => {
  const store = sharedStore()
  const a = page('A', store)
  const b = page('B', store)
  await a.sync.open()
  await b.sync.open()
  // Both change before either hears of the other: B even reads the store as it was before A wrote.
  store.hold()
  a.engine.change((values) => (values.labels.violet = 'Purple'))
  b.engine.change((values) => (values.guides.templates = [{ name: 'Thirds', guides: [] }]))
  await a.sync.check()
  await b.sync.check()
  store.release()
  await settle()
  for (const each of [a, b]) {
    assert.equal(each.engine.state.values.labels.violet, 'Purple')
    assert.deepEqual(each.engine.state.values.guides.templates, [{ name: 'Thirds', guides: [] }])
  }
  assert.equal(store.value().prefs.labels.violet, 'Purple')
  assert.deepEqual(store.value().prefs.guides.templates, [{ name: 'Thirds', guides: [] }])
})

test('the same preference changed on two pages: the last writer wins on both', async () => {
  const store = sharedStore()
  const a = page('A', store)
  const b = page('B', store)
  await a.sync.open()
  await b.sync.open()
  a.engine.change((values) => (values.projectPanel.view.mode = 'list'))
  await a.sync.check()
  await settle()
  b.engine.change((values) => (values.projectPanel.view.mode = 'freeform'))
  await b.sync.check()
  await settle()
  assert.deepEqual([a.engine.state.values.projectPanel.view.mode, b.engine.state.values.projectPanel.view.mode, store.value().prefs.projectPanel.view.mode], ['freeform', 'freeform', 'freeform'])
})

test("the reviewer's case: a page whose load fails while it previews never pushes its stale templates over another page's", async () => {
  const store = sharedStore()
  const errors = []
  const a = page('A', store, engine(), errors)
  const b = page('B', store)
  await a.sync.open()
  await b.sync.open()
  // A previews a dialog; its engine refuses loads for now (more times than the retries).
  a.engine.state.failLoads = 10
  b.engine.change((values) => (values.guides.templates = [{ name: 'Thirds', guides: [{ vertical: true, position: 640 }] }]))
  await b.sync.check()
  await settle()
  assert.ok(errors.length > 0 && /busy/.test(errors[0]), 'the failed load is reported, not swallowed')
  assert.ok(a.engine.state.loads >= 2, 'and retried first')
  // A refreshes (its own commands, an outside refresh) and changes something else: B's template survives.
  await a.sync.check()
  a.engine.state.failLoads = 0
  a.engine.change((values) => (values.trim.offset = 7))
  await a.sync.check()
  await settle()
  assert.deepEqual(store.value().prefs.guides.templates, [{ name: 'Thirds', guides: [{ vertical: true, position: 640 }] }])
  assert.deepEqual(a.engine.state.values.guides.templates, store.value().prefs.guides.templates, 'and reaches A once its engine takes loads')
  assert.deepEqual(b.engine.state.values.guides.templates, store.value().prefs.guides.templates)
  assert.equal(b.engine.state.values.trim.offset, 7)
})

test('a check with no preference change reads only the revision and writes nothing', async () => {
  const store = sharedStore()
  const a = page('A', store)
  await a.sync.open()
  const written = JSON.stringify(store.value())
  let reads = 0
  const value = a.engine.value
  a.engine.value = async () => {
    reads += 1
    return value()
  }
  await a.sync.check()
  await a.sync.check()
  assert.equal(reads, 0)
  assert.equal(JSON.stringify(store.value()), written)
})

test("a storage event that arrives late merges the store as it is now, so a third page's later write is never overwritten, even briefly", async () => {
  // A store whose events are delivered by hand: A hears B's write only after C has written.
  let value
  const listeners = new Map()
  const delivered = []
  const handStore = (name) => ({
    read: () => (value === undefined ? undefined : JSON.parse(value)),
    write: (next) => {
      value = JSON.stringify(next)
      const raw = value
      for (const [other, listener] of listeners) if (other !== name) delivered.push({ to: other, raw })
      return 'stored'
    },
    subscribe: (listener) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  })
  const make = (name) => {
    const own = engine()
    return { engine: own, sync: createPrefsSync({ engine: own, store: handStore(name), page: name, now: () => (clock += 1), wait: async () => undefined, onError: () => undefined }) }
  }
  const a = make('A')
  const b = make('B')
  const c = make('C')
  for (const each of [a, b, c]) await each.sync.open()
  delivered.length = 0
  b.engine.change((values) => (values.projectPanel.view.mode = 'list'))
  await b.sync.check()
  const fromB = delivered.find((event) => event.to === 'A')
  c.engine.change((values) => (values.projectPanel.view.mode = 'freeform'))
  await c.sync.check()
  // A hears B's older write now; every write A makes keeps C's.
  listeners.get('A')(JSON.parse(fromB.raw))
  await settle()
  assert.equal(JSON.parse(value).prefs.projectPanel.view.mode, 'freeform', 'the store keeps C’s later value')
  assert.equal(a.engine.state.values.projectPanel.view.mode, 'freeform', 'and A takes it, never B’s older one')
})

test('leaf paths: an object that becomes a value counts as a change of the object itself too', () => {
  assert.deepEqual(leafPaths({ a: { b: 1, c: 2 } }, { a: 5 }), [['a', 'b'], ['a', 'c'], ['a']])
  // Merged on another page, the value replaces the object, whichever stamp comes first.
  const merged = mergePrefs({ prefs: { a: { b: 1, c: 2 } }, stamps: {} }, { prefs: { a: 5 }, stamps: { '["a"]': { t: 2, page: 'A' }, '["a","b"]': { t: 2, page: 'A' }, '["a","c"]': { t: 2, page: 'A' } } })
  assert.deepEqual(merged.prefs, { a: 5 })
})

test("a command landing while another page's preferences load is never lost (the load is refused and merged again)", async () => {
  const store = sharedStore()
  const a = page('A', store)
  const b = page('B', store)
  await a.sync.open()
  await b.sync.open()
  // A's own command (project.view.set) lands after its sync read the engine and before its load.
  let once = true
  a.engine.hooks.beforeLoad = async () => {
    if (!once) return
    once = false
    a.engine.change((values) => (values.trim.offset = 42))
  }
  b.engine.change((values) => (values.guides.templates = [{ name: 'Thirds', guides: [] }]))
  await b.sync.check()
  await settle()
  assert.equal(a.engine.state.values.trim.offset, 42, "A keeps its command's change")
  assert.deepEqual(a.engine.state.values.guides.templates, [{ name: 'Thirds', guides: [] }], "and takes B's")
  assert.equal(store.value().prefs.trim.offset, 42, 'and stores it')
  await settle()
  assert.equal(b.engine.state.values.trim.offset, 42, 'which reaches B')
})

test('a command landing right after a load is stamped and stored, never taken as part of the load', async () => {
  const store = sharedStore()
  const a = page('A', store)
  const b = page('B', store)
  await a.sync.open()
  await b.sync.open()
  // A command lands right after A's load, before its answer arrives.
  let once = true
  a.engine.hooks.afterLoad = async () => {
    if (!once) return
    once = false
    a.engine.change((values) => (values.trim.offset = 11))
  }
  b.engine.change((values) => (values.labels.violet = 'Purple'))
  await b.sync.check()
  await settle()
  await a.sync.check()
  await settle()
  assert.equal(a.engine.state.values.trim.offset, 11)
  assert.equal(store.value().prefs.trim.offset, 11, 'the change is stored')
  assert.equal(b.engine.state.values.trim.offset, 11)
})

test('a failed open is reported and tried again at the next check, so the session still persists', async () => {
  const store = sharedStore()
  const errors = []
  const a = page('A', store, engine(), errors)
  a.engine.state.failValues = 1
  await a.sync.open()
  assert.ok(errors.some((message) => /not ready/.test(message)), 'reported')
  a.engine.change((values) => (values.trim.offset = 8))
  await a.sync.check()
  assert.equal(store.value()?.prefs.trim.offset, 8)
})

test('another page’s write while this page opens is not dropped', async () => {
  const store = sharedStore()
  const b = page('B', store)
  await b.sync.open()
  let release
  const opening = new Promise((resolve) => (release = resolve))
  const a = page('A', store)
  let first = true
  a.engine.hooks.beforeValue = async () => {
    if (!first) return
    first = false
    await opening
  }
  const opened = a.sync.open()
  b.engine.change((values) => (values.labels.iris = 'Blue'))
  await b.sync.check()
  release()
  await opened
  await settle()
  assert.equal(a.engine.state.values.labels.iris, 'Blue')
})

test('the store takes what the engine fills in or repairs, so later syncs do not load again', async () => {
  const store = sharedStore()
  // An older writer stored preferences without the trim section.
  const old = store.page()
  old.write({ prefs: { labels: { violet: 'Lilac', iris: 'Iris' }, guides: { templates: [] }, projectPanel: { view: { mode: 'icon' }, presets: [] } }, stamps: {} })
  const a = page('A', store)
  await a.sync.open()
  assert.equal(a.engine.state.values.labels.violet, 'Lilac')
  assert.deepEqual(store.value().prefs.trim, { offset: 5 }, 'the filled section is stored, unstamped')
  assert.equal(store.value().stamps['["trim","offset"]'], undefined)
  const loads = a.engine.state.loads
  old.write(store.value())
  await settle()
  await a.sync.check()
  assert.equal(a.engine.state.loads, loads, 'nothing to load again')
})

test("a clock that steps back never lets a page's fresh change lose to its own older one", async () => {
  const store = sharedStore()
  let now = 5000
  const own = engine()
  const sync = createPrefsSync({ engine: own, store: store.page(), page: 'A', now: () => now, wait: async () => undefined, onError: () => undefined })
  await sync.open()
  own.change((values) => (values.trim.offset = 6))
  await sync.check()
  now = 1000
  own.change((values) => (values.trim.offset = 7))
  await sync.check()
  assert.equal(store.value().prefs.trim.offset, 7)
  assert.equal(own.state.values.trim.offset, 7)
  assert.ok(store.value().stamps['["trim","offset"]'].t > 5000)
})

test('a store that will not keep the preferences says so once, in words, until it keeps them again', async () => {
  const errors = []
  let answer = 'unavailable'
  const own = engine()
  const sync = createPrefsSync({ engine: own, store: { read: () => undefined, write: () => answer, subscribe: () => () => undefined }, page: 'A', now: () => (clock += 1), wait: async () => undefined, onError: (message) => errors.push(message) })
  await sync.open()
  own.change((values) => (values.trim.offset = 6))
  await sync.check()
  assert.equal(errors.length, 1)
  assert.ok(!/^(unavailable|tooLarge)$/.test(errors[0]) && /preference/i.test(errors[0]) && errors[0].includes(' '), errors[0])
  answer = 'stored'
  own.change((values) => (values.trim.offset = 7))
  await sync.check()
  answer = 'tooLarge'
  own.change((values) => (values.trim.offset = 8))
  await sync.check()
  assert.equal(errors.length, 2)
})

/** Counts a store's writes. */
function counted(store) {
  let writes = 0
  return {
    writes: () => writes,
    page() {
      const inner = store.page()
      return { ...inner, write: (value) => ((writes += 1), inner.write(value)) }
    },
  }
}

/** An engine of another version: it keeps only the preferences its schema knows, filling and repairing as `read` says. */
const versioned = (read, initial = DEFAULTS) => engine(initial, { read })
const known = (value) => {
  const out = filled(DEFAULTS, value)
  for (const key of Object.keys(out)) if (!Object.hasOwn(DEFAULTS, key)) delete out[key]
  for (const section of Object.keys(DEFAULTS)) if (out[section] && typeof out[section] === 'object' && !Array.isArray(out[section])) for (const key of Object.keys(out[section])) if (!Object.hasOwn(DEFAULTS[section], key)) delete out[section][key]
  return out
}

test('pages on engines of different versions settle: an older engine dropping a preference a newer one fills writes nothing back', async () => {
  const shared = sharedStore()
  const store = counted(shared)
  const make = (name, own) => ({ engine: own, sync: createPrefsSync({ engine: own, store: store.page(), page: name, now: () => (clock += 1), wait: async () => undefined, onError: () => undefined }) })
  // B's newer engine fills trim.k; A's older one does not know it and drops it.
  const newer = { ...DEFAULTS, trim: { offset: 5, k: 1 } }
  const b = make('B', versioned((value) => filled(newer, value), newer))
  const a = make('A', versioned(known))
  await b.sync.open()
  await a.sync.open()
  b.engine.change((values) => (values.labels.violet = 'Purple'))
  await b.sync.check()
  for (let i = 0; i < 20; i += 1) await settle()
  const settled = store.writes()
  for (let i = 0; i < 20; i += 1) await settle()
  assert.equal(store.writes(), settled, 'no more writes once settled')
  assert.ok(settled <= 6, `settles within a few writes (${settled})`)
  assert.equal(shared.value().prefs.trim.k, 1, 'the newer engine’s preference stays in the store')
  assert.equal(a.engine.state.values.labels.violet, 'Purple')
})

test('a choice two engines repair each to its own settles too: neither repair is written over the stored value', async () => {
  const shared = sharedStore()
  const store = counted(shared)
  const make = (name, own) => ({ engine: own, sync: createPrefsSync({ engine: own, store: store.page(), page: name, now: () => (clock += 1), wait: async () => undefined, onError: () => undefined }) })
  // B's engine knows only "freeform" for this choice, A's only "icon": each repairs the other's.
  const repairTo = (mode) => (value) => {
    const out = filled(DEFAULTS, value)
    out.projectPanel.view.mode = mode
    return out
  }
  const bEngine = versioned(repairTo('freeform'))
  bEngine.state.values.projectPanel.view.mode = 'freeform'
  const b = make('B', bEngine)
  const a = make('A', versioned(repairTo('icon')))
  await b.sync.open()
  await a.sync.open()
  b.engine.change((values) => (values.labels.violet = 'Purple'))
  await b.sync.check()
  for (let i = 0; i < 20; i += 1) await settle()
  const settled = store.writes()
  for (let i = 0; i < 20; i += 1) await settle()
  assert.equal(store.writes(), settled, 'no more writes once settled')
  assert.ok(settled <= 6, `settles within a few writes (${settled})`)
  assert.equal(a.engine.state.values.labels.violet, 'Purple')
})

test('a command during the open is kept: a refused load during the open stamps what moved since the first read', async () => {
  const store = sharedStore()
  const b = page('B', store)
  await b.sync.open()
  b.engine.change((values) => (values.labels.violet = 'Purple'))
  await b.sync.check()
  const a = page('A', store)
  let once = true
  a.engine.hooks.beforeLoad = async () => {
    if (!once) return
    once = false
    a.engine.change((values) => (values.trim.offset = 42))
  }
  await a.sync.open()
  await settle()
  assert.equal(a.engine.state.values.trim.offset, 42)
  assert.equal(a.engine.state.values.labels.violet, 'Purple')
  assert.equal(store.value().prefs.trim.offset, 42)
})
