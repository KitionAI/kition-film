// Upstream's clip dialogs (`panels/clip_dialogs.rs`): each one's title and prefix (`meta()`),
// draft (`defaults()`), fields (`show`), and params (`finish()`). Imports carry `.ts` so
// `node --test` loads this module as it is.
import { timecode, type FilmClip, type FilmInfo } from '../film.ts'
import { dialogFps, rememberedDraft, type DialogContext, type DialogSpec, type Draft, type FieldRow, type Params } from './registry.ts'

/** Upstream's `TimeInterpolation::ALL`: name and label. */
export const TIME_INTERPOLATIONS = [
  ['frameSampling', 'Frame Sampling'],
  ['frameBlending', 'Frame Blending'],
  ['opticalFlow', 'Optical Flow'],
] as const

/** The first selected clip of the active sequence, in track order (upstream's `selection.iter().find_map`). */
function firstSelected(ctx: DialogContext): FilmClip | null {
  const film = ctx.film
  if (!film) return null
  const clips = new Map(film.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]))
  for (const id of film.selection) {
    const clip = clips.get(id)
    if (clip) return clip
  }
  return null
}

/**
 * Clip Speed / Duration's Duration: the clip's duration at the new speed (the media shown stays
 * the same), as upstream's `show` arm reads it; null while it has no clip or no speed.
 */
export function speedDurationReadout(draft: Draft, ctx: DialogContext): string | null {
  const clip = firstSelected(ctx)
  const now = Number(draft.speed) / 100
  if (!clip || !(clip.duration > 0) || !(now > 0)) return null
  const was = Math.abs(clip.speed) || 1
  return timecode((clip.duration * was) / now, dialogFps(ctx))
}

/**
 * Clip Speed / Duration (`clip.speedDuration`): the first selected clip's speed in percent (two
 * decimals), Reverse, no Ripple, and its time interpolation, as upstream's `defaults()`. OK and the
 * preview name the selected clips (`clips`), so OK changes the clips the preview showed.
 *
 * Reverse is on for a negative speed (upstream's test) or a reversed clip: the engine keeps a
 * clip's reverse apart from its speed, so upstream's test alone would open a reversed clip
 * unchecked and OK would play it forwards again (a deviation, so nothing is lost).
 */
const speedDuration: DialogSpec = {
  id: 'clip.speedDuration',
  family: 'clip',
  title: 'Clip Speed / Duration',
  prefix: 'speedDuration',
  preview: ['picture', 'timeline'],
  layout: [
    { kind: 'number', field: 'speed', label: 'Speed:', min: 0.01, max: 100_000, step: 0.01, unit: '%' },
    { kind: 'readout', label: 'Duration:', testId: 'duration', value: speedDurationReadout },
    { kind: 'check', field: 'reverse', label: 'Reverse Speed' },
    { kind: 'check', field: 'ripple', label: 'Ripple Edit, Shifting Trailing Clips' },
    { kind: 'heading', label: 'Time Interpolation' },
    { kind: 'radio', field: 'interpolation', label: 'Time Interpolation', options: TIME_INTERPOLATIONS },
  ],
  defaults: (ctx) => {
    const clip = firstSelected(ctx)
    const speed = clip?.speed ?? 1
    return { speed: Math.round(Math.abs(speed) * 100 * 100) / 100, reverse: speed < 0 || clip?.reverse === true, ripple: false, interpolation: clip?.timeInterpolation ?? null }
  },
  toParams: (draft, ctx) => {
    const params: Record<string, unknown> = { clips: [...(ctx.film?.selection ?? [])], speed: Number(draft.speed), reverse: draft.reverse === true, ripple: draft.ripple === true }
    if (typeof draft.interpolation === 'string') params.interpolation = draft.interpolation
    return params
  },
}

/** The timeline's selected clips, which OK names (`clips`), so OK changes the clips the preview showed. */
const selectedClips = (ctx: DialogContext) => [...(ctx.film?.selection ?? [])]

/** What upstream's `defaults()` answers for `command` from session state `inspect()` lacks (the `dialogDefaults` extra), or null. */
export async function engineDefaults(ctx: DialogContext, command: string): Promise<{ params: Draft; info: unknown } | null> {
  const answer = (await ctx.read?.('dialogDefaults', command).catch(() => null)) as { params?: unknown; info?: unknown } | null | undefined
  return answer && typeof answer.params === 'object' && answer.params ? { params: answer.params as Draft, info: answer.info ?? null } : null
}

/** What Paste and Remove Attributes show beside their draft (upstream's `info`): the kinds of clip, and the effects offered. */
export type AttributesInfo = { video: boolean; audio: boolean; effects: Array<readonly [string, string]> }

/** A draft's `info`, as upstream's `show` reads it: a missing kind is enabled (`unwrap_or(true)`), a missing list empty. */
export function attributesInfo(draft: Draft): AttributesInfo {
  const info = (draft.info ?? {}) as { video?: unknown; audio?: unknown; effects?: unknown }
  const effects = Array.isArray(info.effects) ? info.effects.filter((each): each is [string, string] => Array.isArray(each) && typeof each[0] === 'string' && typeof each[1] === 'string') : []
  return { video: info.video !== false, audio: info.audio !== false, effects }
}

/** Upstream's `intrinsic_video()` and `intrinsic_audio()`. */
export const INTRINSIC_VIDEO = [
  ['motion', 'Motion'],
  ['opacity', 'Opacity'],
  ['timeRemapping', 'Time Remapping'],
] as const
export const INTRINSIC_AUDIO = [
  ['volume', 'Volume'],
  ['channelVolume', 'Channel Volume'],
  ['panner', 'Panner'],
] as const
const INTRINSIC_KEYS = [...INTRINSIC_VIDEO, ...INTRINSIC_AUDIO].map(([key]) => key)

/** Paste or Remove Attributes' rows (upstream's `show` arm): the intrinsics by kind, a box per effect, and (Paste) Scale Attribute Times. */
function attributeRows(paste: boolean): FieldRow[] {
  return [
    { kind: 'heading', label: 'Video Attributes' },
    ...INTRINSIC_VIDEO.map(([field, label]): FieldRow => ({ kind: 'check', field, label, enabled: (draft) => attributesInfo(draft).video })),
    { kind: 'heading', label: 'Audio Attributes' },
    ...INTRINSIC_AUDIO.map(([field, label]): FieldRow => ({ kind: 'check', field, label, enabled: (draft) => attributesInfo(draft).audio })),
    { kind: 'heading', label: 'Effects' },
    { kind: 'checklist', field: 'effects', item: 'effect', label: 'Effects', empty: 'No effects', options: (draft) => attributesInfo(draft).effects },
    ...(paste ? ([{ kind: 'separator' }, { kind: 'check', field: 'scaleTimes', label: 'Scale Attribute Times' }] satisfies FieldRow[]) : []),
  ]
}

/** OK's params for Paste (`paste`) or Remove Attributes: upstream's draft as it is (`finish()` changes nothing), naming the selected clips. */
export function attributesParams(draft: Draft, ctx: DialogContext, paste: boolean): Params {
  const params: Params = { clips: selectedClips(ctx) }
  for (const key of INTRINSIC_KEYS) params[key] = draft[key] === true
  params.effects = Array.isArray(draft.effects) ? draft.effects.filter((each) => typeof each === 'string') : []
  if (paste) params.scaleTimes = draft.scaleTimes === true
  return params
}

/** Upstream's draft with nothing copied and nothing selected (what the engine answers then). */
const noAttributes = (paste: boolean): Draft => ({
  ...Object.fromEntries(INTRINSIC_KEYS.map((key) => [key, false])),
  effects: [],
  ...(paste ? { scaleTimes: true } : {}),
  info: { video: false, audio: false, effects: [] },
})

/**
 * Edit ▸ Paste Attributes… and Remove Attributes… (`pasteAttributes`, `removeAttributes`): the
 * intrinsic attributes of the kinds of clip copied (Paste) or selected (Remove) checked, the
 * other kind's drawn disabled, and a box for each standard effect of those clips, all checked;
 * Paste also Scale Attribute Times. The engine reads the copied clips (`dialogDefaults`), which
 * `inspect()` does not show.
 */
function attributes(paste: boolean): DialogSpec {
  const id = paste ? 'edit.pasteAttributes' : 'edit.removeAttributes'
  return {
    id,
    family: 'clip',
    title: paste ? 'Paste Attributes' : 'Remove Attributes',
    prefix: paste ? 'pasteAttributes' : 'removeAttributes',
    preview: ['picture', 'timeline'],
    layout: attributeRows(paste),
    defaults: async (ctx) => {
      const read = await engineDefaults(ctx, id)
      return read ? { ...read.params, info: read.info } : noAttributes(paste)
    },
    toParams: (draft, ctx) => attributesParams(draft, ctx, paste),
  }
}

/** Upstream's `hold_on()`. */
export const HOLD_ON = [
  ['in', 'In Point'],
  ['out', 'Out Point'],
  ['playhead', 'Playhead'],
  ['sourceTimecode', 'Source Timecode'],
  ['sequenceTime', 'Sequence Time'],
] as const

/** Whether the hold reads its Timecode field (upstream draws it, and `finish()` keeps it, only then). */
export const holdsAtTimecode = (holdOn: unknown) => holdOn === 'sourceTimecode' || holdOn === 'sequenceTime'
const holding = (draft: Draft) => draft.enabled !== false

/**
 * Clip ▸ Video Options ▸ Frame Hold Options… (`frameHold`): Hold On, where (In Point, Out Point,
 * Playhead, Source Timecode, Sequence Time), the Timecode for the last two, and Hold Filters,
 * all disabled while Hold On is off. It opens on the first selected clip's hold (`dialogDefaults`:
 * `inspect()` does not show a clip's hold).
 */
const frameHold: DialogSpec = {
  id: 'clip.frameHoldOptions',
  family: 'clip',
  title: 'Frame Hold Options',
  prefix: 'frameHold',
  preview: ['picture'],
  layout: [
    { kind: 'check', field: 'enabled', label: 'Hold On' },
    { kind: 'radio', field: 'holdOn', label: 'Hold On', options: HOLD_ON, enabled: holding },
    { kind: 'text', field: 'timecode', label: 'Timecode:', width: 120, enabled: holding, shown: (draft) => holdsAtTimecode(draft.holdOn) },
    { kind: 'check', field: 'holdFilters', label: 'Hold Filters', enabled: holding },
  ],
  defaults: async (ctx) => (await engineDefaults(ctx, 'clip.frameHoldOptions'))?.params ?? { enabled: true, holdOn: 'in', timecode: '00:00:00:00', holdFilters: false },
  toParams: (draft, ctx) => {
    const params: Params = { clips: selectedClips(ctx), enabled: draft.enabled !== false, holdOn: typeof draft.holdOn === 'string' ? draft.holdOn : 'in', holdFilters: draft.holdFilters === true }
    if (holdsAtTimecode(params.holdOn)) params.timecode = String(draft.timecode ?? '')
    return params
  },
}

/** Upstream's processing options (Field Options). */
export const PROCESSING = [
  ['none', 'None'],
  ['alwaysDeinterlace', 'Always Deinterlace'],
  ['flickerRemoval', 'Flicker Removal'],
] as const

/** Clip ▸ Video Options ▸ Field Options… (`fieldOptions`): Reverse Field Dominance and the processing, opening on upstream's defaults. */
const fieldOptions: DialogSpec = {
  id: 'clip.fieldOptions',
  family: 'clip',
  title: 'Field Options',
  prefix: 'fieldOptions',
  preview: ['picture'],
  layout: [
    { kind: 'check', field: 'reverseFieldDominance', label: 'Reverse Field Dominance' },
    { kind: 'heading', label: 'Processing Options' },
    // Upstream registers each option by its own id (`{}.processing.none`).
    { kind: 'radio', field: 'processing', label: 'Processing Options', options: PROCESSING, optionUpstream: (value) => [`{}.processing.${value}`] },
  ],
  defaults: () => ({ reverseFieldDominance: false, processing: 'none' }),
  toParams: (draft, ctx) => ({ clips: selectedClips(ctx), reverseFieldDominance: draft.reverseFieldDominance === true, processing: typeof draft.processing === 'string' ? draft.processing : 'none' }),
}

/** Upstream's Audio Gain rows: the mode and its label. */
export const AUDIO_GAIN_MODES = [
  ['set', 'Set Gain to:'],
  ['adjust', 'Adjust Gain by:'],
  ['normalizeMax', 'Normalize Max Peak to:'],
  ['normalizeAll', 'Normalize All Peaks to:'],
] as const

/** OK's params for Audio Gain (upstream's `apply`): the mode and its row's dB (Adjust's for any other mode), naming the selected clips. */
export function audioGainParams(draft: Draft, ctx: DialogContext): Params {
  const mode = AUDIO_GAIN_MODES.some(([each]) => each === draft.mode) ? String(draft.mode) : 'adjust'
  return { clips: selectedClips(ctx), mode, db: Number(draft[mode]) || 0 }
}

/**
 * What Audio Gain's Peak Amplitude is read again for (upstream reads it per revision; the
 * selection is what it measures): never a playhead move or another inspect() of the same document.
 */
export const audioPeakKey = (revision: number | null, film: Pick<FilmInfo, 'selection'> | null) => `${revision ?? ''}:${(film?.selection ?? []).join(',')}`

/** Peak Amplitude as upstream prints it (`{p:.1} dB`, or — without one). */
export const peakText = (peakDb: unknown) => (typeof peakDb === 'number' && Number.isFinite(peakDb) ? `${peakDb.toFixed(1)} dB` : '—')

/**
 * Clip ▸ Audio Options ▸ Audio Gain… (`audioGain`, upstream `dialogs.rs` `audio_gain`): Set Gain
 * to, Adjust Gain by, Normalize Max Peak to, and Normalize All Peaks to, each a radio with its dB
 * (−96 to 96, one decimal), and the selection's Peak Amplitude (`clip.audioPeak`, read per
 * revision). Its draft stays for the next time (upstream's `app.ui.audio_gain`), Adjust first.
 */
const audioGain: DialogSpec = {
  id: 'clip.audioGain',
  family: 'clip',
  title: 'Audio Gain',
  prefix: 'audioGain',
  upstream: 'audioGain',
  preview: ['sound'],
  buttons: { ok: 'audioGain.ok', cancel: 'audioGain.cancel' },
  remembers: true,
  controls: [
    ...AUDIO_GAIN_MODES.flatMap(([mode, label]) => [
      { field: mode, label, upstream: [`audioGain.${mode}`] },
      { field: `${mode}.value`, label, upstream: [`audioGain.${mode}.value`] },
    ]),
    { field: 'peak', label: 'Peak Amplitude', upstream: ['audioGain.peak'] },
  ],
  defaults: () => rememberedDraft('clip.audioGain') ?? { mode: 'adjust', set: 0, adjust: 0, normalizeMax: 0, normalizeAll: 0 },
  toParams: audioGainParams,
}

/** The media items Interpret Footage acts on (upstream `open_interpret`): the params' `items`, the Project panel's selection, or the selected clips' items. */
export function interpretItems(ctx: DialogContext): number[] {
  const given = ctx.params.items
  if (Array.isArray(given)) return given.filter((each): each is number => typeof each === 'number')
  const project = ctx.session?.projectSelection ?? []
  if (project.length) return [...project]
  const film = ctx.film
  if (!film) return []
  const clips = new Map(film.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip.item]))
  const items: number[] = []
  for (const id of film.selection) {
    const item = clips.get(id)
    // Upstream's `dedup`: a run of one item's clips (a clip and its linked audio) once.
    if (item != null && items[items.length - 1] !== item) items.push(item)
  }
  return items
}

/** What Interpret Footage shows beside its draft: the detected colour space's label, and the colour spaces offered. */
export type InterpretInfo = { detected: string; spaces: Array<readonly [string, string]> }

/**
 * Clip ▸ Modify ▸ Interpret Footage… (`colorDialog`, upstream `color_dialogs.rs`): the media colour
 * space read from the file's metadata, and Use file metadata or one colour space as the override,
 * the first item's override chosen. It opens with `items` too (the Project panel's item menu);
 * with a `colorSpace` it runs at once, as upstream's route.
 */
const interpretFootage: DialogSpec = {
  id: 'clip.interpretFootage',
  family: 'clip',
  title: 'Interpret Footage',
  prefix: 'colorDialog',
  upstream: 'colorDialog',
  preview: ['picture', 'project'],
  buttons: { ok: 'colorDialog.ok', cancel: 'colorDialog.cancel' },
  opens: (params) => params.colorSpace === undefined,
  controls: [
    { field: 'space.auto', label: 'Use file metadata', upstream: ['colorDialog.space.auto'] },
    { field: 'space', label: 'Colour space', upstream: ['colorDialog.space.{}'] },
  ],
  // The items are the draft's, fixed when it opens: a selection made meanwhile changes nothing.
  dependsOn: (ctx) => ({ sequence: ctx.film?.activeSequence ?? null }),
  defaults: async (ctx) => {
    const items = interpretItems(ctx)
    const [color, spaces] = await Promise.all([
      items.length ? (ctx.query('media.colorInfo', { item: items[0] }) as Promise<{ override?: unknown; detectedLabel?: unknown } | null>).catch(() => null) : Promise.resolve(null),
      (ctx.query('color.spaces', {}) as Promise<{ colorSpaces?: Array<{ id?: unknown; label?: unknown }> } | null>).catch(() => null),
    ])
    const info: InterpretInfo = {
      detected: typeof color?.detectedLabel === 'string' ? color.detectedLabel : '—',
      spaces: (spaces?.colorSpaces ?? []).flatMap((space) => (typeof space.id === 'string' ? [[space.id, typeof space.label === 'string' ? space.label : space.id] as const] : [])),
    }
    return { items, colorSpace: typeof color?.override === 'string' ? color.override : 'auto', info }
  },
  toParams: (draft) => ({ items: Array.isArray(draft.items) ? draft.items : [], colorSpace: typeof draft.colorSpace === 'string' ? draft.colorSpace : 'auto' }),
}

export const CLIP_DIALOGS: readonly DialogSpec[] = [speedDuration, attributes(true), attributes(false), frameHold, fieldOptions, audioGain, interpretFootage]
