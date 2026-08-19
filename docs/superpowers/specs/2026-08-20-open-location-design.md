# View Master — Open Location (Design Spec)

**Date:** 2026-08-20
**Status:** Approved
**Resolves:** issue #25.

## Purpose

The issue's ask: "As a user of viewmaster, I would like to be able to
right click any file or folder and have a menu option... which opens the
file's location in the OS's file browser so that I can easily drag the
file into chat, email, or other collaboration tools." A right-click
context menu already exists in the sidebar, but only for individual files
(`ContentMenuState { file: ChangedFile }`, wired only to `FileRow`) — it
has no menu item for this yet, and folders (nested tree dirs, and the
root folder header) have no context menu at all.

## Load-bearing decisions

1. **Electron's built-in `shell.showItemInFolder(absPath)`**, not a
   hand-rolled per-OS command. It already does exactly what's asked —
   opens the OS file browser with the item pre-selected — cross-platform,
   with no new dependency (`shell` is already imported in
   `src/main/ipc.ts` for the existing `app:openExternal` handler).
2. **Generic label: "Open location."** Not "Open in Explorer / Finder" (the
   issue's literal title) or any other platform-specific phrasing — avoids
   needing to expose `process.platform` to the renderer at all, which
   nothing currently does.
3. **The context menu is generalized to cover files, nested folders, and
   the root folder**, not just files. `ContextMenuState` changes from
   `{ x, y, file: ChangedFile }` to `{ x, y, label, absPath }` — a plain
   absolute-path-plus-label shape, since dir nodes and the root header
   have no `ChangedFile` to carry. A dir's absolute path is computed as
   `state.root + '/' + node.path` (root-level dirs, whose `TreeNode.path`
   is already the plain top-level name, join correctly); the root header's
   is `state.root` directly.
4. **"Copy absolute path" stays file-only**, unchanged from today —
   broadening it to dirs/root is out of scope for this issue, not asked
   for. Only "Open location" is added to all three trigger points
   (file row, dir row, root header).

## Main process changes

`src/main/ipc.ts`: new handler, following the exact `app:copyPath`
pattern:
```ts
ipcMain.handle('app:showInFolder', (_e, absPath: string): void => {
  shell.showItemInFolder(absPath)
})
```

`src/preload/index.ts`: `showInFolder: (absPath: string): void => { void
ipcRenderer.invoke('app:showInFolder', absPath) }`, matching `copyPath`'s
exact shape.

## Renderer changes

`src/renderer/src/components/Sidebar.tsx`:
- `ContextMenuState` changes from `{ x: number; y: number; file:
  ChangedFile }` to `{ x: number; y: number; absPath: string; isFile:
  boolean }` — `isFile` is the explicit discriminant "Copy absolute path"
  gates on (decision 4), settled here rather than left for the plan to
  invent.
- `FileRow`'s existing `onContextMenu` prop signature changes from
  `(e, file: ChangedFile) => void` to `(e, absPath: string) => void` —
  its call site passes `file.absPath` and the handler sets `isFile: true`.
- `DirNode` gains an `onContextMenu` handler on its `tree-row dir-row`
  div (currently has none), passing its computed absolute path; the
  handler sets `isFile: false`.
- The root folder header (`sidebar-header`) gains an `onContextMenu`
  handler using `state.root` directly; also sets `isFile: false`.
- The context menu's "Copy absolute path" item reads `menu.absPath`
  (previously `menu.file.absPath`) and renders only when `menu.isFile` is
  true.
- New context menu item: "Open location", calling
  `window.viewmaster.showInFolder(menu.absPath)`, rendered unconditionally
  for all three trigger points (files and non-files alike).

## Module layout

```
src/main/ipc.ts                              app:showInFolder handler (modified)
src/preload/index.ts                         showInFolder bridge (modified)
src/renderer/src/components/Sidebar.tsx      generalized context menu (modified)
```

## Testing

No automated test — no `.tsx` test infrastructure exists in this
codebase (true of every other renderer component). Covered by a short
manual verification step: right-click a file, a nested folder, and the
root folder header; confirm "Open location" appears in all three and
opens the OS file browser at the right location; confirm "Copy absolute
path" still only appears for files and still works.

## Non-goals

- Platform-specific menu label text.
- Broadening "Copy absolute path" to folders/root.
- Any change to the existing file-row selection/click behavior.
