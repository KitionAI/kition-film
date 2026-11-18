// The editor in each display mode, through the development host: node tests/modes.mjs [chromium|webkit]
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { runModeSmoke } from '@kition/kit-dev-host/mode-smoke'

await runModeSmoke({
  kit: 'kit.film',
  config: new URL('../vite.config.ts', import.meta.url).pathname,
  browser: process.argv[2] === 'webkit' ? webkit : chromium,
  createServer,
  line: { tab: 'home', primary: ['film-cmd-file.import', 'film-cmd-sequence.addEdit', 'film-cmd-edit.rippleDelete', 'film-cmd-source.insert', 'film-cmd-sequence.applyVideoTransition', 'film-cmd-markers.add', 'film-cmd-graphics.newText'] },
})
