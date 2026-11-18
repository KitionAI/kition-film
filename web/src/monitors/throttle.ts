// Pure, so `node --test` runs it.

/**
 * A live readout's sender (rule 8: throttled to animation frames, never debounced): values asked
 * for between two frames send once, the latest, at the next frame; and while one is in flight the
 * next waits for it, so a slow engine drops values rather than queueing them. `flush` sends the
 * latest at once (after the one in flight): a scrub's release or a typed time.
 */
export function frameLatest<T>(send: (value: T) => Promise<unknown>, frame: (callback: () => void) => () => void) {
  let wanted: { value: T } | null = null
  let running = false
  let cancel: (() => void) | null = null
  const pump = async () => {
    while (wanted) {
      const { value } = wanted
      wanted = null
      running = true
      try {
        await send(value)
      } catch {
        // The engine keeps what it had; the next value tries again.
      } finally {
        running = false
      }
    }
  }
  const schedule = () => {
    if (cancel || running) return
    cancel = frame(() => {
      cancel = null
      void pump()
    })
  }
  const ask = (value: T) => {
    wanted = { value }
    schedule()
  }
  ask.flush = (value: T) => {
    wanted = { value }
    cancel?.()
    cancel = null
    if (!running) void pump()
  }
  ask.cancel = () => {
    wanted = null
    cancel?.()
    cancel = null
  }
  return ask
}

/** `frameLatest` on the browser's animation frames. */
export function animationFrameLatest<T>(send: (value: T) => Promise<unknown>) {
  return frameLatest(send, (callback) => {
    const id = requestAnimationFrame(callback)
    return () => cancelAnimationFrame(id)
  })
}
