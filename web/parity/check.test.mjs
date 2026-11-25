// Checks that film-status.json tracks exactly the items film-upstream.json declares, that every
// "hidden" item explains why, that every follow-up (`followUps: [{ wave, item }]`, a gap a "done"
// entry leaves) is due in a later wave or names a remaining task of its wave (a test Task 22 switches on
// fails while any of those is left), and, once the editor's menus exist (and
// `pnpm --dir web engine` has built the engine), that the menus agree with the status file and the
// engine. Run with `pnpm --dir web test:parity`.
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ruleWaves } from './waves.mjs'
import { kitCommand } from './renames.ts'

const manifest = JSON.parse(readFileSync(new URL('./film-upstream.json', import.meta.url), 'utf8'))
const status = JSON.parse(readFileSync(new URL('./film-status.json', import.meta.url), 'utf8'))

/** A module of the editor, or null while the task that writes it has not landed. */
async function optional(relative) {
  const url = new URL(relative, import.meta.url)
  return existsSync(url) ? import(url.href) : null
}
const hidden = await optional('../src/menus/hidden.ts')
const catalog = await optional('../src/menus/catalog.ts')
const kitMenus = await optional('../src/menus/kitMenus.ts')

// The manifest and the status file keep the ids of before the command naming standard (2026-11-25);
// where a test meets the engine or the editor's own commands, the id goes through `kitCommand` (renames.ts).
const menuKey = (row) => `menu:${row.path.join('/')}/${row.command}`
/** Every key the manifest implies, with the wave the plan's rules give it (waves.mjs). */
const rules = ruleWaves(manifest)

const expectedKeys = new Set(rules.keys())
const statusKeys = new Set(Object.keys(status))

test('every manifest item has a status entry', () => {
  const missing = [...expectedKeys].filter((k) => !statusKeys.has(k))
  assert.deepEqual(missing, [], `missing status entries (rerun parity/extract.mjs): ${missing.slice(0, 20).join(', ')}`)
})

test('no status entry names an item the manifest lacks', () => {
  const extra = [...statusKeys].filter((k) => !expectedKeys.has(k))
  assert.deepEqual(extra, [], `status entries with no manifest item: ${extra.slice(0, 20).join(', ')}`)
})

test('hidden entries have a non-empty reason', () => {
  const badHidden = Object.entries(status)
    .filter(([, v]) => v.status === 'hidden')
    .filter(([, v]) => typeof v.reason !== 'string' || v.reason.trim() === '')
    .map(([k]) => k)
  assert.deepEqual(badHidden, [], `hidden entries missing a reason: ${badHidden.slice(0, 20).join(', ')}`)
})

test('status entries use a known status and wave', () => {
  const bad = Object.entries(status)
    .filter(([, v]) => !['done', 'hidden', 'todo'].includes(v.status) || ![1, 2, 3].includes(v.wave))
    .map(([k]) => k)
  assert.deepEqual(bad, [], `status entries with an invalid status or wave: ${bad.slice(0, 20).join(', ')}`)
})

test('a todo entry without a reason or note carries the wave the rules give it', () => {
  const wrong = Object.entries(status)
    .filter(([key, v]) => v.status === 'todo' && !v.reason && !v.note && rules.has(key) && v.wave !== rules.get(key))
    .map(([key, v]) => `${key}: ${v.wave}, the rules say ${rules.get(key)}`)
  assert.deepEqual(wrong, [], 'set the rule wave, or say why the entry moved (reason or note)')
})

/**
 * Registrations whose id the extractor cannot read from upstream's source (both later-wave
 * files): the audio effect editor's ids are built at run time and pushed as values, and the
 * export mode's `Reg::flush` re-registers what its `reg.add` calls (which are read) collected.
 */
const KNOWN_UNRESOLVED = ['panels/audio_fx_editor.rs:218 auto.add(&id, r, &label);', 'panels/export_mode.rs:105 auto.add(&id, r, &l);']

test('no registration loses its id beyond the known ones', () => {
  assert.deepEqual(manifest.unresolved, KNOWN_UNRESOLVED, 'resolve the new registration in parity/extract.mjs, or add it here with why it cannot be read')
})

/**
 * Wave 1's checkpoint (Task 22) flipped this to true (it was off before, unless FILM_CHECKPOINT=1): from then on
 * no follow-up may be due in its own entry's wave, since every task that could close one is done.
 */
const CHECKPOINT = true
/** The wave-1 tasks still to come before the checkpoint, which a same-wave follow-up may name: none since Task 21. */
const LATER_TASKS = []

const followUpsOf = () =>
  Object.entries(status).flatMap(([key, value]) => (value.followUps === undefined ? [] : Array.isArray(value.followUps) ? value.followUps.map((followUp) => [key, value, followUp]) : [[key, value, null]]))
/** A follow-up due in its entry's own wave, naming the later tasks it waits for ("Task 18 and Task 16"). */
const sameWaveTasks = (followUp) => [...followUp.item.matchAll(/\bTasks? (\d+)(?:\s*(?:and|,)\s*(?:Task )?(\d+))*/g)].flatMap((match) => match.slice(1).filter(Boolean).map(Number))

test("follow-ups name an item and a wave after their entry's, or a remaining task of the same wave", () => {
  const later = (value, followUp) => {
    if (followUp.wave > value.wave) return true
    if (followUp.wave !== value.wave) return false
    const tasks = sameWaveTasks(followUp)
    return tasks.length > 0 && tasks.every((task) => LATER_TASKS.includes(task))
  }
  const bad = followUpsOf()
    .filter(([, value, followUp]) => !followUp || typeof followUp.item !== 'string' || followUp.item.trim() === '' || ![1, 2, 3].includes(followUp.wave) || !later(value, followUp))
    .map(([key, , followUp]) => `${key}: ${JSON.stringify(followUp)}`)
  assert.deepEqual(bad, [], 'a follow-up needs an item and a later wave than its entry, or names the remaining task(s) of its wave that close it')
})

test('at the checkpoint, no follow-up is left for a task of its own wave', { skip: !CHECKPOINT && 'switched on by Task 22 (CHECKPOINT, or FILM_CHECKPOINT=1)' }, () => {
  const left = followUpsOf()
    .filter(([, value, followUp]) => followUp && followUp.wave === value.wave)
    .map(([key, , followUp]) => `${key}: ${followUp.item}`)
  assert.deepEqual(left, [], 'close these, or move them to a later wave, before the checkpoint')
})

test('web-hidden menu rows, and only they, are hidden in the status file', { skip: hidden ? false : 'web/src/menus/hidden.ts does not exist yet (Task 9)' }, () => {
  const wrong = manifest.menus.filter((row) => (status[menuKey(row)]?.status === 'hidden') !== hidden.isHiddenOnWeb({ ...row, command: kitCommand(row.command) })).map((row) => row.command)
  assert.deepEqual(wrong, [], `status disagrees with isHiddenOnWeb: ${wrong.join(', ')}`)
})

const engineDir = new URL('../public/engine/', import.meta.url)
const engine = existsSync(new URL('kition_film_kit_bg.wasm', engineDir))
  ? await (async () => {
      const sdk = await import(new URL('kition_film_kit.js', engineDir).href)
      sdk.initSync({ module: readFileSync(new URL('kition_film_kit_bg.wasm', engineDir)) })
      const doc = sdk.FilmDocument.create('Untitled', 1920, 1080)
      const commands = new Map(JSON.parse(doc.commands()).map((command) => [command.id, command]))
      // The Effects panel draws the engine's effect, folder, and preset names through phrase(), and
      // Effect Controls draws their parameter names and choice options (`effect.list` with `detail`).
      const { effectDefsOf, effectLabels, paramLabels, presetsOf } = await import(new URL('../src/panels/effectsTree.ts', import.meta.url).href)
      const listed = effectLabels(effectDefsOf(JSON.parse(doc.execute('effect.list', '{}'))), presetsOf(JSON.parse(doc.execute('preset.list', '{}'))))
      commands.effectLabels = new Set([...listed, ...paramLabels(JSON.parse(doc.execute('effect.list', JSON.stringify({ detail: true }))))])
      return commands
    })()
  : null

test("engine rows sit under the engine's menu path", { skip: engine ? false : 'the web engine is not built' }, () => {
  const rows = [...manifest.menus.filter((row) => row.origin === 'engine').map((row) => ({ ...row, command: kitCommand(row.command) })), ...(catalog ? catalog.FILM_MENUS.filter((row) => engine.has(row.command)) : [])]
  const differ = rows.filter((row) => engine.get(row.command)?.menu?.join('/') !== row.path.join('/')).map((row) => `${row.command}: ${row.path.join('/')} vs ${engine.get(row.command)?.menu?.join('/')}`)
  assert.deepEqual(differ, [], 'rows whose path differs from the engine (rerun parity/extract.mjs)')
})

test('every engine command with a menu path is a menu row, or hidden on the web', { skip: !engine ? 'the web engine is not built' : !catalog || !hidden ? 'web/src/menus/catalog.ts and hidden.ts do not exist yet (Tasks 9 and 11)' : false }, () => {
  const rows = new Set(catalog.FILM_MENUS.map((row) => row.command.replace(/^kit:/, '')))
  const missing = [...engine.values()].filter((command) => command.menu?.length && !rows.has(command.id) && !hidden.hiddenReason(command.id)).map((command) => command.id)
  assert.deepEqual(missing, [], 'engine commands the menus lose (rerun parity/extract.mjs)')
})

test('done menu rows are engine commands or Kition kit: rows', { skip: !engine ? 'the web engine is not built' : !catalog ? 'web/src/menus/catalog.ts does not exist yet (Task 11)' : false }, () => {
  const kitRows = new Set(catalog.FILM_MENUS.filter((row) => row.command.startsWith('kit:')).map((row) => row.command.slice(4)))
  const takeovers = kitMenus?.KIT_TAKEOVERS ?? {}
  const wrong = Object.entries(status)
    .filter(([key, value]) => key.startsWith('menu:') && value.status === 'done')
    .map(([key]) => kitCommand(key.split('/').pop()))
    .filter((command) => !engine.has(command) && !kitRows.has(command) && !takeovers[command])
  assert.deepEqual(wrong, [], `done rows that are neither engine commands nor kit: rows: ${wrong.join(', ')}`)
})

test('wave 1 is finished: every wave-1 item is done or hidden, and every todo deferred from it says why', () => {
  const open = Object.entries(status)
    .filter(([, v]) => v.wave === 1 && v.status === 'todo')
    .map(([key]) => key)
  assert.deepEqual(open, [], 'wave-1 items still todo (finish them, or defer them to a later wave with a reason)')
  // Every item the rules put in wave 1 that is still todo was deferred, and its reason says why.
  const silent = Object.entries(status)
    .filter(([key, v]) => v.status === 'todo' && rules.get(key) === 1 && !(typeof v.reason === 'string' && v.reason.trim()))
    .map(([key]) => key)
  assert.deepEqual(silent, [], 'items the rules give wave 1, deferred without a reason')
})

test('prints counts per wave and status, and the follow-ups', () => {
  const byWave = {}
  const byStatus = {}
  const byKind = {}
  const followUps = {}
  for (const [key, v] of Object.entries(status)) {
    const kind = key.slice(0, key.indexOf(':'))
    byWave[v.wave] = (byWave[v.wave] ?? 0) + 1
    byStatus[v.status] = (byStatus[v.status] ?? 0) + 1
    byKind[kind] ??= {}
    byKind[kind][`${v.status} w${v.wave}`] = (byKind[kind][`${v.status} w${v.wave}`] ?? 0) + 1
    for (const followUp of v.followUps ?? []) (followUps[followUp.wave] ??= []).push(`${key}: ${followUp.item}`)
  }
  console.log(`parity manifest: ${expectedKeys.size} items`)
  console.log(`  by wave: ${JSON.stringify(byWave)}`)
  console.log(`  by status: ${JSON.stringify(byStatus)}`)
  for (const [kind, counts] of Object.entries(byKind)) console.log(`  ${kind}: ${JSON.stringify(counts)}`)
  console.log(`  follow-ups by wave: ${JSON.stringify(Object.fromEntries(Object.entries(followUps).map(([wave, items]) => [wave, items.length])))}`)
  for (const [wave, items] of Object.entries(followUps)) for (const item of items) console.log(`    wave ${wave}: ${item}`)
  // The items the rules put in wave 1 that are still todo (deferred from wave 1), by reason, each named.
  const deferred = new Map()
  for (const [key, v] of Object.entries(status)) if (v.status === 'todo' && rules.get(key) === 1) deferred.set(`to wave ${v.wave}: ${v.reason}`, [...(deferred.get(`to wave ${v.wave}: ${v.reason}`) ?? []), key])
  console.log(`  deferred from wave 1: ${[...deferred.values()].flat().length}`)
  for (const [reason, keys] of deferred) console.log(`    ${keys.length} × ${reason}\n      ${keys.join(', ')}`)
})

// Wave 2's task assignment (wave2.mjs): every wave-2 item and follow-up belongs to one task of
// Tasks 9–41, the counts match the plan's Scope table, and FILM_TASK=<n> checks that task n is done.
const { SCOPE, TASK1_HIDDEN, wave2Task, wave2Tasks, wave3Reason, followUpTasks, WAVE3_FOLLOW_UPS, DROPPED_FOLLOW_UPS } = await import('./wave2.mjs')
/** Hidden by Task 1 (wave2.mjs TASK1_HIDDEN): hidden in the status file with the reason Task 1 gave. */
const hiddenByTask1 = (key, value) => Object.hasOwn(TASK1_HIDDEN, key) && value.status === 'hidden' && value.reason === TASK1_HIDDEN[key]
/** The wave-2 items (any status), but those Task 1 hid. */
const wave2Items = () => Object.entries(status).filter(([key, value]) => value.wave === 2 && !Object.hasOwn(TASK1_HIDDEN, key) && (value.status !== 'hidden' || wave2Tasks(key, manifest).length > 0))
const wave2FollowUps = () => followUpsOf().filter(([, , followUp]) => followUp?.wave === 2)

test('wave2.mjs assigns the boundary cases', () => {
  const cases = [
    // Automate to Sequence's transition checkboxes are its own, not New Offline File's Video and Audio.
    ['element:{}.videoTransition', 15],
    ['element:{}.audioTransition', 15],
    ['element:{}.video', 12],
    ['element:{}.audio', 12],
    // Custom Setup ▸ Edit… opens the audio effect editor.
    ['element:effectControls.effect.{}.edit', 35],
    // Moved to wave 3 by Task 1: no task.
    ['menu:View/Display Mode/view.display.multicam', null],
    ['element:mixer.transport.voiceover.recordToggle', null],
    ['element:transcribe.language', null],
    // A wave-1 key: no task.
    ['key:playback.toggle', null],
    // Shared dialog fields go to the last task that draws them.
    ['element:{}.method.{}', 15],
    ['element:{}.name', 16],
    ['element:colorDialog.ok', 13],
    ['element:colorDialog.cancel', 13],
    ['element:colorDialog.space.{}', 11],
    // Synchronize Clips and Merge Clips (multicam.rs show_dialog).
    ['element:{}.ignoreHours', 12],
    ['element:{}.marker', 12],
    ['element:{}.offset', 12],
    ['element:sync.track', 12],
    ['element:merge.removeVideoAudio', 12],
    // Fields the extractor now reads from the dialog helpers.
    ['element:{}.mediaName', 12],
    ['element:{}.logNote', 12],
    ['element:{}.comment', 16],
    ['element:{}.text', 15],
    ['element:searchBin.column', 15],
    ['element:find.row.{}.operator', 15],
    ['element:projectSettings.renderer', 16],
    ['element:projectSettings.ingest.action', 16],
    ['element:{}.motion', 11],
    ['element:{}.panner', 11],
    ['element:{}.ok', 9],
    // The monitors' wrench rows and the scopes' settings menu (extract.mjs reads helper parameters everywhere).
    ['element:source.settings.display.audioWaveform', 21],
    ['element:program.settings.display.comparison', 21],
    ['element:program.settings.display.multicam', null],
    ['element:source.settings.playbackRes.{}', null],
    ['element:scopes.menu.paradeType.{}', 30],
    ['element:scopes.menu.clamp', 30],
  ]
  const wrong = cases.map(([key, task]) => [key, task, wave2Task(key, manifest)]).filter(([, task, got]) => got !== task)
  assert.deepEqual(wrong, [], 'key, expected task, wave2Task')
  // An item two rules claim has no single task: an element that runs a Task 11 command and sits under a Task 14 prefix.
  const twice = { ...manifest, elements: [...manifest.elements, { id: 'addTracks.probe', files: ['panels/dialogs.rs'], label: '', command: 'clip.speedDuration' }] }
  assert.deepEqual([wave2Tasks('element:addTracks.probe', twice), wave2Task('element:addTracks.probe', twice)], [[11, 14], null])
})

test('every wave-2 todo item maps to exactly one task of Tasks 9–41', () => {
  const wrong = Object.entries(status)
    .filter(([, value]) => value.wave === 2 && value.status === 'todo')
    .map(([key]) => [key, wave2Tasks(key, manifest)])
    .filter(([, tasks]) => tasks.length !== 1 || tasks[0] < 9 || tasks[0] > 41)
    .map(([key, tasks]) => `${key}: ${JSON.stringify(tasks)}`)
  assert.deepEqual(wrong, [], 'give each a task in parity/wave2.mjs (or move it to wave 3 with a reason)')
})

test('every wave-2 follow-up maps to exactly one task of Tasks 9–41', () => {
  const wrong = wave2FollowUps()
    .map(([key, , followUp]) => [key, followUp.item, followUpTasks(key, followUp.item)])
    .filter(([, , tasks]) => tasks.length !== 1 || tasks[0] < 9 || tasks[0] > 41)
    .map(([key, item, tasks]) => `${key}: ${item} → ${JSON.stringify(tasks)}`)
  assert.deepEqual(wrong, [], 'give each a task in parity/wave2.mjs FOLLOW_UP_TASKS')
})

test("wave 2's per-task counts match the Scope table, with Task 1's moves", () => {
  const items = {}
  for (const [key] of wave2Items()) for (const task of wave2Tasks(key, manifest)) items[task] = (items[task] ?? 0) + 1
  const followUps = {}
  for (const [key, , followUp] of wave2FollowUps()) for (const task of followUpTasks(key, followUp.item)) followUps[task] = (followUps[task] ?? 0) + 1
  const moved = Object.entries(status).filter(([key, value]) => value.wave === 3 && wave3Reason(key) && value.reason === wave3Reason(key)).length
  const hiddenCount = Object.entries(status).filter(([key, value]) => hiddenByTask1(key, value)).length
  const movedFollowUps = followUpsOf().filter(([key, , followUp]) => followUp?.wave === 3 && WAVE3_FOLLOW_UPS.some(([on, text]) => on === key && text.test(followUp.item))).length
  const dropped = DROPPED_FOLLOW_UPS.filter(([on, text]) => typeof status[on]?.note === 'string' && text.test(status[on].note) && !(status[on].followUps ?? []).some((followUp) => text.test(followUp.item))).length
  const tasks = [...new Set([...Object.keys(SCOPE.items), ...Object.keys(items), ...Object.keys(SCOPE.followUps), ...Object.keys(followUps)])].map(Number).sort((a, b) => a - b)
  console.log('wave 2 by task (items, open follow-ups):')
  for (const task of tasks) console.log(`  Task ${task}: ${items[task] ?? 0} items (Scope ${SCOPE.items[task] ?? 0}), ${followUps[task] ?? 0} follow-ups (Scope ${SCOPE.followUps[task] ?? 0})`)
  console.log(`  moved to wave 3: ${moved} items, ${movedFollowUps} follow-ups; hidden: ${hiddenCount}; dropped with a note: ${dropped}`)
  console.log(`  total: ${Object.values(items).reduce((a, b) => a + b, 0) + moved + hiddenCount} items, ${Object.values(followUps).reduce((a, b) => a + b, 0) + movedFollowUps + dropped} follow-ups`)
  const itemDiff = tasks.filter((task) => (items[task] ?? 0) !== (SCOPE.items[task] ?? 0))
  assert.deepEqual(itemDiff, [], 'tasks whose item count differs from SCOPE.items (update the rules or the table)')
  // A task closes its follow-ups, so the open ones never exceed the table.
  const followUpDiff = tasks.filter((task) => (followUps[task] ?? 0) > (SCOPE.followUps[task] ?? 0))
  assert.deepEqual(followUpDiff, [], 'tasks with more open follow-ups than SCOPE.followUps')
  assert.deepEqual([moved, hiddenCount, movedFollowUps, dropped], [SCOPE.movedItems, SCOPE.hiddenItems, SCOPE.movedFollowUps, SCOPE.droppedFollowUps], "Task 1's moves: wave 3, hidden, follow-ups to wave 3, dropped")
  // Every item Task 1 hid is hidden with the reason it gave.
  const notHidden = Object.keys(TASK1_HIDDEN).filter((key) => !hiddenByTask1(key, status[key] ?? {}))
  assert.deepEqual(notHidden, [], 'TASK1_HIDDEN entries not hidden with their reason')
})

test('dialog fields hidden on the web, and only they, are hidden in the status file', { skip: hidden ? false : 'web/src/menus/hidden.ts does not exist yet' }, () => {
  // Every field isHiddenField names is hidden with its reason, and every Task 1 hidden field is one isHiddenField names (or Close Project's prompt, whose menu row is hidden).
  const named = manifest.elements.filter((element) => hidden.isHiddenField(element.id))
  const wrong = named.filter((element) => !(status[`element:${element.id}`]?.status === 'hidden' && status[`element:${element.id}`].reason === hidden.hiddenFieldReason(element.id))).map((element) => element.id)
  assert.deepEqual(wrong, [], 'status disagrees with isHiddenField')
  const unnamed = Object.keys(TASK1_HIDDEN).filter((key) => !hidden.isHiddenField(key.slice('element:'.length)) && !['element:{}.save', 'element:{}.dontSave'].includes(key))
  assert.deepEqual(unnamed, [], 'Task 1 hid these, but isHiddenField draws them')
})

/** FILM_TASK, when set: an integer task number of wave 2 (9–41); anything else fails the run. */
const filmTaskRaw = process.env.FILM_TASK
const filmTask = filmTaskRaw ? Number(filmTaskRaw) : null
test('FILM_TASK names a wave-2 task (an integer from 9 to 41)', { skip: filmTaskRaw == null && 'FILM_TASK is unset' }, () => {
  assert.ok(/^\d+$/.test(filmTaskRaw) && filmTask >= 9 && filmTask <= 41, `FILM_TASK=${filmTaskRaw} is not a wave-2 task (9–41)`)
})
test(`FILM_TASK=${filmTaskRaw ?? '<n>'}: every item of the task is done or hidden, and its follow-ups are closed`, { skip: filmTaskRaw == null && 'set FILM_TASK=<n> to check task n' }, () => {
  assert.ok(/^\d+$/.test(filmTaskRaw) && filmTask >= 9 && filmTask <= 41, `FILM_TASK=${filmTaskRaw} is not a wave-2 task (9–41)`)
  const open = wave2Items()
    .filter(([key, value]) => value.status === 'todo' && wave2Tasks(key, manifest).includes(filmTask))
    .map(([key]) => key)
  const followUps = wave2FollowUps()
    .filter(([key, , followUp]) => followUpTasks(key, followUp.item).includes(filmTask))
    .map(([key, , followUp]) => `${key}: ${followUp.item}`)
  console.log(`Task ${filmTask}: ${open.length} items and ${followUps.length} follow-ups open`)
  assert.deepEqual(open, [], `Task ${filmTask}'s items still todo`)
  assert.deepEqual(followUps, [], `Task ${filmTask}'s follow-ups still open`)
})

// Film in Chinese (Task 23b, maintainer decision 11): every label Film draws has a zh-CN entry, and
// the editor's own strings have both locales, so a later task that adds a label adds both. The rule
// for "draws" is in parity/i18n.mjs; labels read at run time are checked by the flow test.
const i18n = await import('./i18n.mjs')
const { CATALOGS, PHRASES } = await import('../src/strings.ts')
const zhCatalog = new URL('../src/i18n/upstream/zh-hans.tsv', import.meta.url)
const zh = existsSync(zhCatalog) ? i18n.readCatalog(zhCatalog) : { table: new Map(), twice: [] }

test('every label Film draws through phrase() has a zh-CN catalog entry', async () => {
  const drawn = await i18n.drawnLabels({ engineCommands: engine ? [...engine.values()] : null, engineEffects: engine?.effectLabels ?? null })
  const overrides = PHRASES['zh-CN'] ?? {}
  const missing = [...drawn].filter(([label]) => !zh.table.has(label) && !(label in overrides)).map(([label, origin]) => `${JSON.stringify(label)} (${origin})`)
  console.log(`zh-CN: ${drawn.size} drawn labels${engine ? '' : ' (engine not built: its command titles unchecked)'}, ${zh.table.size} catalog entries, ${missing.length} missing`)
  assert.deepEqual(missing.slice(0, 40), [], `add these to web/src/i18n/upstream/zh-hans.tsv (${missing.length} in all)`)
})

test("the editor's own strings have en-US and zh-CN, with the same placeholders", () => {
  const en = CATALOGS['en-US']
  const zhCN = CATALOGS['zh-CN'] ?? {}
  const missing = Object.keys(en).filter((key) => !(key in zhCN))
  const extra = Object.keys(zhCN).filter((key) => !(key in en))
  const placeholders = Object.keys(en).filter((key) => key in zhCN && i18n.placeholders(en[key]).join() !== i18n.placeholders(zhCN[key]).join())
  assert.deepEqual({ missing, extra, placeholders }, { missing: [], extra: [], placeholders: [] }, 'add both locales to web/src/strings.ts')
})

test('the zh-CN catalog lists each label once, keeps its placeholders, and has one source per label', () => {
  const placeholders = [...zh.table].filter(([source, translation]) => i18n.placeholders(source).join() !== i18n.placeholders(translation).join()).map(([source]) => source)
  const overridden = Object.keys(PHRASES['zh-CN'] ?? {}).filter((label) => zh.table.has(label))
  assert.deepEqual({ twice: zh.twice, placeholders, overridden }, { twice: [], placeholders: [], overridden: [] })
})
