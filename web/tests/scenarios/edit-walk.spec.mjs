import { test, expect, clips, editState, TICKS } from './fixtures.mjs'

const steps = Number(process.env.FILM_EDIT_WALK_STEPS ?? 24)
if (!Number.isInteger(steps) || steps < 1 || steps > 180) throw new Error('FILM_EDIT_WALK_STEPS must be an integer from 1 to 180')

for (const [num, den, seed] of [[24, 1, 0x241], [25, 1, 0x251], [30000, 1001, 0x2997], [60000, 1001, 0x5994]]) {
  test(`F30 mixed editing at ${num}/${den} keeps exact linked ranges and reversible history (seed ${seed})`, async ({ film }, testInfo) => {
    testInfo.setTimeout(Math.max(60_000, steps * 3000))
    await film.open()
    await film.command('file.newProject', { name: `Exact edits ${num}/${den}` })
    await film.command('sequence.new', { name: 'Walk', width: 64, height: 36, fps: num / den, video: 1, audio: 1 })
    const frame = TICKS * den / num
    expect((await film.sequence()).settings.frame_rate).toEqual({ num, den })
    const { item } = await film.command('item.newBarsAndTone', { seconds: 10 })
    for (const at of [0, 24, 48]) await film.command('timeline.place', { item, track: 'V1', time: at * frame, sourceIn: 24 * frame, duration: 12 * frame })
    let random = seed
    const next = maximum => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % maximum }
    const actions = []
    const invariant = sequence => {
      const violations = []
      for (const kind of ['video', 'audio']) for (const track of sequence[kind]) {
        const items = [...track.items].sort((a, b) => a.start - b.start)
        let end = 0
        for (const clip of items) {
          const checks = {
            noOverlap: clip.start >= end,
            positiveDuration: clip.duration > 0,
            durationOnFrame: clip.duration % frame === 0,
            startOnFrame: clip.start % frame === 0,
            sourceRange: clip.sourceOut - clip.sourceIn === clip.duration,
          }
          if (Object.values(checks).some(ok => !ok)) violations.push({ kind, track: track.id, clip, checks })
          end = clip.start + clip.duration
        }
      }
      // Aggregate failures so an extended session records two useful assertions per
      // inspection instead of tens of thousands of per-field trace steps.
      expect(violations, 'exact frame ranges and non-overlapping tracks').toEqual([])
      const ranges = kind => clips(sequence, kind).map(clip => [clip.link, clip.start, clip.duration, clip.sourceIn, clip.sourceOut]).sort((a, b) => a[0] - b[0])
      expect(ranges('audio')).toEqual(ranges('video'))
    }
    try {
      for (let index = 0; index < steps; index += 1) {
        const before = await film.sequence()
        invariant(before)
        const picture = clips(before)
        const clip = picture[next(picture.length)]
        const kind = next(5)
        let command, params
        if (kind === 0 && clip.duration >= 3 * frame) {
          command = 'sequence.addEdit'; params = { time: clip.start + Math.floor(clip.duration / frame / 2) * frame }
        } else if (kind === 1 && clip.duration >= 2 * frame) {
          command = 'timeline.trim'; params = { clip: clip.clip, edge: 'out', mode: 'regular', deltaFrames: -1 }
        } else if (kind === 2) {
          command = 'timeline.slip'; params = { clip: clip.clip, deltaFrames: next(2) ? 1 : -1 }
        } else if (kind === 3) {
          command = 'marker.add'; params = { time: next(96) * frame, name: `Seed ${seed} mark ${index}`, target: 'program' }
        } else {
          command = 'timeline.move'; params = { moves: picture.map(clip => ({ clip: clip.clip, track: 'V1', time: clip.start + frame })) }
        }
        actions.push({ command, params })
        const history = await film.history()
        await film.command(command, params)
        const after = await film.sequence()
        invariant(after)
        expect(editState(after)).not.toEqual(editState(before))
        expect((await film.history()).undo).toHaveLength(history.undo.length + 1)
        await film.undo()
        await expect.poll(async () => editState(await film.sequence())).toEqual(editState(before))
        await film.redo()
        await expect.poll(async () => editState(await film.sequence())).toEqual(editState(after))
      }
      const final = await film.sequence()
      await film.saveReopen()
      expect(editState(await film.sequence())).toEqual(editState(final))
      invariant(await film.sequence())
    } finally {
      await testInfo.attach('deterministic-edit-actions', { body: JSON.stringify({ num, den, seed, steps, actions }, null, 2), contentType: 'application/json' })
    }
  })
}
