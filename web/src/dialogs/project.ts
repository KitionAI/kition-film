// Upstream's Project panel dialogs (`panels/project_dialogs.rs` `show`, `metadata_display`,
// `manage_presets`, and `panels/project.rs` `route`'s `metadataDisplay`, `saveViewPresetAs`, and
// `manageViewPresets`, `freeformOptions`, and `saveArrangement` arms): Metadata Display…, Save As
// New View Preset, Manage Saved View Presets, Freeform View Options…, and Save Arrangement….
// Imports carry `.ts` so `node --test` loads this module as it is.
import { FONT_SIZES, asciiLower, type ProjectView } from '../panels/projectModel.ts'
import { DEFAULT_FREEFORM, LAYOUT_WIDTH, freeformOptions, layoutCards, type FreeformOptions } from '../panels/freeform.ts'
import type { DialogContext, DialogControl, DialogRebase, DialogSpec, DialogStep, Draft } from './registry.ts'

/** Upstream's `project_panel::PRESET_SLOTS`. */
export const PRESET_SLOTS = 10

/** The column upstream keeps first and shown (`metadata_display`: its box is greyed, its row has no moves). */
const NAME = 'Name'

/** The draft's columns, in order. */
export const columnsOf = (draft: Draft): string[] => (Array.isArray(draft.columns) ? (draft.columns as string[]) : [])

/** The columns after a field's box is checked (`on`, at the end, as upstream pushes it) or cleared; Name stays. The same list when nothing changes. */
export function toggleColumn(columns: readonly string[], name: string, on: boolean): string[] {
  const shown = columns.includes(name)
  if (name === NAME || shown === on) return columns as string[]
  return on ? [...columns, name] : columns.filter((each) => each !== name)
}

/** The columns after ▲ (`-1`) or ▼ (`1`) on row `index` (upstream: ▲ from the third row, ▼ from the second to the last but one). */
export function moveColumn(columns: readonly string[], index: number, delta: -1 | 1): string[] {
  const allowed = delta < 0 ? index > 1 : index > 0 && index + 1 < columns.length
  if (!allowed) return columns as string[]
  const next = [...columns]
  ;[next[index], next[index + delta]] = [next[index + delta], next[index]]
  return next
}

/** Add Property…: the typed field as a column (a custom metadata field), unless it is empty or shown already (any ASCII case). */
export function addProperty(columns: readonly string[], filter: string): string[] {
  const name = filter.trim()
  if (!name || columns.some((each) => asciiLower(each) === asciiLower(name))) return columns as string[]
  return [...columns, name]
}

/** The fields the search shows (upstream: the field holds the search text, without ASCII case; not trimmed). */
export const shownFields = (all: readonly string[], filter: string) => {
  const wanted = asciiLower(filter)
  return wanted === '' ? [...all] : all.filter((each) => asciiLower(each).includes(wanted))
}

/** One Project Metadata row: its field, whether it is shown, and whether its box is greyed (Name). */
export type FieldView = { name: string; on: boolean; locked: boolean }

/**
 * The Project Metadata rows for the search: every field, then each column no field lists (one
 * Add Property… added that no item has yet, so it can be cleared again), each the object `before`
 * had while it shows the same, so with 200 fields a check draws one memoized row again (lesson 5).
 */
export function fieldViews(before: readonly FieldView[], all: readonly string[], columns: readonly string[], filter: string): FieldView[] {
  const old = new Map(before.map((view) => [view.name, view]))
  const shown = new Set(columns)
  const known = new Set(all)
  return shownFields([...all, ...columns.filter((name) => !known.has(name))], filter).map((name) => {
    const view = { name, on: shown.has(name), locked: name === NAME }
    const was = old.get(name)
    return was && was.on === view.on && was.locked === view.locked ? was : view
  })
}

/**
 * A view preset slot (`project.viewPreset.list`): its number (1–10), name (null while empty), the
 * view mode it restores, and its whole settings (columns, sort, sizes), compared to tell a re-save
 * apart. `captured`: an Overwrite this page replayed saved settings it does not know.
 */
export type PresetSlot = { slot: number; name: string | null; view?: string | null; settings?: unknown; captured?: boolean }

/** The ten slots of `project.viewPreset.list`'s answer (empty ones for a missing answer). */
export function presetSlots(answer: unknown): PresetSlot[] {
  const list = (answer as { presets?: unknown } | null)?.presets
  const named = new Map<number, PresetSlot>()
  if (Array.isArray(list))
    for (const raw of list) {
      const each = raw as { slot?: unknown; name?: unknown; settings?: { mode?: unknown } | null; view?: unknown }
      const view = typeof each.view === 'string' ? each.view : typeof each.settings?.mode === 'string' ? each.settings.mode : null
      if (typeof each.slot === 'number' && typeof each.name === 'string') named.set(each.slot, { slot: each.slot, name: each.name, view, settings: each.settings ?? null })
    }
  return Array.from({ length: PRESET_SLOTS }, (_, i) => named.get(i + 1) ?? { slot: i + 1, name: null })
}

/**
 * The commands that change the Project panel's view: refused while Metadata Display or Manage
 * previews, so the view the strip names and Done captures is the one shown (upstream's dialogs are
 * modal; restarting the preview on each change would let Done capture another view than shown).
 */
const VIEW_COMMANDS: readonly string[] = ['project.view.set', 'project.sort', 'project.columns.resize']

/** Upstream's default preset name (`tlf!("Project View Preset {n}")`), through the page's catalog where the dialog draws it. */
const defaultName = (slot: number, phrase: (text: string) => string = (text) => text) => phrase('Project View Preset {n}').replace('{n}', String(slot))

/**
 * The slots after `steps` ran, as the engine runs them (`preset_save`, `preset_rename`,
 * `preset_delete`; Restore changes the view, not the slots): what the scratch session holds, and
 * what Done leaves.
 */
export function simulatePresets(slots: readonly PresetSlot[], steps: readonly DialogStep[], view: string | null = null): PresetSlot[] {
  return replayPresets(slots, steps, view).slots
}

/** One action as the strip lists it: what it did, to which slot, and the view it restored or captured. */
type Replayed = { command: string; slot: number; name: string; was: string; view: string | null }

/**
 * The slots after `steps` (as `simulatePresets`), each action as it ran, and the view shown after
 * them: Restore shows the slot's view, Overwrite captures the view shown (`view`, the document's
 * when Manage opened).
 */
function replayPresets(slots: readonly PresetSlot[], steps: readonly DialogStep[], view: string | null) {
  const next = slots.map((each) => ({ ...each }))
  const done: Replayed[] = []
  let shown = view
  for (const { command, params } of steps) {
    const at = next.find((each) => each.slot === params.slot)
    if (!at) continue
    const was = at.name ?? ''
    const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : null
    if (command === 'project.viewPreset.delete') {
      at.name = null
      at.view = null
      at.settings = null
      at.captured = false
    } else if (command === 'project.viewPreset.rename' && at.name != null && name) at.name = name
    else if (command === 'project.viewPreset.saveAs') {
      at.name = name ?? at.name ?? defaultName(at.slot)
      at.view = shown
      at.settings = null
      at.captured = true
    } else if (command === 'project.viewPreset.restore' && at.name != null) shown = at.view ?? shown
    done.push({ command, slot: at.slot, name: at.name ?? was, was, view: command === 'project.viewPreset.restore' || command === 'project.viewPreset.saveAs' ? (at.view ?? null) : null })
  }
  return { slots: next, done, shown }
}

const presetsOf = (draft: Draft): PresetSlot[] => presetSlots({ presets: (draft.info as { presets?: unknown } | null | undefined)?.presets })
export const stepsOf = (draft: Draft): DialogStep[] => (Array.isArray(draft.steps) ? (draft.steps as DialogStep[]) : [])
/** The view the document showed as Manage opened (Overwrite captures it until a Restore). */
const openedView = (draft: Draft) => {
  const view = (draft.info as { view?: unknown } | null | undefined)?.view
  return typeof view === 'string' ? view : null
}
/** The slots Manage lists now: the document's, after the actions taken so far. */
export const managedSlots = (draft: Draft) => simulatePresets(presetsOf(draft), stepsOf(draft), openedView(draft))

type T = (key: string, values?: Record<string, string | number>) => string
const viewLabel = (mode: string | null | undefined, phrase: (text: string) => string) => (mode ? phrase(VIEW_LABELS[mode as ProjectView['view']['mode']] ?? mode) : '')
/** The key of a Restore's or an Overwrite's line: with the view's name, or without one when no view was read. */
const withView = (key: string, view: string) => (view ? key : `${key}.noView`)

/** Manage's strip lines: each action taken so far, with the view a Restore leads to and the view an Overwrite captures. */
export function manageLines(draft: Draft, t: T, phrase: (text: string) => string): string[] {
  const { done } = replayPresets(presetsOf(draft), stepsOf(draft), openedView(draft))
  return done.map((each) => {
    const view = viewLabel(each.view, phrase)
    if (each.command === 'project.viewPreset.restore') return t(withView('viewPreset.restores', view), { slot: each.slot, name: each.name, view })
    if (each.command === 'project.viewPreset.saveAs') return t(withView('viewPreset.overwrites', view), { slot: each.slot, name: each.name, view })
    if (each.command === 'project.viewPreset.rename') return t('viewPreset.renames', { slot: each.slot, name: each.name })
    return t('viewPreset.deletes', { slot: each.slot, name: each.was })
  })
}

/** Metadata Display's strip line while no List view on screen draws its columns: how many it shows, and which, in order. */
export function columnLines(draft: Draft, t: T, phrase: (text: string) => string, listShown: boolean): string[] {
  if (listShown) return []
  const columns = columnsOf(draft)
  return [t('preview.columns', { count: columns.length, columns: columns.map((each) => phrase(each)).join(', ') })]
}
export const selectedOf = (draft: Draft) => (typeof draft.selected === 'number' ? draft.selected : 1)

export type ManageAction = 'rename' | 'restore' | 'delete' | 'overwrite'

/**
 * Manage after Rename, Restore, Delete, or Overwrite with Current View on the selected slot: the
 * action joins the steps (upstream runs it at once; here the preview runs the steps so far, and
 * Done runs them for real, in order), and the name shows the slot's after it, as upstream refreshes
 * it. Rename, Restore, and Delete need a saved slot (upstream greys them), Rename a name too
 * (upstream's engine refuses an empty one); the same draft when nothing runs.
 */
export function manageAction(draft: Draft, action: ManageAction): Draft {
  const slot = selectedOf(draft)
  const name = typeof draft.name === 'string' ? draft.name : ''
  const filled = managedSlots(draft).find((each) => each.slot === slot)?.name != null
  let step: DialogStep
  if (action === 'overwrite') step = { command: 'project.viewPreset.saveAs', params: { slot, name: name.trim() ? name : null } }
  else if (!filled) return draft
  else if (action === 'rename') {
    if (!name.trim()) return draft
    step = { command: 'project.viewPreset.rename', params: { slot, name } }
  } else step = { command: `project.viewPreset.${action}`, params: { slot } }
  const next = { ...draft, steps: [...stepsOf(draft), step] }
  return { ...next, name: managedSlots(next).find((each) => each.slot === slot)?.name ?? '' }
}

/** The slots of `project.viewPreset.list` read now, or null when the read failed. */
async function readSlots(ctx: Pick<DialogContext, 'query'>): Promise<PresetSlot[] | null> {
  const answer = await ctx.query('project.viewPreset.list', {})
  return answer ? presetSlots(answer) : null
}

const slotKey = (slot: PresetSlot | undefined) => JSON.stringify([slot?.name ?? null, slot?.view ?? null, slot?.settings ?? null])

/**
 * Whether `fresh` (read now) is the slot `expected` said: the same name and settings, or for one an
 * Overwrite this page ran (its settings unknown here) the same name and, when known, view.
 */
const sameSlot = (expected: PresetSlot | undefined, fresh: PresetSlot | undefined) =>
  expected?.captured ? (expected.name ?? null) === (fresh?.name ?? null) && (expected.view == null || expected.view === (fresh?.view ?? null)) : slotKey(expected) === slotKey(fresh)

/** `next` with each slot that shows the same as in `before` being `before`'s own object (stable rows for the memoized list). */
export const keepSlots = (before: readonly PresetSlot[], next: readonly PresetSlot[]): PresetSlot[] =>
  next.map((slot) => {
    const was = before.find((each) => each.slot === slot.slot)
    return was && slotKey(was) === slotKey(slot) ? was : slot
  })

/** Whether two slot lists hold the same names and views. */
export const samePresets = (a: readonly PresetSlot[], b: readonly PresetSlot[]) => a.length === b.length && a.every((slot, index) => slotKey(slot) === slotKey(b[index]))

/**
 * Manage's draft rebased on `fresh` (the presets as they are now), where `expected` is what its
 * steps were drafted against: the steps on a slot another changed meanwhile go (an Overwrite never
 * replaces what another saved there), and so do those that no longer apply (a Rename of a slot now
 * empty); the rest stay, in order. The name follows the selected slot when it changed.
 */
export function rebasePresets(draft: Draft, fresh: readonly PresetSlot[], expected: readonly PresetSlot[]): { draft: Draft; dropped: number } {
  const changed = new Set(fresh.filter((slot) => !sameSlot(expected.find((each) => each.slot === slot.slot), slot)).map((slot) => slot.slot))
  const kept: DialogStep[] = []
  let dropped = 0
  for (const step of stepsOf(draft)) {
    const slot = step.params.slot as number
    const target = simulatePresets(fresh, kept).find((each) => each.slot === slot)
    if (changed.has(slot) || !target || (step.command !== 'project.viewPreset.saveAs' && target.name == null)) dropped += 1
    else kept.push(step)
  }
  const info = { ...((draft.info as Record<string, unknown> | null | undefined) ?? {}), presets: fresh.map((slot) => ({ ...slot })) }
  const next: Draft = { ...draft, steps: kept, info }
  const selected = selectedOf(draft)
  if (changed.has(selected)) next.name = managedSlots(next).find((each) => each.slot === selected)?.name ?? ''
  return { draft: next, dropped }
}

/**
 * Manage after Done failed once `ran` of its steps had run: those are in the document, so they
 * go, and the rest are rebased on `fresh` (the presets read after the failure) against what the
 * steps that ran left.
 */
export function failedAfter(draft: Draft, ran: number, fresh: readonly PresetSlot[]): DialogRebase {
  const steps = stepsOf(draft)
  const expected = simulatePresets(presetsOf(draft), steps.slice(0, ran), openedView(draft))
  const rebased = rebasePresets({ ...draft, steps: steps.slice(ran) }, fresh, expected)
  return { draft: rebased.draft, notice: { key: 'viewPreset.partlyDone', values: { ran, dropped: rebased.dropped } } }
}

const VIEW_LABELS: Readonly<Record<ProjectView['view']['mode'], string>> = { list: 'List', icon: 'Icon', freeform: 'Freeform' }

/** `project.view.get`'s answer with the fields every column list carries. */
type ViewAnswer = ProjectView & { available?: string[] }

/**
 * A view preference another changed while its dialog is open (an agent's call passes the preview
 * gate as the dialog's own command, and no revision follows it): the draft read again. Each of
 * `fields` the person left as it was read (`info.read`) takes the value read now; one they changed
 * keeps theirs; `info` takes the fresh read. Null when nothing read differs. As Manage's
 * `viewRebase` and `checkOk`: on the panel's view tick, and once more before OK, so OK never
 * overwrites another's change with a value read before it.
 */
export function rebaseView(draft: Draft, fresh: Draft, fields: readonly string[]): Draft | null {
  const info = (draft.info ?? {}) as { read?: Record<string, unknown> }
  const freshInfo = (fresh.info ?? {}) as { read?: Record<string, unknown> }
  const read = info.read ?? {}
  const now = freshInfo.read ?? {}
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (fields.every((field) => same(read[field], now[field])) && same(info, freshInfo)) return null
  const next: Draft = { ...draft, info: fresh.info }
  for (const field of fields) if (same(draft[field], read[field])) next[field] = now[field]
  return next
}

/** `viewRebase` and `checkOk` for a dialog over view preferences, from its `defaults` read again and the draft `fields` they fill. */
const viewFollowing = (defaults: (ctx: DialogContext) => Promise<Draft>, fields: readonly string[]): Pick<DialogSpec, 'viewRebase' | 'checkOk'> => {
  const follow = async (draft: Draft, ctx: DialogContext): Promise<DialogRebase | null> => {
    const fresh = await defaults(ctx).catch(() => null)
    const next = fresh ? rebaseView(draft, fresh, fields) : null
    return next ? { draft: next, notice: null } : null
  }
  return { viewRebase: follow, checkOk: follow }
}

/** Metadata Display's draft: the shown columns, every field, and the columns as read (`info.read`, for `rebaseView`). */
async function metadataDefaults(ctx: DialogContext): Promise<Draft> {
  const view = (await ctx.query('project.view.get', {})) as ViewAnswer | null
  const columns = (view?.view.columns ?? []).map((column) => column.name)
  return { columns, filter: '', info: { all: view?.available ?? columns, read: { columns } } }
}

/** Metadata Display's own controls (a custom body), with upstream's ids. */
const METADATA_CONTROLS: readonly DialogControl[] = [
  { field: 'filter', label: 'Search fields', upstream: ['projectDialog.filter'] },
  { field: 'field', label: 'Project Metadata', upstream: ['projectDialog.field.{}'] },
  { field: 'addProperty', label: 'Add Property…', upstream: ['projectDialog.addProperty'] },
  { field: 'up', label: 'Move up', upstream: ['projectDialog.up.{}'] },
  { field: 'down', label: 'Move down', upstream: ['projectDialog.down.{}'] },
]

const BUTTONS = { ok: 'projectDialog.ok', cancel: 'projectDialog.cancel' }

/**
 * Panel menu ▸ Metadata Display… (and a List view column header's right-click): every field
 * (`project_panel::all_columns`), checked when shown, with a search and Add Property…, beside the
 * shown columns in order with ▲ and ▼. OK runs `project.columns.set {columns}`. Preview: the
 * Project panel's List view with the chosen columns in the chosen order, from the scratch
 * session's `project.items`.
 */
const metadataDisplay: DialogSpec = {
  id: 'project.columns.set',
  aliases: ['projectPanel.metadataDisplay'],
  family: 'project',
  title: 'Metadata Display',
  prefix: 'projectDialog',
  upstream: 'projectDialog',
  buttons: BUTTONS,
  preview: ['project'],
  controls: METADATA_CONTROLS,
  // What it shows follows the draft only.
  dependsOn: () => null,
  defaults: metadataDefaults,
  // Another sets the columns while it is open (an agent's project.columns.set): left alone, they follow.
  ...viewFollowing(metadataDefaults, ['columns']),
  toParams: (draft) => ({ columns: columnsOf(draft) }),
  // The search does not change what OK sets: it does not run the preview again.
  previewKey: (draft) => columnsOf(draft),
  previewBlocks: VIEW_COMMANDS,
  // The columns are drawn by a List view on screen only: elsewhere (the Icon view, the panel hidden), the strip lists them.
  viewLines: (draft, _ctx, t, phrase, listShown) => columnLines(draft, t, phrase, listShown),
}

/**
 * Panel menu ▸ Save As New View Preset: a name, upstream's "Project View Preset n" for the first
 * empty slot; Enter or OK runs `project.viewPreset.saveAs {name}`. It saves a preference, not the
 * project, so it previews as a summary: the slot and name it saves, and the view it captures.
 */
const saveViewPresetAs: DialogSpec = {
  id: 'project.viewPreset.saveAs',
  aliases: ['projectPanel.saveViewPresetAs'],
  family: 'project',
  title: 'Save As New View Preset',
  prefix: 'projectDialog',
  upstream: 'projectDialog',
  buttons: BUTTONS,
  preview: ['summary'],
  layout: [
    { kind: 'text', field: 'name', label: 'Name:', autoFocus: true, width: 240 },
    { kind: 'readout', label: 'Saves the view, columns, sort, thumbnail and font size.', testId: 'note', plain: true, value: () => '' },
  ],
  defaults: async (ctx: DialogContext) => {
    const [presets, view] = await Promise.all([ctx.query('project.viewPreset.list', {}), ctx.query('project.view.get', {})])
    const slots = presetSlots(presets)
    const empty = slots.find((each) => each.name == null)?.slot ?? null
    return { name: defaultName(empty ?? 1, ctx.phrase), info: { slot: empty, view: view as ViewAnswer | null } }
  },
  toParams: (draft) => ({ name: typeof draft.name === 'string' ? draft.name : '' }),
  summary: (draft, _ctx, t, phrase) => {
    const info = (draft.info ?? {}) as { slot?: number | null; view?: ViewAnswer | null }
    if (info.slot == null) return [t('viewPreset.full')]
    const name = typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : defaultName(info.slot, phrase)
    const view = info.view?.view
    if (!view) return [t('viewPreset.saves', { slot: info.slot, name })]
    const font = FONT_SIZES.find(([size]) => size === view.fontSize)?.[1] ?? view.fontSize
    return [t('viewPreset.saves', { slot: info.slot, name }), t('viewPreset.captures', { view: viewLabel(view.mode, phrase), columns: view.columns.length, sort: phrase(view.sort.column), font: phrase(font) })]
  },
}

/** Manage's own controls (a custom body), with upstream's ids; Done is the shared OK. */
const MANAGE_CONTROLS: readonly DialogControl[] = [
  { field: 'preset', label: 'View preset', upstream: ['projectDialog.preset.{}'] },
  { field: 'name', label: 'Name', upstream: ['projectDialog.name'] },
  { field: 'rename', label: 'Rename', upstream: ['projectDialog.rename'] },
  { field: 'restore', label: 'Restore', upstream: ['projectDialog.restore'] },
  { field: 'delete', label: 'Delete', upstream: ['projectDialog.delete'] },
  { field: 'overwrite', label: 'Overwrite with Current View', upstream: ['projectDialog.overwrite'] },
]

/**
 * Panel menu ▸ Manage Saved View Presets: the ten slots, the selected one's name with Rename, and
 * Restore, Delete (no confirmation, rule 6), and Overwrite with Current View. Upstream runs each
 * at once and has only Done; here each joins a list of steps the scratch session runs (the list
 * and the Project panel show the result), Done runs them for real, in order, and Cancel drops
 * them (maintainer decision 3). Upstream's route opens it whatever the slots hold (the menu row
 * greys it with none saved), so the engine is not asked first.
 */
const manageViewPresets: DialogSpec = {
  id: 'projectPanel.manageViewPresets',
  family: 'project',
  title: 'Manage Saved View Presets',
  prefix: 'projectDialog',
  upstream: 'projectDialog',
  buttons: BUTTONS,
  okLabel: 'Done',
  preview: ['project'],
  engine: false,
  controls: MANAGE_CONTROLS,
  dependsOn: () => null,
  defaults: async (ctx: DialogContext) => {
    const [list, view] = await Promise.all([ctx.query('project.viewPreset.list', {}), ctx.query('project.view.get', {})])
    const slots = presetSlots(list)
    const first = slots.find((each) => each.name != null)
    return { selected: first?.slot ?? 1, name: first?.name ?? '', steps: [], info: { presets: slots, view: (view as ViewAnswer | null)?.view.mode ?? null } }
  },
  steps: (draft) => stepsOf(draft),
  // A Restore or an Overwrite may look no different on screen: the strip always lists the actions.
  viewLines: (draft, _ctx, t, phrase) => manageLines(draft, t, phrase),
  // Choosing a slot or typing a name runs nothing: only the actions run the preview again.
  // ... and the presets they start from, which a rebase may replace without dropping a step.
  previewKey: (draft) => [stepsOf(draft), presetsOf(draft)],
  previewBlocks: VIEW_COMMANDS,
  // Presets make no revision: Done reads them again first, and refuses when another changed them.
  checkOk: async (draft, ctx) => {
    const fresh = await readSlots(ctx)
    if (!fresh || samePresets(fresh, presetsOf(draft))) return null
    const rebased = rebasePresets(draft, fresh, presetsOf(draft))
    // Nothing queued was on a changed slot: Done runs on the presets as they are.
    if (rebased.dropped === 0) return { draft: rebased.draft, notice: null }
    return { draft: rebased.draft, notice: { key: 'viewPreset.changedBeforeDone', values: { count: rebased.dropped } } }
  },
  // A step failed once some ran: those are done, so they go; the rest follow the presets as they are now.
  afterFailure: async (draft, ran, ctx) => failedAfter(draft, ran, (await readSlots(ctx)) ?? presetsOf(draft)),
  // Another (an agent, another page) changed the presets: the list follows, and the actions on the slots it changed go.
  viewRebase: async (draft, ctx) => {
    const fresh = await readSlots(ctx)
    if (!fresh || samePresets(fresh, presetsOf(draft))) return null
    const rebased = rebasePresets(draft, fresh, presetsOf(draft))
    return { draft: rebased.draft, notice: rebased.dropped ? { key: 'viewPreset.dropped', values: { count: rebased.dropped } } : null }
  },
}

/** Freeform View Options' draft: the preferences' options, and them as read (`info.read`, for `rebaseView`). */
async function freeformDefaults(ctx: DialogContext): Promise<Draft> {
  const options = freeformOptions(await ctx.query('project.view.get', {}))
  return { ...options, info: { read: { ...options } } }
}

/** Freeform View Options' fields, in upstream's order (`project_dialogs.rs`), with its ranges and `" pt"`. */
const FREEFORM_FIELDS = ['grid', 'cardSize', 'snap', 'showNames', 'showDurations'] as const

/** The draft's options, as `project.freeform.options` takes them (upstream's OK sends all five). */
export function freeformParams(draft: Draft): FreeformOptions {
  const number = (key: 'grid' | 'cardSize') => (typeof draft[key] === 'number' && Number.isFinite(draft[key]) ? (draft[key] as number) : DEFAULT_FREEFORM[key])
  const flag = (key: 'snap' | 'showNames' | 'showDurations') => (typeof draft[key] === 'boolean' ? (draft[key] as boolean) : DEFAULT_FREEFORM[key])
  return { grid: number('grid'), snap: flag('snap'), showNames: flag('showNames'), showDurations: flag('showDurations'), cardSize: number('cardSize') }
}

/**
 * Freeform View Options' strip lines while no Freeform view on screen draws the cards: the sizes
 * and the three switches, by upstream's labels.
 */
export function freeformLines(draft: Draft, t: T, phrase: (text: string) => string, freeformShown: boolean): string[] {
  if (freeformShown) return []
  const options = freeformParams(draft)
  const state = (on: boolean) => t(on ? 'freeform.on' : 'freeform.off')
  return [
    t('freeform.sizes', { size: Math.round(options.cardSize), grid: Math.round(options.grid) }),
    t('freeform.switches', { snap: `${phrase('Snap to grid')}: ${state(options.snap)}`, names: `${phrase('Show clip names')}: ${state(options.showNames)}`, durations: `${phrase('Show durations')}: ${state(options.showDurations)}` }),
  ]
}

/**
 * The bin the Project panel shows and the width its Freeform view lays cards out for, from the
 * params (the canvas menu's) or the panel's state when the dialog opened (`DialogContext`).
 */
const freeformPlace = (ctx: DialogContext) => {
  const bin = typeof ctx.params.bin === 'number' ? ctx.params.bin : (ctx.projectBin ?? null)
  const width = typeof ctx.params.width === 'number' && ctx.params.width > 0 ? ctx.params.width : ctx.freeformWidth && ctx.freeformWidth > 0 ? ctx.freeformWidth : LAYOUT_WIDTH
  return { bin, width: Math.round(width) }
}

/**
 * Panel menu or canvas menu ▸ Freeform View Options… (upstream `route`'s `freeformOptions`): Grid
 * spacing and Default clip size (`DragValue`s in points), Snap to grid, Show clip names, and Show
 * durations, opened on the preferences; OK runs `project.freeform.options` with all five. Preview:
 * project, the Freeform view laid out from the scratch session's `project.freeform.layout` after
 * the options there; where no Freeform view is on screen, the strip lists them.
 */
const freeformOptionsDialog: DialogSpec = {
  id: 'project.freeform.options',
  aliases: ['projectPanel.freeformOptions'],
  family: 'project',
  title: 'Freeform View Options',
  prefix: 'projectDialog',
  upstream: 'projectDialog',
  buttons: BUTTONS,
  preview: ['project'],
  layout: [
    { kind: 'number', field: 'grid', label: 'Grid spacing:', min: 4, max: 200, step: 1, suffix: 'pt' },
    { kind: 'number', field: 'cardSize', label: 'Default clip size:', min: 48, max: 480, step: 1, suffix: 'pt' },
    { kind: 'check', field: 'snap', label: 'Snap to grid' },
    { kind: 'check', field: 'showNames', label: 'Show clip names' },
    { kind: 'check', field: 'showDurations', label: 'Show durations' },
  ],
  // The options are the preferences': nothing selected changes what it shows.
  dependsOn: () => null,
  defaults: freeformDefaults,
  // Another changes the options while it is open (an agent's project.freeform.options): the fields left alone follow.
  ...viewFollowing(freeformDefaults, FREEFORM_FIELDS),
  toParams: (draft) => ({ ...freeformParams(draft) }),
  previewKey: (draft) => FREEFORM_FIELDS.map((field) => freeformParams(draft)[field]),
  // The preview froze the view on the scratch session: what it shows stays the view on screen.
  previewBlocks: VIEW_COMMANDS,
  viewDrawer: 'project:freeform',
  viewLines: (draft, _ctx, t, phrase, freeformShown) => freeformLines(draft, t, phrase, freeformShown),
}

/** The arrangement name typed, trimmed (upstream runs nothing for an empty one). */
const arrangementName = (draft: Draft) => (typeof draft.name === 'string' ? draft.name.trim() : '')

/** What Save Arrangement read of the bin: its cards and the arrangements it has. */
type ArrangementInfo = { bin: number | null; width: number; cards: number; names: string[] }
const arrangementInfo = (draft: Draft): ArrangementInfo => {
  const info = (draft.info ?? {}) as Partial<ArrangementInfo>
  return { bin: info.bin ?? null, width: info.width ?? LAYOUT_WIDTH, cards: info.cards ?? 0, names: Array.isArray(info.names) ? info.names : [] }
}

/** The bin's cards and arrangements now (read again on each revision: a card added or moved meanwhile is what OK records). */
async function arrangementRead(ctx: DialogContext): Promise<ArrangementInfo> {
  const { bin, width } = freeformPlace(ctx)
  const params = bin != null ? { bin } : {}
  const [layout, saved] = await Promise.all([ctx.query('project.freeform.layout', { ...params, width }), ctx.query('project.freeform.arrangements', params)])
  const names = (saved as { arrangements?: unknown } | null)?.arrangements
  return { bin, width, cards: layoutCards(layout)?.length ?? 0, names: Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [] }
}

/**
 * Canvas menu ▸ Save Arrangement… (upstream `route`'s `saveArrangement`): a Name; OK runs
 * `project.freeform.saveArrangement {name, bin, width}` for the bin shown, and nothing for an
 * empty name (upstream's OK does nothing then; here it is greyed). Its preview is a summary: the
 * name, and the cards it records (or replaces, for a name saved before).
 */
const saveArrangement: DialogSpec = {
  id: 'project.freeform.saveArrangement',
  aliases: ['projectPanel.saveArrangement'],
  family: 'project',
  title: 'Save Arrangement',
  prefix: 'projectDialog',
  upstream: 'projectDialog',
  buttons: BUTTONS,
  preview: ['summary'],
  layout: [{ kind: 'text', field: 'name', label: 'Name:', autoFocus: true, width: 240 }],
  // Opens from the canvas menu with its bin and width; a name runs at once (an agent's, a key's).
  opens: (params) => typeof params.name !== 'string',
  defaults: async (ctx: DialogContext) => ({ name: '', info: await arrangementRead(ctx) }),
  // A revision (a card moved, added, or removed meanwhile) reads the bin again; the name typed stays.
  rebase: true,
  baseline: () => ({}),
  toParams: (draft) => {
    const name = arrangementName(draft)
    const { bin, width } = arrangementInfo(draft)
    return name ? { name, ...(bin != null ? { bin } : {}), width } : null
  },
  okEnabled: (draft) => arrangementName(draft) !== '',
  summary: (draft, _ctx, t) => {
    const name = arrangementName(draft)
    const info = arrangementInfo(draft)
    if (!name) return [t('freeform.needsName')]
    return [t(info.names.includes(name) ? 'freeform.replaces' : 'freeform.saves', { name, count: info.cards })]
  },
}

export const PROJECT_DIALOGS: readonly DialogSpec[] = [metadataDisplay, saveViewPresetAs, manageViewPresets, freeformOptionsDialog, saveArrangement]
