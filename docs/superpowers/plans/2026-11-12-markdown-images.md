# Images in Rendered Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local images in rendered markdown load (relative to the `.md` file, contained to the opened folder), remote images are click-to-allow per document, and the side-by-side old pane shows images from the git baseline.

**Architecture:** After markdown is rendered and sanitized, a renderer pass (`resolveMarkdownImages`) rewrites every `<img>`: local paths become `data:` URLs read by the main process through the existing containment check (or from git at the baseline ref), remote URLs become placeholders until allowed, then are fetched by the main process and inlined. The CSP stays `img-src 'self' data:` — the renderer never fetches images itself. `ContentPane` holds the per-file "remote allowed" flag and builds a per-side image reader.

**Tech Stack:** Electron (main/preload/renderer), React 19, TypeScript, markdown-it + DOMPurify, Vitest (+ jsdom for renderer tests).

**Spec:** `docs/superpowers/specs/2026-11-12-markdown-images-design.md`

## Global Constraints

- All image bytes come from the main process; the renderer CSP in `src/renderer/index.html` stays exactly `img-src 'self' data:` (plan-level call, allowed by the spec's "builder may choose a different mechanism": remote images are fetched by main and inlined instead of widening the CSP).
- Local reads go through `readResource(absPath, session.root)` (`src/main/files/resource.ts`): realpath + containment, 10 MB cap (`MAX_RESOURCE_SIZE`), files only.
- Nothing remote is fetched until the user clicks **Load images** for that file.
- Image MIME types: png, jpg/jpeg, gif, webp, svg, bmp, ico, avif. SVG only ever as `<img src="data:image/svg+xml;base64,...">`, never inlined as markup.
- Copy: bar text `This document has N remote images` (singular `1 remote image`), button `Load images`.
- Windows: `absPath`/`workspaceRoot` may contain backslashes; normalize `\` → `/` before path math.
- Reuse `joinPath` / `dirnamePath` from `src/renderer/src/markdown/paths.ts`; do not add another copy.
- Base all work on `origin/master` (includes #49 pan/zoom and #22). Baseline test failures to ignore (8): `browse.test` ×3, `git/run` ×1, `history/paths` ×1, `ipc.test` "openRepo generation race", `watcher` ×2; `search/scan` "in-scan compaction" is flaky under load.
- Windows build: `node --max-old-space-size=4096 node_modules/electron-vite/bin/electron-vite.js build` (`npm run build` fails on Windows).

## Review Focus

1. `srcset` on `<img>`/`<source>` would let a browser pick a remote/unresolved URL — the pass must strip `srcset` everywhere (Task 2 test `strips srcset`).
2. A percent-encoded traversal (`%2e%2e/%2e%2e/x.png`) must be decoded before resolution and then refused by main's containment, showing the placeholder (Task 2 test `decodes before resolving`; Task 1 test for `..` rel paths).
3. A document with the same image referenced many times must read it once (Task 2 test `reads each distinct path once`).
4. A remote image whose response is not an image (HTML login page, 404) or is over 10 MB must become the placeholder, not a broken data URL (Task 1 test `fetchRemoteImage rejects non-image`).
5. Switching files must reset the allowance even when the new file renders the same remote image (Task 4 test `allowance resets on file change`).

---

### Task 1: Main-process readers (baseline blob, remote fetch) + preload

**Files:**
- Modify: `src/main/git/content.ts` (add `readBaseBlob`)
- Modify: `src/main/files/resource.ts` (export `mimeFor`, `MAX_RESOURCE_SIZE`, add `isImageMime`)
- Create: `src/main/files/remoteImage.ts`
- Modify: `src/main/ipc.ts` (two handlers), `src/preload/index.ts`, `src/preload/index.d.ts`
- Test: `src/main/git/content.test.ts`, `src/main/files/remoteImage.test.ts`

**Interfaces:**
- Produces (main): `readBaseBlob(root: string, base: string | null, relPath: string): Promise<Buffer | null>` — `git show <base>:<relPath>` with `encoding: 'buffer'`; null when no base, non-zero exit, or > `MAX_RESOURCE_SIZE`.
- Produces (main): `fetchRemoteImage(url: string, fetchImpl?: typeof fetch): Promise<{ base64: string; mime: string } | null>` — only `http:`/`https:`; 15 s timeout (AbortSignal.timeout); response must be ok, `content-type` (sans params) must satisfy `isImageMime`; body > 10 MB → null. Production passes Electron `net.fetch`.
- Produces (IPC/preload): `window.viewmaster.readBaseResource(absPath: string): Promise<{ base64: string; mime: string } | null>` (channel `file:readBaseResource`) and `window.viewmaster.fetchRemoteImage(url: string): Promise<{ base64: string; mime: string } | null>` (channel `file:fetchRemoteImage`).
- `file:readBaseResource` handler: no session/baseline → null; `rel = path.relative(session.root, path.resolve(absPath))`; null if `rel` is empty, absolute, or starts with `..`; convert to `/` separators; base ref chosen exactly as `file:readBase` does; mime via `mimeFor`, null unless `isImageMime`.

- [ ] **Step 1: Write failing tests**

`content.test.ts` (use `makeRepo()` from `./testRepo`): commit `img/a.png` (bytes `[0x89,0x50,0x4e,0x47,0,1,2,255]`), then overwrite on disk with different bytes.
- `readBaseBlob returns committed bytes byte-for-byte` → `expect([...buf!]).toEqual([0x89,0x50,0x4e,0x47,0,1,2,255])`
- `readBaseBlob returns null for a path missing at base` and `for base null`.

`remoteImage.test.ts` with a fake `fetchImpl`:
- `fetchRemoteImage inlines an image response` → `{ mime: 'image/png', base64: <base64 of body> }` for `content-type: image/png; charset=binary`.
- `fetchRemoteImage rejects non-image` → null for `text/html`, for status 404, for a body of 10 MB + 1 byte.
- `fetchRemoteImage refuses non-http schemes` → null for `file:///etc/passwd`, `data:...`, and fetchImpl not called.

- [ ] **Step 2: Run** `npx vitest run src/main/git/content.test.ts src/main/files/remoteImage.test.ts` — Expected: FAIL (functions missing).
- [ ] **Step 3: Implement** the interfaces above; wire both `ipcMain.handle` channels next to `file:readResource` and the preload methods/types next to `readResource`.
- [ ] **Step 4: Run** the same tests plus `npx tsc --noEmit -p tsconfig.node.json` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(markdown-images): main-process baseline blob and remote image readers (#52)`.

### Task 2: `resolveMarkdownImages` pass

**Files:**
- Create: `src/renderer/src/markdown/images.ts`
- Test: `src/renderer/src/markdown/images.test.ts` (`// @vitest-environment jsdom`)

**Interfaces:**
- Consumes: `ResourceReader` type from `src/renderer/src/html/render.ts` (`(absPath) => Promise<{ base64; mime } | null>`).
- Produces:
  ```ts
  export interface ImageResolveOptions {
    docAbsPath: string          // the .md file (may use backslashes)
    workspaceRoot: string
    readLocal: ResourceReader   // receives forward-slash absolute paths
    readRemote: (url: string) => Promise<{ base64: string; mime: string } | null>
    allowRemote: boolean
  }
  export function resolveMarkdownImages(html: string, opts: ImageResolveOptions): Promise<{ html: string; remoteCount: number }>
  export function cachedReader<K>(read: (k: K) => Promise<...>): (k: K) => Promise<...>  // memoizes the promise per key
  ```
- Rules: parse with `DOMParser` (sanitized input), for each `img`: remove `srcset`/`sizes`; also remove `srcset` from every `source`. `src` `data:` → keep. `http:`/`https:` → count it; if `allowRemote`, `readRemote`, else placeholder. Other schemes (`file:`, `javascript:` …) → placeholder. Otherwise strip `?query`/`#hash`, `decodeURIComponent` (malformed → placeholder), base = workspace root for a leading `/`, else `dirnamePath(docAbsPath)`; `joinPath`; `readLocal`. Success → `src="data:<mime>;base64,<b64>"` (keep `alt`, `title`, `width`, `height`). Failure → replace the `img` with the placeholder.
- Placeholder markup (classes are the contract for CSS in Task 3):
  `<span class="md-img-missing[ md-img-remote]" role="img" aria-label="<alt or src>"><span class="md-img-missing-alt">alt</span><span class="md-img-missing-path">original src</span></span>` (text via `textContent`, never innerHTML). Omit the alt span when alt is empty.
- Images inside `pre.mermaid` are untouched (mermaid hasn't run yet; leave its markup alone).

- [ ] **Step 1: Write failing tests** (fake readers record calls):
  - `resolves relative to the document folder` — doc `C:\r\docs\a.md`, root `C:\r`, `<img src="img/f.svg">` → readLocal called with `C:/r/docs/img/f.svg`; output `src` starts `data:image/svg+xml;base64,`.
  - `leading slash resolves from the folder root` — `/docs/c.png` → `C:/r/docs/c.png`.
  - `decodes before resolving` — `d%20e.png` → `C:/r/docs/d e.png`; `%E0%A4%A` (malformed) → placeholder, readLocal not called.
  - `missing local image becomes a placeholder with alt and path` — readLocal → null; `alt="Flow"` `src="x.png"` → `.md-img-missing` with `.md-img-missing-alt` = `Flow`, `.md-img-missing-path` = `x.png`, no `img` left.
  - `remote images are counted and blocked unless allowed` — two `https:` imgs + one local: `remoteCount === 2`, two `.md-img-remote` placeholders, readRemote not called; with `allowRemote: true` readRemote called twice and both become data URLs, `remoteCount` still 2.
  - `strips srcset` — `<img src="a.png" srcset="https://t/x.png 2x">` and `<picture><source srcset="https://t/y.png"><img src="a.png"></picture>` → no `srcset` attribute anywhere in output.
  - `reads each distinct path once` — three `<img src="a.png">` with `cachedReader(readLocal)` → readLocal called once.
  - `leaves data: images and mermaid blocks alone`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/src/markdown/images.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `images.ts` per the rules; resolve all images concurrently (`Promise.all`).
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(markdown-images): resolve markdown images to data URLs (#52)`.

### Task 3: Placeholder styles and remote-images bar

**Files:**
- Modify: `src/renderer/src/styles.css`
- Create: `src/renderer/src/components/RemoteImagesBar.tsx`
- Test: `src/renderer/src/components/RemoteImagesBar.test.ts` (jsdom)

**Interfaces:**
- Produces: `RemoteImagesBar({ count, onLoad }: { count: number; onLoad: () => void }): React.JSX.Element | null` — null when `count === 0`; otherwise a `div.remote-images-bar` with the exact copy from Global Constraints and a `button` `Load images` calling `onLoad`.
- CSS: `.md-img-missing` inline-block grey box (theme tokens `--bg-sidebar`, `--border`, `--fg-dim`), padding 8px 12px, font-size 12px, max-width 100%; `.md-img-missing-path` monospace (`--font-mono`), word-break break-all; `.md-img-missing-alt` block, `--fg`. `.remote-images-bar` sticky at top of the rendered view, same tokens as `.status-notice`.

- [ ] **Step 1: Failing tests:** `renders nothing for 0`; `says "1 remote image" / "3 remote images"`; `button calls onLoad`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/src/components/RemoteImagesBar.test.ts` — FAIL.
- [ ] **Step 3: Implement** component and CSS.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(markdown-images): placeholder styles and remote-images bar (#52)`.

### Task 4: Wire views and per-file allowance

**Files:**
- Modify: `src/renderer/src/components/MarkdownView.tsx`, `MarkdownSideBySideView.tsx`, `ContentPane.tsx`
- Test: `src/renderer/src/components/MarkdownView.test.ts`, create `src/renderer/src/components/ContentPane.images.test.ts` if a ContentPane-level test is practical, else test the allowance logic via an exported hook `useRemoteAllowance(absPath: string | null): [boolean, () => void]` in `src/renderer/src/markdown/remoteAllowance.ts`.

**Interfaces:**
- Consumes: Task 1 preload methods, Task 2 `resolveMarkdownImages` / `cachedReader`, Task 3 `RemoteImagesBar`.
- New props:
  - `MarkdownView`: `images: { readLocal: ResourceReader; readRemote: (url: string) => Promise<…>; allowRemote: boolean; onAllowRemote: () => void }`.
  - `MarkdownSideBySideView`: `oldImages` and `newImages` (same shape; share `allowRemote`/`onAllowRemote`). One `RemoteImagesBar` above both panes with `count = oldCount + newCount`.
- `useRemoteAllowance(absPath)`: returns `allowed` true only after `allow()` for the current `absPath`; any change of `absPath` resets to false (so Back/Forward and links reset too).
- `ContentPane` builds readers with `useMemo` keyed on `file.absPath` + `refreshKey`: disk = `cachedReader(window.viewmaster.readResource)`, baseline = `cachedReader(window.viewmaster.readBaseResource)`, remote = `cachedReader(window.viewmaster.fetchRemoteImage)`. Side readers by `RevisionRef`: `'baseline'` → baseline reader; `'now'` and `{ sha }` (local history) → disk reader. Plain Rendered and Marks use disk.
- In each view, run `resolveMarkdownImages` on the rendered HTML (Marks: on the composed HTML) before `setHtml`; re-run when `allowRemote` changes. Keep the existing stable `innerHtml` memo and `useDocumentPanZoom(ref, html, absPath)` unchanged.

- [ ] **Step 1: Failing tests:**
  - `MarkdownView` (mock render to return `<p><img src="a.png" alt="A"><img src="https://t/b.png"></p>`): with readLocal → png data, the rendered `img[src^="data:image/png"]` exists; one `.md-img-remote` placeholder; `.remote-images-bar` text `This document has 1 remote image`; clicking `Load images` calls `onAllowRemote`; re-render with `allowRemote: true` → readRemote called, no placeholder.
  - `allowance resets on file change` — `useRemoteAllowance`: allow on `/a.md` → true; rerender `/b.md` → false; back to `/a.md` → false.
  - `side-by-side uses each side's reader` — old pane's `img` src comes from `oldImages.readLocal`, new pane's from `newImages.readLocal`; bar shows the summed count.
- [ ] **Step 2: Run** `npx vitest run src/renderer` — new tests FAIL.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run** `npx vitest run src/renderer` and `npx tsc --noEmit -p tsconfig.web.json` — PASS.
- [ ] **Step 5: Commit** `feat(markdown-images): load images in rendered, marks and side-by-side markdown (#52)`.

### Task 5: In-app verification

**Files:** none committed except fixes found.

- [ ] **Step 1:** Build (Windows command in Global Constraints). Create a temp git repo fixture: `docs/a.md` referencing `img/f.svg`, `../shared/b.png`, `/docs/c.png`, `d%20e.png`, `../../outside.png`, `nope.png`, and `https://img.shields.io/badge/x-y-blue`; commit, then change `docs/img/f.svg`.
- [ ] **Step 2:** Drive the app with Playwright (`_electron`; send `menu:openFile` with `{ root, absPath }` as in the existing run-viewmaster skill) and check: the four local images are `img[src^="data:"]`; outside and missing show `.md-img-missing`; the badge shows the bar and no request was made (main logs / no `net.fetch` call); after `Load images` it renders; selecting another file and back shows it blocked again; side-by-side baseline vs now shows different `f.svg` data URLs on each side; hovering a loaded diagram shows `.pz-controls`.
- [ ] **Step 3:** Full suite `npx vitest run` — only the baseline failures listed in Global Constraints.
- [ ] **Step 4:** Commit any fixes as `fix(markdown-images): …`.
