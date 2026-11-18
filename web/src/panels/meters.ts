/**
 * The Audio Meters' levels (upstream `panels/meters.rs` and `mixer.rs` `poll_meters`), pure so
 * `node --test` runs them.
 *
 * Upstream's mixer posts the peak of every block it plays, and the meters take what was posted
 * since the last frame. Here the sound is mixed in half-second chunks scheduled ahead of the audio
 * clock, so `createMeterFeed` keeps each chunk's peaks per 1/30 s window on the audio clock and
 * hands a window over only once the clock reaches it: the meters show what is heard, not what is
 * mixed ahead.
 *
 * `stepMeters` is upstream's ballistics: an instant attack, the level falling 20 dB/s and its
 * peak-hold line 6 dB/s, a frame's step capped at 0.1 s, and nothing below −90 dB.
 */

/** The length of one peak window on the audio clock, in seconds. */
export const METER_WINDOW = 1 / 30
/** Upstream's silence: levels never fall below this (`poll_meters`). */
export const METER_FLOOR_DB = -90
/** Upstream's release of the level and of the peak-hold line, in dB per second. */
export const LEVEL_FALL_DB = 20
export const HOLD_FALL_DB = 6
/** Upstream's frame step is `stable_dt.min(0.1)`. */
export const MAX_STEP_SECONDS = 0.1
/** The scale's foot (upstream draws 0 … −60 dB): a meter below it on both counts shows nothing more to fall. */
export const METER_SCALE_DB = -60

/** Per channel, in dB: the level and its peak-hold line. */
export type MeterLevels = { level: readonly number[]; hold: readonly number[] }

export const silentMeters = (channels = 2): MeterLevels => ({ level: Array(channels).fill(METER_FLOOR_DB), hold: Array(channels).fill(METER_FLOOR_DB) })

/** A linear amplitude in dB, as upstream reads it (`20 log10(max(x, 1e-6))`). */
export const linearToDb = (linear: number) => 20 * Math.log10(Math.max(linear, 1e-6))
export const dbToLinear = (db: number) => (db <= METER_FLOOR_DB ? 0 : 10 ** (db / 20))

/**
 * Upstream's step over `seconds` (capped at 0.1 s): both fall, then the new peaks (linear, per
 * channel, or null when nothing was heard) push them up at once.
 */
export function stepMeters(previous: MeterLevels, seconds: number, fresh: readonly number[] | null): MeterLevels {
  const dt = Math.min(Math.max(0, seconds), MAX_STEP_SECONDS)
  const channels = Math.max(previous.level.length, fresh?.length ?? 0)
  const level: number[] = []
  const hold: number[] = []
  for (let channel = 0; channel < channels; channel += 1) {
    let l = Math.max((previous.level[channel] ?? METER_FLOOR_DB) - LEVEL_FALL_DB * dt, METER_FLOOR_DB)
    let h = Math.max((previous.hold[channel] ?? METER_FLOOR_DB) - HOLD_FALL_DB * dt, METER_FLOOR_DB)
    const peak = fresh?.[channel]
    if (peak != null) {
      const db = linearToDb(peak)
      l = Math.max(l, db)
      h = Math.max(h, db)
    }
    level.push(l)
    hold.push(h)
  }
  return { level, hold }
}

/** Whether the meters show nothing more to fall: every level and line under the scale's foot. */
export function metersAtRest(levels: MeterLevels) {
  return levels.level.every((db) => db <= METER_SCALE_DB) && levels.hold.every((db) => db <= METER_SCALE_DB)
}

/** How long a window the clock has passed is kept for a meter that has not taken it (a hidden page draws no frames). */
export const STALE_SECONDS = 1

/**
 * The peaks of the sound as it is scheduled, per window of `window` seconds on the audio clock
 * (window `k` covers `[k·window, (k+1)·window)`). It does nothing while no meter listens, and
 * drops the windows the clock passed more than `STALE_SECONDS` ago.
 */
export function createMeterFeed(window = METER_WINDOW) {
  const windows = new Map<number, [number, number]>()
  let listeners = 0
  let clock: (() => number) | null = null
  return {
    /** The audio clock the windows are on (the sound output's), set once the output is made. */
    setClock(next: (() => number) | null) {
      clock = next
    },
    /** The audio clock now, or null before there is a sound output. */
    now(): number | null {
      return clock ? clock() : null
    },
    get listening() {
      return listeners > 0
    },
    /** A meter starts listening; the answer stops it (once). The last one to stop empties the feed. */
    listen(): () => void {
      listeners += 1
      let done = false
      return () => {
        if (done) return
        done = true
        listeners -= 1
        if (listeners === 0) windows.clear()
      }
    },
    /** Interleaved stereo `samples` at `rate`, heard from `when` on the audio clock. */
    push(samples: Float32Array, when: number, rate: number) {
      if (listeners === 0 || !(rate > 0)) return
      const now = clock ? clock() : null
      if (now != null) for (const index of windows.keys()) if ((index + 1) * window < now - STALE_SECONDS) windows.delete(index)
      const frames = Math.floor(samples.length / 2)
      let frame = 0
      while (frame < frames) {
        const index = Math.floor((when + frame / rate) / window + 1e-9)
        // The first frame of the next window, so each window's frames are read in one run.
        const end = Math.min(frames, Math.max(frame + 1, Math.ceil(((index + 1) * window - when) * rate - 1e-9)))
        const peaks = windows.get(index) ?? [0, 0]
        for (let at = frame; at < end; at += 1) {
          const left = Math.abs(samples[at * 2])
          const right = Math.abs(samples[at * 2 + 1])
          if (left > peaks[0]) peaks[0] = left
          if (right > peaks[1]) peaks[1] = right
        }
        windows.set(index, peaks)
        frame = end
      }
    },
    /** The peaks of every window the clock has reached by `now` that were not taken yet, or null. */
    take(now: number): [number, number] | null {
      let taken: [number, number] | null = null
      for (const [index, peaks] of windows) {
        if (index * window > now + 1e-9) continue
        taken = taken ? [Math.max(taken[0], peaks[0]), Math.max(taken[1], peaks[1])] : [peaks[0], peaks[1]]
        windows.delete(index)
      }
      return taken
    },
    /** Forgets what was scheduled (a stop, or a new play): it will not be heard. */
    clear() {
      windows.clear()
    },
    /** The windows waiting for the clock (the tests read it). */
    get pending() {
      return windows.size
    },
  }
}

export type MeterFeed = ReturnType<typeof createMeterFeed>
