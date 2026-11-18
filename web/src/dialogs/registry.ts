// Imports carry `.ts` so `node --test` loads this module as it is.
import type { FilmInfo } from '../film.ts'
import type { FilmSessionState } from '../session/useFilmSession.ts'
import type { PreviewDrawer } from './preview.ts'
import { CLIP_DIALOGS } from './clip.ts'
import { CLIP_STRUCTURE_DIALOGS } from './clipStructure.ts'
import { FIND_DIALOGS } from './find.ts'
import { HELP_DIALOGS } from './help.ts'
import { MEDIA_DIALOGS } from './media.ts'
import { MENU_DIALOGS } from './menu.ts'
import { PROJECT_DIALOGS } from './project.ts'
import { SEQUENCE_DIALOGS } from './sequence.ts'
import { TRACKS_DIALOGS } from './tracks.ts'

/**
 * How a dialog previews what OK will do (every dialog previews;
 * upstream's dialogs have none):
 * - `picture`: the Program monitor shows the preview's frame at the playhead;
 * - `sound`: the strip's Play button plays 3 s from the playhead from `previewAudio`;
 * - `timeline`: the Timeline draws the preview's changes over its own tracks;
 * - `project`: the Project panel draws the preview's items;
 * - `selection`: the Project panel and the Timeline highlight the preview's selection;
 * - `markers`: the rulers and the Markers panel show the preview's markers;
 * - `summary`: the strip lists what OK will do (commands that write outside the project,
 *   `PREVIEW_EXTERNAL`, which never run on the scratch session);
 * - `none`: a dialog that changes nothing (About, Properties, Source Settings), with its note.
 *
 * A kind whose panel is not on screen shows in the strip instead, as text (or, for `picture`, a
 * small frame), so every preview is visible in some form.
 */
export type PreviewKind = 'picture' | 'sound' | 'timeline' | 'project' | 'selection' | 'markers' | 'summary' | 'none'

/** The kinds that run the command on the engine's scratch session. */
export const ENGINE_KINDS: ReadonlySet<PreviewKind> = new Set(['picture', 'sound', 'timeline', 'project', 'selection', 'markers'])
/** The kinds a panel draws from the preview's diff (the strip lists them while that panel is not shown). */
export const DIFF_KINDS: ReadonlySet<PreviewKind> = new Set(['timeline', 'project', 'selection', 'markers'])

/** Upstream's dialog modules, by the file family this editor keeps each in (`web/src/dialogs/`). */
export type DialogFamily = 'clip' | 'clipStructure' | 'sequence' | 'tracks' | 'find' | 'menu' | 'media' | 'project' | 'presets' | 'monitor' | 'help'

export type Params = Record<string, unknown>
/** A dialog's draft: the values its fields edit, as upstream's `*Draft` structs and `ClipDialogDraft.params`. */
export type Draft = Record<string, unknown>
/** One command a dialog runs (OK runs each in order; the preview runs them as steps). */
export type DialogStep = { command: string; params: Params }
/** What a `selection` preview highlights (`DialogSpec.highlight`): items in the Project panel, clips and markers on the Timeline. */
export type PreviewHighlight = { items?: readonly number[]; clips?: readonly number[]; markers?: readonly number[] }

/** What a dialog reads when it opens (upstream's `defaults(app, id)`) and when it computes its params. */
export type DialogContext = {
  /** The document as `inspect()` shows it, or null before it opens. */
  film: FilmInfo | null
  /** The session state beside `inspect()` (`state.inspect`). */
  session: FilmSessionState | null
  /** The parameters `invoke` was called with (a dialog that opens with some, such as Interpret Footage's item). */
  params: Readonly<Params>
  /** A read-only engine query, answered as parsed JSON (null when it fails). */
  query: (id: string, params?: Params) => Promise<unknown>
  /**
   * A read-only engine query whose failure throws the engine's error (upstream's `?` in a dialog's
   * defaults, which keeps the dialog shut and puts the error in the status bar); absent where no
   * engine is.
   */
  ask?: (id: string, params?: Params) => Promise<unknown>
  /**
   * A read-only engine extra (`dialogDefaults`, …), its JSON answer parsed (null when it fails);
   * absent where no engine is (a test's context).
   */
  read?: (name: string, ...args: unknown[]) => Promise<unknown>
  /** The panel that had focus when the dialog opened (upstream's `app.ui.focused`, lowerCamel): Find opens on the Timeline from it. */
  focused?: string
  /** The Project panel's search text when the dialog opened (upstream's `app.ui.project_search`): Create Search Bin opens on it. */
  projectSearch?: string
  /** The bin the Project panel showed when the dialog opened (upstream's `view_of(app, inst).bin`): Save Arrangement saves its cards. */
  projectBin?: number | null
  /** The width the Project panel's Freeform view lays its cards out for (0 before it is drawn). */
  freeformWidth?: number
  /** The command that opened the dialog (an alias's own id: Ingest Settings… opens Project Settings on its Ingest tab). */
  command?: string
  /** The page's catalog, for a default upstream's dialog translates (`tlf!("Project View Preset {n}")`); absent in a test's context. */
  phrase?: (text: string) => string
}

type FieldBase = {
  /** The draft key, and the id's last part: `control:dialog.<prefix>.<field>`. */
  field: string
  /** Upstream's ids this field stands for (by default `<upstream>.<field>`, `.{}` added for radios). */
  upstream?: readonly string[]
  /** Upstream's English label, shown through `phrase()`. */
  label: string
  /** Drawn disabled while this says false (upstream's `add_enabled`); `ctx` is absent where no document is read. */
  enabled?: (draft: Draft, ctx?: DialogContext) => boolean
  /** Drawn only while this says true (upstream draws the row inside an `if`). */
  shown?: (draft: Draft) => boolean
  /** Upstream's hover text while the field is disabled (`on_disabled_hover_text`), through `phrase()`. */
  hint?: string
  /** What the field shows, when it is not the draft's `field` (Sequence Settings' timebase is `fpsNum`/`fpsDen`). */
  value?: (draft: Draft, ctx: DialogContext) => unknown
  /** What setting the field does to the draft, when it is more than its own key (a new timebase also picks its timecode). */
  change?: (draft: Draft, value: unknown, ctx: DialogContext) => Draft
}

/**
 * One option, `[value, upstream's label]`; a label made from data is upstream's template
 * (`"After {name}"`, its `tlf!`) with the `values` that fill it once it is translated (`optionText`).
 */
export type FieldOption = readonly [string, string] | readonly [string, string, Readonly<Record<string, string>>]

/** A choice's or radio group's options: fixed, or read from the draft and the document. */
export type FieldOptions = ReadonlyArray<FieldOption> | ((draft: Draft, ctx: DialogContext) => ReadonlyArray<FieldOption>)

/** What an option shows: its label through `phrase`, then its values filled in (upstream's `tlf!`). */
export const optionText = (option: FieldOption, phrase: (text: string) => string) =>
  Object.entries(option[2] ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, () => value), phrase(option[1]))

/** The options of `row` for `draft`. */
export const optionsOf = (options: FieldOptions, draft: Draft, ctx: DialogContext) => (typeof options === 'function' ? options(draft, ctx) : options)

/** The frame rate a dialog's timecodes count in: the sequence's, else 30 (one default for the readouts and the timecode fields). */
export const dialogFps = (ctx: DialogContext) => (ctx.film?.fps && ctx.film.fps > 0 ? ctx.film.fps : 30)

/** A field row of upstream's dialogs, drawn by `fields.tsx` with upstream's label. */
export type FieldRow =
  /**
   * `bare`: no label before the box (its label names it, and `unit` follows it: Frame Size's
   * "horizontal"); `width` in px (upstream's `DragValue` sizes to its text); `suffix`: upstream's
   * DragValue suffix (`" %"`), shown before the unit and never translated.
   */
  | (FieldBase & { kind: 'number'; min: number; max: number; step?: number; unit?: string; suffix?: string; bare?: boolean; width?: number })
  | (FieldBase & { kind: 'timecode' })
  /**
   * A whole number of media frames (from 0), with its timecode at `fps(draft)` beside it, as
   * upstream's `clip_dialogs.rs` `frames` row (Make and Edit Subclip's Start and End).
   */
  | (FieldBase & { kind: 'frames'; fps: (draft: Draft) => number })
  /**
   * A list (upstream's `ComboBox`); `disabledOptions` are labels it lists greyed after the
   * options, with the row's `hint` (Display Format's Feet + Frames); `width` in px; `bare`: no
   * label drawn, the label its accessible name (Delete Tracks' lists).
   */
  | (FieldBase & { kind: 'choice'; options: FieldOptions; disabledOptions?: readonly string[]; width?: number; bare?: boolean })
  /**
   * A value upstream shows and never lets change: `list`, a greyed list showing it (`fixed_combo`);
   * `value`, a greyed number box (`fixed_value`); `text`, a plain label (Frame Size's aspect).
   * `text` is what it shows, through `phrase()` for `list`; `labelAfter` puts the label after it
   * (VR Properties' "0° Horizontal").
   */
  | (FieldBase & { kind: 'fixed'; look: 'list' | 'value' | 'text'; text: (draft: Draft, ctx: DialogContext) => string; width?: number; labelAfter?: boolean })
  /** A button upstream draws disabled, with its `hint` (Sequence Settings' Configure… and Reset). */
  | (FieldBase & { kind: 'inert' })
  /**
   * One Kit UI id per option, `control:dialog.<prefix>.<field>.<value>`, as upstream registers each
   * radio; `optionUpstream` names an option's own upstream ids where upstream lists each
   * (`{}.processing.none`), in place of the row's.
   */
  | (FieldBase & { kind: 'radio'; options: FieldOptions; optionUpstream?: (value: string) => readonly string[] })
  | (FieldBase & { kind: 'check' })
  | (FieldBase & { kind: 'color' })
  /**
   * `width`: upstream's `desired_width`, in px (the field fills the row without it); `bare`: no
   * label drawn, the label its accessible name (Find's rows).
   */
  | (FieldBase & { kind: 'text'; autoFocus?: boolean; width?: number; bare?: boolean })
  | (FieldBase & { kind: 'multiline' })
  | { kind: 'heading'; label: string }
  /** Upstream's `ui.separator()`. */
  | { kind: 'separator' }
  /**
   * A checkbox per option, which adds its value to the draft's list `field` or takes it out
   * (Paste Attributes' effects, `p["effects"]`); the options are the document's, so every box has
   * the one id `control:dialog.<prefix>.<item>` (upstream's `<prefix>.<item>.<value>`), and
   * `empty` shows while there are none. Labels go through `phrase()`, as upstream's `i18n::t`.
   */
  | (FieldBase & { kind: 'checklist'; item: string; options: FieldOptions; empty: string })
  /**
   * A value the dialog shows and does not edit (Speed / Duration's Duration); hidden while `value`
   * is null. It may read the engine (a promise). `plain`: one label, as body text (Automate's "To
   * <sequence>"), not a readout's figures.
   */
  | { kind: 'readout'; label: string; testId: string; plain?: boolean; value: (draft: Draft, ctx: DialogContext) => string | null | Promise<string | null> }
  /**
   * Upstream's tabs (Project Settings' General and Ingest): the draft's `field` names the tab
   * shown; each tab is `control:dialog.<prefix>.<field>.<id>` and draws its own rows. The tab row,
   * after the `lead` rows drawn above it (Project Settings' "Project: <name>"), stays pinned
   * while a tall tab's rows scroll.
   */
  | { kind: 'tabs'; field: string; upstream?: (tab: string) => string; lead?: readonly FieldRow[]; tabs: ReadonlyArray<{ id: string; label: string; rows: readonly FieldRow[] }> }
  /**
   * Rows side by side, after an optional label (upstream's `ui.horizontal`); `enabled` false greys
   * the label (upstream's `add_enabled(false, Label)`).
   */
  | { kind: 'row'; label?: string; rows: readonly FieldRow[]; enabled?: boolean; shown?: (draft: Draft) => boolean }
  /** A titled group of rows (upstream's `section`: a strong label over a `ui.group`). */
  | { kind: 'section'; label: string; rows: readonly FieldRow[]; shown?: (draft: Draft) => boolean }

/** A draft read again on the document, and what to say about it (a key of the editor's strings), or null. */
export type DialogNotice = { key: string; values?: Record<string, string | number> }
export type DialogRebase = { draft: Draft; notice: DialogNotice | null }

/** A control a custom body draws (one `fields.tsx` cannot): its id's last part, label, and upstream ids. */
export type DialogControl = { field: string; label: string; upstream: readonly string[] }

export type DialogSpec = {
  /** The command the dialog runs on OK, and opens from (`invoke(id, {})`). */
  id: string
  /** Other ids that open it (upstream's `app.about` for Kition's `help.about`). */
  aliases?: readonly string[]
  family: DialogFamily
  /** Upstream's English title (`meta()`), shown through `phrase()`. */
  title: string
  /** Upstream's automation prefix (`speedDuration`): fields are `control:dialog.<prefix>.<field>`. */
  prefix: string
  /** The prefix of upstream's own ids for the fields: `{}` (`{pre}.<field>`, the default) or a literal one. */
  upstream?: string
  /** One or more kinds; `none` only alone and with `note`, `summary` never with an engine kind. */
  preview: readonly PreviewKind[]
  /** Why a `none` dialog previews nothing ("shows information; nothing to preview"). */
  note?: string
  okLabel?: string
  cancelLabel?: string
  /**
   * Upstream's own ids for this dialog's OK and Cancel where it registers them apart from
   * `<prefix>.ok` (Audio Gain's `audioGain.ok`, the colour dialogs' `colorDialog.ok`): the shared
   * `control:dialog.ok` and `control:dialog.cancel` stand for them too.
   */
  buttons?: { ok: string; cancel: string }
  /**
   * The dialog keeps its last draft for the next time it opens, Cancel or OK (upstream keeps
   * Audio Gain's in `app.ui`): `defaults` reads it with `rememberedDraft`.
   */
  remembers?: boolean
  /**
   * Collaboration rebase: on each engine revision while the dialog is open (and once more at OK),
   * its `defaults` are read again; every draft key still equal to the old baseline takes the new
   * live value, and the live settings become the baseline (`rebaseDraft`), so OK compares with
   * the document as it is and never undoes a peer's change to a field the person left alone.
   */
  rebase?: boolean
  /** The values the draft was drafted against, by draft key (default: the draft's `info.current`). */
  baseline?: (draft: Draft) => Readonly<Record<string, unknown>> | null
  /**
   * The dialog edits the sequence it opened on: it closes when another sequence becomes active, as
   * for a replaced document (Sequence Settings, Color Management). The others stay open, as
   * upstream's do: a `rebase` dialog reads its defaults again for the new sequence, and
   * `sequenceChanged` adjusts the draft.
   */
  sequenceBound?: boolean
  /** The draft when another sequence becomes active under the open dialog (`followSequence`); the same draft when nothing changes. */
  sequenceChanged?: (draft: Draft, ctx: DialogContext) => Draft
  /** One button (Cancel, named by `cancelLabel`): a dialog that only shows information. */
  hideOk?: boolean
  /**
   * With `hideOk`, the one button is upstream's OK (`<prefix>.ok`, Source Settings'), so it
   * carries `control:dialog.ok`; it still only closes.
   */
  onlyOk?: boolean
  /** OK runs without closing, and the preview stays open (upstream's Find). */
  keepOpen?: boolean
  /**
   * The commands OK runs besides `id` (Link Media's `media.relink`): while a `keepOpen` dialog's
   * preview stays open, the document runs them as the dialog's own.
   */
  runs?: readonly string[]
  /** The draft after OK has run with these answers (parsed), for a `keepOpen` dialog: Link Media drops the file it linked. */
  afterOk?: (draft: Draft, results: readonly unknown[]) => Draft
  /** Commands Cancel (and Escape) run once the preview has ended (upstream's Link Media Cancel runs Offline All). */
  cancelSteps?: readonly DialogStep[]
  /** Whether the engine's `enabled` gates opening it, as upstream's routes check first (default true). */
  engine?: boolean
  /** The command starts a job (Scene Edit Detection): the preview settles it, with its progress. */
  job?: boolean
  /**
   * What the status bar says once OK has run (upstream's `app.ui.status` in its `run`), through
   * `phrase()`; or made from OK's answers (Link Media's "Linked n clip(s)").
   */
  okStatus?: string | ((results: readonly unknown[], phrase: (text: string) => string) => string)
  /** Whether `invoke(id, params)` opens the dialog (default: only with no params, as upstream's routes). */
  opens?: (params: Readonly<Params>) => boolean
  /** The fields, drawn by `fields.tsx`; a dialog without it has a custom body (`bodies.tsx`). */
  layout?: readonly FieldRow[]
  /** The ids a custom body draws. */
  controls?: readonly DialogControl[]
  /**
   * What the preview follows besides the draft and the revision (a change begins it again):
   * by default the active sequence, the timeline's selection, and the Project panel's.
   */
  dependsOn?: (ctx: DialogContext) => unknown
  /** The draft the dialog opens with (upstream's `defaults()`), from the document and the params. */
  defaults: (ctx: DialogContext) => Draft | Promise<Draft>
  /** OK's params (upstream's `finish()`); null runs nothing and previews nothing. Default: the draft. */
  toParams?: (draft: Draft, ctx: DialogContext) => Params | null
  /** Several commands in order (New Sequence, the Manage dialogs), in place of `toParams`. */
  steps?: (draft: Draft, ctx: DialogContext) => DialogStep[] | null
  /**
   * Whether the draft is worth previewing (default true): false previews nothing, while OK still
   * runs it, so the engine's own refusal shows (Find with no text: "enter text to find").
   */
  previewable?: (draft: Draft) => boolean
  /**
   * What the preview highlights, from its answer, in place of the copy's selection (Find: every
   * match, where the copy selects only the first): the Project panel's items, and the Timeline's
   * clips and markers.
   */
  highlight?: (result: unknown) => PreviewHighlight | null
  /**
   * An engine refusal that is the preview's answer, not its failure: the strip shows it and the
   * preview follows the next draft (Find's "no matches", which upstream shows after Find).
   */
  quietError?: (message: string) => boolean
  /** What OK will do, as lines (`summary` dialogs), in the editor's strings (`t`), upstream's labels through `phrase`. */
  summary?: (draft: Draft, ctx: DialogContext, t: (key: string, values?: Record<string, string | number>) => string, phrase: (text: string) => string) => string[]
  /**
   * A preview of the Project panel's view preferences, which no diff shows (Metadata Display's
   * columns, Manage's presets), as strip lines; `listShown`: a List view on screen draws the view
   * (the `project:view` drawer). Empty where the panels show it all.
   */
  viewLines?: (draft: Draft, ctx: DialogContext, t: (key: string, values?: Record<string, string | number>) => string, phrase: (text: string) => string, listShown: boolean) => string[]
  /**
   * The drawer whose panel on screen draws the view `viewLines` previews (default `project:view`,
   * the List view's columns; Freeform View Options' is `project:freeform`, the Freeform view).
   */
  viewDrawer?: PreviewDrawer
  /** What the preview follows of the draft (default: all of it): a change elsewhere (a search, a choice of row) does not run it again. */
  previewKey?: (draft: Draft) => unknown
  /**
   * Commands the editor refuses while this dialog's preview is open, besides the edits every
   * preview refuses (the Project panel's view commands while a view preference previews: what the
   * strip names and Done captures stays the view shown).
   */
  previewBlocks?: readonly string[]
  /**
   * Read the document again before OK runs (state no revision follows, such as view presets): a
   * notice, with the draft rebased on what it read, refuses OK; a rebased draft without one runs
   * in its place; null lets the draft run.
   */
  checkOk?: (draft: Draft, ctx: DialogContext) => Promise<DialogRebase | null>
  /** The draft after OK failed once `ran` of its steps had run: those dropped, the rest rebased on the document as it is now. */
  afterFailure?: (draft: Draft, ran: number, ctx: DialogContext) => Promise<DialogRebase>
  /** The draft when what the dialog shows may have changed with no revision (`useFilmSession`'s `projectView`); null when nothing changed. */
  viewRebase?: (draft: Draft, ctx: DialogContext) => Promise<DialogRebase | null>
  /** OK is greyed while this says false (upstream's `add_enabled` on OK: Delete Tracks with nothing checked). */
  okEnabled?: (draft: Draft) => boolean
  /** Lines the strip shows from the preview's answer (Normalize Mix Track's gain), through the editor's strings. */
  resultLines?: (result: unknown, t: (key: string, values?: Record<string, string | number>) => string) => string[]
  /** OK makes a copy of the active sequence (Simplify Sequence): the Timeline compares the copy with it (`previewTimeline`). */
  copiesSequence?: boolean
  /** An item the strip draws from the preview (`previewItemFrame`), named by the preview's answer: a new Color Matte on no track. */
  stripItem?: (result: unknown) => number | null
}

const remembered = new Map<string, Draft>()
/** The draft a `remembers` dialog was left with this page, or null (upstream's `app.ui` draft; the UI owns it, rule 5). */
export const rememberedDraft = (id: string): Draft | null => remembered.get(id) ?? null
/** Keeps `draft` as `id`'s for the next time it opens. */
export const rememberDraft = (id: string, draft: Draft) => void remembered.set(id, draft)

/** A draft's baseline (`DialogSpec.baseline`, by default `info.current`), or null. */
export function draftBaseline(spec: Pick<DialogSpec, 'baseline'>, draft: Draft): Readonly<Record<string, unknown>> | null {
  if (spec.baseline) return spec.baseline(draft)
  const current = (draft.info as { current?: unknown } | null | undefined)?.current
  return current && typeof current === 'object' ? (current as Record<string, unknown>) : null
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * `draft` rebased on `fresh` (the dialog's defaults read again after a peer's change): each key
 * whose value is still the old baseline's takes the live one, and the draft takes `fresh`'s
 * `info` (where the baseline lives), so the live settings are the baseline after. A key the
 * person changed keeps their value; one they changed back to the baseline's counts as untouched
 * and takes the live value.
 */
export function rebaseDraft(spec: Pick<DialogSpec, 'baseline'>, draft: Draft, fresh: Draft): Draft {
  const old = draftBaseline(spec, draft)
  const live = draftBaseline(spec, fresh)
  if (!old || !live) return draft
  const next: Draft = { ...draft, info: fresh.info ?? draft.info }
  for (const key of Object.keys(live)) if (key in old && key in draft && sameValue(draft[key], old[key])) next[key] = live[key]
  return next
}

/** Whether a `sequenceBound` dialog opened on sequence `openedOn` must close: another sequence is active now. */
export const sequenceGone = (spec: Pick<DialogSpec, 'sequenceBound'>, openedOn: number | null | undefined, film: Pick<FilmInfo, 'activeSequence'> | null) =>
  spec.sequenceBound === true && film != null && (film.activeSequence ?? null) !== (openedOn ?? null)

/** `draft` after another sequence became active under its open dialog: its `sequenceChanged`, else the same draft. */
export const followSequence = (spec: Pick<DialogSpec, 'sequenceChanged'>, draft: Draft, ctx: DialogContext): Draft => (spec.sequenceChanged ? spec.sequenceChanged(draft, ctx) : draft)

/** The commands OK runs for `draft`, in order; empty when it runs nothing (`toParams` answered null). */
export function dialogSteps(spec: DialogSpec, draft: Draft, ctx: DialogContext): DialogStep[] {
  if (spec.steps) return spec.steps(draft, ctx) ?? []
  const params = spec.toParams ? spec.toParams(draft, ctx) : { ...draft }
  return params == null ? [] : [{ command: spec.id, params }]
}

/** The commands the preview runs for `draft`: OK's, unless the draft is not worth previewing (`previewable`). */
export const previewSteps = (spec: DialogSpec, draft: Draft, ctx: DialogContext): DialogStep[] => (spec.previewable && !spec.previewable(draft) ? [] : dialogSteps(spec, draft, ctx))

/**
 * OK: each command of `dialogSteps` once, in order, through `run` (the editor's `invoke` with the
 * params, so it runs at once as one history step). A failure stops it and reaches the dialog.
 */
export async function runDialog(spec: DialogSpec, draft: Draft, ctx: DialogContext, run: (command: string, params: Params) => Promise<unknown>) {
  const results: unknown[] = []
  for (const step of dialogSteps(spec, draft, ctx)) {
    try {
      results.push(await run(step.command, step.params))
    } catch (error) {
      // How many steps ran before this one failed (`stepsRan`): they are in the document now.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { ran: results.length })
    }
  }
  return results
}

/** How many of OK's steps ran before `error` stopped `runDialog` (0 for an error from elsewhere). */
export const stepsRan = (error: unknown) => (typeof (error as { ran?: unknown } | null)?.ran === 'number' ? (error as { ran: number }).ran : 0)

/** What `spec`'s preview follows besides its draft (see `DialogSpec.dependsOn`). */
export function previewDepends(spec: DialogSpec, ctx: DialogContext): unknown {
  if (spec.dependsOn) return spec.dependsOn(ctx)
  return { sequence: ctx.film?.activeSequence ?? null, selection: ctx.film?.selection ?? [], projectSelection: ctx.session?.projectSelection ?? [] }
}

/** What the host and the document allow, when a dialog would open. */
export type DialogGate = { denied: boolean; readOnly: boolean; edits: boolean; enabled: boolean }

/**
 * Why `spec`'s dialog does not open, as upstream's routes check before they draft: the host
 * denies the command, the document is read-only and the command edits it, or the engine cannot
 * run it now (the editor reads the engine's reason). Null opens it. A dialog that only shows
 * information (`engine: false`) always opens.
 */
export function dialogRefusal(spec: DialogSpec, gate: DialogGate): 'denied' | 'readOnly' | 'disabled' | null {
  if (spec.engine === false) return null
  if (gate.denied) return 'denied'
  if (gate.readOnly && gate.edits) return 'readOnly'
  if (!gate.enabled) return 'disabled'
  return null
}

/** Whether `kitEditor.run(id, params)` (a menu row, the palette, a shortcut's `{}`) or `ask(id)` opens Film's dialog for `id`. */
export function editorOpens(id: string, params: Readonly<Params> | undefined) {
  return DIALOGS.has(id) && (params === undefined || Object.keys(params).length === 0)
}

/** Whether `kinds` run the command on the engine's scratch session. */
export const previewsInEngine = (kinds: readonly PreviewKind[]) => kinds.some((kind) => ENGINE_KINDS.has(kind))

/** What is wrong with `spec`'s preview kinds; empty when nothing is. */
export function specProblems(spec: DialogSpec): string[] {
  const problems: string[] = []
  const kinds = spec.preview
  if (kinds.length === 0) problems.push(`${spec.id}: no preview kind`)
  if (kinds.includes('none') && (kinds.length > 1 || !spec.note?.trim())) problems.push(`${spec.id}: \`none\` must be alone, with its note`)
  if (!kinds.includes('none') && spec.note) problems.push(`${spec.id}: a note is only for \`none\``)
  if (kinds.includes('summary') && previewsInEngine(kinds)) problems.push(`${spec.id}: \`summary\` never runs on the scratch session`)
  if (kinds.includes('summary') && !spec.summary) problems.push(`${spec.id}: \`summary\` needs its lines`)
  if (!spec.layout && !spec.controls) problems.push(`${spec.id}: neither fields nor a custom body's controls`)
  return problems
}

const isEmpty = (params: Readonly<Params>) => Object.keys(params).length === 0

export type DialogRegistry = ReturnType<typeof createRegistry>

/** A command id → dialog map; every spec must pass `specProblems`. */
export function createRegistry(specs: readonly DialogSpec[]) {
  const byId = new Map<string, DialogSpec>()
  for (const spec of specs) {
    const problems = specProblems(spec)
    if (problems.length) throw new Error(problems.join('; '))
    for (const id of [spec.id, ...(spec.aliases ?? [])]) {
      if (byId.has(id)) throw new Error(`two dialogs open from ${id}`)
      byId.set(id, spec)
    }
  }
  return {
    specs,
    get: (id: string) => byId.get(id) ?? null,
    has: (id: string) => byId.has(id),
    /** Whether `invoke(id, params)` opens the dialog rather than running the command at once. */
    opens: (id: string, params: Readonly<Params> = {}) => {
      const spec = byId.get(id)
      return spec != null && (spec.opens ? spec.opens(params) : isEmpty(params))
    },
  }
}

/**
 * The buttons every dialog shares (rule 3): OK and Cancel stand for upstream's `<prefix>.ok` and
 * `<prefix>.cancel`; Preview and the sound strip's Play are Kition's (upstream draws no preview).
 */
export const DIALOG_BUTTONS = {
  ok: 'control:dialog.ok',
  cancel: 'control:dialog.cancel',
  preview: 'control:dialog.preview',
  play: 'control:dialog.preview.play',
} as const

/** A dialog field's Kit UI id: `control:dialog.<prefix>.<field>`. */
export const fieldId = (spec: Pick<DialogSpec, 'prefix'>, field: string) => `control:dialog.${spec.prefix}.${field}`

type EditRow = Exclude<Extract<FieldRow, { field: string }>, { kind: 'tabs' }>

/** Every editable row of `rows`, rows side by side and every tab's rows included. */
export function fieldRows(rows: readonly FieldRow[]): EditRow[] {
  return rows.flatMap((row) => (row.kind === 'row' || row.kind === 'section' ? fieldRows(row.rows) : row.kind === 'tabs' ? [...fieldRows(row.lead ?? []), ...row.tabs.flatMap((tab) => fieldRows(tab.rows))] : 'field' in row ? [row] : []))
}

/** Every tabs row of `rows`, nested ones included. */
function tabRows(rows: readonly FieldRow[]): Array<Extract<FieldRow, { kind: 'tabs' }>> {
  return rows.flatMap((row) => (row.kind === 'row' || row.kind === 'section' ? tabRows(row.rows) : row.kind === 'tabs' ? [row, ...row.tabs.flatMap((tab) => tabRows(tab.rows))] : []))
}

/** The draft after `row` is set to `value`: its `change`, or its own key. */
export function changedDraft(row: EditRow, draft: Draft, value: unknown, ctx: DialogContext): Draft {
  return row.change ? row.change(draft, value, ctx) : { ...draft, [row.field]: value }
}

/** What `row` shows for `draft`: its `value`, or the draft's own key. */
export const shownValue = (row: EditRow, draft: Draft, ctx: DialogContext): unknown => (row.value ? row.value(draft, ctx) : draft[row.field])

/**
 * Upstream's ids a layout field stands for: its own list, or `<upstream>.<field>` (`.{}` for each
 * of a radio's options; `<upstream>.<item>.{}` for a checklist's boxes).
 */
export function upstreamIds(spec: DialogSpec, row: EditRow): readonly string[] {
  if (row.upstream) return row.upstream
  const prefix = spec.upstream ?? '{}'
  if (row.kind === 'checklist') return [`${prefix}.${row.item}.{}`]
  return [`${prefix}.${row.field}${row.kind === 'radio' ? '.{}' : ''}`]
}

/** A radio option's id: `control:dialog.<prefix>.<field>.<value>`. */
export const optionId = (spec: Pick<DialogSpec, 'prefix'>, field: string, value: string) => `${fieldId(spec, field)}.${value}`

/** The options a declaration lists for a radio: its fixed ones, or those it offers with no draft and no document. */
const declaredOptions = (options: FieldOptions) => (typeof options === 'function' ? options({}, { film: null, session: null, params: {}, query: async () => null }) : options)

/**
 * The Kit UI ids `registry`'s dialogs draw (for `filmUi.ts`): each with its label and the upstream
 * ids it stands for. An id two dialogs draw (the shared buttons) is listed once.
 */
export function dialogDeclarations(registry: { specs: readonly DialogSpec[] }) {
  const items = new Map<string, { label: string; upstream: Set<string> }>()
  const add = (id: string, label: string, upstream: readonly string[]) => {
    const item = items.get(id) ?? { label, upstream: new Set<string>() }
    for (const each of upstream) item.upstream.add(each)
    items.set(id, item)
  }
  add(DIALOG_BUTTONS.ok, 'OK', ['{}.ok'])
  add(DIALOG_BUTTONS.cancel, 'Cancel', ['{}.cancel'])
  for (const spec of registry.specs) {
    if (!spec.buttons) continue
    add(DIALOG_BUTTONS.ok, 'OK', [spec.buttons.ok])
    add(DIALOG_BUTTONS.cancel, 'Cancel', [spec.buttons.cancel])
  }
  add(DIALOG_BUTTONS.preview, 'Preview', [])
  add(DIALOG_BUTTONS.play, 'Play', [])
  for (const spec of registry.specs) {
    for (const row of tabRows(spec.layout ?? [])) for (const tab of row.tabs) add(fieldId(spec, `${row.field}.${tab.id}`), tab.label, [row.upstream ? row.upstream(tab.id) : `${spec.upstream ?? '{}'}.${row.field}.${tab.id}`])
    for (const row of fieldRows(spec.layout ?? [])) {
      if (row.kind === 'radio') for (const [value, label] of declaredOptions(row.options)) add(optionId(spec, row.field, value), label, row.optionUpstream ? row.optionUpstream(value) : upstreamIds(spec, row))
      else if (row.kind === 'checklist') add(fieldId(spec, row.item), row.label, upstreamIds(spec, row))
      else add(fieldId(spec, row.field), row.label, upstreamIds(spec, row))
    }
    for (const control of spec.controls ?? []) add(fieldId(spec, control.field), control.label, control.upstream)
  }
  return [...items].map(([id, { label, upstream }]) => ({ id, label, upstream: [...upstream] }))
}

/** Film's dialogs. Each dialog task adds its family's (Tasks 11–19, 22). */
export const DIALOGS = createRegistry([...CLIP_DIALOGS, ...CLIP_STRUCTURE_DIALOGS, ...SEQUENCE_DIALOGS, ...TRACKS_DIALOGS, ...FIND_DIALOGS, ...MENU_DIALOGS, ...MEDIA_DIALOGS, ...PROJECT_DIALOGS, ...HELP_DIALOGS])

/**
 * "…" rows upstream runs at once, with no dialog: `project.rs` `NEW_ITEMS` sends the new items with
 * `{}` (`new_item_menu`), Add Chapter Marker has no route, and Add Submix runs `mixer.addSubmix {}`.
 * They stay direct: the menu bar runs them through `invoke` with no values, and kit-editor opens its
 * parameters dialog only for a required parameter, which the engine's converted schemas never mark.
 */
export const DIRECT_ROWS: ReadonlySet<string> = new Set(['file.newBarsAndTone', 'file.newBlackVideo', 'file.newCountingLeader', 'file.newTransparentVideo', 'file.newAdjustmentLayer', 'markers.addChapter', 'mixer.addSubmix'])

/**
 * "…" rows that reach upstream's dialogs other than through the manifest's dialog list (its
 * `dialogs`: `invoke`'s own, `clip_dialogs` `meta`, `menu_dialogs` `dialog_command`, the media
 * and graphics template dialogs): another module's dialog, a file picker (the host's on the web),
 * or an inline field. By command, the upstream path.
 */
export const OTHER_PATHS: Readonly<Record<string, string>> = {
  'clip.synchronize': 'multicam.rs show_dialog',
  'clip.mergeClips': 'multicam.rs show_dialog',
  'clip.createMulticam': 'multicam.rs show_dialog',
  'clip.rename': "project.rs: the Project panel's inline rename",
  'view.addGuide': 'monitor_view.rs dialogs',
  'view.guideTemplates.save': 'monitor_view.rs dialogs',
  'view.guideTemplates.manage': 'monitor_view.rs dialogs',
  'captions.newTrack': "text.rs: the Text panel's caption track formats",
  'captions.export': 'lib.rs file_dialog: a file picker',
  'file.mediaPropertiesFile': 'menu_dialogs.rs: a file picker, then Properties',
  // Not upstream's: the plan's marker dialog (Premiere's Marker dialog over the engine's
  // markers.edit) on a Markers row's double-click, where upstream's panel opens none.
  'markers.edit': "Kition's marker dialog (Premiere's): a Markers row's double-click",
  'media.attachProxies': 'media_dialogs.rs: a file picker',
  'projectPanel.metadataDisplay': 'project.rs route: project_dialogs.rs metadata_display',
  'projectPanel.saveViewPresetAs': 'project.rs route: project_dialogs.rs Save As New View Preset',
  'projectPanel.manageViewPresets': 'project.rs route: project_dialogs.rs manage_presets',
  'projectPanel.freeformOptions': 'project.rs route: project_dialogs.rs Freeform View Options',
  'projectPanel.saveArrangement': 'project.rs route: project_dialogs.rs Save Arrangement',
  'media.reconnectFullRes': 'media_dialogs.rs: a file picker',
  'graphics.newFromFile': 'lib.rs file_dialog: a file picker',
  'file.import': 'lib.rs file_dialog: a file picker (the host picks on the web)',
  'file.exportMedia': 'Export mode (Kition runs its MP4 export)',
  'window.workspace.saveAs': 'workspaces.rs dialogs',
  'window.workspace.edit': 'workspaces.rs dialogs',
}

/**
 * The lines the preview strip shows from answers (`resultLines`) or a refusal: the open
 * preview's answer, else the refusal the last draft got (`quietError`: Find's "no matches", Link
 * Media's mismatch), else what OK answered last (a dialog that stays open).
 */
export function stripResults(spec: Pick<DialogSpec, 'resultLines'>, shown: { open: boolean; result: unknown; quiet: string | null; answered: { result: unknown } | null }, t: (key: string, values?: Record<string, string | number>) => string): string[] {
  if (shown.open) return spec.resultLines ? spec.resultLines(shown.result, t) : []
  if (shown.quiet) return [shown.quiet]
  return spec.resultLines && shown.answered ? spec.resultLines(shown.answered.result, t) : []
}

/** Whether the strip shows for its own lines, whatever the panels draw: an item it draws, answers it lists, or a refusal to show. */
export const stripHasLines = (spec: Pick<DialogSpec, 'resultLines' | 'stripItem'>, quiet: string | null) => spec.stripItem != null || spec.resultLines != null || quiet != null

/** The strip lines of `spec`'s view preview (`viewLines`), given what the panels on screen draw. */
export function viewLinesFor(spec: Pick<DialogSpec, 'viewLines' | 'viewDrawer'>, draft: Draft, ctx: DialogContext, t: (key: string, values?: Record<string, string | number>) => string, phrase: (text: string) => string, drawn: (drawer: PreviewDrawer) => boolean): string[] {
  return spec.viewLines ? spec.viewLines(draft, ctx, t, phrase, drawn(spec.viewDrawer ?? 'project:view')) : []
}

/**
 * The reads a dialog makes of state no revision follows (`viewRebase`), against an OK in flight,
 * which owns the draft: no read starts while OK runs (`read` answers null), and one in flight as
 * OK starts or ends is no longer `current`, so its answer is dropped.
 */
export function createReadGuard() {
  let token = 0
  let running = false
  return {
    okStart() {
      running = true
      token += 1
    },
    okEnd() {
      running = false
      token += 1
    },
    read: () => (running ? null : ++token),
    current: (read: number | null) => read != null && read === token,
  }
}
