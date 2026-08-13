# Rendered HTML View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Rendered/Code/Diff toggle for `.html`/`.htm` files, so they preview like markdown does today instead of falling through to plain Monaco.

**Architecture:** A Shadow DOM (never an iframe) hosts DOMPurify-sanitized (`WHOLE_DOCUMENT` mode) markup — DOMPurify is the actual security boundary, Shadow DOM is CSS isolation only. Relative resource references (`img`/`link`/`style` `url()`) are resolved by recursively reading sibling files through the existing file-read IPC (extended, never `fetch`/a custom protocol) and inlining them as `data:` URIs, scoped to the open workspace root. A new "Open in Default Browser" action (`shell.openPath`) is the answer for interactive/JS content — no in-app script execution is ever planned.

**Tech Stack:** Electron + React + TypeScript, DOMPurify (already a dependency), Vitest (+ new `jsdom` devDependency for two DOM-touching test files, via the per-file `// @vitest-environment jsdom` docblock — the global config stays `environment: 'node'`).

**Spec:** `docs/superpowers/specs/2026-08-12-rendered-html-view-design.md`

## Global Constraints

- No iframes, anywhere, ever — Shadow DOM is the only isolation mechanism.
- No in-app JavaScript execution, ever. Not deferred — "Open in Default Browser" is the permanent answer for interactive content.
- DOMPurify sanitization (`WHOLE_DOCUMENT: true`) is the security boundary. Shadow DOM provides CSS/DOM encapsulation only and must never be treated as a security control.
- Resource loading is disk-reads-only through IPC (extended `file:readResource`) — no `fetch`, no custom protocol, no network stack.
- The workspace-root containment check for resource reads is enforced authoritatively in the **main process** (`readResource`), using the main process's own `session.root` — never a renderer-supplied root, since IPC arguments are renderer-controlled.
- Toggle mode defaults to `'view'` (Rendered), resets per file, in-memory only — no persistence.
- Renderer code cannot import Node's `'path'` module (renderer `tsconfig.web.json` has no `@types/node`; `electron.vite.config.ts`'s `renderer` block has no Node-polyfill plugin, unlike `main`/`preload`). All renderer-side path logic uses the new forward-slash-only `html/paths.ts` helpers instead.

---

### Task 1: Main process — `readResource` (workspace-scoped resource reads)

**Files:**
- Create: `src/main/files/resource.ts`
- Test: `src/main/files/resource.test.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces: `readResource(absPath: string, workspaceRoot: string): Promise<{ base64: string; mime: string } | null>` in `src/main/files/resource.ts`.
- Produces (IPC): `ipcMain.handle('file:readResource', ...)` in `ipc.ts`, deriving `workspaceRoot` from the module's own `session.root` (never from the renderer's IPC argument).
- Produces (preload bridge): `window.viewmaster.readResource(absPath: string): Promise<{ base64: string; mime: string } | null>` — single-argument; `workspaceRoot` is not exposed to the renderer's call site at all.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/files/resource.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { readResource } from './resource'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'viewmaster-resource-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(rel: string, content: Buffer | string): Promise<string> {
  const abs = join(dir, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
  return abs
}

describe('readResource', () => {
  it('reads a file inside the workspace root as base64 with the right MIME', async () => {
    const abs = await write('img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await readResource(abs, dir)).toEqual({
      base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mime: 'image/png'
    })
  })

  it('infers MIME from extension for common web asset types', async () => {
    const css = await write('style.css', 'body{}')
    const woff = await write('font.woff2', Buffer.from([1, 2, 3]))
    const svg = await write('icon.svg', '<svg/>')
    expect((await readResource(css, dir))?.mime).toBe('text/css')
    expect((await readResource(woff, dir))?.mime).toBe('font/woff2')
    expect((await readResource(svg, dir))?.mime).toBe('image/svg+xml')
  })

  it('falls back to application/octet-stream for an unknown extension', async () => {
    const abs = await write('data.xyz', 'blob')
    expect((await readResource(abs, dir))?.mime).toBe('application/octet-stream')
  })

  it('rejects a path outside the workspace root', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'viewmaster-outside-'))
    const outsideFile = join(outsideDir, 'secret.png')
    await writeFile(outsideFile, 'x')
    expect(await readResource(outsideFile, dir)).toBeNull()
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('rejects a "../" traversal that resolves outside the workspace root', async () => {
    await write('sub/x.png', 'x')
    const escaped = join(dir, 'sub', '..', '..', 'escape.png')
    expect(await readResource(escaped, dir)).toBeNull()
  })

  it('rejects a sibling directory with a name-prefix collision', async () => {
    const evilRoot = dir + '-evil'
    await mkdir(evilRoot, { recursive: true })
    const evilFile = join(evilRoot, 'x.png')
    await writeFile(evilFile, 'x')
    expect(await readResource(evilFile, dir)).toBeNull()
    await rm(evilRoot, { recursive: true, force: true })
  })

  it('returns null for a missing file', async () => {
    expect(await readResource(join(dir, 'nope.png'), dir)).toBeNull()
  })

  it('returns null for a file over the size cap', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61)
    const abs = await write('big.png', big)
    expect(await readResource(abs, dir)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/files/resource.test.ts`
Expected: FAIL — `Cannot find module './resource'` (file doesn't exist yet).

- [ ] **Step 3: Implement `readResource`**

```ts
// src/main/files/resource.ts
import { readFile, stat } from 'fs/promises'
import { extname, isAbsolute, relative, resolve } from 'path'

const MAX_RESOURCE_SIZE = 10 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.css': 'text/css'
}

function mimeFor(absPath: string): string {
  return MIME_BY_EXT[extname(absPath).toLowerCase()] ?? 'application/octet-stream'
}

/** True when `absPath` is `workspaceRoot` itself or a descendant of it. */
function isInsideRoot(absPath: string, workspaceRoot: string): boolean {
  const rel = relative(workspaceRoot, absPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Reads a file for embedding in a rendered HTML preview: base64 content plus
 * an extension-inferred MIME type. Returns null for anything outside
 * `workspaceRoot`, missing, oversized, or unreadable — callers treat null as
 * "leave this reference unresolved," not as an error to surface.
 */
export async function readResource(
  absPath: string,
  workspaceRoot: string
): Promise<{ base64: string; mime: string } | null> {
  const resolved = resolve(absPath)
  if (!isInsideRoot(resolved, resolve(workspaceRoot))) return null

  let size: number
  try {
    const info = await stat(resolved)
    if (!info.isFile()) return null
    size = info.size
  } catch {
    return null
  }
  if (size > MAX_RESOURCE_SIZE) return null

  try {
    const buffer = await readFile(resolved)
    return { base64: buffer.toString('base64'), mime: mimeFor(resolved) }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/files/resource.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Wire the IPC handler and preload bridge**

In `src/main/ipc.ts`, add the import and a new handler near the existing `file:read`/`file:readBase` handlers (around line 166-175):

```ts
import { readResource } from './files/resource'
```

```ts
  ipcMain.handle('file:readResource', (_e, absPath: string): Promise<{ base64: string; mime: string } | null> => {
    if (!session) return Promise.resolve(null)
    return readResource(absPath, session.root)
  })
```

In `src/preload/index.ts`, add to the `api` object (near `readFile`/`readBaseFile`):

```ts
  readResource: (absPath: string): Promise<{ base64: string; mime: string } | null> =>
    ipcRenderer.invoke('file:readResource', absPath),
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/files/resource.ts src/main/files/resource.test.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat: add workspace-scoped resource reading for HTML previews"
```

---

### Task 2: Main process — "Open in Default Browser" action

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces (IPC): `ipcMain.handle('app:openInBrowser', ...)`.
- Produces (preload bridge): `window.viewmaster.openInBrowser(absPath: string): void`.

No dedicated automated test — this codebase has no `ipc.test.ts` (Electron's `ipcMain`/`shell` aren't unit-tested anywhere today; `app:openExternal` right above it has none either). It's covered by Task 8's manual verification pass.

- [ ] **Step 1: Add the IPC handler**

In `src/main/ipc.ts`, next to the existing `app:openExternal` handler (line ~183-185), `shell` is already imported at the top of the file:

```ts
  ipcMain.handle('app:openInBrowser', (_e, absPath: string): void => {
    void shell.openPath(absPath)
  })
```

- [ ] **Step 2: Add the preload bridge method**

In `src/preload/index.ts`, next to `openExternal`:

```ts
  openInBrowser: (absPath: string): void => {
    void ipcRenderer.invoke('app:openInBrowser', absPath)
  },
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat: add Open in Default Browser action for HTML files"
```

---

### Task 3: Renderer — forward-slash path helpers

**Files:**
- Create: `src/renderer/src/html/paths.ts`
- Test: `src/renderer/src/html/paths.test.ts`

**Interfaces:**
- Produces: `joinPath(...segments: string[]): string`, `dirnamePath(path: string): string`, `isInsideRoot(path: string, root: string): boolean`.
- Consumed by: Task 4 (`classifyLinkHref`) and Task 5 (`resolveResources`).

These exist because the renderer cannot import Node's `'path'` module (see Global Constraints). All paths are forward-slash POSIX-style, matching this codebase's existing convention (`ChangedFile.path` is documented as "forward slashes"; `ContentPane.tsx:94` already does `file.path.split('/').pop()` rather than importing `path`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/html/paths.test.ts
import { describe, it, expect } from 'vitest'
import { joinPath, dirnamePath, isInsideRoot } from './paths'

describe('joinPath', () => {
  it('joins simple segments', () => {
    expect(joinPath('/a/b', 'c.png')).toBe('/a/b/c.png')
  })

  it('resolves "." and ".." segments', () => {
    expect(joinPath('/a/b', '../c.png')).toBe('/a/c.png')
    expect(joinPath('/a/b', './c.png')).toBe('/a/b/c.png')
  })

  it('clamps excess ".." at the filesystem root instead of erroring', () => {
    expect(joinPath('/a', '../../../etc/passwd')).toBe('/etc/passwd')
  })
})

describe('dirnamePath', () => {
  it('returns everything before the last slash', () => {
    expect(dirnamePath('/a/b/c.html')).toBe('/a/b')
  })

  it('returns "/" for a top-level absolute file', () => {
    expect(dirnamePath('/c.html')).toBe('/')
  })
})

describe('isInsideRoot', () => {
  it('accepts the root itself', () => {
    expect(isInsideRoot('/w', '/w')).toBe(true)
  })

  it('accepts a descendant', () => {
    expect(isInsideRoot('/w/sub/a.png', '/w')).toBe(true)
  })

  it('rejects a path outside the root', () => {
    expect(isInsideRoot('/other/a.png', '/w')).toBe(false)
  })

  it('rejects a sibling directory with a name-prefix collision', () => {
    expect(isInsideRoot('/w-evil/a.png', '/w')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/html/paths.test.ts`
Expected: FAIL — `Cannot find module './paths'`.

- [ ] **Step 3: Implement the helpers**

```ts
// src/renderer/src/html/paths.ts

/** Joins forward-slash path segments, resolving "." and ".." (POSIX-style). */
export function joinPath(...segments: string[]): string {
  const isAbsolute = segments[0]?.startsWith('/') ?? false
  const parts = segments.join('/').split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop()
      else if (!isAbsolute) stack.push('..')
      continue
    }
    stack.push(part)
  }
  return (isAbsolute ? '/' : '') + stack.join('/')
}

/** Everything before the last "/" segment. */
export function dirnamePath(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return path.slice(0, idx)
}

/** True when `path` is `root` itself or a descendant of it. */
export function isInsideRoot(path: string, root: string): boolean {
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root
  return path === normalizedRoot || path.startsWith(normalizedRoot + '/')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/html/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/html/paths.ts src/renderer/src/html/paths.test.ts
git commit -m "feat: add forward-slash path helpers for renderer-side HTML resolution"
```

---

### Task 4: Renderer — link classification for click handling

**Files:**
- Create: `src/renderer/src/html/links.ts`
- Test: `src/renderer/src/html/links.test.ts`

**Interfaces:**
- Consumes: `joinPath`, `dirnamePath`, `isInsideRoot` from `./paths` (Task 3).
- Produces: `classifyLinkHref(href: string, htmlAbsPath: string, workspaceRoot: string): LinkClassification`, where `type LinkClassification = { kind: 'external'; url: string } | { kind: 'navigate'; absPath: string } | { kind: 'noop' }`. Consumed by Task 6 (`HtmlView`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/html/links.test.ts
import { describe, it, expect } from 'vitest'
import { classifyLinkHref } from './links'

const HTML_PATH = '/w/docs/index.html'
const ROOT = '/w'

describe('classifyLinkHref', () => {
  it('classifies an https link as external', () => {
    expect(classifyLinkHref('https://example.com/x', HTML_PATH, ROOT)).toEqual({
      kind: 'external',
      url: 'https://example.com/x'
    })
  })

  it('classifies an in-workspace relative link as navigate', () => {
    expect(classifyLinkHref('table.html', HTML_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/table.html'
    })
  })

  it('resolves ".." against the html file\'s own directory', () => {
    expect(classifyLinkHref('../other/page.html', HTML_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/other/page.html'
    })
  })

  it('treats a leading-slash href as workspace-root-relative', () => {
    expect(classifyLinkHref('/diagrams/erd.html', HTML_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/diagrams/erd.html'
    })
  })

  it('strips a fragment and query string before resolving', () => {
    expect(classifyLinkHref('table.html?x=1#section', HTML_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/table.html'
    })
  })

  it('no-ops a link that resolves outside the workspace root', () => {
    expect(classifyLinkHref('../../../../etc/passwd', HTML_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('no-ops a bare fragment link', () => {
    expect(classifyLinkHref('#section', HTML_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('no-ops a mailto: link', () => {
    expect(classifyLinkHref('mailto:x@example.com', HTML_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('no-ops an empty href', () => {
    expect(classifyLinkHref('', HTML_PATH, ROOT)).toEqual({ kind: 'noop' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/html/links.test.ts`
Expected: FAIL — `Cannot find module './links'`.

- [ ] **Step 3: Implement `classifyLinkHref`**

```ts
// src/renderer/src/html/links.ts
import { dirnamePath, isInsideRoot, joinPath } from './paths'

export type LinkClassification =
  | { kind: 'external'; url: string }
  | { kind: 'navigate'; absPath: string }
  | { kind: 'noop' }

/**
 * Classifies a clicked <a>/<area> href for HtmlView's click handler:
 * http(s) links open externally, in-workspace relative links navigate
 * View Master to that file, everything else (anchors, mailto:, links that
 * escape the workspace root) is inert.
 */
export function classifyLinkHref(
  href: string,
  htmlAbsPath: string,
  workspaceRoot: string
): LinkClassification {
  if (/^https?:\/\//i.test(href)) return { kind: 'external', url: href }

  const withoutFragment = href.split('#')[0].split('?')[0]
  if (withoutFragment === '') return { kind: 'noop' }
  // Any other URI scheme (mailto:, tel:, javascript:, data:, ...) is inert here.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(withoutFragment)) return { kind: 'noop' }

  const base = withoutFragment.startsWith('/') ? workspaceRoot : dirnamePath(htmlAbsPath)
  const rel = withoutFragment.startsWith('/') ? withoutFragment.slice(1) : withoutFragment
  const resolved = joinPath(base, rel)

  return isInsideRoot(resolved, workspaceRoot) ? { kind: 'navigate', absPath: resolved } : { kind: 'noop' }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/html/links.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/html/links.ts src/renderer/src/html/links.test.ts
git commit -m "feat: classify HTML preview link clicks (external/navigate/noop)"
```

---

### Task 5: Renderer — `html/render.ts` (sanitize + resolve resources)

**Files:**
- Create: `src/renderer/src/html/render.ts`
- Test: `src/renderer/src/html/render.test.ts`
- Modify: `package.json` (add `jsdom` devDependency)

**Interfaces:**
- Consumes: `joinPath`, `dirnamePath` from `./paths` (Task 3).
- Produces: `sanitizeHtmlDocument(html: string): string`; `type ResourceReader = (absPath: string) => Promise<{ base64: string; mime: string } | null>`; `resolveResources(html: string, htmlAbsPath: string, readResource: ResourceReader): Promise<string>`. Consumed by Task 6 (`HtmlView`), which passes `window.viewmaster.readResource` (Task 1) as the `readResource` argument.

This is the one place that needs a real DOM (`DOMParser`, and DOMPurify itself needs `window`/`document`) — the global Vitest config is `environment: 'node'` (confirmed in `vitest.config.ts`; no other renderer test file needs a DOM today). Rather than changing the global environment, add `jsdom` as a devDependency and opt this one test file in via the `// @vitest-environment jsdom` docblock — every other existing test file is unaffected.

- [ ] **Step 1: Add the `jsdom` devDependency**

```bash
npm install -D jsdom
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/renderer/src/html/render.test.ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { sanitizeHtmlDocument, resolveResources, type ResourceReader } from './render'

describe('sanitizeHtmlDocument', () => {
  it('strips script tags', () => {
    const out = sanitizeHtmlDocument('<html><body><script>alert(1)</script><p>hi</p></body></html>')
    expect(out).not.toContain('<script')
    expect(out).toContain('<p>hi</p>')
  })

  it('strips inline event handler attributes', () => {
    const out = sanitizeHtmlDocument('<html><body><img src="a.png" onerror="alert(1)"></body></html>')
    expect(out).not.toContain('onerror')
  })

  it('strips javascript: URLs', () => {
    const out = sanitizeHtmlDocument('<html><body><a href="javascript:alert(1)">x</a></body></html>')
    expect(out).not.toContain('javascript:')
  })

  it('strips nested iframe/object/embed', () => {
    const out = sanitizeHtmlDocument(
      '<html><body><iframe src="x"></iframe><object data="y"></object><embed src="z"></body></html>'
    )
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<object')
    expect(out).not.toContain('<embed')
  })

  it('keeps style tags, link stylesheets, and class/id/inline-style attributes', () => {
    const out = sanitizeHtmlDocument(
      '<html><head><style>.a{color:red}</style><link rel="stylesheet" href="s.css"></head>' +
        '<body class="c" id="i" style="color:blue">hi</body></html>'
    )
    expect(out).toContain('<style>')
    expect(out).toContain('rel="stylesheet"')
    expect(out).toContain('class="c"')
    expect(out).toContain('id="i"')
    expect(out).toContain('style="color:blue"')
  })

  it('keeps map/area for image-map diagrams', () => {
    const out = sanitizeHtmlDocument(
      '<html><body><map name="m"><area shape="rect" coords="0,0,10,10" href="t.html"></map>' +
        '<img usemap="#m" src="d.png"></body></html>'
    )
    expect(out).toContain('<map')
    expect(out).toContain('<area')
  })
})

function fakeReader(map: Record<string, { base64: string; mime: string }>): ResourceReader {
  return async (absPath: string) => map[absPath] ?? null
}

describe('resolveResources', () => {
  it('inlines a relative img src as a data: URI', async () => {
    const html = '<html><body><img src="./logo.png"></body></html>'
    const reader = fakeReader({ '/w/logo.png': { base64: 'aGVsbG8=', mime: 'image/png' } })
    const out = await resolveResources(html, '/w/index.html', reader)
    expect(out).toContain('src="data:image/png;base64,aGVsbG8="')
  })

  it('leaves http(s) and existing data: srcs untouched, without calling the reader', async () => {
    const html =
      '<html><body><img src="https://example.com/a.png"><img src="data:image/png;base64,xx"></body></html>'
    const reader = vi.fn(async () => null)
    const out = await resolveResources(html, '/w/index.html', reader)
    expect(out).toContain('src="https://example.com/a.png"')
    expect(out).toContain('src="data:image/png;base64,xx"')
    expect(reader).not.toHaveBeenCalled()
  })

  it('leaves an unresolved reference exactly as the file wrote it', async () => {
    const html = '<html><body><img src="./missing.png"></body></html>'
    const out = await resolveResources(html, '/w/index.html', fakeReader({}))
    expect(out).toContain('src="./missing.png"')
  })

  it('inlines an external stylesheet as a <style> block, resolving its own url()', async () => {
    const html = '<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>'
    const cssBase64 = Buffer.from('.bg{background:url(img/bg.png)}', 'utf8').toString('base64')
    const reader = fakeReader({
      '/w/style.css': { base64: cssBase64, mime: 'text/css' },
      '/w/img/bg.png': { base64: 'Zm9v', mime: 'image/png' }
    })
    const out = await resolveResources(html, '/w/index.html', reader)
    expect(out).not.toContain('<link')
    expect(out).toContain('<style>')
    expect(out).toContain('url("data:image/png;base64,Zm9v")')
  })

  it('resolves url(...) inside inline style attributes', async () => {
    const html = '<html><body><div style="background:url(bg.png)"></div></body></html>'
    const reader = fakeReader({ '/w/bg.png': { base64: 'Zm9v', mime: 'image/png' } })
    const out = await resolveResources(html, '/w/index.html', reader)
    expect(out).toContain('url("data:image/png;base64,Zm9v")')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/html/render.test.ts`
Expected: FAIL — `Cannot find module './render'`.

- [ ] **Step 4: Implement `sanitizeHtmlDocument` and `resolveResources`**

```ts
// src/renderer/src/html/render.ts
import DOMPurify from 'dompurify'
import { dirnamePath, joinPath } from './paths'

export type ResourceReader = (absPath: string) => Promise<{ base64: string; mime: string } | null>

const FORBIDDEN_TAGS = ['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'applet']

/**
 * Sanitizes a full HTML document, stripping every script-execution vector.
 * This — not Shadow DOM — is the feature's actual security boundary.
 */
export function sanitizeHtmlDocument(html: string): string {
  return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: FORBIDDEN_TAGS,
    // DOMPurify's default tag allowlist omits <link> even in WHOLE_DOCUMENT
    // mode (verified against node_modules/dompurify/dist/purify.js — it's
    // tuned for body-only fragments). External stylesheets need it kept.
    ADD_TAGS: ['link']
  })
}

function isEmbeddable(url: string): boolean {
  return !/^(https?:|data:)/i.test(url)
}

function decodeUtf8Base64(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
}

async function inlineCssUrls(
  css: string,
  cssAbsPath: string,
  readResource: ResourceReader
): Promise<string> {
  const matches = Array.from(css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g))
  let result = css
  for (const m of matches) {
    const raw = m[2]
    if (!isEmbeddable(raw)) continue
    const res = await readResource(joinPath(dirnamePath(cssAbsPath), raw))
    if (res) result = result.replace(m[0], `url("data:${res.mime};base64,${res.base64}")`)
  }
  return result
}

/**
 * Resolves relative img/link/style resource references in `html` to inlined
 * data: URIs, reading each through `readResource` (main-process disk reads,
 * never fetch). Call this BEFORE sanitizeHtmlDocument — this function parses
 * raw, unsanitized markup via DOMParser, which never executes embedded
 * scripts (parser-created script elements are inert, and this function only
 * ever hands back a string, never inserts the parsed document live).
 */
export async function resolveResources(
  html: string,
  htmlAbsPath: string,
  readResource: ResourceReader
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const dir = dirnamePath(htmlAbsPath)

  for (const el of Array.from(doc.querySelectorAll('img[src], source[src]'))) {
    const src = el.getAttribute('src')!
    if (!isEmbeddable(src)) continue
    const res = await readResource(joinPath(dir, src))
    if (res) el.setAttribute('src', `data:${res.mime};base64,${res.base64}`)
  }

  for (const styleEl of Array.from(doc.querySelectorAll('style'))) {
    styleEl.textContent = await inlineCssUrls(styleEl.textContent ?? '', htmlAbsPath, readResource)
  }

  for (const linkEl of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
    const href = linkEl.getAttribute('href')!
    if (!isEmbeddable(href)) continue
    const cssAbsPath = joinPath(dir, href)
    const res = await readResource(cssAbsPath)
    if (!res) continue
    const inlined = await inlineCssUrls(decodeUtf8Base64(res.base64), cssAbsPath, readResource)
    const styleEl = doc.createElement('style')
    styleEl.textContent = inlined
    linkEl.replaceWith(styleEl)
  }

  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const inlined = await inlineCssUrls(el.getAttribute('style') ?? '', htmlAbsPath, readResource)
    el.setAttribute('style', inlined)
  }

  return doc.documentElement.outerHTML
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/html/render.test.ts`
Expected: PASS. If the "keeps style tags, link stylesheets..." case fails specifically on the `<link>` assertion, that confirms the `ADD_TAGS: ['link']` line above — don't remove it.

- [ ] **Step 6: Run the full test suite to confirm no other file's environment changed**

Run: `npm test`
Expected: PASS — every pre-existing test still runs under `environment: 'node'`; only `render.test.ts` runs under jsdom.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/html/render.ts src/renderer/src/html/render.test.ts package.json package-lock.json
git commit -m "feat: add HTML document sanitization and resource inlining"
```

---

### Task 6: Renderer — `HtmlView` component

**Files:**
- Create: `src/renderer/src/components/HtmlView.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `sanitizeHtmlDocument`, `resolveResources` (Task 5); `classifyLinkHref` (Task 4); `window.viewmaster.readResource`, `window.viewmaster.openExternal` (existing/Task 1).
- Produces: `HtmlView` React component with props `{ content: string; absPath: string; workspaceRoot: string; onNavigate: (absPath: string) => void }`. Consumed by Task 7 (`ContentPane`).

No automated test for this file — it's DOM-imperative glue (Shadow DOM creation, event wiring) with no existing component-test infrastructure in this codebase (no `.tsx` files are matched by `vitest.config.ts`'s `include`, and no React Testing Library dependency exists). It's covered by Task 8's manual verification pass, consistent with how `MarkdownView.tsx` has zero automated tests today either.

- [ ] **Step 1: Implement `HtmlView`**

```tsx
// src/renderer/src/components/HtmlView.tsx
import { useEffect, useRef } from 'react'
import { resolveResources, sanitizeHtmlDocument } from '../html/render'
import { classifyLinkHref } from '../html/links'

export default function HtmlView({
  content,
  absPath,
  workspaceRoot,
  onNavigate
}: {
  content: string
  absPath: string
  workspaceRoot: string
  onNavigate: (absPath: string) => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const propsRef = useRef({ absPath, workspaceRoot, onNavigate })
  propsRef.current = { absPath, workspaceRoot, onNavigate }

  // Create the shadow root and its click listener exactly once per mount.
  // The listener reads live prop values via propsRef so it never needs to
  // be re-attached (and never double-attached) as files/props change.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const shadow = host.attachShadow({ mode: 'open' })

    const onClick = (e: MouseEvent): void => {
      const anchor = (e.target as HTMLElement).closest('a, area')
      const href = anchor?.getAttribute('href')
      if (!anchor || href === null || href === undefined) return
      e.preventDefault()
      const current = propsRef.current
      const classification = classifyLinkHref(href, current.absPath, current.workspaceRoot)
      if (classification.kind === 'external') window.viewmaster.openExternal(classification.url)
      else if (classification.kind === 'navigate') current.onNavigate(classification.absPath)
    }

    shadow.addEventListener('click', onClick)
    return () => shadow.removeEventListener('click', onClick)
  }, [])

  // Re-render sanitized content whenever the selected file (or its
  // resolved resources) changes.
  useEffect(() => {
    const host = hostRef.current
    if (!host?.shadowRoot) return
    let stale = false

    void (async () => {
      const resolved = await resolveResources(content, absPath, window.viewmaster.readResource)
      const sanitized = sanitizeHtmlDocument(resolved)
      if (!stale && host.shadowRoot) host.shadowRoot.innerHTML = sanitized
    })()

    return () => {
      stale = true
    }
  }, [content, absPath])

  return <div ref={hostRef} className="html-scroll" />
}
```

- [ ] **Step 2: Add the container style**

In `src/renderer/src/styles.css`, add near the `/* ---- rendered markdown ---- */` block (around line 377):

```css
/* ---- rendered html ---- */

.html-scroll {
  height: 100%;
  overflow: auto;
  background: #ffffff;
}
```

(White background, not the app's dark theme — most HTML documents assume a plain browser background and don't set their own; this keeps their text legible instead of adapting them to the app's dark chrome.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/HtmlView.tsx src/renderer/src/styles.css
git commit -m "feat: add HtmlView (shadow-DOM rendered HTML preview)"
```

---

### Task 7: Renderer — wire `HtmlView` into `ContentPane` and `App`

**Files:**
- Modify: `src/renderer/src/components/ContentPane.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `HtmlView` (Task 6); `window.viewmaster.openInBrowser` (Task 2).
- Produces: `ContentPane` gains `workspaceRoot: string` and `onNavigate: (absPath: string) => void` props.

No automated test — `ContentPane.tsx` has no existing test file either (same DOM-component-testing gap as Task 6). Covered by Task 8.

- [ ] **Step 1: Extend `ContentPane`'s detection, `Mode`, props, and routing**

In `src/renderer/src/components/ContentPane.tsx`, add the HTML extension check next to `isMarkdown` (lines 11-16):

```ts
const HTML_EXTENSIONS = ['.html', '.htm']

function isHtml(path: string): boolean {
  const lower = path.toLowerCase()
  return HTML_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
```

Add the import (near the other component imports, line 4-7):

```ts
import HtmlView from './HtmlView'
```

Change the `Mode` type (line 9) to add HTML's plain-code mode (`'marks'` stays markdown-only, `'code'` is HTML-only):

```ts
type Mode = 'view' | 'marks' | 'code' | 'diff'
```

Add the two new props to the function signature (lines 18-28):

```tsx
export default function ContentPane({
  file,
  refreshKey,
  selection,
  versions,
  workspaceRoot,
  onNavigate
}: {
  file: ChangedFile | null
  refreshKey: number
  selection: Selection
  versions: HistoryVersion[]
  workspaceRoot: string
  onNavigate: (absPath: string) => void
}): React.JSX.Element {
```

Insert two new branches into the body-selection chain (lines 110-133), between the existing `isMarkdown` plain-view branch and the final `else`:

```tsx
  } else if (isMarkdown(file.path)) {
    body = <MarkdownView content={content.content} />
  } else if (mode === 'code' && isHtml(file.path)) {
    body = <CodeView fileName={fileName} content={content.content} />
  } else if (isHtml(file.path)) {
    body = (
      <HtmlView
        content={content.content}
        absPath={file.absPath}
        workspaceRoot={workspaceRoot}
        onNavigate={onNavigate}
      />
    )
  } else {
    body = <CodeView fileName={fileName} content={content.content} />
  }
```

Replace the two-way toolbar branch (lines 149-170) with a three-way branch:

```tsx
          {showToolbarToggles && isMarkdown(file.path) ? (
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
          ) : showToolbarToggles && isHtml(file.path) ? (
            <>
              <span className="toolbar-segment">
                {(['view', 'code', 'diff'] as const).map((m) => (
                  <button
                    key={m}
                    className={`toolbar-button${mode === m ? ' active' : ''}`}
                    onClick={() => setMode(m)}
                  >
                    {m === 'view' ? 'Rendered' : m === 'code' ? 'Code' : 'Diff'}
                  </button>
                ))}
              </span>
              <button
                className="toolbar-button"
                onClick={() => window.viewmaster.openInBrowser(file.absPath)}
              >
                Open in Default Browser
              </button>
            </>
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

- [ ] **Step 2: Thread `workspaceRoot` and `onNavigate` through `App.tsx`**

In `src/renderer/src/App.tsx`, add a navigation handler near `onSelectRevision` (after line 129):

```tsx
  const onNavigateToFile = useCallback(
    (absPath: string): void => {
      if (!repo || (repo.kind !== 'repo' && repo.kind !== 'folder')) return
      const existing = repo.files.find((f) => f.absPath === absPath)
      if (existing) {
        setSelected(existing)
        return
      }
      // Linked file has no git-changed entry in the current listing (e.g.
      // Changed mode with an untouched target) — synthesize the same shape
      // Browse Mode's overlayStatus already gives unchanged files.
      const rel = absPath.startsWith(repo.root)
        ? absPath.slice(repo.root.length).replace(/^\/+/, '')
        : absPath
      setSelected({ path: rel, absPath, status: 'unchanged' })
    },
    [repo]
  )
```

Update the `<ContentPane>` call (lines 163-168) to pass the two new props:

```tsx
          <ContentPane
            file={selected}
            refreshKey={refreshKey}
            selection={selection}
            versions={versions}
            workspaceRoot={repo?.root ?? ''}
            onNavigate={onNavigateToFile}
          />
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS (no test targets these files directly, but this confirms nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ContentPane.tsx src/renderer/src/App.tsx
git commit -m "feat: route .html/.htm files to the Rendered/Code/Diff toggle"
```

---

### Task 8: Manual end-to-end verification

**Files:** none (fixture files live in a scratch temp directory, not the repo).

No automated coverage exists for the Shadow DOM render pipeline end-to-end (Task 6/7's justification above) or for the two new IPC actions (Task 1 Step 5 / Task 2, matching the existing lack of `ipc.test.ts`). This task is the only place that verifies they actually work together in the real app. Use the **run-viewmaster** skill to drive the app.

- [ ] **Step 1: Build a fixture folder**

```bash
mkdir -p /tmp/vm-html-fixture/img
cat > /tmp/vm-html-fixture/index.html <<'EOF'
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="style.css">
  <script>document.title = "SHOULD NOT RUN";</script>
</head>
<body>
  <h1>Fixture Index</h1>
  <img src="img/logo.svg" width="64" alt="logo">
  <p><a href="table.html">Go to table page</a></p>
  <p><a href="https://example.com">External link</a></p>
  <button onclick="alert('should not run')">Should be inert</button>
</body>
</html>
EOF
cat > /tmp/vm-html-fixture/table.html <<'EOF'
<!DOCTYPE html>
<html>
<body>
  <h1>Table Page</h1>
  <p><a href="index.html">Back to index</a></p>
</body>
</html>
EOF
cat > /tmp/vm-html-fixture/style.css <<'EOF'
body { font-family: sans-serif; background: url(img/logo.svg) no-repeat top right; }
h1 { color: #2b6cb0; }
EOF
cat > /tmp/vm-html-fixture/img/logo.svg <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#2b6cb0"/></svg>
EOF
```

- [ ] **Step 2: Launch and drive the app via the run-viewmaster skill**

Use the `run-viewmaster` skill to: build/start the app, open `/tmp/vm-html-fixture` as a folder, select `index.html`, and take a screenshot.

Verify from the screenshot / app state:
- The toolbar shows **Rendered / Code / Diff** segmented buttons plus a separate **Open in Default Browser** button.
- Rendered mode (default) shows "Fixture Index" styled with the blue heading color from `style.css`, and the circular SVG logo visible (confirms `link[rel=stylesheet]` inlining, `<style>` `url()` resolution, and `<img>` inlining all worked).
- The button rendered from `<button onclick="...">` does nothing when clicked (no JS alert) — confirms sanitization.
- Page background is white, not the app's dark theme.

- [ ] **Step 3: Verify the Code tab**

Click **Code**. Verify it shows the raw HTML source (including the literal `<script>` tag as text) in a Monaco editor, same as any other code file.

- [ ] **Step 4: Verify the Diff tab**

Click **Diff**. Verify it renders without error (a non-git folder has no baseline, so this should show an all-added diff or empty diff — it must not crash).

- [ ] **Step 5: Verify relative-link navigation**

Switch back to **Rendered**, click "Go to table page". Verify View Master's selected file changes to `table.html` and its Rendered view shows "Table Page". Click "Back to index" and verify it navigates back to `index.html`.

- [ ] **Step 6: Verify external-link and Open-in-Browser behavior**

Click "External link" (`https://example.com`) — verify it does **not** navigate inside the app (the pane still shows the fixture content, not example.com). Click **Open in Default Browser** — verify the OS default browser opens `index.html` (or at minimum that the app doesn't error/crash; actual browser-window confirmation may not be screenshot-able from within the driven session).

- [ ] **Step 7: Clean up the fixture**

```bash
rm -rf /tmp/vm-html-fixture
```

- [ ] **Step 8: Final full-suite check**

Run: `npm run build`
Expected: typecheck + build both succeed.

No commit for this task (no repo files changed) — if any verification step surfaces a bug, fix it as a small follow-up commit referencing the task/step where it was found.
