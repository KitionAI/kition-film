import { test, expect, holdHostRequest } from './fixtures.mjs'

function items(root) { return (root?.children ?? []).flatMap(item => item.children ? items(item) : [item]) }

test('F05 pending media picker must not import into a newly created project', async ({ film }) => {
  await film.open()
  const gate = await holdHostRequest(film, 'host/pick')
  await film.kit.getByTestId('film-menu-File').click()
  await film.kit.locator('[data-kit-ui-id="control:file.import"]').click()
  await gate.wait()
  await film.command('file.newProject', { name: 'Replacement project' })
  const before = await film.details()
  await gate.release()
  await expect.poll(async () => items((await film.details()).project.root).length).toBe(items(before.project.root).length)
  expect(await film.details()).toEqual(before)
})

test('F06 revoking then restoring import permission discards the outstanding picker result', async ({ film }) => {
  await film.open()
  const gate = await holdHostRequest(film, 'host/pick')
  const before = await film.details()
  const history = await film.history()
  await film.kit.getByTestId('film-menu-File').click()
  await film.kit.locator('[data-kit-ui-id="control:file.import"]').click()
  await gate.wait()
  await film.configure({ disable: ['command:file.import'] })
  await film.configure({ disable: [] })
  await gate.release()
  expect(await film.history()).toEqual(history)
  expect(await film.details()).toEqual(before)
})

async function holdRectangle(film, page) {
  await film.kit.getByTestId('film-tools').locator('.kui-tool-slot > button[data-kit-ui-id="tool:Pen"]').click({ button: 'right' })
  await film.kit.locator('.kui-tool-flyout [data-kit-ui-id="tool:Rectangle"]').click()
  await expect(film.kit.getByTestId('film-tools')).toHaveAttribute('data-active', 'Rectangle')
  const box = await film.kit.locator('[data-testid="film-program"] canvas').first().boundingBox()
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 6 })
  await expect(film.kit.locator('[data-testid="film-program-graphics"] rect.film-gfx-outline')).toHaveCount(1)
}

for (const action of ['permissions', 'new project']) {
  test(`F07 graphic creation held across ${action} must be cancelled`, async ({ film, page }) => {
    await film.open()
    await holdRectangle(film, page)
    if (action === 'permissions') {
      await film.configure({ disable: ['command:graphics.newShape'] })
      await film.configure({ disable: [] })
    } else {
      await film.command('file.newProject', { name: 'New graphic destination' })
      await film.command('sequence.new', { name: 'New sequence', width: 64, height: 36, fps: 24 })
    }
    const before = await film.details()
    const history = await film.history()
    await page.mouse.up()
    await film.frame().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await film.history()).toEqual(history)
    expect(await film.details()).toEqual(before)
    await expect(film.kit.locator('[data-testid="film-program-graphics"] rect.film-gfx-outline')).toHaveCount(0)
  })
}
