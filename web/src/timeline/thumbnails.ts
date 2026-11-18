// Imports carry `.ts` so `node --test` loads this module as it is.
import { createRevisionCache, type CacheRevision, type EngineInvoke, type MediaQueue } from './mediaQueue.ts'

/**
 * What a clip's head thumbnail is: its item (and for a sequence item what its picture changes
 * with: the engine revision, or the sequence's own content stamp), frame, and width.
 */
export type ThumbnailSpec = { item: number; revision: CacheRevision; frame: number; seconds: number; width: number }

const baseOf = ({ item, frame, width }: Pick<ThumbnailSpec, 'item' | 'frame' | 'width'>) => `${item}/${frame}/${width}`

/** The cache key: `(item, revision, frame, width × device scale)` for a sequence item, `(item, frame, width)` for media. */
export function thumbnailKey({ item, revision, frame, width }: Omit<ThumbnailSpec, 'seconds'>) {
  return `${item}@${revision ?? '-'}/${frame}/${width}`
}

/**
 * How many thumbnails are kept: a 320 × 180 frame (160 points at device scale 2) is 230 KB of
 * pixels, so 128 stay under about 30 MB.
 */
export const THUMBNAIL_BUDGET = 128

/**
 * The Timeline's head thumbnails (upstream `app.thumbnail(…, 160)`): `itemFrame` at the asked width
 * (160 × device scale), through the shared one-in-flight queue, kept in an LRU of `max`. A sequence
 * item keeps only its newest revision's frame, shown while a newer one loads. A frame the engine
 * cannot give (no picture) is kept as null, so it is not asked again. `release` frees an evicted
 * picture's memory. Another cache on the same queue names itself (`prefix`), so its requests never
 * join this one's: their keys' frames may mean other times.
 */
export function createThumbnails<V>({ invoke, queue, max = THUMBNAIL_BUDGET, decode, release, prefix = '' }: { invoke: EngineInvoke; queue: MediaQueue; max?: number; decode: (bytes: Uint8Array) => V; release?: (value: V) => void; prefix?: string }) {
  const cache = createRevisionCache<V | null>(max, (value) => {
    if (value != null) release?.(value)
  })
  return {
    /** The entry for exactly `key`'s revision (`thumbnailKey`), or undefined. */
    get(key: string) {
      const match = /^(\d+)@([^/]+)\/(.+)$/.exec(key)
      if (!match) return undefined
      return cache.get(`${match[1]}/${match[3]}`, match[2] === '-' ? null : match[2])
    },
    /** What to draw for `spec`: its own frame (`fresh`), or its item's last revision's while that loads; undefined when neither is cached. */
    show(spec: Omit<ThumbnailSpec, 'seconds'>): { image: V | null; fresh: boolean } | undefined {
      const found = cache.show(baseOf(spec), spec.revision)
      return found ? { image: found.value, fresh: found.fresh } : undefined
    },
    /** Asks for `spec` unless it is cached; `onReady` hears when it arrives. Answers a cancel. */
    request(spec: ThumbnailSpec, onReady: () => void): () => void {
      const base = baseOf(spec)
      if (cache.has(base, spec.revision)) return () => undefined
      return queue.want(
        prefix ? `${prefix}:${thumbnailKey(spec)}` : thumbnailKey(spec),
        async (live) => {
          let image: V | null = null
          try {
            image = decode((await invoke('itemFrame', spec.item, spec.seconds, spec.width)) as Uint8Array)
          } catch {
            image = null
          }
          if (live()) cache.set(base, spec.revision, image)
          else if (image != null) release?.(image)
        },
        onReady,
      )
    },
    clear: () => cache.clear(),
  }
}

export type Thumbnails<V> = ReturnType<typeof createThumbnails<V>>

/** `itemFrame`'s answer (`[width u32 LE][height u32 LE]` then RGBA) as a canvas to draw from. */
export function frameCanvas(bytes: Uint8Array): HTMLCanvasElement {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(0, true)
  const height = view.getUint32(4, true)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset + 8, width * height * 4), width, height), 0, 0)
  return canvas
}

/** Frees an evicted canvas's pixels at once (WebKit keeps a detached canvas's backing store until it is collected). */
export function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0
  canvas.height = 0
}

/**
 * Draws `image` into `canvas` at `width` × `height` points on a `dpr` backing store: `crop` keeps
 * the picture's aspect at the full height, cropping its right side (a Timeline clip narrower than
 * its frame); `contain` fits it inside the box, centred (a Project panel card). Clears the canvas
 * when there is no picture.
 */
export function paintFrame(canvas: HTMLCanvasElement, image: CanvasImageSource & { width: number; height: number } | null, width: number, height: number, dpr: number, fit: 'crop' | 'contain') {
  const w = Math.max(1, Math.round(width * dpr))
  const h = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, w, h)
  if (!image || image.width <= 0 || image.height <= 0) return
  if (fit === 'crop') {
    const share = Math.min(1, width / (height * (image.width / image.height)))
    context.drawImage(image, 0, 0, image.width * share, image.height, 0, 0, w, h)
    return
  }
  const scale = Math.min(w / image.width, h / image.height)
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, (w - image.width * scale) / 2, (h - image.height * scale) / 2, image.width * scale, image.height * scale)
}
