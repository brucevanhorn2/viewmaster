import { test as base, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { makeRepo, type TestRepo } from '../src/main/git/testRepo'

// `electron`'s package resolves to the platform Electron *binary path*
// (a plain string) when required from ordinary Node, not the Electron API
// surface its own .d.ts describes — that surface only exists inside a
// running Electron process. Hence the cast.
import electronBinaryPath from 'electron'

const MAIN_ENTRY = resolve(__dirname, '../out/main/index.js')

export const test = base.extend<{
  tmpRepo: TestRepo
  electronApp: ElectronApplication
  window: Page
}>({
  // A small git repo with one committed-and-then-modified file (shows up
  // under "Changed") and one committed-and-untouched file (shows up only
  // under "Browse") — enough fixture data for all five smoke tests.
  tmpRepo: async ({}, use) => {
    const repo = await makeRepo()
    try {
      await repo.write('committed.txt', 'hello from committed\n')
      await repo.write('other.txt', 'searchable-marker-xyz\n')
      await repo.git('add', '.')
      await repo.git('commit', '-m', 'initial commit')
      await repo.write('committed.txt', 'hello from committed\nedited line\n')
      await use(repo)
    } finally {
      await repo.cleanup()
    }
  },

  electronApp: async ({ tmpRepo }, use, testInfo) => {
    // An isolated --user-data-dir keeps this run's electron-store state
    // (recent folders, window bounds, per-folder sidebar mode) from
    // colliding with a developer's real app data or with another test's
    // Electron instance running at the same time.
    const userDataDir = await mkdtemp(join(tmpdir(), 'viewmaster-e2e-userdata-'))
    try {
      // electron-vite dev sets ELECTRON_RENDERER_URL; inherited, it would make the app load
      // a dev server instead of the freshly built out/renderer.
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v
      }
      env.VIEWMASTER_OPEN = tmpRepo.root
      const app = await electron.launch({
        executablePath: electronBinaryPath as unknown as string,
        args: [
          MAIN_ENTRY,
          `--user-data-dir=${userDataDir}`,
          // Ubuntu 24.04 runners restrict unprivileged user namespaces and npm's chrome-sandbox
          // isn't setuid root, so Chromium's sandbox can't start there.
          ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])
        ],
        env
      })
      try {
        // Playwright's `trace: 'on-first-retry'` config option only wraps
        // Playwright's own built-in context/page fixtures, which this
        // harness bypasses via `_electron.launch`. Mirror that semantics
        // by hand: trace only a retry, so the first (usually passing)
        // attempt stays fast, but a CI-only failure that gets retried
        // leaves a trace attached to the html report.
        const tracing = testInfo.retry > 0
        if (tracing) {
          await app.context().tracing.start({ screenshots: true, snapshots: true })
        }
        try {
          await use(app)
        } finally {
          if (tracing) {
            const failed = testInfo.status !== testInfo.expectedStatus
            if (failed) {
              const tracePath = testInfo.outputPath('trace.zip')
              await app.context().tracing.stop({ path: tracePath })
              await testInfo.attach('trace', { path: tracePath, contentType: 'application/zip' })
            } else {
              await app.context().tracing.stop()
            }
          }
        }
      } finally {
        await app.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  },

  window: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await use(page)
  }
})

export { expect }
