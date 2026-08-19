# View Master — Search Listing Cache (Design Spec)

**Date:** 2026-08-18
**Status:** Approved
**Extends:** `2026-08-16-search-indexing-design.md` (issue #6). Resolves issue #16.

## Purpose

Issue #6's final whole-branch review flagged that `search:query`
(`src/main/ipc.ts`) re-derives the searchable file list — via
`listGitTree` or `listFolderTree` — on every debounced query, and that
this listing happens before `searchFiles`' internal 10-second wall-clock
time budget starts counting. For a git-backed session this is cheap
(`git ls-files` against the index), but for a non-git folder session
`listFolderTree` is a genuine recursive `readdir` walk, re-run on every
keystroke-driven query with no cap of its own. This spec caches that
listing on the session and folds its cost into the existing time budget.

## Load-bearing decisions

1. **Cache the listing on the `Session` object, not a new subsystem.**
   `Session` (`src/main/ipc.ts`) gains `searchPaths: string[] | null`.
   `search:query` populates it lazily on first use and reuses it on every
   subsequent query until invalidated. No new cache module, no TTL — the
   session itself is the cache's lifetime and scope.
2. **Invalidate via the existing watcher-driven recompute, not a new
   watcher hook.** `openRepo`'s debounced (`RECOMPUTE_DEBOUNCE_MS`, 300ms)
   file-watcher callback already refreshes `session.baseline` on every
   detected change. `session.searchPaths = null` is set alongside it, in
   the same callback, under the same staleness guard (`session?.root !==
   watchRoot || session.mode !== currentMode`). This invalidates on any
   change, including pure content edits that don't actually alter the
   path list — coarser than necessary, but consistent with this
   codebase's existing "any change recomputes everything" convention, and
   it avoids teaching the watcher to distinguish add/remove from edit
   events for a narrow win.
3. **A cache miss races harmlessly under rapid queries.** Two searches
   fired close together could both observe `searchPaths === null` and
   both perform the listing concurrently before either finishes. Both
   computations produce the same result; the last write simply wins. This
   is accepted rather than guarded with a lock, matching `scan.ts`'s own
   documented stance that the search path's caps and bookkeeping are
   safety valves, not invariants anything depends on.
4. **The time budget covers the listing, not just the scan.**
   `scan.ts`'s `SearchScanOptions` gains an optional `startedAt?: number`;
   `searchFiles` uses `options.startedAt ?? Date.now()` in place of an
   unconditional fresh timestamp. `search:query` captures `Date.now()`
   immediately, before the (possibly cache-miss) listing call, and passes
   it through. A slow first-time folder walk on a large non-git tree now
   eats into the same 10-second budget instead of extending past it.
   Existing callers/tests that don't pass `startedAt` are unaffected —
   default behavior (fresh `Date.now()`) is unchanged.
5. **No change to what gets cached or how search itself works.** The
   cached value is exactly the same `string[]` `search:query` already
   passed to `searchFiles` before this change — repo-relative,
   gitignore-filtered paths. Match semantics, caps, and cancellation in
   `scan.ts` are untouched.

## Implementation sketch

`src/main/ipc.ts`:
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
New sessions initialize `searchPaths: null`. The watcher's debounced
recompute callback adds `session.searchPaths = null` alongside its
existing `session.baseline = fresh.baseline` assignment.

`search:query`:
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

`src/main/search/scan.ts`:
```ts
export interface SearchScanOptions {
  signal?: AbortSignal
  startedAt?: number
}
...
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
  const startedAt = options.startedAt ?? Date.now()
  const signal = options.signal
  ...
```

## Testing

- `scan.test.ts`: a new test passes a `startedAt` already at/past the
  10-second budget and asserts `searchFiles` returns promptly with
  `truncated: true`, without needing to actually wait out a real 10s
  budget in the test.
- No unit test framework covers `ipc.ts`'s handlers (true of every
  existing handler, not a gap introduced here) — the caching/invalidation
  behavior itself is verified via manual end-to-end testing, the same
  convention issue #6 used for its renderer wiring.

## Non-goals

- Time-bounding the listing walk itself (e.g. giving up partway through
  a `readdir` walk and returning a partial path list) — out of scope;
  this spec only makes an *already-slow* listing count against the
  existing budget, not add a new cap to the walk itself.
- Eagerly refreshing the cache in the background — invalidation is lazy
  (next search re-lists); nothing proactively re-walks on a file change
  that no search follows.
- Reusing `browseFiles`' already-computed path list in Browse mode to
  avoid a second `listGitTree` call — real but separate optimization,
  would require threading the raw path list out of `computeRepoState`'s
  return shape; not pursued here to keep this change small and uniform
  across modes.
- Any change to match semantics, caps, or cancellation behavior in
  `scan.ts` — unrelated to this issue.

## Version bump

Bundled into this same branch as a separate, final commit: `package.json`
`"version"` `0.3.0` → `0.4.0`, matching the plain-commit precedent of the
0.2.0→0.3.0 bump (one file, no lockfile touch, no tag).
