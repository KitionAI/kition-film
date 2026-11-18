/**
 * Rulers, guides, guide templates, and Snap in Program Monitor, as upstream's
 * `panels/monitor_view.rs` (`snap_axis`, `snap_move`, `draw_snap_lines`, `rulers`, `nice_step`,
 * `guides`, and `dialogs`). Guides are UI state per monitor, in frame pixels (`MonitorView`, rule
 * 5); templates live in the engine's preferences (`prefs.guides.templates`). Screen geometry is in
 * CSS pixels of the monitor's picture element. Pure, so `node --test` runs it.
 */

/** A guide: a vertical line at x = `position`, or a horizontal one at y = `position` (frame pixels). */
export type Guide = { vertical: boolean; position: number }
export type GuideTemplate = { name: string; guides: Guide[] }
export type Rect = { x: number; y: number; width: number; height: number }
export type Point = { x: number; y: number }
export type FrameSize = { width: number; height: number }
/** A line snapped to (`draw_snap_lines`): vertical at x = `at`, or horizontal at y = `at`, on screen. */
export type SnapLine = { vertical: boolean; at: number }
/** What snapping reads of the Program monitor's view. */
export type SnapView = { snap: boolean; showGuides: boolean; guides: readonly Guide[] }

/** Upstream's `RULER`: a ruler's thickness, in points. */
export const RULER = 16
/** Upstream's `SNAP_PX`: the snap distance, in points. */
export const SNAP_PX = 6
/** Half a guide's grab area across, in points (upstream's `c ± 3.0`). */
export const GUIDE_GRAB = 3

const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]

/** `nice_step`: the ruler's labelled step in frame pixels, the first at least 50 points apart. */
export function niceStep(pxPerUnit: number): number {
  return STEPS.find((step) => step * pxPerUnit >= 50) ?? 5000
}

/** A ruler tick: where (screen), its value (frame pixels), and whether it is a labelled major one. */
export type RulerTick = { at: number; value: number; major: boolean }

/**
 * `rulers`' ticks from `from` to `to` on screen, for a picture starting at `origin` with `k` points
 * per frame pixel: a fifth of `nice_step` apart, every fifth major (`i % 5 == 0`).
 */
export function rulerTicks(from: number, to: number, origin: number, k: number): RulerTick[] {
  if (!(k > 0) || !Number.isFinite(k)) return []
  const step = niceStep(k)
  const first = Math.floor(((from - origin) / k / step) * 5)
  const last = Math.ceil(((to - origin) / k / step) * 5)
  const ticks: RulerTick[] = []
  // A runaway range (a picture zoomed far past the ruler) never draws more than this many.
  for (let i = first; i <= last && ticks.length < 2000; i += 1) {
    const value = (i * step) / 5
    ticks.push({ at: origin + value * k, value, major: i % 5 === 0 })
  }
  return ticks
}

/** Points per frame pixel across and down. */
const scaleOf = (pic: Rect, frame: FrameSize) => ({ kx: pic.width / Math.max(1, frame.width), ky: pic.height / Math.max(1, frame.height) })

/** A guide's place on screen (x for a vertical guide, y for a horizontal one). */
export function guideAt(guide: Guide, pic: Rect, frame: FrameSize): number {
  const { kx, ky } = scaleOf(pic, frame)
  return guide.vertical ? pic.x + guide.position * kx : pic.y + guide.position * ky
}

/** The frame pixel under `point` across (`vertical`) or down, rounded, as upstream's guides commit. */
export function positionAt(vertical: boolean, point: Point, pic: Rect, frame: FrameSize): number {
  const { kx, ky } = scaleOf(pic, frame)
  return Math.round(vertical ? (point.x - pic.x) / kx : (point.y - pic.y) / ky)
}

export const contains = (rect: Rect, point: Point) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height

/** `snap_axis`: the moving item's edges against `targets`; the closest pair within `thr`, as the move to make and the target. */
export function snapAxis(edges: readonly number[], targets: readonly number[], thr = SNAP_PX): { delta: number; target: number } | null {
  let best: { delta: number; target: number } | null = null
  for (const edge of edges) {
    for (const target of targets) {
      const delta = target - edge
      if (Math.abs(delta) <= thr && (best == null || Math.abs(delta) < Math.abs(best.delta))) best = { delta, target }
    }
  }
  return best
}

/**
 * `snap_move`: the drag offset `off` of the box `moving` (both on screen), adjusted so the moved
 * box's edges or centre meet the frame's edges or centre, or a shown guide, within `SNAP_PX`; and
 * the lines it snapped to. With Snap in Program Monitor off, `off` as it is.
 */
export function snapMove(view: SnapView, pic: Rect, frame: FrameSize, moving: Rect, off: Point): { off: Point; lines: SnapLine[] } {
  if (!view.snap) return { off, lines: [] }
  const tx = [pic.x, pic.x + pic.width / 2, pic.x + pic.width]
  const ty = [pic.y, pic.y + pic.height / 2, pic.y + pic.height]
  if (view.showGuides) for (const guide of view.guides) (guide.vertical ? tx : ty).push(guideAt(guide, pic, frame))
  const x = moving.x + off.x
  const y = moving.y + off.y
  const next = { ...off }
  const lines: SnapLine[] = []
  const across = snapAxis([x, x + moving.width / 2, x + moving.width], tx)
  if (across) {
    next.x += across.delta
    lines.push({ vertical: true, at: across.target })
  }
  const down = snapAxis([y, y + moving.height / 2, y + moving.height], ty)
  if (down) {
    next.y += down.delta
    lines.push({ vertical: false, at: down.target })
  }
  return { off: next, lines }
}

/** A point (a shape tool's corner) through `snap_move`, as a box with no size. */
export function snapPoint(view: SnapView, pic: Rect, frame: FrameSize, point: Point): { point: Point; lines: SnapLine[] } {
  const { off, lines } = snapMove(view, pic, frame, { x: point.x, y: point.y, width: 0, height: 0 }, { x: 0, y: 0 })
  return { point: { x: point.x + off.x, y: point.y + off.y }, lines }
}

/** A guide drag: out of a ruler (a new guide; the left ruler makes a vertical one), or an unlocked guide moved. */
export type GuideDrag = { kind: 'new'; vertical: boolean } | { kind: 'move'; index: number }

/**
 * What a guide drag shows with the pointer at `point`: the guides (one moved while the pointer is
 * in the picture area `area`; dragged out of it, a guide keeps its last place until the drop),
 * whether the pointer is outside (dropping there removes the guide), and a new guide's line.
 * `guides` itself while nothing moved.
 */
export function dragGuides(guides: readonly Guide[], drag: GuideDrag, point: Point, area: Rect, pic: Rect, frame: FrameSize): { guides: readonly Guide[]; outside: boolean; line: SnapLine | null } {
  const outside = !contains(area, point)
  if (drag.kind === 'new') return { guides, outside, line: outside ? null : { vertical: drag.vertical, at: drag.vertical ? point.x : point.y } }
  const guide = guides[drag.index]
  if (!guide || outside) return { guides, outside, line: null }
  const position = positionAt(guide.vertical, point, pic, frame)
  if (position === guide.position) return { guides, outside, line: null }
  return { guides: guides.map((each, index) => (index === drag.index ? { ...each, position } : each)), outside, line: null }
}

/**
 * The guides after a drag is released at `point` (upstream's `drag_stopped`): a new guide inside
 * the picture area joins them, a moved guide takes its place there, and a guide dropped outside is
 * removed. `guides` itself when nothing changes.
 */
export function endGuideDrag(guides: readonly Guide[], drag: GuideDrag, point: Point, area: Rect, pic: Rect, frame: FrameSize): readonly Guide[] {
  const outside = !contains(area, point)
  if (drag.kind === 'new') return outside ? guides : [...guides, { vertical: drag.vertical, position: positionAt(drag.vertical, point, pic, frame) }]
  if (!guides[drag.index]) return guides
  if (outside) return guides.filter((_, index) => index !== drag.index)
  return dragGuides(guides, drag, point, area, pic, frame).guides
}

/** A monitor (`MonitorView`'s owner). */
export type GuideMonitor = 'program' | 'source'

/**
 * A dialog's guides on a monitor while it is open (UI only, never the engine): Add Guide's typed
 * guide over the monitor's own, or Manage ▸ Apply's template in place of them (`replace`).
 */
export type GuidePreview = { monitor: GuideMonitor; guides: readonly Guide[]; replace: boolean } | null

/** A guide drawn on a monitor, and whether it is a dialog's preview. */
export type ShownGuide = { guide: Guide; preview: boolean; index: number }

/**
 * The guides a monitor draws: its own while Show Guides is on, and an open dialog's preview for
 * it, marked (shown whether or not guides are, as the dialog's OK shows them).
 */
export function shownGuides(view: { showGuides: boolean; guides: readonly Guide[] }, preview: GuidePreview, monitor: GuideMonitor): ShownGuide[] {
  const mine = preview && preview.monitor === monitor ? preview : null
  const own = view.showGuides && !mine?.replace ? view.guides.map((guide, index) => ({ guide, preview: false, index })) : []
  return [...own, ...(mine ? mine.guides.map((guide, index) => ({ guide, preview: true, index })) : [])]
}

/** Add Guide's draft: the orientation and the position typed. */
export type AddGuideDraft = { vertical: boolean; position: number }

/** Upstream's route opens Add Guide vertical at the frame's middle (`(width / 2) as f64`, 960 with no frame). */
export const addGuideDraft = (frame: FrameSize | null): AddGuideDraft => ({ vertical: true, position: frame ? Math.floor(frame.width / 2) : 960 })

/** Add Guide's preview: the typed guide on its monitor, over the monitor's own. */
export const addGuidePreview = (draft: AddGuideDraft, monitor: GuideMonitor): GuidePreview => ({ monitor, guides: [{ vertical: draft.vertical, position: draft.position }], replace: false })

/** Add Guide's OK: upstream's `view.addGuide` on the monitor it opened for. */
export const addGuideParams = (draft: AddGuideDraft, monitor: GuideMonitor) => ({ monitor, orientation: draft.vertical ? 'vertical' : 'horizontal', position: draft.position })

/** Guides as the strip lists them ("Vertical guide at 640 px"): the editor's own strings (`guides.vertical`, `guides.horizontal`), through `t`. */
export function guideLines(guides: readonly Guide[], t: (key: string, values: Record<string, string | number>) => string): string[] {
  return guides.map((guide) => t(guide.vertical ? 'guides.vertical' : 'guides.horizontal', { position: guide.position }))
}

const isGuide = (value: unknown): value is Guide => {
  const guide = value as { vertical?: unknown; position?: unknown } | null
  return typeof guide?.position === 'number' && Number.isFinite(guide.position) && (guide.vertical === undefined || typeof guide.vertical === 'boolean')
}

/** `prefs.get {key: "guides.templates"}`'s answer as templates; anything unreadable is dropped. */
export function parseTemplates(raw: unknown): GuideTemplate[] {
  if (!Array.isArray(raw)) return []
  const out: GuideTemplate[] = []
  for (const item of raw) {
    const template = item as { name?: unknown; guides?: unknown } | null
    if (typeof template?.name !== 'string') continue
    const guides = Array.isArray(template.guides) ? template.guides.filter(isGuide).map((guide) => ({ vertical: guide.vertical === true, position: guide.position })) : []
    out.push({ name: template.name, guides })
  }
  return out
}

/** Upstream's `save_template`: the name trimmed and needed; a template of that name is replaced, at the end. */
export function saveTemplate(list: readonly GuideTemplate[], name: string, guides: readonly Guide[]): GuideTemplate[] {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('the template needs a name')
  return [...list.filter((template) => template.name !== trimmed), { name: trimmed, guides: guides.map((guide) => ({ ...guide })) }]
}

/** The templates without `names` (upstream's `guideTemplates.delete`, one name at a time). */
export const deleteTemplates = (list: readonly GuideTemplate[], names: readonly string[]): GuideTemplate[] => list.filter((template) => !names.includes(template.name))

export const sameGuides = (a: readonly Guide[], b: readonly Guide[]) => a.length === b.length && a.every((guide, index) => guide.vertical === b[index].vertical && guide.position === b[index].position)
export const sameTemplates = (a: readonly GuideTemplate[], b: readonly GuideTemplate[]) => a.length === b.length && a.every((template, index) => template.name === b[index].name && sameGuides(template.guides, b[index].guides))

/**
 * Manage Guides' draft: the templates as last read, the row chosen, and the actions it previews
 * until Close (maintainer decision 3; upstream runs each at once): the template applied (its
 * guides as they were when applied) and the templates deleted.
 */
export type ManageDraft = { templates: readonly GuideTemplate[]; selected: string | null; applied: GuideTemplate | null; deleted: readonly string[] }

/** Apply: the template's guides preview on the monitor until Close or Cancel. */
export function manageApply(draft: ManageDraft, name: string): ManageDraft {
  const template = draft.templates.find((each) => each.name === name && !draft.deleted.includes(each.name))
  return template ? { ...draft, applied: { name: template.name, guides: template.guides.map((guide) => ({ ...guide })) } } : draft
}

/** Delete (no confirmation, as upstream's): the template leaves the list until Close runs it, and no row is chosen. */
export function manageDelete(draft: ManageDraft, name: string): ManageDraft {
  if (draft.deleted.includes(name) || !draft.templates.some((each) => each.name === name)) return draft
  return { ...draft, deleted: [...draft.deleted, name], selected: null }
}

/** The list Manage shows: the templates without those it deletes. */
export const manageShown = (draft: ManageDraft) => draft.templates.filter((template) => !draft.deleted.includes(template.name))

/**
 * The draft on templates another page or an agent changed: the list follows; an applied template
 * that changed or went, and a deleted one that changed or went, are dropped (counted, for the
 * notice); the chosen row goes when its template did.
 */
export function manageRebase(draft: ManageDraft, fresh: readonly GuideTemplate[]): { draft: ManageDraft; dropped: number } {
  if (sameTemplates(draft.templates, fresh)) return { draft, dropped: 0 }
  const before = (name: string) => draft.templates.find((template) => template.name === name)
  const now = (name: string) => fresh.find((template) => template.name === name)
  const kept = (name: string) => {
    const old = before(name)
    const live = now(name)
    return old != null && live != null && sameGuides(old.guides, live.guides)
  }
  let dropped = 0
  let applied = draft.applied
  if (applied && !(kept(applied.name) && sameGuides(applied.guides, now(applied.name)?.guides ?? []))) {
    applied = null
    dropped += 1
  }
  const deleted = draft.deleted.filter((name) => kept(name))
  dropped += draft.deleted.length - deleted.length
  const selected = draft.selected != null && now(draft.selected) ? draft.selected : null
  return { draft: { templates: fresh, selected, applied, deleted }, dropped }
}

/**
 * Close's deletes on the templates as they are now (`list`): a template goes only while it is the
 * one the dialog showed; one another page or an agent changed since stays, counted in `dropped`
 * (one already gone is nothing to drop).
 */
export function manageDeletes(list: readonly GuideTemplate[], draft: ManageDraft): { templates: GuideTemplate[]; dropped: number } {
  let dropped = 0
  const gone = new Set<string>()
  for (const name of draft.deleted) {
    const shown = draft.templates.find((template) => template.name === name)
    const now = list.find((template) => template.name === name)
    if (!now) continue
    if (shown && sameGuides(shown.guides, now.guides)) gone.add(name)
    else dropped += 1
  }
  return { templates: list.filter((template) => !gone.has(template.name)), dropped }
}

/** Close: the templates to keep (`fresh` without the deleted ones) and the guides the monitor takes (null: none applied). */
export function manageCommit(draft: ManageDraft, fresh: readonly GuideTemplate[]): { templates: GuideTemplate[]; guides: Guide[] | null } {
  return { templates: deleteTemplates(fresh, draft.deleted), guides: draft.applied ? draft.applied.guides.map((guide) => ({ ...guide })) : null }
}

/** A value outside React that components follow (`useSyncExternalStore`); a `set` of the same value tells nobody. */
export type ValueStore<T> = { get: () => T; set: (next: T) => void; subscribe: (listener: () => void) => () => void }

export function createValueStore<T>(initial: T, same: (a: T, b: T) => boolean = Object.is): ValueStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      if (same(value, next)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

/**
 * Where a monitor draws its picture, in its picture element's pixels: the picture area (inside the
 * rulers; the current picture's half in the Comparison View) and the frame in it; null while it
 * draws no picture (a sound-only clip, the waveform).
 */
export type GuideGeometry = { area: Rect; pic: Rect; frame: FrameSize } | null

const sameRect = (a: Rect, b: Rect) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01
export const sameGeometry = (a: GuideGeometry, b: GuideGeometry) => a === b || (a != null && b != null && sameRect(a.area, b.area) && sameRect(a.pic, b.pic) && a.frame.width === b.frame.width && a.frame.height === b.frame.height)

/**
 * The guide dialogs' Kit UI ids (rule 3): each field `control:dialog.<prefix>.<field>` standing for
 * upstream's `guides.<dialog>.<field>`; OK (Manage's Close) and Cancel are the shared
 * `control:dialog.ok` and `control:dialog.cancel`.
 */
export const GUIDE_DIALOG_IDS = {
  vertical: 'control:dialog.guides.add.vertical',
  horizontal: 'control:dialog.guides.add.horizontal',
  position: 'control:dialog.guides.add.position',
  name: 'control:dialog.guides.save.name',
  row: 'control:dialog.guides.manage.row',
  apply: 'control:dialog.guides.manage.apply',
  delete: 'control:dialog.guides.manage.delete',
} as const

/** The guide dialogs' ids for `filmUi.ts`, each with its label and the upstream ids it stands for. */
export const GUIDE_DIALOG_DECLARATIONS: ReadonlyArray<{ id: string; label: string; upstream: readonly string[] }> = [
  { id: GUIDE_DIALOG_IDS.vertical, label: 'Vertical', upstream: ['guides.add.vertical'] },
  { id: GUIDE_DIALOG_IDS.horizontal, label: 'Horizontal', upstream: ['guides.add.horizontal'] },
  { id: GUIDE_DIALOG_IDS.position, label: 'Position', upstream: ['guides.add.position'] },
  { id: GUIDE_DIALOG_IDS.name, label: 'Name', upstream: ['guides.save.name'] },
  { id: GUIDE_DIALOG_IDS.row, label: 'Guide template', upstream: ['guides.manage.row.{}'] },
  { id: GUIDE_DIALOG_IDS.apply, label: 'Apply', upstream: ['guides.manage.apply'] },
  { id: GUIDE_DIALOG_IDS.delete, label: 'Delete', upstream: ['guides.manage.delete'] },
]
/** Upstream's OK and Cancel of the guide dialogs (Manage's Close is its OK), which the shared `control:dialog.ok` and `control:dialog.cancel` stand for. */
export const GUIDE_DIALOG_BUTTONS = { ok: ['guides.add.ok', 'guides.save.ok', 'guides.manage.close'], cancel: ['guides.add.cancel', 'guides.save.cancel'] } as const
