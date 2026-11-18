import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { oneInFlight, type Phrases } from '@kition/kit-editor'
import type { InvokeOptions } from '../session/invoke'
import { createHistoryStepper, historyRows, type HistoryList, type HistoryRow } from './history'

export type HistoryPanelProps = {
  /** The engine's revision: the list is read again when it moves, and only while the panel is shown. */
  revision: number | null
  query: (id: string, params?: Record<string, unknown>) => Promise<unknown>
  invoke: (id: string, params?: Record<string, unknown>, options?: InvokeOptions) => Promise<unknown>
  phrase: Phrases
}

type RowProps = { row: HistoryRow; index: number; phrase: Phrases; onStep: (target: number) => void }

const Row = memo(function Row({ row, index, phrase, onStep }: RowProps) {
  return (
    <button
      type="button"
      className="film-history-row"
      aria-current={row.current ? 'step' : undefined}
      data-undone={row.undone ? 'true' : undefined}
      data-kit-ui-id="control:history.row"
      data-testid={`film-history-row-${index}`}
      onClick={() => onStep(row.target)}
    >
      {phrase(row.label)}
    </button>
  )
})

/**
 * History (upstream `misc.rs` `history`): Open, then the undo steps (the last is current), then
 * the undone steps, faint. A click undoes or redoes to that step, one `edit.undo` or `edit.redo`
 * per step as upstream; the editor refreshes once, after the last (see `createHistoryStepper`). Left and Right undo and redo
 * while it has focus (the engine's History table binds them).
 */
export function HistoryPanel({ revision, query, invoke, phrase }: HistoryPanelProps) {
  const [list, setList] = useState<HistoryList | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const read = useMemo(
    () =>
      oneInFlight(async () => {
        const answer = (await query('history.list')) as HistoryList | null
        if (mounted.current && answer) setList({ undo: answer.undo ?? [], redo: answer.redo ?? [] })
      }),
    [query],
  )
  useEffect(() => {
    void read()
  }, [read, revision])
  // A click walks to its row from the list as it is then (`createHistoryStepper`): a click while
  // one walks is ignored, the steps refresh nothing, and the editor refreshes once at the end
  // (through a `history.list` run, which refreshes everything), even when a step failed.
  const stepper = useMemo(
    () =>
      createHistoryStepper({
        read: async () => {
          const answer = (await query('history.list')) as HistoryList | null
          return answer ? { undo: answer.undo ?? [], redo: answer.redo ?? [] } : null
        },
        step: (command) => invoke(command, {}, { refresh: 'none' }),
        refresh: () => invoke('history.list', {}),
      }),
    [invoke, query],
  )
  const onStep = useCallback(
    (target: number) => {
      void stepper.goTo(target).then(() => read())
    },
    [stepper, read],
  )
  const rows = useMemo(() => (list ? historyRows(list) : []), [list])
  return (
    <div className="film-history" data-testid="film-history">
      {/* Keyed by place, so a row keeps its element (and the focus, for Left and Right) when its step is undone. */}
      {rows.map((row, index) => (
        <Row key={index} row={row} index={index} phrase={phrase} onStep={onStep} />
      ))}
    </div>
  )
}
