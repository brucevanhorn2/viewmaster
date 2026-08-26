# Monaco Model Disposal Design

## Problem

`CodeView.tsx`'s `<Editor keepCurrentModel={true} .../>` plus its import-preload
effect (`monaco.editor.createModel(...)` for a file's direct local imports, so
cross-file go-to-definition/find-usages works before the target file has been
opened) mean Monaco text models — and the TypeScript worker's underlying
program built from them — accumulate for the entire lifetime of the renderer
process. There is no ceiling and no cleanup hook anywhere. Not a correctness
bug today, but a real concern for long sessions browsing many files in a
large codebase, or across many folder switches in one continuous run of the
app. Split out from issue [#23](https://github.com/brucevanhorn2/viewmaster/issues/23)
item 1 for its own design; resolves [#30](https://github.com/brucevanhorn2/viewmaster/issues/30).

## Scope

Two disposal mechanisms, confirmed with Bruce as both wanted together:

1. **Folder-switch clear** — dispose every Monaco model in existence when a
   different folder is opened.
2. **LRU cap within a session** — bound the number of models that can
   accumulate while browsing many files inside one open folder, evicting the
   least-recently-used ones once a cap is exceeded.

Out of scope: anything about the TypeScript worker/language-service program
itself beyond what naturally follows from disposing its underlying models;
any change to `keepCurrentModel` itself (it stays `true` — same-file
re-visits still reuse a model, this design only bounds how many *different*
files' models can exist at once, and clears them all on a folder switch).

## Design

### Folder-switch clear

`App.tsx`'s `openFolder` callback (currently lines 70-75) is the single
place a new folder gets opened, whether via the dialog, a menu click, "Open
Recent", or (as of issue #32) a CLI path argument — all of them funnel
through this one callback. Add one line there, disposing every model Monaco
currently knows about:

```ts
const openFolder = useCallback((root: string): void => {
  monaco.editor.getModels().forEach((model) => model.dispose())
  void window.viewmaster.openRepo(root).then((state) => {
    setRepo(state)
    setNavState(initialNavigationState())
  })
}, [])
```

This runs synchronously, before `openRepo`'s async work even starts —
nothing from the previous folder is relevant to the new one, so a complete,
unconditional reset (even when reopening the *same* folder from Recents) is
simplest and correct. `monaco` is already imported in `App.tsx` (used by
`registerEditorOpener`), so no new import is needed.

**Known risk, needs explicit manual verification (not just assumed):**
Disposing every model here happens before React unmounts whichever
`CodeView` was displaying the old folder's file. `@monaco-editor/react`'s
own cleanup (on that component's unmount) also calls `.dispose()` on its
model. Monaco's `Disposable.dispose()` is expected to be idempotent — a
second call should be a safe no-op — but this must be manually verified
(switch folders while a file is open, confirm zero console errors) rather
than assumed correct from reading the source alone.

### LRU cap within a session

New file `src/renderer/src/code/modelLru.ts`, exporting one function:

```ts
export function touchModel(uri: monaco.Uri, cap: number): void
```

Internally, an ordered `Map<string, true>` keyed by `uri.toString()` acts as
the LRU structure — `touchModel` deletes-then-reinserts the key (moving it to
the "most recently used" end, which for a JS `Map` is insertion order), then
while the map's size exceeds `cap`, disposes and removes entries from the
front (least-recently-used) via `monaco.editor.getModel(monaco.Uri.parse(key))?.dispose()`.

Two call sites in `CodeView.tsx`:

1. **The main displayed file's own model** — a new small effect, keyed on
   `[absPath]` alone (not on `editorInstance`, to avoid any dependency on
   `@monaco-editor/react`'s own internal model-switch effect timing — safer
   to compute the URI ourselves the same deterministic way the `path` prop
   already does, than to read it back off `editorInstance.getModel()` and
   risk a one-render-behind race):
   ```ts
   useEffect(() => {
     touchModel(monaco.Uri.parse(encodeForMonacoPath(absPath)), MODEL_CAP)
   }, [absPath])
   ```
2. **Each import-preload model** — inside the existing import-preload
   effect, right after the existing `if (monaco.editor.getModel(uri)) return`
   check (touch on reuse too, not just on creation) and right after the
   `monaco.editor.createModel(...)` call (touch on creation).

**Correction (found during implementation, see the implementation plan's
Task 2 fix commit):** the paragraph above, as originally written, assumed
the displayed file's own touch and its import-preload touches happen in the
same render and so can never reorder relative to each other. That assumption
is false — the import-preload effect's touches happen *asynchronously*
(each after `await window.viewmaster.readFile(...)`), strictly after the
displayed file's own synchronous `[absPath]` touch. This means the displayed
file's own model routinely ends up as the least-recently-used tracked entry
relative to its own imports, and a file with enough imports could evict the
very model the editor is showing — a blank editor pane, reproduced live
during Task 2's manual verification.

The actual fix: `touchModel`'s eviction never disposes a model that is
currently attached to an editor (`monaco.editor.ITextModel.isAttachedToEditor()`,
queried live on every eviction pass, never cached) — such a model is instead
re-inserted at the most-recently-used end and eviction moves on to the
next-oldest candidate. This makes `MODEL_CAP` a bound on *evictable* entries
rather than a hard ceiling (in practice, at most one entry — the one visible
model — can ever refuse eviction at a time, so the real ceiling is
`MODEL_CAP + 1`). An evicted import-preload model is still not a correctness
problem: the existing `if (monaco.editor.getModel(uri)) return` check in the
import-preload effect already handles "does this model still exist" and will
simply recreate it on next need — a minor performance cost, not a bug.

**Cap value:** `MODEL_CAP = 60`, a module-level constant in `CodeView.tsx`
(or wherever the plan's implementer finds cleanest to place it alongside the
`touchModel` call sites) — generous enough that ordinary browsing never
triggers eviction, while bounding the genuine worst case of a long session
touching hundreds of files in one large repo.

### Interaction between the two mechanisms

The folder-switch clear disposes every model directly via Monaco's own
`getModels()`, without going through `modelLru.ts`'s tracking map at all —
so after a folder switch, the LRU map still contains stale keys pointing at
now-disposed models. This is harmless: the next `touchModel` call for a
freshly-opened file just reinserts its key (a no-op if already present,
otherwise added fresh), and eviction only ever calls `.dispose()` again on
whatever `monaco.editor.getModel()` returns for a stale key — which will be
`undefined` for an already-disposed model, so `?.dispose()` is skipped
safely. No explicit "clear the LRU map on folder switch" call is needed; the
existing `?.` optional-chaining in the eviction loop already handles it.

## Testing

`touchModel`'s LRU bookkeeping (insertion-order movement, eviction past the
cap) is testable with a fake/mock `monaco.Uri`/`monaco.editor.getModel`
shape if `monaco-editor` itself is awkward to import directly in a
`.test.ts` file under this repo's plain-Node vitest environment — the
plan's implementer should verify this first and use whatever approach
actually works, since `monaco-editor` is a heavy package. No test file is
expected for `CodeView.tsx` or `App.tsx` themselves (component-level,
untestable per this repo's existing convention — zero `.tsx` test files
exist anywhere). The folder-switch clear and the two `touchModel` call
sites in `CodeView.tsx` are verified via manual smoke test only: switch
folders with a file open (confirm no console errors, confirm the new
folder's files still open/render correctly), and if practical, verify
eviction behavior by browsing more than `MODEL_CAP` distinct files in one
session and confirming Monaco's model count (`monaco.editor.getModels().length`)
stays bounded near the cap rather than growing unboundedly.
