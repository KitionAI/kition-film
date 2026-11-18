/**
 * The status bar's message, as upstream's `ui.status` and `status_seen` (`lib.rs`): a message
 * shows until 8 seconds after its text was first seen, or until the bar is clicked; the same text
 * again does not start the 8 seconds over, another text does. Pure, so `node --test` runs it.
 */

export type StatusMessage = { text: string; at: number }

/** How long a message shows, in milliseconds. */
export const STATUS_MS = 8000

/** The message after `text` is said at `now`: the one shown when it says the same. */
export function nextStatus(shown: StatusMessage | null, text: string, now: number): StatusMessage {
  return shown && shown.text === text ? shown : { text, at: now }
}

/** How long `shown` still shows at `now`, in milliseconds (0: it is gone). */
export function statusLeft(shown: StatusMessage, now: number, ms = STATUS_MS) {
  return Math.max(0, shown.at + ms - now)
}
