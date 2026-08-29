# Side-by-Side Rendered Markdown Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth markdown diff mode, "Side-by-Side," that renders the old and new revisions as two independent, fully-rendered markdown documents in adjacent, scroll-synced panes.

**Architecture:** Extract the single-document render-to-HTML and mermaid-running logic that `MarkdownView.tsx` already has inline into two small shared pieces (`renderMarkdownToHtml` in `markdown/render.ts`, `runMermaidIn` in a new `markdown/mermaidRunner.ts`). Build a new `MarkdownSideBySideView.tsx` component on top of those shared pieces — two panes, the old one with links disabled, the new one behaving like today's Rendered mode, both synced by scroll-position fraction. Wire a new `sideBySide` mode value into `ContentPane.tsx`'s existing toggle/data-flow, which already resolves both revisions' content for the sibling Marks/Source modes.

**Tech Stack:** TypeScript, React, markdown-it + shiki + DOMPurify (existing render pipeline), mermaid.

**Spec:** `docs/superpowers/specs/2026-08-25-side-by-side-rendered-markdown-diff-design.md`

## Global Constraints

- Toggle order: `Rendered | Marks | Side-by-Side | Source` — Side-by-Side is a new 4th button between Marks and Source, not a replacement for either.
- The two panes scroll in sync by proportional position (`scrollTop / (scrollHeight - clientHeight)`), not independently.
- The old (base) pane's links are **fully inert** — no click handler attached at all, not merely visually different.
- The new (compare) pane behaves identically to today's Rendered mode: full link interactivity, and it's the only pane wired to `scrollToAnchor`/`onAnchorConsumed`.
- New component: `MarkdownSideBySideView.tsx`, not an extended `MarkdownView.tsx`.
- No new test files for anything touching `markdown/render.ts` (directly or transitively) — `DOMPurify.sanitize` is `undefined` under this repo's plain-Node vitest environment (confirmed directly), which is why `render.ts` itself has no existing test file either. This is a pre-existing gap, not something this plan is expected to fix.
- No test files for any `.tsx` component — this repo has zero component-level tests anywhere (`vitest.config.ts`'s `include: ['src/**/*.test.ts']` excludes `.tsx` entirely).
- Run `npm run typecheck` and `npm test` at the end of each task; both must be clean before committing.

---

### Task 1: Extract shared render-to-HTML and mermaid-running helpers

**Files:**
- Modify: `src/renderer/src/markdown/render.ts` (add `renderMarkdownToHtml`)
- Create: `src/renderer/src/markdown/mermaidRunner.ts`
- Modify: `src/renderer/src/components/MarkdownView.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `renderMarkdownToHtml(src: string): Promise<string>` (from `render.ts`) and `runMermaidIn(container: HTMLElement): void` (from `mermaidRunner.ts`) — both consumed by Task 2.

- [ ] **Step 1: Add `renderMarkdownToHtml` to render.ts**

Read `src/renderer/src/markdown/render.ts` in full first to confirm it still matches (it should be unchanged since this plan was written — two exports, `sanitizeHtml` and `renderMarkdown`). Add this new export at the end of the file:

```ts
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Renders `src` to sanitized HTML, or a fallback HTML fragment (escaped
 * error message plus escaped raw source) if rendering throws. Shared by
 * any single-document rendered view (MarkdownView's plain Rendered mode,
 * each pane of MarkdownSideBySideView) -- Marks mode's own dual-render-
 * then-compose fallback chain in MarkdownView.tsx is more involved and
 * stays there, not routed through this function.
 */
export async function renderMarkdownToHtml(src: string): Promise<string> {
  try {
    return await renderMarkdown(src)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `<p><em>Markdown rendering failed: ${escapeHtml(message)}</em></p><pre><code>${escapeHtml(src)}</code></pre>`
  }
}
```

- [ ] **Step 2: Create mermaidRunner.ts**

Create `src/renderer/src/markdown/mermaidRunner.ts`:

```ts
import mermaid from 'mermaid'

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })

/**
 * Runs mermaid over any `pre.mermaid` marker nodes inside `container`
 * (emitted by render.ts's fence-rule override for ```mermaid fences).
 * Adds a `.mermaid-error` class to any node mermaid failed to turn into an
 * `<svg>`, matching the existing rendered-markdown CSS's error styling.
 * Shared by MarkdownView.tsx and MarkdownSideBySideView.tsx so mermaid's
 * one-time `initialize()` call happens exactly once regardless of which
 * component mounts first (ES module caching).
 */
export function runMermaidIn(container: HTMLElement): void {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>('pre.mermaid'))
  if (nodes.length === 0) return
  mermaid.run({ nodes, suppressErrors: true }).catch(() => {
    for (const node of nodes) {
      if (!node.querySelector('svg')) node.classList.add('mermaid-error')
    }
  })
}
```

- [ ] **Step 3: Update MarkdownView.tsx to use both shared helpers**

Read `src/renderer/src/components/MarkdownView.tsx` in full first to confirm it still matches. Current top-of-file imports and mermaid init (lines 1-8):

```ts
// src/renderer/src/components/MarkdownView.tsx
import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { renderMarkdown, sanitizeHtml } from '../markdown/render'
import { composeMarks } from '../markdown/marksDiff'
import { classifyLinkHref } from '../markdown/links'

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
```

Replace with:

```ts
// src/renderer/src/components/MarkdownView.tsx
import { useEffect, useRef, useState } from 'react'
import { renderMarkdown, renderMarkdownToHtml, sanitizeHtml } from '../markdown/render'
import { runMermaidIn } from '../markdown/mermaidRunner'
import { composeMarks } from '../markdown/marksDiff'
import { classifyLinkHref } from '../markdown/links'
```

Current `render` function inside the first `useEffect` (part of the current lines 53-99 effect body):

```ts
    const render = async (): Promise<string> => {
      if (baseContent === null) return renderMarkdown(content)
      const [oldHtml, newHtml] = await Promise.all([
        renderMarkdown(baseContent),
        renderMarkdown(content)
      ])
      return sanitizeHtml(composeMarks(oldHtml, newHtml))
    }
```

Replace with (only the plain-view branch changes, to use the new fallback-wrapped helper; the Marks-mode branch and its surrounding catch block below are untouched):

```ts
    const render = async (): Promise<string> => {
      if (baseContent === null) return renderMarkdownToHtml(content)
      const [oldHtml, newHtml] = await Promise.all([
        renderMarkdown(baseContent),
        renderMarkdown(content)
      ])
      return sanitizeHtml(composeMarks(oldHtml, newHtml))
    }
```

Do not change the `.catch(async (err: unknown) => {...})` block that follows — it still handles the `baseContent !== null` (Marks) failure path exactly as today. It's still reachable in principle since `renderMarkdownToHtml` only throws if something inside its own try/catch itself throws (it shouldn't, by construction), but leaving the outer catch in place is harmless defense-in-depth and out of scope to remove.

Current mermaid-running effect (currently lines 101-111):

```ts
  useEffect(() => {
    const container = ref.current
    if (!container || !html) return
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('pre.mermaid'))
    if (nodes.length === 0) return
    mermaid.run({ nodes, suppressErrors: true }).catch(() => {
      for (const node of nodes) {
        if (!node.querySelector('svg')) node.classList.add('mermaid-error')
      }
    })
  }, [html])
```

Replace with:

```ts
  useEffect(() => {
    const container = ref.current
    if (!container || !html) return
    runMermaidIn(container)
  }, [html])
```

- [ ] **Step 4: Typecheck and run the full test suite**

Run: `npm run typecheck && npm test`
Expected: no typecheck errors (in particular, confirm nothing else in the codebase still imports `mermaid` expecting `MarkdownView.tsx` to have already called `mermaid.initialize` — grep confirms `mermaidRunner.ts` is the only place that now calls it); all existing tests pass unchanged (this task adds no test files, per the Global Constraints).

- [ ] **Step 5: Manual smoke check**

Use the `run-viewmaster` skill to launch the app, open a folder containing a markdown file with an actual revision diff, and confirm: Rendered mode still shows the current content correctly; Marks mode still shows the inline insertions/deletions correctly; if the markdown includes a ```mermaid fence, confirm it still renders as a diagram (not raw text) in both Rendered and Marks modes.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/markdown/render.ts src/renderer/src/markdown/mermaidRunner.ts src/renderer/src/components/MarkdownView.tsx
git commit -m "refactor: extract shared markdown render-to-HTML and mermaid helpers

MarkdownView's plain-view render-with-fallback and mermaid-running logic
were both inlined in its own effects. Extracted to renderMarkdownToHtml
(markdown/render.ts) and runMermaidIn (new markdown/mermaidRunner.ts) so
the upcoming side-by-side diff view can reuse the same behavior instead
of duplicating it. Marks mode's own render/fallback logic is untouched.

Part of #11."
```

---

### Task 2: Create MarkdownSideBySideView.tsx

**Files:**
- Create: `src/renderer/src/components/MarkdownSideBySideView.tsx`
- Modify: `src/renderer/src/styles.css` (new `.markdown-sidebyside*` rules)

**Interfaces:**
- Consumes: `renderMarkdownToHtml` (from `markdown/render.ts`), `runMermaidIn` (from `markdown/mermaidRunner.ts`) — both from Task 1. `classifyLinkHref` (from `markdown/links.ts`, unchanged, already exists).
- Produces: default-exported `MarkdownSideBySideView` component with props `{ baseContent: string; content: string; absPath: string; workspaceRoot: string; onNavigate: (absPath: string, anchor?: string) => void; scrollToAnchor: string | null; onAnchorConsumed: () => void }` — consumed by Task 3.

- [ ] **Step 1: Create the component**

Create `src/renderer/src/components/MarkdownSideBySideView.tsx`:

```tsx
// src/renderer/src/components/MarkdownSideBySideView.tsx
import { useEffect, useRef, useState } from 'react'
import { renderMarkdownToHtml } from '../markdown/render'
import { runMermaidIn } from '../markdown/mermaidRunner'
import { classifyLinkHref } from '../markdown/links'

/** Scrolls `id`'s element into view inside `container`, if it exists. Returns whether it was found. */
function scrollToId(container: HTMLElement | null, id: string): boolean {
  if (!container) return false
  const target = container.querySelector(`#${CSS.escape(id)}`)
  if (!target) return false
  target.scrollIntoView({ behavior: 'smooth' })
  return true
}

/** Renders one pane's markdown to HTML and runs mermaid over it once mounted. */
function usePaneHtml(source: string): [string, React.RefObject<HTMLDivElement>] {
  const ref = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState('')

  useEffect(() => {
    let stale = false
    void renderMarkdownToHtml(source).then((rendered) => {
      if (!stale) setHtml(rendered)
    })
    return () => {
      stale = true
    }
  }, [source])

  useEffect(() => {
    const container = ref.current
    if (!container || !html) return
    runMermaidIn(container)
  }, [html])

  return [html, ref]
}

/**
 * Renders `baseContent` and `content` as two independent, fully-rendered
 * markdown documents side by side, with synced scrolling. The old (base)
 * pane's links are deliberately inert -- a link's target may not exist, or
 * may mean something different, at the revision being shown there, and
 * letting it navigate via the current file tree would be misleading. The
 * new (compare) pane behaves identically to MarkdownView's plain Rendered
 * mode: full link interactivity, and it's the only pane wired to
 * scrollToAnchor/onAnchorConsumed (a cross-document navigation target
 * refers to the current revision, not a historical one).
 */
export default function MarkdownSideBySideView({
  baseContent,
  content,
  absPath,
  workspaceRoot,
  onNavigate,
  scrollToAnchor,
  onAnchorConsumed
}: {
  baseContent: string
  content: string
  absPath: string
  workspaceRoot: string
  onNavigate: (absPath: string, anchor?: string) => void
  scrollToAnchor: string | null
  onAnchorConsumed: () => void
}): React.JSX.Element {
  const [oldHtml, oldRef] = usePaneHtml(baseContent)
  const [newHtml, newRef] = usePaneHtml(content)
  const oldScrollRef = useRef<HTMLDivElement>(null)
  const newScrollRef = useRef<HTMLDivElement>(null)
  const isSyncingRef = useRef(false)

  useEffect(() => {
    const oldEl = oldScrollRef.current
    const newEl = newScrollRef.current
    if (!oldEl || !newEl) return

    const syncFrom = (source: HTMLElement, target: HTMLElement): void => {
      if (isSyncingRef.current) return
      const range = source.scrollHeight - source.clientHeight
      const fraction = range > 0 ? source.scrollTop / range : 0
      const targetRange = target.scrollHeight - target.clientHeight
      isSyncingRef.current = true
      target.scrollTop = fraction * targetRange
      isSyncingRef.current = false
    }

    const onOldScroll = (): void => syncFrom(oldEl, newEl)
    const onNewScroll = (): void => syncFrom(newEl, oldEl)
    oldEl.addEventListener('scroll', onOldScroll)
    newEl.addEventListener('scroll', onNewScroll)
    return () => {
      oldEl.removeEventListener('scroll', onOldScroll)
      newEl.removeEventListener('scroll', onNewScroll)
    }
  }, [])

  useEffect(() => {
    if (!scrollToAnchor) return
    if (scrollToId(newRef.current, scrollToAnchor)) onAnchorConsumed()
  }, [scrollToAnchor, newHtml])

  const onNewPaneClick = (e: React.MouseEvent): void => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    const classification = classifyLinkHref(href, absPath, workspaceRoot)
    if (classification.kind === 'external') {
      window.viewmaster.openExternal(classification.url)
    } else if (classification.kind === 'anchor') {
      scrollToId(newRef.current, classification.id)
    } else if (classification.kind === 'navigate') {
      onNavigate(classification.absPath, classification.anchor)
    }
  }

  return (
    <div className="markdown-sidebyside">
      <div ref={oldScrollRef} className="markdown-sidebyside-pane">
        <div ref={oldRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: oldHtml }} />
      </div>
      <div ref={newScrollRef} className="markdown-sidebyside-pane markdown-sidebyside-pane-new">
        <div
          ref={newRef}
          className="markdown-body"
          onClick={onNewPaneClick}
          dangerouslySetInnerHTML={{ __html: newHtml }}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add CSS for the two-pane layout**

Read `src/renderer/src/styles.css` around line 417-432 first to confirm the `/* ---- rendered markdown ---- */` section still matches (it should be unchanged: `.markdown-scroll` at line 419, `.markdown-body` at line 424). Add this new block immediately after that section (before the `/* ---- rendered html ---- */` comment at line 433):

```css
.markdown-sidebyside {
  height: 100%;
  display: flex;
}

.markdown-sidebyside-pane {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
}

.markdown-sidebyside-pane-new {
  border-left: 1px solid var(--border);
}

.markdown-sidebyside-pane .markdown-body a {
  pointer-events: none;
  cursor: default;
  text-decoration: none;
  color: inherit;
}

.markdown-sidebyside-pane-new .markdown-body a {
  pointer-events: auto;
  cursor: pointer;
  text-decoration: underline;
  color: var(--accent);
}
```

(The old pane's links are made visually inert via CSS — `pointer-events: none` plus no `onClick` handler in the component itself, belt-and-suspenders. The new pane explicitly re-enables normal link styling/interaction, since `.markdown-body a` elsewhere in this file already styles links for the single-pane views and this new two-pane container needs its own override given the two panes now need to differ from each other.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Defer manual verification to Task 3**

This component isn't reachable in the running app until Task 3 wires it into `ContentPane.tsx`'s toggle — there is nothing meaningful to click through yet. Skip a standalone manual check here; Task 3's manual smoke check covers this component's actual behavior (both panes rendering, scroll sync, link inertness/interactivity) once it's reachable in the UI.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/MarkdownSideBySideView.tsx src/renderer/src/styles.css
git commit -m "feat: add MarkdownSideBySideView component

Renders two independently-rendered markdown panes (old/new) with
synced scrolling by proportional position. Old pane's links are
inert (no click handler, pointer-events: none); new pane behaves
like MarkdownView's plain Rendered mode. Not yet reachable from the
UI -- ContentPane wiring is a separate task.

Part of #11."
```

---

### Task 3: Wire the Side-by-Side mode into ContentPane.tsx

**Files:**
- Modify: `src/renderer/src/components/ContentPane.tsx`

**Interfaces:**
- Consumes: `MarkdownSideBySideView` (default export from Task 2, props as documented there).
- Produces: nothing further downstream — this is the final integration task.

- [ ] **Step 1: Import the new component**

Read `src/renderer/src/components/ContentPane.tsx` in full first to confirm it still matches (it should be unchanged since this plan was written). Current imports (lines 1-12):

```ts
import { useEffect, useState } from 'react'
import type { ChangedFile, FileContent, HistoryVersion } from '@shared/types'
import { isDefaultSelection, type RevisionRef, type Selection } from '../history/selection'
import type { NavigationTarget } from '../navigation/history'
import CodeView from './CodeView'
import DiffView from './DiffView'
import MarkdownView from './MarkdownView'
import HtmlView from './HtmlView'
import Placeholder from './Placeholder'
import ImageView from './ImageView'
import { rasterDataUrl, svgDataUrl } from '../image/dataUrl'
import PdfView from './PdfView'
```

Add one import line after `MarkdownView`:

```ts
import MarkdownView from './MarkdownView'
import MarkdownSideBySideView from './MarkdownSideBySideView'
```

- [ ] **Step 2: Add the new mode to the `Mode` type**

Current line 14:

```ts
type Mode = 'view' | 'marks' | 'code' | 'diff'
```

Replace with:

```ts
type Mode = 'view' | 'marks' | 'sideBySide' | 'code' | 'diff'
```

- [ ] **Step 3: Extend the revision-resolution effect's guard**

Current (line 119, inside the "Resolve base/compare sides from the selection when diffing" effect):

```ts
    if (!file || (mode !== 'diff' && mode !== 'marks')) return
```

Replace with:

```ts
    if (!file || (mode !== 'diff' && mode !== 'marks' && mode !== 'sideBySide')) return
```

- [ ] **Step 4: Add the new body-selection branch**

Current `mode === 'marks'` branch (lines 194-208):

```ts
  } else if (mode === 'marks' && isMarkdown(file.path)) {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading marks…" />
      ) : (
        <MarkdownView
          content={compareContent}
          baseContent={baseContent}
          absPath={file.absPath}
          workspaceRoot={workspaceRoot}
          onNavigate={onMarkdownNavigate}
          scrollToAnchor={anchorTarget}
          onAnchorConsumed={onTargetConsumed}
        />
      )
  } else if (mode === 'code' && isMarkdown(file.path)) {
```

Insert a new branch immediately after the `marks` branch and before the `code` branch:

```ts
  } else if (mode === 'marks' && isMarkdown(file.path)) {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading marks…" />
      ) : (
        <MarkdownView
          content={compareContent}
          baseContent={baseContent}
          absPath={file.absPath}
          workspaceRoot={workspaceRoot}
          onNavigate={onMarkdownNavigate}
          scrollToAnchor={anchorTarget}
          onAnchorConsumed={onTargetConsumed}
        />
      )
  } else if (mode === 'sideBySide' && isMarkdown(file.path)) {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading…" />
      ) : (
        <MarkdownSideBySideView
          baseContent={baseContent}
          content={compareContent}
          absPath={file.absPath}
          workspaceRoot={workspaceRoot}
          onNavigate={onMarkdownNavigate}
          scrollToAnchor={anchorTarget}
          onAnchorConsumed={onTargetConsumed}
        />
      )
  } else if (mode === 'code' && isMarkdown(file.path)) {
```

- [ ] **Step 5: Update the toggle button array and labels**

Current (lines 276-287):

```ts
          ) : showToolbarToggles && isMarkdown(file.path) ? (
            <span className="toolbar-segment">
              {(['view', 'marks', 'diff'] as const).map((m) => (
                <button
                  key={m}
                  className={`toolbar-button${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'view' ? 'Rendered' : m === 'marks' ? 'Marks' : 'Source'}
                </button>
              ))}
            </span>
          ) : showToolbarToggles && isHtml(file.path) ? (
```

Replace with:

```ts
          ) : showToolbarToggles && isMarkdown(file.path) ? (
            <span className="toolbar-segment">
              {(['view', 'marks', 'sideBySide', 'diff'] as const).map((m) => (
                <button
                  key={m}
                  className={`toolbar-button${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'view'
                    ? 'Rendered'
                    : m === 'marks'
                      ? 'Marks'
                      : m === 'sideBySide'
                        ? 'Side-by-Side'
                        : 'Source'}
                </button>
              ))}
            </span>
          ) : showToolbarToggles && isHtml(file.path) ? (
```

- [ ] **Step 6: Typecheck and run the full test suite**

Run: `npm run typecheck && npm test`
Expected: no typecheck errors; all existing tests pass unchanged.

- [ ] **Step 7: Full manual smoke check**

Use the `run-viewmaster` skill to launch the app, open a folder containing a markdown file with an actual revision diff (e.g. a file changed on the current branch relative to its fork point), and verify:
1. Click through all four toggle buttons (Rendered, Marks, Side-by-Side, Source) and confirm each renders without error.
2. In Side-by-Side, confirm both panes show fully rendered markdown (not raw text).
3. Scroll the left (old) pane and confirm the right (new) pane scrolls proportionally, and vice versa.
4. Click a link inside the old (left) pane and confirm nothing happens.
5. Click a link inside the new (right) pane and confirm it navigates normally, same as it would in Rendered mode.
6. If the test file contains a ```mermaid fence, confirm it renders as a diagram (not raw text/an error) in both panes.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/ContentPane.tsx
git commit -m "feat: wire Side-by-Side markdown diff mode into ContentPane

Adds the 4th toggle button (Rendered | Marks | Side-by-Side | Source)
and the data-flow/rendering wiring for it, reusing the same base/compare
content resolution already used by Marks and Source.

Resolves #11."
```
