// Upstream's Link Media and Make Offline dialogs (Task 17, `media_dialogs.rs` `route`,
// `link_media`, `make_offline`): Link's params with upstream's match options, Offline All's
// `media.offlineAll`, the rows that leave and the located file that goes with them, Make
// Offline's confirmation, the routes (Attach Proxies… and Reconnect… through the host's picker),
// Create Proxies hidden (it writes files into a local folder) and so never previewed, the ids
// they draw, and the stamp a media item's thumbnails follow, against fake engine reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { describe as describeFilm } from '../film.ts'
import { DIALOGS, dialogDeclarations, dialogSteps, previewSteps, stripHasLines, stripResults } from './registry.ts'
import {
  MATCH_OPTIONS,
  chosenRow,
  createPickTicket,
  fileItems,
  linkParams,
  linkRowViews,
  locate,
  locatedOf,
  mediaStatuses,
  missingRows,
  offlineAll,
  offlineTargets,
  relinkItem,
  relinkRefusal,
  relinkedItems,
  setOffline,
  settleDraft,
  shownRows,
} from './media.ts'
import { createPreview, previewEnded } from './preview.ts'
import { relativePath } from '../menus/kitMenus.ts'
import { thumbStamp } from '../panels/projectPreview.ts'
import { routeOf } from '../session/invoke.ts'
import { readCatalog } from '../../parity/i18n.mjs'
import { createPreviewGate } from '../session/previewGate.ts'
import { hiddenFieldReason, hiddenReason, isHiddenField } from '../menus/hidden.ts'

const missing = {
  missing: [
    {
      item: 8,
      name: 'bars.mp4',
      fileName: 'bars.mp4',
      path: '../clips/bars.mp4',
      status: 'offline',
      duration: 1,
      startTimecode: null,
    },
    {
      item: 9,
      name: 'tone.wav',
      fileName: 'tone.wav',
      path: 'audio/tone.wav',
      status: 'missing',
      duration: 1,
      startTimecode: null,
    },
    // A missing proxy alone is not a row (upstream's `offline.missing` leaves it out).
    {
      item: 10,
      name: 'proxied.mov',
      fileName: 'proxied.mov',
      path: 'proxied.mov',
      status: 'proxyMissing',
      duration: 1,
      startTimecode: null,
    },
  ],
}
/** The project's media as `media.status` answers: two files and a colour matte (generated). */
const statuses = [
  { item: 8, status: 'online' },
  { item: 9, status: 'missing' },
  { item: 12, status: 'generated' },
]
const context = ({ asks = { 'media.linkMedia': missing }, projectSelection = [8] } = {}) => ({
  film: {
    activeSequence: 1,
    selection: [],
    tracks: [],
    root: { id: 0, name: 'root', children: [] },
  },
  session: { projectSelection },
  params: {},
  query: async (id) => (id === 'media.status' ? statuses : null),
  ask: async (id) => {
    if (!(id in asks)) throw new Error(`no answer for ${id}`)
    return asks[id]
  },
})
const spec = (id) => {
  const found = DIALOGS.get(id)
  assert.ok(found, `${id} is registered`)
  return found
}
/** A fake engine that records what it is asked. */
function fakeEngine() {
  const calls = []
  return {
    calls,
    named: (name) => calls.filter((call) => call[0] === name),
    async invoke(name, ...args) {
      calls.push([name, ...args])
      if (name === 'previewBegin' || name === 'previewBeginSteps')
        return JSON.stringify({
          relinked: [{ item: 8, path: '../clips/bars.mp4' }],
          remaining: [],
        })
      if (name === 'previewDiff')
        return JSON.stringify({
          project: { changed: [] },
          items: {
            added: [],
            removed: [],
            changed: [{ id: 8, fields: ['offline'] }],
          },
        })
      return null
    },
  }
}
const frames = () => ({ schedule: () => () => undefined })

// ---- Link Media

test("Link Media opens on upstream's route: media.linkMedia's rows (no missing proxy), upstream's match options, the first row chosen, nothing located", async () => {
  const link = spec('media.linkMedia')
  const draft = await link.defaults(context())
  assert.deepEqual(
    draft.info.rows.map((row) => [row.item, row.status]),
    [
      [8, 'offline'],
      [9, 'missing'],
    ],
  )
  assert.deepEqual(Object.fromEntries(MATCH_OPTIONS.map(([key]) => [key, draft[key]])), {
    fileName: true,
    extension: true,
    clipId: true,
    duration: true,
    mediaStart: false,
    metadata: true,
  })
  assert.equal(draft.alignTimecode, false)
  assert.equal(draft.relinkOthers, true)
  assert.equal(draft.row, 8)
  assert.equal(locatedOf(draft), null)
  // Nothing to link: upstream's status, and no dialog.
  await assert.rejects(link.defaults(context({ asks: { 'media.linkMedia': { missing: [] } } })), /All media is online\./)
  assert.deepEqual(link.preview, ['project', 'picture'])
  assert.equal(link.okLabel, 'Link')
  assert.deepEqual(link.buttons, {
    ok: 'linkMedia.link',
    cancel: 'linkMedia.cancel',
  })
})

test("Link's params carry the match options, Align Timecode, and Relink others, with the row's item and the file Locate… picked", async () => {
  const link = spec('media.linkMedia')
  const ctx = context()
  const opened = await link.defaults(ctx)
  // Nothing located: Link is greyed, and nothing previews.
  assert.equal(link.okEnabled(opened), false)
  assert.deepEqual(previewSteps(link, opened, ctx), [])
  assert.deepEqual(dialogSteps(link, opened, ctx), [])
  const rows = shownRows(opened, null)
  const draft = {
    ...locate(opened, rows[1], 'audio/found/tone.wav'),
    clipId: false,
    mediaStart: true,
    alignTimecode: true,
    relinkOthers: false,
  }
  assert.equal(link.okEnabled(draft), true)
  const steps = [
    {
      command: 'media.relink',
      params: {
        match: {
          fileName: true,
          extension: true,
          clipId: false,
          duration: true,
          mediaStart: true,
          metadata: true,
        },
        alignTimecode: true,
        relinkOthers: false,
        item: 9,
        path: 'audio/found/tone.wav',
      },
    },
  ]
  assert.deepEqual(dialogSteps(link, draft, ctx), steps)
  assert.deepEqual(previewSteps(link, draft, ctx), steps, 'the preview relinks what Link will')
  assert.deepEqual(linkParams(draft), steps[0].params)
  // A file that does not match is the preview's answer (upstream's message under the rows), not its failure.
  assert.equal(link.quietError("tone.wav doesn't match tone.wav: not the same file: the content fingerprint differs"), true)
  assert.equal(link.quietError("found.wav can't be opened"), true)
  assert.equal(link.quietError('no document'), false)
})

test('Link Media previews on the engine only after Locate…, then relinks on the scratch session', async () => {
  const link = spec('media.linkMedia')
  const ctx = context()
  const opened = await link.defaults(ctx)
  const engine = fakeEngine()
  const preview = createPreview({ engine: () => engine, ...frames() })
  const handle = preview.handle()
  await handle.begin({
    kinds: link.preview,
    steps: previewSteps(link, opened, ctx),
  })
  assert.equal(engine.named('previewBegin').length, 0, 'nothing located, nothing previewed')
  assert.equal(preview.get().open, false)
  const located = locate(opened, shownRows(opened, null)[0], '../clips/bars.mp4')
  await handle.begin({
    kinds: link.preview,
    steps: previewSteps(link, located, ctx),
  })
  assert.deepEqual(
    engine.named('previewBegin').map((call) => [call[1], JSON.parse(call[2]).path]),
    [['media.relink', '../clips/bars.mp4']],
  )
  assert.equal(preview.get().open, true)
  assert.deepEqual(relinkedItems(preview.get().result), [8])
  await handle.end()
  assert.equal(engine.named('previewEnd').length, 1)
})

test('Link stays open on the rows left and its OK runs media.relink as its own while the preview stays open; the status says how many it linked', () => {
  const link = spec('media.linkMedia')
  assert.equal(link.keepOpen, true)
  assert.deepEqual(link.runs, ['media.relink'])
  // The preview gate lets the dialog's own commands through, and refuses other edits.
  const gate = createPreviewGate({
    open: () => true,
    own: () => new Set([link.id, ...link.runs]),
    journaled: (id) => id !== 'media.linkMedia',
    message: 'busy',
  })
  assert.equal(gate.refusal('media.relink'), null)
  assert.equal(gate.refusal('media.makeOffline'), 'busy')
  // The template goes through phrase() first, then its count (as the bodies' text does).
  const zh = readCatalog(new URL('../i18n/upstream/zh-hans.tsv', import.meta.url)).table
  const phrase = (text) => zh.get(text) ?? text
  const answer = {
    relinked: [
      { item: 8, path: 'a' },
      { item: 9, path: 'b' },
    ],
    remaining: [],
  }
  assert.notEqual(zh.get('Linked {n} clip(s)'), undefined, 'the zh-CN catalog translates the template')
  assert.equal(link.okStatus([answer], phrase), zh.get('Linked {n} clip(s)').replace('{n}', '2'))
})

test("Link's OK drops the file it linked at once, so a second press (or Enter on Link) relinks nothing more; Cancel runs upstream's Offline All", async () => {
  const link = spec('media.linkMedia')
  const ctx = context()
  const opened = await link.defaults(ctx)
  const located = locate(opened, shownRows(opened, null)[0], '../clips/bars.mp4')
  assert.equal(link.okEnabled(located), true)
  const after = link.afterOk(located, [{ relinked: [{ item: 8, path: '../clips/bars.mp4' }], remaining: [9] }])
  assert.equal(locatedOf(after), null)
  assert.equal(link.okEnabled(after), false, 'Link is greyed until Locate… picks again')
  assert.deepEqual(dialogSteps(link, after, ctx), [], 'a second OK runs nothing')
  assert.deepEqual(previewSteps(link, after, ctx), [], 'and nothing is previewed')
  // A link that did not take the located file keeps it.
  assert.equal(link.afterOk(located, [{ relinked: [], remaining: [8] }]), located)
  // Upstream's Cancel (and Escape) runs media.offlineAll, which changes nothing (the binding's test).
  assert.deepEqual(link.cancelSteps, [{ command: 'media.offlineAll', params: {} }])
})

test("a refused relink's reason shows in the strip (Link Media has no answer lines of its own), and the strip shows for it", () => {
  const link = spec('media.linkMedia')
  const t = (key) => key
  const reason = "bars.mp4 doesn't match Tone: file name differs (bars vs Tone)"
  assert.equal(link.quietError(reason), true)
  assert.equal(stripHasLines(link, reason), true)
  assert.deepEqual(stripResults(link, { open: false, result: null, quiet: reason, answered: null }, t), [reason])
  // A preview that opens again replaces it.
  assert.deepEqual(stripResults(link, { open: true, result: { relinked: [] }, quiet: null, answered: null }, t), [])
  assert.equal(stripHasLines(link, null), false)
  // Find's lines are unchanged: its answer while open, then its refusal or OK's answer.
  const find = spec('edit.find')
  assert.deepEqual(stripResults(find, { open: false, result: null, quiet: 'no matches', answered: null }, t), ['no matches'])
})

test("Link Media's rows draw again only where they change: with 200 rows, a preview that relinks one changes one row's view", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ item: 100 + index, name: `clip ${index}.mp4`, fileName: `clip ${index}.mp4`, path: `media/clip ${index}.mp4`, status: 'missing' }))
  const before = linkRowViews(rows, 100, null)
  const after = linkRowViews(rows, 100, new Map([[150, 'online']]))
  const same = (a, b) => Object.keys(a).every((key) => a[key] === b[key])
  assert.deepEqual(
    after.flatMap((view, index) => (same(view, before[index]) ? [] : [view.row.item])),
    [150],
  )
  // Choosing another row changes two.
  const chosen = linkRowViews(rows, 101, null)
  assert.deepEqual(
    chosen.flatMap((view, index) => (same(view, before[index]) ? [] : [view.row.item])),
    [100, 101],
  )
})

test('a Locate… answer that a newer pick or another row overtook is dropped', () => {
  const ticket = createPickTicket()
  const first = ticket.next()
  const second = ticket.next()
  assert.equal(ticket.current(first), false, 'the first answer arrives late: dropped')
  assert.equal(ticket.current(second), true)
  ticket.drop()
  assert.equal(ticket.current(second), false, 'another row was chosen meanwhile: dropped')
})

test("Link Media's rows follow the document: a row linked or set Offline leaves, its located file goes, and the choice stays on its item", async () => {
  const opened = await spec('media.linkMedia').defaults(context())
  const [bars, tone] = shownRows(opened, null)
  // Before the document's statuses are read, every row shows.
  assert.equal(shownRows(opened, null).length, 2)
  // bars linked (online in the document): it leaves; a file located for it goes; the choice moves to the next.
  const linked = locate(opened, bars, '../clips/bars.mp4')
  const statuses = mediaStatuses([
    { item: 8, status: 'online' },
    { item: 9, status: 'missing' },
  ])
  const left = shownRows(linked, statuses)
  assert.deepEqual(
    left.map((row) => row.item),
    [9],
  )
  assert.equal(locatedOf(settleDraft(linked, left)), null)
  assert.equal(chosenRow(linked, left), tone)
  // A located file for a row still listed stays (the same draft).
  const toneLocated = locate(opened, tone, 'tone.wav')
  assert.equal(settleDraft(toneLocated, shownRows(toneLocated, statuses)), toneLocated)
  // Offline sets the row aside (upstream's `skipped`) and drops its located file.
  const skipped = setOffline(toneLocated, tone)
  assert.deepEqual(skipped.skipped, [9])
  assert.equal(locatedOf(skipped), null)
  assert.deepEqual(
    shownRows(skipped, null).map((row) => row.item),
    [8],
  )
  assert.deepEqual(shownRows(setOffline(skipped, bars), null), [], 'no row left: the dialog closes')
  assert.deepEqual(missingRows(null), [])
})

test('Offline All runs media.offlineAll, then closes the dialog', async () => {
  const log = []
  await offlineAll({
    run: async (command, params) => log.push(['run', command, params]),
    close: () => log.push(['close']),
  })
  assert.deepEqual(log, [['run', 'media.offlineAll', {}], ['close']])
})

// ---- Make Offline

test("Make Offline is its own confirmation: upstream's question for the Project selection, Media files remain on disk, and OK makes those items offline, keeping their files", async () => {
  const make = spec('media.makeOffline')
  assert.deepEqual(make.preview, ['project', 'picture'])
  assert.notEqual(make.hideOk, true)
  assert.deepEqual(make.buttons, {
    ok: 'makeOffline.ok',
    cancel: 'makeOffline.cancel',
  })
  // A colour matte (12, generated) and a sequence (7, no media) in the selection: neither counts, nor goes in OK's items.
  const ctx = context({ projectSelection: [8, 12, 7, 9] })
  const draft = await make.defaults(ctx)
  assert.deepEqual(fileItems(statuses), [8, 9])
  assert.deepEqual(offlineTargets(draft, ctx), [8, 9], 'the count the question shows')
  const steps = [
    {
      command: 'media.makeOffline',
      params: { items: [8, 9], deleteFiles: false },
    },
  ]
  assert.deepEqual(dialogSteps(make, draft, ctx), steps)
  assert.deepEqual(previewSteps(make, draft, ctx), steps, 'the preview makes the same items offline')
  // The preview follows the Project selection.
  assert.deepEqual(make.dependsOn(ctx), [8, 12, 7, 9])
  assert.deepEqual(
    make.controls.map((control) => control.upstream),
    [['makeOffline.keep']],
  )
})

// ---- Create Proxies, Attach Proxies, Reconnect Full Resolution Media

test('Create Proxies is hidden with its reason (its job writes files into a local folder): no dialog is registered for it, and its fields and item menu row are hidden', () => {
  assert.match(hiddenReason('media.addProxies') ?? '', /local folder/)
  assert.equal(DIALOGS.has('media.addProxies'), false)
  for (const id of ['proxies.preset.{}', 'proxies.ok', 'proxies.cancel', 'project.itemMenu.createProxies']) assert.equal(hiddenFieldReason(id), hiddenReason('media.addProxies'), id)
  // Task 1's reasons for its destination stay.
  assert.match(hiddenFieldReason('proxies.destination') ?? '', /local folder for proxies/)
})

test("Attach Proxies… and Reconnect… act on the item the Project item menu names, else the selection's first; Reconnect without a proxy is refused before the picker", () => {
  // The item menu names its item: the selection it sets lands later.
  assert.equal(relinkItem({ item: 9 }, [8]), 9)
  assert.equal(relinkItem({}, [8, 9]), 8)
  assert.equal(relinkItem({}, []), null)
  assert.equal(routeOf('media.attachProxies', { item: 9 }, 'project'), 'fileDialog', 'an item without a path still picks')
  assert.equal(routeOf('media.reconnectFullRes', { item: 9 }, 'project'), 'fileDialog')
  assert.equal(relinkRefusal('media.reconnectFullRes', [{ item: 9, proxy: null }]), 'the clip has no proxy attached')
  assert.equal(relinkRefusal('media.reconnectFullRes', [{ item: 9, proxy: { path: 'p.mov', online: true } }]), null)
  assert.equal(relinkRefusal('media.attachProxies', [{ item: 9, proxy: null }]), null)
})

test("a picked file is named relative to the project, whatever separator the host's workspace path uses", () => {
  assert.equal(relativePath('films', 'clips/bars.mp4'), '../clips/bars.mp4')
  assert.equal(relativePath('films', 'clips\\bars.mp4'), '../clips/bars.mp4')
  assert.equal(relativePath('films', '/clips/bars.mp4'), '../clips/bars.mp4')
  assert.equal(relativePath('films\\cuts', 'films/media/a.mp4'), '../media/a.mp4')
})

test("a preview row drawn from the document's cache keys its thumbnail on the document's stamp, not the copy's", () => {
  const documentStamps = new Map([[8, 'online-stamp']])
  const previewRow = { item: 8, stamp: 'offline-stamp' }
  assert.equal(thumbStamp(previewRow, false, documentStamps), 'online-stamp')
  assert.equal(thumbStamp(previewRow, true, documentStamps), 'offline-stamp', "the preview's own pictures keep its stamp")
  assert.equal(thumbStamp(previewRow, false, new Map()), 'offline-stamp', "no preview: the row is the document's")
})

test("Cancel waits for this dialog's preview to end, or to be overtaken by a newer one, and stops listening", async () => {
  let shown = { open: true, serial: 5 }
  const listeners = new Set()
  const preview = { get: () => shown, subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)) }
  const tell = () => [...listeners].forEach((listener) => listener())
  let ended = false
  const waiting = previewEnded(preview, 5).then(() => (ended = true))
  await Promise.resolve()
  assert.equal(ended, false)
  shown = { open: false, serial: 5 }
  tell()
  await waiting
  assert.equal(listeners.size, 0)
  // Another dialog's preview opened before this one's end was published: this one is over too,
  // and it never waits on that other preview.
  shown = { open: true, serial: 5 }
  let overtaken = false
  const second = previewEnded(preview, 5).then(() => (overtaken = true))
  shown = { open: true, serial: 6 }
  tell()
  await second
  assert.equal(overtaken, true)
  assert.equal(listeners.size, 0)
  // Already another dialog's preview (or none): at once.
  await previewEnded(preview, 5)
  shown = { open: false, serial: 6 }
  await previewEnded(preview, 6)
})

test("Make Offline from the Project item menu opens on the menu's item, not the selection the call finds; other values run at once", async () => {
  const make = spec('media.makeOffline')
  assert.equal(routeOf('media.makeOffline', { item: 9 }, 'project'), 'dialog')
  assert.equal(routeOf('media.makeOffline', { items: [9] }, 'project'), 'session')
  assert.equal(routeOf('media.makeOffline', { item: 9, deleteFiles: false }, 'project'), 'session')
  // The menu selected 9, but the selection the dialog reads is still 8.
  const ctx = { ...context({ projectSelection: [8] }), params: { item: 9 } }
  const draft = await make.defaults(ctx)
  assert.deepEqual(offlineTargets(draft, ctx), [9])
  assert.deepEqual(dialogSteps(make, draft, ctx), [{ command: 'media.makeOffline', params: { items: [9], deleteFiles: false } }])
  // A colour matte from the menu counts nothing.
  const matte = { ...ctx, params: { item: 12 } }
  assert.deepEqual(offlineTargets(await make.defaults(matte), matte), [])
})
test('the dialogs open with no params and run at once with them; Attach Proxies… and Reconnect… go to the host picker without a path', () => {
  assert.equal(routeOf('media.linkMedia', {}, 'project'), 'dialog')
  assert.equal(routeOf('media.makeOffline', {}, 'project'), 'dialog')
  assert.equal(routeOf('media.makeOffline', { items: [8] }, 'project'), 'session')
  assert.equal(routeOf('media.relink', { item: 8, path: 'a.mp4' }, 'project'), 'session')
  assert.equal(routeOf('media.attachProxies', {}, 'project'), 'fileDialog')
  assert.equal(routeOf('media.attachProxies', { item: 8, path: 'p.mov' }, 'project'), 'session')
  assert.equal(routeOf('media.reconnectFullRes', {}, 'project'), 'fileDialog')
  assert.equal(routeOf('media.reconnectFullRes', { item: 8, path: 'full.mov' }, 'project'), 'session')
})

test("every field upstream's Link Media and Make Offline register has a declared id standing for it, the hidden ones aside", () => {
  const stands = new Set(dialogDeclarations(DIALOGS).flatMap((item) => item.upstream))
  const known = upstream.elements.map((element) => element.id).filter((id) => /^(linkMedia|makeOffline|proxies)\./.test(id))
  const hidden = known.filter((id) => isHiddenField(id))
  assert.equal(known.length, 29)
  assert.deepEqual(hidden.sort(), [
    'linkMedia.browse',
    'linkMedia.candidate.{}',
    'linkMedia.exactName',
    'linkMedia.folder',
    'linkMedia.preview',
    'linkMedia.search',
    'makeOffline.delete',
    'proxies.browse',
    'proxies.cancel',
    'proxies.destination',
    'proxies.ok',
    'proxies.preset.{}',
  ])
  assert.deepEqual(
    known.filter((id) => !hidden.includes(id) && !stands.has(id)),
    [],
  )
  assert.deepEqual(
    hidden.filter((id) => stands.has(id)),
    [],
    'a hidden field is never declared',
  )
  const ids = new Set(dialogDeclarations(DIALOGS).map((item) => item.id))
  for (const id of [
    'control:dialog.linkMedia.row',
    'control:dialog.linkMedia.match.clipId',
    'control:dialog.linkMedia.relinkOthers',
    'control:dialog.linkMedia.locate',
    'control:dialog.linkMedia.offlineAll',
    'control:dialog.makeOffline.keep',
  ])
    assert.ok(ids.has(id), id)
})

// ---- the thumbnails' stamp

test("a media item's stamp reaches the bins, so its thumbnails draw again when its media does; other items carry none", () => {
  const film = describeFilm({
    revision: 1,
    inspected: {
      project: {
        name: 'P',
        root: {
          id: 0,
          name: 'root',
          children: [
            {
              item: 8,
              name: 'bars.mp4',
              type: 'Movie',
              duration: 0,
              label: 'Iris',
              stamp: '1234',
            },
            {
              item: 7,
              name: 'Sequence 01',
              type: 'Sequence',
              duration: 0,
              label: 'Forest',
            },
          ],
        },
      },
      ticksPerSecond: 254_016_000_000,
    },
  })
  assert.equal(film.root.children[0].stamp, '1234')
  assert.equal('stamp' in film.root.children[1], false)
})
