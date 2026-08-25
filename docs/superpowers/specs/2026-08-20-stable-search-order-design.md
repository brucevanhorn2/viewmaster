# View Master — Stable Search Match Ordering (Design Spec)

**Date:** 2026-08-20
**Status:** Approved
**Resolves:** issue #21.

## Purpose

The issue's ask: `searchFiles`'s matches come back in whatever order the
bounded-concurrency worker pool (`CONCURRENCY = 24`) happens to finish
scanning each file, since `fs.stat`/`open`/`read` latencies vary per call.
`SearchPane.tsx` groups matches by file via plain iteration into a `Map`,
so the same query against an unchanged file set can render its file
groupings in a different order from one search to the next — not a
correctness bug (every match is still found and correctly attributed),
but a user-visible inconsistency for a results list that reads as
"grouped by file."

While confirming the fix's scope, a second, related instability surfaced:
when the 500-match total cap (`MAX_MATCHES_TOTAL`) truncates a result set,
*which* matches survive is also timing-dependent — a file dispatched
later in `paths` order can finish scanning before an earlier file still
in flight, "stealing" cap headroom from it. Bruce asked that this be
fixed too, not just display order, so this spec covers both.

## Load-bearing decisions

1. **Fix both instabilities in one place: `searchFiles` itself
   (`src/main/search/scan.ts`), not in any caller.** Every consumer
   (`search:query`, `symbol:definitions`, `symbol:references`,
   `related:importedBy`) benefits automatically with no caller changes —
   matching the issue's own suggested direction, and consistent with this
   codebase's existing convention of sorting once at the source
   (`changes.ts:59`'s `files.sort((a, b) => a.path.localeCompare(b.path))`)
   rather than asking every caller to know an ordering quirk exists.

2. **Sort key: `(path, line, column)`**, `path` via `localeCompare` to
   match the existing `changes.ts` convention, `line`/`column` numeric.
   Matches within a single file are already produced in increasing
   line/column order (each file is scanned sequentially via `readline`),
   so this sort's real effect is establishing a deterministic *file*
   order — but including `line`/`column` in the sort key makes the whole
   array's order independently verifiable and future-proof (not reliant
   on "matches happen to already be ordered within a file" staying true).

3. **Truncation-set determinism requires removing the total-match
   early-exit, not just adding a final sort.** The current code checks
   `matches.length >= MAX_MATCHES_TOTAL` before dispatching each file's
   scan and skips the file (marking `truncated`) once the running total
   is reached — this is exactly the timing-dependent step, since the
   running total depends on completion order, not dispatch order. The
   fix: remove that check. Every dispatched file now scans to completion,
   still bounded by its own per-file cap (`MAX_MATCHES_PER_FILE`,
   unchanged) and by the existing `TIME_BUDGET_MS` wall-clock check
   (unchanged, still the sole remaining early-exit besides
   `signal.abort()`). After the concurrent scan finishes, sort the full
   result (decision 2), then slice to `MAX_MATCHES_TOTAL` if it's longer,
   setting `truncated = true` for that reason (in addition to the
   existing reasons: a per-file cap hit, or the time budget firing).

   **Accepted trade-off:** for a search term matching in an extremely
   large fraction of a huge repo, this does more total scanning work than
   today's early-bail — every file scans to its own per-file cap rather
   than the pool stopping once 500 matches exist overall. This is bounded
   by the same `TIME_BUDGET_MS` (10s) that already exists as a hard stop
   for pathological cases, and matches what already happens today for any
   search that never reaches the total cap. Confirmed acceptable by Bruce
   (2026-08-20) as the cost of deterministic truncation.

4. **`perFileCap` simplifies to the fixed `MAX_MATCHES_PER_FILE`.** It
   currently shrinks against remaining total budget
   (`Math.min(MAX_MATCHES_PER_FILE, MAX_MATCHES_TOTAL - matches.length)`)
   to avoid one file's matches overshooting a total that's about to be
   truncated anyway — with decision 3 removing the total early-exit, there
   is no longer a running total to protect mid-scan, so this simplifies to
   a constant.

5. **No change to `SearchPane.tsx` or any IPC handler.** Once
   `searchFiles` returns already-sorted matches, `SearchPane.tsx`'s
   existing plain iteration into a `Map` naturally produces file groups in
   the sorted order — first-seen-path order, unchanged code.

## Main process changes

`src/main/search/scan.ts`, in `searchFiles`:
- Remove the `if (matches.length >= MAX_MATCHES_TOTAL) { truncated = true; return }`
  check inside the `runWithConcurrency` worker callback.
- Change `perFileCap` from `Math.min(MAX_MATCHES_PER_FILE, MAX_MATCHES_TOTAL - matches.length)`
  to the constant `MAX_MATCHES_PER_FILE`.
- After `await runWithConcurrency(...)` completes, before returning:
  ```ts
  matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column)
  if (matches.length > MAX_MATCHES_TOTAL) {
    matches.length = MAX_MATCHES_TOTAL
    truncated = true
  }
  ```

No changes to `scanOneFile`, `runWithConcurrency`, `SearchScanOptions`, or
any IPC handler.

## Module layout

```
src/main/search/scan.ts        sort + deterministic truncation (modified)
src/main/search/scan.test.ts   updated + new tests (modified)
```

## Testing

- Existing test **"caps total matches across files and marks the result
  truncated"** currently asserts `matches.length` is
  `toBeGreaterThanOrEqual(500)` with a comment explaining caps are "soft
  under concurrency." Both become wrong under the new deterministic
  behavior — update the assertion to `toBe(500)` exactly, and correct the
  comment to explain the cap is now exact.
- New test: matches for a query spanning multiple files come back sorted
  by `(path, line, column)` regardless of the files' write/dispatch order.
- New test (the direct regression test for decision 3): given more files
  than the total cap allows, each contributing one match, the truncated
  result deterministically keeps the alphabetically-first paths — run
  the same scan multiple times (or construct the scenario so an
  early-completing, late-in-order file would have "won" under the old
  behavior) and assert the kept set is always the same, sorted-first
  subset.
- No renderer-level test needed — `SearchPane.tsx` is unchanged, and this
  codebase has no `.tsx` test infrastructure (consistent with every other
  component).

## Non-goals

- Any change to `SearchPane.tsx`, `MAX_MATCHES_PER_FILE`'s value, or
  `TIME_BUDGET_MS`'s value.
- Any change to per-file cap behavior (`capped` semantics on
  `scanOneFile`'s return) — still triggers `truncated` exactly as today.
- Making the scan itself faster or changing `CONCURRENCY` — this spec
  only changes which matches are kept and their final order, not the
  scanning mechanism.
