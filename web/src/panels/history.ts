/**
 * The History panel's rows and steps (upstream `misc.rs` `history`), pure so `node --test` runs
 * them. `history.list` answers the engine's `undo` names oldest first, the current step last, and
 * its `redo` names as a stack, the next redo last.
 */

/** What `history.list` answers. */
export type HistoryList = { undo: readonly string[]; redo: readonly string[] }

/**
 * One row: its name (`Open` for the document as opened), whether it is the current step, whether
 * it is undone (drawn faint), and its `target`, the undo stack's length once a click has gone to
 * it (Open is 0).
 */
export type HistoryRow = { label: string; current: boolean; undone: boolean; target: number }

/** Upstream's rows: Open, every undo step (the last is current), then the redo steps in the order they redo. */
export function historyRows(list: HistoryList): HistoryRow[] {
  const n = list.undo.length
  const rows: HistoryRow[] = [{ label: 'Open', current: n === 0, undone: false, target: 0 }]
  list.undo.forEach((label, index) => rows.push({ label, current: index + 1 === n, undone: false, target: index + 1 }))
  // The stack's top (its last name) is the next redo: the first row after the current step.
  ;[...list.redo].reverse().forEach((label, index) => rows.push({ label, current: false, undone: true, target: n + index + 1 }))
  return rows
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((name, index) => name === b[index])

/** The list one `edit.undo` (or `edit.redo`) makes of `list`, or null when there is nothing to undo (redo). */
function afterStep(list: HistoryList, undo: boolean): HistoryList | null {
  if (undo) return list.undo.length ? { undo: list.undo.slice(0, -1), redo: [...list.redo, list.undo[list.undo.length - 1]] } : null
  return list.redo.length ? { undo: [...list.undo, list.redo[list.redo.length - 1]], redo: list.redo.slice(0, -1) } : null
}

export type HistoryStepperDeps = {
  /** Reads `history.list` now. */
  read: () => Promise<HistoryList | null>
  /** Runs `edit.undo` or `edit.redo` without refreshing the editor. */
  step: (command: 'edit.undo' | 'edit.redo') => Promise<unknown>
  /** Refreshes the editor once, after a click's steps (whether or not they all ran). */
  refresh: () => Promise<unknown>
}

/**
 * Goes to a History row as upstream's click does, by repeated `undo` or `redo`. The steps are
 * counted from the list as it is read when they start, not from what the row showed: each step
 * must move the list by exactly that step, so an edit or undo from elsewhere (the agent, a key)
 * stops the walk rather than being undone. A click while a walk runs is ignored (a double-click
 * goes once). The editor refreshes once at the end, even when a step failed.
 */
export function createHistoryStepper(deps: HistoryStepperDeps) {
  let busy = false
  return {
    get busy() {
      return busy
    },
    /** Walks to the row whose undo stack is `target` long; false when a walk was already running. */
    async goTo(target: number): Promise<boolean> {
      if (busy) return false
      busy = true
      try {
        let list = await deps.read()
        while (list && list.undo.length !== target) {
          const undo = target < list.undo.length
          const want = afterStep(list, undo)
          if (!want) break
          await deps.step(undo ? 'edit.undo' : 'edit.redo')
          const now = await deps.read()
          if (!now || !same(now.undo, want.undo) || !same(now.redo, want.redo)) break
          list = now
        }
      } catch {
        // A failed read or step ends the walk where it got to.
      } finally {
        busy = false
        await deps.refresh().catch(() => undefined)
      }
      return true
    },
  }
}
