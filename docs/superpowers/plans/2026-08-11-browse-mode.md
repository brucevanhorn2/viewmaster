# Browse Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the sidebar show every file under the opened root (not just git-changed ones), so View Master works as a general document browser — the driving case being a static Obsidian vault with no pending git changes.

**Architecture:** Extend the existing `ChangedFile`/`buildTree`/`FileRow` model rather than building a parallel one. A non-git folder always shows a full, `.gitignore`-filtered tree (new `RepoState` kind: `'folder'`). A git repo gets a **Changed / Browse** toggle; Browse mode lists every non-ignored file via `git ls-files` and overlays real git status onto the ones that are actually changed, so status badges never disappear.

**Tech Stack:** Electron main process (Node `fs`/`child_process` via the existing `runGit` helper), the `ignore` npm package for non-git `.gitignore` parsing, React/TypeScript renderer, vitest.

## Global Constraints

- Browse mode shows everything except what `.gitignore` excludes — no hidden-dotfile special-casing beyond that.
- Git repos get a Changed/Browse toggle in the sidebar header; non-git folders always browse, no toggle shown.
- The last-used mode is remembered per folder root and restored on reopen.
- Files that are git-changed keep their status badge even while browsing everything — Browse mode is additive to the changed-file set, not a replacement.
- Git repos get fully correct `.gitignore` resolution via `git ls-files --cached --others --exclude-standard`. Non-git folders only honor a **root-level** `.gitignore` (via the `ignore` package) — no nested-gitignore resolution.

---

### Task 1: Non-git folder browsing

Makes opening a plain (non-git) folder show its full file tree instead of today's dead-end "Not a git repository" message. This alone delivers the Obsidian-vault use case and touches only the non-git code path — the `'repo'` `RepoState` shape is untouched in this task.

**Files:**
- Modify: `package.json` (add `ignore` dependency)
- Modify: `src/shared/types.ts:1,24-27` (`FileStatus` gains `'unchanged'`; `RepoState`'s `'not-git'` kind becomes `'folder'`)
- Modify: `src/shared/tree.ts:11-15` (doc comment)
- Create: `src/main/files/browse.ts`
- Create: `src/main/files/browse.test.ts`
- Modify: `src/main/ipc.ts` (folder-kind branch of `computeRepoState`; watcher/session setup extended to folder sessions; `addRecentFolder` condition)
- Modify: `src/renderer/src/components/Sidebar.tsx` (drop the `'not-git'` message block; render the tree for `'folder'` kind; `STATUS_LETTER` gains `'unchanged'`; hide the badge span for unchanged files)
- Modify: `src/renderer/src/App.tsx:68-81` (watcher-driven selected-file refresh also covers `'folder'` kind)

**Interfaces:**
- Produces: `listFolderTree(root: string): Promise<string[]>` — sorted repo-relative paths, `.git` always excluded, root `.gitignore` honored if present.
- Produces: `toUnchangedFiles(root: string, paths: string[]): ChangedFile[]` — wraps plain paths with `status: 'unchanged'`.
- Produces: `RepoState`'s `{ kind: 'folder'; root: string; files: ChangedFile[] }` (replaces `{ kind: 'not-git'; root: string }`).
- Produces: `FileStatus` includes `'unchanged'`.
- Consumes: nothing new from outside this task.

- [ ] **Step 1: Install the `ignore` package**

Run: `npm install ignore@^7.0.6`

Verify `package.json`'s `dependencies` gained `"ignore": "^7.0.6"` (it's a runtime dependency of the main process, not a dev dependency — it belongs alongside `electron-store`).

- [ ] **Step 2: Update shared types**

Edit `src/shared/types.ts` — replace the whole file with:

```ts
export type FileStatus = 'untracked' | 'modified' | 'staged' | 'committed' | 'unchanged'

/** Priority order for primary status: highest ("most live") wins. */
export const STATUS_PRIORITY: FileStatus[] = ['untracked', 'modified', 'staged', 'committed']

export interface ChangedFile {
  /** Repo-relative path, forward slashes. */
  path: string
  absPath: string
  /** Primary (highest-priority) status. */
  status: FileStatus
  /** Next-highest status also present, if any. */
  secondary?: FileStatus
}

export type BaselineKind =
  | { kind: 'merge-base'; base: string; defaultBranch: string; branch: string }
  | {
      kind: 'working-only'
      reason: 'detached' | 'on-default' | 'no-commits' | 'no-baseline'
      branch?: string
    }

export type RepoState =
  | { kind: 'repo'; root: string; baseline: BaselineKind; files: ChangedFile[] }
  | { kind: 'folder'; root: string; files: ChangedFile[] }
  | { kind: 'error'; root: string; message: string }

export type FileContent =
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'missing' }

export interface HistoryVersion {
  /** Capture time, epoch milliseconds. */
  ts: number
  /** sha256 hex of the captured content (object key). */
  sha: string
  /** Byte length of the captured content. */
  size: number
}
```

`STATUS_PRIORITY` deliberately does not include `'unchanged'` — it's only used by `collectChanges` to pick a primary status among *actually present* git statuses, and `'unchanged'` is never one of those.

- [ ] **Step 3: Update `buildTree`'s doc comment**

Edit `src/shared/tree.ts`, replace the comment above `export function buildTree`:

```ts
/**
 * Build a directory tree from a flat file list. Used both for the
 * changed-files sidebar view (only directories with changes appear) and the
 * full browse-mode tree (every non-ignored file and its ancestor dirs).
 */
```

- [ ] **Step 4: Write failing tests for the non-git listing functions**

Create `src/main/files/browse.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { listFolderTree, toUnchangedFiles } from './browse'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'viewmaster-folder-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(rel: string, content = ''): Promise<void> {
  const abs = join(dir, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
}

describe('listFolderTree', () => {
  it('lists every file when there is no .gitignore', async () => {
    await write('a.md', 'a')
    await write('sub/b.md', 'b')

    expect(await listFolderTree(dir)).toEqual(['a.md', 'sub/b.md'])
  })

  it('excludes files matching a root .gitignore pattern', async () => {
    await write('.gitignore', '*.log\n')
    await write('keep.md', 'k')
    await write('debug.log', 'd')

    expect(await listFolderTree(dir)).toEqual(['.gitignore', 'keep.md'])
  })

  it('excludes an entire directory matched by a trailing-slash pattern', async () => {
    await write('.gitignore', 'node_modules/\n')
    await write('node_modules/pkg/index.js', 'x')
    await write('src/app.ts', 'y')

    expect(await listFolderTree(dir)).toEqual(['.gitignore', 'src/app.ts'])
  })

  it('always excludes .git even without a .gitignore', async () => {
    await write('.git/HEAD', 'ref: refs/heads/main')
    await write('README.md', 'r')

    expect(await listFolderTree(dir)).toEqual(['README.md'])
  })

  it('sorts results by path', async () => {
    await write('zebra.txt', 'z')
    await write('alpha.txt', 'a')
    await write('mid/beta.txt', 'b')

    expect(await listFolderTree(dir)).toEqual(['alpha.txt', 'mid/beta.txt', 'zebra.txt'])
  })
})

describe('toUnchangedFiles', () => {
  it('maps paths to unchanged ChangedFile entries', () => {
    expect(toUnchangedFiles('/vault', ['a.md', 'sub/b.md'])).toEqual([
      { path: 'a.md', absPath: join('/vault', 'a.md'), status: 'unchanged' },
      { path: 'sub/b.md', absPath: join('/vault', 'sub/b.md'), status: 'unchanged' }
    ])
  })
})
```

Note the `.gitignore` file itself is never excluded by its own rules (git behaves the same way) — the fixtures above expect it to appear in the listing.

- [ ] **Step 5: Run the tests, verify they fail**

Run: `npx vitest run src/main/files/browse.test.ts`
Expected: FAIL — `Cannot find module './browse'` (the module doesn't exist yet).

- [ ] **Step 6: Implement `listFolderTree` and `toUnchangedFiles`**

Create `src/main/files/browse.ts`:

```ts
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import ignore from 'ignore'
import type { ChangedFile } from '@shared/types'

/**
 * Full file listing for a non-git folder, filtered through a root-level
 * .gitignore if one exists. No nested-gitignore resolution — that requires
 * a real git repo (see listGitTree, added in the Browse-toggle task).
 * .git itself is always excluded, gitignore or not.
 */
export async function listFolderTree(root: string): Promise<string[]> {
  const ig = ignore()
  try {
    ig.add(await readFile(join(root, '.gitignore'), 'utf8'))
  } catch {
    // no .gitignore — nothing to filter beyond .git
  }

  const results: string[] = []

  async function walk(dir: string, relDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // Directory-only gitignore patterns (e.g. "node_modules/") only match
        // with a trailing slash on the tested path.
        if (ig.ignores(`${rel}/`)) continue
        await walk(join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        if (ig.ignores(rel)) continue
        results.push(rel)
      }
    }
  }

  await walk(root, '')
  results.sort((a, b) => a.localeCompare(b))
  return results
}

/** Wrap plain filesystem paths as ChangedFile entries with no git status. */
export function toUnchangedFiles(root: string, paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, absPath: join(root, path), status: 'unchanged' as const }))
}
```

- [ ] **Step 7: Run the tests, verify they pass**

Run: `npx vitest run src/main/files/browse.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 8: Wire the folder-kind branch into `ipc.ts`**

Edit `src/main/ipc.ts`. Add the import:

```ts
import { listFolderTree, toUnchangedFiles } from './files/browse'
```

Replace the non-git branch of `computeRepoState`:

```ts
async function computeRepoState(root: string): Promise<RepoState> {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    const paths = await listFolderTree(root)
    return { kind: 'folder', root, files: toUnchangedFiles(root, paths) }
  }
  const toplevel = await runGit(root, ['rev-parse', '--show-toplevel'])
  const repoRoot = toplevel.code === 0 ? toplevel.stdout.trim() : root

  try {
    const baseline = await resolveBaseline(repoRoot)
    const files = await collectChanges(repoRoot, baseline)
    return { kind: 'repo', root: repoRoot, baseline, files }
  } catch (err) {
    return { kind: 'error', root: repoRoot, message: err instanceof Error ? err.message : String(err) }
  }
}
```

Change the `Session` interface's `baseline` field to be nullable, since a folder session has no git baseline:

```ts
interface Session {
  root: string
  baseline: BaselineKind | null
  watcher: FSWatcher
  recorder: Recorder | null
}
```

Replace `openRepo`'s recent-folder condition and watcher setup so both `'repo'` and `'folder'` states get a live watcher (today only `'repo'` does — non-git folders currently never auto-refresh at all):

```ts
async function openRepo(getWindow: WindowGetter, root: string): Promise<RepoState> {
  await closeSession()
  const state = await computeRepoState(root)

  if (state.kind !== 'error') addRecentFolder(state.root)

  if (state.kind === 'repo' || state.kind === 'folder') {
    const watchRoot = state.root
    const recorder =
      state.kind === 'repo'
        ? createRecorder(watchRoot, {
            historyBaseDir: app.getPath('userData'),
            onCapture: (relPath) => {
              const win = getWindow()
              if (win && !win.isDestroyed()) win.webContents.send('history:changed', relPath)
            }
          })
        : null
    let recomputeTimer: NodeJS.Timeout | null = null
    const watcher = watchRepo(watchRoot, (relPath) => {
      recorder?.handleEvent(relPath)
      if (recomputeTimer) clearTimeout(recomputeTimer)
      recomputeTimer = setTimeout(async () => {
        const fresh = await computeRepoState(watchRoot)
        if (session?.root !== watchRoot) return // repo switched — drop stale update
        if (fresh.kind === 'repo') session.baseline = fresh.baseline
        // Resolve the window at send time — the window that opened the repo
        // may have been closed and replaced since.
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('repo:changed', fresh)
      }, RECOMPUTE_DEBOUNCE_MS)
    })
    session = {
      root: state.root,
      baseline: state.kind === 'repo' ? state.baseline : null,
      watcher,
      recorder
    }
  }

  return state
}
```

`addRecentFolder`'s condition changes from `state.kind !== 'not-git'` to `state.kind !== 'error'` — this is a deliberate small fix, not incidental: previously an `'error'` open (e.g. a git repo `resolveBaseline` failure) was still added to recents, which doesn't make sense; now `'folder'` opens (a real success) are remembered and `'error'` opens aren't.

Finally, guard the one place that assumed a baseline always exists — `file:readBase`:

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

(A folder session has no baseline, so Diff/Marks mode on a file opened from a non-git folder degrades gracefully to "entirely added" rather than crashing — there's no git history to diff against.)

- [ ] **Step 9: Update `Sidebar.tsx` for the `'folder'` kind and `'unchanged'` status**

Edit `src/renderer/src/components/Sidebar.tsx`.

Add `unchanged: ''` to `STATUS_LETTER`:

```ts
const STATUS_LETTER: Record<FileStatus, string> = {
  untracked: 'U',
  modified: 'M',
  staged: 'S',
  committed: 'C',
  unchanged: ''
}
```

In `FileRow`, only render the status badge when there's a real status:

```tsx
function FileRow({
  file,
  depth,
  selected,
  onSelect,
  onContextMenu
}: {
  file: ChangedFile
  depth: number
  selected: boolean
  onSelect: (file: ChangedFile) => void
  onContextMenu: (e: React.MouseEvent, file: ChangedFile) => void
}): React.JSX.Element {
  const name = file.path.split('/').pop() ?? file.path
  return (
    <div
      className={`tree-row file-row status-${file.status}${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onSelect(file)}
      onContextMenu={(e) => onContextMenu(e, file)}
      title={file.path}
    >
      <img className="file-icon" src={fileIconUrl(name)} alt="" />
      <span className="file-name">{name}</span>
      {file.status !== 'unchanged' && (
        <span className="status-badge">
          {STATUS_LETTER[file.status]}
          {file.secondary && <span className="status-secondary">·{STATUS_LETTER[file.secondary]}</span>}
        </span>
      )}
    </div>
  )
}
```

Replace the `tree` memo, the `'not-git'` early return, and the final render to handle `'folder'` alongside `'repo'`:

```tsx
  const tree = useMemo(
    () => (state.kind === 'repo' || state.kind === 'folder' ? buildTree(state.files) : null),
    [state]
  )

  if (state.kind === 'error') {
    return (
      <div className="sidebar">
        <div className="sidebar-message">
          Git error
          <div className="sidebar-message-detail">{state.message}</div>
        </div>
      </div>
    )
  }

  const onContextMenu = (e: React.MouseEvent, file: ChangedFile): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, file })
  }

  const emptyMessage = state.kind === 'folder' ? 'No files to show' : 'No changes in this branch'

  return (
    <div className="sidebar">
      <div className="sidebar-header" title={state.root}>
        {state.kind === 'folder' ? state.root : baselineLabel(state)}
      </div>
      <div className="sidebar-tree">
        {tree && tree.dirs.length === 0 && tree.files.length === 0 ? (
          <div className="sidebar-message">{emptyMessage}</div>
        ) : (
          tree && (
            <Children
              node={tree}
              depth={0}
              selected={selected}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          )
        )}
      </div>
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
    </div>
  )
}
```

(The `'error'` block moved above the removed `'not-git'` block; everything else — the `menu` state/effect at the top of the component — is unchanged.)

- [ ] **Step 10: Extend `App.tsx`'s watcher-refresh to the `'folder'` kind**

Edit `src/renderer/src/App.tsx`, in the `onRepoChanged` effect:

```tsx
  useEffect(
    () =>
      window.viewmaster.onRepoChanged((state) => {
        setRepo(state)
        setRefreshKey((k) => k + 1)
        if (state.kind === 'repo' || state.kind === 'folder') {
          setSelected((current) => {
            if (!current) return current
            return state.files.find((f) => f.path === current.path) ?? current
          })
        }
      }),
    []
  )
```

- [ ] **Step 11: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: both pass (typecheck clean, all existing + new tests green).

- [ ] **Step 12: Manual smoke test**

Run: `npm run dev`

In the running app: use **Open Folder…** on a plain directory that is *not* a git repo (create one with a couple of `.md`/`.txt` files and a `.gitignore` excluding one file, e.g. `mkdir -p /tmp/vault-test && cd /tmp/vault-test && echo 'skip.txt' > .gitignore && echo hi > a.md && echo bye > skip.txt`). Confirm:
- The full tree renders (no more "Not a git repository" message).
- `skip.txt` is hidden, `a.md` shows.
- Clicking `a.md` renders it in the content pane.
- Editing `a.md` on disk while the app is open updates the pane (watcher live-refresh).

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json src/shared/types.ts src/shared/tree.ts \
  src/main/files/browse.ts src/main/files/browse.test.ts src/main/ipc.ts \
  src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx
git commit -m "feat(browse): full-tree browsing for non-git folders"
```

---

### Task 2: Changed/Browse toggle for git repos

Adds the sidebar toggle for git repos: **Changed** (today's behavior, default) and **Browse** (full `.gitignore`-filtered tree with git-changed files keeping their status badge). Builds directly on Task 1's `browse.ts` module and `'unchanged'` status.

**Files:**
- Modify: `src/shared/types.ts` (add `SidebarMode`; `'repo'` kind gains `mode: SidebarMode`)
- Modify: `src/main/files/browse.ts` (add `listGitTree`, `overlayStatus`)
- Modify: `src/main/files/browse.test.ts` (tests for the above)
- Modify: `src/main/store.ts` (persist per-root mode)
- Modify: `src/main/ipc.ts` (mode threading, `mode:set` handler)
- Modify: `src/preload/index.ts` (`setMode` API)
- Modify: `src/renderer/src/styles.css` (`.sidebar-header` becomes a flex row)
- Modify: `src/renderer/src/components/Sidebar.tsx` (the toggle control)
- Modify: `src/renderer/src/App.tsx` (`setMode` wiring)
- Modify: `README.md` (mention Browse mode)

**Interfaces:**
- Consumes: `listFolderTree`, `toUnchangedFiles` (Task 1, unchanged), `ChangedFile`, `FileStatus` (Task 1, `'unchanged'` already added), `RepoState`'s `'folder'` kind (Task 1, unchanged).
- Produces: `listGitTree(root: string): Promise<string[]>` — sorted repo-relative paths from `git ls-files --cached --others --exclude-standard`.
- Produces: `overlayStatus(root: string, allPaths: string[], changed: ChangedFile[]): ChangedFile[]` — every path in `allPaths`, using the matching `changed` entry's real status where one exists, `'unchanged'` otherwise.
- Produces: `SidebarMode = 'changed' | 'browse'`; `RepoState`'s `'repo'` kind gains `mode: SidebarMode`.
- Produces: `window.viewmaster.setMode(mode: SidebarMode): Promise<RepoState | null>`.

- [ ] **Step 1: Add `SidebarMode` and thread it through `RepoState`**

Edit `src/shared/types.ts`. Add above `RepoState`:

```ts
export type SidebarMode = 'changed' | 'browse'
```

Change the `'repo'` variant of `RepoState`:

```ts
export type RepoState =
  | { kind: 'repo'; root: string; baseline: BaselineKind; mode: SidebarMode; files: ChangedFile[] }
  | { kind: 'folder'; root: string; files: ChangedFile[] }
  | { kind: 'error'; root: string; message: string }
```

- [ ] **Step 2: Write failing tests for `listGitTree` and `overlayStatus`**

Append to `src/main/files/browse.test.ts`:

```ts
import { makeRepo, type TestRepo } from '../git/testRepo'
import { listGitTree, overlayStatus } from './browse'

describe('listGitTree', () => {
  let repo: TestRepo

  beforeEach(async () => {
    repo = await makeRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('lists tracked and untracked-non-ignored files, excludes ignored ones', async () => {
    await repo.write('.gitignore', '*.log\n')
    await repo.write('a.txt', 'a')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'init')
    await repo.write('b.txt', 'b') // untracked
    await repo.write('debug.log', 'd') // untracked + ignored

    expect(await listGitTree(repo.root)).toEqual(['.gitignore', 'a.txt', 'b.txt'])
  })
})

describe('overlayStatus', () => {
  it('keeps the real status for changed paths and marks the rest unchanged', () => {
    const changed = [{ path: 'a.txt', absPath: '/r/a.txt', status: 'modified' as const }]

    expect(overlayStatus('/r', ['b.txt', 'a.txt'], changed)).toEqual([
      { path: 'a.txt', absPath: '/r/a.txt', status: 'modified' },
      { path: 'b.txt', absPath: '/r/b.txt', status: 'unchanged' }
    ])
  })
})
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `npx vitest run src/main/files/browse.test.ts`
Expected: FAIL — `listGitTree`/`overlayStatus` are not exported yet.

- [ ] **Step 4: Implement `listGitTree` and `overlayStatus`**

Edit `src/main/files/browse.ts`. Add the import:

```ts
import { runGit } from '../git/run'
import type { ChangedFile } from '@shared/types'
```

(`ChangedFile` import already exists from Task 1 — just add the `runGit` import alongside it.) Append:

```ts
/**
 * Full non-ignored file listing for a git repo: tracked files plus
 * untracked-but-not-ignored ones, exactly what `.gitignore` (nested
 * included, via git itself) would allow through.
 */
export async function listGitTree(root: string): Promise<string[]> {
  const res = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (res.code !== 0) throw new Error(`git ls-files failed: ${res.stderr.trim()}`)
  return res.stdout
    .split('\0')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Merge a full path listing with the changed-file set: changed paths keep
 * their real status, everything else is 'unchanged'.
 */
export function overlayStatus(root: string, allPaths: string[], changed: ChangedFile[]): ChangedFile[] {
  const changedByPath = new Map(changed.map((f) => [f.path, f]))
  return allPaths
    .map((path) => changedByPath.get(path) ?? { path, absPath: join(root, path), status: 'unchanged' as const })
    .sort((a, b) => a.path.localeCompare(b.path))
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npx vitest run src/main/files/browse.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Persist per-root mode in `store.ts`**

Edit `src/main/store.ts` — full new content:

```ts
import Store from 'electron-store'
import type { SidebarMode } from '@shared/types'

interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

interface StoreSchema {
  recentFolders: string[]
  windowBounds: WindowBounds
  folderModes: Record<string, SidebarMode>
}

const MAX_RECENT = 10

const store = new Store<StoreSchema>({
  defaults: {
    recentFolders: [],
    windowBounds: { width: 1200, height: 800 },
    folderModes: {}
  }
})

export function getRecentFolders(): string[] {
  return store.get('recentFolders')
}

export function addRecentFolder(root: string): void {
  const recents = store.get('recentFolders').filter((r) => r !== root)
  recents.unshift(root)
  store.set('recentFolders', recents.slice(0, MAX_RECENT))
}

export function getWindowBounds(): WindowBounds {
  return store.get('windowBounds')
}

export function setWindowBounds(bounds: WindowBounds): void {
  store.set('windowBounds', bounds)
}

export function getFolderMode(root: string): SidebarMode {
  return store.get('folderModes')[root] ?? 'changed'
}

export function setFolderMode(root: string, mode: SidebarMode): void {
  store.set('folderModes', { ...store.get('folderModes'), [root]: mode })
}
```

No new test file for this — matches the existing convention in this module (the sibling `recentFolders`/`windowBounds` functions have no unit tests either; it's a thin `electron-store` wrapper, exercised in practice through the manual smoke test).

- [ ] **Step 7: Thread mode through `ipc.ts`**

Edit `src/main/ipc.ts`.

Update the type import:

```ts
import type { BaselineKind, FileContent, HistoryVersion, RepoState, SidebarMode } from '@shared/types'
```

Add to the `./files/browse` import:

```ts
import { listFolderTree, listGitTree, overlayStatus, toUnchangedFiles } from './files/browse'
```

Add to the `./store` import:

```ts
import { addRecentFolder, getFolderMode, getRecentFolders, setFolderMode } from './store'
```

Add `mode` to the `Session` interface:

```ts
interface Session {
  root: string
  baseline: BaselineKind | null
  mode: SidebarMode
  watcher: FSWatcher
  recorder: Recorder | null
}
```

Replace `computeRepoState` to take an explicit mode and branch on it for git repos:

```ts
async function computeRepoState(root: string, mode: SidebarMode): Promise<RepoState> {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    const paths = await listFolderTree(root)
    return { kind: 'folder', root, files: toUnchangedFiles(root, paths) }
  }
  const toplevel = await runGit(root, ['rev-parse', '--show-toplevel'])
  const repoRoot = toplevel.code === 0 ? toplevel.stdout.trim() : root

  try {
    const baseline = await resolveBaseline(repoRoot)
    if (mode === 'changed') {
      const files = await collectChanges(repoRoot, baseline)
      return { kind: 'repo', root: repoRoot, baseline, mode, files }
    }
    const [allPaths, changed] = await Promise.all([
      listGitTree(repoRoot),
      collectChanges(repoRoot, baseline)
    ])
    return { kind: 'repo', root: repoRoot, baseline, mode, files: overlayStatus(repoRoot, allPaths, changed) }
  } catch (err) {
    return { kind: 'error', root: repoRoot, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Resolve the key used for persisted per-folder mode: the git toplevel for a
 * repo, the raw path otherwise. A second, cheap `rev-parse` call — kept
 * separate from computeRepoState so mode can be looked up before the first
 * real computation runs.
 */
async function resolveModeKey(root: string): Promise<string> {
  const toplevel = await runGit(root, ['rev-parse', '--show-toplevel'])
  return toplevel.code === 0 ? toplevel.stdout.trim() : root
}
```

Update `openRepo` to look up the persisted mode before the first compute, and to keep `session.mode` current for the watcher's recompute:

```ts
async function openRepo(getWindow: WindowGetter, root: string): Promise<RepoState> {
  await closeSession()
  const mode = getFolderMode(await resolveModeKey(root))
  const state = await computeRepoState(root, mode)

  if (state.kind !== 'error') addRecentFolder(state.root)

  if (state.kind === 'repo' || state.kind === 'folder') {
    const watchRoot = state.root
    const recorder =
      state.kind === 'repo'
        ? createRecorder(watchRoot, {
            historyBaseDir: app.getPath('userData'),
            onCapture: (relPath) => {
              const win = getWindow()
              if (win && !win.isDestroyed()) win.webContents.send('history:changed', relPath)
            }
          })
        : null
    let recomputeTimer: NodeJS.Timeout | null = null
    const watcher = watchRepo(watchRoot, (relPath) => {
      recorder?.handleEvent(relPath)
      if (recomputeTimer) clearTimeout(recomputeTimer)
      recomputeTimer = setTimeout(async () => {
        const currentMode = session?.mode ?? 'changed'
        const fresh = await computeRepoState(watchRoot, currentMode)
        if (session?.root !== watchRoot) return // repo switched — drop stale update
        if (fresh.kind === 'repo') session.baseline = fresh.baseline
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('repo:changed', fresh)
      }, RECOMPUTE_DEBOUNCE_MS)
    })
    session = {
      root: state.root,
      baseline: state.kind === 'repo' ? state.baseline : null,
      mode: state.kind === 'repo' ? state.mode : 'changed',
      watcher,
      recorder
    }
  }

  return state
}
```

Update `repo:refresh` to pass the session's current mode:

```ts
  ipcMain.handle('repo:refresh', async (): Promise<RepoState | null> => {
    return session ? computeRepoState(session.root, session.mode) : null
  })
```

Add the `mode:set` handler (in `registerIpc`, alongside the other `ipcMain.handle` calls):

```ts
  ipcMain.handle('mode:set', async (_e, mode: SidebarMode): Promise<RepoState | null> => {
    if (!session) return null
    session.mode = mode
    setFolderMode(session.root, mode)
    const fresh = await computeRepoState(session.root, mode)
    if (fresh.kind === 'repo') session.baseline = fresh.baseline
    return fresh
  })
```

- [ ] **Step 8: Add the `setMode` preload API**

Edit `src/preload/index.ts`. Update the type import:

```ts
import type { FileContent, HistoryVersion, RepoState, SidebarMode } from '@shared/types'
```

Add to the `api` object (anywhere alongside `refreshRepo`):

```ts
  setMode: (mode: SidebarMode): Promise<RepoState | null> => ipcRenderer.invoke('mode:set', mode),
```

- [ ] **Step 9: Make `.sidebar-header` a flex row**

Edit `src/renderer/src/styles.css`. Replace the `.sidebar-header` rule and add a label class:

```css
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-dim);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.sidebar-header-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

(`.toolbar-segment`/`.toolbar-button` — used for the new toggle in the next step — already exist, styled for the ContentPane's Rendered/Marks/Source control; they're reused as-is.)

- [ ] **Step 10: Add the toggle to `Sidebar.tsx`**

Edit `src/renderer/src/components/Sidebar.tsx`. Update the type import:

```ts
import type { ChangedFile, FileStatus, RepoState, SidebarMode } from '@shared/types'
```

Add `onSetMode` to the component's props and render the toggle in the header:

```tsx
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

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close, true)
    }
  }, [menu])

  const tree = useMemo(
    () => (state.kind === 'repo' || state.kind === 'folder' ? buildTree(state.files) : null),
    [state]
  )

  if (state.kind === 'error') {
    return (
      <div className="sidebar">
        <div className="sidebar-message">
          Git error
          <div className="sidebar-message-detail">{state.message}</div>
        </div>
      </div>
    )
  }

  const onContextMenu = (e: React.MouseEvent, file: ChangedFile): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, file })
  }

  const emptyMessage = state.kind === 'folder' ? 'No files to show' : 'No changes in this branch'

  return (
    <div className="sidebar">
      <div className="sidebar-header" title={state.root}>
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
      <div className="sidebar-tree">
        {tree && tree.dirs.length === 0 && tree.files.length === 0 ? (
          <div className="sidebar-message">{emptyMessage}</div>
        ) : (
          tree && (
            <Children
              node={tree}
              depth={0}
              selected={selected}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          )
        )}
      </div>
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
    </div>
  )
}
```

- [ ] **Step 11: Wire `setMode` in `App.tsx`**

Edit `src/renderer/src/App.tsx`. Update the type import:

```tsx
import type { ChangedFile, HistoryVersion, RepoState, SidebarMode } from '@shared/types'
```

Add the handler (alongside `openFolder`):

```tsx
  const setMode = useCallback((mode: SidebarMode): void => {
    void window.viewmaster.setMode(mode).then((state) => {
      if (state) setRepo(state)
    })
  }, [])
```

Pass it to `Sidebar`:

```tsx
              <Sidebar
                state={repo}
                selected={selected?.path ?? null}
                onSelect={setSelected}
                onSetMode={setMode}
              />
```

- [ ] **Step 12: Mention Browse mode in the README**

Edit `README.md`. In the "Branch diff viewing" features list, add a bullet after the existing sidebar description:

```markdown
- **Changed / Browse toggle** — flip to Browse to see the full folder tree
  (filtered by `.gitignore`), not just what changed. Files that are still
  git-changed keep their status coloring. Opening a folder that isn't a git
  repository always browses — there's nothing "changed" to show without git.
```

- [ ] **Step 13: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 14: Manual smoke test**

Run: `npm run dev`

In the running app, open a git repo (e.g. this one) that has both committed history and a few uncommitted changes:
- Confirm it opens in **Changed** mode exactly as before.
- Click **Browse** — confirm the full tree appears, changed files still show their colored status badge, unchanged files show no badge.
- Click **Changed** again — confirm it's back to the original changed-only view.
- Close and reopen the same folder (via **Recent**) — confirm it reopens in whichever mode you left it in.
- Open a non-git folder — confirm no toggle appears and it browses directly (Task 1 behavior, unaffected).

- [ ] **Step 15: Commit**

```bash
git add src/shared/types.ts src/main/files/browse.ts src/main/files/browse.test.ts \
  src/main/store.ts src/main/ipc.ts src/preload/index.ts src/renderer/src/styles.css \
  src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx README.md
git commit -m "feat(browse): Changed/Browse toggle for git repos"
```
