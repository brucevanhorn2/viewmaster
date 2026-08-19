# View Master — Find Usages / Go to Definition (Design Spec)

**Date:** 2026-08-19
**Status:** Approved
**Extends:** `2026-08-16-search-indexing-design.md` (issue #6),
`2026-08-18-search-listing-cache-design.md` (issue #16). Resolves issue #7.

## Purpose

The issue's ask: "As a user of viewmaster, I would like to be able to
find usages, implementations, etc. of a selected token in a code file so
that I can navigate along a call chain and observe how the code works,"
emulating JetBrains/Visual Studio's F12 (go to definition) /
Shift+F12 (find usages) keyboard-driven navigation. View Master has no
language server, no AST parser, and no persistent symbol index — real
semantic symbol resolution (the kind JetBrains/VS provide) is a
substantially larger, differently-shaped project than anything built so
far (embedding a language server per language, binary distribution,
process management). This spec deliberately does not build that.

## Load-bearing decisions

1. **Hybrid: real semantic accuracy for TypeScript, heuristic text
   matching for everything else.** Monaco (already bundled for `CodeView`)
   ships a real TypeScript language service in-browser (`ts.worker`,
   already loaded in `monacoSetup.ts` for tokenization) whose bundled
   `language/typescript` package auto-registers genuine
   `DefinitionProvider`/`ReferenceProvider` implementations backed by the
   actual TypeScript compiler, the moment a `.ts`/`.tsx` file is opened as
   a model — confirmed present in the installed package
   (`DefinitionAdapter`/`ReferenceAdapter` registered in
   `vs/language/typescript/tsMode.js`). This is not a heuristic for
   TypeScript; it is real, type-aware resolution, already mostly present
   and simply unused for this purpose today. Python and Go (the next two
   priority languages) have no such bundled equivalent — real support
   would mean spawning `pyright`/`gopls` as external processes and
   building a generic LSP-client bridge, a genuinely separate, larger
   project. Deferred as its own future issue, given the same treatment the
   user gave Java/C# ("I can wait on that").
2. **Language priority, in order: TypeScript, Python, Go.** Java and C#
   support is explicitly deferred, not built here.
3. **TypeScript cross-file resolution is incremental, not a whole-project
   preload.** Monaco's TS service only knows about files loaded as
   models. Preloading an entire monorepo upfront would repeat the exact
   memory/rebuild-cost mistake #6 was redesigned away from. Instead:
   opening a `.ts`/`.tsx` file registers it as a persistent, path-keyed
   Monaco model (see decision 4), and additionally scans its raw text for
   `import`/`require`/`export...from` specifiers, resolving the relative
   ones against the file's own directory (trying `.ts`/`.tsx`/`.d.ts`/
   `.js`/`.jsx`/`index.*`, mirroring Node/TS resolution) and registering
   each as a model too — **one level, not recursive**. Bare imports
   (`react`, `lodash`) are skipped; there is no `node_modules`
   type-awareness. A definition in a file neither opened nor directly
   imported by an opened file will not resolve via the TypeScript path —
   it falls back to the heuristic path (decision 6), which still finds it,
   without type-aware accuracy. This is an accepted, honest limitation,
   not a bug to chase: most "follow a call chain" sessions involve files
   already open or one hop away while reviewing a diff.
4. **`CodeView` needs real model identity to make decision 3 possible.**
   Today's `<Editor>` has no `path` prop, so every file gets an anonymous,
   disposable model — nothing persists across navigation. This spec adds
   `path={absPath}` (so Monaco keys and reuses models by real file
   identity — `@monaco-editor/react` already checks
   `monaco.editor.getModel(uri)` before creating a new one) and
   `keepCurrentModel={true}` (so navigating away from a file does not
   dispose its model on unmount, which is `@monaco-editor/react`'s default
   behavior and would otherwise erase the TS service's knowledge of it).
5. **Cross-file jumps are back/forward-able; same-file jumps are not.**
   `App.tsx` registers a single global `monaco.editor.registerEditorOpener`
   (once — `navigateTo` is already a stable `useCallback`) that intercepts
   any "open a different file" request from either the TypeScript path or
   the heuristic path's providers, and routes it through
   `navigateTo(absPath, {kind:'line', line})` — the same history stack
   #6 built. Same-file jumps stay native to Monaco (it just moves the
   cursor within the current model) and do not push a history entry —
   an accepted, explicit gap, not an oversight: the common, valuable case
   ("navigate along a call chain") is almost always cross-file.
6. **The heuristic path reuses #6/#16's scan engine, not a new one.**
   `scan.ts` gains a whole-word match mode alongside the existing
   substring mode used by Find in Files — a word-boundary regex instead of
   `indexOf`, and (unlike substring mode, which only reports the first
   match per line) word mode reports *every* occurrence per line, since
   "find usages" needs a real count. It runs against the same cached,
   capped, cancellable, watcher-invalidated file listing #16 already
   built — no new caching layer, no new concurrency model.
7. **A single, language-agnostic set of "looks like a declaration"
   patterns, not per-language parsers.** Given decision 2's priority
   order, a shared regex list (`function foo`, `class Foo`, `const foo =`,
   `def foo(`, `func foo(`, plus a few cheap extras like Rust's `fn foo(`)
   is checked against each whole-word match's line text to split results
   into "definitions" vs. plain usages, independent of the file's declared
   language. `symbol:definitions` returns only the whole-word matches
   whose line satisfies the heuristic — not "all usages" as a fallback
   when none do. Zero declaration-shaped matches means "no definition
   found" (Monaco's native behavior for an empty `Definition` result — it
   does nothing, which is honest: the heuristic genuinely doesn't know).
   More than one declaration-shaped match returns all of them as a list
   rather than guessing which is "the" definition — Monaco's own native
   behavior for a `Definition` array with more than one entry is an
   automatic peek UI, so no extra UI work is needed for the ambiguous
   case.
8. **The heuristic providers are scoped to exclude `typescript`/
   `javascript`.** Both a custom provider and Monaco's bundled TS one
   would otherwise be queried and merged for `.ts`/`.tsx`/`.js`/`.jsx`
   files, polluting real TS results with heuristic noise. The custom
   `DefinitionProvider`/`ReferenceProvider` registered in this spec is
   scoped to every Monaco language id *except* `typescript` and
   `javascript`.

## Main process changes

`src/main/search/scan.ts`:
- `searchFiles`/`scanOneFile` gain a `mode: 'substring' | 'word'` option
  (default `'substring'`, preserving Find in Files' exact existing
  behavior). In `'word'` mode, matching uses a word-boundary regex
  (`\b<escaped query>\b`, case-insensitive) and collects every match on a
  line, not just the first.
- New `src/main/search/definitionHeuristics.ts`: exports
  `looksLikeDefinition(line: string, word: string): boolean`, testing a
  line against the shared pattern list from decision 7.

`src/main/ipc.ts`: new handlers, following the existing `search:query`
pattern (session snapshot, the cached `searchPaths` listing from #16,
cancellation via `AbortController`):
- `symbol:definitions` — runs a word-mode scan for the given word, filters
  to matches where `looksLikeDefinition` is true, returns
  `{ locations: SymbolLocation[] }`.
- `symbol:references` — runs a word-mode scan for the given word, returns
  every match as `{ locations: SymbolLocation[] }` (usages, not filtered
  by the declaration heuristic — "find usages" means everything).
- `SymbolLocation = { path: string; absPath: string; line: number;
  column: number }` (new type in `src/shared/types.ts`) — simpler than
  `SearchMatch`; no preview text is needed since Monaco renders its own
  preview when peeking a `Location`.

`src/preload/index.ts`: `findDefinitions`/`findReferences` bridge methods
mirroring `search`'s shape.

## Renderer changes

`src/renderer/src/components/CodeView.tsx`:
- `<Editor>` gains `path={absPath}` and `keepCurrentModel={true}` (decision
  4). `CodeView` needs `absPath` as a new prop (currently only `fileName`
  is passed — `ContentPane` already has `file.absPath` available).
- A new effect, gated on `languageForFile(fileName) === 'typescript'`,
  scans `content` for import specifiers and registers resolved local
  files as additional Monaco models (decision 3) — reads their content
  via the existing `window.viewmaster.readFile`, creates a model via
  `monaco.editor.getModel(uri) ?? monaco.editor.createModel(...)` (guards
  against duplicate creation when multiple files import the same
  dependency).

`src/renderer/src/monacoSetup.ts`: registers the heuristic
`DefinitionProvider`/`ReferenceProvider` (decision 8) for
`monaco.languages.getLanguages().map(l => l.id)` minus `typescript`/
`javascript`, backed by `window.viewmaster.findDefinitions`/
`findReferences`. Word-under-cursor comes from
`model.getWordAtPosition(position)`.

`src/renderer/src/App.tsx`: one new effect registering
`monaco.editor.registerEditorOpener` (decision 5), routing to the
existing `navigateTo`.

## Module layout

```
src/main/search/scan.ts                       word mode added (modified)
src/main/search/definitionHeuristics.ts       looksLikeDefinition (new)
src/main/ipc.ts                               symbol:definitions / symbol:references (modified)
src/preload/index.ts                          findDefinitions / findReferences bridge (modified)
src/shared/types.ts                           SymbolLocation (modified)
src/renderer/src/components/CodeView.tsx      path/keepCurrentModel, TS import preload (modified)
src/renderer/src/monacoSetup.ts               heuristic provider registration (modified)
src/renderer/src/App.tsx                      registerEditorOpener bridge (modified)
```

## Testing

- `scan.test.ts`: word mode finds every occurrence per line (not just the
  first, unlike substring mode); word-boundary correctness (`foo` doesn't
  match inside `foobar`); existing substring-mode tests remain unchanged
  (default mode).
- `definitionHeuristics.test.ts`: each pattern (`function`, `class`,
  `const =`, `def`, `func`, `fn`) matches its intended shape and rejects a
  plain usage line.
- No automated coverage for the Monaco integration itself (provider
  registration, `registerEditorOpener`, model lifecycle) — consistent with
  every other renderer-side wiring in this codebase. Covered by manual
  end-to-end verification: TS go-to-definition/find-usages across two
  files (one direct import apart), a non-TS heuristic case, and a
  same-file jump (confirming it does *not* push a history entry, per
  decision 5).

## Non-goals

- Real Python/Go semantic support (LSP integration) — deferred as its own
  future issue.
- Java/C# support of any kind — deferred per the user's own note.
- Rename/refactor across files.
- The Related Files panel (issue #15) — still depends on this issue's
  reference-finding mechanism; not built here.
- Whole-project TypeScript preload — decision 3 is intentionally bounded.
- Fixing false positives/negatives inherent to text-pattern matching for
  non-TS languages — this is an accepted ceiling of the heuristic
  approach, not a bug queue.
