// The document's background jobs on the web: the WebAssembly engine has no threads, so Scene Edit
// Detection runs a step at a time (`Session::step_jobs`), and the editor advances it as upstream's
// frame loop does (`jobsStep`: `pump_jobs`, then `poll_persistence`, which applies a finished
// job's result as its own history step, recorded in the replica). React-free, so `node --test`
// drives it. Imports carry `.ts` so `node --test` loads this module as it is.

/** The newest unfinished job, as `job.list` shows one (upstream's status bar job). */
export type RunningJob = { id: number; label: string; progress: number; etaSeconds: number | null }
/** `jobsStep`'s answer. */
export type JobAnswer = { pending?: boolean; revision?: number | null; job?: RunningJob | null }

type Schedule = (task: () => void) => () => void

/**
 * One loop per document: `kick` (after a command, a refresh) asks `step` on the next animation
 * frame, and again each frame while work is left; it shows the running job (`onJob`, null once
 * none runs) and, when the engine's revision moved past the editor's (`revision`), refreshes the
 * editor once (`onChanged`). `reset` (another document) drops what is in flight.
 */
export function createJobPump({ step, schedule, revision, onJob, onChanged }: { step: () => Promise<JobAnswer | null>; schedule: Schedule; revision: () => number | null; onJob: (job: RunningJob | null) => void; onChanged: () => void }) {
  let running = false
  let generation = 0
  let cancel: (() => void) | null = null
  /** The revision the last refresh was asked for, so a slow refresh is not asked again. */
  let refreshedFor: number | null = null
  const tick = async (mine: number) => {
    cancel = null
    let answer: JobAnswer | null = null
    try {
      answer = await step()
    } catch {
      answer = null
    }
    if (mine !== generation) return
    onJob(answer?.job ?? null)
    const now = answer?.revision ?? null
    if (now != null && now !== revision() && now !== refreshedFor) {
      refreshedFor = now
      onChanged()
    }
    if (answer?.pending) cancel = schedule(() => void tick(mine))
    else running = false
  }
  return {
    kick() {
      if (running) return
      running = true
      const mine = generation
      cancel = schedule(() => void tick(mine))
    },
    reset() {
      generation += 1
      cancel?.()
      cancel = null
      running = false
      refreshedFor = null
      onJob(null)
    },
  }
}

/** What upstream's status bar says of the running job (`job_status`): its label for a render, else "Exporting", and its fraction. */
export function jobStatus(job: RunningJob, phrase: (text: string) => string) {
  return { verb: job.label.startsWith('Rendering') ? phrase(job.label) : phrase('Exporting'), fraction: Math.min(1, Math.max(0, job.progress)), secondsLeft: job.etaSeconds }
}
