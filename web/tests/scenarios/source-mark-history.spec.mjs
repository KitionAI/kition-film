import { test, expect, editState, TICKS, holdWorkerCommandReply } from './fixtures.mjs'

for (const route of ['shortcut', 'menu', 'toolbar', 'shortcut then Out', 'shortcut then Redo']) {
  test(`F98 pending Source In then ${route} Undo preserves history and later marks`, async ({ film, page }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Pending mark history' })
    await film.command('sequence.new', { width: 64, height: 36, fps: 24 })
    const item = (await film.command('item.newBarsAndTone', { seconds: 10 })).item
    await film.command('source.open', { item })
    await film.command('project.setMarks', { item, in: TICKS, out: 9 * TICKS })
    await film.command('source.setPlayhead', { seconds: 3 })
    await expect(film.kit.getByTestId('film-source-time')).toHaveText('00:00:03:00')
    await film.kit.getByTestId('film-source').click()
    await film.focus()
    await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const before = await film.history(), sequence = editState(await film.sequence())
    const gate = await holdWorkerCommandReply(film, 'source.inspect')
    await page.keyboard.press('i')
    await gate.wait()
    await film.frame().evaluate(() => {
      const post = Worker.prototype.postMessage
      window.markHistoryOrder = []
      Worker.prototype.postMessage = function(message, ...rest) {
        const r = message?.request
        if (r?.method === 'execute' && ['marker.markIn', 'marker.markOut', 'edit.undo', 'edit.redo'].includes(r.command)) window.markHistoryOrder.push(r.command)
        return post.call(this, message, ...rest)
      }
    })
    if (route === 'menu') await film.menu('edit.undo')
    else if (route === 'toolbar') await film.kit.getByTestId('film-undo').click()
    else await film.undo()
    const laterOut = route === 'shortcut then Out', earlyRedo = route === 'shortcut then Redo'
    if (earlyRedo) await film.redo()
    if (laterOut) await page.keyboard.press('o')
    await gate.release()
    await expect.poll(() => film.frame().evaluate(() => window.markHistoryOrder)).toEqual([
      'marker.markIn', 'edit.undo', ...(earlyRedo ? ['edit.redo'] : []), ...(laterOut ? ['marker.markOut'] : []),
    ])
    const readMarks = async () => { const s = await film.command('source.inspect'); return { markIn: s.markIn, markOut: s.markOut } }
    const expected = { markIn: earlyRedo ? 3 * TICKS : TICKS, markOut: laterOut ? 3 * TICKS : 9 * TICKS }
    await expect.poll(readMarks).toEqual(expected)
    const history = await film.history()
    expect(history.undo).toHaveLength(before.undo.length + (laterOut || earlyRedo ? 1 : 0))
    expect(history.redo).toHaveLength(laterOut || earlyRedo ? 0 : 1)
    if (laterOut || earlyRedo) {
      await film.undo()
      await expect.poll(readMarks).toEqual({ markIn: TICKS, markOut: 9 * TICKS })
    }
    await film.redo()
    const redone = laterOut ? expected : { markIn: 3 * TICKS, markOut: 9 * TICKS }
    await expect.poll(readMarks).toEqual(redone)
    expect(editState(await film.sequence())).toEqual(sequence)
    await film.saveReopen()
    await film.command('source.open', { item })
    expect(await readMarks()).toEqual(redone)
  })
}
