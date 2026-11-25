// Film's dialog framework (Task 9): the registry, `invoke`'s dialog routing, OK, and the preview
// on the engine's scratch session, against a fake engine.
import test from 'node:test'
import assert from 'node:assert/strict'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import status from '../../parity/film-status.json' with { type: 'json' }
import { DIALOGS, DIRECT_ROWS, OTHER_PATHS, createRegistry, dialogDeclarations, dialogSteps, runDialog, specProblems } from './registry.ts'
import { createPreview, createPreviewFrames, describeDiff, previewNames } from './preview.ts'
import { speedDurationReadout } from './clip.ts'
import { createInvoke, routeOf } from '../session/invoke.ts'
import { FILM_MENUS } from '../menus/catalog.ts'
import { isHiddenOnWeb } from '../menus/hidden.ts'


/** A fake engine: records every extra called, answers `previewBegin` with `{}` (or throws `fail`). */
function fakeEngine({ fail = null, settle = [] } = {}) {
  const calls = []
  const pending = [...settle]
  return {
    calls,
    named: (name) => calls.filter((call) => call[0] === name),
    async invoke(name, ...args) {
      calls.push([name, ...args])
      if (name === 'previewBegin' || name === 'previewBeginSteps') {
        if (fail) throw new Error(fail)
        return JSON.stringify({ ok: true })
      }
      if (name === 'previewDiff') return JSON.stringify({ project: { changed: [] }, clips: { added: [], removed: [], changed: [{ id: 3, sequence: 1, track: 2, fields: ['duration', 'speed'] }] } })
      if (name === 'previewSettle') return JSON.stringify(pending.shift() ?? { pending: false, progress: 1 })
      if (name === 'previewInspect') return JSON.stringify({ project: {}, sequence: null })
      if (name === 'previewFrame') return frameBytes(2, 1)
      return null
    },
  }
}

const frameBytes = (width, height) => {
  const bytes = new Uint8Array(8 + width * height * 4)
  new DataView(bytes.buffer).setUint32(0, width, true)
  new DataView(bytes.buffer).setUint32(4, height, true)
  return bytes
}

/** A hand-run animation frame: `run()` fires what is scheduled. */
function frames() {
  let tasks = []
  const schedule = (task) => {
    tasks.push(task)
    return () => {
      tasks = tasks.filter((each) => each !== task)
    }
  }
  return {
    schedule,
    count: () => tasks.length,
    run: async () => {
      const now = tasks
      tasks = []
      for (const task of now) task()
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    },
  }
}

const settleAll = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

const film = {
  fps: 24,
  selection: [3],
  tracks: [{ id: 2, kind: 'video', clips: [{ id: 3, item: 8, name: 'bars.mp4', start: 0, duration: 4, speed: 1, reverse: false }] }],
}
const ctx = { film, session: null, params: {}, query: async () => null }
const request = (steps = [{ command: 'clip.speedDuration', params: { speed: 50 } }], kinds = ['picture', 'timeline']) => ({ kinds, steps })

test("invoke('clip.speedDuration', {}) opens the dialog; with params it runs at once", async () => {
  assert.equal(routeOf('clip.speedDuration', {}, 'timeline'), 'dialog')
  assert.equal(routeOf('clip.speedDuration', { speed: 50 }, 'timeline'), 'session')
  const ran = []
  const opened = []
  const invoke = createInvoke({
    run: async (id, params) => (ran.push({ id, params }), null),
    query: async () => null,
    focused: () => 'timeline',
    status: () => undefined,
    tool: () => true,
    dialog: Object.assign(async (id, params) => (opened.push({ id, params }), { dialog: id }), { serves: (id) => DIALOGS.has(id) }),
  })
  await invoke('clip.speedDuration', {})
  await invoke('clip.speedDuration', { speed: 50 })
  assert.deepEqual(opened, [{ id: 'clip.speedDuration', params: {} }])
  assert.deepEqual(ran, [{ id: 'clip.speedDuration', params: { speed: 50 } }])
  assert.ok(invoke.serves('clip.speedDuration'))
  // OK's own call runs the command even when its params are empty, never the dialog again.
  await invoke('clip.speedDuration', {}, { direct: true })
  assert.deepEqual(ran.at(-1), { id: 'clip.speedDuration', params: {} })
  assert.equal(opened.length, 1)
})

test('invoke with throws: true hands a failure to the caller (the dialog), not the status bar', async () => {
  const said = []
  const invoke = createInvoke({ run: async () => Promise.reject(new Error('no clip selected')), query: async () => null, focused: () => 'timeline', status: (text) => said.push(text), tool: () => true })
  await assert.rejects(invoke('clip.speedDuration', { speed: 50 }, { throws: true }), /no clip selected/)
  assert.deepEqual(said, [])
  assert.equal(await invoke('clip.speedDuration', { speed: 50 }), null)
  assert.deepEqual(said, ['no clip selected'])
})

test("every registry entry has a preview kind, and `none` only alone with its note", () => {
  for (const spec of DIALOGS.specs) {
    assert.deepEqual(specProblems(spec), [], spec.id)
    assert.ok(spec.preview.length > 0, spec.id)
  }
  const base = { id: 'x.y', family: 'menu', title: 'X', prefix: 'x', layout: [], defaults: () => ({}) }
  assert.throws(() => createRegistry([{ ...base, preview: [] }]), /no preview kind/)
  assert.throws(() => createRegistry([{ ...base, preview: ['none'] }]), /with its note/)
  assert.throws(() => createRegistry([{ ...base, preview: ['none', 'picture'], note: 'n' }]), /with its note/)
  assert.throws(() => createRegistry([{ ...base, preview: ['summary', 'picture'], summary: () => [] }]), /never runs on the scratch session/)
  assert.equal(DIALOGS.get('help.about').note, 'Shows information; nothing to preview.')
})

test('OK sends toParams(draft) once', async () => {
  const spec = DIALOGS.get('clip.speedDuration')
  const draft = { ...(await spec.defaults(ctx)), speed: 50, ripple: true }
  const sent = []
  await runDialog(spec, draft, ctx, async (command, params) => sent.push({ command, params }))
  assert.deepEqual(sent, [{ command: 'clip.speedDuration', params: { clips: [3], speed: 50, reverse: false, ripple: true } }])
  // A draft that runs nothing (toParams null) sends nothing.
  assert.deepEqual(dialogSteps(DIALOGS.get('help.about'), { tab: 'about' }, ctx), [])
})

test("Speed / Duration reads the clip's speed and shows the duration at the new one (50% of 4 s is 8 s)", async () => {
  const spec = DIALOGS.get('clip.speedDuration')
  const draft = await spec.defaults(ctx)
  assert.deepEqual(draft, { speed: 100, reverse: false, ripple: false, interpolation: null })
  assert.equal(speedDurationReadout({ ...draft, speed: 50 }, ctx), '00:00:08:00')
  assert.equal(speedDurationReadout({ ...draft, speed: 50 }, { ...ctx, film: { ...film, selection: [] } }), null)
})

test('a draft change calls previewBegin again, at most once per animation frame, the latest draft winning; Cancel calls previewEnd once', async () => {
  const engine = fakeEngine()
  const clock = frames()
  const preview = createPreview({ engine: () => engine, schedule: clock.schedule })
  const handle = preview.handle()
  await handle.begin(request())
  assert.equal(engine.named('previewBegin').length, 1)
  assert.equal(preview.get().open, true)
  assert.equal(preview.get().serial, 1)
  let speed = 60
  const latest = () => request([{ command: 'clip.speedDuration', params: { speed } }])
  // Idle, the first change runs at once; the next, in the same animation frame, waits for the next one.
  await settleAll()
  const one = handle.update(latest)
  speed = 70
  const two = handle.update(latest)
  speed = 80
  const three = handle.update(latest)
  await one
  assert.deepEqual(engine.named('previewBegin').map((call) => JSON.parse(call[2]).speed), [50, 60], 'the first at once')
  await clock.run()
  await Promise.all([two, three])
  assert.deepEqual(engine.named('previewBegin').map((call) => JSON.parse(call[2]).speed), [50, 60, 80], 'then the latest, once')
  assert.equal(preview.get().serial, 3)
  await handle.end()
  await handle.end()
  assert.equal(engine.named('previewEnd').length, 1)
  assert.equal(preview.get().open, false)
})

test('an ended preview is closed for the panels at once, before the engine answers its previewEnd', async () => {
  const engine = fakeEngine()
  let answer = () => undefined
  const slow = { ...engine, invoke: (name, ...args) => (name === 'previewEnd' ? (engine.calls.push([name, ...args]), new Promise((resolve) => (answer = () => resolve(null)))) : engine.invoke(name, ...args)) }
  const preview = createPreview({ engine: () => slow, schedule: frames().schedule })
  const handle = preview.handle()
  await handle.begin(request())
  assert.equal(preview.get().open, true)
  let heard = 0
  const stop = preview.subscribe(() => (heard += 1))
  const ending = handle.end()
  // The engine is busy (rendering a frame): the panels see the preview closed already.
  assert.equal(preview.get().open, false)
  assert.ok(heard > 0, 'and are told so')
  assert.equal(engine.named('previewEnd').length, 1, 'the engine is told')
  answer()
  await ending
  assert.equal(preview.get().open, false)
  // A new dialog's preview after it opens as usual.
  await preview.handle().begin(request())
  assert.equal(preview.get().open, true)
  stop?.()
})

test("a peer's revision reruns begin from the document", async () => {
  // The dialog puts the revision in its draft: PreviewDialog calls update, which begins again.
  const engine = fakeEngine()
  const clock = frames()
  const preview = createPreview({ engine: () => engine, schedule: clock.schedule })
  const handle = preview.handle()
  await handle.begin(request())
  const again = handle.update(() => request())
  await clock.run()
  await again
  assert.equal(engine.named('previewBegin').length, 2)
})

test('the preview ends when the document is replaced, and reads keyed on the old one are dropped', async () => {
  const engine = fakeEngine()
  const clock = frames()
  const preview = createPreview({ engine: () => engine, schedule: clock.schedule })
  const handle = preview.handle()
  await handle.begin(request())
  const before = preview.get().document
  preview.replaced()
  await settleAll()
  assert.equal(engine.named('previewEnd').length, 1)
  assert.equal(preview.get().open, false)
  assert.equal(preview.get().document, before + 1)
  // The old dialog's own end (its unmount) does not end anything again.
  await handle.end()
  assert.equal(engine.named('previewEnd').length, 1)
})

test("a stale dialog's end never ends the next dialog's preview", async () => {
  const engine = fakeEngine()
  const preview = createPreview({ engine: () => engine, schedule: frames().schedule })
  const first = preview.handle()
  const second = preview.handle()
  await first.begin(request())
  await second.begin(request())
  await first.end()
  assert.equal(engine.named('previewEnd').length, 0)
  assert.equal(preview.get().open, true)
})

test('a failing begin leaves no preview open and reaches the dialog', async () => {
  const engine = fakeEngine({ fail: 'command `clip.speedDuration` is not available right now: select a clip' })
  const preview = createPreview({ engine: () => engine, schedule: frames().schedule })
  await assert.rejects(preview.handle().begin(request()), /select a clip/)
  assert.equal(preview.get().open, false)
})

test('a summary dialog, and a draft that runs nothing, never call previewBegin', async () => {
  const engine = fakeEngine()
  const preview = createPreview({ engine: () => engine, schedule: frames().schedule })
  const handle = preview.handle()
  await handle.begin(request([{ command: 'clip.updateMetadata', params: {} }], ['summary']))
  await handle.begin(request(null))
  await handle.begin(request([], ['timeline']))
  assert.equal(engine.calls.filter((call) => call[0].startsWith('previewBegin')).length, 0)
  assert.equal(preview.get().open, false)
})

test('steps preview together through previewBeginSteps', async () => {
  const engine = fakeEngine()
  const preview = createPreview({ engine: () => engine, schedule: frames().schedule })
  const steps = [
    { command: 'sequence.new', params: { name: 'Cut 2' } },
    { command: 'sequence.settings', params: { dropFrame: true } },
  ]
  await preview.handle().begin(request(steps, ['project']))
  assert.deepEqual(JSON.parse(engine.named('previewBeginSteps')[0][1]), steps)
})

test('a job preview settles once per animation frame and shows its progress, then a new serial', async () => {
  const engine = fakeEngine({ settle: [{ pending: true, progress: 0.25 }, { pending: true, progress: 0.5 }] })
  const clock = frames()
  const preview = createPreview({ engine: () => engine, schedule: clock.schedule })
  await preview.handle().begin({ ...request([{ command: 'clip.sceneEditDetection', params: {} }], ['markers']), job: true })
  assert.equal(preview.get().progress, 0)
  await clock.run()
  assert.equal(preview.get().progress, 0.25)
  await clock.run()
  assert.equal(preview.get().progress, 0.5)
  await clock.run()
  assert.equal(preview.get().progress, null)
  assert.equal(preview.get().serial, 2)
  assert.equal(engine.named('previewSettle').length, 3)
  assert.ok(engine.named('previewSettle').every((call) => call[1] === 12), 'a 12 ms budget a frame, so the worker answers the page between')
})

test('a stale preview frame (old revision or serial) is dropped', async () => {
  const engine = fakeEngine()
  const clock = frames()
  let key = { document: 0, revision: 4, serial: 1 }
  const drawn = []
  const pictures = createPreviewFrames({ engine: () => engine, schedule: clock.schedule, current: () => key, onFrame: (image) => drawn.push(image.key) })
  pictures.request(key, 1, 640)
  await clock.run()
  assert.deepEqual(drawn, [{ document: 0, revision: 4, serial: 1 }])
  // The serial moves while a frame is in flight: that frame is not drawn.
  pictures.request(key, 1.5, 640)
  key = { document: 0, revision: 4, serial: 2 }
  await clock.run()
  // A revision from a peer: the same.
  pictures.request(key, 2, 640)
  key = { document: 0, revision: 5, serial: 2 }
  await clock.run()
  assert.equal(drawn.length, 1)
  assert.deepEqual(engine.named('previewFrame').map((call) => call.slice(1)), [[1, 640], [1.5, 640], [2, 640]])
})

test('frames: at most one per animation frame and one in flight, the latest playhead winning', async () => {
  const engine = fakeEngine()
  const clock = frames()
  const key = { document: 0, revision: 1, serial: 1 }
  const pictures = createPreviewFrames({ engine: () => engine, schedule: clock.schedule, current: () => key, onFrame: () => undefined })
  for (const seconds of [1, 2, 3]) pictures.request(key, seconds, 300)
  await settleAll()
  assert.deepEqual(engine.named('previewFrame').map((call) => call[1]), [1], 'idle: the first at once')
  await clock.run()
  await settleAll()
  await clock.run()
  assert.deepEqual(engine.named('previewFrame').map((call) => call[1]), [1, 3], 'then the latest, once')
})

test('an update while idle runs at once, with no animation frame to wait for', async () => {
  const engine = fakeEngine()
  const clock = frames()
  const preview = createPreview({ engine: () => engine, schedule: clock.schedule })
  const handle = preview.handle()
  await handle.begin(request())
  await handle.update(() => request([{ command: 'clip.speedDuration', params: { speed: 25 } }]))
  assert.equal(engine.named('previewBegin').length, 2)
  // A frame later it is idle again: the next change runs at once too.
  await clock.run()
  await handle.update(() => request([{ command: 'clip.speedDuration', params: { speed: 30 } }]))
  assert.equal(engine.named('previewBegin').length, 3)
  const key = { document: 0, revision: 1, serial: 1 }
  const pictures = createPreviewFrames({ engine: () => engine, schedule: clock.schedule, current: () => key, onFrame: () => undefined })
  pictures.request(key, 2, 300)
  await settleAll()
  assert.equal(engine.named('previewFrame').length, 1, 'a frame read at once')
})

test('the strip lists the diff as text for the panels not on screen', () => {
  const t = (key, values = {}) => {
    const text = { 'preview.on': '{what} on {track}', 'preview.noun.clips': 'clip', 'preview.noun.sequences': 'sequence', 'preview.adds': 'Adds {what}', 'preview.changesFields': 'Changes {what}: {fields}', 'preview.count.clips': '{count} clips' }[key] ?? key
    return text.replace(/\{(\w+)\}/g, (_, name) => String(values[name]))
  }
  const document = { project: { activeSequence: 1, root: { children: [{ item: 1, name: 'Sequence 01' }] } }, sequence: { id: 1, video: [{ id: 2, name: 'Video 1', items: [{ clip: 3, name: 'bars.mp4' }] }] } }
  const previewed = { project: { activeSequence: 1, root: { children: [{ item: 1, name: 'Sequence 01' }, { item: 9, name: 'Nest A' }] } } }
  const diff = { sequences: { added: [{ id: 9 }], removed: [], changed: [] }, clips: { added: [], removed: [], changed: [{ id: 3, sequence: 1, track: 2, fields: ['sourceIn', 'speed'] }] } }
  const names = previewNames(document, previewed)
  assert.deepEqual(describeDiff(diff, names, t), ['Adds sequence Nest A', 'Changes clip bars.mp4 on Video 1: source in, speed'])
  // A Timeline on screen draws the clips itself.
  assert.deepEqual(describeDiff(diff, names, t, (kind) => kind === 'project'), ['Adds sequence Nest A'])
})

test("the dialogs' ids stand for upstream's, OK and Cancel for every dialog's", () => {
  const ids = new Set(upstream.elements.map((element) => element.id))
  const declared = dialogDeclarations(DIALOGS)
  for (const item of declared) for (const each of item.upstream) assert.ok(ids.has(each), `${item.id} stands for ${each}, which upstream does not register`)
  const byId = Object.fromEntries(declared.map((item) => [item.id, item.upstream]))
  // And for the dialogs that register their own (Audio Gain's, the colour dialogs', Sequence Settings', Add and Delete Tracks', Link Media's Link, Make Offline's, the Project panel's).
  assert.deepEqual(byId['control:dialog.ok'], ['{}.ok', 'audioGain.ok', 'colorDialog.ok', 'sequenceSettings.ok', 'addTracks.ok', 'deleteTracks.ok', 'linkMedia.link', 'makeOffline.ok', 'projectDialog.ok'])
  assert.deepEqual(byId['control:dialog.cancel'], ['{}.cancel', 'audioGain.cancel', 'colorDialog.cancel', 'sequenceSettings.cancel', 'addTracks.cancel', 'deleteTracks.cancel', 'linkMedia.cancel', 'makeOffline.cancel', 'projectDialog.cancel'])
  assert.deepEqual(byId['control:dialog.about.tab.models'], ['about.tab.models'])
  assert.deepEqual(byId['control:dialog.speedDuration.interpolation.opticalFlow'], ['{}.interpolation.{}'])
})

test('every "…" row of waves 1 and 2 opens an upstream dialog, runs at once as upstream, or takes another upstream path: none needs the parameters fallback', () => {
  const dialogs = new Set(upstream.dialogs)
  const waveOf = (row) => status[`menu:${row.path.join('/')}/${row.command.replace(/^kit:/, '')}`]?.wave ?? null
  const rows = FILM_MENUS.filter((row) => row.label.endsWith('…') && !isHiddenOnWeb(row) && waveOf(row) !== 3)
  const fallback = rows.map((row) => row.command.replace(/^kit:/, '')).filter((id) => !dialogs.has(id) && !DIRECT_ROWS.has(id) && !Object.hasOwn(OTHER_PATHS, id) && !DIALOGS.has(id))
  console.log(`"…" rows: ${rows.length}; with upstream's own dialog ${rows.filter((row) => dialogs.has(row.command)).length}; registered so far ${rows.filter((row) => DIALOGS.has(row.command.replace(/^kit:/, ''))).length}`)
  assert.deepEqual(fallback, [], 'these "…" rows have no upstream dialog: give each kit-editor CommandDialog with upstream labels, or name its upstream path')
  // Every registered dialog is one upstream draws.
  const unknown = DIALOGS.specs.filter((spec) => ![spec.id, ...(spec.aliases ?? [])].some((id) => dialogs.has(id) || Object.hasOwn(OTHER_PATHS, id)))
  assert.deepEqual(unknown.map((spec) => spec.id), [])
})


// ---- Task 9 review fixes

test('a selection change re-begins the preview, and OK names the clips that were previewed', async () => {
  const { previewDepends } = await import('./registry.ts')
  const spec = DIALOGS.get('clip.speedDuration')
  const draft = await spec.defaults(ctx)
  const other = { ...ctx, film: { ...film, selection: [13] } }
  assert.notDeepEqual(previewDepends(spec, ctx), previewDepends(spec, other))
  assert.deepEqual(dialogSteps(spec, { ...draft, speed: 50 }, ctx)[0].params.clips, [3])
  assert.deepEqual(dialogSteps(spec, { ...draft, speed: 50 }, other)[0].params.clips, [13])
})

test('one begin in flight: updates while a begin runs wait for it, then the latest runs once', async () => {
  const engine = fakeEngine()
  let release = null
  const held = { ...engine, async invoke(name, ...args) {
    if (name === 'previewBegin' && engine.named('previewBegin').length >= 1) {
      engine.calls.push([name, ...args])
      await new Promise((resolve) => (release = resolve))
      return '{}'
    }
    return engine.invoke(name, ...args)
  } }
  const clock = frames()
  const preview = createPreview({ engine: () => held, schedule: clock.schedule })
  const handle = preview.handle()
  await handle.begin(request())
  const one = handle.update(() => request())
  await clock.run()
  const two = handle.update(() => request())
  await clock.run()
  await clock.run()
  assert.equal(engine.named('previewBegin').length, 2, 'the second frame waits for the begin in flight')
  release()
  await settleAll()
  await clock.run()
  await settleAll()
  release?.()
  await Promise.all([one, two])
  assert.equal(engine.named('previewBegin').length, 3, 'then the latest draft runs once')
})

test('the preview says when a newer draft is on its way, so a read for the serial shown now can be skipped (latest wins at the read)', async () => {
  const engine = fakeEngine()
  let release = null
  const held = { ...engine, async invoke(name, ...args) {
    if (name === 'previewBegin' && engine.named('previewBegin').length >= 1) {
      engine.calls.push([name, ...args])
      await new Promise((resolve) => (release = resolve))
      return '{}'
    }
    return engine.invoke(name, ...args)
  } }
  const clock = frames()
  const preview = createPreview({ engine: () => held, schedule: clock.schedule })
  const handle = preview.handle()
  await handle.begin(request())
  await settleAll()
  assert.equal(preview.newer(), false, 'nothing on its way')
  const one = handle.update(() => request())
  await clock.run()
  assert.equal(preview.newer(), true, 'a begin in flight')
  release()
  await settleAll()
  await one
  assert.equal(preview.newer(), false)
  const two = handle.update(() => request())
  assert.equal(preview.newer(), true, 'an update queued')
  await clock.run()
  release?.()
  await settleAll()
  await two
  assert.equal(preview.newer(), false)
})

test('when a preview is published, the begin that published it is not a newer one: its serial is read', async () => {
  const engine = fakeEngine()
  const preview = createPreview({ engine: () => engine, schedule: frames().schedule })
  const seen = []
  preview.subscribe(() => {
    if (preview.get().open) seen.push(preview.newer())
    // The panels read in an effect, a moment after the publish.
    void Promise.resolve().then(() => seen.push(preview.newer()))
  })
  await preview.handle().begin(request())
  assert.ok(seen.length >= 2)
  assert.deepEqual(seen.filter(Boolean), [], 'never newer for its own serial')
})

test("a replaced document is told apart from an edit by the engine's project epoch", async () => {
  const { documentReplaced } = await import('./preview.ts')
  const doc = (epoch, path, items, canUndo = false) => ({ canUndo, canRedo: false, project: { epoch, path, root: { id: 0, children: items.map((item) => ({ item })) } } })
  // A collaborator's import or delete on a fresh document arrives with no local undo step.
  assert.equal(documentReplaced(doc(0, 'a', [7, 8]), doc(0, 'a', [7, 8, 9])), false, "a peer's import")
  assert.equal(documentReplaced(doc(0, 'a', [7, 8]), doc(0, 'a', [7])), false, "a peer's delete")
  // A first save or Save As gives the path, and keeps the project.
  assert.equal(documentReplaced(doc(0, null, [7]), doc(0, 'films/New.kfilm', [7])), false, 'a first save')
  assert.equal(documentReplaced(doc(0, 'a', [7], true), doc(0, 'a', [7, 9], true)), false, 'an edit')
  // file.newProject, file.open, Revert, the demo project, a template: the epoch moves.
  assert.equal(documentReplaced(doc(0, 'a', [7, 8]), doc(1, null, [])), true, 'file.newProject')
  assert.equal(documentReplaced(doc(1, null, []), doc(2, null, [5, 6])), true, 'file.openDemoProject')
  assert.equal(documentReplaced(doc(2, 'a', [7], true), doc(3, 'a', [7])), true, 'Revert')
  assert.equal(documentReplaced(null, doc(0, 'a', [7])), false)
})

test("Speed / Duration keeps a reversed clip reversed (the engine stores reverse apart from the speed)", async () => {
  const spec = DIALOGS.get('clip.speedDuration')
  const reversed = { ...ctx, film: { ...film, tracks: [{ ...film.tracks[0], clips: [{ ...film.tracks[0].clips[0], reverse: true }] }] } }
  assert.equal((await spec.defaults(reversed)).reverse, true)
  assert.equal((await spec.defaults(ctx)).reverse, false)
})

test("Speed / Duration preselects the first clip's time interpolation", async () => {
  const spec = DIALOGS.get('clip.speedDuration')
  const blended = { ...ctx, film: { ...film, tracks: [{ ...film.tracks[0], clips: [{ ...film.tracks[0].clips[0], timeInterpolation: 'frameBlending' }] }] } }
  assert.equal((await spec.defaults(blended)).interpolation, 'frameBlending')
  assert.equal(dialogSteps(spec, await spec.defaults(blended), blended)[0].params.interpolation, 'frameBlending')
})

test('a dialog refuses to open for a command the host denies, for an edit in a read-only document, and says why for one the engine cannot run', async () => {
  const { dialogRefusal } = await import('./registry.ts')
  const spec = DIALOGS.get('clip.speedDuration')
  assert.equal(dialogRefusal(spec, { denied: true, readOnly: false, edits: true, enabled: true }), 'denied')
  assert.equal(dialogRefusal(spec, { denied: false, readOnly: true, edits: true, enabled: true }), 'readOnly')
  assert.equal(dialogRefusal(spec, { denied: false, readOnly: false, edits: true, enabled: false }), 'disabled')
  assert.equal(dialogRefusal(spec, { denied: false, readOnly: false, edits: true, enabled: true }), null)
  assert.equal(dialogRefusal(DIALOGS.get('help.about'), { denied: false, readOnly: true, edits: false, enabled: false }), null)
})

test("kit-editor's run with no params or {} and ask open the dialog; ask keeps its values", async () => {
  const { editorOpens } = await import('./registry.ts')
  assert.equal(editorOpens('clip.speedDuration', undefined), true)
  assert.equal(editorOpens('clip.speedDuration', {}), true)
  assert.equal(editorOpens('clip.speedDuration', { speed: 50 }), false)
  assert.equal(editorOpens('timeline.razor', {}), false)
  const opened = []
  const invoke = createInvoke({ run: async () => null, query: async () => null, focused: () => 'timeline', status: () => undefined, tool: () => true, dialog: Object.assign(async (id, params) => opened.push({ id, params }), { serves: () => true }) })
  await invoke('clip.speedDuration', { speed: 20 }, { dialog: true })
  assert.deepEqual(opened, [{ id: 'clip.speedDuration', params: { speed: 20 } }])
})

test("a radio's options carry one id each, as upstream's", () => {
  const ids = dialogDeclarations(DIALOGS).map((item) => item.id)
  for (const name of ['frameSampling', 'frameBlending', 'opticalFlow']) assert.ok(ids.includes(`control:dialog.speedDuration.interpolation.${name}`), name)
  assert.ok(!ids.includes('control:dialog.speedDuration.interpolation'))
})

test('a tabs row declares a tab id each, and its rows; options and readouts may read the draft and the document', async () => {
  const { createRegistry: make } = await import('./registry.ts')
  const spec = {
    id: 'file.projectSettings.general', family: 'menu', title: 'Project Settings', prefix: 'projectSettings', upstream: 'projectSettings', preview: ['picture'], defaults: () => ({ tab: 'general' }),
    layout: [{ kind: 'tabs', field: 'tab', tabs: [{ id: 'general', label: 'General', rows: [{ kind: 'choice', field: 'renderer', label: 'Renderer:', options: (draft, c) => [['cpu', c.film ? 'CPU' : '?']] }] }] }],
  }
  const ids = dialogDeclarations(make([spec])).map((item) => [item.id, item.upstream])
  assert.deepEqual(ids.filter(([id]) => id.includes('projectSettings')), [
    ['control:dialog.projectSettings.tab.general', ['projectSettings.tab.general']],
    ['control:dialog.projectSettings.renderer', ['projectSettings.renderer']],
  ])
})

test("the begin's revision keys the preview's frames", async () => {
  const engine = fakeEngine()
  const preview = createPreview({ engine: () => engine, schedule: frames().schedule })
  await preview.handle().begin({ ...request(), revision: 41 })
  assert.equal(preview.get().revision, 41)
})

test('the Play button: a stop or unmount during its reads closes its sound and leaves no rejection', async () => {
  const { createSoundPlayer } = await import('./sound.ts')
  const closed = []
  let unblock = null
  const engine = { async invoke(name) {
    if (name === 'previewAudioRate') return 48000
    await new Promise((resolve) => (unblock = resolve))
    return new Float32Array(48000 * 2)
  } }
  const audio = () => ({ closed: false, createBuffer: () => ({ copyToChannel() {} }), createBufferSource: () => ({ connect() {}, start() {}, stop() {}, onended: null }), destination: {}, close() { closed.push('closed'); return Promise.resolve() } })
  const player = createSoundPlayer({ audio })
  const playing = player.play(engine, 1, 3)
  await settleAll()
  player.stop()
  unblock()
  await playing
  assert.equal(player.playing(), false)
  assert.deepEqual(closed, [])
  // Played to the end of the reads, then stopped: its context closes.
  const again = player.play({ invoke: async (name) => (name === 'previewAudioRate' ? 48000 : new Float32Array(96)) }, 0, 3)
  await again
  assert.equal(player.playing(), true)
  player.stop()
  assert.deepEqual(closed, ['closed'])
  // A failing read rejects nothing.
  await player.play({ invoke: async () => Promise.reject(new Error('no preview open')) }, 0, 3)
  assert.equal(player.playing(), false)
})

test("the program's own playback renders pause while a picture preview covers the Program monitor", async () => {
  const { playbackRefresh } = await import('./preview.ts')
  assert.equal(playbackRefresh('repaint', true), 'none')
  assert.equal(playbackRefresh('repaint', false), 'repaint')
  assert.equal(playbackRefresh('all', true), 'all')
})
