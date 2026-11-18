// The document's background jobs on the web (Task 16 review): a host without threads steps Scene
// Edit Detection, and the editor advances it each animation frame (`jobsStep`) while work is left,
// shows the running job, and refreshes once its result moved the revision.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createJobPump, jobStatus } from './jobPump.ts'

function frames() {
  let tasks = []
  return {
    schedule: (task) => {
      tasks.push(task)
      return () => {
        tasks = tasks.filter((each) => each !== task)
      }
    },
    count: () => tasks.length,
    run: async () => {
      const now = tasks
      tasks = []
      for (const task of now) task()
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    },
  }
}

const job = (progress) => ({ id: 3, label: 'Scene Edit Detection (1 clip)', progress, etaSeconds: null })

test('a kick steps the jobs each animation frame while work is left, shows the running job, refreshes once the revision moved, and stops', async () => {
  const answers = [
    { pending: true, revision: 5, job: job(0.25) },
    { pending: true, revision: 5, job: job(0.75) },
    { pending: false, revision: 6, job: null },
  ]
  const asked = []
  const shown = []
  let refreshed = 0
  let revision = 5
  const clock = frames()
  const pump = createJobPump({
    step: async () => {
      asked.push(1)
      return answers.shift() ?? { pending: false, revision, job: null }
    },
    schedule: clock.schedule,
    revision: () => revision,
    onJob: (each) => shown.push(each?.progress ?? null),
    onChanged: () => {
      refreshed += 1
      revision = 6
    },
  })
  pump.kick()
  pump.kick()
  assert.equal(clock.count(), 1, 'one loop, whatever the kicks')
  await clock.run()
  await clock.run()
  await clock.run()
  assert.deepEqual(shown, [0.25, 0.75, null])
  assert.equal(refreshed, 1)
  assert.equal(clock.count(), 0, 'nothing left: it stops')
  assert.equal(asked.length, 3)
  // A kick with nothing to do asks once and stops.
  pump.kick()
  await clock.run()
  assert.equal(asked.length, 4)
  assert.equal(clock.count(), 0)
  assert.equal(refreshed, 1)
})

test('another document resets the pump: an answer for the old one is dropped', async () => {
  const clock = frames()
  let release
  const shown = []
  const pump = createJobPump({ step: () => new Promise((done) => (release = done)), schedule: clock.schedule, revision: () => 1, onJob: (each) => shown.push(each), onChanged: () => assert.fail('no refresh') })
  pump.kick()
  await clock.run()
  pump.reset()
  release({ pending: true, revision: 9, job: job(0.5) })
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  assert.deepEqual(shown, [null], 'only the reset')
  assert.equal(clock.count(), 0)
})

test("the status bar says upstream's verb for the running job: its label for a render, else Exporting", () => {
  const phrase = (text) => text
  assert.deepEqual(jobStatus(job(0.42), phrase), { verb: 'Exporting', fraction: 0.42, secondsLeft: null })
  assert.equal(jobStatus({ id: 1, label: 'Rendering previews', progress: 2, etaSeconds: 12 }, phrase).verb, 'Rendering previews')
  assert.equal(jobStatus({ id: 1, label: 'Rendering previews', progress: 2, etaSeconds: 12 }, phrase).fraction, 1)
})
