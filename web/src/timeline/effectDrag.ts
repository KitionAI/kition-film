import type { EffectPayload } from '../panels/effectsTree.ts'

/**
 * A drag of an effect, a transition, or a preset from the Effects panel (upstream
 * `start_drag_effect`, `dragged_effect`): the HTML drag carries this type, and the payload is kept
 * here too, since a page cannot read a drag's data until the drop. The Timeline and Effect
 * Controls take it.
 */
export const EFFECT_DRAG_TYPE = 'application/x-kition-film-effect'

let current: EffectPayload | null = null

/** Starts a drag of `payload` from `event` (the Effects panel row's `dragstart`). */
export function startEffectDrag(event: DragEvent, payload: EffectPayload) {
  current = payload
  event.dataTransfer?.setData(EFFECT_DRAG_TYPE, JSON.stringify(payload))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

/** The effect being dragged, or null; with the drop's data when the page's own copy is gone. */
export function effectDrag(data?: DataTransfer | null): EffectPayload | null {
  if (current) return current
  const raw = data?.getData(EFFECT_DRAG_TYPE)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<{ effect: unknown; kind: unknown; preset: unknown }>
    if (typeof value.preset === 'string') return { preset: value.preset }
    if (typeof value.effect === 'string' && typeof value.kind === 'string' && ['Video', 'Audio', 'VideoTransition', 'AudioTransition'].includes(value.kind)) return { effect: value.effect, kind: value.kind as 'Video' }
    return null
  } catch {
    return null
  }
}

/** Whether a drag event carries an effect. */
export const carriesEffect = (data: DataTransfer | null | undefined) => !!data && [...data.types].includes(EFFECT_DRAG_TYPE)

/** The drag ended (dropped or abandoned). */
export function endEffectDrag() {
  current = null
}
