// Takes the README's pictures of the Film editor (assets/readme/*.png at the repository root) on
// kition-sdk's shared runner (tools/readme-shots/shots.mjs): the development host opens a showcase
// sample, and each shot shows one ability. Not a test; re-run it by hand when the editor changes:
//
//   cd web && pnpm install && pnpm run engine      # the engine in public/
//   node scripts/readme-shots.mjs [name ...]       # every shot, or only the named ones
//
// The samples come from a kition-showcase checkout next to this repository (or the one
// KITION_SHOWCASE names): film/six-places-beat-montage (a cut to music, with markers and a title)
// and film/aurora-title-card (a title fading in over a slow push-in). Both use the kit's
// procedural demo footage, so they need no media files. Run it with no HTTP proxy set. Shrink the
// pictures afterwards with pngquant --quality 70-90 (a README picture is at most 400 KB).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdk = path.resolve(process.env.KITION_SDK ?? path.join(web, '..', '..', 'kition-sdk'))
const showcase = path.resolve(process.env.KITION_SHOWCASE ?? path.join(web, '..', '..', 'kition-showcase'))
const { takeShots, openFile } = await import(pathToFileURL(path.join(sdk, 'tools/readme-shots/shots.mjs')).href)

const MONTAGE = 'six-places-beat-montage'
const TITLE_CARD = 'aurora-title-card'
/** Opens the showcase sample `name` (film/<name>/<name>.kfilm) in the development host. */
const openSample = (page, name) => openFile(page, { name: `${name}.kfilm`, bytes: fs.readFileSync(path.join(showcase, 'film', name, `${name}.kfilm`)) })

/** The open project as the engine reports it (the sequence's tracks and clips, the project's items). */
const details = async (page) => (await page.evaluate(async () => window.devHost.connection().ai.inspect())).details
/** The id of the project item named `name`, searched through bins. */
const itemNamed = (node, name) => (node?.name === name && node.item != null ? node.item : (node?.children ?? []).map((child) => itemNamed(child, name)).find((id) => id != null))

/** Drags the workspace's horizontal gutter between the monitors and the Timeline up by `dy` pixels, so every track shows. */
async function raiseTimeline(page, kit, dy = 70) {
  const gutters = await kit.locator('.kui-ws-gutter[role="separator"]').all()
  for (const gutter of gutters) {
    const box = await gutter.boundingBox()
    if (!box || box.width < box.height || box.width < 600) continue
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - dy, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(500)
    return
  }
  throw new Error('no horizontal workspace gutter')
}
/** Opens the project's Footage bin in the Project panel and the clip `name` from it in the Source monitor (double-clicks). */
async function sourceClip(page, kit, name) {
  const { project } = await details(page)
  const footage = project.root.children.find((bin) => bin.name === 'Footage')
  await kit.getByTestId(`film-project-bin-${footage.id}`).dblclick()
  await kit.getByTestId(`film-project-item-${itemNamed(footage, name)}`).dblclick()
  await kit.getByTestId('film-source').waitFor()
}
/** Zooms the Timeline to fit the sequence (\ with the editor focused). */
async function fitTimeline(page, kit) {
  await kit.locator('.kui-app').focus()
  await page.keyboard.press('\\')
  await page.waitForTimeout(800)
}
/** Moves the playhead by typing a timecode into the Timeline's timecode field. */
async function seek(page, kit, timecode) {
  await kit.getByTestId('film-timeline-timecode').click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Meta+a')
  await page.keyboard.type(timecode)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
}
/** Clicks a clip in the Timeline, as a person selects it. */
async function clickClip(page, kit, clip) {
  await kit.getByTestId(`film-clip-${clip}`).click()
  await page.waitForTimeout(500)
}
/** The page point at fractions (fx, fy) of the Program monitor's picture. */
async function picturePoint(page, kit, fx, fy) {
  const { width, height } = (await details(page)).sequence.settings
  const [zoom, x, y] = ((await kit.getByTestId('film-program').getAttribute('data-view')) ?? '').split(' ').map(Number)
  const region = await kit.locator('[data-testid="film-program"] canvas').first().boundingBox()
  return { x: region.x + (width * fx - x) * zoom, y: region.y + (height * fy - y) * zoom }
}
/** Runs a command from a ribbon tab (Sequence, Markers, …), then goes back to Home. */
async function ribbon(kit, tab, command) {
  await kit.getByRole('tab', { name: tab }).click()
  await kit.getByTestId(`film-cmd-${command}`).click()
  await kit.getByRole('tab', { name: 'Home' }).click()
}

await takeShots({
  web,
  sample: (page, shot) => openSample(page, shot.name === 'see-2' || shot.name === 'see-3' ? TITLE_CARD : MONTAGE),
  ready: '[data-testid="film-program"] canvas',
  query: { modes: 'classic,line,menus,focus' },
  shots: [
    {
      // The montage at its title: six scenes cut on the music's markers, the title selected, a scene in the Source monitor.
      name: 'hero',
      steps: async (page, { kit }) => {
        const { sequence } = await details(page)
        await raiseTimeline(page, kit)
        await sourceClip(page, kit, 'Desert_Dunes.mp4')
        await fitTimeline(page, kit)
        await seek(page, kit, '00:00:11:00')
        await clickClip(page, kit, sequence.video[1].items[0].clip)
      },
    },
    {
      // The Timeline with its markers, and the Markers panel listing them (Window › Markers).
      name: 'see-1',
      steps: async (page, { kit }) => {
        const { sequence } = await details(page)
        await raiseTimeline(page, kit)
        await sourceClip(page, kit, 'Misty_Forest.mp4')
        await fitTimeline(page, kit)
        await seek(page, kit, '00:00:04:00')
        await clickClip(page, kit, [...sequence.video[0].items].sort((a, b) => a.start - b.start)[2].clip)
        await kit.getByRole('tab', { name: 'Window' }).click()
        await kit.getByTestId('film-control-window.panel.Markers').click()
        await kit.getByRole('tab', { name: 'Home' }).click()
        await kit.locator('[data-testid^="film-markers-row-"]').nth(2).click()
      },
    },
    {
      // The title card's text layer selected in the Program monitor, with its handles.
      name: 'see-2',
      steps: async (page, { kit }) => {
        const { sequence } = await details(page)
        await raiseTimeline(page, kit)
        await sourceClip(page, kit, 'Aurora_Timelapse.mp4')
        await fitTimeline(page, kit)
        await seek(page, kit, '00:00:02:00')
        await clickClip(page, kit, sequence.video[1].items[0].clip)
        const at = await picturePoint(page, kit, 0.5, 0.52)
        await page.mouse.click(at.x, at.y)
        await page.waitForTimeout(500)
      },
    },
    {
      // Effect Controls on the footage: Motion's Scale animated by two keyframes (the push-in).
      name: 'see-3',
      steps: async (page, { kit }) => {
        const { sequence } = await details(page)
        await raiseTimeline(page, kit, 20)
        await fitTimeline(page, kit)
        await seek(page, kit, '00:00:02:00')
        await clickClip(page, kit, sequence.video[0].items[0].clip)
        await kit.getByTestId('film-workspace-tab-effectControls').click()
        await kit.getByTestId('film-ec-motion-scale-lane').waitFor()
      },
    },
    {
      // Two default video transitions applied at cuts (Sequence › Apply Video Transition), and the
      // music clip selected: its level and pan in Properties.
      name: 'see-4',
      steps: async (page, { kit }) => {
        const { sequence } = await details(page)
        await raiseTimeline(page, kit)
        await sourceClip(page, kit, 'Ocean_Sunset.mp4')
        await fitTimeline(page, kit)
        await seek(page, kit, '00:00:02:00')
        await ribbon(kit, 'Sequence', 'sequence.applyVideoTransition')
        await seek(page, kit, '00:00:06:00')
        await ribbon(kit, 'Sequence', 'sequence.applyVideoTransition')
        await clickClip(page, kit, sequence.audio[0].items[0].clip)
        await seek(page, kit, '00:00:01:22')
      },
    },
  ],
})
