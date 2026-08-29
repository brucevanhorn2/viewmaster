# Configurable Diff Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user compare the current branch against an arbitrary branch, tag, or commit SHA — a direct `git diff <ref> HEAD` — instead of only the auto-detected merge-base, for the current session only (not persisted).

**Architecture:** `BaselineKind` gains a third `'custom'` variant. `src/main/ipc.ts`'s session state gains a `customBaselineRef` field that `computeRepoState` checks before calling `resolveBaseline()`; when set, it short-circuits to `{ kind: 'custom', ref }` instead. `collectChanges` and `file:readBase` both already special-case `'merge-base'` for their diff-target ref — each gains one more branch for `'custom'`. Two new IPC handlers (`baseline:setCustom`, `git:listRefs`) plus a small clickable UI on `Sidebar.tsx`'s existing baseline label.

**Tech Stack:** TypeScript, Electron IPC, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-configurable-diff-baseline-design.md`

## Global Constraints

- Custom baseline means a direct diff against the chosen ref's tip (`git diff <ref> HEAD`), not a merge-base computation against it.
- No validation of the typed ref before accepting it — a bad ref surfaces via the existing `{ kind: 'error' }` path once a diff against it actually fails, unchanged from how other git-command failures are already handled.
- The custom baseline is session-only — it lives on the in-memory `session` object in `src/main/ipc.ts`, never persisted to `store.ts`, and is naturally cleared whenever `openRepo` creates a fresh session (new folder, or reopening the same folder).
- No test file for `Sidebar.tsx` or `App.tsx` — this repo has zero `.tsx` component tests, and no `ipc.test.ts` exists for any IPC handler (matches this repo's existing convention, not something this plan introduces or fixes).
- Run `npm run typecheck` and `npm test` at the end of each task; both must be clean before committing.

---

### Task 1: Main-process baseline plumbing

**Files:**
- Modify: `src/shared/types.ts` (`BaselineKind`)
- Modify: `src/main/ipc.ts` (`Session` interface, `computeRepoState`, `file:readBase`, two new handlers)
- Modify: `src/main/git/changes.ts` (`collectChanges`'s diff-target branch)
- Test: `src/main/git/changes.test.ts` (new test for the `'custom'` branch)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the `'custom'` `BaselineKind` variant and the `baseline:setCustom`/`git:listRefs` IPC channels, consumed by Task 2's preload/renderer work.

- [ ] **Step 1: Add the `'custom'` variant to `BaselineKind`**

Read `src/shared/types.ts` around `BaselineKind` first to confirm it still matches. Current (lines 16-22):

```ts
export type BaselineKind =
  | { kind: 'merge-base'; base: string; defaultBranch: string; branch: string }
  | {
      kind: 'working-only'
      reason: 'detached' | 'on-default' | 'no-commits' | 'no-baseline'
      branch?: string
    }
```

Replace with:

```ts
export type BaselineKind =
  | { kind: 'merge-base'; base: string; defaultBranch: string; branch: string }
  | { kind: 'custom'; ref: string }
  | {
      kind: 'working-only'
      reason: 'detached' | 'on-default' | 'no-commits' | 'no-baseline'
      branch?: string
    }
```

- [ ] **Step 2: Write the failing test for `collectChanges`'s new `'custom'` branch**

Read `src/main/git/changes.test.ts` in full first to confirm its current structure (it uses `makeRepo`/`TestRepo` from `./testRepo`, a `byPath` helper, and `repo.write`/`repo.git` methods). Add this test inside the existing `describe('collectChanges', ...)` block:

```ts
  it('diffs directly against a custom ref, not filtered through a shared merge-base', async () => {
    await repo.write('base.txt', 'base\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'initial')
    await repo.git('branch', 'mine')
    await repo.git('checkout', '-b', 'sibling')
    await repo.write('sibling-only.txt', 'sibling work\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'sibling work')
    await repo.git('checkout', 'mine')
    await repo.write('mine-only.txt', 'my work\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'my work')

    const files = await collectChanges(repo.root, { kind: 'custom', ref: 'sibling' })

    // Diffing 'mine' (HEAD) directly against 'sibling' surfaces BOTH sides'
    // unique files, since it's a direct tip-to-tip comparison -- a
    // merge-base comparison (fork point = the 'initial' commit) would only
    // ever show mine-only.txt, never sibling-only.txt (a file that only
    // ever existed on a different branch entirely).
    expect(byPath(files, 'mine-only.txt')).toBeDefined()
    expect(byPath(files, 'sibling-only.txt')).toBeDefined()
  })
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/main/git/changes.test.ts -t "custom ref"`
Expected: FAIL — `collectChanges` doesn't yet special-case `baseline.kind === 'custom'`, so the diff never runs and neither file is reported as `'committed'`.

- [ ] **Step 4: Implement the `collectChanges` change**

Read `src/main/git/changes.ts` in full first to confirm it still matches. Current (lines 39-47):

```ts
  if (baseline.kind === 'merge-base') {
    const diffRes = await runGit(root, ['diff', '--name-status', '-z', baseline.base, 'HEAD'])
    if (diffRes.code !== 0) {
      throw new Error(`git diff failed: ${diffRes.stderr.trim()}`)
    }
    for (const file of parseNameStatusZ(diffRes.stdout)) {
      add(file.path, 'committed')
    }
  }
```

Replace with:

```ts
  if (baseline.kind === 'merge-base' || baseline.kind === 'custom') {
    const compareRef = baseline.kind === 'merge-base' ? baseline.base : baseline.ref
    const diffRes = await runGit(root, ['diff', '--name-status', '-z', compareRef, 'HEAD'])
    if (diffRes.code !== 0) {
      throw new Error(`git diff failed: ${diffRes.stderr.trim()}`)
    }
    for (const file of parseNameStatusZ(diffRes.stdout)) {
      add(file.path, 'committed')
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/git/changes.test.ts`
Expected: PASS (all existing tests plus the new one).

- [ ] **Step 6: Add `customBaselineRef` to `Session` and check it in `computeRepoState`**

Read `src/main/ipc.ts` in full around the `Session` interface and `computeRepoState` first to confirm they still match. Current `Session` interface (lines 30-42):

```ts
interface Session {
  root: string
  baseline: BaselineKind | null
  mode: SidebarMode
  watcher: FSWatcher
  recorder: Recorder | null
  searchPaths: string[] | null
  // Bumped every time searchPaths is invalidated. A cache-populating listing
  // in flight when an invalidation happens must not resurrect the cache with
  // pre-change data once it resolves — comparing the generation it started
  // with against the current one detects that race (see search:query).
  searchGeneration: number
}
```

Add one field:

```ts
interface Session {
  root: string
  baseline: BaselineKind | null
  mode: SidebarMode
  watcher: FSWatcher
  recorder: Recorder | null
  searchPaths: string[] | null
  // Bumped every time searchPaths is invalidated. A cache-populating listing
  // in flight when an invalidation happens must not resurrect the cache with
  // pre-change data once it resolves — comparing the generation it started
  // with against the current one detects that race (see search:query).
  searchGeneration: number
  // Session-only override for the "changed files" baseline (issue #13) --
  // never persisted, always reset to auto-detection when a fresh session is
  // created (openRepo). null means "use resolveBaseline() as normal."
  customBaselineRef: string | null
}
```

Current `computeRepoState` (lines 108-134):

```ts
async function computeRepoState(
  root: string,
  mode: SidebarMode,
  resolved?: RootResolution
): Promise<RepoState> {
  const { gitRoot } = resolved ?? (await resolveRoot(root))
  if (gitRoot === null) {
    try {
      const paths = await listFolderTree(root)
      return { kind: 'folder', root, files: toUnchangedFiles(root, paths) }
    } catch (err) {
      return { kind: 'error', root, message: err instanceof Error ? err.message : String(err) }
    }
  }

  try {
    const baseline = await resolveBaseline(gitRoot)
    if (mode === 'changed') {
      const files = await collectChanges(gitRoot, baseline)
      return { kind: 'repo', root: gitRoot, baseline, mode, files }
    }
    const files = await browseFiles(gitRoot, baseline)
    return { kind: 'repo', root: gitRoot, baseline, mode, files }
  } catch (err) {
    return { kind: 'error', root: gitRoot, message: err instanceof Error ? err.message : String(err) }
  }
}
```

Replace the `const baseline = await resolveBaseline(gitRoot)` line with a check for the session override first:

```ts
async function computeRepoState(
  root: string,
  mode: SidebarMode,
  resolved?: RootResolution
): Promise<RepoState> {
  const { gitRoot } = resolved ?? (await resolveRoot(root))
  if (gitRoot === null) {
    try {
      const paths = await listFolderTree(root)
      return { kind: 'folder', root, files: toUnchangedFiles(root, paths) }
    } catch (err) {
      return { kind: 'error', root, message: err instanceof Error ? err.message : String(err) }
    }
  }

  try {
    const customRef = session?.customBaselineRef
    const baseline: BaselineKind = customRef ? { kind: 'custom', ref: customRef } : await resolveBaseline(gitRoot)
    if (mode === 'changed') {
      const files = await collectChanges(gitRoot, baseline)
      return { kind: 'repo', root: gitRoot, baseline, mode, files }
    }
    const files = await browseFiles(gitRoot, baseline)
    return { kind: 'repo', root: gitRoot, baseline, mode, files }
  } catch (err) {
    return { kind: 'error', root: gitRoot, message: err instanceof Error ? err.message : String(err) }
  }
}
```

(`session` is the module-level `let session: Session | null = null` already declared above this function — reading it here is safe since `computeRepoState` is always called either before `session` is first assigned, in which case `session?.customBaselineRef` is `undefined`/falsy and behaves exactly as before, or after, in which case it reflects the current session's override.)

- [ ] **Step 7: Initialize `customBaselineRef` in `openRepo`**

Read `openRepo`'s session-construction block (currently around lines 175-187):

```ts
    session = {
      root: state.root,
      baseline: state.kind === 'repo' ? state.baseline : null,
      // A folder session has no Changed/Browse toggle — it always shows the
      // full tree — so `mode` is unused for 'folder' sessions; 'browse' is
      // semantically accurate (as opposed to the never-read-for-anything
      // 'changed' default), but only 'repo' sessions actually consult it.
      mode: state.kind === 'repo' ? state.mode : 'browse',
      watcher,
      recorder,
      searchPaths: null,
      searchGeneration: 0
    }
```

Add the new field, initialized to `null` (every fresh session starts with no override):

```ts
    session = {
      root: state.root,
      baseline: state.kind === 'repo' ? state.baseline : null,
      // A folder session has no Changed/Browse toggle — it always shows the
      // full tree — so `mode` is unused for 'folder' sessions; 'browse' is
      // semantically accurate (as opposed to the never-read-for-anything
      // 'changed' default), but only 'repo' sessions actually consult it.
      mode: state.kind === 'repo' ? state.mode : 'browse',
      watcher,
      recorder,
      searchPaths: null,
      searchGeneration: 0,
      customBaselineRef: null
    }
```

- [ ] **Step 8: Update `file:readBase` to handle the `'custom'` kind**

Current handler (lines 226-233):

```ts
  ipcMain.handle('file:readBase', async (_e, relPath: string): Promise<string> => {
    if (!session || !session.baseline) return ''
    const { root, baseline } = session
    // In working-only mode diff against HEAD (if any) so staged/modified
    // files still have a meaningful old side; untracked paths yield ''.
    const base = baseline.kind === 'merge-base' ? baseline.base : 'HEAD'
    return readBaseFile(root, base, relPath)
  })
```

Replace the `base` line:

```ts
  ipcMain.handle('file:readBase', async (_e, relPath: string): Promise<string> => {
    if (!session || !session.baseline) return ''
    const { root, baseline } = session
    // In working-only mode diff against HEAD (if any) so staged/modified
    // files still have a meaningful old side; untracked paths yield ''.
    const base = baseline.kind === 'merge-base' ? baseline.base : baseline.kind === 'custom' ? baseline.ref : 'HEAD'
    return readBaseFile(root, base, relPath)
  })
```

- [ ] **Step 9: Add the two new IPC handlers**

Add these two handlers anywhere alongside the other `ipcMain.handle(...)` registrations in `registerIpc` (e.g. right after the existing `mode:set` handler):

```ts
  ipcMain.handle('baseline:setCustom', async (_e, ref: string | null): Promise<RepoState | null> => {
    if (!session) return null
    const root = session.root
    const mode = session.mode
    session.customBaselineRef = ref
    const fresh = await computeRepoState(root, mode)
    if (session?.root !== root || session.mode !== mode) return null // repo switched or mode changed mid-compute — drop stale update
    if (fresh.kind === 'repo') session.baseline = fresh.baseline
    return fresh
  })

  ipcMain.handle('git:listRefs', async (): Promise<string[]> => {
    if (!session) return []
    const [branches, tags] = await Promise.all([
      runGit(session.root, ['branch', '-a', '--format=%(refname:short)']),
      runGit(session.root, ['tag'])
    ])
    const branchNames =
      branches.code === 0
        ? branches.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '' && line !== 'origin/HEAD')
        : []
    const tagNames = tags.code === 0 ? tags.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
    return [...new Set([...branchNames, ...tagNames])]
  })
```

- [ ] **Step 10: Typecheck and run the full test suite**

Run: `npm run typecheck && npm test`
Expected: no typecheck errors; all tests pass, including the new `collectChanges` test.

- [ ] **Step 11: Commit**

```bash
git add src/shared/types.ts src/main/ipc.ts src/main/git/changes.ts src/main/git/changes.test.ts
git commit -m "feat: add a session-only custom diff baseline (main process)

BaselineKind gains a 'custom' variant meaning a direct diff against a
chosen ref's tip, not a merge-base computation. computeRepoState now
checks session.customBaselineRef before calling resolveBaseline().
collectChanges and file:readBase both extend their existing
merge-base-only diff-target logic to also handle 'custom'. Two new
IPC handlers: baseline:setCustom (set/clear the override, session-only
per issue #13's confirmed scope) and git:listRefs (branches + tags,
for the renderer's autocomplete -- not yet wired into any UI).

Part of #13."
```

---

### Task 2: Preload API, renderer UI, and wiring

**Files:**
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/code/baselineLabel.ts`
- Test: `src/renderer/src/code/baselineLabel.test.ts`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: the `baseline:setCustom`/`git:listRefs` IPC channels and the `'custom'` `BaselineKind` variant, both from Task 1.
- Produces: nothing further downstream — this is the final integration task.

- [ ] **Step 1: Add the preload API methods**

Read `src/preload/index.ts` in full first to confirm it still matches. Current `setMode` line (around line 21) and its neighbors:

```ts
  setMode: (mode: SidebarMode): Promise<RepoState | null> => ipcRenderer.invoke('mode:set', mode),
```

Add two new methods right after it:

```ts
  setMode: (mode: SidebarMode): Promise<RepoState | null> => ipcRenderer.invoke('mode:set', mode),
  setCustomBaseline: (ref: string | null): Promise<RepoState | null> =>
    ipcRenderer.invoke('baseline:setCustom', ref),
  listRefs: (): Promise<string[]> => ipcRenderer.invoke('git:listRefs'),
```

- [ ] **Step 2: Write the failing test for the extracted `baselineLabel`**

Create `src/renderer/src/code/baselineLabel.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { baselineLabel } from './baselineLabel'
import type { BaselineKind } from '@shared/types'

describe('baselineLabel', () => {
  it('labels a merge-base baseline as "<branch> vs <defaultBranch>"', () => {
    const baseline: BaselineKind = { kind: 'merge-base', base: 'abc123', defaultBranch: 'main', branch: 'feature' }
    expect(baselineLabel(baseline)).toBe('feature vs main')
  })

  it('labels a custom baseline as "Custom: <ref>"', () => {
    const baseline: BaselineKind = { kind: 'custom', ref: 'v1.2.0' }
    expect(baselineLabel(baseline)).toBe('Custom: v1.2.0')
  })

  it('labels a detached-HEAD working-only baseline', () => {
    const baseline: BaselineKind = { kind: 'working-only', reason: 'detached' }
    expect(baselineLabel(baseline)).toBe('Working tree changes only (detached HEAD)')
  })

  it('labels an on-default-branch working-only baseline using its branch name', () => {
    const baseline: BaselineKind = { kind: 'working-only', reason: 'on-default', branch: 'main' }
    expect(baselineLabel(baseline)).toBe('Working tree changes only (on main)')
  })

  it('labels a no-commits working-only baseline', () => {
    const baseline: BaselineKind = { kind: 'working-only', reason: 'no-commits' }
    expect(baselineLabel(baseline)).toBe('Working tree changes only (no commits yet)')
  })

  it('labels a no-baseline working-only baseline', () => {
    const baseline: BaselineKind = { kind: 'working-only', reason: 'no-baseline' }
    expect(baselineLabel(baseline)).toBe('Working tree changes only (no baseline branch)')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/code/baselineLabel.test.ts`
Expected: FAIL — `Cannot find module './baselineLabel'` (the file doesn't exist yet).

- [ ] **Step 4: Extract `baselineLabel` into its own module**

Read `src/renderer/src/components/Sidebar.tsx` in full first to confirm its current `baselineLabel` function still matches (currently lines 34-44):

```ts
function baselineLabel(state: RepoState & { kind: 'repo' }): string {
  const b = state.baseline
  if (b.kind === 'merge-base') return `${b.branch} vs ${b.defaultBranch}`
  const reasons: Record<string, string> = {
    detached: 'detached HEAD',
    'on-default': `on ${b.branch ?? 'default branch'}`,
    'no-commits': 'no commits yet',
    'no-baseline': 'no baseline branch'
  }
  return `Working tree changes only (${reasons[b.reason]})`
}
```

Create `src/renderer/src/code/baselineLabel.ts` with the same logic, taking `BaselineKind` directly instead of the whole `RepoState` (a smaller, more testable signature — the one call site in `Sidebar.tsx` already has `state.baseline` in hand):

```ts
import type { BaselineKind } from '@shared/types'

/** Human-readable label for the sidebar header's baseline display. */
export function baselineLabel(b: BaselineKind): string {
  if (b.kind === 'merge-base') return `${b.branch} vs ${b.defaultBranch}`
  if (b.kind === 'custom') return `Custom: ${b.ref}`
  const reasons: Record<string, string> = {
    detached: 'detached HEAD',
    'on-default': `on ${b.branch ?? 'default branch'}`,
    'no-commits': 'no commits yet',
    'no-baseline': 'no baseline branch'
  }
  return `Working tree changes only (${reasons[b.reason]})`
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/code/baselineLabel.test.ts`
Expected: PASS (6/6 tests).

- [ ] **Step 6: Update Sidebar.tsx to use the extracted function and add the baseline picker UI**

Read `src/renderer/src/components/Sidebar.tsx` in full first to confirm it still matches. Remove the local `baselineLabel` function (lines 34-44 shown in Step 4 above) entirely, and add an import for the extracted one. Current top-of-file imports:

```ts
import type { ChangedFile, FileStatus, RepoState, SidebarMode } from '@shared/types'
```

Add:

```ts
import type { ChangedFile, FileStatus, RepoState, SidebarMode } from '@shared/types'
import { baselineLabel } from '../code/baselineLabel'
```

Current `Sidebar` component's props and the start of its body (lines 164-176):

```ts
export default function Sidebar({
  state,
  selected,
  onSelect,
  onSetMode
}: {
  state: RepoState
  selected: string | null
  onSelect: (file: ChangedFile) => void
  onSetMode: (mode: SidebarMode) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
```

Add a new prop and new local state for the picker:

```ts
export default function Sidebar({
  state,
  selected,
  onSelect,
  onSetMode,
  onSetCustomBaseline
}: {
  state: RepoState
  selected: string | null
  onSelect: (file: ChangedFile) => void
  onSetMode: (mode: SidebarMode) => void
  onSetCustomBaseline: (ref: string | null) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [editingBaseline, setEditingBaseline] = useState(false)
  const [baselineInput, setBaselineInput] = useState('')
  const [refSuggestions, setRefSuggestions] = useState<string[]>([])
```

Add a helper to open the picker (fetching suggestions once) right after the existing `onContextMenu` function (currently around lines 204-208):

```ts
  const onContextMenu = (e: React.MouseEvent, absPath: string, isFile: boolean): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, absPath, isFile })
  }

  const startEditingBaseline = (): void => {
    if (state.kind !== 'repo') return
    setBaselineInput(state.baseline.kind === 'custom' ? state.baseline.ref : '')
    setEditingBaseline(true)
    void window.viewmaster.listRefs().then(setRefSuggestions)
  }

  const commitBaseline = (ref: string): void => {
    setEditingBaseline(false)
    const trimmed = ref.trim()
    onSetCustomBaseline(trimmed === '' ? null : trimmed)
  }
```

Current header JSX (lines 216-238):

```tsx
  return (
    <div className="sidebar">
      <div
        className="sidebar-header"
        title={state.root}
        onContextMenu={(e) => onContextMenu(e, state.root, false)}
      >
        <span className="sidebar-header-label">
          {state.kind === 'folder' ? state.root : baselineLabel(state)}
        </span>
        {state.kind === 'repo' && (
          <span className="toolbar-segment">
            {(['changed', 'browse'] as const).map((m) => (
              <button
                key={m}
                className={`toolbar-button${state.mode === m ? ' active' : ''}`}
                onClick={() => onSetMode(m)}
              >
                {m === 'changed' ? 'Changed' : 'Browse'}
              </button>
            ))}
          </span>
        )}
      </div>
```

Replace the `<span className="sidebar-header-label">...</span>` block with a conditional editing view, and note `baselineLabel(state)` becomes `baselineLabel(state.baseline)` (the extracted function now takes `BaselineKind` directly, not the whole repo state):

```tsx
  return (
    <div className="sidebar">
      <div
        className="sidebar-header"
        title={state.root}
        onContextMenu={(e) => onContextMenu(e, state.root, false)}
      >
        {state.kind === 'repo' && editingBaseline ? (
          <span className="baseline-picker">
            <input
              autoFocus
              className="baseline-picker-input"
              list="baseline-ref-suggestions"
              value={baselineInput}
              placeholder="branch, tag, or commit"
              onChange={(e) => setBaselineInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitBaseline(baselineInput)
                if (e.key === 'Escape') setEditingBaseline(false)
              }}
              onBlur={() => commitBaseline(baselineInput)}
            />
            <datalist id="baseline-ref-suggestions">
              {refSuggestions.map((ref) => (
                <option key={ref} value={ref} />
              ))}
            </datalist>
          </span>
        ) : (
          <span
            className={`sidebar-header-label${state.kind === 'repo' ? ' sidebar-header-label-clickable' : ''}`}
            onClick={state.kind === 'repo' ? startEditingBaseline : undefined}
          >
            {state.kind === 'folder' ? state.root : baselineLabel(state.baseline)}
          </span>
        )}
        {state.kind === 'repo' && state.baseline.kind === 'custom' && !editingBaseline && (
          <button
            className="toolbar-button baseline-reset"
            title="Reset to auto-detected baseline"
            onClick={() => onSetCustomBaseline(null)}
          >
            ×
          </button>
        )}
        {state.kind === 'repo' && (
          <span className="toolbar-segment">
            {(['changed', 'browse'] as const).map((m) => (
              <button
                key={m}
                className={`toolbar-button${state.mode === m ? ' active' : ''}`}
                onClick={() => onSetMode(m)}
              >
                {m === 'changed' ? 'Changed' : 'Browse'}
              </button>
            ))}
          </span>
        )}
      </div>
```

(Using a native `<datalist>` for the autocomplete suggestions is the simplest correct approach here — it's a real HTML input with real suggestions, accepts anything typed including text not in the list, and needs no custom dropdown/keyboard-navigation code.)

- [ ] **Step 7: Wire the new prop in App.tsx**

Read `src/renderer/src/App.tsx` in full first to confirm it still matches. Current `setMode` callback (lines 77-82):

```ts
  const setMode = useCallback((mode: SidebarMode): void => {
    void window.viewmaster.setMode(mode).then((state) => {
      if (!state) return
      setRepo(state)
    })
  }, [])
```

Add a new callback right after it:

```ts
  const setMode = useCallback((mode: SidebarMode): void => {
    void window.viewmaster.setMode(mode).then((state) => {
      if (!state) return
      setRepo(state)
    })
  }, [])

  const setCustomBaseline = useCallback((ref: string | null): void => {
    void window.viewmaster.setCustomBaseline(ref).then((state) => {
      if (!state) return
      setRepo(state)
    })
  }, [])
```

Current `<Sidebar>` usage (around lines 270-275):

```tsx
              <Sidebar
                state={repo}
                selected={selected?.path ?? null}
                onSelect={onSidebarSelect}
                onSetMode={setMode}
              />
```

Add the new prop:

```tsx
              <Sidebar
                state={repo}
                selected={selected?.path ?? null}
                onSelect={onSidebarSelect}
                onSetMode={setMode}
                onSetCustomBaseline={setCustomBaseline}
              />
```

- [ ] **Step 8: Add CSS for the baseline picker**

Read `src/renderer/src/styles.css` around lines 121-165 (the `/* ---- sidebar ---- */` section) first to confirm it still matches. Add this new block right after the existing `.sidebar-header .toolbar-segment` rule (currently ending around line 158):

```css
.sidebar-header-label-clickable {
  cursor: pointer;
}

.sidebar-header-label-clickable:hover {
  color: var(--fg);
}

.baseline-picker {
  flex: 1;
  min-width: 0;
}

.baseline-picker-input {
  width: 100%;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 11px;
  text-transform: none;
  letter-spacing: normal;
}

.baseline-reset {
  padding: 3px 8px;
  flex-shrink: 0;
}
```

- [ ] **Step 9: Typecheck and run the full test suite**

Run: `npm run typecheck && npm test`
Expected: no typecheck errors; all tests pass, including the new `baselineLabel` tests.

- [ ] **Step 10: Manual smoke check**

Use the `run-viewmaster` skill to launch the app against a real git repo. Confirm: clicking the sidebar header label (when a repo is open) opens the input with autocomplete suggestions; typing a tag or branch name and pressing Enter switches the changed-files list and file diffs to compare directly against it (confirm a file that differs between HEAD and that ref shows up, and its diff view reflects the direct comparison); the "×" reset button appears only when a custom baseline is active and clicking it reverts to the auto-detected baseline; typing a nonexistent ref and pressing Enter surfaces the existing error-state UI (a git error message) rather than crashing; closing and reopening the same folder reverts to the auto-detected baseline (the custom ref does not persist).

- [ ] **Step 11: Commit**

```bash
git add src/preload/index.ts src/renderer/src/code/baselineLabel.ts src/renderer/src/code/baselineLabel.test.ts src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx src/renderer/src/styles.css
git commit -m "feat: add UI for the configurable diff baseline

Sidebar's existing baseline label is now clickable (when a repo is
open), opening a text input with autocomplete suggestions (local +
remote-tracking branches, tags) that still accepts anything typed,
including a SHA not in the list. A reset button clears an active
custom baseline back to auto-detected. baselineLabel extracted from
Sidebar.tsx into its own tested module.

Resolves #13."
```
