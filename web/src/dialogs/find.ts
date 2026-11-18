// Upstream's Find, Create Search Bin, and Automate To Sequence dialogs (`panels/menu_dialogs.rs`
// `defaults`, `show`, `run`): each one's title, draft, fields, and params. Imports carry `.ts` so
// `node --test` loads this module as it is.
import { engineDefaults } from './clip.ts'
import type { DialogContext, DialogSpec, Draft, FieldRow, Params } from './registry.ts'

/** The columns a Find row and a search bin search (engine `find::COLUMNS`, in its order). */
export const FIND_COLUMNS = ['All', 'Name', 'Label', 'Media Type', 'Frame Rate', 'Media Duration', 'Video Info', 'Audio Info', 'File Path', 'Tape Name', 'Description', 'Comment', 'Log Note', 'Scene', 'Shot'] as const
/** Upstream's `FindOp::ALL`, `[name, label]`. */
export const FIND_OPERATORS = [
  ['contains', 'Contains'],
  ['matches', 'Matches'],
  ['beginsWith', 'Begins With'],
  ['endsWith', 'Ends With'],
  ['doesNotContain', 'Does Not Contain'],
] as const
const COLUMN_OPTIONS = FIND_COLUMNS.map((column) => [column, column] as const)

type FindRow = { column: string; operator: string; text: string }
const BLANK: FindRow = { column: 'Name', operator: 'contains', text: '' }

/** A Find draft's two rows (upstream pads them to two). */
export function findRows(draft: Draft): FindRow[] {
  const listed = Array.isArray(draft.rows) ? (draft.rows as Array<Partial<FindRow> | null>) : []
  const rows = listed.map((row) => ({ column: String(row?.column ?? 'Name'), operator: String(row?.operator ?? 'contains'), text: String(row?.text ?? '') }))
  while (rows.length < 2) rows.push({ ...BLANK })
  return rows
}

/** One key of Find row `n`: what it shows, and the draft with it set. */
const rowKey = (n: number, key: keyof FindRow) => ({
  value: (draft: Draft) => findRows(draft)[n][key],
  change: (draft: Draft, value: unknown) => ({ ...draft, rows: findRows(draft).map((row, index) => (index === n ? { ...row, [key]: String(value ?? '') } : row)) }),
})

const timeline = (draft: Draft) => draft.scope === 'timeline'
const project = (draft: Draft) => !timeline(draft)

/** One project row of Find: its column, its operator, and the text (upstream `find.row.<n>.*`, no labels). */
const projectRow = (n: number): FieldRow => ({
  kind: 'row',
  shown: project,
  rows: [
    { kind: 'choice', field: `row.${n}.column`, label: 'Column', bare: true, upstream: ['find.row.{}.column'], options: COLUMN_OPTIONS, ...rowKey(n, 'column') },
    { kind: 'choice', field: `row.${n}.operator`, label: 'Operator', bare: true, upstream: ['find.row.{}.operator'], options: FIND_OPERATORS, ...rowKey(n, 'operator') },
    { kind: 'text', field: `row.${n}.text`, label: 'Find What', bare: true, width: 160, upstream: n === 0 ? ['find.row.0.text', 'find.row.{}.text'] : ['find.row.{}.text'], ...rowKey(n, 'text') },
  ],
})

/** The rows a Find runs: the first only in the Timeline (upstream's `run` keeps `rows[0]`). */
const searched = (draft: Draft) => (timeline(draft) ? findRows(draft).slice(0, 1) : findRows(draft))

type Translate = (key: string, values?: Record<string, string | number>) => string

/** What the strip says of a Find: upstream's "Match n of total", from the answer of `edit.find`. */
export function findLines(result: unknown, t: Translate): string[] {
  const answer = result as { index?: unknown; matches?: unknown } | null
  if (!answer || typeof answer.matches !== 'number') return []
  return [t('preview.findMatch', { n: (typeof answer.index === 'number' ? answer.index : 0) + 1, total: answer.matches })]
}

const ids = (value: unknown) => (Array.isArray(value) ? value.filter((each): each is number => typeof each === 'number') : [])

/** Every match a Find's answer names: the Project panel's items, or the Timeline's clips and markers. */
export function findMatches(result: unknown) {
  const answer = result as { items?: unknown; clips?: unknown; markers?: unknown } | null
  if (!answer) return null
  return { items: ids(answer.items), clips: ids(answer.clips), markers: ids(answer.markers) }
}

/**
 * Edit ▸ Find… (`find`, buttons Find and Done): Find in the Project panel (two rows of column,
 * operator, and text, Match All or Any, Case Sensitive) or the Timeline (one text and what it
 * searches). Find selects the first match and moves to it, and the dialog stays open with "Match
 * n of total"; Done closes it. The preview highlights every match, not only the one selected.
 */
const find: DialogSpec = {
  id: 'edit.find',
  family: 'find',
  title: 'Find',
  prefix: 'find',
  okLabel: 'Find',
  cancelLabel: 'Done',
  preview: ['selection'],
  keepOpen: true,
  layout: [
    {
      kind: 'row',
      label: 'Find in:',
      rows: [
        {
          kind: 'radio',
          field: 'scope',
          label: 'Find in:',
          options: [
            ['project', 'Project'],
            ['timeline', 'Timeline'],
          ],
        },
      ],
    },
    { kind: 'separator' },
    { kind: 'text', field: 'row.0.text', label: 'Find:', width: 240, shown: timeline, upstream: ['find.row.0.text'], ...rowKey(0, 'text') },
    {
      kind: 'row',
      label: 'Search:',
      shown: timeline,
      rows: [
        {
          kind: 'radio',
          field: 'in',
          label: 'Search:',
          options: [
            ['all', 'Clip Names and Markers'],
            ['clips', 'Clip Names'],
            ['markers', 'Markers'],
          ],
        },
      ],
    },
    projectRow(0),
    projectRow(1),
    {
      kind: 'row',
      label: 'Match:',
      shown: project,
      rows: [
        {
          kind: 'radio',
          field: 'match',
          label: 'Match:',
          options: [
            ['all', 'All'],
            ['any', 'Any'],
          ],
          optionUpstream: (value) => [`find.match.${value}`],
          value: (draft) => (draft.matchAll === false ? 'any' : 'all'),
          change: (draft, value) => ({ ...draft, matchAll: value !== 'any' }),
        },
        { kind: 'check', field: 'caseSensitive', label: 'Case Sensitive' },
      ],
    },
  ],
  // What it finds follows the draft, the document (its revision), and the sequence shown.
  dependsOn: (ctx) => ({ sequence: ctx.film?.activeSequence ?? null }),
  defaults: async (ctx) => {
    const read = await engineDefaults(ctx, 'edit.find')
    const params = read?.params ?? { scope: 'project', rows: [{ ...BLANK }, { ...BLANK }], matchAll: true, caseSensitive: false, in: 'all' }
    // Upstream opens on the Timeline while the Timeline has focus and a sequence is open.
    const scope = ctx.focused === 'timeline' && ctx.film?.activeSequence != null ? 'timeline' : 'project'
    return { ...params, scope, rows: findRows(params) }
  },
  toParams: (draft) => ({ scope: timeline(draft) ? 'timeline' : 'project', rows: searched(draft), matchAll: draft.matchAll !== false, caseSensitive: draft.caseSensitive === true, in: String(draft.in ?? 'all') }),
  // Nothing to find until a row has text; Find still runs, for the engine's "enter text to find" (upstream's error).
  previewable: (draft) => searched(draft).some((row) => row.text !== ''),
  resultLines: findLines,
  highlight: findMatches,
  // No match is an answer the strip shows while the text is typed (upstream shows it after Find).
  quietError: (message) => /no matches/.test(message),
}

/**
 * File ▸ New ▸ Search Bin (`searchBin`): its name, the column, the operator, and the text,
 * which opens on the Project panel's search. OK makes the search bin, listed in the Project
 * panel with its matches.
 */
const newSearchBin: DialogSpec = {
  id: 'file.newSearchBin',
  family: 'find',
  title: 'Create Search Bin',
  prefix: 'searchBin',
  preview: ['project'],
  layout: [
    { kind: 'text', field: 'name', label: 'Name:', width: 220 },
    { kind: 'choice', field: 'column', label: 'Search:', upstream: ['searchBin.column'], options: COLUMN_OPTIONS },
    { kind: 'choice', field: 'operator', label: 'Operator', bare: true, upstream: ['searchBin.operator'], options: FIND_OPERATORS },
    { kind: 'text', field: 'text', label: 'Find:', width: 220 },
  ],
  // What it makes follows the draft and the document only.
  dependsOn: () => null,
  defaults: (ctx) => ({ name: '', column: 'All', operator: 'contains', text: ctx.projectSearch ?? '' }),
  // Upstream's run() sends the draft as it is, an empty name too.
  toParams: (draft): Params => ({ name: String(draft.name ?? ''), column: String(draft.column ?? 'All'), operator: String(draft.operator ?? 'contains'), text: String(draft.text ?? '') }),
  // The engine refuses a search bin with no text ("enter text to search for"), which OK shows.
  previewable: (draft) => String(draft.text ?? '') !== '',
}

/** A draft's `info` field, as an object. */
const infoOf = (draft: Draft) => (draft.info && typeof draft.info === 'object' ? (draft.info as Record<string, unknown>) : {})
const whole = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Math.round(Number(value))
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}
const radios = (field: string, label: string, options: ReadonlyArray<readonly [string, string]>): FieldRow => ({ kind: 'row', label, rows: [{ kind: 'radio', field, label, options }] })

/** Clip Overlap's and Frames per Still's width, the same for both, in px. */
const FRAMES_WIDTH = 240

/** Upstream's Automate To Sequence draft (`defaults`). */
const AUTOMATE: Draft = { ordering: 'sort', placement: 'sequentially', method: 'insert', overlapFrames: 30, stillFrames: 150, videoTransition: true, audioTransition: true, ignoreAudio: false, ignoreVideo: false }

/**
 * Clip ▸ Automate to Sequence… (`automate`): the Project panel's selected items placed in the
 * active sequence at the playhead (sequentially, or at its unnumbered markers), by insert or
 * overwrite, with the clip overlap, the frames per still, the default transitions, and what to
 * ignore. The Timeline previews the clips placed.
 */
const automate: DialogSpec = {
  id: 'clip.automateToSequence',
  family: 'find',
  title: 'Automate To Sequence',
  prefix: 'automate',
  preview: ['timeline'],
  layout: [
    // Upstream's plain "To {name}" label, empty without a sequence.
    { kind: 'readout', label: 'To', testId: 'sequence', plain: true, value: (draft) => String(infoOf(draft).sequence ?? '') },
    radios('ordering', 'Ordering:', [
      ['sort', 'Sort Order'],
      ['selection', 'Selection Order'],
    ]),
    radios('placement', 'Placement:', [
      ['sequentially', 'Sequentially'],
      ['unnumberedMarkers', 'At Unnumbered Markers'],
    ]),
    radios('method', 'Method:', [
      ['insert', 'Insert Edit'],
      ['overwrite', 'Overwrite Edit'],
    ]),
    { kind: 'number', field: 'overlapFrames', label: 'Clip Overlap:', min: 0, max: 600, step: 1, unit: 'frames', width: FRAMES_WIDTH },
    { kind: 'number', field: 'stillFrames', label: 'Frames per Still:', min: 1, max: 100_000, step: 1, unit: 'frames', width: FRAMES_WIDTH },
    { kind: 'heading', label: 'Transitions' },
    { kind: 'check', field: 'audioTransition', label: 'Apply Default Audio Transition' },
    { kind: 'check', field: 'videoTransition', label: 'Apply Default Video Transition' },
    { kind: 'heading', label: 'Ignore Options' },
    { kind: 'check', field: 'ignoreAudio', label: 'Ignore Audio' },
    { kind: 'check', field: 'ignoreVideo', label: 'Ignore Video' },
  ],
  // What it places follows the sequence, the Project panel's selection, and the playhead.
  dependsOn: (ctx) => ({ sequence: ctx.film?.activeSequence ?? null, items: ctx.session?.projectSelection ?? [], playhead: ctx.film?.playhead ?? 0 }),
  defaults: async (ctx: DialogContext) => {
    const read = await engineDefaults(ctx, 'clip.automateToSequence')
    if (read) return { ...read.params, info: read.info }
    return { ...AUTOMATE, info: { sequence: ctx.film?.activeSequence != null ? (ctx.film.name ?? '') : null } }
  },
  // Whole frames, rounded (upstream's f64 DragValue sends 30.0, which the engine truncates to 30).
  toParams: (draft) => ({
    ordering: String(draft.ordering ?? 'sort'),
    placement: String(draft.placement ?? 'sequentially'),
    method: String(draft.method ?? 'insert'),
    overlapFrames: whole(draft.overlapFrames, 0, 600, 30),
    stillFrames: whole(draft.stillFrames, 1, 100_000, 150),
    videoTransition: draft.videoTransition !== false,
    audioTransition: draft.audioTransition !== false,
    ignoreAudio: draft.ignoreAudio === true,
    ignoreVideo: draft.ignoreVideo === true,
  }),
}

export const FIND_DIALOGS: readonly DialogSpec[] = [find, newSearchBin, automate]
