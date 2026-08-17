# View Master — Search Indexing (Design Spec)

**Date:** 2026-08-16
**Status:** Approved
**Extends:** `2026-07-08-viewmaster-design.md` (MVP). Resolves issue #6.

## Purpose

Today there is no way to find text within the currently-open folder's files
— the sidebar only shows filenames (Changed or Browse mode), never content.
This blocks the issue's ask: "the ability to search the folder of files
currently open so that I can easily find text within the documents and
files under review." This spec also lays the navigation groundwork
(generalized jump-to-file-and-location, with back/forward history) that
issue #7 (find usages / go to definition) and issue #15 (Related Files
panel) will build on, per explicit direction during brainstorming: this
issue should be designed with those two in mind, not built in isolation and
reworked later.

## Load-bearing decisions (settled during brainstorming)

1. **Content search only, not filename quick-open.** Matches the issue's
   literal text (finding text *within* files). A VS-Code/JetBrains-style
   "Go to File by name" is a natural, cheap follow-up later — it would reuse
   the same file list this feature already has — but is out of scope here.
2. **No persistent content cache or inverted index.** The first design
   direction (an in-memory `Map` of every file's content, kept live via the
   file watcher) was rejected once monorepo scale entered the picture: it
   holds `O(total repo size)` in memory indefinitely and requires nontrivial
   incremental-invalidation logic. The revised, adopted approach: **every
   search is a live, bounded-concurrency, streaming scan** over the current
   file list. Memory usage is `O(concurrency × avg file size)`, independent
   of total repo size, and there is nothing to invalidate on a file
   change — every search reads current on-disk content directly, so
   edits are reflected with zero reindexing work, not eventually via a
   watcher hook.
3. **Plain case-insensitive substring matching only.** No regex, no
   whole-word toggle, no case-sensitivity toggle in this pass. Simpler
   surface area, and substring literal matching (`String` search, not
   `RegExp`) means no regex-escaping/injection concerns for user input.
4. **Binary and oversized files are excluded**, using the same
   classification approach as the rest of the app (extension/content
   sniffing), applied to the first chunk of a stream before any line
   matching happens — never load a whole file to decide it's binary.
5. **Bounded work, not unbounded scanning.** A single search caps total
   returned matches and per-file matches, and aborts early past a time
   budget, returning whatever was found so far marked as truncated rather
   than running indefinitely on a pathological folder. A new query
   cancels any still-running previous scan (typing faster than a slow scan
   completes on a huge tree must not pile up concurrent scans).
6. **Results open in the existing views, not a preview pane.** Clicking a
   match navigates to that file (reusing/extending the file-selection flow)
   and highlights the matching line in Monaco (`CodeView`). For a markdown
   file, a rendered-HTML view has no meaningful raw-text line mapping, so a
   line-targeted jump into a markdown file shows it in the `'code'` mode
   `ContentPane`'s `Mode` type already has (added for SVG's Rendered/Code
   toggle, previously unused for markdown) rather than the rendered view.
7. **Navigation is generalized with a real back/forward history**, not
   left as issue #5's one-off `onNavigateToFile`/`pendingAnchor`. This is an
   explicit refactor of already-shipped code, not just new code: `App.tsx`
   gains a `navigateTo(absPath, target?)` entry point backed by a history
   array + position index (any non-back/forward navigation truncates the
   "forward" part of the stack and pushes a new entry, matching browser
   history semantics), where `target` is `{kind:'anchor', id}` (markdown
   heading — issue #5's existing case) or `{kind:'line', line}` (search
   result — new). Back/Forward get toolbar buttons plus keyboard shortcuts
   (Cmd+[ / Cmd+] on Mac, Alt+Left/Right on Windows/Linux — the
   OS-idiomatic browser-back convention). Issue #5's `pendingAnchor` state
   and its ad hoc self-guard (matching `absPath`) are removed, superseded
   by the history stack's own bookkeeping.
8. **No main-process caching layer at all** — the only thing that stays
   "indexed" in the ordinary sense is the file *list* (paths, gitignore
   filtered), and that already exists via `listFolderTree`/`listGitTree`
   and is already kept fresh by the app's existing repo-state refresh
   plumbing. No new file-watching mechanism is added for search.

## Main process changes

New `src/main/search/scan.ts`:

- `searchFiles(root: string, paths: string[], query: string, options?: { signal?: AbortSignal }): Promise<{ matches: SearchMatch[]; truncated: boolean }>`
  where `SearchMatch = { path: string; absPath: string; line: number;
  column: number; preview: string }` (`column` is the 0-based character
  offset of the match within the line; `preview` is the matched line,
  trimmed, truncated to a fixed max length for pathologically long lines
  e.g. minified files).
- Runs over `paths` (already gitignore-filtered, passed in by the caller —
  this module has no filesystem-walking responsibility of its own) with a
  bounded concurrency pool (24 files in flight).
- Each file is read via a streaming line reader. Before any line is
  matched, the first 8KB (matching the existing `BINARY_SNIFF_BYTES`
  convention in `src/main/git/content.ts`) is checked for a NUL byte; if
  found, the read is aborted and the file is skipped as binary. A file
  already over `MAX_SIZE` (2MB, per `content.ts`) by `stat` is skipped
  without opening it.
- Matching is `line.toLowerCase().includes(query.toLowerCase())` — plain
  substring, case-insensitive.
- Caps: 50 matches per file, 500 matches total across the search; once
  either cap is hit, remaining files are not scanned and the result's
  `truncated` flag is `true`. A 10-second wall-clock budget is a second,
  independent abort condition (also sets `truncated`), guarding against a
  pathologically large folder even before the match caps would trigger.
- Accepts an `AbortSignal` so a superseded query (a newer one arrived)
  can cancel in-flight work cleanly instead of racing to completion.

`src/main/ipc.ts`: new handler,
```ts
ipcMain.handle('search:query', async (_e, query: string) => {
  if (!session || query.trim() === '') return { matches: [], truncated: false }
  // cancel any in-flight search for this session, start a new one
  return searchFiles(session.root, currentFileList(), query, { signal })
})
```
(exact file-list source — `listFolderTree`/`listGitTree`/the already-computed
`RepoState.files`' paths — resolved in the plan; conceptually it's whichever
listing the session already has, not a fresh directory walk per query).

`src/preload/index.ts`: `search: (query: string): Promise<{ matches: SearchMatch[]; truncated: boolean }> => ipcRenderer.invoke('search:query', query)`.

`src/shared/types.ts`: new `SearchMatch` interface and the query return
shape, following this file's existing convention of flat interfaces for
records and discriminated unions only where there's a real branch (there
isn't one here beyond the `truncated` flag, so no `kind` union is needed).

## Renderer changes

New `src/renderer/src/components/SearchPane.tsx`, shaped like the existing
`HistoryPane`: a debounced (~250ms) text input plus a results list grouped
by file, each entry showing line number and the highlighted-match preview.
Opened via Cmd/Ctrl+Shift+F and a menu entry (main-process `Menu`
accelerator, alongside the existing `menu:openFolder` pattern), placed as a
new pane in the left column's vertical `Allotment` (sibling to `Sidebar`
and `HistoryPane`).

`src/renderer/src/App.tsx`:

- Replaces issue #5's `onNavigateToFile`/`pendingAnchor` with a generalized
  navigation history:
  ```ts
  type NavigationTarget = { kind: 'anchor'; id: string } | { kind: 'line'; line: number }
  type NavigationEntry = { absPath: string; target?: NavigationTarget }
  ```
  a `history: NavigationEntry[]` + `historyIndex: number` pair, a
  `navigateTo(absPath, target?)` that resolves/synthesizes the
  `ChangedFile` exactly as issue #5's `onNavigateToFile` already does,
  `setSelected`s it, and pushes a new entry (truncating anything after the
  current index first) — unless called internally by `goBack`/`goForward`,
  which instead just move `historyIndex` and re-derive `selected`/`target`
  from the entry at the new position.
- `ContentPane` gains a `navigationTarget: NavigationTarget | null` prop
  (replacing `scrollToAnchor`/`onAnchorConsumed`) and an
  `onTargetConsumed: () => void` callback — the consuming side (below)
  handles both target kinds instead of only anchors.
- Sidebar-driven selection (clicking a file directly) still goes through
  `navigateTo` (with no target), so it participates in history like any
  other navigation, superseding the separate `onSidebarSelect` wrapper
  issue #5 added purely to null out a stale anchor — that whole class of
  bug goes away because there's no separate `pendingAnchor` state left to
  go stale.

`src/renderer/src/components/ContentPane.tsx`:

- `MarkdownView` and the plain-file dispatch both consume
  `navigationTarget`/`onTargetConsumed` instead of the old
  `scrollToAnchor`/`onAnchorConsumed` pair.
- A `{ kind: 'line' }` target on a markdown file forces `mode` to `'code'`
  (one-shot — same "consumed" semantics as the anchor case had) so
  `CodeView` renders the raw text where a line number is meaningful; a
  `{ kind: 'anchor' }` target behaves exactly as issue #5 built it.
- For non-markdown code files (already `CodeView` by default), a
  `{ kind: 'line' }` target scrolls Monaco to that line and highlights it
  (`revealLineInCenter` + a transient decoration), then calls
  `onTargetConsumed`.

`src/renderer/src/components/MarkdownView.tsx`: `onNavigate`'s prop
signature changes from `(absPath, anchor?: string)` to
`(absPath, target?: NavigationTarget)`. Its click handler wraps
`classification.anchor` (still a plain string, from `classifyLinkHref` —
`src/renderer/src/markdown/links.ts` itself does not change) into
`{ kind: 'anchor', id: classification.anchor }` when present, before
calling `onNavigate`. A mechanical call-site update, no behavior change
for existing markdown-link navigation.

## Module layout

```
src/main/search/scan.ts                      searchFiles (bounded streaming scan)
src/main/ipc.ts                              search:query handler (modified)
src/preload/index.ts                         search bridge method (modified)
src/shared/types.ts                          SearchMatch + query result shape (modified)
src/renderer/src/components/SearchPane.tsx   new — search input + results
src/renderer/src/App.tsx                     navigateTo + history stack (modified, replaces pendingAnchor)
src/renderer/src/components/ContentPane.tsx  navigationTarget consumption (modified)
src/renderer/src/components/MarkdownView.tsx onNavigate signature update, wraps anchor string into NavigationTarget (modified)
```

## Testing

- `scan.test.ts`: case-insensitive substring matching against a fixture
  repo (same `makeRepo`/`TestRepo` pattern as `content.test.ts`); binary
  files (NUL-byte sniff) excluded even when their raw bytes contain the
  query; oversized files excluded; per-file and total match caps trigger
  `truncated: true`; an aborted signal stops scanning promptly (verifiable
  via a controllable delay/large fixture) rather than completing anyway.
- Navigation history (`App.tsx`'s stack logic, extracted to a plain,
  testable function/module where feasible): push truncates forward
  entries; `goBack`/`goForward` move the index without duplicating entries;
  boundary conditions at both ends of the stack are no-ops, not errors;
  the "consumed" one-shot behavior for a `{kind:'line'}`/`{kind:'anchor'}`
  target doesn't re-fire on an unrelated re-render.
- No automated test for `SearchPane.tsx` or the `App.tsx`/`ContentPane.tsx`
  wiring itself (consistent with every other view component in this
  codebase — no `.tsx` test infrastructure exists). Covered by a manual
  verification task.

## Non-goals (this pass)

- Filename quick-open ("Go to File by name") — natural, cheap follow-up;
  not built here.
- Regex search, whole-word toggle, case-sensitivity toggle.
- Scoping a search to a subfolder rather than the whole open root.
- Issue #7 (find usages / go to definition) itself — this spec's live-scan
  mechanism is designed so #7 can reuse it with a whole-word match mode
  instead of substring, but the symbol/definition-detection heuristics are
  #7's own design, not built here.
- Issue #15 (Related Files panel) — depends on #7's reuse of this
  mechanism; not built here.
- Persisting search history or recent-queries UI.
