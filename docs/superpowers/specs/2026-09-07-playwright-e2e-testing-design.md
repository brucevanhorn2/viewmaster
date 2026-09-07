# Playwright E2E Testing Design

## Problem

Resolves [#40](https://github.com/brucevanhorn2/viewmaster/issues/40). The
app has a healthy Vitest unit-test suite (`src/**/*.test.ts`, plain-Node
environment) but no test ever drives the actual Electron app end-to-end —
opening a real window, opening a real folder, clicking through the sidebar,
viewing a diff. There is also no CI workflow that runs any test at all; the
only workflow in `.github/workflows/` (`deploy-website.yml`) deploys the
marketing site. Regressions in the actual user-facing flows are caught only
by hand.

`playwright-core` is already a devDependency, and its Electron driver
(`_electron.launch`) is already used by `.claude/skills/run-viewmaster/driver.mjs`
to drive the app interactively for this agent's own manual QA. `src/main/index.ts`
also already has a `VIEWMASTER_OPEN` env var, explicitly commented as a
"dev/testing convenience," that auto-opens a given folder path at launch
without touching the native folder-picker dialog. Both pieces already assume
something like this would exist.

## Scope

An initial e2e harness plus a small smoke-test suite covering the most
critical flows, wired into a new CI workflow — not an attempt to enumerate
comprehensive coverage of every feature (diff viewer edge cases, markdown/HTML
preview, history scrubbing, related files, baseline picker, etc.) in one
pass. Confirmed with Bruce: later coverage is added incrementally as new
`e2e/*.spec.ts` files against the same harness, without needing a fresh
design each time.

In scope:
- `@playwright/test` + a reusable Electron-launch fixture.
- ~5 smoke tests: open a folder, view a diff, browse mode, find in files,
  related files.
- A new `npm run test:e2e` script.
- A new `.github/workflows/test.yml` that runs both the existing Vitest
  suite and the new e2e suite on `ubuntu-latest`, on every push and PR.

Out of scope: Windows/macOS CI runners (confirmed: ubuntu-only for now);
enumerating full feature coverage; any change to the app's own runtime
behavior (the `VIEWMASTER_OPEN` hook and CLI-arg auto-open already exist and
need no changes to support this).

## Design

### Harness

New `e2e/` directory at the repo root, sibling to `src/`.

`e2e/playwright.config.ts` — a `@playwright/test` config with `testDir:
'./e2e'`, a single default project (Electron doesn't use Playwright's
browser-channel projects), `retries: process.env.CI ? 1 : 0` (CI machines are
slower and shared; local runs should fail fast), and `reporter: process.env.CI
? 'html' : 'list'` (the HTML report becomes the CI failure artifact; a
Linux-CI-only failure otherwise can't be reproduced by hand in this
environment).

`e2e/fixtures.ts` exports a `test`/`expect` pair built via `@playwright/test`'s
`test.extend`, adding two fixtures:

- **`tmpRepo`** — creates a fresh temp directory per test (`mkdtemp(join(tmpdir(),
  'viewmaster-e2e-'))`, matching the existing per-test temp-dir pattern already
  used throughout the Vitest suite, e.g. `src/main/git/run.test.ts`), runs `git
  init` + writes and commits two or three small files, then edits one of them
  uncommitted (so both "Changed" and "Browse" sidebar modes have real content
  to assert against). Removes the directory (`rm(dir, { recursive: true, force:
  true })`) in the fixture's teardown.
- **`electronApp` / `window`** — launches the app via `_electron.launch({
  args: [resolve('out/main/index.js')], env: { ...process.env, VIEWMASTER_OPEN:
  tmpRepo } })` (requires `npm run build` to have already produced `out/`;
  handled by the npm script below, not by the fixture), waits on
  `electronApp.firstWindow()` for the renderer's `Page`, and closes the app in
  teardown (`electronApp.close()`).

Each spec file requests `window` (which transitively requests `tmpRepo` and
`electronApp`) and interacts with it exactly like a Playwright browser test —
`window.getByText(...)`, `expect(locator).toBeVisible()`, etc. Assertions use
Playwright's auto-retrying `expect(locator)` throughout instead of manual
waits/sleeps, since the app's renderer mounts and fetches repo state
asynchronously after `did-finish-load`.

### Smoke tests (`e2e/smoke.spec.ts`)

Five tests, one `test()` block each, sharing the fixtures above:

1. **Open folder shows the tree** — the fixture repo's committed file names
   appear in the sidebar.
2. **Selecting a changed file shows a diff** — click the uncommitted file's
   row, assert the diff/editor pane renders (e.g. a diff-gutter marker or the
   file's content is visible in the content pane).
3. **Browse mode lists all files** — click the "Browse" toolbar button,
   assert a committed (non-changed) file now appears too.
4. **Find in Files finds and navigates to a match** — trigger the search pane
   (Playwright can invoke the app's IPC-exposed menu handler directly, or
   simulate the `Cmd/Ctrl+Shift+F` accelerator via `page.keyboard.press`),
   type a query matching known fixture content, click the result, assert
   navigation lands on the expected file/line.
5. **Related Files opens its pane** — trigger it the same way as (4), assert
   the pane becomes visible.

### npm scripts

```json
"test:e2e": "npm run build && playwright test -c e2e/playwright.config.ts"
```

`npm run build` first, since the harness launches the packaged `out/main/index.js`
output rather than a live `electron-vite dev` server — a stable, closer-to-shipped
artifact, and avoids the fixture needing to know how to start/stop a dev server.

### CI (`.github/workflows/test.yml`)

Triggers: `push` and `pull_request`. Single job on `ubuntu-latest`:

1. Checkout, `actions/setup-node` pinned to Node 22 (there's no `engines`
   field or `.nvmrc` in this repo today to derive a version from; 22 matches
   the current local dev environment), `npm ci`.
2. `npm test` (the existing Vitest suite — first time it runs in CI at all).
3. `xvfb-run -a npm run test:e2e` — Electron needs a display even when
   driven headlessly by Playwright; `xvfb-run` is the standard way to provide
   one on a headless Linux runner (installed via `apt-get install -y xvfb` if
   not already present on `ubuntu-latest`, or via `coactions/setup-xvfb`/
   equivalent action — implementer's choice, whichever proves simplest).
4. On failure, upload the Playwright HTML report (`playwright-report/` or
   wherever the config's `reporter: 'html'` writes it) as a build artifact via
   `actions/upload-artifact`, `if: failure()`.

## Testing

The harness and its five smoke tests are themselves the test surface here —
there's no separate unit test for the fixtures. Verification is: run `npm run
test:e2e` locally against this repo (confirming the harness launches, opens
the fixture repo, and all five specs pass), then push to a PR and confirm the
new GitHub Actions workflow goes green on `ubuntu-latest` — that's the only
way to confirm the `xvfb-run` path actually works, since this environment has
no guaranteed display to test against locally.
