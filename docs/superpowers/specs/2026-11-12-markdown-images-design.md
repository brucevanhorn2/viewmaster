# Images in rendered markdown (issue #52)

## Intent

The owner reads design docs that live in a repo's `docs/` folder, with diagrams
next to them (`![](img/flow.svg)`, `../assets/arch.png`). In Rendered mode those
images don't show today, so the docs are hard to follow. After this change they
render like they do on GitHub, get the pan/zoom from #49 for free, and in the
side-by-side diff each version shows its own diagram.

Why it's broken today: the renderer CSP (`src/renderer/index.html`) allows only
`img-src 'self' data:`, and nothing in `src/renderer/src/markdown/render.ts`
rewrites `src`, so a relative path resolves against the app's `index.html`.

## Goals

1. **Local images load in Rendered markdown.** A relative `src` (markdown
   `![]()` or raw `<img>`/`<picture><source>`) resolves against the markdown
   file's own directory. A `src` starting with `/` resolves from the opened
   folder's root (GitHub's repo-root behaviour). URL-encoded paths (`%20`) are
   decoded; `?query`/`#fragment` suffixes are ignored for resolution.
2. **Containment.** Bytes are read only in the main process, only for files
   inside the opened folder, through the existing containment check
   (`resolveWithinRoot` / `readResource` in `src/main/files/resource.ts`,
   symlinks resolved first). The renderer never fetches local files itself.
3. **Unresolvable images are visible, not silent.** An image that is outside
   the folder, missing, unreadable, over the size limit, or not an image type
   renders as a small grey placeholder box showing the alt text (if any) and
   the original path, so the reader knows something is missing.
4. **Remote images are click-to-allow, per document (owner's decision).**
   `http:`/`https:` images are not fetched by default. When a document has any,
   a bar at the top of the rendered view says "This document has N remote
   images" with a **Load images** button. Clicking it loads them for that
   document only, for as long as that file stays open. Opening another file
   (or reopening this one) starts blocked again. Blocked remote images show the
   same placeholder box as goal 3. Nothing is persisted.
5. **Side-by-side shows each version's own images (owner's decision).** In the
   side-by-side rendered diff, each pane resolves images against the revision
   that pane is showing:
   - git baseline side: image bytes come from git at that same baseline ref
     (`git show <ref>:<path>`, binary-safe), so an old doc shows the old diagram;
     an image that didn't exist at that ref gets the placeholder.
   - "now" side: the working-tree file on disk (same as goal 1).
   - local-history snapshot side (View Master's own saved versions, which store
     only the document text): images come from disk. *(Builder's note: this is
     my call — the snapshot store has no image bytes; showing current images is
     better than none.)*
   - Remote images in side-by-side: one bar above both panes counting remote
     images across both; one click loads them in both panes. *(My call.)*
   - Paths resolve against the document's path in each revision (the same
     repo-relative path on both sides).
6. **Marks mode (owner's decision): images load from disk** (same as goal 1)
   for both deleted and added content. A diagram whose file changed but whose
   path didn't is not highlighted as a change; side-by-side is where the
   before/after diagrams are compared. Marks shows the same remote-images bar.
7. **"While the file stays open" (my call).** The remote-images allowance is
   held per file in `ContentPane` (keyed by `absPath`): it survives switching
   between Rendered, Side-by-side and Marks, and an on-disk refresh of the same
   file. Selecting any other file resets it, and so does coming back to this
   file later — including via Back/Forward or a link.
8. **Pan/zoom applies.** Loaded images are plain `<img>` elements in the
   rendered body, so the #49 `attachDocumentPanZoom` wraps them as today. Late
   loads (images resolve asynchronously) must still get wrapped — #49 already
   handles images that finish loading after attach.

## Non-goals

- HTML files: `HtmlView` already inlines local resources via
  `resolveResources` in `src/renderer/src/html/render.ts`. No change, except
  reusing its helpers where that avoids duplication.
- Source mode, code view: unchanged.
- Remote images in HTML files: unchanged (still blocked).
- Persisting "always allow remote images" for a document, folder or domain.
- Video/audio embeds, CSS background images in markdown.

## Anti-goals

- Widening the CSP to `file:` or a broad custom scheme that the renderer could
  point at arbitrary paths. Containment must stay in the main process.
- Fetching anything remote before the user clicks **Load images**. A tracking
  pixel must not fire just from opening a doc.
- Layout jumps that break the #49 pan/zoom (images must have their real size
  when pan/zoom attaches, or be wrapped on load).

## Constraints

- Electron app: main process (`src/main`), preload bridge (`src/preload`),
  React renderer (`src/renderer/src`). New main-process capability goes through
  an `ipcMain.handle` channel plus a preload method, like `file:readResource`.
- Existing reader: `readResource(absPath, root)` → `{ base64, mime } | null`,
  10 MB cap (`MAX_RESOURCE_SIZE`). Keep the cap (owner's large tbls SVGs fit).
- Baseline text comes from `readBaseFile(root, base, relPath)` via
  `file:readBase`; side-by-side sides are resolved in `ContentPane.tsx`
  (`'baseline' | 'now' | { sha }`). The git-baseline image reader must use the
  same base ref selection as `file:readBase`, and must validate the repo-relative
  path stays inside the repo (no `..` escape) and is a blob.
- Remote loading after the click needs the CSP to allow `https:` (and `http:`)
  for `img-src`; the gate is enforced by not putting remote URLs into `src`
  until allowed (e.g. keep them in `data-remote-src` and swap on click).
  *(My call: allowing `img-src https: http:` in the CSP is acceptable because
  sanitized markdown/HTML is the only place `<img>` URLs come from, and the
  swap happens only after the click. Builder may choose a different mechanism
  that keeps the same behaviour, e.g. fetching via main and inlining.)*
- Windows is the owner's daily machine: paths with backslashes, drive letters,
  and case-insensitive matching must work; mermaid diagrams are unaffected.
- Image MIME types: png, jpg/jpeg, gif, webp, svg, bmp, ico, avif. SVG is
  loaded as `<img>` (scripts in SVG don't run in `<img>`), never inlined as
  markup.

## Decided by the owner

- Main use: design docs with diagrams in a `docs/` folder.
- Remote images: blocked, with a per-document click-to-allow.
- Side-by-side: each version shows its own diagram.

## Left to the builder

- Whether resolution happens as a post-render pass over the sanitized DOM or
  as a pre-render rewrite of the HTML string (either is fine; must not
  re-introduce unsanitized markup).
- Caching of resolved data URLs between re-renders of the same document (the
  view re-renders often — see #53 — so avoid re-reading every image each time).
- Exact placeholder styling (should fit the existing dark/light theme tokens).
- Sharing path helpers with `src/renderer/src/html/paths.ts` /
  `markdown/paths.ts` rather than adding a third copy.

## Done when

- A `.md` in `docs/` with `![](img/a.svg)`, `![](../shared/b.png)` (inside the
  folder), `![](/docs/c.png)` and `<img src="d%20e.png">` shows all four.
- `![](../../outside.png)` (outside the folder) and a missing file show the
  placeholder with the path.
- A doc with an `https:` badge shows the bar and placeholder; no network request
  is made until **Load images**; after clicking, it loads; switching files and
  back shows it blocked again.
- Side-by-side between the git baseline and now, where `img/flow.svg` changed,
  shows the old diagram on the left and the new one on the right.
- Loaded diagrams get pan/zoom controls on hover.
