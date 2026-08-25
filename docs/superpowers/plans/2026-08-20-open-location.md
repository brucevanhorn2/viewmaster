# Open Location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Open location" context-menu item to the sidebar's files, nested folders, and root folder header, which opens the OS file browser at that item's location.

**Architecture:** A new main-process IPC handler wraps Electron's built-in `shell.showItemInFolder(absPath)`. The sidebar's existing file-only context menu is generalized to a plain `{ absPath, isFile }` shape so it can be triggered from dir rows and the root header too, neither of which currently has any right-click handling at all.

**Tech Stack:** TypeScript, Electron main process, React renderer.

## Global Constraints

- `shell.showItemInFolder(absPath)` is Electron's built-in API — cross-platform, no new dependency. `shell` is already imported in `src/main/ipc.ts`.
- Menu label is the literal string `"Open location"` — no platform-specific text (no `process.platform` exposure needed anywhere).
- `ContextMenuState` changes from `{ x, y, file: ChangedFile }` to `{ x, y, absPath: string, isFile: boolean }`.
- "Copy absolute path" stays gated to `menu.isFile === true` — unchanged behavior for files, no new behavior for dirs/root.
- "Open location" renders unconditionally for all three trigger points (file row, dir row, root header).

---

### Task 1: `app:showInFolder` IPC handler + preload bridge

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `window.viewmaster.showInFolder(absPath: string): void` — Task 2's Sidebar context menu calls this.

No automated test — no unit test framework covers any `ipc.ts` handler or preload method in this codebase (true of every existing one, e.g. `app:copyPath`). Covered by Task 3's manual verification.

- [ ] **Step 1: Add the IPC handler**

In `src/main/ipc.ts`, find the existing `app:copyPath` handler:

```ts
  ipcMain.handle('app:copyPath', (_e, absPath: string): void => {
    clipboard.writeText(absPath)
  })
```

Add a new handler right after it:

```ts
  ipcMain.handle('app:showInFolder', (_e, absPath: string): void => {
    shell.showItemInFolder(absPath)
  })
```

- [ ] **Step 2: Add the preload bridge method**

In `src/preload/index.ts`, find the existing `copyPath` method:

```ts
  copyPath: (absPath: string): void => {
    void ipcRenderer.invoke('app:copyPath', absPath)
  },
```

Add a new method right after it:

```ts
  showInFolder: (absPath: string): void => {
    void ipcRenderer.invoke('app:showInFolder', absPath)
  },
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS (no new tests — existing suite unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat: add app:showInFolder IPC handler and preload bridge"
```

---

### Task 2: Generalize the sidebar context menu to files, folders, and the root

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `window.viewmaster.showInFolder` (Task 1).
- Produces: no new exported interface — this is the feature's UI integration point.

No automated test — no `.tsx` test infrastructure in this codebase. Covered by Task 3.

- [ ] **Step 1: Change `ContextMenuState`'s shape**

In `src/renderer/src/components/Sidebar.tsx`, change:

```ts
interface ContextMenuState {
  x: number
  y: number
  file: ChangedFile
}
```

to:

```ts
interface ContextMenuState {
  x: number
  y: number
  absPath: string
  isFile: boolean
}
```

- [ ] **Step 2: Update `FileRow`'s `onContextMenu` prop signature and call site**

`FileRow`'s prop type currently reads `onContextMenu: (e: React.MouseEvent, file: ChangedFile) => void` (in both the destructured params and the type annotation) and its JSX calls `onContextMenu={(e) => onContextMenu(e, file)}`. Change the type in both places to:

```ts
  onContextMenu: (e: React.MouseEvent, absPath: string, isFile: boolean) => void
```

and change the call site to:

```tsx
      onContextMenu={(e) => onContextMenu(e, file.absPath, true)}
```

- [ ] **Step 3: Thread the new `onContextMenu` signature through `DirNode` and `Children`**

`DirNode` and `Children` both currently have `onContextMenu: (e: React.MouseEvent, file: ChangedFile) => void` in their prop types (three occurrences total across the two components — `DirNode`'s own prop type, `Children`'s own prop type, and `Children`'s pass-through to `FileRow`/nested `DirNode`). Change all three occurrences to the same new signature from Step 2:

```ts
  onContextMenu: (e: React.MouseEvent, absPath: string, isFile: boolean) => void
```

- [ ] **Step 4: Add right-click handling to `DirNode` itself**

`DirNode`'s root `<div>` currently only has `onClick={() => setExpanded(!expanded)}` on its `tree-row dir-row` div, with no `onContextMenu`. Add one, computing the directory's absolute path from `node.path` — `DirNode` needs the workspace root to do this, so it must receive a new `root: string` prop (threaded through from `Sidebar` via `Children`, the same way `selected`/`onSelect`/`onContextMenu` already are).

Add `root: string` to `DirNode`'s prop destructuring and type:

```ts
function DirNode({
  node,
  depth,
  selected,
  onSelect,
  onContextMenu,
  root
}: {
  node: TreeNode
  depth: number
  selected: string | null
  onSelect: (file: ChangedFile) => void
  onContextMenu: (e: React.MouseEvent, absPath: string, isFile: boolean) => void
  root: string
}): React.JSX.Element {
```

Change the `tree-row dir-row` div from:

```tsx
      <div
        className="tree-row dir-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setExpanded(!expanded)}
      >
```

to:

```tsx
      <div
        className="tree-row dir-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setExpanded(!expanded)}
        onContextMenu={(e) => onContextMenu(e, `${root}/${node.path}`, false)}
      >
```

And pass `root` through to the nested `Children` call inside `DirNode`:

```tsx
      {expanded && (
        <Children
          node={node}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          root={root}
        />
      )}
```

- [ ] **Step 5: Thread `root` through `Children`**

Add `root: string` to `Children`'s prop destructuring and type (same pattern as Step 4), and pass it to the nested `DirNode` call inside `Children`:

```tsx
      {node.dirs.map((dir) => (
        <DirNode
          key={dir.path}
          node={dir}
          depth={depth}
          selected={selected}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          root={root}
        />
      ))}
```

(`FileRow`'s call site inside `Children` is unchanged — it doesn't need `root`, since `file.absPath` is already absolute.)

- [ ] **Step 6: Update `Sidebar`'s own `onContextMenu` handler and its `Children` call site**

`Sidebar`'s `onContextMenu` function currently reads:

```ts
  const onContextMenu = (e: React.MouseEvent, file: ChangedFile): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, file })
  }
```

Change it to:

```ts
  const onContextMenu = (e: React.MouseEvent, absPath: string, isFile: boolean): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, absPath, isFile })
  }
```

Update the top-level `<Children ...>` call site (inside `Sidebar`'s JSX) to also pass `root={state.root}`:

```tsx
            <Children
              node={tree}
              depth={0}
              selected={selected}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              root={state.root}
            />
```

- [ ] **Step 7: Add right-click handling to the root folder header**

The `sidebar-header` div currently has no `onContextMenu`. Change:

```tsx
      <div className="sidebar-header" title={state.root}>
```

to:

```tsx
      <div
        className="sidebar-header"
        title={state.root}
        onContextMenu={(e) => onContextMenu(e, state.root, false)}
      >
```

- [ ] **Step 8: Update the context menu's JSX — gate "Copy absolute path" on `isFile`, add "Open location"**

The context menu JSX currently reads:

```tsx
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <div
            className="context-menu-item"
            onClick={() => {
              window.viewmaster.copyPath(menu.file.absPath)
              setMenu(null)
            }}
          >
            Copy absolute path
          </div>
        </div>
      )}
```

Change it to:

```tsx
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.isFile && (
            <div
              className="context-menu-item"
              onClick={() => {
                window.viewmaster.copyPath(menu.absPath)
                setMenu(null)
              }}
            >
              Copy absolute path
            </div>
          )}
          <div
            className="context-menu-item"
            onClick={() => {
              window.viewmaster.showInFolder(menu.absPath)
              setMenu(null)
            }}
          >
            Open location
          </div>
        </div>
      )}
```

- [ ] **Step 9: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat: add Open location to sidebar context menu for files, folders, and root"
```

---

### Task 3: Manual verification

**Files:** none.

No automated coverage exists for the context menu's click-through behavior or `shell.showItemInFolder`'s actual OS-level effect — this task is the only place that verifies it actually works. Use the **run-viewmaster** skill to drive the app.

- [ ] **Step 1: Build a small fixture folder**

```bash
mkdir -p /tmp/vm-openloc-fixture/subdir
echo "hello" > /tmp/vm-openloc-fixture/a.txt
echo "world" > /tmp/vm-openloc-fixture/subdir/b.txt
```

- [ ] **Step 2: Launch and drive the app**

Open `/tmp/vm-openloc-fixture` as a folder (Browse mode, so both the file and the nested folder are visible in the tree). Right-click `a.txt` — verify the context menu shows both "Copy absolute path" and "Open location". Click "Open location" — verify it doesn't error (headlessly, the OS file browser may not actually be observable, but the IPC call and Electron's `shell.showItemInFolder` should complete without throwing; check for any renderer console error after the click).

- [ ] **Step 3: Verify the nested folder's context menu**

Right-click the `subdir` folder row — verify the context menu shows ONLY "Open location" (no "Copy absolute path", confirming the `isFile` gate works). Click it — verify no error.

- [ ] **Step 4: Verify the root folder header's context menu**

Right-click the sidebar header (the row showing the folder path at the top). Verify the same menu (only "Open location") appears and clicking it produces no error.

- [ ] **Step 5: Verify existing file-row behavior is unchanged**

Click (left-click, not right-click) `a.txt` to select it — verify it still opens in the content pane as before (this task didn't touch selection behavior, but confirms nothing regressed).

- [ ] **Step 6: Clean up the fixture**

```bash
rm -rf /tmp/vm-openloc-fixture
```

- [ ] **Step 7: Final full-suite check**

Run: `npm run build`
Expected: typecheck + build both succeed.

No commit for this task (no repo files changed) — if any verification step surfaces a bug, fix it as a small follow-up commit referencing the task/step where it was found.
