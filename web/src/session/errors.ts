// Imports carry `.ts` so `node --test` loads this module as it is.
import type { Phrases } from '@kition/sdk/editor'

type Strings = (key: string, values?: Record<string, string | number>) => string

/**
 * The engine's reasons a person meets in the core flow (select, trim, cut, ripple delete, play,
 * export), each a label of the Chinese catalog (`i18n/upstream/zh-hans.tsv`, registered in
 * `parity/i18n.mjs` LABEL_TABLES so the parity check finds them): `personMessage` translates them
 * wherever they appear in an engine error.
 */
export const ENGINE_REASONS: ReadonlyArray<{ reason: string }> = [
  { reason: 'nothing selected' },
  { reason: 'no clips selected' },
  { reason: 'no edit points selected' },
  { reason: 'no edit point at the playhead on targeted tracks' },
  { reason: 'no edit point on the targeted tracks' },
  { reason: 'no sequence is open' },
  { reason: 'no active sequence' },
  { reason: 'track is locked' },
  { reason: 'nothing to undo' },
  { reason: 'nothing to redo' },
  { reason: 'clipboard is empty' },
  { reason: 'mark an In or Out point first' },
  { reason: 'select an item in the Project panel' },
  { reason: 'no clip in the Source monitor' },
  { reason: 'not enough media (handles) for this trim' },
  { reason: 'edit would make a clip shorter than one frame' },
  { reason: 'nothing to do' },
  { reason: 'select a clip' },
  { reason: 'select clips' },
  { reason: 'select a clip with audio' },
  { reason: 'select nested sequence or multi-camera clips' },
  { reason: 'select multi-camera clips to flatten' },
  { reason: "the clip's media is offline" },
  { reason: 'the media is offline' },
  // Refusals the editor itself throws in English, shown the same way.
  { reason: 'select an item or bin to rename' },
  { reason: 'Open a Source clip first' },
]

/** `EngineError::Disabled`: the command is not enabled now, and why. */
const DISABLED = /^command `[^`]+` is not available right now: ([\s\S]+)$/
/** `EngineError::BadParams`: the command refused its parameters, and why. */
const BAD_PARAMS = /^invalid parameters for `[^`]+`: ([\s\S]+)$/
/** `EngineError::Edit`: the timeline edit refused, and why. */
const EDIT = /^edit failed: ([\s\S]+)$/
/** `EditError::SyncLockConflict`: the track whose clip a ripple would push out of sync. */
const SYNC = /^this edit would break sync: (.+?) is sync-locked and has a clip in the way\b/
/** `MediaError::Offline` (behind `EngineError::Media`'s `media: `). */
const OFFLINE = /^(?:media: )?media offline: ([\s\S]+)$/

/** One reason in the person's words: the sync-lock and offline patterns, else the catalog's translation (as it is when it has none). */
function reasonText(reason: string, t: Strings, phrase: Phrases): string {
  const text = reason.trim()
  const sync = SYNC.exec(text)
  if (sync) return t('error.syncLock', { track: sync[1] })
  const offline = OFFLINE.exec(text)
  if (offline) return t('error.mediaOffline', { path: offline[1] })
  return phrase(text)
}

/**
 * An engine or editor error as the status bar shows it to a person (`errorStatus`): the engine's
 * "command `x` is not available right now: <reason>", "invalid parameters for `x`: <reason>" and
 * "edit failed: <reason>" become one sentence in the person's language that never names the
 * command id, with the reason translated by the catalog (`ENGINE_REASONS`); a sync-lock refusal
 * says which track header to change; anything else is translated when the catalog has it and
 * shown as it is otherwise.
 */
export function personMessage(text: string, t: Strings, phrase: Phrases): string {
  const disabled = DISABLED.exec(text)
  if (disabled) return t('error.notNow', { reason: reasonText(disabled[1], t, phrase) })
  const bad = BAD_PARAMS.exec(text)
  if (bad) return t('error.cannot', { reason: reasonText(bad[1], t, phrase) })
  const edit = EDIT.exec(text)
  if (edit) {
    const reason = edit[1].trim()
    // The sync-lock refusal is a whole sentence of its own.
    return SYNC.test(reason) ? reasonText(reason, t, phrase) : t('error.editRefused', { reason: reasonText(reason, t, phrase) })
  }
  return reasonText(text, t, phrase)
}
