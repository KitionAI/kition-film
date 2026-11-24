// Pure, so `node --test` runs it.

/**
 * What a scrub of the program playhead (the timeline's ruler and timecode, the Program monitor's
 * scrub bar) needs from the editor.
 */
export type ScrubDeps = {
  /**
   * Moves the engine's playhead to `seconds` and brings the editor's model up to date without
   * dropping the picture the canvas is rendering (a refresh whose damage is empty).
   */
  seek: (seconds: number) => Promise<unknown>
  /**
   * Renders the Program canvas at the engine's playhead, keeping a render in flight: one asked
   * for meanwhile runs once that one has landed (`KitCanvasHandle.retryRender`).
   */
  paint: () => Promise<unknown>
  /** Shows the playhead at `seconds` at once (null: the scrub ended), ahead of the engine. */
  show: (seconds: number | null) => void
  /** A drag began (true) or the scrub ended (false): pictures render at the playback resolution meanwhile. */
  dragging: (on: boolean) => void
}

/**
 * A scrub of the program playhead. The timecode and the playhead line move with the pointer at
 * once (`show`). The engine gets the latest position only, one seek in flight, and every seek's
 * picture is rendered and lands: a seek never throws away a picture still decoding, which used to
 * leave the monitor frozen until the pointer stopped (each render was dropped by the next seek's
 * refresh after it had paid for the decode). A drag renders at the playback resolution
 * (`dragging`); its end goes back to the paused one, which renders the exact frame where it stopped.
 */
export function createScrub(deps: ScrubDeps) {
  let wanted: number | null = null
  let running = false
  let dragged = false
  let ending = false
  const finish = () => {
    ending = false
    deps.show(null)
    if (dragged) {
      dragged = false
      deps.dragging(false)
    }
  }
  const pump = async () => {
    if (running) return
    running = true
    try {
      while (wanted != null) {
        const next = wanted
        wanted = null
        try {
          await deps.seek(next)
        } catch {
          // The playhead stays where the engine left it.
        }
        // Not awaited: the next seek queues behind this render in the engine and lands after it.
        void deps.paint()
      }
    } finally {
      running = false
    }
    if (ending) finish()
  }
  const go = (seconds: number) => {
    wanted = Math.max(0, seconds)
    deps.show(wanted)
    void pump()
  }
  return {
    /** A press (or a typed time): the playhead goes to `seconds`. */
    start(seconds: number) {
      ending = false
      go(seconds)
    },
    /** The pointer moved with the button held. */
    move(seconds: number) {
      ending = false
      if (!dragged) {
        dragged = true
        deps.dragging(true)
      }
      go(seconds)
    },
    /** The release (or a typed time committed): the last position, then the scrub ends once the engine has it. */
    end(seconds: number) {
      ending = true
      go(seconds)
    },
    /** An interrupted scrub ends where the engine has the playhead, with no further seek. */
    cancel() {
      wanted = null
      ending = true
      if (!running) finish()
    },
    /** Whether a scrub is in progress (between `start` and the engine having its `end`). */
    active: () => running || dragged || ending,
  }
}

export type Scrub = ReturnType<typeof createScrub>
