import type { KitEngine } from '@kition/sdk/editor'
import { createMediaQueue } from './mediaQueue'
import { createPeaks } from './peaks'
import { createThumbnails, frameCanvas, releaseCanvas, type Thumbnails } from './thumbnails'

/** What a preview's pictures are read from (`PreviewContext`'s preview): its engine while it is open, and whether `key` is still the open one. */
export type PreviewPictureSource = { engine: () => { invoke: (name: string, ...args: unknown[]) => Promise<unknown> } | null; current: () => string | null }

/** How many of the open preview's pictures are kept (its new and changed items, in the Timeline and the Project panel). */
const PREVIEW_BUDGET = 48

/**
 * The Timeline's media for one document: thumbnails and peaks through one queue on the engine
 * worker, asked only while nothing plays and the playhead is not scrubbed. `busy` says whether a
 * clock plays; `setScrubbing` marks a ruler or timecode drag. Item ids repeat across documents, so
 * another document starts from empty caches (`reset`).
 */
export function createTimelineMedia(doc: () => KitEngine | null, busy: () => boolean) {
  let scrubbing = false
  const queue = createMediaQueue({ idle: () => !scrubbing && !busy() && doc() != null })
  const invoke = (name: string, ...args: unknown[]) => {
    const engine = doc()
    if (!engine) return Promise.reject(new Error('no document'))
    return engine.invoke(name, ...args)
  }
  const thumbnails = createThumbnails({ invoke, queue, decode: frameCanvas, release: releaseCanvas })
  const peaks = createPeaks({ invoke, queue })
  let preview: { key: string; thumbnails: Thumbnails<HTMLCanvasElement> } | null = null
  return {
    queue,
    thumbnails,
    peaks,
    /** Runs a read of the Timeline's own (render bar, mix level) through the same queue. */
    read(key: string, run: () => Promise<void>) {
      return queue.want(key, run, () => undefined)
    },
    setScrubbing(on: boolean) {
      scrubbing = on
      if (!on) queue.pump()
    },
    /** Playback may have stopped: send what waits. */
    pump: () => queue.pump(),
    /**
     * The pictures of the open preview named `key` (`previewCacheKey`): `previewItemFrame` for the
     * items only the preview has, or whose picture it changes, through the same queue. One cache
     * per preview, dropped when the next one opens; a frame read after its preview ended or moved
     * on is not kept (lesson 6).
     */
    previewThumbnails(key: string, source: PreviewPictureSource): Thumbnails<HTMLCanvasElement> {
      if (preview?.key === key) return preview.thumbnails
      preview?.thumbnails.clear()
      const live = () => source.current() === key
      const read = async (_name: string, ...args: unknown[]) => {
        const engine = source.engine()
        if (!live() || !engine) throw new Error('the preview has ended')
        const bytes = await engine.invoke('previewItemFrame', ...args)
        if (!live()) throw new Error('the preview has moved on')
        return bytes
      }
      preview = { key, thumbnails: createThumbnails({ invoke: read, queue, max: PREVIEW_BUDGET, decode: frameCanvas, release: releaseCanvas, prefix: `preview:${key}` }) }
      return preview.thumbnails
    },
    /** The preview closed: its pictures go. */
    closePreview() {
      preview?.thumbnails.clear()
      preview = null
    },
    reset() {
      queue.clear()
      thumbnails.clear()
      peaks.clear()
      preview?.thumbnails.clear()
      preview = null
    },
  }
}

export type TimelineMedia = ReturnType<typeof createTimelineMedia>
