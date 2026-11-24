// Imports carry `.ts` so `node --test` loads this module as it is.
import type { ExportOptions } from '../movie.ts'

/**
 * The Export dialog's choices (plan "Film usable by hand", phase 6, C3), pure so `node --test`
 * runs them: which sequence, which range, the frame size and rate, and the quality, each turned
 * into `file.exportMedia`'s own parameters by `exportOptions`. "As the sequence" and "Default"
 * send nothing, so the dialog left as it opens exports what the one-click Export MP4 does
 * (except the range, which the dialog always names).
 */

/** What the dialog knows of a sequence (`sequence.inspect`'s settings, its In and Out). */
export type ExportSequence = { id: number; name: string; width: number; height: number; fps: number; hasInOut: boolean; duration: number }

export type ExportRange = 'entire' | 'inOut'
export type ExportSize = 'sequence' | '2160' | '1080' | '720' | '540' | '360'
export type ExportRate = 'sequence' | '23.976' | '24' | '25' | '29.97' | '30' | '50' | '59.94' | '60'
export type ExportQuality = 'default' | 'high' | 'medium' | 'small' | 'bitrate'

export type ExportDraft = { sequence: number | null; range: ExportRange; size: ExportSize; rate: ExportRate; quality: ExportQuality; bitrateMbps: number }

/** The frame heights offered besides the sequence's own (UHD, HD, 720p, 540p, 360p). */
export const EXPORT_HEIGHTS: readonly Exclude<ExportSize, 'sequence'>[] = ['2160', '1080', '720', '540', '360']
/** The frame rates offered besides the sequence's own (the engine's `fps`, NTSC rates as decimals). */
export const EXPORT_RATES: readonly Exclude<ExportRate, 'sequence'>[] = ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60']
/** H.264 constant quality for each quality choice (`file.exportMedia` `quality`, 0 to 100). */
export const QUALITY_VALUES: Readonly<Record<'high' | 'medium' | 'small', number>> = { high: 90, medium: 70, small: 45 }
/** The bitrate field's bounds, in Mb/s, and its starting value (the engine's default H.264 bitrate). */
export const BITRATE_MIN_MBPS = 1
export const BITRATE_MAX_MBPS = 200
export const BITRATE_DEFAULT_MBPS = 20

/** The draft a dialog opens with: the active sequence, In to Out when it has both marks, everything else as the sequence. */
export function initialDraft(active: ExportSequence | null): ExportDraft {
  return { sequence: active?.id ?? null, range: active?.hasInOut ? 'inOut' : 'entire', size: 'sequence', rate: 'sequence', quality: 'default', bitrateMbps: BITRATE_DEFAULT_MBPS }
}

/** A frame of height `height` with the sequence's shape: the width rounded to an even number (H.264 needs even sizes). */
export function frameOf(sequence: Pick<ExportSequence, 'width' | 'height'>, height: number): { width: number; height: number } {
  const aspect = sequence.height > 0 && sequence.width > 0 ? sequence.width / sequence.height : 16 / 9
  return { width: Math.max(2, Math.round((height * aspect) / 2) * 2), height }
}

/** The size the export will have, for the dialog's summary. */
export function exportSize(draft: ExportDraft, sequence: ExportSequence): { width: number; height: number } {
  return draft.size === 'sequence' ? { width: sequence.width, height: sequence.height } : frameOf(sequence, Number(draft.size))
}

/** The rate the export will have, in frames per second. */
export function exportRate(draft: ExportDraft, sequence: ExportSequence): number {
  return draft.rate === 'sequence' ? sequence.fps : Number(draft.rate)
}

/** `file.exportMedia`'s parameters for the draft (the path and format are the export's own). */
export function exportOptions(draft: ExportDraft, sequence: ExportSequence): ExportOptions {
  const options: ExportOptions = { sequence: sequence.id, range: draft.range === 'inOut' && sequence.hasInOut ? 'inOut' : 'entire' }
  if (draft.size !== 'sequence') Object.assign(options, frameOf(sequence, Number(draft.size)))
  if (draft.rate !== 'sequence') options.fps = Number(draft.rate)
  if (draft.quality === 'bitrate') options.bitrateKbps = Math.round(Math.min(BITRATE_MAX_MBPS, Math.max(BITRATE_MIN_MBPS, draft.bitrateMbps)) * 1000)
  else if (draft.quality !== 'default') options.quality = QUALITY_VALUES[draft.quality]
  return options
}

/** A sequence as `sequence.inspect` answers it, or null when the answer is not one. */
export function sequenceOf(id: number, name: string, inspected: unknown): ExportSequence | null {
  const value = inspected as { settings?: { width?: number; height?: number; frame_rate?: { num?: number; den?: number } }; in?: number | null; out?: number | null; duration?: number } | null
  const settings = value?.settings
  if (!settings || !(Number(settings.width) > 0) || !(Number(settings.height) > 0)) return null
  const num = Number(settings.frame_rate?.num)
  const den = Number(settings.frame_rate?.den)
  const fps = num > 0 && den > 0 ? num / den : 30
  return { id, name, width: Number(settings.width), height: Number(settings.height), fps, hasInOut: value?.in != null && value?.out != null, duration: Number(value?.duration) || 0 }
}

/** A frame rate as a person reads it: `30`, `23.976`. */
export const rateText = (fps: number) => (Math.abs(fps - Math.round(fps)) < 1e-6 ? String(Math.round(fps)) : fps.toFixed(3).replace(/0+$/, ''))
