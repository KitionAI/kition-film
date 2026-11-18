// Upstream's Link Media and Make Offline dialogs (`panels/media_dialogs.rs` `route`, `link_media`,
// `make_offline`): each one's title, draft, controls, and params. Link Media's folder search and
// Make Offline's choice to delete media files are hidden on the web (rule 2): Locate… picks the
// file through the host. Create Proxies is hidden whole: its job writes proxy files into a local
// folder, which the web engine cannot write (`menus/hidden.ts`). Imports carry `.ts` so
// `node --test` loads this module as it is.
import type { DialogContext, DialogControl, DialogSpec, Draft, Params } from './registry.ts'

/** Upstream's Match File Properties checkboxes (`linkMedia.match.<id>`), in its order, with its labels. */
export const MATCH_OPTIONS = [
  ['fileName', 'File Name'],
  ['extension', 'File Extension'],
  ['clipId', 'Clip ID (fingerprint)'],
  ['duration', 'Duration'],
  ['mediaStart', 'Media Start'],
  ['metadata', 'Frame Size / Rate'],
] as const

/** Upstream's `LinkMediaDraft::default()` choices. */
const LINK_CHOICES = {
  fileName: true,
  extension: true,
  clipId: true,
  duration: true,
  mediaStart: false,
  metadata: true,
  alignTimecode: false,
  relinkOthers: true,
}

/** A Link Media row (upstream `missing_list`): an item whose file is missing or made offline. */
export type MissingRow = {
  item: number
  name: string
  fileName: string
  path: string
  status: 'missing' | 'offline'
}

/** The file Locate… picked for a row, relative to the project. */
export type Located = { item: number; path: string }

/**
 * The rows of `media.linkMedia`'s answer (upstream's `session.offline.missing`): the files missing
 * or made offline. A missing proxy alone is not a row.
 */
export function missingRows(answer: unknown): MissingRow[] {
  const list = (answer as { missing?: unknown } | null)?.missing
  if (!Array.isArray(list)) return []
  return list.flatMap((raw) => {
    const row = raw as Partial<MissingRow> & { status?: string }
    if (typeof row.item !== 'number' || (row.status !== 'missing' && row.status !== 'offline')) return []
    const path = typeof row.path === 'string' ? row.path : ''
    return [
      {
        item: row.item,
        name: typeof row.name === 'string' ? row.name : '',
        fileName: typeof row.fileName === 'string' ? row.fileName : (path.split(/[/\\]/).pop() ?? path),
        path,
        status: row.status,
      },
    ]
  })
}

/** Each item's status in `media.status`'s answer (`online`, `offline`, `missing`, `unreadable`, `generated`). */
export function mediaStatuses(answer: unknown): ReadonlyMap<number, string> {
  const out = new Map<number, string>()
  if (!Array.isArray(answer)) return out
  for (const raw of answer) {
    const row = raw as { item?: unknown; status?: unknown }
    if (typeof row.item === 'number' && typeof row.status === 'string') out.set(row.item, row.status)
  }
  return out
}

const rowsOf = (draft: Draft): readonly MissingRow[] => {
  const rows = (draft.info as { rows?: unknown } | null | undefined)?.rows
  return Array.isArray(rows) ? (rows as MissingRow[]) : []
}
const skippedOf = (draft: Draft): readonly number[] => (Array.isArray(draft.skipped) ? (draft.skipped as number[]) : [])
export const locatedOf = (draft: Draft): Located | null => {
  const located = draft.located as Partial<Located> | null | undefined
  return located && typeof located.item === 'number' && typeof located.path === 'string' ? { item: located.item, path: located.path } : null
}

/**
 * The rows Link Media lists now (upstream recomputes `missing_list` each frame): those it opened
 * with whose item the document still has missing or offline (`statuses`, the document's
 * `media.status`; null before it is read), less the rows the person set Offline.
 */
export function shownRows(draft: Draft, statuses: ReadonlyMap<number, string> | null): MissingRow[] {
  const skipped = new Set(skippedOf(draft))
  return rowsOf(draft).filter((row) => !skipped.has(row.item) && (statuses == null || statuses.get(row.item) === 'missing' || statuses.get(row.item) === 'offline'))
}

/** The row chosen (upstream's `d.row`, kept as its item here, so a row that goes does not move the choice): the draft's, else the first. */
export function chosenRow(draft: Draft, rows: readonly MissingRow[]): MissingRow | null {
  return rows.find((row) => row.item === draft.row) ?? rows[0] ?? null
}

/**
 * Link's params (upstream `match_params` with the row's item and the file): the match options,
 * Align Timecode, and Relink others automatically. Null until Locate… has picked a file.
 */
export function linkParams(draft: Draft): Params | null {
  const located = locatedOf(draft)
  if (!located) return null
  return {
    match: Object.fromEntries(MATCH_OPTIONS.map(([key]) => [key, draft[key] === true])),
    alignTimecode: draft.alignTimecode === true,
    relinkOthers: draft.relinkOthers === true,
    item: located.item,
    path: located.path,
  }
}

/** The draft after Locate… picked `path` for `row`: that row chosen and its file located. */
export const locate = (draft: Draft, row: MissingRow, path: string): Draft => ({
  ...draft,
  row: row.item,
  located: { item: row.item, path },
})

/** The draft after Offline on `row` (upstream's `skipped`): it leaves the list, and a file located for it goes. */
export function setOffline(draft: Draft, row: MissingRow): Draft {
  const located = locatedOf(draft)
  return {
    ...draft,
    skipped: [...skippedOf(draft), row.item],
    located: located?.item === row.item ? null : (located ?? null),
  }
}

/**
 * The draft for the rows the document still lists: a file located for a row that has gone
 * (linked, or set Offline) goes, as upstream clears its candidates after a link; the same draft
 * when nothing changes.
 */
export function settleDraft(draft: Draft, rows: readonly MissingRow[]): Draft {
  const located = locatedOf(draft)
  if (!located || rows.some((row) => row.item === located.item)) return draft
  return { ...draft, located: null }
}

/** Offline All (upstream's `offlineAll` arm): `media.offlineAll {}` (every file left offline, the open-time prompt cleared), then the dialog closes. */
export async function offlineAll(actions: { run: (command: string, params: Params) => Promise<unknown>; close: () => void }) {
  await actions.run('media.offlineAll', {})
  actions.close()
}

/**
 * What Link Media's rows draw, one view per row: the row itself (the draft's object, the same
 * while it lasts), whether it is chosen, and whether the preview shows it online. Each is
 * compared by its fields, so with 200 rows a preview that relinks one draws that row again only.
 */
export type LinkRowView = { row: MissingRow; index: number; chosen: boolean; online: boolean }
export function linkRowViews(rows: readonly MissingRow[], chosen: number | null, previewed: ReadonlyMap<number, string> | null): LinkRowView[] {
  return rows.map((row, index) => ({ row, index, chosen: row.item === chosen, online: previewed?.get(row.item) === 'online' }))
}

/**
 * The newest of several picks (Locate…): `next()` names a pick as it starts, and `drop()` when
 * the choice moves on (another row), so `current(pick)` is false for an answer that a newer pick
 * or choice has overtaken.
 */
export function createPickTicket() {
  let latest = 0
  return {
    next: () => ++latest,
    drop: () => void ++latest,
    current: (pick: number) => pick === latest,
  }
}

/** The file items in `media.status`'s answer (every status but `generated`): what Make Offline can make offline. */
export function fileItems(answer: unknown): number[] {
  if (!Array.isArray(answer)) return []
  return answer.flatMap((raw) => {
    const row = raw as { item?: unknown; status?: unknown }
    return typeof row.item === 'number' && typeof row.status === 'string' && row.status !== 'generated' ? [row.item] : []
  })
}

/**
 * What Make Offline makes offline: the item the Project item menu named (`draft.item`), else the
 * Project selection, its file items only (the engine skips the rest).
 */
export function offlineTargets(draft: Draft, ctx: Pick<DialogContext, 'session'>): number[] {
  const files = new Set(Array.isArray((draft.info as { files?: unknown } | null | undefined)?.files) ? (draft.info as { files: number[] }).files : [])
  const chosen = typeof draft.item === 'number' ? [draft.item] : (ctx.session?.projectSelection ?? [])
  return chosen.filter((item) => files.has(item))
}

/**
 * The item Attach Proxies… or Reconnect Full Resolution Media… acts on: the one the call names
 * (the Project item menu's), else the Project selection's first (upstream's route); null when
 * there is none.
 */
export function relinkItem(params: Readonly<Params>, selection: readonly number[] | null | undefined): number | null {
  return typeof params.item === 'number' ? params.item : (selection?.[0] ?? null)
}

/**
 * Why the host's picker does not open for Attach Proxies… or Reconnect Full Resolution Media… on
 * the item whose `media.status` row is `status`, or null: Reconnect needs an attached proxy (the
 * engine's own refusal, asked before the picker rather than after it).
 */
export function relinkRefusal(command: string, status: unknown): string | null {
  if (command !== 'media.reconnectFullRes') return null
  const proxy = (Array.isArray(status) ? status[0] : status) as { proxy?: unknown } | null | undefined
  return proxy?.proxy ? null : 'the clip has no proxy attached'
}

/** The relinked items in `media.relink`'s answer (`relinked: [{item, path}]`). */
export function relinkedItems(answer: unknown): number[] {
  const list = (answer as { relinked?: unknown } | null)?.relinked
  return Array.isArray(list) ? list.flatMap((row) => (typeof (row as { item?: unknown })?.item === 'number' ? [(row as { item: number }).item] : [])) : []
}

/** Link Media's own controls (a custom body): upstream's ids, its Cancel and Link being the shared Cancel and OK. */
const LINK_CONTROLS: readonly DialogControl[] = [
  { field: 'row', label: 'Clip Name', upstream: ['linkMedia.row.{}'] },
  ...MATCH_OPTIONS.map(([key, label]) => ({
    field: `match.${key}`,
    label,
    upstream: [`linkMedia.match.${key}`],
  })),
  {
    field: 'alignTimecode',
    label: 'Align Timecode',
    upstream: ['linkMedia.alignTimecode'],
  },
  {
    field: 'relinkOthers',
    label: 'Relink others automatically',
    upstream: ['linkMedia.relinkOthers'],
  },
  {
    field: 'offlineAll',
    label: 'Offline All',
    upstream: ['linkMedia.offlineAll'],
  },
  { field: 'offline', label: 'Offline', upstream: ['linkMedia.offline'] },
  { field: 'locate', label: 'Locate…', upstream: ['linkMedia.locate'] },
]

/**
 * File ▸ Link Media… (`linkMedia`): the clips whose media is missing or offline, upstream's match
 * options, Align Timecode, and Relink others automatically. Locate… picks the chosen row's file
 * through the host, relative to the project; the preview relinks it on the scratch session (the
 * Project panel shows the row online with its picture, and with Relink others the other rows it
 * would relink; the Program monitor the picture), and Link runs `media.relink` for real, as
 * upstream's Locate… does at once. The dialog stays open on the rows left and closes when none
 * is (upstream's). Offline sets a row aside; Offline All runs `media.offlineAll` and closes.
 * Opened with nothing missing, it says "All media is online." in the status bar, as upstream's
 * route.
 */
const linkMedia: DialogSpec = {
  id: 'media.linkMedia',
  family: 'media',
  title: 'Link Media',
  prefix: 'linkMedia',
  upstream: 'linkMedia',
  okLabel: 'Link',
  buttons: { ok: 'linkMedia.link', cancel: 'linkMedia.cancel' },
  preview: ['project', 'picture'],
  // Upstream's dialog stays open after Link on the rows left (it closes when none is).
  keepOpen: true,
  runs: ['media.relink'],
  okEnabled: (draft) => locatedOf(draft) != null,
  controls: LINK_CONTROLS,
  // What Link relinks follows the draft and the document only.
  dependsOn: () => null,
  defaults: async (ctx: DialogContext) => {
    // Upstream's route runs `media.linkMedia {}` (it rescans; it edits nothing).
    if (!ctx.ask) throw new Error('no document')
    const rows = missingRows(await ctx.ask('media.linkMedia', {}))
    if (rows.length === 0) throw new Error('All media is online.')
    return {
      ...LINK_CHOICES,
      row: rows[0].item,
      located: null,
      skipped: [],
      info: { rows },
    }
  },
  steps: (draft) => {
    const params = linkParams(draft)
    return params ? [{ command: 'media.relink', params }] : null
  },
  previewable: (draft) => locatedOf(draft) != null,
  // Link relinked the located file: it goes at once, so a second press (or Enter on Link) runs
  // nothing more until Locate… picks again (upstream clears its candidates after a link).
  afterOk: (draft, results) => {
    const located = locatedOf(draft)
    return located && relinkedItems(results[results.length - 1]).includes(located.item) ? { ...draft, located: null } : draft
  },
  // Upstream's Cancel (and Escape) runs Offline All: it clears the prompt a project opened with,
  // and changes nothing else (no history step, no revision); it runs once the preview has ended.
  cancelSteps: [{ command: 'media.offlineAll', params: {} }],
  // A file that does not match (or cannot be read) is the preview's answer, as upstream shows its message under the rows.
  quietError: (message) => /doesn't match|can't be opened|can't read|is not file media/.test(message),
  okStatus: (results, phrase) => phrase('Linked {n} clip(s)').replace('{n}', String(relinkedItems(results[results.length - 1]).length)),
}

/**
 * File ▸ Make Offline… (`makeOffline`): upstream's confirmation, "Make n selected clip(s) offline.
 * Their clips show the offline slate until you link them again.", with Media files remain on disk
 * (its choice to delete the files is hidden on the web). OK makes the Project selection's file
 * items offline. The Project panel previews the offline badge on their rows, the Program monitor
 * the offline slate at the playhead.
 */
const makeOffline: DialogSpec = {
  id: 'media.makeOffline',
  family: 'media',
  title: 'Make Offline',
  prefix: 'makeOffline',
  upstream: 'makeOffline',
  buttons: { ok: 'makeOffline.ok', cancel: 'makeOffline.cancel' },
  preview: ['project', 'picture'],
  controls: [
    {
      field: 'keep',
      label: 'Media files remain on disk',
      upstream: ['makeOffline.keep'],
    },
  ],
  // The Project item menu names its item (`{item}`), so the dialog acts on it, not on a selection
  // that lands after the call; any other value runs the command at once (an agent's, upstream's).
  opens: (params) => Object.keys(params).every((key) => key === 'item') && (params.item === undefined || typeof params.item === 'number'),
  dependsOn: (ctx) => ctx.session?.projectSelection ?? [],
  // The project's file items, so the question counts and OK names only what the engine makes offline.
  defaults: async (ctx) => ({
    deleteFiles: false,
    item: typeof ctx.params.item === 'number' ? ctx.params.item : null,
    info: { files: fileItems(await ctx.query('media.status', {})) },
  }),
  // Upstream sends `{deleteFiles}` for the Project selection; the items are named, so OK makes
  // offline what the preview showed.
  toParams: (draft, ctx) => ({ items: offlineTargets(draft, ctx), deleteFiles: false }),
}

export const MEDIA_DIALOGS: readonly DialogSpec[] = [linkMedia, makeOffline]
