import { test, expect } from './fixtures.mjs'

for (const edits of [0, 205]) {
  for (const redo of [false, true]) {
    test(`F82 exporting a graphics template preserves history after ${edits} edits, redo=${redo}`, async ({ film, page }) => {
      await film.open()
      await film.command('file.newProject', { name: 'Export history' })
      await film.command('file.newSequence', { width: 64, height: 36, fps: 24 })
      const { clip } = await film.command('graphics.newText', { text: 'Original 标题' })
      await film.command('graphics.newText', { clip, text: 'Subtitle' })
      const result = await page.evaluate(async ([clip, edits]) => window.devHost.connection().ai.run(Array.from({ length: edits }, (_, n) => ({ command: 'graphics.setText', params: { clip, layer: 0, text: `Take ${n}` } })), false), [clip, edits])
      expect(result.failed).toBeFalsy()
      expect(result.completed).toHaveLength(edits)
      if (redo) {
        await film.command('graphics.setText', { clip, layer: 0, text: 'Redo survives' })
        await film.command('edit.undo')
      }
      const before = { history: await film.history(), layers: await film.command('graphics.list', { clip }) }
      const params = { clip, name: 'Snapshot', path: 'Snapshot.fcgt' }
      const exported = await film.command('graphics.template.export', params)
      expect(exported.controls.map(control => control.layer)).toEqual([1, 2])
      expect(await film.history()).toEqual(before.history)
      expect(await film.command('graphics.list', { clip })).toEqual(before.layers)
      await film.command('graphics.template.export', params)
      expect(await film.history()).toEqual(before.history)
      if (redo) {
        await film.command('edit.redo')
        expect((await film.command('graphics.list', { clip })).layers[0].text).toBe('Redo survives')
        await film.command('edit.undo')
      } else {
        await film.command('edit.undo')
        const layers = (await film.command('graphics.list', { clip })).layers
        if (edits) expect(layers[0].text).toBe('Take 203')
        else expect(layers).toHaveLength(1)
        await film.command('edit.redo')
      }
      await film.saveReopen()
      expect(await film.command('graphics.list', { clip })).toEqual(before.layers)
    })
  }
}
