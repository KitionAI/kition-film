import type { KitEngineInfo } from '@kition/kit-editor'

/** An effect on a clip, as `inspect()` summarizes it (Effect Controls reads the full list with `clipEffects`). */
export type FilmEffectSummary = { effect: string; enabled: boolean; masks: number; keyframed: string[] }

/** One clip on a track, in seconds. */
export type FilmClip = {
  id: number
  /** The project item it plays. */
  item: number
  name: string
  start: number
  duration: number
  /** Where it starts and ends in its source, in seconds. */
  sourceIn: number
  sourceOut: number
  speed: number
  reverse: boolean
  /** The clip it is linked to (its video's audio), or null. */
  link: number | null
  enabled: boolean
  gainDb: number
  label: string
  selected: boolean
  effects: FilmEffectSummary[]
  /** The Volume effect's level, in dB, which the waveform's rubber band shows. */
  volumeDb: number
  /** Its time interpolation (`frameSampling`, `frameBlending`, `opticalFlow`), or null when the engine does not say. */
  timeInterpolation: string | null
}

/** A transition on a track, in seconds. */
export type FilmTransition = { id: number; effect: string; start: number; duration: number }

export type FilmTrack = {
  id: number
  name: string
  kind: 'video' | 'audio'
  locked: boolean
  muted: boolean
  solo: boolean
  syncLock: boolean
  enabled: boolean
  clips: FilmClip[]
  transitions: FilmTransition[]
}

/** A sequence marker, in seconds. */
export type FilmMarker = { id: number; start: number; duration: number; kind: string; name: string; comment: string; color: string }

/** A split edit's marks (J and L cuts), in seconds, each null when unset. */
export type FilmSplit = { videoIn: number | null; videoOut: number | null; audioIn: number | null; audioOut: number | null }

/**
 * A project item in a bin. `stamp`: what a media item's pictures (a subclip's: its parent's) are
 * drawn from, as upstream's `item_revision` (its file, whether it is offline, its proxy shown);
 * its thumbnails are keyed on it, so they draw again after Make Offline or Link Media.
 */
export type FilmProjectItem = { item: number; name: string; type: string; duration: number; label: string; stamp?: string }
/** A bin and what it holds, in the project's order. */
export type FilmBin = { id: number; name: string; children: Array<FilmProjectItem | FilmBin> }

/** A search bin (File ▸ New ▸ Search Bin): a saved query and the items it matches now (`project.searchBins`). */
export type FilmSearchBin = { bin: number; name: string; items: number[] }

/** What the Film editor shows about the open project. */
export type FilmInfo = {
  name: string
  /** The project's name, which the header shows (upstream `header.rs`). */
  project: string
  width: number
  height: number
  fps: number
  /** One frame, in seconds. */
  frame: number
  dropFrame: boolean
  /** The sequence's audio sample rate, in Hz. */
  sampleRate: number
  duration: number
  playhead: number
  tracks: FilmTrack[]
  selection: number[]
  /** The sequence's In and Out marks, in seconds, or null. */
  in: number | null
  out: number | null
  markers: FilmMarker[]
  split: FilmSplit
  /** The project's bins and items. */
  root: FilmBin | null
  /** The item open in the Source monitor, or null. */
  sourceItem: number | null
  activeSequence: number | null
  canUndo: boolean
  canRedo: boolean
  summary: string
  /** The engine's time unit, for commands that take ticks. */
  ticksPerSecond: number
  /** Project Settings ▸ General's Title and Action Safe Areas, (horizontal, vertical) percent: what Safe Margins draw. */
  safeAreas: SafeAreas
}

/** The Title and Action Safe Areas, each (horizontal, vertical) percent of the picture left outside it. */
export type SafeAreas = { title: [number, number]; action: [number, number] }
/** The project's default safe areas (upstream's 80% title and 90% action). */
export const DEFAULT_SAFE_AREAS: SafeAreas = { title: [20, 20], action: [10, 10] }

/** An inspected safe area, `fallback` for a missing or malformed one. */
function areaOf(raw: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(raw) || raw.length < 2) return fallback
  const [h, v] = raw.map(Number)
  return Number.isFinite(h) && Number.isFinite(v) ? [h, v] : fallback
}

type InspectedItem = {
  clip?: number
  item?: number
  name?: string
  start?: number
  duration?: number
  sourceIn?: number
  sourceOut?: number
  speed?: number
  reverse?: boolean
  link?: number | null
  enabled?: boolean
  gainDb?: number
  label?: string
  timeInterpolation?: string
  effects?: Array<{ effect?: string; enabled?: boolean; masks?: number; params?: Record<string, { keyframes?: unknown[]; value?: unknown }> }>
}

type InspectedTrack = {
  id?: number
  name?: string
  locked?: boolean
  muted?: boolean
  solo?: boolean
  syncLock?: boolean
  enabled?: boolean
  items?: InspectedItem[]
  transitions?: Array<{ id?: number; effect?: string; start?: number; duration?: number }>
}

type InspectedBin = { id?: number; item?: number; name?: string | null; type?: string | null; duration?: number | null; label?: string | null; stamp?: string | null; children?: InspectedBin[] }

type Inspected = {
  canUndo?: boolean
  canRedo?: boolean
  project?: { name?: string; root?: InspectedBin; activeSequence?: number | null; sourceItem?: number | null; safeAreas?: { title?: unknown; action?: unknown } }
  sequence?: {
    name?: string
    settings?: { width?: number; height?: number; frame_rate?: { num?: number; den?: number }; drop_frame?: boolean; sample_rate?: number }
    duration?: number
    video?: InspectedTrack[]
    audio?: InspectedTrack[]
    selection?: number[]
    in?: number | null
    out?: number | null
    markers?: Array<{ id?: number; start?: number; duration?: number; kind?: string; name?: string; comment?: string; color?: string }>
    split?: { videoIn?: number | null; videoOut?: number | null; audioIn?: number | null; audioOut?: number | null } | null
  } | null
  playhead?: number
  ticksPerSecond?: number
}

/** The engine's time unit: ticks per second. */
export const TICKS_PER_SECOND = 254_016_000_000

function bin(entry: InspectedBin, tps: number): FilmBin {
  return {
    id: entry.id ?? 0,
    name: entry.name ?? '',
    children: (entry.children ?? []).map((child) =>
      child.children
        ? bin(child, tps)
        : { item: child.item ?? 0, name: child.name ?? '', type: child.type ?? '', duration: (child.duration ?? 0) / tps, label: child.label ?? '', ...(child.stamp ? { stamp: child.stamp } : {}) },
    ),
  }
}

/** A number parameter's value as `inspect()` answers it, or null when it is not a number. */
function floatParam(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Every project item in `root`'s bins, by id. */
export function projectItems(root: FilmBin | null) {
  const items = new Map<number, FilmProjectItem>()
  const walk = (bin: FilmBin) => {
    for (const child of bin.children) {
      if ('children' in child) walk(child)
      else items.set(child.item, child)
    }
  }
  if (root) walk(root)
  return items
}

/** Reads the active sequence, its tracks and clips, the playhead, and the project's bins from the engine's inspect JSON. */
export function describe(info: KitEngineInfo): FilmInfo {
  const inspected = info.inspected as Inspected
  const tps = inspected.ticksPerSecond || TICKS_PER_SECOND
  const seconds = (ticks: number | null | undefined) => (ticks == null ? null : ticks / tps)
  const sequence = inspected.sequence ?? null
  const rate = sequence?.settings?.frame_rate
  const fps = rate?.num && rate.den ? rate.num / rate.den : 30
  const selection = sequence?.selection ?? []
  const tracks = (kind: 'video' | 'audio', list: InspectedTrack[] | undefined): FilmTrack[] => (list ?? []).map((track) => ({
    id: track.id ?? 0,
    name: track.name ?? '',
    kind,
    locked: track.locked ?? false,
    muted: track.muted ?? false,
    solo: track.solo ?? false,
    syncLock: track.syncLock ?? false,
    enabled: track.enabled ?? true,
    clips: (track.items ?? []).map((item) => ({
      id: item.clip ?? 0,
      item: item.item ?? 0,
      name: item.name ?? '',
      start: (item.start ?? 0) / tps,
      duration: (item.duration ?? 0) / tps,
      sourceIn: (item.sourceIn ?? 0) / tps,
      sourceOut: (item.sourceOut ?? 0) / tps,
      speed: item.speed ?? 1,
      reverse: item.reverse ?? false,
      link: item.link ?? null,
      enabled: item.enabled ?? true,
      gainDb: item.gainDb ?? 0,
      label: item.label ?? 'Violet',
      selected: selection.includes(item.clip ?? -1),
      effects: (item.effects ?? []).map((effect) => ({
        effect: effect.effect ?? '',
        enabled: effect.enabled ?? true,
        masks: effect.masks ?? 0,
        keyframed: Object.entries(effect.params ?? {}).filter(([, param]) => (param.keyframes?.length ?? 0) > 0).map(([name]) => name),
      })),
      volumeDb: floatParam(item.effects?.find((effect) => effect.effect === 'volume')?.params?.level?.value) ?? 0,
      timeInterpolation: item.timeInterpolation ?? null,
    })),
    transitions: (track.transitions ?? []).map((transition) => ({ id: transition.id ?? 0, effect: transition.effect ?? '', start: (transition.start ?? 0) / tps, duration: (transition.duration ?? 0) / tps })),
  }))
  const video = tracks('video', sequence?.video)
  const audio = tracks('audio', sequence?.audio)
  const fpsLabel = Number.isInteger(fps) ? String(fps) : fps.toFixed(3)
  const split = sequence?.split ?? {}
  return {
    name: sequence?.name ?? inspected.project?.name ?? '',
    project: inspected.project?.name ?? '',
    width: info.width,
    height: info.height,
    fps,
    frame: 1 / fps,
    dropFrame: sequence?.settings?.drop_frame ?? false,
    sampleRate: sequence?.settings?.sample_rate ?? 48_000,
    duration: (sequence?.duration ?? 0) / tps,
    playhead: (inspected.playhead ?? 0) / tps,
    // Video tracks stack upwards, as editors draw them: the top track first.
    tracks: [...video.reverse(), ...audio],
    selection,
    in: seconds(sequence?.in),
    out: seconds(sequence?.out),
    markers: (sequence?.markers ?? []).map((marker) => ({
      id: marker.id ?? 0,
      start: (marker.start ?? 0) / tps,
      duration: (marker.duration ?? 0) / tps,
      kind: marker.kind ?? '',
      name: marker.name ?? '',
      comment: marker.comment ?? '',
      color: marker.color ?? '',
    })),
    split: { videoIn: seconds(split.videoIn), videoOut: seconds(split.videoOut), audioIn: seconds(split.audioIn), audioOut: seconds(split.audioOut) },
    root: inspected.project?.root ? bin(inspected.project.root, tps) : null,
    sourceItem: inspected.project?.sourceItem ?? null,
    activeSequence: inspected.project?.activeSequence ?? null,
    canUndo: inspected.canUndo ?? info.canUndo,
    canRedo: inspected.canRedo ?? info.canRedo,
    summary: `${info.width} x ${info.height} px, ${fpsLabel} fps, ${video.length} video and ${audio.length} audio tracks`,
    ticksPerSecond: tps,
    safeAreas: { title: areaOf(inspected.project?.safeAreas?.title, DEFAULT_SAFE_AREAS.title), action: areaOf(inspected.project?.safeAreas?.action, DEFAULT_SAFE_AREAS.action) },
  }
}

/** `hh:mm:ss:ff` for a time in seconds. */
export function timecode(seconds: number, fps: number) {
  const rounded = Math.max(0, Math.round(fps))
  const frames = Math.floor(Math.max(0, seconds) * fps + 1e-6)
  const ff = rounded ? frames % rounded : 0
  const total = rounded ? Math.floor(frames / rounded) : Math.floor(seconds)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(ff)}`
}

/**
 * What File ▸ Import accepts, by extension, as upstream's `file_dialog`: the engine's video, audio,
 * and still types (`kition_film_media`), then captions and interchange files, which the engine's
 * `file.import` detects and imports too.
 */
export const IMPORT_TYPES = [
  ...['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mxf', 'mts', 'm2ts', 'm2t', 'ts', 'mpg', 'mpeg', 'vob', 'mod', 'tod', 'm2v', 'm1v', 'mpv', '3gp', 'y4m', 'apv'],
  ...['wav', 'wave', 'bwf', 'aif', 'aiff', 'mp3', 'mp2', 'm4a', 'aac', 'flac', 'ogg', 'opus'],
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'bmp'],
  ...['srt', 'vtt', 'scc', 'edl', 'xml', 'fcpxml', 'otio', 'aaf', 'omf'],
]

/** What Get Media File Properties for ▸ File… and Link Media's Locate… accept: the media types only (upstream's video, audio, and still extensions). */
export const MEDIA_TYPES = IMPORT_TYPES.slice(0, IMPORT_TYPES.indexOf('srt'))

/** What Attach Proxies… and Reconnect Full Resolution Media… accept: upstream's video extensions. */
export const VIDEO_TYPES = IMPORT_TYPES.slice(0, IMPORT_TYPES.indexOf('wav'))
