// The program and source clocks, as upstream's `lib.rs` `play`/`advance_playback`,
// `source_playback.rs`, and the playback arms of `menus.rs` `invoke`, run on a fake clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayback } from './playback.ts'

const TPS = 254_016_000_000

/**
 * A fake editor: a 10 s sequence at 25 fps, an engine that records `playhead.set` and
 * `source.setPlayhead`, a wall clock moved by hand, and animation frames run by `advance`.
 */
function harness({ program = {}, source = null, prefs = {}, audio = false } = {}) {
  let wall = 0
  let frames = []
  const ran = []
  const view = { playhead: 0, duration: 10, in: null, out: null, frame: 1 / 25, sourceItem: source?.item ?? null, ...program }
  const sourceView = source ? { start: 0, end: 4 * TPS, fps: 25, playhead: 0, markIn: null, markOut: null, ...source } : { item: null }
  const preferences = { 'timeline.returnToBeginning': true, 'playback.prerollSeconds': 2, 'playback.postrollSeconds': 2, ...prefs }
  const streams = []
  const output = {
    resumed: 0,
    resume() {
      this.resumed += 1
    },
    start(feed, from) {
      streams.push({ feed, from, stopped: false })
    },
    elapsed: () => null,
    stop() {
      for (const stream of streams) stream.stopped = true
    },
  }
  const playback = createPlayback({
    now: () => wall,
    frame: (callback) => {
      frames.push(callback)
      return () => {
        frames = frames.filter((other) => other !== callback)
      }
    },
    program: () => view,
    query: async (id, params) => {
      if (id === 'prefs.get') return preferences[params.key]
      if (id === 'source.inspect') return sourceView
      return null
    },
    run: async (id, asked, refresh) => {
      let params = asked
      ran.push({ id, params, refresh })
      if (id === 'playhead.set') view.playhead = params.seconds
      if (id === 'source.setPlayhead') {
        // As the engine: `time` is whole ticks (`as_i64`); anything else is no time, so 0.
        if (!Number.isInteger(params.time)) params = { ...params, time: 0 }
        const fd = TPS / sourceView.fps
        const time = Math.max(sourceView.start, Math.min(params.time, sourceView.end - fd))
        sourceView.playhead = Math.round(time / fd) * fd
        // As the session does: the engine's answer as JSON text.
        return JSON.stringify({ time: sourceView.playhead })
      }
      return null
    },
    audio: audio ? () => output : undefined,
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** Moves the wall clock by `ms` in animation frames of 1/60 s, letting the engine answer each. */
  async function advance(ms) {
    const end = wall + ms
    while (wall < end) {
      wall = Math.min(end, wall + 1000 / 60)
      const due = frames
      frames = []
      for (const callback of due) callback()
      await settle()
    }
    await settle()
  }
  return { playback, view, sourceView, ran, advance, settle, streams, output, last: (id) => ran.filter((step) => step.id === id).at(-1)?.params }
}

test('L L L gives speeds 1, 2, 4; J from 4 gives -1; L five times caps at 8', async () => {
  const { playback, settle } = harness()
  const speeds = []
  for (let press = 0; press < 3; press += 1) {
    await playback.invoke('playback.forward', {}, 'timeline')
    speeds.push(playback.state().program.speed)
  }
  assert.deepEqual(speeds, [1, 2, 4])
  await playback.invoke('playback.reverse', {}, 'timeline')
  assert.equal(playback.state().program.speed, -1)
  await playback.invoke('playback.stop', {}, 'timeline')
  assert.equal(playback.state().program.playing, false)
  const capped = []
  for (let press = 0; press < 5; press += 1) {
    await playback.invoke('playback.forward', {}, 'timeline')
    capped.push(playback.state().program.speed)
  }
  assert.deepEqual(capped, [1, 2, 4, 8, 8])
  await settle()
})

test('J doubles in reverse to -8; slow forward and reverse are a quarter speed', async () => {
  const { playback } = harness({ program: { playhead: 5 } })
  const speeds = []
  for (let press = 0; press < 5; press += 1) {
    await playback.invoke('playback.reverse', {}, 'timeline')
    speeds.push(playback.state().program.speed)
  }
  assert.deepEqual(speeds, [-1, -2, -4, -8, -8])
  await playback.invoke('playback.slowForward', {}, 'timeline')
  assert.equal(playback.state().program.speed, 0.25)
  await playback.invoke('playback.slowReverse', {}, 'timeline')
  assert.equal(playback.state().program.speed, -0.25)
})

test('the playhead moves by the clock at the shuttle speed', async () => {
  const { playback, advance, view } = harness()
  await playback.invoke('playback.forward', {}, 'timeline')
  await playback.invoke('playback.forward', {}, 'timeline')
  await advance(1000)
  assert.ok(Math.abs(view.playhead - 2) < 0.05, `at 2x after 1 s: ${view.playhead}`)
})

test('frames the engine has not answered are dropped by the clock, never queued', async () => {
  const slow = []
  // An engine that answers each playhead.set only when told: one in flight at a time.
  const playback = createPlayback({
    now: () => 0,
    frame: () => () => undefined,
    program: () => ({ playhead: 0, duration: 10, in: null, out: null, frame: 1 / 25, sourceItem: null }),
    query: async () => null,
    run: (id, params) =>
      new Promise((resolve) => {
        slow.push({ params, resolve })
      }),
  })
  assert.equal(typeof playback.seekProgram, 'function')
  playback.seekProgram(1)
  playback.seekProgram(2)
  playback.seekProgram(3)
  assert.equal(slow.length, 1)
  slow[0].resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  // The second request is the latest time, 3; 2 was never sent.
  assert.equal(slow.length, 2)
  assert.ok(Math.abs(slow[1].params.seconds - 3) < 1e-9, String(slow[1].params.seconds))
})

test('Space toggles; play from the end starts again at 0 when returnToBeginning is on', async () => {
  const { playback, settle, last } = harness({ program: { playhead: 9.99 } })
  await playback.invoke('playback.toggle', {}, 'timeline')
  await settle()
  assert.equal(playback.state().program.playing, true)
  assert.equal(last('playhead.set').seconds, 0)
  await playback.invoke('playback.toggle', {}, 'timeline')
  assert.equal(playback.state().program.playing, false)
  const off = harness({ program: { playhead: 9.99 }, prefs: { 'timeline.returnToBeginning': false } })
  await off.playback.invoke('playback.toggle', {}, 'timeline')
  await off.settle()
  assert.equal(off.last('playhead.set'), undefined)
})

test('playing to the end stops on the last frame; reverse stops at 0', async () => {
  const { playback, advance, view } = harness({ program: { playhead: 9.5 } })
  await playback.invoke('playback.forward', {}, 'timeline')
  await advance(1000)
  assert.equal(playback.state().program.playing, false)
  assert.ok(Math.abs(view.playhead - (10 - 1 / 25)) < 1e-9, String(view.playhead))
  view.playhead = 0.3
  await playback.invoke('playback.reverse', {}, 'timeline')
  await advance(1000)
  assert.equal(playback.state().program.playing, false)
  assert.equal(view.playhead, 0)
})

test('inToOut seeks to In and stops after Out', async () => {
  const { playback, advance, view, ran } = harness({ program: { playhead: 7, in: 2, out: 3 } })
  await playback.invoke('playback.inToOut', {}, 'timeline')
  await advance(50)
  assert.equal(ran.find((step) => step.id === 'playhead.set').params.seconds, 2)
  await advance(1200)
  assert.equal(playback.state().program.playing, false)
  assert.ok(Math.abs(view.playhead - (3 + 1 / 25)) < 1e-9, String(view.playhead))
})

test('loop plays In to Out again and again', async () => {
  const { playback, advance, view } = harness({ program: { playhead: 2, in: 2, out: 2.96 } })
  assert.deepEqual(await playback.invoke('playback.loop', {}, 'timeline'), { loop: true })
  await playback.invoke('playback.toggle', {}, 'timeline')
  await advance(1500)
  assert.equal(playback.state().program.playing, true)
  assert.ok(view.playhead >= 2 && view.playhead < 3, String(view.playhead))
})

test('play to Out and play In to Out with preroll and postroll', async () => {
  const toOut = harness({ program: { playhead: 1, out: 1.96 } })
  await toOut.playback.invoke('playback.toOut', {}, 'timeline')
  await toOut.advance(1500)
  assert.equal(toOut.playback.state().program.playing, false)
  assert.ok(Math.abs(toOut.view.playhead - 2) < 1e-9, String(toOut.view.playhead))
  const preroll = harness({ program: { playhead: 7, in: 3, out: 3.96 } })
  await preroll.playback.invoke('playback.inToOutPreroll', {}, 'timeline')
  await preroll.advance(50)
  assert.equal(preroll.ran.find((step) => step.id === 'playhead.set').params.seconds, 1)
})

test('starting source playback stops program playback, and the other way round', async () => {
  const { playback, settle } = harness({ source: { item: 7 } })
  await playback.invoke('playback.toggle', {}, 'timeline')
  assert.equal(playback.state().program.playing, true)
  await playback.invoke('playback.toggle', {}, 'source')
  await settle()
  assert.equal(playback.state().program.playing, false)
  assert.equal(playback.state().source.playing, true)
  await playback.invoke('playback.toggle', {}, 'timeline')
  assert.equal(playback.state().source.playing, false)
  assert.equal(playback.state().program.playing, true)
})

test('source playback moves the source playhead at 1x, never the program playhead', async () => {
  // At 29.97 fps a frame is not whole ticks, and the clock's times never are.
  const { playback, advance, ran, sourceView } = harness({ source: { item: 7, fps: 30000 / 1001 } })
  await playback.invoke('source.playback.play', {}, 'timeline')
  await advance(1000)
  assert.ok(Math.abs(sourceView.playhead / TPS - 1) < 0.08, String(sourceView.playhead / TPS))
  assert.equal(ran.some((step) => step.id === 'playhead.set'), false)
  // Space with the Source monitor focused stops it; the program does not start.
  await playback.invoke('playback.toggle', {}, 'source')
  assert.equal(playback.state().source.playing, false)
  assert.equal(playback.state().program.playing, false)
})

test('source playback stops on the last frame of the clip, and starts again from its start', async () => {
  const { playback, advance, sourceView } = harness({ source: { item: 7, playhead: 3.5 * TPS } })
  await playback.invoke('source.playback.toggle', {}, 'timeline')
  await advance(1000)
  assert.equal(playback.state().source.playing, false)
  assert.equal(sourceView.playhead, 4 * TPS - TPS / 25)
  // From the last frame, playing starts again at the clip's start (upstream `start_source_playback`).
  await playback.invoke('source.playback.toggle', {}, 'timeline')
  await advance(20)
  assert.ok(sourceView.playhead < TPS / 2, String(sourceView.playhead / TPS))
})

test('source rules follow upstream: forward plays, reverse and slow speeds refuse, no clip refuses', async () => {
  const { playback, settle } = harness({ source: { item: 7 } })
  assert.deepEqual(await playback.invoke('playback.forward', {}, 'source'), { playing: true, speed: 1 })
  await assert.rejects(async () => playback.invoke('playback.reverse', {}, 'source'), /normal forward speed/)
  await assert.rejects(async () => playback.invoke('playback.slowForward', {}, 'source'), /normal forward speed/)
  await settle()
  const empty = harness()
  await assert.rejects(async () => empty.playback.invoke('source.playback.play', {}, 'timeline'), /Source monitor first/)
})

test('source loop plays the marked range again', async () => {
  const { playback, advance, sourceView } = harness({ source: { item: 7, markIn: TPS, markOut: 2 * TPS - TPS / 25 } })
  await playback.invoke('playback.loop', {}, 'source')
  await playback.invoke('source.playback.play', {}, 'timeline')
  await advance(1600)
  assert.equal(playback.state().source.playing, true)
  assert.ok(sourceView.playhead >= TPS && sourceView.playhead < 2 * TPS, String(sourceView.playhead / TPS))
})

test('the sound is resumed inside the gesture, and plays only at 1x as upstream', async () => {
  const { playback, output, streams, settle } = harness({ audio: true, source: { item: 7 } })
  const pending = playback.invoke('playback.forward', {}, 'timeline')
  // Before any await: the context resumes in the key press itself.
  assert.equal(output.resumed, 1)
  await pending
  await settle()
  assert.equal(streams.length, 1)
  assert.equal(streams[0].feed.kind, 'program')
  await playback.invoke('playback.forward', {}, 'timeline')
  await settle()
  assert.equal(streams.every((stream) => stream.stopped), true, 'no sound at 2x')
  await playback.invoke('source.playback.play', {}, 'timeline')
  await settle()
  assert.deepEqual(streams.at(-1).feed, { kind: 'source', item: 7 })
})

test('the program playhead moves once per sequence frame at most, snapped to frames', async () => {
  const { playback, advance, ran } = harness()
  await playback.invoke('playback.toggle', {}, 'timeline')
  await advance(1000)
  const sets = ran.filter((step) => step.id === 'playhead.set')
  // 60 animation frames in the second, 25 sequence frames.
  assert.ok(sets.length <= 26, `${sets.length} playhead moves in 1 s at 25 fps`)
  for (const { params } of sets) assert.ok(Math.abs(params.seconds * 25 - Math.round(params.seconds * 25)) < 1e-6, String(params.seconds))
})

test("while playing, program moves only repaint and source moves refresh nothing; a stop refreshes everything once", async () => {
  const program = harness()
  await program.playback.invoke('playback.toggle', {}, 'timeline')
  await program.advance(300)
  await program.playback.invoke('playback.toggle', {}, 'timeline')
  await program.settle()
  const sets = program.ran.filter((step) => step.id === 'playhead.set')
  assert.deepEqual([...new Set(sets.slice(0, -1).map((step) => step.refresh))], ['repaint'])
  assert.equal(sets.at(-1).refresh, 'all')
  assert.equal(sets.filter((step) => step.refresh === 'all').length, 1)
  const source = harness({ source: { item: 7 } })
  await source.playback.invoke('source.playback.play', {}, 'timeline')
  await source.advance(300)
  await source.playback.invoke('source.playback.stop', {}, 'timeline')
  await source.settle()
  assert.deepEqual([...new Set(source.ran.filter((step) => step.id === 'source.setPlayhead').map((step) => step.refresh))], ['none'])
})

/** Keeps the fake model's playhead where it is until released (as the editor's model is until its refresh renders). */
function harnessFreeze(view) {
  let frozen = true
  let value = view.playhead
  Object.defineProperty(view, 'playhead', { configurable: true, get: () => value, set: (next) => { if (!frozen) value = next; else pending = next } })
  let pending = value
  return { release() { frozen = false; value = pending } }
}

test('the program time is published while playing only, and a stop shows where it stopped until the model catches up', async () => {
  const { playback, advance, view } = harness()
  assert.equal(playback.programTime(), null)
  await playback.invoke('playback.toggle', {}, 'timeline')
  await advance(500)
  const playing = playback.programTime()
  assert.ok(playing > 0.4, String(playing))
  // The editor's model, not refreshed while playing, still says where playing started.
  const stale = 0
  view.playhead = stale
  const engine = harnessFreeze(view)
  await playback.invoke('playback.toggle', {}, 'timeline')
  assert.equal(playback.programTime(), null)
  // Until the model catches up, the stop point shows.
  assert.ok(Math.abs(playback.restingProgram(stale) - playing) < 0.1)
  // Once the model moves, it is followed again.
  engine.release()
  assert.equal(playback.restingProgram(view.playhead), view.playhead)
  assert.equal(playback.restingProgram(1.5), 1.5)
})

test('after a source stop the Source monitor shows the engine playhead, not the clock time', async () => {
  const { playback, advance, sourceView, settle } = harness({ source: { item: 7 } })
  await playback.invoke('source.playback.play', {}, 'timeline')
  await advance(400)
  assert.ok(playback.sourceTime() > 0)
  await playback.invoke('source.playback.stop', {}, 'timeline')
  await settle()
  await settle()
  assert.equal(playback.sourceTime(), sourceView.playhead)
  // Another source command (a step) moves the engine; reading again follows it.
  sourceView.playhead = 5 * (TPS / 25)
  await playback.readSource()
  assert.equal(playback.sourceTime(), 5 * (TPS / 25))
})

test('the source playhead moves once per clip frame at most, on whole frames', async () => {
  const { playback, advance, ran } = harness({ source: { item: 7, fps: 24 } })
  await playback.invoke('source.playback.play', {}, 'timeline')
  await advance(1000)
  const moves = ran.filter((step) => step.id === 'source.setPlayhead').slice(1)
  assert.ok(moves.length <= 25, `${moves.length} source moves in 1 s at 24 fps`)
  for (const { params } of moves) assert.equal(params.time % (TPS / 24), 0, String(params.time))
})

test('moving the source playhead while it plays re-anchors the clock there and keeps playing (upstream advance_source_playback)', async () => {
  const { playback, advance, sourceView, streams } = harness({ source: { item: 7 }, audio: true })
  await playback.invoke('source.playback.play', {}, 'timeline')
  await advance(500)
  playback.moveSource(2 * TPS)
  await advance(0)
  assert.equal(playback.state().source.playing, true, 'still playing')
  assert.equal(sourceView.playhead, 2 * TPS)
  await advance(500)
  assert.ok(Math.abs(sourceView.playhead / TPS - 2.5) < 0.08, String(sourceView.playhead / TPS))
  // The sound starts again from the new place.
  assert.equal(streams.at(-1).from, 2)
  assert.equal(streams.at(-1).stopped, false)
  assert.equal(streams.at(-2).stopped, true, 'the sound from before the move stopped')
})

test('moving the source playhead while stopped just moves it', async () => {
  const { playback, settle, sourceView } = harness({ source: { item: 7 } })
  playback.moveSource(TPS)
  await settle()
  await settle()
  assert.equal(playback.state().source.playing, false)
  assert.equal(sourceView.playhead, TPS)
})

test('readSource answers the view it read, so a reader needs no second source.inspect; nothing while playing', async () => {
  const { playback, sourceView } = harness({ source: { item: 7, playhead: TPS } })
  const view = await playback.readSource()
  assert.equal(view?.playhead, sourceView.playhead)
  await playback.invoke('source.playback.play', {}, 'timeline')
  assert.equal(await playback.readSource(), undefined)
})

test("the dropped-frame count (upstream PlaybackMeter): frames the clock passed over and frames replaced before the engine took them; a new play counts from 0", async () => {
  let wall = 0
  let frames = []
  const slow = []
  const view = { playhead: 0, duration: 10, in: null, out: null, frame: 1 / 25, sourceItem: null }
  // An engine that answers each playhead.set only when told: one in flight at a time.
  const playback = createPlayback({
    now: () => wall,
    frame: (callback) => {
      frames.push(callback)
      return () => {
        frames = frames.filter((other) => other !== callback)
      }
    },
    program: () => view,
    query: async () => false,
    run: (id, params) =>
      new Promise((resolve) => {
        if (id === 'playhead.set') view.playhead = params.seconds
        slow.push({ id, params, resolve })
      }),
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** One animation frame `ms` after the last. */
  const tick = async (ms) => {
    wall += ms
    const due = frames
    frames = []
    for (const callback of due) callback()
    await settle()
  }
  const answer = async () => {
    for (const step of slow.splice(0)) step.resolve()
    await settle()
  }
  await playback.invoke('playback.toggle', {}, 'timeline')
  await settle()
  assert.equal(playback.programDropped(), 0)
  // Frame by frame, each answered in time: nothing dropped.
  for (let frame = 0; frame < 3; frame += 1) {
    await tick(40)
    await answer()
  }
  assert.equal(playback.programDropped(), 0)
  // The engine is slow: frame 4 is in flight, 5 waits, and 6 replaces it before it is sent.
  await tick(40)
  await tick(40)
  await tick(40)
  assert.equal(playback.programDropped(), 1)
  await answer()
  await answer()
  // A stall: the clock passes over three frames (6 to 10).
  await tick(160)
  assert.equal(playback.programDropped(), 4)
  await answer()
  // The count is the controller's own: it tells the program clock's listeners, as each move does.
  let told = 0
  const stop = playback.subscribeProgramTime(() => (told += 1))
  await tick(40)
  assert.ok(told > 0)
  stop()
  await answer()
  // Stopped and played again: from 0.
  await playback.invoke('playback.toggle', {}, 'timeline')
  await answer()
  await playback.invoke('playback.toggle', {}, 'timeline')
  await settle()
  assert.equal(playback.programDropped(), 0)
  await playback.invoke('playback.toggle', {}, 'timeline')
  await answer()
})

test("time the page was hidden, or a gap over 250 ms between frames, is not counted as dropped (upstream's resync); a frame another reader skipped while playing is", async () => {
  let wall = 0
  let frames = []
  let hidden = false
  const view = { playhead: 0, duration: 60, in: null, out: null, frame: 1 / 25, sourceItem: null }
  const playback = createPlayback({
    now: () => wall,
    frame: (callback) => {
      frames.push(callback)
      return () => {
        frames = frames.filter((other) => other !== callback)
      }
    },
    hidden: () => hidden,
    program: () => view,
    query: async () => false,
    run: async (id, params) => {
      if (id === 'playhead.set') view.playhead = params.seconds
      return null
    },
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const tick = async (ms) => {
    wall += ms
    const due = frames
    frames = []
    for (const callback of due) callback()
    await settle()
  }
  await playback.invoke('playback.toggle', {}, 'timeline')
  await settle()
  await tick(40)
  await tick(40)
  // A background tab: the browser ran no frame for 2 s.
  await tick(2000)
  assert.equal(playback.programDropped(), 0)
  await tick(40)
  // Hidden, even a short gap is not counted.
  hidden = true
  await tick(120)
  hidden = false
  await tick(40)
  assert.equal(playback.programDropped(), 0)
  // A real stall under 250 ms still counts.
  await tick(160)
  assert.equal(playback.programDropped(), 3)
  // The Program's channel picture skipped a frame (inside a program-time tell): counted while
  // playing, told to the dropped count's listeners only, never to every program-time listener again.
  let told = 0
  let times = 0
  const stop = playback.subscribeDropped(() => (told += 1))
  const stopTimes = playback.subscribeProgramTime(() => (times += 1))
  playback.noteDropped()
  assert.deepEqual([playback.programDropped(), told, times], [4, 1, 0])
  stop()
  stopTimes()
  await playback.invoke('playback.toggle', {}, 'timeline')
  await settle()
  playback.noteDropped()
  assert.equal(playback.programDropped(), 4, 'not counted while stopped')
})
