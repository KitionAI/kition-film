// FilmAudioPlayer's clock on a fake AudioContext and a hand-moved wall clock: which clock leads,
// and that handing over between them never jumps and never loses sound.
import test from 'node:test'
import assert from 'node:assert/strict'
import { AUDIO_FAILED, AUDIO_STALLED, FilmAudioPlayer } from './audio.ts'

const RATE = 48_000

/** A fake AudioContext: its state and clock are set by the test; scheduled sources are recorded. */
function fakeContext() {
  const listeners = []
  const context = {
    state: 'running',
    currentTime: 0,
    destination: {},
    started: [],
    stopped: 0,
    suspended: 0,
    createGain: () => ({ gain: { value: 1, setTargetAtTime() {} }, connect() {} }),
    createBuffer: (channels, frames) => {
      const data = Array.from({ length: channels }, () => new Float32Array(frames))
      return { length: frames, getChannelData: (index) => data[index] }
    },
    createBufferSource: () => {
      const node = {
        buffer: null,
        connect() {},
        disconnect() {},
        start: (when) => context.started.push({ when, frames: node.buffer.length }),
        stop: () => {
          context.stopped += 1
        },
        onended: null,
      }
      return node
    },
    addEventListener: (type, listener) => listeners.push(listener),
    resume: async () => undefined,
    suspend: async () => {
      context.suspended += 1
    },
    close: async () => undefined,
    /** Changes the state and tells the player, as a real context's `statechange` does. */
    setState(state) {
      context.state = state
      for (const listener of listeners) listener()
    },
  }
  return context
}

/** A document whose `audio` mixes a chunk of a known value per chunk start, and records what was asked. */
function fakeDoc() {
  const asked = []
  return {
    asked,
    invoke: async (name, ...args) => {
      if (name === 'audioRate') return RATE
      asked.push(args[0])
      const samples = new Float32Array(args[1] * 2)
      samples.fill(args[0] + 1)
      return samples
    },
  }
}

function setup() {
  let wall = 1000
  const context = fakeContext()
  const doc = fakeDoc()
  const errors = []
  const player = new FilmAudioPlayer(() => doc, { context: () => context, now: () => wall, onError: (message) => errors.push(message) })
  const chunks = []
  player.onChunk = (samples, when) => chunks.push({ value: samples[0], length: samples.length / 2, when })
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  return {
    context,
    doc,
    player,
    errors,
    chunks,
    settle,
    /** Moves wall time, and the audio clock with it unless it is held. */
    advance(ms, { audio = true } = {}) {
      wall += ms
      if (audio && context.state === 'running') context.currentTime += ms / 1000
    },
  }
}

test('a context whose clock stands still from the start never leads: wall time does', async () => {
  const { context, player, advance, settle, chunks } = setup()
  context.currentTime = 0.0053
  player.start({ kind: 'program' }, 0)
  await settle()
  advance(580, { audio: false })
  assert.ok(Math.abs(player.elapsed() - 0.5) < 1e-9, String(player.elapsed()))
  advance(1000, { audio: false })
  assert.ok(Math.abs(player.elapsed() - 1.5) < 1e-9, String(player.elapsed()))
  assert.equal(chunks.length, 0, 'no sound is scheduled against a clock that does not move')
  player.stop()
})

test('a clock that stalls after leading hands over to wall time without a jump, stops the sound, and says why', async () => {
  const { context, player, advance, settle, errors } = setup()
  player.start({ kind: 'program' }, 0)
  await settle()
  advance(500)
  const leading = player.elapsed()
  assert.ok(leading > 0.4, String(leading))
  // The device stops taking samples: the audio clock stands still for a second (the picture holds, as upstream).
  advance(600, { audio: false })
  assert.equal(player.elapsed(), leading)
  advance(500, { audio: false })
  const handed = player.elapsed()
  assert.ok(Math.abs(handed - leading) < 1e-9, `${handed} after ${leading}`)
  assert.deepEqual(errors, [AUDIO_STALLED])
  assert.ok(context.stopped > 0, 'the scheduled sound stops')
  advance(250, { audio: false })
  assert.ok(Math.abs(player.elapsed() - (leading + 0.25)) < 1e-9, String(player.elapsed()))
  player.stop()
})

test('a context that suspends while leading goes on from where the sound got to, and a resume does not jump back', async () => {
  const { context, player, advance, settle, errors } = setup()
  player.start({ kind: 'program' }, 0)
  await settle()
  advance(1000)
  const before = player.elapsed()
  context.setState('suspended')
  assert.deepEqual(errors, [AUDIO_FAILED])
  advance(400)
  const during = player.elapsed()
  assert.ok(Math.abs(during - (before + 0.4)) < 1e-9, `${during} after ${before}`)
  // Resumed, its clock carries on from where it paused, 0.4 s behind the picture: wall time still leads.
  context.setState('running')
  advance(100)
  assert.ok(player.elapsed() >= during + 0.1 - 1e-9, String(player.elapsed()))
  player.stop()
})

test('chunks mixed before the audio clock leads are scheduled once it does, from where the picture is', async () => {
  const { context, doc, player, advance, settle, chunks } = setup()
  context.currentTime = 2
  player.start({ kind: 'program' }, 0)
  await settle()
  // Mixed while the clock had not moved yet: nothing heard, nothing lost.
  assert.ok(doc.asked.includes(0), JSON.stringify(doc.asked))
  assert.equal(chunks.length, 0)
  advance(180)
  player.elapsed()
  // The first chunk is heard from 0.1 s in (the start delay is 0.08 s), its late part dropped.
  assert.ok(chunks.length >= 1, 'the waiting chunks are scheduled')
  assert.equal(chunks[0].value, 1, 'the first chunk (at 0) is not lost')
  assert.equal(chunks[0].length, RATE / 2 - Math.round(0.1 * RATE))
  assert.ok(Math.abs(chunks[0].when - context.currentTime) < 1e-9)
  assert.ok(Math.abs(context.started[0].when - context.currentTime) < 1e-9)
  player.stop()
})

test('the Audio Meters hear each chunk with its rate and whose sound it is, and that a stop silences what was scheduled', async () => {
  const { context, player, advance, settle } = setup()
  const heard = []
  let silenced = 0
  player.onChunk = (samples, when, rate, kind) => heard.push({ rate, kind })
  player.onSilence = () => (silenced += 1)
  context.currentTime = 1
  player.start({ kind: 'source', item: 4 }, 0)
  await settle()
  advance(180)
  player.elapsed()
  assert.ok(heard.length >= 1)
  assert.deepEqual(heard[0], { rate: RATE, kind: 'source' })
  const before = silenced
  player.stop()
  assert.equal(silenced, before + 1)
})

test("the heard time is the context's clock less its output latency, where it has one", () => {
  const { context, player } = setup()
  context.currentTime = 3
  assert.equal(player.heardTime, 3, 'no outputLatency: the clock itself')
  context.outputLatency = 0.25
  assert.equal(player.heardTime, 2.75)
  context.outputLatency = Number.NaN
  assert.equal(player.heardTime, 3)
})

test('stop suspends the context until the next play, unless one starts at once', async () => {
  const { context, player, settle } = setup()
  player.start({ kind: 'program' }, 0)
  player.stop()
  player.start({ kind: 'program' }, 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(context.suspended, 0)
  player.stop()
  await new Promise((resolve) => setTimeout(resolve, 5))
  await settle()
  assert.equal(context.suspended, 1)
})
