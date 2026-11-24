// Imports carry `.ts` so `node --test` loads this module as it is.
import { FADER_MAX_DB, FADER_MIN_DB, dbToPos, posToDb } from '../timeline/volumeBand.ts'

/**
 * The Audio Track Mixer's strips (upstream `panels/mixer.rs`), pure so `node --test` runs them:
 * what `mixer.inspect` answers, read into one strip per audio track and the Mix, and the fader's
 * and the pan's pointer arithmetic on upstream's taper (`volumeBand.ts` `dbToPos`, `posToDb`).
 */

/** One strip: an audio track (`A1` …) or the Mix. `volumeDb` and `pan` are what plays at the playhead. */
export type MixerStrip = { ref: string; track: number; name: string; kind: 'audio' | 'mix'; volumeDb: number; pan: number; muted: boolean; solo: boolean }

type Inspected = { strips?: Array<{ id?: number; ref?: string; name?: string; kind?: string; volumeDb?: number; pan?: number; muted?: boolean; solo?: boolean; at?: { volumeDb?: number; pan?: number } } | null> }

/** The audio tracks' strips in track order, then the Mix (submixes are not drawn). */
export function stripsOf(inspected: unknown): MixerStrip[] {
  const strips = (inspected as Inspected | null)?.strips ?? []
  const out: MixerStrip[] = []
  for (const strip of strips) {
    if (!strip || (strip.kind !== 'audio' && strip.kind !== 'mix') || typeof strip.ref !== 'string') continue
    const volumeDb = Number(strip.at?.volumeDb ?? strip.volumeDb ?? 0)
    const pan = Number(strip.at?.pan ?? strip.pan ?? 0)
    out.push({
      ref: strip.ref,
      track: Number(strip.id ?? -1),
      name: strip.kind === 'mix' ? 'Mix' : (strip.name ?? strip.ref),
      kind: strip.kind,
      volumeDb: Number.isFinite(volumeDb) ? volumeDb : 0,
      pan: Number.isFinite(pan) ? Math.min(100, Math.max(-100, pan)) : 0,
      muted: strip.muted === true,
      solo: strip.solo === true,
    })
  }
  return [...out.filter((strip) => strip.kind === 'audio'), ...out.filter((strip) => strip.kind === 'mix')]
}

/** The level a fader shows at `y` points down a track `height` points tall (the top is +15 dB, the bottom silence). */
export function faderDb(height: number, y: number) {
  return posToDb(1 - y / Math.max(1, height))
}

/** Where the fader's knob sits for `db`: points down from the top of a track `height` points tall. */
export function faderY(height: number, db: number) {
  return (1 - dbToPos(Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, db)))) * height
}

/** A level as the strip reads it: `+2.5`, `0.0`, `-∞`. */
export function levelText(db: number) {
  if (db <= FADER_MIN_DB) return '-∞'
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`
}

/** A pan as the strip reads it: `L 40`, `0`, `R 100`. */
export function panText(pan: number) {
  const rounded = Math.round(pan)
  return rounded === 0 ? '0' : rounded < 0 ? `L ${-rounded}` : `R ${rounded}`
}
