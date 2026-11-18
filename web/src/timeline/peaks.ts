// Imports carry `.ts` so `node --test` loads this module as it is.
import { CHUNK_SECONDS } from './layout.ts'
import { createRevisionCache, type EngineInvoke, type MediaQueue } from './mediaQueue.ts'

/** One 4 s chunk of an item's peaks (and the engine revision for a sequence item, whose mix edits change). */
export type PeakSpec = { item: number; revision: number | null; chunk: number }

export function peakKey({ item, revision, chunk }: PeakSpec) {
  return `${item}@${revision ?? '-'}/${chunk}`
}

const baseOf = ({ item, chunk }: Pick<PeakSpec, 'item' | 'chunk'>) => `${item}/${chunk}`

/**
 * Waveform peaks (upstream `request_peaks`): `itemPeaks(item, chunk × 4, 4)`, one (min, max) pair
 * per 256 samples at 48 kHz flattened, through the shared one-in-flight queue, cached per chunk in
 * an LRU of `max`. A sequence item keeps only its newest revision's chunks, shown while a newer
 * one loads. A chunk the engine cannot give is kept empty. `loudest` is the largest peak read so
 * far of an item's newest revision, which the display gain normalises by (upstream reads the
 * whole source first; here only the chunks in view are read): one entry per item.
 */
export function createPeaks({ invoke, queue, max = 1000 }: { invoke: EngineInvoke; queue: MediaQueue; max?: number }) {
  const cache = createRevisionCache<Float32Array>(max)
  const loud = new Map<number, { revision: number | null; most: number }>()
  return {
    get(key: string) {
      const match = /^(\d+)@([^/]+)\/(\d+)$/.exec(key)
      if (!match) return undefined
      return cache.get(`${match[1]}/${match[3]}`, match[2] === '-' ? null : Number(match[2]))
    },
    /** The chunk for `spec`'s revision, else its item's last revision's while that loads, else undefined. */
    show: (spec: PeakSpec) => cache.show(baseOf(spec), spec.revision)?.value,
    has: (spec: PeakSpec) => cache.has(baseOf(spec), spec.revision),
    loudest(item: number, revision: number | null) {
      const entry = loud.get(item)
      return entry && entry.revision === revision ? entry.most : 0
    },
    /** The loudest peak read of an item's newest revision, whichever it is: the gain for chunks shown while a newer revision loads. */
    loudestShown: (item: number) => loud.get(item)?.most ?? 0,
    request(spec: PeakSpec, onReady: () => void): () => void {
      if (cache.has(baseOf(spec), spec.revision)) return () => undefined
      return queue.want(
        peakKey(spec),
        async (live) => {
          let pairs: Float32Array = new Float32Array(0)
          try {
            pairs = (await invoke('itemPeaks', spec.item, spec.chunk * CHUNK_SECONDS, CHUNK_SECONDS)) as Float32Array
          } catch {
            // No sound, or past the end: drawn flat.
          }
          if (!live()) return
          const entry = loud.get(spec.item)
          let most = entry && entry.revision === spec.revision ? entry.most : 0
          for (const value of pairs) most = Math.max(most, Math.abs(value))
          // A newer revision starts its own loudest; an older answer arriving late does not replace it.
          if (!entry || entry.revision === spec.revision || (spec.revision ?? -1) > (entry.revision ?? -1)) loud.set(spec.item, { revision: spec.revision, most })
          cache.set(baseOf(spec), spec.revision, pairs)
        },
        onReady,
      )
    },
    clear: () => {
      cache.clear()
      loud.clear()
    },
  }
}

export type Peaks = ReturnType<typeof createPeaks>
