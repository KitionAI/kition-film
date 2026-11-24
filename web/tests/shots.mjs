// Screenshots of the editor for visual checks: [SHOTS_ONLY=<state>,…] [SHOTS_LOCALE=zh-CN] node web/tests/shots.mjs [webkit|chromium]
// Starts the Vite dev server itself, opens dev.html at 1100×700 and 1440×900 in the dark scheme
// (the Dark Gray preset) and in light, and writes web/tests/shots/<size>-<scheme>-<name>.png
// (gitignored, never committed) for the editor as it opens and for every named state in STATES.
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

const which = process.argv[2] ?? 'webkit'
const SIZES = [
  { width: 1100, height: 700 },
  { width: 1440, height: 900 },
]
const SCHEMES = ['dark', 'light']
/** SHOTS_ONLY=<name>,<name> shoots only those states. */
const only = process.env.SHOTS_ONLY?.split(',')
/** SHOTS_LOCALE=zh-CN opens the editor in that language (the files are named with it); unset, the browser's (en-US). */
const locale = process.env.SHOTS_LOCALE ?? null

/** A project of clips on two video and two audio tracks, markers, In and Out, and a selected clip, fitted in the Timeline. */
async function timelineProject(page, kit) {
  const steps = []
  for (let index = 0; index < 6; index += 1) {
    steps.push({ command: 'timeline.place', params: { item: 8, track: 1, audioTrack: 4, seconds: 2.5 + index * 2.5 } })
    steps.push({ command: 'timeline.place', params: { item: 8, track: 2, audioTrack: 5, seconds: 3.5 + index * 2.5 } })
  }
  steps.push({ command: 'playhead.set', params: { seconds: 3 } }, { command: 'markers.add', params: {} }, { command: 'playhead.set', params: { seconds: 9 } }, { command: 'markers.add', params: {} })
  steps.push({ command: 'markers.markIn', params: {} }, { command: 'playhead.set', params: { seconds: 12 } }, { command: 'markers.markOut', params: {} }, { command: 'timeline.select', params: { clips: [10] } })
  await page.evaluate(async (list) => window.devHost.connection().ai.run(list, false), steps)
  await kit.locator('.kui-app').focus()
  await page.keyboard.press('\\')
  await page.waitForTimeout(1200)
}

/** The box of the V1 clip under the playhead, and the playhead's x. */
async function underPlayhead(kit) {
  const playhead = await kit.getByTestId('film-playhead').locator('.film-tl-playhead-line').boundingBox()
  const lane = await kit.getByTestId('film-track-Video 1').boundingBox()
  return { x: playhead.x, y: lane.y + lane.height / 2, lane }
}

/** The bars clip open in the Source monitor, marked from 1 s to 3 s, the playhead at 2 s, and the Timeline's project. */
async function monitorsOpen(page, kit) {
  await timelineProject(page, kit)
  await page.evaluate(async () => {
    const find = (node) => (node?.name?.includes('bars') && node.item != null ? node.item : (node?.children ?? []).map(find).find((id) => id != null))
    const item = find((await window.devHost.connection().ai.inspect()).details.project?.root)
    await window.devHost.connection().ai.run(
      [
        { command: 'source.open', params: { item } },
        { command: 'project.setMarks', params: { item, in: 254016000000, out: 3 * 254016000000 } },
        { command: 'source.setPlayhead', params: { seconds: 2 } },
      ],
      false,
    )
  })
  await kit.getByTestId('film-source').waitFor()
  await page.waitForTimeout(600)
}

/** The page point at fractions (`fx`, `fy`) of the Program picture, from the canvas's view. */
async function picturePoint(page, kit, fx, fy) {
  const { width, height } = (await page.evaluate(async () => window.devHost.connection().ai.inspect())).details.sequence.settings
  const [zoom, x, y] = ((await kit.getByTestId('film-program').getAttribute('data-view')) ?? '').split(' ').map(Number)
  const region = await kit.locator('[data-testid="film-program"] canvas').first().boundingBox()
  return [region.x + (width * fx - x) * zoom, region.y + (height * fy - y) * zoom]
}

/**
 * The Project panel with a bin holding a copy of the bars clip, the items labelled apart, and
 * every visible thumbnail drawn.
 */
async function projectShown(page, kit) {
  await page.evaluate(async () => {
    const run = (list) => window.devHost.connection().ai.run(list, false)
    await run([{ command: 'file.newBin', params: { name: 'Selects' } }, { command: 'file.newBarsAndTone', params: {} }])
    const root = (await window.devHost.connection().ai.inspect()).details.project.root
    const bin = root.children.find((child) => child.children && child.name === 'Selects')
    const bars = root.children.find((child) => child.item != null && child.name?.includes('bars'))
    if (bin && bars) await run([{ command: 'edit.duplicate', params: {} }, { command: 'project.moveToBin', params: { items: [bars.item], bin: bin.id } }])
  })
  await kit.getByTestId('film-project').waitFor()
  await kit.locator('[data-testid^="film-project-thumb-"] canvas[data-drawn="1"]').first().waitFor({ timeout: 10000 }).catch(() => undefined)
  await page.waitForTimeout(800)
}

/**
 * The Project panel in the Freeform view with snapping on: the first two cards stacked, the last
 * moved off the grid and selected, every visible thumbnail drawn.
 */
async function freeformShown(page, kit) {
  await page.evaluate(async () => {
    const run = (list) => window.devHost.connection().ai.run(list, false)
    await run([{ command: 'project.view.set', params: { view: 'freeform' } }, { command: 'project.freeform.options', params: { snap: true } }])
    const layout = (await run([{ command: 'project.freeform.layout', params: { width: 400 } }])).completed[0].result
    const items = (layout?.cards ?? []).map((card) => card.item)
    if (items.length >= 3) {
      await run([
        { command: 'project.freeform.stack', params: { items: [items[0], items[1]], width: 400 } },
        { command: 'project.freeform.move', params: { items: [items.at(-1)], x: 196, y: 36, width: 400 } },
        { command: 'project.select', params: { items: [items.at(-1)] } },
      ])
    }
  })
  await kit.getByTestId('film-project-freeform-canvas').waitFor({ timeout: 10000 })
  await kit.locator('[data-testid^="film-project-stack-"]').first().waitFor({ timeout: 10000 }).catch(() => undefined)
  await kit.locator('[data-testid^="film-project-thumb-"] canvas[data-drawn="1"]').first().waitFor({ timeout: 10000 }).catch(() => undefined)
}

/** The sample project as it opens (bars.mp4 in the root, where its subclips and merges go), in the Project panel. */
async function projectPlain(page, kit) {
  await kit.getByTestId('film-project').waitFor()
  await kit.locator('[data-testid^="film-project-thumb-"] canvas[data-drawn="1"]').first().waitFor({ timeout: 10000 }).catch(() => undefined)
  await page.waitForTimeout(400)
}

/** The Timeline's project with its selected clip's Scale and Position keyframed, shown in Effect Controls. */
async function effectControlsShown(page, kit) {
  await timelineProject(page, kit)
  await page.evaluate(async () => {
    const run = (list) => window.devHost.connection().ai.run(list, false)
    const details = (await window.devHost.connection().ai.inspect()).details
    const clip = details.sequence.video.flatMap((track) => track.items ?? []).find((item) => item.clip === 10)
    const at = (fraction) => Math.round(clip.start + clip.duration * fraction)
    await run([
      { command: 'playhead.set', params: { time: at(0.15) } },
      { command: 'effects.toggleAnimation', params: { clip: 10, effect: 'motion', param: 'scale' } },
      { command: 'effects.toggleAnimation', params: { clip: 10, effect: 'motion', param: 'position' } },
      { command: 'playhead.set', params: { time: at(0.8) } },
      { command: 'effects.setParam', params: { clip: 10, effect: 'motion', param: 'scale', value: 140 } },
      { command: 'effects.setParam', params: { clip: 10, effect: 'motion', param: 'position', value: [700, 400] } },
      { command: 'playhead.set', params: { time: at(0.5) } },
    ])
  })
  await kit.getByTestId('film-workspace-tab-effectControls').click()
  await kit.getByTestId('film-ec-motion-scale-lane').waitFor()
  await page.waitForTimeout(600)
}

/**
 * For the clip dialogs: the playhead over the second clip of V1 with its linked audio selected;
 * with `copy`, the selected clip (10) is given a Gaussian Blur and 40% opacity and copied first.
 */
async function clipDialogSetup(page, { copy }) {
  await page.evaluate(async (copying) => {
    const run = (list) => window.devHost.connection().ai.run(list, false)
    const details = (await window.devHost.connection().ai.inspect()).details
    const clips = (details.sequence.video[0].items ?? []).sort((a, b) => a.start - b.start)
    const target = clips.find((clip) => clip.clip !== 10) ?? clips[0]
    const steps = copying
      ? [
          { command: 'effects.apply', params: { clips: [10], effect: 'gaussian_blur' } },
          { command: 'effects.setParam', params: { clip: 10, effect: 'opacity', param: 'opacity', value: 40 } },
          { command: 'timeline.select', params: { clips: [10], linked: false } },
          { command: 'edit.copy', params: {} },
        ]
      : []
    await run([...steps, { command: 'timeline.select', params: { clips: [target.clip] } }, { command: 'playhead.set', params: { time: Math.round(target.start + target.duration / 2) } }])
  }, copy)
  await page.waitForTimeout(400)
}

/** Runs `steps` on the engine through the dev host (`ai/run`), and answers its result. */
const run = (page, steps) => page.evaluate(async (list) => window.devHost.connection().ai.run(list, false), steps)

/** Upstream's menu rows (the parity manifest), to open a command's dialog or window the way a person does. */
const MENUS = JSON.parse(readFileSync(new URL('../parity/film-upstream.json', import.meta.url), 'utf8')).menus

/**
 * Runs `command` from its menu row: opens its top menu, hovers each submenu on its path, and
 * clicks the row (an engine row is `film-cmd-<command>`, an editor row `film-control-<command>`).
 */
async function fromMenu(page, kit, command) {
  const row = MENUS.find((each) => each.command === command)
  if (!row) throw new Error(`no menu row runs ${command}`)
  await kit.getByTestId(`film-menu-${row.path[0]}`).click()
  for (let depth = 2; depth <= row.path.length; depth += 1) await kit.locator(`[data-kit-ui-id="menu:${row.path.slice(0, depth).join('/')}"]`).hover()
  await kit.locator(`[data-testid="film-cmd-${command}"], [data-testid="film-control-${command}"]`).first().click()
}

/**
 * Brings a state up: `show(page, kit)`; or `setup` (optional), then `dialog: '<command>'`, which
 * runs the command from its menu and waits for its dialog, or `floating: '<command>'`, which
 * runs it and waits for a floating window (kit-editor `FloatingPanels`' `.kui-floating-panel`).
 */
async function bringUp(state, page, kit) {
  if (state.setup) await state.setup(page, kit)
  if (state.show) await state.show(page, kit)
  if (state.dialog) {
    await fromMenu(page, kit, state.dialog)
    await kit.locator('[role="dialog"]').first().waitFor({ timeout: 10000 })
  }
  if (state.after) await state.after(page, kit)
  if (state.floating) {
    await fromMenu(page, kit, state.floating)
    await kit.locator('.kui-floating-panel').first().waitFor({ timeout: 10000 })
  }
}

/**
 * The scheme the editor shows, from the `--kit-surface` token its root (`.kui-app`) computes (the
 * background every frame draws on; the Kit UI tokens have no `--kit-bg`): 'light' or 'dark' by
 * the token's luminance, or null while it is unset.
 */
const shownScheme = (frame) =>
  frame.evaluate(() => {
    const root = document.querySelector('.kui-app')
    const token = root ? getComputedStyle(root).getPropertyValue('--kit-surface').trim() : ''
    if (!token) return null
    // Resolved inside the editor root, where the token is defined.
    const probe = document.createElement('span')
    probe.style.color = token
    root.append(probe)
    const [r, g, b] = (getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) ?? []).map(Number)
    probe.remove()
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 160 ? 'light' : 'dark'
  })

/**
 * Named states to shoot besides the editor as it opens, where `kit` is the editor's frame locator:
 * `{ name, show(page, kit) }`, where `show` brings the state up on a freshly opened editor, or
 * `{ name, setup?, dialog: '<command>' }` and `{ name, setup?, floating: '<command>' }` (see
 * `bringUp`). Tasks add theirs here.
 */
/** A drag from `from` to `to` (page points), paced, released unless `hold`. */
async function dragTo(page, from, to, hold = false) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8)
    await page.waitForTimeout(25)
  }
  if (!hold) await page.mouse.up()
}

/**
 * Rulers on both monitors (Task 22) and guides: on the Program a vertical one dragged out of the
 * left ruler at a third and a horizontal one out of the top ruler at two thirds; on the Source a
 * vertical one at the middle.
 */
async function rulersAndGuides(page, kit) {
  await monitorsOpen(page, kit)
  for (const which of ['program', 'source']) {
    await kit.getByTestId(`film-${which}-settings`).click()
    await kit.getByTestId(`film-${which}-settings-showRulers`).click()
    await kit.getByTestId(`film-${which}-ruler-top`).waitFor()
  }
  await page.waitForTimeout(500)
  const left = await kit.getByTestId('film-program-ruler-left').boundingBox()
  const [x, y] = await picturePoint(page, kit, 1 / 3, 0.5)
  await dragTo(page, { x: left.x + 8, y }, { x, y })
  const top = await kit.getByTestId('film-program-ruler-top').boundingBox()
  const [x2, y2] = await picturePoint(page, kit, 0.6, 2 / 3)
  await dragTo(page, { x: x2, y: top.y + 8 }, { x: x2, y: y2 })
  const sourceLeft = await kit.getByTestId('film-source-ruler-left').boundingBox()
  const sourceArea = await kit.getByTestId('film-source-guides').boundingBox()
  await dragTo(page, { x: sourceLeft.x + 8, y: sourceArea.y + sourceArea.height / 2 }, { x: sourceArea.x + sourceArea.width / 2, y: sourceArea.y + sourceArea.height / 2 })
  await kit.getByTestId('film-program-guide-1').waitFor()
  await kit.getByTestId('film-source-guide-0').waitFor()
  await page.waitForTimeout(300)
}

/** A View menu row (`command`), in `submenu` when given, on the Program monitor (its tab focuses it). */
async function viewRow(kit, command, submenu) {
  await kit.getByTestId('film-workspace-tab-program').click()
  await kit.getByTestId('film-menu-View').click()
  if (submenu) await kit.locator(`[data-kit-ui-id="menu:View/${submenu}"]`).hover()
  await kit.getByTestId(`film-control-${command}`).click()
}

const STATES = [
  ...[
    ['menu-view-resolution', 'View', ['View/Playback Resolution']],
    ['menu-clip-interpolation', 'Clip', ['Clip/Video Options', 'Clip/Video Options/Time Interpolation']],
    ['menu-window-workspaces', 'Window', ['Window/Workspaces']],
    ['menu-file-export', 'File', ['File/Export']],
    ['menu-edit-label', 'Edit', ['Edit/Label']],
  ].map(([name, menu, submenus]) => ({
    name,
    show: async (page, kit) => {
      await kit.getByTestId(`film-menu-${menu}`).click()
      for (const path of submenus) {
        await kit.locator(`[data-kit-ui-id="menu:${path}"]`).hover()
        await page.waitForTimeout(150)
      }
    },
  })),
  // Built-in workspaces besides Editing (the editor as it opens), and the header's workspace menu.
  // Color is not offered (its panels are not drawn: src/menus/hidden.ts).
  ...['Assembly', 'Effects'].map((workspace) => ({
    name: `workspace-${workspace.toLowerCase()}`,
    show: async (page, kit) => {
      await kit.getByTestId('film-header-workspaces').click()
      await kit.getByTestId(`film-workspaces-${workspace.toLowerCase()}`).click()
      await page.waitForTimeout(300)
    },
  })),
  {
    name: 'header-workspaces',
    show: async (page, kit) => {
      await kit.getByTestId('film-header-workspaces').click()
      await kit.getByTestId('film-workspaces-reset').waitFor()
    },
  },
  // The Tools panel with the Ripple group's flyout open (right-click), Rate Stretch chosen first.
  {
    name: 'tools-flyout',
    show: async (page, kit) => {
      const slot = (id) => kit.locator(`[data-testid="film-tools"] .kui-tool-slot > button[data-kit-ui-id="tool:${id}"]`)
      await slot('Ripple').click({ button: 'right' })
      await kit.locator('.kui-tool-flyout [data-kit-ui-id="tool:RateStretch"]').click()
      await slot('RateStretch').click({ button: 'right' })
      await kit.locator('.kui-tool-flyout').waitFor()
    },
  },
  // The Timeline with a project of clips on two video and two audio tracks, markers, In and Out, and a selected clip.
  { name: 'timeline-project', show: timelineProject },
  // The clip menu on a clip under the playhead, with its Label submenu open.
  {
    name: 'timeline-clip-menu',
    show: async (page, kit) => {
      await timelineProject(page, kit)
      const at = await underPlayhead(kit)
      await page.mouse.click(at.x + 4, at.y, { button: 'right' })
      await kit.getByTestId('film-clip-menu').waitFor()
      // The menu is taller than the window at 1100×700 and scrolls: bring Label into view first.
      const label = kit.getByTestId('film-clip-menu').locator('[data-kit-ui-id="menu:Edit/Label"]')
      await label.evaluate((element) => element.scrollIntoView({ block: 'center' }))
      await label.hover()
      await page.waitForTimeout(200)
    },
  },
  // A marquee drag from the empty end of V1 back across V1 and A1, shot before the button comes up.
  {
    name: 'timeline-drag',
    show: async (page, kit) => {
      await timelineProject(page, kit)
      const v1 = await kit.getByTestId('film-track-Video 1').boundingBox()
      const a1 = await kit.getByTestId('film-track-Audio 1').boundingBox()
      await page.mouse.move(v1.x + v1.width - 30, v1.y + 10)
      await page.mouse.down()
      await page.mouse.move(v1.x + v1.width * 0.55, a1.y + a1.height / 2, { steps: 10 })
    },
  },
  // The Razor over a clip, 4 px from the playhead: its cut line snaps there, with the snap indicator.
  {
    name: 'timeline-razor',
    show: async (page, kit) => {
      await timelineProject(page, kit)
      await page.keyboard.press('c')
      const at = await underPlayhead(kit)
      await page.mouse.move(at.x + 20, at.y)
      await page.mouse.move(at.x + 4, at.y, { steps: 4 })
    },
  },
  {
    name: 'timeline-settings',
    show: async (page, kit) => {
      await kit.getByTestId('film-timeline-settings').click()
      await kit.getByTestId('film-timeline-show-thumbnails').waitFor()
    },
  },
  // The status bar while an export runs (upstream `job_status`): its progress and Cancel at the right.
  {
    name: 'status-export',
    show: async (page, kit) => {
      await kit.getByTestId('film-export').click()
      await kit.getByTestId('film-exporting-progress').waitFor({ timeout: 10000 })
    },
  },
  // The Source and Program monitors with a clip and a sequence, marks, and markers.
  { name: 'monitors', show: monitorsOpen },
  // The Program wrench menu with Paused Resolution open.
  {
    name: 'monitor-wrench',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.getByTestId('film-program-settings').click()
      await kit.locator('[data-kit-ui-id="menu:View/Paused Resolution"]').hover()
      await page.waitForTimeout(200)
    },
  },
  // The Source monitor's wrench menu (its Loop marked range row).
  {
    name: 'monitor-source-wrench',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.getByTestId('film-source-settings').click()
      await kit.getByTestId('film-source-settings-loop').waitFor()
    },
  },
  // The Program zoom dropdown, and the Source resolution dropdown.
  {
    name: 'monitor-zoom',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.getByTestId('film-program-zoom').click()
      await kit.getByTestId('film-program-zoom-200').waitFor()
    },
  },
  {
    name: 'monitor-resolution',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.getByTestId('film-source-resolution').click()
      await kit.getByTestId('film-source-resolution-quarter').waitFor()
    },
  },
  // Safe Margins on both monitors, the Program magnified to 200%.
  {
    name: 'monitor-safe-margins',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      for (const which of ['program', 'source']) {
        await kit.getByTestId(`film-${which}-settings`).click()
        await kit.getByTestId(`film-${which}-settings-safeMargins`).click()
      }
      await kit.getByTestId('film-source-zoom').click()
      await kit.getByTestId('film-source-zoom-200').click()
      await page.waitForTimeout(400)
    },
  },
  // The display modes (Task 21): the Program wrench with RGBA Channels open, Red on the Program, the
  // Comparison View stepped one frame on, and the Source's Audio Waveform and split view.
  {
    name: 'monitor-wrench-display',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.getByTestId('film-program-settings').click()
      await kit.locator('[data-kit-ui-id="control:monitor.settings.rgbaChannels"]').hover()
      await kit.getByTestId('film-program-settings-display-red').waitFor()
      await page.waitForTimeout(200)
    },
  },
  {
    name: 'monitor-channel-red',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.getByTestId('film-program-settings').click()
      await kit.locator('[data-kit-ui-id="control:monitor.settings.rgbaChannels"]').hover()
      await kit.getByTestId('film-program-settings-display-red').click()
      await kit.locator('[data-testid="film-program-channel"][data-shown="true"]').waitFor()
      await page.waitForTimeout(300)
    },
  },
  {
    name: 'monitor-comparison',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'playhead.set', params: { seconds: 4 } }], false))
      await kit.getByTestId('film-program-settings').click()
      await kit.getByTestId('film-program-settings-display-comparison').click()
      await kit.locator('[data-testid="film-program-reference"] canvas[data-shown="true"]').waitFor()
      await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'playhead.set', params: { seconds: 7 } }], false))
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'monitor-source-waveform',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.getByTestId('film-source-settings').click()
      await kit.getByTestId('film-source-settings-display-audioWaveform').click()
      await kit.locator('[data-testid="film-source-waveform"][data-state="drawn"]').waitFor()
      await page.waitForTimeout(300)
    },
  },
  {
    name: 'monitor-source-split',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.getByTestId('film-source-settings').click()
      await kit.getByTestId('film-source-settings-display-videoAndWaveform').click()
      await kit.locator('[data-testid="film-source-waveform"][data-state="drawn"]').waitFor()
      await page.waitForTimeout(300)
    },
  },
  // Rulers, guides, and guide templates (Task 22): rulers on both monitors with guides; the
  // Program wrench with the guide rows; Add Guide… previewing a horizontal guide; Manage Guides
  // previewing "Thirds" applied; a Rectangle drag held where it snaps to a guide.
  { name: 'monitor-rulers-guides', show: rulersAndGuides },
  {
    name: 'monitor-guides-wrench',
    show: async (page, kit) => {
      await rulersAndGuides(page, kit)
      await kit.getByTestId('film-program-settings').click()
      await kit.getByTestId('film-program-settings-lockGuides').waitFor()
      await page.waitForTimeout(200)
    },
  },
  {
    name: 'dialog-add-guide',
    show: async (page, kit) => {
      await rulersAndGuides(page, kit)
      await viewRow(kit, 'view.addGuide')
      await kit.getByTestId('film-guide-add-horizontal').check()
      await kit.getByTestId('film-guide-add-position').locator('input').fill('200')
      await kit.getByTestId('film-guide-add-position').locator('input').press('Tab')
      await kit.getByTestId('film-program-guide-preview-0').waitFor()
      await page.waitForTimeout(300)
    },
  },
  {
    name: 'dialog-manage-guides',
    show: async (page, kit) => {
      await rulersAndGuides(page, kit)
      await viewRow(kit, 'view.guideTemplates.save', 'Guide Templates')
      await kit.getByTestId('film-guide-save-name').fill('Thirds')
      await kit.locator('[data-testid="film-guide-dialog"] [data-kit-ui-id="control:dialog.ok"]').click()
      await kit.getByTestId('film-guide-dialog').waitFor({ state: 'detached' })
      await viewRow(kit, 'view.clearGuides')
      await viewRow(kit, 'view.guideTemplates.manage', 'Guide Templates')
      await kit.getByTestId('film-guide-manage-row-Thirds').click()
      await kit.getByTestId('film-guide-manage-apply').click()
      await kit.getByTestId('film-program-guide-preview-1').waitFor()
      await page.waitForTimeout(300)
    },
  },
  {
    name: 'program-shape-snap',
    show: async (page, kit) => {
      await rulersAndGuides(page, kit)
      await kit.locator('[data-testid="film-tools"] .kui-tool-slot > button[data-kit-ui-id="tool:Pen"]').click({ button: 'right' })
      await kit.locator('.kui-tool-flyout [data-kit-ui-id="tool:Rectangle"]').click()
      const guide = await kit.getByTestId('film-program-guide-0').boundingBox()
      const [, y0] = await picturePoint(page, kit, 0.5, 0.2)
      const [x1, y1] = await picturePoint(page, kit, 0.55, 0.45)
      await dragTo(page, { x: guide.x + guide.width / 2 + 5, y: y0 }, { x: x1, y: y1 }, true)
      await page.waitForTimeout(300)
    },
  },
  // The graphics tools on the Program monitor (Task 17): the in-place text field while typing, a
  // Rectangle drag held before release, and a Pen path of three points with its rubber band.
  {
    name: 'program-type',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.locator('.kui-app').focus()
      await page.keyboard.press('t')
      await page.mouse.click(...(await picturePoint(page, kit, 0.2, 0.75)))
      await kit.getByTestId('film-program-text-edit').waitFor()
      await page.keyboard.type('Title')
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'program-shape-drag',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.locator('[data-testid="film-tools"] .kui-tool-slot > button[data-kit-ui-id="tool:Pen"]').click({ button: 'right' })
      await kit.locator('.kui-tool-flyout [data-kit-ui-id="tool:Rectangle"]').click()
      const [x0, y0] = await picturePoint(page, kit, 0.3, 0.3)
      const [x1, y1] = await picturePoint(page, kit, 0.7, 0.7)
      await page.mouse.move(x0, y0)
      await page.mouse.down()
      await page.mouse.move(x1, y1, { steps: 10 })
    },
  },
  {
    name: 'program-pen',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await kit.locator('.kui-app').focus()
      await page.keyboard.press('p')
      for (const [fx, fy] of [[0.25, 0.3], [0.7, 0.25], [0.6, 0.7]]) {
        await page.mouse.click(...(await picturePoint(page, kit, fx, fy)))
        await page.waitForTimeout(350)
      }
      await page.mouse.move(...(await picturePoint(page, kit, 0.3, 0.65)), { steps: 4 })
    },
  },
  // A new rectangle, selected with the Selection tool: its box in the accent.
  {
    name: 'program-selected',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'graphics.newShape', params: { shape: 'rectangle', position: [800, 300], size: [500, 250] } }], false))
      await page.waitForTimeout(800)
    },
  },
  // The layer handles (Task 23): point text and a paragraph box that hides text (its red plus),
  // both selected, with their eight handles and anchor points; and a rectangle's corner held
  // mid-drag, its white outline over the box.
  {
    name: 'program-handles-text',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await page.evaluate(async () => {
        const run = (list) => window.devHost.connection().ai.run(list, false)
        const { width, height } = (await window.devHost.connection().ai.inspect()).details.sequence.settings
        const k = height / 1080
        const made = (await run([{ command: 'graphics.newText', params: { text: 'Title', position: [width * 0.15, height * 0.35], size: Math.round(140 * k) } }])).completed[0].result
        await run([
          { command: 'graphics.newText', params: { text: 'A paragraph whose box is too small for all of its words', clip: made.clip, position: [width * 0.55, height * 0.55], box: [Math.round(420 * k), Math.round(120 * k)], size: Math.round(60 * k) } },
          { command: 'graphics.selectLayer', params: { clip: made.clip, layers: [0, 1] } },
        ])
      })
      await kit.locator('[data-kit-ui-id="control:program.layer.anchor"]').nth(1).waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'program-handles-shape',
    show: async (page, kit) => {
      await monitorsOpen(page, kit)
      await page.evaluate(async () => {
        const { width, height } = (await window.devHost.connection().ai.inspect()).details.sequence.settings
        await window.devHost.connection().ai.run([{ command: 'graphics.newShape', params: { shape: 'rectangle', position: [width * 0.45, height * 0.4], size: [width * 0.25, height * 0.25] } }], false)
      })
      const corner = kit.locator('[data-kit-ui-id="control:program.layer.handle"][data-handle="2"]')
      await corner.waitFor({ timeout: 10000 })
      await page.waitForTimeout(400)
      const box = await corner.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 40, { steps: 10 })
      await kit.locator('[data-testid="film-program-graphics"][data-layer-drag="handle"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(300)
    },
  },
  // The Project panel (Task 18): a bin with the bars clip in it beside the project's items, in
  // the Icon view with its thumbnails drawn, in the List view with the bin open, its ≡ menu, and
  // its New Item menu.
  { name: 'project-icons', show: projectShown },
  {
    name: 'project-list',
    show: async (page, kit) => {
      await projectShown(page, kit)
      await kit.getByTestId('film-project-view-list').click()
      await kit.getByTestId('film-project-list').waitFor()
      await kit.locator('[data-testid^="film-project-bin-"][data-testid$="-toggle"]').first().click()
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'project-menu',
    show: async (page, kit) => {
      await projectShown(page, kit)
      await kit.getByTestId('film-workspace-menu-project').click()
      await kit.getByTestId('film-project-menu-fontSize').hover()
      await kit.getByTestId('film-project-menu-fontSize-small').waitFor()
    },
  },
  {
    name: 'project-new-item',
    show: async (page, kit) => {
      await projectShown(page, kit)
      await kit.getByTestId('film-project-new-item').click()
      await kit.getByTestId('film-project-new-file.newBarsAndTone').waitFor()
    },
  },
  // Effect Controls and Properties (Task 19): the Timeline's selected clip with Scale and
  // Position animated (two keyframes each), the playhead between them; the keyframe menu; and
  // Properties beside the Program monitor.
  { name: 'effect-controls', show: effectControlsShown },
  {
    name: 'effect-controls-keyframe-menu',
    show: async (page, kit) => {
      await effectControlsShown(page, kit)
      await kit.locator('[data-testid="film-ec-motion-scale-lane"] .kui-keyframe').first().click({ button: 'right' })
      await kit.getByTestId('film-ec-menu-linear').waitFor()
    },
  },
  {
    name: 'properties',
    show: async (page, kit) => {
      await effectControlsShown(page, kit)
      await kit.getByTestId('film-properties').waitFor()
    },
  },
  {
    name: 'audio-meters',
    show: async (page, kit) => {
      // Playing the Timeline's project: the meters show the Mix (the shot is taken while it plays).
      await timelineProject(page, kit)
      await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'playhead.set', params: { seconds: 3 } }], false))
      await kit.getByTestId('film-program-transport-playback.toggle').click()
      await kit.locator('[data-testid="film-meters-channel-L"]').evaluate((element) => new Promise((resolve) => {
        const check = () => (Number(element.dataset.db) > -40 ? resolve(null) : setTimeout(check, 50))
        check()
      }))
      await page.waitForTimeout(400)
    },
  },
  ...['Markers', 'History', 'Info', 'Libraries'].map((panel) => ({
    name: `panel-${panel.toLowerCase()}`,
    show: async (page, kit) => {
      await timelineProject(page, kit)
      // Info shows the item a click in the Project panel selects.
      if (panel === 'Info') await kit.getByTestId('film-project-item-8').click()
      await kit.getByTestId('film-menu-Window').click()
      await kit.getByTestId(`film-control-window.panel.${panel}`).click()
      await page.waitForTimeout(500)
      if (panel === 'Markers') {
        // The second marker clicked (the playhead on it) and hovered.
        const row = kit.locator('[data-testid^="film-markers-row-"]').nth(1)
        await row.click()
        await row.hover()
      }
      if (panel === 'History') {
        // Back to a middle step (the current row, undone rows faint after it), another row hovered.
        await kit.getByTestId('film-history-row-6').click()
        await kit.locator('[data-testid="film-history-row-6"][aria-current="step"]').waitFor()
        await kit.getByTestId('film-history-row-3').hover()
      }
      await page.waitForTimeout(300)
    },
  })),
  {
    name: 'help-shortcuts',
    show: async (page, kit) => {
      await kit.getByTestId('film-menu-Help').click()
      await kit.getByTestId('film-control-help.shortcuts').click()
      await kit.getByTestId('film-shortcuts').locator('kbd').first().waitFor()
    },
  },
  // Window ▸ Workspaces ▸ Save as New Workspace…, opened from its menu row.
  { name: 'dialog-new-workspace', dialog: 'window.workspace.saveAs' },
  // The dialog framework (Task 9): Help ▸ About's tabs, and Clip Speed / Duration at 50% with
  // Ripple, its picture preview on the Program monitor and the strip listing the changes.
  ...['about', 'contributors'].map((tab) => ({
    name: `dialog-about-${tab}`,
    show: async (page, kit) => {
      await kit.getByTestId('film-menu-Help').click()
      await kit.getByTestId('film-control-help.about').click()
      await kit.getByTestId(`film-about-tab-${tab}`).click()
      await kit.getByTestId(`film-about-${tab}`).waitFor()
    },
  })),
  {
    name: 'dialog-speed-duration',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'playhead.set', params: { seconds: 2.9 } }], false))
    },
    dialog: 'clip.speedDuration',
    show: undefined,
    after: async (page, kit) => {
      await kit.locator('[data-testid="film-dialog-speedDuration-speed"] input').fill('50')
      await kit.locator('[data-testid="film-dialog-speedDuration-speed"] input').press('Tab')
      await kit.getByTestId('film-dialog-speedDuration-ripple').check()
      await kit.locator('[data-testid="film-program-preview"][data-shown="true"]').waitFor({ timeout: 10000 })
      // The Timeline draws the preview (Task 10): the clip at its new length, its old place ghosted.
      await kit.getByTestId('film-timeline-preview-badge').waitFor({ timeout: 10000 })
      await kit.locator('[data-testid^="film-clip-was-"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  // Upstream's clip dialogs (Task 11), each with its preview: Paste Attributes (a copied clip's
  // blur and opacity on the clip under the playhead), Remove Attributes, Frame Hold Options,
  // Field Options, Audio Gain (+6 dB, its peak after the gain), and Interpret Footage (S-Log3).
  {
    name: 'dialog-paste-attributes',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      await clipDialogSetup(page, { copy: true })
    },
    dialog: 'edit.pasteAttributes',
    after: async (page, kit) => {
      await kit.locator('[data-testid="film-program-preview"][data-shown="true"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-remove-attributes',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      await clipDialogSetup(page, { copy: false })
    },
    dialog: 'edit.removeAttributes',
    after: async (page, kit) => {
      await kit.locator('[data-testid="film-program-preview"][data-shown="true"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-frame-hold',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      await clipDialogSetup(page, { copy: false })
    },
    dialog: 'clip.frameHoldOptions',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-frameHold-enabled').check()
      await kit.getByTestId('film-dialog-frameHold-holdOn-sourceTimecode').check()
      await kit.locator('[data-testid="film-program-preview"][data-shown="true"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-field-options',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      await clipDialogSetup(page, { copy: false })
    },
    dialog: 'clip.fieldOptions',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-fieldOptions-processing-alwaysDeinterlace').check()
      await kit.locator('[data-testid="film-program-preview"][data-shown="true"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-audio-gain',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      await clipDialogSetup(page, { copy: false })
    },
    dialog: 'clip.audioGain',
    after: async (page, kit) => {
      const field = kit.locator('[data-testid="film-dialog-audioGain-adjust-value"] input')
      await field.fill('6')
      await field.press('Tab')
      await kit.getByTestId('film-dialog-audioGain-after').waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-interpret-footage',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      await clipDialogSetup(page, { copy: false })
    },
    dialog: 'clip.interpretFootage',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-colorDialog-space-slog3-sgamut3cine').check()
      await kit.locator('[data-testid="film-program-preview"][data-shown="true"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  // Upstream's clip structure dialogs (Task 12), each with its preview: Nest on the Timeline and
  // in the Project panel, Make and Edit Subclip, Audio Channels (bars.mp4's matrix), Modify
  // Timecode, New and Edit Offline File, Synchronize, Merge Clips, and Source Settings.
  {
    name: 'dialog-nest',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      await run(page, [{ command: 'timeline.select', params: { clips: [10] } }])
    },
    dialog: 'clip.nest',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-nest-name').fill('Nest A')
      await kit.getByTestId('film-timeline-preview-badge').waitFor({ timeout: 10000 })
      await kit.locator('[data-testid^="film-clip-"][data-preview="added"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-make-subclip',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [{ command: 'source.open', params: { item: 8 } }, { command: 'project.setMarks', params: { item: 8, in: 254016000000, out: 254016000000 * 3 } }, { command: 'project.select', params: { items: [8] } }])
    },
    dialog: 'clip.makeSubclip',
    after: async (page, kit) => {
      await kit.locator('[data-testid^="film-project-item-"][data-preview="added"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-edit-subclip',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      const made = await run(page, [{ command: 'clip.makeSubclip', params: { item: 8, startFrame: 24, endFrame: 96, name: 'Bars middle' } }])
      await run(page, [{ command: 'project.select', params: { items: [made.completed[0].result.item] } }])
    },
    dialog: 'clip.editSubclip',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-editSubclip-convertToMaster').check()
      await kit.locator('[data-testid^="film-project-item-"][data-preview="changed"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-audio-channels',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [{ command: 'timeline.select', params: { clips: [] } }, { command: 'project.select', params: { items: [8] } }])
    },
    dialog: 'clip.audioChannels',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-audioChannels-format-mono').check()
      await kit.locator('[data-testid^="film-project-item-"][data-preview="changed"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-modify-timecode',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [{ command: 'project.select', params: { items: [8] } }])
    },
    dialog: 'clip.modifyTimecode',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-timecode-timecode').fill('01:00:00:00')
      await kit.locator('[data-testid^="film-project-item-"][data-preview="changed"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-offline-file',
    setup: projectPlain,
    dialog: 'file.newOfflineFile',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-offlineFile-name').fill('Lost Take')
      await kit.locator('[data-testid^="film-project-item-"][data-preview="added"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-edit-offline',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      const made = await run(page, [{ command: 'file.newOfflineFile', params: { name: 'Lost Take', tapeName: 'A001' } }])
      await run(page, [{ command: 'project.select', params: { items: [made.completed[0].result.item] } }])
    },
    dialog: 'clip.editOffline',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-editOffline-scene').fill('12')
      await kit.locator('[data-testid^="film-project-item-"][data-preview="changed"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-synchronize',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      const clips = await page.evaluate(async () => (await window.devHost.connection().ai.inspect()).details.sequence.video.map((track) => (track.items ?? [])[0]?.clip))
      await run(page, [{ command: 'timeline.select', params: { clips: clips.filter((each) => each != null).slice(0, 2), linked: false } }])
    },
    dialog: 'clip.synchronize',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-sync-method-in').check()
      await kit.locator('[data-testid^="film-clip-"][data-preview="changed"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-merge-clips',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      const made = await run(page, [{ command: 'file.newOfflineFile', params: { name: 'Tone', video: false, audio: true, seconds: 3 } }])
      await run(page, [{ command: 'timeline.select', params: { clips: [] } }, { command: 'project.select', params: { items: [8, made.completed[0].result.item] } }])
    },
    dialog: 'clip.mergeClips',
    after: async (page, kit) => {
      // Audio cannot synchronize a file with no sound: the preview turns off; In Points and Preview again.
      await kit.getByTestId('film-dialog-merge-method-in').check()
      await kit.getByTestId('film-dialog-preview').check()
      await kit.locator('[data-testid^="film-project-item-"][data-preview="added"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-source-settings',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [{ command: 'project.select', params: { items: [8] } }])
    },
    dialog: 'clip.sourceSettings',
    after: async (page) => page.waitForTimeout(400),
  },
  // Upstream's sequence dialogs (Task 13), each tab with its preview: Sequence Settings at a square
  // frame size (the Program monitor's picture at the new aspect), its Color Management and VR
  // Properties tabs, New Sequence's General and Tracks tabs (a ghost tab and a Project row), and
  // Sequence ▸ Color Management.
  ...['general', 'color', 'vr'].map((tab) => ({
    name: `dialog-sequence-settings-${tab}`,
    setup: timelineProject,
    dialog: 'sequence.settings',
    after: async (page, kit) => {
      for (const [field, value] of [['width', 1080], ['height', 1080]]) {
        const box = kit.locator(`[data-testid="film-dialog-sequenceSettings-${field}"] input`)
        await box.fill(String(value))
        await box.press('Tab')
      }
      if (tab !== 'general') await kit.getByTestId(`film-dialog-sequenceSettings-tab-${tab}`).click()
      await kit.locator('[data-testid="film-program-preview"][data-shown="true"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  })),
  ...['general', 'tracks'].map((tab) => ({
    name: `dialog-new-sequence-${tab}`,
    setup: timelineProject,
    dialog: 'file.newSequence',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-sequenceSettings-name').fill('Cut 2')
      if (tab !== 'general') await kit.getByTestId(`film-dialog-sequenceSettings-tab-${tab}`).click()
      await kit.locator('[data-testid^="film-sequence-tab-preview-"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  })),
  {
    name: 'dialog-color-settings',
    setup: timelineProject,
    dialog: 'sequence.colorSettings',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-colorDialog-wideGamut').check()
      await kit.locator('[data-testid="film-program-preview"][data-shown="true"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  // Upstream's track, sequence tool, and new item dialogs (Task 14), each with its preview: Add
  // Tracks (two audio tracks after A1, dashed), Delete Tracks (the empty video tracks struck
  // through), Normalize Mix Track (the gain it applies), Simplify Sequence (the copy compared
  // with its source), New Color Matte (red, its picker open), and Color Matte Color.
  {
    name: 'dialog-add-tracks',
    setup: timelineProject,
    dialog: 'sequence.addTracks',
    after: async (page, kit) => {
      for (const [field, value] of [['video-amount', 0], ['audio-amount', 2]]) {
        const box = kit.locator(`[data-testid="film-dialog-addTracks-${field}"] input`)
        await box.fill(String(value))
        await box.press('Tab')
      }
      await kit.getByTestId('film-dialog-addTracks-audio-placement').selectOption('1')
      await kit.locator('[data-testid="film-timeline-audio"] [data-testid^="film-preview-track-"][data-preview="added"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-delete-tracks',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'sequence.addTracks', params: { video: 1 } }], false))
    },
    dialog: 'sequence.deleteTracks',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-deleteTracks-video').check()
      await kit.locator('[data-testid^="film-preview-track-"][data-preview="removed"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-normalize-mix',
    setup: timelineProject,
    dialog: 'sequence.normalizeMixTrack',
    after: async (page, kit) => {
      const box = kit.locator('[data-testid="film-dialog-normalizeMix-db"] input')
      await box.fill('-6')
      await box.press('Tab')
      await kit.getByTestId('film-preview-result').waitFor({ timeout: 15000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-simplify',
    setup: async (page, kit) => {
      await timelineProject(page, kit)
      await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'sequence.addTracks', params: { video: 1 } }], false))
    },
    dialog: 'sequence.simplify',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-simplify-closeGaps').check()
      await kit.locator('[data-testid^="film-sequence-tab-preview-"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-new-color-matte',
    setup: projectShown,
    dialog: 'file.newColorMatte',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-colorMatte-color').click()
      const hex = kit.getByTestId('film-dialog-colorMatte-color-picker-hex')
      await hex.fill('d83a3a')
      await hex.press('Tab')
      // Escape closes the picker (not the dialog), so the fields and the strip show.
      await page.keyboard.press('Escape')
      await kit.getByTestId('film-dialog-colorMatte-color-popup').waitFor({ state: 'detached', timeout: 5000 })
      await kit.getByTestId('film-preview-item').and(kit.locator('[data-drawn]')).waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-matte-color',
    show: async (page, kit) => {
      await projectShown(page, kit)
      const made = await page.evaluate(async () => (await window.devHost.connection().ai.run([{ command: 'file.newColorMatte', params: { color: '#d83a3a', seconds: 2 } }], false)).completed[0].result?.item)
      const row = kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${made}"]`).first()
      await row.scrollIntoViewIfNeeded()
      await row.dblclick()
      await kit.getByTestId('film-dialog-matteColor').waitFor({ timeout: 10000 })
      await kit.getByTestId('film-dialog-matteColor-color').click()
      const hex = kit.getByTestId('film-dialog-matteColor-color-picker-hex')
      await hex.fill('3a8fd8')
      await hex.press('Tab')
      await kit.locator(`[data-testid="film-project-item-${made}"][data-preview="changed"]`).first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  // Upstream's Find, Create Search Bin, and Automate To Sequence (Task 15), each with its preview:
  // Find in the Project panel ("bars": both bars items highlighted, Match 1 of 2), Find on the
  // Timeline (every bars clip highlighted), Create Search Bin (the ghost bin listing its
  // matches), and Automate To Sequence (two items placed at the playhead).
  {
    name: 'dialog-find',
    show: async (page, kit) => {
      await projectShown(page, kit)
      await kit.getByTestId('film-project-view-list').click()
      await kit.getByTestId('film-project-list').waitFor()
      await kit.getByTestId('film-project-find').click()
      await kit.getByTestId('film-dialog-find').waitFor({ timeout: 10000 })
      await kit.getByTestId('film-dialog-find-row-0-text').fill('bars')
      await kit.locator('[data-testid="film-project"] [data-preview-selected]').first().waitFor({ timeout: 10000 })
      await kit.getByTestId('film-preview-result').waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-find-timeline',
    show: async (page, kit) => {
      await timelineProject(page, kit)
      await fromMenu(page, kit, 'window.panel.Timeline')
      await fromMenu(page, kit, 'edit.find')
      await kit.getByTestId('film-dialog-find').waitFor({ timeout: 10000 })
      await kit.getByTestId('film-dialog-find-row-0-text').fill('bars')
      await kit.locator('[data-testid^="film-clip-"][data-preview-selected]').nth(1).waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-search-bin',
    show: async (page, kit) => {
      await projectShown(page, kit)
      await run(page, [{ command: 'file.newOfflineFile', params: { name: 'Room Tone', video: false, audio: true, seconds: 3 } }])
      await kit.getByTestId('film-project-view-list').click()
      await kit.getByTestId('film-project-list').waitFor()
      await fromMenu(page, kit, 'file.newSearchBin')
      await kit.getByTestId('film-dialog-searchBin').waitFor({ timeout: 10000 })
      await kit.getByTestId('film-dialog-searchBin-name').fill('Movies')
      await kit.getByTestId('film-dialog-searchBin-column').selectOption('Media Type')
      await kit.getByTestId('film-dialog-searchBin-text').fill('Movie')
      await kit.locator('[data-testid^="film-project-search-bin-"][data-preview="added"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-automate',
    show: async (page, kit) => {
      await timelineProject(page, kit)
      const items = await page.evaluate(async () => {
        const all = (node) => [...(node?.item != null ? [node] : []), ...(node?.children ?? []).flatMap(all)]
        return all((await window.devHost.connection().ai.inspect()).details.project.root).filter((each) => each.type !== 'Sequence').map((each) => each.item)
      })
      const tone = (await run(page, [{ command: 'file.newOfflineFile', params: { name: 'Room Tone', video: false, audio: true, seconds: 3 } }])).completed[0].result?.item
      await run(page, [{ command: 'project.select', params: { items: [...items.slice(0, 1), tone] } }, { command: 'playhead.set', params: { seconds: 1 } }])
      await kit.getByTestId('film-project-automate').click()
      await kit.getByTestId('film-dialog-automate').waitFor({ timeout: 10000 })
      await kit.locator('[data-testid^="film-clip-"][data-preview="added"]').first().waitFor({ timeout: 10000 })
      await kit.locator('.kui-app').focus()
      await page.keyboard.press('\\')
      await page.waitForTimeout(800)
    },
  },
  // Upstream's Scene Edit Detection, Flash Cue Marker, Update Metadata, Properties, and Project
  // Settings (Task 16), and the marker dialog a Markers row opens, each with its preview: Scene
  // Edit Detection's ghost markers on the Source bar of a counting leader, the flash cue and the
  // marker's new colour in the Markers panel, Update Metadata's summary, the Properties of the
  // bars file, and Project Settings' two tabs with the new safe areas on the Program monitor.
  {
    name: 'dialog-scene-detect',
    show: async (page, kit) => {
      await timelineProject(page, kit)
      const leader = (await run(page, [{ command: 'file.newCountingLeader', params: {} }])).completed[0].result?.item
      await run(page, [{ command: 'timeline.place', params: { item: leader, track: 'V3', seconds: 0 } }])
      const clip = await page.evaluate(async (item) => (await window.devHost.connection().ai.inspect()).details.sequence.video.flatMap((track) => track.items ?? []).find((each) => each.item === item)?.clip, leader)
      await run(page, [{ command: 'timeline.select', params: { clips: [clip] } }, { command: 'source.open', params: { item: leader } }])
      await fromMenu(page, kit, 'clip.sceneEditDetection')
      await kit.getByTestId('film-dialog-sceneDetect').waitFor({ timeout: 10000 })
      await kit.getByTestId('film-dialog-sceneDetect-applyCuts').uncheck()
      await kit.getByTestId('film-dialog-sceneDetect-generateMarkers').check()
      const box = kit.locator('[data-testid="film-dialog-sceneDetect-sensitivity"] input')
      await box.fill('100')
      await box.press('Tab')
      await kit.locator('[data-testid="film-monitor-source"] .film-monitor-marker[data-preview="added"]').nth(2).waitFor({ timeout: 20000 })
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'dialog-flash-cue',
    show: async (page, kit) => {
      await timelineProject(page, kit)
      await fromMenu(page, kit, 'window.panel.Markers')
      await run(page, [{ command: 'playhead.set', params: { seconds: 6 } }])
      await fromMenu(page, kit, 'markers.addFlashCue')
      await kit.getByTestId('film-dialog-flashCue').waitFor({ timeout: 10000 })
      await kit.getByTestId('film-dialog-flashCue-name').fill('Cue A')
      await kit.getByTestId('film-dialog-flashCue-comment').fill('Fade the title in')
      await kit.locator('[data-testid^="film-markers-row-"][data-preview="added"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'dialog-marker',
    show: async (page, kit) => {
      await timelineProject(page, kit)
      await fromMenu(page, kit, 'window.panel.Markers')
      const row = kit.locator('[data-testid^="film-markers-row-"]').first()
      await row.waitFor({ timeout: 10000 })
      await row.dblclick()
      await kit.getByTestId('film-dialog-marker').waitFor({ timeout: 10000 })
      await kit.getByTestId('film-dialog-marker-name').fill('Pick up here')
      await kit.getByTestId('film-dialog-marker-comment').fill('The second take is better.')
      await kit.getByTestId('film-dialog-marker-color').selectOption('Red')
      await kit.locator('[data-testid^="film-markers-row-"][data-preview="changed"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'dialog-update-metadata',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [{ command: 'project.select', params: { items: [8] } }])
    },
    dialog: 'clip.updateMetadata',
    after: async (page, kit) => {
      await kit.getByTestId('film-preview-summary').waitFor({ timeout: 10000 })
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'dialog-properties',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [{ command: 'project.select', params: { items: [8] } }])
    },
    dialog: 'file.mediaProperties',
    after: async (page) => page.waitForTimeout(400),
  },
  ...['general', 'ingest'].map((tab) => ({
    name: `dialog-project-settings-${tab}`,
    setup: timelineProject,
    dialog: 'file.projectSettings.general',
    after: async (page, kit) => {
      const box = kit.locator('[data-testid="film-dialog-projectSettings-actionSafe-horizontal"] input')
      await box.fill('15')
      await box.press('Tab')
      await kit.locator('[data-testid="film-program-safe-margins"][data-preview="changed"]').waitFor({ timeout: 10000 })
      if (tab !== 'general') await kit.getByTestId(`film-dialog-projectSettings-tab-${tab}`).click()
      await page.waitForTimeout(800)
    },
  })),
  // Link Media (Task 17) on bars made offline, after Locate… (the dev host's picker answers
  // bars.mp4): the row online with its picture in the preview, the Project row online; and Make
  // Offline's question, the badge previewed on the row.
  {
    name: 'dialog-link-media',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [
        { command: 'media.makeOffline', params: { items: [8] } },
        { command: 'playhead.set', params: { seconds: 0.5 } },
      ])
    },
    dialog: 'media.linkMedia',
    after: async (page, kit) => {
      await kit.getByTestId('film-dialog-linkMedia-locate').click()
      await kit.locator('[data-testid="film-dialog-linkMedia-status-8"][data-preview="online"] canvas[data-drawn]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  {
    // Locate… answers bars.mp4 for another offline file: the engine's reason in the strip.
    name: 'dialog-link-media-mismatch',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [
        { command: 'file.newOfflineFile', params: { name: 'Tone', video: false, audio: true, seconds: 3 } },
        { command: 'media.makeOffline', params: { items: [8] } },
      ])
    },
    dialog: 'media.linkMedia',
    after: async (page, kit) => {
      await kit.locator('[data-testid^="film-dialog-linkMedia-row-"]', { hasText: 'Tone' }).click()
      await kit.getByTestId('film-dialog-linkMedia-locate').click()
      await kit.getByTestId('film-preview-result').waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'dialog-link-media-open',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [{ command: 'media.makeOffline', params: { items: [8] } }])
    },
    dialog: 'media.linkMedia',
    after: async (page) => page.waitForTimeout(600),
  },
  {
    name: 'dialog-make-offline',
    setup: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [
        { command: 'project.select', params: { items: [8] } },
        { command: 'playhead.set', params: { seconds: 0.5 } },
      ])
    },
    dialog: 'media.makeOffline',
    after: async (page, kit) => {
      await kit.locator('[data-testid="film-project-item-8"] [data-kit-ui-id="control:project.item.offline"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  // Metadata Display (Task 18) over the List view, Media Duration hidden and Label shown: the List
  // view previews the columns; and Manage Saved View Presets with a Restore previewed.
  {
    name: 'dialog-metadata-display',
    show: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [{ command: 'project.view.set', params: { view: 'list' } }])
      await kit.getByTestId('film-project-list').waitFor({ timeout: 10000 })
      await kit.getByTestId('film-workspace-menu-project').click()
      await kit.getByTestId('film-project-menu-metadataDisplay').click()
      await kit.getByTestId('film-dialog-metadata').waitFor({ timeout: 10000 })
      await kit.getByTestId('film-dialog-metadata-field-Media Duration').uncheck()
      await kit.getByTestId('film-dialog-metadata-field-Label').check()
      await kit.locator('.film-project-column[data-preview="added"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'dialog-manage-presets',
    show: async (page, kit) => {
      await projectPlain(page, kit)
      await run(page, [
        { command: 'project.view.set', params: { view: 'list' } },
        { command: 'project.viewPreset.saveAs', params: { name: 'Review' } },
        { command: 'project.view.set', params: { view: 'icon' } },
      ])
      await kit.getByTestId('film-workspace-menu-project').click()
      await kit.getByTestId('film-project-menu-manageViewPresets').click()
      await kit.getByTestId('film-dialog-presets').waitFor({ timeout: 10000 })
      await kit.getByTestId('film-dialog-presets-restore').click()
      await kit.getByTestId('film-project-list').waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  // The Freeform view (Task 19): the project's items and a bin's as cards, two stacked (×2 on the
  // stack's first card), one moved off the grid and selected, snapping on (its grid drawn); and
  // Freeform View Options with a larger clip size, the cards growing in the preview.
  {
    name: 'project-freeform',
    show: async (page, kit) => {
      await projectShown(page, kit)
      await freeformShown(page, kit)
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'dialog-freeform-options',
    show: async (page, kit) => {
      await projectShown(page, kit)
      await freeformShown(page, kit)
      await kit.getByTestId('film-workspace-menu-project').click()
      await kit.getByTestId('film-project-menu-freeformOptions').click()
      await kit.getByTestId('film-dialog-projectDialog').waitFor({ timeout: 10000 })
      await kit.locator('[data-testid="film-dialog-projectDialog-cardSize"] input').fill('180')
      await kit.locator('[data-testid="film-dialog-projectDialog-cardSize"] input').press('Tab')
      await kit.getByTestId('film-project-preview-badge').waitFor({ timeout: 10000 })
      await page.waitForTimeout(800)
    },
  },
  // Floating bin panels (Task 20): the Selects bin opened from its menu in a window over the
  // workspace, and Window ▸ New Project Panel's root window.
  {
    name: 'floating-bin',
    show: async (page, kit) => {
      await projectShown(page, kit)
      const bin = kit.locator('[data-testid^="film-project-bin-"][data-kit-ui-id="control:project.bin"]').first()
      await bin.click({ button: 'right' })
      await kit.getByTestId('film-project-bin-new-window').click()
      await kit.locator('.kui-floating-panel [data-testid^="film-project-thumb-"] canvas[data-drawn="1"]').first().waitFor({ timeout: 10000 }).catch(() => undefined)
      await page.waitForTimeout(600)
    },
  },
  { name: 'floating-project-panel', setup: projectShown, floating: 'projectPanel.newPanel' },
  // Previews drawn in the panels (Task 10), from dialog specs made here as the flow makes them:
  // Add Tracks on the Timeline, a new Color Matte in the Project panel, and a Flash Cue Marker on
  // the ruler and in the Markers panel.
  {
    name: 'preview-timeline',
    show: async (page, kit) => {
      await timelineProject(page, kit)
      await openFake(page, { id: 'sequence.addTracks', family: 'tracks', title: 'Add Tracks', prefix: 'addTracks', preview: ['timeline'], draft: { video: 1, audio: 1 } })
      // The new tracks go above V3 and below A3: the Timeline scrolls each half to show them.
      await kit.locator('[data-testid^="film-preview-track-"][data-preview="added"]').nth(1).waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'preview-project',
    show: async (page, kit) => {
      await projectShown(page, kit)
      await openFake(page, { id: 'file.newColorMatte', family: 'tracks', title: 'New Color Matte', prefix: 'colorMatte', preview: ['project'], draft: { color: '#3a8fd8', seconds: 2 } })
      const added = kit.locator('[data-testid^="film-project-item-"][data-preview="added"]').first()
      await added.waitFor({ timeout: 10000 })
      await added.scrollIntoViewIfNeeded()
      await added.locator('canvas[data-drawn="1"]').waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'preview-project-list',
    show: async (page, kit) => {
      await projectShown(page, kit)
      await kit.getByTestId('film-project-view-list').click()
      await kit.getByTestId('film-project-list').waitFor()
      await openFake(page, { id: 'file.newColorMatte', family: 'tracks', title: 'New Color Matte', prefix: 'colorMatte', preview: ['project'], draft: { color: '#3a8fd8', seconds: 2 } })
      await kit.locator('[data-testid^="film-project-item-"][data-preview="added"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'preview-markers',
    show: async (page, kit) => {
      await timelineProject(page, kit)
      await kit.getByTestId('film-menu-Window').click()
      await kit.getByTestId('film-control-window.panel.Markers').click()
      // The playhead away from the cue, so the cue's outline shows on its own.
      await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'playhead.set', params: { seconds: 3.5 } }], false))
      await page.waitForTimeout(400)
      await openFake(page, { id: 'markers.addFlashCue', family: 'menu', title: 'Flash Cue Marker', prefix: 'flashCue', preview: ['markers'], draft: { name: 'Cue Point 1', seconds: 6 } })
      await kit.locator('[data-testid^="film-markers-row-"][data-preview="added"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(600)
    },
  },
]

/** Opens a dialog from a spec made here (`window.filmPreview.open`, development builds), as `tests/flow.mjs` does. */
async function openFake(page, fake) {
  const frame = page.frames().find((candidate) => candidate.url().includes('index.html'))
  await frame.evaluate(
    (each) => window.filmPreview.open({ id: each.id, family: each.family, title: each.title, prefix: each.prefix, preview: each.preview, layout: [{ kind: 'heading', label: each.title }], defaults: () => ({ ...each.draft }) }),
    fake,
  )
  const dialog = page.frameLocator('#kit').getByTestId('film-dialog')
  await dialog.waitFor({ timeout: 10000 })
  // Over the Source monitor, so the panels it previews on stay in view.
  const title = await dialog.locator('h2').boundingBox()
  await page.mouse.move(title.x + 10, title.y + title.height / 2)
  await page.mouse.down()
  await page.mouse.move(40, 160, { steps: 6 })
  await page.mouse.up()
}

// Vite's root and config come from this file's place, so the script runs from any directory.
const web = fileURLToPath(new URL('..', import.meta.url))
const out = fileURLToPath(new URL('./shots/', import.meta.url))
mkdirSync(out, { recursive: true })
// No HMR and no file watching: another session's edit of web/src or a linked kit-editor file would
// otherwise make Vite reload the page mid-shot, which reopens the sample and shoots a fresh document.
const server = await createServer({ root: web, configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' })
await server.listen()
// Any reload or update Vite sends prints as it happens.
const started = Date.now()
const note = (text) => console.log(`NOTE ${((Date.now() - started) / 1000).toFixed(1)}s ${text}`)
{
  const hot = server.environments?.client?.hot ?? server.ws
  const send = hot.send.bind(hot)
  hot.send = (payload, ...rest) => {
    const type = typeof payload === 'string' ? payload : payload?.type
    if (type && type !== 'connected' && type !== 'ping') note(`vite sends ${type}${payload?.triggeredBy ? ` from ${payload.triggeredBy.split('/').slice(-3).join('/')}` : ''}`)
    return send(payload, ...rest)
  }
}
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await (which === 'chromium' ? chromium : webkit).launch()
let failures = 0
try {
  for (const size of SIZES) {
    for (const scheme of SCHEMES) {
      for (const state of [{ name: 'editor', show: async () => {} }, ...STATES].filter((each) => !only || only.includes(each.name))) {
        const context = await browser.newContext({ viewport: size })
        const page = await context.newPage()
        // The dev page loads once; a second load reopened the sample, and its shot would show that.
        let devPageLoads = 0
        page.on('framenavigated', (frame) => {
          if (frame !== page.mainFrame() || frame.url() === 'about:blank') return
          devPageLoads += 1
          if (devPageLoads > 1) note(`dev page reloaded (${state.name})`)
        })
        try {
          await page.goto(`${origin}/dev.html${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`)
          await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
          await page.evaluate((next) => window.devHost.setScheme(next), scheme)
          const kit = page.frameLocator('#kit')
          await kit.locator('.kui-app').waitFor()
          const editorFrame = page.frames().find((candidate) => candidate.url().includes('index.html'))
          // The scheme really took (lesson 11): the editor root's computed --kit-surface is the
          // scheme's, before the state comes up and again just before the shot.
          let shown = null
          for (let tries = 0; tries < 100 && (shown = await shownScheme(editorFrame)) !== scheme; tries += 1) await new Promise((resolve) => setTimeout(resolve, 100))
          if (shown !== scheme) throw new Error(`asked for the ${scheme} scheme, the editor's --kit-surface is ${shown ?? 'unset'}`)
          await page.waitForTimeout(800)
          await bringUp(state, page, kit)
          await page.waitForTimeout(300)
          const still = await shownScheme(editorFrame)
          if (still !== scheme) throw new Error(`asked for the ${scheme} scheme, the editor's --kit-surface is ${still ?? 'unset'} at the shot`)
          if (devPageLoads !== 1) throw new Error(`the dev page loaded ${devPageLoads} times: the document was reopened under the shot`)
          const file = `${out}${size.width}x${size.height}-${scheme}-${locale ? `${locale}-` : ''}${state.name}.png`
          await page.screenshot({ path: file })
          console.log(`wrote ${file}`)
        } catch (error) {
          failures += 1
          console.log(`FAIL ${size.width}x${size.height} ${scheme} ${state.name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
        } finally {
          await context.close()
        }
      }
    }
  }
} finally {
  await browser.close()
  await server.close()
}
process.exit(failures ? 1 : 0)
