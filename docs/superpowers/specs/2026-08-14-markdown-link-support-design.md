# View Master — Markdown Link Support (Design Spec)

**Date:** 2026-08-14
**Status:** Approved
**Extends:** `2026-07-08-viewmaster-design.md` (MVP). Resolves issue #5.

## Purpose

Today `MarkdownView.tsx` renders every hyperlink as inert except `https?://`
links, which open in the default browser (`MarkdownView.tsx:79-86`, comment:
"All hyperlinks open in the default browser; no in-app navigation"). A
relative link between two markdown documents in the same folder — the
single most common link shape in a personal-notes/wiki-style folder — does
nothing when clicked. This blocks the issue's stated use case: browsing a
folder of markdown documents (à la Obsidian) with working cross-document
links.

## Load-bearing decisions (settled during brainstorming)

1. **Scope: standard Markdown links only, not Obsidian `[[Wikilinks]]`.**
   The issue's primary sentence asks for links that "work in the same way
   we currently support links in HTML" — i.e. ordinary `[text](path)`
   links, resolved and intercepted the same way the (separate, unmerged)
   HTML-view feature already does for `.html` files. `[[Wikilink]]` syntax
   is a materially different parser feature (markdown-it has no native
   support for it) and is explicitly out of scope; a candidate follow-up
   issue, not bundled here.
2. **Built independently, not depending on the unmerged
   `worktree-rendered-html-view` branch.** That branch already has
   equivalent `classifyLinkHref`/`onNavigate`/`workspaceRoot` plumbing for
   HTML files, but is unreviewed/unmerged. This spec re-implements the same
   shape fresh (own `paths.ts`/`links.ts` modules) rather than depending on
   it — the user's explicit choice, accepting that reconciling the two
   near-identical implementations is deferred to whenever that branch
   eventually merges.
3. **In-page anchor links are in scope.** `[Section](#section)` scrolls the
   current document to the heading with a matching slug, rather than being
   a no-op (as the HTML-view feature chose for its first pass). Requires
   giving markdown-rendered headings `id` attributes, which `markdown-it`
   does not do by default.
4. **Heading slugs follow GitHub's common convention** (lowercase, strip
   punctuation except hyphens, spaces→hyphens, duplicate headings get
   `-1`/`-2`/... suffixes) — the algorithm most markdown authors already
   expect from writing docs elsewhere, and requires no new dependency: a
   small slugger function, applied via the same custom-renderer-rule
   pattern `render.ts` already uses for mermaid fences (`render.ts:26-33`),
   not a `markdown-it-anchor` plugin.
5. **Cross-document + anchor combination is supported.**
   `[Section in Other Doc](other.md#section)` navigates to `other.md` *and*
   scrolls to `#section` once it renders — not treated as two independent,
   unrelated features.
6. **Any relative in-workspace link navigates, not just markdown targets.**
   Matches the HTML-view precedent: a relative link to any file inside the
   workspace root (an image, a PDF, a code file) re-selects that file in
   View Master, the same way `App.tsx`'s existing file-selection flow
   already handles any `ChangedFile`. Not markdown-to-markdown-only.
7. **Unresolvable/out-of-scope links are silent no-ops** — a link escaping
   the workspace root, a nonexistent target, `mailto:`/other schemes, or an
   empty href does nothing (`preventDefault()` only), matching the
   HTML-view precedent's v1 behavior.
8. **No main-process/IPC changes.** This is pure renderer-side parsing and
   navigation logic on top of content already loaded through the existing
   `file:read` flow — no new disk reads, no new IPC surface.

## Rendering pipeline changes

`src/renderer/src/markdown/render.ts`:

- New slug-assignment step: after `md.render(src)` tokenizes headings,
  assign each `heading_open` token an `id` attribute via a small
  `slugify(text, seen: Map<string, number>)` helper (own module,
  `src/renderer/src/markdown/slug.ts`) — lowercase, strip everything but
  `[a-z0-9\s-]`, collapse whitespace to single hyphens, trim leading/
  trailing hyphens; on a repeat slug within one render pass, append
  `-1`/`-2`/... Applied via a renderer-rule override on `heading_open`,
  same technique already used for the mermaid `fence` override.
- `renderMarkdown`'s sanitizer call (`sanitizeHtml`, `DOMPurify.sanitize`)
  already passes through standard `id` attributes untouched — no
  sanitizer config change needed.

## Link classification & navigation

New `src/renderer/src/markdown/paths.ts` (forward-slash-only, since
renderer code has no Node `path` module access):
`joinPath(...segments)`, `dirnamePath(path)`, `isInsideRoot(path, root)` —
same contracts as the equivalent (unmerged) HTML-view module, rebuilt fresh
per decision #2.

New `src/renderer/src/markdown/links.ts`:
`classifyLinkHref(href, mdAbsPath, workspaceRoot): LinkClassification`
where
```ts
type LinkClassification =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'navigate'; absPath: string; anchor?: string }
  | { kind: 'noop' }
```
- `^https?:\/\//` → `external`.
- Empty href, or any other URI scheme (`mailto:`, `tel:`, `javascript:`,
  `data:`, ...) → `noop`.
- A href that is *only* a fragment (`#section`) → `anchor` with the
  fragment (sans `#`) as `id`.
- Otherwise: split off an optional trailing `#fragment`; resolve the path
  portion against `dirnamePath(mdAbsPath)` (or `workspaceRoot` if it starts
  with `/`, workspace-root-relative); if the resolved path is inside
  `workspaceRoot`, return `navigate` with that `absPath` and the optional
  `anchor`; otherwise `noop`.

`src/renderer/src/components/MarkdownView.tsx`:
- Gains props `absPath: string`, `workspaceRoot: string`,
  `onNavigate: (absPath: string, anchor?: string) => void`, and
  `scrollToAnchor?: string | null` / `onAnchorConsumed: () => void` (see
  below).
- `onClick` replaces its current bare `https?://` check with
  `classifyLinkHref`: `external` → `window.viewmaster.openExternal(url)`
  (unchanged); `anchor` → find the element with that `id` inside the
  rendered container and `scrollIntoView({ behavior: 'smooth' })`, no
  state change; `navigate` → `onNavigate(absPath, anchor)`; `noop` →
  nothing (already `preventDefault()`ed by the shared anchor-closest
  check).
- New effect: when `scrollToAnchor` is set and the target `id` exists in
  the just-rendered `html`, scroll to it and call `onAnchorConsumed()` so
  it doesn't re-fire on unrelated re-renders (e.g. a watcher-driven
  refresh). If the id isn't present yet (content still rendering async),
  the effect's dependency on `html` re-checks after the next render.

`src/renderer/src/components/ContentPane.tsx`: threads `workspaceRoot`,
`onNavigate`, and the `scrollToAnchor`/`onAnchorConsumed` pair straight
through to `MarkdownView`, mirroring how `file`/`refreshKey` are already
threaded.

`src/renderer/src/App.tsx`: new `onNavigateToFile(absPath, anchor?)`
handler — resolve `absPath` against `repo.files`; if found, `setSelected`
to it; if not (e.g. an unchanged file in Changed mode), synthesize a
minimal `ChangedFile` the same way Browse Mode's overlay already does for
untouched files. If `anchor` is present, also set a `pendingAnchor` state
value, passed to `ContentPane` as `scrollToAnchor`, cleared by
`onAnchorConsumed`.

## Module layout

```
src/renderer/src/markdown/slug.ts             GitHub-style heading slugger
src/renderer/src/markdown/paths.ts            forward-slash path helpers
src/renderer/src/markdown/links.ts            classifyLinkHref
src/renderer/src/markdown/render.ts           heading_open override assigns slugs (modified)
src/renderer/src/components/MarkdownView.tsx  link click handling, anchor scroll (modified)
src/renderer/src/components/ContentPane.tsx   workspaceRoot/onNavigate/scrollToAnchor threading (modified)
src/renderer/src/App.tsx                      onNavigateToFile + pendingAnchor state (modified)
```

## Testing

- `slug.test.ts`: lowercase/punctuation-stripping/space-to-hyphen rules;
  duplicate headings get `-1`/`-2` suffixes; empty/all-punctuation heading
  text produces a sane fallback (non-empty slug).
- `paths.test.ts`: same cases as the equivalent HTML-view module (root
  itself, descendant, outside-root rejection, sibling name-prefix
  collision rejection).
- `links.test.ts`: external, bare-anchor, path-only navigate, path+anchor
  navigate, workspace-root-relative (leading `/`) navigate, out-of-root
  no-op, mailto/other-scheme no-op, empty-href no-op.
- No automated test for `MarkdownView.tsx`/`ContentPane.tsx`/`App.tsx`
  (no `.tsx` test infrastructure in this codebase — consistent gap already
  accepted for every other view component). Covered by a manual
  verification task: a small fixture of linked markdown files, verifying
  cross-file navigation, anchor scroll (same-doc and combined with
  navigation), and that external/mailto/out-of-workspace links are inert.

## Non-goals (this pass)

- Obsidian `[[Wikilink]]` syntax — decision #1.
- Reconciling with the unmerged HTML-view branch's equivalent code —
  decision #2; a future cleanup once that branch lands.
- Backlinks, a graph view, or any other Obsidian feature beyond link
  navigation — not requested by the issue.
- Non-GitHub slug conventions or configurable slug algorithms.
