# Playwright E2E Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Playwright-based e2e test harness that drives the real, built Electron app, with five smoke tests covering the most critical user flows, wired into a new CI workflow that also runs the existing Vitest unit suite for the first time.

**Architecture:** `@playwright/test`'s Electron support (`_electron.launch`) drives `out/main/index.js` (the real `npm run build` output), auto-opening a disposable temp git repo via the app's existing `VIEWMASTER_OPEN` env var so no dialog automation is needed. A custom Playwright fixture (`e2e/fixtures.ts`) wires this up and hands each test a ready `Page` for the app's single window.

**Tech Stack:** `@playwright/test` (new devDependency, pinned to match the already-present `playwright-core`), the existing `makeRepo()` git-fixture helper from `src/main/git/testRepo.ts`, GitHub Actions (`ubuntu-latest` + `xvfb-run`).

**Spec:** [docs/superpowers/specs/2026-09-07-playwright-e2e-testing-design.md](../specs/2026-09-07-playwright-e2e-testing-design.md)

## Global Constraints

- CI runs on `ubuntu-latest` only — no Windows/macOS runners (confirmed scope decision; this agent's environment also has no Mac to hand-verify a macOS run against).
- `@playwright/test`'s version must track `playwright-core`'s existing `^1.62.1` so both resolve to matching releases.
- Scope is the harness plus exactly five smoke tests (open folder, diff, browse mode, find in files, related files) — no attempt at comprehensive feature coverage in this plan.
- No README changes and no new tsconfig for `e2e/` — out of scope per the approved design.
- **Deviations from the spec's literal wording, worth flagging to a reviewer:**
  1. The spec describes the `tmpRepo` fixture writing its own `mkdtemp`/`git init` logic inline. While building this plan, a better option was found already in the codebase — `makeRepo()` in `src/main/git/testRepo.ts`, the exact same helper `src/main/files/browse.test.ts` already uses for this — and Task 1 uses that instead of duplicating the logic. Functionally equivalent (temp dir + git init + user.name/email/gpgsign config already handled), just DRY.
  2. The spec says `e2e/playwright.config.ts` should set `testDir: './e2e'`. That's a bug in the spec: `testDir` resolves relative to the config file's own directory, and this config file already lives inside `e2e/` — `'./e2e'` would incorrectly point at a nonexistent `e2e/e2e/`. Task 1 uses `testDir: '.'` instead, which is the correct equivalent.

---

### Task 1: Playwright harness + first smoke test (open folder shows the tree)

**Files:**
- Modify: `package.json` (add `@playwright/test` devDependency, add `test:e2e` script)
- Modify: `.gitignore` (ignore Playwright's own output dirs)
- Modify: `electron-builder.yml` (exclude `e2e/` from packaged builds)
- Create: `e2e/playwright.config.ts`
- Create: `e2e/fixtures.ts`
- Create: `e2e/smoke.spec.ts`

**Interfaces:**
- Produces (used by every later task in this plan): `e2e/fixtures.ts` exports `test` and `expect` (a `@playwright/test` `test.extend` pair) with fixtures `tmpRepo: TestRepo` (from `src/main/git/testRepo.ts` — has `.root: string`, `.git(...args): Promise<GitResult>`, `.write(rel, content): Promise<void>`), `electronApp: ElectronApplication`, `window: Page`. Every spec file does `import { test, expect } from './fixtures'`.

- [ ] **Step 1: Add the `@playwright/test` dependency and `test:e2e` script**

Edit `package.json`:

```json
  "scripts": {
    "dev": "electron-vite dev",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "build": "npm run typecheck && node --max-old-space-size=4096 ./node_modules/.bin/electron-vite build",
    "test": "vitest run",
    "test:e2e": "npm run build && playwright test -c e2e/playwright.config.ts",
    "dist:mac": "npm run build && electron-builder --mac",
    "dist:linux": "npm run build && electron-builder --linux",
    "dist:win": "npm run build && electron-builder --win"
  },
```

And add to `devDependencies` (alphabetical, next to the existing `playwright-core` entry):

```json
    "@playwright/test": "^1.62.1",
```

Then run:

```bash
npm install
```

Playwright's Electron support drives the app's own bundled Chromium directly — this does **not** need `npx playwright install` (no separate browser download).

- [ ] **Step 2: Ignore Playwright's own output directories**

Edit `.gitignore`, in the existing "Vite / test caches" section:

```
# Vite / test caches
.vite/
coverage/
playwright-report/
test-results/
```

- [ ] **Step 3: Exclude `e2e/` from packaged builds**

Edit `electron-builder.yml`'s `files` list (it's a blocklist of source-only paths that shouldn't ship in the DMG/AppImage/exe):

```yaml
files:
  - '!src/*'
  - '!docs/*'
  - '!resources/*'
  - '!electron.vite.config.ts'
  - '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json,vitest.config.ts}'
  - '!{.gitignore,README.md}'
  - '!e2e/*'
```

- [ ] **Step 4: Create the Playwright config**

Create `e2e/playwright.config.ts`:

```ts
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
```

- [ ] **Step 5: Create the fixture file**

Create `e2e/fixtures.ts`:

```ts
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
    await repo.write('committed.txt', 'hello from committed\n')
    await repo.write('other.txt', 'searchable-marker-xyz\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'initial commit')
    await repo.write('committed.txt', 'hello from committed\nedited line\n')
    await use(repo)
    await repo.cleanup()
  },

  electronApp: async ({ tmpRepo }, use) => {
    // An isolated --user-data-dir keeps this run's electron-store state
    // (recent folders, window bounds, per-folder sidebar mode) from
    // colliding with a developer's real app data or with another test's
    // Electron instance running at the same time.
    const userDataDir = await mkdtemp(join(tmpdir(), 'viewmaster-e2e-userdata-'))
    const app = await electron.launch({
      executablePath: electronBinaryPath as unknown as string,
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, VIEWMASTER_OPEN: tmpRepo.root }
    })
    await use(app)
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  },

  window: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await use(page)
  }
})

export { expect }
```

- [ ] **Step 6: Write the first smoke test**

Create `e2e/smoke.spec.ts`:

```ts
import { test, expect } from './fixtures'

test('opening a folder shows the file tree', async ({ window }) => {
  await expect(window.getByText('committed.txt')).toBeVisible()
})
```

- [ ] **Step 7: Run it and confirm it passes**

Run: `npm run test:e2e`

Expected: PASS (1 test). This isn't red/green TDD in the usual sense — there's no new app behavior to make it pass, only existing behavior (`VIEWMASTER_OPEN` auto-opening a folder, the sidebar rendering its tree) that the harness now exercises for the first time. If it fails, the harness itself is the bug: check that `npm run build` actually produced `out/main/index.js`, and that the fixture repo's git commands succeeded (a nonzero `GitResult.code` from any `repo.git(...)` call is a silent no-op, not a thrown error).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore electron-builder.yml e2e/playwright.config.ts e2e/fixtures.ts e2e/smoke.spec.ts
git commit -m "test: add Playwright e2e harness with first smoke test"
```

---

### Task 2: Diff and Browse-mode smoke tests

**Files:**
- Modify: `e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: `test`/`expect` from `e2e/fixtures.ts` (Task 1), fixture repo files `committed.txt` (modified, shows in "Changed") and `other.txt` (unmodified, shows only in "Browse").

- [ ] **Step 1: Write the diff test**

Append to `e2e/smoke.spec.ts`:

```ts
test('selecting a changed file shows a diff', async ({ window }) => {
  await window.getByText('committed.txt').click()
  await window.getByRole('button', { name: 'Diff' }).click()
  await expect(window.locator('.monaco-diff-editor')).toBeVisible()
})
```

- [ ] **Step 2: Write the browse-mode test**

Append to `e2e/smoke.spec.ts`:

```ts
test('browse mode lists all files, not just changed ones', async ({ window }) => {
  await window.getByRole('button', { name: 'Browse' }).click()
  await expect(window.getByText('other.txt')).toBeVisible()
})
```

- [ ] **Step 3: Run the suite and confirm both pass**

Run: `npm run test:e2e`

Expected: PASS (3 tests total). If the diff test fails on `.monaco-diff-editor` not appearing, check first whether the "Diff" button click actually landed (the button is only rendered when a text file is selected and it's not markdown/HTML/SVG — `committed.txt` qualifies via `ContentPane.tsx`'s final fallback branch).

- [ ] **Step 4: Commit**

```bash
git add e2e/smoke.spec.ts
git commit -m "test: add diff and browse-mode e2e smoke tests"
```

---

### Task 3: Find-in-Files and Related-Files smoke tests

**Files:**
- Modify: `src/main/index.ts:132-146` (`buildMenu`'s Edit submenu)
- Modify: `e2e/smoke.spec.ts`

**Interfaces:**
- Produces: two new stable menu item ids (`'menu-find-in-files'`, `'menu-related-files'`) that `Menu.getApplicationMenu()?.getMenuItemById(id)` can find from any Electron main-process context, including a Playwright `electronApp.evaluate()` callback.
- Consumes: `test`/`expect`/fixtures from `e2e/fixtures.ts` (Task 1); `other.txt`'s content `searchable-marker-xyz` (Task 1) as the search query.

- [ ] **Step 1: Give the two menu items stable ids**

There's no existing way to trigger "Find in Files…" or "Related Files…" from outside a real keystroke aimed at Electron's native application menu (which Playwright's synthetic `page.keyboard.press` can't reach — that's a DOM-level key event, not an OS-level menu accelerator). Giving each item an `id` lets a test invoke it directly and deterministically via the main-process `Menu` API instead.

In `src/main/index.ts`, inside `buildMenu()`'s `template` array, find the `'Edit'` submenu (currently lines 132-146) and add an `id` to each of these two items:

```ts
    {
      label: 'Edit',
      submenu: [
        ...editExtras,
        { type: 'separator' },
        {
          id: 'menu-find-in-files',
          label: 'Find in Files…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => sendFindInFiles()
        },
        {
          id: 'menu-related-files',
          label: 'Related Files…',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => sendRelatedFiles()
        }
      ]
    },
```

- [ ] **Step 2: Run the existing unit and e2e suites to confirm nothing broke**

Run: `npm test && npm run test:e2e`

Expected: PASS (existing Vitest suite unaffected; the 3 e2e tests from Tasks 1-2 still pass — this change is additive, no behavior changes for anything not yet using the new ids).

- [ ] **Step 3: Write the Find in Files test**

Append to `e2e/smoke.spec.ts`:

```ts
test('find in files finds a match and navigates to it', async ({ window, electronApp }) => {
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('menu-find-in-files')?.click()
  })
  await window.getByPlaceholder('Find in files…').fill('searchable-marker-xyz')
  await window.locator('.search-result-row').first().click()
  await expect(window.locator('.toolbar-path')).toHaveText('other.txt')
})
```

- [ ] **Step 4: Write the Related Files test**

Append to `e2e/smoke.spec.ts`:

```ts
test('related files opens its pane', async ({ window, electronApp }) => {
  await window.getByText('committed.txt').click()
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('menu-related-files')?.click()
  })
  await expect(window.locator('.related-files-title')).toBeVisible()
})
```

- [ ] **Step 5: Run the full e2e suite and confirm all five pass**

Run: `npm run test:e2e`

Expected: PASS (5 tests). If the search test can't find a result row, confirm the 250ms debounce in `SearchPane.tsx` has elapsed before the click is attempted — `window.locator('.search-result-row').first().click()` already auto-waits/retries for the element to exist, so this should self-resolve; a persistent failure more likely means the query string doesn't match `other.txt`'s literal content.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts e2e/smoke.spec.ts
git commit -m "test: add find-in-files and related-files e2e smoke tests"
```

---

### Task 4: CI workflow

**Files:**
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: `npm test` and `npm run test:e2e` scripts (Task 1).

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/test.yml`:

```yaml
name: Test

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: npm ci

      - name: Run unit tests
        run: npm test

      - name: Install Xvfb
        run: sudo apt-get update && sudo apt-get install -y xvfb

      - name: Run e2e tests
        run: xvfb-run -a npm run test:e2e

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

- [ ] **Step 2: Validate the YAML syntax locally**

Run: `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/test.yml'))" && echo OK`

Expected: `OK`. (This only validates YAML syntax, not GitHub Actions semantics — the workflow's actual behavior can only be confirmed once it runs on a real push, since `xvfb-run` and the Electron/CI interaction can't be reproduced in this environment. That real confirmation happens after this plan's work is pushed, outside this plan's scope.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run unit and e2e tests on push and pull request"
```
