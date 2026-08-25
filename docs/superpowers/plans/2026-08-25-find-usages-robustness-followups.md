# Find Usages Robustness Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three of the four robustness gaps tracked in issue #23 (find-usages/go-to-definition follow-ups): a same-file-jump misdetection for paths containing `#`/`?`, a case-sensitive extension allowlist, and a missing `truncated` flag on find-usages results.

**Architecture:** Item 2's actual fix lives in `CodeView.tsx` (sanitizing the string passed to `@monaco-editor/react`'s `path` prop before it reaches that library's internal `Uri.parse` call) rather than in `App.tsx`'s comparison code, since the data loss that causes the bug happens upstream of the comparison. Item 4 extracts an inline regex into an existing pure-function module (`resolveImports.ts`) so it gets real test coverage. Item 3 adds a `truncated: boolean` field to `SymbolLocationsResult` and threads it through all 4 IPC handlers that return that type, surfacing it in the UI only where a real display surface exists (`RelatedFilesPane.tsx`'s custom sections) — not in Monaco's native "Peek" widget, which has no hook for it.

**Tech Stack:** TypeScript, React, Monaco (`@monaco-editor/react` + `monaco-editor`), Electron IPC, Vitest.

**Spec:** No separate spec document — this was brainstormed as a **bounded** task (three well-scoped fixes to existing code) per the brainstorming skill's bounded path, which presents its design in chat rather than writing a spec file. The approved design is captured in full in this plan. Issue: [viewmaster#23](https://github.com/brucevanhorn2/viewmaster/issues/23). Item 1 from that issue (Monaco model lifecycle/disposal) was split out to its own issue, [viewmaster#30](https://github.com/brucevanhorn2/viewmaster/issues/30), and is explicitly **out of scope** for this plan.

## Global Constraints

- Scope is exactly: `src/renderer/src/components/CodeView.tsx` (items 2 and 4), a new `src/renderer/src/code/monacoPath.ts` (item 2), `src/renderer/src/code/resolveImports.ts` (item 4), `src/shared/types.ts` (item 3), `src/main/ipc.ts` (item 3), `src/renderer/src/components/RelatedFilesPane.tsx` (item 3), `src/renderer/src/styles.css` (item 3). Nothing else changes. In particular: `src/renderer/src/App.tsx`'s `registerEditorOpener` same-file check is **not modified** — item 2's real fix is entirely in `CodeView.tsx`, not there.
- Item 1 (Monaco model lifecycle/disposal, tracked in issue #30) is out of scope. Do not touch `keepCurrentModel` or add any disposal logic.
- This repo's vitest config (`vitest.config.ts`) only runs `src/**/*.test.ts` (not `.tsx`) in a plain `node` environment — there are zero component-level/jsdom tests anywhere in this codebase (no `CodeView.test.tsx`, `SearchPane.test.tsx`, or `RelatedFilesPane.test.tsx` exist). Do not attempt to add component-level tests for `CodeView.tsx` or `RelatedFilesPane.tsx` — this plan's testing strategy is pure-function unit tests plus `npm run typecheck`, matching the existing convention.
- `SymbolLocationsResult`'s new `truncated` field must be a **required** `boolean`, not `truncated?: boolean` — this makes the TypeScript compiler itself enforce that every returning code path in `src/main/ipc.ts`'s 4 handlers sets it (this repo has no `ipc.test.ts`; IPC handlers aren't unit tested here, so the type checker is the real regression guard for this task).
- Run `npm test` and `npm run typecheck` at the end of each task; both must be clean before committing.

---

### Task 1: Fix same-file jump misdetection (item 2) and case-sensitive extension check (item 4) in CodeView.tsx

**Files:**
- Create: `src/renderer/src/code/monacoPath.ts`
- Test: `src/renderer/src/code/monacoPath.test.ts`
- Modify: `src/renderer/src/code/resolveImports.ts` (add `isTsJsExtension`)
- Modify: `src/renderer/src/code/resolveImports.test.ts` (add tests for `isTsJsExtension`)
- Modify: `src/renderer/src/components/CodeView.tsx:1-8` (imports), `:68` (extension check), `:90` (path prop)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `encodeForMonacoPath(path: string): string` (from `monacoPath.ts`) and `isTsJsExtension(path: string): boolean` (from `resolveImports.ts`) — not consumed by Task 2, but listed for completeness.

- [ ] **Step 1: Write the failing test for `encodeForMonacoPath`**

Create `src/renderer/src/code/monacoPath.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { encodeForMonacoPath } from './monacoPath'

describe('encodeForMonacoPath', () => {
  it('percent-encodes a literal # so it is not read as a URI fragment delimiter', () => {
    expect(encodeForMonacoPath('/tmp/a#b.ts')).toBe('/tmp/a%23b.ts')
  })

  it('percent-encodes a literal ? so it is not read as a URI query delimiter', () => {
    expect(encodeForMonacoPath('/tmp/a?b.ts')).toBe('/tmp/a%3Fb.ts')
  })

  it('encodes both # and ? in the same path', () => {
    expect(encodeForMonacoPath('/tmp/a#b?c.ts')).toBe('/tmp/a%23b%3Fc.ts')
  })

  it('leaves an ordinary path with no special characters unchanged', () => {
    expect(encodeForMonacoPath('/tmp/plain/file.ts')).toBe('/tmp/plain/file.ts')
  })

  it('leaves a literal space unchanged (Uri.parse handles bare spaces correctly)', () => {
    expect(encodeForMonacoPath('/tmp/a b.ts')).toBe('/tmp/a b.ts')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/code/monacoPath.test.ts`
Expected: FAIL — `Cannot find module './monacoPath'` (the file doesn't exist yet).

- [ ] **Step 3: Implement `encodeForMonacoPath`**

Create `src/renderer/src/code/monacoPath.ts`:

```ts
/**
 * `@monaco-editor/react`'s `path` prop builds a model's URI via
 * `monaco.Uri.parse(path)`, which treats `#` and `?` as URI fragment/query
 * delimiters and strips everything after them from `.fsPath` — permanently
 * losing that suffix from the model's own URI object. Every other URI in
 * this app is built via `monaco.Uri.file(...)`, which treats the whole
 * string as a literal filesystem path with no such splitting. Percent-
 * encoding `#`/`?` before handing a path to `Uri.parse` (via this function)
 * makes it decode back to the correct literal path, matching what
 * `Uri.file` would have produced — verified empirically against this
 * repo's bundled monaco-editor package.
 */
export function encodeForMonacoPath(path: string): string {
  return path.replace(/#/g, '%23').replace(/\?/g, '%3F')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/code/monacoPath.test.ts`
Expected: PASS (5/5 tests).

- [ ] **Step 5: Write the failing test for `isTsJsExtension`**

Read `src/renderer/src/code/resolveImports.test.ts` first to see its existing `describe`/`it` structure and match its style. Add a new `describe` block to that file (do not remove any existing tests):

```ts
describe('isTsJsExtension', () => {
  it('accepts standard lowercase TS/JS extensions', () => {
    expect(isTsJsExtension('/a/b.ts')).toBe(true)
    expect(isTsJsExtension('/a/b.tsx')).toBe(true)
    expect(isTsJsExtension('/a/b.d.ts')).toBe(true)
    expect(isTsJsExtension('/a/b.js')).toBe(true)
    expect(isTsJsExtension('/a/b.jsx')).toBe(true)
    expect(isTsJsExtension('/a/b.mjs')).toBe(true)
    expect(isTsJsExtension('/a/b.cjs')).toBe(true)
    expect(isTsJsExtension('/a/b.cts')).toBe(true)
    expect(isTsJsExtension('/a/b.mts')).toBe(true)
  })

  it('accepts uppercase extensions (case-insensitive)', () => {
    expect(isTsJsExtension('/a/b.TS')).toBe(true)
    expect(isTsJsExtension('/a/b.TSX')).toBe(true)
    expect(isTsJsExtension('/a/b.Js')).toBe(true)
  })

  it('rejects non-TS/JS extensions', () => {
    expect(isTsJsExtension('/a/b.css')).toBe(false)
    expect(isTsJsExtension('/a/b.json')).toBe(false)
    expect(isTsJsExtension('/a/b')).toBe(false)
  })
})
```

Add `isTsJsExtension` to the existing `import { ... } from './resolveImports'` line at the top of the test file.

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/code/resolveImports.test.ts`
Expected: FAIL — `isTsJsExtension is not a function` (or a TypeScript error that it doesn't exist / isn't exported).

- [ ] **Step 7: Implement `isTsJsExtension` in resolveImports.ts**

Read `src/renderer/src/code/resolveImports.ts` in full first to confirm its current exact content still matches what's described below (it should be unchanged since this plan was written). Add this new exported function anywhere after the existing `CANDIDATE_SUFFIXES` constant (e.g. directly above `candidateImportPaths`):

```ts
/**
 * True when `path` ends in a recognized TS/JS source extension
 * (case-insensitive) — used to filter import-preload candidates so a
 * non-TS/JS resolved path (e.g. `./styles.css`) is never registered as a
 * 'typescript'/'javascript' Monaco model.
 */
export function isTsJsExtension(path: string): boolean {
  return /\.(ts|tsx|d\.ts|js|jsx|mjs|cjs|cts|mts)$/i.test(path)
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/code/resolveImports.test.ts`
Expected: PASS (all existing tests plus the 3 new ones in the `isTsJsExtension` describe block).

- [ ] **Step 9: Wire both fixes into CodeView.tsx**

Read `src/renderer/src/components/CodeView.tsx` in full first to confirm it still matches. Current top-of-file imports (lines 1-7):

```ts
import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import * as monaco from 'monaco-editor'
import '../monacoSetup'
import { languageForFile } from '../monacoSetup'
import { extractImportSpecifiers, candidateImportPaths } from '../code/resolveImports'
```

Change the last import line and add a new one:

```ts
import { extractImportSpecifiers, candidateImportPaths, isTsJsExtension } from '../code/resolveImports'
import { encodeForMonacoPath } from '../code/monacoPath'
```

Current line 68 (inside the import-preload effect's inner loop):

```ts
          if (!/\.(ts|tsx|d\.ts|js|jsx|mjs|cjs|cts|mts)$/.test(candidate)) continue
```

Replace with:

```ts
          if (!isTsJsExtension(candidate)) continue
```

Current line 90 (the `<Editor>` element's `path` prop):

```ts
      path={absPath}
```

Replace with:

```ts
      path={encodeForMonacoPath(absPath)}
```

Do not change anything else in this file — `keepCurrentModel={true}` (line 91) stays exactly as it is (item 1 is out of scope, tracked separately in issue #30).

- [ ] **Step 10: Typecheck and run the full test suite**

Run: `npm run typecheck && npm test`
Expected: no typecheck errors; all tests pass, including the new ones from Steps 1-8.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/code/monacoPath.ts src/renderer/src/code/monacoPath.test.ts src/renderer/src/code/resolveImports.ts src/renderer/src/code/resolveImports.test.ts src/renderer/src/components/CodeView.tsx
git commit -m "fix: correct same-file URI comparison and case-sensitive extension check

CodeView's <Editor path={absPath}> prop fed the raw path straight into
@monaco-editor/react's internal Uri.parse call, which treats # and ? as
URI syntax and silently truncates .fsPath at them -- permanently losing
that suffix from the model's own URI, which made App.tsx's same-file
jump check misfire for paths containing either character. Percent-
encoding # and ? before the path prop (encodeForMonacoPath) fixes it at
the source; the comparison in App.tsx needed no change since the data
loss happened upstream of it.

Also extracted the import-preload extension allowlist into a tested,
case-insensitive isTsJsExtension() in resolveImports.ts.

Addresses items 2 and 4 of #23."
```

---

### Task 2: Add a `truncated` flag to find-usages/related-files results

**Files:**
- Modify: `src/shared/types.ts` (`SymbolLocationsResult` interface)
- Modify: `src/main/ipc.ts` (4 handlers: `symbol:definitions`, `symbol:references`, `related:importedBy`, `related:references`)
- Modify: `src/renderer/src/components/RelatedFilesPane.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `SymbolLocationsResult` now has a required `truncated: boolean` field — any other code constructing this type (there is none outside `ipc.ts`, confirmed by this task) would need updating too.

- [ ] **Step 1: Update the type**

Read `src/shared/types.ts` around the `SearchResult`/`SymbolLocation`/`SymbolLocationsResult` interfaces first to confirm current content. Current `SymbolLocationsResult`:

```ts
export interface SymbolLocationsResult {
  locations: SymbolLocation[]
  error?: string
}
```

Change to:

```ts
export interface SymbolLocationsResult {
  locations: SymbolLocation[]
  truncated: boolean
  error?: string
}
```

- [ ] **Step 2: Run typecheck to see every call site that now needs updating**

Run: `npm run typecheck`
Expected: FAIL — TypeScript reports every object literal in `src/main/ipc.ts` returned as `SymbolLocationsResult` that's missing the new required `truncated` property (this is the "failing test" for this task, since there is no dedicated `ipc.test.ts` in this repo — the compiler is the test).

- [ ] **Step 3: Fix the `symbol:definitions` handler**

Read `src/main/ipc.ts` around this handler first to confirm it still matches. Current text:

```ts
    'symbol:definitions',
    async (_e, word: string): Promise<SymbolLocationsResult> => {
      currentDefinitionsController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [] }
      const controller = new AbortController()
      currentDefinitionsController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches } = await searchFiles(activeSession.root, paths, word, {
          signal: controller.signal,
          startedAt,
          mode: 'word',
          caseSensitive: true,
          lineFilter: (line) => looksLikeDefinition(line, word)
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

Replace with (changes: early-return gets `truncated: false`; `truncated` destructured from `searchFiles`'s result and included in the success return; catch block gets `truncated: false`):

```ts
    'symbol:definitions',
    async (_e, word: string): Promise<SymbolLocationsResult> => {
      currentDefinitionsController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [], truncated: false }
      const controller = new AbortController()
      currentDefinitionsController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches, truncated } = await searchFiles(activeSession.root, paths, word, {
          signal: controller.signal,
          startedAt,
          mode: 'word',
          caseSensitive: true,
          lineFilter: (line) => looksLikeDefinition(line, word)
        })
        const seen = new Set<string>()
        const locations: SymbolLocation[] = []
        for (const m of matches) {
          const key = `${m.absPath}:${m.line}`
          if (seen.has(key)) continue
          seen.add(key)
          locations.push({ path: m.path, absPath: m.absPath, line: m.line, column: m.column })
        }
        return { locations, truncated }
      } catch (err) {
        return { locations: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
```

- [ ] **Step 4: Fix the `symbol:references` handler**

Current text:

```ts
    'symbol:references',
    async (_e, word: string): Promise<SymbolLocationsResult> => {
      currentReferencesController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [] }
      const controller = new AbortController()
      currentReferencesController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches } = await searchFiles(activeSession.root, paths, word, {
          signal: controller.signal,
          startedAt,
          mode: 'word',
          caseSensitive: true
        })
        const locations: SymbolLocation[] = matches.map((m) => ({
          path: m.path,
          absPath: m.absPath,
          line: m.line,
          column: m.column
        }))
        return { locations }
      } catch (err) {
        return { locations: [], error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
```

Replace with:

```ts
    'symbol:references',
    async (_e, word: string): Promise<SymbolLocationsResult> => {
      currentReferencesController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [], truncated: false }
      const controller = new AbortController()
      currentReferencesController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches, truncated } = await searchFiles(activeSession.root, paths, word, {
          signal: controller.signal,
          startedAt,
          mode: 'word',
          caseSensitive: true
        })
        const locations: SymbolLocation[] = matches.map((m) => ({
          path: m.path,
          absPath: m.absPath,
          line: m.line,
          column: m.column
        }))
        return { locations, truncated }
      } catch (err) {
        return { locations: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
```

- [ ] **Step 5: Fix the `related:importedBy` handler**

Current text:

```ts
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

Replace with:

```ts
    'related:importedBy',
    async (_e, basename: string): Promise<SymbolLocationsResult> => {
      currentImportedByController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [], truncated: false }
      const controller = new AbortController()
      currentImportedByController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches, truncated } = await searchFiles(activeSession.root, paths, basename, {
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
        return { locations, truncated }
      } catch (err) {
        return { locations: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
```

- [ ] **Step 6: Fix the `related:references` handler**

Current text:

```ts
    'related:references',
    async (_e, names: string[]): Promise<SymbolLocationsResult> => {
      currentRelatedReferencesController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [] }
      if (names.length === 0) return { locations: [] }
      const controller = new AbortController()
      currentRelatedReferencesController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches } = await searchFiles(activeSession.root, paths, names[0], {
          signal: controller.signal,
          startedAt,
          mode: 'word',
          caseSensitive: true,
          words: names
        })
        const locations: SymbolLocation[] = matches.map((m) => ({
          path: m.path,
          absPath: m.absPath,
          line: m.line,
          column: m.column
        }))
        return { locations }
      } catch (err) {
        return { locations: [], error: err instanceof Error ? err.message : String(err) }
      }
    }
```

Replace with:

```ts
    'related:references',
    async (_e, names: string[]): Promise<SymbolLocationsResult> => {
      currentRelatedReferencesController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [], truncated: false }
      if (names.length === 0) return { locations: [], truncated: false }
      const controller = new AbortController()
      currentRelatedReferencesController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches, truncated } = await searchFiles(activeSession.root, paths, names[0], {
          signal: controller.signal,
          startedAt,
          mode: 'word',
          caseSensitive: true,
          words: names
        })
        const locations: SymbolLocation[] = matches.map((m) => ({
          path: m.path,
          absPath: m.absPath,
          line: m.line,
          column: m.column
        }))
        return { locations, truncated }
      } catch (err) {
        return { locations: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
```

- [ ] **Step 7: Run typecheck to confirm all 4 handlers are fixed**

Run: `npm run typecheck`
Expected: PASS — no more missing-`truncated` errors. If any remain, find and fix that return site the same way (add `truncated: false` to an early/error return, or destructure and forward `truncated` from a `searchFiles` call).

- [ ] **Step 8: Surface truncation in RelatedFilesPane.tsx**

Read `src/renderer/src/components/RelatedFilesPane.tsx` in full first to confirm it still matches. Current state declarations (near the top of the component):

```ts
  const [imports, setImports] = useState<RelatedFile[]>([])
  const [importedBy, setImportedBy] = useState<RelatedFile[]>([])
  const [references, setReferences] = useState<RelatedFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [language, setLanguage] = useState('plaintext')
```

Add two new state variables:

```ts
  const [imports, setImports] = useState<RelatedFile[]>([])
  const [importedBy, setImportedBy] = useState<RelatedFile[]>([])
  const [importedByTruncated, setImportedByTruncated] = useState(false)
  const [references, setReferences] = useState<RelatedFile[]>([])
  const [referencesTruncated, setReferencesTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [language, setLanguage] = useState('plaintext')
```

Current top of the effect body (the reset block):

```ts
  useEffect(() => {
    setImports([])
    setImportedBy([])
    setReferences([])
    setError(null)
```

Add the two new resets:

```ts
  useEffect(() => {
    setImports([])
    setImportedBy([])
    setImportedByTruncated(false)
    setReferences([])
    setReferencesTruncated(false)
    setError(null)
```

Current "Imported by" handling inside the effect:

```ts
        if (importedByPromise) {
          const result = await importedByPromise
          if (result.error) throw new Error(result.error)
          if (!cancelled) {
            setImportedBy(aggregateReferences([result.locations], file.absPath))
          }
        }
```

Replace with:

```ts
        if (importedByPromise) {
          const result = await importedByPromise
          if (result.error) throw new Error(result.error)
          if (!cancelled) {
            setImportedBy(aggregateReferences([result.locations], file.absPath))
            setImportedByTruncated(result.truncated)
          }
        }
```

Current "References" handling inside the effect:

```ts
        const names = extractDeclaredNames(content.content)
        if (names.length > 0) {
          const result = await window.viewmaster.findRelatedReferences(names)
          if (result.error) throw new Error(result.error)
          if (!cancelled) {
            setReferences(aggregateReferences([result.locations], file.absPath))
          }
        }
```

Replace with:

```ts
        const names = extractDeclaredNames(content.content)
        if (names.length > 0) {
          const result = await window.viewmaster.findRelatedReferences(names)
          if (result.error) throw new Error(result.error)
          if (!cancelled) {
            setReferences(aggregateReferences([result.locations], file.absPath))
            setReferencesTruncated(result.truncated)
          }
        }
```

Current `renderSection` helper:

```ts
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
```

Replace with (new optional third parameter, defaulting to `false`; a truncation note rendered after the list/empty-state):

```ts
  const renderSection = (
    title: string,
    items: RelatedFile[],
    truncated: boolean = false
  ): React.JSX.Element => (
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
      {truncated && (
        <div className="related-files-truncated">Showing partial results — some matches may be missing.</div>
      )}
    </div>
  )
```

Current render call sites:

```ts
          {supportsImportEdges(language) && renderSection('Imports', imports)}
          {supportsImportEdges(language) && renderSection('Imported by', importedBy)}
          {renderSection('References', references)}
```

Replace with:

```ts
          {supportsImportEdges(language) && renderSection('Imports', imports)}
          {supportsImportEdges(language) && renderSection('Imported by', importedBy, importedByTruncated)}
          {renderSection('References', references, referencesTruncated)}
```

(`'Imports'` intentionally keeps no third argument — it's resolved client-side from already-read file content, not from a scan-capped IPC call, so there's no truncation concept for it.)

- [ ] **Step 9: Add the CSS rule**

Read `src/renderer/src/styles.css` around the existing `.related-files-*` rules first to confirm current content. Add this new rule near the other `.related-files-*` rules (e.g. directly after `.related-files-empty`):

```css
.related-files-truncated {
  padding: 8px 10px;
  color: #d7ba7d;
  font-size: 11px;
}
```

- [ ] **Step 10: Typecheck and run the full test suite**

Run: `npm run typecheck && npm test`
Expected: no typecheck errors; all existing tests still pass (this task adds no new test files, per the Global Constraints — verification here is entirely via the type checker, matching this repo's existing convention of not unit-testing `ipc.ts`/component files).

- [ ] **Step 11: Commit**

```bash
git add src/shared/types.ts src/main/ipc.ts src/renderer/src/components/RelatedFilesPane.tsx src/renderer/src/styles.css
git commit -m "feat: add truncated flag to find-usages/related-files results

SymbolLocationsResult previously had no way to signal that an
underlying scan hit its match cap, unlike SearchResult. Threaded
searchFiles' existing truncated value through all 4 IPC handlers
that return this type (making the field required so the compiler
catches any missed return site). Surfaced it as a banner in
RelatedFilesPane's Imported-by/References sections, matching
SearchPane's existing truncated-results pattern -- left unsurfaced
for symbol:definitions/symbol:references, which feed Monaco's native
Peek widget with no hook for extra banner content.

Addresses item 3 of #23."
```
