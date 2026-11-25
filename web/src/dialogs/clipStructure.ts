// Upstream's clip structure dialogs: Nest (Nested Sequence Name), Make and Edit Subclip, Modify
// ▸ Audio Channels and Timecode, and New Offline File (`panels/clip_dialogs.rs`); Edit Offline
// File and Source Settings (`panels/menu_dialogs.rs`); Synchronize and Merge Clips
// (`panels/multicam.rs` `show_dialog`, whose Create Multi-Camera arm is wave 3). Each one's title
// and prefix (`meta()`), draft (`defaults()`, through the engine's `dialogDefaults` where upstream
// reads the session), fields (`show`), and params (`finish()`, multicam.rs's OK). Imports carry
// `.ts` so `node --test` loads this module as it is.
import { engineDefaults } from './clip.ts'
import type { DialogContext, DialogSpec, Draft, FieldRow, Params } from './registry.ts'

/**
 * Upstream's `format_timecode_frames(frame, FrameRate::from_f64(fps), false)`: non-drop, counting
 * `timecode_base` frames a second (the rate rounded up, 24 without one), the frames in three
 * digits from a base of 100.
 */
export function framesTimecode(frame: number, fps: number) {
  const rate = fps > 0 ? fps : 24
  const base = Math.max(1, Math.ceil(Math.round(rate * 1000) / 1000 - 1e-9))
  const total = Math.max(0, Math.trunc(frame))
  const ff = total % base
  const seconds = Math.floor(total / base)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}:${pad(ff, base >= 100 ? 3 : 2)}`
}

/** A draft's `info` field, as an object (upstream's `d.info`). */
const infoOf = (draft: Draft) => (draft.info && typeof draft.info === 'object' ? (draft.info as Record<string, unknown>) : {})
/** The media rate a subclip dialog counts its frames in (`d.info["fps"]`, 24 without one). */
const subclipFps = (draft: Draft) => (typeof infoOf(draft).fps === 'number' && (infoOf(draft).fps as number) > 0 ? (infoOf(draft).fps as number) : 24)
/** The draft without what the dialog only shows (`info`), as the JSON the command takes. */
const withoutInfo = (draft: Draft): Params => {
  const { info: _info, ...params } = draft
  return params
}
/** The engine's draft for `command` (`{...params, info}`), or `fallback` (upstream's with nothing selected). */
async function opened(ctx: DialogContext, command: string, fallback: Draft): Promise<Draft> {
  const read = await engineDefaults(ctx, command)
  return read ? { ...read.params, ...(read.info == null ? {} : { info: read.info }) } : fallback
}
/** What a dialog whose targets are in its draft follows: the active sequence only. */
const sequenceOnly = (ctx: DialogContext) => ({ sequence: ctx.film?.activeSequence ?? null })

/**
 * Clip ▸ Nest… (`nest`, upstream's "Nested Sequence Name"): the name, ready to type over (focused
 * as it opens), Enter is OK; it opens on the engine's next free "Nested Sequence NN".
 */
const nest: DialogSpec = {
  id: 'clip.nest',
  family: 'clipStructure',
  title: 'Nested Sequence Name',
  prefix: 'nest',
  preview: ['timeline', 'project'],
  layout: [{ kind: 'text', field: 'name', label: 'Name:', width: 240, autoFocus: true }],
  defaults: (ctx) => opened(ctx, 'clip.nest', { name: '' }),
  toParams: (draft) => ({ name: String(draft.name ?? '') }),
}

/** Start and End in media frames, each with its timecode (upstream's `frames`), and Restrict Trims. */
const subclipRows: FieldRow[] = [
  { kind: 'frames', field: 'startFrame', label: 'Start:', fps: subclipFps },
  { kind: 'frames', field: 'endFrame', label: 'End:', fps: subclipFps },
  { kind: 'check', field: 'restrictTrims', label: 'Restrict Trims To Subclip Boundaries' },
]

/**
 * Clip ▸ Make Subclip… (`makeSubclip`): the name and the range of what would be subclipped (the
 * Source monitor's clip, the Project selection's media, or the selected clip), as the engine's
 * `subclip_defaults` reads them, and Restrict Trims, on.
 */
const makeSubclip: DialogSpec = {
  id: 'clip.makeSubclip',
  family: 'clipStructure',
  title: 'Make Subclip',
  prefix: 'makeSubclip',
  preview: ['project'],
  layout: [{ kind: 'text', field: 'name', label: 'Name:', width: 240 }, ...subclipRows],
  defaults: (ctx) => opened(ctx, 'clip.makeSubclip', { name: null, startFrame: null, endFrame: null, restrictTrims: true, info: { fps: null } }),
  toParams: withoutInfo,
}

/**
 * Clip ▸ Edit Subclip… (`editSubclip`): the Project panel's first subclip, its name shown, its
 * range in its parent's media frames, Restrict Trims, and Convert to Master Clip.
 */
const editSubclip: DialogSpec = {
  id: 'clip.editSubclip',
  family: 'clipStructure',
  title: 'Edit Subclip',
  prefix: 'editSubclip',
  preview: ['project'],
  layout: [{ kind: 'readout', label: 'Subclip:', testId: 'name', value: (draft) => (typeof infoOf(draft).name === 'string' ? (infoOf(draft).name as string) : null) }, ...subclipRows, { kind: 'check', field: 'convertToMaster', label: 'Convert to Master Clip' }],
  // The subclip is the draft's, fixed when it opens.
  dependsOn: sequenceOnly,
  defaults: (ctx) => opened(ctx, 'clip.editSubclip', {}),
  toParams: withoutInfo,
}

/** Upstream's `formats()`. */
export const CHANNEL_FORMATS = [
  ['mono', 'Mono'],
  ['stereo', 'Stereo'],
  ['5.1', '5.1'],
  ['adaptive', 'Adaptive'],
] as const

/** What Audio Channels shows beside its draft: the source's channel count, and whether it maps project items (else timeline clips). */
export function channelInfo(draft: Draft): { channels: number; items: boolean } {
  const info = infoOf(draft)
  return { channels: Math.max(1, typeof info.channels === 'number' ? Math.trunc(info.channels) : 2), items: info.items === true }
}

const channelLists = (raw: unknown): number[][] => (Array.isArray(raw) ? raw.map((each) => (Array.isArray(each) ? each.filter((c): c is number => typeof c === 'number') : [])) : [])
const channelList = (raw: unknown): number[] => (Array.isArray(raw) ? raw.filter((c): c is number => typeof c === 'number') : [])

/** Upstream's `AudioChannelMap::for_format(format, n)`: mono a clip per channel, stereo pairs, 5.1 and adaptive one clip of every channel. */
export function formatClips(format: string, channels: number): number[][] {
  const n = Math.max(1, channels)
  const all = Array.from({ length: n }, (_, c) => c)
  if (format === 'mono') return all.map((c) => [c])
  if (format === 'stereo') return all.filter((c) => c % 2 === 0).map((c) => (c + 1 < n ? [c, c + 1] : [c]))
  return [all]
}

/** A format radio clicked: the format, and its default map (upstream sets both). */
export const channelFormat = (draft: Draft, format: string): Draft => ({ ...draft, format, clips: formatClips(format, channelInfo(draft).channels) })

/** Number of Audio Clips set to `count` (1 to `channels`): clips added on the next channel, the last one past it; clips dropped from the end. */
export function addAudioClips(draft: Draft, count: number, channels: number): Draft {
  const clips = channelLists(draft.clips)
  const want = Math.max(1, Math.trunc(count))
  while (clips.length < want) clips.push([Math.min(clips.length, Math.max(0, channels - 1))])
  return { ...draft, clips: clips.slice(0, want) }
}

/** Clip `clip`'s channel `channel` checked or not (the timeline form keeps one list, `channels`), kept sorted. */
export function setChannel(draft: Draft, clip: number, channel: number, on: boolean): Draft {
  const toggle = (list: number[]) => [...list.filter((c) => c !== channel), ...(on ? [channel] : [])].sort((a, b) => a - b)
  if (!channelInfo(draft).items) return { ...draft, channels: toggle(channelList(draft.channels)) }
  return { ...draft, clips: channelLists(draft.clips).map((list, index) => (index === clip ? toggle(list) : list)) }
}

/**
 * Clip ▸ Modify ▸ Audio Channels… (`audioChannels`): for the Project panel's first item with
 * audio, the Clip Channel Format, the Number of Audio Clips, and the clip × source channel matrix
 * (`clips`, its own map or stereo pairs); for the timeline's audio clips, the source channels
 * they play (`channels`).
 */
const audioChannels: DialogSpec = {
  id: 'clip.audioChannels',
  family: 'clipStructure',
  title: 'Modify Clip: Audio Channels',
  prefix: 'audioChannels',
  preview: ['timeline', 'project'],
  controls: [
    ...CHANNEL_FORMATS.map(([format, label]) => ({ field: `format.${format}`, label, upstream: ['{}.format.{}'] })),
    { field: 'count', label: 'Number of Audio Clips:', upstream: ['{}.count'] },
    // The matrix's cells are the media's: one id for every clip × channel box.
    { field: 'clip.channel', label: 'Media Source Channels', upstream: ['{}.clip.{}.ch.{}'] },
    { field: 'channel', label: 'Source channels the selected audio clips play:', upstream: ['{}.clip.0.ch.{}'] },
  ],
  defaults: (ctx) => opened(ctx, 'clip.audioChannels', { channels: [0, 1], info: { channels: 2, items: false } }),
  toParams: (draft) => (channelInfo(draft).items ? { format: typeof draft.format === 'string' ? draft.format : 'stereo', clips: channelLists(draft.clips) } : { channels: channelList(draft.channels) }),
}

/** Clip ▸ Modify ▸ Timecode… (`timecode`): Set Timecode, Tape Name, and Use the file's timecode, which drops the timecode (`finish()`). */
const modifyTimecode: DialogSpec = {
  id: 'clip.setTimecode',
  family: 'clipStructure',
  title: 'Modify Clip: Timecode',
  prefix: 'timecode',
  preview: ['project'],
  layout: [
    { kind: 'text', field: 'timecode', label: 'Set Timecode:', width: 120 },
    { kind: 'text', field: 'tapeName', label: 'Tape Name:', width: 200 },
    { kind: 'check', field: 'reset', label: "Use the file's timecode" },
  ],
  defaults: (ctx) => opened(ctx, 'clip.setTimecode', { timecode: '00:00:00:00', tapeName: '' }),
  toParams: (draft) => {
    const params = withoutInfo(draft)
    if (params.reset === true) delete params.timecode
    return params
  },
}

const hasVideo = (draft: Draft) => draft.video !== false

/**
 * File ▸ New ▸ Offline File… (`offlineFile`): the file's and the clip's names, tape, description,
 * what it contains, its picture (the active sequence's, disabled without video), Media Start,
 * and Duration; an empty Clip Name is dropped (`finish()`), so the engine names it.
 */
const newOfflineFile: DialogSpec = {
  id: 'item.newOfflineFile',
  family: 'clipStructure',
  title: 'New Offline File',
  prefix: 'offlineFile',
  preview: ['project'],
  layout: [
    { kind: 'text', field: 'fileName', label: 'File Name:', width: 220 },
    { kind: 'text', field: 'name', label: 'Clip Name:', width: 220 },
    { kind: 'text', field: 'tapeName', label: 'Tape Name:', width: 220 },
    { kind: 'text', field: 'description', label: 'Description:', width: 220 },
    {
      kind: 'row',
      label: 'Contains:',
      rows: [
        { kind: 'check', field: 'video', label: 'Video' },
        { kind: 'check', field: 'audio', label: 'Audio' },
      ],
    },
    { kind: 'number', field: 'width', label: 'Width:', min: 16, max: 16384, step: 1, unit: 'px', enabled: hasVideo },
    { kind: 'number', field: 'height', label: 'Height:', min: 16, max: 16384, step: 1, unit: 'px', enabled: hasVideo },
    { kind: 'number', field: 'fps', label: 'Frame Rate:', min: 1, max: 240, step: 0.001, unit: 'fps', enabled: hasVideo },
    { kind: 'text', field: 'timecode', label: 'Media Start:', width: 120 },
    { kind: 'number', field: 'seconds', label: 'Duration:', min: 0.05, max: 86_400, step: 0.01, unit: 's' },
  ],
  defaults: (ctx) =>
    opened(ctx, 'item.newOfflineFile', {
      fileName: 'Offline.mov',
      name: '',
      tapeName: '',
      description: '',
      video: true,
      audio: true,
      width: ctx.film?.width ?? 1920,
      height: ctx.film?.height ?? 1080,
      fps: ctx.film?.fps ?? 24,
      timecode: '00:00:00:00',
      seconds: 10,
    }),
  toParams: (draft) => {
    const params = withoutInfo(draft)
    if (params.name === '') delete params.name
    return params
  },
}

/** Clip ▸ Edit Offline… (`editOffline`, `menu_dialogs.rs`): the Project panel's first item, its media name and offline fields. */
const editOffline: DialogSpec = {
  id: 'clip.editOffline',
  family: 'clipStructure',
  title: 'Edit Offline File',
  prefix: 'editOffline',
  preview: ['project'],
  layout: [
    { kind: 'text', field: 'mediaName', label: 'Media Name:', width: 220 },
    { kind: 'text', field: 'tapeName', label: 'Tape Name:', width: 220 },
    { kind: 'text', field: 'description', label: 'Description:', width: 220 },
    { kind: 'text', field: 'scene', label: 'Scene:', width: 220 },
    { kind: 'text', field: 'shot', label: 'Shot/Take:', width: 220 },
    { kind: 'text', field: 'logNote', label: 'Log Note:', width: 220 },
  ],
  // The item is the draft's, fixed when it opens.
  dependsOn: sequenceOnly,
  defaults: (ctx) => opened(ctx, 'clip.editOffline', {}),
  toParams: withoutInfo,
}

/**
 * Clip ▸ Source Settings… (`sourceSettings`, `menu_dialogs.rs`): the codec and why it has no
 * settings here (the engine's `clip.sourceSettings` query, which keeps it shut when it fails);
 * upstream's info dialog has one OK.
 */
const sourceSettings: DialogSpec = {
  id: 'clip.sourceSettings',
  family: 'clipStructure',
  title: 'Source Settings',
  prefix: 'sourceSettings',
  preview: ['none'],
  note: 'shows information; nothing to preview',
  hideOk: true,
  onlyOk: true,
  cancelLabel: 'OK',
  controls: [],
  // Upstream's defaults run the query with `?`: when it fails the dialog does not open, and the
  // error goes to the status bar (invoke's).
  defaults: async (ctx) => {
    if (!ctx.ask) throw new Error('no document')
    return { info: await ctx.ask('clip.sourceSettings', {}) }
  },
  toParams: () => null,
}

/** Upstream's `methods()`: Synchronize Point. */
export const SYNC_METHODS = [
  ['in', 'In Points'],
  ['out', 'Out Points'],
  ['timecode', 'Timecode'],
  ['marker', 'Clip Marker'],
  ['audio', 'Audio'],
] as const

/**
 * multicam.rs's OK, exactly: the method, the offset, and Ignore Hours, a marker when typed; Merge
 * Clips its items, Remove Audio from AV Clip, and a name when there is one; Synchronize the
 * reference track when typed (the engine syncs the timeline's selection, which the preview
 * follows).
 */
export function syncParams(draft: Draft, merge: boolean): Params {
  const params: Params = { method: typeof draft.method === 'string' ? draft.method : 'audio', offset: Math.trunc(Number(draft.offset) || 0), ignoreHours: draft.ignoreHours === true }
  if (typeof draft.marker === 'string' && draft.marker !== '') params.marker = draft.marker
  if (merge) {
    params.items = Array.isArray(draft.items) ? draft.items.filter((each) => typeof each === 'number') : []
    params.removeVideoAudio = draft.removeVideoAudio === true
    if (typeof draft.name === 'string' && draft.name !== '') params.name = draft.name
  } else if (typeof draft.track === 'string' && draft.track !== '') params.track = draft.track
  return params
}

/** Upstream's `SyncDraft::default()` for the Project selection (what the engine answers with no project). */
const syncFallback = (ctx: DialogContext): Draft => ({ items: [...(ctx.session?.projectSelection ?? [])], name: '', method: 'audio', ignoreHours: false, marker: '', offset: 0, track: '', removeVideoAudio: false, info: { names: [] } })

const syncControls = (merge: boolean) => [
  ...(merge ? [{ field: 'name', label: 'Clip Name:', upstream: ['{}.name'] }] : []),
  ...SYNC_METHODS.map(([method, label]) => ({ field: `method.${method}`, label, upstream: ['{}.method.{}'] })),
  { field: 'ignoreHours', label: 'Ignore Hours', upstream: ['{}.ignoreHours'] },
  { field: 'marker', label: 'first marker', upstream: ['{}.marker'] },
  { field: 'offset', label: merge ? 'Offset Audio by:' : 'Offset:', upstream: ['{}.offset'] },
  merge ? { field: 'removeVideoAudio', label: 'Remove Audio from AV Clip', upstream: ['merge.removeVideoAudio'] } : { field: 'track', label: 'Reference track:', upstream: ['sync.track'] },
]

/**
 * Clip ▸ Synchronize… (`sync`) and Merge Clips… (`merge`), upstream `multicam.rs` `show_dialog`:
 * Merge's Clip Name (`"<first> - Merged"`) and its clips; the Synchronize Point (In, Out,
 * Timecode with Ignore Hours, Clip Marker with its name, Audio), the Offset in frames; then
 * Synchronize's Reference track or Merge's Remove Audio from AV Clip.
 */
function sync(merge: boolean): DialogSpec {
  const id = merge ? 'clip.mergeClips' : 'clip.synchronize'
  return {
    id,
    family: 'clipStructure',
    title: merge ? 'Merge Clips' : 'Synchronize Clips',
    prefix: merge ? 'merge' : 'sync',
    preview: merge ? ['project'] : ['timeline'],
    controls: syncControls(merge),
    // Merge's items are the draft's, fixed when it opens; Synchronize follows the selection.
    ...(merge ? { dependsOn: sequenceOnly } : {}),
    defaults: async (ctx) => {
      const draft = await opened(ctx, id, syncFallback(ctx))
      return merge ? draft : { ...draft, name: '' }
    },
    toParams: (draft) => syncParams(draft, merge),
  }
}

export const CLIP_STRUCTURE_DIALOGS: readonly DialogSpec[] = [nest, makeSubclip, editSubclip, audioChannels, modifyTimecode, newOfflineFile, editOffline, sourceSettings, sync(false), sync(true)]
