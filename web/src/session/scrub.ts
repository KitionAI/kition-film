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
  /**
   * Tells the engine how the Program monitor moves: `scrub` lets its pictures be approximate
   * (the nearest earlier frame a decoder has on its way to the wanted one, when that one takes
   * longer than a short budget), `still` makes every picture exact again.
   */
  motion: (motion: 'scrub' | 'still') => Promise<unknown>
  /** Whether the last picture the engine rendered was exact (a scrub's may not be). */
  exact: () => Promise<boolean>
  /** Shows the playhead at `seconds` at once (null: the scrub ended), ahead of the engine. */
  show: (seconds: number | null) => void
  /** A drag began (true) or the scrub ended (false): pictures render at the playback resolution meanwhile. */
  dragging: (on: boolean) => void
}

/** At most this many pictures of one position while it is approximate (each decodes a little further). */
const REFINES = 400

/**
 * A scrub of the program playhead. The timecode and the playhead line move with the pointer at
 * once (`show`). The engine gets the latest position only, one seek in flight, and every seek's
 * picture is rendered and lands: a seek never throws away a picture still decoding, which used to
 * leave the monitor frozen until the pointer stopped (each render was dropped by the next seek's
 * refresh after it had paid for the decode).
 *
 * While it lasts the engine may answer an approximate picture (`motion('scrub')`): the frame on
 * its way to the wanted one when that one is far from a keyframe. While the pointer rests on a
 * position the picture is asked for again, each time decoding further, until it is exact; a new
 * position wins over that. A drag renders at the playback resolution (`dragging`). Its end sets
 * the engine back to exact pictures and renders the exact frame where it stopped.
 */
export function createScrub(deps: ScrubDeps) {
  let wanted: number | null = null
  let running = false
  let scrubbing = false
  let dragged = false
  let ending = false
  const begin = () => {
    if (scrubbing) return
    scrubbing = true
    void deps.motion('scrub').catch(() => undefined)
  }
  const finish = () => {
    ending = false
    scrubbing = false
    // Exact from now on: the picture where the scrub stopped is rendered again exactly (the
    // engine's last exact picture of that state is answered without rendering again).
    void deps.motion('still').catch(() => undefined)
    void deps.paint()
    deps.show(null)
    if (dragged) {
      dragged = false
      deps.dragging(false)
    }
  }
  const exact = () => deps.exact().catch(() => true)
  const pump = async () => {
    if (running) return
    running = true
    try {
      let approximate = false
      let refines = 0
      for (;;) {
        if (wanted != null) {
          const next = wanted
          wanted = null
          refines = 0
          try {
            await deps.seek(next)
          } catch {
            // The playhead stays where the engine left it.
          }
        } else if (!approximate || ending || refines >= REFINES) break
        else refines += 1
        await deps.paint()
        approximate = !(await exact())
      }
    } finally {
      running = false
    }
    if (ending) finish()
  }
  const go = (seconds: number) => {
    begin()
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
    active: () => running || scrubbing || dragged || ending,
  }
}

export type Scrub = ReturnType<typeof createScrub>
