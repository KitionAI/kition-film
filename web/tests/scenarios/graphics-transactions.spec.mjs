import { test, expect, clips } from './fixtures.mjs'

const template = 'builtin:title-centered'
async function setup(film, edits) {
  await film.open()
  await film.command('file.newProject', { name: 'Graphics transactions' })
  await film.command('file.newSequence', { width: 64, height: 36, fps: 24 })
  const { item } = await film.command('file.newColorMatte', { seconds: 0.5 })
  const result = await film.commands(Array.from({ length: edits }, (_, n) => ({ command: 'clip.rename', params: { item, name: `Take ${n}` } })))
  expect(result).toHaveLength(edits)
  return item
}
async function refusal(film, command, params) {
  return film.attempt(command, params)
}
async function snapshot(film) {
  return { items: await film.command('project.items'), sequence: await film.sequence(), captions: await film.command('captions.list'), history: await film.history() }
}
async function values(film, clip) {
  const result = await film.command('graphics.template.controls', { clip })
  return Object.fromEntries(result.controls.map(control => [control.id, control.value]))
}
for (const edits of [0, 205]) {
  test(`F78 template application and multiple property edits undo completely after ${edits} prior edits`, async ({ film }) => {
    await setup(film, edits)
    const items = await film.command('project.items')
    const { clip } = await film.command('graphics.template.apply', { template, values: { title: 'First 标题', subtitle: 'Second' } })
    expect(await values(film, clip)).toMatchObject({ title: 'First 标题', subtitle: 'Second' })
    await film.command('edit.undo')
    expect(clips(await film.sequence())).toHaveLength(0)
    expect(await film.command('project.items')).toEqual(items)
    await film.command('edit.redo')
    expect(await values(film, clip)).toMatchObject({ title: 'First 标题', subtitle: 'Second' })
    await film.command('graphics.template.set', { clip, values: { title: 'Changed', subtitle: 'Also changed' } })
    await film.command('edit.undo')
    expect(await values(film, clip)).toMatchObject({ title: 'First 标题', subtitle: 'Second' })
    await film.command('edit.redo')
    await film.saveReopen()
    expect(await values(film, clip)).toMatchObject({ title: 'Changed', subtitle: 'Also changed' })
  })

  for (const operation of ['apply', 'set']) {
    test(`F79 invalid template ${operation} preserves content and redo after ${edits} prior edits`, async ({ film }) => {
      const item = await setup(film, edits)
      const clip = operation === 'set' ? (await film.command('graphics.template.apply', { template })).clip : undefined
      await film.command('clip.rename', { item, name: 'Redo survives' })
      await film.command('edit.undo')
      const before = await snapshot(film)
      // Apply names the template and set the clip: a command refuses a parameter it does not take
      // (engine rule E7a), so each gets only its own, and the unknown property is what it refuses.
      const target = operation === 'set' ? { clip } : { template }
      expect(await refusal(film, `graphics.template.${operation}`, { ...target, values: { title: 'Must roll back', zz_unknown: 'invalid' } })).toContain('zz_unknown')
      expect(await snapshot(film)).toEqual(before)
      await film.command('edit.redo')
      expect((await film.command('project.items')).rows.find(row => row.item === item).name).toBe('Redo survives')
      const result = await film.command(`graphics.template.${operation}`, { ...target, values: { title: 'Recovered' } })
      await film.saveReopen()
      expect(await values(film, result.clip)).toMatchObject({ title: 'Recovered' })
    })
  }

  test(`F80 multiple captions upgrade as one complete undo step after ${edits} prior edits`, async ({ film }) => {
    await setup(film, edits)
    await film.command('captions.add', { text: 'First', seconds: 0, durationSeconds: 1 })
    await film.command('captions.add', { text: 'Second', seconds: 2, durationSeconds: 1 })
    const before = await film.command('captions.list')
    const captions = before.tracks[0].captions.map(caption => caption.id)
    const result = await film.command('graphics.upgradeCaption', { captions })
    expect(result.upgraded).toBe(2)
    expect(clips(await film.sequence())).toHaveLength(2)
    await film.command('edit.undo')
    expect(clips(await film.sequence())).toHaveLength(0)
    expect((await film.command('captions.list')).tracks).toEqual(before.tracks)
    await film.command('edit.redo')
    await film.saveReopen()
    expect(clips(await film.sequence())).toHaveLength(2)
    expect((await film.command('captions.list')).tracks[0].captions).toHaveLength(0)
  })

  test(`F81 locked caption upgrade refuses without leaving graphics after ${edits} prior edits`, async ({ film }) => {
    const item = await setup(film, edits)
    await film.command('captions.add', { text: 'Locked caption', seconds: 0, durationSeconds: 1 })
    const captions = (await film.command('captions.list')).tracks[0].captions.map(caption => caption.id)
    await film.command('captions.setTrack', { track: 'C1', locked: true })
    await film.command('clip.rename', { item, name: 'Redo survives' })
    await film.command('edit.undo')
    const before = await snapshot(film)
    expect(await refusal(film, 'graphics.upgradeCaption', { captions })).toContain('locked')
    expect(await snapshot(film)).toEqual(before)
    await film.command('edit.redo')
    expect((await film.command('project.items')).rows.find(row => row.item === item).name).toBe('Redo survives')
    await film.command('captions.setTrack', { track: 'C1', locked: false })
    const unlocked = await film.command('captions.list')
    expect((await film.command('graphics.upgradeCaption', { captions })).upgraded).toBe(1)
    await film.command('edit.undo')
    expect(clips(await film.sequence())).toHaveLength(0)
    expect((await film.command('captions.list')).tracks).toEqual(unlocked.tracks)
    await film.command('edit.redo')
    await film.saveReopen()
    expect(clips(await film.sequence())).toHaveLength(1)
  })
}
