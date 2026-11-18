// Select Find Box and Open Search (upstream `keyboard.rs` `focus_find_box`, `take_search_focus`):
// a panel's search field takes keyboard focus on the next frame it is drawn. Imports carry `.ts` so
// `node --test` loads this module as it is.

/** How long a panel just shown has to draw its search field. */
const WAIT_MS = 1000

type Field = { focus: () => void; select: () => void }

export type SearchFocusDeps = {
  /** `panel`'s search field (`[data-film-search="<panel>"]`), or null while it is not drawn. */
  find: (panel: string) => Field | null
  /** Runs `task` a moment later (by time: a hidden page runs no animation frames). */
  schedule: (task: () => void) => void
  now: () => number
  /** Listens for `type` on the page, capturing; answers the function that stops. */
  listen: (type: 'keydown' | 'pointerdown', listener: () => void) => () => void
}

/**
 * Gives `panel`'s search field focus once it is drawn, looking again for a second. A key or a
 * press elsewhere meanwhile stops the wait: focus is never pulled from where the person went
 * (lesson 2).
 */
export function createSearchFocus(deps: SearchFocusDeps) {
  return (panel: string) => {
    const until = deps.now() + WAIT_MS
    let done = false
    const stops: Array<() => void> = []
    const stop = () => {
      done = true
      for (const each of stops.splice(0)) each()
    }
    stops.push(deps.listen('keydown', stop), deps.listen('pointerdown', stop))
    const look = () => {
      if (done) return
      const field = deps.find(panel)
      if (field) {
        stop()
        field.focus()
        field.select()
      } else if (deps.now() < until) deps.schedule(look)
      else stop()
    }
    look()
  }
}

/** `createSearchFocus` on the page's document. */
export const focusPanelSearch = createSearchFocus({
  find: (panel) => document.querySelector<HTMLInputElement>(`[data-film-search="${panel}"]`),
  schedule: (task) => void window.setTimeout(task, 16),
  now: () => performance.now(),
  listen: (type, listener) => {
    window.addEventListener(type, listener, true)
    return () => window.removeEventListener(type, listener, true)
  },
})
