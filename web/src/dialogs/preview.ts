// A dialog's live preview on the engine's scratch session (kition-film `bindings/wasm/src/preview.rs`):
// beginning, updating, and ending it, its frames for the Program monitor, and its diff as text for
// the strip. React-free, so `node --test` drives it with a fake engine; `usePreview.ts` wires it in.
// Imports carry `.ts` so `node --test` loads this module as it is.
import { coveredBy, rectOf, type FrameElement, type Rect } from './placement.ts'
import { DIFF_KINDS, previewsInEngine, type DialogStep, type PreviewHighlight, type PreviewKind } from './registry.ts'

/** The engine calls a preview makes (`KitEngine.invoke`, the kit's extras). */
export type PreviewEngine = { invoke: <T = unknown>(name: string, ...args: unknown[]) => Promise<T> }
/** Runs `task` on the next animation frame; answers a function that cancels it. */
export type Schedule = (task: () => void) => () => void

/** One thing the preview changed (`previewDiff`): its id, where it is, and for a change the fields. */
export type DiffEntry = { id: number; fields?: string[]; sequence?: number; track?: number; owner?: number; ownerKind?: string; name?: string; color?: string; start?: number; duration?: number; kind?: string; comment?: string }
export type DiffPart = { added: DiffEntry[]; removed: DiffEntry[]; changed?: DiffEntry[] }
/** `previewDiff`'s answer (Task 3's "As shipped"). */
export type PreviewDiff = {
  project?: { changed: string[] }
  sequences?: DiffPart
  tracks?: DiffPart
  clips?: DiffPart
  items?: DiffPart
  bins?: DiffPart
  markers?: DiffPart
  captions?: DiffPart
  selection?: DiffPart
  projectSelection?: DiffPart
}

/**
 * What a dialog asks to preview: its kinds, the commands it would run (null: nothing), whether
 * one starts a job, and the document's revision it begins on (which keys the preview's frames).
 */
export type PreviewRequest = {
  kinds: readonly PreviewKind[]
  steps: readonly DialogStep[] | null
  job?: boolean
  revision?: number | null
  copies?: boolean
  /** What the preview highlights, from the command's answer (`DialogSpec.highlight`). */
  highlight?: (result: unknown) => PreviewHighlight | null
}

export type PreviewState = {
  /** A preview is open on the engine's scratch session. */
  open: boolean
  /** Moves with every preview that opens (and when a job's preview finishes): what every read keys on. */
  serial: number
  kinds: readonly PreviewKind[]
  /** The previewed command's answer (the last step's, for steps). */
  result: unknown
  /** What the preview changed, read once per serial for the kinds panels draw from it. */
  diff: PreviewDiff | null
  /** A job's progress (0–1) while it runs, else null. */
  progress: number | null
  /** Moves when the document is replaced: a read keyed on an older one is dropped. */
  document: number
  /** The document's revision the open preview began on. */
  revision: number | null
  /** The preview makes a copy of the active sequence (Simplify Sequence): the Timeline compares the copy with it. */
  copies: boolean
  /** What the panels highlight under the `selection` kind in place of the copy's selection (Find's every match), or null. */
  highlight: PreviewHighlight | null
}

/**
 * How long a job's preview works each animation frame, in ms: short, so the page's own requests
 * (a playhead step, a frame) wait little behind it (Task 16 review: 12 ms against 30 ms).
 */
export const JOB_SETTLE_MS = 12

const CLOSED: Omit<PreviewState, 'serial' | 'document'> = { open: false, kinds: [], result: null, diff: null, progress: null, revision: null, copies: false, highlight: null }

const parse = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** The per-dialog side of the preview: what `PreviewDialog`'s `begin`, `update`, and `end` call. */
export type PreviewHandle = {
  /** Starts the preview from the document, with `request`; this handle owns the preview after. */
  begin: (request: PreviewRequest) => Promise<void>
  /** Shows the latest draft: at most once per animation frame, with `request()` read when it runs (the latest draft wins). */
  update: (request: () => PreviewRequest) => Promise<void>
  /** Ends this handle's preview (once; nothing when another dialog owns the preview now). */
  end: () => Promise<void>
  owns: () => boolean
  /** An update is scheduled, or waits for the begin in flight. */
  queued: () => boolean
}

export type Preview = ReturnType<typeof createPreview>

/**
 * The editor's one preview (upstream draws one dialog at a time). Each `begin` runs the dialog's
 * command on a new scratch copy (`previewBegin`, or `previewBeginSteps`); `summary` and `none`
 * dialogs, and a draft that runs nothing, open none. Calls that finish after a newer begin or an
 * end are dropped, and a stale handle's `end` never ends another dialog's preview.
 */
export function createPreview({ engine, schedule }: { engine: () => PreviewEngine | null; schedule: Schedule }) {
  let state: PreviewState = { ...CLOSED, serial: 0, document: 0 }
  const listeners = new Set<() => void>()
  let owner: PreviewHandle | null = null
  /** The engine the preview may be open on (set before `previewBegin` is sent, so an end sent meanwhile ends it). */
  let openOn: PreviewEngine | null = null
  /** Moves with every begin, end, and replacement: work that finishes under an older one is dropped. */
  let generation = 0
  let cancelJob: (() => void) | null = null
  let inspected: { serial: number; document: number; value: Promise<unknown> } | null = null
  /** Begins that have not published yet (`newer`). */
  let beginning = 0
  /** The begin on the engine now, if one runs: updates wait for it (one call in flight). */
  let running: Promise<void> | null = null

  const publish = (next: Partial<PreviewState>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }

  const stopJob = () => {
    cancelJob?.()
    cancelJob = null
  }

  async function endOnEngine() {
    stopJob()
    const on = openOn
    openOn = null
    if (on) await on.invoke('previewEnd').catch(() => undefined)
  }

  const readDiff = (on: PreviewEngine, kinds: readonly PreviewKind[]) => (kinds.some((kind) => DIFF_KINDS.has(kind)) ? on.invoke<string>('previewDiff').then((raw) => parse(raw) as PreviewDiff).catch(() => null) : Promise.resolve(null))

  /** A job's preview: `previewSettle(JOB_SETTLE_MS)` once per animation frame until it is done, its progress published. */
  function runJob(on: PreviewEngine, mine: number, kinds: readonly PreviewKind[]) {
    let cancelled = false
    let cancelFrame = () => undefined as void
    cancelJob = () => {
      cancelled = true
      cancelFrame()
    }
    const tick = () => {
      cancelFrame = schedule(() => {
        void (async () => {
          if (cancelled || mine !== generation) return
          try {
            const settled = parse(await on.invoke<string>('previewSettle', JOB_SETTLE_MS)) as { pending?: boolean; progress?: number } | null
            if (cancelled || mine !== generation) return
            if (settled?.pending) {
              publish({ progress: Math.min(1, Math.max(0, settled.progress ?? 0)) })
              tick()
              return
            }
            const diff = await readDiff(on, kinds)
            if (cancelled || mine !== generation) return
            cancelJob = null
            inspected = null
            publish({ serial: state.serial + 1, diff, progress: null })
          } catch {
            if (!cancelled && mine === generation) publish({ progress: null })
          }
        })()
      })
    }
    tick()
  }

  async function start(request: PreviewRequest) {
    // Counted until it publishes (or gives way): a begin that published is not a newer one.
    beginning += 1
    let counted = true
    const uncount = () => {
      if (counted) beginning -= 1
      counted = false
    }
    try {
      await begin(request, uncount)
    } finally {
      uncount()
    }
  }

  async function begin(request: PreviewRequest, uncount: () => void) {
    const mine = ++generation
    stopJob()
    const on = engine()
    if (!previewsInEngine(request.kinds) || !request.steps?.length || !on) {
      // A summary or an information dialog, or a draft that runs nothing: no preview on the engine.
      await endOnEngine()
      uncount()
      if (mine === generation) publish({ ...CLOSED, kinds: request.kinds })
      return
    }
    openOn = on
    let result: unknown
    try {
      const [first] = request.steps
      const raw = request.steps.length === 1 ? await on.invoke<string>('previewBegin', first.command, JSON.stringify(first.params)) : await on.invoke<string>('previewBeginSteps', JSON.stringify(request.steps))
      result = parse(raw)
    } catch (error) {
      // A failing command leaves no preview open on the engine.
      if (mine === generation) {
        if (openOn === on) openOn = null
        uncount()
        publish({ ...CLOSED, kinds: request.kinds })
      }
      throw error
    }
    if (mine !== generation) return
    const diff = await readDiff(on, request.kinds)
    if (mine !== generation) return
    inspected = null
    const highlight = request.highlight ? request.highlight(result) : null
    uncount()
    publish({ open: true, serial: state.serial + 1, kinds: request.kinds, result, diff, progress: request.job ? 0 : null, revision: request.revision ?? null, copies: request.copies === true, highlight })
    if (request.job) runJob(on, mine, request.kinds)
  }

  /** Runs `start`, noting it as the begin in flight until it settles. */
  const run = (request: PreviewRequest) => {
    const begun = start(request)
    const settled = begun.then(
      () => undefined,
      () => undefined,
    )
    running = settled
    void settled.then(() => {
      if (running === settled) running = null
    })
    return begun
  }

  function handle(): PreviewHandle {
    let cancelFrame: (() => void) | null = null
    /** An update is scheduled, or waits for the begin in flight. */
    let queued = false
    /** Moves when a begin or an end drops what was queued. */
    let ticket = 0
    let waiting: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let latest: (() => PreviewRequest) | null = null
    /** A begin ran in this animation frame: the next update waits for the next frame (at most one a frame). */
    let cooling = false
    let cancelCool: (() => void) | null = null
    const cool = () => {
      cooling = true
      cancelCool?.()
      cancelCool = schedule(() => {
        cancelCool = null
        cooling = false
      })
    }
    const take = () => {
      const batch = waiting
      waiting = []
      return batch
    }
    const flush = () => {
      cancelFrame?.()
      cancelFrame = null
      queued = false
      ticket += 1
      for (const each of take()) each.resolve()
    }
    /** At most one begin in flight: an update that comes due while one runs waits for it, then runs the latest draft once. */
    const fire = (mine: number) => {
      if (mine !== ticket) return
      if (owner !== self || !latest) {
        queued = false
        for (const each of take()) each.resolve()
        return
      }
      if (running) {
        void running.then(() => fire(mine))
        return
      }
      queued = false
      const batch = take()
      cool()
      run(latest()).then(
        () => batch.forEach((each) => each.resolve()),
        (error) => batch.forEach((each) => each.reject(error)),
      )
    }
    const self: PreviewHandle = {
      begin(request) {
        flush()
        owner = self
        return run(request)
      },
      update(request) {
        if (owner !== self) return Promise.resolve()
        latest = request
        return new Promise<void>((resolve, reject) => {
          waiting.push({ resolve, reject })
          if (queued) return
          queued = true
          const mine = ticket
          // No begin yet this frame: at once (after the one in flight, if any), so a change shows
          // without a frame's wait; a second change in the same frame waits for the next.
          if (!cooling) {
            fire(mine)
            return
          }
          cancelFrame = schedule(() => {
            cancelFrame = null
            fire(mine)
          })
        })
      },
      async end() {
        flush()
        if (owner !== self) return
        owner = null
        generation += 1
        await endOnEngine()
        inspected = null
        publish({ ...CLOSED })
      },
      owns: () => owner === self,
      queued: () => queued,
    }
    return self
  }

  return {
    handle,
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Whether a dialog owns the preview now. */
    busy: () => owner != null,
    /** Whether a newer preview is on its way (a begin in flight, or an update queued): a read for the serial shown now may be skipped. */
    newer: () => beginning > 0 || (owner?.queued() ?? false),
    /**
     * The document was replaced (another document, a reopen from the host, `file.open`, Revert):
     * the open preview is a copy of the old one, so it ends (`previewEnd`, a backstop to the
     * engine's own), and every read keyed on the old document is dropped.
     */
    replaced() {
      generation += 1
      owner = null
      void endOnEngine()
      inspected = null
      publish({ ...CLOSED, document: state.document + 1 })
    },
    /** The preview's `inspect()` (`previewInspect`), read once per serial; null while none is open. */
    inspect(): Promise<unknown> {
      const on = openOn
      if (!state.open || !on) return Promise.resolve(null)
      if (inspected && inspected.serial === state.serial && inspected.document === state.document) return inspected.value
      const value = on.invoke<string>('previewInspect').then(parse, () => null)
      inspected = { serial: state.serial, document: state.document, value }
      return value
    },
    /** The engine the preview is open on, for its frames and sound. */
    engine: () => (state.open ? openOn : null),
  }
}

type InspectedDocument = { project?: { epoch?: number } } | null | undefined

/**
 * Whether `next` (an `inspect()`) holds another project than `previous`, not an edit of it: the
 * engine's project epoch moved (`file.newProject`, `file.open`, Revert, `file.openDemoProject`,
 * Close Project, a new project from a template). A collaborator's imported changes, an edit, and
 * a save (Save As gives a path) keep it.
 */
export function documentReplaced(previous: unknown, next: unknown): boolean {
  const before = (previous as InspectedDocument)?.project?.epoch
  const after = (next as InspectedDocument)?.project?.epoch
  return before != null && after != null && before !== after
}

/** What a playback frame refreshes: nothing of the program while a picture preview covers the Program monitor (the preview draws there). */
export const playbackRefresh = <R extends string>(refresh: R, covered: boolean): R | 'none' => (covered && refresh === 'repaint' ? 'none' : refresh)

/** What a preview frame or read is keyed on (lesson 6): the document, its revision, and the preview's serial. */
export type PreviewKey = { document: number; revision: number | null; serial: number }
export const sameKey = (a: PreviewKey | null, b: PreviewKey | null) => a != null && b != null && a.document === b.document && a.revision === b.revision && a.serial === b.serial

export type PreviewImage = { key: PreviewKey; seconds: number; width: number; height: number; pixels: Uint8ClampedArray }

/** `[width u32 LE][height u32 LE]` then RGBA (`previewFrame`, `previewItemFrame`), or null when it is not one. */
export function decodeFrame(bytes: Uint8Array | ArrayBuffer | null | undefined): { width: number; height: number; pixels: Uint8ClampedArray } | null {
  if (!bytes) return null
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (view.byteLength < 8) return null
  const header = new DataView(view.buffer, view.byteOffset, 8)
  const width = header.getUint32(0, true)
  const height = header.getUint32(4, true)
  if (!width || !height || view.byteLength < 8 + width * height * 4) return null
  return { width, height, pixels: new Uint8ClampedArray(view.buffer, view.byteOffset + 8, width * height * 4) }
}

/**
 * The preview's frames at the playhead (`previewFrame`): at most one per animation frame, one in
 * flight, the latest request winning. A frame whose key is not the current one (an older serial,
 * revision, or document) is dropped, never drawn.
 */
export function createPreviewFrames({ engine, schedule, current, onFrame }: { engine: () => PreviewEngine | null; schedule: Schedule; current: () => PreviewKey | null; onFrame: (image: PreviewImage) => void }) {
  let wanted: { key: PreviewKey; seconds: number; width: number } | null = null
  let inFlight = false
  let cancelFrame: (() => void) | null = null
  let disposed = false
  /** A frame was asked for in this animation frame: the next waits for the next one (at most one a frame). */
  let cooling = false
  const pump = () => {
    if (cancelFrame || inFlight || !wanted || disposed) return
    // Idle: at once; otherwise on the next animation frame.
    if (!cooling) {
      read()
      return
    }
    cancelFrame = schedule(() => {
      cancelFrame = null
      read()
    })
  }
  let cancelCool: (() => void) | null = null
  const read = () => {
    cooling = true
    cancelCool?.()
    cancelCool = schedule(() => {
      cancelCool = null
      cooling = false
      pump()
    })
    const ask = wanted
    wanted = null
    const on = engine()
    if (!ask || !on || disposed) return
    inFlight = true
    void on
      .invoke<Uint8Array>('previewFrame', ask.seconds, ask.width)
      .then((bytes) => {
        const image = decodeFrame(bytes)
        if (image && !disposed && sameKey(current(), ask.key)) onFrame({ key: ask.key, seconds: ask.seconds, ...image })
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false
        pump()
      })
  }
  return {
    request(key: PreviewKey, seconds: number, width: number) {
      wanted = { key, seconds: Math.max(0, seconds), width: Math.max(1, Math.min(2048, Math.round(width))) }
      pump()
    },
    dispose() {
      disposed = true
      cancelFrame?.()
      cancelFrame = null
      cancelCool?.()
      cancelCool = null
      wanted = null
    },
  }
}

// ---- the diff as text, for the strip while the panel that draws it is not shown

type RawBin = { id?: number; item?: number; name?: string | null; children?: RawBin[] }
type RawTrack = { id?: number; name?: string; items?: Array<{ clip?: number; name?: string }> }
type RawInspect = { project?: { root?: RawBin; activeSequence?: number | null }; sequence?: { id?: number; name?: string; video?: RawTrack[]; audio?: RawTrack[] } | null } | null

/** A sequence as `sequence.inspect` answers it. */
type RawSequence = { id?: number; name?: string | null; video?: RawTrack[]; audio?: RawTrack[] }

/**
 * Names by id, from the document's `inspect()` and the preview's (`previewInspect`): what was
 * added lives only in one, what was removed only in the other. `sequences` are other sequences
 * (`sequence.inspect`, the preview's or the document's), whose tracks are named with their
 * sequence ("Nest A: Video 1"); `root` names the root bin, which has no name of its own.
 */
export function previewNames(document: unknown, preview: unknown, options: { sequences?: readonly unknown[]; root?: string; searchBins?: ReadonlyArray<{ bin?: number; name?: string }> } = {}) {
  const items = new Map<number, string>()
  const bins = new Map<number, string>()
  const tracks = new Map<string, string>()
  const clips = new Map<string, string>()
  const shown = (document as RawInspect)?.sequence?.id ?? (document as RawInspect)?.project?.activeSequence ?? (preview as RawInspect)?.sequence?.id ?? null
  const addSequence = (sequence: RawSequence | null | undefined, at: number | null) => {
    const prefix = at != null && at !== shown ? `${sequence?.name ?? items.get(at) ?? `#${at}`}: ` : ''
    for (const track of [...(sequence?.video ?? []), ...(sequence?.audio ?? [])]) {
      if (track.id != null) tracks.set(`${at}:${track.id}`, `${prefix}${track.name ?? ''}`)
      for (const clip of track.items ?? []) if (clip.clip != null) clips.set(`${at}:${clip.clip}`, clip.name ?? '')
    }
  }
  for (const source of [document as RawInspect, preview as RawInspect]) {
    const walk = (bin: RawBin) => {
      for (const child of bin.children ?? []) {
        if (child.children) {
          if (child.id != null) bins.set(child.id, child.name ?? '')
          walk(child)
        } else if (child.item != null) items.set(child.item, child.name ?? '')
      }
    }
    const root = source?.project?.root
    if (root) {
      if (root.id != null && (root.name || options.root)) bins.set(root.id, root.name || (options.root as string))
      walk(root)
    }
  }
  // Search bins are bins of the diff too (Create Search Bin's: `project.searchBins` of the copy).
  for (const searchBin of options.searchBins ?? []) if (searchBin.bin != null) bins.set(searchBin.bin, searchBin.name ?? '')
  for (const source of [document as RawInspect, preview as RawInspect]) addSequence(source?.sequence, source?.sequence?.id ?? source?.project?.activeSequence ?? null)
  for (const sequence of options.sequences ?? []) {
    const raw = sequence as RawSequence | null
    if (raw?.id != null) addSequence(raw, raw.id)
  }
  return {
    item: (id: number) => items.get(id) ?? `#${id}`,
    bin: (id: number) => bins.get(id) ?? `#${id}`,
    sequence: (id: number) => items.get(id) ?? `#${id}`,
    track: (id: number, sequence?: number) => tracks.get(`${sequence ?? null}:${id}`) ?? `#${id}`,
    clip: (id: number, sequence?: number) => clips.get(`${sequence ?? null}:${id}`) ?? `#${id}`,
  }
}

/** The sequences other than the shown one whose tracks or clips `diff` names: their names come from `sequence.inspect`. */
export function otherSequences(diff: PreviewDiff | null, shown: number | null): number[] {
  const ids = new Set<number>()
  for (const part of [diff?.tracks, diff?.clips]) for (const entry of [...(part?.added ?? []), ...(part?.removed ?? []), ...(part?.changed ?? [])]) if (entry.sequence != null && entry.sequence !== shown) ids.add(entry.sequence)
  return [...ids]
}

type Names = ReturnType<typeof previewNames>
type T = (key: string, values?: Record<string, string | number>) => string

/** A camelCase field name as words (`sourceIn` → `source in`). */
const words = (field: string) => field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()

const PARTS = ['sequences', 'tracks', 'clips', 'items', 'bins', 'markers', 'captions'] as const
type Part = (typeof PARTS)[number]
/**
 * What draws a part of the diff on screen (`useDrawsPreview`): a preview kind, or a panel's part of
 * one: the two selections (the Timeline's clips, the Project panel's items), the caption lanes
 * (Task 36), and the project's own fields (no panel draws them yet), so what one panel draws is not
 * left out for another, and what no panel draws is always listed.
 */
/**
 * `project:view`: the List view on screen, which draws a view preference's preview (Metadata
 * Display's columns); `project:freeform`: the Freeform view on screen, which draws Freeform View
 * Options' preview (its cards laid out with the options).
 */
export type PreviewDrawer = PreviewKind | 'selection:timeline' | 'selection:project' | 'timeline:captions' | 'timeline:fields' | 'project:fields' | 'project:view' | 'project:freeform'

/** The kind a drawer belongs to. */
export const drawerKind = (drawer: PreviewDrawer) => drawer.split(':')[0] as PreviewKind

/** A part of the diff, as the drawers are asked about it. */
export type DiffPartName = Part | 'selection' | 'projectSelection'

/** Which of a part's entries a panel draws (the shown sequence's clips, the rows of the bin shown); none given: all. */
export type PreviewCovers = (part: DiffPartName, entry: DiffEntry) => boolean

/** The drawers of each part of the diff. */
const PART_KINDS: Readonly<Record<DiffPartName, readonly PreviewDrawer[]>> = {
  sequences: ['timeline', 'project'],
  tracks: ['timeline'],
  clips: ['timeline'],
  items: ['project'],
  bins: ['project'],
  markers: ['markers'],
  captions: ['timeline:captions'],
  selection: ['selection:timeline'],
  projectSelection: ['selection:project'],
}

/**
 * The panels on screen and what each draws of a preview (`useDrawsPreview`), so the strip lists
 * only the rest. A registration reads its `covers` when asked (the panel's latest); `changed`
 * says that what one covers changed (another bin shown, another sequence).
 */
export function createDrawers() {
  type Registration = { covers: () => PreviewCovers | undefined; frame: () => FrameElement | null }
  const registered = new Map<PreviewDrawer, Set<Registration>>()
  const listeners = new Set<() => void>()
  let version = 0
  /** The open dialog's box: a panel it hides half of or more draws nothing a person can see. */
  let occluder: Rect | null = null
  /** The floating windows' boxes (the floating bin panels): a workspace panel one hides half of or more draws nothing a person can see either. */
  let windows: readonly Rect[] = []
  const tell = () => {
    version += 1
    for (const listener of listeners) listener()
  }
  const visible = (registration: Registration) => {
    if (!occluder && !windows.length) return true
    const element = registration.frame()
    if (!element) return true
    const box = rectOf(element)
    if (coveredBy(box, occluder)) return false
    // A panel inside a floating window is drawn over the others, never under them.
    return element.closest?.('.kui-floating-panel') != null || !windows.some((window) => coveredBy(box, window))
  }
  const shown = (drawer: PreviewDrawer) => [...(registered.get(drawer) ?? [])].filter(visible)
  return {
    /**
     * `frame` is the panel's element (its workspace frame is found from it), so the dialog can
     * keep off it and a covered one counts as not drawing.
     */
    add(drawer: PreviewDrawer, covers: () => PreviewCovers | undefined = () => undefined, frame: () => FrameElement | null = () => null) {
      const set = registered.get(drawer) ?? new Set()
      const registration: Registration = { covers, frame }
      set.add(registration)
      registered.set(drawer, set)
      tell()
      return () => {
        set.delete(registration)
        tell()
      }
    },
    drawn: (drawer: PreviewDrawer) => shown(drawer).length > 0,
    /** Whether a panel on screen draws `entry` of `part` under `drawer`. */
    covers(drawer: PreviewDrawer, part: DiffPartName, entry: DiffEntry) {
      for (const registration of shown(drawer)) {
        const test = registration.covers()
        if (!test || test(part, entry)) return true
      }
      return false
    },
    /** The boxes of the panels that draw `drawer` (whether or not a dialog covers them). */
    frames: (drawer: PreviewDrawer): Rect[] =>
      [...(registered.get(drawer) ?? [])].flatMap((registration) => {
        const element = registration.frame()
        return element ? [rectOf(element)] : []
      }),
    /** The open dialog's box, or null once it closes. */
    occlude(next: Rect | null) {
      const same = next === occluder || (next && occluder && next.x === occluder.x && next.y === occluder.y && next.width === occluder.width && next.height === occluder.height)
      if (same) return
      occluder = next
      tell()
    },
    /** The floating windows' boxes now (none when no window is open). */
    floating(next: readonly Rect[]) {
      const same = next.length === windows.length && next.every((box, k) => box.x === windows[k].x && box.y === windows[k].y && box.width === windows[k].width && box.height === windows[k].height)
      if (same) return
      windows = next
      tell()
    },
    changed: tell,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => version,
  }
}

export type PreviewDrawers = ReturnType<typeof createDrawers>

/** Whether the strip lists a drawer's part (or one entry of it) for a dialog previewing `kinds`: it previews that kind, and no panel on screen draws it. */
export type StripListing = (drawer: PreviewDrawer, part?: DiffPartName, entry?: DiffEntry) => boolean

export const stripListing =
  (kinds: readonly PreviewKind[], drawers: Pick<PreviewDrawers, 'drawn' | 'covers'>): StripListing =>
  (drawer, part, entry) =>
    kinds.includes(drawerKind(drawer)) && !(part && entry ? drawers.covers(drawer, part, entry) : drawers.drawn(drawer))

/** At most this many entries are named one by one; more are counted. */
const NAMED = 3

/**
 * The diff as lines for the strip ("Adds sequence Nest A", "Changes clip bars.mp4 on Video 1:
 * speed, duration"), for what no panel on screen draws: `shown(drawer, part, entry)` says the
 * strip lists an entry (`stripListing`: the dialog previews its kind, and no panel draws it).
 */
export function describeDiff(diff: PreviewDiff | null, names: Names, t: T, shown: StripListing = () => true): string[] {
  if (!diff) return []
  const lines: string[] = []
  const name = (part: Part, entry: DiffEntry) => {
    switch (part) {
      case 'sequences':
        return names.sequence(entry.id)
      case 'tracks':
        return names.track(entry.id, entry.sequence)
      case 'clips': {
        const clip = names.clip(entry.id, entry.sequence)
        return entry.track != null ? t('preview.on', { what: clip, track: names.track(entry.track, entry.sequence) }) : clip
      }
      case 'items':
        return names.item(entry.id)
      case 'bins':
        return names.bin(entry.id)
      case 'markers':
      case 'captions':
        return entry.name ? entry.name : `#${entry.id}`
    }
  }
  const what = (part: Part, entries: readonly DiffEntry[]) =>
    entries.length > NAMED ? t(`preview.count.${part}`, { count: entries.length }) : entries.map((entry) => `${t(`preview.noun.${part}`)} ${name(part, entry)}`).join(', ')
  /** The entries of `part` the strip lists: those no panel on screen draws. */
  const listed = (part: DiffPartName): DiffPart | null => {
    const all = diff[part]
    if (!all) return null
    const keep = (entry: DiffEntry) => PART_KINDS[part].some((drawer) => shown(drawer, part, entry))
    return { added: all.added.filter(keep), removed: all.removed.filter(keep), changed: (all.changed ?? []).filter(keep) }
  }
  if (diff.project?.changed.length && (shown('project:fields') || shown('timeline:fields'))) lines.push(t('preview.project', { fields: diff.project.changed.map(words).join(', ') }))
  for (const part of PARTS) {
    const changes = listed(part)
    if (!changes) continue
    if (changes.added.length) lines.push(t('preview.adds', { what: what(part, changes.added) }))
    if (changes.removed.length) lines.push(t('preview.removes', { what: what(part, changes.removed) }))
    const changed = changes.changed ?? []
    if (changed.length > NAMED) lines.push(t('preview.changes', { what: what(part, changed) }))
    else for (const entry of changed) lines.push(t('preview.changesFields', { what: `${t(`preview.noun.${part}`)} ${name(part, entry)}`, fields: (entry.fields ?? []).map(words).join(', ') }))
  }
  for (const part of ['selection', 'projectSelection'] as const) {
    const changes = listed(part)
    if (!changes) continue
    const noun = part === 'selection' ? 'clips' : 'items'
    const count = (n: number) => (n === 1 ? `1 ${t(`preview.noun.${noun}`)}` : t(`preview.count.${noun}`, { count: n }))
    if (changes.added.length) lines.push(t('preview.selects', { what: count(changes.added.length) }))
    if (changes.removed.length) lines.push(t('preview.deselects', { what: count(changes.removed.length) }))
  }
  return lines
}

/**
 * Whether the dialog's strip has anything to show: what OK will do (`summary`), Play (`sound`), the
 * small frame while no Program monitor draws the picture, a job's progress, or a part of the diff
 * no panel on screen draws (or, while no panel draws any of its kinds, the diff or "nothing
 * changes"), from what the panels on screen draw (`drawers`).
 */
export function stripShows(kinds: readonly PreviewKind[], diff: PreviewDiff | null, drawers: Pick<PreviewDrawers, 'drawn' | 'covers'>, progress: number | null): boolean {
  const drawn = drawers.drawn
  if (kinds.includes('summary') || kinds.includes('sound') || progress != null) return true
  if (kinds.includes('picture') && !drawn('picture')) return true
  const diffKinds = kinds.filter((kind) => DIFF_KINDS.has(kind))
  if (!diffKinds.length) return false
  const drawnSomewhere = diffKinds.some((kind) => (kind === 'selection' ? drawn('selection:timeline') || drawn('selection:project') : drawn(kind)))
  if (!drawnSomewhere) return true
  return describeDiff(diff, previewNames(null, null), (key) => key, stripListing(kinds, drawers)).length > 0
}

/**
 * Resolves once the preview shown as serial `serial` (a dialog's own, read as it closes) has
 * ended (the engine's `previewEnd` answered) or been overtaken by a newer one (another dialog's
 * preview began), and stops listening; at once when it is no longer open. It never waits on
 * another dialog's preview.
 */
export function previewEnded(preview: { get: () => { open: boolean; serial: number }; subscribe: (listener: () => void) => () => void }, serial: number): Promise<void> {
  const over = () => !preview.get().open || preview.get().serial !== serial
  return new Promise((resolve) => {
    if (over()) return resolve()
    const off = preview.subscribe(() => {
      if (!over()) return
      off()
      resolve()
    })
  })
}
