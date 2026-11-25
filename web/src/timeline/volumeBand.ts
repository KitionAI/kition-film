/**
 * The Volume line on audio clips (upstream `panels/timeline_volume.rs`): the clip's Volume level
 * over time, with its keyframes, on the faders' scale (`panels/mixer.rs` `db_to_pos`). It runs
 * under the clip's name band down to 3 points above its bottom edge. Pure, so `node --test` runs it.
 * Times are seconds on the timeline; y is points from the clip body's top.
 */

/** The faders' range (upstream `mixer::FADER_MIN_DB`, `FADER_MAX_DB`). */
export const FADER_MIN_DB = -96
export const FADER_MAX_DB = 15

/** Upstream's fader taper: (dB, position 0 bottom … 1 top). */
const TAPER: ReadonlyArray<readonly [number, number]> = [
  [-96, 0],
  [-60, 0.05],
  [-40, 0.14],
  [-30, 0.24],
  [-20, 0.38],
  [-12, 0.52],
  [-6, 0.64],
  [0, 0.76],
  [6, 0.88],
  [15, 1],
]

/** The name band the line runs under (`draw_clip`'s 17 points), and its margin above the bottom. */
const BAND_TOP = 17
const BAND_BOTTOM = 3
/** How near the line a press takes it (upstream `on_line`: 4 points). */
export const LINE_HIT = 4
/** How near a keyframe's centre a press takes the keyframe (upstream: an 11-point square). */
export const KEY_HIT = 5.5

/** `db_to_pos`: a fader position (0 bottom … 1 top) of a level in dB. */
export function dbToPos(db: number) {
  if (!Number.isFinite(db) || db <= TAPER[0][0]) return 0
  for (let index = 1; index < TAPER.length; index += 1) {
    const [d0, p0] = TAPER[index - 1]
    const [d1, p1] = TAPER[index]
    if (db <= d1) return p0 + (p1 - p0) * ((db - d0) / (d1 - d0))
  }
  return 1
}

/** `pos_to_db`: the level of a fader position, −96 dB (silence) within half a dB of the bottom. */
export function posToDb(pos: number) {
  const p = Number.isFinite(pos) ? Math.min(1, Math.max(0, pos)) : 0
  for (let index = 1; index < TAPER.length; index += 1) {
    const [d0, p0] = TAPER[index - 1]
    const [d1, p1] = TAPER[index]
    if (p <= p1) {
      const db = d0 + (d1 - d0) * ((p - p0) / (p1 - p0))
      return db <= FADER_MIN_DB + 0.5 ? FADER_MIN_DB : db
    }
  }
  return FADER_MAX_DB
}

/** The band of a clip body `height` points tall (`band`), or null when it is too short to draw (under 6 points). */
export function bandOf(height: number) {
  const top = BAND_TOP
  const bottom = height - BAND_BOTTOM
  return bottom - top >= 6 ? { top, bottom, height: bottom - top } : null
}

/** The y of a level in a band. */
export const yOfDb = (band: { bottom: number; height: number }, db: number) => band.bottom - dbToPos(db) * band.height

/** The level a band's y stands for. */
export const dbOfY = (band: { bottom: number; height: number }, y: number) => posToDb((band.bottom - y) / Math.max(1, band.height))

/** A keyframe of the Volume level: its time on the timeline (seconds), its media time (ticks, which names it to the engine) and level. */
export type VolumeKey = { time: number; mediaTime: number; value: number }

/**
 * The level at timeline time `t` (seconds): the keyframes' straight line between them (upstream
 * interpolates as each keyframe says; the line drawn here is linear), held before the first and
 * after the last, or the flat `level` without keyframes.
 */
export function levelAt(keys: readonly VolumeKey[], level: number, t: number) {
  if (!keys.length) return level
  if (t <= keys[0].time) return keys[0].value
  for (let index = 1; index < keys.length; index += 1) {
    const a = keys[index - 1]
    const b = keys[index]
    if (t <= b.time) return b.time > a.time ? a.value + (b.value - a.value) * ((t - a.time) / (b.time - a.time)) : b.value
  }
  return keys[keys.length - 1].value
}

/** The keyframes either side of time `t` (upstream `start`'s `keys`): a drag of the line there moves both. */
export function keysAround(keys: readonly VolumeKey[], t: number): number[] {
  const after = keys.findIndex((key) => key.time > t)
  if (after < 0) return keys.length ? [keys.length - 1] : []
  return after > 0 ? [after - 1, after] : [after]
}

/** Points along the line for a clip body `width` points wide showing `duration` seconds from `start`: two without keyframes, one at each keyframe otherwise. */
export function linePoints(keys: readonly VolumeKey[], level: number, start: number, duration: number, width: number, band: { bottom: number; height: number }) {
  const xOf = (t: number) => (duration > 0 ? ((t - start) / duration) * width : 0)
  const points: Array<[number, number]> = [[0, yOfDb(band, levelAt(keys, level, start))]]
  for (const key of keys) if (key.time > start && key.time < start + duration) points.push([xOf(key.time), yOfDb(band, key.value)])
  points.push([width, yOfDb(band, levelAt(keys, level, start + duration))])
  return points
}

/**
 * What a press at (`x`, `y`) in a clip body (`x` from its left, `y` from its top; `width` ×
 * `height`, showing `duration` seconds from `start`) takes of its Volume line: a keyframe (its
 * index), the line, or nothing.
 */
export function bandHit(keys: readonly VolumeKey[], level: number, start: number, duration: number, width: number, height: number, x: number, y: number): { kind: 'key'; index: number } | { kind: 'line' } | null {
  const band = bandOf(height)
  if (!band || !(width > 0) || !(duration > 0) || x < 0 || x > width) return null
  const xOf = (t: number) => ((t - start) / duration) * width
  let best = -1
  let nearest = KEY_HIT
  for (let index = 0; index < keys.length; index += 1) {
    const dist = Math.hypot(xOf(keys[index].time) - x, yOfDb(band, keys[index].value) - y)
    if (dist <= nearest) {
      best = index
      nearest = dist
    }
  }
  if (best >= 0) return { kind: 'key', index: best }
  const t = start + (x / width) * duration
  return Math.abs(yOfDb(band, levelAt(keys, level, t)) - y) <= LINE_HIT ? { kind: 'line' } : null
}

/** The level a drag of the line pressed at `y0` where it stood at `from` dB reaches at `y` (upstream `drag`): by fader position, so it moves as a fader does. */
export function draggedDb(band: { height: number }, from: number, y0: number, y: number) {
  return posToDb(dbToPos(from) + (y0 - y) / Math.max(1, band.height))
}

/** A keyframe moved in time: on a frame, at least a frame from its neighbours and inside the clip (upstream's keyframe drag). */
export function keyTimeBetween(keys: readonly VolumeKey[], index: number, t: number, frame: number, clipStart: number, clipEnd: number) {
  let lo = clipStart
  let hi = clipEnd - frame
  const previous = keys[index - 1]
  const next = keys[index + 1]
  if (previous) lo = Math.max(lo, previous.time + frame)
  if (next) hi = Math.min(hi, next.time - frame)
  const snapped = frame > 0 ? Math.round(t / frame) * frame : t
  return lo <= hi ? Math.min(hi, Math.max(lo, snapped)) : keys[index]?.time ?? t
}

/**
 * Where a keyframe dragged by (`dx`, `dy`) points from its place at the press (`origin`) lands
 * (upstream's keyframe drag, both ways at once): its time follows the pointer sideways (on a frame,
 * between its neighbours, inside the clip; `pps` points a second), its level up or down as a fader
 * moves, kept on the faders' scale. A way the pointer did not move keeps the keyframe's own value.
 */
export function draggedKey(keys: readonly VolumeKey[], index: number, origin: VolumeKey, dx: number, dy: number, pps: number, frame: number, clipStart: number, clipEnd: number, band: { height: number }) {
  const time = dx === 0 || !(pps > 0) ? origin.time : keyTimeBetween(keys, index, origin.time + dx / pps, frame, clipStart, clipEnd)
  const value = dy === 0 ? origin.value : Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, draggedDb(band, origin.value, 0, dy)))
  return { time, value }
}

/** The level next to the pointer while dragging (upstream `tip`): one decimal place more, −∞ at the bottom. */
export function dbText(db: number) {
  return db <= FADER_MIN_DB ? '-∞ dB' : `${db >= 0 ? '+' : ''}${db.toFixed(2)} dB`
}
