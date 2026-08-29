# Top Menu Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder ViewMaster's application menu bar to the conventional `File | Edit | View | Navigate | Window` layout, moving the standalone Search menu's items into Edit and renaming Go to Navigate.

**Architecture:** Single-file change to the Electron menu template built in `buildMenu()` in `src/main/index.ts`. No renderer, preload, or IPC changes — the click handlers, accelerators, and IPC channel names for the moved items stay exactly as they are today; only their position in the template array changes.

**Tech Stack:** Electron `Menu.buildFromTemplate`, TypeScript, vitest.

**Spec:** GitHub issue #42 ("top menu order") — approved design (resolved via brainstorming): move `Find in Files…` / `Related Files…` from the standalone Search menu into Edit (JetBrains convention: Edit menu has a Find section); rename Go to Navigate and move it to sit after View (JetBrains convention: Navigate is its own top-level menu, positioned after View, before Window). Final order: `File | Edit | View | Navigate | Window`.

## Global Constraints

- Do not change any accelerator, click handler, or IPC channel name for `Open Folder…`, `Open Recent`, `Find in Files…`, `Related Files…`, `Back`, or `Forward` — only their position in the menu template.
- `src/main/index.ts` currently has no dedicated test file (Electron `Menu`/`BrowserWindow`/`app` APIs aren't unit-tested anywhere in this codebase — see `git/`, `search/`, `history/`, `files/` for the pattern: pure logic gets vitest coverage, Electron wiring in `index.ts` does not). Follow that convention: no new test file for this change. Verify manually via the `run-viewmaster` skill instead.
- Preserve the existing `process.platform === 'darwin'` conditional style already used in this file (e.g. line 66's close/quit split) when building the platform-aware Edit submenu.

---

### Task 1: Reorder the application menu template

**Files:**
- Modify: `src/main/index.ts:47-104` (`buildMenu()`)

**Interfaces:**
- Consumes: existing handlers already defined earlier in the file — `pickFolder()`, `sendOpenFolder(root: string)`, `sendFindInFiles()`, `sendRelatedFiles()`, `sendGoBack()`, `sendGoForward()`, and the `recents: string[]` array from `getRecentFolders()`. None of these signatures change.
- Produces: nothing consumed by other tasks — this is the only task in the plan.

The current `buildMenu()` (for reference, do not copy verbatim — this is what exists today before the change):

```ts
function buildMenu(): void {
  const recents = getRecentFolders()
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
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
    },
    {
      label: 'Search',
      submenu: [
        {
          label: 'Find in Files…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => sendFindInFiles()
        },
        {
          label: 'Related Files…',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => sendRelatedFiles()
        }
      ]
    },
    {
      label: 'Go',
      submenu: [
        {
          label: 'Back',
          accelerator: process.platform === 'darwin' ? 'Cmd+[' : 'Alt+Left',
          click: () => sendGoBack()
        },
        {
          label: 'Forward',
          accelerator: process.platform === 'darwin' ? 'Cmd+]' : 'Alt+Right',
          click: () => sendGoForward()
        }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
```

- [x] **Step 1: Replace `buildMenu()` with the reordered template**

Replace the entire function body (lines 47-104) with:

```ts
function buildMenu(): void {
  const recents = getRecentFolders()
  const editExtras: Electron.MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
          }
        ]
      : [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ]

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
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
    },
    {
      label: 'Edit',
      submenu: [
        ...editExtras,
        { type: 'separator' },
        {
          label: 'Find in Files…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => sendFindInFiles()
        },
        {
          label: 'Related Files…',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => sendRelatedFiles()
        }
      ]
    },
    { role: 'viewMenu' },
    {
      label: 'Navigate',
      submenu: [
        {
          label: 'Back',
          accelerator: process.platform === 'darwin' ? 'Cmd+[' : 'Alt+Left',
          click: () => sendGoBack()
        },
        {
          label: 'Forward',
          accelerator: process.platform === 'darwin' ? 'Cmd+]' : 'Alt+Right',
          click: () => sendGoForward()
        }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
```

- [x] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes with no errors (the `editExtras` array must satisfy `Electron.MenuItemConstructorOptions[]` — if TypeScript complains about the literal object shapes, keep the explicit `Electron.MenuItemConstructorOptions[]` annotation on `editExtras` as shown above).

- [x] **Step 3: Manually verify the menu in the running app**

Use the `run-viewmaster` skill to launch the app and take a screenshot of the menu bar. Confirm:
- Top-level order is `File | Edit | View | Navigate | Window` (plus the macOS app menu first, if running on macOS).
- `Edit` menu shows standard items (Undo/Redo/Cut/Copy/Paste/etc.) followed by a separator, then `Find in Files…` and `Related Files…`.
- `Navigate` menu shows `Back` and `Forward`.
- Clicking `Find in Files…`, `Related Files…`, `Back`, and `Forward` still trigger their existing behavior (find-in-files panel opens, related-files panel opens, navigation moves through history) — these are unchanged handlers, so this is a smoke check, not new behavior.

- [x] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all existing tests still pass (this change touches no code any existing test exercises, so this is a regression check).

- [x] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: reorder application menu to File | Edit | View | Navigate | Window"
```
