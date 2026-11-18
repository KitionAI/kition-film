// The floating windows' boxes for the preview drawers (a workspace panel a window covers draws
// nothing a person sees), measured only when a window can have moved: the windows' own layer
// changes (a window moved, resized, opened, or closed), the layer mounts or unmounts, the
// workspace area resizes or moves (the page resized), at most once per animation frame. Style
// writes elsewhere in the workspace (the Timeline's playhead every frame while playing, clip and
// monitor drags) measure nothing; with no window open nothing is measured at all. Imports none,
// so `node --test` loads this module as it is.

export type Box = { x: number; y: number; width: number; height: number }

/** What the watcher needs of the page, injected so a test can drive it. */
export type FloatingBoxesDeps = {
  /** The windows' layer (kit-editor's `.kui-floating-layer`, a child of the area), or null while no window is open. */
  layer: () => unknown | null
  /** The open windows' boxes in the layer. */
  boxes: (layer: unknown) => Box[]
  /** The workspace's frames now (watched for size while a window is open: a gutter drag moves a panel under a still window). */
  frames: () => unknown[]
  /** Watches `target`'s mutations: the area's children only (`childList`), or the layer's styles and children (`subtree`). */
  observeMutations: (target: unknown, options: { childList: boolean; subtree: boolean; attributes: boolean; attributeFilter?: string[] }, callback: () => void) => () => void
  /** Watches the sizes of `targets` (each change calls back); answers a function that sets the targets again, and one that stops. */
  observeSizes: (callback: () => void) => { watch: (targets: unknown[]) => void; stop: () => void }
  onWindowResize: (callback: () => void) => () => void
  frame: (callback: () => void) => () => void
  /** The windows' boxes now (the drawers tell only on a change). */
  floating: (boxes: Box[]) => void
  /** The frames under the windows may have changed: the strip checks again. */
  changed: () => void
}

/** Starts watching `area`; answers the function that stops. */
export function watchFloatingBoxes(area: unknown, deps: FloatingBoxesDeps): () => void {
  let layer: unknown | null = null
  let stopLayer: (() => void) | null = null
  let pending: (() => void) | null = null
  let framesMoved = false
  const sizes = deps.observeSizes(() => {
    framesMoved = true
    schedule()
  })
  const run = () => {
    pending = null
    const now = deps.layer()
    if (now !== layer) {
      stopLayer?.()
      stopLayer = now ? deps.observeMutations(now, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] }, schedule) : null
      layer = now
    }
    // The area and, while a window is open, its frames.
    sizes.watch(layer ? [area, ...deps.frames()] : [area])
    deps.floating(layer ? deps.boxes(layer) : [])
    if (framesMoved) {
      framesMoved = false
      if (layer) deps.changed()
    }
  }
  function schedule() {
    pending ??= deps.frame(run)
  }
  const stopArea = deps.observeMutations(area, { childList: true, subtree: false, attributes: false }, schedule)
  const stopResize = deps.onWindowResize(schedule)
  run()
  return () => {
    pending?.()
    stopLayer?.()
    stopArea()
    stopResize()
    sizes.stop()
    deps.floating([])
  }
}

/**
 * A ResizeObserver's first report of each target is the size it starts at, not a change: `watch`
 * marks a target just observed, and `moved` answers whether a batch holds a real change, clearing
 * every fresh target of the batch (one that reports later reports a real resize).
 */
export function firstSizeReports() {
  const fresh = new Set<unknown>()
  return {
    watch: (target: unknown) => void fresh.add(target),
    moved(targets: Iterable<unknown>) {
      let moved = false
      for (const target of targets) if (!fresh.delete(target)) moved = true
      return moved
    },
  }
}
