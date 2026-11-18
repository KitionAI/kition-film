import type { DropPayload } from './gestures.ts'

/**
 * A drag onto the Timeline from the Project panel or the Source monitor (upstream
 * `start_drag_source`, `dragged_project_item`): the HTML drag carries this type, and the payload
 * is kept here too, since a page cannot read a drag's data until the drop.
 */
export const FILM_DRAG_TYPE = 'application/x-kition-film-item'

let current: DropPayload | null = null
let generation = 0

/**
 * Starts a drag of `payload` (a project item, or the Source monitor's In–Out range) from `event`:
 * a drag source calls it from its `dragstart` (the Project panel, the Source monitor's
 * picture), and `endFilmDrag` from its `dragend`, so an abandoned drag is forgotten.
 */
export function startFilmDrag(event: DragEvent | { dataTransfer: DataTransfer | null }, payload: DropPayload) {
  current = payload
  event.dataTransfer?.setData(FILM_DRAG_TYPE, JSON.stringify({ ...payload, _filmDragEpoch: generation }))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

/** The drag in progress, or null; with the drop's data when the page's own copy is gone. */
export function filmDrag(data?: DataTransfer | null): DropPayload | null {
  if (current) return current
  const raw = data?.getData(FILM_DRAG_TYPE)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as DropPayload & { _filmDragEpoch?: number }
    if (value?._filmDragEpoch != null && value._filmDragEpoch !== generation) return null
    return typeof value?.item === 'number' ? value : null
  } catch {
    return null
  }
}

/** The drag ended (dropped or abandoned). */
export function endFilmDrag() {
  current = null
}

/** Invalidate both the live drag and the browser’s retained transfer data after an interruption. */
export function cancelFilmDrag() {
  generation += 1
  current = null
}
