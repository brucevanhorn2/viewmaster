# Editor's-Marks Rendered Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Marks" mode for markdown files that renders the branch diff as proofreader's marks — insertions and deletions inline in the rendered output — per `docs/superpowers/specs/2026-07-08-editors-marks-diff-design.md`.

**Architecture:** Render baseline and current markdown through the existing `renderMarkdown` pipeline, merge the two HTML strings with `node-htmldiff` (treating `<pre>` blocks — shiki fences and mermaid sources — as atomic tokens), sanitize, display. One new pure module (`marksDiff.ts`) carries the diff logic and all unit tests; `MarkdownView`/`ContentPane` gain a three-state mode control for markdown files.

**Tech Stack:** node-htmldiff (new devDependency, bundled by vite), existing markdown-it/shiki/mermaid/DOMPurify pipeline, vitest.

## Global Constraints

- Marks apply to **markdown files only**; non-markdown files keep the existing View/Diff behavior exactly.
- Changed code fences and mermaid blocks appear as **old block styled removed, then new block styled inserted** — never word-diffed internally.
- Old side = same baseline as source diff (`merge-base` base, or `HEAD` in working-only mode) via the existing `viewmaster.readBaseFile(relPath)`; empty old side (untracked) → everything marked inserted.
- Failures degrade to the plain rendered current view with a one-line notice — never a blank pane.
- `ins` = green tint, no underline; `del` = red tint + strikethrough; removed blocks red left edge + dimmed; inserted blocks green left edge. Dark theme only.
- `composeMarks` stays pure (string → string, no DOM) so it is unit-testable in vitest's node environment.

---

### Task 1: `composeMarks` pure module

**Files:**
- Create: `src/renderer/src/markdown/marksDiff.ts`
- Test: `src/renderer/src/markdown/marksDiff.test.ts`
- Modify: `package.json` (add `node-htmldiff` devDependency), `src/renderer/src/env.d.ts` (module declaration — the package ships no types)

**Interfaces:**
- Consumes: nothing from the app (pure).
- Produces: `composeMarks(oldHtml: string, newHtml: string): string` — merged HTML where prose changes are wrapped in `<ins>`/`<del>` and whole `<pre>` blocks appear atomically inside `<ins>`/`<del>` when changed. Consumed by Task 2.

- [ ] **Step 1: Install dependency**

```bash
npm install --save-dev node-htmldiff
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/renderer/src/markdown/marksDiff.test.ts
import { describe, it, expect } from 'vitest'
import { composeMarks } from './marksDiff'

const PRE_A = '<pre class="shiki"><code>const a = 1</code></pre>'
const PRE_B = '<pre class="shiki"><code>const b = 2</code></pre>'
const MERMAID_A = '<pre class="mermaid">flowchart LR\n A --> B</pre>'
const MERMAID_B = '<pre class="mermaid">flowchart LR\n A --> C</pre>'

describe('composeMarks', () => {
  it('marks inserted words with ins', () => {
    const out = composeMarks('<p>the cat sat</p>', '<p>the fat cat sat</p>')
    expect(out).toContain('<ins')
    expect(out).toMatch(/<ins[^>]*>\s*fat\s*<\/ins>/)
    expect(out).not.toContain('<del')
  })

  it('marks deleted words with del', () => {
    const out = composeMarks('<p>the fat cat sat</p>', '<p>the cat sat</p>')
    expect(out).toMatch(/<del[^>]*>\s*fat\s*<\/del>/)
  })

  it('passes an unchanged pre block through intact and unmarked', () => {
    const out = composeMarks(`<p>x</p>${PRE_A}`, `<p>x y</p>${PRE_A}`)
    expect(out).toContain(PRE_A)
    // the pre itself is not inside ins/del
    const preIdx = out.indexOf('<pre')
    const insIdx = out.indexOf('<ins')
    expect(insIdx).toBeGreaterThan(-1)
    expect(out.slice(0, preIdx)).not.toMatch(/<(ins|del)[^>]*>[^<]*$/)
  })

  it('shows a changed code block as old-in-del then new-in-ins', () => {
    const out = composeMarks(`<p>intro</p>${PRE_A}`, `<p>intro</p>${PRE_B}`)
    const delIdx = out.indexOf('const a = 1')
    const insIdx = out.indexOf('const b = 2')
    expect(delIdx).toBeGreaterThan(-1)
    expect(insIdx).toBeGreaterThan(delIdx)
    // old block wrapped by del, new by ins
    expect(out.slice(0, delIdx)).toMatch(/<del[^>]*>(?:(?!<\/del>).)*$/s)
    expect(out.slice(0, insIdx)).toMatch(/<ins[^>]*>(?:(?!<\/ins>).)*$/s)
  })

  it('treats mermaid blocks atomically', () => {
    const out = composeMarks(MERMAID_A, MERMAID_B)
    // both complete sources present, never word-merged
    expect(out).toContain('A --> B')
    expect(out).toContain('A --> C')
    expect(out.match(/<pre class="mermaid">/g)?.length).toBe(2)
  })

  it('marks everything inserted when the old side is empty (untracked file)', () => {
    const out = composeMarks('', '<p>brand new</p>')
    expect(out).toMatch(/<ins/)
    expect(out).not.toContain('<del')
  })

  it('returns unchanged content without marks', () => {
    const html = '<p>same</p>'
    expect(composeMarks(html, html)).not.toMatch(/<(ins|del)/)
  })
})
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/renderer/src/markdown/marksDiff.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// src/renderer/src/markdown/marksDiff.ts
import htmldiff from 'node-htmldiff'

/**
 * Merge two rendered-markdown HTML strings into one with editor's marks:
 * word-level <ins>/<del> in prose, whole <pre> blocks (shiki fences,
 * mermaid sources) treated atomically so a changed block appears as
 * old-block-in-del followed by new-block-in-ins.
 */
export function composeMarks(oldHtml: string, newHtml: string): string {
  // 'pre' added to htmldiff's atomic tag set; the rest are its defaults.
  return htmldiff(oldHtml, newHtml, null, null, 'pre,iframe,object,math,svg,script,video,head,style')
}
```

```ts
// append to src/renderer/src/env.d.ts
declare module 'node-htmldiff' {
  export default function htmldiff(
    before: string,
    after: string,
    className?: string | null,
    dataPrefix?: string | null,
    atomicTags?: string | null
  ): string
}
```

If `atomicTags` does not deliver the old-del/new-ins contract, fall back to the placeholder strategy from the spec: regex-extract `<pre[\s\S]*?<\/pre>` from both inputs into a hash-keyed map, diff with placeholders `<div data-vm-block="<hash>"></div>`, then reinflate (scanning ins/del nesting to pick old/new). The tests, not the mechanism, are the contract.

- [ ] **Step 5: Run to verify pass** — same command, expect 7 passed.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: composeMarks html-level editor's-marks diff"`

---

### Task 2: UI integration — three-state mode for markdown

**Files:**
- Modify: `src/renderer/src/components/MarkdownView.tsx` (accept optional `baseContent`; compose marks when present)
- Modify: `src/renderer/src/components/ContentPane.tsx` (mode `'view' | 'marks' | 'diff'`; fetch base in marks mode; segmented control for markdown)
- Modify: `src/renderer/src/styles.css` (ins/del + block mark styles)

**Interfaces:**
- Consumes: `composeMarks(oldHtml, newHtml)` (Task 1); `renderMarkdown(src)` (existing); `window.viewmaster.readBaseFile(relPath)` (existing).
- Produces: `<MarkdownView content={string} baseContent={string | null} />` — `baseContent === null` → plain rendered view (today's behavior); string (possibly '') → marks view.

- [ ] **Step 1: MarkdownView** — render both sides when `baseContent` is a string:

```tsx
// inside MarkdownView; replaces the single renderMarkdown effect
useEffect(() => {
  let stale = false
  const render = async (): Promise<string> => {
    if (baseContent === null) return renderMarkdown(content)
    const [oldHtml, newHtml] = await Promise.all([
      renderMarkdown(baseContent),
      renderMarkdown(content)
    ])
    return sanitizeMarks(composeMarks(oldHtml, newHtml))
  }
  render()
    .then((rendered) => { if (!stale) setHtml(rendered) })
    .catch(/* existing escaped-source fallback, prefixed with the notice
             '<p><em>Marks unavailable: …</em></p>' when baseContent !== null,
             falling back to renderMarkdown(content) first if marks composition
             was the failing step */)
  return () => { stale = true }
}, [content, baseContent])
```

`sanitizeMarks` = `DOMPurify.sanitize` re-export from `markdown/render.ts` (export a `sanitizeHtml(html: string): string` helper there so both paths share one sanitizer config). Note `renderMarkdown` already sanitizes its own output; composing marks from two sanitized strings then re-sanitizing is safe and cheap. Mermaid: existing `mermaid.run` effect works unchanged — changed diagrams appear twice (old in `del`, new in `ins`) and both render.

- [ ] **Step 2: ContentPane** — extend `Mode`:

```tsx
type Mode = 'view' | 'marks' | 'diff'
```

Base-content effect fetches when `mode === 'diff' || mode === 'marks'`. Body routing: markdown + `mode === 'marks'` → `<MarkdownView content={c} baseContent={baseContent ?? ''} />`; markdown + `mode === 'view'` → `<MarkdownView content={c} baseContent={null} />`. Toolbar for markdown text files becomes a segmented control:

```tsx
{isMarkdown(file.path) ? (
  <span className="toolbar-segment">
    {(['view', 'marks', 'diff'] as const).map((m) => (
      <button key={m}
        className={`toolbar-button${mode === m ? ' active' : ''}`}
        onClick={() => setMode(m)}>
        {m === 'view' ? 'Rendered' : m === 'marks' ? 'Marks' : 'Source'}
      </button>
    ))}
  </span>
) : /* existing Diff + Inline/Side-by-side buttons */}
```

Keep the Inline/Side-by-side toggle visible only when `mode === 'diff'` (both file kinds).

- [ ] **Step 3: Styles** — append to `styles.css`:

```css
.markdown-body ins { background: rgba(87, 166, 74, 0.28); text-decoration: none; border-radius: 2px; }
.markdown-body del { background: rgba(229, 83, 75, 0.22); text-decoration: line-through; text-decoration-color: #e5534b; border-radius: 2px; }
.markdown-body del pre, .markdown-body ins pre { text-decoration: none; }
.markdown-body del pre { border-left: 3px solid #e5534b; opacity: 0.62; }
.markdown-body ins pre { border-left: 3px solid #57a64a; }
.markdown-body ins, .markdown-body del { padding: 0 1px; }
.toolbar-segment { display: inline-flex; gap: 0; }
.toolbar-segment .toolbar-button { border-radius: 0; }
.toolbar-segment .toolbar-button:first-child { border-radius: 3px 0 0 3px; }
.toolbar-segment .toolbar-button:last-child { border-radius: 0 3px 3px 0; }
```

- [ ] **Step 4: Verify** — `npm test` (all green), `npm run typecheck`, then dev-app walkthrough (Task 3).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: Marks mode — rendered editor's-marks diff for markdown"`

---

### Task 3: Verification + docs

**Files:**
- Modify: `README.md` (move the feature from Roadmap to Features)

- [ ] **Step 1: Dev-app verification** (CDP method from the MVP build): launch with `VIEWMASTER_OPEN`, modify a committed markdown file (prose edit + change a mermaid edge + change a code fence), open Marks mode, screenshot; confirm word-level ins/del in prose, old/new blocks for the fence and diagram (both diagrams drawn), Rendered/Source modes still fine, non-markdown toolbar unchanged.
- [ ] **Step 2: README** — Features gains: "**Editor's-marks diff for markdown** — toggle *Marks* to see the branch's changes as proofreader's marks inline in the rendered output; changed code fences and mermaid diagrams show old (struck) and new blocks."; remove the corresponding Roadmap line.
- [ ] **Step 3: Full suite + build** — `npm test`, `npm run build` green.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: editor's-marks feature in README"`

---

## Self-Review Notes

- Spec coverage: HTML-level diff (T1), atomic pre blocks old-del/new-ins (T1 tests 4–5), three-state UI (T2), baseline semantics + untracked all-inserted (T2 base fetch reuses `readBaseFile`; T1 test 6), styling (T2 step 3), fallback-never-blank (T2 step 1 catch), tests-in-node (T1), out-of-scope respected.
- Type consistency: `composeMarks(oldHtml: string, newHtml: string): string` used identically in T1/T2; `MarkdownView` prop `baseContent: string | null` consistent between T2 steps 1–2.
