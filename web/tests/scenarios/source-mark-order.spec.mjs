import { test, expect, editState, TICKS, holdWorkerCommandReply } from './fixtures.mjs'

for (const [keys, clear, shortcut] of [
  [['i'], 'markers.clearIn', 'ControlOrMeta+Shift+i'],
  [['o'], 'markers.clearOut', 'ControlOrMeta+Shift+o'],
  [['i', 'o'], 'markers.clearInOut', null],
]) {
  test(`F97 ${clear} follows pending Source marks and retains undo/redo order`, async ({ film, page }) => {
    await film.open()
    await film.command('file.newProject', { name: 'Pending marks then clear' })
    await film.command('file.newSequence', { width: 64, height: 36, fps: 24 })
    const item = (await film.command('file.newBarsAndTone', { seconds: 10 })).item
    await film.command('source.open', { item })
    await film.command('project.setMarks', { item, in: TICKS, out: 9 * TICKS })
    await film.command('source.setPlayhead', { seconds: 3 })
    await expect(film.kit.getByTestId('film-source-time')).toHaveText('00:00:03:00')
    await film.kit.getByTestId('film-source').click()
    await film.focus()
    await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const before = await film.history(), sequence = editState(await film.sequence())
    const gate = await holdWorkerCommandReply(film, 'source.inspect')
    await page.keyboard.press(keys[0])
    await gate.wait()
    await film.frame().evaluate(() => {
      const post = Worker.prototype.postMessage
      window.markOrder = []
      Worker.prototype.postMessage = function(message, ...rest) {
        if (message?.request?.method === 'execute' && message.request.command.startsWith('markers.')) window.markOrder.push(message.request.command)
        return post.call(this, message, ...rest)
      }
    })
    for (const key of keys.slice(1)) await page.keyboard.press(key)
    if (shortcut) await page.keyboard.press(shortcut)
    else await film.menu(clear)
    await gate.release()
    const expectedOrder = [...keys.map(k => k === 'i' ? 'markers.markIn' : 'markers.markOut'), clear]
    await expect.poll(() => film.frame().evaluate(() => window.markOrder)).toEqual(expectedOrder)
    const cleared = { markIn: keys.includes('i') ? null : TICKS, markOut: keys.includes('o') ? null : 9 * TICKS }
    const readMarks = async () => { const s = await film.command('source.inspect'); return { markIn: s.markIn, markOut: s.markOut } }
    await expect.poll(readMarks).toEqual(cleared)
    expect((await film.history()).undo).toHaveLength(before.undo.length + keys.length + 1)
    await film.undo()
    await expect.poll(readMarks).toEqual({ markIn: keys.includes('i') ? 3 * TICKS : TICKS, markOut: keys.includes('o') ? 3 * TICKS : 9 * TICKS })
    await film.redo()
    await expect.poll(readMarks).toEqual(cleared)
    expect(editState(await film.sequence())).toEqual(sequence)
    await film.saveReopen()
    await film.command('source.open', { item })
    expect(await readMarks()).toEqual(cleared)
  })
}
