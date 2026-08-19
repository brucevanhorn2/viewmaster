# Find Usages / Go to Definition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JetBrains/VS-style F12 (go to definition) / Shift+F12 (find usages) navigation, real-semantic for TypeScript (via Monaco's already-bundled TS language service) and heuristic (text-pattern matching, reusing the #6/#16 scan engine) for everything else.

**Architecture:** Two independent lookup paths feed Monaco's native `DefinitionProvider`/`ReferenceProvider` machinery — Monaco's own bundled TypeScript integration for `.ts`/`.tsx` (given real per-file model identity and one-level import preloading), and a new heuristic path (whole-word scan + declaration-pattern matching) registered for every other language. A single shared `registerEditorOpener` bridge routes any cross-file jump from either path through the app's existing `navigateTo`/history stack.

**Tech Stack:** TypeScript, Electron main process, Monaco Editor (bundled TS worker), Vitest.

## Global Constraints

- Language priority: TypeScript first (real semantic accuracy), then Python and Go (heuristic), Java/C# explicitly deferred.
- TypeScript cross-file resolution is incremental (visited files + one level of their direct imports), never a whole-project preload.
- `CodeView` gains `path={absPath}` and `keepCurrentModel={true}` on its `<Editor>` so Monaco keeps a persistent, path-keyed model per file instead of disposing it on unmount.
- The heuristic path reuses `scan.ts`'s existing bounded-concurrency, cached, cancellable file listing — no new caching layer, no new concurrency model.
- Heuristic word-mode matching reports every occurrence per line (unlike the existing substring mode, which only reports the first).
- The custom heuristic `DefinitionProvider`/`ReferenceProvider` is registered for every Monaco language id **except** `typescript` and `javascript` — those already get Monaco's real, bundled TS-backed providers.
- Cross-file jumps push a Back/Forward history entry (via `navigateTo`); same-file jumps do not (accepted gap — Monaco handles those natively).
- `symbol:definitions` returns only whole-word matches whose line satisfies the declaration heuristic — never "all usages" as a fallback when none do. Zero matches means "not found," not "show everything."

---

### Task 1: `scan.ts` — whole-word match mode

**Files:**
- Modify: `src/main/search/scan.ts`
- Test: `src/main/search/scan.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SearchScanOptions.mode?: 'substring' | 'word'` (default `'substring'`) — Task 3's `symbol:definitions`/`symbol:references` handlers pass `mode: 'word'`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('searchFiles', ...)` block in `src/main/search/scan.test.ts`, after the last test:

```ts
  it('word mode matches whole words only, not substrings', async () => {
    await repo.write('a.txt', 'foo foobar barfoo\n')
    const { matches } = await searchFiles(repo.root, ['a.txt'], 'foo', { mode: 'word' })
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ line: 1, column: 0 })
  })

  it('word mode finds every occurrence on a line, not just the first', async () => {
    await repo.write('a.txt', 'foo(foo, foo)\n')
    const { matches } = await searchFiles(repo.root, ['a.txt'], 'foo', { mode: 'word' })
    expect(matches).toHaveLength(3)
    expect(matches.map((m) => m.column)).toEqual([0, 4, 9])
  })

  it('defaults to substring mode when mode is omitted', async () => {
    await repo.write('a.txt', 'foobar\n')
    const { matches } = await searchFiles(repo.root, ['a.txt'], 'foo')
    expect(matches).toHaveLength(1)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/search/scan.test.ts -t "word mode"`
Expected: FAIL — `searchFiles` doesn't accept a `mode` option yet, so both new tests behave like substring mode (the first finds 1 match via substring `indexOf`, not the intended whole-word-only count; the second finds only the first `foo` per line, not all three).

- [ ] **Step 3: Implement the minimal change**

In `src/main/search/scan.ts`, add an escape helper near the top (after the existing constants):

```ts
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
```

Change `SearchScanOptions` (currently `{ signal?: AbortSignal; startedAt?: number }`) to:

```ts
export interface SearchScanOptions {
  signal?: AbortSignal
  startedAt?: number
  mode?: 'substring' | 'word'
}
```

Change `scanOneFile`'s signature and body. Currently:

```ts
async function scanOneFile(
  absPath: string,
  relPath: string,
  needle: string,
  maxMatches: number
): Promise<{ matches: SearchMatch[]; capped: boolean }> {
```

becomes:

```ts
async function scanOneFile(
  absPath: string,
  relPath: string,
  needle: string,
  maxMatches: number,
  mode: 'substring' | 'word'
): Promise<{ matches: SearchMatch[]; capped: boolean }> {
```

(the four lines before the streaming loop — the `maxMatches <= 0` guard, the `stat` check, and the `isBinaryFile` check — are unchanged).

Replace the streaming loop body. Currently:

```ts
  const results: SearchMatch[] = []
  let capped = false
  const stream = createReadStream(absPath, { encoding: 'utf8' })
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity
  })
  let lineNumber = 0
  try {
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
    } catch {
      // Stream error (file deleted, permissions changed, etc.) — skip this file,
      // don't fail the entire search. Return whatever matches were found so far.
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return { matches: results, capped }
```

becomes:

```ts
  const results: SearchMatch[] = []
  let capped = false
  const wordPattern = mode === 'word' ? new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'gi') : null
  const stream = createReadStream(absPath, { encoding: 'utf8' })
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity
  })
  let lineNumber = 0
  try {
    try {
      outer: for await (const line of rl) {
        lineNumber++
        if (wordPattern) {
          wordPattern.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = wordPattern.exec(line)) !== null) {
            const { preview, previewColumn } = extractPreview(line, match.index)
            results.push({
              path: relPath,
              absPath,
              line: lineNumber,
              column: match.index,
              preview,
              previewColumn
            })
            if (results.length >= maxMatches) {
              capped = true
              break outer
            }
          }
        } else {
          const column = line.toLowerCase().indexOf(needle)
          if (column === -1) continue
          const { preview, previewColumn } = extractPreview(line, column)
          results.push({ path: relPath, absPath, line: lineNumber, column, preview, previewColumn })
          if (results.length >= maxMatches) {
            capped = true
            break outer
          }
        }
      }
    } catch {
      // Stream error (file deleted, permissions changed, etc.) — skip this file,
      // don't fail the entire search. Return whatever matches were found so far.
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return { matches: results, capped }
```

In `searchFiles`, change:

```ts
  const needle = query.toLowerCase()
```

to add a `mode` read right after it:

```ts
  const needle = query.toLowerCase()
  const mode = options.mode ?? 'substring'
```

and change the `scanOneFile` call site:

```ts
    const { matches: fileMatches, capped } = await scanOneFile(absPath, relPath, needle, perFileCap)
```

to:

```ts
    const { matches: fileMatches, capped } = await scanOneFile(absPath, relPath, needle, perFileCap, mode)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/search/scan.test.ts`
Expected: all tests in the file PASS (12 total: 9 existing + 3 new).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/search/scan.ts src/main/search/scan.test.ts
git commit -m "feat: add whole-word match mode to searchFiles"
```

---

### Task 2: `definitionHeuristics.ts` — declaration-pattern heuristic

**Files:**
- Create: `src/main/search/definitionHeuristics.ts`
- Test: `src/main/search/definitionHeuristics.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `looksLikeDefinition(line: string, word: string): boolean` — Task 3's `symbol:definitions` handler filters whole-word matches through this.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/search/definitionHeuristics.test.ts
import { describe, it, expect } from 'vitest'
import { looksLikeDefinition } from './definitionHeuristics'

describe('looksLikeDefinition', () => {
  it('matches a function declaration', () => {
    expect(looksLikeDefinition('function needleFunction(): string {', 'needleFunction')).toBe(true)
  })

  it('matches a class declaration', () => {
    expect(looksLikeDefinition('export class Needle {', 'Needle')).toBe(true)
  })

  it('matches a const assignment', () => {
    expect(looksLikeDefinition('const needle = 5', 'needle')).toBe(true)
  })

  it('matches a python def', () => {
    expect(looksLikeDefinition('def needle_function():', 'needle_function')).toBe(true)
  })

  it('matches a go func', () => {
    expect(looksLikeDefinition('func needleFunction() string {', 'needleFunction')).toBe(true)
  })

  it('matches a rust fn', () => {
    expect(looksLikeDefinition("fn needle_function() -> String {", 'needle_function')).toBe(true)
  })

  it('rejects a plain usage line', () => {
    expect(looksLikeDefinition('return needleFunction()', 'needleFunction')).toBe(false)
  })

  it('does not match a different word that merely starts with the same letters', () => {
    expect(looksLikeDefinition('function needleFunctionExtra(): string {', 'needleFunction')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/search/definitionHeuristics.test.ts`
Expected: FAIL with a module-not-found error — `./definitionHeuristics` doesn't exist yet.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/main/search/definitionHeuristics.ts
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A single, language-agnostic set of "this line declares something named
 * `word`" patterns, checked regardless of the file's actual language (see
 * the design spec's decision on a shared pattern list instead of
 * per-language parsers). Not exhaustive, not per-language-correct —
 * intentionally cheap heuristics covering common declaration shapes
 * across TypeScript/JavaScript, Python, Go, and a couple of cheap extras.
 */
export function looksLikeDefinition(line: string, word: string): boolean {
  const w = escapeRegExp(word)
  const patterns = [
    new RegExp(`\\b(function|class|interface|type|enum|namespace|module|struct)\\s+${w}\\b`),
    new RegExp(`\\b(const|let|var)\\s+${w}\\b\\s*=`),
    new RegExp(`\\bdef\\s+${w}\\s*\\(`),
    new RegExp(`\\bfunc\\s+${w}\\s*\\(`),
    new RegExp(`\\bfn\\s+${w}\\s*\\(`)
  ]
  return patterns.some((p) => p.test(line))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/search/definitionHeuristics.test.ts`
Expected: PASS (8/8).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/search/definitionHeuristics.ts src/main/search/definitionHeuristics.test.ts
git commit -m "feat: add language-agnostic declaration-pattern heuristic"
```

---

### Task 3: `ipc.ts`/`types.ts`/preload — `symbol:definitions` and `symbol:references`

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `SearchScanOptions.mode` (Task 1), `looksLikeDefinition` (Task 2).
- Produces: `SymbolLocation`/`SymbolLocationsResult` types; `window.viewmaster.findDefinitions(word)`/`findReferences(word)` — Task 6's Monaco providers call these.

No automated test — no unit test framework covers any `ipc.ts` handler in this codebase (true of every existing handler, not a gap introduced here). Covered by Task 8's manual verification.

- [ ] **Step 1: Add the shared types**

In `src/shared/types.ts`, add after the existing `SearchResult` interface:

```ts
export interface SymbolLocation {
  /** Repo-relative path, forward slashes. */
  path: string
  absPath: string
  /** 1-based line number. */
  line: number
  /** 0-based character offset within the line. */
  column: number
}

export interface SymbolLocationsResult {
  locations: SymbolLocation[]
}
```

- [ ] **Step 2: Extract the shared cache-population logic in `ipc.ts`**

`search:query` currently populates `activeSession.searchPaths` inline. This task adds two more handlers that need the exact same logic, so extract it first. In `src/main/ipc.ts`, add this function right after the `Session` interface and its `let session`/`let currentSearchController` declarations (before `closeSession`):

```ts
/**
 * Returns the session's cached file listing, populating it if this is the
 * first search since the last invalidation. Guards against a slow,
 * now-superseded listing overwriting a fresher invalidation — see
 * `searchGeneration` on `Session`. Shared by `search:query` and the
 * `symbol:definitions`/`symbol:references` handlers below, which all
 * search the same underlying listing.
 */
async function getSearchPaths(activeSession: Session): Promise<string[]> {
  if (activeSession.searchPaths !== null) return activeSession.searchPaths
  const generation = activeSession.searchGeneration
  const paths = activeSession.baseline
    ? await listGitTree(activeSession.root)
    : await listFolderTree(activeSession.root)
  if (activeSession.searchGeneration === generation) {
    activeSession.searchPaths = paths
  }
  return paths
}
```

Then replace `search:query`'s current body (the `if (activeSession.searchPaths === null) { ... }` block) — currently:

```ts
    try {
      let paths = activeSession.searchPaths
      if (paths === null) {
        const generation = activeSession.searchGeneration
        paths = activeSession.baseline
          ? await listGitTree(activeSession.root)
          : await listFolderTree(activeSession.root)
        // Only cache this listing if nothing invalidated it while we were
        // awaiting — a file change during the listing means it may already
        // be stale; leaving searchPaths null lets the next query re-list
        // instead of resurrecting the cache with pre-change data. This
        // query still answers with what it has: redoing the listing would
        // just delay the response the user is already waiting on.
        if (activeSession.searchGeneration === generation) {
          activeSession.searchPaths = paths
        }
      }
      return await searchFiles(activeSession.root, paths, query, {
```

with:

```ts
    try {
      const paths = await getSearchPaths(activeSession)
      return await searchFiles(activeSession.root, paths, query, {
```

(the rest of the handler — `signal`/`startedAt` in the options object, and the `catch` block — is unchanged).

- [ ] **Step 3: Add the two new handlers**

Add imports at the top of `src/main/ipc.ts` — `looksLikeDefinition` alongside the existing `searchFiles` import, and `SymbolLocation`/`SymbolLocationsResult` alongside the existing type imports from `@shared/types`:

```ts
import { searchFiles } from './search/scan'
import { looksLikeDefinition } from './search/definitionHeuristics'
```

```ts
import type {
  BaselineKind,
  FileContent,
  HistoryVersion,
  RepoState,
  SearchResult,
  SidebarMode,
  SymbolLocation,
  SymbolLocationsResult
} from '@shared/types'
```

Add the two handlers right after `search:query`'s closing `})`, inside `registerIpc`:

```ts
  ipcMain.handle(
    'symbol:definitions',
    async (_e, word: string): Promise<SymbolLocationsResult> => {
      currentSearchController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [] }
      const controller = new AbortController()
      currentSearchController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches } = await searchFiles(activeSession.root, paths, word, {
          signal: controller.signal,
          startedAt,
          mode: 'word'
        })
        const locations: SymbolLocation[] = matches
          .filter((m) => looksLikeDefinition(m.preview, word))
          .map((m) => ({ path: m.path, absPath: m.absPath, line: m.line, column: m.column }))
        return { locations }
      } catch {
        return { locations: [] }
      }
    }
  )

  ipcMain.handle(
    'symbol:references',
    async (_e, word: string): Promise<SymbolLocationsResult> => {
      currentSearchController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [] }
      const controller = new AbortController()
      currentSearchController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches } = await searchFiles(activeSession.root, paths, word, {
          signal: controller.signal,
          startedAt,
          mode: 'word'
        })
        const locations: SymbolLocation[] = matches.map((m) => ({
          path: m.path,
          absPath: m.absPath,
          line: m.line,
          column: m.column
        }))
        return { locations }
      } catch {
        return { locations: [] }
      }
    }
  )
```

- [ ] **Step 4: Add the preload bridge methods**

In `src/preload/index.ts`, add `SymbolLocationsResult` to the type import:

```ts
import type { FileContent, HistoryVersion, RepoState, SearchResult, SidebarMode, SymbolLocationsResult } from '@shared/types'
```

Add two methods to the `api` object, after `search`:

```ts
  search: (query: string): Promise<SearchResult> => ipcRenderer.invoke('search:query', query),
  findDefinitions: (word: string): Promise<SymbolLocationsResult> =>
    ipcRenderer.invoke('symbol:definitions', word),
  findReferences: (word: string): Promise<SymbolLocationsResult> =>
    ipcRenderer.invoke('symbol:references', word)
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (all existing + Task 1/2's new tests — no tests reference `ipc.ts` directly, so this just confirms nothing else broke).

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat: add symbol:definitions and symbol:references IPC handlers"
```

---

### Task 4: `CodeView` — real per-file model identity

**Files:**
- Modify: `src/renderer/src/components/CodeView.tsx`
- Modify: `src/renderer/src/components/ContentPane.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CodeView` gains a required `absPath: string` prop. Task 5's import-preload effect reads it to resolve relative imports.

No automated test — no `.tsx` test infrastructure in this codebase. Covered by Task 8.

- [ ] **Step 1: Add the `absPath` prop and Monaco model-identity props**

In `src/renderer/src/components/CodeView.tsx`, change the prop destructuring and type (currently `{ fileName, content, revealLine }: { fileName: string; content: string; revealLine?: number }`) to:

```tsx
export default function CodeView({
  fileName,
  absPath,
  content,
  revealLine
}: {
  fileName: string
  absPath: string
  content: string
  revealLine?: number
}): React.JSX.Element {
```

Change the `<Editor>` element (currently missing `path`/`keepCurrentModel`) to add them:

```tsx
    <Editor
      height="100%"
      theme="vs-dark"
      language={languageForFile(fileName)}
      path={absPath}
      keepCurrentModel={true}
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
```

- [ ] **Step 2: Update all three call sites in `ContentPane.tsx`**

In `src/renderer/src/components/ContentPane.tsx`, there are three `<CodeView ...>` elements. Add `absPath={file.absPath}` to each.

The SVG-as-code branch, currently `<CodeView fileName={fileName} content={content.content} />`, becomes:

```tsx
    body = <CodeView fileName={fileName} absPath={file.absPath} content={content.content} />
```

The markdown-as-code branch and the generic (non-markdown, non-SVG) branch — both currently
`<CodeView fileName={fileName} content={content.content} revealLine={lineTarget} />` — each become:

```tsx
    body = <CodeView fileName={fileName} absPath={file.absPath} content={content.content} revealLine={lineTarget} />
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/CodeView.tsx src/renderer/src/components/ContentPane.tsx
git commit -m "feat: give CodeView real per-file Monaco model identity"
```

---

### Task 5: `resolveImports.ts` — TypeScript import-specifier extraction

**Files:**
- Create: `src/renderer/src/code/resolveImports.ts`
- Test: `src/renderer/src/code/resolveImports.test.ts`
- Modify: `src/renderer/src/components/CodeView.tsx`

**Interfaces:**
- Consumes: `CodeView`'s `absPath` prop (Task 4).
- Produces: `extractImportSpecifiers(content: string): string[]`, `candidateImportPaths(fromDir: string, specifier: string): string[]` — pure functions, used by `CodeView`'s new import-preload effect (Step 4, not itself unit-tested — matches every other effect in this file).

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/code/resolveImports.test.ts
import { describe, it, expect } from 'vitest'
import { extractImportSpecifiers, candidateImportPaths } from './resolveImports'

describe('extractImportSpecifiers', () => {
  it('extracts a default import specifier', () => {
    expect(extractImportSpecifiers("import Foo from './foo'\n")).toEqual(['./foo'])
  })

  it('extracts a named import specifier', () => {
    expect(extractImportSpecifiers("import { a, b } from '../bar'\n")).toEqual(['../bar'])
  })

  it('extracts a side-effect import with no from clause', () => {
    expect(extractImportSpecifiers("import './styles.css'\n")).toEqual(['./styles.css'])
  })

  it('extracts an export-from specifier', () => {
    expect(extractImportSpecifiers("export { a } from './a'\n")).toEqual(['./a'])
  })

  it('extracts a require specifier', () => {
    expect(extractImportSpecifiers("const x = require('./x')\n")).toEqual(['./x'])
  })

  it('includes a bare package specifier alongside a local one', () => {
    const specifiers = extractImportSpecifiers("import React from 'react'\nimport Foo from './foo'\n")
    expect(specifiers).toEqual(['react', './foo'])
  })

  it('deduplicates repeated specifiers', () => {
    expect(extractImportSpecifiers("import a from './x'\nimport b from './x'\n")).toEqual(['./x'])
  })
})

describe('candidateImportPaths', () => {
  it('returns an empty list for a bare (node_modules-style) specifier', () => {
    expect(candidateImportPaths('/project/src', 'react')).toEqual([])
  })

  it('builds candidates for a relative specifier without an extension', () => {
    const candidates = candidateImportPaths('/project/src', './foo')
    expect(candidates[0]).toBe('/project/src/foo')
    expect(candidates).toContain('/project/src/foo.ts')
    expect(candidates).toContain('/project/src/foo/index.ts')
  })

  it('resolves a parent-directory specifier', () => {
    const candidates = candidateImportPaths('/project/src/components', '../util/helper')
    expect(candidates[0]).toBe('/project/src/util/helper')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/renderer/src/code/resolveImports.test.ts`
Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/renderer/src/code/resolveImports.ts

const IMPORT_PATTERNS = [
  /\bimport\s+(?:[\s\S]*?\bfrom\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
]

/**
 * Extracts import-like specifier strings from TS/JS source text via
 * regex, not real parsing — deliberately approximate (see the design
 * spec's decision on incremental, one-level import preloading). Used only
 * to find candidate local files to preload as Monaco models, not to
 * build an accurate module graph.
 */
export function extractImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>()
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1])
    }
  }
  return [...specifiers]
}

/**
 * Candidate extensions/index files to try, in order, loosely mirroring
 * Node/TypeScript module resolution.
 */
const CANDIDATE_SUFFIXES = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx'
]

/**
 * Joins `dir` and a relative `specifier` (which may contain `.`/`..`
 * segments) into an absolute, forward-slash path. Assumes forward-slash
 * paths throughout, matching this codebase's existing convention — like
 * `markdown/paths.ts` from issue #5, this does not handle Windows path
 * separators (an accepted, pre-existing limitation, not new here).
 */
function posixJoin(dir: string, specifier: string): string {
  const segments = `${dir}/${specifier}`.split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') resolved.pop()
    else resolved.push(segment)
  }
  return (dir.startsWith('/') ? '/' : '') + resolved.join('/')
}

/**
 * Builds the ordered list of candidate absolute paths for a relative
 * import specifier — the caller tries each in turn (e.g. via `readFile`)
 * until one exists. Bare specifiers (not starting with `.` or `/`) are
 * node_modules-style and return an empty list — there is no
 * node_modules type-awareness here.
 */
export function candidateImportPaths(fromDir: string, specifier: string): string[] {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return []
  const base = posixJoin(fromDir, specifier)
  return [base, ...CANDIDATE_SUFFIXES.map((suffix) => base + suffix)]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/src/code/resolveImports.test.ts`
Expected: PASS (10/10).

- [ ] **Step 5: Wire the import-preload effect into `CodeView.tsx`**

In `src/renderer/src/components/CodeView.tsx`, add imports:

```tsx
import * as monaco from 'monaco-editor'
import { extractImportSpecifiers, candidateImportPaths } from '../code/resolveImports'
```

Add a new effect, after the existing reveal/highlight effect:

```tsx
  // Incrementally makes Monaco's TypeScript language service aware of
  // this file's direct local imports (one level, not recursive — see the
  // design spec), so cross-file "go to definition"/"find usages" can
  // follow an import you haven't opened yet. Bare (node_modules-style)
  // specifiers are skipped entirely — there is no node_modules
  // type-awareness here.
  useEffect(() => {
    if (languageForFile(fileName) !== 'typescript') return
    let cancelled = false
    const lastSlash = absPath.lastIndexOf('/')
    const fromDir = lastSlash === -1 ? absPath : absPath.slice(0, lastSlash)
    const specifiers = extractImportSpecifiers(content)
    void Promise.all(
      specifiers.map(async (specifier) => {
        for (const candidate of candidateImportPaths(fromDir, specifier)) {
          if (cancelled) return
          const uri = monaco.Uri.file(candidate)
          if (monaco.editor.getModel(uri)) return
          const result = await window.viewmaster.readFile(candidate)
          if (cancelled || result.kind !== 'text') continue
          if (!monaco.editor.getModel(uri)) {
            monaco.editor.createModel(result.content, 'typescript', uri)
          }
          return
        }
      })
    )
    return () => {
      cancelled = true
    }
  }, [fileName, absPath, content])
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/code/resolveImports.ts src/renderer/src/code/resolveImports.test.ts src/renderer/src/components/CodeView.tsx
git commit -m "feat: preload direct TypeScript imports as Monaco models"
```

---

### Task 6: `monacoSetup.ts` — heuristic definition/reference providers

**Files:**
- Modify: `src/renderer/src/monacoSetup.ts`

**Interfaces:**
- Consumes: `window.viewmaster.findDefinitions`/`findReferences` (Task 3).
- Produces: nothing new exported — this registers global Monaco providers as a side effect of importing this module (already imported by `CodeView.tsx` today).

No automated test — Monaco provider registration has no test infrastructure in this codebase. Covered by Task 8.

- [ ] **Step 1: Add the provider registration**

In `src/renderer/src/monacoSetup.ts`, add an import for the shared type:

```ts
import type { SymbolLocation } from '@shared/types'
```

Add the following after the existing `languageForFile` function (at the end of the file):

```ts
const HEURISTIC_EXCLUDED_LANGUAGE_IDS = new Set(['typescript', 'javascript'])

function toMonacoLocations(locations: SymbolLocation[]): monaco.languages.Location[] {
  return locations.map((loc) => ({
    uri: monaco.Uri.file(loc.absPath),
    range: {
      startLineNumber: loc.line,
      startColumn: loc.column + 1,
      endLineNumber: loc.line,
      endColumn: loc.column + 1
    }
  }))
}

function wordUnderCursor(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): string | null {
  return model.getWordAtPosition(position)?.word ?? null
}

// TypeScript/JavaScript already get real, type-aware definition/reference
// providers from Monaco's bundled TS language service the moment a
// .ts/.tsx file is opened — registering a second, heuristic provider for
// those language ids would have both queried and merged, polluting real
// results with heuristic noise. Every other language id gets the
// heuristic path (see the design spec's decision 8).
const heuristicLanguageIds = monaco.languages
  .getLanguages()
  .map((lang) => lang.id)
  .filter((id) => !HEURISTIC_EXCLUDED_LANGUAGE_IDS.has(id))

monaco.languages.registerDefinitionProvider(heuristicLanguageIds, {
  async provideDefinition(model, position) {
    const word = wordUnderCursor(model, position)
    if (!word) return []
    const { locations } = await window.viewmaster.findDefinitions(word)
    return toMonacoLocations(locations)
  }
})

monaco.languages.registerReferenceProvider(heuristicLanguageIds, {
  async provideReferences(model, position) {
    const word = wordUnderCursor(model, position)
    if (!word) return []
    const { locations } = await window.viewmaster.findReferences(word)
    return toMonacoLocations(locations)
  }
})
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/monacoSetup.ts
git commit -m "feat: register heuristic definition/reference providers for non-TS languages"
```

---

### Task 7: `App.tsx` — cross-file navigation bridge

**Files:**
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `navigateTo` (already in `App.tsx`, stable `useCallback`).
- Produces: no new exported interface — this is the final integration point connecting both lookup paths' cross-file jumps to the existing history stack.

No automated test — same gap as every other `App.tsx` wiring task in this codebase. Covered by Task 8.

- [ ] **Step 1: Add the import**

In `src/renderer/src/App.tsx`, add to the existing import block:

```ts
import * as monaco from 'monaco-editor'
```

- [ ] **Step 2: Register the editor opener**

Add a new effect after the existing `onGoBack`/`onGoForward` declarations:

```tsx
  // Bridges Monaco's "open a different file" request (fired when either
  // the TypeScript path's real definition/reference results, or the
  // heuristic path's, point at a file other than the one currently open)
  // into the app's own navigation history — the same stack Back/Forward
  // already operate on. A same-file jump never reaches this callback;
  // Monaco just moves the cursor within the current model instead (see
  // the design spec's accepted gap).
  useEffect(() => {
    const disposable = monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const line =
          selectionOrPosition && 'lineNumber' in selectionOrPosition
            ? selectionOrPosition.lineNumber
            : selectionOrPosition && 'startLineNumber' in selectionOrPosition
              ? selectionOrPosition.startLineNumber
              : 1
        navigateTo(resource.fsPath, { kind: 'line', line })
        return true
      }
    })
    return () => disposable.dispose()
  }, [navigateTo])
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: route cross-file go-to-definition/find-usages jumps through navigateTo"
```

---

### Task 8: Manual end-to-end verification

**Files:** none (fixture files live in a scratch temp directory, not the repo).

No automated coverage exists for the Monaco provider integration, the TS import-preload effect, or the `registerEditorOpener` bridge — this task is the only place that verifies the full feature actually works in the real running app. Use the **run-viewmaster** skill to drive the app. If triggering F12/Shift+F12 by simulated keypress doesn't reach Monaco (the same class of gap hit in #6's and #16's manual-verification tasks with native menu accelerators — issue #18 tracks this for menus specifically), trigger "go to definition"/"find usages" via Monaco's right-click context menu instead (`Editor.getSupportedActions()`/`editor.getAction('editor.action.revealDefinition')`/`'editor.action.referenceSearch.trigger'` can also be invoked directly via `editor.trigger` if the context menu itself isn't reachable headlessly) — check what the driver already supports before improvising a workaround.

- [ ] **Step 1: Build a fixture folder**

```bash
mkdir -p /tmp/vm-usages-fixture/src
cat > /tmp/vm-usages-fixture/src/app.ts <<'EOF'
import { needleFunction } from './util'

export function callsNeedle(): string {
  return needleFunction()
}
EOF
cat > /tmp/vm-usages-fixture/src/util.ts <<'EOF'
export function needleFunction(): string {
  return 'found the needle here'
}

export function anotherFunction(): void {
  console.log('nothing to see here')
}
EOF
cat > /tmp/vm-usages-fixture/main.py <<'EOF'
def needle_function():
    return "found the needle here"


def caller():
    return needle_function()
EOF
git -C /tmp/vm-usages-fixture init -q
git -C /tmp/vm-usages-fixture add -A
git -C /tmp/vm-usages-fixture commit -q -m "init"
```

- [ ] **Step 2: TypeScript — go to definition across files**

Open `/tmp/vm-usages-fixture`, select `src/app.ts`. Place the cursor on `needleFunction` inside `callsNeedle`'s `return needleFunction()` call (a usage, not the declaration). Trigger "go to definition." Verify:
- The content pane switches to `src/util.ts` (a *different* file — confirming the cross-file path, not just same-file cursor movement).
- The definition line (`export function needleFunction(): string {`) is visible/highlighted.
- The toolbar's Back button is now enabled; clicking it returns to `src/app.ts` at the original position — confirming the jump pushed a history entry (design spec decision 5).

- [ ] **Step 3: TypeScript — find usages**

From `src/util.ts`, with the cursor on `needleFunction`'s declaration, trigger "find usages." Verify at least one result pointing at `src/app.ts`'s call site is present (via Monaco's peek/reference list, or by checking the provider's underlying data if the peek UI itself isn't inspectable headlessly).

- [ ] **Step 4: TypeScript — same-file jump does not push history**

Open `src/util.ts`. Note the Back button's current enabled/disabled state. Trigger "go to definition" on a call to `anotherFunction` from within the same file if one exists, or otherwise trigger a same-file jump. Verify the Back button's enabled/disabled state is unchanged immediately after (no new history entry was pushed) — confirming the accepted gap from decision 5 behaves as designed, not as an accidental omission.

- [ ] **Step 5: Heuristic path — Python go to definition**

Select `main.py`. Place the cursor on `needle_function` inside `caller`'s `return needle_function()` line. Trigger "go to definition." Verify it jumps to the `def needle_function():` line in the same file (same-file in this fixture, so no cross-file history check here — that's already covered by Step 2's TS case). This confirms the heuristic path's declaration-pattern matching works for Python's `def` shape end-to-end (IPC round-trip, `looksLikeDefinition` filtering, Monaco rendering the result).

- [ ] **Step 6: Clean up the fixture**

```bash
rm -rf /tmp/vm-usages-fixture
```

- [ ] **Step 7: Final full-suite check**

Run: `npm run build`
Expected: typecheck + build both succeed.

No commit for this task (no repo files changed) — if any verification step surfaces a bug, fix it as a small follow-up commit referencing the task/step where it was found.
