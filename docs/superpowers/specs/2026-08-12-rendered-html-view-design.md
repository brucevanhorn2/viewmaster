# View Master — Rendered HTML View (Design Spec)

**Date:** 2026-08-12
**Status:** Approved
**Extends:** `2026-07-08-viewmaster-design.md` (MVP). Adds a Rendered/Code/Diff
toggle for `.html`/`.htm` files, analogous to the existing markdown
Rendered/Marks/Source toggle.

## Purpose

Today `.html` files carry no special handling — `isMarkdown()` doesn't match
them, so they fall straight through to the generic `CodeView` branch in
`ContentPane.tsx:129-132`: a read-only Monaco editor with HTML syntax
highlighting, no preview. A motivating use case: static HTML doc generators
like SchemaSpy produce a self-contained, heavily cross-linked site (an index
page, one page per table, relationship diagrams as image maps) that's much
more useful browsed visually than read as markup.

## Load-bearing decisions (settled during brainstorming)

1. **Isolation mechanism: Shadow DOM, not an iframe.** Explicit constraint —
   no iframes in this codebase, full stop. Shadow DOM gives CSS/DOM
   encapsulation (the file's `<style>`/`<link>` won't leak into the app's
   chrome, and vice versa) in the same document and JS realm — it is **not**
   a security boundary by itself.
2. **Security boundary: DOMPurify, not the isolation mechanism.** All script
   execution vectors are stripped before anything is written to the DOM —
   same trust model markdown already uses (`markdown/render.ts:42-44`),
   applied to a whole document instead of a fragment.
3. **No in-app JavaScript execution, ever — not deferred.** Rather than
   building toward script support later, a new toolbar action, **"Open in
   Default Browser"**, hands full-fidelity/interactive viewing to the OS's
   real browser on demand. This closes the door on ever needing to sandbox
   script execution in-app.
4. **Resource loading: recursive disk reads, no fetch, no custom protocol.**
   Relative `src`/`href`/`url(...)` references are resolved by reading the
   referenced files directly through the existing (extended) file-read IPC
   and inlining them as `data:` URIs. Restricted to the open workspace root.
5. **Relative link navigation.** Clicking a relative `<a>`/`<area>` link to
   another file inside the workspace root re-selects that file in View
   Master, so a multi-page doc set (SchemaSpy's table-to-table links,
   diagram image maps) can be clicked through entirely within Rendered view.
   Links resolving outside the workspace root, or to a nonexistent file, are
   a silent no-op.
6. **Toolbar shape:** 3-way segmented **Rendered / Code / Diff** (mirrors
   markdown's slot; unlike markdown, Code is a real plain `CodeView` — HTML
   has no "Marks" concept) plus a separate, always-visible **"Open in
   Default Browser"** button next to the segmented group, since it's a
   one-shot action, not a persistent view mode.
7. **Mode defaults to Rendered, resets per file, in-memory only** — no
   persistence, consistent with the existing toggle behavior.

## Detection & toolbar (renderer)

`ContentPane.tsx`:

- `HTML_EXTENSIONS = ['.html', '.htm']` / `isHtml(path)`, mirroring
  `MARKDOWN_EXTENSIONS` / `isMarkdown` (`ContentPane.tsx:11-16`).
- `Mode` gains a new value: `'view' | 'marks' | 'code' | 'diff'`. `'marks'`
  stays markdown-only; `'code'` is HTML-only. (Kept as distinct named modes
  rather than overloading `'marks'` for HTML's code view — clearer given
  each file type only ever uses its own subset.)
- Toolbar branch becomes three-way instead of two-way
  (`ContentPane.tsx:149-170`): `isMarkdown` → existing segmented
  view/marks/diff; `isHtml` → segmented view/code/diff (labels **Rendered /
  Code / Diff**) plus a standalone **"Open in Default Browser"** button
  (calls `window.viewmaster.openInBrowser(file.absPath)`, always enabled
  regardless of current mode); otherwise → existing single Diff button.
- Body-selection chain (`ContentPane.tsx:110-133`) gains one branch: `mode
  === 'code' && isHtml(file.path)` → `CodeView` (explicit); `isHtml(...)` →
  new `HtmlView` (Rendered, the default). `mode === 'diff'` already covers
  HTML's Diff tab unchanged — `DiffView` is file-type-agnostic.

## Rendering pipeline

New module `src/renderer/src/html/render.ts`, mirroring
`markdown/render.ts`'s shape:

- `sanitizeHtmlDocument(html: string): string` — `DOMPurify.sanitize(html, {
WHOLE_DOCUMENT: true, FORBID_TAGS: ['script', 'iframe', 'object', 'embed',
'frame', 'frameset', 'applet'] })`. `WHOLE_DOCUMENT` is DOMPurify's mode for
  sanitizing a complete `<html>` document (vs. markdown's fragment mode) —
  keeps `<head>`/`<style>`/`<link>` intact. DOMPurify's defaults already
  strip `on*=` handlers and `javascript:` URLs; `<map>`/`<area>` are not on
  its forbid list, so SchemaSpy-style clickable diagrams keep working.
- `resolveResources(html: string, htmlAbsPath: string, workspaceRoot:
string): Promise<string>` — parses via `DOMParser`, walks
  `img[src]`/`link[rel=stylesheet][href]`/`source[src]`, plus `url(...)`
  inside inline `style=` and `<style>` text. For each *relative* reference
  (absolute `http(s)://` and existing `data:` URIs pass through untouched):
  resolves it against `htmlAbsPath`'s directory, rejects anything that
  escapes `workspaceRoot`, reads it via the new `readResource` IPC call
  (below), and rewrites the reference to a `data:` URI (extension → MIME
  lookup). Stylesheet text (external `<link>` or inline `<style>`) is
  recursively scanned the same way for its own `url(...)` refs, then inlined
  directly as a `<style>` element — no `<link href>` is left pointing
  anywhere loadable.

New `src/renderer/src/components/HtmlView.tsx`, sibling to `MarkdownView`:

- Props: `content: string` (already-loaded raw HTML, same
  `window.viewmaster.readFile` plumbing `ContentPane` already uses),
  `absPath: string`, `workspaceRoot: string`, `onNavigate: (absPath:
string) => void`.
- `useEffect`: `resolveResources` → `sanitizeHtmlDocument`, then
  imperatively `container.attachShadow({ mode: 'open' }).innerHTML =
  sanitized` (React doesn't manage shadow-root content, so this is an
  imperative DOM write via `useRef`, the same pattern `MarkdownView` already
  uses for its post-render `mermaid.run()` pass).
- **Gotcha to get right:** the click listener for link interception must be
  attached to the **shadow root itself** (`shadowRoot.addEventListener`),
  not to the host `<div>` in the light DOM. A listener on the host sees
  `event.target` retargeted to the host element (shadow encapsulation), not
  the actual `<a>`/`<area>` that was clicked — retargeting only happens for
  listeners *outside* the shadow tree. Attach in the same effect that sets
  `innerHTML`.
- `onClick`: `closest('a, area')`; read `href`. `^https?:\/\//` → same as
  markdown, `window.viewmaster.openExternal(href)`. Otherwise resolve
  relative to `absPath`'s directory; if the resolved path is inside
  `workspaceRoot`, call `onNavigate(resolvedAbsPath)`. Anything else (escapes
  workspace, doesn't resolve) is a no-op — `preventDefault()` only, no
  visible feedback in v1.

`onNavigate` threads `HtmlView` ← `ContentPane` ← `App.tsx`. `App.tsx`
implements it by looking up the resolved path in the current file list
(`repo.files`) and calling the existing `setSelected`; if the path isn't in
the currently-listed set (e.g. Changed mode and the linked file has no git
changes), synthesize a minimal `ChangedFile` the same way Browse Mode's
`overlayStatus` already does for untouched files (`files/browse.ts`) rather
than forcing a mode switch.

## Main process changes

New `src/main/files/resource.ts`:

- `readResource(absPath: string, workspaceRoot: string): Promise<{ base64:
string; mime: string } | null>` — validates `absPath` resolves inside
  `workspaceRoot` (reject any path that isn't a descendant, no `..`
  escapes), stats it (reject missing or over 10 MB — generous for
  images/fonts/CSS, well under the base64-inflation pain point), reads raw
  bytes, base64-encodes, and infers MIME from extension (small lookup table:
  png/jpg/jpeg/gif/svg/webp/ico, woff/woff2/ttf/otf, css, falling back to
  `application/octet-stream`). Returns `null` on any validation failure;
  `resolveResources` leaves that attribute's URL exactly as the original
  file wrote it (unrewritten relative path) rather than substituting
  anything — it simply fails to load in the shadow DOM the same way a
  missing image fails to load in any browser, with no special-cased broken
  state to build.

`ipc.ts`: `ipcMain.handle('file:readResource', (_e, absPath, workspaceRoot)
=> readResource(absPath, workspaceRoot))`; `ipcMain.handle('app:openInBrowser',
(_e, absPath) => { void shell.openPath(absPath) })` (`shell` is already
imported in `ipc.ts`).

`preload/index.ts`: `readResource(absPath, workspaceRoot)` and
`openInBrowser(absPath)`, alongside the existing `readFile`/`openExternal`.

## Module layout

```
src/renderer/src/html/render.ts           sanitizeHtmlDocument, resolveResources
src/renderer/src/components/HtmlView.tsx  shadow-DOM render + link interception
src/renderer/src/components/ContentPane.tsx  isHtml routing, 'code' mode, toolbar
src/main/files/resource.ts                readResource (workspace-scoped, base64+MIME)
src/main/ipc.ts                           file:readResource, app:openInBrowser handlers
src/preload/index.ts                      readResource, openInBrowser bridge methods
src/renderer/src/App.tsx                  onNavigate → setSelected (+ synthesize fallback)
```

## Testing

- `html/render.test.ts`: `sanitizeHtmlDocument` strips `<script>`, `on*=`
  handlers, `javascript:` URLs, nested `<iframe>`/`<object>`/`<embed>`;
  retains `<style>`/`<link>`/`class`/`id`/inline `style=`/`<map>`/`<area>`.
  `resolveResources` against a fixture dir (html + sibling `.png` + `.css`
  with a nested `url(...)`) produces correct `data:` URIs; a reference that
  resolves outside the fixture's workspace root is rejected, not inlined.
- `resource.test.ts`: `readResource` rejects a path outside `workspaceRoot`
  (including `..`-traversal), returns `null` for missing/oversized files,
  correct MIME per extension.
- `ContentPane`: `isHtml` routes to `HtmlView`; mode defaults to `'view'` and
  resets on file change; toolbar shows the Rendered/Code/Diff segment + Open
  in Browser button only for `.html`/`.htm` files.
- `HtmlView` link handling: `http(s)://` href → `openExternal` called;
  in-workspace relative href → `onNavigate` called with the resolved path;
  out-of-workspace/nonexistent → neither called, event still prevented.

## Non-goals (v1)

- In-app JavaScript execution — never planned; "Open in Default Browser" is
  the intended answer for interactive content, not a future in-app sandbox.
- Persistence of view mode (matches existing toggle behavior).
- Image/SVG/PDF preview — raised as a promising follow-up during this
  design session, explicitly out of scope here. Would likely reuse this
  spec's file-type-detection + toolbar-eligible-view-component pattern, but
  needs its own design pass (a plain preview probably doesn't need a
  Rendered/Code/Diff toggle at all; PDF needs a different viewer entirely).
- `.xhtml` extension support.
- Lazy resource loading — everything embedded in the HTML resolves eagerly
  at open time; a file embedding very large media will be slow to open.
  Matches "this is a file viewer, not a browser" scope.
- Visible feedback for a dead/out-of-scope link click — silently inert in
  v1.
