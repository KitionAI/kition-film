// The read-only engine extras a dialog may call while it drafts (`DialogContext.read`). Imports
// carry `.ts` so `node --test` loads this module as it is.

/** The extras a dialog's `defaults` may read; anything else (an extra that changes state) is refused. */
export const DIALOG_EXTRAS: ReadonlySet<string> = new Set(['dialogDefaults'])

type Engine = { invoke: (name: string, ...args: unknown[]) => Promise<unknown> }

/**
 * `DialogContext.read` on the document `doc()` answers: an allowed extra's answer, its JSON
 * parsed; null for another extra, with no document, or when it fails.
 */
export function createReadExtra(doc: () => Engine | null) {
  return async (name: string, ...args: unknown[]): Promise<unknown> => {
    const on = doc()
    if (!on || !DIALOG_EXTRAS.has(name)) return null
    const raw = await on.invoke(name, ...args).catch(() => null)
    if (typeof raw !== 'string') return raw ?? null
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return null
    }
  }
}
