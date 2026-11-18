// Imports are types only, so `node --test` loads this module as it is.
import type { KitEngine } from '@kition/kit-editor'
import type { AudioFeed, AudioOutput } from './session/playback.ts'

const CHUNK_SECONDS = 0.5
const LOOKAHEAD_SECONDS = 1.2
const START_DELAY_SECONDS = 0.08
/** How far the context's clock must move after a play starts before it leads: a context without a working device can move one render quantum and stop. */
const MOVING_SECONDS = 0.05
/** Upstream's `AUDIO_STALL_S`: an audio clock that stands still this long hands over to wall time. */
const STALL_SECONDS = 1

/** Upstream's messages when the sound gives up its clock (`lib.rs` `advance_playback`, `source_playback.rs`). */
export const AUDIO_FAILED = 'Audio output failed: playing without sound (check Settings ▸ Audio Hardware)'
export const AUDIO_STALLED = 'Audio output is not responding: playing without sound (check Settings ▸ Audio Hardware)'
export const SOURCE_AUDIO_STALLED = 'Source audio output stopped responding: playing without sound (check Settings ▸ Audio Hardware)'

/** The parts of an `AudioContext` the player uses (a fake one in the tests). */
export type AudioContextLike = Pick<AudioContext, 'state' | 'currentTime' | 'outputLatency' | 'destination' | 'createGain' | 'createBuffer' | 'createBufferSource' | 'addEventListener' | 'resume' | 'suspend' | 'close'>

export type FilmAudioOptions = {
  muted?: boolean
  /** Makes the context (a real `AudioContext` by default). */
  context?: () => AudioContextLike
  /** Wall time in milliseconds (`performance.now` by default). */
  now?: () => number
  /** Hears why the sound stopped while the picture plays on (the status bar). */
  onError?: (message: string) => void
}

/** A chunk mixed before the audio clock leads: kept, and scheduled once it does. */
type Chunk = { at: number; frames: number; rate: number; samples: Float32Array }

/** One play's sound: chunks scheduled from `from` on the shared context. */
type Stream = {
  feed: AudioFeed
  from: number
  /** Wall time (ms) at which `from` is heard while the wall clock leads. */
  wallOrigin: number
  /** The context time at which `from` is heard; set once the context's clock moves. */
  audioOrigin: number | null
  /** The context's clock when the play started: the audio clock leads only once it has moved from here. */
  startedAt: number
  /** The audio clock's last reading, and the wall time it last moved (upstream's `audio_seen`). */
  seen: { at: number; wall: number }
  /** Set when the audio clock failed or stalled: wall time leads from then on, without sound. */
  stalled: boolean
  next: number
  stopped: boolean
  pumping: boolean
  timer: ReturnType<typeof setTimeout> | null
  waiting: Chunk[]
  nodes: Set<AudioBufferSourceNode>
}

/**
 * Plays the editor's sound: the Film engine mixes it in half-second chunks that are scheduled ahead
 * on one WebAudio context. The sequence's mix comes from the `audio` extra (program playback), a
 * project item's own sound from `itemAudio` (source playback). The context's clock is the playback
 * clock, so the picture follows the sound; `onChunk` hears every chunk as it is scheduled (the part
 * that will be heard, and when), so the Audio Meters read the same samples that are heard.
 *
 * Make it inside a play gesture, and call `resume()` in every later one: WebKit (the desktop app's
 * web view) starts a context suspended and runs it only after `resume()` in a gesture. The clock
 * starts at once, on wall time, and moves to the audio clock when the context runs and its clock
 * moves, continuing from where wall time had got to; chunks mixed meanwhile wait for it. An audio
 * clock that stops running, or stands still for a second, hands back to wall time from where the
 * sound got to, stops the sound, and says why (upstream's `AUDIO_STALL_S`).
 */
export class FilmAudioPlayer implements AudioOutput {
  private readonly context: AudioContextLike
  private readonly gain: GainNode
  private readonly now: () => number
  private readonly onError: (message: string) => void
  private stream: Stream | null = null
  private sampleRate: Promise<number> | null = null
  private suspending: ReturnType<typeof setTimeout> | null = null
  /** Hears each chunk as it is scheduled: interleaved stereo samples at `rate`, the context time the first of them is heard, and whose sound it is. */
  onChunk: ((samples: Float32Array, when: number, rate: number, kind: AudioFeed['kind']) => void) | null = null
  /** Hears that the chunks scheduled so far will not be heard after all (a stop, or a new play). */
  onSilence: (() => void) | null = null

  private readonly doc: () => KitEngine | null

  constructor(doc: () => KitEngine | null, options: FilmAudioOptions = {}) {
    this.doc = doc
    this.now = options.now ?? (() => performance.now())
    this.onError = options.onError ?? (() => undefined)
    this.context = (options.context ?? (() => new AudioContext()))()
    this.gain = this.context.createGain()
    this.gain.gain.value = options.muted ? 0 : 1
    this.gain.connect(this.context.destination)
    this.context.addEventListener('statechange', () => this.check())
    this.resume()
  }

  /** Inside a gesture: the only place WebKit lets a context start. */
  resume() {
    if (this.suspending != null) clearTimeout(this.suspending)
    this.suspending = null
    if (this.context.state !== 'running') void this.context.resume().catch(() => undefined)
  }

  /** The context's clock, which `onChunk`'s `when` is on. */
  get currentTime() {
    return this.context.currentTime
  }

  /**
   * The context time of the sound reaching the speakers now: the clock less the output's latency
   * (`outputLatency`, where the browser has it), so the Audio Meters do not lead what is heard.
   */
  get heardTime() {
    const latency = this.context.outputLatency
    return this.context.currentTime - (Number.isFinite(latency) && latency > 0 ? latency : 0)
  }

  start(feed: AudioFeed, from: number) {
    this.stop()
    this.resume()
    const now = this.now()
    this.stream = {
      feed,
      from,
      wallOrigin: now + START_DELAY_SECONDS * 1000,
      audioOrigin: null,
      startedAt: this.context.currentTime,
      seen: { at: -1, wall: now },
      stalled: false,
      next: from,
      stopped: false,
      pumping: false,
      timer: null,
      waiting: [],
      nodes: new Set(),
    }
    this.check()
    void this.pump(this.stream)
  }

  /** Seconds played on wall time since `from` was due. */
  private wallPlayed(stream: Stream) {
    return Math.max(0, (this.now() - stream.wallOrigin) / 1000)
  }

  /**
   * Follows the context: ties the audio clock to the time already played once the context runs
   * and its clock moves (a context without a working output device can say it runs while its
   * clock stands still, and the picture must not wait for it), and gives the clock back to wall
   * time when an anchored context stops running or stands still.
   */
  private check() {
    const stream = this.stream
    if (!stream || stream.stopped || stream.stalled) return
    const now = this.now()
    const time = this.context.currentTime
    if (stream.audioOrigin == null) {
      if (this.context.state !== 'running' || time - stream.startedAt < MOVING_SECONDS) return
      const played = this.wallPlayed(stream)
      stream.audioOrigin = time - played + (played > 0 ? 0 : START_DELAY_SECONDS)
      stream.seen = { at: time, wall: now }
      // What was mixed while wall time led is heard now, from where the picture is.
      const waiting = stream.waiting
      stream.waiting = []
      for (const chunk of waiting) this.schedule(stream, chunk)
      return
    }
    const played = Math.max(0, stream.seen.at - stream.audioOrigin)
    if (this.context.state !== 'running') return this.giveUp(stream, played, stream.feed.kind === 'source' ? SOURCE_AUDIO_STALLED : AUDIO_FAILED)
    if (time !== stream.seen.at) stream.seen = { at: time, wall: now }
    else if (now - stream.seen.wall >= STALL_SECONDS * 1000) this.giveUp(stream, played, stream.feed.kind === 'source' ? SOURCE_AUDIO_STALLED : AUDIO_STALLED)
  }

  /** The sound stops; wall time goes on from `played`, where the sound got to. */
  private giveUp(stream: Stream, played: number, why: string) {
    stream.stalled = true
    stream.wallOrigin = this.now() - played * 1000
    this.silence(stream)
    this.onError(why)
  }

  elapsed() {
    const stream = this.stream
    if (!stream) return null
    this.check()
    if (stream.audioOrigin != null && !stream.stalled) return Math.max(0, stream.seen.at - stream.audioOrigin)
    return this.wallPlayed(stream)
  }

  setMuted(muted: boolean) {
    this.gain.gain.setTargetAtTime(muted ? 0 : 1, this.context.currentTime, 0.02)
  }

  private read(feed: AudioFeed, at: number, frames: number) {
    const doc = this.doc()
    if (!doc) return Promise.resolve(null)
    const samples = feed.kind === 'program' ? doc.invoke<Float32Array>('audio', at, frames) : doc.invoke<Float32Array>('itemAudio', feed.item, at, frames)
    return samples.catch(() => null)
  }

  /** Schedules a chunk on the audio clock; the part already past is dropped, so the sound never drifts. */
  private schedule(stream: Stream, { at, frames, rate, samples }: Chunk) {
    if (stream.audioOrigin == null) return
    const when = stream.audioOrigin + (at - stream.from)
    const late = Math.max(0, this.context.currentTime - when)
    if (late >= CHUNK_SECONDS) return
    const skip = Math.min(frames, Math.round(late * rate))
    const heard = samples.subarray(skip * 2)
    const buffer = this.context.createBuffer(2, frames - skip, rate)
    const left = buffer.getChannelData(0)
    const right = buffer.getChannelData(1)
    for (let index = 0; index < frames - skip; index += 1) {
      left[index] = heard[index * 2] ?? 0
      right[index] = heard[index * 2 + 1] ?? 0
    }
    const node = this.context.createBufferSource()
    node.buffer = buffer
    node.connect(this.gain)
    node.start(when + late)
    stream.nodes.add(node)
    node.onended = () => stream.nodes.delete(node)
    this.onChunk?.(heard, when + late, rate, stream.feed.kind)
  }

  /** Keeps about a second of sound mixed ahead of the clock. */
  private async pump(stream: Stream) {
    if (stream.pumping || stream.stopped || stream.stalled) return
    stream.pumping = true
    try {
      this.sampleRate ??= this.doc()?.invoke<number>('audioRate').catch(() => 48_000) ?? Promise.resolve(48_000)
      const rate = await this.sampleRate
      while (!stream.stopped && !stream.stalled && stream.next < stream.from + (this.elapsed() ?? 0) + LOOKAHEAD_SECONDS) {
        const frames = Math.round(CHUNK_SECONDS * rate)
        const at = stream.next
        stream.next += CHUNK_SECONDS
        const samples = await this.read(stream.feed, at, frames)
        if (!samples || stream.stopped || stream.stalled) continue
        this.check()
        // Until the audio clock leads, the chunk waits rather than being lost.
        if (stream.audioOrigin == null) stream.waiting.push({ at, frames, rate, samples })
        else this.schedule(stream, { at, frames, rate, samples })
      }
    } finally {
      stream.pumping = false
    }
    if (!stream.stopped && !stream.stalled) stream.timer = setTimeout(() => void this.pump(stream), (CHUNK_SECONDS * 1000) / 2)
  }

  private silence(stream: Stream) {
    if (stream.timer != null) clearTimeout(stream.timer)
    stream.timer = null
    stream.waiting = []
    for (const node of stream.nodes) {
      try {
        node.stop()
      } catch {
        // Not started yet.
      }
      node.disconnect()
    }
    stream.nodes.clear()
    this.onSilence?.()
  }

  /** Stops the current play's sound at once; the context is suspended until the next play, unless one starts at once (a shuttle press). */
  stop() {
    const stream = this.stream
    if (!stream) return
    this.stream = null
    stream.stopped = true
    this.silence(stream)
    if (this.suspending != null) clearTimeout(this.suspending)
    this.suspending = setTimeout(() => {
      this.suspending = null
      if (!this.stream && this.context.state === 'running') void this.context.suspend().catch(() => undefined)
    }, 0)
  }

  close() {
    this.stop()
    if (this.suspending != null) clearTimeout(this.suspending)
    void this.context.close().catch(() => undefined)
  }
}
