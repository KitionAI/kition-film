/**
 * The engine's events (the `takeEvents` extra), as upstream's frame loop handles them (`lib.rs`
 * `drain_events`): `OpenSequence` restores the Timeline and brings it forward, `OpenSource`
 * brings the Source monitor forward where it is docked, `RevealInProject` shows the item in the
 * Project panel, and a `Toast` is shown. Pure, so `node --test` runs it.
 */

export type EngineEvent =
  | { kind: 'toast'; message: string; error: boolean }
  | { kind: 'openSequence'; item: number }
  | { kind: 'openSource'; item: number }
  | { kind: 'revealInProject'; item: number }

export type EventHandlers = {
  /** Shows a toast (kit-editor's `toast`). */
  toast: (level: 'info' | 'error', message: string) => void
  /** Restores the Timeline if it was closed and brings it forward (upstream `restore_timeline`, `activate`). */
  showTimeline: () => void
  /** Brings a docked panel forward, without opening it (upstream `dock.activate`). */
  activate: (panel: string) => void
  /** Shows the item in the Project panel (upstream `reveal_in_project`). */
  reveal: (item: number) => void
}

/** Parses `takeEvents`' answer; anything that is not an event is left out. */
export function parseEvents(answer: string): EngineEvent[] {
  let raw: unknown
  try {
    raw = JSON.parse(answer)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.filter((event): event is EngineEvent => {
    if (!event || typeof event !== 'object') return false
    const { kind } = event as { kind?: unknown }
    if (kind === 'toast') return typeof (event as { message?: unknown }).message === 'string'
    return (kind === 'openSequence' || kind === 'openSource' || kind === 'revealInProject') && typeof (event as { item?: unknown }).item === 'number'
  })
}

/** Handles `events` in order. */
export function applyEvents(events: readonly EngineEvent[], handlers: EventHandlers) {
  for (const event of events) {
    switch (event.kind) {
      case 'toast':
        handlers.toast(event.error ? 'error' : 'info', event.message)
        break
      case 'openSequence':
        handlers.showTimeline()
        break
      case 'openSource':
        handlers.activate('source')
        break
      case 'revealInProject':
        handlers.reveal(event.item)
        break
    }
  }
}
