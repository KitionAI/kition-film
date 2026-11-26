// `invoke`, Film's single entry point, as upstream's `menus.rs` `invoke`: UI commands go to the part
// of the editor that owns them, and every other id runs in the (targeted) session.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvoke, routeOf, toolFromName } from './invoke.ts'

test('routes each id to the part of the editor that owns it', () => {
  const cases = [
    ['tool.razor', 'tool'],
    ['window.panel.EffectControls', 'workspace'],
    ['window.workspace.editing', 'workspace'],
    ['window.maximizeFrame', 'workspace'],
    ['window.maximizeFrameUnderCursor', 'workspace'],
    ['window.nextPanel', 'workspace'],
    ['window.prevPanel', 'workspace'],
    ['mode.edit', 'workspace'],
    ['playback.forward', 'playback'],
    ['source.playback.toggle', 'playback'],
    ['view.zoomIn', 'timelineView'],
    ['graphics.beginTextEditing', 'program'],
    ['view.zoomToSequence', 'timelineView'],
    ['timeline.expandAllTracks', 'timelineView'],
    ['view.playbackRes.quarter', 'monitorView'],
    ['view.pausedRes.half', 'monitorView'],
    ['view.highQualityPlayback', 'monitorView'],
    ['view.magnification.50', 'monitorView'],
    ['view.safeMargins', 'monitorView'],
    ['view.programZoomFit', 'monitorView'],
    ['view.sourceZoom100', 'monitorView'],
    // The display modes and the Comparison View's reference (Task 21).
    ['view.display.red', 'monitorView'],
    ['view.display.comparison', 'monitorView'],
    ['view.compare.setReference', 'monitorView'],
    // Rulers, guides, guide templates, and Snap in Program Monitor (Task 22).
    ['view.showRulers', 'monitorView'],
    ['view.showGuides', 'monitorView'],
    ['view.lockGuides', 'monitorView'],
    ['view.clearGuides', 'monitorView'],
    ['view.addGuide', 'monitorView'],
    ['view.snapInProgramMonitor', 'monitorView'],
    ['view.guideTemplates.save', 'monitorView'],
    ['view.guideTemplates.manage', 'monitorView'],
    ['view.guideTemplates.apply', 'monitorView'],
    ['view.guideTemplates.delete', 'monitorView'],
    ['app.about', 'dialog'],
    ['app.keyboardShortcuts', 'dialog'],
    ['help.about', 'dialog'],
    ['help.shortcuts', 'dialog'],
    ['projectPanel.viewList', 'projectPanel'],
    // Upstream's `file_dialog`: File ▸ Import without paths picks them; Export Media without a path is Kition's MP4 export.
    ['file.import', 'fileDialog'],
    ['file.exportMedia', 'fileDialog'],
    ['marker.markIn', 'session'],
    ['sequence.addEdit', 'session'],
    ['playhead.stepBack', 'session'],
    // A UI command no part of the editor serves yet is not sent to the engine.
    ['help.revealLogFiles', 'unavailable'],
  ]
  for (const [id, route] of cases) assert.equal(routeOf(id, {}, 'timeline'), route, id)
})

test('frame steps with the Source monitor focused move the source playhead', () => {
  for (const id of ['playhead.stepBack', 'playhead.stepForward', 'playhead.stepBack5', 'playhead.stepForward5']) {
    assert.equal(routeOf(id, {}, 'source'), 'sourceStep', id)
    assert.equal(routeOf(id, { monitor: 'program' }, 'source'), 'session', id)
  }
})

function harness(overrides = {}) {
  const ran = []
  const statuses = []
  const routed = []
  const handlers = {
    run: async (id, params) => {
      ran.push({ id, params })
      if (id === 'fails') throw new Error('the engine refused')
      return 'ok'
    },
    query: async (id) => {
      if (id === 'source.inspect') return { item: 5, fps: 25, playhead: 254016000000 }
      if (id === 'prefs.get') return { stepManyFrames: 5 }
      return null
    },
    focused: () => 'timeline',
    sourceContext: () => 'source',
    settleSource: async () => undefined,
    sourceMarkTime: () => undefined,
    status: (message) => statuses.push(message),
    tool: (tool) => routed.push(['tool', tool]),
    playback: (id, params) => routed.push(['playback', id, params]),
    ...overrides,
  }
  return { invoke: createInvoke(handlers), ran, statuses, routed }
}

test('engine commands run in the session; tools set the tool', async () => {
  const { invoke, ran, routed } = harness()
  assert.equal(await invoke('marker.markIn', {}), 'ok')
  await invoke('tool.razor')
  assert.deepEqual(ran, [{ id: 'marker.markIn', params: {} }])
  assert.deepEqual(routed, [['tool', 'Razor']])
})

test('an unknown tool is refused, as upstream', async () => {
  const { invoke, routed, statuses } = harness()
  await invoke('tool.lasso')
  assert.deepEqual(routed, [])
  assert.match(statuses.at(-1), /unknown tool/)
})

test('a tool the editor refuses (the host denies it) says so in the status bar and answers null', async () => {
  const chosen = []
  const { invoke, statuses } = harness({
    tool: (tool) => {
      if (tool === 'Razor') return false
      chosen.push(tool)
      return true
    },
    unavailable: 'Not available',
  })
  assert.equal(await invoke('tool.razor'), null)
  assert.deepEqual(statuses, ['Not available'])
  assert.deepEqual(await invoke('tool.hand'), { tool: 'Hand' })
  assert.deepEqual(chosen, ['Hand'])
})

test('an error shows in the status bar, not as a toast', async () => {
  const { invoke, statuses } = harness()
  assert.equal(await invoke('fails'), null)
  assert.deepEqual(statuses, ['the engine refused'])
})

test('a route the editor does not serve yet says so in the status bar', async () => {
  const { invoke, ran, statuses } = harness()
  await invoke('view.zoomIn')
  assert.deepEqual(ran, [])
  assert.equal(statuses.length, 1)
})

test('a source frame step sets the source playhead a frame (or five) away', async () => {
  const { invoke, ran, routed } = harness({ focused: () => 'source' })
  await invoke('playhead.stepForward')
  await invoke('playhead.stepBack5')
  // One second in at 25 fps is frame 25; the source clock stops first.
  assert.deepEqual(ran, [{ id: 'source.setPlayhead', params: { frame: 26 } }, { id: 'source.setPlayhead', params: { frame: 20 } }])
  assert.deepEqual(routed.map((item) => item[1]), ['source.playback.stop', 'source.playback.stop'])
})

test('a source frame step with no Source clip is refused', async () => {
  const { invoke, ran, statuses } = harness({ focused: () => 'source', query: async () => ({ item: null }) })
  await invoke('playhead.stepForward')
  assert.deepEqual(ran, [])
  assert.equal(statuses.at(-1), 'Open a Source clip first')
})

test("tools match as upstream's Tool::from_name: by id or label, any case, all 17", () => {
  assert.equal(toolFromName('razor'), 'Razor')
  assert.equal(toolFromName('trackSelectBackward'), 'TrackSelectBackward')
  assert.equal(toolFromName('Rectangle'), 'Rectangle')
  assert.equal(toolFromName('ellipse'), 'Ellipse')
  assert.equal(toolFromName('Ripple Edit Tool'), 'Ripple')
  assert.equal(toolFromName('vertical_type'), 'VerticalType')
  assert.equal(toolFromName('lasso'), null)
})

test('the Pen flyout tools, which have no key of their own, can be chosen', async () => {
  const { invoke, routed } = harness()
  await invoke('tool.rectangle')
  await invoke('tool.ellipse')
  assert.deepEqual(routed, [['tool', 'Rectangle'], ['tool', 'Ellipse']])
})

test('serves: a command no part of the editor runs yet is left to the browser', () => {
  const { invoke } = harness()
  assert.equal(invoke.serves('marker.markIn'), true)
  assert.equal(invoke.serves('tool.razor'), true)
  assert.equal(invoke.serves('playback.toggle'), true)
  // mode.export (Cmd+M) has no workspace handler yet, so the system's Minimize still runs.
  assert.equal(invoke.serves('mode.export'), false)
  assert.equal(invoke.serves('view.zoomIn'), false)
  assert.equal(invoke.serves('help.revealLogFiles'), false)
})

test('fast source steps run one after another, so none is lost', async () => {
  let playhead = 254016000000
  const ran = []
  const { invoke } = harness({
    focused: () => 'source',
    query: async (id) => (id === 'source.inspect' ? { item: 5, fps: 25, playhead } : { stepManyFrames: 5 }),
    run: async (id, params) => {
      ran.push(params.frame)
      await new Promise((resolve) => setTimeout(resolve, 5))
      playhead = (params.frame / 25) * 254016000000
      return 'ok'
    },
  })
  await Promise.all([invoke('playhead.stepForward'), invoke('playhead.stepForward'), invoke('playhead.stepForward')])
  assert.deepEqual(ran, [26, 27, 28])
})

for (const held of ['stop', 'inspect', 'preferences']) {
  test(`Source replacement during ${held} cancels the active step and queued keys without stopping the new source`, async () => {
    let context = {}
    let playhead = 254016000000
    let release
    let entered
    const gate = new Promise(resolve => { release = resolve })
    const waiting = new Promise(resolve => { entered = resolve })
    let paused = false
    const pause = async stage => {
      if (paused || stage !== held) return
      paused = true
      entered()
      await gate
    }
    const ran = []
    const stops = []
    const { invoke, statuses } = harness({
      focused: () => 'source',
      sourceContext: () => context,
      playback: async () => { stops.push(context); await pause('stop') },
      query: async id => {
        if (id === 'source.inspect') {
          const view = { item: 5, fps: 25, playhead }
          await pause('inspect')
          return view
        }
        await pause('preferences')
        return { stepManyFrames: 5 }
      },
      run: async (id, params) => {
        assert.equal(id, 'source.setPlayhead')
        ran.push(params.frame)
        playhead = params.frame * 254016000000 / 25
      },
    })
    const first = invoke(held === 'preferences' ? 'playhead.stepForward5' : 'playhead.stepForward')
    await waiting
    const queued = [invoke('playhead.stepForward'), invoke('playhead.stepBack5')]
    context = {}
    playhead = 0
    release()
    await Promise.all([first, ...queued])
    assert.deepEqual(ran, [], 'all keys submitted in the old context are discarded')
    assert.equal(stops.length, 1, 'cancelled queued keys must not stop replacement playback')
    assert.deepEqual(statuses, [])
    await Promise.all([invoke('playhead.stepForward'), invoke('playhead.stepForward'), invoke('playhead.stepForward')])
    await invoke('playhead.stepForward5')
    await invoke('playhead.stepBack5')
    assert.deepEqual(ran, [1, 2, 3, 8, 3], 'fresh keys retain every step and configured jump size')
  })
}

for (const held of ['stop', 'inspect', 'preferences']) {
  test(`fresh Source keys do not wait for the former context's pending ${held}`, async () => {
    let context = {}
    let playhead = 254016000000
    let release
    let entered
    const gate = new Promise(resolve => { release = resolve })
    const waiting = new Promise(resolve => { entered = resolve })
    let paused = false
    const pause = async stage => {
      if (paused || stage !== held) return
      paused = true
      entered()
      await gate
    }
    const ran = []
    const { invoke, statuses } = harness({
      focused: () => 'source',
      sourceContext: () => context,
      playback: () => pause('stop'),
      query: async id => {
        if (id === 'source.inspect') {
          const view = { item: 5, fps: 25, playhead }
          await pause('inspect')
          return view
        }
        await pause('preferences')
        return { stepManyFrames: 5 }
      },
      run: async (id, params) => {
        assert.equal(id, 'source.setPlayhead')
        ran.push(params.frame)
        playhead = params.frame * 254016000000 / 25
      },
    })
    const old = invoke(held === 'preferences' ? 'playhead.stepForward5' : 'playhead.stepForward')
    await waiting
    const oldQueued = invoke('playhead.stepForward5')
    context = {}
    playhead = 0
    const fresh = [invoke('playhead.stepForward'), invoke('playhead.stepForward'), invoke('playhead.stepForward')]
    try {
      // Drain ready microtasks while the original promise remains deliberately unresolved.
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(ran, [1, 2, 3], 'the replacement queue must progress without the old reply')
    } finally {
      release()
      await Promise.all([old, oldQueued, ...fresh])
    }
    assert.deepEqual(ran, [1, 2, 3], 'old completion must not apply its queued inputs')
    await Promise.all([invoke('playhead.stepForward5'), invoke('playhead.stepBack5')])
    assert.deepEqual(ran, [1, 2, 3, 8, 3])
    assert.deepEqual(statuses, [])
  })
}

test("a handler's own serves leaves the ids it does not run to the browser and the status bar", async () => {
  const playback = Object.assign((id) => ({ ran: id }), { serves: (id) => id !== 'playback.playAround' })
  const { invoke, statuses } = harness({ playback, unavailable: 'not yet' })
  assert.equal(invoke.serves('playback.toggle'), true)
  assert.equal(invoke.serves('playback.playAround'), false)
  assert.deepEqual(await invoke('playback.toggle'), { ran: 'playback.toggle' })
  assert.equal(await invoke('playback.playAround'), null)
  assert.deepEqual(statuses, ['not yet'])
})

test('File ▸ Import with paths, or Export Media with a path, runs in the session; without, the file dialog takes it', async () => {
  const fileDialog = (id, params) => ({ dialog: id, params })
  const { invoke, ran } = harness({ fileDialog })
  assert.deepEqual(await invoke('file.import', { bin: 3 }), { dialog: 'file.import', params: { bin: 3 } })
  assert.equal(await invoke('file.import', { paths: ['a.mp4'] }), 'ok')
  assert.equal(await invoke('file.exportMedia', { path: 'a.mp4' }), 'ok')
  assert.deepEqual(ran.map((item) => item.id), ['file.import', 'file.exportMedia'])
  assert.equal(invoke.serves('file.import'), true)
  assert.equal(harness().invoke.serves('file.import'), false)
})

test("a session command's refresh option reaches the session's run (a drag's values repaint only)", async () => {
  const seen = []
  const { invoke } = harness({ run: async (id, params, options) => (seen.push([id, options ?? null]), 'ok') })
  await invoke('effect.setParam', { value: 1 }, { refresh: 'repaint' })
  await invoke('effect.setParam', { value: 2 })
  assert.deepEqual(seen, [
    ['effect.setParam', { refresh: 'repaint' }],
    ['effect.setParam', null],
  ])
})

test('Undo pressed while a released drag still sends its step runs after the whole step, and history keeps its order', async () => {
  // regressions/issue-undo-during-drag-release: a Motion box drag's release sends Anchor Point,
  // then Position, one after the other; an Undo between the two took back the Anchor Point only,
  // and the Position sent after it made a new step (picture.mjs failed once in WebKit).
  const { invoke, ran } = harness()
  let release = () => undefined
  const finishing = (async () => {
    await new Promise((done) => {
      release = done
    })
    await invoke('effect.setParam', { param: 'anchor' })
    await invoke('effect.setParam', { param: 'position' })
  })()
  invoke.gesture(finishing)
  const undo = invoke('edit.undo', {})
  const redo = invoke('edit.redo', {})
  // Other commands do not wait for the gesture.
  await invoke('playhead.stepForward', {})
  assert.deepEqual(ran.map((each) => each.id), ['playhead.stepForward'], 'history waits for the drag')
  release()
  await Promise.all([undo, redo])
  assert.deepEqual(
    ran.map((each) => [each.id, each.params.param ?? null]),
    [
      ['playhead.stepForward', null],
      ['effect.setParam', 'anchor'],
      ['effect.setParam', 'position'],
      ['edit.undo', null],
      ['edit.redo', null],
    ],
  )
  // Once the gesture is done (failed or not), history runs at once again.
  invoke.gesture(Promise.reject(new Error('the drag failed')))
  await new Promise((done) => setTimeout(done, 0))
  await invoke('edit.undo', {})
  assert.equal(ran.at(-1).id, 'edit.undo')
})
