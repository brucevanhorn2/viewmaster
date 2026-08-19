# Related Files Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sidebar panel showing files related to the one currently selected — what it imports, what imports it, and what references the symbols it declares — even for files untouched by the current branch.

**Architecture:** Three edge types, all reusing #6/#7's existing engine rather than a new one. "Imports" is parsed client-side from the currently-open file's own text (extending #7's `resolveImports.ts` pattern to Python). "Imported by" is a new main-process word-mode scan filtered by an import-shape heuristic (the mirror image of `definitionHeuristics.ts`). "References" reuses #7's existing `symbol:references` IPC unmodified, called once per declared symbol name extracted from the file's own text.

**Tech Stack:** TypeScript, Electron main process, React renderer, Vitest.

## Global Constraints

- No new persistent index, cache, or concurrency model — every new scan reuses `searchFiles`'s existing caps/budget/cancellation and the session's cached file listing (#16) exactly as `symbol:definitions`/`symbol:references` already do.
- The panel is computed lazily — only while it's open (`open` prop true), matching `SearchPane`'s exact convention. No work happens on file selection alone.
- **Go gets no "Imports" or "Imported by" support in this pass** — Go's import model (module-qualified package paths resolved via `go.mod`) has no honest light-parsing resolution to a local file. For a `.go` file, the panel shows only the "References" section. Do not build Go import extraction/resolution as part of this plan.
- Python's "Imports" support is relative-imports only (`from .foo import bar`, `from ..pkg import baz`) — absolute dotted imports (`from myapp.utils import x`) are out of scope; resolving them needs the project's actual source root, which light parsing can't determine.
- Every new IPC handler gets its own `AbortController` variable, following the exact pattern `symbol:definitions`/`symbol:references` already established (a shared controller across independent lookup kinds was a real bug fixed during #7's final review — do not reintroduce it).
- "References" aggregates to one row per related *file*, not per match, excluding matches inside the file being viewed itself.

---

### Task 1: `importHeuristics.ts` — import-shape heuristic

**Files:**
- Create: `src/main/search/importHeuristics.ts`
- Test: `src/main/search/importHeuristics.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `looksLikeImportOf(line: string, basename: string): boolean` — Task 2's `related:importedBy` handler filters whole-word matches through this.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/search/importHeuristics.test.ts
import { describe, it, expect } from 'vitest'
import { looksLikeImportOf } from './importHeuristics'

describe('looksLikeImportOf', () => {
  it('matches a TS/JS import-from statement', () => {
    expect(looksLikeImportOf("import { foo } from './utils'", 'utils')).toBe(true)
  })

  it('matches a require call', () => {
    expect(looksLikeImportOf("const u = require('./utils')", 'utils')).toBe(true)
  })

  it('matches a Python from-import statement', () => {
    expect(looksLikeImportOf('from myapp.utils import foo', 'utils')).toBe(true)
  })

  it('matches a Python bare import statement', () => {
    expect(looksLikeImportOf('import myapp.utils', 'utils')).toBe(true)
  })

  it('matches a Go import statement', () => {
    expect(looksLikeImportOf('import "myapp/pkg/utils"', 'utils')).toBe(true)
  })

  it('rejects a plain usage line', () => {
    expect(looksLikeImportOf('return utils.formatDate()', 'utils')).toBe(false)
  })

  it('rejects a comment merely mentioning the name', () => {
    expect(looksLikeImportOf('// this relates to utils somehow', 'utils')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/search/importHeuristics.test.ts`
Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/main/search/importHeuristics.ts
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A language-agnostic set of "this line imports something named
 * `basename`" patterns — the reverse-direction sibling to
 * `definitionHeuristics.ts`'s `looksLikeDefinition`. Not exhaustive, not
 * per-language-correct — covers common import shapes across
 * TypeScript/JavaScript, Python, and Go. (Go's own pattern is kept here
 * for completeness even though the call site never searches a Go file's
 * own basename — see the design spec's Go carve-out — a cross-language
 * false match is not a realistic concern.)
 */
export function looksLikeImportOf(line: string, basename: string): boolean {
  const b = escapeRegExp(basename)
  const patterns = [
    new RegExp(`\\bimport\\b[^'"]*['"][^'"]*${b}[^'"]*['"]`),
    new RegExp(`\\brequire\\(\\s*['"][^'"]*${b}[^'"]*['"]`),
    new RegExp(`\\bfrom\\s+[.\\w]*${b}[.\\w]*\\s+import\\b`),
    new RegExp(`\\bimport\\s+[.\\w]*${b}[.\\w]*\\s*$`)
  ]
  return patterns.some((p) => p.test(line))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/search/importHeuristics.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/search/importHeuristics.ts src/main/search/importHeuristics.test.ts
git commit -m "feat: add import-shape heuristic for reverse import search"
```

---

### Task 2: `related:importedBy` IPC handler + preload bridge

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `looksLikeImportOf` (Task 1).
- Produces: `window.viewmaster.findImportedBy(basename: string): Promise<SymbolLocationsResult>` — Task 6's panel calls this.

No automated test — no unit test framework covers any `ipc.ts` handler in this codebase (true of every existing handler). Covered by Task 8's manual verification.

- [ ] **Step 1: Add the fourth `AbortController`**

In `src/main/ipc.ts`, find:

```ts
let currentSearchController: AbortController | null = null
let currentDefinitionsController: AbortController | null = null
let currentReferencesController: AbortController | null = null
```

Add a fourth variable right after:

```ts
let currentSearchController: AbortController | null = null
let currentDefinitionsController: AbortController | null = null
let currentReferencesController: AbortController | null = null
let currentImportedByController: AbortController | null = null
```

Find `closeSession`'s body:

```ts
async function closeSession(): Promise<void> {
  currentSearchController?.abort()
  currentSearchController = null
  currentDefinitionsController?.abort()
  currentDefinitionsController = null
  currentReferencesController?.abort()
  currentReferencesController = null
  if (session) {
```

Add the fourth controller's abort/clear right after the third:

```ts
async function closeSession(): Promise<void> {
  currentSearchController?.abort()
  currentSearchController = null
  currentDefinitionsController?.abort()
  currentDefinitionsController = null
  currentReferencesController?.abort()
  currentReferencesController = null
  currentImportedByController?.abort()
  currentImportedByController = null
  if (session) {
```

- [ ] **Step 2: Add the import**

In `src/main/ipc.ts`, find:

```ts
import { looksLikeDefinition } from './search/definitionHeuristics'
```

Add right after:

```ts
import { looksLikeDefinition } from './search/definitionHeuristics'
import { looksLikeImportOf } from './search/importHeuristics'
```

- [ ] **Step 3: Add the handler**

Add right after the `symbol:references` handler's closing `)`:

```ts
  ipcMain.handle(
    'related:importedBy',
    async (_e, basename: string): Promise<SymbolLocationsResult> => {
      currentImportedByController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [] }
      const controller = new AbortController()
      currentImportedByController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches } = await searchFiles(activeSession.root, paths, basename, {
          signal: controller.signal,
          startedAt,
          mode: 'word',
          caseSensitive: true,
          lineFilter: (line) => looksLikeImportOf(line, basename)
        })
        const seen = new Set<string>()
        const locations: SymbolLocation[] = []
        for (const m of matches) {
          const key = `${m.absPath}:${m.line}`
          if (seen.has(key)) continue
          seen.add(key)
          locations.push({ path: m.path, absPath: m.absPath, line: m.line, column: m.column })
        }
        return { locations }
      } catch (err) {
        return { locations: [], error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
```

- [ ] **Step 4: Add the preload bridge method**

In `src/preload/index.ts`, find:

```ts
  findReferences: (word: string): Promise<SymbolLocationsResult> =>
    ipcRenderer.invoke('symbol:references', word)
}
```

Change to:

```ts
  findReferences: (word: string): Promise<SymbolLocationsResult> =>
    ipcRenderer.invoke('symbol:references', word),
  findImportedBy: (basename: string): Promise<SymbolLocationsResult> =>
    ipcRenderer.invoke('related:importedBy', basename)
}
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat: add related:importedBy IPC handler and preload bridge"
```

---

### Task 3: `declaredSymbols.ts` — declared-name extraction

**Files:**
- Create: `src/renderer/src/code/declaredSymbols.ts`
- Test: `src/renderer/src/code/declaredSymbols.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractDeclaredNames(content: string): string[]` — Task 6's panel calls this on the currently-open file's own content to find symbols to look up references for.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/code/declaredSymbols.test.ts
import { describe, it, expect } from 'vitest'
import { extractDeclaredNames } from './declaredSymbols'

describe('extractDeclaredNames', () => {
  it('extracts a function declaration name', () => {
    expect(extractDeclaredNames('function needleFunction(): string {')).toEqual(['needleFunction'])
  })

  it('extracts a class declaration name', () => {
    expect(extractDeclaredNames('export class Needle {')).toEqual(['Needle'])
  })

  it('extracts a const assignment name', () => {
    expect(extractDeclaredNames('const needle = 5')).toEqual(['needle'])
  })

  it('extracts a python def name', () => {
    expect(extractDeclaredNames('def needle_function():')).toEqual(['needle_function'])
  })

  it('extracts a go func name', () => {
    expect(extractDeclaredNames('func NeedleFunction() string {')).toEqual(['NeedleFunction'])
  })

  it('extracts multiple distinct names across lines, deduplicated', () => {
    const content = 'function a() {}\nfunction b() {}\nfunction a() {}\n'
    expect(extractDeclaredNames(content)).toEqual(['a', 'b'])
  })

  it('returns an empty array for a file with no declarations', () => {
    expect(extractDeclaredNames('return a + b\nconsole.log("hi")\n')).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/code/declaredSymbols.test.ts`
Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/renderer/src/code/declaredSymbols.ts

/**
 * Capture-group siblings of `definitionHeuristics.ts`'s `looksLikeDefinition`
 * patterns — same declaration shapes, but extracting the declared name
 * instead of testing a known one. Used to find candidate symbols to look
 * up external references for (issue #15), not to build an accurate
 * symbol table.
 */
const DECLARATION_PATTERNS = [
  /\b(?:function|class|interface|type|enum|namespace|module|struct)\s+(\w+)/,
  /\b(?:const|let|var)\s+(\w+)\b\s*=/,
  /\bdef\s+(\w+)\s*\(/,
  /\bfunc\s+(\w+)\s*\(/,
  /\bfn\s+(\w+)\s*\(/
]

/** Extracts declared symbol names from source text, one line at a time, deduplicated, in first-seen order. */
export function extractDeclaredNames(content: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    for (const pattern of DECLARATION_PATTERNS) {
      const match = pattern.exec(line)
      if (match && !seen.has(match[1])) {
        seen.add(match[1])
        names.push(match[1])
      }
    }
  }
  return names
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/code/declaredSymbols.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/code/declaredSymbols.ts src/renderer/src/code/declaredSymbols.test.ts
git commit -m "feat: add declared-symbol-name extraction"
```

---

### Task 4: `importExtractors.ts` — per-language import dispatch

**Files:**
- Modify: `src/renderer/src/code/resolveImports.ts`
- Create: `src/renderer/src/code/importExtractors.ts`
- Test: `src/renderer/src/code/importExtractors.test.ts`

**Interfaces:**
- Consumes: `extractImportSpecifiers`/`candidateImportPaths` (existing, from `resolveImports.ts`, unchanged).
- Produces: `extractImportSpecifiersForLanguage(language: string, content: string): string[]`,
  `candidateImportPathsForLanguage(language: string, fromDir: string, specifier: string): string[]` — Task 6's panel calls both.

- [ ] **Step 1: Export `posixJoin` from `resolveImports.ts`**

In `src/renderer/src/code/resolveImports.ts`, find:

```ts
function posixJoin(dir: string, specifier: string): string {
```

Change to:

```ts
export function posixJoin(dir: string, specifier: string): string {
```

(no other change to this file — the function body and every existing call site are untouched).

- [ ] **Step 2: Write the failing tests**

```ts
// src/renderer/src/code/importExtractors.test.ts
import { describe, it, expect } from 'vitest'
import { extractImportSpecifiersForLanguage, candidateImportPathsForLanguage } from './importExtractors'

describe('extractImportSpecifiersForLanguage', () => {
  it('dispatches typescript to the TS/JS extractor', () => {
    expect(extractImportSpecifiersForLanguage('typescript', "import Foo from './foo'\n")).toEqual(['./foo'])
  })

  it('dispatches javascript to the TS/JS extractor', () => {
    expect(extractImportSpecifiersForLanguage('javascript', "import Foo from './foo'\n")).toEqual(['./foo'])
  })

  it('extracts a python relative from-import', () => {
    expect(extractImportSpecifiersForLanguage('python', 'from .utils import foo\n')).toEqual(['.utils'])
  })

  it('extracts a python parent-relative from-import', () => {
    expect(extractImportSpecifiersForLanguage('python', 'from ..pkg.sub import bar\n')).toEqual(['..pkg.sub'])
  })

  it('extracts a bare-package python relative import', () => {
    expect(extractImportSpecifiersForLanguage('python', 'from . import foo\n')).toEqual(['.'])
  })

  it('ignores a python absolute dotted import', () => {
    expect(extractImportSpecifiersForLanguage('python', 'from myapp.utils import foo\n')).toEqual([])
  })

  it('returns an empty list for go', () => {
    expect(extractImportSpecifiersForLanguage('go', 'import "myapp/pkg/utils"\n')).toEqual([])
  })

  it('returns an empty list for an unrecognized language', () => {
    expect(extractImportSpecifiersForLanguage('plaintext', 'anything\n')).toEqual([])
  })
})

describe('candidateImportPathsForLanguage', () => {
  it('dispatches typescript to the TS/JS resolver', () => {
    const candidates = candidateImportPathsForLanguage('typescript', '/project/src', './foo')
    expect(candidates[0]).toBe('/project/src/foo')
    expect(candidates).toContain('/project/src/foo.ts')
  })

  it('resolves a python same-package relative import', () => {
    const candidates = candidateImportPathsForLanguage('python', '/project/pkg', '.utils')
    expect(candidates).toEqual(['/project/pkg/utils.py', '/project/pkg/utils/__init__.py'])
  })

  it('resolves a python parent-package relative import', () => {
    const candidates = candidateImportPathsForLanguage('python', '/project/pkg/sub', '..utils')
    expect(candidates).toEqual(['/project/pkg/utils.py', '/project/pkg/utils/__init__.py'])
  })

  it('resolves a python bare-package relative import (from . import x)', () => {
    const candidates = candidateImportPathsForLanguage('python', '/project/pkg', '.')
    expect(candidates).toEqual(['/project/pkg.py', '/project/pkg/__init__.py'])
  })

  it('returns an empty list for go', () => {
    expect(candidateImportPathsForLanguage('go', '/project/src', 'myapp/pkg/utils')).toEqual([])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/renderer/src/code/importExtractors.test.ts`
Expected: FAIL with a module-not-found error.

- [ ] **Step 4: Write the minimal implementation**

```ts
// src/renderer/src/code/importExtractors.ts
import {
  extractImportSpecifiers as extractTsSpecifiers,
  candidateImportPaths as candidateTsPaths,
  posixJoin
} from './resolveImports'

const PYTHON_RELATIVE_FROM_PATTERN = /^\s*from\s+(\.+)([\w.]*)\s+import\b/gm

/**
 * Extracts Python *relative* import specifiers only (`from .foo import
 * bar`, `from ..pkg.sub import baz`, `from . import qux`) — absolute
 * dotted imports (`from myapp.utils import x`) are deliberately not
 * extracted, since resolving them needs the project's actual source
 * root, which light parsing has no honest way to determine (see the
 * design spec's decision 4).
 */
function extractPythonRelativeImports(content: string): string[] {
  const specifiers = new Set<string>()
  for (const match of content.matchAll(PYTHON_RELATIVE_FROM_PATTERN)) {
    specifiers.add(match[1] + match[2])
  }
  return [...specifiers]
}

/**
 * Resolves a Python relative import specifier (leading dots + optional
 * dotted module path) against `fromDir`. One leading dot means "this
 * package" (0 levels up); each additional dot means one more level up.
 * Remaining dots in the module path become path separators. Tries both
 * a `.py` file and a `/__init__.py` package directory, mirroring
 * `candidateImportPaths`' TS/JS suffix-list approach.
 */
function candidatePythonImportPaths(fromDir: string, specifier: string): string[] {
  const dotMatch = /^(\.+)(.*)$/.exec(specifier)
  if (!dotMatch) return []
  const [, dots, rest] = dotMatch
  const modulePath = rest.replace(/\./g, '/')
  let base = fromDir
  for (let i = 0; i < dots.length - 1; i++) {
    const lastSlash = base.lastIndexOf('/')
    base = lastSlash === -1 ? base : base.slice(0, lastSlash)
  }
  const joined = modulePath ? posixJoin(base, modulePath) : base
  return [`${joined}.py`, `${joined}/__init__.py`]
}

/**
 * Dispatches import-specifier extraction by Monaco language id. Go
 * returns an empty list unconditionally — see the design spec's Go
 * carve-out (module-qualified package paths have no light-parsing
 * resolution to a local file, so extraction alone isn't useful).
 */
export function extractImportSpecifiersForLanguage(language: string, content: string): string[] {
  if (language === 'typescript' || language === 'javascript') return extractTsSpecifiers(content)
  if (language === 'python') return extractPythonRelativeImports(content)
  return []
}

/** Dispatches candidate-path resolution by Monaco language id, mirroring extractImportSpecifiersForLanguage's dispatch. */
export function candidateImportPathsForLanguage(
  language: string,
  fromDir: string,
  specifier: string
): string[] {
  if (language === 'typescript' || language === 'javascript') return candidateTsPaths(fromDir, specifier)
  if (language === 'python') return candidatePythonImportPaths(fromDir, specifier)
  return []
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/src/code/importExtractors.test.ts`
Expected: PASS (13/13).

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (existing `resolveImports.test.ts` and everything else unaffected — `posixJoin`'s behavior didn't change, only its visibility).

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/code/resolveImports.ts src/renderer/src/code/importExtractors.ts src/renderer/src/code/importExtractors.test.ts
git commit -m "feat: add per-language import-specifier dispatch (Python relative imports)"
```

---

### Task 5: `relatedFiles.ts` — cross-symbol result aggregation

**Files:**
- Create: `src/renderer/src/code/relatedFiles.ts`
- Test: `src/renderer/src/code/relatedFiles.test.ts`

**Interfaces:**
- Consumes: `SymbolLocation` (existing, from `@shared/types`).
- Produces: `type RelatedFile = { path: string; absPath: string }`,
  `aggregateReferences(results: SymbolLocation[][], ownAbsPath: string): RelatedFile[]` — Task 6's panel calls this to merge per-symbol `symbol:references` results (and the single-array `related:importedBy` result) into one row per file.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/code/relatedFiles.test.ts
import { describe, it, expect } from 'vitest'
import { aggregateReferences } from './relatedFiles'

const loc = (path: string, line: number) => ({ path, absPath: `/root/${path}`, line, column: 0 })

describe('aggregateReferences', () => {
  it('produces one row per distinct file across multiple symbol results', () => {
    const result = aggregateReferences(
      [[loc('a.ts', 1)], [loc('b.ts', 5), loc('a.ts', 9)]],
      '/root/self.ts'
    )
    expect(result).toEqual([
      { path: 'a.ts', absPath: '/root/a.ts' },
      { path: 'b.ts', absPath: '/root/b.ts' }
    ])
  })

  it('deduplicates multiple matches in the same file', () => {
    const result = aggregateReferences([[loc('a.ts', 1), loc('a.ts', 2)]], '/root/self.ts')
    expect(result).toEqual([{ path: 'a.ts', absPath: '/root/a.ts' }])
  })

  it('excludes matches inside the file being viewed itself', () => {
    const result = aggregateReferences([[loc('self.ts', 1), loc('a.ts', 1)]], '/root/self.ts')
    expect(result).toEqual([{ path: 'a.ts', absPath: '/root/a.ts' }])
  })

  it('returns an empty array when there are no results', () => {
    expect(aggregateReferences([], '/root/self.ts')).toEqual([])
    expect(aggregateReferences([[]], '/root/self.ts')).toEqual([])
  })

  it('sorts results by path', () => {
    const result = aggregateReferences([[loc('z.ts', 1), loc('a.ts', 1)]], '/root/self.ts')
    expect(result.map((r) => r.path)).toEqual(['a.ts', 'z.ts'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/code/relatedFiles.test.ts`
Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/renderer/src/code/relatedFiles.ts
import type { SymbolLocation } from '@shared/types'

export interface RelatedFile {
  path: string
  absPath: string
}

/**
 * Merges symbol-location results for multiple declared names (or a
 * single-array `related:importedBy` result) into one row per related
 * file, excluding matches inside the file being viewed itself
 * (`ownAbsPath`), sorted by path for stable, readable display.
 */
export function aggregateReferences(results: SymbolLocation[][], ownAbsPath: string): RelatedFile[] {
  const byPath = new Map<string, RelatedFile>()
  for (const locations of results) {
    for (const loc of locations) {
      if (loc.absPath === ownAbsPath) continue
      if (!byPath.has(loc.absPath)) {
        byPath.set(loc.absPath, { path: loc.path, absPath: loc.absPath })
      }
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/code/relatedFiles.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/code/relatedFiles.ts src/renderer/src/code/relatedFiles.test.ts
git commit -m "feat: add cross-symbol related-file result aggregation"
```

---

### Task 6: `RelatedFilesPane.tsx` — the panel component

**Files:**
- Create: `src/renderer/src/components/RelatedFilesPane.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `window.viewmaster.findImportedBy`/`findReferences` (Tasks 2 and #7's existing), `extractDeclaredNames` (Task 3), `extractImportSpecifiersForLanguage`/`candidateImportPathsForLanguage` (Task 4), `aggregateReferences`/`RelatedFile` (Task 5), `languageForFile` (existing, `../monacoSetup`).
- Produces: `RelatedFilesPane` component with props `{ file: ChangedFile | null; workspaceRoot: string; open: boolean; onNavigate: (absPath: string) => void; onClose: () => void }` — Task 7's `App.tsx` wires this in.

No automated test — no `.tsx` test infrastructure in this codebase. Covered by Task 8.

- [ ] **Step 1: Write the component**

```tsx
// src/renderer/src/components/RelatedFilesPane.tsx
import { useEffect, useState } from 'react'
import type { ChangedFile } from '@shared/types'
import { languageForFile } from '../monacoSetup'
import { extractDeclaredNames } from '../code/declaredSymbols'
import { extractImportSpecifiersForLanguage, candidateImportPathsForLanguage } from '../code/importExtractors'
import { aggregateReferences, type RelatedFile } from '../code/relatedFiles'

function toRelativePath(absPath: string, workspaceRoot: string): string {
  return absPath.startsWith(workspaceRoot)
    ? absPath.slice(workspaceRoot.length).replace(/^\/+/, '')
    : absPath
}

export default function RelatedFilesPane({
  file,
  workspaceRoot,
  open,
  onNavigate,
  onClose
}: {
  file: ChangedFile | null
  workspaceRoot: string
  open: boolean
  onNavigate: (absPath: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [imports, setImports] = useState<RelatedFile[]>([])
  const [importedBy, setImportedBy] = useState<RelatedFile[]>([])
  const [references, setReferences] = useState<RelatedFile[]>([])
  const [loading, setLoading] = useState(false)
  const [language, setLanguage] = useState('plaintext')

  useEffect(() => {
    setImports([])
    setImportedBy([])
    setReferences([])
    if (!open || !file) return
    let cancelled = false
    setLoading(true)
    const fileName = file.path.split('/').pop() ?? file.path
    const currentLanguage = languageForFile(fileName)
    setLanguage(currentLanguage)
    const lastSlash = file.absPath.lastIndexOf('/')
    const fromDir = lastSlash === -1 ? file.absPath : file.absPath.slice(0, lastSlash)

    void (async () => {
      const content = await window.viewmaster.readFile(file.absPath)
      if (cancelled || content.kind !== 'text') {
        if (!cancelled) setLoading(false)
        return
      }

      // Imports (forward) — resolve each specifier's first existing candidate.
      const specifiers = extractImportSpecifiersForLanguage(currentLanguage, content.content)
      const resolvedImports: RelatedFile[] = []
      for (const specifier of specifiers) {
        for (const candidate of candidateImportPathsForLanguage(currentLanguage, fromDir, specifier)) {
          if (cancelled) break
          const result = await window.viewmaster.readFile(candidate)
          if (result.kind === 'text') {
            resolvedImports.push({ path: toRelativePath(candidate, workspaceRoot), absPath: candidate })
            break
          }
        }
      }
      if (!cancelled) setImports(resolvedImports)

      // Imported by (reverse) — skipped entirely for Go (see design spec decision 5).
      if (!cancelled && currentLanguage !== 'go') {
        const basename = fileName.replace(/\.[^.]+$/, '')
        const result = await window.viewmaster.findImportedBy(basename)
        if (!cancelled) {
          setImportedBy(aggregateReferences([result.locations], file.absPath))
        }
      }

      // References (reverse, symbol-level) — one symbol:references call per declared name.
      const names = extractDeclaredNames(content.content)
      const refResults = await Promise.all(names.map((name) => window.viewmaster.findReferences(name)))
      if (!cancelled) {
        setReferences(aggregateReferences(refResults.map((r) => r.locations), file.absPath))
      }

      if (!cancelled) setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [open, file, workspaceRoot])

  const renderSection = (title: string, items: RelatedFile[]): React.JSX.Element => (
    <div className="related-files-section">
      <div className="related-files-section-title">{title}</div>
      {items.length === 0 ? (
        <div className="related-files-empty">None found.</div>
      ) : (
        <ul className="related-files-list">
          {items.map((item) => (
            <li
              key={item.absPath}
              className="related-files-row"
              onClick={() => onNavigate(item.absPath)}
              title={item.path}
            >
              {item.path}
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return (
    <div className="related-files-pane">
      <div className="related-files-title">
        Related Files
        <button className="related-files-close" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      {!file ? (
        <div className="related-files-empty">Select a file to see related files.</div>
      ) : loading ? (
        <div className="related-files-loading">Loading…</div>
      ) : (
        <>
          {renderSection('Imports', imports)}
          {language !== 'go' && renderSection('Imported by', importedBy)}
          {renderSection('References', references)}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add the styles**

In `src/renderer/src/styles.css`, add (near the existing `.search-pane` rules, following the same visual pattern):

```css
/* ---- related files pane ---- */

.related-files-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: auto;
  background: var(--bg);
  border-top: 1px solid #333;
}
.related-files-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
}
.related-files-close {
  background: transparent;
  border: none;
  color: #888;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 4px;
}
.related-files-close:hover {
  color: var(--fg);
}
.related-files-loading {
  padding: 8px 10px;
  color: #777;
  font-size: 12px;
}
.related-files-section {
  margin-bottom: 4px;
}
.related-files-section-title {
  padding: 4px 10px;
  font-size: 11px;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.related-files-empty {
  padding: 2px 10px 6px;
  color: #777;
  font-size: 12px;
}
.related-files-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.related-files-row {
  padding: 2px 10px;
  cursor: pointer;
  font-size: 12px;
  color: var(--fg);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.related-files-row:hover {
  background: var(--bg-hover);
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/RelatedFilesPane.tsx src/renderer/src/styles.css
git commit -m "feat: add RelatedFilesPane component"
```

---

### Task 7: Wire into `App.tsx` and the main-process menu

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `RelatedFilesPane` (Task 6).
- Produces: no new exported interface — this is the feature's final integration point.

No automated test — same gap as every other `App.tsx`/menu wiring task in this codebase. Covered by Task 8.

- [ ] **Step 1: Add the menu item**

In `src/main/index.ts`, add a sender function right after `sendFindInFiles`:

```ts
function sendFindInFiles(): void {
  getMainWindow()?.webContents.send('menu:findInFiles')
}

function sendRelatedFiles(): void {
  getMainWindow()?.webContents.send('menu:relatedFiles')
}
```

Add a new item to the existing `'Search'` submenu, right after `'Find in Files…'`:

```ts
    {
      label: 'Search',
      submenu: [
        {
          label: 'Find in Files…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => sendFindInFiles()
        },
        {
          label: 'Related Files…',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => sendRelatedFiles()
        }
      ]
    },
```

- [ ] **Step 2: Add the preload subscription**

In `src/preload/index.ts`, find:

```ts
  onMenuFindInFiles: (cb: () => void): (() => void) => subscribe<void>('menu:findInFiles', () => cb()),
```

Add right after:

```ts
  onMenuFindInFiles: (cb: () => void): (() => void) => subscribe<void>('menu:findInFiles', () => cb()),
  onMenuRelatedFiles: (cb: () => void): (() => void) => subscribe<void>('menu:relatedFiles', () => cb()),
```

- [ ] **Step 3: Add the import**

In `src/renderer/src/App.tsx`, find:

```ts
import SearchPane from './components/SearchPane'
```

Add right after:

```ts
import SearchPane from './components/SearchPane'
import RelatedFilesPane from './components/RelatedFilesPane'
```

- [ ] **Step 4: Add state and the menu subscription**

Find:

```ts
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => window.viewmaster.onMenuFindInFiles(() => setSearchOpen(true)), [])
```

Change to:

```ts
  const [searchOpen, setSearchOpen] = useState(false)
  const [relatedFilesOpen, setRelatedFilesOpen] = useState(false)

  useEffect(() => window.viewmaster.onMenuFindInFiles(() => setSearchOpen(true)), [])
  useEffect(() => window.viewmaster.onMenuRelatedFiles(() => setRelatedFilesOpen(true)), [])
```

Find:

```ts
  const onCloseSearch = useCallback((): void => setSearchOpen(false), [])
```

Add right after:

```ts
  const onCloseSearch = useCallback((): void => setSearchOpen(false), [])
  const onCloseRelatedFiles = useCallback((): void => setRelatedFilesOpen(false), [])
```

- [ ] **Step 5: Add the pane to the left-column layout**

Find the `SearchPane`'s `<Allotment.Pane>` (currently the last pane in the left column's vertical `Allotment`):

```tsx
            <Allotment.Pane visible={searchOpen} preferredSize={240} minSize={120}>
              <SearchPane
                key={repo?.root ?? 'none'}
                open={searchOpen}
                onSelectMatch={onSelectMatch}
                onClose={onCloseSearch}
              />
            </Allotment.Pane>
          </Allotment>
        </Allotment.Pane>
```

Change to:

```tsx
            <Allotment.Pane visible={searchOpen} preferredSize={240} minSize={120}>
              <SearchPane
                key={repo?.root ?? 'none'}
                open={searchOpen}
                onSelectMatch={onSelectMatch}
                onClose={onCloseSearch}
              />
            </Allotment.Pane>
            <Allotment.Pane visible={relatedFilesOpen} preferredSize={240} minSize={120}>
              <RelatedFilesPane
                key={repo?.root ?? 'none'}
                file={selected}
                workspaceRoot={repo?.root ?? ''}
                open={relatedFilesOpen}
                onNavigate={navigateTo}
                onClose={onCloseRelatedFiles}
              />
            </Allotment.Pane>
          </Allotment>
        </Allotment.Pane>
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/renderer/src/App.tsx
git commit -m "feat: wire RelatedFilesPane into the app layout via Related Files menu"
```

---

### Task 8: Manual end-to-end verification

**Files:** none (fixture files live in a scratch temp directory, not the repo).

No automated coverage exists for the panel's IPC round-trips, the client-side import resolution, or the aggregation across all three sections working together against the real running app — this task is the only place that verifies it actually works. Use the **run-viewmaster** skill to drive the app.

- [ ] **Step 1: Build a fixture folder**

```bash
mkdir -p /tmp/vm-related-fixture/src
cat > /tmp/vm-related-fixture/src/app.ts <<'EOF'
import { needleFunction } from './util'

export function callsNeedle(): string {
  return needleFunction()
}
EOF
cat > /tmp/vm-related-fixture/src/util.ts <<'EOF'
export function needleFunction(): string {
  return 'found the needle here'
}
EOF
cat > /tmp/vm-related-fixture/main.py <<'EOF'
from .helper import greet


def caller():
    return greet('World')
EOF
cat > /tmp/vm-related-fixture/helper.py <<'EOF'
def greet(name):
    return f"Hello, {name}!"
EOF
git -C /tmp/vm-related-fixture init -q
git -C /tmp/vm-related-fixture add -A
git -C /tmp/vm-related-fixture commit -q -m "init"
```

- [ ] **Step 2: TypeScript — verify all three sections for the importing file**

Open `/tmp/vm-related-fixture`, select `src/app.ts`, trigger "Related Files…" (menu or Cmd/Ctrl+Shift+R). Verify:
- "Imports" shows `src/util.ts`.
- "Imported by" shows nothing (nothing imports `app.ts` in this fixture) — confirm the section renders with "None found." rather than erroring or staying stuck loading.
- "References" shows nothing (no other file references anything `app.ts` itself declares).
- Clicking the `src/util.ts` row in "Imports" navigates the content pane to that file.

- [ ] **Step 3: TypeScript — verify the imported file's reverse edges**

Select `src/util.ts`, open Related Files again. Verify:
- "Imports" shows nothing.
- "Imported by" shows `src/app.ts` (the import-shape heuristic correctly matched `import { needleFunction } from './util'`).
- "References" shows `src/app.ts` (the declared symbol `needleFunction` is used there — via the same #7 `symbol:references` mechanism, independently confirmed working in issue #7's own verification).

- [ ] **Step 4: Python — verify relative-import resolution and the reverse edges**

Select `main.py`. Verify:
- "Imports" shows `helper.py` (resolved via the new relative-import extractor/resolver).
- "Imported by" shows nothing.
- "References" shows nothing.

Select `helper.py`. Verify:
- "Imports" shows nothing.
- "Imported by" shows `main.py`.
- "References" shows `main.py` (the declared symbol `greet` is used there).

- [ ] **Step 5: Verify the panel closes and reopens correctly on folder switch**

Click the panel's close (×) button — verify it collapses. Reopen via the menu — verify it still works for the currently selected file. (The `key={repo?.root ?? 'none'}` reset isn't independently testable without a second fixture folder in this task's scope — a full folder-switch check isn't required here, just confirm open/close itself works.)

- [ ] **Step 6: Clean up the fixture**

```bash
rm -rf /tmp/vm-related-fixture
```

- [ ] **Step 7: Final full-suite check**

Run: `npm run build`
Expected: typecheck + build both succeed.

No commit for this task (no repo files changed) — if any verification step surfaces a bug, fix it as a small follow-up commit referencing the task/step where it was found.
