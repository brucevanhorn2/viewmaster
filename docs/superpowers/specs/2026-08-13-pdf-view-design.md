# View Master — PDF View (Design Spec)

**Date:** 2026-08-13
**Status:** Approved (self-reviewed; produced during an unattended overnight
run — see "Autonomous-run notes" at the end for how approval gates were
handled)
**Extends:** `2026-07-08-viewmaster-design.md` (MVP). Adds PDF preview,
flagged as a follow-up (non-goal) in both `2026-08-12-rendered-html-view-design.md`
and `2026-08-13-image-view-design.md`. Resolves issue #4.

## Purpose

Today a `.pdf` file has no extension in `RASTER_IMAGE_MIME` and no NUL byte
sniff match beyond "binary" — `readCurrentFile` (`src/main/git/content.ts`)
reads its first 8KB, finds NUL bytes (virtually all real PDFs have them),
and classifies it `{ kind: 'binary' }`. `ContentPane` renders the generic
"Binary file / Not displayed" placeholder, with no toolbar. This spec adds
an actual in-app PDF preview, so a user can click a PDF in the file list and
read it without leaving View Master.

## Load-bearing decisions

1. **Extension-based detection, same as images.** `PDF_EXTENSION = '.pdf'`,
   `isPdf(path)` — mirrors `isRasterImage`/`isSvg`
   (`ContentPane.tsx`/`content.ts`). No content sniffing; the existing binary
   NUL-byte sniff already runs first for everything else, so this only needs
   to intercept before that check, the same way raster images do.

2. **No new IPC channel — extend `FileContent` again.** PDF bytes ride the
   existing `file:read` / `window.viewmaster.readFile` call, adding a third
   binary-ish variant alongside `'image'`:
   `{ kind: 'pdf'; base64: string }`. No `mime` field — unlike raster images
   (four possible MIME types), a PDF is always `application/pdf`, so there's
   nothing to vary and pdf.js's `getDocument` never even looks at a MIME
   type; it works directly off the decoded bytes. This is also why no
   `data:` URL is built anywhere in this feature (contrast with images):
   pdf.js's `getDocument({ data })` API accepts a `Uint8Array` directly, so
   base64 only exists to cross the IPC boundary as JSON-safe text, and is
   decoded straight back to bytes on arrival — never turned into a URL of
   any kind.

3. **Size cap: 25MB, its own constant (`MAX_PDF_SIZE`), separate from both
   the 2MB text/binary cap and the 10MB raster-image cap.** Real-world PDFs
   worth previewing (scanned multi-page documents, engineering drawings,
   generated reports) routinely exceed typical photo sizes, so reusing the
   10MB image cap would reject files a user would reasonably expect to
   open. 25MB is generous for that use case while still bounding the
   base64-inflated payload (~33MB) that crosses the Electron IPC structured-
   clone boundary and the in-memory `Uint8Array` pdf.js then holds — both
   of which stay comfortably fast at that size, unlike at, say, 200MB.

4. **Rendering: pdf.js (`pdfjs-dist`), not Chromium's native PDF viewer, an
   iframe, or a `<webview>`.** This is a hard constraint, not just a
   preference: Electron's built-in PDF viewing is implemented as an
   embedded/nested browsing context (effectively a `<webview>`/plugin
   surface under the hood), which is exactly the "iframe-shaped" thing this
   codebase never uses, for the same reason the HTML-view feature rejected
   iframes. pdf.js instead decodes and rasterizes pages under our own
   control, entirely inside the page's own JS realm.

5. **No fetch, no custom protocol, no CDN — pdf.js gets raw bytes, and its
   worker ships bundled.** `getDocument({ data })` is called with the
   `Uint8Array` decoded from the base64 the IPC call already returned —
   pdf.js never makes a network request for the document itself. pdf.js
   also needs a background Worker script (`pdf.worker.mjs`) to do the
   actual parsing off the main thread; that script is imported as a local
   module (`pdfjs-dist/build/pdf.worker.mjs?url`, resolved and bundled by
   Vite at build time — same mechanism the repo already relies on via
   `vite/client` types in `env.d.ts`) and assigned to
   `pdfjsLib.GlobalWorkerOptions.workerSrc`. That's a normal bundled-asset
   load, not a fetch of remote content, and satisfies "fully bundled /
   offline" the same way monaco-editor and shiki already are in this repo.
   `pdfjs-dist` is added to `package.json` under `devDependencies`,
   matching the existing convention for every other renderer-bundled
   library here (`monaco-editor`, `dompurify`, `mermaid`, `markdown-it`,
   `shiki` are all `devDependencies` too — only `electron-store` and
   `ignore`, which run unbundled in the main process, are real
   `dependencies`; `electron-vite`'s `externalizeDepsPlugin` is why that
   split matters, and PDF rendering is 100% renderer-side).

6. **License correction: pdf.js is Apache-2.0, not MIT.** Worth stating
   plainly since the issue/brainstorm framing assumed MIT — Mozilla ships
   pdf.js under the Apache License 2.0. Still a permissive, commercially-
   compatible license consistent with every other dependency in this
   project; the license family doesn't change any decision here, just
   correcting the record.

7. **Isolation mechanism: none needed — a `<canvas>`, not injected markup.**
   Unlike HTML (needs Shadow DOM + DOMPurify) or even images (a plain
   `<img src="data:...">`, already a non-executing render context), pdf.js
   draws pages by issuing 2D canvas drawing commands
   (`page.render({ canvasContext, viewport })`) into a `<canvas>` element
   this app already owns. There is no markup or script of the PDF's own
   ever parsed into the DOM — the attack surface is strictly "can pdf.js's
   parser be tricked into misbehaving," the same trust boundary as any
   other PDF-parsing library, not a DOM-injection concern this app's
   isolation conventions need to solve.

8. **Single page at a time, not continuous scroll.** Simpler to implement
   correctly and enough for "review PDF documents" (the issue's stated
   goal). Continuous/virtualized scrolling across dozens or hundreds of
   pages is real additional complexity (managing which pages are mounted,
   scroll-position-to-page-number mapping) that the issue doesn't ask for.
   Minimal chrome: **Prev/Next** buttons and a **"Page X of N"** counter,
   owned by the PDF view component itself as its own small footer bar —
   this is page-level state internal to viewing one file, not a `mode`
   ContentPane's toolbar needs to know about (contrast with the
   Rendered/Code/Diff `mode` toggle, which is file-view-level state).

9. **Auto-fit-to-width, no manual zoom controls.** Every page renders at a
   scale computed from the pane's current width via a `ResizeObserver`
   (recomputed on container resize and on page change), so text is
   readably sized without the user doing anything. Manual zoom (buttons,
   scroll-wheel, pinch) is real UI surface the issue doesn't ask for and
   YAGNI rules out for this pass — fit-to-width alone makes the viewer
   usable, with the pane's own scrollbars handling any residual overflow
   (e.g. a page taller than the pane at fit-to-width scale).

10. **No toolbar mode toggle for PDFs at all** — mirrors raster images
    (decision #6 in the image-view spec): there's no alternate "source" or
    "code" view of a PDF to switch to, so `showToolbarToggles` (already
    gated on `content?.kind === 'text'`) stays `false` and PDFs get zero
    buttons in `ContentPane`'s toolbar, same as raster images today.

11. **View-only — no Diff/history support for PDFs**, identical in shape to
    the image-view precedent: `mode` is irrelevant whenever the open file
    is a PDF; the body always shows the current on-disk PDF regardless of
    history/diff selection state.

12. **Decode-failure fallback and a recorder skip, built in from the start
    (not deferred to a follow-up fix).** The image-view feature shipped
    without these and needed a same-day follow-up commit
    (`d947d91`) once real testing surfaced two gaps. Both apply identically
    to PDFs, so this spec includes them up front instead of waiting to
    rediscover them:
    - `getDocument(...).promise` rejects on a corrupt/truncated file, or a
      non-PDF file that happens to have a `.pdf` extension. The PDF view
      component catches that and renders `Placeholder` ("PDF could not be
      displayed") instead of a blank pane, resetting on `base64`/path
      change — the exact pattern `ImageView`'s `onError` fallback now uses.
    - The history recorder's `capture()` already discards anything where
      `fc.kind !== 'text'`, but for PDFs that means doing a full disk read
      *and* base64-encoding a (potentially 25MB-capped) buffer on every
      file-save event, purely to throw it away. `isPdfPath(relPath)` (a
      sibling of the image feature's `isRasterImagePath`, exported from
      `content.ts`) short-circuits `capture()` before that wasted work,
      exactly like the raster-image path already does.

## Main process changes

`src/shared/types.ts`: `FileContent` gains a variant:

```ts
| { kind: 'pdf'; base64: string }
```

`src/main/git/content.ts`:

- New `PDF_EXTENSION = '.pdf'` and `isPdfPath(path: string): boolean`
  (exported, mirrors `isRasterImagePath`).
- New `MAX_PDF_SIZE = 25 * 1024 * 1024`.
- `readCurrentFile`: after the raster-image branch and before the existing
  `MAX_SIZE`/binary-sniff logic, check `isPdfPath(absPath)`. If true: apply
  `MAX_PDF_SIZE` for the too-large check, read the buffer, and return
  `{ kind: 'pdf', base64: buffer.toString('base64') }`. Everything else is
  unchanged.

`src/main/history/recorder.ts`:

- `capture()` gains `if (isPdfPath(relPath)) return` immediately after the
  existing `if (isRasterImagePath(relPath)) return` line, before the
  `readCurrentFile` call.

`ipc.ts` / `preload/index.ts`: no changes — `file:read` already returns
whatever `FileContent` shape `readCurrentFile` produces.

## Renderer changes

`src/renderer/src/components/ContentPane.tsx`:

- `PDF_EXTENSION = '.pdf'`, `isPdf(path)` — mirrors `isSvg`.
- Render dispatch: `content.kind === 'pdf'` → `PdfView` with the raw
  `base64` string, checked alongside the existing `'image'`/`'binary'`/
  `'too-large'`/`'missing'` branches so it takes precedence over `mode` the
  same way those do.
- Toolbar: no change needed — `isPdf(file.path)` is never checked there;
  `showToolbarToggles` is already `false` for `content.kind === 'pdf'`
  (it's gated on `'text'`), so PDFs automatically get the same "no toolbar
  buttons" treatment raster images get.

New `src/renderer/src/pdf/base64.ts` (pure, unit-testable):

- `base64ToBytes(base64: string): Uint8Array` — decodes via the global
  `atob` (available in both the renderer's browser context and Node 22's
  test environment; `Buffer` is not used because `nodeIntegration: false`
  means the renderer has no Node globals).

New `src/renderer/src/pdf/worker.ts`:

- One-line module: imports the bundled worker asset URL
  (`import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'`) and sets
  `GlobalWorkerOptions.workerSrc = workerSrc`. Imported once, for its side
  effect, at the top of `PdfView.tsx`. Split into its own module so the
  side effect is obvious and happens exactly once regardless of how many
  times `PdfView` re-renders.

New `src/renderer/src/components/PdfView.tsx`:

- Props: `{ base64: string }`.
- On mount and whenever `base64` changes: decode via `base64ToBytes`, call
  `pdfjsLib.getDocument({ data })`, await `.promise`. On success, store the
  `PDFDocumentProxy` and reset `pageNumber` to `1`; on rejection, set a
  `failed` flag and render `Placeholder`.
- A `ResizeObserver` on the scroll container plus `[pdfDoc, pageNumber]`
  drive a render effect: `pdfDoc.getPage(pageNumber)`, compute `scale =
  containerWidth / page.getViewport({ scale: 1 }).width`, then
  `page.render({ canvasContext, viewport: page.getViewport({ scale }) })`
  onto a `<canvas>` ref. The in-flight `RenderTask` is stored in a ref and
  `.cancel()`-ed before starting a new one, so rapid Prev/Next clicks (or a
  resize firing mid-render) can't collide — a documented pdf.js requirement
  when a page can re-render before a prior render finishes.
- Footer bar: **Prev**/**Next** buttons (disabled at the first/last page)
  and a **"Page {pageNumber} of {numPages}"** label, shown only once
  `numPages > 1` (a single-page PDF gets no footer clutter).

## Module layout

```
src/shared/types.ts                          FileContent gains 'pdf' variant
src/main/git/content.ts                       isPdfPath / MAX_PDF_SIZE branch in readCurrentFile
src/main/history/recorder.ts                  skip PDF paths before readCurrentFile
src/renderer/src/pdf/base64.ts                new — pure base64 → Uint8Array decode
src/renderer/src/pdf/worker.ts                new — pdf.js worker bundling side effect
src/renderer/src/components/PdfView.tsx       new — canvas renderer + page nav
src/renderer/src/components/ContentPane.tsx   isPdf routing
src/renderer/src/styles.css                   .pdf-view sizing/footer rules
package.json                                  pdfjs-dist under devDependencies
```

## Testing

- `content.test.ts`: a `.pdf` file returns `{ kind: 'pdf', base64 }`; a PDF
  over 25MB returns `too-large`; a PDF under 25MB but over the 2MB text cap
  still succeeds (confirms the dedicated cap, mirroring the image-view
  test's "applies the larger cap" case); `isPdfPath` matches `.pdf`
  case-insensitively and rejects other extensions.
- `recorder.test.ts`: a `.pdf` path never reaches `readCurrentFile` (spy/
  call-count assertion, mirroring however the raster-image skip is already
  tested there).
- `base64.test.ts`: `base64ToBytes` round-trips known byte sequences
  (including a value needing padding, and the empty string).
- No automated test for `PdfView.tsx` or the `ContentPane` PDF-routing
  branch — same DOM-component-testing gap already documented and accepted
  in the image-view spec (no `.test.tsx` infrastructure exists in this
  repo). Covered by manual verification instead (see the implementation
  plan's manual-verification task).

## Non-goals (this pass)

- Diff/history support for PDFs — same follow-up-needing-its-own-design
  status as images (binary blob diffing has no home in this app yet).
- Continuous/virtualized multi-page scrolling — decision #8.
- Manual zoom, pinch, or scroll-wheel zoom controls — decision #9.
- Text search within a PDF, text selection/copy, annotations, printing, or
  a thumbnail/page-picker sidebar — none requested by the issue, all real
  additional scope.
- Password-protected/encrypted PDFs — `getDocument` will reject them the
  same way it rejects any other unparseable input, surfacing the existing
  decode-failure `Placeholder`; a dedicated "enter password" UI is out of
  scope.
- Unifying the `'image'`/`'pdf'` base64-carrying `FileContent` variants
  into one shape — left as-is; they're already structurally similar
  (`'pdf'` is exactly `'image'` minus the `mime` field) and a future
  cleanup could merge them if a third format shows the same shape again,
  but doing it speculatively now isn't justified by two data points.

## Autonomous-run notes

This spec was written end-to-end without a human review checkpoint, per
explicit standing instruction for this run. Self-review pass performed
before commit:

- **Placeholder scan:** no `TODO`/`TBD`/bracketed-placeholder text remains
  anywhere above.
- **Internal consistency:** the `FileContent` variant, cap constant name,
  and file paths named in "Main process changes" match what "Module
  layout" and "Renderer changes" reference; decision numbers aren't
  referenced out of order.
- **Scope:** every decision either mirrors an already-shipped precedent
  (images/HTML) or is justified independently (caps, single-page nav,
  fit-to-width) — nothing added "because it'd be nice."
- **Ambiguity check:** the one place this spec deviates from a literal
  reading of upstream guidance (pdf.js's license, and the `devDependencies`
  vs `dependencies` placement) is called out explicitly with reasoning
  (decisions #5, #6) rather than silently done differently.
