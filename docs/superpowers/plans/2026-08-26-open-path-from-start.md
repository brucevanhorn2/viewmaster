# Open Path From Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let viewmaster open directly to a folder passed as a command-line argument (e.g. `viewmaster /some/path`), so an LLM (or a user) can jump straight into a working folder without the manual "Open Folder" step.

**Architecture:** Extract a small pure function, `getPathArgFromArgv`, into a new sibling file `src/main/argv.ts` (matching this codebase's existing pattern of small standalone modules directly under `src/main/` — e.g. `store.ts`, `watcher.ts` — rather than adding untested logic inline into the large, untested `index.ts`). Generalize `createWindow()`'s existing dev-only `VIEWMASTER_OPEN` env var hook to also fall back to this function's result, reusing the exact same `sendOpenFolder` path "Open Recent" already uses — no new IPC, no new validation, no single-instance-lock changes.

**Tech Stack:** TypeScript, Electron main process, Vitest.

**Spec:** No separate spec document — this was brainstormed as a **bounded** task (a small, well-scoped change to an existing hook) per the brainstorming skill's bounded path, which presents its design in chat rather than writing a spec file. The approved design is captured in full in this plan. Issue: [viewmaster#32](https://github.com/brucevanhorn2/viewmaster/issues/32).

## Global Constraints

- No `app.requestSingleInstanceLock()` / `second-instance` handling — each invocation opens a new window/process, matching this codebase's existing default behavior (confirmed: no single-instance lock exists anywhere in `src/main/index.ts` today).
- No path validation added in `src/main/index.ts` — an invalid/nonexistent path reuses `openRepo`'s/`computeRepoState`'s existing error-state handling in the renderer, unchanged by this plan.
- No `electron-builder.yml`/packaging changes, no PATH-accessible CLI wrapper or symlink — explicitly out of scope. This plan only implements the underlying argv-parsing; invoking the packaged binary's own executable path directly with a trailing path argument is how it gets exercised (already how `VIEWMASTER_OPEN` works today, minus the env var).
- `getPathArgFromArgv` must be genuinely unit-tested via real TDD (write the failing test first) — it is a pure function, testable under this repo's plain-Node vitest environment, unlike the rest of `src/main/index.ts` (which has no test file and isn't expected to gain one here).
- Run `npm run typecheck` and `npm test` at the end of the task; both must be clean before committing.

---

### Task 1: Add `getPathArgFromArgv` and wire it into the auto-open hook

**Files:**
- Create: `src/main/argv.ts`
- Test: `src/main/argv.test.ts`
- Modify: `src/main/index.ts:150-154`

**Interfaces:**
- Consumes: nothing from other tasks (single-task plan).
- Produces: `getPathArgFromArgv(argv: string[], isPackaged: boolean): string | null`, consumed by `src/main/index.ts`'s `createWindow()`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/argv.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getPathArgFromArgv } from './argv'

describe('getPathArgFromArgv', () => {
  it('extracts a path argument from packaged-mode argv', () => {
    expect(getPathArgFromArgv(['/Applications/View Master.app/Contents/MacOS/View Master', '/some/path'], true)).toBe(
      '/some/path'
    )
  })

  it('extracts a path argument from dev-mode argv (electron binary + entry-point arg both skipped)', () => {
    expect(getPathArgFromArgv(['/usr/local/bin/electron', '.', '/some/path'], false)).toBe('/some/path')
  })

  it('returns null when no path argument is present (packaged)', () => {
    expect(getPathArgFromArgv(['/Applications/View Master.app/Contents/MacOS/View Master'], true)).toBeNull()
  })

  it('returns null when no path argument is present (dev)', () => {
    expect(getPathArgFromArgv(['/usr/local/bin/electron', '.'], false)).toBeNull()
  })

  it('returns null when only flag-like arguments are present', () => {
    expect(getPathArgFromArgv(['/Applications/View Master.app/Contents/MacOS/View Master', '--foo'], true)).toBeNull()
  })

  it('skips a flag that appears before the real path argument', () => {
    expect(
      getPathArgFromArgv(['/Applications/View Master.app/Contents/MacOS/View Master', '--foo', '/some/path'], true)
    ).toBe('/some/path')
  })

  it("skips macOS's -psn_ process-serial-number argument the same way as any other flag", () => {
    expect(
      getPathArgFromArgv(
        ['/Applications/View Master.app/Contents/MacOS/View Master', '-psn_0_12345', '/some/path'],
        true
      )
    ).toBe('/some/path')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/argv.test.ts`
Expected: FAIL — `Cannot find module './argv'` (the file doesn't exist yet).

- [ ] **Step 3: Implement `getPathArgFromArgv`**

Create `src/main/argv.ts`:

```ts
/**
 * Extracts the first path-like argument from `argv`, skipping Electron's
 * own leading arguments (the packaged app's own executable path, or in
 * dev mode both the electron binary and the entry-point/project-dir arg)
 * and any flag-like arguments (starting with `-`, e.g. Chromium/Electron
 * flags or macOS's `-psn_...` process-serial-number arg passed on a
 * Finder-launched app). Returns null if nothing qualifies.
 */
export function getPathArgFromArgv(argv: string[], isPackaged: boolean): string | null {
  const userArgs = argv.slice(isPackaged ? 1 : 2)
  return userArgs.find((arg) => !arg.startsWith('-')) ?? null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/argv.test.ts`
Expected: PASS (7/7 tests).

- [ ] **Step 5: Wire it into the existing auto-open hook**

Read `src/main/index.ts` in full first to confirm it still matches (it should be unchanged since this plan was written — the hook is currently at lines 150-154, inside `createWindow()`). Current imports (lines 1-5):

```ts
import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import { join } from 'path'
import { registerIpc, disposeIpc } from './ipc'
import { getRecentFolders, getWindowBounds, setWindowBounds } from './store'
import icon from '../../resources/icon.png?asset'
```

Add one import line:

```ts
import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import { join } from 'path'
import { registerIpc, disposeIpc } from './ipc'
import { getRecentFolders, getWindowBounds, setWindowBounds } from './store'
import { getPathArgFromArgv } from './argv'
import icon from '../../resources/icon.png?asset'
```

Current hook (lines 150-154):

```ts
  // Dev/testing hook: auto-open a folder on launch.
  const autoOpen = process.env['VIEWMASTER_OPEN']
  if (autoOpen) {
    win.webContents.on('did-finish-load', () => sendOpenFolder(autoOpen))
  }
```

Replace with:

```ts
  // Auto-open a folder on launch: VIEWMASTER_OPEN (dev/testing convenience)
  // or a CLI path argument (e.g. `viewmaster /some/path`, or an LLM telling
  // itself to open its own working folder) -- both funnel through the same
  // sendOpenFolder path the "Open Recent" menu already uses, so an invalid
  // path gets the same existing error-state handling openRepo already has,
  // no new validation needed here.
  const autoOpen = process.env['VIEWMASTER_OPEN'] ?? getPathArgFromArgv(process.argv, app.isPackaged)
  if (autoOpen) {
    win.webContents.on('did-finish-load', () => sendOpenFolder(autoOpen))
  }
```

Do not change anything else in this file — no single-instance-lock, no `second-instance` handler, no path validation added here (per the Global Constraints).

- [ ] **Step 6: Typecheck and run the full test suite**

Run: `npm run typecheck && npm test`
Expected: no typecheck errors; all tests pass, including the 7 new ones in `src/main/argv.test.ts`.

- [ ] **Step 7: Manual smoke check**

Use the `run-viewmaster` skill's underlying dev command (or equivalent) to launch the app with a trailing path argument after the entry point (dev-mode argv shape: `electron . /some/existing/folder`) and confirm it opens directly to that folder instead of showing the "no folder open" welcome screen. Then launch it with no path argument and confirm the welcome screen still shows as before (no regression to the no-argument case).

- [ ] **Step 8: Commit**

```bash
git add src/main/argv.ts src/main/argv.test.ts src/main/index.ts
git commit -m "feat: open directly to a folder passed as a CLI path argument

Generalizes the existing VIEWMASTER_OPEN dev/testing hook to also
accept a real command-line path argument, so the packaged app (or an
LLM invoking it) can jump straight to a working folder without the
manual Open Folder step. Reuses the existing sendOpenFolder path and
openRepo's existing error handling for an invalid path -- no new
validation, no single-instance-lock changes.

Resolves #32."
```
