// Imports carry `.ts` so `node --test` loads this module as it is; React is imported only by the hook.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { TICKS_PER_SECOND } from '../film.ts'
import { targetsSource } from './target.ts'

type Params = Record<string, unknown>

/** What the program clock reads from the editor's inspect model, in seconds. */
export type ProgramView = {
  playhead: number
  duration: number
  in: number | null
  out: number | null
  /** One frame of the sequence. */
  frame: number
  /** The Source monitor's item, which source playback follows. */
  sourceItem: number | null
}

/** Whose sound a stream plays: the sequence mix (`audio`) or a project item's own (`itemAudio`). */
export type AudioFeed = { kind: 'program' } | { kind: 'source'; item: number }

/** The sound output the clocks lead with (`FilmAudioPlayer`). */
export type AudioOutput = {
  /** Lets the output start sound; called inside each play gesture, where WebKit allows it. */
  resume: () => void
  /** Plays `feed` from `from` seconds of its own time. */
  start: (feed: AudioFeed, from: number) => void
  /** Seconds heard since the last `start`: the audio clock once it runs, wall time until then; null without a stream. */
  elapsed: () => number | null
  stop: () => void
  setMuted?: (muted: boolean) => void
  close?: () => void
}

export type PlaybackDeps = {
  /** Wall time in milliseconds (`performance.now`). */
  now: () => number
  /** Runs `callback` at the next animation frame; answers a cancel. */
  frame: (callback: () => void) => () => void
  /** Whether the page is hidden (`document.hidden`): frames passed then are not dropped ones. */
  hidden?: () => boolean
  program: () => ProgramView | null
  /** Stable document/project/Source token; callers without one fall back to the source item ID. */
  sourceContext?: () => unknown
  /** A read-only engine query, answered as parsed JSON. */
  query: (id: string, params?: Params) => Promise<unknown>
  /**
   * An engine command (`playhead.set`, `source.setPlayhead`) and what the editor refreshes after it
   * (kit-editor's `KitRefresh`): the program playhead repaints the program monitor only while playing,
   * the source playhead refreshes nothing (the Source monitor follows the clock's own time), and a
   * stop refreshes everything once.
   */
  run: (id: string, params: Params, refresh: PlaybackRefresh) => Promise<unknown>
  /** Makes the sound output; called inside the first play gesture. */
  audio?: () => AudioOutput
  /** A failure while playing (the status bar, as upstream's `app.ui.status`). */
  onError?: (message: string) => void
}

export type PlaybackRefresh = 'all' | 'repaint' | 'none'

/** What `source.inspect` answers, in ticks. */
type SourceInspect = { item?: number | null; start?: number; end?: number; fps?: number; playhead?: number; markIn?: number | null; markOut?: number | null }

export type ProgramState = { playing: boolean; speed: number; looping: boolean }
export type SourceState = { playing: boolean; looping: boolean; item: number | null }
export type PlaybackState = { program: ProgramState; source: SourceState; muted: boolean }

/** Upstream's message for the shuttle speeds Source playback has no clock for (`menus.rs` `invoke`). */
const SOURCE_FORWARD_ONLY = 'Source playback currently supports normal forward speed'
/** Upstream's `menus.rs` `playback.forward`/`reverse`: J and L double up to 8×. */
const MAX_SHUTTLE = 8

/**
 * Sends only the latest value, one request in flight: a value asked for while one is in flight
 * replaces any other waiting, so a slow engine drops frames by the clock rather than queueing them.
 */
function latestOnly<T>(send: (value: T) => Promise<unknown>, onError: (error: unknown) => void, onReplace?: () => void) {
  let wanted: { value: T } | null = null
  let latest: { value: T } | null = null
  let running: Promise<void> | null = null
  const pump = async () => {
    while (wanted) {
      const request = wanted
      const { value } = request
      wanted = null
      try {
        await send(value)
      } catch (error) {
        onError(error)
      } finally {
        if (latest === request) latest = null
      }
    }
  }
  const ask = (value: T) => {
    // A value still waiting is never sent: the clock dropped it.
    if (wanted) onReplace?.()
    wanted = latest = { value }
    running ??= pump().finally(() => {
      running = null
    })
  }
  /** Resolves once nothing is in flight or waiting. */
  ask.idle = async () => {
    while (running) await running
  }
  /** Latest requested value until its send completes; older acknowledgements cannot clear it. */
  ask.pending = () => latest?.value
  return ask
}

/** Upstream's `SourceView::selected_range`: In to one frame past Out, inside the clip, in ticks. */
function selectedRange(view: Required<Pick<SourceInspect, 'start' | 'end'>> & SourceInspect, frame: number) {
  if (view.start < 0 || view.end <= view.start) return { start: view.start, end: view.start }
  const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))
  const start = clamp(view.markIn ?? view.start, view.start, view.end)
  const end = clamp(view.markOut != null ? view.markOut + frame : view.end, start, view.end)
  return { start, end }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The editor's two playback clocks, as upstream's `lib.rs` (`play`, `stop`, `advance_playback`),
 * `source_playback.rs`, and the playback arms of `menus.rs` `invoke` and `keyboard.rs`.
 *
 * - **Program** plays the sequence at the shuttle speed. At 1× the sound leads: the audio clock
 *   moves the playhead. Other speeds are silent on wall time, as upstream's `start_audio`.
 * - **Source** plays the Source monitor's item forward at 1× from the source playhead, with the
 *   item's own sound, moving `source.setPlayhead`.
 *
 * Starting either stops the other. Each moves its playhead at most once per animation frame, the
 * latest time only, with one request in flight.
 */
export function createPlayback(deps: PlaybackDeps) {
  let program: ProgramState = { playing: false, speed: 1, looping: false }
  let source: SourceState = { playing: false, looping: false, item: null }
  let muted = false
  let snapshot: PlaybackState = { program, source, muted }
  const listeners = new Set<() => void>()
  const programListeners = new Set<() => void>()
  const sourceListeners = new Set<() => void>()
  /** Told when a reader other than the clock reports a dropped frame (`noteDropped`), which may run inside a program-time tell. */
  const droppedListeners = new Set<() => void>()
  const tell = (set: Set<() => void>) => {
    for (const listener of set) listener()
  }
  const changed = () => {
    snapshot = { program, source, muted }
    for (const listener of listeners) listener()
  }
  const fail = (error: unknown) => deps.onError?.(message(error))

  // ---- sound
  let output: AudioOutput | null = null
  let streaming = false
  const audioStart = (feed: AudioFeed, from: number) => {
    if (!output) return
    output.start(feed, from)
    streaming = true
  }
  const audioStop = () => {
    if (streaming) output?.stop()
    streaming = false
  }
  const elapsedSince = (wall: number) => (streaming ? output?.elapsed() : null) ?? Math.max(0, (deps.now() - wall) / 1000)

  // ---- the animation-frame loop both clocks share
  let cancelFrame: (() => void) | null = null
  const loop = () => {
    if (cancelFrame) return
    cancelFrame = deps.frame(() => {
      cancelFrame = null
      programTick()
      sourceTick()
      if (program.playing || source.playing) loop()
    })
  }
  const settleLoop = () => {
    if (program.playing || source.playing) return
    cancelFrame?.()
    cancelFrame = null
  }

  // ---- program clock
  /**
   * Upstream's `PlaybackMeter`, for the Program monitor's dropped-frame dot: the frames this play
   * dropped, those the clock passed over (a forward step of more than `step` frames, not a loop's
   * jump back) and those replaced before the engine took them. Frames a fast speed steps over on
   * purpose are not counted.
   */
  const meter = { dropped: 0, step: 1, frame: null as number | null, wall: null as number | null, resync: false }
  /** Longer than this between two clock frames, the page was not drawing (a hidden tab): the clock resyncs, nothing counted. */
  const RESYNC_MS = 250
  const sendProgram = latestOnly(
    ({ seconds, refresh }: { seconds: number; refresh: PlaybackRefresh }) => deps.run('playhead.set', { seconds }, refresh),
    fail,
    () => {
      if (program.playing) meter.dropped += 1
    },
  )
  let programRun: { time: number; wall: number } | null = null
  let programStopAt: number | null = null
  let programPosition = 0
  /** The frame the program playhead was last sent to: a clock tick inside the same frame sends nothing. */
  let programFrame: number | null = null
  /** Where a stop left the playhead, until the editor's inspect model shows it (see `programShown`). */
  let programRest: { at: number; stale: number | undefined } | null = null
  /**
   * Where a ruler or monitor scrub has the playhead (`showProgramScrub`), shown at once: the
   * engine's seeks and the pictures follow at their own pace, never holding the timecode back.
   */
  let programScrub: number | null = null
  let programGeneration = 0

  /**
   * Moves the program playhead to the frame `seconds` falls in, unless it is there already; while
   * playing it repaints the program monitor only. `refresh: 'all'` always sends.
   */
  const seekProgram = (seconds: number, refresh: PlaybackRefresh = 'repaint') => {
    const frame = deps.program()?.frame ?? 0
    const index = frame > 0 ? Math.floor(seconds / frame + 1e-6) : null
    const snapped = index != null && frame > 0 ? index * frame : seconds
    const moved = snapped !== programPosition
    programPosition = snapped
    if (refresh !== 'all' && index != null && index === programFrame) return
    programFrame = index
    if (program.playing && programRun && index != null) {
      // `PlaybackMeter::resync` after hidden time; else `refresh`: frames passed over count.
      const moved = meter.frame == null || meter.resync ? 0 : Math.trunc((index - meter.frame) / meter.step)
      if (moved > 1 && moved < 1000) meter.dropped += moved - 1
      meter.frame = index
      meter.resync = false
    }
    sendProgram({ seconds: snapped, refresh })
    if (moved) tell(programListeners)
  }

  const pref = async (key: string) => deps.query('prefs.get', { key }).catch(() => null)

  /** Upstream's `play(speed)`: stops the source clock, then plays from the playhead (`from`, when given). */
  function play(speed: number, options: { from?: number; stopAt?: number | null } = {}) {
    stopSource()
    const view = deps.program()
    if (!view) return
    const current = program.playing && programRun ? programPosition : restingProgram(view.playhead)
    programScrub = null
    program = { ...program, playing: true, speed }
    if (options.stopAt !== undefined) programStopAt = options.stopAt
    programRun = null
    const generation = ++programGeneration
    // `PlaybackMeter::start`: a play counts from 0, stepping by its speed.
    meter.dropped = 0
    meter.frame = null
    meter.wall = null
    meter.resync = false
    meter.step = Math.trunc(Math.max(1, Math.abs(speed))) * (speed < 0 ? -1 : 1)
    audioStop()
    changed()
    return (async () => {
      let from = options.from ?? current
      // Settings ▸ Timeline ▸ "At playback end, return to beginning when restarting playback".
      if (speed > 0 && from >= view.duration - view.frame && (await pref('timeline.returnToBeginning')) !== false) from = 0
      if (generation !== programGeneration) return
      programRun = { time: from, wall: deps.now() }
      programRest = null
      programFrame = null
      if (from !== current) seekProgram(from)
      else programPosition = from
      meter.frame = Math.floor(from / (view.frame || 1) + 1e-6)
      if (speed === 1) audioStart({ kind: 'program' }, from)
      loop()
    })()
  }

  function stopProgram() {
    programGeneration += 1
    programStopAt = null
    const ran = programRun != null
    programRun = null
    if (!program.playing) return
    program = { ...program, playing: false }
    audioStop()
    settleLoop()
    // One full refresh where the playhead stopped: the editor's model catches up with the clock.
    if (ran) {
      programRest = { at: programPosition, stale: deps.program()?.playhead }
      seekProgram(programPosition, 'all')
    }
    changed()
    tell(programListeners)
  }

  /** The program playhead the editor should show, given the one its inspect model has (`resting`). */
  function restingProgram(resting: number) {
    if (programScrub != null) return programScrub
    // Once the model moves from what it said at the stop (it caught up, or the playhead was moved since), it is the truth again.
    if (programRest != null && resting !== programRest.stale) programRest = null
    return programRest?.at ?? resting
  }

  function programTick() {
    if (!program.playing || !programRun) return
    const wall = deps.now()
    if (meter.wall != null && (wall - meter.wall > RESYNC_MS || deps.hidden?.() === true)) meter.resync = true
    meter.wall = wall
    const view = deps.program()
    if (!view) return stopProgram()
    const { speed, looping } = program
    const time = programRun.time + elapsedSince(programRun.wall) * speed
    const [lo, hi] = looping ? [view.in ?? 0, view.out != null ? view.out + view.frame : view.duration] : [0, view.duration]
    if (programStopAt != null && time >= programStopAt && speed > 0 && !looping) {
      seekProgram(programStopAt)
      stopProgram()
    } else if (time >= hi && speed > 0) {
      if (looping) {
        // A loop restart: the clock and the sound start again at In.
        seekProgram(lo)
        programRun = { time: lo, wall: deps.now() }
        audioStop()
        if (speed === 1) audioStart({ kind: 'program' }, lo)
      } else {
        seekProgram(Math.max(0, hi - view.frame))
        stopProgram()
      }
    } else if (time <= 0 && speed < 0) {
      seekProgram(0)
      stopProgram()
    } else {
      seekProgram(time)
    }
  }

  /** Upstream's `keyboard.rs` `play_range`: to Out from the playhead, or In to Out with preroll and postroll. */
  async function playRange(preroll: boolean) {
    const view = deps.program()
    if (!view) throw new Error('no sequence is open')
    const end = view.out != null ? view.out + view.frame : view.duration
    let start = view.playhead
    let stop = end
    if (preroll) {
      const before = Number((await pref('playback.prerollSeconds')) ?? 0)
      const after = Number((await pref('playback.postrollSeconds')) ?? 0)
      start = Math.max(0, (view.in ?? 0) - before)
      stop = end + after
    }
    await play(1, { from: start, stopAt: stop })
    return { from: start, to: stop }
  }

  // ---- source clock
  // The engine reads `time` as whole ticks: a fraction would be no time at all, and play from 0.
  const sourceContext = () => deps.sourceContext ? deps.sourceContext() : deps.program()?.sourceItem
  const makeSourceQueue = (context: unknown) => ({
    context,
    send: latestOnly(async (time: number) => {
      // A detached old queue may finish, but can never send its waiting position to a new source.
      if (context !== sourceContext()) return
      return deps.run('source.setPlayhead', { time: Math.round(time) }, 'none')
    }, fail),
  })
  let sourceQueue: ReturnType<typeof makeSourceQueue> | null = null
  const sourceSeeks = () => {
    const context = sourceContext()
    // A new source must not wait for the previous source's outstanding acknowledgement.
    if (!sourceQueue || sourceQueue.context !== context) sourceQueue = makeSourceQueue(context)
    return sourceQueue.send
  }
  let sourceRun: {
    context: unknown
    time: number
    wall: number
    start: number
    end: number
    frame: number
    range: { start: number; end: number }
    stopAt: number | null
    rangeStart: number | null
  } | null = null
  /** The source playhead the Source monitor shows: the clock's while playing, the engine's otherwise (`readSource`); null before either. */
  let sourceTime: number | null = null
  let sourceGeneration = 0
  /** A newer navigation or scrub supersedes a navigation whose inspect read is still pending. */
  let sourceNavigation = 0

  /** The clip frame the source playhead was last sent to: a clock tick inside the same frame sends nothing. */
  let sourceFrame: number | null = null
  /** Moves the source playhead to the clip frame `time` falls in, unless it is there already. */
  const seekSource = (time: number, frame = sourceRun?.frame ?? 0) => {
    const index = frame > 0 ? Math.floor(time / frame + 1e-6) : null
    if (index != null && index === sourceFrame) return
    sourceFrame = index
    sourceTime = index != null ? index * frame : time
    sourceSeeks()(sourceTime)
    tell(sourceListeners)
  }
  const showSource = (time: number | null) => {
    if (time === sourceTime) return
    sourceTime = time
    tell(sourceListeners)
  }
  let sourceReads = 0
  /**
   * Reads the source playhead from the engine (`source.inspect`, a light read) once the clock's
   * last move has landed: after a stop, and after any other source command. Not while playing.
   */
  async function readSource(): Promise<SourceInspect | null | undefined> {
    const asked = ++sourceReads
    await sourceSeeks().idle()
    if (source.playing) return undefined
    const view = (await deps.query('source.inspect').catch(() => null)) as SourceInspect | null
    if (asked !== sourceReads || source.playing) return view
    showSource(view?.item != null ? (view.playhead ?? 0) : null)
    // The view read, for a reader that wants the rest of it (the Source monitor's marks and size).
    return view
  }

  /** One play intent owns all its reads, including range and roll preferences. */
  function beginSource() {
    stopProgram()
    stopSource()
    const intent = { generation: ++sourceGeneration, context: sourceContext() }
    source = { ...source, playing: true }
    changed()
    return intent
  }
  const sourceCurrent = (intent: ReturnType<typeof beginSource>) => {
    if (intent.generation !== sourceGeneration) return false
    if (intent.context !== sourceContext()) {
      stopSource()
      return false
    }
    return true
  }

  /** Upstream's `start_source_playback`: from the source playhead (or `start`), to the clip's end (or `stop`). */
  function playSource(start: number | null = null, stop: number | null = null, intent = beginSource()) {
    return (async () => {
      try {
        // A just-finished scrub owns the position from which Play must start. Range playback
        // also waits so an older queued scrub cannot overwrite its explicit starting position.
        await sourceSeeks().idle()
        if (!sourceCurrent(intent)) return null
        const view = (await deps.query('source.inspect')) as SourceInspect | null
        if (!sourceCurrent(intent)) return null
        if (view?.item == null) throw new Error('Open a media file in the Source monitor first')
        const clip = { ...view, start: view.start ?? 0, end: view.end ?? 0 }
        if (clip.end <= clip.start) throw new Error('Source clip has no playable duration')
        const frame = TICKS_PER_SECOND / (view.fps && view.fps > 0 ? view.fps : 30)
        const range = selectedRange(clip, frame)
        const { looping } = source
        if (looping && range.end <= range.start) throw new Error('Source marked range is empty')
        const first = looping ? range.start : clip.start
        const end = stop ?? (looping ? range.end : clip.end)
        let time = start ?? view.playhead ?? first
        if (start == null && (time < first || time >= Math.max(Math.round((end - frame) / frame) * frame, first))) time = first
        if (!sourceCurrent(intent)) return null
        const raw = await deps.run('source.setPlayhead', { time: Math.round(time) }, 'none')
        // The session answers the engine's JSON text; the fake engine answers objects.
        const answer = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { time?: number } | null
        if (!sourceCurrent(intent)) return null
        time = answer?.time ?? time
        sourceTime = time
        sourceFrame = Math.floor(time / frame + 1e-6)
        source = { ...source, playing: true, item: view.item }
        sourceRun = { context: intent.context, time, wall: deps.now(), start: clip.start, end: clip.end, frame, range, stopAt: stop, rangeStart: start }
        audioStart({ kind: 'source', item: view.item }, time / TICKS_PER_SECOND)
        changed()
        loop()
        return { playing: true }
      } catch (error) {
        if (!sourceCurrent(intent)) return null
        stopSource()
        throw error
      }
    })()
  }

  /** Upstream's `play_source_range`: In to Out, from the playhead to Out, or with preroll and postroll. */
  async function playSourceRange(fromPlayhead: boolean, preroll: boolean) {
    const intent = beginSource()
    try {
      await sourceSeeks().idle()
      if (!sourceCurrent(intent)) return null
      const view = (await deps.query('source.inspect')) as SourceInspect | null
      if (!sourceCurrent(intent)) return null
      if (view?.item == null) throw new Error('Open a Source clip first')
      const clip = { ...view, start: view.start ?? 0, end: view.end ?? 0 }
      const frame = TICKS_PER_SECOND / (view.fps && view.fps > 0 ? view.fps : 30)
      const range = selectedRange(clip, frame)
      if (range.end <= range.start) throw new Error('Source marked range is empty')
      const roll = async (key: string) => {
        const seconds = Number((await pref(key)) ?? 0)
        return Math.round((Number.isFinite(seconds) ? Math.min(3600, Math.max(0, seconds)) : 0) * TICKS_PER_SECOND)
      }
      const start = fromPlayhead ? (view.playhead ?? clip.start) : preroll ? Math.max(clip.start, range.start - (await roll('playback.prerollSeconds'))) : range.start
      if (!sourceCurrent(intent)) return null
      const stop = preroll ? Math.min(clip.end, range.end + (await roll('playback.postrollSeconds'))) : range.end
      if (!sourceCurrent(intent)) return null
      if (start >= stop) throw new Error('Source playhead is at or beyond the Out point')
      return playSource(start, stop, intent)
    } catch (error) {
      if (!sourceCurrent(intent)) return null
      stopSource()
      throw error
    }
  }

  function stopSource() {
    sourceGeneration += 1
    sourceRun = null
    if (!source.playing) return
    source = { ...source, playing: false }
    audioStop()
    settleLoop()
    changed()
    void readSource()
  }

  /**
   * Moves the source playhead to `ticks` (a scrub, a transport step, Go to In or Out). While the
   * source clock plays it carries on from there, as upstream's `advance_source_playback`
   * re-anchors when the playhead moved: the clock and the sound start again at the new place.
   * Stopped, it only moves the playhead.
   */
  function moveSource(ticks: number) {
    sourceNavigation += 1
    const clip = sourceRun
    if (!source.playing || !clip) {
      sourceFrame = null
      sourceSeeks()(ticks)
      void readSource()
      return
    }
    const time = Math.min(Math.max(ticks, clip.start), Math.max(clip.end - clip.frame, clip.start))
    sourceRun = { ...clip, time, wall: deps.now() }
    sourceFrame = null
    seekSource(time)
    audioStop()
    if (source.item != null) audioStart({ kind: 'source', item: source.item }, time / TICKS_PER_SECOND)
  }

  /** Go In/Out shares the transport buttons' queue and running-clock re-anchor. */
  async function navigateSource(id: string) {
    const context = sourceContext()
    const navigation = ++sourceNavigation
    const view = (await deps.query('source.inspect')) as SourceInspect | null
    if (context !== sourceContext() || navigation !== sourceNavigation) return null
    if (view?.item == null) throw new Error('Open a media file in the Source monitor first')
    const start = view.start ?? 0
    const frame = TICKS_PER_SECOND / (view.fps && view.fps > 0 ? view.fps : 30)
    const time = id === 'markers.goToIn' ? view.markIn ?? start : view.markOut ?? Math.max(start, (view.end ?? start) - frame)
    moveSource(time)
    return null
  }

  function sourceTick() {
    if (!source.playing || !sourceRun) return
    // Another clip in the Source monitor (or none) stops it, as upstream's `advance_source_playback`.
    if (deps.program()?.sourceItem !== source.item || sourceRun.context !== sourceContext()) return stopSource()
    const clip = sourceRun
    const next = clip.time + elapsedSince(clip.wall) * TICKS_PER_SECOND
    const end = Math.min(clip.stopAt ?? (source.looping ? clip.range.end : clip.end), clip.end)
    const ended = next >= end
    if (ended && source.looping) {
      const start = Math.max(clip.rangeStart ?? clip.range.start, clip.start)
      seekSource(start)
      sourceRun = { ...clip, time: start, wall: deps.now() }
      audioStop()
      if (source.item != null) audioStart({ kind: 'source', item: source.item }, start / TICKS_PER_SECOND)
      return
    }
    seekSource(ended ? Math.max(end - clip.frame, clip.start) : Math.max(next, clip.start))
    if (ended) stopSource()
  }

  // ---- commands
  /** Runs a playback command, as upstream's `invoke` arms do; Source-targeted when `focused` or `params.monitor` says so. */
  function run(id: string, params: Params, focused: string): unknown {
    const toSource = targetsSource(focused, params)
    switch (id) {
      case 'markers.goToIn':
      case 'markers.goToOut':
        return navigateSource(id)
      case 'source.playback.toggle':
        return source.playing ? (stopSource(), { playing: false }) : playSource()
      case 'source.playback.play':
        return playSource()
      case 'source.playback.stop':
        stopSource()
        return null
      case 'playback.toggle':
        if (toSource) return source.playing ? (stopSource(), { playing: false }) : playSource()
        if (program.playing) stopProgram()
        else void play(1)
        return { playing: program.playing }
      case 'playback.forward':
        if (toSource) return playSource().then((answer) => answer && { playing: true, speed: 1 })
        void play(program.playing && program.speed > 0 ? Math.min(program.speed * 2, MAX_SHUTTLE) : 1)
        return { speed: program.speed }
      case 'playback.reverse':
        if (toSource) throw new Error(`${SOURCE_FORWARD_ONLY}; use Play/Space or frame stepping`)
        void play(program.playing && program.speed < 0 ? Math.max(program.speed * 2, -MAX_SHUTTLE) : -1)
        return { speed: program.speed }
      case 'playback.slowForward':
      case 'playback.slowReverse':
        if (toSource) throw new Error(SOURCE_FORWARD_ONLY)
        void play(id === 'playback.slowForward' ? 0.25 : -0.25)
        return { speed: program.speed }
      case 'playback.stop':
        if (toSource) stopSource()
        else stopProgram()
        return null
      case 'playback.inToOut': {
        if (toSource) return playSourceRange(false, false).then(() => null)
        const view = deps.program()
        return Promise.resolve(play(1, { from: view?.in ?? view?.playhead, stopAt: view?.out != null ? view.out + view.frame : null })).then(() => null)
      }
      case 'playback.loop':
        if (toSource) {
          source = { ...source, looping: !source.looping }
          changed()
          return { loop: source.looping }
        }
        program = { ...program, looping: !program.looping }
        changed()
        return { loop: program.looping }
      case 'playback.toOut':
        return toSource ? playSourceRange(true, false).then(() => null) : playRange(false)
      case 'playback.inToOutPreroll':
        return toSource ? playSourceRange(false, true).then(() => null) : playRange(true)
      default:
        throw new Error(`unknown playback command \`${id}\``)
    }
  }

  /** The commands this controller runs. Play Around belongs to dynamic trimming, which the editor does not have yet. */
  const serves = (id: string) => id !== 'playback.playAround'

  return {
    /**
     * Runs `id` (`playback.*`, `source.playback.*`). The sound output is made and resumed first,
     * synchronously, so a click or key press that calls this starts sound in WebKit.
     */
    invoke(id: string, params: Params, focused: string): unknown {
      if (deps.audio && serves(id)) {
        output ??= deps.audio()
        output.setMuted?.(muted)
        output.resume()
      }
      return run(id, params, focused)
    },
    serves,
    stopProgram,
    stopSource,
    moveSource,
    /** Moves the program playhead (latest only, one in flight); used by the clock and by tests. */
    seekProgram,
    readSource,
    /** Waits for current Source seeks; a replacement context has its own independent queue. */
    settleSource: () => sourceSeeks().idle(),
    /** Capture the intended frame at a mark gesture; idle Sources use the engine's cursor. */
    sourceMarkTime: () => source.playing && sourceRun?.context === sourceContext()
      ? sourceTime ?? undefined
      : sourceQueue?.context === sourceContext() ? sourceQueue?.send.pending() : undefined,
    setMuted(next: boolean) {
      muted = next
      output?.setMuted?.(next)
      changed()
    },
    state: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    /** The source playhead the Source monitor shows, in ticks (see `readSource`); null before the first. */
    sourceTime: () => sourceTime,
    subscribeSourceTime(listener: () => void) {
      sourceListeners.add(listener)
      return () => void sourceListeners.delete(listener)
    },
    /** The program playhead while the clock plays (null otherwise): the transport and timeline follow it without a document refresh. */
    programTime: () => (program.playing && programRun ? programPosition : null),
    /** The program playhead a scrub shows (`showProgramScrub`), null when none is in progress. */
    programScrub: () => programScrub,
    /** The program playhead to show ahead of the inspect model: the playing clock's, else a scrub's; null for neither. */
    programShown: () => (program.playing && programRun ? programPosition : programScrub),
    /**
     * Shows `seconds` (snapped to its frame) as the program playhead while a scrub moves it, ahead
     * of the engine; null ends the scrub, keeping its last position until the inspect model shows it.
     */
    showProgramScrub(seconds: number | null) {
      if (seconds == null) {
        if (programScrub == null) return
        programRest = { at: programScrub, stale: deps.program()?.playhead }
        programScrub = null
      } else {
        const frame = deps.program()?.frame ?? 0
        const snapped = frame > 0 ? Math.floor(Math.max(0, seconds) / frame + 1e-6) * frame : Math.max(0, seconds)
        if (snapped === programScrub) return
        programScrub = snapped
      }
      tell(programListeners)
    },
    /** Frames this play of the program dropped (upstream's `meter.counts().1`); its listeners are the program time's. */
    programDropped: () => meter.dropped,
    /** A frame of the playing program another reader of it skipped (the Program monitor's channel picture): counted, and told. */
    noteDropped() {
      if (!program.playing || !programRun) return
      meter.dropped += 1
      tell(droppedListeners)
    },
    /** Hears `noteDropped`; the clock's own drops are told with the program time (`subscribeProgramTime`). */
    subscribeDropped(listener: () => void) {
      droppedListeners.add(listener)
      return () => void droppedListeners.delete(listener)
    },
    subscribeProgramTime(listener: () => void) {
      programListeners.add(listener)
      return () => void programListeners.delete(listener)
    },
    restingProgram,
    dispose() {
      stopProgram()
      stopSource()
      cancelFrame?.()
      cancelFrame = null
      output?.close?.()
      output = null
    },
  }
}

export type Playback = ReturnType<typeof createPlayback>

/**
 * The editor's playback controller (`createPlayback`) on the browser's clock and animation frames,
 * kept for the editor's life. `program` is read at each frame, so it sees the latest inspect model.
 */
export function usePlayback(deps: Omit<PlaybackDeps, 'now' | 'frame'>) {
  const latest = useRef(deps)
  latest.current = deps
  const playback = useMemo(
    () =>
      createPlayback({
        now: () => performance.now(),
        frame: (callback) => {
          const id = requestAnimationFrame(callback)
          return () => cancelAnimationFrame(id)
        },
        hidden: () => document.hidden,
        program: () => latest.current.program(),
        sourceContext: deps.sourceContext ? () => latest.current.sourceContext!() : undefined,
        query: (id, params) => latest.current.query(id, params),
        run: (id, params, refresh) => latest.current.run(id, params, refresh),
        audio: deps.audio ? () => latest.current.audio!() : undefined,
        onError: (text) => latest.current.onError?.(text),
      }),
    // One controller for the editor's life; its dependencies are read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  useEffect(() => () => playback.dispose(), [playback])
  const state = useSyncExternalStore(playback.subscribe, playback.state)
  return { playback, state }
}

/** The source playhead the Source monitor shows, in ticks, or `resting` before any; re-renders only its caller. */
export function useSourceTime(playback: Playback, resting: number) {
  return useSyncExternalStore(playback.subscribeSourceTime, playback.sourceTime) ?? resting
}

/**
 * The program playhead in seconds: the clock's while it plays, a scrub's while one moves it, else
 * the inspect model's (`resting`), which a stop catches up with. Re-renders only its caller, every
 * frame while playing.
 */
export function useProgramTime(playback: Playback, resting: number) {
  const shown = useSyncExternalStore(playback.subscribeProgramTime, playback.programShown)
  return shown ?? playback.restingProgram(resting)
}
