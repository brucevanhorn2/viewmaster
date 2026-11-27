# Second Look Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename View Master to Second Look, replace the toy-derived icon with the original SVG design, configure Developer ID signing + notarization, and carry users' old data across.

**Architecture:** Mostly a mechanical rename driven by the table in GitHub issue #58, plus one new main-process module (`src/main/userDataMigration.ts`) imported first in `src/main/index.ts` so it runs before electron-store opens userData.

**Tech Stack:** Electron 3x + electron-vite, TypeScript, vitest, Playwright e2e, electron-builder.

**Spec:** GitHub issue #58 (`gh issue view 58`): the primary spec, follow it verbatim. Also `docs/superpowers/specs/2026-11-13-second-look-rename-design.md` for owner decisions and gap-filling calls.

## Global Constraints

- Display name `Second Look`; npm name `second-look`; `appId: com.vanhorn.secondlook`; preload global `window.secondLook`, type `SecondLookApi`; env var `SECONDLOOK_OPEN`; log prefixes `[secondlook:...]`; tmpdir prefixes `secondlook-*`.
- Leave unchanged: GitHub URLs containing `brucevanhorn2/viewmaster`, `.claude/skills/*` directory names, `.claude/skills/factory/**`, `docs/superpowers/**`, `.claude/factory/**`.
- The icon SVG is exactly the one in the issue body. No toy/reel/viewer imagery anywhere.
- Do not enable the App Sandbox.
- Windows dev box: build with `node --max-old-space-size=4096 node_modules/electron-vite/bin/electron-vite.js build` (or `npm run build`); e2e with `npx playwright test -c e2e/playwright.config.ts` after building. If `npm ci` skipped the Electron binary: `node node_modules/electron/install.js`.
- Baseline: 8 unit tests already fail on master on this machine (browse.test ×3, git/run "rejects distinctly on a permission error", history/paths ×1, ipc.test "openRepo generation race", watcher ×2). They must not grow; their names will change only by the tmp prefix.
- Commit trailer: `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`.

## Review Focus

- e2e / `--user-data-dir` runs must never migrate the developer's real View Master data (test pins it).
- A Second Look folder that already has data is never overwritten by the migration (test pins it).
- Migration failure (unreadable old folder, disk full) must not stop the app launching (test pins it).
- Renamed preload global: every renderer caller and the run-viewmaster driver must use `window.secondLook`; a missed one is a runtime crash, not a type error, in `.mjs` (grep in Task 1 pins it).
- Packaged app name: `productName` must match in `package.json` and `electron-builder.yml` so the default userData folder is `Second Look` (Task 2 asserts it).

---

### Task 1: Rename (issue Part A) + commit the build workflow

**Files:** everything listed by
`git grep -nIiE "view ?master" -- . ':!package-lock.json' ':!docs/superpowers' ':!.claude/factory' ':!.claude/skills/factory'`
plus `package-lock.json` (only the first two `"name"` entries), `img/viewmaster.png` (`git mv` → `img/second-look.png`), and the untracked `.github/workflows/build.yml` (artifact `name: second-look-${{ matrix.os }}`; then `git add` it).

- [ ] **Step 1:** Apply the issue's Part A table. Includes `e2e/fixtures.ts` (`SECONDLOOK_OPEN`, `secondlook-e2e-userdata-`), and `.claude/skills/run-viewmaster/{driver.mjs,SKILL.md}` text and `window.secondLook` (dir name stays).
- [ ] **Step 2:** Verify: the grep above returns only `brucevanhorn2/viewmaster` URLs and `run-viewmaster` skill-path references. `git grep -n "window.viewmaster\|VIEWMASTER_OPEN\|ViewmasterApi"` returns nothing.
- [ ] **Step 3:** `npm run typecheck` clean; `npm test` shows only the 8 baseline failures.
- [ ] **Step 4:** Commit `refactor: rename View Master to Second Look (#58)`.

### Task 2: Data migration from the View Master folder

**Files:**
- Create: `src/main/userDataMigration.ts`, `src/main/userDataMigration.test.ts`, `src/main/migrateOnLoad.ts`
- Modify: `src/main/index.ts` (first import)

**Interfaces:**
- Produces: `migrateLegacyUserData(opts: { appDataDir: string; userDataDir: string; currentName: string; legacyName: string }): 'migrated' | 'skipped' | 'failed'` (pure, sync, `fs` only, no electron import).
- `migrateOnLoad.ts` is a side-effect module: `import { app } from 'electron'`, calls the function with `app.getPath('appData')`, `app.getPath('userData')`, `app.getName()`, `'View Master'`, logs failures as `[secondlook:migrate]`. In `index.ts` it is the **first** import (`import './migrateOnLoad'`), above `./ipc` and `./store`, because `store.ts` constructs electron-store at import time.

Rules (from the spec): only when `userDataDir === join(appDataDir, currentName)`; skip if `<userDataDir>/migrated-from-view-master` exists, or `config.json` or `history/` already exists there; source is `join(appDataDir, legacyName)`; copy `history/` (recursive, `fs.cpSync`) then `config.json`, only those that exist; create `userDataDir` if needed; write the marker after any attempt where the default-folder check passed and the legacy folder exists (success or failure); never throw.

- [ ] **Step 1: Failing tests** in `userDataMigration.test.ts`, each against a fresh `mkdtemp(tmpdir(), 'secondlook-migrate-')` appData:
  - `copies config.json and history/ from the legacy folder` → returns `'migrated'`; new `config.json` content equals old; `history/abc/state.json` exists; legacy folder still exists; marker exists.
  - `skips a non-default userData dir` (userDataDir elsewhere) → `'skipped'`, nothing written in the default folder or the custom one.
  - `never overwrites existing Second Look data` (new folder already has `config.json` with different content) → `'skipped'`, content unchanged.
  - `runs once` → second call after a migration returns `'skipped'` even if the new `config.json` was deleted.
  - `skips when there is no legacy folder` → `'skipped'`, no marker written.
  - `reports failure without throwing` (legacy `config.json` is a directory, so the copy throws) → `'failed'`, marker exists.
- [ ] **Step 2:** Run `npx vitest run src/main/userDataMigration.test.ts`; expect failures (module missing).
- [ ] **Step 3:** Implement `userDataMigration.ts` and `migrateOnLoad.ts`; add the import to `index.ts`.
- [ ] **Step 4:** Tests pass. Typecheck clean. Assert `package.json` `productName` and `electron-builder.yml` `productName` are both `Second Look`.
- [ ] **Step 5:** Commit `feat: carry View Master data over to Second Look on first launch (#58)`.

### Task 3: Icon (issue Part B)

**Files:** Create `resources/icon.svg` (exact issue SVG). Overwrite `resources/icon.png` (1024²), `img/second-look.png` (copy of it), `website/logo.png` (320²), `website/favicon.png` (64²). Modify `website/index.html` logo `<img>` to `width="160" height="160"`.

- [ ] **Step 1:** Write `resources/icon.svg` byte-for-byte from the issue.
- [ ] **Step 2:** Rasterize with Electron's Chromium (`rsvg-convert` is not installed; ImageMagick drops the `feDropShadow` filter). Use a throwaway script outside the repo (e.g. in `%TEMP%`): an offscreen `BrowserWindow` with transparent background at the target size, load the SVG, `webContents.capturePage()` → `toPNG()`. Set `deviceScaleFactor`/zoom so output pixels equal the target size exactly. Run it with `node_modules/electron/dist/electron(.exe)`. Do not commit the script.
- [ ] **Step 3:** Verify each PNG's dimensions (e.g. `magick identify`), view `resources/icon.png` and confirm it shows the documents + magnifier with transparent corners and the drop shadow. `git grep -l` / `ls` shows no remaining old artwork (all four old PNGs replaced).
- [ ] **Step 4:** Commit `feat: original Second Look icon (#58)`.

### Task 4: Signing config + README (issue Parts C and D)

**Files:** Modify `electron-builder.yml` (replace `publish`/`mac` per Part C verbatim; drop the "unsigned" comments and `identity: null`), create `resources/entitlements.mac.plist` (verbatim), modify `README.md` (Part D).

- [ ] **Step 1:** Apply Part C. Note `files:` excludes `resources/*` from the app bundle; that's fine because electron-builder reads `entitlements` from the project, not the bundle.
- [ ] **Step 2:** Apply Part D: "Releasing (macOS)" section replacing "Running an unsigned macOS build" (one-time setup, `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`, `npm run dist:mac`, CI `CSC_LINK` / `CSC_KEY_PASSWORD`, unsigned escape hatch `npx electron-builder --mac -c.mac.identity=null -c.mac.notarize=false`, system `git` requirement). Remove the #12 roadmap bullet. Also mention that on first launch Second Look copies recent folders and local history from View Master.
- [ ] **Step 3:** `node -e "require('js-yaml')"`-free check: `npx electron-builder --help` is not needed; instead verify the YAML parses with `node -e "console.log(JSON.stringify(require('yaml').parse(require('fs').readFileSync('electron-builder.yml','utf8')).mac))"` if `yaml` is installed, else by eye against the issue.
- [ ] **Step 4:** Commit `build: Developer ID signing and notarization for macOS (#58)`.

### Task 5: Whole-app check

- [ ] **Step 1:** `npm run build`, then `npx playwright test -c e2e/playwright.config.ts`: all pass.
- [ ] **Step 2:** Launch the built app (run-viewmaster driver, or Playwright `_electron`) with an isolated `--user-data-dir`: window title is "Second Look", welcome heading says Second Look, `window.secondLook` exists.
- [ ] **Step 3:** Run the issue's acceptance grep: `grep -rniE "view ?master|viewmaster"` outside the leave-unchanged list returns nothing except the migration's `'View Master'` legacy-name constant, its marker filename, its test, and the README migration note (intended).
- [ ] **Step 4:** Commit any fixes.
