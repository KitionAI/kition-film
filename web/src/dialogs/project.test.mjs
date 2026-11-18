// Upstream's Project panel dialogs (Task 18, `project_dialogs.rs`, `project.rs` `route`):
// Metadata Display's order and checks as `project.columns.set`'s columns, Save As New View
// Preset's slot and summary, Manage Saved View Presets' slots and its actions as steps in order,
// the routes, the ids they draw, the Project panel's preview of a column change, and the panel
// reading its view again after a command that changes it, against fake engine reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { DIALOGS, createReadGuard, dialogDeclarations, dialogSteps, draftBaseline, previewSteps, previewsInEngine, runDialog, stepsRan, viewLinesFor } from './registry.ts'
import { PRESET_SLOTS, addProperty, failedAfter, fieldViews, manageAction, manageLines, managedSlots, moveColumn, presetSlots, samePresets, shownFields, simulatePresets, toggleColumn } from './project.ts'
import { createPreviewGate } from '../session/previewGate.ts'
import { previewProjectRows } from '../panels/projectPreview.ts'
import { rowsStillShown } from '../panels/projectModel.ts'
import { routeOf } from '../session/invoke.ts'
import { changesProjectView, createRefreshFrame, rereadsAfter } from '../session/reads.ts'

const COLUMNS = ['Name', 'Frame Rate', 'Media Start', 'Media End', 'Media Duration', 'Video Info']
const AVAILABLE = ['Name', 'Label', 'Media Type', 'Frame Rate', 'Media Start', 'Media End', 'Media Duration', 'Video Info', 'Scene', 'Take']
const VIEW = {
  view: { mode: 'icon', iconSize: 110, fontSize: 'medium', columns: COLUMNS.map((name) => ({ name, width: 110 })), sort: { column: 'Name', descending: false }, iconSort: { column: '', descending: false } },
  previewArea: false,
  thumbnails: false,
  thumbnailsShowEffects: true,
  hoverScrub: true,
  thumbnailControlsAllDevices: false,
  currentPreset: null,
  available: AVAILABLE,
}
const slots = (named) => ({ presets: Array.from({ length: 10 }, (_, i) => ({ slot: i + 1, name: named[i + 1] ?? null })), current: null })
const context = ({ view = VIEW, presets = slots({}) } = {}) => ({
  film: null,
  session: null,
  params: {},
  query: async (id) => (id === 'project.view.get' ? view : id === 'project.viewPreset.list' ? presets : null),
})

const spec = (id) => {
  const found = DIALOGS.get(id)
  assert.ok(found, `${id} is registered`)
  return found
}
const opened = (id, ctx = context()) => Promise.resolve(spec(id).defaults(ctx))

// ---- Metadata Display

test("Metadata Display opens on the List view's columns and every field; its checks and order map to project.columns.set's columns", async () => {
  const id = 'projectPanel.metadataDisplay'
  assert.equal(spec(id).id, 'project.columns.set')
  let draft = await opened(id)
  assert.deepEqual(draft.columns, COLUMNS)
  assert.equal(draft.filter, '')
  assert.deepEqual(draft.info.all, AVAILABLE)
  // Hide Media Duration, show Label (at the end, as upstream pushes it), then move Label up twice.
  draft = { ...draft, columns: toggleColumn(draft.columns, 'Media Duration', false) }
  draft = { ...draft, columns: toggleColumn(draft.columns, 'Label', true) }
  draft = { ...draft, columns: moveColumn(draft.columns, draft.columns.indexOf('Label'), -1) }
  draft = { ...draft, columns: moveColumn(draft.columns, draft.columns.indexOf('Label'), -1) }
  assert.deepEqual(dialogSteps(spec(id), draft, context()), [{ command: 'project.columns.set', params: { columns: ['Name', 'Frame Rate', 'Media Start', 'Label', 'Media End', 'Video Info'] } }])
  // The preview runs the same on the scratch session, for the Project panel to draw.
  assert.deepEqual(spec(id).preview, ['project'])
  assert.deepEqual(previewSteps(spec(id), draft, context()), dialogSteps(spec(id), draft, context()))
})

test("Metadata Display keeps Name first and shown, as upstream's (its box is greyed, its row has no moves)", () => {
  assert.deepEqual(toggleColumn(COLUMNS, 'Name', false), COLUMNS)
  // ▲ is for rows past the second, ▼ for rows past the first and before the last.
  assert.deepEqual(moveColumn(COLUMNS, 1, -1), COLUMNS)
  assert.deepEqual(moveColumn(COLUMNS, 0, 1), COLUMNS)
  assert.deepEqual(moveColumn(COLUMNS, COLUMNS.length - 1, 1), COLUMNS)
  assert.deepEqual(moveColumn(COLUMNS, 2, -1), ['Name', 'Media Start', 'Frame Rate', 'Media End', 'Media Duration', 'Video Info'])
  assert.deepEqual(moveColumn(COLUMNS, 1, 1), ['Name', 'Media Start', 'Frame Rate', 'Media End', 'Media Duration', 'Video Info'])
  // Showing a shown column, or hiding a hidden one, changes nothing.
  assert.equal(toggleColumn(COLUMNS, 'Frame Rate', true), COLUMNS)
  assert.equal(toggleColumn(COLUMNS, 'Scene', false), COLUMNS)
})

test("Metadata Display's search filters the fields without ASCII case, and Add Property… adds the typed field once", () => {
  assert.deepEqual(shownFields(AVAILABLE, 'media'), ['Media Type', 'Media Start', 'Media End', 'Media Duration'])
  assert.deepEqual(shownFields(AVAILABLE, ''), AVAILABLE)
  assert.deepEqual(addProperty(COLUMNS, '  Camera Roll '), [...COLUMNS, 'Camera Roll'])
  // Empty, or a column already shown (any case): nothing.
  assert.equal(addProperty(COLUMNS, '   '), COLUMNS)
  assert.equal(addProperty(COLUMNS, 'frame rate'), COLUMNS)
})

test("Metadata Display's field rows draw again only where they change: with 200 fields, a check changes one row's view", () => {
  const all = Array.from({ length: 200 }, (_, i) => (i === 0 ? 'Name' : `Field ${i}`))
  const before = fieldViews([], all, ['Name', 'Field 3'], '')
  assert.equal(before.length, 200)
  assert.equal(before[0].locked, true)
  assert.equal(before[3].on, true)
  const after = fieldViews(before, all, ['Name', 'Field 3', 'Field 150'], '')
  assert.deepEqual(
    after.map((view, index) => (view === before[index] ? null : view.name)).filter(Boolean),
    ['Field 150'],
  )
})

// ---- Save As New View Preset

test("Save As New View Preset names the first empty slot, sends {name}, and previews as a summary of the slot, name, and view it captures", async () => {
  const id = 'projectPanel.saveViewPresetAs'
  assert.equal(spec(id).id, 'project.viewPreset.saveAs')
  const ctx = context({ presets: slots({ 1: 'Mine', 2: 'Edit' }) })
  const draft = await opened(id, ctx)
  assert.equal(draft.name, 'Project View Preset 3')
  assert.deepEqual(dialogSteps(spec(id), { ...draft, name: 'Review' }, ctx), [{ command: 'project.viewPreset.saveAs', params: { name: 'Review' } }])
  assert.deepEqual(spec(id).preview, ['summary'])
  assert.equal(previewsInEngine(spec(id).preview), false)
  const t = (key, values = {}) => `${key}${JSON.stringify(values)}`
  const lines = spec(id).summary({ ...draft, name: 'Review' }, ctx, t, (text) => text)
  assert.deepEqual(lines, ['viewPreset.saves{"slot":3,"name":"Review"}', 'viewPreset.captures{"view":"Icon","columns":6,"sort":"Name","font":"Medium (default)"}'])
  // All ten slots used: the engine's refusal, as the summary.
  const full = context({ presets: slots(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, `P${i + 1}`]))) })
  const fullDraft = await opened(id, full)
  assert.equal(fullDraft.name, 'Project View Preset 1')
  assert.deepEqual(spec(id).summary(fullDraft, full, t, (text) => text), ['viewPreset.full{}'])
})

test("Save As New View Preset's default name is upstream's template through the page's catalog (tlf!)", async () => {
  const id = 'projectPanel.saveViewPresetAs'
  const phrase = (text) => (text === 'Project View Preset {n}' ? 'Preset {n} (translated)' : text)
  const ctx = { ...context({ presets: slots({ 1: 'Mine' }) }), phrase }
  const draft = await opened(id, ctx)
  assert.equal(draft.name, 'Preset 2 (translated)')
  const t = (key, values = {}) => `${key}${JSON.stringify(values)}`
  assert.equal(spec(id).summary({ ...draft, name: '' }, ctx, t, phrase)[0], 'viewPreset.saves{"slot":2,"name":"Preset 2 (translated)"}')
})

// ---- Manage Saved View Presets

test('the view preset slots list: ten slots, named or empty, from project.viewPreset.list', () => {
  const list = presetSlots(slots({ 2: 'Mine' }))
  assert.equal(list.length, PRESET_SLOTS)
  assert.deepEqual(list[1], { slot: 2, name: 'Mine', view: null, settings: null })
  assert.deepEqual(list[0], { slot: 1, name: null })
  assert.equal(presetSlots(null).length, PRESET_SLOTS)
  assert.ok(presetSlots(null).every((each) => each.name == null))
})

test('Manage opens on the first saved slot, with its name', async () => {
  const draft = await opened('projectPanel.manageViewPresets', context({ presets: slots({ 3: 'Mine', 5: 'Edit' }) }))
  assert.equal(draft.selected, 3)
  assert.equal(draft.name, 'Mine')
  assert.deepEqual(draft.steps, [])
  const none = await opened('projectPanel.manageViewPresets')
  assert.equal(none.selected, 1)
  assert.equal(none.name, '')
})

test("Manage's actions accumulate as steps in order, each upstream's params; Overwrite sends saveAs {slot, name}; Done runs them in order", async () => {
  const id = 'projectPanel.manageViewPresets'
  const ctx = context({ presets: slots({ 1: 'Mine', 2: 'Edit' }) })
  let draft = await opened(id, ctx)
  draft = manageAction(draft, 'restore')
  draft = manageAction({ ...draft, name: 'Mine 2' }, 'rename')
  draft = manageAction({ ...draft, selected: 2, name: 'Edit' }, 'overwrite')
  draft = manageAction({ ...draft, selected: 4, name: '' }, 'overwrite')
  draft = manageAction({ ...draft, selected: 2, name: 'Edit' }, 'delete')
  const expected = [
    { command: 'project.viewPreset.restore', params: { slot: 1 } },
    { command: 'project.viewPreset.rename', params: { slot: 1, name: 'Mine 2' } },
    { command: 'project.viewPreset.saveAs', params: { slot: 2, name: 'Edit' } },
    { command: 'project.viewPreset.saveAs', params: { slot: 4, name: null } },
    { command: 'project.viewPreset.delete', params: { slot: 2 } },
  ]
  assert.deepEqual(dialogSteps(spec(id), draft, ctx), expected)
  // The preview runs every step so far on the scratch session; with none, it previews nothing.
  assert.deepEqual(previewSteps(spec(id), draft, ctx), expected)
  assert.deepEqual(previewSteps(spec(id), await opened(id, ctx), ctx), [])
  assert.deepEqual(spec(id).preview, ['project'])
  assert.equal(spec(id).okLabel, 'Done')
  // The list after them, as the scratch session has it.
  assert.deepEqual(
    simulatePresets(draft.info.presets, draft.steps).map((each) => each.name),
    ['Mine 2', null, null, 'Project View Preset 4', null, null, null, null, null, null],
  )
})

test("Manage refreshes the name to the selected slot's after each action, as upstream's; an empty slot only overwrites, and Rename needs a name", async () => {
  const id = 'projectPanel.manageViewPresets'
  const draft = await opened(id, context({ presets: slots({ 1: 'Mine' }) }))
  const deleted = manageAction(draft, 'delete')
  assert.equal(deleted.name, '')
  // Slot 1 is empty now: Rename, Restore, and Delete do nothing; Overwrite saves into it.
  assert.equal(manageAction(deleted, 'restore'), deleted)
  assert.equal(manageAction(deleted, 'rename'), deleted)
  assert.equal(manageAction(deleted, 'delete'), deleted)
  const saved = manageAction(deleted, 'overwrite')
  assert.equal(saved.name, 'Project View Preset 1')
  assert.equal(manageAction({ ...saved, name: '  ' }, 'rename').steps.length, saved.steps.length)
})

// ---- routes, ids

test("the Project panel's dialog commands open their dialogs with no params; the commands they run run at once with them", () => {
  for (const id of ['projectPanel.metadataDisplay', 'projectPanel.saveViewPresetAs', 'projectPanel.manageViewPresets']) assert.equal(routeOf(id, {}, 'project'), 'dialog', id)
  assert.equal(routeOf('project.columns.set', { columns: ['Name'] }, 'project'), 'session')
  assert.equal(routeOf('project.viewPreset.saveAs', { name: 'Mine' }, 'project'), 'session')
  assert.equal(routeOf('project.viewPreset.restore', { slot: 1 }, 'project'), 'session')
  // The panel's own commands still go to the panel.
  assert.equal(routeOf('projectPanel.viewList', {}, 'project'), 'projectPanel')
})

test("every id upstream's Metadata Display and view preset dialogs register has a declared id standing for it", () => {
  const stands = new Set(dialogDeclarations(DIALOGS).flatMap((item) => item.upstream))
  const freeform = ['projectDialog.cardSize', 'projectDialog.grid', 'projectDialog.showNames', 'projectDialog.showDurations', 'projectDialog.snap']
  const known = upstream.elements.map((element) => element.id).filter((id) => id.startsWith('projectDialog.') && !freeform.includes(id))
  assert.equal(known.length, 13)
  assert.deepEqual(known.filter((id) => !stands.has(id)), [])
  const ids = new Set(dialogDeclarations(DIALOGS).map((item) => item.id))
  for (const id of ['control:dialog.projectDialog.filter', 'control:dialog.projectDialog.field', 'control:dialog.projectDialog.up', 'control:dialog.projectDialog.down', 'control:dialog.projectDialog.preset', 'control:dialog.projectDialog.overwrite', 'control:dialog.projectDialog.name']) assert.ok(ids.has(id), id)
})

// ---- what the Project panel draws of the preview, and when it reads its view again

test("a column change previews in the List view without marking every row changed: a cell of a column one side does not show is no change", () => {
  const row = (item, cells) => ({ item, name: `item ${item}`, depth: 0, cells })
  const doc = [row(8, { 'Frame Rate': '25', 'Media Duration': '00:00:04:00' }), row(9, { 'Frame Rate': '30', 'Media Duration': '00:00:02:00' })]
  const shown = [row(8, { 'Frame Rate': '25', Label: 'Violet' }), row(9, { 'Frame Rate': '30', Label: 'Iris' })]
  const { rows, marks } = previewProjectRows(doc, shown, { items: { added: [], removed: [], changed: [] } })
  assert.equal(marks.size, 0)
  // The preview's own rows, which carry the new column's cells.
  assert.equal(rows[0], shown[0])
  assert.equal(rows[0].cells.Label, 'Violet')
  // A cell both show that differs is still a change.
  const renamed = previewProjectRows(doc, [row(8, { 'Frame Rate': '50' }), doc[1]], null)
  assert.deepEqual(renamed.marks.get('i8'), { mark: 'changed', cells: 'Frame Rate' })
})

test("the commands that change the Project panel's view read it again (they make no revision), whoever runs them", () => {
  for (const command of ['project.view.set', 'project.columns.set', 'project.columns.resize', 'project.sort', 'project.viewPreset.save', 'project.viewPreset.saveAs', 'project.viewPreset.restore', 'project.viewPreset.rename', 'project.viewPreset.delete'])
    assert.equal(changesProjectView(command), true, command)
  for (const command of ['project.view.get', 'project.items', 'project.viewPreset.list', 'project.columns.list', 'project.select']) assert.equal(changesProjectView(command), false, command)
  assert.equal(rereadsAfter('project.viewPreset.restore', 4, 4).projectView, true)
  assert.equal(rereadsAfter('project.select', 4, 4).projectView, false)
})

// ---- spec review: the preview visible wherever the List view is not, phrased labels, view-only reads

const tt = (key, values = {}) => `${key}${JSON.stringify(values)}`
const phraseOf = (text) => `«${text}»`

test("Metadata Display's strip lists the columns it shows while no List view on screen draws them (Icon view, panel hidden), and nothing while one does", async () => {
  const s = spec('projectPanel.metadataDisplay')
  const draft = { ...(await opened('projectPanel.metadataDisplay')), columns: ['Name', 'Label', 'Frame Rate'] }
  assert.deepEqual(viewLinesFor(s, draft, context(), tt, phraseOf, () => false), ['preview.columns{"count":3,"columns":"«Name», «Label», «Frame Rate»"}'])
  assert.deepEqual(viewLinesFor(s, draft, context(), tt, phraseOf, (drawer) => drawer === 'project:view'), [])
  // A dialog without view lines has none.
  assert.deepEqual(viewLinesFor(spec('projectPanel.saveViewPresetAs'), draft, context(), tt, phraseOf, () => false), [])
})

test("Manage's strip lists each action and where it leads, always (a Restore or Overwrite may look no different on screen)", async () => {
  const ctx = context({ presets: { presets: [{ slot: 1, name: 'Mine', settings: { mode: 'list' } }, { slot: 2, name: 'Edit', settings: { mode: 'icon' } }], current: null } })
  let draft = await opened('projectPanel.manageViewPresets', ctx)
  assert.deepEqual(viewLinesFor(spec('projectPanel.manageViewPresets'), draft, ctx, tt, phraseOf, () => true), [])
  draft = manageAction(draft, 'restore')
  draft = manageAction({ ...draft, selected: 2, name: 'Edit' }, 'overwrite')
  draft = manageAction({ ...draft, name: 'Edit 2' }, 'rename')
  draft = manageAction({ ...draft, selected: 1, name: 'Mine' }, 'delete')
  assert.deepEqual(viewLinesFor(spec('projectPanel.manageViewPresets'), draft, ctx, tt, phraseOf, () => true), [
    'viewPreset.restores{"slot":1,"name":"Mine","view":"«List»"}',
    'viewPreset.overwrites{"slot":2,"name":"Edit","view":"«List»"}',
    'viewPreset.renames{"slot":2,"name":"Edit 2"}',
    'viewPreset.deletes{"slot":1,"name":"Mine"}',
  ])
})

test("Save As's summary passes the view, the sort column, and the font size through phrase()", async () => {
  const ctx = context()
  const draft = await opened('projectPanel.saveViewPresetAs', ctx)
  const lines = spec('projectPanel.saveViewPresetAs').summary(draft, ctx, tt, phraseOf)
  assert.equal(lines[1], 'viewPreset.captures{"view":"«Icon»","columns":6,"sort":"«Name»","font":"«Medium (default)»"}')
})

test('a view-only refresh reads the rows again only when the view it reads differs, or the bin or mode shown moved', () => {
  const before = { view: VIEW, mode: 'icon', bin: null }
  assert.equal(rowsStillShown({ onlyView: true, before, view: { ...VIEW }, mode: 'icon', bin: null }), true)
  assert.equal(rowsStillShown({ onlyView: false, before, view: { ...VIEW }, mode: 'icon', bin: null }), false)
  assert.equal(rowsStillShown({ onlyView: true, before, view: { ...VIEW, thumbnails: true }, mode: 'icon', bin: null }), false)
  assert.equal(rowsStillShown({ onlyView: true, before, view: VIEW, mode: 'list', bin: null }), false)
  assert.equal(rowsStillShown({ onlyView: true, before, view: VIEW, mode: 'icon', bin: 4 }), false)
  assert.equal(rowsStillShown({ onlyView: true, before: null, view: VIEW, mode: 'icon', bin: null }), false)
})

test('refreshes made elsewhere in one frame read once, and a view-only one among them is kept (not dropped by the frame already pending)', () => {
  const frames = []
  const ran = []
  const frame = createRefreshFrame((task) => void frames.push(task), (viewOnly) => ran.push(viewOnly))
  frame.refresh(false)
  frame.refresh(true)
  assert.equal(frames.length, 1)
  frames.shift()()
  assert.deepEqual(ran, [true])
  frame.refresh(false)
  frames.shift()()
  assert.deepEqual(ran, [true, false])
  frame.cancel()
})

// ---- code review: Done against the real presets, outside changes, the gate, preview keys

const named = (names) => ({ presets: Array.from({ length: 10 }, (_, i) => ({ slot: i + 1, name: names[i + 1] ?? null, settings: names[i + 1] ? { mode: 'list' } : undefined })), current: null })
const reading = (answers) => ({ ...context(), query: async (id) => (id === 'project.viewPreset.list' ? answers.shift() : id === 'project.view.get' ? VIEW : null) })

test('Done reads the presets again first: changed by another, it is refused on a rebased draft whose steps on the changed slots go', async () => {
  const id = 'projectPanel.manageViewPresets'
  let draft = await opened(id, context({ presets: named({ 1: 'A', 2: 'B', 3: 'C' }) }))
  draft = manageAction(draft, 'delete')
  draft = manageAction({ ...draft, selected: 3, name: 'B2' }, 'rename')
  assert.equal(await spec(id).checkOk(draft, reading([named({ 1: 'A', 2: 'B', 3: 'C' })])), null)
  const refused = await spec(id).checkOk(draft, reading([named({ 1: 'A', 2: 'B' })]))
  assert.deepEqual(refused.notice, { key: 'viewPreset.changedBeforeDone', values: { count: 1 } })
  assert.deepEqual(refused.draft.steps, [{ command: 'project.viewPreset.delete', params: { slot: 1 } }])
  assert.equal(presetSlots({ presets: refused.draft.info.presets })[2].name, null)
})

test('a Done that fails partway drops the steps that ran and follows the presets as they are, so a second Done starts from them', async () => {
  const id = 'projectPanel.manageViewPresets'
  let draft = await opened(id, context({ presets: named({ 1: 'A', 3: 'C' }) }))
  draft = manageAction(draft, 'delete')
  draft = manageAction({ ...draft, selected: 3, name: 'B' }, 'rename')
  // Delete 1 ran; an agent deleted slot 3 meanwhile, so Rename 3 failed.
  const ran = []
  const error = await runDialog(spec(id), draft, context(), async (command, params) => {
    if (command === 'project.viewPreset.rename') throw new Error('that slot is empty')
    ran.push([command, params])
  }).catch((each) => each)
  assert.equal(stepsRan(error), 1)
  assert.equal(error.message, 'that slot is empty')
  const after = await spec(id).afterFailure(draft, stepsRan(error), reading([named({})]))
  assert.deepEqual(after.draft.steps, [])
  assert.deepEqual(after.notice, { key: 'viewPreset.partlyDone', values: { ran: 1, dropped: 1 } })
  assert.ok(presetSlots({ presets: after.draft.info.presets }).every((slot) => slot.name == null))
  assert.deepEqual(dialogSteps(spec(id), after.draft, context()), [])
})

test('Manage follows presets another changes: the list shows them, and an Overwrite of a slot another renamed goes (it never replaces what they saved)', async () => {
  const id = 'projectPanel.manageViewPresets'
  let draft = await opened(id, context({ presets: named({ 1: 'A', 2: 'B' }) }))
  draft = manageAction({ ...draft, selected: 2, name: 'B' }, 'overwrite')
  draft = manageAction({ ...draft, selected: 1, name: 'A2' }, 'rename')
  assert.equal(await spec(id).viewRebase(draft, reading([named({ 1: 'A', 2: 'B' })])), null)
  const rebased = await spec(id).viewRebase(draft, reading([named({ 1: 'A', 2: 'X' })]))
  assert.deepEqual(rebased.draft.steps, [{ command: 'project.viewPreset.rename', params: { slot: 1, name: 'A2' } }])
  assert.deepEqual(rebased.notice, { key: 'viewPreset.dropped', values: { count: 1 } })
  assert.equal(managedSlots(rebased.draft)[1].name, 'X')
})

test("the Project panel's view commands are refused while Metadata Display or Manage previews; other previews leave them alone", () => {
  for (const id of ['projectPanel.metadataDisplay', 'projectPanel.manageViewPresets']) assert.deepEqual([...spec(id).previewBlocks].sort(), ['project.columns.resize', 'project.sort', 'project.view.set'])
  let open = true
  let blocks = new Set(spec('projectPanel.metadataDisplay').previewBlocks)
  const gate = createPreviewGate({ open: () => open, own: () => new Set(['project.columns.set']), blocked: () => blocks, journaled: () => true, message: 'busy' })
  assert.equal(gate.refusal('project.view.set'), 'busy')
  assert.equal(gate.refusal('project.columns.set'), null)
  assert.equal(gate.refusal('playhead.set'), null)
  blocks = new Set()
  assert.equal(gate.refusal('project.view.set'), null)
  open = false
  blocks = new Set(['project.view.set'])
  assert.equal(gate.refusal('project.view.set'), null)
})

test('the preview follows what OK runs only: the search, the slot chosen, and the name typed do not run it again', async () => {
  const metadata = spec('projectPanel.metadataDisplay')
  const draft = await opened('projectPanel.metadataDisplay')
  assert.deepEqual(metadata.previewKey({ ...draft, filter: 'med' }), metadata.previewKey(draft))
  assert.notDeepEqual(metadata.previewKey({ ...draft, columns: ['Name'] }), metadata.previewKey(draft))
  const manage = spec('projectPanel.manageViewPresets')
  const opening = await opened('projectPanel.manageViewPresets', context({ presets: named({ 1: 'A' }) }))
  assert.deepEqual(manage.previewKey({ ...opening, selected: 4, name: 'typed' }), manage.previewKey(opening))
  assert.notDeepEqual(manage.previewKey(manageAction(opening, 'restore')), manage.previewKey(opening))
})

test('a column Add Property… added that no item has keeps a box, so it can be cleared; Metadata Display keeps no rebase baseline', async () => {
  const views = fieldViews([], ['Name', 'Scene'], ['Name', 'Camera Roll'], '')
  assert.deepEqual(views.map((view) => [view.name, view.on]), [['Name', true], ['Scene', false], ['Camera Roll', true]])
  assert.equal(draftBaseline(spec('projectPanel.metadataDisplay'), await opened('projectPanel.metadataDisplay')), null)
})

test("preferences set or reset on the Project panel's keys read its view again; others do not", () => {
  assert.equal(changesProjectView('prefs.set', { key: 'projectPanel.view.mode', value: 'list' }), true)
  assert.equal(changesProjectView('prefs.set', { values: { 'autoSave.maxVersions': 2, 'projectPanel.thumbnails': true } }), true)
  assert.equal(changesProjectView('prefs.set', { key: 'autoSave.intervalMinutes', value: 5 }), false)
  assert.equal(changesProjectView('prefs.reset', {}), true)
  assert.equal(changesProjectView('prefs.reset', { category: 'general' }), false)
  assert.equal(rereadsAfter('prefs.set', 4, 4, { key: 'projectPanel.hoverScrub', value: false }).projectView, true)
})

test("Manage's Restore and Overwrite lines read well with no view read at open", async () => {
  const ctx = { ...context({ presets: named({ 1: 'A' }) }), query: async (id) => (id === 'project.viewPreset.list' ? { presets: [{ slot: 1, name: 'A' }] } : null) }
  let draft = await opened('projectPanel.manageViewPresets', ctx)
  draft = manageAction(draft, 'restore')
  draft = manageAction(draft, 'overwrite')
  assert.deepEqual(manageLines(draft, tt, phraseOf), ['viewPreset.restores.noView{"slot":1,"name":"A","view":""}', 'viewPreset.overwrites.noView{"slot":1,"name":"A","view":""}'])
})

// ---- re-review: Done and a view rebase, the presets a preview starts from, full settings, Done not refused for nothing

const withSettings = (slots) => ({ presets: Array.from({ length: 10 }, (_, i) => (slots[i + 1] ? { slot: i + 1, name: slots[i + 1][0], settings: slots[i + 1][1] } : { slot: i + 1, name: null })), current: null })

test('a view rebase read started before or during Done is dropped (Done in flight owns the draft)', () => {
  const guard = createReadGuard()
  const before = guard.read()
  assert.equal(guard.current(before), true)
  guard.okStart()
  assert.equal(guard.current(before), false, 'a read in flight as Done starts is dropped')
  assert.equal(guard.read(), null, 'no read starts while Done runs')
  guard.okEnd()
  const after = guard.read()
  assert.equal(guard.current(after), true)
})

test("Manage's preview follows the presets it starts from too: a rebase that drops nothing still runs it again", async () => {
  const manage = spec('projectPanel.manageViewPresets')
  const draft = manageAction(await opened('projectPanel.manageViewPresets', context({ presets: named({ 1: 'A', 2: 'B' }) })), 'restore')
  const rebased = await manage.viewRebase(draft, reading([named({ 1: 'A', 2: 'X' })]))
  assert.deepEqual(rebased.draft.steps, draft.steps)
  assert.notDeepEqual(manage.previewKey(rebased.draft), manage.previewKey(draft))
})

test('a preset saved again with the same name and view but other columns or sort is a change', async () => {
  const listView = (sort) => ({ mode: 'list', columns: [{ name: 'Name', width: 220 }], sort: { column: sort, descending: false } })
  const a = presetSlots(withSettings({ 1: ['A', listView('Name')] }))
  const b = presetSlots(withSettings({ 1: ['A', listView('Frame Rate')] }))
  assert.equal(samePresets(a, b), false)
  assert.equal(samePresets(a, presetSlots(withSettings({ 1: ['A', listView('Name')] }))), true)
  // An Overwrite that ran captured settings the page does not know: the slot is not taken for changed by another.
  let draft = await opened('projectPanel.manageViewPresets', { ...context(), query: async (id) => (id === 'project.viewPreset.list' ? withSettings({ 1: ['A', listView('Name')], 2: ['B', listView('Name')] }) : VIEW) })
  draft = manageAction(draft, 'overwrite')
  draft = manageAction({ ...draft, name: 'A2' }, 'rename')
  draft = manageAction({ ...draft, selected: 2, name: 'B' }, 'delete')
  // The Overwrite captured the view shown as Manage opened (the Icon view), with settings of its own.
  const after = failedAfter(draft, 1, presetSlots(withSettings({ 1: ['A', { ...listView('Media Start'), mode: 'icon' }], 2: ['B', listView('Name')] })))
  assert.deepEqual(after.draft.steps.map((step) => step.command), ['project.viewPreset.rename', 'project.viewPreset.delete'])
})

test('Done is not refused when the presets changed only where nothing is queued: it runs on the rebased draft', async () => {
  const id = 'projectPanel.manageViewPresets'
  const draft = manageAction(await opened(id, context({ presets: named({ 1: 'A', 2: 'B' }) })), 'restore')
  const checked = await spec(id).checkOk(draft, reading([named({ 1: 'A', 2: 'X' })]))
  assert.equal(checked.notice, null)
  assert.deepEqual(checked.draft.steps, draft.steps)
  assert.equal(managedSlots(checked.draft)[1].name, 'X')
})

test("prefs.reset of the projectPanel category is not a panel change (the engine has no such category)", () => {
  assert.equal(changesProjectView('prefs.reset', { category: 'projectPanel' }), false)
})
