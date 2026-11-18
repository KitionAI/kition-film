// The preview strip's Play (`sound` previews): 3 s of the preview's mix from the playhead
// (`previewAudio`). Imports carry `.ts` so `node --test` loads this module as it is.
import type { PreviewEngine } from './preview.ts'

/** What Play needs of a Web Audio context (an `AudioContext`, or a test's stand-in). */
export type SoundContext = {
  createBuffer: (channels: number, frames: number, rate: number) => { copyToChannel: (samples: Float32Array<ArrayBuffer>, channel: number) => void }
  createBufferSource: () => { buffer?: unknown; connect: (to: unknown) => void; start: () => void; stop: () => void; onended: (() => void) | null }
  destination: unknown
  close: () => Promise<void>
}

/** Interleaved stereo (`previewAudio`) as two channels. */
export function deinterleave(samples: ArrayLike<number>): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const frames = Math.floor(samples.length / 2)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let at = 0; at < frames; at += 1) {
    left[at] = samples[at * 2]
    right[at] = samples[at * 2 + 1]
  }
  return [left, right]
}

/**
 * Plays the preview's sound, one play at a time. A stop (or an unmount, or another preview)
 * while it still reads drops the play: each await checks its ticket, so nothing plays late; a
 * context made is closed on stop and at the end; a failed read rejects nothing.
 */
export function createSoundPlayer({ audio, onChange = () => undefined }: { audio: (rate: number) => SoundContext; onChange?: (playing: boolean) => void }) {
  let ticket = 0
  let sound: { context: SoundContext; source: ReturnType<SoundContext['createBufferSource']> } | null = null
  const stop = () => {
    ticket += 1
    const shown = sound
    sound = null
    if (shown) {
      shown.source.onended = null
      try {
        shown.source.stop()
      } catch {
        // Already stopped.
      }
      void shown.context.close().catch(() => undefined)
      onChange(false)
    }
  }
  return {
    stop,
    playing: () => sound != null,
    async play(engine: PreviewEngine, startSeconds: number, seconds: number) {
      stop()
      const mine = ticket
      try {
        const rate = await engine.invoke<number>('previewAudioRate')
        if (mine !== ticket || !(rate > 0)) return
        const samples = await engine.invoke<Float32Array>('previewAudio', Math.max(0, startSeconds), Math.round(rate * seconds))
        if (mine !== ticket) return
        const [left, right] = deinterleave(samples)
        if (left.length === 0) return
        const context = audio(rate)
        const buffer = context.createBuffer(2, left.length, rate)
        buffer.copyToChannel(left, 0)
        buffer.copyToChannel(right, 1)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        source.onended = () => {
          if (sound?.source === source) stop()
        }
        sound = { context, source }
        source.start()
        onChange(true)
      } catch {
        // No preview open (it ended meanwhile), or no sound: nothing plays.
        if (mine === ticket) stop()
      }
    },
  }
}
