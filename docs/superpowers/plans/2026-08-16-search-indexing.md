# Search Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users find text within the currently-open folder's files (Find in Files), and generalize file navigation with a real back/forward history so search results (and, later, issue #7's find-usages) can jump around and retrace their steps.

**Architecture:** Main-process search is a live, bounded-concurrency, streaming scan over the current file list — no persistent index or cache, so there's nothing to invalidate when files change. The renderer's file-selection state is generalized from issue #5's one-off `pendingAnchor` into a real navigation history (array + position index), which both markdown-link navigation and search-result navigation now go through.

**Tech Stack:** Electron + TypeScript + React, Node's `readline`/streams (no new dependencies), `@monaco-editor/react`'s existing Monaco integration (for line reveal/highlight), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-search-indexing-design.md`

## Global Constraints

- No persistent content cache or inverted index — every search reads current on-disk content directly (live scan), so file edits are reflected with zero reindexing work.
- Plain case-insensitive substring matching only — no regex, no whole-word/case-sensitivity toggles.
- Binary and oversized (>2MB) files are excluded, sniffed before any line matching (never load a whole file to decide it's binary).
- Search is bounded: 50 matches per file, 500 matches total, 10-second wall-clock budget — whichever hits first stops the scan and marks the result `truncated`. A new query cancels any still-running previous scan.
- Navigation is generalized with a real back/forward history (array + position index) — issue #5's `pendingAnchor`/`onNavigateToFile`/`onSidebarSelect` are removed, not left alongside the new mechanism.
- A `{kind: 'line'}` navigation target into a markdown file forces the `'code'` mode (raw text) rather than the rendered view, since rendered HTML has no line-number mapping.

---

### Task 1: Main process — `searchFiles` (bounded, streaming scan)

**Files:**
- Modify: `src/shared/types.ts` (add the `SearchMatch` type)
- Modify: `src/main/git/content.ts` (export two existing constants)
- Create: `src/main/search/scan.ts`
- Test: `src/main/search/scan.test.ts`

**Interfaces:**
- Consumes: `MAX_SIZE`, `BINARY_SNIFF_BYTES` from `../git/content` (exported by this task).
- Produces: `SearchMatch` type in `@shared/types` (also consumed by Task 2's `SearchResult` and Task 8's `SearchPane`); `searchFiles(root: string, paths: string[], query: string, options?: { signal?: AbortSignal }): Promise<{ matches: SearchMatch[]; truncated: boolean }>`. Consumed by Task 2 (`ipc.ts`'s `search:query` handler).

- [ ] **Step 1: Add the `SearchMatch` type**

In `src/shared/types.ts`, add after the `HistoryVersion` interface (end of file):

```ts

export interface SearchMatch {
  /** Repo-relative path, forward slashes. */
  path: string
  absPath: string
  /** 1-based line number. */
  line: number
  /** 0-based character offset of the match within the full line. */
  column: number
  /** Display snippet of the line, re-centered/truncated for very long lines. */
  preview: string
  /** 0-based character offset of the match within `preview`. */
  previewColumn: number
}
```

- [ ] **Step 2: Export the two constants `scan.ts` needs**

In `src/main/git/content.ts`, change:

```ts
const MAX_SIZE = 2 * 1024 * 1024
```

to:

```ts
export const MAX_SIZE = 2 * 1024 * 1024
```

and change:

```ts
const BINARY_SNIFF_BYTES = 8192
```

to:

```ts
export const BINARY_SNIFF_BYTES = 8192
```

Nothing else in this file changes — both constants are still used locally exactly as before, just also exported.

- [ ] **Step 3: Write the failing tests**

```ts
// src/main/search/scan.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { searchFiles } from './scan'
import { makeRepo, type TestRepo } from '../git/testRepo'

let repo: TestRepo

beforeEach(async () => {
  repo = await makeRepo()
})

afterEach(async () => {
  await repo.cleanup()
})

describe('searchFiles', () => {
  it('finds a case-insensitive substring match', async () => {
    await repo.write('a.txt', 'Hello World\nSecond line\n')
    const { matches, truncated } = await searchFiles(repo.root, ['a.txt'], 'hello')
    expect(truncated).toBe(false)
    expect(matches).toEqual([
      {
        path: 'a.txt',
        absPath: join(repo.root, 'a.txt'),
        line: 1,
        column: 0,
        preview: 'Hello World',
        previewColumn: 0
      }
    ])
  })

  it('finds multiple matches across multiple files', async () => {
    await repo.write('a.txt', 'foo bar\n')
    await repo.write('sub/b.txt', 'bar foo\nanother foo here\n')
    const { matches } = await searchFiles(repo.root, ['a.txt', 'sub/b.txt'], 'foo')
    const byLine = matches.map((m) => `${m.path}:${m.line}`).sort()
    expect(byLine).toEqual(['a.txt:1', 'sub/b.txt:1', 'sub/b.txt:2'])
  })

  it('returns no matches for an empty or whitespace-only query', async () => {
    await repo.write('a.txt', 'hello\n')
    expect(await searchFiles(repo.root, ['a.txt'], '')).toEqual({ matches: [], truncated: false })
    expect(await searchFiles(repo.root, ['a.txt'], '   ')).toEqual({
      matches: [],
      truncated: false
    })
  })

  it('excludes binary files even when their raw bytes contain the query', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0x47, ...Buffer.from('needle')])
    await repo.write('photo.bin', bytes)
    const { matches } = await searchFiles(repo.root, ['photo.bin'], 'needle')
    expect(matches).toEqual([])
  })

  it('excludes files over the 2MB size cap', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61)
    await repo.write('big.txt', big)
    const { matches } = await searchFiles(repo.root, ['big.txt'], 'aaaa')
    expect(matches).toEqual([])
  })

  it('centers a long preview around a match far into the line', async () => {
    const line = 'x'.repeat(300) + 'NEEDLE' + 'y'.repeat(300)
    await repo.write('long.txt', line + '\n')
    const { matches } = await searchFiles(repo.root, ['long.txt'], 'needle')
    expect(matches).toHaveLength(1)
    const match = matches[0]
    expect(match.preview).toContain('NEEDLE')
    expect(match.preview.slice(match.previewColumn, match.previewColumn + 6)).toBe('NEEDLE')
    expect(match.preview.length).toBeLessThanOrEqual(200)
  })

  it('caps matches per file and marks the result truncated', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `needle ${i}`).join('\n')
    await repo.write('many.txt', lines + '\n')
    const { matches, truncated } = await searchFiles(repo.root, ['many.txt'], 'needle')
    expect(matches).toHaveLength(50)
    expect(truncated).toBe(true)
  })

  it('respects an already-aborted signal by scanning nothing', async () => {
    await repo.write('a.txt', 'needle\n')
    const controller = new AbortController()
    controller.abort()
    const { matches } = await searchFiles(repo.root, ['a.txt'], 'needle', {
      signal: controller.signal
    })
    expect(matches).toEqual([])
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run src/main/search/scan.test.ts`
Expected: FAIL — `Cannot find module './scan'`.

- [ ] **Step 5: Implement `searchFiles`**

```ts
// src/main/search/scan.ts
import { createReadStream } from 'fs'
import { open, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { join } from 'path'
import type { SearchMatch } from '@shared/types'
import { BINARY_SNIFF_BYTES, MAX_SIZE } from '../git/content'

const CONCURRENCY = 24
const MAX_MATCHES_PER_FILE = 50
const MAX_MATCHES_TOTAL = 500
const TIME_BUDGET_MS = 10000
const PREVIEW_MAX_LENGTH = 200
const PREVIEW_CONTEXT = 60

export interface SearchScanOptions {
  signal?: AbortSignal
}

export interface SearchScanResult {
  matches: SearchMatch[]
  truncated: boolean
}

/** True when the first BINARY_SNIFF_BYTES of `absPath` contain a NUL byte. */
async function isBinaryFile(absPath: string): Promise<boolean> {
  const handle = await open(absPath, 'r')
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

/**
 * Extracts a display snippet around a match, capped to PREVIEW_MAX_LENGTH.
 * For a line short enough to fit whole, `previewColumn` equals `column`;
 * for a longer line, the snippet is centered around the match (with
 * PREVIEW_CONTEXT characters of leading context where available) so a
 * match far into a long/minified line is never cut out of the preview.
 */
function extractPreview(line: string, column: number): { preview: string; previewColumn: number } {
  if (line.length <= PREVIEW_MAX_LENGTH) return { preview: line, previewColumn: column }
  const start = Math.max(0, column - PREVIEW_CONTEXT)
  const end = Math.min(line.length, start + PREVIEW_MAX_LENGTH)
  return { preview: line.slice(start, end), previewColumn: column - start }
}

/**
 * Scans one file for up to `maxMatches` occurrences of `needle` (already
 * lowercased). `capped` is true when the file had more matches than
 * `maxMatches` allowed for (used by the caller to mark the overall result
 * `truncated`).
 */
async function scanOneFile(
  absPath: string,
  relPath: string,
  needle: string,
  maxMatches: number
): Promise<{ matches: SearchMatch[]; capped: boolean }> {
  if (maxMatches <= 0) return { matches: [], capped: false }

  try {
    const info = await stat(absPath)
    if (!info.isFile() || info.size === 0 || info.size > MAX_SIZE) {
      return { matches: [], capped: false }
    }
  } catch {
    return { matches: [], capped: false }
  }

  try {
    if (await isBinaryFile(absPath)) return { matches: [], capped: false }
  } catch {
    return { matches: [], capped: false }
  }

  const results: SearchMatch[] = []
  let capped = false
  const rl = createInterface({
    input: createReadStream(absPath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  let lineNumber = 0
  try {
    for await (const line of rl) {
      lineNumber++
      const column = line.toLowerCase().indexOf(needle)
      if (column === -1) continue
      const { preview, previewColumn } = extractPreview(line, column)
      results.push({ path: relPath, absPath, line: lineNumber, column, preview, previewColumn })
      if (results.length >= maxMatches) {
        capped = true
        break
      }
    }
  } finally {
    rl.close()
  }
  return { matches: results, capped }
}

/** Runs `worker` over `items` with at most `concurrency` running at once. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  const next = (): T | undefined => (cursor < items.length ? items[cursor++] : undefined)
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const item = next()
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Live, bounded-concurrency substring search over `paths` (already
 * gitignore-filtered, relative to `root`) — no persistent index or cache;
 * every call reads current on-disk content. Case-insensitive plain
 * substring matching, capped at MAX_MATCHES_PER_FILE per file and
 * MAX_MATCHES_TOTAL overall (soft caps under concurrency — may overshoot
 * slightly before all workers notice; that's fine, this is a safety valve,
 * not an invariant anything else depends on), plus a TIME_BUDGET_MS
 * wall-clock budget as a second, independent guard against a
 * pathologically large folder. `options.signal`, if already aborted or
 * aborted mid-scan, stops dispatching new file scans promptly (a file scan
 * already in flight when the abort happens is not cancelled mid-file).
 */
export async function searchFiles(
  root: string,
  paths: string[],
  query: string,
  options: SearchScanOptions = {}
): Promise<SearchScanResult> {
  if (query.trim() === '') return { matches: [], truncated: false }
  const needle = query.toLowerCase()
  const matches: SearchMatch[] = []
  let truncated = false
  const startedAt = Date.now()
  const signal = options.signal

  await runWithConcurrency(paths, CONCURRENCY, async (relPath) => {
    if (signal?.aborted) return
    if (matches.length >= MAX_MATCHES_TOTAL) {
      truncated = true
      return
    }
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      truncated = true
      return
    }
    const perFileCap = Math.min(MAX_MATCHES_PER_FILE, MAX_MATCHES_TOTAL - matches.length)
    const absPath = join(root, relPath)
    const { matches: fileMatches, capped } = await scanOneFile(absPath, relPath, needle, perFileCap)
    matches.push(...fileMatches)
    if (capped) truncated = true
  })

  return { matches, truncated }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/main/search/scan.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors — confirms `scan.ts`'s import of the new `SearchMatch` type and the two now-exported `content.ts` constants all resolve correctly.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS — confirms exporting the two `content.ts` constants didn't break anything (it shouldn't; the change is additive).

- [ ] **Step 9: Commit**

```bash
git add src/shared/types.ts src/main/git/content.ts src/main/search/scan.ts src/main/search/scan.test.ts
git commit -m "feat: add bounded streaming file-content search scan"
```

---

### Task 2: Main process — `search:query` IPC handler

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `searchFiles` (Task 1); `SearchMatch` type (Task 1, already in `@shared/types`).
- Produces: `SearchResult` type in `@shared/types`; IPC handler `search:query`; preload bridge `window.viewmaster.search(query: string): Promise<SearchResult>`. Consumed by Task 8 (`SearchPane`).

No automated test for the IPC handler itself — this codebase has no `ipc.test.ts` (confirmed: `ipcMain`/`shell` aren't unit-tested anywhere; every other IPC handler added by prior features has none either). Covered by Task 10's manual verification.

- [ ] **Step 1: Add the `SearchResult` type**

`SearchMatch` already exists (added by Task 1). In `src/shared/types.ts`, add right after it:

```ts

export interface SearchResult {
  matches: SearchMatch[]
  truncated: boolean
}
```

- [ ] **Step 2: Add the IPC handler**

In `src/main/ipc.ts`, change the type import at the top from:

```ts
import type { BaselineKind, FileContent, HistoryVersion, RepoState, SidebarMode } from '@shared/types'
```

to:

```ts
import type {
  BaselineKind,
  FileContent,
  HistoryVersion,
  RepoState,
  SearchResult,
  SidebarMode
} from '@shared/types'
```

Change the `files/browse` import from:

```ts
import { browseFiles, listFolderTree, toUnchangedFiles } from './files/browse'
```

to:

```ts
import { browseFiles, listFolderTree, listGitTree, toUnchangedFiles } from './files/browse'
```

Add a new import:

```ts
import { searchFiles } from './search/scan'
```

Add a module-level variable near the top, alongside the existing `let session: Session | null = null` (line 25):

```ts
let currentSearchController: AbortController | null = null
```

Add the handler inside `registerIpc`, after the `history:read` handler (near the end of the function, before its closing brace):

```ts
  ipcMain.handle('search:query', async (_e, query: string): Promise<SearchResult> => {
    currentSearchController?.abort()
    if (!session) return { matches: [], truncated: false }
    const controller = new AbortController()
    currentSearchController = controller
    const paths = session.baseline
      ? await listGitTree(session.root)
      : await listFolderTree(session.root)
    return searchFiles(session.root, paths, query, { signal: controller.signal })
  })
```

(`session.baseline` is non-null exactly for a git-repo session — see the existing `mode: state.kind === 'repo' ? state.mode : 'browse'` comment a few lines up in this same file for the same repo-vs-folder distinction already relied on there.)

- [ ] **Step 3: Add the preload bridge method**

In `src/preload/index.ts`, change the type import from:

```ts
import type { FileContent, HistoryVersion, RepoState, SidebarMode } from '@shared/types'
```

to:

```ts
import type { FileContent, HistoryVersion, RepoState, SearchResult, SidebarMode } from '@shared/types'
```

Add to the `api` object, near `historyRead`:

```ts
  search: (query: string): Promise<SearchResult> => ipcRenderer.invoke('search:query', query),
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat: add search:query IPC handler and preload bridge"
```

---

### Task 3: Main process — "Find in Files…" menu item

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces: IPC event `menu:findInFiles`; preload bridge `window.viewmaster.onMenuFindInFiles(cb: () => void): () => void`. Consumed by Task 9 (`App.tsx`).

No automated test — mirrors the existing `menu:openFolder` mechanism, which also has none (Electron `Menu`/window IPC isn't unit-tested anywhere in this codebase). Covered by Task 10.

- [ ] **Step 1: Add the menu item and its send function**

In `src/main/index.ts`, add a new function near `sendOpenFolder` (after its definition, line 19):

```ts
function sendFindInFiles(): void {
  getMainWindow()?.webContents.send('menu:findInFiles')
}
```

Change the menu template in `buildMenu` (currently `File` → `editMenu` → `viewMenu` → `windowMenu`) to insert a new top-level entry between `File` and `editMenu`:

```ts
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
        }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
```

- [ ] **Step 2: Add the preload subscription**

In `src/preload/index.ts`, add to the `api` object, near `onHistoryChanged`:

```ts
  onMenuFindInFiles: (cb: () => void): (() => void) => subscribe<void>('menu:findInFiles', () => cb()),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "feat: add Find in Files menu item and accelerator"
```

---

### Task 4: Renderer — navigation history (pure module)

**Files:**
- Create: `src/renderer/src/navigation/history.ts`
- Test: `src/renderer/src/navigation/history.test.ts`

**Interfaces:**
- Produces: `NavigationTarget`, `NavigationEntry`, `NavigationState`, `initialNavigationState()`, `pushEntry(state, entry)`, `canGoBack(state)`, `canGoForward(state)`, `goBack(state)`, `goForward(state)`, `currentEntry(state)`. Consumed by Task 5 (`App.tsx`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/navigation/history.test.ts
import { describe, it, expect } from 'vitest'
import {
  initialNavigationState,
  pushEntry,
  goBack,
  goForward,
  canGoBack,
  canGoForward,
  currentEntry
} from './history'

describe('navigation history', () => {
  it('starts empty with no current entry', () => {
    const state = initialNavigationState()
    expect(currentEntry(state)).toBeNull()
    expect(canGoBack(state)).toBe(false)
    expect(canGoForward(state)).toBe(false)
  })

  it('pushing an entry makes it current and enables back but not forward', () => {
    let state = initialNavigationState()
    state = pushEntry(state, { absPath: '/a.md' })
    expect(currentEntry(state)).toEqual({ absPath: '/a.md' })
    expect(canGoBack(state)).toBe(false)
    expect(canGoForward(state)).toBe(false)

    state = pushEntry(state, { absPath: '/b.md' })
    expect(currentEntry(state)).toEqual({ absPath: '/b.md' })
    expect(canGoBack(state)).toBe(true)
    expect(canGoForward(state)).toBe(false)
  })

  it('goBack/goForward move the position without duplicating entries', () => {
    let state = initialNavigationState()
    state = pushEntry(state, { absPath: '/a.md' })
    state = pushEntry(state, { absPath: '/b.md' })
    state = pushEntry(state, { absPath: '/c.md' })

    state = goBack(state)
    expect(currentEntry(state)).toEqual({ absPath: '/b.md' })
    expect(canGoBack(state)).toBe(true)
    expect(canGoForward(state)).toBe(true)

    state = goBack(state)
    expect(currentEntry(state)).toEqual({ absPath: '/a.md' })
    expect(canGoBack(state)).toBe(false)
    expect(canGoForward(state)).toBe(true)

    state = goForward(state)
    state = goForward(state)
    expect(currentEntry(state)).toEqual({ absPath: '/c.md' })
    expect(canGoForward(state)).toBe(false)
  })

  it('is a no-op at either boundary', () => {
    let state = initialNavigationState()
    state = pushEntry(state, { absPath: '/a.md' })
    const afterForwardAtEnd = goForward(state)
    expect(afterForwardAtEnd).toEqual(state)

    state = goBack(state)
    const afterBackAtStart = goBack(state)
    expect(afterBackAtStart).toEqual(state)
  })

  it('a new push after going back truncates the forward entries', () => {
    let state = initialNavigationState()
    state = pushEntry(state, { absPath: '/a.md' })
    state = pushEntry(state, { absPath: '/b.md' })
    state = goBack(state)
    state = pushEntry(state, { absPath: '/c.md' })
    expect(state.entries.map((e) => e.absPath)).toEqual(['/a.md', '/c.md'])
    expect(canGoForward(state)).toBe(false)
  })

  it('carries an optional navigation target on an entry', () => {
    let state = initialNavigationState()
    state = pushEntry(state, { absPath: '/a.md', target: { kind: 'anchor', id: 'section' } })
    expect(currentEntry(state)).toEqual({
      absPath: '/a.md',
      target: { kind: 'anchor', id: 'section' }
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/navigation/history.test.ts`
Expected: FAIL — `Cannot find module './history'`.

- [ ] **Step 3: Implement the navigation history module**

```ts
// src/renderer/src/navigation/history.ts

export type NavigationTarget = { kind: 'anchor'; id: string } | { kind: 'line'; line: number }

export interface NavigationEntry {
  absPath: string
  target?: NavigationTarget
}

export interface NavigationState {
  entries: NavigationEntry[]
  index: number
}

export function initialNavigationState(): NavigationState {
  return { entries: [], index: -1 }
}

/** Pushes a new entry, discarding any "forward" entries past the current position. */
export function pushEntry(state: NavigationState, entry: NavigationEntry): NavigationState {
  const kept = state.entries.slice(0, state.index + 1)
  return { entries: [...kept, entry], index: kept.length }
}

export function canGoBack(state: NavigationState): boolean {
  return state.index > 0
}

export function canGoForward(state: NavigationState): boolean {
  return state.index < state.entries.length - 1
}

export function goBack(state: NavigationState): NavigationState {
  return canGoBack(state) ? { ...state, index: state.index - 1 } : state
}

export function goForward(state: NavigationState): NavigationState {
  return canGoForward(state) ? { ...state, index: state.index + 1 } : state
}

export function currentEntry(state: NavigationState): NavigationEntry | null {
  return state.entries[state.index] ?? null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/navigation/history.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/navigation/history.ts src/renderer/src/navigation/history.test.ts
git commit -m "feat: add pure navigation history stack (back/forward)"
```

---

### Task 5: Renderer — `App.tsx` navigation refactor

**Files:**
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `initialNavigationState`, `pushEntry`, `canGoBack`, `canGoForward`, `goBack`, `goForward`, `currentEntry`, `type NavigationTarget` (Task 4).
- Produces: `navigateTo(absPath: string, target?: NavigationTarget): void`, passed to `ContentPane` as `onNavigate` (Task 7); `canGoBack`/`canGoForward`/`onGoBack`/`onGoForward`/`navigationTarget`/`onTargetConsumed` props passed to `ContentPane` (Task 7).

This task's own `npm run typecheck` will show errors at the `<ContentPane>` call site (props `ContentPane` doesn't accept until Task 7 lands) — expected, matches the same pattern prior features in this codebase used when one task introduces a new prop shape and a later task updates the consumer. No automated test — `App.tsx` has no existing test file. Covered by Task 10.

- [ ] **Step 1: Replace the full contents of `App.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import type { ChangedFile, HistoryVersion, RepoState, SidebarMode } from '@shared/types'
import Sidebar from './components/Sidebar'
import ContentPane from './components/ContentPane'
import HistoryPane from './components/HistoryPane'
import {
  defaultSelection,
  singleClickSelection,
  type RevisionRef,
  type Selection
} from './history/selection'
import {
  canGoBack,
  canGoForward,
  currentEntry,
  goBack,
  goForward,
  initialNavigationState,
  pushEntry,
  type NavigationTarget
} from './navigation/history'

function Welcome({ onOpen }: { onOpen: (root: string) => void }): React.JSX.Element {
  const [recents, setRecents] = useState<string[]>([])

  useEffect(() => {
    void window.viewmaster.recentFolders().then(setRecents)
  }, [])

  const pick = async (): Promise<void> => {
    const root = await window.viewmaster.openFolderDialog()
    if (root) onOpen(root)
  }

  return (
    <div className="welcome">
      <h1>View Master</h1>
      <p>Read-only viewer for markdown documents and branch diffs.</p>
      <div className="welcome-mark" aria-hidden="true" />
      <button className="open-button" onClick={() => void pick()}>
        Open Folder…
      </button>
      {recents.length > 0 && (
        <div className="recent-list">
          <div className="recent-title">Recent</div>
          {recents.map((root) => (
            <div key={root} className="recent-item" onClick={() => onOpen(root)}>
              {root}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [repo, setRepo] = useState<RepoState | null>(null)
  const [selected, setSelected] = useState<ChangedFile | null>(null)
  const [navState, setNavState] = useState(initialNavigationState())
  const [refreshKey, setRefreshKey] = useState(0)
  const [versions, setVersions] = useState<HistoryVersion[]>([])
  const [selection, setSelection] = useState<Selection>(defaultSelection())
  const [historyTick, setHistoryTick] = useState(0)

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

  // Watcher-driven auto-refresh: update the change list in place. `selected`
  // is re-derived below from the nav stack + fresh `repo`, so no separate
  // reconciliation is needed here.
  useEffect(
    () =>
      window.viewmaster.onRepoChanged((state) => {
        setRepo(state)
        setRefreshKey((k) => k + 1)
      }),
    []
  )

  // A settle-capture just landed a new version — re-fetch history for the
  // currently-selected file so the pane updates without waiting for the next
  // repo change or file switch. (Captures write outside the watched repo, so
  // they don't otherwise trigger a refresh.)
  useEffect(() => window.viewmaster.onHistoryChanged(() => setHistoryTick((t) => t + 1)), [])

  // Reset the revision selection whenever the selected file changes.
  useEffect(() => {
    setSelection(defaultSelection())
    setVersions([])
  }, [selected?.path])

  // Load local history for the selected file (git repos only), refreshing when
  // the watcher reports a change.
  useEffect(() => {
    if (!selected || repo?.kind !== 'repo') {
      setVersions([])
      return
    }
    let stale = false
    void window.viewmaster.historyList(selected.path).then((v) => {
      if (!stale) setVersions(v)
    })
    return () => {
      stale = true
    }
  }, [selected?.path, repo?.kind, refreshKey, historyTick])

  const onSelectRevision = useCallback(
    (ref: RevisionRef): void => {
      setSelection(singleClickSelection(versions, ref))
    },
    [versions]
  )

  /**
   * Resolves an absPath against the current repo listing, synthesizing an
   * "unchanged" entry for a target outside it (e.g. a link/search jump to a
   * file with no git-changed entry in Changed mode) — the same convention
   * Browse Mode's overlayStatus already uses for untouched files.
   */
  const resolveChangedFile = useCallback(
    (absPath: string): ChangedFile | null => {
      if (!repo || (repo.kind !== 'repo' && repo.kind !== 'folder')) return null
      const existing = repo.files.find((f) => f.absPath === absPath)
      if (existing) return existing
      const rel = absPath.startsWith(repo.root)
        ? absPath.slice(repo.root.length).replace(/^\/+/, '')
        : absPath
      return { path: rel, absPath, status: 'unchanged' }
    },
    [repo]
  )

  // `selected` always mirrors the nav stack's current entry, re-resolved
  // against the latest `repo` listing (e.g. after a watcher-driven refresh
  // changes a file's status).
  useEffect(() => {
    const entry = currentEntry(navState)
    setSelected(entry ? resolveChangedFile(entry.absPath) : null)
  }, [navState, resolveChangedFile])

  const navigateTo = useCallback((absPath: string, target?: NavigationTarget): void => {
    setNavState((s) => pushEntry(s, { absPath, target }))
  }, [])

  const onSidebarSelect = useCallback(
    (file: ChangedFile): void => {
      navigateTo(file.absPath)
    },
    [navigateTo]
  )

  const onGoBack = useCallback((): void => setNavState((s) => goBack(s)), [])
  const onGoForward = useCallback((): void => setNavState((s) => goForward(s)), [])

  const navigationTarget = currentEntry(navState)?.target ?? null

  // Marks the current entry's target as handled so a re-render doesn't keep
  // re-triggering the same scroll/reveal action. Deliberately does not clear
  // on its own if the user has since navigated elsewhere — by the time a
  // consumer calls this, it has just acted on the *current* target, so
  // clearing "whatever entry is current now" is always clearing the right one.
  const onTargetConsumed = useCallback((): void => {
    setNavState((s) => {
      const entry = currentEntry(s)
      if (!entry?.target) return s
      const entries = s.entries.slice()
      entries[s.index] = { absPath: entry.absPath }
      return { ...s, entries }
    })
  }, [])

  if (!repo) {
    return (
      <div className="app">
        <Welcome onOpen={openFolder} />
      </div>
    )
  }

  return (
    <div className="app">
      <Allotment defaultSizes={[280, 920]}>
        <Allotment.Pane minSize={180} preferredSize={280}>
          <Allotment vertical>
            <Allotment.Pane>
              <Sidebar
                state={repo}
                selected={selected?.path ?? null}
                onSelect={onSidebarSelect}
                onSetMode={setMode}
              />
            </Allotment.Pane>
            <Allotment.Pane preferredSize={220} minSize={80}>
              <HistoryPane
                versions={versions}
                selection={selection}
                isGitRepo={repo?.kind === 'repo'}
                onSelect={onSelectRevision}
              />
            </Allotment.Pane>
          </Allotment>
        </Allotment.Pane>
        <Allotment.Pane>
          <ContentPane
            file={selected}
            refreshKey={refreshKey}
            selection={selection}
            versions={versions}
            workspaceRoot={repo?.root ?? ''}
            onNavigate={navigateTo}
            navigationTarget={navigationTarget}
            onTargetConsumed={onTargetConsumed}
            canGoBack={canGoBack(navState)}
            canGoForward={canGoForward(navState)}
            onGoBack={onGoBack}
            onGoForward={onGoForward}
          />
        </Allotment.Pane>
      </Allotment>
    </div>
  )
}
```

Note what this deletes relative to the current file: the `reconcileSelected` helper function, `pendingAnchor` state, `onNavigateToFile`, `onAnchorConsumed`, and the bespoke `onSidebarSelect` that existed solely to null out a stale anchor — all superseded by the nav-stack-derived `selected` and the generalized target-consumption above.

- [ ] **Step 2: Typecheck (expected errors, not a regression)**

Run: `npm run typecheck`
Expected: errors at the `<ContentPane ...>` JSX call site above (`workspaceRoot`/`onNavigate`/`navigationTarget`/etc. not yet in `ContentPane`'s prop type) — fixed by Task 7. No errors anywhere else.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: generalize file navigation into a back/forward history stack"
```

---

### Task 6: Renderer — `CodeView` line reveal/highlight

**Files:**
- Modify: `src/renderer/src/components/CodeView.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Produces: `CodeView` gains an optional `revealLine?: number` prop — when set, scrolls to and highlights that line. Consumed by Task 7 (`ContentPane`).

No automated test — `CodeView.tsx` has no existing test file (Monaco-backed, no `.tsx` test infrastructure in this codebase). Covered by Task 10.

- [ ] **Step 1: Replace the full contents of `CodeView.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import '../monacoSetup'
import { languageForFile } from '../monacoSetup'

export default function CodeView({
  fileName,
  content,
  revealLine
}: {
  fileName: string
  content: string
  revealLine?: number
}): React.JSX.Element {
  const [editorInstance, setEditorInstance] = useState<editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)

  useEffect(() => {
    if (!editorInstance) return
    if (!decorationsRef.current) {
      decorationsRef.current = editorInstance.createDecorationsCollection()
    }
    if (revealLine) {
      editorInstance.revealLineInCenter(revealLine)
      decorationsRef.current.set([
        {
          range: {
            startLineNumber: revealLine,
            startColumn: 1,
            endLineNumber: revealLine,
            endColumn: 1
          },
          options: { isWholeLine: true, className: 'code-view-highlight-line' }
        }
      ])
    } else {
      decorationsRef.current.clear()
    }
  }, [editorInstance, revealLine, content])

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      language={languageForFile(fileName)}
      value={content}
      onMount={setEditorInstance}
      options={{
        readOnly: true,
        lineNumbers: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'none',
        automaticLayout: true,
        domReadOnly: true
      }}
    />
  )
}
```

- [ ] **Step 2: Add the highlight decoration style**

In `src/renderer/src/styles.css`, add anywhere among the top-level blocks (exact position doesn't matter):

```css
/* ---- code view line highlight ---- */

.code-view-highlight-line {
  background: rgba(77, 163, 255, 0.15);
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no new errors from this file (the pre-existing `App.tsx`/`ContentPane` mismatch from Task 5 is unrelated and still expected).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/CodeView.tsx src/renderer/src/styles.css
git commit -m "feat: add line reveal/highlight support to CodeView"
```

---

### Task 7: Renderer — `ContentPane` navigation-target wiring

**Files:**
- Modify: `src/renderer/src/components/ContentPane.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `type NavigationTarget` (Task 4); `App.tsx`'s new props (Task 5); `CodeView`'s `revealLine` prop (Task 6).
- Produces: `ContentPane`'s props become `{ file, refreshKey, selection, versions, workspaceRoot, onNavigate, navigationTarget, onTargetConsumed, canGoBack, canGoForward, onGoBack, onGoForward }` — replacing `scrollToAnchor`/`onAnchorConsumed`. This closes the typecheck gap Task 5 left open.

`MarkdownView.tsx` does **not** change in this task (or anywhere in this plan). Its existing `scrollToAnchor: string | null` / `onAnchorConsumed: () => void` props stay exactly as issue #5 built them — `ContentPane` translates `navigationTarget` into that shape at the boundary (extracting the anchor id when present), since `MarkdownView` never needs to see a `{kind: 'line'}` target: a line-targeted jump into a markdown file is routed to `CodeView` instead (see Step 1), so `MarkdownView` simply never receives one in practice.

No automated test — `ContentPane.tsx` has no existing test file. Covered by Task 10.

- [ ] **Step 1: Replace the full contents of `ContentPane.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { ChangedFile, FileContent, HistoryVersion } from '@shared/types'
import { isDefaultSelection, type RevisionRef, type Selection } from '../history/selection'
import type { NavigationTarget } from '../navigation/history'
import CodeView from './CodeView'
import DiffView from './DiffView'
import MarkdownView from './MarkdownView'
import Placeholder from './Placeholder'
import ImageView from './ImageView'
import { rasterDataUrl, svgDataUrl } from '../image/dataUrl'
import PdfView from './PdfView'

type Mode = 'view' | 'marks' | 'code' | 'diff'

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx']

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

const SVG_EXTENSION = '.svg'

function isSvg(path: string): boolean {
  return path.toLowerCase().endsWith(SVG_EXTENSION)
}

export default function ContentPane({
  file,
  refreshKey,
  selection,
  versions,
  workspaceRoot,
  onNavigate,
  navigationTarget,
  onTargetConsumed,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward
}: {
  file: ChangedFile | null
  refreshKey: number
  selection: Selection
  versions: HistoryVersion[]
  workspaceRoot: string
  onNavigate: (absPath: string, target?: NavigationTarget) => void
  navigationTarget: NavigationTarget | null
  onTargetConsumed: () => void
  canGoBack: boolean
  canGoForward: boolean
  onGoBack: () => void
  onGoForward: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('view')
  const [sideBySide, setSideBySide] = useState(true)
  const [content, setContent] = useState<FileContent | null>(null)
  const [baseContent, setBaseContent] = useState<string | null>(null)
  const [compareContent, setCompareContent] = useState<string | null>(null)

  // Reset to rendered/view mode whenever a different file is selected.
  useEffect(() => {
    setMode('view')
  }, [file?.path])

  // A line-targeted navigation into a markdown file needs the raw-text
  // 'code' mode to be meaningful (a rendered-HTML view has no line-number
  // mapping) -- force it once, when the target first arrives. This never
  // resets mode back on consumption (target -> null); once switched to
  // 'code' for a jump, the user's own subsequent mode choice is a normal
  // toggle, not something this effect should fight.
  useEffect(() => {
    if (file && isMarkdown(file.path) && navigationTarget?.kind === 'line') {
      setMode('code')
    }
  }, [file?.path, navigationTarget])

  // A non-default revision selection means "show a diff"; jump into diff mode.
  useEffect(() => {
    if (!isDefaultSelection(selection)) setMode((m) => (m === 'view' ? 'diff' : m))
  }, [selection])

  // Current on-disk content (for view mode + the 'now' ref).
  useEffect(() => {
    if (!file) return
    let stale = false
    void window.viewmaster.readFile(file.absPath).then((c) => {
      if (!stale) setContent(c)
    })
    return () => {
      stale = true
    }
  }, [file, refreshKey])

  // Show the loading placeholder while a newly-selected revision pair resolves.
  useEffect(() => {
    setBaseContent(null)
    setCompareContent(null)
  }, [selection, file?.path, mode])

  // Resolve base/compare sides from the selection when diffing.
  useEffect(() => {
    if (!file || (mode !== 'diff' && mode !== 'marks')) return
    let stale = false
    const resolve = async (ref: RevisionRef): Promise<string> => {
      if (ref === 'baseline') return window.viewmaster.readBaseFile(file.path)
      if (ref === 'now') {
        const c = await window.viewmaster.readFile(file.absPath)
        return c.kind === 'text' ? c.content : ''
      }
      return window.viewmaster.historyRead(ref.sha)
    }
    void resolve(selection.base).then((b) => {
      if (!stale) setBaseContent(b)
    })
    void resolve(selection.compare).then((c) => {
      if (!stale) setCompareContent(c)
    })
    return () => {
      stale = true
    }
  }, [file, mode, selection, refreshKey])

  if (!file) {
    return (
      <div className="content-pane">
        <Placeholder title="Select a file to view it" />
      </div>
    )
  }

  const fileName = file.path.split('/').pop() ?? file.path
  const lineTarget = navigationTarget?.kind === 'line' ? navigationTarget.line : undefined
  const anchorTarget = navigationTarget?.kind === 'anchor' ? navigationTarget.id : null

  // MarkdownView's onNavigate prop is unchanged from issue #5 -- a bare
  // optional anchor string, not a NavigationTarget. This adapts the real
  // (generalized) onNavigate to that shape at the boundary, since
  // MarkdownView itself doesn't change in this plan.
  const onMarkdownNavigate = (absPath: string, anchor?: string): void => {
    onNavigate(absPath, anchor ? { kind: 'anchor', id: anchor } : undefined)
  }

  let body: React.JSX.Element
  if (!content) {
    body = <Placeholder title="Loading…" />
  } else if (content.kind === 'image') {
    body = <ImageView src={rasterDataUrl(content.mime, content.base64)} />
  } else if (content.kind === 'binary') {
    body = <Placeholder title="Binary file" detail="Not displayed" />
  } else if (content.kind === 'too-large') {
    body = (
      <Placeholder
        title="File too large to display"
        detail={`${(content.size / (1024 * 1024)).toFixed(1)} MB`}
      />
    )
  } else if (content.kind === 'missing') {
    body = <Placeholder title="File not found" detail={file.absPath} />
  } else if (content.kind === 'pdf') {
    body = <PdfView base64={content.base64} />
  } else if (isSvg(file.path) && mode === 'code') {
    body = <CodeView fileName={fileName} content={content.content} />
  } else if (isSvg(file.path)) {
    body = <ImageView src={svgDataUrl(content.content)} />
  } else if (mode === 'diff') {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading diff…" />
      ) : (
        <DiffView
          fileName={fileName}
          original={baseContent}
          modified={compareContent}
          sideBySide={sideBySide}
        />
      )
  } else if (mode === 'marks' && isMarkdown(file.path)) {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading marks…" />
      ) : (
        <MarkdownView
          content={compareContent}
          baseContent={baseContent}
          absPath={file.absPath}
          workspaceRoot={workspaceRoot}
          onNavigate={onMarkdownNavigate}
          scrollToAnchor={anchorTarget}
          onAnchorConsumed={onTargetConsumed}
        />
      )
  } else if (mode === 'code' && isMarkdown(file.path)) {
    body = <CodeView fileName={fileName} content={content.content} revealLine={lineTarget} />
  } else if (isMarkdown(file.path)) {
    body = (
      <MarkdownView
        content={content.content}
        absPath={file.absPath}
        workspaceRoot={workspaceRoot}
        onNavigate={onMarkdownNavigate}
        scrollToAnchor={anchorTarget}
        onAnchorConsumed={onTargetConsumed}
      />
    )
  } else {
    body = <CodeView fileName={fileName} content={content.content} revealLine={lineTarget} />
  }

  const showToolbarToggles = content?.kind === 'text'

  return (
    <div className="content-pane">
      <div className="toolbar">
        <span className="toolbar-nav">
          <button className="toolbar-button" onClick={onGoBack} disabled={!canGoBack} title="Back">
            ←
          </button>
          <button
            className="toolbar-button"
            onClick={onGoForward}
            disabled={!canGoForward}
            title="Forward"
          >
            →
          </button>
        </span>
        <span className="toolbar-path" title={file.absPath}>
          {file.path}
        </span>
        <span className="toolbar-actions">
          {showToolbarToggles && mode === 'diff' && !isSvg(file.path) && (
            <button className="toolbar-button" onClick={() => setSideBySide(!sideBySide)}>
              {sideBySide ? 'Inline' : 'Side by side'}
            </button>
          )}
          {showToolbarToggles && isSvg(file.path) ? (
            <span className="toolbar-segment">
              {(['view', 'code'] as const).map((m) => (
                <button
                  key={m}
                  className={`toolbar-button${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'view' ? 'Rendered' : 'Code'}
                </button>
              ))}
            </span>
          ) : showToolbarToggles && isMarkdown(file.path) ? (
            <span className="toolbar-segment">
              {(['view', 'marks', 'diff'] as const).map((m) => (
                <button
                  key={m}
                  className={`toolbar-button${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'view' ? 'Rendered' : m === 'marks' ? 'Marks' : 'Source'}
                </button>
              ))}
            </span>
          ) : (
            showToolbarToggles && (
              <button
                className={`toolbar-button${mode === 'diff' ? ' active' : ''}`}
                onClick={() => setMode(mode === 'diff' ? 'view' : 'diff')}
              >
                Diff
              </button>
            )
          )}
        </span>
      </div>
      <div className="content-body">{body}</div>
    </div>
  )
}
```

Note: markdown files intentionally have no user-visible toolbar toggle for the `'code'` mode this task adds (unlike SVG's explicit Rendered/Code segment) — it's reachable only via a line-targeted navigation (a search-result click). A user can still get back to the rendered view by clicking the existing "Rendered" button, which sets `mode` to `'view'` regardless of the mode it's leaving.

- [ ] **Step 2: Add the toolbar-nav style**

In `src/renderer/src/styles.css`, add near the existing `.toolbar-actions` rule:

```css
.toolbar-nav {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors anywhere (this closes the gap Task 5 left open).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ContentPane.tsx src/renderer/src/styles.css
git commit -m "feat: wire navigation targets and back/forward into ContentPane"
```

---

### Task 8: Renderer — `SearchPane` component

**Files:**
- Create: `src/renderer/src/components/SearchPane.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `window.viewmaster.search` (Task 2); `SearchMatch` from `@shared/types` (Task 2).
- Produces: `SearchPane` component with props `{ open: boolean; onSelectMatch: (match: SearchMatch) => void; onClose: () => void }`. Consumed by Task 9 (`App.tsx`).

No automated test — no `.tsx` test infrastructure in this codebase (consistent with every other view component). Covered by Task 10.

- [ ] **Step 1: Implement `SearchPane`**

```tsx
// src/renderer/src/components/SearchPane.tsx
import { useEffect, useRef, useState } from 'react'
import type { SearchMatch } from '@shared/types'

const DEBOUNCE_MS = 250

export default function SearchPane({
  open,
  onSelectMatch,
  onClose
}: {
  open: boolean
  onSelectMatch: (match: SearchMatch) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [truncated, setTruncated] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (query.trim() === '') {
      setMatches([])
      setTruncated(false)
      return
    }
    const timer = setTimeout(() => {
      const requestId = ++requestIdRef.current
      void window.viewmaster.search(query).then((result) => {
        if (requestIdRef.current !== requestId) return
        setMatches(result.matches)
        setTruncated(result.truncated)
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const byFile = new Map<string, SearchMatch[]>()
  for (const match of matches) {
    const existing = byFile.get(match.path)
    if (existing) existing.push(match)
    else byFile.set(match.path, [match])
  }

  return (
    <div className="search-pane">
      <div className="search-title">
        Search
        <button className="search-close" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        placeholder="Find in files…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query.trim() !== '' && matches.length === 0 && (
        <div className="search-empty">No matches.</div>
      )}
      <ul className="search-results">
        {Array.from(byFile.entries()).map(([path, fileMatches]) => (
          <li key={path} className="search-result-file">
            <div className="search-result-file-name" title={path}>
              {path}
            </div>
            <ul className="search-result-lines">
              {fileMatches.map((match) => (
                <li
                  key={`${match.line}:${match.column}`}
                  className="search-result-row"
                  onClick={() => onSelectMatch(match)}
                >
                  <span className="search-result-line-number">{match.line}</span>
                  <span className="search-result-preview">
                    {match.preview.slice(0, match.previewColumn)}
                    <mark>{match.preview.slice(match.previewColumn, match.previewColumn + query.length)}</mark>
                    {match.preview.slice(match.previewColumn + query.length)}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {truncated && (
        <div className="search-truncated">Showing partial results — refine your search.</div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add search pane styles**

In `src/renderer/src/styles.css`, add:

```css
/* ---- search pane ---- */

.search-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: auto;
  background: var(--bg);
  border-top: 1px solid #333;
}
.search-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
}
.search-close {
  background: transparent;
  border: none;
  color: #888;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 4px;
}
.search-close:hover {
  color: var(--fg);
}
.search-input {
  margin: 0 10px 6px;
  padding: 4px 8px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--fg);
  font-size: 12px;
}
.search-empty {
  padding: 8px 10px;
  color: #777;
  font-size: 12px;
}
.search-results {
  list-style: none;
  margin: 0;
  padding: 0;
}
.search-result-file {
  margin: 0;
}
.search-result-file-name {
  padding: 4px 10px;
  font-size: 11px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-result-lines {
  list-style: none;
  margin: 0;
  padding: 0;
}
.search-result-row {
  display: flex;
  gap: 8px;
  padding: 2px 10px 2px 20px;
  cursor: pointer;
  font-size: 12px;
  color: var(--fg);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-result-row:hover {
  background: var(--bg-hover);
}
.search-result-line-number {
  color: #666;
  flex: none;
}
.search-result-preview mark {
  background: var(--accent);
  color: #ffffff;
}
.search-truncated {
  padding: 8px 10px;
  color: #d7ba7d;
  font-size: 11px;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no new errors (this component isn't consumed by anything yet — that's Task 9).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/SearchPane.tsx src/renderer/src/styles.css
git commit -m "feat: add SearchPane component"
```

---

### Task 9: Renderer — wire `SearchPane` into `App.tsx`

**Files:**
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `SearchPane` (Task 8); `window.viewmaster.onMenuFindInFiles` (Task 3); `navigateTo` (already in `App.tsx` from Task 5).
- Produces: no new exported interface — this is the final integration point.

No automated test — same gap as Task 5. Covered by Task 10.

- [ ] **Step 1: Add the import**

In `src/renderer/src/App.tsx`, add to the existing import block (after the `HistoryPane` import):

```ts
import SearchPane from './components/SearchPane'
```

Add `SearchMatch` to the shared-types import — change:

```ts
import type { ChangedFile, HistoryVersion, RepoState, SidebarMode } from '@shared/types'
```

to:

```ts
import type { ChangedFile, HistoryVersion, RepoState, SearchMatch, SidebarMode } from '@shared/types'
```

- [ ] **Step 2: Add `searchOpen` state, the menu subscription, and the match handler**

Add after the `onGoBack`/`onGoForward` declarations:

```tsx
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => window.viewmaster.onMenuFindInFiles(() => setSearchOpen(true)), [])

  const onSelectMatch = useCallback(
    (match: SearchMatch): void => {
      navigateTo(match.absPath, { kind: 'line', line: match.line })
    },
    [navigateTo]
  )

  const onCloseSearch = useCallback((): void => setSearchOpen(false), [])
```

- [ ] **Step 3: Add the `SearchPane` to the left-column layout**

Change the left-column vertical `Allotment` (currently `Sidebar` pane + `HistoryPane` pane) from:

```tsx
          <Allotment vertical>
            <Allotment.Pane>
              <Sidebar
                state={repo}
                selected={selected?.path ?? null}
                onSelect={onSidebarSelect}
                onSetMode={setMode}
              />
            </Allotment.Pane>
            <Allotment.Pane preferredSize={220} minSize={80}>
              <HistoryPane
                versions={versions}
                selection={selection}
                isGitRepo={repo?.kind === 'repo'}
                onSelect={onSelectRevision}
              />
            </Allotment.Pane>
          </Allotment>
```

to:

```tsx
          <Allotment vertical>
            <Allotment.Pane>
              <Sidebar
                state={repo}
                selected={selected?.path ?? null}
                onSelect={onSidebarSelect}
                onSetMode={setMode}
              />
            </Allotment.Pane>
            <Allotment.Pane preferredSize={220} minSize={80}>
              <HistoryPane
                versions={versions}
                selection={selection}
                isGitRepo={repo?.kind === 'repo'}
                onSelect={onSelectRevision}
              />
            </Allotment.Pane>
            <Allotment.Pane visible={searchOpen} preferredSize={240} minSize={120}>
              <SearchPane open={searchOpen} onSelectMatch={onSelectMatch} onClose={onCloseSearch} />
            </Allotment.Pane>
          </Allotment>
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: wire SearchPane into the app layout via Find in Files"
```

---

### Task 10: Manual end-to-end verification

**Files:** none (fixture files live in a scratch temp directory, not the repo).

No automated coverage exists for the full search → results → navigate → back/forward pipeline end-to-end, or for the Monaco line-reveal/highlight behavior. This task is the only place that verifies it actually works in the real app. Use the **run-viewmaster** skill to drive the app.

- [ ] **Step 1: Build a fixture folder**

```bash
mkdir -p /tmp/vm-search-fixture/src
cat > /tmp/vm-search-fixture/notes.md <<'EOF'
# Notes

See [setup](src/setup.md) for details.
EOF
cat > /tmp/vm-search-fixture/src/setup.md <<'EOF'
# Setup

Back to [Notes](../notes.md).
EOF
cat > /tmp/vm-search-fixture/src/app.ts <<'EOF'
export function needleFunction(): string {
  return 'found the needle here'
}

export function anotherFunction(): void {
  console.log('nothing to see here')
}
EOF
cat > /tmp/vm-search-fixture/src/util.ts <<'EOF'
import { needleFunction } from './app'

export function callsNeedle(): string {
  return needleFunction()
}
EOF
```

- [ ] **Step 2: Launch and drive the app via the run-viewmaster skill**

Use the `run-viewmaster` skill to: build/start the app, open `/tmp/vm-search-fixture` as a folder, select `notes.md`.

Trigger Find in Files (Cmd/Ctrl+Shift+F, or via the driver's menu-trigger capability if the accelerator isn't simulable headlessly — check the skill's own docs for how it drives native menu items/accelerators). Verify:
- A Search pane appears in the left column, its input focused.
- Typing `needle` shows results grouped by file: `src/app.ts` (2 matches — the function name and the string literal `'found the needle here'`) and `src/util.ts` (2 matches — the import and the call site).

- [ ] **Step 3: Verify jump-to-line and highlight**

Click the `needleFunction` result in `src/app.ts` at its definition line. Verify:
- The content pane switches to `src/app.ts` in the plain code view.
- The clicked line is visible (scrolled into view) and visually highlighted (check via `eval`: query for an element with class `code-view-highlight-line` and confirm it exists and is positioned over the expected line).

- [ ] **Step 4: Verify back/forward**

From `src/app.ts`, select `notes.md` directly via the sidebar. Verify the toolbar's Back button is enabled; click it — verify the pane returns to `src/app.ts` at the same line. Click Forward — verify it returns to `notes.md`. Click Back twice — verify it stops at the first-ever selection (button becomes disabled, no error).

- [ ] **Step 5: Verify markdown link navigation still works through the new stack**

From `notes.md`, click the "setup" link. Verify it navigates to `src/setup.md`, rendered normally (confirms issue #5's link navigation survived the refactor). Click "Notes" to go back to `notes.md`. Click the toolbar Back button — verify it goes to `src/setup.md` again (confirms link clicks push onto the same history stack Back/Forward operate on, not a separate mechanism).

- [ ] **Step 6: Verify a truncated/no-match search and closing the pane**

Search for a query with no matches (e.g. `zzzznomatch`) — verify "No matches." appears, no crash. Click the Search pane's close (×) button — verify the pane collapses/hides.

- [ ] **Step 7: Clean up the fixture**

```bash
rm -rf /tmp/vm-search-fixture
```

- [ ] **Step 8: Final full-suite check**

Run: `npm run build`
Expected: typecheck + build both succeed.

No commit for this task (no repo files changed) — if any verification step surfaces a bug, fix it as a small follow-up commit referencing the task/step where it was found.
