/**
 * The Timeline's tools and gestures, as upstream `panels/timeline.rs` `interact` and
 * `panels/timeline_hit.rs` (`hit`, `grab_at`, `edge_geometry`, `selection_trim_kind`) work them
 * out: what a press grabs, what a click or a drag start sends, the live drag (drawn locally, never
 * sent), and the one command its release sends. Times are engine ticks; x is points from the left
 * edge of the track content, y points from the top of the panel. Pure, so `node --test` runs it.
 */
import { snapTo, xOfTick, type SnapScene } from './snap.ts'

export type Mods = { shift: boolean; alt: boolean; command: boolean }

export type SceneClip = { id: number; item: number; start: number; duration: number; link: number | null }
export type SceneTrack = { id: number; kind: 'video' | 'audio'; index: number; clips: readonly SceneClip[]; transitions: ReadonlyArray<{ id: number; start: number; duration: number }> }

/** The active sequence as the gestures read it: tracks V1…Vn then A1…An (upstream's `all_tracks`). */
export type Scene = Omit<SnapScene, 'tracks'> & {
  tracks: readonly SceneTrack[]
  selection: readonly number[]
  /** One frame of the sequence, in ticks. */
  frame: number
  linkedSelection: boolean
  /** Settings ▸ Trim ▸ "Allow Selection tool to choose Roll and Ripple trims without modifier key". */
  rollRipple: boolean
}

export type Row = { track: number; kind: 'video' | 'audio'; index: number; top: number; height: number }
export type Layout = { pps: number; scroll: number; width: number; rows: readonly Row[]; ruler: { top: number; bottom: number } | null }

export type Edge = 'in' | 'out'
export type TrimKind = 'trim' | 'ripple' | 'roll' | 'stretch' | 'remix'

/**
 * What a press of a tool grabs (upstream `Grab`, flattened): a clip edge and the trim it starts, or
 * what is there for a tool that does not trim (a clip, with the edge it is near, a transition, an
 * empty track, the ruler, or nothing).
 */
export type Grab =
  | { kind: 'edge'; track: number; clip: number; edge: Edge; trim: TrimKind; left?: number; right?: number }
  | { kind: 'clip'; track: number; clip: number; edge: Edge | null }
  | { kind: 'transition'; track: number; id: number }
  | { kind: 'empty'; track: number }
  | { kind: 'ruler' }
  | { kind: 'none' }

export type Command = { id: string; params: Record<string, unknown> }

/** egui's drag threshold (`max_click_dist`, 6 points): a press that moves no farther is a click. */
export const DRAG_THRESHOLD = 6
/** egui's `max_click_duration` (0.8 s): a press held longer is a drag even where it went down. */
export const CLICK_MS = 800
/** Widest an edge zone gets, each side of a clip edge (`EDGE_PX`). */
export const EDGE_PX = 7
/** How close to a cut the Selection tool rolls with the Trim setting on (`ROLL_PX`). */
export const ROLL_PX = 2.5
/** Transitions are hit below this much of a row's top (their overlay starts there). */
const TRANSITION_TOP = 17

/** egui's `has_moved_too_much_for_a_click`: farther than the threshold, not at it. */
export const isDrag = (dx: number, dy: number) => Math.hypot(dx, dy) > DRAG_THRESHOLD

const end = (clip: SceneClip) => clip.start + clip.duration
/** `Layout::tick_at`: the time (ticks) at `x`. */
export const tickAt = (scene: Scene, layout: Layout, x: number) => Math.round((layout.scroll + x / layout.pps) * scene.tps)
/** `Layout::x_of` for a time in ticks. */
export const xOf = (scene: Scene, layout: Layout, t: number) => xOfTick(layout, t, scene.tps)
/** `FrameRate::snap_nearest`. */
const snapNearest = (scene: Scene, t: number) => (scene.frame > 0 ? Math.round(t / scene.frame) * scene.frame : t)

/**
 * The frame nearest `x`, never before 0, then `snap`ped (upstream `snap(rate.snap_nearest(tick_at(x)))`):
 * where the Razor cuts and where a drop lands. `x` is the snap indicator's place, null when nothing pulled it.
 */
export function snapAt(scene: Scene, layout: Layout, x: number): { time: number; x: number | null } {
  return snapTo(scene, layout, snapNearest(scene, Math.max(0, tickAt(scene, layout, x))), [], true)
}
const trackOf = (scene: Scene, id: number) => scene.tracks.find((track) => track.id === id)
const rowAt = (layout: Layout, y: number) => layout.rows.find((row) => row.top <= y && y < row.top + row.height)

export function findClip(scene: Scene, id: number): { track: SceneTrack; clip: SceneClip } | null {
  for (const track of scene.tracks) {
    const clip = track.clips.find((each) => each.id === id)
    if (clip) return { track, clip }
  }
  return null
}

/** `commands::with_links`: the clips and, while Linked Selection is on, every clip linked to one of them. */
export function withLinks(scene: Scene, clips: readonly number[]): number[] {
  const out = [...clips]
  if (!scene.linkedSelection) return out
  const links = clips.map((id) => findClip(scene, id)?.clip.link).filter((link): link is number => link != null)
  for (const track of scene.tracks) for (const clip of track.clips) if (clip.link != null && links.includes(clip.link) && !out.includes(clip.id)) out.push(clip.id)
  return out
}

/** `selection_trim_kind`: Cmd+Shift rolls, Cmd ripples; with the Trim setting, right on a cut rolls and elsewhere ripples; else a regular trim. */
export function selectionTrimKind(noModifier: boolean, command: boolean, shift: boolean, distance: number, neighbour: boolean): 'trim' | 'ripple' | 'roll' {
  if (command && shift) return 'roll'
  if (command) return 'ripple'
  if (noModifier) return neighbour && distance <= ROLL_PX ? 'roll' : 'ripple'
  return 'trim'
}

/** `edge_geometry`: how far `x` is from the cut at `clip`'s `edge`, and whether a clip touches the cut from the other side. */
function edgeGeometry(scene: Scene, layout: Layout, track: SceneTrack, clip: SceneClip, edge: Edge, x: number) {
  const cut = edge === 'out' ? end(clip) : clip.start
  const neighbour = track.clips.some((other) => (edge === 'out' ? other.start === cut : end(other) === cut))
  return { distance: Math.abs(xOf(scene, layout, cut) - x), neighbour }
}

/** The edge on `track` a pointer at `x` reaches (`edge_at`): inside a clip beats outside, then the nearer edge, a tie to the later clip's In. */
function edgeAt(scene: Scene, layout: Layout, track: SceneTrack, x: number): { clip: number; edge: Edge } | null {
  let best: { clip: number; edge: Edge; inside: boolean; dist: number } | null = null
  for (const clip of track.clips) {
    const x0 = xOf(scene, layout, clip.start)
    const x1 = xOf(scene, layout, end(clip))
    const width = x1 - x0
    if (!Number.isFinite(width) || width <= 0) continue
    const zone = Math.min(EDGE_PX, width / 3)
    for (const [edge, d] of [['in', x - x0], ['out', x1 - x]] as const) {
      if (!(d >= -zone && d <= zone)) continue
      const reach = { clip: clip.id, edge, inside: d >= 0, dist: Math.abs(d) }
      const beats = !best || (reach.inside !== best.inside ? reach.inside : reach.dist !== best.dist ? reach.dist < best.dist : reach.edge === 'in' && best.edge !== 'in')
      if (beats) best = reach
    }
  }
  return best ? { clip: best.clip, edge: best.edge } : null
}

/** `hit`: what is at a point, whatever the tool. */
export function hitAt(scene: Scene, layout: Layout, x: number, y: number): Exclude<Grab, { kind: 'edge' }> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { kind: 'none' }
  if (layout.ruler && y >= layout.ruler.top && y < layout.ruler.bottom && x >= 0 && x <= layout.width) return { kind: 'ruler' }
  if (x < 0 || x > layout.width) return { kind: 'none' }
  const row = rowAt(layout, y)
  const track = row ? trackOf(scene, row.track) : undefined
  if (!row || !track) return { kind: 'none' }
  for (const transition of track.transitions) {
    if (x >= xOf(scene, layout, transition.start) && x <= xOf(scene, layout, transition.start + transition.duration) && y > row.top + TRANSITION_TOP) return { kind: 'transition', track: track.id, id: transition.id }
  }
  const reached = edgeAt(scene, layout, track, x)
  if (reached) return { kind: 'clip', track: track.id, clip: reached.clip, edge: reached.edge }
  const t = tickAt(scene, layout, x)
  const under = track.clips.find((clip) => clip.start <= t && t < end(clip))
  return under ? { kind: 'clip', track: track.id, clip: under.id, edge: null } : { kind: 'empty', track: track.id }
}

/** A roll of the cut at `clip`'s `edge`, or a regular trim when nothing touches it from the other side (`roll`). */
function rollAt(track: SceneTrack, clip: SceneClip, edge: Edge): Pick<Extract<Grab, { kind: 'edge' }>, 'trim' | 'left' | 'right'> {
  const other = edge === 'out' ? track.clips.find((each) => each.start === end(clip)) : track.clips.find((each) => end(each) === clip.start)
  if (!other) return { trim: 'trim' }
  return edge === 'out' ? { trim: 'roll', left: clip.id, right: other.id } : { trim: 'roll', left: other.id, right: clip.id }
}

/** `grab_at`: what a press of `tool` with `mods` at a point grabs; the one place that decides which tools trim at an edge. */
export function hitTest(scene: Scene, layout: Layout, x: number, y: number, tool: string, mods: Mods): Grab {
  const hit = hitAt(scene, layout, x, y)
  if (hit.kind !== 'clip' || hit.edge == null) return hit
  const found = findClip(scene, hit.clip)
  if (!found) return hit
  const base = { kind: 'edge' as const, track: hit.track, clip: hit.clip, edge: hit.edge }
  switch (tool) {
    case 'Selection': {
      const { distance, neighbour } = edgeGeometry(scene, layout, found.track, found.clip, hit.edge, x)
      const kind = selectionTrimKind(scene.rollRipple, mods.command, mods.shift, distance, neighbour)
      return kind === 'roll' ? { ...base, ...rollAt(found.track, found.clip, hit.edge) } : { ...base, trim: kind }
    }
    case 'Ripple':
      return { ...base, trim: 'ripple' }
    case 'Rolling':
      return { ...base, ...rollAt(found.track, found.clip, hit.edge) }
    case 'RateStretch':
      return { ...base, trim: 'stretch' }
    case 'Remix':
      return hit.edge === 'out' ? { ...base, trim: 'remix' } : hit
    default:
      return hit
  }
}

/** A gesture in progress (upstream `Drag`): nothing of it reaches the engine until the release. */
export type Drag =
  | { kind: 'move'; clips: number[]; grabTick: number; startTrack: number; offset: number; trackDelta: number }
  | { kind: 'trim'; clip: number; edge: Edge; mode: 'regular' | 'ripple'; delta: number; from: number }
  | { kind: 'roll'; left: number; right: number; delta: number; from: number }
  | { kind: 'stretch'; clip: number; edge: Edge; delta: number; from: number }
  | { kind: 'remix'; clip: number; delta: number; from: number }
  | { kind: 'slip'; clip: number; delta: number; originX: number }
  | { kind: 'slide'; clip: number; delta: number; originX: number }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }

/** Where the button went down and what it grabbed there (upstream `Pressed`). */
export type Pressed = { x: number; y: number; grab: Grab }

/** What a press sends now, the drag it starts, and a Zoom click's zoom (factor about a time, in seconds, at `x`). */
export type Begun = { commands: Command[]; drag: Drag | null; zoom?: { factor: number; time: number; x: number } }

/**
 * `interact`'s press arm, run once when a press turns out to be a click (`clicked`) or a drag
 * start: the commands it sends now (selecting, razoring) and the drag it starts. A Selection drag
 * on an unselected clip selects it first; the move then carries the selection the select leaves.
 */
export function begin(scene: Scene, layout: Layout, pressed: Pressed, tool: string, mods: Mods, clicked: boolean): Begun {
  const { grab } = pressed
  const t = tickAt(scene, layout, pressed.x)
  const commands: Command[] = []
  const started = (drag: Drag | null): Begun => ({ commands, drag: clicked ? null : drag })
  if (grab.kind === 'ruler') return started(null)
  if (tool === 'Hand') return started({ kind: 'pan', lastX: pressed.x, lastY: pressed.y })
  if (tool === 'Zoom') return clicked ? { commands, drag: null, zoom: { factor: mods.alt ? 0.5 : 2, time: t / scene.tps, x: pressed.x } } : started(null)
  // The Razor's arm takes a clip only; on an empty track it selects and marquees as any tool does.
  if (tool === 'Razor' && grab.kind === 'clip') {
    const { time } = snapAt(scene, layout, pressed.x)
    commands.push({ id: 'timeline.razor', params: mods.shift ? { time } : { time, clip: grab.clip } })
    return started(null)
  }
  if ((tool === 'TrackSelectForward' || tool === 'TrackSelectBackward') && (grab.kind === 'clip' || grab.kind === 'empty')) {
    const forward = tool === 'TrackSelectForward'
    const clips = scene.tracks
      .filter((track) => !mods.shift || track.id === grab.track)
      .flatMap((track) => track.clips)
      .filter((clip) => (forward ? end(clip) > t : clip.start < t))
      .map((clip) => clip.id)
    commands.push({ id: 'timeline.select', params: { clips } })
    return started(null)
  }
  if (grab.kind === 'edge') {
    if (clicked) {
      if (tool !== 'Selection' && tool !== 'Ripple' && tool !== 'Rolling') return started(null)
      let kind: string = tool === 'Rolling' ? 'roll' : 'ripple'
      if (tool === 'Selection') {
        const found = findClip(scene, grab.clip)
        const geometry = found ? edgeGeometry(scene, layout, found.track, found.clip, grab.edge, pressed.x) : { distance: Number.POSITIVE_INFINITY, neighbour: false }
        kind = selectionTrimKind(scene.rollRipple, mods.command, mods.shift, geometry.distance, geometry.neighbour)
      }
      commands.push({ id: 'trim.selectEditPoint', params: { clip: grab.clip, edge: grab.edge, kind, add: mods.shift && !mods.command } })
      return started(null)
    }
    switch (grab.trim) {
      case 'trim':
      case 'ripple':
        return started({ kind: 'trim', clip: grab.clip, edge: grab.edge, mode: grab.trim === 'ripple' ? 'ripple' : 'regular', delta: 0, from: t })
      case 'roll':
        return started({ kind: 'roll', left: grab.left ?? grab.clip, right: grab.right ?? grab.clip, delta: 0, from: t })
      case 'stretch':
        return started({ kind: 'stretch', clip: grab.clip, edge: grab.edge, delta: 0, from: t })
      case 'remix':
        return started({ kind: 'remix', clip: grab.clip, delta: 0, from: t })
    }
  }
  // Slip and Slide keep the press's x, read again at each move's scroll (upstream's `press_origin`).
  if (tool === 'Slip' && grab.kind === 'clip') return started({ kind: 'slip', clip: grab.clip, delta: 0, originX: pressed.x })
  if (tool === 'Slide' && grab.kind === 'clip') return started({ kind: 'slide', clip: grab.clip, delta: 0, originX: pressed.x })
  if (grab.kind === 'clip') {
    // Select (Shift toggles; Alt selects one side of a link), as upstream, before a move.
    let selection = [...scene.selection]
    if (mods.shift) {
      commands.push({ id: 'timeline.select', params: { clips: [grab.clip], toggle: true } })
      for (const id of withLinks(scene, [grab.clip])) selection = selection.includes(id) ? selection.filter((each) => each !== id) : [...selection, id]
    } else if (!selection.includes(grab.clip)) {
      if (mods.alt) {
        commands.push({ id: 'timeline.select', params: { clips: [grab.clip], linked: false } })
        selection = [grab.clip]
      } else {
        commands.push({ id: 'timeline.select', params: { clips: [grab.clip] } })
        selection = withLinks(scene, [grab.clip])
      }
    }
    return started({ kind: 'move', clips: selection, grabTick: t, startTrack: grab.track, offset: 0, trackDelta: 0 })
  }
  if (grab.kind === 'empty') {
    if (clicked) commands.push({ id: 'timeline.select', params: { clips: [] } })
    return started({ kind: 'marquee', x0: pressed.x, y0: pressed.y, x1: pressed.x, y1: pressed.y })
  }
  return started(null)
}

/** The track `delta` places from `track` among the tracks of its kind, kept inside them (`shift_track`). */
function shiftTrack(scene: Scene, track: number, delta: number) {
  const kind = trackOf(scene, track)?.kind
  if (delta === 0 || !kind) return track
  const same = scene.tracks.filter((each) => each.kind === kind)
  const at = same.findIndex((each) => each.id === track)
  return same[Math.min(same.length - 1, Math.max(0, at + delta))]?.id ?? track
}

/** One pointer move of a drag: the drag as it stands, the snap indicator's x, and a Hand drag's pan. */
export type Moved = { drag: Drag; snapX: number | null; pan?: { dx: number; dy: number } }

/** `interact`'s drag arm: where the drag stands with the pointer at `x`, `y` (snapped as upstream snaps each kind). */
export function moveDrag(scene: Scene, layout: Layout, drag: Drag, x: number, y: number, _mods: Mods): Moved {
  const here = tickAt(scene, layout, x)
  let snapX: number | null = null
  const snap = (t: number, exclude: readonly number[]) => {
    const snapped = snapTo(scene, layout, t, exclude, true)
    if (snapped.x != null) snapX = snapped.x
    return snapped.time
  }
  switch (drag.kind) {
    case 'pan':
      return { drag: { kind: 'pan', lastX: x, lastY: y }, snapX, pan: { dx: x - drag.lastX, dy: y - drag.lastY } }
    case 'marquee':
      return { drag: { ...drag, x1: x, y1: y }, snapX }
    case 'move': {
      const raw = snapNearest(scene, here - drag.grabTick)
      const clips = drag.clips.map((id) => findClip(scene, id)?.clip).filter((clip): clip is SceneClip => clip != null)
      const first = clips.length ? Math.min(...clips.map((clip) => clip.start)) : 0
      const last = clips.length ? Math.max(...clips.map(end)) : 0
      const s1 = snap(first + raw, drag.clips) - first
      const offset = Math.max(-first, s1 !== raw ? s1 : snap(last + raw, drag.clips) - last)
      const current = rowAt(layout, y)
      const start = layout.rows.find((row) => row.track === drag.startTrack)
      const trackDelta = current && start && current.kind === start.kind ? current.index - start.index : 0
      return { drag: { ...drag, offset, trackDelta }, snapX }
    }
    case 'trim':
    case 'stretch': {
      const found = findClip(scene, drag.clip)
      if (!found) return { drag, snapX }
      const base = drag.edge === 'in' ? found.clip.start : end(found.clip)
      const target = snap(snapNearest(scene, base + (here - drag.from)), [drag.clip])
      return { drag: { ...drag, delta: target - base }, snapX }
    }
    case 'remix': {
      const found = findClip(scene, drag.clip)
      if (!found) return { drag, snapX }
      const target = Math.max(snapNearest(scene, end(found.clip) + (here - drag.from)), found.clip.start + scene.frame)
      return { drag: { ...drag, delta: target - end(found.clip) }, snapX }
    }
    case 'roll': {
      const left = findClip(scene, drag.left)
      if (!left) return { drag, snapX }
      const target = snap(snapNearest(scene, end(left.clip) + (here - drag.from)), [drag.left, drag.right])
      return { drag: { ...drag, delta: target - end(left.clip) }, snapX }
    }
    case 'slip':
      return { drag: { ...drag, delta: -snapNearest(scene, here - tickAt(scene, layout, drag.originX)) }, snapX }
    case 'slide':
      return { drag: { ...drag, delta: snapNearest(scene, here - tickAt(scene, layout, drag.originX)) }, snapX }
  }
}

/** `interact`'s release arm: the one command a drag sends, or null when it changed nothing. */
export function release(scene: Scene, layout: Layout, drag: Drag, x: number, y: number, mods: Mods): Command | null {
  switch (drag.kind) {
    case 'move': {
      if (drag.offset === 0 && drag.trackDelta === 0) return null
      const moves = drag.clips.flatMap((id) => {
        const found = findClip(scene, id)
        return found ? [{ clip: id, track: shiftTrack(scene, found.track.id, drag.trackDelta), time: Math.max(0, found.clip.start + drag.offset) }] : []
      })
      return { id: 'timeline.move', params: { moves, insert: mods.command, linked: false } }
    }
    case 'trim':
      return drag.delta ? { id: 'timeline.trim', params: { clip: drag.clip, edge: drag.edge, mode: drag.mode, delta: drag.delta } } : null
    case 'stretch':
      return drag.delta ? { id: 'timeline.rateStretch', params: { clip: drag.clip, edge: drag.edge, delta: drag.delta } } : null
    case 'remix': {
      const found = findClip(scene, drag.clip)
      return drag.delta ? { id: 'clip.remix', params: { clip: drag.clip, duration: (found?.clip.duration ?? 0) + drag.delta } } : null
    }
    case 'roll':
      return drag.delta ? { id: 'timeline.roll', params: { left: drag.left, right: drag.right, delta: drag.delta } } : null
    case 'slip':
      return drag.delta ? { id: 'timeline.slip', params: { clip: drag.clip, delta: drag.delta } } : null
    case 'slide':
      return drag.delta ? { id: 'timeline.slide', params: { clip: drag.clip, delta: drag.delta } } : null
    case 'marquee': {
      const left = Math.min(drag.x0, x)
      const right = Math.max(drag.x0, x)
      const top = Math.min(drag.y0, y)
      const bottom = Math.max(drag.y0, y)
      const a = tickAt(scene, layout, left)
      const b = tickAt(scene, layout, right)
      const crossed = new Set(layout.rows.filter((row) => row.top < bottom && row.top + row.height > top).map((row) => row.track))
      const clips = scene.tracks.filter((track) => crossed.has(track.id)).flatMap((track) => track.clips.filter((clip) => clip.start < b && end(clip) > a).map((clip) => clip.id))
      return { id: 'timeline.select', params: { clips, add: mods.shift } }
    }
    case 'pan':
      return null
  }
}

/** A clip as a drag shows it: its start and duration (ticks), and the track it is drawn on when it moves to another. */
export type Previewed = { start: number; duration: number; track: number | null }

/** `preview_drag`: the clips a drag moves or resizes, as drawn while it lasts. A Slip moves nothing on the timeline. */
export function preview(scene: Scene, drag: Drag | null): Map<number, Previewed> {
  const out = new Map<number, Previewed>()
  if (!drag) return out
  const at = (id: number) => findClip(scene, id)
  switch (drag.kind) {
    case 'move':
      for (const id of drag.clips) {
        const found = at(id)
        if (found) out.set(id, { start: Math.max(0, found.clip.start + drag.offset), duration: found.clip.duration, track: shiftTrack(scene, found.track.id, drag.trackDelta) })
      }
      break
    case 'remix': {
      const found = at(drag.clip)
      if (found) out.set(drag.clip, { start: found.clip.start, duration: found.clip.duration + drag.delta, track: null })
      break
    }
    case 'trim':
    case 'stretch':
      for (const id of withLinks(scene, [drag.clip])) {
        const found = at(id)
        if (!found) continue
        out.set(id, drag.edge === 'in' ? { start: found.clip.start + drag.delta, duration: found.clip.duration - drag.delta, track: null } : { start: found.clip.start, duration: found.clip.duration + drag.delta, track: null })
      }
      break
    case 'roll': {
      const left = at(drag.left)
      const right = at(drag.right)
      if (left) out.set(drag.left, { start: left.clip.start, duration: left.clip.duration + drag.delta, track: null })
      if (right) out.set(drag.right, { start: right.clip.start + drag.delta, duration: right.clip.duration - drag.delta, track: null })
      break
    }
    case 'slide': {
      const found = at(drag.clip)
      if (found) out.set(drag.clip, { start: found.clip.start + drag.delta, duration: found.clip.duration, track: null })
      break
    }
    default:
      break
  }
  return out
}

/**
 * What a drop on the Timeline carries (upstream `dragged_project_item`, `dragged_source`): a
 * project item, and from the Source monitor its In–Out range and which halves it brings.
 */
export type DropPayload = { item: number; sourceIn?: number; duration?: number; video?: boolean; audio?: boolean }

/** The row a drop at `y` lands on: none, or one of the kind the Source drag does not carry. */
export function dropRow(layout: Layout, y: number, payload: DropPayload) {
  const row = rowAt(layout, y)
  if (!row) return null
  if (payload.sourceIn !== undefined && (row.kind === 'video' ? payload.video === false : payload.audio === false)) return null
  return row
}

/**
 * The drop arm of `interact` (around line 2120): `timeline.place` on the row under the pointer and
 * its pair on the other side (the row's index there, else the first track), at the snapped time,
 * inserting with Cmd; a Source drag adds its range and halves.
 */
export function placeCommand(scene: Scene, layout: Layout, x: number, y: number, payload: DropPayload, mods: Mods): Command | null {
  const row = dropRow(layout, y, payload)
  if (!row || x < 0 || x > layout.width) return null
  const { time } = snapAt(scene, layout, x)
  const video = scene.tracks.filter((track) => track.kind === 'video')
  const audio = scene.tracks.filter((track) => track.kind === 'audio')
  const paired = (tracks: SceneTrack[]) => (tracks[row.index] ?? tracks[0])?.id ?? null
  const params: Record<string, unknown> = {
    item: payload.item,
    track: row.kind === 'video' ? row.track : paired(video),
    audioTrack: row.kind === 'audio' ? row.track : paired(audio),
    time,
    insert: mods.command,
  }
  if (payload.sourceIn !== undefined) {
    params.sourceIn = payload.sourceIn
    params.duration = payload.duration
    params.video = payload.video ?? true
    params.audio = payload.audio ?? true
  }
  return { id: 'timeline.place', params }
}

/** What `sceneOf` reads of the inspected sequence (`film.ts` `FilmInfo`, seconds). */
type SceneSource = {
  tracks: ReadonlyArray<{ id: number; kind: 'video' | 'audio'; clips: ReadonlyArray<{ id: number; item: number; start: number; duration: number; link: number | null }>; transitions: ReadonlyArray<{ id: number; start: number; duration: number }> }>
  selection: readonly number[]
  playhead: number
  markers: ReadonlyArray<{ start: number }>
  in: number | null
  out: number | null
  frame: number
  ticksPerSecond: number
}

/**
 * The gestures' scene from the editor's inspect model (seconds, video tracks top first): times in
 * ticks, tracks V1…Vn then A1…An, and the session's Snap, Linked Selection, and Trim setting.
 */
export function sceneOf(film: SceneSource, session: { snapping: boolean; linkedSelection: boolean } | null, rollRipple: boolean): Scene {
  const tps = film.ticksPerSecond
  const ticks = (seconds: number) => Math.round(seconds * tps)
  const ofKind = (kind: 'video' | 'audio') => {
    const list = film.tracks.filter((track) => track.kind === kind)
    return kind === 'video' ? [...list].reverse() : list
  }
  const tracks = [...ofKind('video'), ...ofKind('audio')].map((track, _, all) => ({
    id: track.id,
    kind: track.kind,
    index: all.filter((each) => each.kind === track.kind).indexOf(track),
    clips: track.clips.map((clip) => ({ id: clip.id, item: clip.item, start: ticks(clip.start), duration: ticks(clip.duration), link: clip.link })),
    transitions: track.transitions.map((transition) => ({ id: transition.id, start: ticks(transition.start), duration: ticks(transition.duration) })),
  }))
  return {
    tracks,
    selection: film.selection,
    playhead: ticks(film.playhead),
    markers: film.markers.map((marker) => ticks(marker.start)),
    in: film.in == null ? null : ticks(film.in),
    out: film.out == null ? null : ticks(film.out),
    frame: Math.round(film.frame * tps),
    tps,
    snapping: session?.snapping ?? true,
    linkedSelection: session?.linkedSelection ?? true,
    rollRipple,
  }
}

/** A selected edit point (the engine's `edit_points`): a clip's In or Out edge and its trim kind. */
export type EditPoint = { clip: number; out: boolean; kind: string }

/**
 * `paint_edit_points`: the brackets the selected edit points draw, at the edge's time on the
 * clip's track; a roll marks both sides of its cut (`roll_pair`), or its own edge when nothing is
 * across it. Red for a ripple, yellow otherwise.
 */
export function editPointMarks(scene: Scene, points: readonly EditPoint[]) {
  const marks: Array<{ clip: number; track: number; time: number; out: boolean; ripple: boolean }> = []
  for (const point of points) {
    const found = findClip(scene, point.clip)
    if (!found) continue
    const { track, clip } = found
    const across = point.kind === 'roll' ? (point.out ? track.clips.find((other) => other.start === end(clip)) : track.clips.find((other) => end(other) === clip.start)) : undefined
    const sides = across ? (point.out ? [[clip, true], [across, false]] : [[across, true], [clip, false]]) : [[clip, point.out]]
    for (const [each, out] of sides as Array<[SceneClip, boolean]>) marks.push({ clip: each.id, track: track.id, time: out ? end(each) : each.start, out, ripple: point.kind === 'ripple' })
  }
  return marks
}

/** `empty_state`'s drop: a project item dropped on the empty Timeline makes a sequence from it. */
export function emptyDropCommand(payload: DropPayload): Command {
  return { id: 'file.newSequence', params: { fromItem: payload.item } }
}
