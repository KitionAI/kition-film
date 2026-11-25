// The editor's flow in a real browser, through the development host: node tests/flow.mjs [chromium|webkit]
// Starts the Vite dev server itself, opens dev.html in Chinese, and prints PASS or FAIL per step.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { checkUiIds } from '@kition/sdk/dev-host/check-ui-ids'
import { CATALOGS } from '../src/strings.ts'
import { WEB_PANEL_IDS, WEB_WORKSPACES } from '../src/workspace/presets.ts'
import { readCatalog } from '../parity/i18n.mjs'

const which = process.argv[2] ?? 'chromium'
// The flow's page runs in Chinese (`dev.html?locale=zh-CN`); a second page or a fresh one opens in
// the browser's English. Steps match drawn text through the catalogs, never through literals.
const ZH = readCatalog(new URL('../src/i18n/upstream/zh-hans.tsv', import.meta.url)).table
/** Labels a step asked `zh` for that the catalog lacks: a step then expects English, and the last step fails on them. */
const zhMissing = new Set()
/** Upstream's English label as the zh-CN page draws it (its zh-CN catalog entry). */
const zh = (english) => {
  if (ZH.has(english)) return ZH.get(english)
  // Nothing to translate (a tool upstream gives no hint: an empty string).
  if (!/[A-Za-z]{2}/.test(english)) return english
  if (!zhMissing.has(english)) console.log(`NOTE zh(): no zh-CN entry for ${JSON.stringify(english)}`)
  zhMissing.add(english)
  return english
}
/** The editor's own string `key` as the zh-CN page draws it. */
const zt = (key, values = {}) => (CATALOGS['zh-CN'][key] ?? CATALOGS['en-US'][key]).replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match))
/** The editor's own string `key` in zh-CN, unfilled (for `pattern`). */
const ztRaw = (key) => CATALOGS['zh-CN'][key] ?? CATALOGS['en-US'][key]
/** A label template's placeholders filled in (upstream's `tlf!`), after `zh`. */
const filled = (template, values) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, () => String(value)), template)
/** `text` matched literally inside a RegExp: catalog text carries `(`, `.`, `+`, `?`. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * A RegExp of `template` (catalog text, escaped) with each `holes` placeholder a pattern: the
 * editor's own string (`ztRaw`) or an upstream label (`zh`); `start` and `end` anchor it.
 */
const pattern = (template, holes = {}, { start = false, end = false } = {}) =>
  new RegExp(`${start ? '^' : ''}${Object.entries(holes).reduce((text, [name, hole]) => text.replaceAll(escapeRegExp(`{${name}}`), () => hole), escapeRegExp(template))}${end ? '$' : ''}`)
const manifest = JSON.parse(readFileSync(new URL('../parity/film-upstream.json', import.meta.url), 'utf8'))
// Vite's root and config come from this file's place, so the flow runs from any directory.
const web = fileURLToPath(new URL('..', import.meta.url))
// No HMR and no file watching: another session's edit of web/src or a linked kit-editor file would
// otherwise make Vite reload the page mid-run, which reopens the sample and loses the flow's state.
const server = await createServer({ root: web, configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' })
await server.listen()
// What could reopen the document under the flow: a file change Vite hears of and the reload or
// update it sends for it, and every navigation of the dev page or its editor frame. Each prints as
// it happens, and a failure repeats them. The dev page navigates once; a second is a reload.
const reloads = []
const started = Date.now()
const note = (text) => {
  const line = `${((Date.now() - started) / 1000).toFixed(1)}s ${text}`
  reloads.push(line)
  console.log(`NOTE ${line}`)
}
for (const event of ['change', 'add', 'unlink']) server.watcher.on(event, (file) => note(`watcher ${event} ${file.split('/').slice(-3).join('/')}`))
{
  const hot = server.environments?.client?.hot ?? server.ws
  const send = hot.send.bind(hot)
  hot.send = (payload, ...rest) => {
    const type = typeof payload === 'string' ? payload : payload?.type
    if (type && type !== 'connected' && type !== 'ping') note(`vite sends ${type}${payload?.updates ? ` ${payload.updates.map((update) => update.path).join(',')}` : ''}${payload?.triggeredBy ? ` from ${payload.triggeredBy.split('/').slice(-3).join('/')}` : ''}`)
    return send(payload, ...rest)
  }
}
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await (which === 'webkit' ? webkit : chromium).launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
if (which === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
// Every AudioContext the editor makes, so a step can check that a play gesture got it running (WebKit starts one suspended).
await context.addInitScript(() => {
  const Original = window.AudioContext
  if (!Original) return
  window.audioContexts = []
  window.AudioContext = class extends Original {
    constructor(...args) {
      super(...args)
      window.audioContexts.push(this)
    }
  }
})
// The engine worker's requests by method, so a step can count the renders a playback asks for.
await context.addInitScript(() => {
  const Original = window.Worker
  if (!Original) return
  window.workerRequests = {}
  window.Worker = class extends Original {
    constructor(...args) {
      super(...args)
      const post = this.postMessage.bind(this)
      this.postMessage = (message, transfer) => {
        const method = message?.request?.method
        if (method) window.workerRequests[method] = (window.workerRequests[method] ?? 0) + 1
        return post(message, transfer)
      }
    }
  }
})
const page = await context.newPage()
const errors = []
let failures = 0
page.on('pageerror', (error) => errors.push(error.message))
let devPageLoads = 0
page.on('framenavigated', (frame) => {
  const url = frame.url()
  if (url === 'about:blank') return
  if (frame === page.mainFrame()) devPageLoads += 1
  note(`navigated ${frame === page.mainFrame() ? 'dev page' : 'frame'} ${url.replace(origin, '')}`)
})
// The editor frame's console errors (React's duplicate-key warning among them), for the steps that check them.
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
const step = (name, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check, tries = 60) => {
  for (let i = 0; i < tries; i += 1) {
    if (await check().catch(() => false)) return true
    await sleep(100)
  }
  return false
}
/**
 * What `read` answers once it is there (not null) and holds still: the same (`same`) over three
 * reads or more, at least 200 ms apart. The editor draws a control again after each change lands
 * (the Program overlay replaces a layer's box, handles and anchor cross on every paint; a list
 * re-renders a row; a dialog or a window places itself a frame after it shows), so a control read
 * once can be gone, or elsewhere, a moment later. Every read that places a pointer action or feeds
 * an assertion waits here first. Throws with the last read when it never settles (`what` names
 * it), or answers null with `{ orNull: true }` where a step reports a missing control itself.
 */
const heldStill = async (read, { same = (a, b) => JSON.stringify(a) === JSON.stringify(b), what = 'the value', orNull = false, tries = 100 } = {}) => {
  let last = null
  let since = 0
  let polls = 0
  let now = null
  const held = await until(async () => {
    now = await read()
    if (now == null || last == null || !same(now, last)) {
      last = now
      since = Date.now()
      polls = 1
      return false
    }
    polls += 1
    return polls >= 3 && Date.now() - since >= 200
  }, tries)
  if (held) return now
  if (orNull) return null
  throw new Error(`${what} never held still within ${tries * 100} ms; last read ${JSON.stringify(now)}`)
}
const boxesMatch = (a, b) => ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) < 0.5)
/** A control's box (`locator.boundingBox()`) once it is drawn and holds still (`heldStill`). */
const settledBox = (locator, options = {}) => heldStill(() => locator.boundingBox({ timeout: 1000 }).catch(() => null), { same: boxesMatch, what: `the box of ${locator}`, ...options })
/**
 * Polls the engine through the dev host until `predicate(state)` holds, and answers that state.
 * `state` is `inspect()` (`{ revision, details, … }`), with `history` (history.list's result) when
 * `{ history: true }`, and `results` by command (`results['source.inspect']`) for
 * `{ queries: [{ command, params }] }` (non-journaled reads such as `source.inspect`, `job.list`).
 * On timeout it throws with the last state and the last error, or answers null with
 * `{ orNull: true }`. Steps wait on the engine this way (lesson 7), never on a fixed timeout.
 */
async function waitForEngine(on, predicate, { history = false, queries = [], timeout = 10000, orNull = false } = {}) {
  const deadline = Date.now() + timeout
  let last = null
  let lastError = null
  for (;;) {
    try {
      last = await on.evaluate(
        async ([withHistory, reads]) => {
          const connection = window.devHost.connection()
          const state = await connection.ai.inspect()
          // The person's history (the History panel's read): an agent's history.list answers the
          // agent's own steps (KitModel 1.1 M12a), and the flow's edits are the person's.
          const history = withHistory ? await document.querySelector('#kit')?.contentWindow?.filmPreview?.history?.() ?? await window.filmPreview?.history?.() : undefined
          const completed = reads.length ? (await connection.ai.run(reads, false)).completed : []
          const results = Object.fromEntries(completed.map((each) => [each.command, each.result]))
          return { ...state, ...(withHistory ? { history } : {}), results }
        },
        [history, queries],
      )
      if (await predicate(last)) return last
    } catch (error) {
      lastError = error
    }
    if (Date.now() > deadline) {
      if (orNull) return null
      const shown = JSON.stringify({ revision: last?.revision, playhead: last?.details?.playhead, history: last?.history ? 'read' : undefined, results: last?.results }).slice(0, 400)
      throw new Error(`waitForEngine timed out after ${timeout} ms; last state ${shown}${lastError ? `; last error ${(lastError.message ?? String(lastError)).split('\n')[0]}` : ''}`)
    }
    await sleep(50)
  }
}
/** `n` animation frames in the editor frame of `on`: a change a click or a key starts has been drawn. */
const paintFrames = (on = page, n = 2) => {
  const frame = on.frames().find((candidate) => candidate.url().includes('index.html'))
  if (!frame) throw new Error('paintFrames: the editor frame (index.html) is not loaded')
  return frame.evaluate((count) => new Promise((resolve) => {
    const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve())
    next(count)
  }), n)
}
/**
 * A measured interval: playing for a while, holding a press, pacing pointer moves, or a window in
 * which nothing may happen. Never a wait for a result, which waits on the engine (`waitForEngine`)
 * or on the page (`until`, `paintFrames`).
 */
const hold = (ms, on = page) => on.waitForTimeout(ms)
/**
 * Waits until the engine's playhead (with `{ source: true }`, the Source monitor's) has read the
 * same for at least 250 ms over three polls or more: a stop has landed (the transport keeps no
 * engine state to read).
 */
const playheadSettled = (on = page, { source = false } = {}) => {
  let last
  let since = 0
  let polls = 0
  const read = (state) => (source ? state.results['source.inspect']?.playhead : state.details?.playhead)
  return waitForEngine(
    on,
    (state) => {
      const at = read(state)
      if (at === undefined || at !== last) {
        last = at
        since = Date.now()
        polls = 1
        return false
      }
      polls += 1
      return polls >= 3 && Date.now() - since >= 250
    },
    source ? { queries: [{ command: 'source.inspect', params: {} }] } : {},
  )
}
const inspect = () => page.evaluate(async () => window.devHost.connection().ai.inspect())
const details = async () => (await inspect()).details
// Every control the editor draws carries a declared Kit UI id (`web/src/filmUi.ts`): call
// `checkIds()` after showing each panel; the last step reports what it found. Strict: a control in
// a panel's body needs an id of its own, not its panel's.
const kitFrame = () => page.frames().find((candidate) => candidate.url().includes('index.html'))
// The person's undo history (the History panel's read) and the person's Undo (the editor's button):
// an agent's history.list and edit.undo work on the agent's own steps only (KitModel 1.1 M12a,
// KitAgent A7), and the flow's edits are the person's.
const agentHistory = async () => (await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'history.list', params: {} }], false))).completed[0].result?.undo ?? []
const personHistory = async () => (await kitFrame().evaluate(() => window.filmPreview.history()))?.undo ?? []
/**
 * Whose step is the latest undoable one: the flow edits as the person (keys, clicks, dialogs,
 * `personRun`) and, where a step tests the agent, as the agent (`agentRun`), and each has its own
 * history (M12a). The agent's steps are the newest while the person's history reads as it did
 * when the agent's last run ended (any person step or undo since makes the person's newer), so
 * `undoLatest` takes back the newest step whoever made it, as one shared history did.
 */
let agentNewest = null
const personNow = async () => JSON.stringify(await personHistory().catch(() => []))
/** Runs `steps` as the agent (`ai/run`), noting the agent steps it makes or takes back. */
const agentRun = async (steps) => {
  const person = await personNow()
  const before = (await agentHistory().catch(() => [])).length
  try {
    return await page.evaluate(async (list) => window.devHost.connection().ai.run(list, false), steps)
  } finally {
    const made = (await agentHistory().catch(() => [])).length - before
    const kept = agentNewest && agentNewest.person === person ? agentNewest.steps : 0
    const steps = kept + made
    agentNewest = steps > 0 ? { steps, person: await personNow() } : null
  }
}
/**
 * Runs `steps` (`{ command, params }`) one after another as the person, through the editor's own
 * `run` as a menu or a key runs a command (development builds' `filmPreview.run`), on the editor of
 * `on`; answers `{ completed: [{ command, result }] }` as `ai/run` does. The flow sets the
 * selection, the playheads, the open sequence and the Source monitor this way: an agent's `ai/run`
 * acts in an editor state of its own (KHP C3b) and leaves the person's as it was.
 */
const personRun = async (steps, on = page) => {
  const frame = on.frames().find((candidate) => candidate.url().includes('index.html'))
  if (!frame) throw new Error('personRun: the editor frame (index.html) is not loaded')
  const completed = await frame.evaluate(async (list) => {
    const done = []
    for (const { command, params } of list) done.push({ command, result: await window.filmPreview.run(command, params ?? {}) })
    return done
  }, steps)
  return { completed }
}
/** Takes back the newest step: the agent's with its `edit.undo`, the person's with Ctrl+Z. */
const undoLatest = async () => {
  if (agentNewest && agentNewest.person === (await personNow())) {
    await agentRun([{ command: 'edit.undo', params: {} }])
  } else {
    await page.frameLocator('#kit').locator('.kui-app').focus()
    await page.keyboard.press('ControlOrMeta+z')
  }
}
const personUndo = async (times = 1) => {
  for (let i = 0; i < times; i += 1) {
    const before = (await personHistory()).length
    await page.frameLocator('#kit').getByTestId('film-undo').click()
    await until(async () => (await personHistory()).length === before - 1)
  }
}
const idProblems = []
let undeclared = null
const checkIds = async () => {
  const elements = await page.evaluate(() => window.devHost.connection().elements()).catch((error) => {
    const message = (error?.message ?? String(error)).split('\n')[0]
    if (!/ui\/elements is not supported/.test(message)) throw error
    undeclared = message
    return null
  })
  if (!elements) return
  const frame = kitFrame()
  if (!frame) {
    idProblems.push('the editor frame (index.html) is not loaded')
    return
  }
  idProblems.push(...(await checkUiIds(frame, elements, { strict: true })))
}

try {
  await page.goto(`${origin}/dev.html?locale=zh-CN`)
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
  const kit = page.frameLocator('#kit')
  await waitForEngine(page, (state) => state.details?.sequence != null, { timeout: 30000 })
  await kit.getByTestId('film-program-zoom').waitFor({ timeout: 10000 })
  // ---- dialog previews (Task 9; every dialog task uses these): a dialog previews on the engine's
  // scratch session and leaves the document alone until OK.
  /** The preview as the editor holds it (`window.filmPreview`, development builds). */
  const previewState = () => kitFrame().evaluate(() => window.filmPreview.state())
  /** What a preview must leave alone: the revision, history.list, the replica's version, and inspect(). */
  const documentNow = async () => {
    const replica = await kitFrame().evaluate(() => window.filmPreview.replica())
    const state = await waitForEngine(page, () => true, { history: true })
    return { revision: state.revision, history: JSON.stringify(state.history), replica, inspect: JSON.stringify(state.details) }
  }
  const dialogShown = () => kit.getByTestId('film-dialog').count()
  /**
   * Where keys would go, for a failing key step's detail: the focused element and frame, open
   * dialogs and menus, the preview, the selection, the revision, and the history's last steps.
   */
  const keyState = async () => {
    const shown = await kitFrame().evaluate(() => {
      const active = document.activeElement
      return {
        active: active ? `${active.tagName.toLowerCase()}${active.getAttribute('data-testid') ? `[${active.getAttribute('data-testid')}]` : ''}${active.className && typeof active.className === 'string' ? `.${active.className.split(' ')[0]}` : ''}` : null,
        frame: document.querySelector('.kui-ws-frame[data-focused="true"]')?.getAttribute('data-panel') ?? null,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        menus: document.querySelectorAll('[role="menu"]').length,
        preview: window.filmPreview?.state().open ?? null,
      }
    })
    const engine = await waitForEngine(page, () => true, { history: true })
    return { ...shown, selection: engine.details?.sequence?.selection, revision: engine.revision, undo: (engine.history?.undo ?? []).slice(-3), redo: (engine.history?.redo ?? []).slice(-2) }
  }
  /**
   * What of a preview is still drawn: the Program monitor's badge and frame, the panels' Preview
   * badges, and every mark and ghost the Timeline, the Project panel, and the Markers panel draw.
   */
  const previewGhosts = async () =>
    (await kit.getByTestId('film-program-preview-badge').count()) +
    (await kit.getByTestId('film-program-preview').count()) +
    (await kit.locator('[data-testid$="-preview-badge"]').count()) +
    (await kit.locator('[data-preview], [data-preview-selected]').count())
  /** Waits until the open preview's serial reads the same for 300 ms over three polls or more: every change made has been previewed. */
  const previewSettled = async () => {
    let last = null
    let since = Date.now()
    let polls = 0
    return until(async () => {
      const shown = await previewState()
      if (!shown.open || shown.serial !== last) {
        last = shown.open ? shown.serial : null
        since = Date.now()
        polls = 1
        return false
      }
      polls += 1
      return polls >= 3 && Date.now() - since >= 300
    }, 100)
  }
  /**
   * For a dialog that opens on the document as it is: after two painted frames and the engine's
   * answer to a read (so a preview it began would have opened), none is open past `serial`.
   */
  const previewIdle = async (serial) => {
    await paintFrames()
    await waitForEngine(page, () => true)
    await paintFrames()
    const shown = await previewState()
    return !shown.open && shown.serial === serial
  }
  /** Waits for an open preview whose serial is past `serial`, from the engine's answer (lesson 7). */
  const previewOpened = async (serial) => until(async () => {
    const shown = await previewState()
    return shown.open && shown.serial > serial
  }, 100)
  /**
   * Opens a dialog (`open`), makes a change (`change`; null for a dialog previewed as it opens),
   * waits for the engine's preview of it, runs
   * `expectPreview` (true when the preview shows the change), then Cancel (or, with `escape`, the
   * Escape key in the field `escape` names, which also cancels): the revision, history, replica
   * version (read, never null), and inspect() are as before, and the badge and ghosts are gone.
   * With `idle`, the dialog opens on what the document already is and previews nothing until the
   * change (Sequence Settings sends only what changed): no preview may open before it.
   */
  async function previewThenCancel({ open, change, expectPreview, escape = null, idle = false }) {
    const before = await documentNow()
    const serial = (await previewState()).serial
    await open()
    await kit.getByTestId('film-dialog').waitFor({ timeout: 10000 })
    await checkIds()
    const begun = idle ? await previewIdle(serial) : await previewOpened(serial)
    const changedFrom = (await previewState()).serial
    if (change) await change()
    const previewed = (!change || (await previewOpened(changedFrom))) && (await previewSettled()) && (await expectPreview())
    if (escape) {
      await kit.locator(escape).focus()
      await page.keyboard.press('Escape')
    } else await kit.getByTestId('film-dialog-cancel').click()
    const closed = await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
    await paintFrames()
    const after = await documentNow()
    const ghosts = await previewGhosts()
    const unchanged = ['revision', 'history', 'replica', 'inspect'].filter((key) => before[key] !== after[key])
    return { ok: before.replica != null && begun && previewed && closed && unchanged.length === 0 && ghosts === 0, replica: before.replica != null, begun, previewed, closed, changed: unchanged, ghosts }
  }
  /**
   * The same dialog with OK (`change` null for one previewed as it opens): `steps` new history steps (one, unless the dialog runs several
   * commands: the engine has no history group, so New Sequence's two steps and the Manage
   * dialogs' actions each make their own), the document's state is the preview's (its project and
   * sequence as `previewInspect` showed them), and the preview is closed and drawn nowhere.
   * `landed`: for a dialog whose OK changes preferences only (the Project panel's view, columns,
   * and presets: no revision, no history step), true once OK's change is in the document, which
   * the flow waits for in place of a new revision.
   */
  async function previewThenOk({ open, change, expectPreview = async () => true, steps = 1, idle = false, landed = null }) {
    const before = await waitForEngine(page, () => true, { history: true })
    const serial = (await previewState()).serial
    await open()
    await kit.getByTestId('film-dialog').waitFor({ timeout: 10000 })
    if (idle) await previewIdle(serial)
    else await previewOpened(serial)
    const changedFrom = (await previewState()).serial
    // null: a dialog previewed as it opens, with nothing to change (Make Offline).
    if (change) await change()
    const previewed = (!change || (await previewOpened(changedFrom))) && (await previewSettled()) && (await expectPreview())
    const shown = await kitFrame().evaluate(() => window.filmPreview.inspect())
    await kit.getByTestId('film-dialog-ok').click()
    const entries = (state) => (state.history?.undo ?? []).length
    // Every step OK runs has landed (New Sequence's second, drop-frame, comes after the first).
    const done = landed ? await until(landed, 100) : true
    if (!landed) await waitForEngine(page, (state) => state.revision > before.revision && entries(state) >= entries(before) + steps, { history: true, orNull: true })
    // Read again: one read takes inspect() before history.list, so a step landing between them
    // (New Sequence's second) is in the history and not yet in that inspect().
    const after = await waitForEngine(page, (state) => landed != null || state.revision > before.revision, { history: true })
    const closed = await until(async () => (await dialogShown()) === 0 && !(await previewState()).open && (await previewGhosts()) === 0, 50)
    // The first place where the document and what the preview showed differ, or null.
    const differs = (a, b, path = '') => {
      // An untouched sequence has no saved playhead entry; its effective position is zero.
      // Fitting/repainting the monitor can materialize that zero without changing the edit.
      if (path === '.sequence.playhead' && ((a === null && b === 0) || (a === 0 && b === null))) return null
      if (JSON.stringify(a) === JSON.stringify(b)) return null
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          const found = differs(a[key], b[key], `${path}.${key}`)
          if (found) return found
        }
        return null
      }
      return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`
    }
    const difference = differs({ project: shown?.project, sequence: shown?.sequence }, { project: after.details.project, sequence: after.details.sequence })
    return { ok: previewed && done && closed && entries(after) === entries(before) + steps && difference == null, previewed, landed: done, closed, steps: entries(after) - entries(before), difference }
  }
  // A source file changing mid-run (another session's edit) reloads nothing: the flow keeps its document.
  {
    const loaded = [...server.environments.client.moduleGraph.fileToModulesMap.keys()].find((file) => /\/src\/.+\.tsx?$/.test(file))
    const loadsBefore = devPageLoads
    server.watcher.emit('change', loaded)
    await hold(1000)
    step('a source file changing mid-run does not reload the dev page', loaded != null && devPageLoads === loadsBefore, JSON.stringify({ loaded: loaded?.split('/').slice(-3).join('/'), loads: devPageLoads }))
  }
  // The harness's own wait: a timeout throws with the last state (or answers null when asked), and query results come by command.
  {
    const thrown = await waitForEngine(page, () => false, { timeout: 300 }).then(() => null, (error) => error.message)
    const tolerated = await waitForEngine(page, () => false, { timeout: 300, orNull: true })
    const read = await waitForEngine(page, (state) => state.results['history.list'] != null && state.results['job.list'] != null, { queries: [{ command: 'job.list', params: {} }, { command: 'history.list', params: {} }] })
    step('waitForEngine throws on timeout with the last state, answers null with orNull, and keys reads by command', /timed out after 300 ms; last state \{"revision":\d+/.test(thrown ?? '') && tolerated === null && Array.isArray(read?.results['job.list']), JSON.stringify({ thrown, tolerated }))
  }
  // The Program monitor opens at Fit: the canvas's own first fit, early in the frame's life, is
  // not a wheel zoom. A fresh page without this test's init scripts opens fast enough to show it.
  const openZooms = []
  for (const size of [{ width: 1440, height: 900 }, { width: 1100, height: 700 }]) {
    const fresh = await browser.newContext({ viewport: size })
    const freshPage = await fresh.newPage()
    await freshPage.goto(`${origin}/dev.html`)
    await freshPage.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
    await waitForEngine(freshPage, (state) => state.details?.sequence != null, { timeout: 30000 })
    await paintFrames(freshPage, 4)
    openZooms.push(await freshPage.frameLocator('#kit').getByTestId('film-program-zoom').textContent({ timeout: 5000 }).catch(() => null))
    await fresh.close()
  }
  openZooms.push(await kit.getByTestId('film-program-zoom').textContent({ timeout: 5000 }).catch(() => null))
  // The two fresh pages are English; the flow's own is Chinese.
  step('the Program zoom reads Fit on open', openZooms.every((label, index) => label === (index < 2 ? 'Fit' : zh('Fit'))), JSON.stringify(openZooms))
  const clips = async (track) => ((await details()).sequence[track] ?? []).flatMap((item) => item.items ?? [])
  step('Chinese menu names', (await kit.getByTestId('film-menu-Sequence').textContent()) === zh('Sequence') && zh('Sequence') !== 'Sequence')
  step('the lent clip is on the timeline', (await kit.getByTestId('film-track-Video 1').textContent())?.includes('bars.mp4'))
  // The engine's revision moves with every edit: steps wait for it, never for a timeout.
  const revision = async () => (await inspect()).revision
  // The Program monitor's transport (upstream `monitor.rs` `transport`): its Play-Stop Toggle.
  const programPlay = kit.getByTestId('film-program-transport-playback.toggle')
  await programPlay.click()
  await hold(900)
  await programPlay.click()
  await until(async () => (await details()).playhead > 0)
  step('plays and pauses', (await details()).playhead > 0)
  // The split acts at the playhead the editor shows: wait until the paused playhead is drawn, then for the edit's revision.
  await until(async () => !/^00:00:00[:;]00$/.test((await kit.getByTestId('film-timecode').textContent()) ?? ''))
  const splitFrom = await revision()
  // Add Edit (Cmd+K), the engine's key; upstream's monitors have no split button.
  await kit.locator('.kui-app').focus()
  await page.keyboard.press('ControlOrMeta+k')
  await until(async () => (await revision()) > splitFrom && (await clips('video')).length === 2)
  step('splits at the playhead', (await clips('video')).length === 2, JSON.stringify({ clips: (await clips('video')).map((item) => [item.start, item.duration]), playhead: (await details()).playhead, said: await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => null) }))
  const first = (await clips('video'))[0]
  const box = await settledBox(kit.getByTestId(`film-clip-${first.clip}`))
  await page.mouse.move(box.x + 10, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 140, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await until(async () => (await clips('video')).find((item) => item.clip === first.clip)?.start > first.start)
  step('drags a clip along its track', (await clips('video')).find((item) => item.clip === first.clip)?.start > first.start)
  // Keys go through upstream's key router and `invoke`; the Timeline has focus by default.
  await kit.locator('.kui-app').focus()
  const beforeStep = (await details()).playhead
  await page.keyboard.press('ArrowRight')
  await until(async () => (await details()).playhead > beforeStep)
  step('Right steps the playhead (playhead.stepForward)', (await details()).playhead > beforeStep)
  // Shift+Right is upstream's "step forward many", five frames by default (the editor used to step ten).
  const beforeMany = await details()
  await page.keyboard.press('Shift+ArrowRight')
  await until(async () => (await details()).playhead > beforeMany.playhead)
  const rate = beforeMany.sequence.settings.frame_rate
  const stepped = Math.round((((await details()).playhead - beforeMany.playhead) * rate.num) / (254016000000 * rate.den))
  step('Shift+Right steps five frames (playhead.stepForward5)', stepped === 5, `${stepped} frames`)
  await page.keyboard.press('i')
  await until(async () => (await details()).sequence.in != null)
  const marked = await details()
  step('I marks In at the playhead', marked.sequence.in != null && marked.sequence.in === marked.playhead, JSON.stringify({ in: marked.sequence.in, playhead: marked.playhead }))
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await until(async () => (await details()).playhead > marked.playhead)
  await page.keyboard.press('Shift+I')
  await until(async () => (await details()).playhead === marked.sequence.in)
  const went = await details()
  step('Shift+I goes to In and does not mark In', went.playhead === marked.sequence.in && went.sequence.in === marked.sequence.in, JSON.stringify({ in: went.sequence.in, playhead: went.playhead }))
  // A command that fails says why in the status bar, which a click clears (upstream's status):
  // Insert (`,`) with no clip in the Source monitor.
  await page.keyboard.press(',')
  const said = await until(async () => (await kit.getByTestId('film-message').count()) > 0)
  await kit.getByTestId('film-message').click().catch(() => undefined)
  step('a failed command shows in the status bar until clicked', said && (await kit.getByTestId('film-message').count()) === 0)
  // Playback, the shuttle, and source playback (upstream's `menus.rs` playback arms).
  const seekTo = (seconds) => personRun([{ command: 'playhead.set', params: { seconds } }])
  const seconds = async () => (await details()).playhead / 254016000000
  const kitWindow = kitFrame()
  const requests = () => kitWindow.evaluate(() => ({ ...window.workerRequests }))
  const hostChanges = () => page.evaluate(() => window.devHost.changes.length)
  const renders = (from, to) => (to.render ?? 0) + (to.renderArea ?? 0) - (from.render ?? 0) - (from.renderArea ?? 0)
  await seekTo(0)
  await kit.locator('.kui-app').focus()
  await page.keyboard.press(' ')
  await hold(200)
  // The window is timed in the page itself: a loaded machine stretches a 500 ms wait, and the
  // renders it may hold with it, so the bound is one render per sequence frame of the time that passed.
  const sampled = () => kitWindow.evaluate(() => ({ requests: { ...window.workerRequests }, at: performance.now() }))
  const programFrom = { ...(await sampled()), changes: await hostChanges() }
  await hold(500)
  const programTo = { ...(await sampled()), changes: await hostChanges() }
  const running = await kitWindow.evaluate(() => (window.audioContexts ?? []).some((audio) => audio.state === 'running'))
  await page.keyboard.press(' ')
  await playheadSettled()
  const spaced = await seconds()
  step('Space plays and pauses, with a running audio context', spaced > 0.3 && running, `playhead ${spaced.toFixed(2)} s, audio running ${running}`)
  // The sequence plays at 23.976 fps: at most one program render per sequence frame, and the host hears of no change.
  const programRenders = renders(programFrom.requests, programTo.requests)
  const elapsedMs = programTo.at - programFrom.at
  const frameBound = Math.ceil((elapsedMs / 1000) * (24000 / 1001)) + 1
  step('program playback renders at most once per sequence frame and sends no document/changed', programRenders > 0 && programRenders <= frameBound && programTo.changes === programFrom.changes, JSON.stringify({ renders: programRenders, in: `${Math.round(elapsedMs)} ms`, bound: frameBound, changes: programTo.changes - programFrom.changes }))
  // Audio Meters (upstream `panels/meters.rs`), on screen in Editing: the Mix's level shows while
  // the program plays, taken as the audio clock reaches it, and falls below the scale after a stop.
  await checkIds()
  const meterDb = () => kit.locator('[data-testid^="film-meters-channel-"]').evaluateAll((items) => Math.max(...items.map((item) => Number(item.dataset.db))))
  const meterFrom = await seconds()
  await kit.locator('.kui-app').focus()
  await page.keyboard.press(' ')
  let loudest = -Infinity
  const metered = await until(async () => (loudest = Math.max(loudest, await meterDb())) > -30, 40)
  await page.keyboard.press(' ')
  const fell = await until(async () => (await meterDb()) <= -60, 80)
  step('the Audio Meters show the Mix above -30 dB while it plays, and fall after a stop', metered && fell, JSON.stringify({ loudest, after: await meterDb() }))
  await seekTo(meterFrom)
  // After K the playhead stays where it stopped: the transport reads the same twice, and the engine agrees.
  await page.keyboard.press('l')
  await hold(400)
  await page.keyboard.press('k')
  await playheadSettled()
  const stoppedFirst = await kit.getByTestId('film-timecode').textContent()
  const stoppedAt = await seconds()
  await hold(400)
  const stoppedSecond = await kit.getByTestId('film-timecode').textContent()
  step('after K the program playhead reads the same twice', stoppedFirst === stoppedSecond && stoppedAt === (await seconds()) && stoppedAt > 0, JSON.stringify({ stoppedFirst, stoppedSecond, stoppedAt }))
  const shuttle = async (presses) => {
    await seekTo(0)
    await waitForEngine(page, (state) => state.details?.playhead === 0)
    for (let press = 0; press < presses; press += 1) await page.keyboard.press('l')
    await hold(600)
    await page.keyboard.press('k')
    await playheadSettled()
    return seconds()
  }
  const once = await shuttle(1)
  const twice = await shuttle(2)
  step('L twice plays faster than L once', twice > once * 1.4, `${once.toFixed(2)} s at 1x, ${twice.toFixed(2)} s at 2x after 600 ms`)
  const bars = await page.evaluate(async () => {
    const find = (node) => (node?.name?.includes('bars') && node.item != null ? node.item : (node?.children ?? []).map(find).find((id) => id != null))
    return find((await window.devHost.connection().ai.inspect()).details.project?.root)
  })
  await personRun([{ command: 'source.open', params: { item: bars } }])
  await kit.getByTestId('film-source').waitFor({ timeout: 10000 })
  // The Source monitor's timecode (`film.ts` `timecode`) at the bars clip's 24 fps.
  const sourceTimecode = (at) => {
    const frames = Math.floor(at * 24 + 1e-6)
    const pad = (value) => String(value).padStart(2, '0')
    const total = Math.floor(frames / 24)
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(frames % 24)}`
  }
  const sourceAt = async () => (await personRun([{ command: 'source.inspect', params: {} }])).completed[0].result.playhead / 254016000000
  await seekTo(0.5)
  const programBefore = await seconds()
  const sourceBefore = await sourceAt()
  await kit.getByTestId('film-source').click()
  await kit.locator('.kui-app').focus()
  // Frame steps with Source focused move the source playhead, and the Source monitor shows it.
  const shownBefore = await kit.getByTestId('film-source-time').textContent()
  for (let press = 0; press < 5; press += 1) await page.keyboard.press('ArrowRight')
  // The steps run one after another; wait for the fifth.
  await until(async () => Math.round((await sourceAt()) * 24) === 5)
  await until(async () => (await kit.getByTestId('film-source-time').textContent()) === sourceTimecode(5 / 24))
  const stepped5 = await sourceAt()
  const shownStepped = await kit.getByTestId('film-source-time').textContent()
  step('Right x5 with Source focused moves the source playhead, and the Source monitor shows it', shownStepped !== shownBefore && shownStepped === sourceTimecode(stepped5) && Math.round(stepped5 * 24) === 5, JSON.stringify({ shownBefore, shownStepped, engine: stepped5 }))
  await personRun([{ command: 'source.setPlayhead', params: { frame: 0 } }])
  // The program's last play (L, then K) has fallen below the meters' scale before the Source plays.
  const metersQuiet = await until(async () => (await meterDb()) <= -60, 80)
  await page.keyboard.press(' ')
  await hold(200)
  const sourceFrom = { requests: await requests(), changes: await hostChanges() }
  // Upstream meters the Mix only: the Source clip's own sound leaves the Audio Meters silent.
  let sourceLoudest = -Infinity
  for (let sample = 0; sample < 5; sample += 1) {
    await hold(100)
    sourceLoudest = Math.max(sourceLoudest, await meterDb())
  }
  const sourceTo = { requests: await requests(), changes: await hostChanges() }
  await page.keyboard.press('k')
  await playheadSettled(page, { source: true })
  step('source playback asks no program render and sends no document/changed', renders(sourceFrom.requests, sourceTo.requests) === 0 && sourceTo.changes === sourceFrom.changes, JSON.stringify({ renders: renders(sourceFrom.requests, sourceTo.requests), changes: sourceTo.changes - sourceFrom.changes }))
  const sourceShownFirst = await kit.getByTestId('film-source-time').textContent()
  await hold(400)
  const sourceShownSecond = await kit.getByTestId('film-source-time').textContent()
  const sourceAfter = await sourceAt()
  const programAfter = await seconds()
  step('after K the Source monitor reads the same twice, where the engine stopped', sourceShownFirst === sourceShownSecond && sourceShownFirst === sourceTimecode(sourceAfter), JSON.stringify({ sourceShownFirst, sourceShownSecond, engine: sourceAfter }))
  step('the Audio Meters stay below the scale while the Source clip plays', metersQuiet && sourceLoudest <= -60, JSON.stringify({ metersQuiet, sourceLoudest }))
  step('Space with Source focused plays the Source clip, not the sequence', sourceAfter > sourceBefore + 0.3 && programAfter === programBefore, JSON.stringify({ sourceBefore, sourceAfter, programBefore, programAfter, said: await kit.getByTestId('film-message').textContent({ timeout: 500 }).catch(() => null) }))
  // The Source and Program monitors (upstream `monitor.rs`, `monitor_view.rs`, `source_range.rs`, `source_drag.rs`).
  {
    const sourceInspect = async () => (await personRun([{ command: 'source.inspect', params: {} }])).completed[0].result
    const litPixels = (selector) =>
      kitFrame().evaluate((css) => {
        const canvas = document.querySelector(css)
        if (!canvas || !canvas.width) return 0
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
        let count = 0
        for (let at = 0; at < data.length; at += 16) if (data[at] + data[at + 1] + data[at + 2] > 60) count += 1
        return count
      }, selector)
    const sourceLit = await until(async () => (await litPixels('[data-testid="film-source"] canvas')) > 100)
    step('the Source monitor draws its clip, not black', sourceLit, `${await litPixels('[data-testid="film-source"] canvas')} lit samples`)
    // I and O with Source focused mark the clip, and leave the sequence's In and Out alone (upstream's `targets_source`).
    const sequenceMarks = async () => {
      const sequence = (await details()).sequence
      return JSON.stringify([sequence.in ?? null, sequence.out ?? null])
    }
    const marksBefore = await sequenceMarks()
    await personRun([{ command: 'project.setMarks', params: { in: null, out: null } }, { command: 'source.setPlayhead', params: { frame: 6 } }])
    await until(async () => (await sourceInspect()).markIn == null)
    await kit.getByTestId('film-source').click()
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('i')
    await until(async () => (await sourceInspect()).markIn != null)
    await personRun([{ command: 'source.setPlayhead', params: { frame: 30 } }])
    await until(async () => Math.round(((await sourceInspect()).playhead / 254016000000) * 24) === 30)
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('o')
    await until(async () => (await sourceInspect()).markOut != null)
    const sourceMarked = await sourceInspect()
    const frameOf = (ticks) => (ticks == null ? null : Math.round((ticks / 254016000000) * 24))
    step('I and O with Source focused mark the Source clip; the sequence In and Out are unchanged', frameOf(sourceMarked.markIn) === 6 && frameOf(sourceMarked.markOut) === 30 && (await sequenceMarks()) === marksBefore, JSON.stringify({ in: frameOf(sourceMarked.markIn), out: frameOf(sourceMarked.markOut), sequence: [marksBefore, await sequenceMarks()] }))
    // The scrub bar shows the marked range: the duration reads In to Out (25 frames at 24 fps).
    const durationShown = await until(async () => (await kit.getByTestId('film-source-duration').textContent()) === '00:00:01:01')
    step('the Source duration reads the marked In to Out', durationShown, await kit.getByTestId('film-source-duration').textContent())
    // Dragging the In handle on the scrub bar moves the mark in one project.setMarks.
    const bar = await settledBox(kit.getByTestId('film-source-scrub'))
    const inHandle = await settledBox(kit.locator('[data-testid="film-source-scrub"] [data-edge="in"]'))
    const handleFrom = await revision()
    await page.mouse.move(inHandle.x + inHandle.width / 2, bar.y + bar.height / 2)
    await page.mouse.down()
    await page.mouse.move(inHandle.x + inHandle.width / 2 + 24, bar.y + bar.height / 2, { steps: 6 })
    await page.mouse.up()
    const handleMoved = await until(async () => (await revision()) > handleFrom && frameOf((await sourceInspect()).markIn) > 6)
    step('dragging the Source In handle moves the In mark, the Out stays', handleMoved && frameOf((await sourceInspect()).markOut) === 30, JSON.stringify({ in: frameOf((await sourceInspect()).markIn), out: frameOf((await sourceInspect()).markOut) }))
    await personRun([{ command: 'project.setMarks', params: { in: 6 * 10584000000, out: 30 * 10584000000 } }])
    await until(async () => frameOf((await sourceInspect()).markIn) === 6)
    // , with Source focused inserts the marked range at the program playhead; undo takes it out.
    const v1Count = async () => (await clips('video')).length
    const insertFrom = { count: await v1Count(), revision: await revision() }
    await kit.getByTestId('film-source').click()
    await kit.locator('.kui-app').focus()
    await page.keyboard.press(',')
    const inserted = await until(async () => (await revision()) > insertFrom.revision && (await v1Count()) > insertFrom.count)
    const insertedDuration = inserted ? Math.max(...(await clips('video')).map((item) => item.duration).filter((duration) => Math.round((duration / 254016000000) * 24) === 25), 0) : 0
    step(', with Source focused inserts the marked range into the sequence', inserted && insertedDuration > 0, JSON.stringify({ before: insertFrom.count, after: await v1Count(), said: await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => null) }))
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('ControlOrMeta+z')
    await until(async () => (await v1Count()) === insertFrom.count)
    // Dragging the Source picture onto V1 shows the drop preview over the track, and places the marked range there.
    const lane = await settledBox(kit.locator('.film-tl-lane').first())
    const picture = await settledBox(kit.getByTestId('film-source'))
    const dropFrom = { count: await v1Count(), revision: await revision() }
    const from = { x: picture.x + picture.width / 2, y: picture.y + picture.height / 2 }
    const to = { x: lane.x + lane.width * 0.85, y: lane.y + lane.height / 2 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // WebKit delivers a drag's events a beat behind the pointer: the moves are paced, and a last nudge lands on the lane.
    for (let i = 1; i <= 12; i += 1) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12)
      await hold(40)
    }
    await page.mouse.move(to.x + 2, to.y)
    const previewed = await until(async () => (await kit.getByTestId('film-timeline-drop').count()) === 1, 20)
    await page.mouse.up()
    const placed = await until(async () => (await revision()) > dropFrom.revision && (await v1Count()) === dropFrom.count + 1)
    const placedClip = placed ? (await clips('video')).find((item) => Math.round((item.sourceIn / 254016000000) * 24) === 6 && Math.round((item.duration / 254016000000) * 24) === 25) : null
    step('dragging the Source picture onto V1 previews the drop and places the marked range', previewed && placed && placedClip != null, JSON.stringify({ previewed, placed, clips: (await clips('video')).map((item) => [item.start, item.sourceIn, item.duration]) }))
    if (placed) {
      await kit.locator('.kui-app').focus()
      await page.keyboard.press('ControlOrMeta+z')
      await until(async () => (await v1Count()) === dropFrom.count)
    }
    await personRun([{ command: 'project.setMarks', params: { in: null, out: null } }])
    // Program: Paused Resolution 1/4 from the wrench: once the engine takes the scale, the canvas is painted again, and drawn.
    const programCanvas = '[data-testid="film-program"] canvas'
    const paints = async () => {
      const counts = await requests()
      return (counts.render ?? 0) + (counts.renderArea ?? 0)
    }
    /**
     * Opens the Program wrench's Paused Resolution submenu until `row` shows: the wrench's menu
     * closes after a row is chosen, and a hover that lands while it still closes opens nothing.
     * Answers the tries it took.
     */
    const openWrenchRow = async (row) => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        if ((await kit.locator('[role="menu"]').count()) === 0) await kit.getByTestId('film-program-settings').click()
        await kit.locator('[data-kit-ui-id="menu:View/Paused Resolution"]').hover({ timeout: 3000 }).catch(() => undefined)
        if (await row.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) return attempt
        await page.keyboard.press('Escape')
        await until(async () => (await kit.locator('[role="menu"]').count()) === 0, 20)
      }
      return 0
    }
    await openWrenchRow(kit.getByTestId('film-program-settings-pausedRes-quarter'))
    await kit.getByTestId('film-program-settings-pausedRes-quarter').waitFor()
    // The wrench and its submenu are open: every row carries a declared id.
    await checkIds()
    const paintedAt = await paints()
    await kit.getByTestId('film-program-settings-pausedRes-quarter').click()
    // The scale shows once the engine has taken it; the repaint that follows paints at it.
    const quartered = await until(async () => (await kit.getByTestId('film-program').getAttribute('data-render-scale')) === '0.25')
    const repainted = await until(async () => (await paints()) > paintedAt)
    const quarterLit = await until(async () => (await litPixels(programCanvas)) > 100)
    step('Paused Resolution 1/4: the engine renders the Program at a quarter, the canvas is painted again, and still drawn', quartered && repainted && quarterLit, JSON.stringify({ scale: await kit.getByTestId('film-program').getAttribute('data-render-scale'), repainted, lit: await litPixels(programCanvas) }))
    const fullRow = kit.getByTestId('film-program-settings-pausedRes-full')
    const opened = await openWrenchRow(fullRow)
    await fullRow.click({ timeout: 5000 }).catch(async (error) => {
      throw new Error(`Paused Resolution Full did not take the click: ${error.message.split('\n')[0]}; ${JSON.stringify({ opened, ...(await keyState()) })}`)
    })
    await until(async () => (await kit.getByTestId('film-program').getAttribute('data-render-scale')) !== '0.25')
    // The canvas's view (zoom, and the document point at its top left), and the sequence's size.
    const settings = (await details()).sequence.settings
    const canvasView = async () => {
      const [zoom, x, y] = ((await kit.getByTestId('film-program').getAttribute('data-view')) ?? '').split(' ').map(Number)
      return { zoom, x, y }
    }
    /** The picture's box on the page: the sequence frame at the canvas's view. */
    const pictureBox = async () => {
      const view = await canvasView()
      const region = await kit.locator(programCanvas).first().boundingBox()
      return { x: region.x - view.x * view.zoom, y: region.y - view.y * view.zoom, width: settings.width * view.zoom, height: settings.height * view.zoom }
    }
    const sameBox = (a, b) => a && b && ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 1.5)
    // Safe Margins from the wrench covers exactly the picture, and follows it when the picture is magnified.
    await kit.getByTestId('film-program-settings').click()
    await kit.getByTestId('film-program-settings-safeMargins').click()
    const marginsFit = await until(async () => sameBox(await kit.getByTestId('film-program-safe-margins').boundingBox(), await pictureBox()))
    const dpr = await kitFrame().evaluate(() => window.devicePixelRatio || 1)
    await kit.getByTestId('film-program-zoom').click()
    await kit.getByTestId('film-program-zoom-200').waitFor()
    await checkIds()
    await kit.getByTestId('film-program-zoom-200').click()
    // 200%: two frame pixels per device pixel, about the sequence's centre.
    const zoomed = await until(async () => {
      const view = await canvasView()
      const region = await kit.locator(programCanvas).first().boundingBox()
      const centre = { x: view.x + region.width / 2 / view.zoom, y: view.y + region.height / 2 / view.zoom }
      return Math.abs(view.zoom - 2 / dpr) < 1e-6 && Math.abs(centre.x - settings.width / 2) < 2 && Math.abs(centre.y - settings.height / 2) < 2 && (await kit.getByTestId('film-program-zoom').textContent()) === '200%'
    })
    const marginsZoomed = await until(async () => sameBox(await kit.getByTestId('film-program-safe-margins').boundingBox(), await pictureBox()))
    const zoomedView = await canvasView()
    await kit.getByTestId('film-program-zoom').click()
    await kit.getByTestId('film-program-zoom-fit').click()
    const fitted = await until(async () => (await canvasView()).zoom < zoomedView.zoom && (await kit.getByTestId('film-program-zoom').textContent()) === zh('Fit'))
    step('Safe Margins covers the Program picture and follows it at 200%', marginsFit && marginsZoomed, JSON.stringify({ marginsFit, marginsZoomed, margins: await kit.getByTestId('film-program-safe-margins').boundingBox(), picture: await pictureBox() }))
    step('the Program zoom dropdown magnifies to 200% about the centre, and Fit fits again', zoomed && fitted, JSON.stringify({ zoomed, fitted, zoomedView, view: await canvasView(), dpr }))
    await kit.getByTestId('film-program-settings').click()
    await kit.getByTestId('film-program-settings-safeMargins').click()
    await until(async () => (await kit.getByTestId('film-program-safe-margins').count()) === 0)
    // A wheel zoom (Ctrl+wheel on the canvas) shows its percentage, and another view change (Safe Margins off) keeps it.
    const region = await kit.locator(programCanvas).first().boundingBox()
    const fitZoom = (await canvasView()).zoom
    // A pinch or Ctrl+wheel, as the browser reports it (WebKit's test driver does not send the modifier with a wheel).
    await kitFrame().evaluate(() => {
      const canvas = document.querySelector('[data-testid="film-program"] canvas')
      const box = canvas.getBoundingClientRect()
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true }))
    })
    const wheelZoomed = await until(async () => (await canvasView()).zoom > fitZoom * 1.2 && /^\d+%$/.test((await kit.getByTestId('film-program-zoom').textContent()) ?? ''))
    const wheelView = await canvasView()
    const wheelLabel = await kit.getByTestId('film-program-zoom').textContent()
    await kit.getByTestId('film-program-settings').click()
    await kit.getByTestId('film-program-settings-highQuality').click()
    await paintFrames()
    await kit.getByTestId('film-program-settings').click()
    await kit.getByTestId('film-program-settings-highQuality').click()
    await paintFrames()
    const kept = await canvasView()
    step('a wheel zoom shows its percentage and survives another view change', wheelZoomed && /%$/.test(wheelLabel ?? '') && wheelLabel !== '200%' && Math.abs(kept.zoom - wheelView.zoom) < 1e-6 && (await kit.getByTestId('film-program-zoom').textContent()) === wheelLabel, JSON.stringify({ fitZoom, wheelView, wheelLabel, kept }))
    await kit.getByTestId('film-program-zoom').click()
    await kit.getByTestId('film-program-zoom-fit').click()
    await until(async () => (await canvasView()).zoom <= fitZoom + 1e-6)
    // Show Transport Controls off hides the Source transport; on brings it back.
    await kit.getByTestId('film-source-settings').click()
    await kit.getByTestId('film-source-settings-showTransport').click()
    const hidden = await until(async () => (await kit.getByTestId('film-source-transport').count()) === 0)
    await kit.getByTestId('film-source-settings').click()
    await kit.getByTestId('film-source-settings-showTransport').click()
    step('Show Transport Controls hides and shows the Source transport', hidden && (await until(async () => (await kit.getByTestId('film-source-transport').count()) === 1)))
    await checkIds()
    // ---- display modes, the Comparison View, and the Source waveform (Task 21; upstream monitor_view.rs).
    {
      const TPS = 254016000000
      /** Lit samples of a canvas, and how many of them are not grey (r, g, b apart). */
      const tones = (selector) =>
        kitFrame().evaluate((css) => {
          const canvas = document.querySelector(css)
          if (!canvas || !canvas.width) return { lit: 0, coloured: 0 }
          const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
          let lit = 0
          let coloured = 0
          for (let at = 0; at < data.length; at += 16) {
            if (data[at] + data[at + 1] + data[at + 2] > 60) lit += 1
            if (Math.abs(data[at] - data[at + 1]) > 2 || Math.abs(data[at + 1] - data[at + 2]) > 2) coloured += 1
          }
          return { lit, coloured }
        }, selector)
      /** Opens a monitor's wrench and chooses `row`, through the RGBA Channels submenu when `rgba`; answers the tries it took. */
      const chooseWrench = async (which, row, rgba = false) => {
        const target = kit.getByTestId(`film-${which}-settings-${row}`)
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          if ((await kit.locator('[role="menu"]').count()) === 0) await kit.getByTestId(`film-${which}-settings`).click()
          if (rgba) await kit.locator('[data-kit-ui-id="control:monitor.settings.rgbaChannels"]').hover({ timeout: 3000 }).catch(() => undefined)
          if (await target.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) {
            if (rgba && attempt === 1) await checkIds()
            await target.click()
            return attempt
          }
          await page.keyboard.press('Escape')
          await until(async () => (await kit.locator('[role="menu"]').count()) === 0, 20)
        }
        return 0
      }
      // Program ▸ Red: the bars' red channel in grey, from a reduced copy drawn over the canvas.
      await personRun([{ command: 'playhead.set', params: { seconds: 0.5 } }])
      await until(async () => (await tones(programCanvas)).coloured > 20)
      const composite = await tones(programCanvas)
      await chooseWrench('program', 'display-red', true)
      const channelShown = await until(async () => (await kit.locator('[data-testid="film-program-channel"][data-shown="true"]').count()) === 1)
      const red = await tones('[data-testid="film-program-channel"]')
      const redLabel = await kit.getByTestId('film-program-mode').textContent({ timeout: 2000 }).catch(() => null)
      step('Program ▸ Red shows a grey picture: the colour bars\' red channel, labelled Red', channelShown && composite.coloured > 20 && red.lit > 20 && red.coloured === 0 && redLabel === zh('Red'), JSON.stringify({ composite, red, redLabel }))
      // Playing in Red: the channel picture follows the clock from reduced copies, the canvas is not painted, and the dropped-frame dot shows.
      // The click that focuses the Program monitor selects the clip under it (phase 5): its render
      // lands before the playback this step measures, so the step counts from after it.
      const selectedBefore = JSON.stringify((await details()).sequence.selection)
      const paintsBefore = await paints()
      await kit.getByTestId('film-program').click()
      if (await until(async () => JSON.stringify((await details()).sequence.selection) !== selectedBefore, 20)) await until(async () => (await paints()) > paintsBefore, 40)
      const channelFrom = { requests: await requests(), ticks: await kit.getByTestId('film-program-channel').getAttribute('data-ticks') }
      await kit.locator('.kui-app').focus()
      await page.keyboard.press(' ')
      const dotShown = await until(async () => (await kit.getByTestId('film-program-dropped').count()) === 1, 30)
      const dotState = await kit.getByTestId('film-program-dropped').getAttribute('data-dropped', { timeout: 1000 }).catch(() => null)
      // The channel picture's frames as the clock moves (each drawn picture says its time).
      const channelTimes = new Set()
      for (let sample = 0; sample < 6; sample += 1) {
        await hold(100)
        channelTimes.add(await kit.getByTestId('film-program-channel').getAttribute('data-ticks'))
      }
      const channelTo = { requests: await requests(), ticks: await kit.getByTestId('film-program-channel').getAttribute('data-ticks') }
      await page.keyboard.press('k')
      await playheadSettled()
      const dotGone = await until(async () => (await kit.getByTestId('film-program-dropped').count()) === 0, 30)
      step('playing in Red draws the channel picture as the clock moves, paints no canvas frame, and shows the dropped-frame dot until the stop', renders(channelFrom.requests, channelTo.requests) === 0 && channelTimes.size >= 3 && channelTo.ticks !== channelFrom.ticks && dotShown && ['true', 'false'].includes(dotState) && dotGone, JSON.stringify({ renders: renders(channelFrom.requests, channelTo.requests), frames: channelTimes.size, ticks: [channelFrom.ticks, channelTo.ticks], dotShown, dotState, dotGone }))
      await chooseWrench('program', 'display-composite')
      const back = await until(async () => (await kit.getByTestId('film-program-channel').count()) === 0 && (await kit.getByTestId('film-program-mode').count()) === 0)
      step('Composite Video takes the channel picture away', back)
      // Comparison View: the reference on the left, the current picture on the right; ◀ and ▶ step the reference one frame, Set takes the playhead.
      await personRun([{ command: 'playhead.set', params: { seconds: 1 } }])
      await until(async () => Math.abs((await seconds()) - 1) < 0.05)
      const enteredAt = (await details()).playhead
      // Magnified to 200% first: the Comparison View fits both pictures, and leaving it magnifies again.
      await kit.getByTestId('film-program-zoom').click()
      await kit.getByTestId('film-program-zoom-200').click()
      await until(async () => Math.abs((await canvasView()).zoom - 2 / dpr) < 1e-6)
      await chooseWrench('program', 'display-comparison')
      const referenceCanvas = '[data-testid="film-program-reference"] canvas'
      const referenceDrawn = await until(async () => (await kit.locator(`${referenceCanvas}[data-shown="true"]`).count()) === 1)
      const referenceBox = await settledBox(kit.locator(referenceCanvas), { orNull: true })
      const currentBox = await settledBox(kit.locator(programCanvas).first(), { orNull: true })
      const pictures = { reference: (await tones(referenceCanvas)).lit, current: (await tones(programCanvas)).lit }
      const reference = async () => Number(await kit.getByTestId('film-program-compare-bar').getAttribute('data-reference'))
      const drawnAt = async () => Number(await kit.locator(referenceCanvas).getAttribute('data-ticks'))
      const frame = Math.floor((TPS * 1001) / 24000)
      const snap = (ticks) => Math.ceil((Math.floor((ticks * 24000) / (TPS * 1001)) * TPS * 1001) / 24000)
      const entered = await reference()
      step('Comparison View shows two pictures, the reference at the playhead on the left of the current one', referenceDrawn && entered === enteredAt && referenceBox && currentBox && referenceBox.x + referenceBox.width <= currentBox.x && pictures.reference > 20 && pictures.current > 20, JSON.stringify({ entered, enteredAt, referenceBox, currentBox, pictures }))
      await checkIds()
      await kit.getByTestId('film-program-compare-prev').click()
      const stepBack = await until(async () => (await reference()) === entered - frame && (await drawnAt()) === snap(entered - frame))
      await kit.getByTestId('film-program-compare-next').click()
      await kit.getByTestId('film-program-compare-next').click()
      const stepOn = await until(async () => (await reference()) === entered + frame && (await drawnAt()) === snap(entered + frame))
      await personRun([{ command: 'playhead.set', params: { seconds: 2 } }])
      await until(async () => Math.abs((await seconds()) - 2) < 0.05)
      const playheadNow = (await details()).playhead
      await kit.getByTestId('film-program-compare-set').click()
      const setToPlayhead = await until(async () => (await reference()) === playheadNow && (await drawnAt()) === snap(playheadNow))
      step('◀ and ▶ step the reference one frame and draw it there; Set takes the playhead', stepBack && stepOn && setToPlayhead, JSON.stringify({ stepBack, stepOn, setToPlayhead, reference: await reference(), drawn: await drawnAt(), entered, frame, playheadNow }))
      const comparedFit = (await canvasView()).zoom < 2 / dpr
      await chooseWrench('program', 'display-composite')
      await until(async () => (await kit.getByTestId('film-program-reference').count()) === 0)
      // Back at 200%, centred on the whole picture area's width, not the half it had while comparing.
      const centred = async () => {
        const view = await canvasView()
        const region = await kit.locator(programCanvas).first().boundingBox()
        const centre = { x: view.x + region.width / 2 / view.zoom, y: view.y + region.height / 2 / view.zoom }
        return { view, width: region.width, centre, ok: Math.abs(view.zoom - 2 / dpr) < 1e-6 && Math.abs(centre.x - settings.width / 2) < 2 && Math.abs(centre.y - settings.height / 2) < 2 }
      }
      const recentred = await until(async () => (await centred()).ok)
      step('the Comparison View fits a magnified picture, and leaving it magnifies to 200% again, centred on the whole width', comparedFit && recentred, JSON.stringify({ comparedFit, ...(await centred()), sequence: [settings.width, settings.height], dpr }))
      await kit.getByTestId('film-program-zoom').click()
      await kit.getByTestId('film-program-zoom-fit').click()
      await until(async () => (await canvasView()).zoom < 2 / dpr)
      // Source ▸ Audio Waveform: the bars' tone, and a click there moves the source playhead.
      await chooseWrench('source', 'display-audioWaveform')
      const waveDrawn = await until(async () => (await kit.locator('[data-testid="film-source-waveform"][data-state="drawn"]').count()) === 1, 100)
      const green = await kitFrame().evaluate(() => {
        const canvas = document.querySelector('[data-testid="film-source-waveform"] canvas')
        if (!canvas || !canvas.width) return 0
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
        let count = 0
        for (let at = 0; at < data.length; at += 16) if (data[at + 1] > 150 && data[at] < 120 && data[at + 3] > 0) count += 1
        return count
      })
      const clip = await sourceInspect()
      const wave = await settledBox(kit.getByTestId('film-source-waveform'))
      await kit.getByTestId('film-source-waveform').click({ position: { x: wave.width * 0.25, y: wave.height / 2 } })
      const wanted = clip.end * 0.25
      const sourceFrame = TPS / clip.fps
      const moved = await until(async () => Math.abs((await sourceInspect()).playhead - wanted) <= sourceFrame + 1)
      step('Source ▸ Audio Waveform shows the tone\'s waveform, and a click there moves the source playhead', waveDrawn && green > 50 && moved, JSON.stringify({ waveDrawn, green, wanted, playhead: (await sourceInspect()).playhead, end: clip.end }))
      await checkIds()
      // A vertical drag out of the waveform takes the marked audio to the Timeline (upstream's source_drag with audio only).
      const audioLane = await settledBox(kit.getByTestId('film-track-Audio 1'))
      const waveFrom = { audio: (await clips('audio')).length, video: (await clips('video')).length, revision: await revision() }
      const start = { x: wave.x + wave.width / 2, y: wave.y + wave.height / 2 }
      const target = { x: audioLane.x + audioLane.width * 0.85, y: audioLane.y + audioLane.height / 2 }
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      // Straight down first, so the drag starts vertical; then on to A1, paced for WebKit's drag events.
      for (let i = 1; i <= 4; i += 1) {
        await page.mouse.move(start.x, start.y + i * 8)
        await hold(40)
      }
      for (let i = 1; i <= 12; i += 1) {
        await page.mouse.move(start.x + ((target.x - start.x) * i) / 12, start.y + 32 + ((target.y - start.y - 32) * i) / 12)
        await hold(40)
      }
      await page.mouse.move(target.x + 2, target.y)
      const wavePreview = await until(async () => (await kit.getByTestId('film-timeline-drop').count()) === 1, 20)
      await page.mouse.up()
      const audioPlaced = await until(async () => (await revision()) > waveFrom.revision && (await clips('audio')).length === waveFrom.audio + 1)
      const videoAfter = (await clips('video')).length
      step('a vertical drag out of the Source waveform places the marked audio alone on the Timeline', wavePreview && audioPlaced && videoAfter === waveFrom.video, JSON.stringify({ wavePreview, audioPlaced, audio: [waveFrom.audio, (await clips('audio')).length], video: [waveFrom.video, videoAfter] }))
      if (audioPlaced) {
        await kit.locator('.kui-app').focus()
        await page.keyboard.press('ControlOrMeta+z')
        await until(async () => (await clips('audio')).length === waveFrom.audio)
      }
      await chooseWrench('source', 'display-composite')
      await until(async () => (await kit.getByTestId('film-source-waveform').count()) === 0)
    }
  }
  // The keys that follow act on the sequence again.
  await kit.getByTestId('film-program').click()
  await kit.locator('.kui-app').focus()
  // Home's drop-down panel first, then upstream's menus (`menus.rs` `menu_bar`): the nine menus in
  // order, engine rows running in the session, upstream's UI rows through `invoke`, and no row a browser hides.
  const menuLabels = await kit.locator('.kui-menu-bar-item').evaluateAll((items) => items.map((item) => item.getAttribute('data-kit-ui-id')))
  step('Home, then upstream\'s nine menus, in order', JSON.stringify(menuLabels) === JSON.stringify(['tab:home', ...['File', 'Edit', 'Clip', 'Sequence', 'Markers', 'Graphics and Titles', 'View', 'Window', 'Help'].map((menu) => `menu:${menu}`)]), JSON.stringify(menuLabels))
  await kit.getByTestId('film-menu-File').click()
  const fileRows = await kit.locator('[role="menu"] [data-kit-ui-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-kit-ui-id')))
  await page.keyboard.press('Escape')
  step('File draws no row a browser hides', fileRows.includes('control:file.import') && !fileRows.some((id) => /file\.(save|open|close|newProject|revert)$/.test(id)), JSON.stringify(fileRows.slice(0, 12)))
  await personRun([{ command: 'marker.clearInOut', params: {} }, { command: 'playhead.set', params: { seconds: 1 } }])
  await until(async () => (await details()).sequence.in == null)
  await kit.getByTestId('film-menu-Markers').click()
  await kit.getByTestId('film-cmd-marker.markIn').click()
  await until(async () => (await details()).sequence.in != null)
  const menuMarked = await details()
  step('Markers ▸ Mark In marks In at the playhead', menuMarked.sequence.in != null && menuMarked.sequence.in === menuMarked.playhead, JSON.stringify({ in: menuMarked.sequence.in, playhead: menuMarked.playhead }))
  // A menu command the engine refuses says why in the status bar, as upstream's `invoke` does; no toast.
  await kit.getByTestId('film-menu-Sequence').click()
  await kit.getByTestId('film-cmd-sequence.closeGap').click()
  const refused = await until(async () => (await kit.getByTestId('film-message').count()) > 0)
  const refusal = refused ? await kit.getByTestId('film-message').textContent() : null
  step('a menu command the engine refuses says why in the status bar, not in a toast', refused && (await kit.locator('.kui-toast').count()) === 0, JSON.stringify(refusal))
  await kit.getByTestId('film-message').click().catch(() => undefined)
  const playbackRes = async () => {
    await kit.getByTestId('film-menu-View').click()
    await kit.locator('[data-kit-ui-id="menu:View/Playback Resolution"]').hover()
    await kit.getByTestId('film-control-view.playbackRes.quarter').waitFor({ timeout: 5000 })
  }
  await playbackRes()
  const quarterBefore = await kit.getByTestId('film-control-view.playbackRes.quarter').getAttribute('aria-checked')
  await kit.getByTestId('film-control-view.playbackRes.quarter').click()
  await playbackRes()
  const quarterAfter = await kit.getByTestId('film-control-view.playbackRes.quarter').getAttribute('aria-checked')
  const halfAfter = await kit.getByTestId('film-control-view.playbackRes.half').getAttribute('aria-checked')
  await page.keyboard.press('Escape')
  step('View ▸ Playback Resolution ▸ 1/4 is checked after choosing it', quarterBefore === 'false' && quarterAfter === 'true' && halfAfter === 'false', JSON.stringify({ quarterBefore, quarterAfter, halfAfter }))
  await kit.getByTestId('film-menu-Help').click()
  await kit.getByTestId('film-control-help.about').click()
  const about = await kit.getByTestId('film-about').textContent({ timeout: 5000 }).catch(() => '')
  // Upstream's three tabs (dialogs.rs about); the credits tabs show upstream's line for a copy built without credits.
  const aboutTabs = await kit.locator('[data-testid^="film-about-tab-"]').allTextContents()
  await checkIds()
  await kit.getByTestId('film-about-tab-contributors').click()
  const contributors = await kit.getByTestId('film-about-contributors').textContent({ timeout: 5000 }).catch(() => '')
  await kit.getByTestId('film-about-tab-models').click()
  const models = await kit.getByTestId('film-about-models').textContent({ timeout: 5000 }).catch(() => '')
  const aboutPreviewless = (await kit.getByTestId('film-dialog-preview').count()) === 0 && (await kit.getByTestId('film-dialog-ok').count()) === 0
  await kit.getByTestId('film-dialog-cancel').click()
  const aboutClosed = await until(async () => (await dialogShown()) === 0, 30)
  step('Help ▸ About shows the version and the upstream release it ports', pattern(ztRaw('help.version'), { version: '\\d+\\.\\d+\\.\\d+' }).test(about) && about.includes(zt('help.upstream', { version: 'v0.5.0' })), about.slice(0, 120))
  step('Help ▸ About shows three tabs, with nothing to preview and one Close', JSON.stringify(aboutTabs) === JSON.stringify(['About', 'Contributors', 'Models'].map(zh)) && contributors.includes(zh('No contributor data was built into this copy.')) && models.includes(zh('No model credits were built into this copy.')) && aboutPreviewless && aboutClosed, JSON.stringify({ aboutTabs, contributors, models, aboutPreviewless, aboutClosed }))
  await kit.getByTestId('film-menu-Help').click()
  await kit.getByTestId('film-control-help.shortcuts').click()
  await until(async () => ((await kit.getByTestId('film-shortcuts').textContent()) ?? '').includes('Alt+Shift+1'))
  const shortcuts = await kit.getByTestId('film-shortcuts').locator('kbd').allTextContents()
  await kit.getByTestId('film-help-close').click()
  // Cmd+K is the engine's Add Edit, Alt+Shift+1 upstream's Editing workspace; Save (Cmd+S) is the host's.
  step('Help ▸ Keyboard Shortcuts lists the engine\'s keys and upstream\'s UI keys', shortcuts.includes('Cmd+K') && shortcuts.includes('Alt+Shift+1') && !shortcuts.includes('Cmd+S'), `${shortcuts.length} keys`)
  // File ▸ Import picks media through the host and imports it only, as upstream: the timeline is unchanged.
  const projectItems = async () => {
    const count = (node) => (node?.children ?? []).reduce((total, child) => total + (child.children ? count(child) : 1), 0)
    return count((await details()).project?.root)
  }
  const itemsBefore = await projectItems()
  const clipsBefore = (await clips('video')).length
  await kit.getByTestId('film-menu-File').click()
  await kit.getByTestId('film-control-file.import').click()
  await until(async () => (await projectItems()) === itemsBefore + 1)
  step('File ▸ Import adds the picked media to the project, not the timeline', (await projectItems()) === itemsBefore + 1 && (await clips('video')).length === clipsBefore, JSON.stringify({ itemsBefore, items: await projectItems(), said: await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => null) }))
  // The Project panel (upstream `panels/project.rs`, `project_views.rs`): the imported item is
  // listed; the Icon view draws its thumbnail; a double-click opens it in the Source monitor; it
  // drags from its card onto V2 and into a new bin; and it is renamed in place. Each step waits on
  // the engine's revision or state, never a timeout.
  {
    const root = async () => (await details()).project?.root
    const itemIds = (node) => (node?.children ?? []).flatMap((child) => (child.children ? itemIds(child) : [child.item]))
    const imported = itemIds(await root()).sort((a, b) => b - a)[0]
    const card = kit.getByTestId(`film-project-item-${imported}`)
    const listed = await until(async () => (await card.count()) === 1, 40)
    await checkIds()
    step('File ▸ Import lists the imported item in the Project panel', listed, JSON.stringify({ imported, count: await kit.getByTestId('film-project-count').textContent().catch(() => null) }))
    // Icon view, from the List view: the engine keeps the view (`project.view.set`).
    await kit.getByTestId('film-project-view-list').click()
    const listShown = await until(async () => (await kit.getByTestId('film-project').getAttribute('data-view')) === 'list' && (await kit.getByTestId('film-project-list').count()) === 1, 40)
    await checkIds()
    await kit.getByTestId('film-project-view-icon').click()
    const iconShown = await until(async () => (await kit.getByTestId('film-project').getAttribute('data-view')) === 'icon', 40)
    const thumb = kit.locator(`[data-testid="film-project-thumb-${imported}"] canvas`)
    const drawn = await until(async () => (await thumb.getAttribute('data-drawn')) === '1', 100)
    const thumbLit = drawn
      ? await thumb.evaluate((canvas) => {
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
          let lit = 0
          for (let i = 0; i < data.length; i += 4 * 17) if (data[i] + data[i + 1] + data[i + 2] > 90) lit += 1
          return lit
        })
      : 0
    step('the List and Icon switches change the view, and the Icon view draws the item\'s thumbnail, not black', listShown && iconShown && thumbLit > 20, JSON.stringify({ listShown, iconShown, drawn, thumbLit }))
    await checkIds()
    // A double-click on media opens it in the Source monitor (`source.open`).
    await card.dblclick()
    const opened = await until(async () => (await details()).project?.sourceItem === imported && (await kit.getByTestId('film-source').count()) === 1, 60)
    step('a double-click on the item opens it in the Source monitor', opened, JSON.stringify({ sourceItem: (await details()).project?.sourceItem, imported }))
    // Its card drags onto V2 through the Timeline's drop target: the preview shows, then the clip is placed.
    const v2 = async () => (await clips('video')).filter((item) => item.item === imported)
    const dragFrom = { revision: await revision(), count: (await v2()).length }
    const cardBox = await settledBox(card)
    const lane2 = await settledBox(kit.getByTestId('film-track-Video 2'))
    const from = { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 3 }
    const to = { x: lane2.x + lane2.width * 0.6, y: lane2.y + lane2.height * 0.6 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= 14; i += 1) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 14, from.y + ((to.y - from.y) * i) / 14)
      await hold(40)
    }
    await page.mouse.move(to.x + 2, to.y)
    const dropPreviewed = await until(async () => (await kit.getByTestId('film-timeline-drop').count()) === 1, 20)
    await page.mouse.up()
    const dropped = await until(async () => (await revision()) > dragFrom.revision && (await v2()).length === dragFrom.count + 1)
    const onV2 = dropped ? (await details()).sequence.video?.find((track) => track.name === 'Video 2')?.items?.some((item) => item.item === imported) === true : false
    step('dragging the item\'s card onto V2 previews the drop and places it there', dropPreviewed && dropped && onV2, JSON.stringify({ dropPreviewed, dropped, onV2 }))
    if (dropped) {
      await kit.locator('.kui-app').focus()
      await page.keyboard.press('ControlOrMeta+z')
      await until(async () => (await v2()).length === dragFrom.count)
    }
    // New Bin in the footer (`bin.add`), then the card dragged onto the bin's card (`project.moveToBin`).
    const binsOf = (node) => (node?.children ?? []).filter((child) => child.children)
    const binsBefore = binsOf(await root()).map((bin) => bin.id)
    await kit.getByTestId('film-project-new-bin').click()
    await until(async () => binsOf(await root()).length === binsBefore.length + 1)
    const bin = binsOf(await root()).find((each) => !binsBefore.includes(each.id))
    const binCard = kit.getByTestId(`film-project-bin-${bin?.id}`)
    await binCard.waitFor({ timeout: 5000 }).catch(() => undefined)
    const moveFrom = await revision()
    const cardAt = await settledBox(card, { orNull: true })
    const binAt = await settledBox(binCard, { orNull: true })
    if (cardAt && binAt) {
      const start = { x: cardAt.x + cardAt.width / 2, y: cardAt.y + cardAt.height / 3 }
      const end = { x: binAt.x + binAt.width / 2, y: binAt.y + binAt.height / 3 }
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      for (let i = 1; i <= 10; i += 1) {
        await page.mouse.move(start.x + ((end.x - start.x) * i) / 10, start.y + ((end.y - start.y) * i) / 10)
        await hold(40)
      }
      await page.mouse.move(end.x + 2, end.y)
      await until(async () => (await binCard.getAttribute('data-drop')) === 'true', 20)
      await page.mouse.up()
    }
    const inBin = await until(async () => (await revision()) > moveFrom && itemIds(binsOf(await root()).find((each) => each.id === bin?.id)).includes(imported))
    const leftRoot = inBin && (await until(async () => (await card.count()) === 0, 40))
    step('New Bin makes a bin, and the item\'s card dragged onto it moves the item into it', bin != null && inBin && leftRoot, JSON.stringify({ bin: bin?.id, inBin, leftRoot }))
    // The bin opens in place on a double-click; the item's menu renames it in place (`clip.rename`).
    await binCard.dblclick()
    const inside = await until(async () => (await kit.getByTestId('film-project-breadcrumb').textContent())?.endsWith(`/ ${bin?.name}`) && (await card.count()) === 1, 40)
    await card.click({ button: 'right' })
    await kit.getByTestId('film-project-item-menu').waitFor()
    await checkIds()
    await kit.getByTestId('film-project-item-rename').click()
    const field = kit.getByTestId(`film-project-rename-${imported}`)
    await field.waitFor()
    await checkIds()
    await field.fill('Renamed take')
    const renameFrom = await revision()
    await field.press('Enter')
    const nameOf = async () => {
      const find = (node) => (node?.children ?? []).map((child) => (child.children ? find(child) : child.item === imported ? child.name : null)).find((name) => name != null)
      return find(await root())
    }
    const renamed = await until(async () => (await revision()) > renameFrom && (await nameOf()) === 'Renamed take' && ((await card.textContent()) ?? '').includes('Renamed take'))
    step('a bin opens in place on a double-click, and the item renames in place from its menu', inside && renamed, JSON.stringify({ inside, renamed, name: await nameOf() }))
    // New Sequence From Clip makes a sequence from the item at once (sequence.new {fromItem}), as upstream.
    const sequences = async () => {
      const walk = (node) => (node?.children ?? []).flatMap((child) => (child.children ? walk(child) : child.type === 'Sequence' ? [child.item] : []))
      return walk(await root())
    }
    const sequencesBefore = await sequences()
    const undoSteps = personHistory
    await card.click({ button: 'right' })
    await kit.getByTestId('film-project-item-new-sequence').click()
    const madeSequence = await until(async () => (await sequences()).length === sequencesBefore.length + 1 && (await undoSteps()).at(-1) === 'New Sequence From Clip')
    // The engine collapses it into one history step (New Sequence and the clip placed in it,
    // `collapse_history`, as sequence.newFromClip is; scenario F73): one Cmd+Z removes it.
    const stepsMade = await undoSteps()
    const oneStep = stepsMade.at(-1) === 'New Sequence From Clip' && stepsMade.at(-2) !== 'New Sequence'
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('ControlOrMeta+z')
    const undone = await until(async () => (await sequences()).length === sequencesBefore.length && (await details()).project?.activeSequence === sequencesBefore[0], 100)
    step('New Sequence From Clip makes a sequence from the item in one history step; Cmd+Z takes it back', madeSequence && oneStep && undone, JSON.stringify({ madeSequence, oneStep, undone, last: stepsMade.slice(-2) }))
    // Up One Level goes back to the project's root; the panel menu and New Item menu carry declared ids.
    await kit.getByTestId('film-project-up').click()
    await until(async () => (await kit.getByTestId('film-project-breadcrumb').textContent()) === 'Sample.kfilm')
    await kit.getByTestId('film-workspace-menu-project').click()
    await kit.getByTestId('film-project-menu-fontSize').hover()
    await kit.getByTestId('film-project-menu-fontSize-large').waitFor()
    await checkIds()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await kit.getByTestId('film-project-new-item').click()
    await kit.getByTestId('film-project-new-item.newBarsAndTone').waitFor()
    await checkIds()
    await page.keyboard.press('Escape')
    // Sort Icons, the bin menu, and the empty space's menu carry declared ids too.
    await kit.getByTestId('film-project-sort-icons').click()
    await kit.getByTestId('film-project-sort-userOrder').waitFor()
    await checkIds()
    await page.keyboard.press('Escape')
    await binCard.click({ button: 'right' })
    await kit.getByTestId('film-project-bin-menu').waitFor()
    await checkIds()
    await page.keyboard.press('Escape')
    await kit.getByTestId('film-project-empty').click({ button: 'right' })
    await kit.getByTestId('film-project-background-menu').waitFor()
    await checkIds()
    await page.keyboard.press('Escape')
    const sessionNow = async () => (await personRun([{ command: 'state.inspect', params: {} }])).completed[0].result
    // The Project panel's keys, which only the engine's panel table binds (registered as upstream's
    // register_external): End selects the last card, Shift+Up extends the selection back one.
    const cards = () => kit.locator('[data-testid^="film-project-item-"]').evaluateAll((items) => items.map((item) => Number(item.getAttribute('data-testid').slice('film-project-item-'.length))))
    const shownCards = await cards()
    await kit.locator(`[data-testid="film-project-item-${shownCards[0]}"]`).click()
    await until(async () => JSON.stringify((await sessionNow()).project_selection) === JSON.stringify([shownCards[0]]), 30)
    await page.keyboard.press('End')
    const ended = await until(async () => JSON.stringify((await sessionNow()).project_selection) === JSON.stringify([shownCards.at(-1)]), 30)
    // In the Icon view Up is a row of cards up (upstream's `icon_columns`), Left one card.
    await page.keyboard.press('Shift+ArrowLeft')
    const extendedLeft = await until(async () => JSON.stringify((await sessionNow()).project_selection) === JSON.stringify([shownCards.at(-1), shownCards.at(-2)]), 30)
    await page.keyboard.press('End')
    await until(async () => JSON.stringify((await sessionNow()).project_selection) === JSON.stringify([shownCards.at(-1)]), 30)
    await page.keyboard.press('Shift+ArrowUp')
    // From the last card back to the card a row above it (the first, when they fit one row), the anchor first.
    const spanUp = (selection) => selection.length >= 2 && selection[0] === shownCards.at(-1) && selection.every((id, k) => id === shownCards[shownCards.length - 1 - k])
    const extended = await until(async () => spanUp((await sessionNow()).project_selection), 30)
    step('with the Project panel focused, End selects the last item, Shift+Left and Shift+Up extend the selection', shownCards.length >= 2 && ended && extendedLeft && extended, JSON.stringify({ shownCards, ended, extendedLeft, extended, selection: (await sessionNow()).project_selection }))
    // Hover Scrub, then I: the hovered item's In is set at the hovered time (project.setMarks), not the sequence's.
    const iconRowsNow = (await personRun([{ command: 'project.items', params: { order: 'icon' } }])).completed[0].result.rows
    const scrubbed = iconRowsNow.find((row) => row.kind === 'media' && row.hasVideo && row.direct && row.item !== imported)?.item ?? shownCards[0]
    const sequenceIn = (await details()).sequence.in ?? null
    const art = await settledBox(kit.locator(`[data-testid="film-project-thumb-${scrubbed}"]`))
    for (let i = 0; i <= 6; i += 1) {
      await page.mouse.move(art.x + art.width * (0.2 + i * 0.05), art.y + art.height / 2)
      await hold(40)
    }
    const scrubShown = await until(async () => (await kit.getByTestId(`film-project-scrub-${scrubbed}`).count()) === 1, 30)
    const marksFrom = await revision()
    await page.keyboard.press('i')
    const itemIn = async () => {
      const rows = (await personRun([{ command: 'project.items', params: { order: 'icon' } }])).completed[0].result.rows
      return rows.find((row) => row.item === scrubbed)?.in ?? null
    }
    const marked = await until(async () => (await revision()) > marksFrom && (await itemIn()) != null && (await itemIn()) > 0, 40)
    step('Hover Scrub across a card, then I sets that item\'s In at the hovered time, not the sequence\'s', scrubShown && marked && ((await details()).sequence.in ?? null) === sequenceIn, JSON.stringify({ scrubShown, marked, in: await itemIn(), sequenceIn, sequenceInNow: (await details()).sequence.in ?? null }))
    await page.mouse.move(5, 5)
    await personRun([{ command: 'project.setMarks', params: { item: scrubbed, in: null, out: null } }])
    // The fold state (UI state outside the panel) survives a revision and the panel being hidden
    // and shown again; a search opens every bin and keeps only matching names.
    await kit.getByTestId('film-project-view-list').click()
    await kit.getByTestId('film-project-list').waitFor()
    const binToggle = kit.getByTestId(`film-project-bin-${bin?.id}-toggle`)
    if ((await binToggle.getAttribute('aria-expanded')) !== 'true') await binToggle.click()
    const openedFold = await until(async () => (await card.count()) === 1, 20)
    const foldFrom = await revision()
    await personRun([{ command: 'item.newBlackVideo', params: {} }])
    await until(async () => (await revision()) > foldFrom)
    const keptAfterRevision = (await binToggle.getAttribute('aria-expanded')) === 'true' && (await card.count()) === 1
    await kit.getByTestId('film-workspace-tab-markers').click()
    const hidden = await until(async () => (await kit.getByTestId('film-project').count()) === 0, 20)
    await kit.getByTestId('film-workspace-tab-project').click()
    await kit.getByTestId('film-project').waitFor({ timeout: 5000 }).catch(() => undefined)
    // The panel shown again reads its view (project.view.get): wait for it, not for time.
    const shownNow = async () => ({ hidden, view: await kit.getByTestId('film-project').getAttribute('data-view').catch(() => null), expanded: await binToggle.getAttribute('aria-expanded').catch(() => null) })
    await until(async () => {
      const now = await shownNow()
      return now.view === 'list' && now.expanded === 'true'
    }, 30)
    const shownAgain = await shownNow()
    const keptAfterHiding = shownAgain.hidden && shownAgain.view === 'list' && shownAgain.expanded === 'true'
    await binToggle.click()
    await until(async () => (await card.count()) === 0, 20)
    await kit.getByTestId('film-project-search').fill('renamed')
    const searched = await until(async () => (await card.count()) === 1 && (await kit.locator('[data-testid^="film-project-item-"]').count()) === 1, 20)
    await kit.getByTestId('film-project-search').fill('')
    step('a folded bin\'s state survives a revision and hiding the panel; a search opens the bins and keeps matching names', openedFold && keptAfterRevision && keptAfterHiding && searched, JSON.stringify({ openedFold, keptAfterRevision, keptAfterHiding, shownAgain, searched }))
    // A bin shown in place that goes away (its creation undone) gives way to the root, as upstream's view_of.
    await kit.getByTestId('film-project-new-bin').click()
    await until(async () => binsOf(await root()).length === binsBefore.length + 2)
    const fresh = binsOf(await root()).find((each) => each.id !== bin?.id && !binsBefore.includes(each.id))
    await kit.getByTestId(`film-project-bin-${fresh?.id}`).dblclick()
    const insideFresh = await until(async () => (await kit.getByTestId('film-project-breadcrumb').textContent())?.endsWith(`/ ${fresh?.name}`), 20)
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('ControlOrMeta+z')
    const backAtRoot = await until(async () => binsOf(await root()).every((each) => each.id !== fresh?.id) && (await kit.getByTestId('film-project-breadcrumb').textContent()) === 'Sample.kfilm' && (await kit.getByTestId(`film-project-bin-${bin?.id}`).count()) === 1, 40)
    step('a bin shown in place whose creation is undone gives way to the project\'s root', insideFresh && backAtRoot, JSON.stringify({ insideFresh, backAtRoot, crumb: await kit.getByTestId('film-project-breadcrumb').textContent() }))
    await kit.getByTestId('film-project-view-icon').click()
    // The other UI commands the engine's tables bind once registered: Shift+L shuttles slowly
    // forward (playback.slowForward), Alt+= in the Timeline makes the audio tracks taller
    // (timeline.increaseAudioHeight), and Alt+Shift+9 shows the All Panels workspace.
    const timelineFrame = await settledBox(kit.getByTestId('film-workspace-frame-timeline'))
    await page.mouse.click(timelineFrame.x + timelineFrame.width / 2, timelineFrame.y + 12)
    await kit.locator('.kui-app').focus()
    const playFrom = (await details()).playhead
    await page.keyboard.press('Shift+L')
    const slowPlayed = await until(async () => (await details()).playhead > playFrom, 100)
    await page.keyboard.press('k')
    await playheadSettled()
    const audioHeight = async () => (await kit.getByTestId('film-track-Audio 1').boundingBox())?.height ?? 0
    const heightFrom = (await settledBox(kit.getByTestId('film-track-Audio 1'))).height
    await page.keyboard.press('Alt+Equal')
    const taller = await until(async () => (await audioHeight()) > heightFrom, 20)
    await page.keyboard.press('Alt+Minus')
    await until(async () => (await audioHeight()) === heightFrom, 20)
    const workspaceFrom = (await kit.getByTestId('film-header-workspaces').textContent()).trim()
    await page.keyboard.press('Alt+Shift+9')
    const allPanels = await until(async () => (await kit.getByTestId('film-header-workspaces').textContent()).trim() === zh('All Panels').toUpperCase(), 20)
    await page.keyboard.press('Alt+Shift+1')
    await until(async () => (await kit.getByTestId('film-header-workspaces').textContent()).trim() === workspaceFrom, 20)
    step('the engine binds the registered UI commands: Shift+L shuttles slowly, Alt+= makes audio tracks taller, Alt+Shift+9 shows All Panels', slowPlayed && taller && allPanels && workspaceFrom === zh('Editing').toUpperCase(), JSON.stringify({ slowPlayed, taller, heightFrom, allPanels, workspaceFrom }))
  }
  // The running export shows on the status bar's right, with a progress bar and Cancel (upstream
  // `lib.rs` `job_status`); Cancel stops it, and no movie is written.
  {
    const movies = () => page.evaluate(() => [...window.devHost.files.keys()].filter((name) => name.endsWith('.mp4')).length)
    const moviesBefore = await movies()
    await kit.getByTestId('film-export').click()
    const shown = await until(async () => (await kit.getByTestId('film-exporting').count()) === 1, 100)
    const label = shown ? await kit.getByTestId('film-exporting').textContent() : null
    const bar = shown ? await kit.getByTestId('film-exporting-progress').getAttribute('aria-valuenow') : null
    const buttonBusy = await kit.getByTestId('film-export').isDisabled()
    await kit.getByTestId('film-exporting-cancel').click().catch(() => undefined)
    const gone = await until(async () => (await kit.getByTestId('film-exporting').count()) === 0, 100)
    await hold(300)
    const moviesAfter = await movies()
    await checkIds()
    step('the running export shows on the status bar with its progress and Cancel, which stops it', shown && new RegExp(`^${escapeRegExp(zh('Exporting'))}… \\d+%`).test(label ?? '') && bar != null && buttonBusy && gone && moviesAfter === moviesBefore, JSON.stringify({ shown, label, bar, buttonBusy, gone, moviesBefore, moviesAfter }))
    if (await kit.getByTestId('film-message').count()) await kit.getByTestId('film-message').click()
  }
  await kit.getByTestId('film-export').click()
  await until(async () => (await page.evaluate(() => [...window.devHost.files.keys()])).some((name) => name.startsWith('films/') && name.endsWith('.mp4')), 1200)
  const movie = await page.evaluate(() => {
    const name = [...window.devHost.files.keys()].find((key) => key.startsWith('films/') && key.endsWith('.mp4'))
    return name ? { name, size: window.devHost.files.get(name).bytes.byteLength } : null
  })
  step('exports an MP4 next to the project', movie && movie.size > 1000, JSON.stringify(movie))
  const run = await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'playhead.set', params: { seconds: 0 } }, { command: 'sequence.addEdit', params: { time: 127008000000 } }], false))
  await until(async () => (await page.evaluate(() => window.devHost.changes.at(-1)?.by)) === 'agent')
  step('the agent edits the live project', run.completed.some((item) => item.changed) && (await page.evaluate(() => window.devHost.changes.at(-1).by)) === 'agent')
  await kit.getByTestId('film-save').click()
  await until(async () => (await page.evaluate(() => window.devHost.files.get('films/Sample.kfilm').version)) > 1)
  step('saves through the host', (await page.evaluate(() => window.devHost.files.get('films/Sample.kfilm').version)) > 1)
  // file.save is hidden, so its key resolves to nothing in the router and the shell's own Save runs.
  const savedVersion = await page.evaluate(() => window.devHost.files.get('films/Sample.kfilm').version)
  await kit.locator('.kui-app').focus()
  await page.keyboard.press('o')
  await until(async () => (await details()).sequence.out != null)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await until(async () => (await page.evaluate(() => window.devHost.files.get('films/Sample.kfilm').version)) > savedVersion)
  step('the save key saves through the shell', (await page.evaluate(() => window.devHost.files.get('films/Sample.kfilm').version)) > savedVersion)

  // The Timeline (upstream `panels/timeline.rs`): track headers, toolbar toggles shared with the
  // menus through the session state, thumbnails and waveforms from the engine, and the zoom keys.
  const sessionState = async () => (await personRun([{ command: 'state.inspect', params: {} }])).completed[0].result
  const trackOf = async (kind, index) => (await details()).sequence[kind][index]
  await kit.getByTestId('film-track-V1-lock').click()
  const locked = await until(async () => (await trackOf('video', 0)).locked === true)
  const lockShown = (await kit.getByTestId('film-track-V1-lock').getAttribute('aria-pressed')) === 'true'
  await kit.getByTestId('film-track-V1-lock').click()
  const unlocked = await until(async () => (await trackOf('video', 0)).locked === false)
  step('the V1 lock locks the track in the session, and again unlocks it', locked && lockShown && unlocked, JSON.stringify({ locked, lockShown, unlocked }))
  await kit.getByTestId('film-track-A1-mute').click()
  const muted = await until(async () => (await trackOf('audio', 0)).muted === true)
  const muteShown = await until(async () => (await kit.getByTestId('film-track-A1-mute').getAttribute('aria-pressed')) === 'true')
  await kit.getByTestId('film-track-A1-mute').click()
  await until(async () => (await trackOf('audio', 0)).muted === false)
  step('A1 mutes from its header', muted && muteShown, JSON.stringify({ muted, muteShown }))
  // The keyboard: Tab from V1's source patch reaches its lock, and Space presses it (not play).
  await kit.getByTestId('film-track-V1-patch').focus()
  await page.keyboard.press('Tab')
  const tabbedTo = await kitFrame().evaluate(() => document.activeElement?.getAttribute('data-testid'))
  const playheadBefore = (await details()).playhead
  await page.keyboard.press(' ')
  const keyLocked = await until(async () => (await trackOf('video', 0)).locked === true)
  const stayed = (await details()).playhead === playheadBefore
  await page.keyboard.press(' ')
  const keyUnlocked = await until(async () => (await trackOf('video', 0)).locked === false)
  const lockLabel = await kit.getByTestId('film-track-V1-lock').getAttribute('aria-label')
  step('Tab reaches the V1 lock and Space locks the track, without playing', tabbedTo === 'film-track-V1-lock' && keyLocked && keyUnlocked && stayed && lockLabel === `${zh('Toggle Track Lock')}, V1`, JSON.stringify({ tabbedTo, keyLocked, keyUnlocked, stayed, lockLabel }))
  // Upstream checks neither menu row; the toolbar follows the session state whichever changed it.
  const toggleProblems = []
  for (const [button, key, command] of [['film-timeline-snap', 'snapping', 'sequence.snap'], ['film-timeline-linked', 'linked_selection', 'sequence.linkedSelection']]) {
    const before = (await sessionState())[key]
    await kit.getByTestId(button).click()
    if (!(await until(async () => (await sessionState())[key] === !before))) toggleProblems.push(`${key}: the toolbar did not change it`)
    if (!(await until(async () => (await kit.getByTestId(button).getAttribute('aria-pressed')) === String(!before)))) toggleProblems.push(`${key}: the toolbar does not show it`)
    await kit.getByTestId('film-menu-Sequence').click()
    await kit.getByTestId(`film-cmd-${command}`).click()
    if (!(await until(async () => (await sessionState())[key] === before))) toggleProblems.push(`${key}: the menu did not change it back`)
    if (!(await until(async () => (await kit.getByTestId(button).getAttribute('aria-pressed')) === String(before)))) toggleProblems.push(`${key}: the toolbar did not follow the menu`)
  }
  step('Snap and Linked Selection: the toolbar toggles the session state, and follows the Sequence menu', toggleProblems.length === 0, toggleProblems.join('; '))
  // The longest clip on the first track: upstream draws no thumbnail on a clip 20 px wide or less.
  const timelineClip = async (kind) => [...(await details()).sequence[kind][0].items].sort((a, b) => b.duration - a.duration)[0].clip
  const videoClip = await timelineClip('video')
  const lit = (testId) =>
    kit.getByTestId(`film-clip-${videoClip}`).locator(`[data-testid="${testId}"]`).first().evaluate((canvas) => {
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
      let count = 0
      for (let at = 0; at < data.length; at += 4) if (data[at + 3] > 0 && data[at] + data[at + 1] + data[at + 2] > 60) count += 1
      return count
    }, null, { timeout: 500 })
  const thumbnailLit = await until(async () => (await lit('film-clip-thumbnail')) > 50, 100)
  const thumbnailDetail = async () => ({
    lit: await lit('film-clip-thumbnail').catch((error) => String(error).slice(0, 80)),
    clip: videoClip,
    clips: ((await details()).sequence.video[0].items ?? []).map((item) => [item.clip, item.start, item.sourceIn]),
    drawn: await kit.locator('.film-clip[data-kind="video"]').evaluateAll((items) => items.map((item) => `${item.getAttribute('data-testid')}:${item.querySelectorAll('canvas').length}:${Math.round(item.getBoundingClientRect().width)}`)),
    invokes: await kitFrame().evaluate(() => window.workerRequests?.invoke ?? 0),
  })
  step('a video clip shows its head thumbnail, not black', thumbnailLit, JSON.stringify(await thumbnailDetail()))
  const audioClip = await timelineClip('audio')
  const waveLit = async () =>
    kit.getByTestId(`film-clip-${audioClip}`).locator('[data-testid="film-clip-waveform"]').evaluate((canvas) => {
      const { data } = canvas.getContext('2d').getImageData(0, Math.floor(canvas.height * 0.6), canvas.width, Math.floor(canvas.height * 0.4))
      let count = 0
      // Upstream's waveform blue (#79c0f9): more blue than red.
      for (let at = 0; at < data.length; at += 4) if (data[at + 3] > 0 && data[at + 2] > 200 && data[at] < 200) count += 1
      return count
    }, null, { timeout: 500 })
  const waveShown = await until(async () => (await waveLit()) > 20, 100)
  step('an audio clip shows its waveform', waveShown, `${await waveLit().catch(() => 0)} waveform pixels`)
  const clipWidth = async () => (await kit.getByTestId(`film-clip-${videoClip}`).boundingBox())?.width ?? 0
  await kit.locator('.kui-app').focus()
  const widthBefore = (await settledBox(kit.getByTestId(`film-clip-${videoClip}`))).width
  await page.keyboard.press('=')
  const zoomedIn = await until(async () => Math.abs((await clipWidth()) / widthBefore - 1.6) < 0.02)
  const widthIn = await clipWidth()
  await page.keyboard.press('-')
  const zoomedOut = await until(async () => Math.abs((await clipWidth()) / widthBefore - 1) < 0.02)
  step('= zooms the Timeline in by 1.6 and - zooms it back', zoomedIn && zoomedOut, JSON.stringify({ widthBefore, widthIn, after: await clipWidth() }))
  const tabs = await kit.getByTestId('film-sequence-tabs').textContent().catch(() => null)
  step("the Timeline frame's strip lists the open sequence", tabs === 'Sequence 01', JSON.stringify(tabs))
  await kit.getByTestId('film-timeline-settings').click()
  await kit.getByTestId('film-timeline-show-thumbnails').waitFor({ timeout: 5000 })
  await checkIds()
  await page.keyboard.press('Escape')

  // The Tools panel (upstream `panels/tools.rs`) and the 17 tools (`state.rs` `Tool`): each is
  // chosen by a click (its group's button, or the flyout's row), and by its key when it has one,
  // and the status bar shows its hint (`lib.rs` `hint_text`), as upstream words it on this platform.
  const tools = kit.getByTestId('film-tools')
  await tools.waitFor({ timeout: 10000 })
  await checkIds()
  const activeTool = () => tools.getAttribute('data-active')
  const slot = (id) => tools.locator(`.kui-tool-slot > button[data-kit-ui-id="tool:${id}"]`)
  const flyoutRow = (id) => kit.locator(`.kui-tool-flyout [data-kit-ui-id="tool:${id}"]`)
  const mac = await kitFrame().evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))
  const hintFor = (id) => {
    const text = manifest.hints.find((hint) => hint.tool === id)?.text ?? ''
    return mac ? text : text.replace(/\bOpt\b/g, 'Alt').replace(/\bCmd\b/g, 'Ctrl')
  }
  // The hint shown, '' when none (Pen, the shapes, and Type have none), or what hides it.
  const shownHint = async () => {
    if (await kit.getByTestId('film-hint').count()) return kit.getByTestId('film-hint').textContent()
    return (await kit.getByTestId('film-message').count()) ? `(hidden by ${JSON.stringify(await kit.getByTestId('film-message').textContent())})` : ''
  }
  const groups = []
  for (const tool of manifest.tools) (groups[tool.group] ??= []).push(tool)
  const pressKey = async (shortcut) => {
    await kit.locator('.kui-app').focus()
    await page.keyboard.press(shortcut.startsWith('Shift+') ? shortcut : shortcut.toLowerCase())
  }
  // A status message (the export's) hides the hint until it is clicked away, as upstream.
  if (await kit.getByTestId('film-message').count()) await kit.getByTestId('film-message').click()
  const toolProblems = []
  for (const tool of manifest.tools) {
    const group = groups[tool.group]
    // From another group's tool, so neither the click nor the key is a no-op.
    const other = tool.group === 0 ? 'Hand' : 'Selection'
    await slot(groups.find((each) => each.some((item) => item.id === other))[0].id).click()
    if (!(await until(async () => (await activeTool()) === other, 20))) toolProblems.push(`${tool.id}: could not reset to ${other}`)
    if (tool.slot === 0) {
      await slot(tool.id).click()
    } else {
      await slot(group[0].id).click({ button: 'right' })
      await flyoutRow(tool.id).click()
    }
    const clicked = await until(async () => (await activeTool()) === tool.id, 20)
    const flyoutClosed = (await kit.locator('.kui-tool-flyout').count()) === 0
    const hint = await shownHint()
    if (!clicked || !flyoutClosed) toolProblems.push(`${tool.id}: ${tool.slot === 0 ? 'click' : 'flyout'} chose ${await activeTool()}${flyoutClosed ? '' : ', flyout still open'}`)
    if (hint !== zh(hintFor(tool.id))) toolProblems.push(`${tool.id}: hint ${JSON.stringify(hint)}`)
    // A group's button shows its active tool, with "Label (Key)" as its tooltip.
    const title = await slot(tool.id).getAttribute('title').catch(() => null)
    const wantTitle = tool.shortcut ? `${zh(tool.label)} (${tool.shortcut})` : zh(tool.label)
    if (title !== wantTitle) toolProblems.push(`${tool.id}: tooltip ${JSON.stringify(title)}`)
    if (tool.shortcut) {
      await slot(groups.find((each) => each.some((item) => item.id === other))[0].id).click()
      await until(async () => (await activeTool()) === other, 20)
      await pressKey(tool.shortcut)
      if (!(await until(async () => (await activeTool()) === tool.id, 20))) toolProblems.push(`${tool.id}: ${tool.shortcut} chose ${await activeTool()}`)
    }
  }
  step('every tool is chosen by a click or its flyout, and by its key, and the status bar shows its hint', toolProblems.length === 0, toolProblems.slice(0, 4).join('; '))
  // A group's button shows the group's first tool once another group's tool is active (upstream draws `group[0]`).
  await slot('Selection').click()
  // The tool bar drawn for Selection before its buttons are read.
  await until(async () => (await activeTool()) === 'Selection', 20)
  await paintFrames()
  const firstShown = (await slot('Type').count()) === 1 && (await slot('VerticalType').count()) === 0
  // Upstream's long-press test: holding Type 350 ms opens its flyout, and that release chooses nothing.
  const typeBox = await settledBox(slot('Type'))
  await page.mouse.move(typeBox.x + typeBox.width / 2, typeBox.y + typeBox.height / 2)
  await page.mouse.down()
  await hold(500)
  await page.mouse.up()
  const heldOpen = (await flyoutRow('VerticalType').count()) === 1
  const stillSelection = (await activeTool()) === 'Selection'
  await flyoutRow('VerticalType').click()
  const vertical = await until(async () => (await activeTool()) === 'VerticalType', 20)
  step('a long press on Type opens its flyout without choosing Type, and Vertical Type is chosen from it', firstShown && heldOpen && stillSelection && vertical, JSON.stringify({ firstShown, heldOpen, stillSelection, vertical }))
  // The one policy check: a tool the host denies is chosen neither by its key nor by its button.
  await slot('Selection').click()
  await page.evaluate(() => window.devHost.configure({ hide: [], disable: ['tool:Razor'] }))
  await until(async () => (await slot('Razor').isDisabled()), 20)
  await pressKey('C')
  await hold(200)
  const deniedByKey = (await activeTool()) === 'Selection'
  await page.evaluate(() => window.devHost.configure({ hide: [], disable: [] }))
  await until(async () => !(await slot('Razor').isDisabled()), 20)
  await pressKey('C')
  const allowedAgain = await until(async () => (await activeTool()) === 'Razor', 20)
  await slot('Selection').click()
  step('a tool the host disables is not chosen by its key, and is again once allowed', deniedByKey && allowedAgain, JSON.stringify({ deniedByKey, allowedAgain }))

  // The graphics tools on the Program monitor (upstream `graphics.rs` `monitor_overlay`): a Type
  // click makes a text clip on the top empty track and types into it in place; a click on the text
  // edits it again; a Rectangle drag adds a shape (into the selected graphic, upstream's
  // `canvas_target`); three Pen clicks and Enter make a path; Escape drops a Pen path. Each step
  // waits for the engine's revision; the history is undone at the end.
  if (await kit.getByTestId('film-message').count()) await kit.getByTestId('film-message').click()
  {
    const person = personRun
    const historyLength = async () => (await personHistory()).length
    const videoTracks = async () => (await details()).sequence.video ?? []
    const graphicList = async (clip) => {
      try {
        return (await person([{ command: 'graphics.list', params: { clip } }])).completed[0].result
      } catch (error) {
        const tracks = await videoTracks()
        throw new Error(`graphics.list of clip ${clip} failed: ${(error.message ?? String(error)).split('\n')[0]}; ${JSON.stringify({ inEngine: tracks.some((track) => (track.items ?? []).some((item) => item.clip === clip)), clips: tracks.map((track) => (track.items ?? []).map((item) => item.clip)), ...(await keyState()) })}`)
      }
    }
    const programCanvas = kit.locator('[data-testid="film-program"] canvas').first()
    /** The page point of sequence point (`x`, `y`) at the Program canvas's view. */
    const pagePoint = async (x, y) => {
      // The canvas's box and its view, once both hold still (a refit or a zoom eases over frames).
      const { view, region } = await heldStill(
        async () => {
          const shown = await kit.getByTestId('film-program').getAttribute('data-view', { timeout: 1000 }).catch(() => null)
          const box = await programCanvas.boundingBox({ timeout: 1000 }).catch(() => null)
          return shown && box ? { view: shown, region: box } : null
        },
        { what: 'the Program canvas and its view' },
      )
      const [zoom, vx, vy] = view.split(' ').map(Number)
      return { x: region.x + (x - vx) * zoom, y: region.y + (y - vy) * zoom }
    }
    const clickAt = async (x, y) => {
      const point = await pagePoint(x, y)
      await page.mouse.click(point.x, point.y)
    }
    const field = kit.getByTestId('film-program-text-edit')
    const penPoints = async () => Number(await kit.getByTestId('film-program-graphics').getAttribute('data-pen-points'))
    const historyFrom = await historyLength()
    const { width: W, height: H } = (await details()).sequence.settings
    // The whole picture in view: Fit again (the frame may have changed size since the monitor's steps).
    await kit.getByTestId('film-program-zoom').click()
    await kit.getByTestId('film-program-zoom-fit').click()
    await until(async () => (await kit.getByTestId('film-program-zoom').textContent()) === zh('Fit'))
    await person([
      { command: 'playhead.set', params: { seconds: 0.5 } },
      { command: 'timeline.select', params: { clips: [] } },
    ])
    const tracksBefore = await videoTracks()
    const clipsBefore = new Set(tracksBefore.flatMap((track) => (track.items ?? []).map((item) => item.clip)))
    // The top track with a clip under the playhead: new graphics go above it.
    const T = 254016000000
    const under = (track, at) => (track.items ?? []).some((item) => item.start <= at && at < item.start + item.duration)
    const playheadTicks = (await details()).playhead
    const topBusy = tracksBefore.map((track) => under(track, playheadTicks)).lastIndexOf(true)
    // Type: a click on empty picture makes point text and opens the field over it, focused. Keys
    // typed at once are the text's, never shortcuts (H would choose the Hand): upstream opens the
    // edit in the same frame as the click.
    await pressKey('T')
    await until(async () => (await activeTool()) === 'Type', 20)
    let at = await revision()
    await clickAt(W * 0.25, H * 0.3)
    await page.keyboard.type('Hello')
    const fieldShown = await until(async () => (await field.count()) === 1 && (await revision()) > at)
    await checkIds()
    const focused = await kitFrame().evaluate(() => document.activeElement?.getAttribute('data-testid'))
    const toolKept = (await activeTool()) === 'Type'
    const newClip = async () => (await videoTracks()).flatMap((track, index) => (track.items ?? []).filter((item) => !clipsBefore.has(item.clip)).map((item) => ({ ...item, track: index })))[0] ?? null
    const typed = await until(async () => {
      const made = await newClip()
      return made != null && (await graphicList(made.clip))?.layers?.[0]?.text === 'Hello'
    })
    const text = await newClip()
    await page.keyboard.press('Escape')
    const ended = await until(async () => (await field.count()) === 0)
    // The keyboard is the editor's again after Escape: a tool key works without a click.
    await page.keyboard.press('v')
    const keyAfterEscape = await until(async () => (await activeTool()) === 'Selection', 20)
    await pressKey('T')
    await until(async () => (await activeTool()) === 'Type', 20)
    const placed = text != null && text.track === topBusy + 1 && Math.abs(text.start - playheadTicks) <= T / 10
    step(
      'a Type click on the Program picture makes a text clip on the top empty track, typed into in place at once; Escape ends the edit and gives the keys back',
      fieldShown && focused === 'film-program-text-edit' && toolKept && typed && ended && keyAfterEscape && placed,
      JSON.stringify({ fieldShown, focused, toolKept, typed, ended, keyAfterEscape, text: text ? (await graphicList(text.clip))?.layers?.[0]?.text : null, track: text?.track, topBusy, said: await kit.getByTestId('film-message').textContent({ timeout: 200 }).catch(() => null) }),
    )
    // A click on the text layer edits it again; no new clip.
    const words = (await graphicList(text.clip)).layers[0]
    const xs = words.quad.map((corner) => corner[0])
    const ys = words.quad.map((corner) => corner[1])
    await clickAt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2)
    const reopened = await until(async () => (await field.count()) === 1 && (await field.inputValue()) === 'Hello')
    const refocused = await until(async () => (await kitFrame().evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'film-program-text-edit', 20)
    await page.keyboard.type('!')
    const appended = await until(async () => (await graphicList(text.clip))?.layers?.[0]?.text === 'Hello!')
    await page.keyboard.press('Escape')
    await until(async () => (await field.count()) === 0)
    const sameClips = (await videoTracks()).flatMap((track) => track.items ?? []).filter((item) => !clipsBefore.has(item.clip)).length === 1
    step('a Type click on a text layer edits it in place, making nothing new', reopened && refocused && appended && sameClips, JSON.stringify({ reopened, refocused, appended, sameClips, text: (await graphicList(text.clip))?.layers?.[0]?.text }))
    // Rectangle: a drag adds the shape, into the selected graphic under the playhead.
    await slot('Pen').click({ button: 'right' })
    await flyoutRow('Rectangle').click()
    await until(async () => (await activeTool()) === 'Rectangle', 20)
    const from = await pagePoint(W * 0.6, H * 0.25)
    const to = await pagePoint(W * 0.8, H * 0.55)
    at = await revision()
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
    const outlined = await until(async () => (await kit.locator('[data-testid="film-program-graphics"] rect.film-gfx-outline').count()) === 1, 20)
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await page.mouse.up()
    const shaped = await until(async () => (await revision()) > at && (await graphicList(text.clip))?.layers?.some((layer) => layer.kind === 'Rectangle'))
    const rectangle = (await graphicList(text.clip))?.layers?.find((layer) => layer.kind === 'Rectangle')
    const rx = rectangle?.quad?.map((corner) => corner[0]) ?? []
    const ry = rectangle?.quad?.map((corner) => corner[1]) ?? []
    const where = rectangle ? [Math.min(...rx), Math.min(...ry), Math.max(...rx), Math.max(...ry)].map(Math.round) : null
    const fits = where != null && [W * 0.6, H * 0.25, W * 0.8, H * 0.55].every((value, index) => Math.abs(where[index] - value) <= 4)
    step('a Rectangle drag on the Program picture draws its outline, then adds the shape where it was dragged', outlined && shaped && fits, JSON.stringify({ outlined, shaped, where }))
    // ---- rulers, guides, and guide templates (Task 22; upstream monitor_view.rs `route`,
    // `rulers`, `guides`, `snap_move`, and `dialogs`). Guides are UI state, so each step reads the
    // monitor's guides as drawn (`data-position`), and the templates from the engine's preferences.
    {
      const guide = (index) => kit.getByTestId(`film-program-guide-${index}`)
      const guidesShown = () => kit.getByTestId('film-program-guides')
      /** The positions of the Program's own guides, as drawn: `v640`, `h540`. */
      const guidePositions = () => kit.locator('[data-testid="film-program-guides"] .film-guide:not([data-preview]):not(.film-guide-new)').evaluateAll((items) => items.map((item) => `${item.getAttribute('data-vertical') === 'true' ? 'v' : 'h'}${item.getAttribute('data-position')}`))
      const previewPositions = () => kit.locator('[data-testid="film-program-guides"] .film-guide[data-preview]').evaluateAll((items) => items.map((item) => `${item.getAttribute('data-vertical') === 'true' ? 'v' : 'h'}${item.getAttribute('data-position')}`))
      const viewRow = async (command, submenu) => {
        await kit.getByTestId('film-menu-View').click()
        if (submenu) await kit.locator(`[data-kit-ui-id="menu:View/${submenu}"]`).hover()
        await kit.getByTestId(`film-control-${command}`).click()
      }
      const templatesInPrefs = async (on = page) => (await personRun([{ command: 'prefs.get', params: { key: 'guides.templates' } }], on)).completed[0].result ?? []
      const guideDialog = kit.getByTestId('film-guide-dialog')
      // View ▸ Show Rulers (the Program monitor: no monitor has focus but the Program's view acts).
      const viewBefore = await kit.getByTestId('film-program').getAttribute('data-view')
      await viewRow('view.showRulers')
      const rulersShown = await until(async () => (await kit.getByTestId('film-program-ruler-top').count()) === 1 && (await kit.getByTestId('film-program-ruler-left').count()) === 1)
      // The picture refits inside the rulers before the guide is placed.
      await until(async () => (await kit.getByTestId('film-program').getAttribute('data-view')) !== viewBefore, 30)
      await paintFrames(page, 3)
      await checkIds()
      // Drag a vertical guide out of the left ruler to x = W * 0.3: shown while dragged, placed on release in frame pixels.
      const left = await settledBox(kit.getByTestId('film-program-ruler-left'))
      const target = await pagePoint(Math.round(W * 0.3), H * 0.5)
      await page.mouse.move(left.x + 8, target.y)
      await page.mouse.down()
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(left.x + 8 + ((target.x - left.x - 8) * i) / 8, target.y)
        await hold(30)
      }
      const draggedOut = await until(async () => (await kit.getByTestId('film-program-guide-new').count()) === 1, 20)
      await page.mouse.up()
      const placedGuide = await until(async () => (await guidePositions()).length === 1)
      const guideX = Number(await guide(0).getAttribute('data-position'))
      step(
        'View ▸ Show Rulers draws the Program rulers; a guide dragged out of the left ruler shows while dragged and lands at the release, in frame pixels',
        rulersShown && draggedOut && placedGuide && Math.abs(guideX - Math.round(W * 0.3)) <= 2 && (await kit.getByTestId('film-control-view.showRulers').count()) === 0,
        JSON.stringify({ rulersShown, draggedOut, placedGuide, guideX, want: Math.round(W * 0.3), step: await kit.getByTestId('film-program-ruler-top').getAttribute('data-step') }),
      )
      // The Rectangle tool's drag snaps to the guide: pressed 5 points right of it (within 6), its left edge lands on it.
      const near = await pagePoint(guideX, H * 0.12)
      const far = await pagePoint(W * 0.45, H * 0.4)
      const shapesBefore = (await graphicList(text.clip))?.layers?.length ?? 0
      at = await revision()
      await page.mouse.move(near.x + 5, near.y)
      await page.mouse.down()
      await page.mouse.move(near.x + 40, near.y + 30, { steps: 6 })
      const snapShown = await until(async () => Number(await kit.getByTestId('film-program-graphics').getAttribute('data-snapped')) >= 1, 20)
      await page.mouse.move(far.x, far.y, { steps: 6 })
      await page.mouse.up()
      const snappedMade = await until(async () => (await revision()) > at && ((await graphicList(text.clip))?.layers?.length ?? 0) > shapesBefore)
      const snappedShape = ((await graphicList(text.clip))?.layers ?? []).filter((layer) => layer.kind === 'Rectangle').at(-1)
      const snappedLeft = snappedShape ? Math.min(...snappedShape.quad.map((corner) => corner[0])) : null
      step(
        "the Rectangle tool's drag snaps to the guide: pressed 5 points from it, the shape's left edge is on the guide, the snap line drawn while dragging",
        snapShown && snappedMade && snappedLeft != null && Math.abs(snappedLeft - guideX) <= 0.5,
        JSON.stringify({ snapShown, snappedMade, snappedLeft, guideX }),
      )
      if (snappedMade) {
        const undoFrom = await historyLength()
        await personUndo()
        await until(async () => (await historyLength()) === undoFrom - 1 && ((await graphicList(text.clip))?.layers?.length ?? 0) === shapesBefore)
      }
      // Lock Guides: a drag on the guide moves nothing (the Hand tool, so the picture takes no press). Unlocked, it moves; Escape drops a drag.
      await pressKey('H')
      await until(async () => (await activeTool()) === 'Hand', 20)
      const dragGuide = async (dx, { escape = false } = {}) => {
        const box = await settledBox(guide(0))
        const from = { x: box.x + box.width / 2, y: box.y + box.height * 0.6 }
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        for (let i = 1; i <= 6; i += 1) {
          await page.mouse.move(from.x + (dx * i) / 6, from.y)
          await hold(30)
        }
        if (escape) {
          await until(async () => (await guidesShown().getAttribute('data-dragging')) === 'move', 20)
          await page.keyboard.press('Escape')
        }
        await page.mouse.up()
        await paintFrames(page, 2)
      }
      await viewRow('view.lockGuides')
      const locked = await until(async () => (await guidesShown().getAttribute('data-locked')) === 'true')
      await dragGuide(60)
      const lockedKept = (await guidePositions()).join() === `v${guideX}`
      await viewRow('view.lockGuides')
      await until(async () => (await guidesShown().getAttribute('data-locked')) == null)
      await dragGuide(60, { escape: true })
      const escapeKept = (await guidePositions()).join() === `v${guideX}`
      await dragGuide(30)
      const moved = await until(async () => Number(await guide(0).getAttribute('data-position')) > guideX)
      const movedX = Number(await guide(0).getAttribute('data-position'))
      step('Lock Guides keeps a dragged guide in place; unlocked, Escape drops a drag and a drag moves it', locked && lockedKept && escapeKept && moved, JSON.stringify({ locked, lockedKept, escapeKept, moved, guideX, movedX, guides: await guidePositions() }))
      // View ▸ Add Guide… at 540 horizontal: the guide previews on the monitor while the dialog is open; Cancel leaves the guides exactly as they were.
      const before = await guidePositions()
      await viewRow('view.addGuide')
      await guideDialog.waitFor({ timeout: 5000 })
      await checkIds()
      const opensAt = await kit.getByTestId('film-guide-add-position').locator('input').inputValue()
      await kit.getByTestId('film-guide-add-horizontal').check()
      await kit.getByTestId('film-guide-add-position').locator('input').fill('540')
      await kit.getByTestId('film-guide-add-position').locator('input').press('Tab')
      const previewed = await until(async () => (await previewPositions()).join() === 'h540')
      const listed = await kit.getByTestId('film-guide-dialog-lines').textContent()
      const ownKept = (await guidePositions()).join() === before.join()
      await kit.locator('[data-testid="film-guide-dialog"] [data-kit-ui-id="control:dialog.cancel"]').click()
      const cancelled = await until(async () => (await guideDialog.count()) === 0 && (await previewPositions()).length === 0)
      const restored = (await guidePositions()).join() === before.join()
      step(
        'View ▸ Add Guide… at 540 horizontal previews the guide on the Program monitor and lists it; Cancel removes it and leaves the guides as they were',
        Number(opensAt) === Math.floor(W / 2) && previewed && ownKept && (listed ?? '').includes(zt('guides.horizontal', { position: 540 })) && cancelled && restored,
        JSON.stringify({ opensAt, previewed, listed, ownKept, cancelled, restored, before, now: await guidePositions() }),
      )
      // A second editor page, open before the template is saved, hears of it (the kit store carries the engine's preferences between pages).
      const page2 = await context.newPage()
      page2.on('pageerror', (error) => errors.push(`page 2: ${error.message}`))
      await page2.goto(`${origin}/dev.html`)
      await page2.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
      const kit2 = page2.frameLocator('#kit')
      await kit2.getByTestId('film-program-zoom').waitFor({ timeout: 20000 })
      await page.bringToFront()
      // Add Guide… OK adds the horizontal guide; then save both as "Thirds", whose strip lists them.
      await viewRow('view.addGuide')
      await guideDialog.waitFor({ timeout: 5000 })
      await kit.getByTestId('film-guide-add-horizontal').check()
      await kit.getByTestId('film-guide-add-position').locator('input').fill('480')
      await kit.getByTestId('film-guide-add-position').locator('input').press('Tab')
      await until(async () => (await previewPositions()).join() === 'h480')
      await kit.locator('[data-testid="film-guide-dialog"] [data-kit-ui-id="control:dialog.ok"]').click()
      const added = await until(async () => (await guideDialog.count()) === 0 && (await guidePositions()).join() === `v${movedX},h480`)
      await viewRow('view.guideTemplates.save', 'Guide Templates')
      await guideDialog.waitFor({ timeout: 5000 })
      await checkIds()
      await kit.getByTestId('film-guide-save-name').fill('Thirds')
      // The strip is drawn again for the typed name before it is read.
      await until(async () => ((await kit.getByTestId('film-guide-dialog-lines').textContent()) ?? '').includes('Thirds'), 30)
      const saveLines = await kit.getByTestId('film-guide-dialog-lines').textContent()
      await kit.locator('[data-testid="film-guide-dialog"] [data-kit-ui-id="control:dialog.ok"]').click()
      const thirds = [{ vertical: true, position: movedX }, { vertical: false, position: 480 }]
      const saved = await until(async () => JSON.stringify((await templatesInPrefs()).map((template) => [template.name, template.guides.map((each) => [each.vertical, each.position])])) === JSON.stringify([['Thirds', thirds.map((each) => [each.vertical, each.position])]]))
      step(
        'Save Guides as Template… "Thirds" lists the guides it saves, and puts them in the preferences',
        added && saved && (saveLines ?? '').includes(zt('guides.saves', { name: 'Thirds', count: 2 })) && pattern(ztRaw('guides.vertical'), { position: '\\d+' }).test(saveLines ?? '') && (saveLines ?? '').includes(zt('guides.horizontal', { position: 480 })),
        JSON.stringify({ added, saved, saveLines, prefs: await templatesInPrefs() }),
      )
      // Clear Guides, then Manage ▸ Apply previews "Thirds" until Cancel, and Close applies it.
      await viewRow('view.clearGuides')
      const clearedAll = await until(async () => (await guidePositions()).length === 0)
      const openManage = async () => {
        await viewRow('view.guideTemplates.manage', 'Guide Templates')
        await guideDialog.waitFor({ timeout: 5000 })
        await kit.getByTestId('film-guide-manage-row-Thirds').click()
        await kit.getByTestId('film-guide-manage-apply').click()
      }
      await openManage()
      await checkIds()
      const applyPreviewed = await until(async () => (await previewPositions()).join() === `v${movedX},h480` && (await guidePositions()).length === 0)
      await kit.locator('[data-testid="film-guide-dialog"] [data-kit-ui-id="control:dialog.cancel"]').click()
      const applyCancelled = await until(async () => (await guideDialog.count()) === 0 && (await previewPositions()).length === 0 && (await guidePositions()).length === 0)
      await openManage()
      await until(async () => (await previewPositions()).length === 2)
      await kit.locator('[data-testid="film-guide-dialog"] [data-kit-ui-id="control:dialog.ok"]').click()
      const appliedOnClose = await until(async () => (await guideDialog.count()) === 0 && (await guidePositions()).join() === `v${movedX},h480` && (await previewPositions()).length === 0)
      step('Clear Guides, then Manage ▸ Apply "Thirds" previews its guides until Cancel, and Close restores them', clearedAll && applyPreviewed && applyCancelled && appliedOnClose, JSON.stringify({ clearedAll, applyPreviewed, applyCancelled, appliedOnClose, guides: await guidePositions() }))
      // The second page sees "Thirds": in its engine's preferences and in its own Manage Guides.
      await page2.bringToFront()
      const inPage2 = await until(async () => (await templatesInPrefs(page2)).some((template) => template.name === 'Thirds'))
      await kit2.getByTestId('film-menu-View').click()
      await kit2.locator('[data-kit-ui-id="menu:View/Guide Templates"]').hover()
      await kit2.getByTestId('film-control-view.guideTemplates.manage').click()
      const listedOn2 = await kit2.getByTestId('film-guide-manage-row-Thirds').waitFor({ timeout: 5000 }).then(() => true, () => false)
      await kit2.locator('[data-testid="film-guide-dialog"] [data-kit-ui-id="control:dialog.cancel"]').click()
      step('a second editor page sees the "Thirds" template, in its preferences and its Manage Guides', inPage2 && listedOn2, JSON.stringify({ inPage2, listedOn2, prefs2: await templatesInPrefs(page2) }))
      // Preferences (every one, as upstream's preferences file): page A previews Clip ▸ Speed/Duration…
      // while page B saves another template; A takes it while previewing (a load runs no command, so
      // the preview gate does not refuse it), and A's next change of another preference keeps it.
      {
        const runOn = (on, steps) => personRun(steps, on)
        const prefOn = async (on, key) => (await runOn(on, [{ command: 'prefs.get', params: { key } }])).completed[0].result
        const names = (list) => (list ?? []).map((template) => template.name).sort().join()
        await page.bringToFront()
        const trimBefore = await prefOn(page, 'trim.largeTrimOffset')
        await person([{ command: 'timeline.select', params: { clips: [text.clip] } }])
        await kit.getByTestId('film-menu-Clip').click()
        await kit.getByTestId('film-cmd-clip.speedDuration').click()
        const previewing = await until(async () => (await previewState()).open, 50)
        const wide = { name: 'Wide', guides: [{ vertical: true, position: 100 }, { vertical: true, position: W - 100 }] }
        await runOn(page2, [{ command: 'prefs.set', params: { key: 'guides.templates', value: [...(await prefOn(page2, 'guides.templates')), wide] } }])
        const tookWhilePreviewing = await until(async () => names(await prefOn(page, 'guides.templates')) === 'Thirds,Wide' && (await previewState()).open, 50)
        await kit.locator('[data-testid="film-dialog"] [data-kit-ui-id="control:dialog.cancel"]').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        // A refreshes and changes another preference: B's template survives on both pages.
        await person([{ command: 'prefs.set', params: { key: 'trim.largeTrimOffset', value: trimBefore + 2 } }])
        const survived = await until(async () => names(await prefOn(page, 'guides.templates')) === 'Thirds,Wide' && names(await prefOn(page2, 'guides.templates')) === 'Thirds,Wide' && (await prefOn(page2, 'trim.largeTrimOffset')) === trimBefore + 2, 50)
        step(
          "page A previewing Speed/Duration… takes page B's new template, and A's next preference change keeps it on both pages",
          previewing && tookWhilePreviewing && survived,
          JSON.stringify({ previewing, tookWhilePreviewing, survived, a: names(await prefOn(page, 'guides.templates')), b: names(await prefOn(page2, 'guides.templates')), trim: [trimBefore, await prefOn(page2, 'trim.largeTrimOffset')] }),
        )
        // A view preset and the templates outlast the session: a new page (as a reload or another document opens) starts with them.
        await person([{ command: 'project.viewPreset.saveAs', params: { name: 'Kept' } }])
        const presetSlot = async (on) => ((await runOn(on, [{ command: 'project.viewPreset.list', params: {} }])).completed[0].result?.presets ?? []).find((preset) => preset.name === 'Kept')?.slot ?? null
        await until(async () => (await presetSlot(page2)) != null, 50)
        const page3 = await context.newPage()
        page3.on('pageerror', (error) => errors.push(`page 3: ${error.message}`))
        let reopened = null
        try {
          await page3.goto(`${origin}/dev.html`)
          await page3.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
          await page3.frameLocator('#kit').getByTestId('film-program-zoom').waitFor({ timeout: 20000 })
          reopened = { templates: names(await prefOn(page3, 'guides.templates')), preset: await presetSlot(page3), trim: await prefOn(page3, 'trim.largeTrimOffset') }
        } catch (error) {
          reopened = { error: error.message.split('\n')[0] }
        } finally {
          await page3.close()
        }
        await page.bringToFront()
        step('a view preset, the guide templates, and a preference outlast the session: a new page starts with them', reopened?.templates === 'Thirds,Wide' && reopened.preset != null && reopened.trim === trimBefore + 2, JSON.stringify(reopened))
        // Leave the preferences as they were for the later steps.
        const slot = await presetSlot(page)
        await person([...(slot != null ? [{ command: 'project.viewPreset.delete', params: { slot } }] : []), { command: 'prefs.set', params: { key: 'trim.largeTrimOffset', value: trimBefore } }])
        await until(async () => (await prefOn(page2, 'trim.largeTrimOffset')) === trimBefore && (await presetSlot(page2)) == null, 50)
      }
      await page2.close()
      await page.bringToFront()
      // Leave the monitor as it was: no guides, no rulers, the Rectangle tool.
      await viewRow('view.clearGuides')
      await viewRow('view.showRulers')
      await until(async () => (await kit.getByTestId('film-program-ruler-top').count()) === 0 && (await guidePositions()).length === 0)
      await slot('Pen').click({ button: 'right' })
      await flyoutRow('Rectangle').click()
      await until(async () => (await activeTool()) === 'Rectangle', 20)
      await paintFrames(page, 3)
    }
    // Pen: three clicks show the path, Enter makes it.
    await pressKey('P')
    await until(async () => (await activeTool()) === 'Pen', 20)
    const afterClicks = []
    for (const [x, y] of [[W * 0.15, H * 0.65], [W * 0.3, H * 0.65], [W * 0.22, H * 0.85]]) {
      await clickAt(x, y)
      await hold(350)
      afterClicks.push(await penPoints())
    }
    const shownPoints = await until(async () => (await penPoints()) === 3)
    await checkIds()
    at = await revision()
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('Enter')
    const pathMade = await until(async () => (await revision()) > at && (await graphicList(text.clip))?.layers?.some((layer) => layer.kind === 'Path'))
    // The overlay drops the pen points on its next paint after the path lands.
    const cleared = await until(async () => (await penPoints()) === 0, 20)
    step('three Pen clicks on the Program picture show the path, and Enter makes it a shape', shownPoints && pathMade && cleared, JSON.stringify({ shownPoints, pathMade, cleared, points: await penPoints(), afterClicks }))
    // Escape drops a Pen path; nothing is made.
    await clickAt(W * 0.15, H * 0.15)
    await hold(350)
    await clickAt(W * 0.3, H * 0.15)
    await until(async () => (await penPoints()) === 2)
    const layersBefore = (await graphicList(text.clip))?.layers?.length
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('Escape')
    const dropped = await until(async () => (await penPoints()) === 0)
    await hold(250)
    step('Escape drops a Pen path and makes nothing', dropped && (await graphicList(text.clip))?.layers?.length === layersBefore, JSON.stringify({ dropped, layersBefore }))
    // Ellipse: a drag adds an ellipse.
    const kinds = async () => ((await graphicList(text.clip))?.layers ?? []).map((layer) => layer.kind)
    const dragIn = async (a, b) => {
      const from = await pagePoint(...a)
      const to = await pagePoint(...b)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 10 })
      await page.mouse.up()
    }
    await slot('Pen').click({ button: 'right' })
    await flyoutRow('Ellipse').click()
    await until(async () => (await activeTool()) === 'Ellipse', 20)
    await dragIn([W * 0.4, H * 0.6], [W * 0.5, H * 0.8])
    const ellipsed = await until(async () => (await kinds()).includes('Ellipse'))
    step('an Ellipse drag on the Program picture adds an ellipse', ellipsed, JSON.stringify(await kinds()))
    // Type drag: paragraph text in the dragged box, typed into.
    await pressKey('T')
    await until(async () => (await activeTool()) === 'Type', 20)
    await dragIn([W * 0.55, H * 0.65], [W * 0.85, H * 0.9])
    const boxField = await until(async () => (await field.count()) === 1)
    await page.keyboard.type('Box')
    const boxed = await until(async () => ((await graphicList(text.clip))?.layers ?? []).some((layer) => layer.text === 'Box' && layer.textType === 'paragraph'))
    const paragraph = ((await graphicList(text.clip))?.layers ?? []).find((layer) => layer.text === 'Box')
    const boxFits = paragraph?.box != null && Math.abs(paragraph.box[0] - W * 0.3) <= 4 && Math.abs(paragraph.box[1] - H * 0.25) <= 4
    await page.keyboard.press('Escape')
    await until(async () => (await field.count()) === 0)
    step('a Type drag on the Program picture makes paragraph text in the dragged box', boxField && boxed && boxFits, JSON.stringify({ boxField, boxed, box: paragraph?.box }))
    // A Type box drag has no cancel (upstream's, and before the layer handles): Escape pressed
    // during it changes nothing, and the release still makes the box.
    {
      const from = await pagePoint(W * 0.05, H * 0.45)
      const to = await pagePoint(W * 0.3, H * 0.6)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 10 })
      const outlinedBox = await until(async () => (await kit.locator('[data-testid="film-program-graphics"] rect.film-gfx-edit').count()) === 1, 20)
      await page.keyboard.press('Escape')
      await paintFrames(page, 2)
      const keptAfterEscape = (await kit.locator('[data-testid="film-program-graphics"] rect.film-gfx-edit').count()) === 1
      await page.mouse.up()
      const escField = await until(async () => (await field.count()) === 1)
      await page.keyboard.type('Esc')
      const escBoxed = await until(async () => ((await graphicList(text.clip))?.layers ?? []).some((layer) => layer.text === 'Esc' && layer.textType === 'paragraph'))
      await page.keyboard.press('Escape')
      await until(async () => (await field.count()) === 0)
      step('Escape during a Type box drag cancels nothing: the outline stays and the release makes the paragraph box', outlinedBox && keptAfterEscape && escField && escBoxed, JSON.stringify({ outlinedBox, keptAfterEscape, escField, escBoxed }))
    }
    // Vertical Type: a click makes vertical point text, typed into in a vertical field.
    await slot('Type').click({ button: 'right' })
    await flyoutRow('VerticalType').click()
    await until(async () => (await activeTool()) === 'VerticalType', 20)
    await clickAt(W * 0.92, H * 0.15)
    await page.keyboard.type('Up')
    const verticalField = await until(async () => (await field.count()) === 1 && (await field.getAttribute('data-vertical')) === 'true')
    const verticalMade = await until(async () => ((await graphicList(text.clip))?.layers ?? []).some((layer) => layer.text === 'Up' && layer.textType === 'point'))
    await page.keyboard.press('Escape')
    await until(async () => (await field.count()) === 0)
    step('a Vertical Type click makes vertical point text, typed into in place', verticalField && verticalMade, JSON.stringify({ verticalField, verticalMade }))
    // Selection: a click selects a layer (its box drawn), a click on empty picture drops the
    // selected layers (the clip stays selected), and a double-click on text edits it.
    const graphicLayersNow = async () => (await person([{ command: 'state.inspect', params: {} }])).completed[0].result?.graphic_layers ?? null
    const layersList = (await graphicList(text.clip)).layers
    const rectangleIndex = layersList.findIndex((layer) => layer.kind === 'Rectangle')
    await slot('Selection').click()
    await until(async () => (await activeTool()) === 'Selection', 20)
    await clickAt(W * 0.7, H * 0.4)
    const picked = await until(async () => JSON.stringify(await graphicLayersNow()) === JSON.stringify([rectangleIndex]))
    const boxDrawn = await until(async () => Number(await kit.getByTestId('film-program-graphics').getAttribute('data-outlined')) === 1)
    // Select Next Layer (a key, no new revision) moves the box to the layer it selects.
    const outlinePoints = () => kit.locator('[data-testid="film-program-graphics"] .film-gfx-selected').first().getAttribute('points', { timeout: 2000 }).catch(() => null)
    const boxBefore = await outlinePoints()
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('ControlOrMeta+Alt+BracketRight')
    const stepped = await until(async () => JSON.stringify(await graphicLayersNow()) !== JSON.stringify([rectangleIndex]))
    const boxFollowed = await until(async () => {
      const now = await outlinePoints()
      return now != null && now !== boxBefore
    })
    // Deselect All: no selected graphic, no box.
    await page.keyboard.press('ControlOrMeta+Shift+a')
    const deselected = await until(async () => ((await details()).sequence.selection ?? []).length === 0)
    const boxGone = await until(async () => Number(await kit.getByTestId('film-program-graphics').getAttribute('data-outlined')) === 0)
    step(
      'the selected layer box follows Select Next Layer and goes with Deselect All',
      stepped && boxFollowed && deselected && boxGone,
      JSON.stringify({ stepped, boxFollowed, deselected, boxGone, boxBefore, box: await outlinePoints(), layers: await graphicLayersNow() }),
    )
    // Select the rectangle again for the next checks.
    await clickAt(W * 0.7, H * 0.4)
    await until(async () => JSON.stringify(await graphicLayersNow()) === JSON.stringify([rectangleIndex]))
    await clickAt(W * 0.96, H * 0.96)
    const unpicked = await until(async () => JSON.stringify(await graphicLayersNow()) === '[]')
    const clipKept = JSON.stringify((await details()).sequence.selection) === JSON.stringify([text.clip])
    const unoutlined = await until(async () => Number(await kit.getByTestId('film-program-graphics').getAttribute('data-outlined')) === 0)
    const hello = (await graphicList(text.clip)).layers.find((layer) => layer.text === 'Hello!')
    const hx = hello.quad.map((corner) => corner[0])
    const hy = hello.quad.map((corner) => corner[1])
    const helloAt = await pagePoint((Math.min(...hx) + Math.max(...hx)) / 2, (Math.min(...hy) + Math.max(...hy)) / 2)
    await page.mouse.dblclick(helloAt.x, helloAt.y)
    const doubleEdited = await until(async () => (await field.count()) === 1 && (await field.inputValue()) === 'Hello!')
    await page.keyboard.press('Escape')
    await until(async () => (await field.count()) === 0)
    step(
      'a Selection click selects a graphic layer and draws its box; a click on empty picture drops it; a double-click on text edits it',
      picked && boxDrawn && unpicked && clipKept && unoutlined && doubleEdited,
      JSON.stringify({ picked, boxDrawn, unpicked, clipKept, unoutlined, doubleEdited, layers: await graphicLayersNow(), rectangleIndex }),
    )
    // ---- the layer handles (Task 23; upstream graphics.rs `monitor_overlay`, `HandleDrag`, and
    // monitor_view.rs `snap_move`): a Selection drag moves a layer, a corner handle scales it, the
    // anchor point moves alone, and a move snaps to a guide. Each shows a live outline and sends
    // nothing until its release, then one graphics.set: one history step. Escape drops a drag.
    {
      const overlay = kit.getByTestId('film-program-graphics')
      const layerOf = async (test) => ((await graphicList(text.clip))?.layers ?? []).find(test)
      const centreOf = (quad) => ({ x: quad.reduce((sum, corner) => sum + corner[0], 0) / 4, y: quad.reduce((sum, corner) => sum + corner[1], 0) / 4 })
      const close = (a, b, tolerance = 1) => a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= tolerance)
      const zoomNow = async () => Number(((await kit.getByTestId('film-program').getAttribute('data-view')) ?? '').split(' ')[0])
      const cursorNow = () => programCanvas.evaluate((element) => element.style.cursor)
      /** Drags from page point `from` by (`dx`, `dy`) in steps; mid-drag it notes the live outline and that nothing was sent. */
      const dragBy = async (from, dx, dy, { escape = false, modifier = null } = {}) => {
        const stepsAt = await historyLength()
        if (modifier) await page.keyboard.down(modifier)
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        for (let i = 1; i <= 8; i += 1) {
          await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8)
          await hold(30)
        }
        await paintFrames(page, 2)
        const live = await until(async () => (await overlay.getAttribute('data-layer-drag')) != null, 20)
        const liveKind = await overlay.getAttribute('data-layer-drag')
        const snapped = Number(await overlay.getAttribute('data-snapped'))
        const unsent = (await historyLength()) === stepsAt
        if (escape) await page.keyboard.press('Escape')
        await page.mouse.up()
        if (modifier) await page.keyboard.up(modifier)
        return { live, liveKind, snapped, unsent, stepsAt }
      }
      await slot('Selection').click()
      await until(async () => (await activeTool()) === 'Selection', 20)
      // A drag on the text layer moves it (Cmd or Ctrl held: freely, no snapping); Escape first drops one.
      const hello = await layerOf((layer) => layer.text === 'Hello!')
      const helloAt = await pagePoint(centreOf(hello.quad).x, centreOf(hello.quad).y)
      await page.mouse.move(helloAt.x - 3, helloAt.y)
      await page.mouse.move(helloAt.x, helloAt.y)
      const moveCursor = await until(async () => (await cursorNow()) === 'move', 30)
      const zoom = await zoomNow()
      const escaped = await dragBy(helloAt, 60, 40, { escape: true })
      await paintFrames(page, 2)
      await hold(250)
      const escapeSentNothing = (await historyLength()) === escaped.stepsAt && close((await layerOf((layer) => layer.text === 'Hello!')).position, hello.position, 1e-6) && (await overlay.getAttribute('data-layer-drag')) == null
      const moved = await dragBy(helloAt, 60, 40, { modifier: 'ControlOrMeta' })
      const movedOnce = await until(async () => (await historyLength()) === moved.stepsAt + 1)
      const helloMoved = await layerOf((layer) => layer.text === 'Hello!')
      const movedBy = close(helloMoved.position, [hello.position[0] + 60 / zoom, hello.position[1] + 40 / zoom], 1.5)
      await personUndo()
      const undone = await until(async () => (await historyLength()) === moved.stepsAt && close((await layerOf((layer) => layer.text === 'Hello!')).position, hello.position, 1e-6))
      step(
        'with the Selection tool the Move cursor shows over a text layer, a drag moves it with a live outline and one history step that one undo reverts, and Escape drops a drag with nothing sent',
        moveCursor && escaped.live && escaped.unsent && escapeSentNothing && moved.live && moved.liveKind === 'move' && moved.unsent && movedOnce && movedBy && undone,
        JSON.stringify({ moveCursor, escaped, escapeSentNothing, moved, movedOnce, movedBy, from: hello.position, to: helloMoved?.position, zoom, undone }),
      )
      // A corner of the rectangle dragged out with Shift held: both axes scale alike (upstream's handles read no Shift), the opposite corner stays.
      const rectangle = await layerOf((layer) => layer.kind === 'Rectangle')
      const rectangleAt = await pagePoint(rectangle.quad[0][0] + (rectangle.quad[2][0] - rectangle.quad[0][0]) * 0.25, rectangle.quad[0][1] + (rectangle.quad[2][1] - rectangle.quad[0][1]) * 0.25)
      await page.mouse.click(rectangleAt.x, rectangleAt.y)
      const handlesShown = await until(async () => JSON.stringify(await graphicLayersNow()) === JSON.stringify([rectangleIndex]) && Number(await overlay.getAttribute('data-handles')) === 8)
      await checkIds()
      const corner = await settledBox(kit.locator('[data-kit-ui-id="control:program.layer.handle"][data-handle="2"]'))
      const scaled = await dragBy({ x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, 40, 20, { modifier: 'Shift' })
      const scaledOnce = await until(async () => (await historyLength()) === scaled.stepsAt + 1)
      const bigger = await layerOf((layer) => layer.kind === 'Rectangle')
      const uniform = bigger.scale > 100.5 && Math.abs(bigger.scale - bigger.scaleWidth) < 1e-6
      const pinned = close(bigger.quad[0], rectangle.quad[0], 1)
      step(
        'a corner handle of a rectangle dragged with Shift scales it with a live outline, both axes alike, its opposite corner staying, in one history step',
        handlesShown && scaled.live && scaled.liveKind === 'handle' && scaled.unsent && scaledOnce && uniform && pinned,
        JSON.stringify({ handlesShown, scaled, scaledOnce, scale: [bigger.scale, bigger.scaleWidth], before: rectangle.quad[0], after: bigger.quad[0] }),
      )
      // The anchor point dragged moves alone: the position follows it, so the rectangle stays where it is.
      // The box is drawn again after the scale lands: the cross is read once it has settled.
      const cross = await settledBox(kit.locator('[data-kit-ui-id="control:program.layer.anchor"]'))
      const anchored = await dragBy({ x: cross.x + cross.width / 2, y: cross.y + cross.height / 2 }, 30, 20)
      const anchoredOnce = await until(async () => (await historyLength()) === anchored.stepsAt + 1)
      const moved2 = await layerOf((layer) => layer.kind === 'Rectangle')
      const anchorMoved = moved2.anchor[0] > bigger.anchor[0] + 1 && moved2.anchor[1] > bigger.anchor[1] + 1
      const followed = close(moved2.position, [bigger.position[0] + 30 / zoom, bigger.position[1] + 20 / zoom], 1.5)
      const stayed = moved2.quad.every((point, index) => close(point, bigger.quad[index], 1))
      step(
        "the rectangle's anchor point dragged moves alone: anchor and position change in one history step and the shape stays where it was",
        anchored.live && anchored.liveKind === 'anchor' && anchored.unsent && anchoredOnce && anchorMoved && followed && stayed,
        JSON.stringify({ anchored, anchoredOnce, anchor: [bigger.anchor, moved2.anchor], position: [bigger.position, moved2.position], stayed }),
      )
      // With a guide shown, a move snaps the box's left edge onto it: pressed so the edge ends 4 points from the guide.
      const viewMenuRow = async (command) => {
        await kit.getByTestId('film-menu-View').click()
        await kit.getByTestId(`film-control-${command}`).click()
      }
      const left = Math.min(...moved2.quad.map((point) => point[0]))
      const guideX = Math.round(left - 100)
      await viewMenuRow('view.addGuide')
      await kit.getByTestId('film-guide-dialog').waitFor({ timeout: 5000 })
      await kit.getByTestId('film-guide-add-vertical').check()
      await kit.getByTestId('film-guide-add-position').locator('input').fill(String(guideX))
      await kit.getByTestId('film-guide-add-position').locator('input').press('Tab')
      await kit.locator('[data-testid="film-guide-dialog"] [data-kit-ui-id="control:dialog.ok"]').click()
      const guideAdded = await until(async () => (await kit.getByTestId('film-guide-dialog').count()) === 0 && (await kit.getByTestId('film-program-guides').getAttribute('data-count')) === '1')
      const inside = await pagePoint(moved2.quad[0][0] + (moved2.quad[2][0] - moved2.quad[0][0]) * 0.25, moved2.quad[0][1] + (moved2.quad[2][1] - moved2.quad[0][1]) * 0.75)
      const snappedMove = await dragBy(inside, -(left - guideX) * zoom + 4, 0)
      const snappedOnce = await until(async () => (await historyLength()) === snappedMove.stepsAt + 1)
      const onGuide = await layerOf((layer) => layer.kind === 'Rectangle')
      const snappedLeft = Math.min(...onGuide.quad.map((point) => point[0]))
      await viewMenuRow('view.clearGuides')
      await until(async () => (await kit.getByTestId('film-program-guides').getAttribute('data-count')) === '0')
      step(
        "with a guide shown, a layer move snaps: its box's left edge, released 4 points from the guide, lands on it, the snap line drawn while dragging",
        guideAdded && snappedMove.live && snappedMove.snapped >= 1 && snappedMove.unsent && snappedOnce && Math.abs(snappedLeft - guideX) <= 0.5,
        JSON.stringify({ guideAdded, snappedMove, snappedOnce, snappedLeft, guideX }),
      )
      // An edge handle stretches one axis only (uniform_scale false): the rectangle's right edge dragged out widens it, its height kept.
      await paintFrames(page, 2)
      const edge = await settledBox(kit.locator('[data-kit-ui-id="control:program.layer.handle"][data-handle="5"]'))
      const stretched = await dragBy({ x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 }, 50, 0)
      const stretchedOnce = await until(async () => (await historyLength()) === stretched.stepsAt + 1)
      const wide = await layerOf((layer) => layer.kind === 'Rectangle')
      const oneAxis = wide.scaleWidth > onGuide.scaleWidth + 1 && Math.abs(wide.scale - onGuide.scale) < 1e-6 && Math.abs(wide.scale - wide.scaleWidth) > 1
      const leftKept = Math.abs(Math.min(...wide.quad.map((point) => point[0])) - snappedLeft) <= 1
      step(
        "an edge handle of the rectangle dragged out stretches only its width (uniform_scale false: its X and Y scales differ), its left edge staying, in one history step",
        stretched.live && stretched.liveKind === 'handle' && stretched.unsent && stretchedOnce && oneAxis && leftKept,
        JSON.stringify({ stretched, stretchedOnce, before: [onGuide.scale, onGuide.scaleWidth], after: [wide.scale, wide.scaleWidth], leftKept }),
      )
      // An unselected paragraph box that hides text moves with one Selection drag, as upstream: the
      // press reads it unselected (its overflow not laid out), the drag selects it, and the release
      // still finds it where it was.
      const madeHiding = (await person([{ command: 'graphics.newText', params: { text: 'Words that a small box cannot hold at all', clip: text.clip, position: [Math.round(W * 0.06), Math.round(H * 0.78)], box: [Math.round(W * 0.12), Math.round(H * 0.06)], size: Math.round(H * 0.05) } }])).completed[0].result
      await person([{ command: 'graphics.selectLayer', params: { clip: text.clip, layers: [rectangleIndex] } }])
      await until(async () => JSON.stringify(await graphicLayersNow()) === JSON.stringify([rectangleIndex]))
      const hiding = await layerOf((layer) => layer.layer === madeHiding.layer)
      const hidingAt = await pagePoint(centreOf(hiding.quad).x, centreOf(hiding.quad).y)
      const hidingMove = await dragBy(hidingAt, 40, -20, { modifier: 'ControlOrMeta' })
      const hidingOnce = await until(async () => (await historyLength()) === hidingMove.stepsAt + 1)
      const hidingMoved = await layerOf((layer) => layer.layer === madeHiding.layer)
      step(
        'an unselected paragraph box that hides text moves with one Selection drag, in one history step',
        hiding.overflow === true && hidingMove.live && hidingMove.liveKind === 'move' && hidingMove.unsent && hidingOnce && close(hidingMoved.position, [hiding.position[0] + 40 / zoom, hiding.position[1] - 20 / zoom], 1.5),
        JSON.stringify({ overflow: hiding.overflow, hidingMove, hidingOnce, from: hiding.position, to: hidingMoved?.position, zoom }),
      )
      // A layer an agent changes during the drag: the release sends nothing, and the status bar says why.
      {
        const before = await layerOf((layer) => layer.layer === madeHiding.layer)
        const at = await pagePoint(centreOf(before.quad).x, centreOf(before.quad).y)
        const stepsAt = await historyLength()
        await page.keyboard.down('ControlOrMeta')
        await page.mouse.move(at.x, at.y)
        await page.mouse.down()
        for (let i = 1; i <= 6; i += 1) {
          await page.mouse.move(at.x + 5 * i, at.y)
          await hold(30)
        }
        const dragged = await until(async () => (await overlay.getAttribute('data-layer-drag')) != null, 30)
        const agentAt = [before.position[0], before.position[1] + 30]
        // The agent's step is in the agent's own history (KitModel 1.1 M12a), not the person's.
        const agentSteps = async () => (await agentRun([{ command: 'history.list', params: {} }])).completed[0].result?.undo?.length ?? -1
        const agentFrom = await agentSteps()
        await agentRun([{ command: 'graphics.set', params: { clip: text.clip, layer: madeHiding.layer, props: { position: agentAt } } }])
        await until(async () => (await agentSteps()) === agentFrom + 1)
        await page.mouse.up()
        await page.keyboard.up('ControlOrMeta')
        // The editor's own string, in whichever locale the page runs.
        const layerChanged = Object.values(CATALOGS).map((catalog) => catalog.layerChanged).filter(Boolean)
        const said = await until(async () => {
          const message = (await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => '')) ?? ''
          return layerChanged.some((text) => message.includes(text))
        })
        await hold(300)
        const agentKept = close((await layerOf((layer) => layer.layer === madeHiding.layer)).position, agentAt, 1e-6) && (await agentSteps()) === agentFrom + 1 && (await historyLength()) === stepsAt
        step(
          "a layer an agent changes during a drag: the release sends nothing, the agent's change stays, and the status bar says the drag was dropped",
          dragged && said && agentKept,
          JSON.stringify({ dragged, said, agentKept, message: await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => null) }),
        )
        if (await kit.getByTestId('film-message').count()) await kit.getByTestId('film-message').click()
      }
      // A host that disables control:program.layer: no Move cursor over a layer, and a Selection click or drag on it does nothing.
      {
        await person([{ command: 'graphics.selectLayer', params: { clip: text.clip, layers: [rectangleIndex] } }])
        await until(async () => JSON.stringify(await graphicLayersNow()) === JSON.stringify([rectangleIndex]))
        await page.evaluate(() => window.devHost.configure({ hide: [], disable: ['control:program.layer'] }))
        await paintFrames(page, 2)
        const target = await layerOf((layer) => layer.layer === madeHiding.layer)
        const at = await pagePoint(centreOf(target.quad).x, centreOf(target.quad).y)
        await page.mouse.move(at.x - 3, at.y)
        await page.mouse.move(at.x, at.y)
        await hold(300)
        const cursor = await cursorNow()
        const stepsAt = await historyLength()
        await page.mouse.click(at.x, at.y)
        await hold(400)
        const unselected = JSON.stringify(await graphicLayersNow()) === JSON.stringify([rectangleIndex])
        await page.mouse.move(at.x, at.y)
        await page.mouse.down()
        await page.mouse.move(at.x + 40, at.y + 20, { steps: 8 })
        await page.mouse.up()
        await hold(400)
        const unmoved = (await historyLength()) === stepsAt && close((await layerOf((layer) => layer.layer === madeHiding.layer)).position, target.position, 1e-6)
        await page.evaluate(() => window.devHost.configure({ hide: [], disable: [] }))
        step('with control:program.layer disabled by the host, a layer shows no Move cursor, and a Selection click or drag on it does nothing', cursor !== 'move' && unselected && unmoved, JSON.stringify({ cursor, unselected, unmoved, layers: await graphicLayersNow() }))
      }
    }
    // The press goes by tool (monitor.rs: `pan_input`, then the overlay): at 200% a Selection drag
    // does not pan, a Hand drag does; at Fit the Hand does not pan either.
    const viewOf = async () => (await kit.getByTestId('film-program').getAttribute('data-view')) ?? ''
    const dragPicture = async () => {
      const region = await settledBox(programCanvas)
      const start = { x: region.x + region.width * 0.3, y: region.y + region.height * 0.5 }
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(start.x + 60, start.y + 30, { steps: 6 })
      await page.mouse.up()
      await hold(300)
    }
    await kit.getByTestId('film-program-zoom').click()
    await kit.getByTestId('film-program-zoom-200').click()
    await until(async () => (await kit.getByTestId('film-program-zoom').textContent()) === '200%')
    await paintFrames(page, 4)
    await slot('Selection').click()
    const zoomedFrom = await viewOf()
    await dragPicture()
    const selectionKept = (await viewOf()) === zoomedFrom
    await pressKey('H')
    await until(async () => (await activeTool()) === 'Hand', 20)
    await dragPicture()
    const handPanned = await until(async () => (await viewOf()) !== zoomedFrom, 20)
    await kit.getByTestId('film-program-zoom').click()
    await kit.getByTestId('film-program-zoom-fit').click()
    await until(async () => (await kit.getByTestId('film-program-zoom').textContent()) === zh('Fit'))
    await paintFrames(page, 4)
    const fitFrom = await viewOf()
    await dragPicture()
    const fitKept = (await viewOf()) === fitFrom
    step('on the Program picture only the Hand pans, and only a magnified picture', selectionKept && handPanned && fitKept, JSON.stringify({ selectionKept, handPanned, fitKept, zoomedFrom, fitFrom, now: await viewOf() }))
    // Leave the sequence as it was.
    await slot('Selection').click()
    const made = (await historyLength()) - historyFrom
    if (made > 0) await personUndo(made)
    await until(async () => (await historyLength()) === historyFrom)
  }

  // Timeline editing (upstream `panels/timeline.rs` `interact`): each tool's gesture sends one
  // engine command on release, one history step, and undo restores it. Every step waits for the
  // engine's revision. The sequence is rebuilt first: two pieces of bars.mp4 on V1 and A1, each
  // with handles on both sides.
  // A status message left by the steps before (a refused key's "Not available in this editor yet")
  // is clicked away first, so a step's `said` detail is its own.
  if (await kit.getByTestId('film-message').count()) await kit.getByTestId('film-message').click()
  {
    const T = 254016000000
    const person = personRun
    const seq = async () => (await details()).sequence
    const v1 = async () => (await seq()).video[0].items ?? []
    const clipOf = async (id) => [...(await seq()).video, ...(await seq()).audio].flatMap((track) => track.items ?? []).find((item) => item.clip === id)
    const history = async () => (await kitFrame().evaluate(() => window.filmPreview.history()))?.undo?.length ?? -1
    /** Runs `action` and waits for the engine's next revision, then for `settled` (the editor's own drawing). */
    const edited = async (action, settled = async () => true) => {
      const before = await revision()
      await action()
      return until(async () => (await revision()) > before && (await settled()))
    }
    /** A clip's box once it stops moving (the zoom eases; an edit redraws). */
    const box = async (id) => {
      // A clip drawn again (an undo, a redraw) is briefly not in the page: a miss is sampled again.
      let previous = null
      let now = null
      for (let i = 0; i < 60; i += 1) {
        now = await kit.getByTestId(`film-clip-${id}`).boundingBox({ timeout: 2000 }).catch(() => null)
        if (now && previous && Math.abs(now.x - previous.x) < 0.5 && Math.abs(now.width - previous.width) < 0.5) return now
        previous = now
        await hold(50)
      }
      // Not settled: the last sample, if the clip is still there.
      if (!now) {
        const drawn = await kit.getByTestId(`film-clip-${id}`).count()
        const inEngine = [...(await seq()).video, ...(await seq()).audio].some((track) => (track.items ?? []).some((item) => item.clip === id))
        throw new Error(`clip ${id} disappeared: ${JSON.stringify({ drawn, inEngine, ...(await keyState()) })}`)
      }
      return now
    }
    const drag = async (from, to) => {
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 8 })
      await page.mouse.up()
    }
    // The newest step's undo (the person's Ctrl+Z, or the agent's edit.undo for a step the agent made).
    const undoKey = undoLatest
    const said = () => kit.getByTestId('film-message').textContent({ timeout: 200 }).catch(() => null)
    /** For a check that nothing was sent: two animation frames and a short wait, so a late command would have landed. */
    const settle = async () => {
      await kitFrame().evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await hold(250)
      await person([{ command: 'state.inspect', params: {} }])
    }
    const all = [...(await seq()).video, ...(await seq()).audio].flatMap((track) => (track.items ?? []).map((item) => item.clip))
    const media = await page.evaluate(async () => {
      const find = (node) => (node?.name?.includes('bars') && node.item != null ? node : (node?.children ?? []).map(find).find(Boolean))
      return find((await window.devHost.connection().ai.inspect()).details.project?.root)
    })
    const rate = (await seq()).settings.frame_rate
    const frameTicks = (T * rate.den) / rate.num
    const piece = Math.floor(media.duration / 4 / frameTicks) * frameTicks
    await person([
      { command: 'timeline.select', params: { clips: all } },
      { command: 'edit.delete', params: {} },
      { command: 'marker.clearInOut', params: {} },
      { command: 'playhead.set', params: { seconds: 0 } },
      { command: 'timeline.place', params: { item: media.item, track: 'V1', audioTrack: 'A1', time: 0, sourceIn: piece, duration: piece } },
      { command: 'timeline.place', params: { item: media.item, track: 'V1', audioTrack: 'A1', time: piece, sourceIn: piece * 2, duration: piece } },
      { command: 'timeline.select', params: { clips: [] } },
    ])
    await until(async () => (await v1()).length === 2)
    const [A, B] = (await v1()).sort((a, b) => a.start - b.start)
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('\\')
    await pressKey('V')
    const aBox = await box(A.clip)
    const mid = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    step('the rebuilt sequence shows its two clips', aBox != null && (await v1()).length === 2, JSON.stringify({ A: A.clip, B: B.clip, piece, aBox }))

    // One gesture, one history step: a drag of an unselected clip selects it and moves it, and only the move is a step.
    const stepsBefore = await history()
    const moved = await edited(() => drag(mid(aBox), { x: mid(aBox).x + 60, y: mid(aBox).y }), async () => (await clipOf(A.clip)).start > A.start)
    const stepsAfter = await history()
    await edited(undoKey, async () => (await clipOf(A.clip)).start === A.start)
    step('a Selection drag moves the clip in one history step, and undo puts it back', moved && stepsAfter === stepsBefore + 1 && (await clipOf(A.clip)).start === A.start, JSON.stringify({ moved, stepsBefore, stepsAfter, said: await said() }))

    // A drag draws its preview without the engine; brought back to where it began, its release sends nothing.
    await edited(() => kit.getByTestId(`film-clip-${A.clip}`).click(), async () => (await seq()).selection?.includes(A.clip))
    const backFrom = await revision()
    const backBox = await box(A.clip)
    await page.mouse.move(mid(backBox).x, mid(backBox).y)
    await page.mouse.down()
    await page.mouse.move(mid(backBox).x + 80, mid(backBox).y, { steps: 8 })
    // The drag's preview is drawn a frame or more after the pointer moves.
    const previewed = await until(async () => (await box(A.clip)).x > backBox.x + 40, 30)
    const midDrag = await revision()
    await page.mouse.move(mid(backBox).x, mid(backBox).y, { steps: 8 })
    await page.mouse.up()
    await settle()
    const backTo = await revision()
    step('a drag draws its preview without the engine, and one brought back to where it began sends nothing', previewed && midDrag === backFrom && backTo === backFrom && (await clipOf(A.clip)).start === A.start && (await box(A.clip)).x === backBox.x, JSON.stringify({ previewed, backFrom, midDrag, backTo }))

    // Alt-click selects one side of a link (timeline.select with linked: false); a plain click selects both.
    await edited(() => person([{ command: 'timeline.select', params: { clips: [] } }]))
    const partner = (await clipOf(A.clip)).link != null ? (await seq()).audio.flatMap((track) => track.items ?? []).find((item) => item.link === A.link)?.clip : null
    await edited(() => kit.getByTestId(`film-clip-${A.clip}`).click(), async () => (await seq()).selection?.length === 2)
    const both = JSON.stringify([...((await seq()).selection ?? [])].sort((a, b) => a - b))
    await edited(() => person([{ command: 'timeline.select', params: { clips: [] } }]))
    await kit.getByTestId(`film-clip-${A.clip}`).click({ modifiers: ['Alt'] })
    const oneSide = await until(async () => JSON.stringify((await seq()).selection) === JSON.stringify([A.clip]), 30)
    await settle()
    const stillOne = JSON.stringify((await seq()).selection) === JSON.stringify([A.clip])
    step('Alt-click selects one side of a linked clip; a click selects both', partner != null && both === JSON.stringify([A.clip, partner].sort((a, b) => a - b)) && oneSide && stillOne, JSON.stringify({ partner, both, selection: (await seq()).selection }))

    // Ctrl-click on macOS is a plain primary press, as upstream gets it from winit: it selects, and opens no clip menu.
    if (mac) {
      await edited(() => person([{ command: 'timeline.select', params: { clips: [] } }]))
      // A browser on macOS adds a contextmenu (button 0, Ctrl) to the press; a test browser does not, so it is sent
      // here. The press itself goes without a held Control key (no tool reads Ctrl on macOS, and a held key can
      // outlast the step in WebKit).
      const ctrlBox = await box(A.clip)
      await page.mouse.move(mid(ctrlBox).x, mid(ctrlBox).y)
      await page.mouse.down()
      await kitFrame().evaluate(({ id }) => {
        const clip = document.querySelector(`[data-testid="film-clip-${id}"]`)
        const frame = clip.getBoundingClientRect()
        clip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: frame.left + frame.width / 2, clientY: frame.top + frame.height / 2 }))
      }, { id: A.clip })
      await page.mouse.up()
      const ctrlSelected = await until(async () => (await seq()).selection?.includes(A.clip), 30)
      await settle()
      const ctrlMenu = await kit.getByTestId('film-clip-menu').count()
      if (ctrlMenu) await page.keyboard.press('Escape')
      step('on macOS a Ctrl-click on a clip selects it and opens no clip menu (upstream: a primary press)', ctrlSelected && ctrlMenu === 0, JSON.stringify({ ctrlSelected, ctrlMenu, selection: (await seq()).selection }))
    }

    // Razor: a click on A cuts it in two at the frame there.
    await pressKey('C')
    const razorBox = await box(A.clip)
    const cut = await edited(() => page.mouse.click(razorBox.x + razorBox.width * 0.5, razorBox.y + razorBox.height / 2), async () => (await v1()).length === 3)
    const pieces = (await v1()).filter((item) => item.clip === A.clip || item.start < B.start)
    const onFrame = pieces.every((item) => item.start % frameTicks === 0)
    await edited(undoKey, async () => (await v1()).length === 2)
    step('Razor cuts a clip in two on a frame, and undo joins it', cut && pieces.length === 2 && pieces[0].duration + pieces[1].duration === A.duration && onFrame && (await v1()).length === 2, JSON.stringify({ pieces: pieces.map((item) => [item.start, item.duration]), said: await said() }))

    // Razor on an empty stretch of a track is not a cut: a click there clears the selection, as with Selection.
    await edited(() => person([{ command: 'timeline.select', params: { clips: [A.clip] } }]), async () => (await seq()).selection?.includes(A.clip))
    const gapBox = await box(B.clip)
    const gap = { x: gapBox.x + gapBox.width + 40, y: gapBox.y + gapBox.height / 2 }
    await page.mouse.click(gap.x, gap.y)
    const gapCleared = await until(async () => ((await seq()).selection ?? []).length === 0, 30)
    await settle()
    step('Razor on an empty track clears the selection and cuts nothing', gapCleared && (await v1()).length === 2, JSON.stringify({ selection: (await seq()).selection, clips: (await v1()).length, said: await said() }))

    // Selection on A's Out edge: a regular trim; B stays.
    await pressKey('V')
    const trimBox = await box(A.clip)
    const out = { x: trimBox.x + trimBox.width - 3, y: trimBox.y + trimBox.height / 2 }
    const editPoints = async () => (await person([{ command: 'state.inspect', params: {} }])).completed[0].result.edit_points ?? []
    // Held still 0.9 s, past egui's 0.8 s click time, the press is a drag that goes nowhere: nothing is sent, no edit point.
    const heldPointsBefore = JSON.stringify(await editPoints())
    const heldFrom = await revision()
    await page.mouse.move(out.x, out.y)
    await page.mouse.down()
    await hold(900)
    await page.mouse.up()
    await settle()
    const heldPoints = JSON.stringify(await editPoints())
    const heldTo = await revision()
    step('a press held still 0.9 s on an edge is a drag that sends nothing: no edit point, no edit', heldPointsBefore === '[]' && heldPoints === '[]' && heldTo === heldFrom && (await clipOf(A.clip)).duration === A.duration, JSON.stringify({ heldPointsBefore, heldPoints, heldFrom, heldTo }))
    // A quick click on the same edge selects it as an edit point (session state, no new revision), which the Timeline marks with a bracket.
    await page.mouse.click(out.x, out.y)
    const pointed = await until(async () => JSON.stringify(await editPoints()) === JSON.stringify([{ clip: A.clip, kind: 'trim', out: true }]) && (await kit.getByTestId('film-edit-point').count()) === 1)
    const trimmed = await edited(() => drag(out, { x: out.x - 40, y: out.y }), async () => (await clipOf(A.clip)).duration < A.duration)
    const trimmedB = await clipOf(B.clip)
    await edited(undoKey, async () => (await clipOf(A.clip)).duration === A.duration)
    step("a click on a clip's edge marks it as an edit point; dragging it with Selection trims, and the next clip stays", pointed && trimmed && trimmedB.start === B.start, JSON.stringify({ pointed, trimmed, B: trimmedB?.start, said: await said() }))

    // Ripple on A's Out edge: B follows to the left.
    await pressKey('B')
    const rippleBox = await box(A.clip)
    const rippleOut = { x: rippleBox.x + rippleBox.width - 3, y: rippleBox.y + rippleBox.height / 2 }
    const rippled = await edited(() => drag(rippleOut, { x: rippleOut.x - 40, y: rippleOut.y }), async () => (await clipOf(B.clip)).start < B.start)
    const rippledA = await clipOf(A.clip)
    await edited(undoKey, async () => (await clipOf(B.clip)).start === B.start)
    step("a Ripple trim of the first clip's Out moves the second clip left", rippled && rippledA.duration < A.duration, JSON.stringify({ rippled, B: (await clipOf(B.clip)).start, said: await said() }))

    // Slip on B: its source In changes, its place does not.
    await pressKey('Y')
    const slipBox = await box(B.clip)
    const slipped = await edited(() => drag(mid(slipBox), { x: mid(slipBox).x - 30, y: mid(slipBox).y }), async () => (await clipOf(B.clip)).sourceIn !== B.sourceIn)
    const slippedB = await clipOf(B.clip)
    await edited(undoKey, async () => (await clipOf(B.clip)).sourceIn === B.sourceIn)
    step('Slip changes sourceIn and not start', slipped && slippedB.start === B.start && slippedB.sourceIn > B.sourceIn, JSON.stringify({ slipped, sourceIn: [B.sourceIn, slippedB?.sourceIn], start: [B.start, slippedB?.start], said: await said() }))

    // I and O around A, then ; lifts (B keeps its place: the sequence keeps its length) and ' extracts (it shrinks).
    await pressKey('V')
    const duration = (await seq()).duration
    await person([{ command: 'playhead.set', params: { seconds: 0 } }])
    await until(async () => (await details()).playhead === 0)
    await edited(() => pressKey('I'), async () => (await seq()).in === 0)
    await person([{ command: 'playhead.set', params: { frame: Math.round((A.start + A.duration) / frameTicks) - 1 } }])
    await until(async () => (await details()).playhead > 0)
    await edited(() => pressKey('O'), async () => (await seq()).out != null)
    const lifted = await edited(() => pressKey(';'), async () => !(await v1()).some((item) => item.clip === A.clip))
    const liftedDuration = (await seq()).duration
    const liftedB = await clipOf(B.clip)
    await edited(undoKey, async () => (await v1()).some((item) => item.clip === A.clip))
    await edited(() => pressKey("'"), async () => (await seq()).duration < duration)
    const extractedDuration = (await seq()).duration
    await edited(undoKey, async () => (await seq()).duration === duration)
    step('I and O, then ; lifts and \' extracts: only extract shortens the sequence', lifted && liftedDuration === duration && liftedB.start === B.start && extractedDuration < duration && (await seq()).duration === duration, JSON.stringify({ duration, liftedDuration, extractedDuration, said: await said() }))
    await person([{ command: 'marker.clearInOut', params: {} }])

    // Right-click ▸ Speed/Duration… opens the command's dialog; the clip right-clicked is selected first.
    await edited(() => person([{ command: 'timeline.select', params: { clips: [] } }]))
    const menuBox = await box(A.clip)
    await page.mouse.click(mid(menuBox).x, mid(menuBox).y, { button: 'right' })
    await kit.getByTestId('film-clip-menu').waitFor({ timeout: 5000 })
    const selectedByMenu = await until(async () => (await seq()).selection?.includes(A.clip), 30)
    // The menu follows the editor's selection, which lands after the engine's.
    const unlinkShown = await until(async () => (await kit.getByTestId('film-cmd-clip.link').textContent()) === zh('Unlink'), 30)
    await checkIds()
    await kit.getByTestId('film-cmd-clip.speedDuration').click()
    const dialog = await until(async () => (await kit.locator('.kui-dialog').count()) > 0, 30)
    await page.keyboard.press('Escape')
    await until(async () => (await kit.locator('.kui-dialog').count()) === 0, 30)
    step('right-click selects the clip and Speed/Duration… opens its dialog', selectedByMenu && unlinkShown && dialog, JSON.stringify({ selectedByMenu, unlinkShown, dialog }))

    // Clip ▸ Speed/Duration… previews on the scratch session (Task 9; upstream's dialog has no
    // preview): at 50% with Ripple the Program monitor shows the clip past its old end, and the
    // Timeline draws the clip twice as long with a ghost where it was, and B's old place ghosted
    // (Task 10), so the strip lists nothing of the timeline.
    // The clip selected and the playhead past its end, before a step records the document.
    const speedSetup = async () => {
      const at = A.start + Math.round(A.duration * 1.25)
      await person([{ command: 'timeline.select', params: { clips: [A.clip] } }, { command: 'playhead.set', params: { time: at } }])
      await waitForEngine(page, (state) => Math.abs((state.details?.playhead ?? -Infinity) - at) <= frameTicks * 2 && state.details?.sequence?.selection?.includes(A.clip))
    }
    const speedDialog = async () => {
      await kit.getByTestId('film-menu-Clip').click()
      await kit.getByTestId('film-cmd-clip.speedDuration').click()
    }
    const halfSpeed = async () => {
      await kit.locator('[data-testid="film-dialog-speedDuration-speed"] input').fill('50')
      await kit.locator('[data-testid="film-dialog-speedDuration-speed"] input').press('Tab')
      await kit.getByTestId('film-dialog-speedDuration-ripple').check()
    }
    let readout = null
    let onTimeline = null
    await speedSetup()
    // Escape with focus in the Speed field (a number field with nothing typed) cancels, as Cancel does.
    const speedCancel = await previewThenCancel({
      open: speedDialog,
      change: halfSpeed,
      escape: '[data-testid="film-dialog-speedDuration-speed"] input',
      expectPreview: async () => {
        const badge = await until(async () => (await kit.getByTestId('film-program-preview-badge').count()) === 1, 30)
        const drawn = await until(async () => (await kit.getByTestId('film-program-preview').getAttribute('data-serial')) === String((await previewState()).serial), 60)
        readout = await kit.getByTestId('film-dialog-speedDuration-duration').textContent().catch(() => null)
        const ghosted = await until(async () => (await kit.locator(`[data-testid="film-clip-${A.clip}"][data-preview="changed"]`).count()) === 1 && (await kit.getByTestId(`film-clip-was-${A.clip}`).count()) === 1 && (await kit.getByTestId(`film-clip-was-${B.clip}`).count()) === 1, 60)
        const grown = await settledBox(kit.getByTestId(`film-clip-${A.clip}`), { orNull: true })
        const was = await settledBox(kit.getByTestId(`film-clip-was-${A.clip}`), { orNull: true })
        onTimeline = {
          ghosted,
          badge: await kit.getByTestId('film-timeline-preview-badge').count(),
          ratio: grown && was ? +(grown.width / was.width).toFixed(2) : null,
          strip: await kit.getByTestId('film-preview-diff').count(),
          shifted: await kitFrame().evaluate((clip) => (window.filmPreview.state().diff?.clips?.changed ?? []).some((entry) => entry.id === clip && entry.fields?.includes('start')), B.clip),
        }
        const lit = await kitFrame().evaluate(() => {
          const canvas = document.querySelector('[data-testid="film-program-preview"]')
          if (!canvas?.width) return 0
          const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
          let count = 0
          for (let at = 0; at < data.length; at += 16) if (data[at] + data[at + 1] + data[at + 2] > 60) count += 1
          return count
        })
        return badge && drawn && lit > 100 && onTimeline.ghosted && onTimeline.badge === 1 && Math.abs(onTimeline.ratio - 2) < 0.1 && onTimeline.strip === 0 && onTimeline.shifted
      },
    })
    step('Clip ▸ Speed/Duration… at 50% with Ripple previews on the Program monitor with a Preview badge and on the Timeline (the clip twice as long, the old places ghosted), and Cancel leaves the document as it was', speedCancel.ok, JSON.stringify({ ...speedCancel, readout, onTimeline }))

    // Keys typed in a dialog's field stay in the field: the playhead and the In mark do not move (lesson 2).
    await speedSetup()
    await speedDialog()
    await kit.getByTestId('film-dialog').waitFor({ timeout: 10000 })
    const keysFrom = await details()
    const speedField = kit.locator('[data-testid="film-dialog-speedDuration-speed"] input')
    await speedField.focus()
    for (const key of ['i', 'ArrowRight', 'Shift+ArrowRight', 'o']) await page.keyboard.press(key)
    await paintFrames()
    const keysTo = await details()
    await kit.getByTestId('film-dialog-cancel').click()
    await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
    step("keys typed in a dialog's field do not reach the Timeline", keysTo.playhead === keysFrom.playhead && keysTo.sequence.in === keysFrom.sequence.in && keysTo.sequence.out === keysFrom.sequence.out, JSON.stringify({ from: [keysFrom.playhead, keysFrom.sequence.in, keysFrom.sequence.out], to: [keysTo.playhead, keysTo.sequence.in, keysTo.sequence.out] }))

    // OK runs it as one history step, the document becoming what the preview showed; one undo restores it.
    await speedSetup()
    const speedOk = await previewThenOk({ open: speedDialog, change: halfSpeed })
    const slowed = await clipOf(A.clip)
    const twice = slowed && Math.abs(slowed.duration - A.duration * 2) <= frameTicks
    await edited(undoKey, async () => (await clipOf(A.clip))?.duration === A.duration)
    step('Speed/Duration… OK at 50% makes the clip twice as long in one history step, as previewed, and one undo restores it', speedOk.ok && twice && (await clipOf(A.clip)).duration === A.duration, JSON.stringify({ ...speedOk, duration: [A.duration, slowed?.duration] }))
    // A selection made with the dialog open (the dialog leaves the editor its clicks) begins the
    // preview again for the new clip, and OK changes that clip, the one previewed.
    {
      await speedSetup()
      const serialFrom = (await previewState()).serial
      await speedDialog()
      await kit.getByTestId('film-dialog').waitFor({ timeout: 10000 })
      await halfSpeed()
      await previewOpened(serialFrom)
      await previewSettled()
      const firstSerial = (await previewState()).serial
      const firstClips = await kitFrame().evaluate(() => (window.filmPreview.state().diff?.clips?.changed ?? []).map((entry) => entry.id))
      // The Timeline draws the preview, where Ripple moved B: the view fitted to it shows B.
      await kit.locator('.kui-app').focus()
      await page.keyboard.press('\\')
      const bAt = mid(await box(B.clip))
      await page.mouse.click(bAt.x, bAt.y)
      await waitForEngine(page, (state) => state.details?.sequence?.selection?.includes(B.clip) && !state.details.sequence.selection.includes(A.clip))
      const rebegun = await previewOpened(firstSerial)
      await previewSettled()
      const nextClips = await kitFrame().evaluate(() => (window.filmPreview.state().diff?.clips?.changed ?? []).map((entry) => entry.id))
      const bBefore = await clipOf(B.clip)
      await kit.getByTestId('film-dialog-ok').click()
      const okB = await until(async () => (await clipOf(B.clip))?.duration > bBefore.duration && (await clipOf(A.clip))?.duration === A.duration, 60)
      await edited(undoKey, async () => (await clipOf(B.clip))?.duration === bBefore.duration)
      await kit.locator('.kui-app').focus()
      await page.keyboard.press('\\')
      step('a selection made with Speed/Duration… open previews the new clip again, and OK changes that clip', rebegun && firstClips.includes(A.clip) && nextClips.includes(B.clip) && !nextClips.includes(A.clip) && okB, JSON.stringify({ rebegun, firstClips, nextClips, okB }))
    }

    // A previewing dialog moves by its title, and opens again where it was left (the kit store).
    {
      await speedSetup()
      await speedDialog()
      const shown = kit.getByTestId('film-dialog')
      await shown.waitFor({ timeout: 10000 })
      const from = await settledBox(shown)
      const title = await settledBox(shown.locator('h2'))
      await page.mouse.move(title.x + 20, title.y + title.height / 2)
      await page.mouse.down()
      await page.mouse.move(title.x + 80, title.y + title.height / 2 - 40, { steps: 6 })
      await page.mouse.up()
      const moved = await settledBox(shown)
      await kit.getByTestId('film-dialog-cancel').click()
      await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      await speedDialog()
      await shown.waitFor({ timeout: 10000 })
      const again = await settledBox(shown)
      await kit.getByTestId('film-dialog-cancel').click()
      await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      const near = (a, b) => Math.abs(a - b) <= 2
      step('a previewing dialog moves by its title and opens again where it was left', near(moved.x - from.x, 60) && near(moved.y - from.y, -40) && near(again.x, moved.x) && near(again.y, moved.y), JSON.stringify({ from, moved, again }))
      // Back to the layout's place for the later steps and the shots.
      await kitFrame().evaluate(() => Object.keys(localStorage).filter((key) => key.includes('dialogPlace')).forEach((key) => localStorage.removeItem(key)))
    }

    // ---- upstream's clip dialogs (Task 11), each previewed (upstream's have no preview), each
    // with Cancel (the document left as it was) and OK (one history step, as previewed).
    {
      /** Opens `command`'s dialog from its row in upstream's menus (`film-upstream.json`), hovering each submenu. */
      const fromMenu = async (command) => {
        const row = manifest.menus.find((each) => each.command === command)
        await kit.getByTestId(`film-menu-${row.path[0]}`).click()
        for (let depth = 2; depth <= row.path.length; depth += 1) await kit.locator(`[data-kit-ui-id="menu:${row.path.slice(0, depth).join('/')}"]`).hover()
        await kit.locator(`[data-testid="film-cmd-${command}"], [data-testid="film-control-${command}"]`).first().click()
      }
      const middle = A.start + Math.floor(A.duration / 2 / frameTicks) * frameTicks
      /** A selected with its linked audio and the playhead in its middle, before a step records the document. */
      const onA = async (extra = []) => {
        await person([...extra, { command: 'timeline.select', params: { clips: [A.clip] } }, { command: 'playhead.set', params: { time: middle } }])
        await waitForEngine(page, (state) => state.details?.playhead === middle && state.details?.sequence?.selection?.includes(A.clip))
      }
      /** The Program monitor's preview picture once drawn for the open serial: its centre pixel and its summed brightness. */
      const previewPicture = async () => {
        const drawn = await until(async () => (await kit.getByTestId('film-program-preview').getAttribute('data-serial').catch(() => null)) === String((await previewState()).serial), 60)
        if (!drawn) return null
        return kitFrame().evaluate(() => {
          const canvas = document.querySelector('[data-testid="film-program-preview"]')
          if (!canvas?.width) return null
          const context2d = canvas.getContext('2d')
          const centre = [...context2d.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3)]
          const { data } = context2d.getImageData(0, 0, canvas.width, canvas.height)
          let sum = 0
          for (let at = 0; at < data.length; at += 16) sum += data[at] + data[at + 1] + data[at + 2]
          return { centre, sum }
        })
      }
      /** What the open preview changed on clip `clip` (`previewDiff`, read from the engine). */
      const changedFields = async (clip) => {
        const diff = await kitFrame().evaluate(() => window.filmPreview.diff())
        return (diff?.clips?.changed ?? []).filter((entry) => entry.id === clip).flatMap((entry) => entry.fields ?? [])
      }
      const topStep = async () => (await waitForEngine(page, () => true, { history: true })).history?.undo?.at(-1) ?? null
      const peakNow = async () => (await person([{ command: 'clip.audioPeak', params: {} }])).completed[0].result?.peakDb ?? null
      const opacityOf = async (clip) => {
        const effects = (await clipOf(clip))?.effects ?? []
        // inspect() answers a parameter's value as JSON (a number for Opacity).
        const value = effects.find((effect) => effect.effect === 'opacity')?.params?.opacity?.value
        return typeof value === 'number' ? value : null
      }

      // Paste Attributes… (Opacity only): B's 20% opacity, copied, shows on A's picture at the
      // playhead, and on the Timeline as A's changed effects; Motion (the same on both) is pasted too.
      const copyB = [
        { command: 'effect.setParam', params: { clip: B.clip, effect: 'opacity', param: 'opacity', value: 20 } },
        { command: 'timeline.select', params: { clips: [B.clip], linked: false } },
        { command: 'edit.copy', params: {} },
      ]
      await onA(copyB)
      const pasteOpen = async () => {
        await fromMenu('edit.pasteAttributes')
        await kit.getByTestId('film-dialog-pasteAttributes').waitFor({ timeout: 10000 })
        await kit.getByTestId('film-dialog-pasteAttributes-opacity').uncheck()
        await kit.getByTestId('film-dialog-pasteAttributes-timeRemapping').uncheck()
      }
      const opacityOn = async () => kit.getByTestId('film-dialog-pasteAttributes-opacity').check()
      let pasted = null
      const pasteCancel = await previewThenCancel({
        open: async () => {
          await pasteOpen()
          await previewSettled()
          pasted = { before: await previewPicture() }
        },
        change: opacityOn,
        expectPreview: async () => {
          pasted.after = await previewPicture()
          pasted.fields = await changedFields(A.clip)
          pasted.timeline = await kit.locator(`[data-testid="film-clip-${A.clip}"][data-preview="changed"]`).count()
          return pasted.before != null && pasted.after != null && pasted.before.centre.join() !== pasted.after.centre.join() && pasted.after.sum < pasted.before.sum * 0.5 && pasted.fields.includes('effects') && pasted.timeline === 1
        },
      })
      step("Paste Attributes… (Opacity) previews the copied 20% opacity on A's picture (the centre pixel changes) and on the Timeline, and Cancel leaves the document as it was", pasteCancel.ok, JSON.stringify({ ...pasteCancel, pasted }))
      const pasteOk = await previewThenOk({ open: pasteOpen, change: opacityOn })
      const pastedOpacity = await opacityOf(A.clip)
      await edited(undoKey, async () => (await opacityOf(A.clip)) !== pastedOpacity)
      step("Paste Attributes… OK pastes B's opacity onto A in one history step, as previewed, and one undo restores it", pasteOk.ok && Math.abs(pastedOpacity - 20) < 0.01 && (await opacityOf(A.clip)) !== pastedOpacity, JSON.stringify({ ...pasteOk, pastedOpacity, after: await opacityOf(A.clip) }))

      // Remove Attributes… (Opacity only) on A at 20%: the picture brightens back.
      await onA([{ command: 'effect.setParam', params: { clip: A.clip, effect: 'opacity', param: 'opacity', value: 20 } }])
      const removeOpen = async () => {
        await fromMenu('edit.removeAttributes')
        await kit.getByTestId('film-dialog-removeAttributes').waitFor({ timeout: 10000 })
        for (const field of ['motion', 'opacity', 'timeRemapping', 'volume', 'channelVolume', 'panner']) {
          const box = kit.getByTestId(`film-dialog-removeAttributes-${field}`)
          if (await box.isEnabled()) await box.uncheck()
        }
      }
      let removed = null
      const removeCancel = await previewThenCancel({
        open: async () => {
          await removeOpen()
          await previewSettled()
          removed = { before: await previewPicture() }
        },
        change: async () => kit.getByTestId('film-dialog-removeAttributes-opacity').check(),
        expectPreview: async () => {
          removed.after = await previewPicture()
          removed.fields = await changedFields(A.clip)
          return removed.before != null && removed.after != null && removed.after.sum > removed.before.sum * 2 && removed.fields.includes('effects')
        },
      })
      step("Remove Attributes… (Opacity) previews A's picture at full opacity again, and Cancel leaves the document as it was", removeCancel.ok, JSON.stringify({ ...removeCancel, removed }))
      const removeOk = await previewThenOk({ open: removeOpen, change: async () => kit.getByTestId('film-dialog-removeAttributes-opacity').check() })
      const removedOpacity = await opacityOf(A.clip)
      await edited(undoKey, async () => Math.abs((await opacityOf(A.clip)) - 20) < 0.01)
      step("Remove Attributes… OK resets A's opacity in one history step, as previewed, and one undo restores it", removeOk.ok && Math.abs(removedOpacity - 100) < 0.01, JSON.stringify({ ...removeOk, removedOpacity }))
      // Back to the clips as they were: undo A's and B's opacity.
      await edited(undoKey, async () => (await opacityOf(A.clip)) !== 20)
      await edited(undoKey, async () => (await opacityOf(B.clip)) !== 20)

      // Frame Hold Options… from the clip menu: Hold On (In Point) holds A's first frame.
      await onA()
      const holdOpen = async () => {
        const at = mid(await box(A.clip))
        await page.mouse.click(at.x, at.y, { button: 'right' })
        await kit.getByTestId('film-clip-menu').waitFor({ timeout: 5000 })
        await kit.getByTestId('film-cmd-clip.frameHoldOptions').click()
        await kit.getByTestId('film-dialog-frameHold').waitFor({ timeout: 10000 })
      }
      const holdOn = async () => kit.getByTestId('film-dialog-frameHold-enabled').check()
      let held = null
      const holdCancel = await previewThenCancel({
        open: holdOpen,
        change: holdOn,
        expectPreview: async () => {
          held = { fields: await changedFields(A.clip), picture: (await previewPicture()) != null, badge: await kit.getByTestId('film-program-preview-badge').count() }
          return held.fields.includes('frameHold') && held.picture && held.badge === 1
        },
      })
      step('Frame Hold Options… (from the clip menu) previews A held at its In point on the Program monitor, and Cancel leaves the document as it was', holdCancel.ok, JSON.stringify({ ...holdCancel, held }))
      await onA()
      const holdOk = await previewThenOk({ open: holdOpen, change: holdOn })
      const holdStep = await topStep()
      // The dialog opens again on A's hold now (upstream's defaults read the clip): Hold On checked.
      await holdOpen()
      const reopened = await kit.getByTestId('film-dialog-frameHold-enabled').isChecked()
      await kit.getByTestId('film-dialog-cancel').click()
      await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      await edited(undoKey)
      step('Frame Hold Options… OK holds A in one history step, and the dialog opens again on the hold', holdOk.ok && reopened, JSON.stringify({ ...holdOk, holdStep, reopened }))

      // Field Options… (Always Deinterlace).
      await onA()
      const fieldsOpen = async () => {
        await fromMenu('clip.fieldOptions')
        await kit.getByTestId('film-dialog-fieldOptions').waitFor({ timeout: 10000 })
      }
      const deinterlace = async () => kit.getByTestId('film-dialog-fieldOptions-processing-alwaysDeinterlace').check()
      let fielded = null
      const fieldsCancel = await previewThenCancel({
        open: fieldsOpen,
        change: deinterlace,
        expectPreview: async () => {
          fielded = { fields: await changedFields(A.clip), picture: (await previewPicture()) != null }
          return fielded.fields.includes('fieldOptions') && fielded.picture
        },
      })
      step('Field Options… (Always Deinterlace) previews on the Program monitor, and Cancel leaves the document as it was', fieldsCancel.ok, JSON.stringify({ ...fieldsCancel, fielded }))
      await onA()
      const fieldsOk = await previewThenOk({ open: fieldsOpen, change: deinterlace })
      const fieldsStep = await topStep()
      await edited(undoKey)
      step('Field Options… OK sets them in one history step', fieldsOk.ok, JSON.stringify({ ...fieldsOk, fieldsStep }))

      // Audio Gain… +6 dB: the strip's Play, and the peak after the gain 6 dB over the selection's.
      await onA()
      const gainField = '[data-testid="film-dialog-audioGain-adjust-value"] input'
      const gainOpen = async () => {
        await fromMenu('clip.audioGain')
        await kit.getByTestId('film-dialog-audioGain').waitFor({ timeout: 10000 })
        await kit.getByTestId('film-dialog-audioGain-adjust').check()
        // The dialog keeps its draft: from 0 dB each time.
        await kit.locator(gainField).fill('0')
        await kit.locator(gainField).press('Tab')
        await previewSettled()
      }
      const plusSix = async () => {
        await kit.locator(gainField).fill('6')
        await kit.locator(gainField).press('Tab')
      }
      const peakFrom = await peakNow()
      let gained = null
      const gainCancel = await previewThenCancel({
        open: gainOpen,
        change: plusSix,
        expectPreview: async () => {
          const serial = String((await previewState()).serial)
          const read = await until(async () => (await kit.getByTestId('film-dialog-audioGain-after').getAttribute('data-serial').catch(() => null)) === serial, 60)
          const text = read ? await kit.getByTestId('film-dialog-audioGain-after').textContent() : null
          const after = Number(/(-?\d+(\.\d+)?) dB/.exec(text ?? '')?.[1])
          gained = { read, text, peakFrom, after, play: await kit.getByTestId('film-preview-play').isEnabled(), shown: await kit.getByTestId('film-dialog-audioGain-peak').textContent() }
          return read && Math.abs(after - (peakFrom + 6)) <= 0.15 && gained.play
        },
      })
      step("Audio Gain… +6 dB previews the selection's peak 6 dB higher beside the current one, with the strip's Play, and Cancel leaves the document as it was", gainCancel.ok && typeof peakFrom === 'number', JSON.stringify({ ...gainCancel, gained }))
      const gainOk = await previewThenOk({ open: gainOpen, change: plusSix })
      const peakTo = await peakNow()
      await edited(undoKey, async () => Math.abs((await peakNow()) - peakFrom) <= 0.05)
      step('Audio Gain… OK at +6 dB raises clip.audioPeak by 6 dB in one history step, and one undo restores it', gainOk.ok && Math.abs(peakTo - (peakFrom + 6)) <= 0.15, JSON.stringify({ ...gainOk, peakFrom, peakTo }))

      // Interpret Footage… from the Project panel's item menu: a log colour space for bars.mp4
      // previews the picture of its clips and the item's changed row.
      await onA([{ command: 'project.select', params: { items: [] } }])
      const card = kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${media.item}"]`).first()
      const interpretOpen = async () => {
        await card.scrollIntoViewIfNeeded()
        await card.click({ button: 'right' })
        await kit.getByTestId('film-project-item-interpret').click()
        await kit.getByTestId('film-dialog-colorDialog').waitFor({ timeout: 10000 })
        await previewSettled()
      }
      const toLog = async () => kit.getByTestId('film-dialog-colorDialog-space-slog3-sgamut3cine').check()
      let interpreted = null
      const interpretCancel = await previewThenCancel({
        open: async () => {
          await interpretOpen()
          interpreted = { before: await previewPicture(), detected: await kit.getByTestId('film-dialog-colorDialog-detected').textContent() }
        },
        change: toLog,
        expectPreview: async () => {
          interpreted.after = await previewPicture()
          const diff = await kitFrame().evaluate(() => window.filmPreview.state().diff)
          interpreted.item = (diff?.items?.changed ?? []).find((entry) => entry.id === media.item)?.fields ?? []
          interpreted.row = await until(async () => (await kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${media.item}"][data-preview="changed"]`).count()) > 0, 60)
          return interpreted.before != null && interpreted.after != null && interpreted.before.centre.join() !== interpreted.after.centre.join() && interpreted.item.includes('interpret') && interpreted.row
        },
      })
      step("Interpret Footage… (from the Project item menu) previews bars.mp4 in S-Log3 on the Program monitor (the centre pixel changes) and its row as changed, and Cancel leaves the document as it was", interpretCancel.ok, JSON.stringify({ ...interpretCancel, interpreted }))
      const interpretOk = await previewThenOk({ open: interpretOpen, change: toLog })
      const override = (await person([{ command: 'media.colorInfo', params: { item: media.item } }])).completed[0].result?.override ?? null
      await edited(undoKey)
      const overrideBack = (await person([{ command: 'media.colorInfo', params: { item: media.item } }])).completed[0].result?.override ?? null
      step('Interpret Footage… OK overrides the colour space in one history step, and one undo restores it', interpretOk.ok && override === 'slog3-sgamut3cine' && overrideBack == null, JSON.stringify({ ...interpretOk, override, overrideBack }))
      // Interpret Footage opened with no place kept keeps off the Project panel it previews in and
      // off the Program monitor's Preview badge (Task 11 review).
      {
        await kitFrame().evaluate(() => Object.keys(localStorage).filter((key) => key.includes('dialogPlace')).forEach((key) => localStorage.removeItem(key)))
        await interpretOpen()
        const boxOf = (locator) => settledBox(locator, { orNull: true })
        const dialogBox = await boxOf(kit.getByTestId('film-dialog'))
        const projectBox = await boxOf(kit.locator('.kui-ws-frame', { has: kit.getByTestId('film-project') }).first())
        const badgeBox = await boxOf(kit.getByTestId('film-program-preview-badge'))
        const overlap = (a, b) => (a && b ? Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) : -1)
        const projectHidden = projectBox ? overlap(dialogBox, projectBox) / (projectBox.width * projectBox.height) : null
        const badgeHidden = overlap(dialogBox, badgeBox)
        await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        step("Interpret Footage opens clear of the Project panel it previews in and of the Program monitor's Preview badge", projectHidden != null && projectHidden < 0.5 && badgeHidden === 0, JSON.stringify({ dialogBox, projectBox, badgeBox, projectHidden, badgeHidden }))
      }

      // Audio Gain keeps its draft for the next time it opens, Cancel or OK (upstream's app.ui).
      {
        await onA()
        await fromMenu('clip.audioGain')
        await kit.getByTestId('film-dialog-audioGain').waitFor({ timeout: 10000 })
        await kit.getByTestId('film-dialog-audioGain-normalizeMax').check()
        const maxField = kit.locator('[data-testid="film-dialog-audioGain-normalizeMax-value"] input')
        await maxField.fill('-3')
        await maxField.press('Tab')
        await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        await fromMenu('clip.audioGain')
        await kit.getByTestId('film-dialog-audioGain').waitFor({ timeout: 10000 })
        const kept = { mode: await kit.getByTestId('film-dialog-audioGain-normalizeMax').isChecked(), value: await maxField.inputValue(), enabled: await maxField.isEnabled() }
        await kit.getByTestId('film-dialog-audioGain-adjust').check()
        await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        step('Audio Gain opens again with the mode and value it was left with (Normalize Max Peak to -3 dB, after Cancel)', kept.mode && Number(kept.value) === -3 && kept.enabled, JSON.stringify(kept))
      }

      // Frame Hold Options: Source Timecode shows the Timecode field, and what is typed there is what OK holds.
      {
        await onA()
        await holdOpen()
        await kit.getByTestId('film-dialog-frameHold-enabled').check()
        const before = await kit.getByTestId('film-dialog-frameHold-timecode').count()
        await kit.getByTestId('film-dialog-frameHold-holdOn-sourceTimecode').check()
        const field = kit.getByTestId('film-dialog-frameHold-timecode')
        const shown = await until(async () => (await field.count()) === 1, 30)
        const width = (await settledBox(field, { orNull: true }))?.width ?? null
        await field.fill('00:00:00:12')
        await previewSettled()
        const revisionFrom = (await waitForEngine(page, () => true)).revision
        await kit.getByTestId('film-dialog-ok').click()
        await waitForEngine(page, (state) => state.revision > revisionFrom)
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        // Opened again, the dialog reads the clip's hold (upstream's defaults): the frame typed.
        await holdOpen()
        await kit.getByTestId('film-dialog-frameHold-holdOn-sourceTimecode').check()
        const heldAt = await kit.getByTestId('film-dialog-frameHold-timecode').inputValue()
        await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        await edited(undoKey)
        step("Frame Hold Options shows Timecode (120 px) only for Source Timecode, and OK holds the frame typed there", before === 0 && shown && Math.abs(width - 120) <= 1 && heldAt === '00:00:00:12', JSON.stringify({ before, shown, width, heldAt }))
      }
      await person([{ command: 'timeline.select', params: { clips: [] } }, { command: 'project.select', params: { items: [] } }])
    }

    // ---- upstream's clip structure dialogs (Task 12), each previewed (upstream's have no
    // preview): Cancel leaves the document as it was, OK makes one history step, as previewed.
    {
      /** Opens `command`'s dialog from its row in upstream's menus (`film-upstream.json`), hovering each submenu. */
      const fromMenu = async (command) => {
        const row = manifest.menus.find((each) => each.command === command)
        await kit.getByTestId(`film-menu-${row.path[0]}`).click()
        for (let depth = 2; depth <= row.path.length; depth += 1) await kit.locator(`[data-kit-ui-id="menu:${row.path.slice(0, depth).join('/')}"]`).hover()
        await kit.locator(`[data-testid="film-cmd-${command}"], [data-testid="film-control-${command}"]`).first().click()
      }
      /** Every item of a project tree (`inspect()`'s root): `{item, name, …}`. */
      const itemsOf = (node) => [...(node?.item != null ? [node] : []), ...(node?.children ?? []).flatMap(itemsOf)]
      const named = (root, name) => itemsOf(root).find((each) => each.name === name) ?? null
      const previewRoot = async () => (await kitFrame().evaluate(() => window.filmPreview.inspect()))?.project?.root ?? null
      const documentRoot = async () => (await details()).project?.root ?? null
      const previewDiff = () => kitFrame().evaluate(() => window.filmPreview.diff())
      const row = (item) => kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${item}"]`).first()
      /** Waits until the Project panel draws `item`'s row marked `mark` (added, changed). */
      const rowMarked = (item, mark) => until(async () => (await kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${item}"][data-preview="${mark}"]`).count()) > 0, 60)
      const itemChanged = async (item, field) => ((await previewDiff())?.items?.changed ?? []).some((entry) => entry.id === item && (entry.fields ?? []).includes(field))
      const closeDialog = async () => {
        if (await dialogShown()) await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      }
      const open = (command, prefix) => async () => {
        await fromMenu(command)
        await kit.getByTestId(`film-dialog-${prefix}`).waitFor({ timeout: 10000 })
      }
      const fill = (testId, text) => async () => {
        const field = kit.getByTestId(testId)
        await field.fill(text)
      }
      const undoneTo = (check) => edited(undoKey, check)

      // Nest… "Nest A" over A and its linked audio: the Timeline shows the nest clip in their place,
      // the Project panel a "Nest A" row; the name is focused as it opens, and Escape cancels.
      const onA = async () => {
        await person([{ command: 'project.select', params: { items: [] } }, { command: 'timeline.select', params: { clips: [A.clip] } }])
        await waitForEngine(page, (state) => state.details?.sequence?.selection?.includes(A.clip))
      }
      await onA()
      let nested = null
      const nestOpen = async () => {
        await open('clip.nest', 'nest')()
        nested = { focused: await until(async () => (await kitFrame().evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'film-dialog-nest-name', 30) }
      }
      const nestA = fill('film-dialog-nest-name', 'Nest A')
      const nestCancel = await previewThenCancel({
        open: nestOpen,
        change: nestA,
        escape: '[data-testid="film-dialog-nest-name"]',
        expectPreview: async () => {
          const sequence = named(await previewRoot(), 'Nest A')
          nested.sequence = sequence?.item ?? null
          nested.row = sequence ? await rowMarked(sequence.item, 'added') : false
          nested.added = await until(async () => (await kit.locator('[data-testid^="film-clip-"][data-preview="added"]').count()) > 0, 60)
          nested.removed = await kit.locator(`[data-testid="film-clip-removed-${A.clip}"]`).count()
          nested.inDocument = named(await documentRoot(), 'Nest A') != null
          return nested.focused && sequence != null && nested.row && nested.added && nested.removed === 1 && !nested.inDocument
        },
      })
      step('Nest… "Nest A" previews one nest clip in place of A on the Timeline and a "Nest A" row in the Project panel, the name focused, and Escape leaves the document as it was', nestCancel.ok, JSON.stringify({ ...nestCancel, nested }))
      await onA()
      const nestOk = await previewThenOk({ open: open('clip.nest', 'nest'), change: nestA })
      const nestMade = named(await documentRoot(), 'Nest A')
      const aGone = (await clipOf(A.clip)) == null
      await undoneTo(async () => (await clipOf(A.clip)) != null)
      step('Nest… OK makes the "Nest A" sequence in one history step, as previewed, and one undo restores A', nestOk.ok && nestMade != null && aGone && named(await documentRoot(), 'Nest A') == null, JSON.stringify({ ...nestOk, made: nestMade?.item, aGone }))
      // Enter in the name is OK (upstream: lost_focus + Enter), and runs it once.
      {
        await onA()
        const before = await waitForEngine(page, () => true, { history: true })
        await open('clip.nest', 'nest')()
        await previewSettled()
        await kit.getByTestId('film-dialog-nest-name').fill('Nest B')
        await previewSettled()
        await kit.getByTestId('film-dialog-nest-name').press('Enter')
        const after = await waitForEngine(page, (state) => state.revision > before.revision, { history: true })
        const closed = await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        await settle()
        const later = await waitForEngine(page, () => true, { history: true })
        const steps = (later.history?.undo ?? []).length - (before.history?.undo ?? []).length
        const made = named(await documentRoot(), 'Nest B') != null
        await undoneTo(async () => (await clipOf(A.clip)) != null)
        step('Nest…: Enter in the name runs OK once (one history step), and the dialog closes', closed && steps === 1 && made && later.revision === after.revision, JSON.stringify({ closed, steps, made, revisions: [before.revision, after.revision, later.revision] }))
      }

      // Make Subclip… from the Project item menu, with In and Out set on bars.mp4: a subclip row
      // whose icon is bars.mp4's picture (not black).
      const marks = { in: piece, out: piece * 2 }
      await person([{ command: 'timeline.select', params: { clips: [] } }, { command: 'source.open', params: { item: media.item } }, { command: 'project.setMarks', params: { item: media.item, ...marks } }, { command: 'project.select', params: { items: [media.item] } }])
      const subclipOpen = async () => {
        const card = row(media.item)
        await card.scrollIntoViewIfNeeded()
        await card.click({ button: 'right' })
        await kit.getByTestId('film-project-item-make-subclip').click()
        await kit.getByTestId('film-dialog-makeSubclip').waitFor({ timeout: 10000 })
      }
      const subclipName = fill('film-dialog-makeSubclip-name', 'Bars middle')
      let subclipped = null
      const iconBrightness = (item) =>
        kitFrame().evaluate((id) => {
          const canvas = document.querySelector(`[data-testid="film-project"] [data-testid="film-project-item-${id}"] canvas[data-drawn="1"]`)
          if (!canvas?.width) return null
          const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
          let sum = 0
          let n = 0
          for (let at = 0; at < data.length; at += 16) {
            sum += data[at] + data[at + 1] + data[at + 2]
            n += 3
          }
          return n ? sum / n : null
        }, item)
      const subclipCancel = await previewThenCancel({
        open: subclipOpen,
        change: subclipName,
        expectPreview: async () => {
          const made = named(await previewRoot(), 'Bars middle')
          subclipped = { item: made?.item ?? null, start: await kit.getByTestId('film-dialog-makeSubclip-startFrame-timecode').textContent() }
          subclipped.row = made ? await rowMarked(made.item, 'added') : false
          const lit = made ? await until(async () => ((await iconBrightness(made.item)) ?? 0) > 20, 80) : false
          subclipped.brightness = made ? await iconBrightness(made.item) : null
          return made != null && subclipped.row && lit
        },
      })
      step('Make Subclip… (In and Out set) previews a "Bars middle" subclip row with a non-black icon, and Cancel leaves the document as it was', subclipCancel.ok, JSON.stringify({ ...subclipCancel, subclipped }))
      const subclipOk = await previewThenOk({ open: subclipOpen, change: subclipName })
      const subclip = named(await documentRoot(), 'Bars middle')
      step('Make Subclip… OK makes the subclip in one history step, as previewed', subclipOk.ok && subclip != null, JSON.stringify({ ...subclipOk, subclip: subclip?.item }))

      // Edit Subclip… from the subclip's item menu: Convert to Master Clip.
      if (subclip) {
        await person([{ command: 'project.select', params: { items: [subclip.item] } }])
        const editOpen = async () => {
          const card = row(subclip.item)
          await card.scrollIntoViewIfNeeded()
          await card.click({ button: 'right' })
          await kit.getByTestId('film-project-item-edit-subclip').click()
          await kit.getByTestId('film-dialog-editSubclip').waitFor({ timeout: 10000 })
        }
        const toMaster = async () => kit.getByTestId('film-dialog-editSubclip-convertToMaster').check()
        let editedSub = null
        const editCancel = await previewThenCancel({
          open: editOpen,
          change: toMaster,
          expectPreview: async () => {
            editedSub = { name: await kit.getByTestId('film-dialog-editSubclip-name').textContent(), kind: await itemChanged(subclip.item, 'kind'), row: await rowMarked(subclip.item, 'changed') }
            return editedSub.name === 'Bars middle' && editedSub.kind && editedSub.row
          },
        })
        step('Edit Subclip… (Convert to Master Clip) shows the subclip and previews its row as changed, and Cancel leaves the document as it was', editCancel.ok, JSON.stringify({ ...editCancel, editedSub }))
        // The preview's own media pool (a fork) leaves the document's decoded sources alone: the
        // Project icons of bars.mp4 and of the subclip are still drawn, not blank.
        const lit = async () => {
          const ok = await until(async () => ((await iconBrightness(media.item)) ?? 0) > 20 && ((await iconBrightness(subclip.item)) ?? 0) > 20, 80)
          return { ok, bars: await iconBrightness(media.item), item: await iconBrightness(subclip.item) }
        }
        const litAfterCancel = await lit()
        const editOk = await previewThenOk({ open: editOpen, change: toMaster })
        const litAfterOk = await lit()
        step('Edit Subclip… OK converts it in one history step, as previewed', editOk.ok, JSON.stringify(editOk))
        step("after Edit Subclip's Cancel and OK the Project icons of bars.mp4 and the converted item are still drawn (the preview's pool fork blanks none of the document's sources)", litAfterCancel.ok && litAfterOk.ok, JSON.stringify({ litAfterCancel, litAfterOk }))
        await undoneTo()
        await undoneTo(async () => named(await documentRoot(), 'Bars middle') == null)
      }
      await person([{ command: 'project.setMarks', params: { item: media.item, in: null, out: null } }])

      // Modify ▸ Audio Channels… on bars.mp4 (a project item): Mono maps a clip per channel.
      await person([{ command: 'timeline.select', params: { clips: [] } }, { command: 'project.select', params: { items: [media.item] } }])
      const channelsOpen = open('clip.audioChannels', 'audioChannels')
      const toMono = async () => kit.getByTestId('film-dialog-audioChannels-format-mono').check()
      let channelled = null
      const channelsCancel = await previewThenCancel({
        open: channelsOpen,
        change: toMono,
        expectPreview: async () => {
          channelled = { matrix: await kit.getByTestId('film-dialog-audioChannels-matrix').count(), interpret: await itemChanged(media.item, 'interpret'), row: await rowMarked(media.item, 'changed') }
          return channelled.matrix === 1 && channelled.interpret && channelled.row
        },
      })
      step('Audio Channels… (Mono) on a project item previews its row as changed, with the clip × channel matrix, and Cancel leaves the document as it was', channelsCancel.ok, JSON.stringify({ ...channelsCancel, channelled }))
      const channelsOk = await previewThenOk({ open: channelsOpen, change: toMono })
      await undoneTo()
      step('Audio Channels… OK maps bars.mp4 in one history step, as previewed', channelsOk.ok, JSON.stringify(channelsOk))

      // Modify ▸ Timecode… on bars.mp4: the Media Start cell.
      const timecodeOpen = open('clip.setTimecode', 'timecode')
      const toHour = fill('film-dialog-timecode-timecode', '01:00:00:00')
      let retimed = null
      const timecodeCancel = await previewThenCancel({
        open: timecodeOpen,
        change: toHour,
        expectPreview: async () => {
          retimed = { timecode: await itemChanged(media.item, 'timecode'), row: await rowMarked(media.item, 'changed') }
          return retimed.timecode && retimed.row
        },
      })
      step("Modify Timecode… (01:00:00:00) previews bars.mp4's row as changed, and Cancel leaves the document as it was", timecodeCancel.ok, JSON.stringify({ ...timecodeCancel, retimed }))
      const timecodeOk = await previewThenOk({ open: timecodeOpen, change: toHour })
      await undoneTo()
      step('Modify Timecode… OK sets the Media Start in one history step, as previewed', timecodeOk.ok, JSON.stringify(timecodeOk))

      // Source Settings… shows the codec and has one OK, which changes nothing.
      {
        const before = await documentNow()
        await open('clip.sourceSettings', 'sourceSettings')()
        await checkIds()
        const codec = await kit.getByTestId('film-dialog-sourceSettings-codec').textContent()
        const buttons = { ok: await kit.getByTestId('film-dialog-ok').count(), close: await kit.getByTestId('film-dialog-cancel').textContent() }
        const preview = (await previewState()).open
        await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0, 50)
        const after = await documentNow()
        step('Source Settings… shows the codec with one OK, previews nothing, and changes nothing', pattern(zh('Codec: {codec}'), { codec: '\\S+' }, { start: true }).test(codec ?? '') && buttons.ok === 0 && buttons.close === zh('OK') && !preview && before.revision === after.revision && before.inspect === after.inspect, JSON.stringify({ codec, buttons, preview }))
      }

      // Clip ▸ Rename… starts the Project panel's inline rename of the selected item (no dialog).
      {
        const before = (await waitForEngine(page, () => true)).revision
        await fromMenu('clip.rename')
        const field = kit.locator(`[data-testid="film-project-rename-${media.item}"]`)
        const shown = await until(async () => (await field.count()) === 1, 40)
        const value = shown ? await kit.locator(`[data-testid="film-project-rename-${media.item}"] input, input[data-testid="film-project-rename-${media.item}"]`).first().inputValue().catch(() => null) : null
        await page.keyboard.press('Escape')
        await until(async () => (await field.count()) === 0, 40)
        const after = (await waitForEngine(page, () => true)).revision
        step("Clip ▸ Rename… starts the Project panel's inline rename on the selected item, and Escape renames nothing", shown && value === media.name && (await dialogShown()) === 0 && after === before, JSON.stringify({ shown, value, name: media.name, before, after }))
      }

      // File ▸ New ▸ Offline File… "Lost Take": the offline row.
      await person([{ command: 'project.select', params: { items: [] } }])
      const offlineOpen = open('item.newOfflineFile', 'offlineFile')
      const lostTake = fill('film-dialog-offlineFile-name', 'Lost Take')
      let offlined = null
      const offlineCancel = await previewThenCancel({
        open: offlineOpen,
        change: lostTake,
        expectPreview: async () => {
          const made = named(await previewRoot(), 'Lost Take')
          offlined = { item: made?.item ?? null, row: made ? await rowMarked(made.item, 'added') : false, fileName: await kit.getByTestId('film-dialog-offlineFile-fileName').inputValue() }
          return made != null && offlined.row && offlined.fileName === 'Offline.mov'
        },
      })
      step('New Offline File… "Lost Take" previews its offline row, and Cancel leaves the document as it was', offlineCancel.ok, JSON.stringify({ ...offlineCancel, offlined }))
      const offlineOk = await previewThenOk({ open: offlineOpen, change: lostTake })
      const lost = named(await documentRoot(), 'Lost Take')
      step('New Offline File… OK makes the offline item in one history step, as previewed', offlineOk.ok && lost != null, JSON.stringify({ ...offlineOk, lost: lost?.item }))

      // Clip ▸ Edit Offline… on it: the Scene field.
      if (lost) {
        await person([{ command: 'project.select', params: { items: [lost.item] } }])
        const editOfflineOpen = async () => {
          await open('clip.editOffline', 'editOffline')()
          // It opens on the item's own fields (dialogDefaults).
          offlinedEdit.name = await kit.getByTestId('film-dialog-editOffline-mediaName').inputValue()
        }
        const scene = fill('film-dialog-editOffline-scene', 'Scene 12')
        const offlinedEdit = {}
        const editOfflineCancel = await previewThenCancel({
          open: editOfflineOpen,
          change: scene,
          expectPreview: async () => {
            offlinedEdit.metadata = await itemChanged(lost.item, 'metadata')
            offlinedEdit.row = await rowMarked(lost.item, 'changed')
            return offlinedEdit.name === 'Lost Take' && offlinedEdit.metadata && offlinedEdit.row
          },
        })
        step("Edit Offline File… opens on the item's fields and previews its row as changed (Scene), and Cancel leaves the document as it was", editOfflineCancel.ok, JSON.stringify({ ...editOfflineCancel, offlinedEdit }))
        const editOfflineOk = await previewThenOk({ open: editOfflineOpen, change: scene })
        step('Edit Offline File… OK sets the Scene in one history step, as previewed', editOfflineOk.ok, JSON.stringify(editOfflineOk))
        await undoneTo()
        await undoneTo(async () => named(await documentRoot(), 'Lost Take') == null)
      }

      // Merge Clips… bars.mp4 with an audio-only (offline) file: upstream's Audio method cannot
      // synchronize a file with no sound, so its preview turns off and says why; In Points and
      // Preview again show the merged item row, named as typed.
      const tone = (await person([{ command: 'item.newOfflineFile', params: { name: 'Tone', video: false, audio: true, seconds: 3 } }])).completed[0].result?.item ?? null
      await person([{ command: 'timeline.select', params: { clips: [] } }, { command: 'project.select', params: { items: [media.item, tone] } }])
      const mergedName = 'Merged A'
      const byIn = (prefix) => async () => kit.getByTestId(`film-dialog-${prefix}-method-in`).check()
      let merged = null
      const mergeOpen = async () => {
        await open('clip.mergeClips', 'merge')()
        const previewBox = kit.getByTestId('film-dialog-preview')
        merged = { name: await kit.getByTestId('film-dialog-merge-name').inputValue(), off: await until(async () => !(await previewBox.isChecked()), 60) }
        await byIn('merge')()
        await previewBox.check()
      }
      const mergeName = fill('film-dialog-merge-name', mergedName)
      const mergeCancel = await previewThenCancel({
        open: mergeOpen,
        change: mergeName,
        expectPreview: async () => {
          const made = named(await previewRoot(), mergedName)
          merged.item = made?.item ?? null
          merged.row = made ? await rowMarked(made.item, 'added') : false
          return merged.name === `${media.name} - Merged` && merged.off && made != null && merged.row
        },
      })
      step('Merge Clips… opens on "<first> - Merged" (Audio cannot sync a file with no sound: Preview turns off), and by In Points previews the merged item row; Cancel leaves the document as it was', mergeCancel.ok, JSON.stringify({ ...mergeCancel, merged }))
      const mergeOk = await previewThenOk({ open: mergeOpen, change: mergeName })
      const mergedItem = named(await documentRoot(), mergedName)
      await undoneTo(async () => named(await documentRoot(), mergedName) == null)
      // Tone is the person's newest step: the person's undo takes it away.
      await edited(undoKey, async () => named(await documentRoot(), 'Tone') == null)
      step('Merge Clips… OK makes the merged item in one history step, as previewed, and one undo takes it away', mergeOk.ok && mergedItem != null, JSON.stringify({ ...mergeOk, merged: mergedItem?.item }))

      // Synchronize… by In Points: a clip on V2 moves to A's In point.
      await person([{ command: 'project.select', params: { items: [] } }, { command: 'timeline.place', params: { item: media.item, track: 'V2', time: piece / 2, sourceIn: piece, duration: piece } }])
      const upper = await until(async () => (await seq()).video[1]?.items?.length === 1)
      const other = upper ? (await seq()).video[1].items[0] : null
      if (other) {
        await person([{ command: 'timeline.select', params: { clips: [A.clip, other.clip], linked: false } }])
        await waitForEngine(page, (state) => state.details?.sequence?.selection?.length === 2)
        const syncOpen = async () => {
          await open('clip.synchronize', 'sync')()
          synced.count = await kit.getByTestId('film-dialog-sync-selected').textContent()
        }
        const synced = {}
        const syncCancel = await previewThenCancel({
          open: syncOpen,
          change: byIn('sync'),
          expectPreview: async () => {
            synced.start = ((await previewDiff())?.clips?.changed ?? []).some((entry) => entry.id === other.clip && (entry.fields ?? []).includes('start'))
            synced.timeline = await until(async () => (await kit.locator(`[data-testid="film-clip-${other.clip}"][data-preview="changed"]`).count()) === 1, 60)
            return synced.count === filled(zh('{n} clip(s) selected; the clip on the reference track stays put.'), { n: 2 }) && synced.start && synced.timeline
          },
        })
        step('Synchronize… (In Points) previews the V2 clip moved to its synchronized place on the Timeline, and Cancel leaves the document as it was', syncCancel.ok, JSON.stringify({ ...syncCancel, synced }))
        const syncOk = await previewThenOk({ open: syncOpen, change: byIn('sync') })
        const movedTo = (await clipOf(other.clip))?.start
        await undoneTo(async () => (await clipOf(other.clip))?.start === other.start)
        step('Synchronize… OK moves the clip in one history step, as previewed, and one undo puts it back', syncOk.ok && movedTo !== other.start, JSON.stringify({ ...syncOk, from: other.start, movedTo }))
        await undoneTo(async () => ((await seq()).video[1]?.items?.length ?? 0) === 0)
      } else step('Synchronize… has a clip on V2 to synchronize', false, JSON.stringify({ upper }))
      await closeDialog()
      await person([{ command: 'timeline.select', params: { clips: [] } }, { command: 'project.select', params: { items: [] } }])
    }

    // ---- upstream's sequence dialogs (Task 13), each previewed (upstream's have no preview):
    // Sequence Settings, New Sequence, and Sequence ▸ Color Management.
    {
      /** Opens `command`'s dialog from its row in upstream's menus (`film-upstream.json`), hovering each submenu. */
      const fromMenu = async (command) => {
        const row = manifest.menus.find((each) => each.command === command)
        await kit.getByTestId(`film-menu-${row.path[0]}`).click()
        for (let depth = 2; depth <= row.path.length; depth += 1) await kit.locator(`[data-kit-ui-id="menu:${row.path.slice(0, depth).join('/')}"]`).hover()
        await kit.locator(`[data-testid="film-cmd-${command}"], [data-testid="film-control-${command}"]`).first().click()
      }
      const open = (command, prefix) => async () => {
        await fromMenu(command)
        await kit.getByTestId(`film-dialog-${prefix}`).waitFor({ timeout: 10000 })
      }
      const itemsOf = (node) => [...(node?.item != null ? [node] : []), ...(node?.children ?? []).flatMap(itemsOf)]
      const named = (root, name) => itemsOf(root).find((each) => each.name === name) ?? null
      const previewInspect = () => kitFrame().evaluate(() => window.filmPreview.inspect())
      const closeDialog = async () => {
        if (await dialogShown()) await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      }
      /** Types `value` into a number field and leaves it (the field commits on blur). */
      const number = (testId, value) => async () => {
        const field = kit.locator(`[data-testid="${testId}"] input`)
        await field.fill(String(value))
        await field.press('Tab')
      }
      /** The Program monitor's preview picture once drawn for the open serial: its size, centre pixel, and corner pixel. */
      const previewPicture = async () => {
        const drawn = await until(async () => (await kit.getByTestId('film-program-preview').getAttribute('data-serial').catch(() => null)) === String((await previewState()).serial), 60)
        if (!drawn) return null
        return kitFrame().evaluate(() => {
          const canvas = document.querySelector('[data-testid="film-program-preview"]')
          if (!canvas?.width) return null
          const context2d = canvas.getContext('2d')
          const box = canvas.getBoundingClientRect()
          return { width: canvas.width, height: canvas.height, fit: getComputedStyle(canvas).objectFit, box: { width: box.width, height: box.height }, centre: [...context2d.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3)] }
        })
      }
      const middle = A.start + Math.floor(A.duration / 2 / frameTicks) * frameTicks
      await person([{ command: 'timeline.select', params: { clips: [] } }, { command: 'project.select', params: { items: [] } }, { command: 'playhead.set', params: { time: middle } }])
      await waitForEngine(page, (state) => state.details?.playhead === middle)
      const was = (await seq()).settings
      const sequenceId = (await details()).sequence?.id ?? null
      // A frame size of another aspect than the sequence's (the sample's is already 1280 × 720).
      const size = was.width === 1280 && was.height === 720 ? { width: 1080, height: 1080 } : { width: 1280, height: 720 }
      const settingsOpen = open('sequence.settings', 'sequenceSettings')
      const resize = async () => {
        await number('film-dialog-sequenceSettings-width', size.width)()
        await number('film-dialog-sequenceSettings-height', size.height)()
      }

      // Sequence Settings: each tab, its ids, and its greyed fields drawn disabled, as upstream.
      {
        await settingsOpen()
        const tabs = {}
        for (const tab of ['general', 'color', 'vr']) {
          await kit.getByTestId(`film-dialog-sequenceSettings-tab-${tab}`).click()
          await checkIds()
          tabs[tab] = await kitFrame().evaluate(() => {
            const panel = document.querySelector('[data-testid="film-dialog-sequenceSettings"] [role="tabpanel"]')
            const controls = [...(panel?.querySelectorAll('[data-kit-ui-id]') ?? [])]
            return { ids: controls.length, disabled: controls.filter((each) => each.disabled).length }
          })
        }
        await kit.getByTestId('film-dialog-sequenceSettings-tab-general').click()
        const general = {
          name: await kit.getByTestId('film-dialog-sequenceSettings-name').inputValue(),
          timebase: await kit.getByTestId('film-dialog-sequenceSettings-timebase').inputValue(),
          aspect: await kit.getByTestId('film-dialog-sequenceSettings-aspect').textContent(),
          codec: await kit.getByTestId('film-dialog-sequenceSettings-previewCodec').inputValue().catch(() => null),
          hint: await kit.getByTestId('film-dialog-sequenceSettings-editingMode').getAttribute('title'),
          // A greyed list reads as disabled; a disabled button carries its hint itself.
          greyed: await kit.getByTestId('film-dialog-sequenceSettings-editingMode').evaluate((select) => Number(getComputedStyle(select).opacity)),
          button: await kit.getByTestId('film-dialog-sequenceSettings-configure').evaluate((button) => ({ title: button.getAttribute('title'), description: button.getAttribute('aria-description') })),
        }
        const idle = await previewIdle((await previewState()).serial)
        await closeDialog()
        const rate = `${was.frame_rate.num}/${was.frame_rate.den}`
        const gcd = (a, b) => (b ? gcd(b, a % b) : a)
        const ratio = `${was.width / gcd(was.width, was.height)}:${was.height / gcd(was.width, was.height)}`
        step("Sequence Settings… opens on the active sequence with its General, Color Management, and VR Properties tabs, the greyed fields drawn disabled with upstream's hint, and previews nothing until a change", tabs.general.ids > 20 && tabs.general.disabled >= 12 && tabs.color.ids >= 3 && tabs.color.disabled === 0 && tabs.vr.disabled === 4 && general.timebase === rate && general.aspect === ratio && general.hint === zh('Not supported in Kition Film yet') && general.greyed < 0.7 && general.button.title === general.hint && general.button.description === general.hint && idle, JSON.stringify({ tabs, general, rate, ratio, idle }))
      }

      // At another frame size: the Program monitor's preview has the new aspect, and the Timeline shows its Preview badge.
      let resized = null
      const resizeCancel = await previewThenCancel({
        open: settingsOpen,
        change: resize,
        idle: true,
        expectPreview: async () => {
          const picture = await previewPicture()
          resized = { picture, badge: await kit.getByTestId('film-timeline-preview-badge').count(), changed: ((await kitFrame().evaluate(() => window.filmPreview.diff()))?.sequences?.changed ?? []).find((entry) => entry.id === sequenceId)?.fields ?? [] }
          const ratio = picture ? picture.width / picture.height : 0
          return picture != null && Math.abs(ratio - size.width / size.height) < 0.02 && picture.fit === 'contain' && resized.badge === 1 && resized.changed.includes('settings')
        },
      })
      step(`Sequence Settings… at ${size.width} × ${size.height} previews the picture at the new aspect on the Program monitor and on the Timeline, and Cancel leaves the document as it was`, resizeCancel.ok, JSON.stringify({ ...resizeCancel, resized, size }))
      const resizeOk = await previewThenOk({ open: settingsOpen, change: resize, idle: true })
      const after = (await seq()).settings
      await edited(undoKey, async () => (await seq()).settings.width === was.width)
      const restored = (await seq()).settings
      step(`Sequence Settings… OK makes the sequence ${size.width} × ${size.height} in one history step, as previewed, and one undo restores it`, resizeOk.ok && after.width === size.width && after.height === size.height && restored.width === was.width && restored.height === was.height, JSON.stringify({ ...resizeOk, after: [after.width, after.height], restored: [restored.width, restored.height] }))

      // A 29.97 timebase starts on drop-frame timecode: the Timeline's timecode reads it (";").
      {
        let shown = null
        const timecode = () => kit.getByTestId('film-timeline-timecode').textContent()
        const before = await timecode()
        const result = await previewThenCancel({
          open: settingsOpen,
          idle: true,
          change: async () => kit.getByTestId('film-dialog-sequenceSettings-timebase').selectOption('30000/1001'),
          expectPreview: async () => {
            const read = await until(async () => /;/.test((await timecode()) ?? ''), 60)
            shown = { before, during: await timecode(), display: await kit.getByTestId('film-dialog-sequenceSettings-videoDisplay').inputValue() }
            return read && shown.display === 'df' && !/;/.test(before ?? '')
          },
        })
        step("Sequence Settings… Timebase 29.97 previews drop-frame timecode on the Timeline (its Display Format turns Drop-Frame), and Cancel leaves the document as it was", result.ok, JSON.stringify({ ...result, shown }))
      }

      // Another sequence made active (its Timeline tab clicked) closes Sequence Settings, and nothing is applied.
      {
        const other = (await person([{ command: 'sequence.new', params: { name: 'Other cut' } }, { command: 'sequence.open', params: { item: sequenceId } }])).completed[0].result?.sequence ?? null
        await waitForEngine(page, (state) => state.details?.sequence?.id === sequenceId)
        const before = await documentNow()
        const serial = (await previewState()).serial
        await settingsOpen()
        await resize()
        const previewing = await previewOpened(serial)
        // The dialog sits over the Timeline's tabs at this size: moved aside by its title first
        // (the place it keeps is cleared after), as a person would.
        const title = await settledBox(kit.locator('[data-testid="film-dialog"] h2'))
        const tab = kit.getByTestId(`film-sequence-tab-${other}`)
        const tabBox = await settledBox(tab)
        if (title && tabBox) {
          await page.mouse.move(title.x + 20, title.y + title.height / 2)
          await page.mouse.down()
          await page.mouse.move(tabBox.x + tabBox.width + 120, title.y + title.height / 2 - 60, { steps: 6 })
          await page.mouse.up()
        }
        await tab.click()
        const closed = await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        const switched = await waitForEngine(page, (state) => state.details?.sequence?.id === other, { orNull: true })
        await kitFrame().evaluate(() => Object.keys(localStorage).filter((key) => key.includes('dialogPlace')).forEach((key) => localStorage.removeItem(key)))
        const settings = (await details()).sequence?.settings
        await person([{ command: 'sequence.open', params: { item: sequenceId } }])
        const after = await documentNow()
        const back = (await waitForEngine(page, (state) => state.details?.sequence?.id === sequenceId))?.details?.sequence?.settings
        // The switch is a view change: the history is as before (the tab open is session state).
        await edited(undoKey, async () => named((await details()).project?.root, 'Other cut') == null)
        step("Sequence Settings… closes when another sequence's Timeline tab is clicked, and applies nothing", other != null && previewing && closed && switched != null && before.history === after.history && back?.width === was.width && back?.height === was.height && settings?.width !== size.width, JSON.stringify({ other, previewing, closed, switched: switched != null, history: before.history === after.history, back: [back?.width, back?.height] }))
      }

      // New Sequence… "Cut 2" with 3 video tracks (from the File menu): a ghost tab and a Project row.
      const newOpen = open('sequence.new', 'sequenceSettings')
      const cutTwo = async () => {
        await kit.getByTestId('film-dialog-sequenceSettings-name').fill('Cut 2')
        await kit.getByTestId('film-dialog-sequenceSettings-tab-tracks').click()
        await checkIds()
        await number('film-dialog-sequenceSettings-tracks-video', 3)()
        await number('film-dialog-sequenceSettings-tracks-audio', 2)()
      }
      let made = null
      const newCancel = await previewThenCancel({
        open: newOpen,
        change: cutTwo,
        expectPreview: async () => {
          const item = named((await previewInspect())?.project?.root, 'Cut 2')
          const tab = kit.locator('[data-testid^="film-sequence-tab-preview-"][data-preview="added"]')
          made = {
            item: item?.item ?? null,
            tab: await until(async () => (await tab.count()) === 1 && (await tab.first().textContent()) === 'Cut 2', 60),
            row: item ? await until(async () => (await kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${item.item}"][data-preview="added"]`).count()) > 0, 60) : false,
            video: ((await previewInspect())?.sequence?.video ?? []).length,
          }
          // The Timeline draws each of the three video tracks, marked added: those in view, then
          // the rest as the video half is scrolled to them (the wheel over it).
          const drawn = new Set()
          const half = kit.getByTestId('film-timeline-video')
          const look = async () => {
            for (const each of await half.locator('[data-testid^="film-preview-track-"][data-preview="added"]').evaluateAll((tracks) => tracks.map((track) => track.getAttribute('data-testid')))) drawn.add(each)
          }
          await until(async () => (await half.locator('[data-testid^="film-preview-track-"][data-preview="added"]').count()) > 0, 60)
          await look()
          const box = await settledBox(half, { orNull: true })
          for (let turn = 0; turn < 8 && drawn.size < 3 && box; turn += 1) {
            await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2)
            await page.mouse.wheel(0, turn < 6 ? -120 : 120)
            await paintFrames()
            await look()
          }
          made.tracks = [...drawn]
          return item != null && made.tab && made.row && drawn.size === 3 && made.video === 3
        },
      })
      step('New Sequence… "Cut 2" with 3 video tracks previews a ghost tab, its three video tracks, and a Project row, and Cancel leaves the document as it was', newCancel.ok, JSON.stringify({ ...newCancel, made }))
      // OK from the Project panel's New Item ▸ Sequence…: it opens with V1–V3 (one step: drop-frame and Maximum Render Quality are off).
      const fromProject = async () => {
        await kit.getByTestId('film-project-new-item').click()
        await kit.getByTestId('film-project-new-sequence.new').click()
        await kit.getByTestId('film-dialog-sequenceSettings').waitFor({ timeout: 10000 })
      }
      const newOk = await previewThenOk({ open: fromProject, change: cutTwo })
      const opened = await details()
      const cut = named(opened.project?.root, 'Cut 2')
      const tracks = (opened.sequence?.video ?? []).map((track) => track.name)
      await edited(undoKey, async () => named((await details()).project?.root, 'Cut 2') == null)
      step('New Sequence… OK (from the Project panel\'s New Item) makes "Cut 2", which opens with V1–V3, in one history step, as previewed; one undo takes it away', newOk.ok && cut != null && opened.sequence?.id === cut.item && tracks.length === 3, JSON.stringify({ ...newOk, cut: cut?.item, active: opened.sequence?.id, tracks }))
      // With drop-frame timecode it is two steps (sequence.new, then sequence.settings), as upstream.
      {
        const twoOk = await previewThenOk({
          open: newOpen,
          steps: 2,
          change: async () => {
            await kit.getByTestId('film-dialog-sequenceSettings-name').fill('Cut DF')
            await kit.getByTestId('film-dialog-sequenceSettings-timebase').selectOption('30000/1001')
          },
        })
        const df = await details()
        const dfMade = named(df.project?.root, 'Cut DF')
        await edited(undoKey)
        await edited(undoKey, async () => named((await details()).project?.root, 'Cut DF') == null)
        step('New Sequence… at 29.97 drop-frame makes "Cut DF" in two history steps (New Sequence, then its drop-frame setting), as previewed', twoOk.ok && dfMade != null && df.sequence?.settings?.drop_frame === true, JSON.stringify({ ...twoOk, made: dfMade?.item, dropFrame: df.sequence?.settings?.drop_frame }))
      }
      // Back on the sample's sequence (undo restores it; opening it again is not an edit).
      if (!(await until(async () => (await details()).sequence?.id === sequenceId, 20))) await person([{ command: 'sequence.open', params: { item: sequenceId } }])
      await waitForEngine(page, (state) => state.details?.sequence?.id === sequenceId)

      // Sequence ▸ Color Management…: with A interpreted as S-Log3, Auto Tone Map off changes its picture's centre pixel.
      {
        await person([{ command: 'clip.interpretFootage', params: { items: [A.item], colorSpace: 'slog3-sgamut3cine' } }, { command: 'playhead.set', params: { time: middle } }])
        await waitForEngine(page, (state) => state.details?.playhead === middle)
        const colorOpen = open('sequence.colorSettings', 'colorDialog')
        const toneOff = async () => kit.getByTestId('film-dialog-colorDialog-autoToneMap').uncheck()
        let toned = null
        const colorCancel = await previewThenCancel({
          open: async () => {
            await colorOpen()
            await previewSettled()
            toned = { before: await previewPicture(), working: await kit.getByTestId('film-dialog-colorDialog-working-rec709').isChecked() }
          },
          change: toneOff,
          expectPreview: async () => {
            toned.after = await previewPicture()
            return toned.working && toned.before != null && toned.after != null && toned.before.centre.join() !== toned.after.centre.join()
          },
        })
        step('Color Management… opens on the sequence\'s Rec. 709, and Auto Tone Map off previews the log clip\'s picture untone-mapped (the centre pixel changes); Cancel leaves the document as it was', colorCancel.ok, JSON.stringify({ ...colorCancel, toned }))
        const colorOk = await previewThenOk({ open: colorOpen, change: toneOff })
        const tone = (await seq()).settings.color?.auto_tone_map
        await edited(undoKey, async () => (await seq()).settings.color?.auto_tone_map === true)
        step('Color Management… OK turns Auto Tone Map off in one history step, as previewed', colorOk.ok && tone === false, JSON.stringify({ ...colorOk, tone }))
        await edited(undoKey)
      }
      await closeDialog()
    }

    // ---- upstream's track, sequence tool, and new item dialogs (Task 14), each previewed
    // (upstream's have no preview): Add and Delete Tracks, Normalize Mix Track, Simplify Sequence,
    // New Color Matte and Color Matte Color, and the new items upstream makes at once. None of
    // them removes or moves a Project item, so no step here covers removed Project rows.
    {
      /** Opens `command`'s dialog from its row in upstream's menus (`film-upstream.json`), hovering each submenu. */
      const fromMenu = async (command) => {
        const row = manifest.menus.find((each) => each.command === command)
        await kit.getByTestId(`film-menu-${row.path[0]}`).click()
        for (let depth = 2; depth <= row.path.length; depth += 1) await kit.locator(`[data-kit-ui-id="menu:${row.path.slice(0, depth).join('/')}"]`).hover()
        await kit.locator(`[data-testid="film-cmd-${command}"], [data-testid="film-control-${command}"]`).first().click()
      }
      const open = (command, prefix) => async () => {
        await fromMenu(command)
        await kit.getByTestId(`film-dialog-${prefix}`).waitFor({ timeout: 10000 })
      }
      const itemsOf = (node) => [...(node?.item != null ? [node] : []), ...(node?.children ?? []).flatMap(itemsOf)]
      const previewInspect = () => kitFrame().evaluate(() => window.filmPreview.inspect())
      const previewDiff = () => kitFrame().evaluate(() => window.filmPreview.diff())
      const closeDialog = async () => {
        if (await dialogShown()) await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      }
      /** Types `value` into a number field and leaves it (the field commits on blur). */
      const number = (testId, value) => async () => {
        const field = kit.locator(`[data-testid="${testId}"] input`)
        await field.fill(String(value))
        await field.press('Tab')
      }
      /**
       * Opens a colour row's picker, types `hex` into it (Tab commits; Enter would be OK), and
       * closes the picker with Escape, which leaves the dialog open (`pickerEscapes` counts it).
       */
      let pickerEscapes = 0
      /** Each opened picker: whether its pop-up keeps clear of the dialog's title (`pickerPlace`). */
      const pickerClear = []
      const colour = (prefix, hex) => async () => {
        if (!(await kit.getByTestId(`film-dialog-${prefix}-color-picker-hex`).count())) await kit.getByTestId(`film-dialog-${prefix}-color`).click()
        await paintFrames()
        const popup = await settledBox(kit.getByTestId(`film-dialog-${prefix}-color-popup`), { orNull: true })
        const title = await settledBox(kit.locator('[data-testid="film-dialog"] h2'), { orNull: true })
        pickerClear.push(popup != null && title != null && (popup.x >= title.x + title.width || popup.x + popup.width <= title.x || popup.y >= title.y + title.height || popup.y + popup.height <= title.y))
        const field = kit.getByTestId(`film-dialog-${prefix}-color-picker-hex`)
        await field.fill(hex)
        await field.press('Tab')
        await page.keyboard.press('Escape')
        if ((await until(async () => (await kit.getByTestId(`film-dialog-${prefix}-color-popup`).count()) === 0, 40)) && (await dialogShown()) === 1) pickerEscapes += 1
      }
      /** The tracks a half of the Timeline marks `mark`, scrolled through (the wheel over it) until each of `ids` is drawn. */
      const marked = async (half, mark, ids) => {
        const drawn = new Set()
        const lane = kit.getByTestId(`film-timeline-${half}`)
        const look = async () => {
          for (const each of await lane.locator(`[data-testid^="film-preview-track-"][data-preview="${mark}"]`).evaluateAll((tracks) => tracks.map((track) => Number(track.getAttribute('data-testid').replace('film-preview-track-', ''))))) drawn.add(each)
        }
        await until(async () => (await lane.locator(`[data-testid^="film-preview-track-"][data-preview="${mark}"]`).count()) > 0, 60)
        await look()
        const box = await settledBox(lane, { orNull: true })
        for (let turn = 0; turn < 12 && !ids.every((id) => drawn.has(id)) && box; turn += 1) {
          await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2)
          await page.mouse.wheel(0, turn < 4 ? -120 : 120)
          await paintFrames()
          await look()
        }
        // Back to where the half rests (the video half at its bottom, V1 by the divider; the
        // audio half at its top), so later steps find the clips where they were.
        if (box) {
          await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2)
          for (let turn = 0; turn < 12; turn += 1) await page.mouse.wheel(0, half === 'video' ? 120 : -120)
          await paintFrames()
        }
        return [...drawn]
      }
      /** The centre pixel of a canvas the page has drawn (`selector`), or null. */
      const centre = (selector) =>
        kitFrame().evaluate((query) => {
          const canvas = document.querySelector(query)
          if (!canvas?.width) return null
          return { size: [canvas.width, canvas.height], rgb: [...canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3)] }
        }, selector)
      const red = (pixel) => pixel != null && pixel.rgb[0] > 200 && pixel.rgb[1] < 60 && pixel.rgb[2] < 60
      const blue = (pixel) => pixel != null && pixel.rgb[2] > 200 && pixel.rgb[0] < 60 && pixel.rgb[1] < 60
      const iconOf = (item) => `[data-testid="film-project"] [data-testid="film-project-item-${item}"] canvas[data-drawn]`
      await person([{ command: 'timeline.select', params: { clips: [] } }, { command: 'project.select', params: { items: [] } }])
      const sequenceId = (await details()).sequence?.id ?? null

      // Add Tracks…: it opens on one video and one audio track after the last ones; two audio
      // tracks after A1 preview as two dashed tracks there.
      const audioBefore = (await seq()).audio.map((track) => track.id)
      const videoBefore = (await seq()).video.map((track) => track.id)
      const addOpen = open('sequence.addTracks', 'addTracks')
      const twoAudio = async () => {
        await number('film-dialog-addTracks-video-amount', 0)()
        await number('film-dialog-addTracks-audio-amount', 2)()
        await kit.getByTestId('film-dialog-addTracks-audio-placement').selectOption('1')
      }
      let adds = null
      const addCancel = await previewThenCancel({
        open: async () => {
          await addOpen()
          adds = {
            opened: {
              video: await kit.locator('[data-testid="film-dialog-addTracks-video-amount"] input').inputValue(),
              audio: await kit.locator('[data-testid="film-dialog-addTracks-audio-amount"] input').inputValue(),
              placement: await kit.getByTestId('film-dialog-addTracks-video-placement').inputValue(),
              options: await kit.getByTestId('film-dialog-addTracks-audio-placement').locator('option').count(),
              submix: await kit.getByTestId('film-dialog-addTracks-submix-placement').isDisabled(),
            },
          }
        },
        change: twoAudio,
        expectPreview: async () => {
          const audio = (await previewInspect())?.sequence?.audio ?? []
          adds.tracks = audio.map((track) => track.id)
          const fresh = adds.tracks.filter((id) => !audioBefore.includes(id))
          adds.drawn = await marked('audio', 'added', fresh)
          adds.dashed = await kit.locator('[data-testid="film-timeline-audio"] [data-testid^="film-preview-track-"][data-preview="added"]').first().evaluate((element) => getComputedStyle(element).borderTopStyle).catch(() => null)
          return audio.length === audioBefore.length + 2 && adds.tracks[0] === audioBefore[0] && fresh.length === 2 && adds.tracks.indexOf(fresh[0]) === 1 && fresh.every((id) => adds.drawn.includes(id)) && adds.dashed === 'dashed'
        },
      })
      const openedRight = adds?.opened.video === '1' && adds?.opened.audio === '1' && adds?.opened.placement === String(videoBefore.length) && adds?.opened.options === audioBefore.length + 1 && adds?.opened.submix === true
      step('Add Tracks… opens on one video and one audio track after the last ones (submix placement greyed: no submix track), and 2 audio tracks after A1 preview as two dashed tracks there; Cancel leaves the document as it was', addCancel.ok && openedRight, JSON.stringify({ ...addCancel, adds }))
      const addOk = await previewThenOk({ open: addOpen, change: twoAudio })
      const audioAfter = (await seq()).audio
      await edited(undoKey, async () => (await seq()).audio.length === audioBefore.length)
      step('Add Tracks… OK adds A2 and A3 after A1 in one history step, as previewed; one undo takes them away', addOk.ok && audioAfter.length === audioBefore.length + 2 && audioAfter[1]?.name === 'Audio 2' && audioAfter[2]?.name === 'Audio 3' && !audioBefore.includes(audioAfter[1]?.id) && (await seq()).audio.length === audioBefore.length, JSON.stringify({ ...addOk, names: audioAfter.map((track) => track.name) }))

      // Another sequence made active (its Timeline tab clicked) with Add Tracks open: it stays
      // open, as upstream's, and lists that sequence's tracks after its last ones.
      {
        const made = (await person([{ command: 'sequence.new', params: { name: 'Two tracks', video: 1, audio: 2 } }, { command: 'sequence.open', params: { item: sequenceId } }])).completed[0].result?.sequence ?? null
        await waitForEngine(page, (state) => state.details?.sequence?.id === sequenceId)
        await addOpen()
        const title = await settledBox(kit.locator('[data-testid="film-dialog"] h2'))
        const tab = kit.getByTestId(`film-sequence-tab-${made}`)
        const tabBox = await settledBox(tab)
        if (title && tabBox) {
          await page.mouse.move(title.x + 20, title.y + title.height / 2)
          await page.mouse.down()
          await page.mouse.move(tabBox.x + tabBox.width + 120, title.y + title.height / 2 - 60, { steps: 6 })
          await page.mouse.up()
        }
        await tab.click()
        const switched = await waitForEngine(page, (state) => state.details?.sequence?.id === made, { orNull: true })
        const options = kit.getByTestId('film-dialog-addTracks-audio-placement').locator('option')
        const listed = await until(async () => (await options.count()) === 3 && (await kit.getByTestId('film-dialog-addTracks-video-placement').inputValue()) === '1', 60)
        const shown = { open: await dialogShown(), audio: await options.allTextContents(), video: await kit.getByTestId('film-dialog-addTracks-video-placement').inputValue(), previewed: (await previewState()).open }
        await closeDialog()
        await kitFrame().evaluate(() => Object.keys(localStorage).filter((key) => key.includes('dialogPlace')).forEach((key) => localStorage.removeItem(key)))
        await person([{ command: 'sequence.open', params: { item: sequenceId } }])
        await waitForEngine(page, (state) => state.details?.sequence?.id === sequenceId)
        await edited(undoKey, async () => !itemsOf((await details()).project?.root).some((each) => each.item === made))
        step("Add Tracks… stays open when another sequence's Timeline tab is clicked, and lists that sequence's tracks after its last ones (upstream's dialog follows the active sequence)", made != null && switched != null && listed && shown.open === 1 && shown.previewed, JSON.stringify({ made, switched: switched != null, listed, ...shown }))
      }

      // A previewing dialog taller than the workspace keeps its place once it is lifted to the top (no update loop).
      {
        const loops = () => consoleErrors.filter((text) => text.includes('Maximum update depth')).length
        const before = loops()
        await kitFrame().evaluate(() =>
          window.filmPreview.open({ id: 'sequence.addTracks', family: 'tracks', title: 'Add Tracks', prefix: 'addTracks', preview: ['timeline'], layout: Array.from({ length: 70 }, (_, index) => ({ kind: 'heading', label: `Row ${index + 1}` })), defaults: () => ({ video: 0, audio: 1 }) }),
        )
        await kit.getByTestId('film-dialog').waitFor({ timeout: 10000 })
        const opened = await previewOpened((await previewState()).serial - 1)
        for (let frame = 0; frame < 6; frame += 1) await paintFrames()
        const box = await kit.getByTestId('film-dialog').boundingBox()
        const still = { open: await dialogShown(), loops: loops() - before, top: box?.y ?? null }
        await closeDialog()
        step('a previewing dialog taller than the workspace is lifted to its top once and stays there, with no update loop', opened && still.open === 1 && still.loops === 0, JSON.stringify({ opened, ...still }))
      }

      // An empty video track (made here, taken away after): Delete Tracks (All Empty video) and Simplify both drop it.
      const emptyTrack = (await person([{ command: 'sequence.addTracks', params: { video: 1 } }])).completed[0].result?.video?.[0] ?? null
      await waitForEngine(page, (state) => (state.details?.sequence?.video ?? []).some((track) => track.id === emptyTrack))
      {
        let gone = null
        const deleteCancel = await previewThenCancel({
          open: async () => {
            await open('sequence.deleteTracks', 'deleteTracks')()
            gone = { okBefore: await kit.getByTestId('film-dialog-ok').isDisabled(), listBefore: await kit.getByTestId('film-dialog-deleteTracks-video-target').isDisabled() }
          },
          idle: true,
          change: async () => {
            await kit.getByTestId('film-dialog-deleteTracks-video').check()
            // Enter on the focused checkbox is not OK (kit-editor's PreviewDialog): nothing is deleted.
            await kit.getByTestId('film-dialog-deleteTracks-video').focus()
            await page.keyboard.press('Enter')
          },
          expectPreview: async () => {
            gone.stillOpen = (await dialogShown()) === 1 && (await seq()).video.some((track) => track.id === emptyTrack)
            gone.names = await kit.locator('[data-testid="film-dialog-deleteTracks"] select').evaluateAll((lists) => lists.map((list) => list.getAttribute('aria-label')))
            gone.drawn = await marked('video', 'removed', [emptyTrack])
            gone.okAfter = await kit.getByTestId('film-dialog-ok').isDisabled()
            gone.removed = ((await previewDiff())?.tracks?.removed ?? []).map((entry) => entry.id)
            return gone.stillOpen && gone.names.join() === [zh('Video Tracks'), zh('Audio Tracks')].join() && gone.drawn.includes(emptyTrack) && gone.removed.includes(emptyTrack) && !gone.removed.includes(videoBefore[0]) && !gone.okAfter
          },
        })
        step('Delete Tracks… previews nothing and greys OK until a kind is checked; Enter on the checked box applies nothing; its lists are named; All Empty video tracks strikes the empty track through on the Timeline, and Cancel leaves the document as it was', deleteCancel.ok && gone?.okBefore === true && gone?.listBefore === true, JSON.stringify({ ...deleteCancel, gone }))
      }

      // Simplify Sequence…: the copy opens as a ghost tab with its Project row, compared with its
      // source on the Timeline (the empty track struck through, the kept clips not marked).
      {
        const name = `${(await details()).sequence?.name ?? ''} (Simplified)`
        let simple = null
        const simplifyCancel = await previewThenCancel({
          open: open('sequence.simplify', 'simplify'),
          change: async () => kit.getByTestId('film-dialog-simplify-closeGaps').check(),
          expectPreview: async () => {
            const tab = kit.locator('[data-testid^="film-sequence-tab-preview-"][data-preview="added"]')
            const copy = (await previewInspect())?.project?.activeSequence ?? null
            simple = {
              field: await kit.getByTestId('film-dialog-simplify-name').inputValue(),
              tab: await until(async () => (await tab.count()) === 1 && (await tab.first().textContent()) === name, 60),
              row: copy != null && (await until(async () => (await kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${copy}"][data-preview="added"]`).count()) > 0, 60)),
              drawn: await marked('video', 'removed', [emptyTrack]),
              addedClips: await kit.locator('[data-testid^="film-clip-"][data-preview="added"]').count(),
              copy,
            }
            // What the Timeline compares the copy by (`copiesShown`): the diff's added sequences, and
            // the track ids of the document's shown sequence and of the copy (reported, not asserted).
            const trackIds = (sequence) => [...(sequence?.video ?? []), ...(sequence?.audio ?? [])].map((track) => track.id)
            const shownDoc = await details()
            simple.compared = {
              added: ((await previewDiff())?.sequences?.added ?? []).map((entry) => entry.id),
              docActive: shownDoc.project?.activeSequence ?? null,
              docTracks: trackIds(shownDoc.sequence),
              copyTracks: trackIds((await previewInspect())?.sequence),
            }
            return simple.field === name && simple.tab && simple.row && simple.drawn.includes(emptyTrack) && simple.addedClips === 0 && copy !== sequenceId
          },
        })
        step('Simplify Sequence… previews the simplified copy as a ghost tab and a Project row, compared with its source on the Timeline (the empty track struck through, its kept clips unmarked); Cancel leaves the document as it was', simplifyCancel.ok, JSON.stringify({ ...simplifyCancel, simple }))
      }
      await edited(undoKey, async () => !(await seq()).video.some((track) => track.id === emptyTrack))

      // Normalize Mix Track… to −6 dB: the strip plays it and names the gain it applies.
      {
        let level = null
        const normalizeCancel = await previewThenCancel({
          open: open('sequence.normalizeMixTrack', 'normalizeMix'),
          change: number('film-dialog-normalizeMix-db', -6),
          expectPreview: async () => {
            const result = (await previewState()).result
            level = { result, line: await kit.getByTestId('film-preview-result').textContent().catch(() => null), play: await kit.getByTestId('film-preview-play').count() }
            return Math.abs((result?.peakDb ?? 0) + 6) < 0.5 && Number.isFinite(result?.gainDb) && pattern(ztRaw('preview.normalizeGain'), { gain: '[+-]\\d+\\.\\d dB', before: '.+', after: '.+' }, { start: true, end: true }).test(level.line ?? '') && level.play === 1
          },
        })
        step('Normalize Mix Track… to −6 dB previews the mix peaking at −6 dB, with Play and the gain it applies in the strip; Cancel leaves the document as it was', normalizeCancel.ok, JSON.stringify({ ...normalizeCancel, level }))
      }

      // New Color Matte… red at 640 × 360 (File ▸ New): a red icon in a ghost row, and the matte in the strip.
      const matteOpen = open('item.newColorMatte', 'colorMatte')
      const redMatte = async () => {
        await colour('colorMatte', 'ff0000')()
        await number('film-dialog-colorMatte-width', 640)()
        await number('film-dialog-colorMatte-height', 360)()
      }
      let matte = null
      const matteCancel = await previewThenCancel({
        open: matteOpen,
        change: redMatte,
        expectPreview: async () => {
          const item = (await previewState()).result?.item ?? null
          matte = { item, hex: await kit.getByTestId('film-dialog-colorMatte-color-hex').textContent() }
          if (item == null) return false
          await kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${item}"]`).first().scrollIntoViewIfNeeded().catch(() => undefined)
          matte.row = await until(async () => (await kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${item}"][data-preview="added"]`).count()) > 0, 60)
          matte.icon = (await until(async () => red(await centre(iconOf(item))), 60)) ? await centre(iconOf(item)) : await centre(iconOf(item))
          matte.strip = (await until(async () => red(await centre(`[data-testid="film-preview-item"][data-item="${item}"][data-drawn]`)), 60)) ? await centre('[data-testid="film-preview-item"][data-drawn]') : null
          const ratio = matte.strip ? matte.strip.size[0] / matte.strip.size[1] : 0
          return matte.hex === '#ff0000' && matte.row && red(matte.icon) && red(matte.strip) && Math.abs(ratio - 16 / 9) < 0.05
        },
      })
      step('New Color Matte… red at 640 × 360 previews a red icon in a ghost Project row and the red matte in the strip (the picker clear of the title; Escape closes the picker, not the dialog); Cancel leaves the document as it was', matteCancel.ok && pickerEscapes === 1 && pickerClear.join() === 'true', JSON.stringify({ ...matteCancel, matte, pickerEscapes, pickerClear }))
      const matteOk = await previewThenOk({ open: matteOpen, change: redMatte })
      const made = itemsOf((await details()).project?.root).filter((each) => each.name === 'Color Matte').map((each) => each.item).sort((a, b) => b - a)[0] ?? null
      step('New Color Matte… OK makes the red matte in one history step, as previewed', matteOk.ok && made != null, JSON.stringify({ ...matteOk, made }))
      // A double-click on it opens Color Matte Color on its red; blue previews a blue icon.
      {
        let recolour = null
        const recolourCancel = await previewThenCancel({
          open: async () => {
            const card = kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${made}"]`).first()
            await card.scrollIntoViewIfNeeded()
            await card.dblclick()
            await kit.getByTestId('film-dialog-matteColor').waitFor({ timeout: 10000 })
            recolour = { hex: await kit.getByTestId('film-dialog-matteColor-color-hex').textContent(), selected: (await waitForEngine(page, () => true)).details?.projectSelection ?? null }
          },
          change: colour('matteColor', '0000ff'),
          expectPreview: async () => {
            recolour.changed = ((await previewDiff())?.items?.changed ?? []).find((entry) => entry.id === made)?.fields ?? []
            recolour.icon = (await until(async () => blue(await centre(iconOf(made))), 60)) ? await centre(iconOf(made)) : await centre(iconOf(made))
            return recolour.changed.includes('media') && blue(recolour.icon)
          },
        })
        step('A double-click on the Color Matte opens Color Matte Color on its red; blue previews a blue icon in the Project panel, and Cancel leaves the document as it was', recolourCancel.ok && recolour?.hex === '#ff0000', JSON.stringify({ ...recolourCancel, recolour }))
      }
      await closeDialog()
      await edited(undoKey, async () => !itemsOf((await details()).project?.root).some((each) => each.item === made))

      // Bars and Tone from the Project panel's New Item menu, and from File ▸ New: each adds an item at once, with no dialog.
      {
        const count = async () => itemsOf((await details()).project?.root).length
        const before = await count()
        const stepsBefore = await history()
        await kit.getByTestId('film-project-new-item').click()
        await kit.getByTestId('film-project-new-item.newBarsAndTone').click()
        const fromPanel = await until(async () => (await count()) === before + 1, 50)
        const panelDialog = await kit.locator('[role="dialog"]').count()
        await fromMenu('item.newBarsAndTone')
        const fromFile = await until(async () => (await count()) === before + 2, 50)
        const fileDialog = await kit.locator('[role="dialog"]').count()
        await fromMenu('mixer.addSubmix')
        const submix = await until(async () => (await history()) === stepsBefore + 3, 50)
        const submixDialog = await kit.locator('[role="dialog"]').count()
        for (let undo = 0; undo < 3; undo += 1) await edited(undoKey)
        const back = await until(async () => (await count()) === before && (await history()) === stepsBefore, 50)
        step('Bars and Tone from New Item and from File ▸ New, and Sequence ▸ Add Submix, each run at once with no dialog (one history step each), as upstream', fromPanel && fromFile && submix && back && panelDialog === 0 && fileDialog === 0 && submixDialog === 0, JSON.stringify({ fromPanel, fromFile, submix, back, dialogs: [panelDialog, fileDialog, submixDialog] }))
      }
    }

    // ---- upstream's Find, Create Search Bin, and Automate To Sequence (Task 15), each previewed
    // (upstream's have no preview): Find highlights every match and stays open; a search bin's
    // ghost lists its matches; Automate's clips are placed on the Timeline. None of them removes
    // or moves a Project item, so no step here covers removed Project rows.
    {
      const fromMenu = async (command) => {
        const row = manifest.menus.find((each) => each.command === command)
        await kit.getByTestId(`film-menu-${row.path[0]}`).click()
        for (let depth = 2; depth <= row.path.length; depth += 1) await kit.locator(`[data-kit-ui-id="menu:${row.path.slice(0, depth).join('/')}"]`).hover()
        await kit.locator(`[data-testid="film-cmd-${command}"], [data-testid="film-control-${command}"]`).first().click()
      }
      const itemsOf = (node) => [...(node?.item != null ? [node] : []), ...(node?.children ?? []).flatMap(itemsOf)]
      const sessionState = async () => (await person([{ command: 'state.inspect', params: {} }])).completed[0].result
      const projectSelection = async () => JSON.stringify((await sessionState())?.project_selection ?? [])
      const previewInspect = () => kitFrame().evaluate(() => window.filmPreview.inspect())
      const previewDiff = () => kitFrame().evaluate(() => window.filmPreview.diff())
      const closeDialog = async () => {
        if (await dialogShown()) await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      }
      /** The search bins (`project.searchBins`): the document's, and the open preview's copy's. */
      const documentSearchBins = async () => (await person([{ command: 'project.searchBins', params: {} }])).completed[0].result ?? []
      const previewSearchBins = () => kitFrame().evaluate(async () => {
        const raw = await window.filmPreview.query('project.searchBins', {})
        return typeof raw === 'string' ? JSON.parse(raw) : raw
      })
      const resultLine = () => kit.getByTestId('film-preview-result').textContent({ timeout: 300 }).catch(() => null)
      // A sound item named Tone (the one item "tone" finds), the List view at the project's root,
      // and a selection Find does not touch until its Find.
      const toneNamed = async () => itemsOf((await details()).project?.root).filter((each) => /tone/i.test(each.name ?? ''))
      let toneItems = await toneNamed()
      if (toneItems.length === 0) {
        await person([{ command: 'item.newOfflineFile', params: { name: 'Tone', video: false, audio: true, seconds: 3 } }])
        toneItems = await toneNamed()
      }
      const tone = toneItems[0]?.item ?? null
      const bars = itemsOf((await details()).project?.root).find((each) => each.name?.includes('bars'))?.item ?? null
      await person([{ command: 'timeline.select', params: { clips: [] } }, { command: 'project.select', params: { items: bars != null ? [bars] : [] } }])
      // The view the Project panel was left in, put back at the end for the steps after.
      const viewBefore = await kit.getByTestId('film-project').getAttribute('data-view')
      await kit.getByTestId('film-project-view-list').click()
      await kit.getByTestId('film-project-list').waitFor({ timeout: 10000 })
      if (await kit.getByTestId('film-project-search').inputValue()) await kit.getByTestId('film-project-search').fill('')
      const selectedBefore = await projectSelection()
      const typeFind = async () => {
        await kit.getByTestId('film-dialog-find-row-0-text').fill('tone')
      }
      const openFind = async () => {
        await kit.getByTestId('film-project-find').click()
        await kit.getByTestId('film-dialog-find').waitFor({ timeout: 10000 })
      }

      // Find "tone" from the Project panel's Find button: the Tone row is highlighted, the strip says
      // Match 1 of N, and Cancel (Done) leaves the document and the selection as they were.
      let found = null
      const findCancel = await previewThenCancel({
        open: openFind,
        change: typeFind,
        idle: true,
        expectPreview: async () => {
          const shown = await previewState()
          found = { highlight: shown.highlight?.items ?? [], line: await resultLine(), scope: await kit.getByTestId('film-dialog-find-scope-project').isChecked() }
          found.row = await until(async () => (await kit.locator(`[data-testid="film-project"] [data-testid="film-project-item-${tone}"][data-preview-selected]`).count()) > 0, 60)
          found.selection = await projectSelection()
          return found.scope && found.highlight.includes(tone) && found.highlight.length === toneItems.length && found.line === zt('preview.findMatch', { n: 1, total: toneItems.length }) && found.row && found.selection === selectedBefore
        },
      })
      step(`Find… "tone" from the Project panel opens on Find in Project, previews nothing until a row has text, then highlights the Tone row with "Match 1 of ${toneItems.length}" (the real selection unchanged); Done leaves the document as it was`, findCancel.ok && (await projectSelection()) === selectedBefore, JSON.stringify({ ...findCancel, found, tone }))

      // Find ▸ Find selects it for real and stays open with its line; Done closes it.
      {
        await openFind()
        const typedFrom = (await previewState()).serial
        await typeFind()
        await previewOpened(typedFrom)
        await kit.getByTestId('film-dialog-ok').click()
        const selected = await until(async () => (await projectSelection()) === JSON.stringify([tone]), 60)
        await paintFrames()
        // The preview opens again on the real selection, and its line is drawn after it.
        await until(async () => (await previewState()).open && (await resultLine()) === zt('preview.findMatch', { n: 1, total: toneItems.length }), 60)
        const stays = (await dialogShown()) === 1
        const line = await resultLine()
        const previewing = (await previewState()).open
        await kit.getByTestId('film-dialog-cancel').click()
        const closed = await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        step(`Find ▸ Find selects the Tone item and the dialog stays open, previewing, with "Match 1 of ${toneItems.length}"; Done closes it`, selected && stays && previewing && line === zt('preview.findMatch', { n: 1, total: toneItems.length }) && closed, JSON.stringify({ selected, stays, previewing, line, closed, selection: await projectSelection() }))
      }

      // Create Search Bin "Audio" (Media Type contains Audio), from File ▸ New: the ghost search bin
      // lists the sound items only, open; OK makes it in one history step, as previewed.
      const audioItems = itemsOf((await details()).project?.root).filter((each) => each.type === 'Audio').map((each) => each.item).sort((a, b) => a - b)
      const fillBin = async () => {
        await kit.getByTestId('film-dialog-searchBin-name').fill('Audio')
        await kit.getByTestId('film-dialog-searchBin-column').selectOption('Media Type')
        await kit.getByTestId('film-dialog-searchBin-text').fill('Audio')
      }
      let ghost = null
      const binCancel = await previewThenCancel({
        open: async () => {
          await fromMenu('bin.addSearch')
          await kit.getByTestId('film-dialog-searchBin').waitFor({ timeout: 10000 })
        },
        change: fillBin,
        idle: true,
        expectPreview: async () => {
          const bins = (await previewSearchBins()) ?? []
          const made = bins.find((each) => each.name === 'Audio') ?? null
          ghost = { made }
          if (!made) return false
          const row = kit.locator(`[data-testid="film-project-search-bin-${made.bin}"][data-preview="added"]`)
          ghost.row = await until(async () => (await row.count()) === 1, 60)
          ghost.text = await row.textContent().catch(() => null)
          ghost.listed = (await kit.locator(`[data-testid^="film-project-search-bin-${made.bin}-item-"]`).evaluateAll((rows) => rows.map((each) => Number(each.getAttribute('data-testid').split('-item-')[1])))).sort((a, b) => a - b)
          return ghost.row && ghost.text === `Audio (${audioItems.length})` && JSON.stringify(ghost.listed) === JSON.stringify(audioItems) && JSON.stringify([...made.items].sort((a, b) => a - b)) === JSON.stringify(audioItems)
        },
      })
      step('Create Search Bin "Audio" (Media Type contains Audio) previews a ghost search bin, open, listing only the sound items; Cancel leaves the document as it was', binCancel.ok && audioItems.length > 0 && audioItems.includes(tone), JSON.stringify({ ...binCancel, ghost, audioItems }))
      const binOk = await previewThenOk({
        open: async () => {
          await fromMenu('bin.addSearch')
          await kit.getByTestId('film-dialog-searchBin').waitFor({ timeout: 10000 })
        },
        change: fillBin,
        idle: true,
      })
      const madeBin = (await documentSearchBins()).find((each) => each.name === 'Audio') ?? null
      const binRow = madeBin ? kit.locator(`[data-testid="film-project-search-bin-${madeBin.bin}"]`) : null
      const binShown = binRow ? await until(async () => (await binRow.count()) === 1 && (await binRow.textContent()) === `Audio (${audioItems.length})`, 60) : false
      step('Create Search Bin OK makes the search bin in one history step, as previewed, and the List view lists it with its count', binOk.ok && binShown, JSON.stringify({ ...binOk, madeBin, binShown }))
      if (binRow && madeBin) {
        // A click opens it to its matches; Delete Search Bin (its menu) removes it at once, no confirmation.
        await binRow.click()
        const opened = await until(async () => (await kit.locator(`[data-testid^="film-project-search-bin-${madeBin.bin}-item-"]`).count()) === audioItems.length, 40)
        await checkIds()
        const steps = await history()
        await binRow.click({ button: 'right' })
        await kit.getByTestId('film-project-search-bin-delete').click()
        const deleted = await until(async () => (await documentSearchBins()).every((each) => each.bin !== madeBin.bin) && (await binRow.count()) === 0, 60)
        const asked = await kit.locator('[role="dialog"]').count()
        step('a search bin opens to its matches on a click, and Delete Search Bin removes it in one history step with no confirmation, as upstream', opened && deleted && asked === 0 && (await history()) === steps + 1, JSON.stringify({ opened, deleted, asked, steps: [steps, await history()] }))
      }

      // Automate to Sequence… from the Project panel's footer with two items selected: both are
      // placed on the Timeline as added clips (dashed), at the playhead.
      if (bars != null && tone != null) {
        await person([{ command: 'project.select', params: { items: [bars, tone] } }, { command: 'playhead.set', params: { seconds: 0 } }])
        // The whole sequence in view (\\, Zoom to Sequence), so the placed clips are drawn.
        await kit.locator('.kui-app').focus()
        await page.keyboard.press('\\')
        let placed = null
        const automateCancel = await previewThenCancel({
          open: async () => {
            await kit.getByTestId('film-project-automate').click()
            await kit.getByTestId('film-dialog-automate').waitFor({ timeout: 10000 })
          },
          change: async () => {
            const box = kit.locator('[data-testid="film-dialog-automate-overlapFrames"] input')
            await box.fill('0')
            await box.press('Tab')
          },
          expectPreview: async () => {
            const diff = await previewDiff()
            const shown = await previewInspect()
            const clipsShown = [...(shown?.sequence?.video ?? []), ...(shown?.sequence?.audio ?? [])].flatMap((track) => track.items ?? [])
            const added = (diff?.clips?.added ?? []).map((entry) => clipsShown.find((clip) => clip.clip === entry.id)?.item)
            placed = { added, to: await kit.getByTestId('film-dialog-automate-sequence').textContent() }
            // The previewed sequence in view (\\ zooms to its new length) and the audio half scrolled
            // to its top (A1), where the sound is placed.
            await kit.locator('.kui-app').focus()
            await page.keyboard.press('\\')
            const lane = await settledBox(kit.getByTestId('film-timeline-audio'), { orNull: true })
            if (lane) {
              await page.mouse.move(lane.x + lane.width * 0.7, lane.y + lane.height / 2)
              for (let turn = 0; turn < 8; turn += 1) await page.mouse.wheel(0, -120)
              await paintFrames()
            }
            const drawnItems = async () => kit.locator('[data-testid^="film-clip-"][data-preview="added"]').evaluateAll((all) => all.map((each) => Number(each.getAttribute('data-testid').replace('film-clip-', ''))))
            placed.drawn = await until(async () => {
              const ids = await drawnItems()
              const items = ids.map((id) => clipsShown.find((clip) => clip.clip === id)?.item)
              return items.includes(bars) && items.includes(tone)
            }, 60)
            if (!placed.drawn) placed.ids = await drawnItems()
            return added.includes(bars) && added.includes(tone) && placed.drawn
          },
        })
        step('Automate to Sequence… (the footer) with two items selected previews both placed on the Timeline as added clips, and Cancel leaves the document as it was', automateCancel.ok, JSON.stringify({ ...automateCancel, placed, bars, tone }))
      }

      // Edit ▸ Find… with the Timeline focused opens on Find in the Timeline; "bars" highlights every
      // bars clip on the Timeline (the copy selects only the first), with Match 1 of N.
      {
        await fromMenu('window.panel.Timeline')
        await until(async () => (await kit.locator('[data-testid="film-workspace-frame-timeline"][data-focused="true"]').count()) === 1, 30)
        const sequenceNow = (await details()).sequence
        const barsClips = [...(sequenceNow?.video ?? []), ...(sequenceNow?.audio ?? [])].flatMap((track) => track.items ?? []).filter((clip) => /bars/i.test(clip.name ?? '')).map((clip) => clip.clip)
        let hits = null
        const timelineCancel = await previewThenCancel({
          open: async () => {
            await fromMenu('edit.find')
            await kit.getByTestId('film-dialog-find').waitFor({ timeout: 10000 })
          },
          // It opens on the last project Find's text, "tone", which no clip matches: the strip says
          // so and Preview stays on (upstream shows the engine's answer after Find).
          change: async () => {
            hits = { opened: await kit.getByTestId('film-dialog-find-row-0-text').inputValue() }
            hits.quiet = (await until(async () => (await resultLine()) === 'no matches', 40)) && (await kit.getByTestId('film-dialog-preview').isChecked())
            await kit.getByTestId('film-dialog-find-row-0-text').fill('bars')
          },
          idle: true,
          expectPreview: async () => {
            const shown = await previewState()
            hits = { ...hits, timeline: await kit.getByTestId('film-dialog-find-scope-timeline').isChecked(), clips: shown.highlight?.clips ?? [], line: await resultLine() }
            hits.drawn = await until(async () => (await kit.locator('[data-testid^="film-clip-"][data-preview-selected]').count()) >= Math.min(2, barsClips.length), 60)
            const sorted = (list) => JSON.stringify([...list].sort((a, b) => a - b))
            return hits.opened === 'tone' && hits.quiet && hits.timeline && sorted(hits.clips) === sorted(barsClips) && hits.line === zt('preview.findMatch', { n: 1, total: shown.result?.matches }) && hits.drawn
          },
        })
        step(`Edit ▸ Find… with the Timeline focused opens on Find in the Timeline with the last project text, "tone" (the strip says "no matches", Preview stays on), and "bars" highlights all ${barsClips.length} bars clips on the Timeline with "Match 1 of N"; Done leaves the document as it was`, timelineCancel.ok && barsClips.length >= 2, JSON.stringify({ ...timelineCancel, hits, barsClips }))
      }

      // Select Find Box (Shift+F) with the Project panel focused focuses its search, where keys type
      // and do not reach the Timeline; Open Search (Cmd+Shift+F) from the Timeline shows the
      // Project panel and focuses its search; Cmd+F opens Find.
      {
        await kit.getByTestId('film-project-breadcrumb').click()
        const from = await details()
        await page.keyboard.press('Shift+F')
        const focused = await until(async () => (await kitFrame().evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'film-project-search', 30)
        await page.keyboard.type('jl')
        await paintFrames()
        const to = await details()
        const typed = await kit.getByTestId('film-project-search').inputValue()
        await kit.getByTestId('film-project-search').fill('')
        await page.keyboard.press('Escape')
        // Window ▸ Timeline focuses the Timeline (upstream's show_panel).
        await fromMenu('window.panel.Timeline')
        const timelineFocused = await until(async () => (await kit.locator('[data-testid="film-workspace-frame-timeline"][data-focused="true"]').count()) === 1, 30)
        await kit.locator('.kui-app').focus()
        await page.keyboard.press('ControlOrMeta+Shift+F')
        const opened = await until(async () => (await kitFrame().evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'film-project-search', 30)
        await page.keyboard.press('Escape')
        await kit.locator('.kui-app').focus()
        await page.keyboard.press('ControlOrMeta+f')
        const findOpened = await until(async () => (await kit.getByTestId('film-dialog-find').count()) === 1, 30)
        await closeDialog()
        if (viewBefore === 'icon') await kit.getByTestId('film-project-view-icon').click()
        step('Shift+F (Select Find Box) focuses the Project panel\'s search and keys typed there do not move the playhead; Cmd+Shift+F (Open Search) focuses it from the Timeline; Cmd+F opens Find', focused && typed === 'jl' && to.playhead === from.playhead && timelineFocused && opened && findOpened, JSON.stringify({ focused, typed, playhead: [from.playhead, to.playhead], timelineFocused, opened, findOpened, ...(focused && opened ? {} : await keyState()) }))
      }
    }

    // ---- upstream's Scene Edit Detection, Flash Cue Marker, Update Metadata, Properties, and
    // Project Settings (Task 16), and the marker dialog a Markers row opens, each previewed
    // (upstream's have none): a stepped job with its progress whose ghost markers show on the
    // Source bar, a marker's colour on the Markers panel, the safe areas on the Program monitor,
    // and Update Metadata's summary. None of them removes or moves a Project item, so no step
    // here covers removed Project rows.
    {
      const fromMenu = async (command) => {
        const row = manifest.menus.find((each) => each.command === command)
        await kit.getByTestId(`film-menu-${row.path[0]}`).click()
        for (let depth = 2; depth <= row.path.length; depth += 1) await kit.locator(`[data-kit-ui-id="menu:${row.path.slice(0, depth).join('/')}"]`).hover()
        await kit.locator(`[data-testid="film-cmd-${command}"], [data-testid="film-control-${command}"]`).first().click()
      }
      const T = (await details()).ticksPerSecond ?? 254_016_000_000
      const history = async () => (await kitFrame().evaluate(() => window.filmPreview.history()))?.undo?.length ?? -1
      const documentJobs = async () => JSON.stringify((await person([{ command: 'job.list', params: {} }])).completed[0].result ?? null)
      const closeDialog = async () => {
        if (await dialogShown()) await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      }

      // Scene Edit Detection on a Universal Counting Leader (a cut each second at full
      // sensitivity), open in the Source monitor, and a 300 s matte after it (a job long enough to
      // watch): Generate Markers previews ghost markers on the Source bar once the stepped job
      // ends, with its progress in the strip on the way; the document's job.list stays empty,
      // and Cancel leaves the document as it was.
      const historyAtScene = await history()
      // The leader, the matte and the markers Analyze writes are the person's steps.
      const leader = (await person([{ command: 'item.newCountingLeader', params: {} }])).completed[0].result?.item ?? null
      const end = (await details()).sequence?.duration ?? 0
      await person([{ command: 'timeline.place', params: { item: leader, track: 'V1', time: end } }])
      const longMatte = (await person([{ command: 'item.newColorMatte', params: { color: '#203040', seconds: 300 } }])).completed[0].result?.item ?? null
      await person([{ command: 'timeline.place', params: { item: longMatte, track: 'V1', time: (await details()).sequence?.duration ?? 0 } }])
      const analysed = (await details()).sequence.video.flatMap((track) => track.items ?? []).filter((clip) => clip.item === leader || clip.item === longMatte).map((clip) => clip.clip)
      await person([{ command: 'timeline.select', params: { clips: analysed } }, { command: 'source.open', params: { item: leader } }, { command: 'playhead.set', params: { time: end } }])
      await kit.getByTestId('film-source').waitFor({ timeout: 10000 })
      const jobsBefore = await documentJobs()
      /** Records, each animation frame in the page, the preview's progress and whether the strip draws its bar. */
      const recordProgress = () =>
        kitFrame().evaluate(() => {
          const log = { progress: [], bar: false, live: true }
          window.filmT16Progress = log
          const tick = () => {
            if (!log.live) return
            const shown = window.filmPreview.state()
            if (shown.progress != null) log.progress.push(shown.progress)
            if (document.querySelector('[data-testid="film-preview-progress"]')) log.bar = true
            requestAnimationFrame(tick)
          }
          tick()
        })
      const progressSeen = () =>
        kitFrame().evaluate(() => {
          const log = window.filmT16Progress
          log.live = false
          delete window.filmT16Progress
          // The last job's run (a draft that lands late begins another job, from 0 again).
          const restart = log.progress.reduce((at, each, index) => (index > 0 && each < log.progress[index - 1] ? index : at), 0)
          const run = log.progress.slice(restart)
          return { samples: run.length, restarts: restart > 0, first: run.slice(0, 3), last: run.slice(-2), rising: run.length > 2 && run[0] < 0.5 && run[run.length - 1] > 0.5, bar: log.bar }
        })
      /** Waits for the open preview's job, whose progress the page records, to end (its progress null again). */
      const jobEnded = () =>
        until(
          () =>
            kitFrame().evaluate(() => {
              const shown = window.filmPreview.state()
              return shown.open && shown.progress == null && (window.filmT16Progress?.progress.length ?? 0) > 0
            }),
          300,
        )
      const chooseMarkers = async () => {
        await kit.getByTestId('film-dialog-sceneDetect-applyCuts').uncheck()
        await kit.getByTestId('film-dialog-sceneDetect-generateMarkers').check()
        const box = kit.locator('[data-testid="film-dialog-sceneDetect-sensitivity"] input')
        await box.fill('100')
        await box.press('Tab')
      }
      let scene = null
      const sceneCancel = await previewThenCancel({
        open: async () => {
          await fromMenu('clip.sceneEditDetection')
          await kit.getByTestId('film-dialog-sceneDetect').waitFor({ timeout: 10000 })
        },
        change: async () => {
          await chooseMarkers()
          await recordProgress()
        },
        expectPreview: async () => {
          // The serial holds while the job runs: wait for its end.
          const ended = await jobEnded()
          scene = { ended, ...(await progressSeen()) }
          const diff = await kitFrame().evaluate(() => window.filmPreview.diff())
          const added = (diff?.markers?.added ?? []).filter((entry) => entry.ownerKind === 'item' && entry.owner === leader)
          scene.added = added.length
          scene.drawn = await until(async () => (await kit.locator('[data-testid="film-monitor-source"] .film-monitor-marker[data-preview="added"]').count()) === added.length, 60)
          scene.jobs = (await documentJobs()) === jobsBefore
          return ended && scene.samples > 2 && scene.rising && scene.first[0] < 1 && scene.bar && added.length >= 3 && scene.drawn && scene.jobs
        },
      })
      step('Scene Edit Detection with Generate Markers (a counting leader and a long matte) previews as a stepped job, its progress rising in the strip, then the ghost markers on the Source bar; the document\'s job.list stays empty, and Cancel leaves the document as it was', sceneCancel.ok, JSON.stringify({ ...sceneCancel, scene }))

      // Cancel while the job runs ends it: no preview stays open on the engine, nothing reaches
      // the document, and no ghost is left.
      {
        const before = await documentNow()
        await fromMenu('clip.sceneEditDetection')
        await kit.getByTestId('film-dialog-sceneDetect').waitFor({ timeout: 10000 })
        await chooseMarkers()
        const running = await until(async () => {
          const shown = await previewState()
          return shown.open && shown.progress != null && shown.progress > 0.05
        }, 200)
        const at = (await previewState()).progress
        await kit.getByTestId('film-dialog-cancel').click()
        const closed = await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        await paintFrames()
        const ended = await kitFrame().evaluate(async () => (await window.filmPreview.query('project.items', {})) == null)
        const after = await documentNow()
        const unchanged = ['revision', 'history', 'replica', 'inspect'].filter((key) => before[key] !== after[key])
        const ghosts = await previewGhosts()
        step('Cancel while Scene Edit Detection\'s job runs ends it: no preview stays open on the engine, the document is unchanged, and no ghost is left', running && at > 0 && at < 1 && closed && ended && unchanged.length === 0 && ghosts === 0 && (await documentJobs()) === jobsBefore, JSON.stringify({ running, at, closed, ended, unchanged, ghosts }))
      }
      // Analyze (OK) on the leader and the long matte: the document's own job runs a step at a time
      // as upstream's thread does (the web has none), so OK closes at once with upstream's status,
      // the status bar shows the job, a playhead key answers while it runs, and the markers land
      // in one history step when it ends; Cancel through job.cancel changes nothing.
      const runningJob = async () => ((await person([{ command: 'job.list', params: {} }])).completed[0].result ?? []).find((each) => each.finished !== true) ?? null
      const startAnalyze = async () => {
        await person([{ command: 'timeline.select', params: { clips: analysed } }])
        await fromMenu('clip.sceneEditDetection')
        await kit.getByTestId('film-dialog-sceneDetect').waitFor({ timeout: 10000 })
        await chooseMarkers()
        await kit.getByTestId('film-dialog-ok').click()
        return until(async () => (await dialogShown()) === 0, 50)
      }
      {
        const steps = await history()
        const closed = await startAnalyze()
        // The status bar's message for the job, once it has replaced whatever was there.
        const message = () => kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => null)
        await until(async () => (await message()) === zh('Scene Edit Detection: analysing in the background (see Progress)'), 50)
        const said = await message()
        const shown = await until(async () => (await kit.getByTestId('film-exporting').count()) === 1, 50)
        const job = await runningJob()
        // A playhead key while it runs (the Timeline focused: the Source monitor, which opened the
        // leader, would step its own): answered by the engine between the job's steps.
        await fromMenu('window.panel.Timeline')
        await until(async () => (await kit.locator('[data-testid="film-workspace-frame-timeline"][data-focused="true"]').count()) === 1, 30)
        const from = (await details()).playhead
        await kit.locator('.kui-app').focus()
        const pressed = Date.now()
        await page.keyboard.press('ArrowRight')
        const moved = await waitForEngine(page, (state) => state.details?.playhead !== from, { timeout: 5000, orNull: true })
        const answeredMs = Date.now() - pressed
        const stillRunning = (await runningJob()) != null
        const landed = await until(async () => (await history()) === steps + 1 && (await kit.getByTestId('film-exporting').count()) === 0, 600)
        const onLeader = ((await person([{ command: 'source.inspect', params: {} }])).completed[0].result?.markers ?? []).length
        const last = (await personHistory()).at(-1)
        step('Scene Edit Detection\'s Analyze closes at once with upstream\'s "analysing in the background" status; the status bar shows the job, a playhead key answers while it runs, and its markers land on the leader in one "Scene Edit Detection" history step', closed && said === zh('Scene Edit Detection: analysing in the background (see Progress)') && shown && job != null && moved != null && stillRunning && landed && onLeader >= 3 && JSON.stringify(last ?? '').includes('Scene Edit Detection'), JSON.stringify({ closed, said, shown, job: job?.label, moved: moved != null, answeredMs, stillRunning, landed, onLeader, last, steps: [steps, await history()] }))
      }
      {
        const steps = await history()
        const revision = (await inspect()).revision
        await startAnalyze()
        const shown = await until(async () => (await kit.getByTestId('film-exporting').count()) === 1, 50)
        const job = await runningJob()
        if (job) await person([{ command: 'job.cancel', params: { job: job.id } }])
        const ended = await until(async () => (await kit.getByTestId('film-exporting').count()) === 0 && (await runningJob()) == null, 200)
        await paintFrames()
        const after = await waitForEngine(page, () => true, { history: true })
        step('job.cancel stops the document\'s running Scene Edit Detection: the status bar\'s job goes, and no history step or edit lands', shown && job != null && ended && (await history()) === steps && after.revision === revision, JSON.stringify({ shown, job: job?.id, ended, steps: [steps, await history()], revision: [revision, after.revision] }))
      }
      // The leader, the long matte, and the markers go again, for the steps after.
      await person([{ command: 'timeline.select', params: { clips: [] } }])
      await personUndo((await history()) - historyAtScene)

      // The marker dialog: a double-click on a Markers row opens it on that marker; a new colour
      // previews on the row; Cancel leaves the document; OK changes it in one step, undone by one.
      await person([{ command: 'playhead.set', params: { time: Math.round(1.5 * T) } }, { command: 'marker.add', params: { name: 'Edit me' } }])
      await fromMenu('window.panel.Markers')
      const markerNow = async () => ((await details()).sequence?.markers ?? []).find((each) => each.name === 'Edit me') ?? null
      const marker = await markerNow()
      const row = marker ? kit.getByTestId(`film-markers-row-${marker.id}`) : null
      if (row) await row.waitFor({ timeout: 10000 })
      const openMarker = async () => {
        await row.dblclick()
        await kit.getByTestId('film-dialog-marker').waitFor({ timeout: 10000 })
      }
      // The dialog lists the marker colours (the Markers filter's seven), so the Rose label is
      // its Red, as the engine names a marker's colour (`Label::marker_name`).
      const toRed = async () => kit.getByTestId('film-dialog-marker-color').selectOption('Red')
      let shownMarker = null
      const markerCancel = row
        ? await previewThenCancel({
            open: openMarker,
            change: toRed,
            idle: false,
            expectPreview: async () => {
              shownMarker = { name: await kit.getByTestId('film-dialog-marker-name').inputValue() }
              shownMarker.row = await until(async () => (await kit.locator(`[data-testid="film-markers-row-${marker.id}"][data-preview="changed"]`).count()) === 1, 60)
              return shownMarker.name === 'Edit me' && shownMarker.row
            },
          })
        : { ok: false }
      step('a double-click on a Markers row opens the marker dialog on it; a new colour previews on the row (changed), and Cancel leaves the document as it was', markerCancel.ok, JSON.stringify({ ...markerCancel, shownMarker, marker }))
      if (row) {
        const steps = await history()
        const markerOk = await previewThenOk({ open: openMarker, change: toRed })
        const red = (await markerNow())?.color
        await personUndo()
        const back = (await markerNow())?.color
        step('the marker dialog\'s OK makes the marker Red in one history step, as previewed, and one undo restores its colour', markerOk.ok && red === 'Red' && back === marker.color && (await history()) === steps, JSON.stringify({ ...markerOk, red, back, was: marker.color }))
      }

      // Flash Cue Marker: the named cue previews at the playhead in the Markers panel and on the
      // ruler, outlined; Cancel leaves the document.
      await person([{ command: 'playhead.set', params: { time: Math.round(3.25 * T) } }])
      const cueCancel = await previewThenCancel({
        open: async () => {
          await fromMenu('marker.addFlashCue')
          await kit.getByTestId('film-dialog-flashCue').waitFor({ timeout: 10000 })
        },
        change: async () => kit.getByTestId('film-dialog-flashCue-name').fill('Cue A'),
        expectPreview: async () => {
          const added = (await kit.locator('[data-testid^="film-markers-row-"][data-preview="added"]').allTextContents()).join(' | ')
          const ruler = await kit.locator('[data-testid="film-ruler"] [data-preview="added"], [data-testid^="film-ruler"] [data-preview="added"]').count()
          return added.includes('Cue A') && ruler >= 1
        },
      })
      step('Flash Cue Marker "Cue A" previews the cue at the playhead in the Markers panel and on the ruler, outlined; Cancel leaves the document as it was', cueCancel.ok, JSON.stringify(cueCancel))

      // Project Settings: Action Safe at 85% (a 15% margin) draws the new safe areas on the
      // Program monitor, marked, with Safe Margins off; its Ingest tab draws no destination;
      // Cancel leaves the document and the margins go.
      let safe = null
      const settingsCancel = await previewThenCancel({
        open: async () => {
          await fromMenu('file.projectSettings.general')
          await kit.getByTestId('film-dialog-projectSettings').waitFor({ timeout: 10000 })
        },
        change: async () => {
          const box = kit.locator('[data-testid="film-dialog-projectSettings-actionSafe-horizontal"] input')
          await box.fill('15')
          await box.press('Tab')
        },
        expectPreview: async () => {
          const margins = kit.locator('[data-testid="film-program-safe-margins"][data-preview="changed"]')
          safe = { drawn: await until(async () => (await margins.count()) === 1, 60) }
          safe.action = await margins.locator('.film-safe-action').evaluate((element) => element.style.width).catch(() => null)
          await kit.getByTestId('film-dialog-projectSettings-tab-ingest').click()
          await checkIds()
          safe.ingest = (await kit.getByTestId('film-dialog-projectSettings-ingest-enabled').count()) === 1 && (await kit.locator('[data-kit-ui-id="control:dialog.projectSettings.ingest.destination"]').count()) === 0
          await kit.getByTestId('film-dialog-projectSettings-tab-general').click()
          return safe.drawn && safe.action === '85%' && safe.ingest
        },
      })
      const marginsGone = (await kit.getByTestId('film-program-safe-margins').count()) === 0
      step('Project Settings with Action Safe at 85% draws the new safe areas on the Program monitor (marked, Safe Margins off); its Ingest tab has no destination; Cancel leaves the document as it was and the margins go', settingsCancel.ok && marginsGone, JSON.stringify({ ...settingsCancel, safe, marginsGone }))

      // Update Metadata: its question (upstream's confirmation) and the summary of the clips whose
      // XMP it writes; it never opens a preview on the engine, and Cancel writes nothing.
      {
        const bars = (function find(node) {
          return node?.name?.includes('bars') && node.item != null ? node.item : (node?.children ?? []).map(find).find((id) => id != null)
        })((await details()).project?.root)
        await person([{ command: 'timeline.select', params: { clips: [] } }, { command: 'project.select', params: { items: bars != null ? [bars] : [] } }])
        const before = await documentNow()
        const serial = (await previewState()).serial
        await fromMenu('clip.updateMetadata')
        await kit.getByTestId('film-dialog-updateMetadata').waitFor({ timeout: 10000 })
        await checkIds()
        const question = await kit.getByTestId('film-dialog-updateMetadata-question').textContent()
        const summary = await kit.getByTestId('film-preview-summary').textContent()
        const idle = await previewIdle(serial)
        await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0, 50)
        const after = await documentNow()
        const unchanged = ['revision', 'history', 'replica', 'inspect'].filter((key) => before[key] !== after[key])
        step('Update Metadata asks upstream\'s question with its count and its summary names the clip whose XMP it writes; no preview opens on the engine, and Cancel changes nothing', question === filled(zh('Write the metadata of the selected clip(s) ({n}) to XMP files next to their media?'), { n: 1 }) && /bars/.test(summary ?? '') && idle && unchanged.length === 0, JSON.stringify({ question, summary, idle, unchanged }))

        // Properties of the selection, then of a file the host picks (File…): upstream's lines, one Close.
        await fromMenu('file.mediaProperties')
        await kit.getByTestId('film-dialog-properties').waitFor({ timeout: 10000 })
        await checkIds()
        const selection = await kit.getByTestId('film-dialog-properties-list').textContent()
        // The one button is upstream's Close (properties.ok): it carries control:dialog.ok.
        const close = kit.getByTestId('film-dialog-cancel')
        const closeId = await close.getAttribute('data-kit-ui-id')
        await close.click()
        const closedSelection = (await until(async () => (await dialogShown()) === 0, 50)) && closeId === 'control:dialog.ok'

        await fromMenu('file.mediaPropertiesFile')
        const picked = await kit.getByTestId('film-dialog-properties').waitFor({ timeout: 10000 }).then(() => true, () => false)
        const file = picked ? await kit.getByTestId('film-dialog-properties-list').textContent() : null
        await closeDialog()
        step('Properties shows the selected file\'s path, type, duration, video and audio lines with one Close; File… shows those of the file the host picks', new RegExp(`${escapeRegExp(zh('File Path'))}: .*bars\\.mp4`).test(selection ?? '') && (selection ?? '').includes(`${zh('Video')}: `) && closedSelection && picked && /bars\.mp4/.test(file ?? ''), JSON.stringify({ selection: selection?.slice(0, 240), file: file?.slice(0, 120), closedSelection, picked }))
      }
    }

    // ---- upstream's Make Offline and Link Media (Task 17), each previewed (upstream's have none):
    // Make Offline's offline badge on the Project row and the slate at the playhead, in the preview
    // only; then Link Media ▸ Locate…, the dev host's picker answering the same file: the row online
    // in the dialog and in the Project panel. The preview never touches the document's media: its
    // status, its thumbnail, and its pool stay until OK. Neither removes nor moves a Project row,
    // so no step here covers removed Project rows (Task 10's open item stays open).
    {
      const fromMenu = async (command) => {
        const row = manifest.menus.find((each) => each.command === command)
        await kit.getByTestId(`film-menu-${row.path[0]}`).click()
        for (let depth = 2; depth <= row.path.length; depth += 1) await kit.locator(`[data-kit-ui-id="menu:${row.path.slice(0, depth).join('/')}"]`).hover()
        await kit.locator(`[data-testid="film-cmd-${command}"], [data-testid="film-control-${command}"]`).first().click()
      }
      const closeDialogNow = async () => {
        if (await dialogShown()) await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      }
      const T = (await details()).ticksPerSecond ?? 254_016_000_000
      const bars = (function find(node) {
        return node?.name === 'bars.mp4' && node.item != null ? node.item : (node?.children ?? []).map(find).find((id) => id != null)
      })((await details()).project?.root)
      /** The document's own view of bars: its media status, and its row's offline badge in the Project panel. */
      const statusNow = async () => (await person([{ command: 'media.status', params: { item: bars } }])).completed[0].result?.[0]?.status ?? null
      const row = kit.getByTestId(`film-project-item-${bars}`)
      const badge = row.locator('[data-kit-ui-id="control:project.item.offline"]')
      /** The document's thumbnail of bars as the Project panel draws it (its canvas's pixels), or null when none is drawn. */
      // Read only a fresh frame (`data-drawn="1"`), never the placeholder shown while it loads.
      const thumbNow = () =>
        row
          .locator('canvas')
          .first()
          .evaluate((canvas) => (canvas.width && canvas.dataset.drawn === '1' ? canvas.toDataURL() : null), undefined, { timeout: 1000 })
          .catch(() => null)
      // The Project panel in front (Task 16 left the Markers panel there), at the project's root.
      await fromMenu('window.panel.Project')
      await kit.getByTestId('film-project').waitFor({ timeout: 10000 })
      for (let up = 0; up < 5 && (await kit.getByTestId('film-project-up').isEnabled()); up += 1) await kit.getByTestId('film-project-up').click()
      if (await kit.getByTestId('film-project-search').inputValue()) await kit.getByTestId('film-project-search').fill('')
      // bars on V1 at the playhead, selected in the Project panel, its row in view.
      const barsClip = (await details()).sequence.video.flatMap((track) => track.items ?? []).find((clip) => clip.item === bars)
      await person([
        { command: 'timeline.select', params: { clips: [] } },
        { command: 'project.select', params: { items: [bars] } },
        { command: 'playhead.set', params: { time: (barsClip?.start ?? 0) + Math.round(T / 2) } },
      ])
      const rowShown = await row.waitFor({ timeout: 10000 }).then(() => true, () => false)
      if (rowShown) await row.scrollIntoViewIfNeeded()
      await until(async () => (await thumbNow()) != null, 60)
      const thumbBefore = await thumbNow()
      // The Preview Area on: it draws bars's picture too, from the same cache as its row, so a
      // preview never files the document's frame under the copy's media there either.
      // From the panel's menu (an ai call sets the view without the panel reading it again).
      const previewAreaToggle = async () => {
        await kit.getByTestId('film-workspace-menu-project').click()
        await kit.getByTestId('film-project-menu-previewArea').click()
      }
      await previewAreaToggle()
      const area = kit.locator('[data-testid="film-project-preview-thumb"] canvas')
      // Read only a fresh frame (`data-drawn="1"`), never the previous one shown while it loads.
      const areaNow = () => area.evaluate((canvas) => (canvas.width && canvas.dataset.drawn === '1' ? canvas.toDataURL() : null), undefined, { timeout: 1000 }).catch(() => null)
      await until(async () => (await areaNow()) != null, 60)
      await paintFrames()
      const areaBefore = await areaNow()

      // Make Offline: upstream's question for the Project selection (its own confirmation), the
      // offline badge on the row and the slate at the playhead in the preview only.
      let offline = null
      const offlineCancel = await previewThenCancel({
        open: () => fromMenu('media.makeOffline'),
        change: null,
        expectPreview: async () => {
          offline = {
            question: await kit.getByTestId('film-dialog-makeOffline-question').textContent(),
            keep: (await kit.getByTestId('film-dialog-makeOffline-keep').isChecked()) && (await kit.locator('[data-kit-ui-id="control:dialog.makeOffline.delete"]').count()) === 0,
            badge: await until(async () => (await badge.count()) === 1 && (await row.getAttribute('data-preview')) === 'changed', 60),
            program: await until(async () => (await kit.getByTestId('film-program-preview').getAttribute('data-shown')) === 'true', 60),
            document: await statusNow(),
            // The row draws the preview's picture (its slate, `previewItemFrame`); the document's own thumbnail is checked after Cancel.
            picture: await until(async () => (await thumbNow()) !== thumbBefore, 60),
          }
          return (offline.question ?? '').startsWith(filled(zh('Make {n} selected clip(s) offline. Their clips show the offline slate until you link them again.'), { n: 1 })) && offline.keep && offline.badge && offline.program && offline.document === 'online' && offline.picture
        },
      })
      // The row draws the document's own thumbnail again after Cancel (null until drawn).
      const afterCancel = { status: await statusNow(), badge: await badge.count(), thumb: await until(async () => (await thumbNow()) === thumbBefore, 60) }
      step('Make Offline asks upstream\'s question with Media files remain on disk, and previews the offline badge on the Project row and the slate at the playhead; the document\'s media status and thumbnail stay, and Cancel leaves the document as it was', rowShown && offlineCancel.ok && afterCancel.status === 'online' && afterCancel.badge === 0 && afterCancel.thumb, JSON.stringify({ rowShown, ...offlineCancel, offline, afterCancel }))
      const offlineOk = await previewThenOk({
        open: () => fromMenu('media.makeOffline'),
        change: null,
        expectPreview: async () => (await badge.count()) === 1,
      }).catch((error) => ({ ok: false, error: error.message.split('\n')[0] }))
      const madeOffline = { status: await statusNow(), badge: await until(async () => (await badge.count()) === 1 && (await row.getAttribute('data-preview')) == null, 60) }
      // The document's thumbnail follows its media (its stamp), as upstream's item_revision: drawn again.
      madeOffline.thumb = await until(async () => ![null, thumbBefore].includes(await thumbNow()), 60)
      madeOffline.area = areaBefore != null && (await until(async () => ![null, areaBefore].includes(await areaNow()), 60))
      const areaOffline = await areaNow()
      step('Make Offline\'s OK makes bars offline in one step, as previewed: the badge on its row, its thumbnail and the Preview Area\'s drawn again', offlineOk.ok && madeOffline.status === 'offline' && madeOffline.badge && madeOffline.thumb && madeOffline.area, JSON.stringify({ ...offlineOk, madeOffline }))

      // Link Media ▸ Locate…: the dev host's picker answers bars.mp4, the same file; the preview
      // relinks it on the scratch session: the dialog's row and the Project row show it online.
      // The document has other files offline (an earlier task's offline file): set Offline, they
      // leave the list, so Link leaves no row and the dialog closes, as upstream's.
      const thumbOffline = await thumbNow()
      let link = null
      const barsRow = kit.locator('[data-testid^="film-dialog-linkMedia-row-"]', { hasText: 'bars.mp4' })
      const otherRows = kit.locator('[data-testid^="film-dialog-linkMedia-row-"]:not(:has-text("bars.mp4"))')
      let skipped = null
      const linkOpen = async () => {
        await fromMenu('media.linkMedia')
        await kit.getByTestId('film-dialog-linkMedia').waitFor({ timeout: 10000 })
        const others = await otherRows.count()
        for (let each = 0; each < others; each += 1) {
          await otherRows.first().click()
          await kit.getByTestId('film-dialog-linkMedia-offline').click()
        }
        skipped = { others, left: await kit.locator('[data-testid^="film-dialog-linkMedia-row-"]').count() }
        await barsRow.click()
      }
      const linkCancel = await previewThenCancel({
        open: linkOpen,
        idle: true,
        change: () => kit.getByTestId('film-dialog-linkMedia-locate').click(),
        expectPreview: async () => {
          const status = kit.getByTestId(`film-dialog-linkMedia-status-${bars}`)
          link = {
            ...skipped,
            located: await kit.getByTestId('film-dialog-linkMedia-located').textContent(),
            online: await until(async () => (await status.getAttribute('data-preview')) === 'online', 60),
            icon: await until(async () => (await kit.getByTestId(`film-dialog-linkMedia-icon-${bars}`).getAttribute('data-drawn')) != null, 60),
            row: await until(async () => (await badge.count()) === 0 && (await row.getAttribute('data-preview')) === 'changed', 60),
            document: await statusNow(),
            picture: await until(async () => (await thumbNow()) !== thumbOffline, 60),
            link: await kit.getByTestId('film-dialog-ok').isEnabled(),
          }
          return link.left === 1 && /bars\.mp4/.test(link.located ?? '') && link.online && link.icon && link.row && link.document === 'offline' && link.picture && link.link
        },
      })
      const linkAfterCancel = { status: await statusNow(), badge: await badge.count(), thumb: await until(async () => (await thumbNow()) === thumbOffline, 60) }
      step('Link Media lists bars offline (its other rows set Offline leave the list); Locate… (the host\'s picker answering bars.mp4) previews it relinked: online with its picture in the dialog, its Project row online; the document\'s status and thumbnail stay offline, and Cancel leaves the document as it was', linkCancel.ok && linkAfterCancel.status === 'offline' && linkAfterCancel.badge === 1 && linkAfterCancel.thumb, JSON.stringify({ ...linkCancel, link, linkAfterCancel }))
      const linkOk = await previewThenOk({
        open: linkOpen,
        idle: true,
        change: () => kit.getByTestId('film-dialog-linkMedia-locate').click(),
        expectPreview: async () => (await kit.getByTestId(`film-dialog-linkMedia-status-${bars}`).getAttribute('data-preview')) === 'online',
      }).catch((error) => ({ ok: false, error: error.message.split('\n')[0] }))
      const linked = { status: await statusNow(), badge: await until(async () => (await badge.count()) === 0, 60), thumb: await until(async () => (await thumbNow()) === thumbBefore, 60), said: await kit.getByTestId('film-message').textContent({ timeout: 500 }).catch(() => null) }
      linked.area = await until(async () => (await areaNow()) === areaBefore, 60)
      linked.areaChanged = areaOffline !== areaBefore
      await previewAreaToggle()
      await until(async () => (await kit.getByTestId('film-project-preview').count()) === 0, 50)
      step('Link links bars in one step, as previewed, and the dialog closes with no row left: bars is back online, its badge gone, its thumbnail and the Preview Area\'s the picture again, and the status bar says it linked one clip', linkOk.ok && linked.status === 'online' && linked.badge && linked.thumb && linked.area && linked.areaChanged && linked.said === filled(zh('Linked {n} clip(s)'), { n: 1 }), JSON.stringify({ ...linkOk, linked }))

      // Link Media again lists only the files still offline (bars is linked); with none, it opens
      // no dialog and says "All media is online.", as upstream's route.
      await fromMenu('media.linkMedia')
      const again = await until(async () => (await dialogShown()) === 1 || ((await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => '')) ?? '').includes(zh('All media is online.')), 50)
      const listed = (await dialogShown()) ? await kit.locator('[data-testid^="film-dialog-linkMedia-row-"]').allTextContents() : []
      const allOnline = (await dialogShown()) === 0
      await closeDialogNow()
      step('Link Media again lists only the files still offline, without bars (with none, it opens no dialog and says "All media is online.")', again && !listed.includes('bars.mp4') && (allOnline || listed.length === (skipped?.others ?? -1)), JSON.stringify({ listed, allOnline, skipped }))

      // Link while rows remain (bars and the other offline file): the dialog stays open on the
      // rest, the located file and the preview reset, and Link is greyed. Locate… for the other
      // row then answers bars.mp4, which does not match it: the engine's reason shows in the strip
      // (upstream's message under the rows). With the match options off, the next preview relinks
      // it; Cancel leaves the document as Link left it.
      if (skipped?.others) {
        const historyNow = async () => ((await waitForEngine(page, () => true, { history: true })).history?.undo ?? []).length
        await person([{ command: 'media.makeOffline', params: { items: [bars] } }])
        await until(async () => (await statusNow()) === 'offline', 50)
        await fromMenu('media.linkMedia')
        await kit.getByTestId('film-dialog-linkMedia').waitFor({ timeout: 10000 })
        const rowsAtOpen = await kit.locator('[data-testid^="film-dialog-linkMedia-row-"]').count()
        await barsRow.click()
        await kit.getByTestId('film-dialog-linkMedia-locate').click()
        const previewed = await until(async () => (await kit.getByTestId(`film-dialog-linkMedia-status-${bars}`).getAttribute('data-preview')) === 'online', 60)
        const historyAtLink = await historyNow()
        await kit.getByTestId('film-dialog-ok').click()
        const rowsLeft = kit.locator('[data-testid^="film-dialog-linkMedia-row-"]')
        const stayed = await until(
          async () =>
            (await dialogShown()) === 1 &&
            (await rowsLeft.count()) === rowsAtOpen - 1 &&
            ((await kit.getByTestId('film-dialog-linkMedia-located').textContent()) ?? '').includes(zh('No candidates yet — Search a folder or Locate the file.')) &&
            !(await previewState()).open &&
            !(await kit.getByTestId('film-dialog-ok').isEnabled()),
          60,
        )
        const linkedOnce = (await historyNow()) === historyAtLink + 1 && (await statusNow()) === 'online'
        step('Link with rows left keeps the dialog open on them: one history step, the located file and the preview reset, Link greyed', previewed && stayed && linkedOnce, JSON.stringify({ rowsAtOpen, previewed, stayed, linkedOnce, rows: await rowsLeft.allTextContents() }))

        const before = await documentNow()
        await rowsLeft.first().click()
        await kit.getByTestId('film-dialog-linkMedia-locate').click()
        const strip = kit.getByTestId('film-preview-result')
        const reasonShown = await until(async () => /doesn't match/.test((await strip.textContent({ timeout: 300 }).catch(() => '')) ?? ''), 60)
        const reason = reasonShown ? await strip.textContent() : null
        const refusedOpen = (await previewState()).open
        for (const key of ['fileName', 'extension', 'clipId', 'duration', 'mediaStart', 'metadata']) await kit.getByTestId(`film-dialog-linkMedia-match-${key}`).uncheck()
        const other = await rowsLeft.first().getAttribute('data-testid')
        const againPreviewed = await until(async () => (await previewState()).open && (await kit.locator('[data-testid^="film-dialog-linkMedia-status-"][data-preview="online"]').count()) === 1, 60)
        const reasonGone = (await strip.count()) === 0 || !/doesn't match/.test((await strip.textContent({ timeout: 300 }).catch(() => '')) ?? '')
        await kit.getByTestId('film-dialog-cancel').click()
        const closed = await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        await paintFrames()
        const after = await documentNow()
        const unchanged = ['revision', 'history', 'replica', 'inspect'].filter((key) => before[key] !== after[key])
        step("Locate… with a file that does not match the row shows the engine's reason in the strip and opens no preview; with the match options off the next preview relinks it, and Cancel (upstream's Offline All) leaves the document as it was", reasonShown && !refusedOpen && againPreviewed && reasonGone && closed && unchanged.length === 0, JSON.stringify({ reason, refusedOpen, other, againPreviewed, reasonGone, closed, unchanged }))
      }

      // The Project item menu's Attach Proxies… acts on its own item, though another is selected
      // when it is chosen (the menu's selection lands after its call); Reconnect… without a proxy
      // says why before any picker opens.
      {
        const sequenceItem = (function find(node) {
          return node?.type === 'Sequence' && node.item != null ? node.item : (node?.children ?? []).map(find).find((id) => id != null)
        })((await details()).project?.root)
        const proxyNow = async () => (await person([{ command: 'media.status', params: { item: bars } }])).completed[0].result?.[0]?.proxy?.path ?? null
        const fromItemMenu = async (testId) => {
          await person([{ command: 'project.select', params: { items: sequenceItem != null ? [sequenceItem] : [] } }])
          await row.click({ button: 'right' })
          await kit.getByTestId('film-project-item-menu').waitFor({ timeout: 10000 })
          await kit.getByTestId('film-project-item-proxy').hover()
          await kit.getByTestId(testId).click()
        }
        await fromItemMenu('film-project-item-attach-proxies')
        const attached = await until(async () => (await proxyNow()) === '../clips/bars.mp4', 60)
        await person([{ command: 'media.detachProxies', params: { items: [bars] } }])
        await until(async () => (await proxyNow()) == null, 50)
        await fromItemMenu('film-project-item-reconnect')
        const refused = await until(async () => ((await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => '')) ?? '').includes(zh('the clip has no proxy attached')), 50)
        step("the Project item menu's Attach Proxies… attaches the host's file to its own item, not the selection the call found; Reconnect Full Resolution Media… without a proxy says so before the picker", sequenceItem != null && attached && refused, JSON.stringify({ sequenceItem, attached, refused }))
      }
    }

    // ---- upstream's Project panel dialogs (Task 18), each previewed (upstream's have none):
    // Metadata Display (from a List view column header's right-click) hiding Media Duration, the
    // List view dropping it in the preview only; Save As New View Preset "Mine" (a summary, no
    // preview); Manage ▸ Restore "Mine" from the Icon view, the List view in the preview only, then
    // Restore and Done. These change the panel's preferences, not the project: no revision, no
    // history step, and the panel reads its view again after each (also after an agent's call).
    // None removes or moves a Project row (a preset is not a row), so Task 10's open item stays open.
    {
      const panelMenu = async (testId) => {
        await kit.getByTestId('film-workspace-menu-project').click()
        await kit.getByTestId(testId).click()
      }
      const viewNow = async () => (await person([{ command: 'project.view.get', params: {} }])).completed[0].result
      const presetsNow = async () => (await person([{ command: 'project.viewPreset.list', params: {} }])).completed[0].result?.presets ?? []
      const header = (name) => kit.getByTestId(`film-project-column-${name}`)
      const panelView = () => kit.getByTestId('film-project').getAttribute('data-view')
      await panelMenu('film-project-menu-view-list')
      await until(async () => (await panelView()) === 'list' && (await header('Media Duration').count()) === 1, 60)
      const columnsBefore = (await viewNow())?.view?.columns?.map((column) => column.name) ?? []

      // Metadata Display from the Name column's header (project_views.rs: a right-click opens it).
      const openMetadata = async () => {
        await header('Name').click({ button: 'right' })
        await kit.getByTestId('film-project-header-metadataDisplay').click()
      }
      let metadata = null
      const metadataCancel = await previewThenCancel({
        open: openMetadata,
        change: () => kit.getByTestId('film-dialog-metadata-field-Media Duration').uncheck(),
        expectPreview: async () => {
          metadata = {
            dropped: await until(async () => (await header('Media Duration').count()) === 0 && (await header('Media End').count()) === 1, 60),
            badge: (await kit.getByTestId('film-project-preview-badge').count()) === 1,
            order: (await kit.getByTestId('film-dialog-metadata-order').locator('.film-columns-name').allTextContents()).length,
            name: await kit.getByTestId('film-dialog-metadata-field-Name').isDisabled(),
            document: (await viewNow())?.view?.columns?.some((column) => column.name === 'Media Duration'),
            // The List view on screen draws the columns: the strip lists none.
            stripLines: await kit.getByTestId('film-preview-view').count(),
          }
          return metadata.dropped && metadata.badge && metadata.order === columnsBefore.length - 1 && metadata.name && metadata.document === true && metadata.stripLines === 0
        },
      })
      const metadataBack = await until(async () => (await header('Media Duration').count()) === 1, 50)
      step('Metadata Display, from a List view column header\'s right-click, previews the List view without Media Duration (Name greyed first); the document keeps the column, and Cancel leaves it as it was', metadataCancel.ok && metadataBack, JSON.stringify({ ...metadataCancel, metadata, metadataBack }))
      const metadataOk = await previewThenOk({
        open: () => panelMenu('film-project-menu-metadataDisplay'),
        change: () => kit.getByTestId('film-dialog-metadata-field-Media Duration').uncheck(),
        expectPreview: async () => until(async () => (await header('Media Duration').count()) === 0, 60),
        steps: 0,
        landed: async () => !(await viewNow())?.view?.columns?.some((column) => column.name === 'Media Duration'),
      }).catch((error) => ({ ok: false, error: error.message.split('\n')[0] }))
      // The panel reads its view again after OK, which makes no revision.
      const metadataShown = await until(async () => (await header('Media Duration').count()) === 0 && (await header('Media End').count()) === 1, 60)
      step('Metadata Display\'s OK hides Media Duration as previewed (no history step: a preference), and the List view drops it at once', metadataOk.ok && metadataShown, JSON.stringify({ ...metadataOk, metadataShown }))
      // An agent's project.columns.set brings it back, and the panel draws it without a new revision.
      await agentRun([{ command: 'project.columns.set', params: { columns: columnsBefore } }])
      const agentShown = await until(async () => (await header('Media Duration').count()) === 1, 60)
      step("an agent's project.columns.set redraws the List view at once (no revision)", agentShown, JSON.stringify({ agentShown, columnsBefore }))

      // In the Icon view no column is drawn: the strip lists the columns Metadata Display shows.
      await panelMenu('film-project-menu-view-icon')
      await until(async () => (await panelView()) === 'icon', 60)
      let iconStrip = null
      const metadataIcon = await previewThenCancel({
        open: () => panelMenu('film-project-menu-metadataDisplay'),
        change: () => kit.getByTestId('film-dialog-metadata-field-Media Duration').uncheck(),
        expectPreview: async () => {
          const strip = kit.getByTestId('film-preview-view')
          const shown = await until(async () => ((text) => text.startsWith(zt('preview.columns', { count: 11, columns: [zh('Name'), zh('Frame Rate')].join(', ') })))((await strip.textContent({ timeout: 300 }).catch(() => '')) ?? ''), 60)
          iconStrip = await strip.textContent({ timeout: 300 }).catch(() => null)
          return shown && !(iconStrip ?? '').includes(zh('Media Duration')) && !((text) => text.includes(zt('preview.nothing')))((await kit.getByTestId('film-preview-strip').textContent({ timeout: 300 }).catch(() => '')) ?? '')
        },
      })
      step('Metadata Display over the Icon view (which draws no columns) lists the columns it shows in the strip, and Cancel leaves the document as it was', metadataIcon.ok, JSON.stringify({ ...metadataIcon, iconStrip }))
      await panelMenu('film-project-menu-view-list')
      await until(async () => (await panelView()) === 'list', 60)

      // Save As New View Preset "Mine": a summary of what OK saves, no preview; Enter runs OK once.
      const slotsBefore = await presetsNow()
      const mineSlot = slotsBefore.find((each) => each.name == null)?.slot ?? null
      const serialBefore = (await previewState()).serial
      await panelMenu('film-project-menu-saveViewPresetAs')
      await kit.getByTestId('film-dialog').waitFor({ timeout: 10000 })
      await checkIds()
      const nameField = kit.getByTestId('film-dialog-projectDialog-name')
      const defaultName = await nameField.inputValue()
      await nameField.fill('Mine')
      const summary = await until(async () => pattern(ztRaw('viewPreset.saves'), { slot: '\\d+', name: 'Mine' }).test((await kit.getByTestId('film-preview-summary').textContent({ timeout: 300 }).catch(() => '')) ?? ''), 50)
      const summaryText = await kit.getByTestId('film-preview-summary').textContent({ timeout: 300 }).catch(() => null)
      const noPreview = await previewIdle(serialBefore)
      await nameField.press('Enter')
      const saved = await until(async () => (await dialogShown()) === 0 && (await presetsNow()).filter((each) => each.name === 'Mine').length === 1, 60)
      const savedOnce = (await presetsNow()).filter((each) => each.name != null).length === slotsBefore.filter((each) => each.name != null).length + 1
      step('Save As New View Preset names the first empty slot, sums up what it saves (no preview: a preference), and Enter saves "Mine" once', mineSlot != null && defaultName === filled(zh('Project View Preset {n}'), { n: mineSlot }) && summary && noPreview && saved && savedOnce, JSON.stringify({ mineSlot, defaultName, summaryText, noPreview, saved, savedOnce }))

      // The Icon view, then Manage ▸ Restore "Mine": the List view in the preview only.
      await panelMenu('film-project-menu-view-icon')
      await until(async () => (await panelView()) === 'icon', 60)
      const openManage = async () => {
        await panelMenu('film-project-menu-manageViewPresets')
        await kit.getByTestId('film-dialog-presets').waitFor({ timeout: 10000 })
        await kit.getByTestId(`film-dialog-presets-slot-${mineSlot}`).click()
      }
      let manage = null
      const manageCancel = await previewThenCancel({
        open: openManage,
        idle: true,
        change: () => kit.getByTestId('film-dialog-presets-restore').click(),
        expectPreview: async () => {
          manage = {
            list: await until(async () => (await panelView()) === 'list' && (await kit.getByTestId('film-project-list').count()) === 1, 60),
            pending: await kit.getByTestId('film-dialog-presets-pending').textContent({ timeout: 300 }).catch(() => null),
            name: await kit.getByTestId('film-dialog-presets-name').inputValue(),
            document: (await viewNow())?.view?.mode,
            strip: await kit.getByTestId('film-preview-view').textContent({ timeout: 1000 }).catch(() => null),
          }
          return manage.list && manage.pending === zt('viewPreset.pending', { count: 1 }) && manage.name === 'Mine' && manage.document === 'icon' && (manage.strip ?? '').includes(zt('viewPreset.restores', { slot: mineSlot, name: 'Mine', view: zh('List') }))
        },
      })
      const iconBack = await until(async () => (await panelView()) === 'icon', 50)
      step('Manage ▸ Restore "Mine" previews the List view from the Icon view; the document stays in the Icon view, and Cancel drops the step', manageCancel.ok && iconBack, JSON.stringify({ ...manageCancel, manage, iconBack }))
      const manageOk = await previewThenOk({
        open: openManage,
        idle: true,
        change: () => kit.getByTestId('film-dialog-presets-restore').click(),
        expectPreview: async () => until(async () => (await panelView()) === 'list', 60),
        steps: 0,
        landed: async () => (await viewNow())?.view?.mode === 'list',
      }).catch((error) => ({ ok: false, error: error.message.split('\n')[0] }))
      // Done restored it for real: the panel shows the List view at once, with no revision.
      const restored = await until(async () => (await panelView()) === 'list' && (await kit.getByTestId('film-project-list').count()) === 1, 60)
      const current = (await viewNow())?.currentPreset
      step('Manage ▸ Restore and Done restore "Mine": the document and the panel show the List view (no history step: a preference)', manageOk.ok && restored && current === mineSlot, JSON.stringify({ ...manageOk, restored, current }))

      // While Metadata Display previews, the panel's view commands are refused (the strip and OK keep the view shown).
      {
        const serial = (await previewState()).serial
        await panelMenu('film-project-menu-metadataDisplay')
        await kit.getByTestId('film-dialog-metadata').waitFor({ timeout: 10000 })
        await previewOpened(serial)
        await kit.getByTestId('film-project-view-icon').click()
        const said = await until(async () => ((await kit.getByTestId('film-message').textContent({ timeout: 300 }).catch(() => '')) ?? '').includes(zt('previewBusy')), 50)
        await paintFrames()
        const kept = { panel: await panelView(), document: (await viewNow())?.view?.mode }
        await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
        step("while Metadata Display previews, the panel's Icon view button is refused with the gate's message: the panel and the document stay in the List view", said && kept.panel === 'list' && kept.document === 'list', JSON.stringify({ said, kept }))
      }

      // Another changes a preset while Manage is open: the list follows, and the queued Overwrite of that slot goes.
      {
        await openManage()
        await kit.getByTestId('film-dialog-presets-overwrite').click()
        const queued = await until(async () => pattern(ztRaw('viewPreset.overwrites'), { slot: '\\d+', name: '.*', view: '.*' }).test((await kit.getByTestId('film-preview-view').textContent({ timeout: 300 }).catch(() => '')) ?? ''), 60)
        // Another: the agent (the person's own commands wait while their dialog is open).
        await agentRun([{ command: 'project.viewPreset.rename', params: { slot: mineSlot, name: 'Theirs' } }])
        const slot = kit.getByTestId(`film-dialog-presets-slot-${mineSlot}`)
        const followed = await until(async () => /Theirs/.test((await slot.textContent()) ?? '') && (await kit.getByTestId('film-dialog-presets-pending').count()) === 0, 60)
        const notice = await kit.getByTestId('film-dialog-notice').textContent({ timeout: 1000 }).catch(() => null)
        const previewGone = await until(async () => !(await previewState()).open, 50)
        await kit.getByTestId('film-dialog-cancel').click()
        await until(async () => (await dialogShown()) === 0, 50)
        const kept = (await presetsNow()).find((each) => each.slot === mineSlot)?.name
        step("Manage follows a preset another renames: the list shows it, the queued Overwrite of that slot is dropped and the dialog says so, and their name stays", queued && followed && (notice ?? '') === zt('viewPreset.dropped', { count: 1 }) && previewGone && kept === 'Theirs', JSON.stringify({ queued, followed, notice, previewGone, kept }))
      }

      // Thumbnail controls for all pointing devices: a touch drag across a card scrubs it only with it on.
      await panelMenu('film-project-menu-view-icon')
      await until(async () => (await panelView()) === 'icon', 60)
      const card = kit.locator('[data-testid^="film-project-thumb-"]').first()
      const cardItem = Number((await card.getAttribute('data-testid'))?.replace('film-project-thumb-', ''))
      const touch = () =>
        card.evaluate((element) => {
          const art = element.closest('.film-project-card-art') ?? element
          const rect = art.getBoundingClientRect()
          for (const fraction of [0.3, 0.6]) art.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', isPrimary: true, bubbles: true, clientX: rect.left + rect.width * fraction, clientY: rect.top + rect.height / 2 }))
        })
      const scrubMark = kit.getByTestId(`film-project-scrub-${cardItem}`)
      const leave = () => card.evaluate((element) => (element.closest('.film-project-card-art') ?? element).dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'touch', bubbles: false })))
      await touch()
      await paintFrames()
      const offScrubs = await scrubMark.count()
      await leave()
      await panelMenu('film-project-menu-thumbnailControlsAllDevices')
      const turnedOn = await until(async () => (await viewNow())?.thumbnailControlsAllDevices === true, 50)
      // The card reads the setting once the panel has read its view again.
      const onScrubs = await until(async () => {
        await touch()
        await paintFrames()
        return (await scrubMark.count()) === 1
      }, 50)
      // A sideways drag scrubs; one up or down still scrolls the grid.
      const touchAction = await card.evaluate((element) => getComputedStyle(element.closest('.film-project-card-art') ?? element).touchAction)
      await leave()
      await panelMenu('film-project-menu-thumbnailControlsAllDevices')
      await until(async () => (await viewNow())?.thumbnailControlsAllDevices === false, 50)
      step('Thumbnail controls for all pointing devices: a touch drag across an Icon view card scrubs it only with it on, and the grid still scrolls up and down by touch (touch-action pan-y)', Number.isFinite(cardItem) && offScrubs === 0 && turnedOn && onScrubs && touchAction === 'pan-y', JSON.stringify({ cardItem, offScrubs, turnedOn, onScrubs, touchAction }))
    }

    // ---- upstream's Freeform view (Task 19): the bin's cards where the engine's layout puts them,
    // a card dragged (one move, kept in the saved document: a fresh page opening it draws it
    // there), two cards stacked from the card menu (the ×2 badge), Align to Grid, Freeform View
    // Options previewing a larger clip size (in the preview only), Save Arrangement "A", a move,
    // and Restore "A"; a card dragged out of the panel onto the Timeline is the item's own drag.
    // No step here removes or moves a Project row (Unstack, Delete Arrangement, and the options
    // change only cards), so Task 10's removed-row flow step carries forward.
    {
      const person = personRun
      const sessionNow = async () => (await person([{ command: 'state.inspect', params: {} }])).completed[0].result
      const history = async () => (await kitFrame().evaluate(() => window.filmPreview.history()))?.undo?.length ?? -1
      const panelMenu = async (testId) => {
        await kit.getByTestId('film-workspace-menu-project').click()
        await kit.getByTestId(testId).click()
      }
      const viewNow = async () => (await person([{ command: 'project.view.get', params: {} }])).completed[0].result
      const panelView = () => kit.getByTestId('film-project').getAttribute('data-view')
      const canvas = kit.getByTestId('film-project-freeform-canvas')
      /** The width the panel lays its cards out for (the Freeform view's own). */
      const widthNow = () => kit.getByTestId('film-project-freeform').evaluate((element) => Math.round(element.offsetWidth))
      const layoutNow = async () => (await person([{ command: 'project.freeform.layout', params: { width: await widthNow() } }])).completed[0].result?.cards ?? []
      const cardOf = async (item) => (await layoutNow()).find((card) => card.item === item) ?? null
      /** Where the canvas draws a card: its box's place on the canvas, which is the engine's place less 2 points (upstream's `r.expand(2)`). */
      const drawnAt = (item) => kit.getByTestId(`film-project-item-${item}`).evaluate((element) => ({ x: element.offsetLeft + 2, y: element.offsetTop + 2, width: element.offsetWidth - 4 })).catch(() => null)
      const near = (a, b, within = 1) => a != null && b != null && Math.abs(a - b) <= within
      /** A point of the canvas no card covers, in the page (the canvas menu's place). */
      const emptySpot = async () => {
        const box = await settledBox(kit.getByTestId('film-project-freeform'))
        const frameBox = await settledBox(page.locator('#kit'))
        const spot = await kitFrame().evaluate(({ x, y, width, height }) => {
          for (let fy = 0.92; fy > 0.05; fy -= 0.07)
            for (let fx = 0.95; fx > 0.05; fx -= 0.07) {
              const px = x + width * fx
              const py = y + height * fy
              if (document.elementFromPoint(px, py)?.getAttribute('data-testid') === 'film-project-freeform-canvas') return { x: px, y: py }
            }
          return null
        }, { x: box.x - frameBox.x, y: box.y - frameBox.y, width: box.width, height: box.height })
        return spot ? { x: spot.x + frameBox.x, y: spot.y + frameBox.y } : null
      }
      const canvasMenu = async () => {
        const spot = await emptySpot()
        await page.mouse.click(spot.x, spot.y, { button: 'right' })
        await kit.getByTestId('film-project-canvas-menu').waitFor({ timeout: 5000 })
      }
      /** Drags a card by its picture to `to` (page points), a step at a time, as the person does. */
      const dragCard = async (item, by) => {
        // In the panel's view first (a click on another card may have scrolled the canvas).
        await kit.getByTestId(`film-project-item-${item}`).scrollIntoViewIfNeeded()
        const box = await settledBox(kit.getByTestId(`film-project-item-${item}`))
        const from = { x: box.x + box.width / 2, y: box.y + box.height / 3 }
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        for (let i = 1; i <= 10; i += 1) {
          await page.mouse.move(from.x + (by.x * i) / 10, from.y + (by.y * i) / 10)
          await hold(30)
        }
        await page.mouse.up()
      }

      // The footer's Freeform View button: the engine's view, and every card where its layout puts it.
      await kit.getByTestId('film-project-view-freeform').click()
      const shown = await until(async () => (await panelView()) === 'freeform' && (await canvas.count()) === 1 && (await kit.locator('.film-freeform-card').count()) > 1, 60)
      await checkIds()
      const cards = await layoutNow()
      const placesWrong = []
      for (const card of cards) {
        const at = await drawnAt(card.item)
        if (!at || !near(at.x, card.x, 0.5) || !near(at.y, card.y, 0.5) || !near(at.width, card.size, 0.5)) placesWrong.push({ card, at })
      }
      // A click at the engine's place of a card (the middle of its picture) selects that card.
      const [A, B, C] = cards.filter((card) => card.stack == null)
      const canvasBox = await settledBox(canvas)
      await page.mouse.click(canvasBox.x + B.x + B.size / 2, canvasBox.y + B.y + (B.size * 9) / 32)
      const hit = await until(async () => JSON.stringify((await sessionNow()).project_selection) === JSON.stringify([B.item]), 50)
      step("the Freeform View button shows the bin's cards where the engine's layout puts them, and a click at a card's place selects it", shown && (await viewNow())?.view?.mode === 'freeform' && cards.length >= 3 && placesWrong.length === 0 && hit, JSON.stringify({ shown, cards: cards.length, placesWrong: placesWrong.slice(0, 2), hit, selection: (await sessionNow()).project_selection }))

      // A card dragged in the panel: one move, one history step, drawn where it was dropped.
      const stepsBefore = await history()
      const revisionBefore = await revision()
      await dragCard(C.item, { x: 70, y: 40 })
      const moved = await until(async () => {
        const now = await cardOf(C.item)
        return now?.placed === true && near(now.x, C.x + 70, 4) && near(now.y, C.y + 40, 4)
      }, 60)
      const movedTo = await cardOf(C.item)
      const movedDrawn = await until(async () => {
        const at = await drawnAt(C.item)
        return near(at?.x, movedTo?.x, 0.5) && near(at?.y, movedTo?.y, 0.5)
      }, 40)
      const oneStep = (await history()) === stepsBefore + 1 && (await revision()) === revisionBefore + 1
      step('a card dragged in the Freeform view moves there in one history step, and is drawn where it was dropped', moved && movedDrawn && oneStep, JSON.stringify({ from: [C.x, C.y], to: movedTo && [movedTo.x, movedTo.y], movedDrawn, oneStep }))

      // Escape mid-drag: the cards go back, and nothing is sent.
      {
        const revisionFrom = await revision()
        await kit.getByTestId(`film-project-item-${C.item}`).scrollIntoViewIfNeeded()
        const box = await settledBox(kit.getByTestId(`film-project-item-${C.item}`))
        const from = { x: box.x + box.width / 2, y: box.y + box.height / 3 }
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        for (let i = 1; i <= 10; i += 1) {
          await page.mouse.move(from.x + 5 * i, from.y + 3 * i)
          await hold(30)
        }
        const midway = await until(async () => (await kit.getByTestId(`film-project-item-${C.item}`).getAttribute('data-moving')) === 'true' && !near((await drawnAt(C.item))?.x, movedTo?.x, 10), 20)
        await page.keyboard.press('Escape')
        const back = await until(async () => (await kit.getByTestId(`film-project-item-${C.item}`).getAttribute('data-moving')) == null && near((await drawnAt(C.item))?.x, movedTo?.x, 0.5) && near((await drawnAt(C.item))?.y, movedTo?.y, 0.5), 30)
        await page.mouse.up()
        await paintFrames()
        await hold(250)
        const unchanged = (await revision()) === revisionFrom && JSON.stringify(await cardOf(C.item)) === JSON.stringify(movedTo)
        step('Escape in the middle of a card drag puts the cards back and sends nothing', midway && back && unchanged, JSON.stringify({ midway, back, unchanged, now: await cardOf(C.item) }))
      }

      // Saved, then opened in a fresh page: the card is where it was dropped.
      const versionBefore = await page.evaluate(() => window.devHost.files.get('films/Sample.kfilm').version)
      await kit.getByTestId('film-save').click()
      const savedVersion = await until(async () => (await page.evaluate(() => window.devHost.files.get('films/Sample.kfilm').version)) > versionBefore, 40)
      const bytes = await page.evaluate(() => Array.from(new Uint8Array(window.devHost.files.get('films/Sample.kfilm').bytes)))
      const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      let reopened = null
      try {
        const page5 = await fresh.newPage()
        await page5.goto(`${origin}/dev.html`)
        await page5.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
        await page5.evaluate(async (list) => {
          document.getElementById('status').textContent = ''
          await window.devHost.open('films/Sample.kfilm', new Uint8Array(list).buffer)
        }, bytes)
        await page5.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
        await waitForEngine(page5, (state) => state.details?.project != null, { timeout: 30000 })
        await personRun([{ command: 'project.view.set', params: { view: 'freeform' } }], page5)
        const kit5 = page5.frameLocator('#kit')
        const card5 = kit5.getByTestId(`film-project-item-${C.item}`)
        await card5.waitFor({ timeout: 15000 })
        const layout5 = (await personRun([{ command: 'project.freeform.layout', params: {} }], page5)).completed[0].result?.cards ?? []
        // Where the card is drawn once the canvas has laid it out (a first frame may draw it before the layout lands).
        const at5 = await heldStill(() => card5.evaluate((element) => ({ x: element.offsetLeft + 2, y: element.offsetTop + 2 })).catch(() => null), { what: "the reopened page's card place" })
        reopened = { layout: layout5.find((card) => card.item === C.item) ?? null, drawn: at5 }
      } catch (error) {
        reopened = { error: error.message.split('\n')[0] }
      } finally {
        await fresh.close()
      }
      step("the moved card's place is kept in the saved document: a fresh page opening it draws the card there", savedVersion && reopened?.layout?.placed === true && near(reopened.layout.x, movedTo?.x, 0.5) && near(reopened.layout.y, movedTo?.y, 0.5) && near(reopened.drawn?.x, movedTo?.x, 0.5) && near(reopened.drawn?.y, movedTo?.y, 0.5), JSON.stringify({ movedTo: movedTo && [movedTo.x, movedTo.y], reopened }))

      // Two cards stacked from the card menu: the stack's first card shows ×2.
      await kit.getByTestId(`film-project-item-${A.item}`).click({ position: { x: 20, y: 20 } })
      await kit.getByTestId(`film-project-item-${B.item}`).click({ position: { x: 20, y: 20 }, modifiers: ['Shift'] })
      await until(async () => ((await sessionNow()).project_selection ?? []).length === 2, 50)
      await kit.getByTestId(`film-project-item-${B.item}`).click({ position: { x: 20, y: 20 }, button: 'right' })
      await kit.getByTestId('film-project-card-menu').waitFor({ timeout: 5000 })
      await checkIds()
      const unstackGreyed = await kit.getByTestId('film-project-card-unstack').isDisabled().catch(() => null)
      await kit.getByTestId('film-project-card-stack').click()
      const stacked = await until(async () => (await layoutNow()).filter((card) => card.stack === A.item).length === 2, 60)
      const badge = await until(async () => (await kit.getByTestId(`film-project-stack-${A.item}`).textContent({ timeout: 300 }).catch(() => null)) === '×2', 60)
      step('Stack, from the card menu over two selected cards, stacks them: the stack\'s first card shows ×2 (Unstack greyed before)', unstackGreyed === true && stacked && badge, JSON.stringify({ unstackGreyed, stacked, badge }))

      // Align to Grid from the canvas menu: every card not stacked behind another on the grid.
      await canvasMenu()
      await checkIds()
      const grid = (await viewNow())?.freeform?.grid ?? 20
      await kit.getByTestId('film-project-canvas-alignToGrid').click()
      const aligned = await until(async () => {
        const all = await layoutNow()
        return all.length > 0 && all.filter((card) => card.stack == null || card.stack === card.item).every((card) => card.placed && card.x % grid === 0 && card.y % grid === 0)
      }, 60)
      step('Align to Grid, from the canvas menu, puts every card on the grid', aligned, JSON.stringify({ grid, cards: (await layoutNow()).slice(0, 4).map((card) => [card.item, card.x, card.y]) }))

      // Freeform View Options with a larger clip size: the cards grow in the preview only.
      const sizeBefore = (await viewNow())?.freeform?.cardSize ?? 128
      const sizeField = '[data-testid="film-dialog-projectDialog-cardSize"] input'
      let options = null
      const optionsCancel = await previewThenCancel({
        open: () => panelMenu('film-project-menu-freeformOptions'),
        change: async () => {
          await kit.locator(sizeField).fill(String(sizeBefore + 72))
          await kit.locator(sizeField).press('Tab')
        },
        expectPreview: async () => {
          options = {
            grown: await until(async () => near((await drawnAt(C.item))?.width, sizeBefore + 72, 0.5), 60),
            badge: (await kit.getByTestId('film-project-preview-badge').count()) === 1,
            document: (await viewNow())?.freeform?.cardSize,
            // The Freeform view on screen draws the options: the strip lists none.
            stripLines: await kit.getByTestId('film-preview-view').count(),
          }
          return options.grown && options.badge && options.document === sizeBefore && options.stripLines === 0
        },
      })
      const sizeBack = await until(async () => near((await drawnAt(C.item))?.width, sizeBefore, 0.5), 50)
      step('Freeform View Options with a larger clip size previews the cards larger, the document keeps its size, and Cancel leaves it as it was', optionsCancel.ok && sizeBack, JSON.stringify({ ...optionsCancel, options, sizeBack }))

      // Save Arrangement "A" (a summary of what it records), a card moved, then Restore "A".
      await canvasMenu()
      await kit.getByTestId('film-project-canvas-saveArrangement').click()
      await kit.getByTestId('film-dialog').waitFor({ timeout: 10000 })
      await checkIds()
      const okGreyed = await kit.getByTestId('film-dialog-ok').isDisabled()
      await kit.getByTestId('film-dialog-projectDialog-name').fill('A')
      const summary = await until(async () => pattern(ztRaw('freeform.saves'), { name: 'A', count: '\\d+' }).test((await kit.getByTestId('film-preview-summary').textContent({ timeout: 300 }).catch(() => '')) ?? ''), 50)
      await kit.getByTestId('film-dialog-ok').click()
      const savedA = await until(async () => (await dialogShown()) === 0 && ((await person([{ command: 'project.freeform.arrangements', params: {} }])).completed[0].result?.arrangements ?? []).includes('A'), 60)
      const placeA = await cardOf(C.item)
      await dragCard(C.item, { x: 60, y: 60 })
      const movedAgain = await until(async () => {
        const now = await cardOf(C.item)
        return now != null && placeA != null && (Math.abs(now.x - placeA.x) > 20 || Math.abs(now.y - placeA.y) > 20)
      }, 60)
      await canvasMenu()
      await kit.getByTestId('film-project-canvas-restoreArrangement').click()
      await kit.getByTestId('film-project-canvas-restore-A').click()
      const restored = await until(async () => {
        const now = await cardOf(C.item)
        const at = await drawnAt(C.item)
        return now != null && near(now.x, placeA?.x, 0.5) && near(now.y, placeA?.y, 0.5) && near(at?.x, placeA?.x, 0.5) && near(at?.y, placeA?.y, 0.5)
      }, 60)
      step('Save Arrangement "A" (OK greyed with no name; a summary of the cards it records), a card moved, and Restore "A" puts it back', okGreyed && summary && savedA && movedAgain && restored, JSON.stringify({ okGreyed, summary, savedA, movedAgain, restored, placeA: placeA && [placeA.x, placeA.y], now: await cardOf(C.item) }))

      // The canvas scrolls under a drag (as the browsers auto-scroll it, or a wheel): the card stays
      // under the pointer and lands where it is shown, the scroll included.
      {
        const scroller = kit.getByTestId('film-project-freeform')
        await scroller.evaluate((element) => {
          element.scrollTop = 0
        })
        // The card near the canvas's top, so the pointer stays over the short view as it scrolls.
        await person([{ command: 'project.freeform.move', params: { items: [C.item], x: 200, y: 20, width: await widthNow() } }])
        await until(async () => near((await drawnAt(C.item))?.y, 20, 0.5), 40)
        const before = await cardOf(C.item)
        const box = await settledBox(kit.getByTestId(`film-project-item-${C.item}`))
        const from = { x: box.x + box.width / 2, y: box.y + box.height / 3 }
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        for (let i = 1; i <= 6; i += 1) {
          await page.mouse.move(from.x + 2 * i, from.y + 5 * i)
          await hold(30)
        }
        const scrolled = await scroller.evaluate((element) => {
          element.scrollTop += 120
          return element.scrollTop
        })
        for (let i = 1; i <= 4; i += 1) {
          await page.mouse.move(from.x + 12 + i, from.y + 30 + i)
          await hold(40)
        }
        // Drawn under the pointer: the card's place on the canvas follows the scroll.
        const shownAt = await drawnAt(C.item)
        const following = near(shownAt?.y, before.y + 34 + scrolled, 3)
        await page.mouse.up()
        const landed = await until(async () => {
          const now = await cardOf(C.item)
          return now != null && near(now.y, before.y + 34 + scrolled, 3) && near(now.x, before.x + 16, 3)
        }, 60)
        step('a card dragged while the canvas scrolls under it stays under the pointer and lands where it is shown, the scroll included', scrolled > 20 && following && landed, JSON.stringify({ scrolled, before: [before.x, before.y], shownAt, now: await cardOf(C.item) }))
        await scroller.evaluate((element) => {
          element.scrollTop = 0
        })
      }

      // A card dragged out of the panel onto V2 is the item's own drag: placed there, and no card moves.
      {
        const cardBefore = await cardOf(C.item)
        const v2 = async () => (await clips('video')).filter((item) => item.item === C.item)
        const countBefore = (await v2()).length
        const lane2 = await settledBox(kit.getByTestId('film-track-Video 2'))
        await kit.getByTestId(`film-project-item-${C.item}`).scrollIntoViewIfNeeded()
        const box = await settledBox(kit.getByTestId(`film-project-item-${C.item}`))
        const from = { x: box.x + box.width / 2, y: box.y + box.height / 3 }
        const to = { x: lane2.x + lane2.width * 0.6, y: lane2.y + lane2.height * 0.6 }
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        for (let i = 1; i <= 14; i += 1) {
          await page.mouse.move(from.x + ((to.x - from.x) * i) / 14, from.y + ((to.y - from.y) * i) / 14)
          await hold(40)
        }
        await page.mouse.move(to.x + 2, to.y)
        const dropPreviewed = await until(async () => (await kit.getByTestId('film-timeline-drop').count()) === 1, 20)
        // Out of the view, upstream's drag ghost (the item's name) follows the pointer, and the card keeps its offset.
        const ghost = await until(async () => (await kit.getByTestId('film-project-freeform-drag-label').textContent({ timeout: 200 }).catch(() => '')) === (await kit.getByTestId(`film-project-item-${C.item}`).locator('.film-project-text').first().textContent()), 20)
        const following = (await kit.getByTestId(`film-project-item-${C.item}`).getAttribute('data-moving')) === 'true'
        await page.mouse.up()
        const ghostGone = await until(async () => (await kit.getByTestId('film-project-freeform-drag-label').count()) === 0 && (await kit.getByTestId(`film-project-item-${C.item}`).getAttribute('data-moving')) == null, 30)
        const placed = await until(async () => (await v2()).length === countBefore + 1, 60)
        const cardAfter = await cardOf(C.item)
        const stayed = cardAfter != null && cardBefore != null && cardAfter.x === cardBefore.x && cardAfter.y === cardBefore.y
        step('a card dragged out of the Freeform view onto V2 places the item there, as the Icon view\'s drag, with the item\'s name beside the pointer and the card following it, and moves no card', dropPreviewed && ghost && following && ghostGone && placed && stayed, JSON.stringify({ dropPreviewed, ghost, following, ghostGone, placed, stayed, cardBefore, cardAfter }))
        if (placed) {
          await kit.locator('.kui-app').focus()
          await page.keyboard.press('ControlOrMeta+z')
          await until(async () => (await v2()).length === countBefore)
        }
      }

      // Back to the Icon view for the steps after.
      await kit.getByTestId('film-project-view-icon').click()
      await until(async () => (await panelView()) === 'icon', 60)
    }

    // ---- floating bin panels (Task 20, upstream `project.rs` `open_bin` openNewWindow, `floating`,
    // `route` newPanel): a bin's menu ▸ Open in New Window shows the bin's items in a window; an
    // item drags from it onto V2; the window takes the Project panel's keys; Window ▸ New Project
    // Panel opens the root in another; a second editor page keeps its own windows, its new window
    // where the first page left one of the same bin (the kit store); a renamed bin's window
    // follows it; closing a window focuses the Project panel; a deleted bin's window closes. No
    // step previews a change (Task 10's removed-row step carries forward).
    {
      const person = personRun
      const sessionNow = async () => (await person([{ command: 'state.inspect', params: {} }])).completed[0].result
      const iconItems = async (params) => ((await person([{ command: 'project.items', params: { ...params, order: 'icon' } }])).completed[0].result?.rows ?? []).flatMap((row) => (row.item != null && row.direct !== false ? [row.item] : []))
      const windows = kit.locator('.kui-floating-panel')
      const windowOf = (id) => kit.getByTestId(`film-bin-windows-${id}`)
      const itemsIn = (id) => windowOf(id).locator('[data-testid^="film-project-item-"]').evaluateAll((items) => items.map((item) => Number(item.getAttribute('data-testid').slice('film-project-item-'.length))))
      const rectOf = (locator) => locator.evaluate((element) => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top), width: parseFloat(element.style.width), height: parseFloat(element.style.height) }))
      const stored = (on = page) => on.frameLocator('#kit').locator('.kui-app').evaluate(() => JSON.parse(localStorage.getItem('kit:film:floatingBins') ?? '{}'))
      const focusedFrame = () => kitFrame().evaluate(() => document.querySelector('.kui-ws-frame[data-focused="true"]')?.getAttribute('data-panel') ?? null)
      const rootId = (await details()).project.root.id
      // A bin at the root holding two of its media items.
      const media = ((await person([{ command: 'project.items', params: { order: 'icon' } }])).completed[0].result?.rows ?? []).filter((row) => row.item != null && row.direct !== false && row.kind === 'media').map((row) => row.item)
      const bin = (await person([{ command: 'bin.add', params: { name: 'Floating' } }])).completed[0].result?.bin
      const moved = media.slice(0, 2)
      await person([{ command: 'project.moveToBin', params: { items: moved, bin } }])
      const binCard = kit.getByTestId(`film-project-bin-${bin}`)
      await binCard.waitFor({ timeout: 10000 })
      const id = `bin${bin}`

      // The bin's menu ▸ Open in New Window: a window titled "Bin: Floating" with the bin's items.
      await binCard.click({ button: 'right' })
      await kit.getByTestId('film-project-bin-new-window').click()
      const opened = await until(async () => (await windowOf(id).count()) === 1 && JSON.stringify((await itemsIn(id)).sort()) === JSON.stringify([...moved].sort()), 60)
      const title = await kit.getByTestId(`film-bin-windows-${id}-title`).textContent().catch(() => null)
      await checkIds()
      const windowCrumb = await windowOf(id).getByTestId('film-project-breadcrumb').textContent().catch(() => null)
      step("a bin's menu ▸ Open in New Window shows a window titled with the bin, listing the bin's items (and no other)", moved.length === 2 && opened && title === filled(zh('Bin: {name}'), { name: 'Floating' }) && windowCrumb === 'Sample.kfilm / Floating' && (await windows.count()) === 1, JSON.stringify({ moved, shown: await itemsIn(id), title, windowCrumb }))

      // An item dragged from the window onto V2 is placed there, as the panel's own drag.
      {
        const item = moved[0]
        const v2 = async () => (await clips('video')).filter((each) => each.item === item)
        const before = { revision: await revision(), count: (await v2()).length }
        const box = await settledBox(windowOf(id).getByTestId(`film-project-item-${item}`))
        const lane2 = await settledBox(kit.getByTestId('film-track-Video 2'))
        const from = { x: box.x + box.width / 2, y: box.y + box.height / 3 }
        const to = { x: lane2.x + lane2.width * 0.6, y: lane2.y + lane2.height * 0.6 }
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        for (let i = 1; i <= 14; i += 1) {
          await page.mouse.move(from.x + ((to.x - from.x) * i) / 14, from.y + ((to.y - from.y) * i) / 14)
          await hold(40)
        }
        await page.mouse.move(to.x + 2, to.y)
        const dropPreviewed = await until(async () => (await kit.getByTestId('film-timeline-drop').count()) === 1, 20)
        await page.mouse.up()
        const placed = await until(async () => (await revision()) > before.revision && (await v2()).length === before.count + 1, 60)
        step('an item dragged from a floating bin window onto V2 previews the drop and is placed there', dropPreviewed && placed, JSON.stringify({ item, dropPreviewed, placed }))
        if (placed) {
          await kit.locator('.kui-app').focus()
          await page.keyboard.press('ControlOrMeta+z')
          await until(async () => (await v2()).length === before.count)
        }
      }

      // A click in the window focuses it: End selects its bin's last item, not the panel's.
      {
        const own = await iconItems({ bin })
        await windowOf(id).getByTestId(`film-project-item-${own[0]}`).click({ position: { x: 10, y: 10 } })
        await until(async () => JSON.stringify((await sessionNow()).project_selection) === JSON.stringify([own[0]]), 30)
        const focused = (await windowOf(id).getAttribute('data-focused')) === 'true'
        await page.keyboard.press('End')
        const ended = await until(async () => JSON.stringify((await sessionNow()).project_selection) === JSON.stringify([own.at(-1)]), 30)
        step("a click in a floating bin window focuses it, and its keys act on it: End selects its bin's last item", own.length === 2 && focused && ended, JSON.stringify({ own, focused, selection: (await sessionNow()).project_selection }))
      }

      // Window ▸ New Project Panel: the project's root in a window of its own, titled "Project: Sample".
      const rootWindow = `bin${rootId}`
      await kit.getByTestId('film-menu-Window').click()
      await kit.getByTestId('film-control-projectPanel.newPanel').click()
      const rootShown = await until(async () => (await windowOf(rootWindow).count()) === 1 && (await windowOf(rootWindow).getByTestId(`film-project-bin-${bin}`).count()) === 1, 60)
      const rootTitle = await kit.getByTestId(`film-bin-windows-${rootWindow}-title`).textContent().catch(() => null)
      await checkIds()
      step('Window ▸ New Project Panel opens the project\'s root in another window, titled "Project: Sample", listing the root\'s bins', rootShown && rootTitle === filled(zh('Project: {name}'), { name: 'Sample' }) && (await windows.count()) === 2, JSON.stringify({ rootShown, rootTitle, windows: await windows.count() }))

      // Moved by its title bar: the rectangle is in the kit store, under the root window's id.
      const rootRect = await heldStill(() => rectOf(windowOf(rootWindow)), { what: "the root window's place" })
      const titleBox = await settledBox(kit.getByTestId(`film-bin-windows-${rootWindow}-title`))
      await page.mouse.move(titleBox.x + 60, titleBox.y + titleBox.height / 2)
      await page.mouse.down()
      for (let i = 1; i <= 6; i += 1) {
        await page.mouse.move(titleBox.x + 60 + 20 * i, titleBox.y + titleBox.height / 2 + 12 * i)
        await hold(30)
      }
      await page.mouse.up()
      // Where it was dropped (kept inside the workspace: the layer moves it in when it would leave it).
      const movedTo = await heldStill(() => rectOf(windowOf(rootWindow)), { what: "the root window's place after the drag" })
      const kept = movedTo.x === rootRect.x + 120 && movedTo.y !== rootRect.y && (await until(async () => JSON.stringify((await stored())[rootWindow]) === JSON.stringify(movedTo), 30))

      // Two pages: a second editor page has none of the first page's windows; its own New Project
      // Panel opens where the first page left the root's window (positions in the store).
      {
        const page2 = await context.newPage()
        page2.on('pageerror', (error) => errors.push(`page 2: ${error.message}`))
        let second = null
        try {
          await page2.goto(`${origin}/dev.html`)
          await page2.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
          const kit2 = page2.frameLocator('#kit')
          await kit2.getByTestId('film-project').waitFor({ timeout: 15000 })
          const root2 = (await waitForEngine(page2, (state) => state.details?.project?.root != null, { timeout: 30000 })).details.project.root.id
          const none = await kit2.locator('.kui-floating-panel').count()
          await kit2.getByTestId('film-menu-Window').click()
          await kit2.getByTestId('film-control-projectPanel.newPanel').click()
          const own = kit2.getByTestId(`film-bin-windows-bin${root2}`)
          await own.waitFor({ timeout: 10000 })
          second = { root2, none, count: await kit2.locator('.kui-floating-panel').count(), rect: await rectOf(own) }
          await kit2.getByTestId(`film-bin-windows-bin${root2}-close`).click()
          second.closed = await until(async () => (await kit2.locator('.kui-floating-panel').count()) === 0, 30)
        } catch (error) {
          second = { error: error.message.split('\n')[0] }
        } finally {
          await page2.close()
        }
        const firstKeeps = (await windows.count()) === 2
        step("a second editor page keeps its own windows: none of the first page's, and its New Project Panel opens where the first page left the root's window (the kit store)", kept && second?.root2 === rootId && second.none === 0 && second.count === 1 && JSON.stringify(second.rect) === JSON.stringify(movedTo) && second.closed && firstKeeps, JSON.stringify({ kept, rootRect, movedTo, second, firstKeeps }))
      }

      // A renamed bin's window takes its name; closing the focused root window focuses the Project panel, whose keys act again.
      await person([{ command: 'project.renameBin', params: { bin, name: 'Floated' } }])
      const renamed = await until(async () => (await kit.getByTestId(`film-bin-windows-${id}-title`).textContent()) === filled(zh('Bin: {name}'), { name: 'Floated' }) && (await windowOf(id).getByTestId('film-project-breadcrumb').textContent()) === 'Sample.kfilm / Floated', 40)
      step("a renamed bin's window takes its name in its title and breadcrumb", renamed, JSON.stringify({ title: await kit.getByTestId(`film-bin-windows-${id}-title`).textContent().catch(() => null) }))
      {
        await windowOf(rootWindow).getByTestId('film-project-count').click()
        const focusedRoot = await until(async () => (await windowOf(rootWindow).getAttribute('data-focused')) === 'true', 20)
        await kit.getByTestId(`film-bin-windows-${rootWindow}-close`).click()
        const closed = await until(async () => (await windowOf(rootWindow).count()) === 0, 30)
        const panelFocused = await until(async () => (await focusedFrame()) === 'project', 30)
        // The editor gives the keyboard back on the next animation frame, and only while its
        // document has focus: Home is pressed once the keyboard is inside the editor again.
        const keysBack = await until(async () => kitFrame().evaluate(() => document.hasFocus() && document.activeElement?.closest('.kui-app') != null), 30)
        const mainItems = await iconItems({})
        await page.keyboard.press('Home')
        const homed = await until(async () => JSON.stringify((await sessionNow()).project_selection) === JSON.stringify([mainItems[0]]), 30)
        step('closing the focused window focuses the Project panel, whose keys act again (Home selects its first item)', focusedRoot && closed && panelFocused && keysBack && homed && (await windows.count()) === 1, JSON.stringify({ focusedRoot, closed, panelFocused, keysBack, homed, mainFirst: mainItems[0], selection: (await sessionNow()).project_selection }))
      }

      // Escape in a window's search field: the window keeps focus (and so the keys).
      {
        const field = windowOf(id).getByTestId('film-project-search')
        await field.click()
        await page.keyboard.press('Escape')
        const kept = await until(async () => (await kitFrame().evaluate(() => document.activeElement?.classList.contains('kui-floating-panel') === true)) && (await windowOf(id).getAttribute('data-focused')) === 'true', 20)
        step("Escape in a floating window's search field leaves focus in the window, not on the page's body", kept, JSON.stringify({ active: await kitFrame().evaluate(() => document.activeElement?.className ?? null) }))
      }

      // A bin made with New Bin, opened in a window, the window focused, then Cmd+Z: the window
      // closes with the bin, and the editor keeps its keys (Cmd+Shift+Z brings the bin back).
      {
        const binsNow = async () => ((await details()).project.root.children ?? []).filter((child) => child.children).map((child) => child.id)
        const before = await binsNow()
        // The docked panel's own footer and card (the open window draws the same controls).
        const docked = kit.getByTestId('film-project')
        await docked.getByTestId('film-project-new-bin').click()
        await until(async () => (await binsNow()).length === before.length + 1, 40)
        const made = (await binsNow()).find((each) => !before.includes(each))
        await docked.getByTestId(`film-project-bin-${made}`).click({ button: 'right' })
        await kit.getByTestId('film-project-bin-new-window').click()
        const madeWindow = windowOf(`bin${made}`)
        await madeWindow.waitFor({ timeout: 10000 })
        await madeWindow.getByTestId('film-project-empty').click()
        const focusedMade = await until(async () => (await madeWindow.getAttribute('data-focused')) === 'true', 20)
        await page.keyboard.press('ControlOrMeta+z')
        const closedWithBin = await until(async () => !(await binsNow()).includes(made) && (await madeWindow.count()) === 0, 40)
        const appFocused = await until(async () => kitFrame().evaluate(() => document.activeElement?.classList.contains('kui-app') === true), 20)
        await page.keyboard.press('ControlOrMeta+Shift+z')
        const redone = await until(async () => (await binsNow()).includes(made), 40)
        // The editor hands the focus back to the Project frame on its next animation frame.
        await until(async () => (await focusedFrame()) === 'project', 30)
        step('a focused window whose bin an undo removes closes, and the editor keeps its keys: Cmd+Shift+Z brings the bin back', made != null && focusedMade && closedWithBin && appFocused && redone && (await focusedFrame()) === 'project', JSON.stringify({ made, focusedMade, closedWithBin, appFocused, redone, frame: await focusedFrame() }))
        if (redone) await person([{ command: 'project.delete', params: { items: [made] } }])
      }

      // The bin deleted (its items back at the root first): its window closes.
      await person([{ command: 'project.moveToBin', params: { items: moved, bin: null } }])
      await person([{ command: 'project.delete', params: { items: [bin] } }])
      const gone = await until(async () => (await windowOf(id).count()) === 0 && (await windows.count()) === 0, 40)
      step("a floating bin window closes when its bin is deleted", gone, JSON.stringify({ windows: await windows.count() }))
    }

    // ---- previews drawn in the panels (Task 10): a dialog spec the flow makes (each dialog task
    // registers its own), opened as the editor opens a registered one, and previewed on its panels.
    /** Opens a dialog for `fake.id` whose draft is `fake.draft` and whose preview kinds are `fake.preview`. */
    const openFake = (fake) => () =>
      kitFrame().evaluate((each) => window.filmPreview.open({ id: each.id, family: each.family, title: each.title, prefix: each.prefix, preview: each.preview, layout: [{ kind: 'heading', label: each.title }], defaults: () => ({ ...each.draft }) }), fake)
    const addTracks = { id: 'sequence.addTracks', family: 'tracks', title: 'Add Tracks', prefix: 'addTracks', preview: ['timeline'], draft: { video: 0, audio: 1 } }
    {
      await person([{ command: 'timeline.select', params: { clips: [] } }])
      await kit.locator('.kui-app').focus()
      await page.keyboard.press('\\')
      const audioBefore = (await seq()).audio.map((track) => track.id)
      let shown = null
      const result = await previewThenCancel({
        open: openFake(addTracks),
        change: null,
        expectPreview: async () => {
          const added = kit.locator('[data-testid="film-timeline-audio"] [data-testid^="film-preview-track-"][data-preview="added"]')
          // The new track goes below the last one: the Timeline scrolls the audio half to show it.
          const drawn = await until(async () => (await added.count()) === 1, 60)
          const id = Number((await added.first().getAttribute('data-testid'))?.replace('film-preview-track-', ''))
          shown = {
            drawn,
            id,
            dashed: drawn ? await added.first().evaluate((element) => getComputedStyle(element).borderTopStyle) : null,
            badge: await kit.getByTestId('film-timeline-preview-badge').count(),
            strip: await kit.getByTestId('film-preview-diff').count(),
            inDiff: await kitFrame().evaluate((track) => (window.filmPreview.state().diff?.tracks?.added ?? []).some((entry) => entry.id === track), id),
            new: !audioBefore.includes(id),
          }
          return drawn && shown.dashed === 'dashed' && shown.badge === 1 && shown.strip === 0 && shown.inDiff && shown.new
        },
      })
      step('a timeline preview of Add Tracks (audio 1) draws a dashed A-track with the Preview badge, and Cancel removes it and leaves the document as it was', result.ok && (await seq()).audio.length === audioBefore.length, JSON.stringify({ ...result, shown }))
    }
    // While a preview is open the Timeline's editing gestures are off: a drag of a clip moves nothing.
    {
      await openFake(addTracks)()
      await kit.getByTestId('film-dialog').waitFor({ timeout: 10000 })
      await previewSettled()
      const from = await waitForEngine(page, () => true, { history: true })
      const aMid = mid(await box(A.clip))
      await drag(aMid, { x: aMid.x + 80, y: aMid.y })
      await settle()
      const to = await waitForEngine(page, () => true, { history: true })
      const still = await clipOf(A.clip)
      await kit.getByTestId('film-dialog-cancel').click()
      await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      step("a drag on the Timeline under a preview moves no clip and adds no history step", still.start === A.start && (to.history?.undo ?? []).length === (from.history?.undo ?? []).length && to.details.sequence.video[0].items.length === from.details.sequence.video[0].items.length, JSON.stringify({ start: [A.start, still.start], undo: [(from.history?.undo ?? []).length, (to.history?.undo ?? []).length] }))
    }
    // While a preview is open the document is not editable (upstream's dialogs are modal): Delete
    // on a selected clip changes nothing and the status bar says why; the playhead still moves.
    {
      if (await kit.getByTestId('film-message').count()) await kit.getByTestId('film-message').click()
      await openFake(addTracks)()
      await kit.getByTestId('film-dialog').waitFor({ timeout: 10000 })
      await previewSettled()
      // A click on A under the preview selects it and focuses the Timeline, as a person does.
      const aAt = mid(await box(A.clip))
      await page.mouse.click(aAt.x, aAt.y)
      // The person's selection, as the Timeline draws it: an agent's inspect answers the agent's own.
      await until(async () => (await kit.getByTestId(`film-clip-${A.clip}`).getAttribute('data-selected')) != null)
      await until(async () => (await kit.locator('[data-testid="film-workspace-frame-timeline"][data-focused="true"]').count()) === 1, 40)
      await previewSettled()
      const from = await waitForEngine(page, () => true, { history: true })
      await kit.locator('.kui-app').focus()
      await page.keyboard.press('Delete')
      await settle()
      const message = await until(async () => ((await said()) ?? '').includes(zt('previewBusy')), 40)
      const to = await waitForEngine(page, () => true, { history: true })
      await page.keyboard.press('ArrowRight')
      const moved = await waitForEngine(page, (state) => state.details?.playhead !== to.details?.playhead, { orNull: true })
      await kit.getByTestId('film-dialog-cancel').click()
      await until(async () => (await dialogShown()) === 0 && !(await previewState()).open, 50)
      const unchanged = to.revision === from.revision && (to.history?.undo ?? []).length === (from.history?.undo ?? []).length && (await clipOf(A.clip)) != null
      step('Delete with a preview open changes nothing and says to finish or cancel the dialog; the playhead still moves', unchanged && message && moved != null, JSON.stringify({ revision: [from.revision, to.revision], message, said: await said(), moved: moved != null }))
      if (await kit.getByTestId('film-message').count()) await kit.getByTestId('film-message').click()
      await person([{ command: 'timeline.select', params: { clips: [] } }])
    }
    // A selection preview (Find on the Timeline) highlights its matches, dashed, beside the real selection.
    {
      await person([{ command: 'timeline.select', params: { clips: [B.clip] } }])
      const realBefore = (await waitForEngine(page, (state) => state.details?.sequence?.selection?.includes(B.clip))).details.sequence.selection
      let shown = null
      const result = await previewThenCancel({
        open: openFake({ id: 'edit.find', family: 'find', title: 'Find', prefix: 'find', preview: ['selection'], draft: { scope: 'timeline', text: A.name ?? 'bars' } }),
        change: null,
        expectPreview: async () => {
          const drawn = await until(async () => (await kit.locator('[data-testid^="film-clip-"][data-preview-selected]').count()) > 0, 60)
          shown = {
            drawn,
            highlighted: await kit.locator('[data-preview-selected]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid'))),
            selected: await kit.locator('.film-clip[data-selected]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid'))),
            real: (await seq()).selection,
          }
          return drawn && shown.highlighted.includes(`film-clip-${A.clip}`) && !shown.selected.includes(`film-clip-${A.clip}`) && shown.selected.includes(`film-clip-${B.clip}`) && JSON.stringify(shown.real) === JSON.stringify(realBefore)
        },
      })
      step('a selection preview (Find) highlights the matches dashed on the Timeline and leaves the real selection as it was', result.ok, JSON.stringify({ ...result, shown }))
      await person([{ command: 'timeline.select', params: { clips: [] } }])
    }
    // A markers preview (Flash Cue Marker) shows the new marker outlined on the Timeline's ruler,
    // in the Markers panel, and on the Program monitor's bar.
    {
      await kit.getByTestId('film-menu-Window').click()
      await kit.getByTestId('film-control-window.panel.Markers').click()
      await kit.getByTestId('film-markers').waitFor({ timeout: 10000 })
      await person([{ command: 'playhead.set', params: { time: A.start + Math.round(A.duration / 2) } }])
      await playheadSettled()
      let shown = null
      const result = await previewThenCancel({
        open: openFake({ id: 'marker.addFlashCue', family: 'menu', title: 'Flash Cue Marker', prefix: 'flashCue', preview: ['markers'], draft: { name: 'Preview cue' } }),
        change: null,
        expectPreview: async () => {
          const added = kit.locator('[data-testid^="film-marker-"][data-preview="added"]')
          const drawn = await until(async () => (await added.count()) === 1, 60)
          const row = kit.locator('[data-testid^="film-markers-row-"][data-preview="added"]')
          const listed = await until(async () => (await row.count()) === 1, 60)
          const bar = await until(async () => (await kit.locator('.film-monitor-marker[data-preview="added"]').count()) >= 1, 60)
          shown = {
            drawn,
            listed,
            bar,
            title: drawn ? await added.first().getAttribute('title') : null,
            row: listed ? await row.first().locator('.film-markers-name').textContent() : null,
            badges: [await kit.getByTestId('film-timeline-preview-badge').count(), await kit.getByTestId('film-markers-preview-badge').count()],
            strip: await kit.getByTestId('film-preview-diff').count(),
            barMarks: await kit.locator('.film-monitor-marker').evaluateAll((marks) => marks.map((mark) => mark.getAttribute('data-preview'))),
            program: await kit.getByTestId('film-program').count(),
          }
          return drawn && listed && bar && shown.title === 'Preview cue' && shown.row === 'Preview cue' && shown.badges.join() === '1,1' && shown.strip === 0
        },
      })
      step('a markers preview (Flash Cue Marker) outlines the new marker on the ruler, in the Markers panel, and on the Program bar, and Cancel removes it', result.ok, JSON.stringify({ ...result, shown }))
      await kit.getByTestId('film-menu-Window').click()
      await kit.getByTestId('film-control-window.panel.Project').click()
      await kit.getByTestId('film-project').waitFor({ timeout: 10000 })
    }
    // A New Sequence preview lays the new sequence out on the Timeline with a ghost tab, its tracks
    // added, and a press there selects nothing (its clips are the copy's).
    {
      let shown = null
      const result = await previewThenCancel({
        open: openFake({ id: 'sequence.new', family: 'sequence', title: 'New Sequence', prefix: 'newSequence', preview: ['timeline'], draft: { name: 'Cut 2', video: 3, audio: 2 } }),
        change: null,
        expectPreview: async () => {
          const tab = kit.locator('[data-testid^="film-sequence-tab-preview-"][data-preview="added"]')
          const drawn = await until(async () => (await tab.count()) === 1, 60)
          // The track area lays the copy out a render after the tab shows.
          await until(async () => (await kit.locator('[data-testid^="film-preview-track-"][data-preview="added"]').count()) >= 3 && (await kit.locator('.film-clip').count()) === 0, 60)
          shown = {
            drawn,
            name: drawn ? await tab.first().textContent() : null,
            added: await kit.locator('[data-testid^="film-preview-track-"][data-preview="added"]').count(),
            clips: await kit.locator('.film-clip').count(),
          }
          return drawn && shown.name === 'Cut 2' && shown.added >= 3 && shown.clips === 0
        },
      })
      step('a New Sequence preview shows a ghost tab and the new sequence\'s tracks added, and Cancel removes them', result.ok, JSON.stringify({ ...result, shown }))
    }
    // A selection preview in the Project panel (Find, project scope) highlights the matching item, dashed; the real Project selection is unchanged.
    {
      await person([{ command: 'project.select', params: { items: [] } }])
      // An item the panel draws, found by its name.
      const first = kit.locator('[data-testid="film-project"] [data-testid^="film-project-item-"]').first()
      await first.waitFor({ timeout: 10000 })
      const findText = ((await first.locator('.film-project-text').first().textContent()) ?? '').trim()
      const stateBefore = JSON.stringify((await person([{ command: 'state.inspect', params: {} }])).completed[0].result?.project_selection ?? [])
      let shown = null
      const result = await previewThenCancel({
        open: openFake({ id: 'edit.find', family: 'find', title: 'Find', prefix: 'find', preview: ['selection'], draft: { scope: 'project', text: findText } }),
        change: null,
        expectPreview: async () => {
          const drawn = await until(async () => (await kit.locator('[data-testid="film-project"] [data-preview-selected]').count()) > 0, 60)
          shown = {
            drawn,
            findText,
            result: (await previewState()).result,
            highlighted: await kit.locator('[data-testid="film-project"] [data-preview-selected]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid'))),
            selected: await kit.locator('[data-testid="film-project"] [aria-selected="true"][data-testid^="film-project-item-"]').count(),
            real: JSON.stringify((await person([{ command: 'state.inspect', params: {} }])).completed[0].result?.project_selection ?? []),
          }
          return drawn && shown.selected === 0 && shown.real === stateBefore
        },
      })
      step('a selection preview (Find in the project) highlights the match dashed in the Project panel and leaves the real selection as it was', result.ok, JSON.stringify({ ...result, shown }))
    }
    // A project preview (New Color Matte) shows its new item outlined, its icon from the preview's frame.
    {
      let shown = null
      const result = await previewThenCancel({
        open: openFake({ id: 'item.newColorMatte', family: 'tracks', title: 'New Color Matte', prefix: 'colorMatte', preview: ['project'], draft: { color: '#ff0000', seconds: 2 } }),
        change: null,
        expectPreview: async () => {
          const added = kit.locator('[data-testid="film-project"] [data-testid^="film-project-item-"][data-preview="added"]')
          const drawn = await until(async () => (await added.count()) === 1, 60)
          if (drawn) await added.first().scrollIntoViewIfNeeded()
          const red = drawn
            ? await until(
                async () =>
                  added.first().evaluate((element) => {
                    const canvas = element.querySelector('canvas[data-drawn="1"]')
                    if (!canvas?.width) return false
                    const { data } = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
                    return data[0] > 200 && data[1] < 60 && data[2] < 60
                  }),
                80,
              )
            : false
          shown = { drawn, red, badge: await kit.getByTestId('film-project-preview-badge').count(), view: await kit.getByTestId('film-project').getAttribute('data-view') }
          return drawn && red && shown.badge === 1
        },
      })
      step("a project preview (New Color Matte, red) draws its new item outlined with the preview's red icon, and Cancel removes it", result.ok, JSON.stringify({ ...result, shown }))
    }

    // The agent's ai/run runs a dialog's command at once, with no dialog and no preview.
    // Its step is in the agent's own history, and only the agent's undo takes it back (KitModel 1.1 M12a).
    const agentFrom = (await agentHistory()).length
    await agentRun([{ command: 'timeline.select', params: { clips: [A.clip] } }, { command: 'clip.speedDuration', params: {} }])
    const agentRan = (await until(async () => (await agentHistory()).length > agentFrom, 100)) ? true : null
    await paintFrames()
    const agentDialog = await dialogShown()
    const agentPreview = (await previewState()).open
    if (agentRan) await edited(() => agentRun([{ command: 'edit.undo', params: {} }]))
    step("an agent's ai/run of a dialog's command runs it at once, with no dialog and no preview", agentRan != null && agentDialog === 0 && !agentPreview, JSON.stringify({ ran: agentRan != null, agentDialog, agentPreview }))

    // Delete clears the selected clip (a gap stays); Shift+Delete ripple-deletes it. Each key waits
    // for the state it acts on: A selected (in the engine), the Timeline focused, no dialog open.
    const deleteFrom = await keyState()
    // A click on A selects it and focuses the Timeline, as a person does.
    const aMid = mid(await box(A.clip))
    await page.mouse.click(aMid.x, aMid.y)
    // The person's selection, as the Timeline draws it: an agent's inspect answers the agent's own.
    const personSelected = (id) => until(async () => (await kit.getByTestId(`film-clip-${id}`).getAttribute('data-selected')) != null)
    await personSelected(A.clip)
    await until(async () => (await kit.locator('[data-testid="film-workspace-frame-timeline"][data-focused="true"]').count()) === 1 && (await dialogShown()) === 0, 40)
    await kit.locator('.kui-app').focus()
    const clearedFrom = await keyState()
    const cleared = await edited(() => page.keyboard.press('Delete'), async () => !(await v1()).some((item) => item.clip === A.clip))
    const keptB = await clipOf(B.clip)
    const clearedUndone = await edited(undoKey, async () => (await v1()).some((item) => item.clip === A.clip))
    // Upstream's router tries the focused panel's keys first and lets extra Shift through, so in the
    // Timeline Shift+Delete is its Delete (Clear); with another panel focused it is Ripple Delete.
    // The key is the person's, so the person selects A (an agent's timeline.select selects for the agent).
    const aAgain = mid(await box(A.clip))
    await page.mouse.click(aAgain.x, aAgain.y)
    await personSelected(A.clip)
    await kit.getByTestId('film-program').click()
    await until(async () => (await kit.locator('[data-testid="film-workspace-frame-program"][data-focused="true"]').count()) === 1, 40)
    await kit.locator('.kui-app').focus()
    const rippleFrom = await keyState()
    const rippleDeleted = await edited(() => page.keyboard.press('Shift+Delete'), async () => (await clipOf(B.clip)).start < B.start)
    const rippleTo = await keyState()
    await edited(undoKey, async () => (await clipOf(B.clip)).start === B.start)
    const deleted = cleared && keptB.start === B.start && clearedUndone && rippleDeleted && (await v1()).length === 2
    step('Delete clears the clip and leaves the gap; Shift+Delete (Program focused) ripple-deletes; undo restores each', deleted, JSON.stringify(deleted ? { cleared, rippleDeleted } : { cleared, B: keptB?.start, clearedUndone, rippleDeleted, said: await said(), deleteFrom, clearedFrom, rippleFrom, rippleTo }))

    // A drop from the Project panel or the Source monitor (Task 15's drop target) places the item.
    const before = (await v1()).length
    // A's lane drawn and still (the undo before drew the clips again) before the drop reads its place.
    await settledBox(kit.getByTestId(`film-clip-${A.clip}`))
    const dropped = await edited(
      () =>
        kitFrame().evaluate(({ id, item }) => {
          const lane = document.querySelector(`[data-testid="film-clip-${id}"]`).closest('.film-tl-lane')
          const rect = lane.getBoundingClientRect()
          const at = { clientX: rect.left + rect.width * 0.8, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }
          const data = new DataTransfer()
          data.setData('application/x-kition-film-item', JSON.stringify({ item }))
          lane.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer: data }))
          lane.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer: data }))
        }, { id: A.clip, item: media.item }),
      async () => (await v1()).length === before + 1,
    )
    await edited(undoKey, async () => (await v1()).length === before)
    step('a project item dropped on V1 is placed there by timeline.place', dropped, JSON.stringify({ before, after: (await v1()).length, said: await said() }))

    // Effect Controls and Properties (upstream `panels/effect_controls.rs` `show`, `keyframe_nav`,
    // `properties_panel`) on clip A: a typed value, a drag as one history step, a stopwatch and a
    // second keyframe, a keyframe dragged in the lane, its menu, and Properties beside them.
    {
      const fx = async (effect, param) => (await clipOf(A.clip))?.effects?.find((each) => each.effect === effect)?.params?.[param] ?? null
      const number = (param) => Number(/-?\d+(?:\.\d+)?/.exec(param?.value ?? '')?.[0] ?? Number.NaN)
      /** The Program picture's lit samples and a checksum of its pixels. */
      const picture = () =>
        kitFrame().evaluate(() => {
          const canvas = document.querySelector('[data-testid="film-program"] canvas')
          if (!canvas || !canvas.width) return { lit: 0, sum: 0 }
          const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
          let lit = 0
          let sum = 0
          for (let at = 0; at < data.length; at += 16) {
            if (data[at] + data[at + 1] + data[at + 2] > 60) lit += 1
            sum = (sum * 31 + data[at] + data[at + 1] * 3 + data[at + 2] * 7) % 1000000007
          }
          return { lit, sum }
        })
      const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
      const typeInto = async (testId, text) => {
        await kit.getByTestId(`${testId}-value`).click()
        await kit.getByTestId(`${testId}-input`).fill(text)
        await kit.getByTestId(`${testId}-input`).press('Enter')
      }
      await person([
        { command: 'timeline.select', params: { clips: [A.clip] } },
        { command: 'playhead.set', params: { time: A.start + Math.round(A.duration * 0.25) } },
      ])
      await kit.getByTestId('film-workspace-tab-effectControls').click()
      const shown = await until(async () => (await kit.getByTestId('film-ec-motion-scale').count()) === 1 && (await kit.getByTestId('film-properties').count()) === 1)
      await checkIds()
      await until(async () => (await picture()).lit > 100)
      const pictureBefore = await picture()
      const scaled = await edited(() => typeInto('film-ec-motion-scale-value', '50'), async () => number(await fx('motion', 'scale')) === 50)
      // The scaled picture covers less of the frame: fewer lit samples, other pixels.
      const smaller = await until(async () => {
        const now = await picture()
        return now.sum !== pictureBefore.sum && now.lit < pictureBefore.lit
      })
      const keysBack = await kit.locator('.kui-app').evaluate((app) => app.ownerDocument.activeElement === app)
      step('Effect Controls: Scale typed as 50 is set, the Program monitor shows it smaller, and the keys go back to the editor', shown && scaled && smaller && keysBack, JSON.stringify({ shown, scaled, scale: (await fx('motion', 'scale'))?.value, before: pictureBefore, after: await picture(), keysBack }))

      const opacityFrom = number(await fx('opacity', 'opacity'))
      const stepsFrom = await history()
      const hot = await settledBox(kit.getByTestId('film-ec-opacity-opacity-value-value'))
      const dragged = await edited(() => drag(center(hot), { x: center(hot).x - 120, y: center(hot).y }), async () => number(await fx('opacity', 'opacity')) < opacityFrom)
      await settle()
      const stepsTo = await history()
      const draggedTo = number(await fx('opacity', 'opacity'))
      const restored = await edited(undoKey, async () => number(await fx('opacity', 'opacity')) === opacityFrom)
      step('dragging Opacity in Effect Controls is one history step, and one undo restores it', dragged && stepsTo === stepsFrom + 1 && restored, JSON.stringify({ opacityFrom, draggedTo, stepsFrom, stepsTo, restored, said: await said() }))

      const animated = await edited(() => kit.getByTestId('film-ec-motion-position-stopwatch').click(), async () => (await fx('motion', 'position'))?.keyframes?.length === 1)
      await person([{ command: 'playhead.set', params: { time: A.start + Math.round(A.duration * 0.75) } }])
      const off = await until(async () => (await kit.getByTestId('film-ec-motion-position-nav-add').getAttribute('aria-pressed')) === 'false')
      const second = await edited(() => typeInto('film-ec-motion-position-value-x', '100'), async () => (await fx('motion', 'position'))?.keyframes?.length === 2)
      const lane = kit.getByTestId('film-ec-motion-position-lane')
      const laneKeys = () => lane.locator('.kui-keyframe').evaluateAll((items) => items.map((item) => item.dataset.keyframeId))
      const drawn = await until(async () => (await laneKeys()).length === 2)
      step('the Position stopwatch, then a change after moving the playhead: two keyframes, both in the lane', animated && off && second && drawn, JSON.stringify({ animated, off, second, keyframes: (await fx('motion', 'position'))?.keyframes, lane: await laneKeys() }))

      const keysBefore = await laneKeys()
      const laneBox = await settledBox(lane)
      const later = center(await settledBox(lane.locator('.kui-keyframe').nth(1)))
      const movedKey = await edited(() => drag(later, { x: later.x - laneBox.width * 0.2, y: later.y }), async () => {
        const now = await laneKeys()
        return now.length === 2 && JSON.stringify(now) !== JSON.stringify(keysBefore)
      })
      const keysAfter = await laneKeys()
      step('dragging a keyframe in the lane moves its time', movedKey && Number(keysAfter[1]) < Number(keysBefore[1]) && keysAfter[0] === keysBefore[0], JSON.stringify({ keysBefore, keysAfter, said: await said() }))

      await lane.locator('.kui-keyframe').nth(0).click({ button: 'right' })
      await kit.getByTestId('film-ec-menu-hold').waitFor({ timeout: 5000 })
      await checkIds()
      const held = await edited(() => kit.getByTestId('film-ec-menu-hold').click(), async () => (await lane.locator('.kui-keyframe').nth(0).getAttribute('data-shape')) === 'square')
      step("a keyframe's menu sets Hold, drawn as a square", held, JSON.stringify({ shape: await lane.locator('.kui-keyframe').nth(0).getAttribute('data-shape') }))

      const viaProperties = await edited(() => typeInto('film-props-opacity-opacity', '70'), async () => number(await fx('opacity', 'opacity')) === 70)
      const inEffectControls = await until(async () => (await kit.getByTestId('film-ec-opacity-opacity-value-value').textContent()) === '70.0%')
      step('Properties ▸ Opacity 70 is set, and Effect Controls shows it', viaProperties && inEffectControls, JSON.stringify({ viaProperties, shown: await kit.getByTestId('film-ec-opacity-opacity-value-value').textContent() }))

      // An effect's own menu (upstream: Save Preset…, and Clear for an effect that is not fixed).
      await kit.getByTestId('film-ec-effect-opacity').click({ button: 'right' })
      const effectMenu = await kit.getByTestId('film-ec-menu-save-preset').waitFor({ timeout: 5000 }).then(() => true, () => false)
      const fixedHasNoClear = (await kit.getByTestId('film-ec-menu-remove').count()) === 0
      await checkIds()
      await page.keyboard.press('Escape')
      step("an effect's menu offers Save Preset…, and no Clear for a fixed effect", effectMenu && fixedHasNoClear, JSON.stringify({ effectMenu, fixedHasNoClear }))

      // A text parameter (a text layer's Source Text): Escape leaves it and the history as they
      // were; ending a hot number's edit by clicking the text field leaves the focus there.
      const made = await person([{ command: 'graphics.newText', params: { text: 'Hello', position: [200, 200] } }])
      const textClip = made.completed[0].result?.clip
      await person([{ command: 'timeline.select', params: { clips: [textClip] } }])
      const sourceText = kit.getByTestId('film-ec-graphic_text-text-value')
      const textShown = await sourceText.waitFor({ timeout: 10000 }).then(() => true, () => false)
      const textOf = async () => (await clipOf(textClip))?.effects?.find((each) => each.effect === 'graphic_text')?.params?.text?.value ?? null
      const textBefore = await textOf()
      const textSteps = await history()
      await sourceText.click()
      await sourceText.fill('Typed then dropped')
      await sourceText.press('Escape')
      await settle()
      const kept = (await textOf()) === textBefore && (await history()) === textSteps && (await sourceText.inputValue()) === 'Hello'
      step('Escape in a text parameter keeps its value and makes no history step', textShown && kept, JSON.stringify({ textShown, before: textBefore, after: await textOf(), steps: [textSteps, await history()], shown: await sourceText.inputValue().catch(() => null) }))

      await kit.getByTestId('film-ec-motion-scale-value-value').click()
      await kit.getByTestId('film-ec-motion-scale-value-input').fill('90')
      await sourceText.click()
      await kitFrame().evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await paintFrames()
      const focusedField = await kitFrame().evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.className ?? null)
      const scaleSet = await until(async () => number(await fx('motion', 'scale')) === 90 || number((await clipOf(textClip))?.effects?.find((each) => each.effect === 'motion')?.params?.scale) === 90)
      await sourceText.press('Escape')
      step('a hot number ended by clicking a text field commits, and the focus stays in the text field', focusedField === 'film-ec-graphic_text-text-value' && scaleSet, JSON.stringify({ focusedField, scaleSet }))
    }
    // On the empty Timeline (no sequence open), a dropped item makes a sequence from it (upstream `empty_state`).
    const project = async () => (await details()).project
    const sequenceCount = async () => {
      const count = (node) => (node?.children ?? []).reduce((total, child) => total + (child.children ? count(child) : child.type === 'Sequence' ? 1 : 0), 0)
      return count((await project())?.root)
    }
    const sequencesBefore = await sequenceCount()
    // The person closes every open sequence from its tab (the open sequences are each origin's own;
    // an agent's sequence.close closes the agent's).
    const closeTab = kit.locator('[data-kit-ui-id="control:timeline.tab.close"]')
    for (let open = await closeTab.count(); open > 0; open = await closeTab.count()) {
      await closeTab.first().click()
      await until(async () => (await closeTab.count()) < open, 50)
    }
    await kit.getByTestId('film-timeline-empty').waitFor({ timeout: 10000 })
    const made = await edited(
      () =>
        kitFrame().evaluate((item) => {
          const empty = document.querySelector('[data-testid="film-timeline-empty"]')
          const rect = empty.getBoundingClientRect()
          const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }
          const data = new DataTransfer()
          data.setData('application/x-kition-film-item', JSON.stringify({ item }))
          empty.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer: data }))
          empty.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer: data }))
        }, media.item),
      async () => (await sequenceCount()) === sequencesBefore + 1 && (await project())?.activeSequence != null,
    )
    step('an item dropped on the empty Timeline makes a sequence from it', made && (await kit.getByTestId('film-timeline-empty').count()) === 0, JSON.stringify({ sequencesBefore, after: await sequenceCount(), said: await said() }))

    // Markers (upstream `misc.rs` `markers`): both of two markers are listed, and a click on the second moves the playhead to it.
    const markersOf = async () => [...((await seq()).markers ?? [])].sort((a, b) => a.start - b.start)
    const markersBefore = (await markersOf()).length
    // Added at the playhead, as M does, so each sits on a frame.
    await edited(
      () => person([{ command: 'playhead.set', params: { frame: 3 } }, { command: 'marker.add', params: { name: 'First' } }, { command: 'playhead.set', params: { frame: 12 } }, { command: 'marker.add', params: { name: 'Second' } }, { command: 'playhead.set', params: { frame: 0 } }]),
      async () => (await markersOf()).length === markersBefore + 2,
    )
    await kit.getByTestId('film-menu-Window').click()
    await kit.getByTestId('film-control-window.panel.Markers').click()
    const markerList = await markersOf()
    const listedBoth = await until(async () => (await kit.locator('[data-testid^="film-markers-row-"]').count()) === markerList.length && markerList.length >= 2)
    await checkIds()
    const second = markerList.find((marker) => marker.name === 'Second')
    await kit.getByTestId(`film-markers-row-${second.id}`).click()
    const wentToSecond = await until(async () => (await details()).playhead === second.start)
    step('two markers are listed in the Markers panel, and a click on the second goes to it', listedBoth && wentToSecond, JSON.stringify({ rows: await kit.locator('[data-testid^="film-markers-row-"]').allTextContents(), playhead: (await details()).playhead, second: second.start }))
    // The colour filter hides a colour's markers and shows them again (`marker.filterColors`).
    await kit.getByTestId('film-markers-filter-Green').click()
    const filtered = await until(async () => (await kit.locator('[data-testid^="film-markers-row-"]').count()) === markerList.filter((marker) => marker.color !== 'Green').length)
    await kit.getByTestId('film-markers-filter-Green').click()
    const unfiltered = await until(async () => (await kit.locator('[data-testid^="film-markers-row-"]').count()) === markerList.length)
    step('the Markers colour filter hides the green markers and shows them again', filtered && unfiltered, JSON.stringify({ shown: await kit.locator('[data-testid^="film-markers-row-"]').count() }))

    // History (upstream `misc.rs` `history`): Open goes back to the document as opened, the last step restores it.
    await kit.getByTestId('film-menu-Window').click()
    await kit.getByTestId('film-control-window.panel.History').click()
    const steps = await history()
    const historyRows = () => kit.locator('[data-testid^="film-history-row-"]').count()
    await until(async () => (await historyRows()) === steps + 1)
    await checkIds()
    // The project's bins and items, which every step changes: the sequence made, the markers in it.
    const projectState = async () => JSON.stringify((await project())?.root)
    const restoredState = await projectState()
    await kit.getByTestId('film-history-row-0').click()
    const wentBack = await until(async () => (await history()) === 0 && !(await inspect()).canUndo, 100)
    const backState = await projectState()
    await until(async () => (await historyRows()) === steps + 1 && (await kit.getByTestId('film-history-row-0').getAttribute('aria-current')) === 'step')
    await kit.getByTestId(`film-history-row-${steps}`).click()
    const restored = await until(async () => (await history()) === steps && (await projectState()) === restoredState, 100)
    step('History: Open undoes every step, and the last step redoes them all', wentBack && backState !== restoredState && restored, JSON.stringify({ steps, after: await history(), wentBack, restored }))
    // Left and Right undo and redo while History has focus (the engine's History table).
    await kit.getByTestId(`film-history-row-${steps}`).focus()
    await page.keyboard.press('ArrowLeft')
    const leftUndid = await until(async () => (await history()) === steps - 1)
    await page.keyboard.press('ArrowRight')
    const rightRedid = await until(async () => (await history()) === steps)
    step('with History focused, Left undoes one step and Right redoes it', leftUndid && rightRedid, JSON.stringify({ steps, now: await history() }))

    // Info (upstream `misc.rs` `info`): the item selected in the Project panel, with its duration.
    // A click on the first item the Project panel shows selects it (its tab lies past the strip's » while History is shown).
    await kit.getByTestId('film-menu-Window').click()
    await kit.getByTestId('film-control-window.panel.Project').click()
    const shownItem = kit.locator('[data-testid^="film-project-item-"]').first()
    const infoItem = Number((await shownItem.getAttribute('data-testid', { timeout: 10000 })).slice('film-project-item-'.length))
    await shownItem.click()
    await until(async () => JSON.stringify((await person([{ command: 'state.inspect', params: {} }])).completed[0].result.project_selection) === JSON.stringify([infoItem]))
    await kit.getByTestId('film-menu-Window').click()
    await kit.getByTestId('film-control-window.panel.Info').click()
    const listedDuration = (await person([{ command: 'project.items', params: { recursive: true } }])).completed[0].result.rows.find((row) => row.item === infoItem)?.info?.mediaDuration
    const infoShows = await until(async () => {
      const text = (await kit.getByTestId('film-info-item').textContent({ timeout: 500 })) ?? ''
      return listedDuration != null && text.includes(listedDuration)
    })
    await checkIds()
    step("Info shows the selected item's duration, and the sequence's playhead", infoShows && (await kit.getByTestId('film-info-sequence').count()) === 1, JSON.stringify({ infoItem, listedDuration, shown: await kit.getByTestId('film-info').textContent().catch(() => null) }))
  }

  // The workspace (upstream `dock.rs`, `header.rs`, `panels/workspaces.rs`): frames of a split
  // tree, the nine built-in workspaces, Window ▸ <panel>, maximize, and named workspaces shared
  // by every Film page through the kit store.
  const frames = (on = kit) => on.locator('.kui-ws-frame').evaluateAll((items) => items.map((item) => item.getAttribute('data-kit-ui-id')))
  /** Each group's active tab of a manifest tree, in drawn order (`panel:<id>`). */
  const activeTabs = (node) => ('split' in node ? [...activeTabs(node.a), ...activeTabs(node.b)] : [`panel:${node.tabs[node.active]}`])
  const slug = (name) => name.toLowerCase().replaceAll(' ', '')
  const switchWorkspace = async (on, name) => {
    await on.getByTestId('film-header-workspaces').click()
    await on.getByTestId(`film-workspaces-${slug(name)}`).click()
  }
  // A second editor page (another dev.html) opens now, before the first saves a workspace.
  const page2 = await context.newPage()
  page2.on('pageerror', (error) => errors.push(`page 2: ${error.message}`))
  await page2.goto(`${origin}/dev.html`)
  await page2.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
  const kit2 = page2.frameLocator('#kit')
  await kit2.locator('.kui-ws-frame').first().waitFor({ timeout: 10000 })
  await page.bringToFront()
  const wrong = []
  // The built-in workspaces the editor offers (presets.ts WEB_WORKSPACES): upstream's trees without the
  // panels it does not draw, and without the workspaces made of those only (Color, Audio, Captions and Graphics).
  for (const [name, layout] of Object.entries(WEB_WORKSPACES)) {
    await switchWorkspace(kit, name)
    const want = activeTabs(layout)
    const shown = await until(async () => JSON.stringify(await frames()) === JSON.stringify(want), 30)
    const label = await kit.getByTestId('film-header-workspaces').textContent()
    if (!shown || label.trim() !== zh(name).toUpperCase()) wrong.push(`${name}: ${JSON.stringify(await frames())} under ${label}`)
  }
  step('every offered built-in workspace switches, and its frames are the manifest tree without the panels the editor does not draw', wrong.length === 0, wrong.slice(0, 2).join('; '))
  // Upstream's Effects layout lists Effect Controls twice; the editor keeps the first only.
  await switchWorkspace(kit, 'Effects')
  const errorsBefore = consoleErrors.length
  await kit.getByTestId('film-menu-Window').click()
  await kit.getByTestId('film-control-window.panel.EffectControls').click()
  await until(async () => (await kit.getByTestId('film-workspace-frame-effectControls').count()) === 1)
  const effectFrames = await kit.locator('.kui-ws-frame[data-panel="effectControls"]').count()
  const effectTabs = await kit.locator('[data-testid="film-workspace-tab-effectControls"]').count()
  const keyWarnings = consoleErrors.slice(errorsBefore).filter((text) => /same key|unique "key"/.test(text))
  step('Effects, then Window ▸ Effect Controls: one frame, one tab, no React key warning', effectFrames === 1 && effectTabs === 1 && keyWarnings.length === 0, JSON.stringify({ effectFrames, effectTabs, keyWarnings: keyWarnings.slice(0, 1) }))
  await switchWorkspace(kit, 'Editing')
  await until(async () => (await frames()).length === activeTabs(WEB_WORKSPACES.Editing).length)
  const editingFrames = await frames()
  await kit.getByTestId('film-menu-Window').click()
  await kit.getByTestId('film-control-window.panel.EffectControls').click()
  await until(async () => (await kit.getByTestId('film-workspace-frame-effectControls').count()) === 1)
  step('Window ▸ Effect Controls shows it in its frame and focuses it', (await kit.getByTestId('film-workspace-frame-effectControls').getAttribute('data-focused')) === 'true')
  // History sits past the Project frame's » in Editing: show it, then close it from its panel menu.
  await kit.getByTestId('film-menu-Window').click()
  await kit.getByTestId('film-control-window.panel.History').click()
  await kit.getByTestId('film-workspace-tab-history').click({ button: 'right' })
  await kit.getByTestId('film-workspace-menu-history-close').click()
  const closed = await until(async () => (await kit.getByTestId('film-workspace-tab-history').count()) === 0)
  await kit.getByTestId('film-menu-Window').click()
  await kit.getByTestId('film-control-window.panel.History').click()
  await until(async () => (await kit.getByTestId('film-workspace-frame-history').count()) === 1)
  const nearProject = (await kit.getByTestId('film-workspace-frame-history').getByTestId('film-workspace-tab-project').count()) === 1
  step('closing History and then Window ▸ History brings it back near Project', closed && nearProject, JSON.stringify({ closed, nearProject }))
  // ` maximizes the frame under the pointer, and again restores the layout.
  const program = await settledBox(kit.getByTestId('film-workspace-frame-program'))
  await page.mouse.move(program.x + program.width / 2, program.y + program.height / 2)
  await kit.locator('.kui-app').focus()
  const framesBefore = await frames()
  await page.keyboard.press('`')
  const maxed = await until(async () => JSON.stringify(await frames()) === JSON.stringify(['panel:program']))
  await page.keyboard.press('`')
  const restored = await until(async () => JSON.stringify(await frames()) === JSON.stringify(framesBefore))
  step('` maximizes the frame under the pointer and restores it', maxed && restored, JSON.stringify(await frames()))
  // Save as New Workspace "Cut": it joins Window ▸ Workspaces, sorted, and becomes the workspace in use.
  const workspaceRows = async (on) => {
    await on.getByTestId('film-menu-Window').click()
    await on.locator('[data-kit-ui-id="menu:Window/Workspaces"]').hover()
    await on.getByTestId('film-control-window.workspace.editing').waitFor({ timeout: 5000 })
    const rows = await on.locator('[data-kit-ui-id^="control:window.workspace."]').evaluateAll((items) => items.map((item) => item.querySelector(':scope > span:not([style])')?.textContent ?? ''))
    return rows
  }
  await workspaceRows(kit)
  await kit.getByTestId('film-control-window.workspace.saveAs').click()
  await kit.getByTestId('film-workspace-save-name').fill('Cut')
  await kit.getByTestId('film-workspace-save-ok').click()
  await until(async () => (await kit.getByTestId('film-header-workspaces').textContent()).trim() === zh('Cut').toUpperCase())
  const rows = await workspaceRows(kit)
  await page.keyboard.press('Escape')
  // Upstream sorts the names as they are and draws each through its catalog (`crate::i18n::t`), a person's own too.
  const actions = ['Reset to Saved Layout', 'Save Changes to this Workspace', 'Save as New Workspace…', 'Edit Workspaces…'].map(zh)
  const names = rows.filter((row) => !actions.includes(row))
  const sorted = [...Object.keys(WEB_WORKSPACES), 'Cut'].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map(zh)
  step('Save as New Workspace "Cut" lists it in Window ▸ Workspaces, sorted', JSON.stringify(names) === JSON.stringify(sorted) && (await kit.getByTestId('film-header-workspaces').textContent()).trim() === zh('Cut').toUpperCase(), JSON.stringify(names))
  // The other page sees "Cut" too, and keeps its own live layout and workspace.
  await page2.bringToFront()
  const rows2 = await until(async () => {
    const found = (await workspaceRows(kit2)).includes('Cut')
    await page2.keyboard.press('Escape')
    return found
  }, 20)
  const frames2 = await frames(kit2)
  const label2 = (await kit2.getByTestId('film-header-workspaces').textContent()).trim()
  step('a second editor page sees "Cut" in its Workspaces menu, and its layout is unchanged', rows2 && JSON.stringify(frames2) === JSON.stringify(editingFrames) && label2 === 'EDITING', JSON.stringify({ rows2, frames2, label2 }))
  await page2.close()
  await page.bringToFront()
  // Edit Workspaces renames "Cut" (the page follows it) and deletes it (the page falls back to Editing), with no prompt, as upstream.
  await workspaceRows(kit)
  await kit.getByTestId('film-control-window.workspace.edit').click()
  await kit.locator('[role="option"]', { hasText: new RegExp(`^${escapeRegExp(zh('Cut'))}$`) }).click()
  await kit.getByTestId('film-workspace-edit-name').fill('Rough Cut')
  await kit.getByTestId('film-workspace-edit-rename').click()
  const renamed = await until(async () => (await kit.getByTestId('film-header-workspaces').textContent()).trim() === 'ROUGH CUT')
  await kit.getByTestId('film-workspace-edit-delete').click()
  const deleted = await until(async () => (await kit.getByTestId('film-header-workspaces').textContent()).trim() === zh('Editing').toUpperCase())
  const listed = await kit.locator('[role="option"]').allTextContents()
  await kit.getByTestId('film-workspace-edit-close').click()
  step('Edit Workspaces renames and deletes a workspace of the person\'s own', renamed && deleted && !listed.some((name) => /Cut/.test(name) || name === zh('Cut')), JSON.stringify({ renamed, deleted, listed }))
  // At 1100×700 the Tools frame is too short for 8 groups: as upstream, only the groups that fit
  // are drawn, and the others are not in the page (nothing to reach by pointer or Tab). Then, with
  // no Tools frame on screen (the Timeline maximized), the editor still moves off a tool the host
  // denies.
  {
    const small = await browser.newContext({ viewport: { width: 1100, height: 700 } })
    const page3 = await small.newPage()
    page3.on('pageerror', (error) => errors.push(`1100×700: ${error.message}`))
    await page3.goto(`${origin}/dev.html`)
    await page3.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
    const kit3 = page3.frameLocator('#kit')
    const tools3 = kit3.getByTestId('film-tools')
    await tools3.waitFor({ timeout: 10000 })
    await paintFrames(page3, 4)
    const frameBox = await settledBox(kit3.getByTestId('film-workspace-frame-tools'))
    const drawn = await tools3.locator('[data-kit-ui-id^="tool:"]').evaluateAll((items) => items.map((item) => item.getAttribute('data-kit-ui-id')))
    const firsts = []
    for (const tool of manifest.tools) if (tool.slot === 0) firsts.push(`tool:${tool.id}`)
    const groupCount = Number(await tools3.getAttribute('data-groups'))
    const buttons = await tools3.locator('button').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().bottom))
    const frameBottom = await kit3.getByTestId('film-workspace-frame-tools').evaluate((item) => item.getBoundingClientRect().bottom)
    const allInside = buttons.every((bottom) => bottom <= frameBottom)
    const typeAbsent = (await kit3.locator('[data-kit-ui-id="tool:Type"], [data-kit-ui-id="tool:VerticalType"]').count()) === 0
    step(
      'at 1100×700 the Tools frame draws only the groups that fit, and none it leaves out',
      groupCount === 7 && JSON.stringify(drawn) === JSON.stringify(firsts.slice(0, 7)) && allInside && typeAbsent,
      JSON.stringify({ height: Math.round(frameBox.height), groupCount, drawn, allInside, typeAbsent }),
    )
    const hint3 = () => kit3.getByTestId('film-hint').textContent({ timeout: 1000 }).catch(() => '')
    await kit3.locator('.kui-app').focus()
    await page3.keyboard.press('c')
    const razor = await until(async () => (await hint3()) === hintFor('Razor'), 20)
    const timeline3 = await settledBox(kit3.getByTestId('film-workspace-frame-timeline'))
    await page3.mouse.move(timeline3.x + timeline3.width / 2, timeline3.y + timeline3.height / 2)
    await kit3.locator('.kui-app').focus()
    await page3.keyboard.press('`')
    const noTools = await until(async () => (await kit3.getByTestId('film-tools').count()) === 0, 20)
    await page3.evaluate(() => window.devHost.configure({ hide: [], disable: ['tool:Razor'] }))
    const movedOff = await until(async () => (await hint3()) === hintFor('Selection'), 20)
    step('with no Tools frame on screen, a denied active tool gives way to the first allowed one', razor && noTools && movedOff, JSON.stringify({ razor, noTools, movedOff }))
    // The status bar stays one line at 1100×700 with the hint, the summary, Unsaved changes, and
    // Edited by the agent: the hint gives way, cut with an ellipsis (upstream draws one line).
    await page3.evaluate(async () => window.devHost.connection().ai.run([{ command: 'marker.add', params: {} }], false))
    await kit3.getByTestId('film-unsaved').waitFor({ timeout: 5000 }).catch(() => undefined)
    await kit3.locator('.kui-agent-edited').waitFor({ timeout: 5000 }).catch(() => undefined)
    const statusLine = await kit3.locator('.kui-status-bar').evaluate((bar) => {
      const box = bar.getBoundingClientRect()
      const parts = [...bar.children].filter((child) => child.getBoundingClientRect().width > 0)
      return {
        height: Math.round(box.height),
        lines: parts.map((child) => Math.round(child.getBoundingClientRect().height)),
        inside: parts.every((child) => child.getBoundingClientRect().right <= box.right + 0.5 && child.getBoundingClientRect().left >= box.left - 0.5),
        cut: (() => {
          const hint = bar.querySelector('.film-message')
          return hint ? hint.scrollWidth > hint.clientWidth : null
        })(),
        texts: parts.map((child) => (child.textContent ?? '').slice(0, 24)),
      }
    })
    step('at 1100×700 the status bar is one line: the hint gives way to the summary and the notes', statusLine.height <= 30 && statusLine.lines.every((height) => height <= 20) && statusLine.inside && statusLine.cut === true && statusLine.texts.length >= 4, JSON.stringify(statusLine))
    await small.close()
  }
  // At 1440×900 on a 2× screen the Program renders at 3/4 while paused and 1/2 while playing: a
  // stop changes the render scale and repaints, and the playhead stays where playback stopped.
  {
    const hidpi = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    const page4 = await hidpi.newPage()
    page4.on('pageerror', (error) => errors.push(`2x: ${error.message}`))
    await page4.goto(`${origin}/dev.html`)
    await page4.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60000 })
    const kit4 = page4.frameLocator('#kit')
    await kit4.getByTestId('film-program').waitFor({ timeout: 10000 })
    await waitForEngine(page4, (state) => state.details?.sequence != null, { timeout: 30000 })
    const details4 = async () => (await page4.evaluate(async () => window.devHost.connection().ai.inspect())).details
    const scale4 = () => kit4.getByTestId('film-program').getAttribute('data-render-scale')
    await until(async () => (await scale4()) != null)
    const pausedScale = await scale4()
    await kit4.getByTestId('film-program-transport-playback.toggle').click()
    const playingScale = (await until(async () => (await scale4()) !== pausedScale, 30)) ? await scale4() : null
    await hold(800, page4)
    await kit4.getByTestId('film-program-transport-playback.toggle').click()
    await until(async () => (await scale4()) === pausedScale, 30)
    await playheadSettled(page4)
    const sequence4 = await details4()
    const rate4 = sequence4.sequence.settings.frame_rate
    const frames4 = Math.floor((sequence4.playhead * rate4.num) / (254016000000 * rate4.den) + 1e-6)
    const base4 = Math.ceil(rate4.num / rate4.den - 1e-9)
    const pad = (value) => String(value).padStart(2, '0')
    const expected4 = `${pad(Math.floor(frames4 / base4 / 3600))}:${pad(Math.floor(frames4 / base4 / 60) % 60)}:${pad(Math.floor(frames4 / base4) % 60)}:${pad(frames4 % base4)}`
    const shown4 = await kit4.getByTestId('film-timecode').textContent()
    step('on a 2× screen a Program stop changes the render scale and leaves the playhead where it stopped', playingScale != null && sequence4.playhead > 0 && shown4 === expected4, JSON.stringify({ pausedScale, playingScale, playhead: sequence4.playhead, shown4, expected4 }))
    await hidpi.close()
  }
  // ---- The engine's events, the status bar, the remaining keys, and every panel's ids (Task 21).
  {
    const person = personRun
    const tabActive = (panel) => kit.getByTestId(`film-workspace-tab-${panel}`).getAttribute('aria-selected').then((value) => value === 'true').catch(() => false)
    // A tab the strip has no room for is reached through its frame's » list, as upstream's.
    const showTab = async (panel) => {
      const tab = kit.getByTestId(`film-workspace-tab-${panel}`)
      // The Timeline's tab is its strip of sequence tabs (upstream's), drawn over it while it is shown.
      if (await tabActive(panel)) return undefined
      if ((await tab.evaluate((element) => element.getBoundingClientRect().width)) > 0) return tab.click()
      const more = await tab.evaluate((element) => element.closest('.kui-ws-frame')?.querySelector('.kui-ws-more')?.getAttribute('data-testid') ?? null)
      if (!more) throw new Error(`no room for the ${panel} tab, and no » list`)
      await kit.getByTestId(more).click()
      await kit.getByTestId(`${more}-${panel}`).click()
    }
    await kit.getByTestId('film-header-workspaces').click()
    await kit.getByTestId('film-workspaces-editing').click()
    await kit.getByTestId('film-workspace-tab-effectControls').click()
    // A toast the engine raises shows as a toast (upstream's Event::Toast): Shift+S toggles audio during scrubbing.
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('Shift+S')
    const toasted = await until(async () => (await kit.locator('.kui-toast', { hasText: new RegExp(`^(${escapeRegExp(zh('Audio during scrubbing on'))}|${escapeRegExp(zh('Audio during scrubbing off'))})$`) }).count()) > 0, 40)
    await hold(400)
    const toasts = await kit.locator('.kui-toast', { hasText: new RegExp(`^(${escapeRegExp(zh('Audio during scrubbing on'))}|${escapeRegExp(zh('Audio during scrubbing off'))})$`) }).count()
    await page.keyboard.press('Shift+S')
    step("the engine's toasts show as toasts, each once (Shift+S, Toggle Audio During Scrubbing)", toasted && toasts === 1, await kit.locator('.kui-toast').allTextContents().then((all) => JSON.stringify({ toasts, all })))
    // The status bar's message clears on a click anywhere on the bar, and by itself after its time
    // (8 s; the development build's window.filmStatusMs shortens it here).
    const fail = async () => {
      // Reveal Nested Sequence (Cmd+Alt+F) with no nested sequence selected: the engine refuses it.
      await person([{ command: 'timeline.select', params: { clips: [] } }])
      await kit.locator('.kui-app').focus()
      await page.keyboard.press('ControlOrMeta+Alt+f')
      return until(async () => (await kit.getByTestId('film-message').count()) === 1, 40)
    }
    const saidFirst = await fail()
    await kit.getByTestId('film-status').click()
    const clicked = await until(async () => (await kit.getByTestId('film-message').count()) === 0, 20)
    await kitFrame().evaluate(() => (window.filmStatusMs = 1500))
    const saidAgain = await fail()
    const shownFor = await kitFrame().evaluate(() => performance.now())
    const cleared = await until(async () => (await kit.getByTestId('film-message').count()) === 0, 60)
    const clearedAfter = (await kitFrame().evaluate(() => performance.now())) - shownFor
    await kitFrame().evaluate(() => delete window.filmStatusMs)
    step('a status message clears on a click on the bar, and by itself after its time', saidFirst && clicked && saidAgain && cleared && clearedAfter >= 1200, JSON.stringify({ saidFirst, clicked, saidAgain, cleared, clearedAfter: Math.round(clearedAfter) }))
    // Match Frame (F) opens the clip under the playhead in the Source monitor and brings its tab forward (Event::OpenSource).
    const v1 = (await details()).sequence.video[0].items ?? []
    const under = v1[0]
    await person([{ command: 'playhead.set', params: { time: Math.round(under.start + under.duration / 2) } }])
    const sourceBefore = await tabActive('source')
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('f')
    const sourceShown = await until(async () => await tabActive('source'), 40)
    step('Match Frame brings the Source monitor forward, as upstream (Event::OpenSource)', !sourceBefore && sourceShown, JSON.stringify({ sourceBefore, sourceShown }))
    // Reveal Sequence in Project shows the Project panel (Event::RevealInProject) with the sequence selected.
    await showTab('history')
    await kit.getByTestId('film-workspace-menu-timeline').click()
    await kit.getByTestId('film-timeline-reveal').click()
    const sequenceItem = (await details()).project?.activeSequence
    const revealed = await until(async () => (await tabActive('project')) && (await kit.locator(`[data-testid="film-project-item-${sequenceItem}"][aria-selected="true"], [data-testid="film-project-item-${sequenceItem}"][data-selected="true"]`).count()) === 1, 40)
    step('Reveal Sequence in Project shows the Project panel with the sequence selected (Event::RevealInProject)', revealed, JSON.stringify({ sequenceItem, project: await tabActive('project') }))
    // A project.select (the person's, as a panel runs it) changes no revision: Info follows it anyway (the session state is read after every refresh).
    await showTab('info')
    const items = []
    const collect = (node) => {
      if (node?.item != null && node.name) items.push(node)
      for (const child of node?.children ?? []) collect(child)
    }
    collect((await details()).project?.root)
    const named = items.filter((item, index) => items.findIndex((other) => other.name === item.name) === index).slice(0, 2)
    const infoName = () => kit.getByTestId('film-info-item').locator('.film-info-title').textContent({ timeout: 300 }).catch(() => null)
    const revisionBefore = (await inspect()).revision
    await person([{ command: 'project.select', params: { items: [named[0].item] } }])
    const firstShown = await until(async () => (await infoName()) === named[0].name, 40)
    await person([{ command: 'project.select', params: { items: [named[1].item] } }])
    const secondShown = await until(async () => (await infoName()) === named[1].name, 40)
    step('Info follows a project.select, which moves no revision', named.length === 2 && firstShown && secondShown && (await inspect()).revision === revisionBefore, JSON.stringify({ named: named.map((item) => item.name), firstShown, secondShown, shown: await infoName() }))
    // The engine's wave-1 keys run in the editor: Home and End, Down to the next edit, D selects the clip at the playhead, ] raises its volume.
    await kit.getByTestId('film-workspace-tab-project').click()
    const focusTimeline = async () => {
      const lane = await settledBox(kit.getByTestId('film-track-Video 1'))
      await page.mouse.click(lane.x + 2, lane.y - 30)
      await kit.locator('.kui-app').focus()
    }
    await focusTimeline()
    await person([{ command: 'playhead.set', params: { seconds: 0.5 } }, { command: 'timeline.select', params: { clips: [] } }])
    const keyed = {}
    await page.keyboard.press('End')
    keyed.end = await until(async () => (await details()).playhead > 0 && (await details()).playhead >= ((await details()).sequence.duration ?? 0) - 254016000000, 40)
    await page.keyboard.press('Home')
    keyed.home = await until(async () => (await details()).playhead === 0, 40)
    await page.keyboard.press('ArrowDown')
    keyed.down = await until(async () => (await details()).playhead > 0, 40)
    await person([{ command: 'playhead.set', params: { time: Math.round(under.start + under.duration / 2) } }])
    await page.keyboard.press('d')
    keyed.d = await until(async () => ((await details()).sequence.selection ?? []).includes(under.clip), 40)
    const volume = async () => ((await details()).sequence.video[0].items ?? []).concat(...((await details()).sequence.audio ?? []).map((track) => track.items ?? [])).find((item) => item.clip === under.clip)
    const volumeBefore = JSON.stringify(await volume())
    const volumeFrom = (await inspect()).revision
    await page.keyboard.press(']')
    keyed.bracket = await until(async () => (await inspect()).revision > volumeFrom, 40)
    if (keyed.bracket) await page.keyboard.press('ControlOrMeta+z')
    step("the engine's wave-1 keys run in the editor (End, Home, Down, D, ])", Object.values(keyed).every(Boolean), JSON.stringify({ keyed, changed: volumeBefore !== JSON.stringify(await volume()) }))
    // View ▸ Dynamic Audio Waveforms toggles the waveform scale; the row is checked while on.
    const waveform = kit.locator('[data-testid="film-clip-waveform"]').first()
    const pixels = () => waveform.evaluate((canvas) => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let lit = 0
      for (let i = 3; i < data.length; i += 4) lit += data[i] > 0 ? 1 : 0
      return lit
    }).catch(() => null)
    const dynamicRow = () => kit.locator('[data-kit-ui-id="control:view.dynamicAudioWaveforms"]')
    await kit.getByTestId('film-menu-View').click()
    const checkedOn = await dynamicRow().getAttribute('aria-checked')
    const litOn = await pixels()
    await dynamicRow().click()
    await until(async () => (await pixels()) !== litOn, 30)
    const litOff = await pixels()
    await kit.getByTestId('film-menu-View').click()
    const checkedOff = await dynamicRow().getAttribute('aria-checked')
    await dynamicRow().click()
    step('View ▸ Dynamic Audio Waveforms switches the waveforms between logarithmic and linear, and is checked while on', checkedOn === 'true' && checkedOff === 'false' && litOn != null && litOff != null && litOff < litOn, JSON.stringify({ checkedOn, checkedOff, litOn, litOff }))
    // The divider shares the height between the halves; a track header's bottom edge resizes its tracks.
    const header = (name) => settledBox(kit.getByTestId(`film-track-${name}-header`))
    const audioBefore = await header('A1')
    await page.mouse.move(audioBefore.x + audioBefore.width / 2, audioBefore.y + audioBefore.height - 1)
    await page.mouse.down()
    await page.mouse.move(audioBefore.x + audioBefore.width / 2, audioBefore.y + audioBefore.height + 15, { steps: 4 })
    await page.mouse.up()
    const audioAfter = await header('A1')
    const divider = await settledBox(kit.getByTestId('film-timeline-divider'))
    const videoBefore = await header('V1')
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
    await page.mouse.down()
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2 + 30, { steps: 4 })
    await page.mouse.up()
    const videoAfterSplit = await header('V1')
    step("the Timeline's divider moves the halves apart, and a track header's bottom edge resizes its tracks", videoAfterSplit.y > videoBefore.y + 10 && audioAfter.height > audioBefore.height + 8, JSON.stringify({ videoBefore: videoBefore.y, videoAfterSplit: videoAfterSplit.y, audioBefore: audioBefore.height, audioAfter: audioAfter.height }))
    // The Timeline panel menu's Video Thumbnails turns the thumbnails off and on.
    const thumbs = () => kit.locator('[data-testid="film-clip-thumbnail"]').count()
    const thumbsOn = await until(async () => (await thumbs()) > 0, 40)
    await kit.getByTestId('film-workspace-menu-timeline').click()
    await kit.getByTestId('film-timeline-menu-thumbnails').click()
    const thumbsOff = await until(async () => (await thumbs()) === 0, 40)
    await kit.getByTestId('film-workspace-menu-timeline').click()
    await kit.getByTestId('film-timeline-menu-thumbnails').click()
    const thumbsBack = await until(async () => (await thumbs()) > 0, 40)
    step("the Timeline panel menu's Video Thumbnails hides and shows the thumbnails", thumbsOn && thumbsOff && thumbsBack, JSON.stringify({ thumbsOn, thumbsOff, thumbsBack }))
    // Begin Text Editing (Cmd+Alt+'): the graphic's text layer opens in the Program monitor with its whole text selected.
    const made = await person([{ command: 'graphics.newText', params: { text: 'Title', seconds: 2, time: 0 } }, { command: 'playhead.set', params: { seconds: 0.5 } }])
    const textClip = made.completed[0].result?.clip
    await person([{ command: 'timeline.select', params: { clips: [textClip] } }])
    await kit.locator('.kui-app').focus()
    await page.keyboard.press("ControlOrMeta+Alt+'")
    const field = kit.locator('[data-kit-ui-id="control:program.textEdit"]')
    const opened = await until(async () => (await field.count()) === 1, 40)
    const selected = opened ? await field.evaluate((element) => [element.selectionStart, element.selectionEnd, element.value]) : null
    await page.keyboard.press('Escape')
    await kit.locator('.kui-app').focus()
    // Past the graphic's end the layer is selected, and the status bar says the picture does not show it.
    await person([{ command: 'playhead.set', params: { seconds: 5 } }, { command: 'timeline.select', params: { clips: [textClip] } }])
    await kit.locator('.kui-app').focus()
    await page.keyboard.press("ControlOrMeta+Alt+'")
    const notShown = await until(async () => ((text) => text.includes(zt('textNotShown')))((await kit.getByTestId('film-message').textContent({ timeout: 200 }).catch(() => '')) ?? ''), 40)
    if (await kit.getByTestId('film-message').count()) await kit.getByTestId('film-message').click()
    step("Begin Text Editing opens the graphic's text in the Program monitor, all of it selected, and says so when the picture does not show it", opened && selected?.[0] === 0 && selected?.[1] === 'Title'.length && notShown, JSON.stringify({ textClip, opened, selected, notShown }))
    // A part that fails to draw shows upstream's window with Save Project and Continue; Continue draws the editor again.
    await kitFrame().evaluate(() => window.filmInjectFault?.())
    const faulted = await until(async () => (await kit.getByTestId('film-error-dismiss').count()) === 1, 40)
    await checkIds()
    const detail = faulted ? await kit.getByTestId('film-error-detail').textContent() : null
    await kit.getByTestId('film-error-dismiss').click().catch(() => undefined)
    const back = await until(async () => (await kit.getByTestId('film-workspace-frame-timeline').count()) === 1 && (await kit.getByTestId('film-error-dismiss').count()) === 0, 40)
    step('a part that fails to draw shows the error window, and Continue draws the editor again', faulted && detail === 'injected UI fault' && back, JSON.stringify({ faulted, detail, back }))
    // The whole shell has its own boundary (menus, header, status bar); Save Project follows the
    // host's Save: with action:save hidden it is not offered.
    await page.evaluate(() => window.devHost.configure({ hide: ['action:save'], disable: [] }))
    await kitFrame().evaluate(() => window.filmInjectFault?.('shell'))
    const shellFaulted = await until(async () => (await kit.getByTestId('film-error-dismiss').count()) === 1 && (await kit.getByTestId('film-menu-File').count()) === 0, 40)
    const saveOffered = await kit.getByTestId('film-error-save').count()
    await checkIds()
    await kit.getByTestId('film-error-dismiss').click().catch(() => undefined)
    const shellBack = await until(async () => (await kit.getByTestId('film-menu-File').count()) === 1 && (await kit.locator('.kui-status-bar').count()) === 1, 40)
    await page.evaluate(() => window.devHost.configure({ hide: [], disable: [] }))
    step("the shell's own boundary catches a fault in the menus and status bar, and Save Project follows the host's Save", shellFaulted && saveOffered === 0 && shellBack, JSON.stringify({ shellFaulted, saveOffered, shellBack }))
    // Every panel, shown once in All Panels: each one's controls carry declared ids.
    await kit.locator('.kui-app').focus()
    await page.keyboard.press('Alt+Shift+9')
    await until(async () => (await kit.getByTestId('film-header-workspaces').textContent()).trim() === zh('All Panels').toUpperCase(), 20)
    const tabs = await kit.locator('[data-testid^="film-workspace-tab-"]').evaluateAll((items) => [...new Set(items.map((item) => item.getAttribute('data-testid').slice('film-workspace-tab-'.length)))])
    const shownPanels = []
    for (const panel of tabs) {
      await showTab(panel)
      if (await until(async () => await tabActive(panel), 20)) shownPanels.push(panel)
      await paintFrames()
      await checkIds()
    }
    // The panels All Panels leaves out open from Window, near their neighbours (upstream `show_panel`);
    // the panels the editor does not draw have no Window row (presets.ts WEB_PANEL_IDS).
    for (const panel of manifest.panels.filter((each) => WEB_PANEL_IDS.has(each.id) && !each.compact && !tabs.includes(each.id))) {
      await kit.getByTestId('film-menu-Window').click()
      await kit.locator(`[data-kit-ui-id="control:window.panel.${panel.kind}"]`).click()
      if (await until(async () => await tabActive(panel.id), 20)) shownPanels.push(panel.id)
      await paintFrames()
      await checkIds()
    }
    await page.keyboard.press('Alt+Shift+1')
    await until(async () => (await kit.getByTestId('film-header-workspaces').textContent()).trim() === zh('Editing').toUpperCase(), 20)
    const everyPanel = manifest.panels.filter((panel) => WEB_PANEL_IDS.has(panel.id) && !panel.compact).map((panel) => panel.id)
    step('every panel the editor draws is shown once, from All Panels or Window, its controls checked for declared ids', everyPanel.every((panel) => shownPanels.includes(panel)), JSON.stringify({ shown: shownPanels.length, missing: everyPanel.filter((panel) => !shownPanels.includes(panel)) }))
  }
  // The document replaced while a dialog previews (an agent's file.newProject; last, as it ends
  // this document): the preview ends and the dialog closes, since what it was drafted for is gone.
  {
    const first = (await details()).sequence.video.flatMap((track) => track.items ?? [])[0]
    await personRun([{ command: 'timeline.select', params: { clips: [first.clip] } }])
    await waitForEngine(page, (state) => state.details?.sequence?.selection?.includes(first.clip))
    const serialFrom = (await previewState()).serial
    await kit.getByTestId('film-menu-Clip').click()
    await kit.getByTestId('film-cmd-clip.speedDuration').click()
    await kit.getByTestId('film-dialog').waitFor({ timeout: 10000 })
    const opened = await previewOpened(serialFrom)
    await page.evaluate(async () => window.devHost.connection().ai.run([{ command: 'file.newProject', params: {} }], false))
    const closed = await until(async () => (await dialogShown()) === 0 && !(await previewState()).open && (await previewGhosts()) === 0, 60)
    step('a document replaced while a dialog previews (file.newProject) ends the preview and closes the dialog', opened && closed, JSON.stringify({ opened, closed, state: await previewState() }))
  }
  step('the dev page loaded once: nothing reopened the document under the flow', devPageLoads === 1, JSON.stringify(reloads.filter((line) => /navigated dev page|full-reload/.test(line))))
  await checkIds()
  if (undeclared) step('gives every control a declared id', false, undeclared)
  else step('gives every control a declared id', idProblems.length === 0, [...new Set(idProblems.map((problem) => problem.slice(0, 90)))].slice(0, 8).join('; '))
  // Every label the flow drew through phrase() on its zh-CN page has a zh-CN entry (Task 23b), so a
  // later task that draws a new label adds both locales. FILM_PHRASES_OUT=<file> writes the list.
  // What reaches phrase() and is not one of upstream's labels, so it stays as it is (as upstream's
  // `i18n::t` leaves it): text already in Chinese (an editor string the status bar shows), the
  // engine's history and job lines made with a document's names, and names this flow gives (a
  // workspace, a test dialog's rows). Engine and error messages never reach it: the status bar
  // shows them through `errorStatus`, which notes nothing.
  const notLabels = [/\p{Script=Han}/u, /^Import bars\.mp4$/, /^Scene Edit Detection: \d+ cut point\(s\)$/, /^Rough Cut$/, /^Row \d+$/]
  const untranslated = await kitFrame()?.evaluate(() => window.filmPhrases?.missing() ?? null).catch(() => null)
  if (process.env.FILM_PHRASES_OUT) writeFileSync(process.env.FILM_PHRASES_OUT, JSON.stringify(untranslated, null, 1))
  const labelsMissing = (untranslated ?? []).filter((text) => !notLabels.some((pattern) => pattern.test(text)))
  step("every label the flow's steps looked up has a zh-CN catalog entry", zhMissing.size === 0, JSON.stringify([...zhMissing]))
  step('every label the flow drew on its zh-CN page has a zh-CN catalog entry', Array.isArray(untranslated) && labelsMissing.length === 0, JSON.stringify(untranslated ? labelsMissing.slice(0, 12) : 'window.filmPhrases is missing'))
} catch (error) {
  failures += 1
  console.log(`FAIL ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  // Where in this file it threw, so the step that stopped the run can be found.
  const at = (error instanceof Error ? error.stack ?? '' : '').split('\n').filter((line) => line.includes('flow.mjs')).slice(0, 3)
  if (at.length) console.log(`  at: ${at.map((line) => line.trim()).join(' <- ')}`)
  // What the document and the engine worker looked like then: a reopened document (more than one
  // `open`), a history that went back, the editor's last console errors.
  const worker = await kitFrame()?.evaluate(() => ({ ...window.workerRequests })).catch(() => null)
  const engine = await waitForEngine(page, () => true, { history: true, timeout: 3000, orNull: true }).catch(() => null)
  console.log(`  state: ${JSON.stringify({ opens: worker?.open, revision: engine?.revision, undo: engine?.history?.undo?.length, lastUndo: engine?.history?.undo?.slice(-3), clips: engine?.details?.sequence ? [...engine.details.sequence.video, ...engine.details.sequence.audio].map((track) => (track.items ?? []).length) : null, devPageLoads, consoleErrors: consoleErrors.slice(-4) }).slice(0, 1200)}`)
  console.log(`  reloads and navigations: ${JSON.stringify(reloads.slice(-12))}`)
} finally {
  if (errors.length) console.log(`page errors:\n${errors.slice(0, 8).join('\n')}`)
  await browser.close()
  await server.close()
}
process.exit(failures ? 1 : 0)
