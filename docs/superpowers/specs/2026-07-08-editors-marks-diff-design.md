# viewmaster — Rendered Editor's-Marks Diff (Design Spec)

**Date:** 2026-07-08
**Status:** Approved
**Extends:** `2026-07-08-viewmaster-design.md` (MVP), which listed this as the roadmap "dream feature".

## Purpose

For markdown files, show what a branch changed *in the rendered output*, like a
proofreader's marks: inserted text highlighted, deleted text struck through —
instead of (or alongside) the Monaco source diff.

## Approach

Diff at the **rendered-HTML level**:

1. Render the baseline content (`git show <base>:<path>`, already exposed via
   `viewmaster.readBaseFile`) and the current content through the existing
   `renderMarkdown` pipeline (markdown-it + shiki + mermaid markers).
2. Merge the two HTML strings with **`node-htmldiff`**, which emits combined
   HTML with `<ins>`/`<del>` around changes. Prose gets word-level marks and
   document structure survives, because we diff the rendered output, not the
   markdown source.
3. Sanitize the merged HTML with DOMPurify (as the rendered view already does;
   `ins`/`del` are in its default allowlist), insert it, then run mermaid.

Rejected alternatives: custom markdown-it token-stream alignment (too much
bespoke alignment code for the value) and injecting diff markers into markdown
source before rendering (deletions spanning syntax corrupt the rendering).

## Atomic blocks (code fences & mermaid)

Word-diffing inside highlighted code or diagram source produces garbage, so
every top-level `<pre …>…</pre>` is treated **atomically**:

- Before diffing, each `<pre>` block in both documents is replaced by a
  placeholder element keyed by a content hash.
- After htmldiff, placeholders are reinflated:
  - Identical hash on both sides → the block re-emerges unchanged.
  - A placeholder wrapped in `<del>` → the **old** block, styled as removed
    (red left edge, dimmed, "removed" affordance).
  - A placeholder wrapped in `<ins>` → the **new** block, styled as inserted
    (green left edge).
  - A changed block therefore appears as old-removed followed by new-inserted.
- Mermaid `<pre class="mermaid">` blocks participate identically; both old and
  new diagrams render as diagrams, so the before/after picture is visible.

## Components

- **`src/renderer/src/markdown/marksDiff.ts`** (new, pure):
  `composeMarks(oldHtml: string, newHtml: string): string` — placeholder
  extraction → `node-htmldiff` → reinflation. String-in/string-out; no DOM.
- **`MarkdownView`**: gains a mode where it receives old + new markdown,
  renders both, composes marks, sanitizes, displays. Mermaid/link handling
  unchanged.
- **`ContentPane`**: for markdown files the mode control becomes three-state —
  **Rendered | Marks | Source** (Source = existing Monaco diff). Non-markdown
  files keep the existing View/Diff behavior exactly. Marks mode fetches the
  base content exactly like source-diff mode (same baseline semantics:
  merge-base, or HEAD in working-only mode; empty old side for untracked →
  everything shows inserted).

## Styling

Proofreading conventions, dark-theme calibrated:
- `ins` — green tint background, no underline.
- `del` — red tint background, strikethrough.
- Removed blocks — red left border, reduced opacity.
- Inserted blocks — green left border.

## Error handling

- `composeMarks` failure (or render failure of either side) → fall back to the
  plain rendered view of the current content with a one-line notice; never a
  blank pane.
- Binary/too-large/missing files never reach marks mode (existing guards).

## Testing

`composeMarks` unit tests (vitest, node environment, no DOM): word-level
ins/del in prose; unchanged code block passes through byte-identical; changed
code block yields old-removed + new-inserted in order; mermaid blocks treated
atomically; added-only and removed-only documents; empty old side (untracked
case) marks everything inserted. UI wiring verified manually (dev app).

## Out of scope

- Marks for non-markdown files.
- Word-level marks *inside* code blocks.
- Side-by-side rendered old/new mode.
