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
  // Both pinned to the repo root (paths here are relative to this file), where CI uploads them.
  outputDir: '../test-results',
  // CI: list for readable job logs, html for the uploaded report.
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]]
    : 'list'
})
