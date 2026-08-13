---
name: run-viewmaster
description: Build, run, and drive the View Master Electron desktop app. Use when asked to start viewmaster, launch the app, take a screenshot of it, or interact with its UI (open a folder, toggle Changed/Browse, click a file, view a diff).
---

View Master is an Electron desktop app (read-only viewer for markdown documents and git branch diffs). Drive it via the Playwright `_electron` REPL at `.claude/skills/run-viewmaster/driver.mjs`, run under `xvfb-run` since this container has no display. Launch takes ~3s; the interesting flows (opening a folder, the Changed/Browse toggle, viewing a file) all go through the driver's commands below.

All paths are relative to the repo root.

## Prerequisites

```bash
sudo apt-get update
sudo apt-get install -y xvfb libnss3 libgbm1 libasound2t64 libgtk-3-0 \
  libxss1 libxkbcommon0 libatk-bridge2.0-0 libcups2 libdrm2
```

## Setup

```bash
npm install
```

Electron's own postinstall does **not** run automatically here — this
package version ships no `postinstall` lifecycle hook at all (check
`node_modules/electron/package.json`'s `scripts` field: it's absent), so
`npm install` alone leaves `node_modules/electron/dist/` empty. Prime it
explicitly:

```bash
node node_modules/electron/install.js
```

Verify it worked: `ls node_modules/electron/dist/electron` should exist.

`playwright-core` (the driver's dependency) is already a `devDependency` in
`package.json`, so the `npm install` above pulls it in — no separate step.

## Build

```bash
npm run build
```

Takes ~2-3 minutes (bundles a lot of language grammars for syntax
highlighting). Output goes to `out/main/`, `out/preload/`, `out/renderer/`.
The driver launches this built output directly, not `npm run dev` (which
spawns a Vite dev server + hot reload — more moving parts than a headless
driver needs).

## Run (agent path)

```bash
xvfb-run -a --server-args="-screen 0 1280x900x24" node .claude/skills/run-viewmaster/driver.mjs
```

Wrap in tmux so you can send commands and read output over multiple tool
calls:

```bash
tmux new-session -d -s vmapp -x 220 -y 50
tmux send-keys -t vmapp 'xvfb-run -a --server-args="-screen 0 1280x900x24" node .claude/skills/run-viewmaster/driver.mjs' Enter
timeout 15 bash -c 'until tmux capture-pane -t vmapp -p | grep -q "driver>"; do sleep 0.2; done'
tmux send-keys -t vmapp 'launch' Enter
timeout 20 bash -c 'until tmux capture-pane -t vmapp -p | grep -q "launched"; do sleep 0.2; done'
tmux send-keys -t vmapp 'ss landing' Enter
tmux capture-pane -t vmapp -p
```

Screenshots land in `/tmp/shots/` (override with `SCREENSHOT_DIR`).

### Opening a folder

There's no native-dialog automation under xvfb, so don't try to click
"Open Folder…" — use `open-path` instead, which calls the app's own
`window.viewmaster.openRepo(path)` preload API directly (the same IPC call
a real folder pick or a Recent-list click triggers):

```
driver> open-path /absolute/path/to/a/folder
```

This returns the raw `RepoState` JSON but does **not** update the
already-rendered Welcome screen's React state (its Recent list only fetches
once, on mount). To actually drive the opened folder through the real UI —
toggle, sidebar, content pane, all of it — reload the page and click the
newly-added Recent entry:

```
driver> eval location.reload()
driver> click .recent-item
```

### Commands

| command | what it does |
|---|---|
| `launch` | launch the app, wait for the window |
| `ss [name]` | screenshot → `/tmp/shots/<name>.png` |
| `open-path <dir>` | open a folder via the preload API (see above — reload + click a recent item to reflect it in the UI) |
| `click <css-sel>` | click element via DOM `.click()` |
| `click-text <text>` | click a `button`/`a`/`[role=button]` containing that text (the toolbar buttons: Changed, Browse, Rendered, Marks, Source, Diff, Inline/Side by side) |
| `click-row <name>` | click a sidebar file/dir row by its exact visible name — these are plain `div`s, not buttons/links, so `click-text` won't find them |
| `type <text>` / `press <key>` | keyboard input |
| `wait <css-sel>` | wait for element, 10s timeout |
| `eval <js>` | evaluate in the page, print JSON |
| `text [css-sel]` | print `innerText` |
| `windows` | list Electron windows |
| `quit` | close app, exit driver |

## Run (human path)

```bash
npm run dev   # hot-reload dev build; opens a window. Useless headless.
```

## Test

```bash
npm run typecheck   # tsc, both tsconfig.node.json and tsconfig.web.json
npm test             # vitest — 98/98 passing as of this writing
```

## Gotchas

- **Electron's binary doesn't download via `npm install`.** See Setup —
  this package version has no `postinstall` script at all; run
  `node node_modules/electron/install.js` explicitly after every fresh
  `npm install` in a new environment.
- **Sidebar file/dir rows aren't clickable via `click-text`.** They're
  `<div className="tree-row">` with an `onClick`, not `button`/`a`
  elements — `click-text` searches only interactive elements. Use
  `click-row <exact-name>` instead (matches `.file-name`/`.dir-name` text).
- **The Welcome screen's Recent list doesn't live-update.** `open-path`
  calls the IPC handler directly, which does add the folder to the
  persisted recents list — but the already-mounted React component fetched
  its `recents` state once, on mount, and won't reflect the change until
  you `eval location.reload()`.
- **`--no-sandbox` is required.** Electron's sandbox needs
  `CAP_SYS_ADMIN`/user namespaces this container doesn't have without it;
  the driver already passes this flag.
- **Chrome's own sandbox helper still needs setuid outside this driver.**
  Running the *built app* directly (not via the driver) hits
  `FATAL:setuid_sandbox_host.cc` unless `node_modules/electron/dist/chrome-sandbox`
  is `root:root` mode `4755` — not needed for the driver (`--no-sandbox`
  covers it), but relevant if you ever run `npm run dev`/`npm start`
  directly in a container.

## Troubleshooting

- **`ls node_modules/electron/dist/electron` → No such file or directory**:
  the postinstall didn't run. Fix: `node node_modules/electron/install.js`
  (see Gotchas).
- **`Cannot find package 'playwright-core'`**: the driver was run from
  outside the repo, or with a `cwd` that doesn't resolve `node_modules`
  back to this project (e.g. copying `driver.mjs` elsewhere without also
  copying/symlinking `node_modules`). Run it from the repo root as shown
  above.
- **Screenshot is the Welcome screen when you expected an open folder**:
  you called `open-path` but never reloaded — see the Gotcha above.
