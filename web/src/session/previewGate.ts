// What may run while a dialog's preview is open (Task 10's review). Upstream's dialogs are modal;
// Film's preview dialogs are non-modal only so the playhead can be scrubbed and the document
// looked at, so while a preview is open the document is not editable: the playhead, transport,
// selection, view, and panel focus run, and the open dialog's own commands. One place, the
// session's `run` (`useFilmSession`), refuses the rest, whatever asked (a key, a menu, a panel).
// Imports carry `.ts` so `node --test` loads this module as it is.

/** Command families that only move the playhead, play, or change the view. */
const VIEW_GROUPS = new Set(['playhead', 'playback', 'transport', 'view', 'help', 'window', 'mode', 'tool'])

/** Single commands that only navigate, select, or change what is shown (session state, not the document's). */
const VIEW_IDS = new Set([
  'source.open',
  'source.setPlayhead',
  'source.inspect',
  'sequence.open',
  'sequence.revealInProject',
  'sequence.revealNested',
  'sequence.matchFrame',
  'sequence.snap',
  'sequence.linkedSelection',
  'sequence.nestSequences',
  'sequence.showThroughEdits',
  'edit.find',
  'edit.findNext',
  'marker.filterColors',
  'project.view.set',
  'project.sort',
  'project.columns.resize',
])

const VIEW_PREFIXES = ['source.playback.', 'markers.go']

/** A command that selects (`timeline.select`, `project.select`, `edit.selectAll`, `edit.deselectAll`, `trim.selectEditPoint`). */
const selects = (id: string) => /^(select|deselect)/.test(id.split('.').at(-1) ?? '')

/** Whether `id` may run while a preview is open: a query (`journaled` false) or a playhead, transport, selection, or view command. */
export function previewAllows(id: string, journaled: boolean | null): boolean {
  if (journaled === false) return true
  if (VIEW_GROUPS.has(id.split('.')[0] ?? '')) return true
  return VIEW_IDS.has(id) || VIEW_PREFIXES.some((prefix) => id.startsWith(prefix)) || selects(id)
}

export type PreviewGate = { refusal: (id: string) => string | null }

/**
 * The gate the session's `run` asks: `message` while a preview is `open` and `id` is an edit the
 * open dialog does not run itself (`own`: its command and steps, so a dialog that keeps its preview
 * open, Find, still runs its OK), or a command it blocks (`blocked`: a view command while the
 * Project panel's view preferences preview); null otherwise.
 */
export function createPreviewGate({ open, own, blocked = () => NONE, journaled, message }: { open: () => boolean; own: () => ReadonlySet<string>; blocked?: () => ReadonlySet<string>; journaled: (id: string) => boolean | null; message: string }): PreviewGate {
  return {
    refusal(id) {
      if (!open()) return null
      // The open dialog's preview shows a view the strip names and OK captures (`previewBlocks`): nothing changes it meanwhile.
      if (blocked().has(id)) return message
      if (own().has(id) || previewAllows(id, journaled(id))) return null
      return message
    },
  }
}

const NONE: ReadonlySet<string> = new Set()
