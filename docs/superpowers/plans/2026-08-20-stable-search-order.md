# Stable Search Match Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `searchFiles`'s returned matches deterministically ordered
and deterministically truncated, so the same query against an unchanged
file set always produces the same result — both which matches are kept
under the 500-match cap, and what order they come back in.

**Architecture:** Remove the timing-dependent total-match early-exit
inside the concurrent scan (every dispatched file now scans to
completion, still bounded by its own per-file cap and the existing
wall-clock time budget), then sort the full result by `(path, line,
column)` and slice to the cap afterward. One file changes
(`src/main/search/scan.ts`); every caller (`search:query`,
`symbol:definitions`, `symbol:references`, `related:importedBy`)
benefits automatically with no changes of its own.

**Tech Stack:** TypeScript, Node.js `fs`/`readline` streaming, Vitest.

## Global Constraints

- Sort key: `path` via `localeCompare` (matching `src/main/git/changes.ts:59`'s
  existing convention), then `line` numeric, then `column` numeric.
- `MAX_MATCHES_PER_FILE` (50), `MAX_MATCHES_TOTAL` (500), `TIME_BUDGET_MS`
  (10000), and `CONCURRENCY` (24) values are unchanged — this plan changes
  *when* the total cap is enforced and *what order* results come back in,
  not any of these numbers.
- Accepted trade-off (confirmed with Bruce during brainstorming): removing
  the total-match early-exit means a pathological search that matches
  across a huge fraction of a large repo does more total scanning work
  than before, bounded by the unchanged `TIME_BUDGET_MS` — the same bound
  that already applies to any search that never reaches the total cap.

---

### Task 1: Deterministic ordering and truncation in `searchFiles`

**Files:**
- Modify: `src/main/search/scan.ts:174-230` (the `searchFiles` doc
  comment and function body)
- Test: `src/main/search/scan.test.ts`

**Interfaces:**
- Consumes: nothing new — `searchFiles`'s existing signature
  (`root: string, paths: string[], query: string, options:
  SearchScanOptions = {}`) and existing return type
  (`Promise<SearchScanResult>`, i.e. `{ matches: SearchMatch[]; truncated:
  boolean }`) are unchanged. No caller (`src/main/ipc.ts`'s `search:query`,
  `symbol:definitions`, `symbol:references`, `related:importedBy`
  handlers) needs any change.
- Produces: the same `SearchScanResult` shape, but `matches` is now always
  sorted by `(path, line, column)` and, when truncation occurs, always
  contains the alphabetically-first `MAX_MATCHES_TOTAL` paths' matches
  rather than a scan-completion-timing-dependent subset.

- [ ] **Step 1: Write the failing tests**

Three changes to `src/main/search/scan.test.ts`:

**1a. Update the existing "caps total matches" test** — its current
assertion and comment describe the old timing-dependent behavior and must
change to describe the new exact-cap behavior. Replace this test:

```ts
  it('caps total matches across files and marks the result truncated', async () => {
    // 600 one-match files, well beyond the CONCURRENCY (24) worker pool, so
    // the queue isn't fully drained (all files dispatched) before the
    // running total crosses MAX_MATCHES_TOTAL (500) — with too few files
    // relative to concurrency, every file gets dispatched while there's
    // still plenty of budget left, and the total cap never has a chance to
    // engage. One match per file also keeps this test decoupled from the
    // per-file cap (covered separately below).
    const paths: string[] = []
    for (let i = 0; i < 600; i++) {
      const path = `file${i}.txt`
      await repo.write(path, `needle ${i}\n`)
      paths.push(path)
    }
    const { matches, truncated } = await searchFiles(repo.root, paths, 'needle')
    expect(truncated).toBe(true)
    // Caps are soft under concurrency (scan.ts's own doc comment) — assert
    // the cap was actually reached, not an exact count.
    expect(matches.length).toBeGreaterThanOrEqual(500)
  })
```

with:

```ts
  it('caps total matches across files and marks the result truncated', async () => {
    // 600 one-match files. One match per file keeps this test decoupled
    // from the per-file cap (covered separately above).
    const paths: string[] = []
    for (let i = 0; i < 600; i++) {
      const path = `file${i}.txt`
      await repo.write(path, `needle ${i}\n`)
      paths.push(path)
    }
    const { matches, truncated } = await searchFiles(repo.root, paths, 'needle')
    expect(truncated).toBe(true)
    // The cap is exact now (every file scans to completion, then the
    // sorted result is sliced to MAX_MATCHES_TOTAL) — no longer a soft,
    // scan-completion-timing-dependent overshoot.
    expect(matches).toHaveLength(500)
  })
```

**1b. Add a new test for sort order**, right after the test above:

```ts
  it('returns matches sorted by path then line, regardless of scan dispatch order', async () => {
    await repo.write('z.txt', 'needle\n')
    await repo.write('a.txt', 'x\nneedle\nneedle\n')
    await repo.write('m.txt', 'needle\n')
    // Dispatch order deliberately not alphabetical.
    const { matches } = await searchFiles(repo.root, ['z.txt', 'a.txt', 'm.txt'], 'needle')
    expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      'a.txt:2',
      'a.txt:3',
      'm.txt:1',
      'z.txt:1'
    ])
  })
```

**1c. Add the regression test for deterministic truncation** — the direct
test for this fix's actual bug (which matches survive the cap must not
depend on scan-completion timing):

```ts
  it('truncates to the alphabetically-first paths deterministically, not by scan-completion timing', async () => {
    const paths: string[] = []
    for (let i = 0; i < 600; i++) {
      const path = `file${String(i).padStart(3, '0')}.txt`
      await repo.write(path, 'needle\n')
      paths.push(path)
    }
    // Shuffle dispatch order so completion timing can't correlate with
    // path order — under the old behavior this could let a late-in-array,
    // fast-completing file "steal" cap headroom from an earlier one.
    const shuffled = [...paths].sort(() => Math.random() - 0.5)
    const { matches, truncated } = await searchFiles(repo.root, shuffled, 'needle')
    expect(truncated).toBe(true)
    expect(matches).toHaveLength(500)
    const expectedPaths = [...paths].sort((a, b) => a.localeCompare(b)).slice(0, 500)
    expect(matches.map((m) => m.path)).toEqual(expectedPaths)
  })
```

- [ ] **Step 2: Run the tests to verify the new/changed ones fail**

Run: `npx vitest run src/main/search/scan.test.ts`

Expected: the updated "caps total matches" test FAILs (old code doesn't
guarantee exactly 500), and both new tests FAIL (old code doesn't sort or
deterministically truncate). The other existing tests in this file still
PASS (they don't exercise the changed behavior).

- [ ] **Step 3: Implement the fix**

In `src/main/search/scan.ts`, replace the `searchFiles` doc comment
(currently lines 174-186) — it currently says caps are "soft" and "may
overshoot slightly," which becomes wrong:

```ts
/**
 * Live, bounded-concurrency substring search over `paths` (already
 * gitignore-filtered, relative to `root`) — no persistent index or cache;
 * every call reads current on-disk content. Case-insensitive plain
 * substring matching, capped at MAX_MATCHES_PER_FILE per file. Every
 * dispatched file scans to completion (bounded by its own per-file cap
 * and the TIME_BUDGET_MS wall-clock budget below) — the result is then
 * sorted by (path, line, column) and sliced to MAX_MATCHES_TOTAL if
 * longer, so both the match order and which matches survive truncation
 * are deterministic for a given file set and query, independent of
 * worker-completion timing. `options.signal`, if already aborted or
 * aborted mid-scan, stops dispatching new file scans promptly (a file
 * scan already in flight when the abort happens is not cancelled
 * mid-file).
 */
```

Then replace the function body:

```ts
export async function searchFiles(
  root: string,
  paths: string[],
  query: string,
  options: SearchScanOptions = {}
): Promise<SearchScanResult> {
  if (query.trim() === '') return { matches: [], truncated: false }
  const caseSensitive = options.caseSensitive ?? false
  const needle = caseSensitive ? query : query.toLowerCase()
  const mode = options.mode ?? 'substring'
  const lineFilter = options.lineFilter
  const matches: SearchMatch[] = []
  let truncated = false
  const startedAt = options.startedAt ?? Date.now()
  const signal = options.signal

  await runWithConcurrency(paths, CONCURRENCY, async (relPath) => {
    if (signal?.aborted) return
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      truncated = true
      return
    }
    const absPath = join(root, relPath)
    const { matches: fileMatches, capped } = await scanOneFile(
      absPath,
      relPath,
      needle,
      MAX_MATCHES_PER_FILE,
      mode,
      caseSensitive,
      lineFilter,
      options.words
    )
    matches.push(...fileMatches)
    if (capped) truncated = true
  })

  matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column)
  if (matches.length > MAX_MATCHES_TOTAL) {
    matches.length = MAX_MATCHES_TOTAL
    truncated = true
  }

  return { matches, truncated }
}
```

Note what changed from the current code: the `if (matches.length >=
MAX_MATCHES_TOTAL) { truncated = true; return }` check inside the worker
callback is gone; `perFileCap` (previously `Math.min(MAX_MATCHES_PER_FILE,
MAX_MATCHES_TOTAL - matches.length)`) is now just the constant
`MAX_MATCHES_PER_FILE`; and the sort + slice happen once, after
`runWithConcurrency` resolves.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/search/scan.test.ts`

Expected: all tests in this file PASS, including the two new ones and the
updated "caps total matches" test.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test` and `npm run typecheck`

Expected: both clean — this change touches only `scan.ts`'s internals
(same exported signature/return shape), so no other file's tests should
be affected.

- [ ] **Step 6: Commit**

```bash
git add src/main/search/scan.ts src/main/search/scan.test.ts
git commit -m "fix: make search match order and truncation deterministic"
```

---

## Testing

Covered entirely by Task 1's own test changes — this is a single-file,
single-task fix. No manual verification step is needed: `searchFiles`'s
behavior is fully exercised by its existing unit test suite, and no
renderer-visible behavior changes beyond "search results now render in a
stable order," which the existing `scan.test.ts` suite already proves at
the source.

## Non-goals

Restated from the design spec: no change to `SearchPane.tsx`, no change
to `MAX_MATCHES_PER_FILE`/`TIME_BUDGET_MS`/`CONCURRENCY` values, no change
to per-file cap (`capped`) semantics, no attempt to make scanning itself
faster.
