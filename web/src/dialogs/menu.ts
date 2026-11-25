// Upstream's Scene Edit Detection, Flash Cue Marker, Update Metadata, Properties, and Project
// Settings dialogs (`panels/menu_dialogs.rs` `defaults`, `show`, `run`), and the marker dialog a
// Markers row opens (Premiere's Marker dialog over the engine's `marker.edit`; upstream's panel
// opens none): each one's title, draft, fields, and params. Imports carry `.ts` so `node --test`
// loads this module as it is.
import type { FilmBin, FilmInfo, FilmMarker } from '../film.ts'
import { engineDefaults } from './clip.ts'
import type { DiffEntry, DiffPartName, PreviewCovers, PreviewDiff } from './preview.ts'
import { dialogFps, type DialogContext, type DialogSpec, type DialogStep, type Draft, type FieldRow, type Params } from './registry.ts'

/** A draft's `info` field, as an object. */
const infoOf = (draft: Draft) => (draft.info && typeof draft.info === 'object' ? (draft.info as Record<string, unknown>) : {})
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

// ---- Scene Edit Detection

/** Upstream's Scene Edit Detection draft (`defaults`). */
const SCENE_DETECT: Draft = { applyCuts: true, createSubclips: false, generateMarkers: false, sensitivity: 50 }

/**
 * Clip ▸ Scene Edit Detection… (`sceneDetect`, OK "Analyze"): apply a cut, create a subclip, or
 * generate a clip marker at each cut point found in the selected video clips, at a sensitivity
 * from 0 to 100. Its preview is a job on the scratch session, a few frames each animation frame
 * (the engine's stepped job), with its progress in the strip; the cuts on the Timeline, the
 * subclips in the Project panel, and the markers on the Source monitor's bar (or in the strip)
 * appear when it ends. Cancel ends the job with the preview. Analyze starts the document's own job
 * and closes the dialog, as upstream: the status bar shows its progress and its Cancel.
 */
const sceneDetect: DialogSpec = {
  id: 'clip.sceneEditDetection',
  family: 'menu',
  title: 'Scene Edit Detection',
  prefix: 'sceneDetect',
  okLabel: 'Analyze',
  preview: ['timeline', 'project', 'markers'],
  job: true,
  // On the web the document's own run is stepped too (a host without threads): its result lands
  // as one history step when the job ends, its progress in the status bar, as upstream's thread.
  okStatus: 'Scene Edit Detection: analysing in the background (see Progress)',
  layout: [
    { kind: 'check', field: 'applyCuts', label: 'Apply a cut at each detected cut point' },
    { kind: 'check', field: 'createSubclips', label: 'Create a subclip for each detected cut point' },
    { kind: 'check', field: 'generateMarkers', label: 'Generate clip markers at each detected cut point' },
    // Upstream's `Slider` (0 to 100), a number field with its scrub here.
    { kind: 'number', field: 'sensitivity', label: 'Sensitivity:', upstream: ['sceneDetect.sensitivity'], min: 0, max: 100, step: 1, width: 200 },
  ],
  defaults: () => ({ ...SCENE_DETECT }),
  // Upstream's run() sends the draft as it is (the engine analyses the timeline's selection).
  toParams: (draft) => ({
    applyCuts: draft.applyCuts === true,
    createSubclips: draft.createSubclips === true,
    generateMarkers: draft.generateMarkers === true,
    sensitivity: clamp(draft.sensitivity, 0, 100, 50),
  }),
  // Nothing chosen to do: nothing to preview; OK still runs, for the engine's "choose at least one".
  previewable: (draft) => draft.applyCuts === true || draft.createSubclips === true || draft.generateMarkers === true,
}

// ---- Flash Cue Marker

/**
 * Markers ▸ Add Flash Cue Marker… (`flashCue`): a name and comments for the flash cue marker the
 * engine adds at the playhead; an empty name is left out, so the engine names it "Cue Point n".
 */
const flashCue: DialogSpec = {
  id: 'marker.addFlashCue',
  family: 'menu',
  title: 'Flash Cue Marker',
  prefix: 'flashCue',
  preview: ['markers'],
  layout: [
    { kind: 'text', field: 'name', label: 'Name:', width: 220 },
    { kind: 'text', field: 'comment', label: 'Comments:', width: 220 },
  ],
  // The marker goes at the playhead of the sequence shown.
  dependsOn: (ctx) => ({ sequence: ctx.film?.activeSequence ?? null, playhead: ctx.film?.playhead ?? 0 }),
  defaults: () => ({ name: '', comment: '' }),
  toParams: (draft) => {
    const params: Params = { comment: text(draft.comment) }
    if (text(draft.name) !== '') params.name = text(draft.name)
    return params
  },
}

// ---- the marker dialog

/** Upstream's marker colours (`MARKER_FILTER`), each chip of the Markers panel's filter. */
export const MARKER_COLORS = ['Green', 'Red', 'Purple', 'Orange', 'Yellow', 'Blue', 'Cyan'] as const

/** The draft keys of the marker dialog, compared with a peer's change (`info.current`). */
const MARKER_KEYS = ['name', 'comment', 'color', 'duration'] as const

/** The marker `params.marker` names, or the one at the playhead (within half a frame). */
function markerOf(ctx: DialogContext): FilmMarker | null {
  const markers = ctx.film?.markers ?? []
  const named = ctx.params.marker
  if (typeof named === 'number') return markers.find((marker) => marker.id === named) ?? null
  const playhead = ctx.film?.playhead ?? 0
  const half = 0.5 / dialogFps(ctx)
  return markers.find((marker) => Math.abs(marker.start - playhead) < half) ?? null
}

/**
 * The marker dialog (`marker`, the engine's `marker.edit`), opened by a double-click on a Markers
 * row (Premiere's Marker dialog; upstream's panel opens none) or with no marker named on the one
 * at the playhead: its name, duration, comments, and colour. OK edits that marker of the active
 * sequence; the rulers and the Markers panel preview it.
 */
const editMarker: DialogSpec = {
  id: 'marker.edit',
  family: 'menu',
  title: 'Marker',
  prefix: 'marker',
  preview: ['markers'],
  // A peer's change to a field left alone shows; a field the person changed keeps their value.
  rebase: true,
  // A Markers row opens it on its marker; any other value runs the command at once (an agent's).
  opens: (params) => Object.keys(params).every((key) => key === 'marker'),
  layout: [
    { kind: 'text', field: 'name', label: 'Name:', width: 260, upstream: [] },
    { kind: 'timecode', field: 'duration', label: 'Duration:', upstream: [] },
    { kind: 'multiline', field: 'comment', label: 'Comments:', upstream: [] },
    {
      kind: 'choice',
      field: 'color',
      label: 'Color:',
      upstream: [],
      width: 160,
      // The filter's seven, and the marker's own colour when it is another label's.
      options: (draft) => {
        const listed = MARKER_COLORS.map((color) => [color, color] as const)
        const own = text(infoOf(draft).color)
        return own && !(MARKER_COLORS as readonly string[]).includes(own) ? [...listed, [own, own] as const] : listed
      },
    },
  ],
  dependsOn: (ctx) => ({ sequence: ctx.film?.activeSequence ?? null }),
  defaults: (ctx) => {
    const marker = markerOf(ctx)
    if (!marker) throw new Error(typeof ctx.params.marker === 'number' ? 'no such marker' : 'no marker at the playhead')
    const current = { name: marker.name, comment: marker.comment, color: marker.color, duration: marker.duration }
    return { marker: marker.id, ...current, info: { current, color: marker.color } }
  },
  toParams: (draft, ctx) => ({
    marker: draft.marker,
    name: text(draft.name),
    comment: text(draft.comment),
    color: text(draft.color),
    durationFrames: Math.max(0, Math.round(clamp(draft.duration, 0, Number.MAX_SAFE_INTEGER, 0) * dialogFps(ctx))),
  }),
  baseline: (draft) => {
    const current = infoOf(draft).current as Record<string, unknown> | undefined
    return current ? Object.fromEntries(MARKER_KEYS.map((key) => [key, current[key]])) : null
  },
}

// ---- Update Metadata

/** Each project item in `bin`, by id, with its name. */
function itemNames(bin: FilmBin | null | undefined, into = new Map<number, string>()) {
  for (const child of bin?.children ?? []) {
    if ('children' in child) itemNames(child, into)
    else into.set(child.item, child.name)
  }
  return into
}

/** The items Update Metadata writes for (upstream's `targets`): the Project selection, else the timeline's selected clips' items, each once. */
export function updateMetadataTargets(ctx: Pick<DialogContext, 'film' | 'session'>): number[] {
  const selected = ctx.session?.projectSelection ?? []
  if (selected.length) return [...selected]
  const film = ctx.film as (FilmInfo & { tracks: Array<{ clips: Array<{ id: number; item: number }> }> }) | null
  const out: number[] = []
  for (const clip of (film?.tracks ?? []).flatMap((track) => track.clips)) if ((film?.selection ?? []).includes(clip.id) && !out.includes(clip.item)) out.push(clip.item)
  return out
}

/**
 * Clip ▸ Update Metadata… (`updateMetadata`): upstream's confirmation, "Write the metadata of the
 * selected clip(s) (n) to XMP files next to their media?". It writes outside the project
 * (`PREVIEW_EXTERNAL`), so it never runs on the scratch session: the strip lists the clips whose
 * XMP file OK writes. OK runs it for the selection, as upstream's `{}`.
 */
const updateMetadata: DialogSpec = {
  id: 'clip.updateMetadata',
  family: 'menu',
  title: 'Update Metadata',
  prefix: 'updateMetadata',
  preview: ['summary'],
  controls: [],
  // Upstream's count, `max(project selection, timeline selection)`.
  defaults: (ctx) => ({ info: { count: Math.max(ctx.session?.projectSelection?.length ?? 0, ctx.film?.selection?.length ?? 0) } }),
  toParams: () => ({}),
  summary: (_, ctx, t) => {
    const names = itemNames(ctx.film?.root)
    return updateMetadataTargets(ctx).map((item) => t('preview.writesXmp', { name: names.get(item) ?? `#${item}` }))
  },
}

// ---- Properties

type Properties = {
  name?: string
  path?: string | null
  type?: string
  container?: string | null
  fileSize?: number | null
  duration?: { timecode?: string } | null
  dataRateKbps?: number | null
  video?: { codec?: string; width?: number; height?: number; pixelAspectRatio?: string; frameRateLabel?: string; pixelFormat?: string; color?: string } | null
  audio?: { codec?: string; sampleRate?: number; channels?: number } | null
}

const shown = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value))

/** Upstream's Properties lines for one file (`show`'s `line`: a line with no value is not drawn). */
export function propertyLines(raw: unknown, phrase: (text: string) => string): string[] {
  const v = (raw ?? {}) as Properties
  const lines: string[] = []
  const line = (key: string, value: string) => {
    if (value !== '' && value !== 'null') lines.push(`${phrase(key)}: ${value}`)
  }
  line('File Path', shown(v.path))
  line('Type', `${shown(v.type)} (${shown(v.container)})`)
  line('File Size', typeof v.fileSize === 'number' ? `${(v.fileSize / 1e6).toFixed(2)} MB` : '')
  line('Total Duration', shown(v.duration?.timecode))
  line('Average Data Rate', typeof v.dataRateKbps === 'number' ? `${v.dataRateKbps} kbit/s` : '')
  if (v.video && typeof v.video === 'object') {
    const x = v.video
    line('Video', `${shown(x.codec)} · ${shown(x.width)} x ${shown(x.height)} (${shown(x.pixelAspectRatio)}) · ${shown(x.frameRateLabel)} fps · ${shown(x.pixelFormat)}`)
    line('Colour', shown(x.color))
  }
  if (v.audio && typeof v.audio === 'object') {
    const x = v.audio
    line('Audio', phrase('{codec} · {rate} Hz · {n} channel(s)').replace('{codec}', shown(x.codec)).replace('{rate}', shown(x.sampleRate)).replace('{n}', shown(x.channels)))
  }
  return lines
}

/**
 * File ▸ Get Media File Properties for ▸ Selection… (`properties`, one Close): each selected
 * file's path, type, size, duration, data rate, video, colour, and audio (the engine's
 * `file.mediaProperties`); File… shows a file the host picks (`file.mediaPropertiesFile`). It
 * shows information; nothing to preview.
 */
const properties: DialogSpec = {
  id: 'file.mediaProperties',
  family: 'menu',
  title: 'Properties',
  prefix: 'properties',
  preview: ['none'],
  note: 'shows information; nothing to preview',
  // It opens on a picked file too (File…), with nothing selected: the selection's query says why it cannot.
  engine: false,
  hideOk: true,
  onlyOk: true,
  cancelLabel: 'Close',
  controls: [],
  defaults: async (ctx) => {
    if (Array.isArray(ctx.params.properties)) return { info: ctx.params.properties }
    if (!ctx.ask) throw new Error('no document')
    return { info: await ctx.ask('file.mediaProperties', {}) }
  },
  toParams: () => null,
}

// ---- Project Settings

const pair = (value: unknown): [number, number] => {
  const list = Array.isArray(value) ? value : []
  return [clamp(list[0], 0, 50, 0), clamp(list[1], 0, 50, 0)]
}
type Ingest = { enabled?: boolean; action?: string; destination?: string | null; preset?: string }
const ingestOf = (draft: Draft): Ingest => (draft.ingest && typeof draft.ingest === 'object' ? (draft.ingest as Ingest) : {})
const listed = (value: unknown, fallback: readonly string[]) => (Array.isArray(value) && value.length ? value.map(String) : fallback).map((each) => [each, each] as const)

/** One axis of a safe area: its percent box, `horizontal` or `vertical` after it (upstream's DragValue, 0 to 50 %). */
const safeAxis = (key: 'titleSafe' | 'actionSafe', axis: 0 | 1, area: string): FieldRow => {
  const name = axis === 0 ? 'horizontal' : 'vertical'
  return {
    kind: 'number',
    field: `${key}.${name}`,
    label: `${area} ${name}`,
    upstream: [`projectSettings.${key}.{}`],
    bare: true,
    suffix: '%',
    unit: name,
    min: 0,
    max: 50,
    step: 1,
    width: 150,
    value: (draft) => pair(draft[key])[axis],
    change: (draft, value) => {
      const next = pair(draft[key])
      next[axis] = clamp(value, 0, 50, next[axis])
      return { ...draft, [key]: next }
    },
  }
}

const GENERAL: readonly FieldRow[] = [
  { kind: 'heading', label: 'Video Rendering and Playback' },
  { kind: 'choice', field: 'renderer', label: 'Renderer:', width: 300, options: (draft) => listed(infoOf(draft).renderers, ['Kition Film GPU Acceleration (wgpu)', 'Kition Film Software Only (CPU)']) },
  { kind: 'heading', label: 'Video' },
  { kind: 'choice', field: 'videoDisplay', label: 'Display Format:', width: 220, options: (draft) => listed(infoOf(draft).videoDisplays, ['Timecode', 'Feet + Frames 35mm', 'Feet + Frames 16mm', 'Frames', 'Audio Samples', 'Seconds']) },
  { kind: 'heading', label: 'Audio' },
  {
    kind: 'choice',
    field: 'audioDisplay',
    label: 'Display Format:',
    width: 220,
    options: [
      ['Audio Samples', 'Audio Samples'],
      ['Milliseconds', 'Milliseconds'],
    ],
  },
  { kind: 'heading', label: 'Capture' },
  {
    kind: 'choice',
    field: 'captureFormat',
    label: 'Capture Format:',
    width: 220,
    options: [
      ['DV', 'DV'],
      ['HDV', 'HDV'],
    ],
  },
  { kind: 'heading', label: 'Action and Title Safe Areas' },
  { kind: 'row', label: 'Title Safe Area', rows: [safeAxis('titleSafe', 0, 'Title Safe Area'), safeAxis('titleSafe', 1, 'Title Safe Area')] },
  { kind: 'row', label: 'Action Safe Area', rows: [safeAxis('actionSafe', 0, 'Action Safe Area'), safeAxis('actionSafe', 1, 'Action Safe Area')] },
]

/** Upstream's ingest actions. */
const INGEST_ACTIONS = [
  ['copy', 'Copy'],
  ['transcode', 'Transcode'],
  ['createProxies', 'Create Proxies'],
  ['copyAndCreateProxies', 'Copy and Create Proxies'],
] as const

// The destination ("Next to the media") is a local folder: hidden on the web (rule 2), never drawn.
const INGEST: readonly FieldRow[] = [
  {
    kind: 'check',
    field: 'ingest.enabled',
    label: 'Ingest',
    upstream: ['projectSettings.ingest.enabled'],
    value: (draft) => ingestOf(draft).enabled === true,
    change: (draft, value) => ({ ...draft, ingest: { ...ingestOf(draft), enabled: value === true } }),
  },
  {
    kind: 'choice',
    field: 'ingest.action',
    label: 'Action:',
    upstream: ['projectSettings.ingest.action'],
    width: 220,
    options: INGEST_ACTIONS,
    value: (draft) => ingestOf(draft).action ?? 'createProxies',
    change: (draft, value) => ({ ...draft, ingest: { ...ingestOf(draft), action: String(value) } }),
  },
]

/** Project Settings' draft without the engine: the project's defaults (upstream's `ProjectSettings::default()`). */
const SETTINGS_FALLBACK = {
  renderer: 'Kition Film GPU Acceleration (wgpu)',
  videoDisplay: 'Timecode',
  audioDisplay: 'Audio Samples',
  captureFormat: 'DV',
  titleSafe: [20, 20],
  actionSafe: [10, 10],
  ingest: { enabled: false, action: 'createProxies', destination: null, preset: '' },
}

/** OK's commands: General's every value (upstream's run), then Ingest's when it changed. */
function settingsSteps(draft: Draft): DialogStep[] {
  const steps: DialogStep[] = [
    {
      command: 'file.projectSettings.general',
      params: {
        renderer: text(draft.renderer),
        videoDisplay: text(draft.videoDisplay),
        audioDisplay: draft.audioDisplay === 'Milliseconds' ? 'milliseconds' : 'samples',
        captureFormat: text(draft.captureFormat),
        titleSafe: pair(draft.titleSafe),
        actionSafe: pair(draft.actionSafe),
      },
    },
  ]
  if (JSON.stringify(draft.ingest ?? null) !== JSON.stringify(infoOf(draft).ingest ?? null)) steps.push({ command: 'project.ingestSettings', params: { ...ingestOf(draft) } })
  return steps
}

/**
 * File ▸ Project Settings ▸ General… and Ingest Settings… (`projectSettings`, one dialog on two
 * tabs): General's renderer, video and audio display formats, capture format, and the title and
 * action safe areas; Ingest's on or off and its action. Scratch Disks and the ingest destination
 * are local folders, hidden on the web. OK runs General with every value (no step when nothing
 * changed), then Ingest when it changed. The Program monitor previews the safe areas; the strip
 * names the settings changed.
 */
const projectSettings: DialogSpec = {
  id: 'file.projectSettings.general',
  aliases: ['project.ingestSettings'],
  family: 'menu',
  title: 'Project Settings',
  prefix: 'projectSettings',
  upstream: 'projectSettings',
  preview: ['picture', 'timeline'],
  // A peer's change to a setting left alone shows, and OK never undoes it.
  rebase: true,
  layout: [
    {
      kind: 'tabs',
      field: 'tab',
      lead: [{ kind: 'readout', label: 'Project:', testId: 'project', plain: true, value: (draft) => text(infoOf(draft).project) }],
      tabs: [
        { id: 'general', label: 'General', rows: GENERAL },
        { id: 'ingest', label: 'Ingest Settings', rows: INGEST },
      ],
    },
  ],
  // What it changes follows the draft and the document only.
  dependsOn: () => null,
  defaults: async (ctx) => {
    const command = ctx.command === 'project.ingestSettings' ? 'project.ingestSettings' : 'file.projectSettings.general'
    const read = await engineDefaults(ctx, command)
    if (read) return { ...read.params, info: read.info }
    return { ...SETTINGS_FALLBACK, tab: command === 'project.ingestSettings' ? 'ingest' : 'general', info: { project: ctx.film?.project ?? '', ingest: SETTINGS_FALLBACK.ingest, current: SETTINGS_FALLBACK } }
  },
  steps: (draft) => settingsSteps(draft),
}

// ---- the Source monitor's bar

type BarMarker = { start: number; color: string; mark?: 'added' | 'changed' }
type BarView = { item: number; media: number; markers: ReadonlyArray<{ start: number; color: string }> }

/**
 * What the Source monitor's bar draws of a preview's markers (Task 10's note): the markers of the
 * item it shows (the clip, or the media a subclip shows) that the preview adds or changes, at
 * their place (`start` in media ticks), marked; and what it `covers`, so the strip leaves those
 * out. A removed marker has no place on the bar, so the strip lists it.
 */
export function sourcePreviewMarkers(view: BarView, diff: PreviewDiff | null): { markers: readonly BarMarker[]; covers: PreviewCovers } {
  const ours = (entry: DiffEntry) => entry.ownerKind === 'item' && (entry.owner === view.item || entry.owner === view.media) && typeof entry.start === 'number'
  const covers: PreviewCovers = (part: DiffPartName, entry: DiffEntry) => part === 'markers' && ours(entry)
  if (!diff?.markers) return { markers: view.markers, covers }
  const added = (diff.markers.added ?? []).filter(ours).map((entry) => ({ start: entry.start as number, color: entry.color ?? '', mark: 'added' as const }))
  const changed = (diff.markers.changed ?? []).filter(ours).map((entry) => ({ start: entry.start as number, color: entry.color ?? '', mark: 'changed' as const }))
  return { markers: added.length || changed.length ? [...view.markers, ...added, ...changed] : view.markers, covers }
}

export const MENU_DIALOGS: readonly DialogSpec[] = [sceneDetect, flashCue, editMarker, updateMetadata, properties, projectSettings]
