// Upstream's sequence dialogs (`panels/sequence_settings.rs`, `panels/color_dialogs.rs`
// `open_sequence`): Sequence ▸ Sequence Settings…, File ▸ New ▸ Sequence…, and Sequence ▸ Color
// Management…, each one's title, draft (`open`, `open_new`), fields (`show`), and params
// (`changes()`, `new_sequence_params`). Imports carry `.ts` so `node --test` loads this module as it is.
import type { DialogContext, DialogSpec, DialogStep, Draft, FieldOption, FieldRow, Params } from './registry.ts'

/** Upstream's hover text on what it draws greyed, as its rebranded catalog keys read (`i18n/upstream/*.tsv`), so `phrase()` translates them. */
export const NOT_YET = 'Not supported in Kition Film yet'
export const LINEAR = 'Kition Film always composites in linear light'

/** A timebase upstream lists: frames per second as `num`/`den`, its label (`23.976`), and whether it has drop-frame timecode. */
export type Timebase = { num: number; den: number; label: string; dropFrame: boolean }

/** The settings upstream's `changes()` compares (the draft's keys), with the sequence's name. */
export type SequenceKeys = {
  name: string
  fpsNum: number
  fpsDen: number
  width: number
  height: number
  dropFrame: boolean
  mix: string
  sampleRate: number
  maxRenderQuality: boolean
  workingSpace: string
  wideGamut: boolean
  autoToneMap: boolean
}

/** What the dialog shows beside its draft (`dialogDefaults`' `info`). */
export type SequenceInfo = {
  /** What OK compares the draft with: the active sequence and its name (New Sequence: the defaults and a blank name). */
  current: SequenceKeys
  par: readonly [number, number]
  previewCodec: string
  maxBitDepth: boolean
  audioDisplaySamples: boolean
  timebases: readonly Timebase[]
  workingSpaces: ReadonlyArray<readonly [string, string]>
}

/** `SequenceSettings::default()`, for a draft the engine did not answer. */
const DEFAULT_KEYS: SequenceKeys = { name: '', fpsNum: 24_000, fpsDen: 1001, width: 1920, height: 1080, dropFrame: false, mix: 'Stereo', sampleRate: 48_000, maxRenderQuality: false, workingSpace: 'rec709', wideGamut: false, autoToneMap: true }
const DEFAULT_INFO: SequenceInfo = {
  current: DEFAULT_KEYS,
  par: [1, 1],
  previewCodec: 'ProRes 422',
  maxBitDepth: false,
  audioDisplaySamples: true,
  timebases: [],
  workingSpaces: [
    ['rec709', 'Rec. 709'],
    ['rec2100-pq', 'Rec. 2100 PQ'],
    ['rec2100-hlg', 'Rec. 2100 HLG'],
  ],
}

/** Upstream's `SAMPLE_RATES` and `MIXES`. */
export const SAMPLE_RATES = [32_000, 44_100, 48_000, 88_200, 96_000] as const
export const MIXES = ['Stereo', 'Mono', '5.1', 'Adaptive'] as const

/** A draft's `info`, as the engine answered it. */
export const sequenceInfo = (draft: Draft): SequenceInfo => {
  const info = (draft.info ?? {}) as Partial<SequenceInfo>
  return { ...DEFAULT_INFO, ...info, current: { ...DEFAULT_KEYS, ...(info.current ?? {}) } }
}

/** The draft's timebase (upstream's `rate()`: `FrameRate::sane`, 23.976 for a rate that is not positive). */
export function draftRate(draft: Draft): { num: number; den: number } {
  const num = Number(draft.fpsNum)
  const den = Number(draft.fpsDen)
  return num > 0 && den > 0 ? { num, den } : { num: 24_000, den: 1001 }
}

/** Upstream's `FrameRate::supports_drop_frame`: an NTSC (x/1001) rate whose timecode counts a multiple of 30 frames a second. */
export const supportsDropFrame = ({ num, den }: { num: number; den: number }) => den === 1001 && Math.max(1, Math.floor((num + den - 1) / den)) % 30 === 0

/** Upstream's `FrameRate::label`: `24`, or `23.976` (three decimals, trailing zeros dropped). */
export const rateLabel = ({ num, den }: { num: number; den: number }) => (den === 1 ? String(num) : String(Number((num / den).toFixed(3))))

/** Upstream's `aspect`: "16:9", or "1.90:1" when the reduced ratio has no small integer form. */
export function aspect(width: number, height: number): string {
  let a = width
  let b = height
  while (b !== 0) [a, b] = [b, a % b]
  const g = Math.max(1, a)
  const [x, y] = [width / g, height / g]
  if (x <= 64 && y <= 64) return `${x}:${y}`
  return height > 0 ? `${(width / height).toFixed(2)}:1` : ''
}

/** Upstream's `par_label`. */
export function parLabel([a, b]: readonly [number, number]): string {
  if (a === b) return 'Square Pixels (1.0)'
  return b > 0 ? `Custom (${(a / b).toFixed(4)})` : 'Custom'
}

/** Upstream's `timecode_formats`: drop-frame and non-drop-frame timecode for the NTSC rates, plain timecode otherwise. */
export function timecodeFormats(rate: { num: number; den: number }): FieldOption[] {
  const values = { rate: rateLabel(rate) }
  return supportsDropFrame(rate)
    ? [
        ['df', '{rate} fps Drop-Frame Timecode', values],
        ['ndf', '{rate} fps Non Drop-Frame Timecode', values],
      ]
    : [['tc', '{rate} fps Timecode', values]]
}

/** The Display Format the draft shows (`df`, `ndf`, or `tc`). */
export const displayFormat = (draft: Draft) => (supportsDropFrame(draftRate(draft)) ? (draft.dropFrame === true ? 'df' : 'ndf') : 'tc')

/**
 * Upstream's `changes()`: the `sequence.settings` params where `draft` differs from `current`
 * (and its name), so OK sends only what changed; empty when nothing did. A blank name keeps the
 * current one; drop-frame travels only for a rate that has it; a new frame size carries Scale
 * Motion.
 */
export function sequenceChanges(draft: Draft, current: SequenceKeys): Params {
  const params: Params = {}
  const name = String(draft.name ?? '').trim()
  if (name && name !== current.name) params.name = name
  const rate = draftRate(draft)
  if (rate.num !== current.fpsNum || rate.den !== current.fpsDen) params.fps = rate.num / rate.den
  const width = Number(draft.width)
  const height = Number(draft.height)
  if (width !== current.width || height !== current.height) {
    params.width = width
    params.height = height
    params.scaleMotion = draft.scaleMotion === true
  }
  const dropFrame = draft.dropFrame === true && supportsDropFrame(rate)
  if (dropFrame !== (current.dropFrame && supportsDropFrame({ num: current.fpsNum, den: current.fpsDen }))) params.dropFrame = dropFrame
  if (draft.mix !== current.mix) params.mix = draft.mix
  if (Number(draft.sampleRate) !== current.sampleRate) params.sampleRate = Number(draft.sampleRate)
  if ((draft.maxRenderQuality === true) !== current.maxRenderQuality) params.maxRenderQuality = draft.maxRenderQuality === true
  if (draft.workingSpace !== current.workingSpace) params.workingSpace = draft.workingSpace
  if ((draft.wideGamut === true) !== current.wideGamut) params.wideGamut = draft.wideGamut === true
  if ((draft.autoToneMap === true) !== current.autoToneMap) params.autoToneMap = draft.autoToneMap === true
  return params
}

/** A track count (upstream's `DragValue` from 0 to 256, and `.min(256)` on OK). */
const trackCount = (value: unknown) => Math.max(0, Math.min(256, Math.round(Number(value) || 0)))

/**
 * Upstream's `new_sequence_params`: `sequence.new`'s params (a blank name lets the command
 * name it), then `sequence.settings` on the new sequence for what that command has no param for
 * (drop-frame timecode, Maximum Render Quality), only when they are not the defaults.
 */
export function newSequenceSteps(draft: Draft, defaults: SequenceKeys = DEFAULT_KEYS): DialogStep[] {
  const rate = draftRate(draft)
  const params: Params = {}
  const name = String(draft.name ?? '').trim()
  if (name) params.name = name
  params.width = Number(draft.width)
  params.height = Number(draft.height)
  params.fps = rate.num / rate.den
  params.sampleRate = Number(draft.sampleRate)
  params.mix = draft.mix
  params.video = trackCount(draft['tracks.video'])
  params.audio = trackCount(draft['tracks.audio'])
  // What is left: what the new sequence has against the defaults with its rate, size, and sample rate.
  const after: SequenceKeys = { ...defaults, name, fpsNum: rate.num, fpsDen: rate.den, width: Number(draft.width), height: Number(draft.height), sampleRate: Number(draft.sampleRate) }
  const all = sequenceChanges(draft, after)
  const rest = Object.fromEntries(Object.entries(all).filter(([key]) => key === 'dropFrame' || key === 'maxRenderQuality'))
  return [{ command: 'sequence.new', params }, ...(Object.keys(rest).length ? [{ command: 'sequence.settings', params: rest }] : [])]
}

/** What upstream's `defaults()` answers for `command` (the `dialogDefaults` extra), or null. */
async function engineDraft(ctx: DialogContext, command: string): Promise<Draft | null> {
  const answer = (await ctx.read?.('dialogDefaults', command).catch(() => null)) as { params?: unknown; info?: unknown } | null | undefined
  return answer && typeof answer.params === 'object' && answer.params ? { ...(answer.params as Draft), info: answer.info ?? null } : null
}

/** The draft Sequence Settings or New Sequence opens with: the engine's, the track counts under their fields' keys. */
async function settingsDraft(ctx: DialogContext, command: string, newSequence: boolean): Promise<Draft> {
  const read = (await engineDraft(ctx, command)) ?? { ...DEFAULT_KEYS, tab: 'general', newSequence, video: 3, audio: 3, scaleMotion: true, info: DEFAULT_INFO }
  const { video, audio, ...rest } = read
  return { ...rest, 'tracks.video': video ?? 3, 'tracks.audio': audio ?? 3 }
}

/** The Timebase list: the engine's (upstream's 15, the sequence's own rate first when it is not one of them). */
const timebaseOptions = (draft: Draft): FieldOption[] => {
  const listed = sequenceInfo(draft).timebases
  const rate = draftRate(draft)
  const all = listed.some((each) => each.num === rate.num && each.den === rate.den) ? listed : [{ ...rate, label: rateLabel(rate), dropFrame: supportsDropFrame(rate) }, ...listed]
  return all.map((each) => [`${each.num}/${each.den}`, '{rate} frames/second', { rate: each.label }] as const)
}

/** A new timebase starts on its usual timecode (drop-frame for the NTSC rates); the current one again keeps the Display Format chosen. */
function setTimebase(draft: Draft, value: unknown): Draft {
  const [num, den] = String(value).split('/').map(Number)
  if (!(num > 0 && den > 0)) return draft
  const rate = draftRate(draft)
  if (rate.num === num && rate.den === den) return draft
  return { ...draft, fpsNum: num, fpsDen: den, dropFrame: supportsDropFrame({ num, den }) }
}

/** The Sample Rate list: upstream's five, the draft's own first when it is not one of them. */
const sampleRateOptions = (draft: Draft): FieldOption[] => {
  const rate = Number(draft.sampleRate)
  const rates: number[] = (SAMPLE_RATES as readonly number[]).includes(rate) ? [...SAMPLE_RATES] : [rate, ...SAMPLE_RATES]
  return rates.map((hz) => [String(hz), '{rate} Hz', { rate: String(hz) }] as const)
}

/** Upstream's Number of Channels for a channel format. */
const channelCount = (mix: unknown) => (mix === 'Mono' ? '1' : mix === '5.1' ? '6' : mix === 'Adaptive' ? '—' : '2')

const off = () => false
const fixed = (field: string, label: string, text: (draft: Draft) => string, look: 'list' | 'value' = 'list', width?: number): FieldRow => ({ kind: 'fixed', field, label, look, text, hint: NOT_YET, enabled: off, width })

/** Upstream's `general` tab: the name, Timebase, and the Video, Audio, and Video Previews sections. */
const GENERAL: readonly FieldRow[] = [
  { kind: 'text', field: 'name', label: 'Sequence Name:', width: 260 },
  fixed('editingMode', 'Editing Mode:', () => 'Custom', 'list', 260),
  {
    kind: 'choice',
    field: 'timebase',
    label: 'Timebase:',
    upstream: ['sequenceSettings.timebase', 'sequenceSettings.timebase.option.{}/{}'],
    width: 260,
    options: timebaseOptions,
    value: (draft) => {
      const rate = draftRate(draft)
      return `${rate.num}/${rate.den}`
    },
    change: setTimebase,
  },
  {
    kind: 'section',
    label: 'Video',
    rows: [
      {
        kind: 'row',
        label: 'Frame Size:',
        rows: [
          { kind: 'number', field: 'width', label: 'Frame Size: horizontal', bare: true, unit: 'horizontal', min: 1, max: 32_768, step: 1, width: 132 },
          { kind: 'number', field: 'height', label: 'Frame Size: vertical', bare: true, unit: 'vertical', min: 1, max: 32_768, step: 1, width: 120 },
          { kind: 'fixed', field: 'aspect', label: 'Aspect', look: 'text', text: (draft) => aspect(Number(draft.width) || 0, Number(draft.height) || 0) },
        ],
      },
      { kind: 'check', field: 'scaleMotion', label: 'Scale motion effects proportionally when changing frame size' },
      fixed('par', 'Pixel Aspect Ratio:', (draft) => parLabel(sequenceInfo(draft).par), 'list', 260),
      fixed('fields', 'Fields:', () => 'No Fields (Progressive Scan)', 'list', 260),
      {
        kind: 'choice',
        field: 'videoDisplay',
        label: 'Display Format:',
        upstream: ['sequenceSettings.videoDisplay', 'sequenceSettings.videoDisplay.option.{}'],
        width: 260,
        options: (draft) => timecodeFormats(draftRate(draft)),
        disabledOptions: ['Feet + Frames 16mm', 'Feet + Frames 35mm', 'Frames'],
        hint: NOT_YET,
        value: displayFormat,
        change: (draft, value) => ({ ...draft, dropFrame: value === 'df' }),
      },
    ],
  },
  {
    kind: 'section',
    label: 'Audio',
    rows: [
      {
        kind: 'row',
        rows: [
          { kind: 'choice', field: 'channelFormat', label: 'Channel Format:', upstream: ['sequenceSettings.channelFormat', 'sequenceSettings.channelFormat.option.{}'], width: 120, options: MIXES.map((mix) => [mix, mix] as const), value: (draft) => draft.mix, change: (draft, value) => ({ ...draft, mix: value }) },
          fixed('channels', 'Number of Channels:', (draft) => channelCount(draft.mix), 'list', 60),
        ],
      },
      {
        kind: 'choice',
        field: 'sampleRate',
        label: 'Sample Rate:',
        upstream: ['sequenceSettings.sampleRate', 'sequenceSettings.sampleRate.option.{}'],
        width: 260,
        options: sampleRateOptions,
        value: (draft) => String(draft.sampleRate),
        change: (draft, value) => ({ ...draft, sampleRate: Number(value) }),
      },
      fixed('audioDisplay', 'Display Format:', (draft) => (sequenceInfo(draft).audioDisplaySamples ? 'Audio Samples' : 'Milliseconds'), 'list', 260),
    ],
  },
  {
    kind: 'section',
    label: 'Video Previews',
    rows: [
      { kind: 'row', rows: [fixed('previewFormat', 'Preview File Format:', () => 'QuickTime', 'list', 260), { kind: 'inert', field: 'configure', label: 'Configure…', upstream: [], hint: NOT_YET, enabled: off }] },
      fixed('previewCodec', 'Codec:', (draft) => sequenceInfo(draft).previewCodec, 'list', 260),
      fixed('previewWidth', 'Width:', (draft) => String(draft.width), 'value'),
      { kind: 'row', rows: [fixed('previewHeight', 'Height:', (draft) => String(draft.height), 'value'), { kind: 'inert', field: 'reset', label: 'Reset', upstream: [], hint: NOT_YET, enabled: off }] },
      {
        kind: 'row',
        rows: [
          { kind: 'check', field: 'maxBitDepth', label: 'Maximum Bit Depth', enabled: off, hint: NOT_YET, value: (draft) => sequenceInfo(draft).maxBitDepth },
          { kind: 'check', field: 'maxRenderQuality', label: 'Maximum Render Quality' },
        ],
      },
      { kind: 'check', field: 'linearColor', label: 'Composite in Linear Color', enabled: off, hint: LINEAR, value: () => true },
    ],
  },
]

/** The working colour spaces the engine lists. */
const workingSpaces = (draft: Draft) => sequenceInfo(draft).workingSpaces

/** Upstream's `color` tab. */
const COLOR: readonly FieldRow[] = [
  { kind: 'choice', field: 'workingSpace', label: 'Working Color Space:', upstream: ['sequenceSettings.workingSpace', 'sequenceSettings.workingSpace.option.{}'], width: 220, options: workingSpaces },
  { kind: 'check', field: 'wideGamut', label: 'Wide gamut color (composite in BT.2020)' },
  { kind: 'check', field: 'autoToneMap', label: 'Auto Tone Map Media (HDR and log into SDR)' },
]

/** Upstream's `vr` tab, greyed "not yet". */
const VR: readonly FieldRow[] = [
  fixed('vr.projection', 'Projection:', () => 'None', 'list', 200),
  fixed('vr.layout', 'Layout:', () => 'Monoscopic', 'list', 200),
  {
    kind: 'row',
    label: 'Captured View:',
    enabled: false,
    rows: [
      { ...fixed('vr.horizontal', 'Horizontal', () => '0°', 'value'), labelAfter: true },
      { ...fixed('vr.vertical', 'Vertical', () => '0°', 'value'), labelAfter: true },
    ] as FieldRow[],
  },
]

/** New Sequence's Tracks tab: how many video and audio tracks it starts with. */
const TRACKS: readonly FieldRow[] = [
  { kind: 'number', field: 'tracks.video', label: 'Video:', unit: 'tracks', min: 0, max: 256, step: 1, width: 160 },
  { kind: 'number', field: 'tracks.audio', label: 'Audio:', unit: 'tracks', min: 0, max: 256, step: 1, width: 160 },
]

const tabUpstream = () => 'sequenceSettings.tab.{}'

/** The active sequence (what the dialog compares with); the selections do not change what it does. */
const onSequence = (ctx: DialogContext) => ({ sequence: ctx.film?.activeSequence ?? null })

/**
 * Sequence ▸ Sequence Settings… (`sequenceSettings`, upstream `open`): General, Color Management,
 * and VR Properties (greyed) on the active sequence. OK sends `sequence.settings` with only what
 * changed (`changes()`), one undo step; nothing changed, it closes and runs nothing.
 */
const sequenceSettings: DialogSpec = {
  id: 'sequence.settings',
  family: 'sequence',
  title: 'Sequence Settings',
  prefix: 'sequenceSettings',
  upstream: 'sequenceSettings',
  preview: ['picture', 'timeline'],
  buttons: { ok: 'sequenceSettings.ok', cancel: 'sequenceSettings.cancel' },
  // A peer's change to a field left alone shows, and OK compares with the live sequence (show() re-reads it).
  rebase: true,
  sequenceBound: true,
  layout: [
    {
      kind: 'tabs',
      field: 'tab',
      upstream: tabUpstream,
      tabs: [
        { id: 'general', label: 'General', rows: GENERAL },
        { id: 'color', label: 'Color Management', rows: COLOR },
        { id: 'vr', label: 'VR Properties', rows: VR },
      ],
    },
  ],
  dependsOn: onSequence,
  defaults: (ctx) => settingsDraft(ctx, 'sequence.settings', false),
  toParams: (draft) => {
    const params = sequenceChanges(draft, sequenceInfo(draft).current)
    return Object.keys(params).length ? params : null
  },
}

/**
 * File ▸ New ▸ Sequence… (upstream `open_new`): the General tab from the default settings, named
 * "Sequence NN" as `sequence.new` would, and a Tracks tab (3 video, 3 audio). OK runs
 * `sequence.new`, then `sequence.settings` for drop-frame timecode and Maximum Render Quality
 * when they are on: two history steps then, as upstream.
 */
const newSequence: DialogSpec = {
  id: 'sequence.new',
  family: 'sequence',
  title: 'New Sequence',
  prefix: 'sequenceSettings',
  upstream: 'sequenceSettings',
  preview: ['project', 'timeline'],
  buttons: { ok: 'sequenceSettings.ok', cancel: 'sequenceSettings.cancel' },
  layout: [
    {
      kind: 'tabs',
      field: 'tab',
      upstream: tabUpstream,
      tabs: [
        { id: 'general', label: 'General', rows: GENERAL },
        { id: 'tracks', label: 'Tracks', rows: TRACKS },
      ],
    },
  ],
  // What it makes follows the draft only.
  dependsOn: () => null,
  defaults: (ctx) => settingsDraft(ctx, 'sequence.new', true),
  steps: (draft) => newSequenceSteps(draft, sequenceInfo(draft).current),
}

/**
 * Sequence ▸ Color Management… (`colorDialog`, upstream `color_dialogs.rs` `open_sequence`): the
 * working colour space, wide gamut, and Auto Tone Map Media of the active sequence. OK sends all
 * three to `sequence.colorSettings`, one undo step (none when nothing changed, as the engine does).
 */
const colorSettings: DialogSpec = {
  id: 'sequence.colorSettings',
  family: 'sequence',
  title: 'Sequence Color Management',
  prefix: 'colorDialog',
  upstream: 'colorDialog',
  preview: ['picture'],
  buttons: { ok: 'colorDialog.ok', cancel: 'colorDialog.cancel' },
  rebase: true,
  sequenceBound: true,
  layout: [
    { kind: 'heading', label: 'Working Color Space' },
    { kind: 'radio', field: 'working', label: 'Working Color Space', options: (draft) => sequenceInfo(draft).workingSpaces, value: (draft) => draft.workingSpace, change: (draft, value) => ({ ...draft, workingSpace: value }) },
    { kind: 'check', field: 'wideGamut', label: 'Wide gamut color (composite in BT.2020)' },
    { kind: 'check', field: 'autoToneMap', label: 'Auto tone map media (HDR and log into SDR)' },
  ],
  dependsOn: onSequence,
  defaults: async (ctx) => {
    const read = (await engineDraft(ctx, 'sequence.colorSettings')) ?? { workingSpace: 'rec709', wideGamut: false, autoToneMap: true, info: { workingSpaces: DEFAULT_INFO.workingSpaces } }
    // What the draft was read from (the rebase's baseline): the sequence's pipeline.
    const current = { workingSpace: read.workingSpace, wideGamut: read.wideGamut, autoToneMap: read.autoToneMap }
    return { ...read, info: { ...((read.info as object | null) ?? {}), current } }
  },
  toParams: (draft) => ({ workingSpace: String(draft.workingSpace ?? 'rec709'), wideGamut: draft.wideGamut === true, autoToneMap: draft.autoToneMap === true }),
}

export const SEQUENCE_DIALOGS: readonly DialogSpec[] = [sequenceSettings, newSequence, colorSettings]
