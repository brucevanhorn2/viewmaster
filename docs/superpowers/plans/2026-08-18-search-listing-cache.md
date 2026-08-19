# Search Listing Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-deriving the searchable file list on every "Find in Files" query, and make a slow listing count against the existing search time budget instead of extending past it.

**Architecture:** Cache the file listing on the existing `Session` object in `src/main/ipc.ts`, invalidated by the watcher-driven recompute that already refreshes `session.baseline`. Thread an optional `startedAt` through `searchFiles` (`src/main/search/scan.ts`) so the caller can start the clock before the (possibly cache-miss) listing runs, not after.

**Tech Stack:** TypeScript, Electron main process, Vitest.

## Global Constraints

- `Session` (`src/main/ipc.ts`) gains one new field: `searchPaths: string[] | null`.
- Invalidation happens inside the existing watcher recompute `setTimeout` callback in `openRepo`, under the same staleness guard already used for `session.baseline` (`session?.root !== watchRoot || session.mode !== currentMode`) — not a new watcher hook.
- `SearchScanOptions` (`src/main/search/scan.ts`) gains one new optional field: `startedAt?: number`. Default behavior when omitted is unchanged (`Date.now()` sampled fresh inside `searchFiles`).
- No change to match semantics, per-file/total caps, cancellation, or any other behavior in `scan.ts`.
- No change to `mode:set` or `repo:refresh` handlers — the cached listing is independent of Changed/Browse mode, so neither needs to invalidate it.
- Version bump (`package.json` `"version"`: `0.3.0` → `0.4.0`) is its own final task, one file, no lockfile touch, no tag — matching the existing 0.2.0→0.3.0 precedent.

---

### Task 1: `scan.ts` — accept an external start time for the budget check

**Files:**
- Modify: `src/main/search/scan.ts`
- Test: `src/main/search/scan.test.ts`

**Interfaces:**
- Consumes: nothing new from elsewhere.
- Produces: `SearchScanOptions.startedAt?: number` — Task 2 passes this from `ipc.ts` so the 10-second budget starts before the file listing, not after `searchFiles` is called.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('searchFiles', ...)` block in `src/main/search/scan.test.ts`, after the last test:

```ts
  it('honors a startedAt that is already past the time budget', async () => {
    await repo.write('a.txt', 'needle\n')
    const { matches, truncated } = await searchFiles(repo.root, ['a.txt'], 'needle', {
      startedAt: Date.now() - 11_000
    })
    expect(matches).toEqual([])
    expect(truncated).toBe(true)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/search/scan.test.ts -t "honors a startedAt"`
Expected: FAIL. Vitest transpiles rather than type-checks, so the extra
`startedAt` property is silently ignored at runtime rather than rejected
at compile time — `searchFiles` still samples `Date.now()` fresh
internally, finds the one `needle` match in `a.txt`, and returns
`truncated: false`, failing both assertions. Confirm the failure is this
assertion mismatch (not, say, a thrown error or a missing-file error)
before moving on.

- [ ] **Step 3: Implement the minimal change**

In `src/main/search/scan.ts`, change the `SearchScanOptions` interface (currently just `{ signal?: AbortSignal }`) to:

```ts
export interface SearchScanOptions {
  signal?: AbortSignal
  startedAt?: number
}
```

Then, inside `searchFiles`, change:

```ts
  const startedAt = Date.now()
```

to:

```ts
  const startedAt = options.startedAt ?? Date.now()
```

No other line in `searchFiles` changes — `startedAt` is already used exactly the same way afterward (`Date.now() - startedAt > TIME_BUDGET_MS`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/search/scan.test.ts`
Expected: all tests in the file PASS, including the new one.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/search/scan.ts src/main/search/scan.test.ts
git commit -m "feat: accept an external startedAt in searchFiles' time budget"
```

---

### Task 2: `ipc.ts` — cache the file listing on the session, invalidate on file changes

**Files:**
- Modify: `src/main/ipc.ts`

**Interfaces:**
- Consumes: `SearchScanOptions.startedAt` (Task 1).
- Produces: no new exported interface — this is the feature's main-process integration point. `Session.searchPaths: string[] | null` is internal to this file.

No automated test — no unit test framework covers any `ipc.ts` handler in this codebase (true of every existing handler, not a gap introduced here). Covered by Task 4's manual verification.

- [ ] **Step 1: Add the `searchPaths` field to `Session`**

In `src/main/ipc.ts`, change the `Session` interface (currently ending with `recorder: Recorder | null`) to:

```ts
interface Session {
  root: string
  baseline: BaselineKind | null
  mode: SidebarMode
  watcher: FSWatcher
  recorder: Recorder | null
  searchPaths: string[] | null
}
```

- [ ] **Step 2: Initialize the field on a new session**

In `openRepo`, find the `session = { ... }` assignment (currently ending with `watcher, recorder`) and add `searchPaths: null`:

```ts
    session = {
      root: state.root,
      baseline: state.kind === 'repo' ? state.baseline : null,
      mode: state.kind === 'repo' ? state.mode : 'browse',
      watcher,
      recorder,
      searchPaths: null
    }
```

- [ ] **Step 3: Invalidate on the existing watcher-driven recompute**

Still in `openRepo`, inside the `watchRepo` callback's `recomputeTimer = setTimeout(async () => { ... }, RECOMPUTE_DEBOUNCE_MS)` body, find:

```ts
        if (session?.root !== watchRoot || session.mode !== currentMode) return // repo switched or mode toggled — drop stale update
        if (fresh.kind === 'repo') session.baseline = fresh.baseline
```

and add the invalidation right after the existing `session.baseline` line:

```ts
        if (session?.root !== watchRoot || session.mode !== currentMode) return // repo switched or mode toggled — drop stale update
        if (fresh.kind === 'repo') session.baseline = fresh.baseline
        session.searchPaths = null
```

(This fires on every detected file change, not just adds/removes — coarser than strictly necessary, but consistent with this callback already recomputing the full repo state on any change. See the spec's load-bearing decision #2 for the rationale; don't narrow this to specific event types.)

- [ ] **Step 4: Use and populate the cache in `search:query`, and cover the listing under the time budget**

Find the `search:query` handler (currently):

```ts
  ipcMain.handle('search:query', async (_e, query: string): Promise<SearchResult> => {
    currentSearchController?.abort()
    const activeSession = session
    if (!activeSession) return { matches: [], truncated: false }
    const controller = new AbortController()
    currentSearchController = controller
    try {
      const paths = activeSession.baseline
        ? await listGitTree(activeSession.root)
        : await listFolderTree(activeSession.root)
      return await searchFiles(activeSession.root, paths, query, { signal: controller.signal })
    } catch (err) {
      return { matches: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
```

Replace it with:

```ts
  ipcMain.handle('search:query', async (_e, query: string): Promise<SearchResult> => {
    currentSearchController?.abort()
    const activeSession = session
    if (!activeSession) return { matches: [], truncated: false }
    const controller = new AbortController()
    currentSearchController = controller
    const startedAt = Date.now()
    try {
      if (activeSession.searchPaths === null) {
        activeSession.searchPaths = activeSession.baseline
          ? await listGitTree(activeSession.root)
          : await listFolderTree(activeSession.root)
      }
      return await searchFiles(activeSession.root, activeSession.searchPaths, query, {
        signal: controller.signal,
        startedAt
      })
    } catch (err) {
      return { matches: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
```

Note `startedAt` is captured *before* the `if (activeSession.searchPaths === null)` block, so a cold-cache listing's time counts against the same 10-second budget `searchFiles` already enforces.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (168 existing + Task 1's new test).

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc.ts
git commit -m "feat: cache the search file listing on the session, invalidated on file changes"
```

---

### Task 3: Manual verification

**Files:** none (fixture files live in a scratch temp directory, not the repo).

No automated coverage exists for the caching/invalidation behavior itself (per Task 2's note) — this task is the only place that verifies it actually works end-to-end. Use the **run-viewmaster** skill to drive the app.

- [ ] **Step 1: Build a fixture folder**

```bash
mkdir -p /tmp/vm-cache-fixture
for i in $(seq 1 5); do echo "needle in file $i" > "/tmp/vm-cache-fixture/file$i.txt"; done
git -C /tmp/vm-cache-fixture init -q
git -C /tmp/vm-cache-fixture add -A
git -C /tmp/vm-cache-fixture commit -q -m "init"
```

- [ ] **Step 2: Launch and drive the app via the run-viewmaster skill**

Open `/tmp/vm-cache-fixture` as a folder. Trigger Find in Files, search `needle`. Verify 5 matches (one per file), same as before this change — the caching is invisible from the UI when it's working correctly.

- [ ] **Step 3: Verify the cache is actually being used, not just correct by coincidence**

Add a 6th file to the fixture folder from outside the app (`echo "needle in file 6" > /tmp/vm-cache-fixture/file6.txt`) while the app is still open. Without touching the search box again, wait a moment for the watcher's debounce (300ms) to fire, then re-run the same `needle` search (clear the box and retype it, or close/reopen Find in Files). Verify the new file's match now appears — this confirms the watcher-driven invalidation (Task 2, Step 3) actually clears the cache on a file-system change rather than serving a stale list forever.

- [ ] **Step 4: Verify a repeat search without any file change reuses the cache**

Search `needle` again immediately (no file changes in between). Results should appear at least as fast as the first search — there's no user-visible way to directly measure the skipped listing call, so this step is a sanity check (same 6 matches, no errors, no delay), not a strict timing assertion.

- [ ] **Step 5: Clean up the fixture**

```bash
rm -rf /tmp/vm-cache-fixture
```

- [ ] **Step 6: Final full-suite check**

Run: `npm run build`
Expected: typecheck + build both succeed.

No commit for this task (no repo files changed) — if any verification step surfaces a bug, fix it as a small follow-up commit referencing the task/step where it was found.

---

### Task 4: Version bump

**Files:**
- Modify: `package.json`

**Interfaces:** none.

- [ ] **Step 1: Bump the version**

In `package.json`, change:

```json
  "version": "0.3.0",
```

to:

```json
  "version": "0.4.0",
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.4.0"
```
