// Imports none, so `node --test` loads this module as it is.

type Query = (id: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * `query`, with the calls of `shared` commands without params made in one turn of the page (the
 * Project panel and its floating windows reading the view for one revision or refresh) sharing one
 * request. A call made after that turn asks again, so it never takes an answer read before a
 * change it follows.
 */
export function shareTurnReads(query: Query, shared: ReadonlySet<string>): Query {
  const pending = new Map<string, Promise<unknown>>()
  return (id, params) => {
    if (!shared.has(id) || (params != null && Object.keys(params).length > 0)) return query(id, params)
    const asked = pending.get(id)
    if (asked) return asked
    const made = query(id, params)
    pending.set(id, made)
    queueMicrotask(() => pending.delete(id))
    return made
  }
}
