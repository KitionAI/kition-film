import { test as base, expect } from '@playwright/test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const menuRows = JSON.parse(readFileSync(new URL('../../parity/film-upstream.json', import.meta.url), 'utf8')).menus

export { expect }
export const TICKS = 254_016_000_000
export const test = base.extend({
  origin: [async ({}, use) => {
    const server = await createServer({
      root: fileURLToPath(new URL('../..', import.meta.url)),
      configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error',
    })
    await server.listen()
    try { await use(`http://127.0.0.1:${server.httpServer.address().port}`) } finally { await server.close() }
  }, { scope: 'worker' }],
  film: async ({ page, origin }, use) => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const film = {
      page,
      kit: page.frameLocator('#kit'),
      frame: () => page.frames().find(frame => frame.url().includes('index.html')),
      async open(query = '') {
        await page.goto(`${origin}/dev.html?locale=en-US${query}`)
        await expect(page.locator('#status')).toContainText(' open in ', { timeout: 45_000 })
        await expect.poll(async () => (await this.inspect())?.details?.sequence != null).toBe(true)
        await this.kit.getByTestId('film-program-zoom').waitFor()
        await expect.poll(() => this.frame()?.evaluate(() => typeof window.filmPreview?.run === 'function')).toBe(true)
      },
      inspect: () => page.evaluate(() => window.devHost.connection().ai.inspect()),
      async details() { return (await this.inspect()).details },
      // The scenarios set up and edit as the person, through the editor's own `run` (development
      // builds' `filmPreview.run`, as a menu or a key runs a command): an agent's `ai/run` acts in
      // an editor state of its own (selection, playheads, open sequence and source; KHP C3b) and
      // its steps are the agent's undo steps, which the person's Undo keeps (KitModel 1.1 M12a).
      async command(command, params = {}) {
        return this.frame().evaluate(([command, params]) => window.filmPreview.run(command, params), [command, params])
      },
      /** Runs `steps` (`{ command, params }`) one after another as the person; answers their results. */
      async commands(steps) {
        return this.frame().evaluate(async steps => {
          const results = []
          for (const { command, params } of steps) results.push(await window.filmPreview.run(command, params ?? {}))
          return results
        }, steps)
      },
      /**
       * Runs `command` as the agent (`ai/run`), where a scenario needs a change the person cannot
       * make at that moment (a project replaced while the person's dialog waits); answers its result.
       */
      async agent(command, params = {}) {
        const result = await page.evaluate(async ([command, params]) => window.devHost.connection().ai.run([{ command, params }], false), [command, params])
        expect(result.failed, JSON.stringify(result)).toBeFalsy()
        expect(result.completed, JSON.stringify(result)).toHaveLength(1)
        return result.completed[0].result
      },
      /** Runs `command` as the person and answers why it was refused, or null when it ran. */
      async attempt(command, params = {}) {
        return this.frame().evaluate(async ([command, params]) => {
          try { await window.filmPreview.run(command, params); return null }
          catch (error) { return String(error?.message ?? error) }
        }, [command, params])
      },
      async sequence() { return (await this.details()).sequence },
      // The person's history, as the History panel reads it.
      async history() { return this.frame().evaluate(() => window.filmPreview.history()) },
      async configure(config) {
        await page.evaluate(config => window.devHost.configure(config), config)
        // A protocol round trip ensures the notification has reached the editor.
        await page.evaluate(() => window.devHost.connection().elements())
      },
      async focus() { await this.kit.locator('.kui-app').focus() },
      async menu(command) {
        const row = menuRows.find(each => each.command === command)
        expect(row, `menu route for ${command}`).toBeTruthy()
        await this.kit.getByTestId(`film-menu-${row.path[0]}`).click()
        for (let depth = 2; depth <= row.path.length; depth += 1) await this.kit.locator(`[data-kit-ui-id="menu:${row.path.slice(0, depth).join('/')}"]`).hover()
        await this.kit.locator(`[data-testid="film-cmd-${command}"], [data-testid="film-control-${command}"]`).first().click()
      },
      async undo() { await this.focus(); await page.keyboard.press('ControlOrMeta+z') },
      async redo() { await this.focus(); await page.keyboard.press('ControlOrMeta+Shift+z') },
      async saveReopen() {
        const old = await page.evaluate(() => window.devHost.files.get('films/Sample.kfilm').version)
        await this.focus()
        await page.keyboard.press('ControlOrMeta+s')
        await expect.poll(() => page.evaluate(() => window.devHost.files.get('films/Sample.kfilm').version)).not.toBe(old)
        await page.evaluate(async () => {
          const file = window.devHost.files.get('films/Sample.kfilm')
          await window.devHost.open('films/Sample.kfilm', file.bytes.slice(0))
        })
        await this.kit.getByTestId('film-program-zoom').waitFor()
        await expect.poll(async () => (await this.details()).sequence != null).toBe(true)
      },
    }
    await use(film)
    expect(errors, 'uncaught browser errors').toEqual([])
  },
})

export function clips(sequence, kind = 'video') { return sequence[kind].flatMap(track => track.items ?? []) }
export function editState(sequence) {
  return { video: sequence.video, audio: sequence.audio, markers: sequence.markers, duration: sequence.duration }
}

/** Serve original test media through the real worker's HTTP lent-file reader, including ranges.
 * The dev host's in-memory picker list alone does not serve its static /sample/ URLs. */
export async function lendMedia(film, path, input) {
  const bytes = Buffer.from(input)
  const reads = []
  const url = new URL(`sample/${path.split('/').map(encodeURIComponent).join('/')}`, film.page.url()).href
  await film.page.context().route(url, async route => {
    const request = route.request()
    const range = request.headers().range
    reads.push({ method: request.method(), range: range ?? null })
    const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' }
    if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...headers, 'content-length': String(bytes.length) }, body: Buffer.alloc(0) })
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
    if (!match) return route.fulfill({ status: 200, headers, body: bytes })
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), bytes.length - 1)
    if (start > end) return route.fulfill({ status: 416, headers: { ...headers, 'content-range': `bytes */${bytes.length}` } })
    return route.fulfill({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}` }, body: bytes.subarray(start, end + 1) })
  })
  await film.page.evaluate(([path, bytes]) => window.devHost.files.set(path, { bytes: new Uint8Array(bytes).buffer, version: 1 }), [path, Array.from(bytes)])
  return reads
}

/** Delay a real host request, then let the real host answer it. No fabricated success replies. */
export async function holdHostRequest(film, method) {
  await film.frame().evaluate(method => {
    const original = MessagePort.prototype.postMessage
    let held = null
    MessagePort.prototype.postMessage = function(message, ...rest) {
      if (!held && message?.method === method) {
        held = { port: this, message, rest }
        MessagePort.prototype.postMessage = original
        return
      }
      return original.call(this, message, ...rest)
    }
    window.reviewHostGate = {
      pending: () => held != null,
      release: () => new Promise(resolve => {
        const { port, message, rest } = held
        const answered = event => {
          if (event.data?.id !== message.id) return
          port.removeEventListener('message', answered)
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }
        port.addEventListener('message', answered)
        original.call(port, message, ...rest)
      }),
    }
  }, method)
  return {
    wait: () => expect.poll(() => film.frame().evaluate(() => window.reviewHostGate.pending())).toBe(true),
    release: () => film.frame().evaluate(() => window.reviewHostGate.release()),
  }
}

/** Hold one real Worker call before submission, including its transfer list. */
export async function holdWorkerCall(film, name) {
  await film.frame().evaluate(name => {
    const original = Worker.prototype.postMessage
    let held = null
    Worker.prototype.postMessage = function(message, ...rest) {
      if (!held && message?.request?.method === 'invoke' && message.request.name === name) {
        held = { worker: this, message, rest }
        Worker.prototype.postMessage = original
        return
      }
      return original.call(this, message, ...rest)
    }
    window.reviewWorkerGate = {
      pending: () => held != null,
      release: () => new Promise(resolve => {
        const { worker, message, rest } = held
        const answered = event => {
          if (event.data?.id !== message.id) return
          worker.removeEventListener('message', answered)
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }
        worker.addEventListener('message', answered)
        original.call(worker, message, ...rest)
      }),
    }
  }, name)
  return {
    wait: () => expect.poll(() => film.frame().evaluate(() => window.reviewWorkerGate.pending()), { timeout: 30_000 }).toBe(true),
    release: () => film.frame().evaluate(() => window.reviewWorkerGate.release()),
  }
}

/** Let the Worker execute a real read, then delay only delivery of its actual reply.
 * Later commands keep their natural execution order while this caller remains suspended. */
export async function holdWorkerReply(film, name) {
  await film.frame().evaluate(name => {
    const post = Worker.prototype.postMessage
    let held = null
    Worker.prototype.postMessage = function(message, ...rest) {
      if (message?.request?.method === 'invoke' && message.request.name === name) {
        Worker.prototype.postMessage = post
        const worker = this
        const receive = worker.onmessage
        worker.onmessage = function(event) {
          if (event.data?.id === message.id) {
            held = { worker, receive, event }
            worker.onmessage = receive
          } else receive.call(worker, event)
        }
      }
      return post.call(this, message, ...rest)
    }
    window.reviewWorkerReply = {
      pending: () => held != null,
      release: () => new Promise(resolve => {
        held.receive.call(held.worker, held.event)
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      }),
    }
  }, name)
  return {
    wait: () => expect.poll(() => film.frame().evaluate(() => window.reviewWorkerReply.pending()), { timeout: 30_000 }).toBe(true),
    release: () => film.frame().evaluate(() => window.reviewWorkerReply.release()),
  }
}

/** Delay delivery of one real engine command reply matching the supplied parameters. */
export async function holdWorkerCommandReply(film, command, params = {}) {
  await film.frame().evaluate(([command, params]) => {
    const post = Worker.prototype.postMessage
    let held = null
    Worker.prototype.postMessage = function(message, ...rest) {
      const request = message?.request
      if (request?.method === 'execute' && request.command === command && Object.entries(params).every(([key, value]) => request.params?.[key] === value)) {
        Worker.prototype.postMessage = post
        const worker = this
        const receive = worker.onmessage
        worker.onmessage = function(event) {
          if (event.data?.id === message.id) {
            held = { worker, receive, event }
            worker.onmessage = receive
          } else receive.call(worker, event)
        }
      }
      return post.call(this, message, ...rest)
    }
    window.reviewCommandReply = {
      pending: () => held != null,
      release: () => new Promise(resolve => {
        held.receive.call(held.worker, held.event)
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      }),
    }
  }, [command, params])
  return {
    wait: () => expect.poll(() => film.frame().evaluate(() => window.reviewCommandReply.pending())).toBe(true),
    release: () => film.frame().evaluate(() => window.reviewCommandReply.release()),
  }
}

/** Original generated matte: six frames at 24 fps, no external assets or reference application. */
export async function tinyMovie(film) {
  await film.command('file.newProject', { name: 'Six red frames' })
  await film.command('file.newSequence', { name: 'Red', width: 64, height: 36, fps: 24, video: 1, audio: 1 })
  const matte = await film.command('file.newColorMatte', { color: '#ff0000', seconds: 0.25 })
  await film.command('timeline.place', { item: matte.item, track: 'V1', seconds: 0 })
  await expect.poll(async () => (await film.sequence()).duration).toBe(TICKS / 4)
}
