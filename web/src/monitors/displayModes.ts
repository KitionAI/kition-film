// The monitors' display modes, as upstream's `monitor_view.rs` (`set_display`, `checked`,
// `channel_view`, `waveform`, `compare_bar`) and `monitor.rs` `show`. The UI owns the mode and
// the comparison reference (upstream's `MonitorView`, rule 5). Pure, with `.ts` imports, so
// `node --test` runs it.
import type { MonitorId, MonitorView, MonitorViews } from './monitorView.ts'

/** Upstream's `DisplayMode`, by the name its `view.display.<name>` command takes (Multi-Camera, wave 3, aside). */
export type DisplayMode = 'composite' | 'alpha' | 'red' | 'green' | 'blue' | 'audioWaveform' | 'comparison' | 'videoAndWaveform'
export type ChannelMode = 'alpha' | 'red' | 'green' | 'blue'

/** `DISPLAY_NAMES`, in upstream's order. */
export const DISPLAY_MODES: readonly DisplayMode[] = ['composite', 'alpha', 'red', 'green', 'blue', 'audioWaveform', 'comparison', 'videoAndWaveform']

export const isDisplayMode = (name: string): name is DisplayMode => (DISPLAY_MODES as readonly string[]).includes(name)
/** `DisplayMode::is_channel`: one channel of the picture, in grey. */
export const isChannel = (mode: DisplayMode): mode is ChannelMode => mode === 'alpha' || mode === 'red' || mode === 'green' || mode === 'blue'

/** The label `show` draws at the picture's top right for a mode other than Composite (upstream's `tl!`, a phrase). */
export const DISPLAY_LABELS: Readonly<Record<DisplayMode, string>> = {
  composite: 'Composite',
  alpha: 'Alpha',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
  audioWaveform: 'Audio Waveform',
  comparison: 'Comparison',
  videoAndWaveform: 'Video and Waveform',
}

/** `set_display`'s forcing: Audio Waveform and the split view are Source modes, Comparison a Program mode, the rest the asked monitor's. */
export function displayMonitor(mode: DisplayMode, asked: MonitorId): MonitorId {
  if (mode === 'audioWaveform' || mode === 'videoAndWaveform') return 'source'
  if (mode === 'comparison') return 'program'
  return asked
}

/**
 * `set_display`: the views with `mode` on the monitor it goes to, and upstream's answer. Comparison
 * with no reference yet takes the program playhead (`playhead`, ticks) as its reference.
 */
export function setDisplay(views: MonitorViews, asked: MonitorId, mode: DisplayMode, playhead: number): { views: MonitorViews; result: Record<string, unknown> } {
  const monitor = displayMonitor(mode, asked)
  const view = views[monitor]
  const next: MonitorView = { ...view, display: mode, compareRef: mode === 'comparison' && view.compareRef == null ? playhead : view.compareRef }
  return { views: { ...views, [monitor]: next }, result: { monitor, display: mode } }
}

/** `checked` for `view.display.<mode>`: the forced monitor's mode for the waveform modes and Comparison, else the focused monitor's. */
export function displayChecked(views: MonitorViews, mode: DisplayMode, focused: MonitorId) {
  return views[displayMonitor(mode, focused)].display === mode
}

/**
 * `channel_view`, in place: one channel of an RGBA frame as opaque grey, the colour channels
 * premultiplied by alpha (so a transparent area is black), the alpha channel as it is.
 */
export function channelPass(pixels: Uint8ClampedArray, mode: ChannelMode) {
  const offset = mode === 'red' ? 0 : mode === 'green' ? 1 : mode === 'blue' ? 2 : 3
  for (let at = 0; at < pixels.length; at += 4) {
    const alpha = pixels[at + 3]
    const value = offset === 3 ? alpha : ((pixels[at + offset] * alpha) / 255) | 0
    pixels[at] = value
    pixels[at + 1] = value
    pixels[at + 2] = value
    pixels[at + 3] = 255
  }
}

/**
 * `compare_bar`'s buttons: Set takes the playhead, ▶ and ◀ step the reference (else the playhead)
 * by one frame, never before 0, and ▶ never past the sequence's last frame (`end` less a frame).
 */
export function compareStep(reference: number | null, playhead: number, frame: number, key: 'set' | 'next' | 'prev', end = Number.POSITIVE_INFINITY) {
  if (key === 'set') return playhead
  const from = reference ?? playhead
  return key === 'next' ? Math.max(0, Math.min(from + frame, end - frame)) : Math.max(0, from - frame)
}

/**
 * `show`'s Source layout: a clip with no picture, or Audio Waveform, is all waveform (`wave_only`);
 * the split view gives the picture the top 62% and the waveform the rest.
 */
export function sourceLayout(hasPicture: boolean, mode: DisplayMode): { picture: boolean; waveform: 'full' | 'split' | null } {
  if (!hasPicture || mode === 'audioWaveform') return { picture: false, waveform: 'full' }
  return mode === 'videoAndWaveform' ? { picture: true, waveform: 'split' } : { picture: true, waveform: null }
}

/** Where the split view divides the Source picture area (`video_area.height() * 0.62`). */
export const SPLIT = 0.62

/**
 * A picture read keyed by what it shows (document, item, revision, time, width; lesson 6): one in
 * flight, the latest key asked next; an answer for a key that is no longer the latest is dropped,
 * never shown. The key shown (or in flight) is not asked again. A failed read, or an answer
 * `onValue` could not show (it answers false), is not shown, so the next want reads again. A key
 * that waited and was replaced before it was read is told to `onSkip` (a frame the clock passed).
 * `stop` drops what is in flight.
 */
export function createLatestRead<K, V>({ read, same, onValue, onError, onSkip }: { read: (key: K) => Promise<V>; same: (a: K, b: K) => boolean; onValue: (key: K, value: V) => boolean | void; onError?: (key: K, error: unknown) => void; onSkip?: (key: K) => void }) {
  let latest: K | null = null
  let flying: K | null = null
  let shown: K | null = null
  let waiting = false
  const pump = () => {
    if (flying !== null || !waiting || latest === null) return
    const key = latest
    waiting = false
    flying = key
    read(key)
      .then(
        (value) => {
          if (latest === null || !same(key, latest)) return
          if (onValue(key, value) !== false) shown = key
        },
        (error) => {
          if (latest !== null && same(key, latest)) onError?.(key, error)
        },
      )
      .finally(() => {
        flying = null
        pump()
      })
  }
  return {
    want(key: K) {
      if (waiting && latest !== null && !same(latest, key)) onSkip?.(latest)
      latest = key
      if ((flying !== null && same(flying, key)) || (shown !== null && same(shown, key))) {
        waiting = false
        return
      }
      waiting = true
      pump()
    },
    /** Nothing is wanted any more (the mode is off, the monitor hidden): the answer in flight is dropped, and the next want reads again. */
    stop() {
      latest = null
      shown = null
      waiting = false
    },
  }
}
