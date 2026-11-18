// The Source monitor's waveform data (upstream `monitor_view.rs` `waveform`): an item's peaks read
// in the Timeline's 4 s chunks through the Timeline's one-in-flight queue, each chunk folded as it
// arrives into a fixed set of min and max bins the waveform owns, so a long clip neither fills the
// Timeline's peaks cache nor keeps its raw chunks. Pure, with `.ts` imports, so `node --test` runs it.
import { TICKS_PER_SECOND } from '../film.ts'
import type { MediaQueue } from '../timeline/mediaQueue.ts'

/** `itemPeaks`: one (min, max) pair per 256 samples at 48 kHz, flattened. */
const PAIRS_PER_SECOND = 48_000 / 256
export const CHUNK_SECONDS = 4
export const PAIRS_PER_CHUNK = PAIRS_PER_SECOND * CHUNK_SECONDS
/** The bins a summary keeps: more than any monitor is wide in device pixels. */
export const WAVEFORM_BINS = 4096
/** The chunk reads a waveform keeps queued at once, so the Timeline's own reads wait behind a few at most. */
export const WAVEFORM_WINDOW = 8
/** Numbers each summary: its reads are its own, never joined by another summary's (lesson 6). */
let summaries = 0

/** How many 4 s chunks cover `duration` ticks of an item. */
export const waveformChunks = (duration: number) => Math.max(0, Math.ceil(duration / TICKS_PER_SECOND / CHUNK_SECONDS))

export type WaveformColumn = { lo: number; hi: number } | null

/**
 * An item's peaks over `duration` ticks from its start, folded into at most `bins` bins (one per
 * pair for a short item). `add` folds a chunk in (an empty one, no sound there, reads flat);
 * `columns` gives each of `width` pixels the min and max of the bins it covers, folded from 0 as
 * upstream does, or null while a bin it covers is still waiting for one of its chunks.
 */
export function createWaveformSummary(duration: number, bins = WAVEFORM_BINS) {
  const total = Math.max(1, Math.ceil((Math.max(0, duration) / TICKS_PER_SECOND) * PAIRS_PER_SECOND))
  const count = Math.min(bins, total)
  const lo = new Float32Array(count)
  const hi = new Float32Array(count)
  /** Each bin's chunks still to come (a bin may straddle two). */
  const missing = new Uint8Array(count)
  const chunks = waveformChunks(duration)
  const id = ++summaries
  const arrived = new Set<number>()
  let sound = false
  const binOf = (pair: number) => Math.min(count - 1, Math.floor((pair * count) / total))
  for (let bin = 0; bin < count; bin += 1) {
    const first = Math.ceil((bin * total) / count)
    const last = Math.min(total, Math.ceil(((bin + 1) * total) / count)) - 1
    missing[bin] = Math.floor(Math.max(first, last) / PAIRS_PER_CHUNK) - Math.floor(first / PAIRS_PER_CHUNK) + 1
  }
  return {
    id,
    chunks,
    has: (chunk: number) => arrived.has(chunk),
    add(chunk: number, pairs: Float32Array) {
      if (arrived.has(chunk) || chunk < 0 || chunk >= chunks) return
      arrived.add(chunk)
      const first = chunk * PAIRS_PER_CHUNK
      const end = Math.min(total, first + PAIRS_PER_CHUNK)
      for (let at = 0; at * 2 + 1 < pairs.length && first + at < end; at += 1) {
        const bin = binOf(first + at)
        if (pairs[at * 2] < lo[bin]) lo[bin] = pairs[at * 2]
        if (pairs[at * 2 + 1] > hi[bin]) hi[bin] = pairs[at * 2 + 1]
        sound = true
      }
      if (first < end) for (let bin = binOf(first); bin <= binOf(end - 1); bin += 1) if (missing[bin] > 0) missing[bin] -= 1
    },
    /** Whether every chunk has arrived, any has, and any had sound. */
    state: () => ({ all: arrived.size >= chunks, any: arrived.size > 0, sound }),
    columns(width: number): WaveformColumn[] {
      const columns: WaveformColumn[] = []
      for (let x = 0; x < width; x += 1) {
        const first = Math.floor((total * x) / width)
        const last = Math.max(first + 1, Math.floor((total * (x + 1)) / width))
        let low = 0
        let high = 0
        let waiting = false
        for (let bin = binOf(first); bin <= binOf(last - 1); bin += 1) {
          if (missing[bin] > 0) {
            waiting = true
            break
          }
          low = Math.min(low, lo[bin])
          high = Math.max(high, hi[bin])
        }
        columns.push(waiting ? null : { lo: low, hi: high })
      }
      return columns
    },
  }
}

export type WaveformSummary = ReturnType<typeof createWaveformSummary>

/**
 * Reads the chunks `summary` lacks (`itemPeaks(item, chunk × 4, 4)`) through the Timeline's queue
 * under keys naming the summary (a read is never joined by another summary's, which would write
 * into the one that asked first), never its peaks cache, keeping at most `WAVEFORM_WINDOW` queued
 * and asking the next as each lands, so the Timeline's reads asked meanwhile wait behind a few.
 * `onChange` is told at most once per `schedule` (an animation frame) however many arrived. A
 * chunk the engine cannot give reads flat. Answers a cancel: what waits is not sent; an answer for
 * another document (`live()` false) is dropped.
 */
export function loadWaveform({ summary, item, revision, queue, read, schedule, onChange }: { summary: WaveformSummary; item: number; revision: number | null; queue: MediaQueue; read: (item: number, start: number, seconds: number) => Promise<unknown>; schedule: (task: () => void) => () => void; onChange: () => void }) {
  const cancels = new Map<number, () => void>()
  let next = 0
  let cancelled = false
  let pending: (() => void) | null = null
  const changed = () => {
    pending ??= schedule(() => {
      pending = null
      onChange()
    })
  }
  const topUp = () => {
    while (!cancelled && cancels.size < WAVEFORM_WINDOW && next < summary.chunks) {
      const chunk = next
      next += 1
      if (summary.has(chunk)) continue
      cancels.set(
        chunk,
        queue.want(
          `waveform:${summary.id}:${item}@${revision ?? '-'}/${chunk}`,
          async (live) => {
            let pairs: Float32Array = new Float32Array(0)
            try {
              pairs = (await read(item, chunk * CHUNK_SECONDS, CHUNK_SECONDS)) as Float32Array
            } catch {
              // No sound there, or past the end: drawn flat.
            }
            if (live()) summary.add(chunk, pairs)
          },
          () => {
            cancels.delete(chunk)
            changed()
            topUp()
          },
        ),
      )
    }
  }
  topUp()
  return () => {
    cancelled = true
    for (const cancel of cancels.values()) cancel()
    cancels.clear()
    pending?.()
    pending = null
  }
}

/** The last summary drawn whole, of which item and document: a new revision's draws over it only once it has all arrived. */
export type ShownWaveform = { summary: WaveformSummary; item: number; doc: unknown }

/** What the waveform draws: `current`, or while it loads the last whole summary of the same item and document. */
export function shownSummary(current: WaveformSummary, last: ShownWaveform | null, item: number, doc: unknown) {
  if (current.state().all || !last || last.item !== item || last.doc !== doc) return current
  return last.summary
}
