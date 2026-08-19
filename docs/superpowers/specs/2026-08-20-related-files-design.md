# View Master — Related Files Panel (Design Spec)

**Date:** 2026-08-20
**Status:** Approved
**Extends:** `2026-08-16-search-indexing-design.md` (issue #6),
`2026-08-19-find-usages-design.md` (issue #7). Resolves issue #15.

## Purpose

The issue's ask: show files related to the one currently being viewed —
even files untouched by the current branch — so a user can understand
the context around a change, not just the change itself (e.g. a refactor
that calls a function whose own definition lives in an untouched file).
The issue's own proposed shape names two signal types: a static
import/require graph, and symbol-reference linkage reusing whatever #7
built. Both are now shipped (#6's scan engine, #7's whole-word/heuristic
lookup), so this spec builds directly on their real shape rather than
guessing at it.

An explicit question raised before design started: whether to lean on
the separate "understand-anything" knowledge-graph capability instead of
building natively. Decided against — UA produces a static, batch-generated
snapshot (assumes the explorer knows nothing about the codebase), which
is fundamentally the wrong shape for a tool whose whole premise is
reflecting the *current* state of a fast-moving repo, often mid-edit.
Building natively, on #6/#7's live infrastructure, is the only option
that doesn't reintroduce the exact staleness problem #6 was redesigned
away from.

## Load-bearing decisions

1. **Three edge types, reusing #6/#7's engine rather than building a new
   one.**
   - **Imports** (forward) — what the *currently open* file's own text
     imports. Parsed client-side from content already in hand (the
     renderer already has it via `ContentPane`'s `readFile`), reusing and
     extending #7's `resolveImports.ts` pattern.
   - **Imported by** (reverse) — reuses #7's word-mode scan
     (`searchFiles` with `mode: 'word'`), searching for this file's own
     basename, filtered through a *new* heuristic ("does this line look
     like it imports this name") — the same shape as
     `definitionHeuristics.ts`'s declaration-pattern filter, just a
     different pattern set, applied the same way (as a `lineFilter`
     pushed into the scan, not a post-hoc filter — matching the
     performance lesson from #7's own final review).
   - **References** (reverse, symbol-level) — extract the currently open
     file's own top-level declared symbol names client-side (new: a
     capture-group extractor, the mirror image of
     `looksLikeDefinition`'s boolean test), then call #7's *existing*,
     *unmodified* `symbol:references` IPC once per declared name,
     excluding matches inside the file itself, aggregating to one row per
     related file (not per match — same grouping convention `SearchPane`
     already uses).

   No new persistent index, no new cache, no new concurrency model — the
   session's cached file listing (#16) and the scan engine's caps/budget/
   cancellation are inherited automatically by reusing `searchFiles` and
   `symbol:references` as-is.

2. **New sidebar pane, matching `HistoryPane`/`SearchPane`'s existing
   pattern.** A new collapsible pane in the left column's vertical
   `Allotment`, showing related files for whichever file is currently
   selected.

3. **Computed lazily, only while the panel is open** — matching
   `SearchPane`'s own pattern (closed by default, does nothing until
   opened). Avoids running potentially several `symbol:references` calls
   (one per declared symbol) on every single file click when most clicks
   won't have the panel open.

4. **Language scope for the "Imports" extractor: TypeScript/JavaScript
   (already built by #7), plus new Python and Go extractors.** Same
   "light per-language parsing, not real parsing" philosophy #7 already
   established — regex-based specifier extraction, not an AST. Priority
   order matches #7's own (TypeScript, then Python, then Go).
5. **A known, accepted heuristic limitation: "Imported by" can produce
   false positives for generic filenames** (e.g. two unrelated files both
   named `utils.ts` in different directories) — the search can only match
   on the bare basename, not real module resolution. No special UI
   treatment; this is the same class of honest limitation the issue's own
   non-goals already accept for the heuristic path generally.
   **Go is a sharper case, not just noisier:** Go doesn't import
   individual files at all — it imports *packages* (directories), so a
   file's own basename never appears in any Go import statement
   referencing it. "Imported by" for a `.go` file is therefore not merely
   imprecise, it would find nothing meaningful by basename-matching. For
   Go specifically, "Imported by" is scoped down for this pass — it
   simply returns no results (not an error, not a broken UI, just an
   empty section) — rather than building a separate package-path-based
   search mechanism, which is a real, differently-shaped piece of work
   deferred to a future pass if Go usage justifies it.
6. **Non-goals, restated from the issue verbatim:** no true call-hierarchy
   or inheritance-chain tracing (needs real language-level understanding,
   a separate, materially bigger initiative); no cross-repo or
   `node_modules`/vendored dependency graph — scoped to files within the
   open folder only, exactly like #7's import preloading already is.

## Main process changes

`src/main/search/scan.ts`: no changes — `searchFiles`'s existing `mode:
'word'` and `lineFilter` options (both already shipped by #7) are reused
as-is for the "Imported by" edge type.

New `src/main/search/importHeuristics.ts` (sibling to
`definitionHeuristics.ts`): exports `looksLikeImportOf(line: string,
basename: string): boolean` — a language-agnostic pattern list for "does
this line import something named `basename`" (covers `import ... from
'.../basename'`, `require('.../basename')`, Python's `from .../basename
import ...` / `import .../basename`, Go's `import ".../basename"`).

`src/main/ipc.ts`: one new handler, `related:importedBy`, following the
exact `symbol:definitions`/`symbol:references` pattern (session snapshot,
`getSearchPaths` cache, its own `AbortController` — a fourth, following
#7's fix-wave lesson that shared controllers across independent lookup
kinds is a real bug, not a simplification):

```ts
ipcMain.handle('related:importedBy', async (_e, basename: string): Promise<SymbolLocationsResult> => {
  // same shape as symbol:definitions/references: own controller,
  // getSearchPaths cache, mode: 'word', lineFilter: looksLikeImportOf
})
```

No new handler for "Imports" (client-side, see below) or "References"
(reuses `symbol:references` unmodified, called once per declared name).

`src/preload/index.ts`: `findImportedBy(basename: string):
Promise<SymbolLocationsResult>` bridge method, mirroring
`findReferences`'s exact shape.

## Renderer changes

New `src/renderer/src/code/declaredSymbols.ts`: exports
`extractDeclaredNames(content: string): string[]` — a capture-group
sibling to `definitionHeuristics.ts`'s pattern family (own copy, not a
cross-process shared module — matches this codebase's existing tolerance
for small, parallel duplication across the main/renderer boundary, e.g.
`markdown/paths.ts` and `html/paths.ts`'s independent `isInsideRoot`
copies).

New `src/renderer/src/code/importExtractors.ts`: generalizes #7's
`resolveImports.ts` TS/JS-specific `extractImportSpecifiers` into a
per-language dispatch — new Python and Go specifier-extraction functions
alongside the existing TS one, chosen by the selected file's
`languageForFile` result. `resolveImports.ts`'s `candidateImportPaths`
(path-joining/candidate-suffix logic) is reused for TS/JS; Python/Go get
their own candidate-suffix lists (`.py`/`__init__.py`; `.go`) but share
the same `posixJoin` resolution helper.

New `src/renderer/src/components/RelatedFilesPane.tsx`: fetches and
renders the three sections (Imports / Imported by / References) for the
currently selected file, lazily (decision 3) — only does any work while
`open` is true, matching `SearchPane`'s own `open` prop convention. Each
row navigates via the existing `navigateTo`, consistent with every other
click-to-navigate surface in the app. Per decision 5, the "Imported by"
section is skipped entirely (not fetched, not rendered as an empty
loading state) when the selected file's language is Go.

`src/renderer/src/App.tsx`: one new pane wired into the left-column
`Allotment`, following the exact `SearchPane` wiring pattern (state,
menu/keyboard trigger — reusing the "Search" menu's sibling slot rather
than inventing a new trigger convention — `key={repo?.root ?? 'none'}`
reset on folder switch).

## Module layout

```
src/main/search/importHeuristics.ts             looksLikeImportOf (new)
src/main/ipc.ts                                  related:importedBy handler (modified)
src/preload/index.ts                             findImportedBy bridge (modified)
src/renderer/src/code/declaredSymbols.ts         extractDeclaredNames (new)
src/renderer/src/code/importExtractors.ts        per-language specifier extraction (new, generalizes resolveImports.ts)
src/renderer/src/components/RelatedFilesPane.tsx new panel component (new)
src/renderer/src/App.tsx                         pane wiring (modified)
```

## Testing

- `importHeuristics.test.ts`: `looksLikeImportOf` matches TS/JS
  `import`/`require`, Python `from...import`/`import`, and Go `import`
  shapes; rejects a plain usage/mention line.
- `declaredSymbols.test.ts`: `extractDeclaredNames` extracts the same
  shapes `definitionHeuristics.ts` tests for, as names rather than
  booleans.
- `importExtractors.test.ts`: Python and Go specifier extraction
  (parallel to `resolveImports.test.ts`'s existing TS/JS coverage).
- No automated coverage for `RelatedFilesPane.tsx` itself or the
  `related:importedBy` IPC handler — consistent with every other
  renderer component/IPC handler in this codebase. Covered by manual
  end-to-end verification: a small multi-file fixture (TS files with a
  real import chain, a Python file, cross-references between them),
  checking all three sections populate correctly and each row navigates.

## Non-goals

Restated from decision 6: true call-hierarchy/inheritance tracing;
cross-repo or `node_modules`/vendored graphs. Also, per this spec's own
scope: no UI treatment for the accepted false-positive limitation
(decision 5); no persistent caching beyond what #6/#16 already provide;
no new concurrency/caps model beyond what `searchFiles` already enforces.
