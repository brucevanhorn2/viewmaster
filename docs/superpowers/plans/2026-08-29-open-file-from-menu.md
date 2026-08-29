# Open File From Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Open File…" item to View Master's File menu that opens a picked file directly, showing its containing folder in the sidebar — whether or not that folder is a git repo.

**Architecture:** The main process picks a file via a native dialog, computes its containing folder, and sends both to the renderer over a new IPC channel that mirrors the app's existing "Open Folder…" flow exactly. The renderer opens that folder through its existing `openRepo` plumbing (already handles both git-repo and plain-folder roots) and then seeds the navigation stack with the picked file, reusing the same mechanism search/link jumps already use to display a file outside the current listing.

**Tech Stack:** Electron (`dialog.showOpenDialog`, IPC), TypeScript, React.

**Spec:** GitHub issue #41 ("Ability to directly open a file from the File Open menu") — approved design (bounded path, no separate spec document): add "Open File…" to the File menu (no keyboard accelerator), right after "Open Folder…" and before "Open Recent". No changes to `src/main/ipc.ts` or `src/shared/types.ts` — this reuses existing `openRepo`/`computeRepoState` plumbing and the existing navigation-stack mechanism.

## Global Constraints

- No keyboard accelerator on the new "Open File…" menu item (avoids reassigning/conflicting with the existing `CmdOrCtrl+O` on "Open Folder…").
- No changes to `src/main/ipc.ts` or `src/shared/types.ts` — everything needed already exists there.
- `src/preload/index.d.ts` needs no edit — `ViewmasterApi` is `typeof api` (see `src/preload/index.ts:63`), so adding a method to `api` updates the exposed type automatically.
- No automated tests for this task — matches this codebase's existing convention of not unit-testing Electron menu/IPC wiring (`src/main/index.ts`) or React components (`src/renderer/src/App.tsx`); verification is `npm run typecheck` plus a manual run via the `run-viewmaster` skill.

---

### Task 1: Wire "Open File…" through main, preload, and renderer

**Files:**
- Modify: `src/main/index.ts:2` (import), `src/main/index.ts:18-20` (add `sendOpenFile`), `src/main/index.ts:38-45` (add `pickFile`), `src/main/index.ts:52-68` (add the menu item)
- Modify: `src/preload/index.ts:41-42` (add `onMenuOpenFile`)
- Modify: `src/renderer/src/App.tsx:70-84` (add `openFile` callback + its subscription)

**Interfaces:**
- Produces: IPC channel `'menu:openFile'`, carrying `{ root: string; absPath: string }`; preload method `onMenuOpenFile(cb: (payload: { root: string; absPath: string }) => void): () => void`, exposed on `window.viewmaster` (via `ViewmasterApi = typeof api`).
- Consumes: `openRepo` (`window.viewmaster.openRepo`, already exists), `pushEntry`/`initialNavigationState` (already imported in `App.tsx` from `./navigation/history`).

- [ ] **Step 1: Add `dirname` to the `path` import**

In `src/main/index.ts`, change line 2 from:

```ts
import { join } from 'path'
```

to:

```ts
import { join, dirname } from 'path'
```

- [ ] **Step 2: Add `sendOpenFile`, right after `sendOpenFolder`**

In `src/main/index.ts`, after the existing `sendOpenFolder` function (lines 18-20):

```ts
function sendOpenFolder(root: string): void {
  getMainWindow()?.webContents.send('menu:openFolder', root)
}

function sendOpenFile(root: string, absPath: string): void {
  getMainWindow()?.webContents.send('menu:openFile', { root, absPath })
}
```

- [ ] **Step 3: Add `pickFile`, right after `pickFolder`**

In `src/main/index.ts`, after the existing `pickFolder` function (lines 38-45):

```ts
async function pickFolder(): Promise<void> {
  const win = getMainWindow()
  if (!win) return
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (!result.canceled && result.filePaths.length > 0) {
    sendOpenFolder(result.filePaths[0])
  }
}

async function pickFile(): Promise<void> {
  const win = getMainWindow()
  if (!win) return
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'] })
  if (!result.canceled && result.filePaths.length > 0) {
    const absPath = result.filePaths[0]
    sendOpenFile(dirname(absPath), absPath)
  }
}
```

- [ ] **Step 4: Add the "Open File…" menu item**

In `src/main/index.ts`'s `buildMenu()`, the `File` submenu currently reads (lines 52-68):

```ts
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickFolder()
        },
        {
          label: 'Open Recent',
          submenu: recents.length
            ? recents.map((root) => ({ label: root, click: () => sendOpenFolder(root) }))
            : [{ label: 'No Recent Folders', enabled: false }]
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
```

Add an "Open File…" entry between "Open Folder…" and "Open Recent" (no `accelerator` — see Global Constraints):

```ts
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickFolder()
        },
        {
          label: 'Open File…',
          click: () => void pickFile()
        },
        {
          label: 'Open Recent',
          submenu: recents.length
            ? recents.map((root) => ({ label: root, click: () => sendOpenFolder(root) }))
            : [{ label: 'No Recent Folders', enabled: false }]
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
```

- [ ] **Step 5: Add `onMenuOpenFile` to the preload API**

In `src/preload/index.ts`, the `api` object currently has, right after `openRepo` and near the other `onMenu*` subscriptions:

```ts
  onMenuOpenFolder: (cb: (root: string) => void): (() => void) =>
    subscribe('menu:openFolder', cb),
```

Add a new entry directly after it:

```ts
  onMenuOpenFolder: (cb: (root: string) => void): (() => void) =>
    subscribe('menu:openFolder', cb),
  onMenuOpenFile: (cb: (payload: { root: string; absPath: string }) => void): (() => void) =>
    subscribe('menu:openFile', cb),
```

`src/preload/index.d.ts` needs no change — `ViewmasterApi` is `typeof api` (`src/preload/index.ts:63`), so the new method is picked up automatically.

- [ ] **Step 6: Add the `openFile` callback and its subscription in `App.tsx`**

In `src/renderer/src/App.tsx`, the `openFolder` callback and its subscription currently read (lines 70-84):

```ts
  const openFolder = useCallback((root: string): void => {
    void window.viewmaster.openRepo(root).then((state) => {
      setRepo(state)
      setNavState(initialNavigationState())
    })
  }, [])

  const setMode = useCallback((mode: SidebarMode): void => {
    void window.viewmaster.setMode(mode).then((state) => {
      if (!state) return
      setRepo(state)
    })
  }, [])

  useEffect(() => window.viewmaster.onMenuOpenFolder(openFolder), [openFolder])
```

Add an `openFile` callback right after `openFolder`, and its subscription right after the existing one:

```ts
  const openFolder = useCallback((root: string): void => {
    void window.viewmaster.openRepo(root).then((state) => {
      setRepo(state)
      setNavState(initialNavigationState())
    })
  }, [])

  const openFile = useCallback((payload: { root: string; absPath: string }): void => {
    void window.viewmaster.openRepo(payload.root).then((state) => {
      setRepo(state)
      setNavState(pushEntry(initialNavigationState(), { absPath: payload.absPath }))
    })
  }, [])

  const setMode = useCallback((mode: SidebarMode): void => {
    void window.viewmaster.setMode(mode).then((state) => {
      if (!state) return
      setRepo(state)
    })
  }, [])

  useEffect(() => window.viewmaster.onMenuOpenFolder(openFolder), [openFolder])
  useEffect(() => window.viewmaster.onMenuOpenFile(openFile), [openFile])
```

`pushEntry` and `initialNavigationState` are already imported at the top of `App.tsx` from `./navigation/history` — no new imports needed.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

Expected: passes with no errors.

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/renderer/src/App.tsx
git commit -m "feat: add Open File… to the File menu"
```

---

### Task 2: Verify the full flow with a real running app

**Files:**
- Modify: `.claude/skills/run-viewmaster/driver.mjs:140-146` (extend `send-ipc` to optionally carry a JSON payload)

**Interfaces:**
- Consumes: the `'menu:openFile'` channel and `{ root, absPath }` payload shape from Task 1.
- Produces: nothing consumed by another task — this is the last task in the plan.

Native file/folder dialogs can't be automated under `xvfb` (per the `run-viewmaster` skill's own documented gotchas), so verifying this feature end-to-end means simulating the *result* of a dialog pick — the `'menu:openFile'` IPC message `pickFile` sends once a user has chosen a file. The driver's existing `send-ipc <channel>` command sends a channel with no payload, which doesn't fit this channel's shape. Extend it to accept an optional JSON payload, then use it to drive the new feature exactly as `pickFile` would.

- [ ] **Step 1: Extend `send-ipc` to accept an optional JSON payload**

In `.claude/skills/run-viewmaster/driver.mjs`, this command currently reads (lines 140-146):

```js
  async 'send-ipc'(channel) {
    if (!app) return console.log('ERROR: launch first')
    await app.evaluate(({ BrowserWindow }, ch) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch)
    }, channel)
    console.log('send-ipc', channel, '→ sent')
  },
```

Replace it with a version that splits off an optional trailing JSON payload (the REPL joins all arguments after the command into one string, so `channel` here is actually `"<channel> [json-payload]"`):

```js
  async 'send-ipc'(argStr) {
    if (!app) return console.log('ERROR: launch first')
    const spaceIdx = argStr.indexOf(' ')
    const channel = spaceIdx === -1 ? argStr : argStr.slice(0, spaceIdx)
    const payloadStr = spaceIdx === -1 ? undefined : argStr.slice(spaceIdx + 1).trim()
    const payload = payloadStr ? JSON.parse(payloadStr) : undefined
    await app.evaluate(
      ({ BrowserWindow }, { ch, p }) => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch, p)
      },
      { ch: channel, p: payload }
    )
    console.log('send-ipc', channel, '→ sent', payload ?? '')
  },
```

This is backward-compatible: `send-ipc menu:findInFiles` (no payload) still works exactly as before, since `payload` is `undefined` when no JSON follows the channel name.

- [ ] **Step 2: Install dependencies and build the app**

Each git worktree has its own separate `node_modules/`, so this worktree needs its own install even if another worktree already has one built:

```bash
sudo apt-get update
sudo apt-get install -y xvfb libnss3 libgbm1 libasound2t64 libgtk-3-0 \
  libxss1 libxkbcommon0 libatk-bridge2.0-0 libcups2 libdrm2
npm install
node node_modules/electron/install.js
ls node_modules/electron/dist/electron  # must exist
npm run build
```

Expected: `npm run build` completes without error, producing `out/main/`, `out/preload/`, `out/renderer/`.

- [ ] **Step 3: Launch the app under tmux + xvfb**

```bash
tmux new-session -d -s vmopenfile -x 220 -y 50
tmux send-keys -t vmopenfile 'xvfb-run -a --server-args="-screen 0 1280x900x24" node .claude/skills/run-viewmaster/driver.mjs' Enter
timeout 15 bash -c 'until tmux capture-pane -t vmopenfile -p | grep -q "driver>"; do sleep 0.2; done'
tmux send-keys -t vmopenfile 'launch' Enter
timeout 20 bash -c 'until tmux capture-pane -t vmopenfile -p | grep -q "launched"; do sleep 0.2; done'
```

Expected: the second `timeout` exits without a timeout error.

- [ ] **Step 4: Simulate picking this repo's own README.md via the new menu item**

```bash
tmux send-keys -t vmopenfile "send-ipc menu:openFile {\"root\":\"$(pwd)\",\"absPath\":\"$(pwd)/README.md\"}" Enter
sleep 1
tmux send-keys -t vmopenfile 'ss open-file-readme' Enter
sleep 1
tmux capture-pane -t vmopenfile -p | tail -20
```

Expected: no error output in the captured pane, and `/tmp/shots/open-file-readme.png` is created.

- [ ] **Step 5: Confirm the right file actually opened**

```bash
tmux send-keys -t vmopenfile 'eval document.querySelector(".sidebar-header-label")?.textContent ?? document.querySelector(".sidebar-message")?.textContent' Enter
sleep 1
tmux capture-pane -t vmopenfile -p | tail -10
```

Expected: the printed text reflects this repo's root path or its resolved baseline label (confirming the folder opened), not an error message. Visually confirm via the screenshot from Step 4 that the main pane shows README.md's rendered markdown content (not a blank pane or "File not found").

- [ ] **Step 6: Quit and clean up**

```bash
tmux send-keys -t vmopenfile 'quit' Enter
sleep 1
tmux kill-session -t vmopenfile
```

- [ ] **Step 7: Commit the driver enhancement**

```bash
git add .claude/skills/run-viewmaster/driver.mjs
git commit -m "test: let send-ipc carry an optional JSON payload"
```
