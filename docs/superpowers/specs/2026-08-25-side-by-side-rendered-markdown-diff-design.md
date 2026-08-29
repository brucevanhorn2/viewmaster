# Side-by-Side Rendered Markdown Diff Design

## Problem

Viewmaster's markdown diff currently has two modes: **Marks** (old/new
merged into one rendered view, insertions highlighted, deletions struck
through) and **Source** (raw markdown text, diffed via Monaco's side-by-side
code diff view — not rendered). There is no mode that shows the old and new
*rendered* markdown side by side as two independent documents. Issue
[#11](https://github.com/brucevanhorn2/viewmaster/issues/11) asks for this
as an alternate diff mode, carried over from the README roadmap.

## Scope

Add a fourth toggle option, **Side-by-Side**, to the existing markdown
toggle (`Rendered | Marks | Source` → `Rendered | Marks | Side-by-Side |
Source`). Marks and Source are unchanged. Side-by-Side renders the base and
compare revisions as two independent, fully-rendered markdown documents in
adjacent panes, with synced scrolling.

Out of scope: changes to Marks or Source; any change to how baseline/
revision selection works; anything for non-markdown files.

## Design

### Toggle placement

`ContentPane.tsx`'s `Mode` type gains a new value alongside `'view' | 'marks'
| 'code'`. The markdown toggle's button list becomes `['view', 'marks',
'sideBySide', 'diff']` (labels: Rendered / Marks / Side-by-Side / Source —
`'diff'` already means "Source" for markdown, per the existing label logic
at `ContentPane.tsx`'s toggle rendering; this plan doesn't touch that
naming, just adds one more entry before it in the button list).

### Data flow

`ContentPane.tsx`'s existing revision-resolution effect (around line 119:
`if (!file || (mode !== 'diff' && mode !== 'marks')) return`) already
resolves `baseContent`/`compareContent` from the current `Selection` for
both Marks and Source modes, via the same `resolve(ref: RevisionRef)`
helper (baseline / a historical version / "now"). This condition simply
gains a third mode: `mode !== 'diff' && mode !== 'marks' && mode !==
'sideBySide'`. No new IPC handlers, no new resolution logic — this is
purely reusing what already exists for the other two diff-capable modes.

`ContentPane.tsx`'s body-selection `if/else if` chain gains a new branch
for `mode === 'sideBySide' && isMarkdown(file.path)`, positioned the same
way the existing `mode === 'marks' && isMarkdown(file.path)` branch is,
rendering the new `MarkdownSideBySideView` component with `baseContent`/
`compareContent` (falling back to a `Placeholder` while either is still
`null`, matching the existing Marks-mode loading behavior).

### Shared rendering pipeline

`MarkdownView.tsx` currently inlines its own render-to-HTML logic in a
`useEffect`: call `renderMarkdown` (and for Marks mode, `composeMarks` over
both old/new renders), run mermaid over `pre.mermaid` nodes post-render,
and handle a rendering failure with a fallback message. This logic —
minus the Marks-specific `composeMarks` step — is exactly what each pane of
the new side-by-side view needs (render one markdown string to sanitized
HTML, run mermaid on it, handle failure with a fallback message).

Extract this into a small reusable piece both components call: a function
(or hook) that takes a markdown string and returns a settled result — the
sanitized HTML on success, or a fallback HTML string with the error message
inlined on failure — plus a small effect helper for running mermaid over a
container ref once new HTML has committed to the DOM. `MarkdownView.tsx`'s
own plain-render path (`baseContent === null`) and each pane of
`MarkdownSideBySideView` all become thin callers of this shared piece,
rather than three independent copies of the same render-then-mermaid
choreography. `MarkdownView`'s Marks-mode path (`composeMarks` over two
renders) stays as it is today — it already reuses `renderMarkdown` directly
and isn't touched by this extraction beyond continuing to call the same
underlying function.

### MarkdownSideBySideView component

New file, `src/renderer/src/components/MarkdownSideBySideView.tsx`. Props:

```ts
{
  baseContent: string
  content: string
  absPath: string
  workspaceRoot: string
  onNavigate: (absPath: string, anchor?: string) => void
  scrollToAnchor: string | null
  onAnchorConsumed: () => void
}
```

Renders two panes side by side (a two-column flex/grid layout, new CSS
class(es) added to `styles.css`), each using the shared render pipeline
above:

- **Old pane** (from `baseContent`): rendered HTML, mermaid diagrams run
  normally, but **no click handler is attached** — links render as inert
  text (no `onClick`, and the existing `classifyLinkHref`/`onNavigate`
  wiring is not used for this pane at all). This is a deliberate,
  explicit design choice: a link's target may not exist, or may mean
  something different, at the revision being shown in this pane, and
  letting it navigate via the *current* file tree would be misleading.
- **New pane** (from `content`): identical behavior to today's `Rendered`
  mode — full link interactivity via `classifyLinkHref`/`onNavigate`, and
  it's the only pane wired to `scrollToAnchor`/`onAnchorConsumed` (a
  cross-document navigation target refers to the current revision, not a
  historical one).

Each pane's render failure is independent and caught separately — a
broken old-revision render shows its own fallback message without
affecting the new pane, and vice versa (mirrors `MarkdownView`'s existing
per-render failure handling, just not merged into one shared failure path).

### Scroll sync

Each pane's scrollable container gets a ref. A scroll listener on either
pane computes `scrollTop / (scrollHeight - clientHeight)` (0 when the
content doesn't overflow) and applies that same fraction to the other
pane's `scrollTop`. A boolean ref (`isSyncingRef`) is set before
programmatically assigning the other pane's `scrollTop` and cleared
immediately after, so that assignment's own resulting `scroll` event
doesn't re-trigger the sync back onto the originating pane (the standard
guard for this kind of bidirectional sync).

### Error handling

No new error paths beyond what's described above (independent per-pane
render-failure fallback, reusing the shared pipeline's existing fallback
behavior). No new IPC calls means no new IPC-level error handling is
needed.

### Testing

**Correction from an earlier draft of this spec:** `src/renderer/src/markdown/render.ts`
(the module `renderMarkdown`/`sanitizeHtml` live in) has **no existing test
file** — verified there is no `render.test.ts` anywhere under
`src/renderer/src/markdown/`, unlike `marksDiff.test.ts`/`links.test.ts`/
`paths.test.ts`/`slug.test.ts`, which do exist. This is not an oversight:
`sanitizeHtml` calls `DOMPurify.sanitize`, and `DOMPurify`'s default export
has no working `.sanitize` method outside a real DOM (`DOMPurify.sanitize`
is `undefined` under plain Node — confirmed directly against this repo's
installed `dompurify` package). This repo's `vitest.config.ts` runs
`environment: 'node'` with no jsdom, so anything importing `render.ts`
(directly or transitively) cannot be unit-tested as written today.

This means the extracted shared render-pipeline function
(`renderMarkdownToHtml`, wrapping `renderMarkdown` with a fallback for
render failures) is **not unit-testable** in this repo's current test
setup, for the same reason `render.ts` itself isn't — this is a
pre-existing gap in the codebase, not something this feature introduces or
is expected to fix. Verification for this extraction is `npm run
typecheck` plus manual verification via `run-viewmaster` (open a markdown
file with a revision diff, switch to Side-by-Side, confirm both panes
render including a mermaid diagram, confirm scroll sync, confirm the old
pane's links are inert and the new pane's aren't).

Neither `MarkdownSideBySideView.tsx` nor the `ContentPane.tsx` toggle
change gets a dedicated test file either — this repo has zero
component-level (`.tsx`) tests anywhere (confirmed by checking
`vitest.config.ts`'s `include: ['src/**/*.test.ts']`, which excludes
`.tsx` files entirely, and by the absence of any existing
`ContentPane.test.tsx`/`MarkdownView.test.tsx`/etc.) — this plan follows
that existing convention rather than introducing component testing as a
side effect of this feature.

## Decisions confirmed with Bruce (2026-08-25)

1. Side-by-Side is a new, fourth toggle button (`Rendered | Marks |
   Side-by-Side | Source`) — not a replacement for Marks, not nested under
   Source.
2. The two panes scroll in sync (proportional position), not
   independently.
3. The old (base) pane's links are inert — not clickable/navigable. Only
   the new (compare) pane's links work, identically to today's Rendered
   mode.
4. Component structure: a new `MarkdownSideBySideView.tsx`, not an
   extended `MarkdownView.tsx` — keeps `MarkdownView` focused on its
   existing merged-rendering behavior, avoids growing its prop surface and
   internal branching for a structurally different rendering shape (two
   independent panes with synced scroll, vs. one merged HTML blob).
