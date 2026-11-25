// Upstream's track, sequence tool, and new item dialogs: Sequence ▸ Add Tracks… and Delete
// Tracks… (`panels/dialogs.rs` `add_tracks`, `delete_tracks`, opened by `menus.rs`' routes), and
// Sequence ▸ Normalize Mix Track… and Simplify Sequence…, File ▸ New ▸ Color Matte…, and the
// Project panel's Color Matte Color (`panels/menu_dialogs.rs` `defaults`, `show`, `run`). Each
// one's title, draft, fields, and params. Imports carry `.ts` so `node --test` loads this module
// as it is.
import { engineDefaults } from './clip.ts'
import type { DialogContext, DialogSpec, Draft, FieldRow, Params } from './registry.ts'

/** A draft's `info` field, as an object. */
const infoOf = (draft: Draft) => (draft.info && typeof draft.info === 'object' ? (draft.info as Record<string, unknown>) : {})
/** The draft without what the dialog only shows (`info`), as the JSON the command takes. */
const withoutInfo = (draft: Draft): Params => {
  const { info: _info, ...params } = draft
  return params
}
/** What a dialog on the active sequence follows: that sequence only (its draft holds the rest). */
const onSequence = (ctx: DialogContext) => ({ sequence: ctx.film?.activeSequence ?? null })

// ---- Add Tracks

type TrackKindKey = 'video' | 'audio' | 'submix'

/** The active sequence's track names by kind, as the engine read them (`info.tracks`), else the Timeline's video and audio tracks. */
function trackNames(draft: Draft, ctx: DialogContext, kind: TrackKindKey): string[] {
  const listed = (infoOf(draft).tracks as Record<string, unknown> | undefined)?.[kind]
  if (Array.isArray(listed)) return listed.map(String)
  if (kind === 'submix') return []
  return (ctx.film?.tracks ?? []).filter((track) => track.kind === kind).map((track) => track.name)
}

/** An amount upstream's `DragValue` allows: whole, 0 to 99. */
const amount = (value: unknown) => Math.max(0, Math.min(99, Math.round(Number(value) || 0)))
/** A placement: how many tracks come before the new ones, at most every track there is (upstream's `min(tracks.len())`). */
const placement = (value: unknown, count: number) => Math.max(0, Math.min(count, Math.trunc(Number(value) || 0)))

/** Upstream's Track type lists, `[id, label]`. */
const AUDIO_TYPES = [
  ['standard', 'Standard'],
  ['5.1', '5.1'],
  ['adaptive', 'Adaptive'],
  ['mono', 'Mono'],
] as const
const SUBMIX_TYPES = [
  ['stereo', 'Stereo'],
  ['5.1', '5.1'],
  ['adaptive', 'Adaptive'],
  ['mono', 'Mono'],
] as const

/** One group of Add Tracks: "Add video tracks" and its Amount, Placement, and (audio and submix) Track type. */
function addGroup(kind: TrackKindKey, title: string, types?: ReadonlyArray<readonly [string, string]>): FieldRow {
  const after = `${kind}After`
  const typeKey = `${kind}Type`
  const rows: FieldRow[] = [
    {
      kind: 'number',
      field: `${kind}.amount`,
      label: 'Amount',
      min: 0,
      max: 99,
      step: 1,
      width: 120,
      value: (draft) => draft[kind],
      change: (draft, value) => ({ ...draft, [kind]: amount(value) }),
    },
    {
      kind: 'choice',
      field: `${kind}.placement`,
      label: 'Placement',
      upstream: [`addTracks.${kind}.placement`, `addTracks.${kind}.placement.option.{}`],
      // Nowhere to choose from while the sequence has no track of the kind.
      enabled: (draft, ctx) => trackNames(draft, ctx ?? { film: null, session: null, params: {}, query: async () => null }, kind).length > 0,
      options: (draft, ctx) => {
        const names = trackNames(draft, ctx, kind)
        return [['0', 'Before First Track'] as const, ...names.map((name, index) => [String(index + 1), 'After {name}', { name }] as const)]
      },
      value: (draft, ctx) => String(placement(draft[after], trackNames(draft, ctx, kind).length)),
      change: (draft, value) => ({ ...draft, [after]: Math.max(0, Math.trunc(Number(value) || 0)) }),
    },
  ]
  if (types)
    rows.push({
      kind: 'choice',
      field: `${kind}.type`,
      label: 'Track type',
      upstream: [`addTracks.${kind}.type`, `addTracks.${kind}.type.option.{}`],
      options: types,
      value: (draft) => (types.some(([id]) => id === draft[typeKey]) ? draft[typeKey] : types[0][0]),
      change: (draft, value) => ({ ...draft, [typeKey]: value }),
    })
  return { kind: 'section', label: title, rows }
}

/**
 * Sequence ▸ Add Tracks… (`addTracks`): video, audio, and submix groups, each an Amount, a
 * Placement (Before First Track or after one of the tracks; greyed while there is none of the
 * kind), and for audio and submix a Track type. It opens on one video and one audio track after
 * the last ones (`menus.rs`). OK sends all eight params; with every amount 0 it closes and runs
 * nothing, as upstream.
 */
const addTracks: DialogSpec = {
  id: 'sequence.addTracks',
  family: 'tracks',
  title: 'Add Tracks',
  prefix: 'addTracks',
  upstream: 'addTracks',
  preview: ['timeline'],
  buttons: { ok: 'addTracks.ok', cancel: 'addTracks.cancel' },
  // A peer's new track moves "after the last track" with it, and another active sequence's tracks
  // are listed (upstream lists the live tracks each frame; it keeps the dialog open on another
  // sequence, and placements left alone here follow that sequence's last tracks).
  rebase: true,
  layout: [addGroup('video', 'Add video tracks'), addGroup('audio', 'Add audio tracks', AUDIO_TYPES), addGroup('submix', 'Add audio submix tracks', SUBMIX_TYPES)],
  dependsOn: onSequence,
  defaults: async (ctx) => {
    const read = await engineDefaults(ctx, 'sequence.addTracks')
    if (read) return { ...read.params, info: read.info }
    // Without the engine: upstream's AddTracksDraft after the Timeline's last tracks.
    const count = (kind: 'video' | 'audio') => (ctx.film?.tracks ?? []).filter((track) => track.kind === kind).length
    const current = { videoAfter: count('video'), audioAfter: count('audio'), submixAfter: 0 }
    return { video: 1, audio: 1, audioType: 'standard', submix: 0, submixType: 'stereo', ...current, info: { current } }
  },
  toParams: (draft, ctx) => {
    const video = amount(draft.video)
    const audio = amount(draft.audio)
    const submix = amount(draft.submix)
    // Nothing asked for: OK closes the dialog and changes nothing.
    if (video === 0 && audio === 0 && submix === 0) return null
    const at = (kind: TrackKindKey) => placement(draft[`${kind}After`], trackNames(draft, ctx, kind).length)
    return {
      video,
      videoAfter: at('video'),
      audio,
      audioAfter: at('audio'),
      audioType: String(draft.audioType ?? 'standard'),
      submix,
      submixAfter: at('submix'),
      submixType: String(draft.submixType ?? 'stereo'),
    }
  },
}

// ---- Delete Tracks

/** Upstream's track names for a kind, `V1`, `V2`… by place (`delete_tracks`' `names`). */
const placeNames = (ctx: DialogContext, kind: 'video' | 'audio') => (ctx.film?.tracks ?? []).filter((track) => track.kind === kind).map((_, index) => `${kind === 'video' ? 'V' : 'A'}${index + 1}`)

/** One kind of Delete Tracks: its strong title, the checkbox, and the track list (greyed until checked). */
const deleteGroup = (kind: 'video' | 'audio', title: string, label: string): FieldRow[] => [
  { kind: 'heading', label: title },
  { kind: 'check', field: kind, label },
  {
    kind: 'choice',
    field: `${kind}.target`,
    // No label drawn (upstream's list sits under its checkbox), the kind's title as its name.
    label: title,
    bare: true,
    upstream: [`deleteTracks.${kind}.target`, `deleteTracks.${kind}.option.empty`, `deleteTracks.${kind}.option.{}`],
    width: 170,
    enabled: (draft) => draft[kind] === true,
    options: (_, ctx) => [['empty', 'All Empty Tracks'] as const, ...placeNames(ctx, kind).map((name) => [name, name] as const)],
    value: (draft) => draft[`${kind}Target`],
    change: (draft, value) => ({ ...draft, [`${kind}Target`]: value }),
  },
]

/**
 * Sequence ▸ Delete Tracks… (`deleteTracks`): Delete Video Tracks and Delete Audio Tracks, each
 * with All Empty Tracks or one track. OK is off until one is checked and sends only the kinds
 * checked. Upstream asks for no confirmation (rule 6), and neither does this.
 */
const deleteTracks: DialogSpec = {
  id: 'sequence.deleteTracks',
  family: 'tracks',
  title: 'Delete Tracks',
  prefix: 'deleteTracks',
  upstream: 'deleteTracks',
  preview: ['timeline'],
  buttons: { ok: 'deleteTracks.ok', cancel: 'deleteTracks.cancel' },
  layout: [...deleteGroup('video', 'Video Tracks', 'Delete Video Tracks'), ...deleteGroup('audio', 'Audio Tracks', 'Delete Audio Tracks')],
  dependsOn: onSequence,
  okEnabled: (draft) => draft.video === true || draft.audio === true,
  // On another active sequence (upstream keeps the dialog open and lists its tracks), a track the
  // new sequence lacks gives way to All Empty Tracks, where upstream's list would show a name it
  // no longer has.
  sequenceChanged: (draft, ctx) => {
    let next = draft
    for (const kind of ['video', 'audio'] as const) {
      const key = `${kind}Target`
      const target = String(draft[key] ?? 'empty')
      if (target !== 'empty' && !placeNames(ctx, kind).includes(target)) next = { ...next, [key]: 'empty' }
    }
    return next
  },
  // `menus.rs` opens it on `DeleteTracksDraft::default()` each time.
  defaults: () => ({ video: false, videoTarget: 'empty', audio: false, audioTarget: 'empty' }),
  toParams: (draft) => {
    const params: Params = {}
    if (draft.video === true) params.video = String(draft.videoTarget ?? 'empty')
    if (draft.audio === true) params.audio = String(draft.audioTarget ?? 'empty')
    return Object.keys(params).length ? params : null
  },
}

// ---- Normalize Mix Track

type Translate = (key: string, values?: Record<string, string | number>) => string
const db = (value: number) => `${value >= 0 && !Object.is(value, -0) ? '+' : ''}${value.toFixed(1)} dB`
const level = (value: number) => `${value.toFixed(1)} dB`

/** What the strip says of a Normalize Mix Track preview: the gain it applies to the Mix, and the peak before and after (`sequence.normalizeMixTrack`'s answer). */
export function normalizeLines(result: unknown, t: Translate): string[] {
  const answer = result as { gainDb?: unknown; peakBeforeDb?: unknown; peakDb?: unknown } | null
  if (!answer || typeof answer.gainDb !== 'number' || typeof answer.peakBeforeDb !== 'number' || typeof answer.peakDb !== 'number') return []
  return [t('preview.normalizeGain', { gain: db(answer.gainDb), before: level(answer.peakBeforeDb), after: level(answer.peakDb) })]
}

/** Sequence ▸ Normalize Mix Track… (`normalizeMix`): the level the Mix peaks at, −96 to +24 dB (0 dBFS). */
const normalizeMix: DialogSpec = {
  id: 'sequence.normalizeMixTrack',
  family: 'menu',
  title: 'Normalize Mix Track',
  prefix: 'normalizeMix',
  preview: ['sound'],
  layout: [{ kind: 'row', label: 'Normalize Mix Track to:', rows: [{ kind: 'number', field: 'db', label: 'Normalize Mix Track to:', bare: true, min: -96, max: 24, step: 0.1, unit: 'dB', width: 110 }] }],
  dependsOn: onSequence,
  defaults: () => ({ db: 0 }),
  toParams: (draft) => ({ db: Math.max(-96, Math.min(24, Number(draft.db) || 0)) }),
  resultLines: normalizeLines,
}

// ---- Simplify Sequence

/**
 * Sequence ▸ Simplify Sequence… (`simplify`, OK "Simplify"): the copy's name, what to remove, Move
 * clips down, and Keep. OK makes the simplified copy and opens it, as upstream's `run()` sends
 * the params. The Timeline draws the copy compared with its source (`previewTimeline`).
 */
const simplify: DialogSpec = {
  id: 'sequence.simplify',
  family: 'menu',
  title: 'Simplify Sequence',
  prefix: 'simplify',
  okLabel: 'Simplify',
  preview: ['timeline', 'project'],
  copiesSequence: true,
  // A peer renaming the sequence renames the copy's default name with it, and another active
  // sequence (upstream keeps the dialog open) gives its own name, while the person left it alone.
  rebase: true,
  layout: [
    { kind: 'text', field: 'name', label: 'Sequence Name:', width: 240 },
    { kind: 'heading', label: 'Remove' },
    { kind: 'check', field: 'removeDisabled', label: 'Disabled clips' },
    { kind: 'check', field: 'removeEmptyTracks', label: 'Empty tracks' },
    { kind: 'check', field: 'closeGaps', label: 'Gaps' },
    { kind: 'check', field: 'removeVideoEffects', label: 'Video effects' },
    { kind: 'check', field: 'removeAudioEffects', label: 'Audio effects' },
    { kind: 'check', field: 'removeText', label: 'Text (graphics and captions)' },
    { kind: 'heading', label: 'Clips' },
    { kind: 'check', field: 'moveClipsDown', label: 'Move clips to the lowest track possible' },
    {
      kind: 'row',
      label: 'Keep:',
      rows: [
        {
          kind: 'radio',
          field: 'keep',
          label: 'Keep:',
          options: [
            ['both', 'Video and Audio'],
            ['video', 'Video Only'],
            ['audio', 'Audio Only'],
          ],
        },
      ],
    },
  ],
  dependsOn: onSequence,
  defaults: async (ctx) => {
    const read = await engineDefaults(ctx, 'sequence.simplify')
    if (read) return { ...read.params, info: read.info }
    const name = ctx.film?.name ? `${ctx.film.name} (Simplified)` : ''
    return { name, removeDisabled: true, removeEmptyTracks: true, closeGaps: false, moveClipsDown: false, removeVideoEffects: false, removeAudioEffects: false, removeText: false, keep: 'both', info: { current: { name } } }
  },
  toParams: withoutInfo,
}

// ---- New Color Matte and Color Matte Color

/** Upstream's colour row (`menu_dialogs.rs` `color`): the swatch that opens the picker, then the `#rrggbb` it holds. */
const colorRow: FieldRow = { kind: 'color', field: 'color', label: 'Color:' }

/**
 * File ▸ New ▸ Color Matte… (`colorMatte`): the colour, name, width and height (the active
 * sequence's), and duration. OK makes the matte in the Project panel; its preview is the new row
 * with its colour icon, and the matte itself in the strip (it is on no track, so the Program
 * monitor would show nothing new).
 */
const newColorMatte: DialogSpec = {
  id: 'item.newColorMatte',
  family: 'menu',
  title: 'New Color Matte',
  prefix: 'colorMatte',
  preview: ['project'],
  layout: [
    colorRow,
    { kind: 'text', field: 'name', label: 'Name:', width: 220 },
    { kind: 'number', field: 'width', label: 'Width:', min: 1, max: 16_384, step: 1, unit: 'px' },
    { kind: 'number', field: 'height', label: 'Height:', min: 1, max: 16_384, step: 1, unit: 'px' },
    { kind: 'number', field: 'seconds', label: 'Duration:', min: 0.04, max: 36_000, step: 0.01, unit: 's' },
  ],
  // What it makes follows the draft only.
  dependsOn: () => null,
  defaults: async (ctx) => {
    const read = await engineDefaults(ctx, 'item.newColorMatte')
    if (read) return { ...read.params }
    return { color: '#000000', name: 'Color Matte', width: ctx.film?.width || 1920, height: ctx.film?.height || 1080, seconds: 5 }
  },
  // Whole pixels: the engine reads the size as a whole number.
  toParams: (draft) => ({ color: String(draft.color ?? '#000000'), name: String(draft.name ?? ''), width: Math.max(1, Math.round(Number(draft.width) || 1)), height: Math.max(1, Math.round(Number(draft.height) || 1)), seconds: Number(draft.seconds) || 5 }),
  stripItem: (result) => {
    const item = (result as { item?: unknown } | null)?.item
    return typeof item === 'number' ? item : null
  },
}

/**
 * The Project panel's Color Matte Color (`matteColor`; a double-click on a Color Matte, upstream
 * `project_views.rs` `item_interactions`): the one matte selected and its colour. It does not
 * open with anything else selected (upstream's "select one Color Matte" in the status bar).
 */
const matteColor: DialogSpec = {
  id: 'project.matteColor',
  family: 'menu',
  title: 'Color Matte Color',
  prefix: 'matteColor',
  preview: ['project', 'picture'],
  // A peer's new colour shows while the person has not picked one.
  rebase: true,
  layout: [colorRow],
  // The matte is the draft's, fixed when it opens.
  dependsOn: () => null,
  defaults: async (ctx) => {
    const read = await engineDefaults(ctx, 'project.matteColor')
    if (!read) throw new Error('select one Color Matte')
    return { ...read.params, info: read.info }
  },
  toParams: (draft) => ({ item: draft.item, color: String(draft.color ?? '#000000') }),
}

export const TRACKS_DIALOGS: readonly DialogSpec[] = [addTracks, deleteTracks, normalizeMix, simplify, newColorMatte, matteColor]
