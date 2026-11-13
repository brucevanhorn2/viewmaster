# Second Look rename, new icon, signed macOS build — design (issue #58)

GitHub issue #58 is the design document. It is prescriptive (exact rename table, icon SVG,
`electron-builder.yml` block, entitlements plist, README sections) and the builder follows it
verbatim. This file records only what the issue does not say.

## Owner decisions (2026-11-13)

- **Migrate old data.** The rename changes Electron's default userData folder from
  `<appData>/View Master` to `<appData>/Second Look`. On first launch Second Look copies the
  old app's data across so recent folders, window bounds, per-folder sidebar modes and local
  history survive. The old folder is left in place (copy, not move).
- **Keep the default folder name with a space** (`Second Look`). The code never passes paths
  through a shell (git and language servers are spawned with argv arrays, file URLs come from
  `pathToFileURL`), and the install paths already contain spaces.

## Migration rules (builder's calls, made by the planner)

- What is copied: `config.json` (electron-store: `recentFolders`, `windowBounds`,
  `folderModes`) and the `history/` directory. Nothing else; the rest of the old folder is
  Chromium cache, and the renderer uses no localStorage/IndexedDB.
- When: only if the new userData is the *default* one (`join(appData, 'Second Look')`). An
  explicit `--user-data-dir` (e2e tests, dev runs) never migrates, so tests can't pick up the
  owner's real data.
- Once only: a marker file `migrated-from-view-master` is written in the new folder after the
  attempt, success or not. It also never runs if the new folder already has `config.json` or
  `history/`; existing Second Look data is never overwritten.
- Must run before anything opens userData. `src/main/store.ts` constructs electron-store at
  import time, so the migration is a side-effect import placed first in `src/main/index.ts`.
- Failures are logged (`[secondlook:migrate]`) and never block launch.

## Gaps in the issue's rename list (planner's calls)

- `e2e/` (added by #40 after the issue was written) is renamed too: `VIEWMASTER_OPEN`,
  `viewmaster-e2e-*` tmp prefixes.
- `.github/workflows/build.yml` (previously untracked in the owner's checkout) is committed
  with artifact names `second-look-${{ matrix.os }}`.
- The `run-viewmaster` skill's driver uses the new `window.secondLook` / `SECONDLOOK_OPEN`;
  its directory name stays (per the issue).
- `.claude/skills/factory/SKILL.md` mentions of "viewmaster" refer to the repo, which is not
  renamed yet: leave them.
- Icons are rasterized with Electron's own Chromium (`rsvg-convert` isn't installed on this
  machine, and ImageMagick's SVG renderer drops the drop-shadow filter).
