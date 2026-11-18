import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/scenarios',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  outputDir: 'test-results/scenarios',
  reporter: [['list'], ['junit', { outputFile: 'test-results/browser.xml' }], ['html', { open: 'never' }]],
  use: { viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
})
