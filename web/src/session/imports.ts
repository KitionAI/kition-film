/**
 * Importing several files in one go (plan "Film usable by hand", phase 6, C1 and C2), pure so
 * `node --test` runs it: what one `file.import` of many paths did, as one status message in the
 * person's language, with each file that did not come in named with why.
 *
 * The engine imports every path it can and answers `{ items, errors }`, each error
 * `<path>: <reason>`; when none comes in it refuses with the errors joined by `; `.
 */

type Strings = (key: string, values?: Record<string, string | number>) => string

/** Why a file did not come in, as a person can act on it. */
export type ImportFailure = { name: string; reason: 'missing' | 'format' | 'damaged' | 'unwritten' }
export type ImportReport = { imported: number; items: number[]; failures: ImportFailure[] }

/** A path's last segment (`../clips/a.mp4` → `a.mp4`). */
export const fileName = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path

/** The engine's reason, as one of those a person meets (`unwritten`: the host would not keep a dropped file). */
export function failureReason(text: string): Exclude<ImportFailure['reason'], 'unwritten'> {
  if (/offline|not found|no such file|missing|not-allowed|not allowed|404|could not read the file|cannot be read from the host/i.test(text)) return 'missing'
  if (/unsupported|not supported|unknown (?:format|container|file)|not a (?:media|supported|recognized)|unrecognized|cannot import|no importable|no video or audio/i.test(text)) return 'format'
  return 'damaged'
}

/**
 * Each requested path's failure in `text` (the errors, `<path>: <reason>`, joined by `; `, maybe
 * behind words of the engine's), named by the file; a path the text does not name has none.
 */
function failuresOf(paths: readonly string[], text: string): ImportFailure[] {
  const found = paths
    .map((path) => ({ path, at: text.indexOf(`${path}: `) }))
    .filter((each) => each.at >= 0)
    .sort((a, b) => a.at - b.at)
  return found.map((each, index) => {
    const end = index + 1 < found.length ? found[index + 1].at : text.length
    return { name: fileName(each.path), reason: failureReason(text.slice(each.at + each.path.length + 2, end)) }
  })
}

/** What `file.import` of `paths` did: its answer, or the text of its refusal. */
export function importReport(paths: readonly string[], answer: { items?: number[]; errors?: string[] } | null, refusal: string | null): ImportReport {
  if (refusal != null) {
    // A refusal naming no file is every file's.
    const failures = failuresOf(paths, refusal)
    return { imported: 0, items: [], failures: failures.length ? failures : paths.map((path) => ({ name: fileName(path), reason: failureReason(refusal) })) }
  }
  const items = answer?.items ?? []
  return { imported: items.length, items, failures: failuresOf(paths, (answer?.errors ?? []).join('; ')) }
}

/**
 * The status bar's one message: "Imported 3 files", and the files that did not come in, each
 * with its reason. `error` is whether it is shown as an error (some file did not come in).
 */
export function importMessage(report: ImportReport, t: Strings): { text: string; error: boolean } {
  const failed = report.failures.map((failure) => t('import.failure', { name: failure.name, reason: t(`import.reason.${failure.reason}`) })).join(t('import.separator'))
  if (!report.failures.length) return { text: t('import.done', { count: report.imported }), error: false }
  if (!report.imported) return { text: t('import.none', { failures: failed }), error: true }
  return { text: t('import.some', { count: report.imported, failures: failed }), error: true }
}
