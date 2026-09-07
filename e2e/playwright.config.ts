import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Electron app instances are heavy (full Chromium + Node) and each test
  // launches its own — run them one at a time rather than fighting over
  // CPU/memory on a typical CI runner.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'html' : 'list'
})
