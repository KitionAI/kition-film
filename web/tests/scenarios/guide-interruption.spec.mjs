import { test, expect, clips, editState } from './fixtures.mjs'

for (const monitor of ['program', 'source']) {
  for (const control of ['guide', 'ruler-top', 'ruler-left']) {
    for (const restore of [false, true]) {
      test(`F84 ${monitor} ${control} drag is cancelled when disabled${restore ? ' and restored before release' : ' through release'}`, async ({ film, page }) => {
        await film.open()
        if (monitor === 'source') {
          await film.command('source.open', { item: clips(await film.sequence())[0].item })
          await film.kit.getByTestId('film-source').click()
        } else await film.kit.getByTestId('film-program').click()
        await film.menu('view.showRulers')
        const guides = film.kit.getByTestId(`film-${monitor}-guides`)
        const positions = () => guides.locator('.film-guide:not(.film-guide-new)').evaluateAll(items => items.map(item => ({
          vertical: item.dataset.vertical, position: Number(item.dataset.position),
        })))
        const ruler = side => film.kit.getByTestId(`film-${monitor}-ruler-${side}`)
        const begin = async target => {
          await target.hover()
          const area = await guides.boundingBox()
          await page.mouse.down()
          await page.mouse.move(area.x + area.width * 0.65, area.y + area.height * 0.65, { steps: 6 })
          await expect(guides).toHaveAttribute('data-dragging', target === guide ? 'move' : 'new')
        }
        const guide = film.kit.getByTestId(`film-${monitor}-guide-0`)
        if (control === 'guide') {
          await begin(ruler('left'))
          await page.mouse.up()
          await expect(guides).toHaveAttribute('data-count', '1')
        }
        const before = await positions()
        const sequence = editState(await film.sequence())
        const history = await film.history()
        const target = control === 'guide' ? guide : ruler(control.slice('ruler-'.length))
        // Move an existing guide away from its initial 65% position as well.
        await begin(target)
        const area = await guides.boundingBox()
        await page.mouse.move(area.x + area.width * 0.4, area.y + area.height * 0.4, { steps: 4 })
        const id = control === 'guide' ? 'control:monitor.guide' : `control:monitor.ruler.${control.slice('ruler-'.length)}`
        await film.configure({ disable: [id] })
        if (restore) await film.configure({ disable: [] })
        await page.mouse.up()
        await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        expect(await positions(), 'an interrupted drag cannot commit, even after permission returns').toEqual(before)
        await expect(guides).not.toHaveAttribute('data-dragging', /.+/)
        await film.configure({ disable: [] })
        await begin(target)
        await page.mouse.move(area.x + area.width * 0.4, area.y + area.height * 0.4, { steps: 4 })
        await page.mouse.up()
        await expect.poll(positions).not.toEqual(before)
        const after = await positions()
        expect(after).toHaveLength(1)
        expect(after[0].vertical).toBe(control === 'ruler-top' ? 'false' : 'true')
        expect(after[0].position).toBeGreaterThan(0)
        expect(editState(await film.sequence())).toEqual(sequence)
        expect(await film.history()).toEqual(history)
      })
    }
  }
}
