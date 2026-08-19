# View Master — Image View (Design Spec)

**Date:** 2026-08-13
**Status:** Approved
**Extends:** `2026-07-08-viewmaster-design.md` (MVP). Adds image preview for
PNG/JPEG/GIF/WEBP/SVG files — the "Image/SVG/PDF preview" item flagged as a
follow-up (non-goal) in `2026-08-12-rendered-html-view-design.md`. Resolves
issue #3.

## Purpose

Today an image file (`.png`/`.jpg`/`.gif`/`.webp`) is read by
`readCurrentFile` (`src/main/git/content.ts:9-32`), sniffed for a NUL byte in
its first 8KB, and classified `{ kind: 'binary' }` — `ContentPane` renders a
"Binary file / Not displayed" placeholder for it (`ContentPane.tsx:99-100`)
with no toolbar. `.svg` is real UTF-8 text with no NUL byte, so it already
comes back as `{ kind: 'text' }` and falls through to plain `CodeView` — raw
XML, no visual preview either. This spec adds an actual image preview for
both cases.

## Load-bearing decisions (settled during brainstorming)

1. **"WEBM" in the issue text is read as WEBP.** The issue lists "PNG, JPEG,
   WEBM, or SVG" — WEBM is a video container, out of place next to three
   static image formats in an issue titled "Support for images." Treated as
   a typo for WEBP. GIF is folded in too since it's the same code path as
   the other raster formats.
2. **View only — no Diff support for images in this pass.** Selecting a
   changed image still shows just the current on-disk image, the same way
   the existing binary-file placeholder ignores mode/selection today
   (`ContentPane.tsx:96-100` intercepts before the mode dispatch). Image
   diffing (old-vs-new comparison) is a natural follow-up but needs its own
   design: `readBaseFile` has no binary-blob awareness today
   (`src/main/git/content.ts:39-47` always does a UTF-8 `git show`), and
   `DiffView` is Monaco-text-only.
3. **No dependency on the unmerged `worktree-rendered-html-view` branch.**
   That branch already built a `readResource` IPC (base64 + MIME, keyed by
   extension) for embedding images inside rendered HTML — architecturally
   the same idea used here, but unreviewed/unmerged. This spec adds a small,
   purpose-built, self-contained path instead of coupling issue #3 to
   unrelated unreviewed work. (If that branch lands first, the two base64+MIME
   paths could later be unified — not done here.)
4. **No new IPC channel.** Raster image bytes ride the existing `file:read` /
   `window.viewmaster.readFile` call by extending what `FileContent` can be,
   rather than adding a second channel.
5. **Isolation: a plain `<img>` tag, not Shadow DOM.** Unlike the HTML-view
   feature, an image (including SVG used as an `<img src>`) never executes
   embedded scripts or fetches external resources in that context — it's
   already a safe, non-executing render surface. No DOMPurify, no shadow
   root needed.
6. **SVG gets a Rendered/Code toggle; raster formats get no toolbar at
   all.** SVG is inspectable text, so — mirroring the HTML view's
   Rendered/Code split — it gets a two-way toggle. PNG/JPEG/GIF/WEBP have no
   underlying "source" to show, so their toolbar stays empty, same as any
   other binary file today.
7. **Raster size cap: 10MB**, not the existing 2MB `MAX_SIZE` used for
   text/binary sniffing — matches the precedent in the (unmerged)
   `resource.ts`'s `MAX_RESOURCE_SIZE`, generous enough for typical photos.
   SVG keeps the existing 2MB text cap unchanged (it's still classified via
   the ordinary text path).
8. **Mode defaults to Rendered, resets per file, in-memory only** — no
   persistence, consistent with the existing toggle behavior.

## Main process changes

`src/shared/types.ts`: `FileContent` gains a variant:

```ts
| { kind: 'image'; mime: string; base64: string }
```

`src/main/git/content.ts`:

- New `RASTER_IMAGE_MIME: Record<string, string>` keyed by extension
  (`.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`).
- New `MAX_IMAGE_SIZE = 10 * 1024 * 1024`.
- `readCurrentFile`: after the `stat`/missing check, before the existing
  `MAX_SIZE`/binary-sniff logic, check the extension against
  `RASTER_IMAGE_MIME`. If it matches: apply `MAX_IMAGE_SIZE` instead of
  `MAX_SIZE` for the too-large check, read the buffer, and return `{ kind:
  'image', mime, base64: buffer.toString('base64') }`. Non-matching
  extensions (including `.svg`) fall through to the existing logic
  unchanged.
- `readBaseFile` and the history `recorder.ts` are untouched — per decision
  #2, images have no diff/history path; raster images already fell into
  `fc.kind !== 'text'` (skipped by the recorder) as `'binary'`, and still
  do as `'image'`.

`ipc.ts` / `preload/index.ts`: no changes — `file:read` already returns
whatever `FileContent` shape `readCurrentFile` produces.

## Renderer changes

`src/renderer/src/components/ContentPane.tsx`:

- `RASTER_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']`,
  `isRasterImage(path)`; `SVG_EXTENSION = '.svg'`, `isSvg(path)` — mirroring
  the existing `MARKDOWN_EXTENSIONS`/`isMarkdown` pattern
  (`ContentPane.tsx:11-16`).
- `Mode` gains a new value, `'code'` — SVG-only in this branch, added fresh
  here (this worktree branches from master, which doesn't have it; the
  unmerged HTML-view branch happens to add the same name for the same
  purpose, and the two can be reconciled if/when both merge).
- Render dispatch: `content.kind === 'image'` → `ImageView` with a raster
  `data:` URL, checked alongside the existing `'binary'`/`'too-large'`/
  `'missing'` branches (`ContentPane.tsx:96-109`) so it takes precedence
  over `mode` the same way those do. `isSvg(file.path) && mode !== 'code'`
  → `ImageView` with an SVG `data:` URL (default, "Rendered"). `isSvg(...) &&
  mode === 'code'` → existing `CodeView` with the raw XML text.
- Toolbar: `isSvg(file.path)` → segmented **Rendered / Code** toggle (no
  Diff button). `isRasterImage(file.path)` → no toolbar buttons at all.
  Both cases skip the existing single Diff button that other binary/text
  files show.

New `src/renderer/src/components/ImageView.tsx`:

- Props: `src: string` (a fully-formed `data:` URL, built by the caller).
- Renders a centered `<img src={src} />`, `object-fit: contain`, capped to
  the pane's dimensions (new rule in `styles.css`, e.g. `.image-view` /
  `.image-view img { max-width: 100%; max-height: 100%; object-fit:
  contain; }`).
- `data:` URL construction happens in `ContentPane`, not inside `ImageView`:
  - Raster: `data:${content.mime};base64,${content.base64}` directly from
    the new `FileContent` variant.
  - SVG: `data:image/svg+xml;utf8,${encodeURIComponent(content.content)}` —
    reuses the existing text content already loaded via `readFile`, no
    base64 needed.

## Module layout

```
src/shared/types.ts                          FileContent gains 'image' variant
src/main/git/content.ts                      raster-extension branch in readCurrentFile
src/renderer/src/components/ImageView.tsx    new — <img> renderer
src/renderer/src/components/ContentPane.tsx  isRasterImage/isSvg routing, 'code' mode, toolbar
src/renderer/src/styles.css                  .image-view sizing rules
```

## Testing

- `content.test.ts`: each raster extension returns `{ kind: 'image', mime,
  base64 }` with the correct MIME; a raster file over 10MB returns
  `too-large`; a `.svg` file still returns `{ kind: 'text' }` unchanged
  (confirms decision #7's cap split).
- `ImageView.test.tsx`: renders an `<img>` with the exact `src` it's given.
- `ContentPane` additions: a raster image renders `ImageView` with no
  toolbar buttons; an SVG file defaults to `ImageView` (Rendered) and
  switching to Code mode renders `CodeView` with the raw markup; mode resets
  to `'view'`/Rendered when the selected file changes; selecting a non-default
  history/diff revision while an image is open still shows only the current
  on-disk image (no diff attempted).

## Non-goals (this pass)

- Diff/history support for images — flagged in decision #2 as a follow-up
  needing its own design (binary git-blob reads, a non-text diff view).
- Unifying with the unmerged HTML-view branch's `readResource` IPC —
  decision #3; left as a possible future cleanup once that branch is
  reviewed.
- PDF support — separate issue (#4).
- Any "WEBM video" interpretation of the issue text — decision #1.
- Zoom/pan controls, checkerboard-transparency background, or any other
  image-viewer chrome beyond a simple fit-to-pane render.
