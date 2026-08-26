# Monaco Model Disposal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound how many Monaco text models can accumulate over a session — dispose everything on a folder switch, and cap the number of distinct models alive at once within one folder session via LRU eviction.

**Architecture:** A new module, `src/renderer/src/code/modelLru.ts`, splits the LRU bookkeeping into two functions: `touchKey` (a pure, fully-testable function operating on a plain `Map<string, true>` and an injected dispose callback — no `monaco-editor` dependency at all) and `touchModel` (a thin production wrapper around it that imports real `monaco` and is used directly at the two call sites in `CodeView.tsx`). `App.tsx`'s `openFolder` callback gets one new line disposing every Monaco model on folder switch.

**Spec:** `docs/superpowers/specs/2026-08-26-monaco-model-disposal-design.md`

## Global Constraints

- `MODEL_CAP = 60` (module-level constant in `CodeView.tsx`) — already confirmed with Bruce, do not change this value.
- `keepCurrentModel={true}` on `CodeView.tsx`'s `<Editor>` stays exactly as it is — this plan bounds how many *different* files' models can exist, not whether the same file's model is reused on revisit.
- No test file for `App.tsx` or `CodeView.tsx` themselves (component-level, untestable per this repo's existing convention — zero `.tsx` test files exist anywhere). `touchKey` (the actual LRU algorithm) must be genuinely unit-tested; `touchModel` (the thin real-`monaco` wrapper) does not need its own test — its correctness follows from `touchKey`'s tested correctness plus trusting Monaco's own `Uri`/`editor` API.
- Run `npm run typecheck` and `npm test` at the end of each task; both must be clean before committing.

---

### Task 1: Create modelLru.ts with a testable LRU core and a thin production wrapper

**Files:**
- Create: `src/renderer/src/code/modelLru.ts`
- Test: `src/renderer/src/code/modelLru.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `touchModel(uri: monaco.Uri, cap: number): void`, consumed by Task 2's `CodeView.tsx` call sites. (`touchKey` is exported too, for its own tests, but Task 2 never calls it directly.)

- [ ] **Step 1: Write the failing tests for `touchKey`**

Create `src/renderer/src/code/modelLru.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { touchKey } from './modelLru'

describe('touchKey', () => {
  it('does not evict anything while under the cap', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 3, (k) => disposed.push(k))
    touchKey(map, 'b', 3, (k) => disposed.push(k))
    touchKey(map, 'c', 3, (k) => disposed.push(k))
    expect([...map.keys()]).toEqual(['a', 'b', 'c'])
    expect(disposed).toEqual([])
  })

  it('evicts the least-recently-used key once the cap is exceeded', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 2, (k) => disposed.push(k))
    touchKey(map, 'b', 2, (k) => disposed.push(k))
    touchKey(map, 'c', 2, (k) => disposed.push(k))
    expect([...map.keys()]).toEqual(['b', 'c'])
    expect(disposed).toEqual(['a'])
  })

  it('re-touching an existing key moves it to most-recently-used instead of duplicating it', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 2, (k) => disposed.push(k))
    touchKey(map, 'b', 2, (k) => disposed.push(k))
    touchKey(map, 'a', 2, (k) => disposed.push(k)) // re-touch 'a' -- now 'b' is oldest
    touchKey(map, 'c', 2, (k) => disposed.push(k)) // exceeds cap -- 'b' should be evicted, not 'a'
    expect([...map.keys()]).toEqual(['a', 'c'])
    expect(disposed).toEqual(['b'])
  })

  it('evicts multiple keys in one call if several are over the cap at once', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 5, (k) => disposed.push(k))
    touchKey(map, 'b', 5, (k) => disposed.push(k))
    touchKey(map, 'c', 5, (k) => disposed.push(k))
    // Lower the cap to 1 on this next touch -- both 'a' and 'b' must go, only the
    // just-touched 'd' (and whatever was already under the new cap) should survive.
    touchKey(map, 'd', 1, (k) => disposed.push(k))
    expect([...map.keys()]).toEqual(['d'])
    expect(disposed).toEqual(['a', 'b', 'c'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/renderer/src/code/modelLru.test.ts`
Expected: FAIL — `Cannot find module './modelLru'` (the file doesn't exist yet).

- [ ] **Step 3: Implement `touchKey` and `touchModel`**

Create `src/renderer/src/code/modelLru.ts`:

```ts
import * as monaco from 'monaco-editor'

/**
 * Moves `key` to the most-recently-used end of `map` (a `Map`'s iteration
 * order is insertion order, so delete-then-reinsert moves it to the end),
 * then evicts from the least-recently-used end (the front) via `dispose`
 * until `map.size` is back at or under `cap`.
 *
 * Pure and dependency-free on purpose -- this is the actual LRU algorithm,
 * fully unit-testable without importing monaco-editor at all. `touchModel`
 * below is the thin, real-monaco production wrapper around it.
 */
export function touchKey(
  map: Map<string, true>,
  key: string,
  cap: number,
  dispose: (key: string) => void
): void {
  map.delete(key)
  map.set(key, true)
  while (map.size > cap) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
    dispose(oldest)
  }
}

const tracked = new Map<string, true>()

/**
 * Marks `uri`'s model as most-recently-used, evicting (disposing) the
 * least-recently-used tracked models once more than `cap` are tracked at
 * once. Safe to call whether or not `uri`'s model has been created yet --
 * eviction looks the model up via `monaco.editor.getModel` at eviction
 * time, so a key evicted after its model was already disposed some other
 * way (e.g. a folder-switch clear elsewhere) is just a harmless no-op via
 * the `?.dispose()` optional chain.
 */
export function touchModel(uri: monaco.Uri, cap: number): void {
  touchKey(tracked, uri.toString(), cap, (key) => {
    monaco.editor.getModel(monaco.Uri.parse(key))?.dispose()
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/src/code/modelLru.test.ts`
Expected: PASS (4/4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/code/modelLru.ts src/renderer/src/code/modelLru.test.ts
git commit -m "feat: add LRU-based Monaco model tracking (modelLru.ts)

touchKey is the pure, fully-tested LRU algorithm (plain Map + injected
dispose callback, no monaco-editor dependency); touchModel is the thin
production wrapper importing real monaco, used by CodeView.tsx in the
next task. Not yet wired into anything.

Part of #30."
```

---

### Task 2: Wire touchModel into CodeView.tsx and add the folder-switch clear to App.tsx

**Files:**
- Modify: `src/renderer/src/components/CodeView.tsx`
- Modify: `src/renderer/src/App.tsx:70-75`

**Interfaces:**
- Consumes: `touchModel(uri: monaco.Uri, cap: number): void` from Task 1's `src/renderer/src/code/modelLru.ts`.
- Produces: nothing further downstream — this is the final integration task.

- [ ] **Step 1: Add the import and MODEL_CAP constant to CodeView.tsx**

Read `src/renderer/src/components/CodeView.tsx` in full first to confirm it still matches (it should be unchanged since this plan was written). Current imports (lines 1-8):

```ts
import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import * as monaco from 'monaco-editor'
import '../monacoSetup'
import { languageForFile } from '../monacoSetup'
import { extractImportSpecifiers, candidateImportPaths, isTsJsExtension } from '../code/resolveImports'
import { encodeForMonacoPath } from '../code/monacoPath'
```

Add one import line, and add the `MODEL_CAP` constant right after the imports:

```ts
import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import * as monaco from 'monaco-editor'
import '../monacoSetup'
import { languageForFile } from '../monacoSetup'
import { extractImportSpecifiers, candidateImportPaths, isTsJsExtension } from '../code/resolveImports'
import { encodeForMonacoPath } from '../code/monacoPath'
import { touchModel } from '../code/modelLru'

// Bounds how many distinct files' Monaco models can accumulate at once
// within one open folder (see docs/superpowers/specs/2026-08-26-monaco-
// model-disposal-design.md) -- generous enough that ordinary browsing
// never triggers eviction, while bounding the real worst case of a long
// session touching hundreds of files in one large repo.
const MODEL_CAP = 60
```

- [ ] **Step 2: Touch the main displayed file's own model**

Current code right after the imports (the component's opening lines, roughly lines 9-22 before this plan's edits — read the live file to find the exact spot, it's right after the two existing `useEffect` blocks and before the `return (`):

```ts
  useEffect(() => {
    const language = languageForFile(fileName)
    if (language !== 'typescript' && language !== 'javascript') return
    let cancelled = false
    const lastSlash = absPath.lastIndexOf('/')
    const fromDir = lastSlash === -1 ? absPath : absPath.slice(0, lastSlash)
    const specifiers = extractImportSpecifiers(content)
    void Promise.all(
      specifiers.map(async (specifier) => {
        for (const candidate of candidateImportPaths(fromDir, specifier)) {
          if (cancelled) return
          if (!isTsJsExtension(candidate)) continue
          const uri = monaco.Uri.file(candidate)
          if (monaco.editor.getModel(uri)) return
          const result = await window.viewmaster.readFile(candidate)
          if (cancelled || result.kind !== 'text') continue
          if (!monaco.editor.getModel(uri)) {
            monaco.editor.createModel(result.content, languageForFile(candidate), uri)
          }
          return
        }
      })
    )
    return () => {
      cancelled = true
    }
  }, [fileName, absPath, content])

  return (
```

Insert a new effect between that effect and `return (`, and update the import-preload effect's two touch points (both changes shown together below since they're adjacent):

```ts
  useEffect(() => {
    const language = languageForFile(fileName)
    if (language !== 'typescript' && language !== 'javascript') return
    let cancelled = false
    const lastSlash = absPath.lastIndexOf('/')
    const fromDir = lastSlash === -1 ? absPath : absPath.slice(0, lastSlash)
    const specifiers = extractImportSpecifiers(content)
    void Promise.all(
      specifiers.map(async (specifier) => {
        for (const candidate of candidateImportPaths(fromDir, specifier)) {
          if (cancelled) return
          if (!isTsJsExtension(candidate)) continue
          const uri = monaco.Uri.file(candidate)
          if (monaco.editor.getModel(uri)) {
            touchModel(uri, MODEL_CAP)
            return
          }
          const result = await window.viewmaster.readFile(candidate)
          if (cancelled || result.kind !== 'text') continue
          if (!monaco.editor.getModel(uri)) {
            monaco.editor.createModel(result.content, languageForFile(candidate), uri)
          }
          touchModel(uri, MODEL_CAP)
          return
        }
      })
    )
    return () => {
      cancelled = true
    }
  }, [fileName, absPath, content])

  // Tracks the main displayed file's own model for LRU eviction, keyed the
  // same deterministic way its `path` prop below is computed -- reading
  // editorInstance.getModel() instead would risk a one-render-behind race
  // against @monaco-editor/react's own internal model-switch effect.
  useEffect(() => {
    touchModel(monaco.Uri.parse(encodeForMonacoPath(absPath)), MODEL_CAP)
  }, [absPath])

  return (
```

- [ ] **Step 3: Typecheck and run the full test suite**

Run: `npm run typecheck && npm test`
Expected: no typecheck errors; all tests pass (this step adds no new test files for `CodeView.tsx` itself, per the Global Constraints).

- [ ] **Step 4: Add the folder-switch clear to App.tsx**

Read `src/renderer/src/App.tsx` in full first to confirm it still matches (it should be unchanged — `monaco` is already imported at the top of the file for `registerEditorOpener`, confirmed). Current `openFolder` callback (lines 70-75):

```ts
  const openFolder = useCallback((root: string): void => {
    void window.viewmaster.openRepo(root).then((state) => {
      setRepo(state)
      setNavState(initialNavigationState())
    })
  }, [])
```

Replace with:

```ts
  const openFolder = useCallback((root: string): void => {
    // Nothing from the previous folder is relevant to the new one -- a
    // complete, unconditional reset (even when reopening the same folder
    // from Recents) is simplest and correct. See docs/superpowers/specs/
    // 2026-08-26-monaco-model-disposal-design.md.
    monaco.editor.getModels().forEach((model) => model.dispose())
    void window.viewmaster.openRepo(root).then((state) => {
      setRepo(state)
      setNavState(initialNavigationState())
    })
  }, [])
```

- [ ] **Step 5: Typecheck and run the full test suite again**

Run: `npm run typecheck && npm test`
Expected: no typecheck errors; all tests pass.

- [ ] **Step 6: Manual smoke check — folder switch with no console errors**

Use the `run-viewmaster` skill. Build and launch the app against a real folder with at least one TypeScript/JavaScript file, open that file (so it has a live Monaco model), then trigger opening a *different* folder (e.g. via the "Open Recent" list if two folders are available, or reuse the skill's own fixture-switching approach). Use the driver's `eval` command to check for any errors surfaced to the page (e.g. `eval window.__vmTestErrors ?? 'no error hook, check console output directly'` is not needed -- simplest is to watch the driver's own console/log output during the folder-switch action for any uncaught exception text). Confirm: no uncaught exception appears in the driver's output when the folder switch happens, and the new folder's files still open and render correctly afterward (this exercises the known risk flagged in the spec: disposing all models while the old folder's `CodeView` may still be mid-unmount).

- [ ] **Step 7: Manual smoke check — LRU eviction actually fires**

Temporarily change `MODEL_CAP` from `60` to `2` in `CodeView.tsx` (do not commit this change). Using the `run-viewmaster` skill, open a folder with at least 4 distinct TypeScript/JavaScript files and open 4 of them one after another (e.g. via `click` on each file in the sidebar, or the driver's file-opening mechanism). After opening the 4th file, use `eval monaco.editor.getModels().length` — if this errors because `monaco` isn't reachable as a global in the page's `eval` context, instead confirm indirectly: the app should still be fully functional after opening all 4 files (no crash, no broken editor, no console errors), which is the behavior that matters — the exact count assertion is a nice-to-have, not required if `monaco` isn't globally reachable from the driver's `eval`. Revert `MODEL_CAP` back to `60` before Step 8's commit — verify with `grep -n "MODEL_CAP = " src/renderer/src/components/CodeView.tsx` that it reads `60` again before committing.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/CodeView.tsx src/renderer/src/App.tsx
git commit -m "feat: dispose Monaco models on folder switch, cap per-session count via LRU

CodeView.tsx now touches the main displayed file's model and each
import-preload model through the new modelLru.ts, bounding how many
can accumulate within one folder session (MODEL_CAP = 60). App.tsx's
openFolder now disposes every existing model on switch, since nothing
from the previous folder is relevant to the new one.

Resolves #30."
```
