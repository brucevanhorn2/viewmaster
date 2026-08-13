# viewmaster — Local Edit History (Design Spec)

**Date:** 2026-07-24
**Status:** Approved
**Extends:** `2026-07-08-viewmaster-design.md` (MVP). Adds a local, per-file
version timeline that lives *between* git commits.

## Purpose

Today viewmaster diffs a file only against its **git baseline** (merge-base with
the default branch, or `HEAD` for working-only mode). During a day of AI-assisted
editing the file passes through many intermediate states that are never
committed, so those states are invisible — you can only see "current vs the last
committed point."

Local Edit History captures those intermediate states automatically and lets you
diff between any two of them, without committing. It fills the gap between
commits; once you commit, git owns that history and the local copy is pruned.

## Load-bearing decisions (settled during brainstorming)

1. **Interaction model:** a JetBrains-style **Local History pane** docked under
   the file browser (not a horizontal timeline baked into the content pane).
2. **Capture trigger:** **settle-based** — after a burst of edits, capture one
   version once the file goes quiet. A rapid AI rewrite becomes one revision,
   not fifty keystroke snapshots.
3. **Scope:** **all changed text files** (whatever appears in the sidebar as
   changed vs baseline). Binary / too-large files are skipped. Git repos only.
4. **Retention:** **commit-anchored** — keep the full timeline since the last
   commit; on commit, prune versions git now owns. Hard backstops (per-file
   count + max age) prevent unbounded growth in an uncommitted repo.
5. **Engine:** **content-addressed object store + per-file append log**. No new
   native dependency (electron-store stays the only runtime dep).

## Data model & storage

Everything lives under `app.getPath('userData')/history/`, namespaced per repo:

```
history/
  <repoId>/                     repoId = sha256(repoRoot)[:16]
    objects/<sha256>            gzipped file content, content-addressed (dedup)
    logs/<pathHash>.jsonl       append-only, one line per captured version
    paths.json                  { pathHash: relPath }   (for listing tracked files)
    state.json                  { lastPrunedCommit: string | null }
```

- `pathHash = sha256(relPath)`. `relPath` uses forward slashes, repo-relative
  (matches `ChangedFile.path`).
- A log line: `{"ts": <epochMillis>, "sha": "<hex>", "size": <bytes>}`, appended
  in capture order (ascending `ts`).
- Objects are content-addressed and shared across versions and files, so
  identical states never double-store. Text documents are small; a day of edits
  is kilobytes.
- **Git repos only.** The feature anchors on baselines and commits; for
  `'folder'` folders it is simply inactive.

## Capture pipeline (settle-based)

The watcher is refactored to emit **granular events** instead of a single
blanket debounced callback:

```
watchRepo(root, onEvent: (relPath: string | null) => void): FSWatcher
```

It still uses the single native recursive `fs.watch` handle (no EMFILE
regression) and still applies `shouldIgnore` + drops the macOS root-basename
noise event; it just forwards the changed `relPath` per event rather than
debouncing internally. Two consumers subscribe in `ipc.ts`:

1. **Repo recompute** (existing behavior): wraps `onEvent` in a 300 ms debounce
   and re-runs `computeRepoState` → `repo:changed`. Externally unchanged.
2. **HistoryRecorder**: keeps a **per-file settle timer** (`SETTLE_MS = 2500`).
   Each event for a path clears and restarts that file's timer. When a file goes
   quiet, it captures once:
   - Read the file. Skip if deleted, binary, or too-large (reuse the detection
     in `git/content.ts` — only `kind: 'text'` is captured).
   - `sha = sha256(content)`. If a log entry with that `sha` is already the
     newest for this file, skip (dedup — no-op edits don't record).
   - If the object is new, gzip and write `objects/<sha>`; then append the log
     line. (Object-before-log ordering: a crash in between leaves an orphan
     object, GC'd later — never a dangling log reference.)
   - A `MAX_SETTLE_MS = 30000` cap forces a capture if a file is edited
     continuously so a long AI stream still lands points.
   - Per-file append queue (a promise chain) serializes writes to one log.

The leftmost point of every file's history is the **git baseline** (fetched via
the existing `readBaseFile`), not a stored object. Captured objects are the
states *after* the baseline.

## Retention

**Commit-anchored pruning (primary).** The watcher already sees `.git/HEAD`
change on commit (`shouldIgnore` deliberately keeps `HEAD`/`index`/`refs`). When
a new commit is detected, the recorder:

1. Reads the new HEAD commit time: `git show -s --format=%ct HEAD`.
2. For every log, drops entries with `ts <= commitTimeMillis` (git now owns
   them).
3. Records the commit sha in `state.json` as `lastPrunedCommit`.
4. Runs GC: computes the set of `sha`s still referenced across all logs in the
   repo and deletes any `objects/<sha>` not in that set.

**Backstops (secondary, commit-independent).** Applied on append and on repo
open so an uncommitted repo can't grow forever. All three limits are constants
in one module:

- `MAX_VERSIONS_PER_FILE = 200` — drop oldest entries beyond the cap.
- `MAX_AGE_DAYS = 30` — drop entries older than this.
- GC after any prune removes now-unreferenced objects.

## IPC

Two new handlers in `ipc.ts` (available only when the session is a git repo):

- `history:list(relPath: string) → HistoryVersion[]` — ascending
  `{ ts, sha, size }` for the file, read from its log.
- `history:read(sha: string) → string` — ungzip and return an object's content.

New shared type:

```ts
export interface HistoryVersion { ts: number; sha: string; size: number }
```

## History pane & diff interaction

The left column becomes a **nested vertical Allotment split**: file tree on top,
**History pane** below. The outer horizontal split (`[leftColumn | ContentPane]`)
is unchanged. The History pane shows revisions for the currently-selected file,
newest-first:

```
HISTORY — README.md
  ● Now             (live on disk)
  ● 2:55 PM
  ● 1:20 PM
  ● 11:40 AM
  ● Baseline (git)  (pinned floor)
```

Selection model (JetBrains Local History):

- **Single-click a revision** → content pane switches to diff mode showing *what
  that revision changed*: base = the immediately-older revision, compare = the
  clicked revision. (For the oldest captured revision, base = Baseline.)
- **⌘/Shift-click a second revision** → diff between the two selected; older is
  base, newer is compare.
- **Now** and **Baseline (git)** are selectable rows. Baseline ↔ Now reproduces
  exactly today's whole-file diff, and is the **default** selection when a file
  is opened — so nothing about the current flow changes until a revision is
  clicked.
- The diff header shows what is being compared, e.g. `1:20 PM ↔ 2:55 PM`.
- Empty / non-git / binary → the pane shows a quiet placeholder:
  `No local history yet — edits appear here as you work`.

`DiffView` already renders base-vs-current; the pane only changes *what content
feeds each side*: `history:read(sha)` for a captured version, `readBaseFile` for
Baseline, `readFile` for Now. The Marks (rendered editor's-marks) mode reuses the
same selected base/compare pair.

State lives in `App`: alongside `selected` (file), add `selectedRevisions`
(`base` and `compare`, each a `sha` or the sentinel `'baseline'` / `'now'`),
passed to `ContentPane`.

## Error handling & edge cases

- **Deleted / binary / too-large at settle:** skip — never recorded.
- **Rename:** the old path's history stays under its old `pathHash`, aged out by
  backstops. (No rename tracking in v1.)
- **Crash safety:** append-only logs + write-object-before-append make partial
  writes recoverable — a truncated trailing JSONL line is dropped by the reader;
  an orphan object is GC'd.
- **Non-git folder:** feature inactive; pane shows placeholder.
- **Concurrency:** per-file append queue prevents interleaved log writes;
  Node's single thread plus the queue is sufficient.
- **No new native dependency:** gzip via `node:zlib`, hashing via `node:crypto`.

## Module layout

```
src/main/history/
  paths.ts      repoId, pathHash, dir layout, paths.json read/write
  store.ts      object put/get/gc; log append/read/prune  (pure where possible)
  recorder.ts   per-file settle timers + capture + commit-triggered prune
src/main/ipc.ts            + history:list / history:read; wire recorder to watcher
src/main/watcher.ts        refactor onChange → granular onEvent(relPath)
src/renderer/src/components/HistoryPane.tsx   the docked revision list
src/renderer/src/components/ContentPane.tsx   accept selected base/compare
src/renderer/src/App.tsx                      nested split + selectedRevisions state
src/shared/types.ts                            + HistoryVersion
```

## Testing

Mirroring the existing `shouldIgnore` style — **pure functions unit-tested
directly**, fs/timer effects kept thin:

- `pruneLog(entries, commitTimeMillis) → entries` — commit-anchored prune.
- `applyBackstops(entries, now) → entries` — count + age limits.
- `referencedShas(logs) → Set<string>` — GC reference set.
- Settle scheduling with vitest fake timers: burst of events → one capture;
  continuous edits → capture forced at `MAX_SETTLE_MS`.
- gzip object round-trip and content-address dedup.
- Watcher: granular `onEvent` fires per change, still ignores `node_modules`,
  still drops the root-basename noise event (update existing `watcher.test.ts`).
- Integration (temp dir, reuse `git/testRepo.ts`): edit → settle → version
  appears in `history:list`; commit → entries at/older-than the commit are
  pruned and orphan objects GC'd.

## Non-goals (v1)

- Rename/move tracking across history.
- Viewing (rendering) a past revision on its own outside diff mode.
- Restoring/reverting a file to a past revision (viewmaster is read-only).
- History for non-git folders.
- Cross-file or repo-wide "what changed everywhere at 2 PM" views.
