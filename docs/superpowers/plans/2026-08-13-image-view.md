# Image View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let clicking a PNG/JPEG/GIF/WEBP/SVG file preview it as an image instead of falling into the "Binary file / Not displayed" placeholder (or, for SVG, raw XML in `CodeView`).

**Architecture:** Raster images are read fully in the main process, base64-encoded, and returned through the existing `file:read` IPC channel via a new `FileContent` variant (`{ kind: 'image'; mime; base64 }`) — no new IPC channel. The renderer turns that (or, for SVG, the already-loaded text content) into a `data:` URL and renders it with a plain `<img>` tag, which never executes embedded scripts even for SVG sources — no Shadow DOM or sanitization library needed, unlike the (separate, unmerged) HTML-view feature. SVG additionally gets a Rendered/Code toggle since it's inspectable text; raster formats get no toolbar at all. No diff/history support for images in this pass — selecting a file always shows the current on-disk image, ignoring `mode`.

**Tech Stack:** Electron + React + TypeScript, Vitest (all new tests are plain `.test.ts`, `environment: 'node'` — no DOM/jsdom dependency needed for this feature).

**Spec:** `docs/superpowers/specs/2026-08-13-image-view-design.md`

## Global Constraints

- No new IPC channel — raster image bytes ride the existing `file:read` handler by extending `FileContent`.
- No `fetch`, no custom protocol, no network stack — base64 comes from a direct disk read in the main process, same as every other file-read path in this app.
- No Shadow DOM, no DOMPurify, no sanitization library — a plain `<img src="data:...">` is already a non-executing render context for both raster formats and SVG.
- No Diff/history support for images — `mode` is ignored entirely whenever the selected file is an image (raster `FileContent.kind === 'image'`, or `.svg`); the body always shows the current on-disk image.
- Raster image size cap: 10MB (`MAX_IMAGE_SIZE`), separate from and larger than the existing 2MB text/binary cap (`MAX_SIZE`). SVG keeps the existing 2MB text cap unchanged — it still goes through the ordinary text path in `readCurrentFile`.
- "WEBM" in the original issue text is treated as a typo for WEBP; GIF is included too since it's the same code path as the other raster formats.

---

### Task 1: Main process — classify raster images in `readCurrentFile`

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/git/content.ts`
- Modify: `src/main/git/content.test.ts`

**Interfaces:**
- Produces: `FileContent` gains `{ kind: 'image'; mime: string; base64: string }` in `src/shared/types.ts`.
- Produces: `readCurrentFile(absPath: string): Promise<FileContent>` now returns the `'image'` variant for `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp` files (case-insensitive extension match), applying a 10MB size cap instead of the existing 2MB cap for those extensions only. All other behavior (including `.svg`, which stays on the `'text'` path) is unchanged.

- [ ] **Step 1: Write the failing tests**

Add these cases to the existing `describe('readCurrentFile', ...)` block in `src/main/git/content.test.ts` (after the existing "detects binary content" test, before "rejects files over the size cap"):

```ts
  it('classifies a raster image by extension, base64-encoded', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    await repo.write('photo.png', bytes)
    expect(await readCurrentFile(join(repo.root, 'photo.png'))).toEqual({
      kind: 'image',
      mime: 'image/png',
      base64: bytes.toString('base64')
    })
  })

  it('infers the correct MIME type per raster extension', async () => {
    await repo.write('a.jpg', Buffer.from([1, 2, 3]))
    await repo.write('b.jpeg', Buffer.from([1, 2, 3]))
    await repo.write('c.gif', Buffer.from([1, 2, 3]))
    await repo.write('d.webp', Buffer.from([1, 2, 3]))

    expect(await readCurrentFile(join(repo.root, 'a.jpg'))).toMatchObject({
      kind: 'image',
      mime: 'image/jpeg'
    })
    expect(await readCurrentFile(join(repo.root, 'b.jpeg'))).toMatchObject({
      kind: 'image',
      mime: 'image/jpeg'
    })
    expect(await readCurrentFile(join(repo.root, 'c.gif'))).toMatchObject({
      kind: 'image',
      mime: 'image/gif'
    })
    expect(await readCurrentFile(join(repo.root, 'd.webp'))).toMatchObject({
      kind: 'image',
      mime: 'image/webp'
    })
  })

  it('applies the larger 10MB image cap instead of the 2MB text/binary cap', async () => {
    // Over the 2MB text cap, under the 10MB image cap.
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61)
    await repo.write('big.png', big)
    expect(await readCurrentFile(join(repo.root, 'big.png'))).toEqual({
      kind: 'image',
      mime: 'image/png',
      base64: big.toString('base64')
    })
  })

  it('rejects a raster image over the 10MB image size cap', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61)
    await repo.write('huge.png', big)
    expect(await readCurrentFile(join(repo.root, 'huge.png'))).toEqual({
      kind: 'too-large',
      size: big.length
    })
  })

  it('still classifies SVG as text, not image', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>'
    await repo.write('icon.svg', svg)
    expect(await readCurrentFile(join(repo.root, 'icon.svg'))).toEqual({
      kind: 'text',
      content: svg
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/git/content.test.ts`
Expected: FAIL — `readCurrentFile` returns `{ kind: 'binary' }` (or the old `too-large`/`text` shape) for the new cases; no `'image'` kind exists yet.

- [ ] **Step 3: Add the `'image'` variant to `FileContent`**

In `src/shared/types.ts`, change:

```ts
export type FileContent =
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'missing' }
```

to:

```ts
export type FileContent =
  | { kind: 'text'; content: string }
  | { kind: 'image'; mime: string; base64: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'missing' }
```

- [ ] **Step 4: Implement the raster-image branch in `readCurrentFile`**

Replace the full contents of `src/main/git/content.ts` with:

```ts
import { readFile, stat } from 'fs/promises'
import { extname } from 'path'
import type { FileContent } from '@shared/types'
import { runGit } from './run'

const MAX_SIZE = 2 * 1024 * 1024
const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8192

const RASTER_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** Read a file from disk, classifying image / binary / oversized / missing content. */
export async function readCurrentFile(absPath: string): Promise<FileContent> {
  let size: number
  try {
    const info = await stat(absPath)
    if (!info.isFile()) return { kind: 'missing' }
    size = info.size
  } catch {
    return { kind: 'missing' }
  }

  const rasterMime = RASTER_IMAGE_MIME[extname(absPath).toLowerCase()]
  if (rasterMime) {
    if (size > MAX_IMAGE_SIZE) return { kind: 'too-large', size }
    try {
      const buffer = await readFile(absPath)
      return { kind: 'image', mime: rasterMime, base64: buffer.toString('base64') }
    } catch {
      return { kind: 'missing' }
    }
  }

  if (size > MAX_SIZE) return { kind: 'too-large', size }

  let buffer: Buffer
  try {
    buffer = await readFile(absPath)
  } catch {
    return { kind: 'missing' }
  }

  const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES)
  if (sniff.includes(0)) return { kind: 'binary' }

  return { kind: 'text', content: buffer.toString('utf8') }
}

/**
 * Baseline content via `git show <base>:<path>`. Empty string when there is
 * no baseline or the path did not exist at it — an untracked/added file then
 * diffs as all-added.
 */
export async function readBaseFile(
  root: string,
  base: string | null,
  relPath: string
): Promise<string> {
  if (!base) return ''
  const res = await runGit(root, ['show', `${base}:${relPath}`])
  return res.code === 0 ? res.stdout : ''
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/git/content.test.ts`
Expected: PASS (all cases, including the pre-existing ones).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/main/git/content.ts src/main/git/content.test.ts
git commit -m "feat: classify raster images as base64 content in readCurrentFile"
```

---

### Task 2: Renderer — pure `data:` URL helpers

**Files:**
- Create: `src/renderer/src/image/dataUrl.ts`
- Test: `src/renderer/src/image/dataUrl.test.ts`

**Interfaces:**
- Produces: `rasterDataUrl(mime: string, base64: string): string`; `svgDataUrl(svgText: string): string`. Consumed by Task 4 (`ContentPane`).

Pulled out as pure functions (rather than building the string inline in `ContentPane`) so this logic is unit-testable — `ContentPane.tsx` and the new `ImageView.tsx` are `.tsx` files with no automated-test infrastructure in this codebase today (`vitest.config.ts`'s `include` is `src/**/*.test.ts` only; no `.test.tsx` file exists anywhere in the repo, and no React Testing Library dependency is installed).

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/image/dataUrl.test.ts
import { describe, it, expect } from 'vitest'
import { rasterDataUrl, svgDataUrl } from './dataUrl'

describe('rasterDataUrl', () => {
  it('builds a base64 data: URL for the given MIME type', () => {
    expect(rasterDataUrl('image/png', 'aGVsbG8=')).toBe('data:image/png;base64,aGVsbG8=')
  })
})

describe('svgDataUrl', () => {
  it('percent-encodes SVG markup into a data: URL', () => {
    const svg = '<svg><circle r="1" fill="#fff"/></svg>'
    expect(svgDataUrl(svg)).toBe(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`)
  })

  it('encodes characters that would otherwise break the URL (# and &)', () => {
    const svg = '<svg><text>a &amp; b # c</text></svg>'
    const out = svgDataUrl(svg)
    expect(out).not.toContain('#c') // a raw '#' would be read as a URL fragment, truncating the SVG
    expect(out).toContain(encodeURIComponent('#'))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/image/dataUrl.test.ts`
Expected: FAIL — `Cannot find module './dataUrl'`.

- [ ] **Step 3: Implement the helpers**

```ts
// src/renderer/src/image/dataUrl.ts

/** Builds a base64 `data:` URL for raster image bytes read via `readFile`. */
export function rasterDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`
}

/** Builds a `data:` URL for SVG markup already loaded as text — no base64 needed. */
export function svgDataUrl(svgText: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgText)}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/image/dataUrl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/image/dataUrl.ts src/renderer/src/image/dataUrl.test.ts
git commit -m "feat: add pure data: URL builders for image preview"
```

---

### Task 3: Renderer — `ImageView` component and CSS

**Files:**
- Create: `src/renderer/src/components/ImageView.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Produces: `ImageView` React component with props `{ src: string }`. Consumed by Task 4 (`ContentPane`).

No automated test for this file — same DOM-component-testing gap as `MarkdownView.tsx`/`HtmlView.tsx` (no `.tsx` file is matched by `vitest.config.ts`'s `include`, no React Testing Library dependency exists). Covered by Task 5's manual verification pass.

- [ ] **Step 1: Implement `ImageView`**

```tsx
// src/renderer/src/components/ImageView.tsx
export default function ImageView({ src }: { src: string }): React.JSX.Element {
  return (
    <div className="image-view">
      <img src={src} alt="" />
    </div>
  )
}
```

- [ ] **Step 2: Add the container style**

In `src/renderer/src/styles.css`, add a new block after the `/* ---- rendered markdown ---- */` section ends (after the closing brace of `.markdown-body h1, ... h6 { ... }` around line 400, or anywhere else in the file after the markdown block — exact position among top-level blocks doesn't matter):

```css
/* ---- image preview ---- */

.image-view {
  height: 100%;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

.image-view img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
```

No explicit background — `.content-pane` (the ancestor element) already sets `background: var(--bg)`, so `.image-view` inherits the app's existing dark background, same as `CodeView`/`Placeholder` do.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ImageView.tsx src/renderer/src/styles.css
git commit -m "feat: add ImageView component"
```

---

### Task 4: Renderer — wire images into `ContentPane`

**Files:**
- Modify: `src/renderer/src/components/ContentPane.tsx`

**Interfaces:**
- Consumes: `ImageView` (Task 3); `rasterDataUrl`, `svgDataUrl` (Task 2).
- Produces: no new exported interface — `ContentPane`'s own props are unchanged (images need no `workspaceRoot`/`onNavigate`, unlike the HTML-view feature).

No automated test — `ContentPane.tsx` has no existing test file (same gap noted in Task 3). Covered by Task 5.

- [ ] **Step 1: Add imports**

In `src/renderer/src/components/ContentPane.tsx`, add to the existing import block (after the `MarkdownView` import at line 6):

```ts
import ImageView from './ImageView'
import { rasterDataUrl, svgDataUrl } from '../image/dataUrl'
```

- [ ] **Step 2: Extend `Mode` and add the SVG extension check**

Change line 9 from:

```ts
type Mode = 'view' | 'marks' | 'diff'
```

to:

```ts
type Mode = 'view' | 'marks' | 'code' | 'diff'
```

Add next to `isMarkdown` (after its closing brace, line 16):

```ts
const SVG_EXTENSION = '.svg'

function isSvg(path: string): boolean {
  return path.toLowerCase().endsWith(SVG_EXTENSION)
}
```

- [ ] **Step 3: Insert image branches into the body-dispatch chain**

Replace lines 96-133 (from `let body: React.JSX.Element` through the closing `}` of the dispatch chain) with:

```tsx
  let body: React.JSX.Element
  if (!content) {
    body = <Placeholder title="Loading…" />
  } else if (content.kind === 'image') {
    body = <ImageView src={rasterDataUrl(content.mime, content.base64)} />
  } else if (content.kind === 'binary') {
    body = <Placeholder title="Binary file" detail="Not displayed" />
  } else if (content.kind === 'too-large') {
    body = (
      <Placeholder
        title="File too large to display"
        detail={`${(content.size / (1024 * 1024)).toFixed(1)} MB`}
      />
    )
  } else if (content.kind === 'missing') {
    body = <Placeholder title="File not found" detail={file.absPath} />
  } else if (isSvg(file.path) && mode === 'code') {
    body = <CodeView fileName={fileName} content={content.content} />
  } else if (isSvg(file.path)) {
    body = <ImageView src={svgDataUrl(content.content)} />
  } else if (mode === 'diff') {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading diff…" />
      ) : (
        <DiffView
          fileName={fileName}
          original={baseContent}
          modified={compareContent}
          sideBySide={sideBySide}
        />
      )
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
    body = <CodeView fileName={fileName} content={content.content} />
  }
```

The `isSvg` branches sit **before** the `mode === 'diff'`/`mode === 'marks'` checks — same precedence the `'binary'`/`'too-large'`/`'missing'` branches already have — so selecting a history/diff revision while viewing an SVG can never flip the body into `DiffView`/`MarkdownView`; it always keeps showing the current on-disk SVG.

- [ ] **Step 4: Guard the Inline/Side-by-side button and add the SVG toolbar segment**

Change line 135 — no change needed, it already reads `const showToolbarToggles = content?.kind === 'text'`, which is already `false` for `content.kind === 'image'` (raster), so raster images automatically get zero toolbar buttons.

Change the Inline/Side-by-side button condition (line 144) from:

```tsx
          {showToolbarToggles && mode === 'diff' && (
```

to:

```tsx
          {showToolbarToggles && mode === 'diff' && !isSvg(file.path) && (
```

(Without this guard, selecting a history revision while an SVG is open silently flips internal `mode` state to `'diff'` — see the effect at lines 40-43 — and this button would appear even though the body never actually renders `DiffView` for an SVG.)

Replace the toolbar ternary (lines 149-170) with a three-way version, adding the SVG segment first:

```tsx
          {showToolbarToggles && isSvg(file.path) ? (
            <span className="toolbar-segment">
              {(['view', 'code'] as const).map((m) => (
                <button
                  key={m}
                  className={`toolbar-button${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'view' ? 'Rendered' : 'Code'}
                </button>
              ))}
            </span>
          ) : showToolbarToggles && isMarkdown(file.path) ? (
            <span className="toolbar-segment">
              {(['view', 'marks', 'diff'] as const).map((m) => (
                <button
                  key={m}
                  className={`toolbar-button${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'view' ? 'Rendered' : m === 'marks' ? 'Marks' : 'Source'}
                </button>
              ))}
            </span>
          ) : (
            showToolbarToggles && (
              <button
                className={`toolbar-button${mode === 'diff' ? ' active' : ''}`}
                onClick={() => setMode(mode === 'diff' ? 'view' : 'diff')}
              >
                Diff
              </button>
            )
          )}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (no test targets `ContentPane.tsx` directly, but this confirms nothing else broke).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/ContentPane.tsx
git commit -m "feat: preview images and toggle SVG Rendered/Code in ContentPane"
```

---

### Task 5: Manual end-to-end verification

**Files:** none (fixture files live in a scratch temp directory, not the repo).

No automated coverage exists for the full render pipeline end-to-end (Tasks 3/4's justification above). This task is the only place that verifies everything works together in the real app. Use the **run-viewmaster** skill to drive the app.

- [ ] **Step 1: Build a fixture folder**

```bash
mkdir -p /tmp/vm-image-fixture
cat > /tmp/vm-image-fixture/logo.svg <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#2b6cb0"/></svg>
EOF
python3 -c "
import struct, zlib
def chunk(tag, data):
    c = tag + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c))
width, height = 4, 4
sig = b'\x89PNG\r\n\x1a\n'
ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
raw = b''.join(b'\x00' + b'\xff\x00\x00' * width for _ in range(height))
idat = chunk(b'IDAT', zlib.compress(raw))
iend = chunk(b'IEND', b'')
open('/tmp/vm-image-fixture/photo.png', 'wb').write(sig + ihdr + idat + iend)
"
cat > /tmp/vm-image-fixture/notes.txt <<'EOF'
Just a plain text file, for contrast with the image files above.
EOF
```

- [ ] **Step 2: Launch and drive the app via the run-viewmaster skill**

Use the `run-viewmaster` skill to: build/start the app, open `/tmp/vm-image-fixture` as a folder, select `photo.png`, and take a screenshot.

Verify from the screenshot / app state:
- `photo.png` renders as a small solid-red square image, centered in the pane, not a "Binary file / Not displayed" placeholder.
- No toolbar buttons appear for `photo.png` (no Diff, no segmented toggle).

- [ ] **Step 3: Verify SVG Rendered/Code toggle**

Select `logo.svg`. Verify:
- It renders as a blue circle by default (Rendered mode).
- The toolbar shows a **Rendered / Code** segmented toggle, with **Rendered** active.
- Clicking **Code** shows the raw `<svg xmlns=...>` markup in a Monaco editor (same as any other code file).
- Clicking back to **Rendered** shows the blue circle again.
- No **Diff** button appears anywhere in this toolbar.

- [ ] **Step 4: Verify plain text files are unaffected**

Select `notes.txt`. Verify it still shows in `CodeView` with a **Diff** button in the toolbar, exactly as it did before this change — confirms the new image branches don't accidentally intercept non-image files.

- [ ] **Step 5: Verify oversized raster images are still rejected**

```bash
python3 -c "
with open('/tmp/vm-image-fixture/huge.png', 'wb') as f:
    f.write(b'\\x89PNG\\r\\n\\x1a\\n')
    f.write(b'\\x00' * (11 * 1024 * 1024))
"
```

Select `huge.png` in the app. Verify it shows the "File too large to display" placeholder (not a crash, not an attempt to render 11MB of garbage as an image).

- [ ] **Step 6: Clean up the fixture**

```bash
rm -rf /tmp/vm-image-fixture
```

- [ ] **Step 7: Final full-suite check**

Run: `npm run build`
Expected: typecheck + build both succeed.

No commit for this task (no repo files changed) — if any verification step surfaces a bug, fix it as a small follow-up commit referencing the task/step where it was found.
