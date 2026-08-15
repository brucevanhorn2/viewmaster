# Markdown Link Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make relative links between markdown documents (and in-page `#heading` links) actually navigate/scroll in View Master, instead of doing nothing.

**Architecture:** `MarkdownView` classifies every clicked link's href via a new pure `classifyLinkHref` — external (open in default browser, unchanged), a bare `#id` (scroll to that heading in the current document), a relative path optionally with `#id` (navigate View Master to that file, then scroll once it renders), or anything else (silent no-op). Headings get GitHub-style `id` attributes via a small slugger wired into the existing `markdown-it` render pipeline. Navigation and pending-anchor state thread through `ContentPane` into `App.tsx`'s existing file-selection flow — no main-process or IPC changes.

**Tech Stack:** Electron + React + TypeScript, `markdown-it@14.3.0` (already a dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-markdown-link-support-design.md`

## Global Constraints

- Standard Markdown links only — no Obsidian `[[Wikilink]]` syntax (a candidate future issue, not this one).
- Built independently of the unmerged `worktree-rendered-html-view` branch — its equivalent `classifyLinkHref`/`onNavigate` code is not reused or depended on.
- Heading slugs follow GitHub's convention: lowercase, strip everything but `[a-z0-9\s-]`, spaces→hyphens, trim leading/trailing hyphens, duplicate slugs within one document get `-1`/`-2`/... suffixes.
- Any relative in-workspace link navigates (not markdown-file-only targets) — matches how `App.tsx` already treats any `ChangedFile`.
- A link/anchor that can't be resolved (escapes the workspace root, unknown scheme, empty href, missing heading id) is a silent no-op — `preventDefault()` only, no visible feedback.
- No main-process/IPC changes — this is pure renderer-side logic on content already loaded through the existing `file:read` flow.

---

### Task 1: Renderer — GitHub-style heading slugger

**Files:**
- Create: `src/renderer/src/markdown/slug.ts`
- Test: `src/renderer/src/markdown/slug.test.ts`

**Interfaces:**
- Produces: `slugify(text: string, seen: Map<string, number>): string`. Consumed by Task 4 (`render.ts`'s heading-id core rule).

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/markdown/slug.test.ts
import { describe, it, expect } from 'vitest'
import { slugify } from './slug'

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Getting Started', new Map())).toBe('getting-started')
  })

  it('strips punctuation', () => {
    expect(slugify('FAQ: Common Questions!', new Map())).toBe('faq-common-questions')
  })

  it('collapses multiple spaces and trims leading/trailing hyphens', () => {
    expect(slugify('  Hello   World  ', new Map())).toBe('hello-world')
  })

  it('keeps existing hyphens and digits', () => {
    expect(slugify('Step 1 - Setup', new Map())).toBe('step-1---setup')
  })

  it('falls back to "section" for text with no sluggable characters', () => {
    expect(slugify('!!!', new Map())).toBe('section')
  })

  it('disambiguates repeated headings within the same seen map', () => {
    const seen = new Map<string, number>()
    expect(slugify('Overview', seen)).toBe('overview')
    expect(slugify('Overview', seen)).toBe('overview-1')
    expect(slugify('Overview', seen)).toBe('overview-2')
  })

  it('does not disambiguate across separate seen maps', () => {
    expect(slugify('Overview', new Map())).toBe('overview')
    expect(slugify('Overview', new Map())).toBe('overview')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/markdown/slug.test.ts`
Expected: FAIL — `Cannot find module './slug'`.

- [ ] **Step 3: Implement `slugify`**

```ts
// src/renderer/src/markdown/slug.ts

/**
 * GitHub-style heading slug: lowercase, strip everything but letters/
 * digits/spaces/hyphens, collapse whitespace to single hyphens, trim
 * leading/trailing hyphens. Falls back to "section" for text that slugs
 * to nothing (e.g. a heading made entirely of punctuation/emoji).
 */
function baseSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

/**
 * Slugifies `text`, disambiguating repeats within one render pass via
 * `seen` (a Map the caller creates once per document and passes to every
 * heading) — a second "Overview" heading becomes "overview-1", matching
 * GitHub's convention.
 */
export function slugify(text: string, seen: Map<string, number>): string {
  const slug = baseSlug(text)
  const count = seen.get(slug) ?? 0
  seen.set(slug, count + 1)
  return count === 0 ? slug : `${slug}-${count}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/markdown/slug.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/markdown/slug.ts src/renderer/src/markdown/slug.test.ts
git commit -m "feat: add GitHub-style heading slugger for markdown link anchors"
```

---

### Task 2: Renderer — forward-slash path helpers

**Files:**
- Create: `src/renderer/src/markdown/paths.ts`
- Test: `src/renderer/src/markdown/paths.test.ts`

**Interfaces:**
- Produces: `joinPath(...segments: string[]): string`, `dirnamePath(path: string): string`, `isInsideRoot(path: string, root: string): boolean`.
- Consumed by: Task 3 (`classifyLinkHref`).

These exist because the renderer cannot import Node's `'path'` module (no `@types/node` in `tsconfig.web.json`, no Node-polyfill plugin for the renderer in `electron.vite.config.ts`). All paths are forward-slash POSIX-style, matching this codebase's existing convention (`ChangedFile.path` is documented as "forward slashes").

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/markdown/paths.test.ts
import { describe, it, expect } from 'vitest'
import { joinPath, dirnamePath, isInsideRoot } from './paths'

describe('joinPath', () => {
  it('joins simple segments', () => {
    expect(joinPath('/a/b', 'c.md')).toBe('/a/b/c.md')
  })

  it('resolves "." and ".." segments', () => {
    expect(joinPath('/a/b', '../c.md')).toBe('/a/c.md')
    expect(joinPath('/a/b', './c.md')).toBe('/a/b/c.md')
  })

  it('clamps excess ".." at the filesystem root instead of erroring', () => {
    expect(joinPath('/a', '../../../etc/passwd')).toBe('/etc/passwd')
  })
})

describe('dirnamePath', () => {
  it('returns everything before the last slash', () => {
    expect(dirnamePath('/a/b/c.md')).toBe('/a/b')
  })

  it('returns "/" for a top-level absolute file', () => {
    expect(dirnamePath('/c.md')).toBe('/')
  })
})

describe('isInsideRoot', () => {
  it('accepts the root itself', () => {
    expect(isInsideRoot('/w', '/w')).toBe(true)
  })

  it('accepts a descendant', () => {
    expect(isInsideRoot('/w/sub/a.md', '/w')).toBe(true)
  })

  it('rejects a path outside the root', () => {
    expect(isInsideRoot('/other/a.md', '/w')).toBe(false)
  })

  it('rejects a sibling directory with a name-prefix collision', () => {
    expect(isInsideRoot('/w-evil/a.md', '/w')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/markdown/paths.test.ts`
Expected: FAIL — `Cannot find module './paths'`.

- [ ] **Step 3: Implement the helpers**

```ts
// src/renderer/src/markdown/paths.ts

/** Joins forward-slash path segments, resolving "." and ".." (POSIX-style). */
export function joinPath(...segments: string[]): string {
  const isAbsolute = segments[0]?.startsWith('/') ?? false
  const parts = segments.join('/').split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop()
      else if (!isAbsolute) stack.push('..')
      continue
    }
    stack.push(part)
  }
  return (isAbsolute ? '/' : '') + stack.join('/')
}

/** Everything before the last "/" segment. */
export function dirnamePath(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return path.slice(0, idx)
}

/** True when `path` is `root` itself or a descendant of it. */
export function isInsideRoot(path: string, root: string): boolean {
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root
  return path === normalizedRoot || path.startsWith(normalizedRoot + '/')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/markdown/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/markdown/paths.ts src/renderer/src/markdown/paths.test.ts
git commit -m "feat: add forward-slash path helpers for markdown link resolution"
```

---

### Task 3: Renderer — link classification for click handling

**Files:**
- Create: `src/renderer/src/markdown/links.ts`
- Test: `src/renderer/src/markdown/links.test.ts`

**Interfaces:**
- Consumes: `joinPath`, `dirnamePath`, `isInsideRoot` from `./paths` (Task 2).
- Produces: `classifyLinkHref(href: string, mdAbsPath: string, workspaceRoot: string): LinkClassification`, where
  ```ts
  type LinkClassification =
    | { kind: 'external'; url: string }
    | { kind: 'anchor'; id: string }
    | { kind: 'navigate'; absPath: string; anchor?: string }
    | { kind: 'noop' }
  ```
  Consumed by Task 5 (`MarkdownView`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/markdown/links.test.ts
import { describe, it, expect } from 'vitest'
import { classifyLinkHref } from './links'

const MD_PATH = '/w/docs/index.md'
const ROOT = '/w'

describe('classifyLinkHref', () => {
  it('classifies an https link as external', () => {
    expect(classifyLinkHref('https://example.com/x', MD_PATH, ROOT)).toEqual({
      kind: 'external',
      url: 'https://example.com/x'
    })
  })

  it('classifies a bare fragment as an anchor', () => {
    expect(classifyLinkHref('#section', MD_PATH, ROOT)).toEqual({ kind: 'anchor', id: 'section' })
  })

  it('classifies an in-workspace relative link as navigate', () => {
    expect(classifyLinkHref('other.md', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/other.md'
    })
  })

  it('classifies a relative link with a fragment as navigate-with-anchor', () => {
    expect(classifyLinkHref('other.md#section', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/other.md',
      anchor: 'section'
    })
  })

  it('resolves ".." against the markdown file\'s own directory', () => {
    expect(classifyLinkHref('../other/page.md', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/other/page.md'
    })
  })

  it('treats a leading-slash href as workspace-root-relative', () => {
    expect(classifyLinkHref('/diagrams/erd.md', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/diagrams/erd.md'
    })
  })

  it('strips a query string before resolving, keeping the fragment', () => {
    expect(classifyLinkHref('other.md?x=1#section', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/other.md',
      anchor: 'section'
    })
  })

  it('no-ops a link that resolves outside the workspace root', () => {
    expect(classifyLinkHref('../../../../etc/passwd', MD_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('no-ops a mailto: link', () => {
    expect(classifyLinkHref('mailto:x@example.com', MD_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('no-ops an empty href', () => {
    expect(classifyLinkHref('', MD_PATH, ROOT)).toEqual({ kind: 'noop' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/markdown/links.test.ts`
Expected: FAIL — `Cannot find module './links'`.

- [ ] **Step 3: Implement `classifyLinkHref`**

```ts
// src/renderer/src/markdown/links.ts
import { dirnamePath, isInsideRoot, joinPath } from './paths'

export type LinkClassification =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'navigate'; absPath: string; anchor?: string }
  | { kind: 'noop' }

/**
 * Classifies a clicked markdown link's href for MarkdownView's click
 * handler: http(s) links open externally; a bare "#id" scrolls to that
 * heading in the current document; an in-workspace relative link
 * navigates View Master to that file (optionally also scrolling to a
 * "#id" suffix once it renders); everything else (mailto:, links that
 * escape the workspace root, empty hrefs) is inert.
 */
export function classifyLinkHref(
  href: string,
  mdAbsPath: string,
  workspaceRoot: string
): LinkClassification {
  if (/^https?:\/\//i.test(href)) return { kind: 'external', url: href }
  if (href === '') return { kind: 'noop' }
  if (href.startsWith('#')) return { kind: 'anchor', id: href.slice(1) }
  // Any other URI scheme (mailto:, tel:, javascript:, data:, ...) is inert here.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return { kind: 'noop' }

  const hashIdx = href.indexOf('#')
  const pathPart = (hashIdx === -1 ? href : href.slice(0, hashIdx)).split('?')[0]
  const anchor = hashIdx === -1 ? undefined : href.slice(hashIdx + 1)
  if (pathPart === '') return { kind: 'noop' }

  const base = pathPart.startsWith('/') ? workspaceRoot : dirnamePath(mdAbsPath)
  const rel = pathPart.startsWith('/') ? pathPart.slice(1) : pathPart
  const resolved = joinPath(base, rel)

  if (!isInsideRoot(resolved, workspaceRoot)) return { kind: 'noop' }
  return anchor === undefined
    ? { kind: 'navigate', absPath: resolved }
    : { kind: 'navigate', absPath: resolved, anchor }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/markdown/links.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/markdown/links.ts src/renderer/src/markdown/links.test.ts
git commit -m "feat: classify markdown link clicks (external/anchor/navigate/noop)"
```

---

### Task 4: Renderer — wire heading-id assignment into the markdown render pipeline

**Files:**
- Modify: `src/renderer/src/markdown/render.ts`

**Interfaces:**
- Consumes: `slugify` from `./slug` (Task 1).
- Produces: no new exported interface — `renderMarkdown`'s output HTML now has `id` attributes on every heading. Consumed implicitly by Task 5 (`MarkdownView`'s anchor-scroll logic, which looks up those ids).

No automated test for this task — `render.ts` has no existing test file, and testing it end-to-end would require adding a `jsdom` dependency for DOMPurify (the same reason the separate, unmerged HTML-view feature needed `// @vitest-environment jsdom` for its own render tests), which is out of scope for this change. The slug computation itself is already fully tested in Task 1; this task is pure wiring, verified by typecheck plus Task 8's manual pass.

- [ ] **Step 1: Add the heading-id core rule**

Replace the full contents of `src/renderer/src/markdown/render.ts` with:

```ts
import MarkdownIt from 'markdown-it'
import markdownItShiki from '@shikijs/markdown-it'
import type { BundledLanguage } from 'shiki'
import DOMPurify from 'dompurify'
import { slugify } from './slug'

// Shiki accepts its built-in plain-text language at runtime, but the
// BundledLanguage type union omits it.
const PLAIN_TEXT = 'text' as unknown as BundledLanguage

let mdPromise: Promise<MarkdownIt> | null = null

async function getMd(): Promise<MarkdownIt> {
  if (!mdPromise) {
    mdPromise = (async () => {
      const md = new MarkdownIt({ html: true, linkify: true })
      md.use(
        await markdownItShiki({
          theme: 'dark-plus',
          fallbackLanguage: PLAIN_TEXT,
          defaultLanguage: PLAIN_TEXT
        })
      )

      // Mermaid fences bypass shiki: emit the raw source in a marker element
      // that MarkdownView hands to mermaid for diagram rendering.
      const highlightFence = md.renderer.rules.fence!
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        if (token.info.trim() === 'mermaid') {
          return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`
        }
        return highlightFence(tokens, idx, options, env, self)
      }

      // Give every heading a stable, GitHub-style id so "[Section](#section)"
      // links (and MarkdownView's anchor-click scroll) have something to
      // target. `state.env` is fresh per `md.render(src)` call (when the
      // caller doesn't pass its own), so a Map stashed there dedupes repeat
      // headings within one document without leaking across renders.
      md.core.ruler.push('heading-ids', (state: MarkdownIt.StateCore) => {
        const seen: Map<string, number> = (state.env.headingSlugs ??= new Map())
        for (let i = 0; i < state.tokens.length; i++) {
          const token = state.tokens[i]
          if (token.type !== 'heading_open') continue
          const inline = state.tokens[i + 1]
          const text = inline?.children?.map((c) => c.content).join('') ?? ''
          token.attrSet('id', slugify(text, seen))
        }
      })

      return md
    })()
  }
  return mdPromise
}

/** Shared sanitizer for all rendered-markdown HTML paths. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html)
}

/** Render markdown to sanitized HTML (shiki-highlighted fences, mermaid markers, heading ids). */
export async function renderMarkdown(src: string): Promise<string> {
  const md = await getMd()
  return sanitizeHtml(md.render(src))
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`MarkdownIt.StateCore` resolves via the existing default `import MarkdownIt from 'markdown-it'` — the `@types/markdown-it` package declares `StateCore` as a nested type on the `MarkdownIt` namespace/class merge, so no additional type-only import is needed.)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — confirms nothing else broke (in particular `marksDiff.test.ts`, which exercises `renderMarkdown`-produced HTML indirectly through fixtures, if any; if it doesn't, this is still the right regression check).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/markdown/render.ts
git commit -m "feat: assign GitHub-style ids to rendered markdown headings"
```

---

### Task 5: Renderer — link click handling and anchor scrolling in `MarkdownView`

**Files:**
- Modify: `src/renderer/src/components/MarkdownView.tsx`

**Interfaces:**
- Consumes: `classifyLinkHref` (Task 3).
- Produces: `MarkdownView` gains props `absPath: string`, `workspaceRoot: string`, `onNavigate: (absPath: string, anchor?: string) => void`, `scrollToAnchor?: string | null`, `onAnchorConsumed: () => void`. Consumed by Task 6 (`ContentPane`).

No automated test for this file — same DOM-component-testing gap as every other view component in this codebase (`vitest.config.ts`'s `include` is `src/**/*.test.ts` only; no React Testing Library dependency exists). Covered by Task 8's manual verification pass.

- [ ] **Step 1: Replace the full contents of `MarkdownView.tsx`**

```tsx
// src/renderer/src/components/MarkdownView.tsx
import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { renderMarkdown, sanitizeHtml } from '../markdown/render'
import { composeMarks } from '../markdown/marksDiff'
import { classifyLinkHref } from '../markdown/links'

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Scrolls `id`'s element into view inside `container`, if it exists. Returns whether it was found. */
function scrollToId(container: HTMLElement | null, id: string): boolean {
  if (!container) return false
  const target = container.querySelector(`#${CSS.escape(id)}`)
  if (!target) return false
  target.scrollIntoView({ behavior: 'smooth' })
  return true
}

/**
 * Rendered markdown. When `baseContent` is a string (possibly ''), renders
 * editor's marks: the diff between baseContent and content shown inline in
 * the rendered output. `baseContent === null` → plain rendered view.
 */
export default function MarkdownView({
  content,
  baseContent = null,
  absPath,
  workspaceRoot,
  onNavigate,
  scrollToAnchor = null,
  onAnchorConsumed
}: {
  content: string
  baseContent?: string | null
  absPath: string
  workspaceRoot: string
  onNavigate: (absPath: string, anchor?: string) => void
  scrollToAnchor?: string | null
  onAnchorConsumed: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState('')

  useEffect(() => {
    let stale = false

    const render = async (): Promise<string> => {
      if (baseContent === null) return renderMarkdown(content)
      const [oldHtml, newHtml] = await Promise.all([
        renderMarkdown(baseContent),
        renderMarkdown(content)
      ])
      return sanitizeHtml(composeMarks(oldHtml, newHtml))
    }

    render()
      .then((rendered) => {
        if (!stale) setHtml(rendered)
      })
      .catch(async (err: unknown) => {
        if (stale) return
        const message = err instanceof Error ? err.message : String(err)
        if (baseContent !== null) {
          // Marks composition failed — fall back to the plain rendered view.
          try {
            const plain = await renderMarkdown(content)
            if (!stale) setHtml(`<p><em>Marks unavailable: ${escape(message)}</em></p>${plain}`)
            return
          } catch {
            // fall through to the escaped-source fallback
          }
        }
        if (!stale) {
          setHtml(
            `<p><em>Markdown rendering failed: ${escape(message)}</em></p><pre><code>${escape(content)}</code></pre>`
          )
        }
      })

    return () => {
      stale = true
    }
  }, [content, baseContent])

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

  // Scroll to a heading requested by a cross-document navigation (set by
  // App.tsx's onNavigateToFile) once this document's content has rendered.
  useEffect(() => {
    if (!scrollToAnchor) return
    if (scrollToId(ref.current, scrollToAnchor)) onAnchorConsumed()
  }, [scrollToAnchor, html])

  const onClick = (e: React.MouseEvent): void => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    const classification = classifyLinkHref(href, absPath, workspaceRoot)
    if (classification.kind === 'external') {
      window.viewmaster.openExternal(classification.url)
    } else if (classification.kind === 'anchor') {
      scrollToId(ref.current, classification.id)
    } else if (classification.kind === 'navigate') {
      onNavigate(classification.absPath, classification.anchor)
    }
  }

  return (
    <div className="markdown-scroll">
      <div
        ref={ref}
        className="markdown-body"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (this step will also surface the now-outdated call sites in `ContentPane.tsx` — expected, fixed in Task 6).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/MarkdownView.tsx
git commit -m "feat: classify and act on markdown link clicks in MarkdownView"
```

---

### Task 6: Renderer — thread navigation props through `ContentPane`

**Files:**
- Modify: `src/renderer/src/components/ContentPane.tsx`

**Interfaces:**
- Consumes: `MarkdownView`'s new props (Task 5).
- Produces: `ContentPane` gains props `workspaceRoot: string`, `onNavigate: (absPath: string, anchor?: string) => void`, `scrollToAnchor: string | null`, `onAnchorConsumed: () => void`. Consumed by Task 7 (`App.tsx`).

No automated test — `ContentPane.tsx` has no existing test file (same gap as Task 5). Covered by Task 8.

- [ ] **Step 1: Add the four new props to the function signature**

In `src/renderer/src/components/ContentPane.tsx`, change lines 18-28 from:

```tsx
export default function ContentPane({
  file,
  refreshKey,
  selection,
  versions
}: {
  file: ChangedFile | null
  refreshKey: number
  selection: Selection
  versions: HistoryVersion[]
}): React.JSX.Element {
```

to:

```tsx
export default function ContentPane({
  file,
  refreshKey,
  selection,
  versions,
  workspaceRoot,
  onNavigate,
  scrollToAnchor,
  onAnchorConsumed
}: {
  file: ChangedFile | null
  refreshKey: number
  selection: Selection
  versions: HistoryVersion[]
  workspaceRoot: string
  onNavigate: (absPath: string, anchor?: string) => void
  scrollToAnchor: string | null
  onAnchorConsumed: () => void
}): React.JSX.Element {
```

- [ ] **Step 2: Pass the new props to both `MarkdownView` call sites**

Change lines 122-130 from:

```tsx
  } else if (mode === 'marks' && isMarkdown(file.path)) {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading marks…" />
      ) : (
        <MarkdownView content={compareContent} baseContent={baseContent} />
      )
  } else if (isMarkdown(file.path)) {
    body = <MarkdownView content={content.content} />
  } else {
```

to:

```tsx
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
          onNavigate={onNavigate}
          scrollToAnchor={scrollToAnchor}
          onAnchorConsumed={onAnchorConsumed}
        />
      )
  } else if (isMarkdown(file.path)) {
    body = (
      <MarkdownView
        content={content.content}
        absPath={file.absPath}
        workspaceRoot={workspaceRoot}
        onNavigate={onNavigate}
        scrollToAnchor={scrollToAnchor}
        onAnchorConsumed={onAnchorConsumed}
      />
    )
  } else {
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors (this will surface the now-outdated `<ContentPane>` call site in `App.tsx` — expected, fixed in Task 7).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ContentPane.tsx
git commit -m "feat: thread markdown navigation props through ContentPane"
```

---

### Task 7: Renderer — `onNavigateToFile` and pending-anchor state in `App.tsx`

**Files:**
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `ContentPane`'s new props (Task 6).
- Produces: no new exported interface — `App`'s own props are unchanged (it's the root component).

No automated test — `App.tsx` has no existing test file. Covered by Task 8.

- [ ] **Step 1: Add `pendingAnchor` state and the navigation handler**

In `src/renderer/src/App.tsx`, add after the existing `onSelectRevision` callback (after line 129, before the `if (!repo)` early return):

```tsx
  const [pendingAnchor, setPendingAnchor] = useState<{ absPath: string; anchor: string } | null>(
    null
  )

  const onNavigateToFile = useCallback(
    (absPath: string, anchor?: string): void => {
      if (!repo || (repo.kind !== 'repo' && repo.kind !== 'folder')) return
      const existing = repo.files.find((f) => f.absPath === absPath)
      if (existing) {
        setSelected(existing)
      } else {
        // Linked file has no git-changed entry in the current listing (e.g.
        // Changed mode with an untouched target) — synthesize the same shape
        // Browse Mode's overlayStatus already gives unchanged files.
        const rel = absPath.startsWith(repo.root)
          ? absPath.slice(repo.root.length).replace(/^\/+/, '')
          : absPath
        setSelected({ path: rel, absPath, status: 'unchanged' })
      }
      setPendingAnchor(anchor ? { absPath, anchor } : null)
    },
    [repo]
  )

  const onAnchorConsumed = useCallback((): void => {
    setPendingAnchor(null)
  }, [])
```

`pendingAnchor` stores the target `absPath` alongside the anchor, not just the anchor string. This is load-bearing, not incidental: the `<ContentPane>` call site in Step 2 only forwards the anchor when it still matches the *currently selected* file. If the anchor were tracked as a bare string, selecting an unrelated file afterward (e.g. via the sidebar, before `MarkdownView` ever consumed the pending anchor) could cause a spurious scroll if that unrelated file happens to have a heading with a matching slug. Tying the anchor to its target path closes that off without needing a separate clear-on-select effect.

The `useState` import already exists at the top of the file (`import { useCallback, useEffect, useState } from 'react'`) — no import changes needed for this step.

- [ ] **Step 2: Pass the new props to `<ContentPane>`**

Change the `<ContentPane>` call (currently):

```tsx
          <ContentPane
            file={selected}
            refreshKey={refreshKey}
            selection={selection}
            versions={versions}
          />
```

to:

```tsx
          <ContentPane
            file={selected}
            refreshKey={refreshKey}
            selection={selection}
            versions={versions}
            workspaceRoot={repo?.root ?? ''}
            onNavigate={onNavigateToFile}
            scrollToAnchor={
              pendingAnchor && selected && pendingAnchor.absPath === selected.absPath
                ? pendingAnchor.anchor
                : null
            }
            onAnchorConsumed={onAnchorConsumed}
          />
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS (no test targets these files directly, but this confirms nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: navigate to linked files and scroll to their anchor from markdown links"
```

---

### Task 8: Manual end-to-end verification

**Files:** none (fixture files live in a scratch temp directory, not the repo).

No automated coverage exists for the full render → click → navigate/scroll pipeline end-to-end (Tasks 4-7's justification above). This task is the only place that verifies it actually works in the real app. Use the **run-viewmaster** skill to drive the app.

- [ ] **Step 1: Build a fixture folder**

```bash
mkdir -p /tmp/vm-md-link-fixture
cat > /tmp/vm-md-link-fixture/index.md <<'EOF'
# Index

## Getting Started

See the [setup guide](setup.md) for details.

Jump to [Getting Started](#getting-started) from anywhere on this page.

[Broken link](../../../etc/passwd) should do nothing.

[External](https://example.com) opens in your browser.

[Email me](mailto:test@example.com) does nothing.
EOF
cat > /tmp/vm-md-link-fixture/setup.md <<'EOF'
# Setup Guide

## Installation

Back to [Index](index.md).

See [Index's Getting Started section](index.md#getting-started) directly.
EOF
```

- [ ] **Step 2: Launch and drive the app via the run-viewmaster skill**

Use the `run-viewmaster` skill to: build/start the app, open `/tmp/vm-md-link-fixture` as a folder, select `index.md`, and take a screenshot.

Verify from the screenshot / app state:
- `index.md` renders normally (headings, paragraphs, links styled as links).
- Query the DOM for `#getting-started` (e.g. via the driver's `eval` command) and confirm an element with that id exists on the `## Getting Started` heading — confirms Task 4's heading-id assignment actually reached the rendered output.

- [ ] **Step 3: Verify cross-document navigation**

Click the "setup guide" link. Verify:
- The selected file changes to `setup.md` (check the toolbar path / sidebar highlight).
- The content pane now shows "Setup Guide" / "Installation".

Click "Back to Index". Verify it navigates back to `index.md`.

- [ ] **Step 4: Verify combined navigate + anchor**

From `setup.md`, click "Index's Getting Started section". Verify:
- The selected file changes to `index.md`.
- The view has scrolled such that the `## Getting Started` heading is visible (check via `eval`: the heading element's `getBoundingClientRect().top` is within the visible pane bounds, not off-screen below the fold — the fixture is short enough that this mainly confirms no crash and a real scroll attempt happened, since everything likely fits in-frame already; the important check is that navigation to the *correct file* happened and no error was thrown).

- [ ] **Step 5: Verify in-page anchor scrolling (no navigation)**

Back on `index.md`, click the in-page "Getting Started" link (the one with href `#getting-started`, not the cross-document one). Verify:
- The selected file does **not** change (still `index.md`, no reload/flash of a different file's content).
- No error is thrown; the click was handled by the `anchor` branch, not `navigate`.

- [ ] **Step 6: Verify inert links**

Click "Broken link" (resolves outside the workspace root). Verify: no navigation, no crash, content pane unchanged.

Click "Email me" (`mailto:`). Verify: no navigation, no crash.

Click "External" (`https://example.com`). Verify: the app does **not** navigate to it internally (content pane still shows `index.md`, not example.com) — actual OS-browser-opening confirmation may not be screenshot-able from within the driven session, same limitation noted in the earlier HTML-view feature's manual verification.

- [ ] **Step 7: Clean up the fixture**

```bash
rm -rf /tmp/vm-md-link-fixture
```

- [ ] **Step 8: Final full-suite check**

Run: `npm run build`
Expected: typecheck + build both succeed.

No commit for this task (no repo files changed) — if any verification step surfaces a bug, fix it as a small follow-up commit referencing the task/step where it was found.
