# viewmaster MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build viewmaster — a read-only Electron desktop viewer for markdown documents and branch diffs, per `docs/superpowers/specs/2026-07-08-viewmaster-design.md`.

**Architecture:** Three Electron surfaces: a main process that owns all filesystem/git access (spawning the system `git` CLI), a context-isolated preload bridge exposing a typed `window.viewmaster` API, and a React renderer that only calls that API. The git layer is a set of small, unit-tested pure parsers plus integration functions tested against throwaway git repos.

**Tech Stack:** Electron, TypeScript, React, electron-vite, electron-builder, allotment, monaco-editor + @monaco-editor/react, markdown-it + @shikijs/markdown-it + shiki + mermaid + DOMPurify, material-icon-theme, chokidar, electron-store, vitest.

## Global Constraints

- **View-only**: the app never writes to user files. Only writes: clipboard, electron-store config.
- **Dark mode only**, VS Code dark aesthetic (`#1e1e1e` background family).
- **Git via system CLI** spawned from the main process — no native git bindings.
- **Renderer sandbox**: `contextIsolation: true`, `nodeIntegration: false`; renderer talks only to `window.viewmaster.*`.
- **Deleted files are excluded from the change list entirely.**
- **Status priority** (highest wins as primary): `untracked` > `modified` > `staged` > `committed`; next-highest also present may show as secondary marker.
- **Baseline** = `git merge-base HEAD <defaultBranch>`; default branch detection: `origin/HEAD` → local `main`/`master` → `init.defaultBranch`. Detached HEAD / on default branch / empty repo / unresolvable → working-tree-only mode. Not a repo → clear message, no crash.
- Hyperlinks in rendered markdown open in the **default browser** (`shell.openExternal`); no in-app navigation.
- Diffs **side-by-side by default** with an inline toggle.
- Binary or files > 2 MB → placeholder, never loaded into Monaco.
- Tests: `vitest`; primary coverage on the git layer using temp repos.
- Packaging: electron-builder — mac `.dmg`, linux AppImage, win NSIS; unsigned.

## File Structure

```
package.json
electron.vite.config.ts
electron-builder.yml
tsconfig.json / tsconfig.node.json / tsconfig.web.json
vitest.config.ts
src/
  shared/
    types.ts            # ChangedFile, FileStatus, BaselineKind, RepoState, FileContent, IPC api type
    tree.ts             # buildTree(files) -> TreeNode (pure)
    tree.test.ts
  main/
    index.ts            # app bootstrap, window, menu, window-state persistence
    store.ts            # electron-store: recentFolders, windowBounds
    watcher.ts          # chokidar debounced repo watcher (incl. .git HEAD/index/refs)
    ipc.ts              # typed ipcMain handlers, current-repo session state
    git/
      run.ts            # runGit(cwd, args)
      baseline.ts       # detectDefaultBranch, resolveBaseline
      baseline.test.ts
      parse.ts          # parsePorcelainV2, parseNameStatusZ (pure)
      parse.test.ts
      changes.ts        # collectChanges(root, baseline) -> ChangedFile[]
      changes.test.ts
      content.ts        # readCurrentFile (binary/size detect), readBaseFile (git show)
      content.test.ts
      testRepo.ts       # test helper: make throwaway git repos
  preload/
    index.ts            # contextBridge -> window.viewmaster
    index.d.ts          # global Window typing
  renderer/
    index.html
    src/
      main.tsx
      App.tsx           # welcome screen | Allotment split layout
      styles.css        # dark theme
      monacoSetup.ts    # workers + loader.config({ monaco })
      icons.ts          # material-icon-theme lookup (pure-ish; url map via vite glob)
      components/
        Sidebar.tsx     # tree, status colors, context menu (copy absolute path)
        ContentPane.tsx # routes by file type; view/diff toggle state
        CodeView.tsx    # Monaco read-only editor
        DiffView.tsx    # Monaco DiffEditor, side-by-side/inline toggle
        MarkdownView.tsx# rendered markdown + mermaid + link interception
        Placeholder.tsx # binary/too-large/error messages
      markdown/
        render.ts       # markdown-it + shiki + mermaid-fence + DOMPurify pipeline
```

---

### Task 1: Project scaffold — electron-vite + React + vitest, dark window opens

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`
- Create: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`
- Create: `src/shared/types.ts` (skeleton — filled in Task 2)

**Interfaces:**
- Produces: working `npm run dev`, `npm run build`, `npm test` scripts; `src/shared/` importable from both main and renderer via `@shared/*` alias.

- [ ] **Step 1: Install dependencies**

```bash
npm init -y
npm install --save-exact electron-store@8.2.0
npm install chokidar
npm install --save-dev electron electron-vite vite typescript electron-builder vitest \
  react react-dom @types/react @types/react-dom @vitejs/plugin-react \
  allotment monaco-editor @monaco-editor/react \
  markdown-it @types/markdown-it @shikijs/markdown-it shiki mermaid dompurify \
  material-icon-theme @types/node
```

(Note: renderer-side libs are devDependencies because vite bundles them; only main-process externalized deps — `chokidar`, `electron-store` — must be runtime `dependencies` for electron-builder. `electron-store@8` is the last CJS version; the main bundle is CJS.)

- [ ] **Step 2: Write configs** — `package.json` scripts:

```json
{
  "name": "viewmaster",
  "version": "0.1.0",
  "description": "Read-only desktop viewer for markdown documents and branch diffs",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "build": "npm run typecheck && electron-vite build",
    "test": "vitest run",
    "dist:mac": "npm run build && electron-builder --mac",
    "dist:linux": "npm run build && electron-builder --linux",
    "dist:win": "npm run build && electron-builder --win"
  }
}
```

`electron.vite.config.ts`:

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 20000 }
})
```

tsconfigs: `tsconfig.node.json` covers `src/main`, `src/preload`, `src/shared` (module NodeNext, strict); `tsconfig.web.json` covers `src/renderer/src`, `src/shared`, `src/preload/index.d.ts` (jsx react-jsx, DOM libs, bundler resolution); root `tsconfig.json` just references both. Both define `"paths": { "@shared/*": ["src/shared/*"] }`.

- [ ] **Step 3: Minimal three surfaces** — main opens a 1200×800 `BrowserWindow` with `backgroundColor '#1e1e1e'`, `contextIsolation: true`, `nodeIntegration: false`, preload wired; renderer shows "viewmaster" placeholder. Dark `styles.css` base.

- [ ] **Step 4: Sanity test** — `src/shared/types.test.ts` asserting a trivial import works; run `npm test` → PASS; run `npm run build` → succeeds.

- [ ] **Step 5: Commit** — `feat: scaffold electron-vite + react + vitest app shell`

---

### Task 2: Shared types + git runner

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/main/git/run.ts`, `src/main/git/testRepo.ts`, `src/main/git/run.test.ts`

**Interfaces (produces — used by every later task):**

```ts
// src/shared/types.ts
export type FileStatus = 'untracked' | 'modified' | 'staged' | 'committed'

export interface ChangedFile {
  path: string        // repo-relative, forward slashes
  absPath: string
  status: FileStatus  // primary (highest priority present)
  secondary?: FileStatus
}

export type BaselineKind =
  | { kind: 'merge-base'; base: string; defaultBranch: string; branch: string }
  | { kind: 'working-only'; reason: 'detached' | 'on-default' | 'no-commits' | 'no-baseline'; branch?: string }

export type RepoState =
  | { kind: 'repo'; root: string; baseline: BaselineKind; files: ChangedFile[] }
  | { kind: 'not-git'; root: string }
  | { kind: 'error'; root: string; message: string }

export type FileContent =
  | { kind: 'text'; content: string }
  | { kind: 'binary' } | { kind: 'too-large'; size: number } | { kind: 'missing' }
```

```ts
// src/main/git/run.ts
export interface GitResult { code: number; stdout: string; stderr: string }
export function runGit(cwd: string, args: string[]): Promise<GitResult> // execFile('git', ...), never rejects on nonzero exit
```

```ts
// src/main/git/testRepo.ts (test-only helper)
export async function makeRepo(): Promise<{ root: string; git: (...args: string[]) => Promise<GitResult>; write: (rel: string, content: string) => Promise<void>; cleanup: () => Promise<void> }>
// git init -b main; sets user.name/user.email/commit.gpgsign=false locally
```

- [ ] **Step 1: Failing test** — `run.test.ts`: `runGit(tmpRepo, ['rev-parse', '--is-inside-work-tree'])` → code 0, stdout 'true'; `runGit(tmpdir-not-repo, ['rev-parse', '--is-inside-work-tree'])` → nonzero code, no throw.
- [ ] **Step 2: Verify fail** (`npx vitest run src/main/git/run.test.ts`)
- [ ] **Step 3: Implement** `runGit` with `execFile`, `maxBuffer: 64MB`; implement `makeRepo` with `fs.mkdtemp` + `git init -b main`.
- [ ] **Step 4: Verify pass**
- [ ] **Step 5: Commit** — `feat: git runner + shared types + test repo helper`

---

### Task 3: Baseline detection

**Files:**
- Create: `src/main/git/baseline.ts`, `src/main/git/baseline.test.ts`

**Interfaces:**
- Consumes: `runGit`, `makeRepo`.
- Produces: `detectDefaultBranch(cwd): Promise<string | null>`, `resolveBaseline(cwd): Promise<BaselineKind>`.

Logic (per spec): default branch via `git symbolic-ref refs/remotes/origin/HEAD` → local `main`/`master` (`git show-ref --verify`) → `git config init.defaultBranch`. Baseline: no HEAD commit → `working-only/no-commits`; detached (symbolic-ref HEAD fails) → `working-only/detached`; branch === default → `working-only/on-default`; no default/merge-base failure → `working-only/no-baseline`; else `merge-base HEAD <origin/def or def>` → `{ kind: 'merge-base', base, defaultBranch, branch }`.

- [ ] **Step 1: Failing tests** covering: feature branch off main → merge-base equals fork commit; on main → `on-default`; detached → `detached`; empty repo → `no-commits`; repo with only branch `trunk` and no config → `no-baseline`; `master` fallback works.
- [ ] **Step 2: Verify fail** → **Step 3: Implement** → **Step 4: Verify pass**
- [ ] **Step 5: Commit** — `feat: default-branch + merge-base baseline detection`

---

### Task 4: Pure parsers — porcelain v2 and name-status

**Files:**
- Create: `src/main/git/parse.ts`, `src/main/git/parse.test.ts`

**Interfaces:**

```ts
export interface PorcelainEntry { path: string; staged: boolean; modified: boolean; untracked: boolean; deleted: boolean }
export function parsePorcelainV2(nulSeparated: string): PorcelainEntry[]
export function parseNameStatusZ(nulSeparated: string): { path: string; committed: true }[] // D excluded; R/C use new path
```

Porcelain v2 `-z` rules: records split on NUL. `? <path>` → untracked. `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` → path = fields 8+ rejoined (paths may contain spaces). `2 ... <Xscore> <path>` → path = fields 9+, **next NUL token is origPath — consume it**. `u` → treat as modified (path = fields 10+). `!` → skip. Deleted: `Y === 'D'`, or `X === 'D' && Y === '.'` → `deleted: true` (assembler excludes and suppresses committed entry too). `staged = X !== '.' && X !== 'D'`; `modified = Y !== '.' && Y !== 'D'`.

`git diff --name-status -z base HEAD` format: `M\0path\0A\0path\0R100\0old\0new\0…` — for `R`/`C` consume two paths, keep the new one; drop `D`.

- [ ] **Step 1: Failing tests** — string fixtures for: untracked; staged-only (`M.`); modified-only (`.M`); both (`MM`); added staged (`A.`); worktree delete (`.D` → deleted); staged delete (`D.` → deleted); rename record type 2 with origPath consumption; path with spaces; name-status with M/A/D/R100.
- [ ] **Steps 2–4: fail → implement → pass**
- [ ] **Step 5: Commit** — `feat: porcelain-v2 and name-status parsers`

---

### Task 5: Changed-file set assembly + status merging

**Files:**
- Create: `src/main/git/changes.ts`, `src/main/git/changes.test.ts`

**Interfaces:**
- Consumes: `runGit`, parsers, `BaselineKind`.
- Produces: `collectChanges(root: string, baseline: BaselineKind): Promise<ChangedFile[]>` — sorted by path.

Logic: run `git status --porcelain=v2 -z --untracked-files=all`; accumulate per-path status sets; if `baseline.kind === 'merge-base'`, add `committed` for each `parseNameStatusZ(git diff --name-status -z <base> HEAD)` path. Paths flagged deleted by porcelain are excluded entirely (even if committed earlier in branch). Primary = highest priority (`untracked` > `modified` > `staged` > `committed`); secondary = next-highest present, if any. `absPath = join(root, path)`.

- [ ] **Step 1: Failing integration tests** (temp repos): committed-only file on branch → `committed`; committed then modified → primary `modified`, secondary `committed`; staged file → `staged`; staged+modified → primary `modified` secondary `staged`; untracked → `untracked`; file committed on branch then deleted from worktree → **absent**; working-only baseline → committed set empty but staged/modified/untracked present; file changed on main *after* fork not listed (merge-base isolation).
- [ ] **Steps 2–4: fail → implement → pass**
- [ ] **Step 5: Commit** — `feat: changed-file set with merged statuses`

---

### Task 6: Change tree (pure)

**Files:**
- Create: `src/shared/tree.ts`, `src/shared/tree.test.ts`

**Interfaces:**

```ts
export interface TreeNode { name: string; path: string; dirs: TreeNode[]; files: ChangedFile[] }
export function buildTree(files: ChangedFile[]): TreeNode // root: name '', path ''
```

Only directories that contain changed files exist (tree is built solely from the file list). Dirs sorted before files, both alphabetical.

- [ ] **Step 1: Failing tests** — nested paths produce nested dirs; no empty dirs; ordering; root-level files.
- [ ] **Steps 2–4: fail → implement → pass** → **Step 5: Commit** — `feat: changed-file tree builder`

---

### Task 7: File content reading

**Files:**
- Create: `src/main/git/content.ts`, `src/main/git/content.test.ts`

**Interfaces:**
- Produces: `readCurrentFile(absPath: string): Promise<FileContent>` (2 MB cap → `too-large`; NUL byte in first 8 KB → `binary`; ENOENT → `missing`; else utf-8 `text`), `readBaseFile(root: string, base: string | null, relPath: string): Promise<string>` (`git show <base>:<relPath>`, empty string when base is null or path absent at base — untracked/added renders all-added).

- [ ] **Step 1: Failing tests** — text file; file with NUL bytes → binary; 3 MB file → too-large; missing; base content of committed-then-modified file returns old content; untracked path → ''.
- [ ] **Steps 2–4: fail → implement → pass** → **Step 5: Commit** — `feat: current/base file content readers`

---

### Task 8: Main-process integration — store, watcher, IPC, menu

**Files:**
- Create: `src/main/store.ts`, `src/main/watcher.ts`, `src/main/ipc.ts`
- Modify: `src/main/index.ts`

**Interfaces (produces — the IPC contract the preload consumes):**

| channel | args → result |
|---|---|
| `dialog:openFolder` | → `string \| null` |
| `repo:open` | `(root: string)` → `RepoState` (also records recent folder, restarts watcher) |
| `repo:refresh` | → `RepoState` (current repo) |
| `file:read` | `(absPath: string)` → `FileContent` |
| `file:readBase` | `(relPath: string)` → `string` |
| `app:recentFolders` | → `string[]` |
| `app:copyPath` | `(absPath: string)` → `void` (clipboard) |
| `app:openExternal` | `(url: string)` → `void` (http/https only) |
| push `repo:changed` | → `RepoState` (debounced watcher → recompute → webContents.send) |

- `store.ts`: electron-store with `recentFolders: string[]` (max 10, MRU) and `windowBounds`.
- `watcher.ts`: `watchRepo(root, onChange)` — chokidar on root, `ignoreInitial`, ignore `node_modules` and `.git` internals **except** `.git/HEAD`, `.git/index`, `.git/refs/**` (so commits/stages/branch switches trigger); 300 ms debounce.
- `index.ts`: restore/persist window bounds; app menu with File → Open Folder… (CmdOrCtrl+O) and Open Recent; `setWindowOpenHandler` → deny + `shell.openExternal`.
- `repo:open` behavior: not a directory/`rev-parse --is-inside-work-tree` fails → `{ kind: 'not-git' }`; git errors → `{ kind: 'error', message }`; else resolve baseline + collect changes. Root normalized to `git rev-parse --show-toplevel`.

- [ ] **Step 1: Implement** all three modules (watcher ignore logic gets a unit test on its exported `shouldIgnore(root, path)` predicate).
- [ ] **Step 2: Verify** — `npm test` passes, `npm run build` compiles, `npm run dev` opens window with menu.
- [ ] **Step 3: Commit** — `feat: IPC surface, repo watcher, persistence, app menu`

---

### Task 9: Preload bridge

**Files:**
- Create: `src/preload/index.d.ts`; Modify: `src/preload/index.ts`

**Interfaces (produces):**

```ts
// window.viewmaster
export interface ViewmasterApi {
  openFolderDialog(): Promise<string | null>
  openRepo(root: string): Promise<RepoState>
  refreshRepo(): Promise<RepoState>
  readFile(absPath: string): Promise<FileContent>
  readBaseFile(relPath: string): Promise<string>
  recentFolders(): Promise<string[]>
  copyPath(absPath: string): void
  openExternal(url: string): void
  onRepoChanged(cb: (state: RepoState) => void): () => void   // returns unsubscribe
  onMenuOpenFolder(cb: (root: string | null) => void): () => void // menu-driven opens
}
```

- [ ] **Step 1: Implement** contextBridge wrappers over `ipcRenderer.invoke`/`.on`; global `Window` typing in `index.d.ts`.
- [ ] **Step 2: Verify build + commit** — `feat: typed preload bridge (window.viewmaster)`

---

### Task 10: Renderer shell — welcome screen, split layout, sidebar

**Files:**
- Modify: `src/renderer/src/App.tsx`, `styles.css`
- Create: `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/icons.ts`, `src/renderer/src/icons.test.ts` (pure lookup logic)

**Interfaces:**
- Consumes: `window.viewmaster`, `buildTree`, `RepoState`.
- Produces: `<Sidebar state={RepoState} selected={string|null} onSelect={(f: ChangedFile) => void} />`; `App` owns `repoState`, `selectedFile` state.

Details:
- Welcome screen (no repo open): app name, Open Folder button, recent-folders list.
- Layout: `Allotment` horizontal — sidebar (min 180, default 280 px) + content pane.
- Sidebar: tree from `buildTree`; dirs collapsible (default expanded); file rows show material-icon-theme icon (lookup: `fileNames` exact match → longest `fileExtensions` match → generic `file`, SVG urls via `import.meta.glob` over `material-icon-theme/icons/*.svg`), name colored by status, letter badge (`U`/`M`/`S`/`C`, secondary shown dimmed like `M·C`). Colors: untracked `#73C991`, modified `#E2C08D`, staged `#75BEFF`, committed `#C5C5C5`.
- `not-git` → sidebar message "Not a git repository"; `working-only` → subtle header line "Working tree changes only (<reason>)"; `merge-base` → header "`<branch>` vs `<defaultBranch>`".
- Right-click file row → custom context menu → "Copy absolute path" → `viewmaster.copyPath`.
- [ ] **Step 1: Failing test** for icon lookup (name match, extension match, fallback) → implement → pass.
- [ ] **Step 2: Implement components**, verify in `npm run dev` against this repo.
- [ ] **Step 3: Commit** — `feat: sidebar change tree, welcome screen, split layout`

---

### Task 11: Code view + diff views (Monaco)

**Files:**
- Create: `src/renderer/src/monacoSetup.ts`, `components/CodeView.tsx`, `components/DiffView.tsx`, `components/Placeholder.tsx`, `components/ContentPane.tsx`

**Interfaces:**
- Produces: `<ContentPane file={ChangedFile|null} repo={RepoState} />` — owns `mode: 'view' | 'diff'` and `sideBySide: boolean`; routes markdown (`.md`/`.markdown`/`.mdx`) → MarkdownView (Task 12), else CodeView; toolbar with file path, Diff toggle, side-by-side/inline toggle (visible in diff mode).
- `monacoSetup.ts`: `self.MonacoEnvironment.getWorker` via vite `?worker` imports (editor/json/css/html/ts workers) + `loader.config({ monaco })`.
- `CodeView`: `<Editor>` `readOnly, vs-dark, lineNumbers on, automaticLayout` — language inferred from extension via `monaco.languages`.
- `DiffView`: `<DiffEditor original={baseContent} modified={currentContent} options={{ readOnly: true, renderSideBySide }}>`.
- Binary/too-large/missing → `Placeholder` ("Binary file — not displayed", "File too large to display (N MB)").

- [ ] **Step 1: Implement + verify in dev** (open a code file, toggle diff, toggle inline).
- [ ] **Step 2: Commit** — `feat: monaco read-only code view and side-by-side/inline diff`

---

### Task 12: Markdown view — rendered pipeline + diff toggle

**Files:**
- Create: `src/renderer/src/markdown/render.ts`, `components/MarkdownView.tsx`

**Interfaces:**
- Produces: `renderMarkdown(src: string): Promise<string>` (sanitized HTML string), `<MarkdownView content={string} />`.

Pipeline: singleton `markdown-it` (`html: true, linkify: true`) + `@shikijs/markdown-it` (theme `dark-plus`); fence rule wrapped so ` ```mermaid ` fences emit `<pre class="mermaid">escaped source</pre>` before shiki sees them; output through `DOMPurify.sanitize`. Component: set sanitized HTML, then `mermaid.run({ nodes })` (`startOnLoad: false, theme: 'dark', securityLevel: 'strict'`), per-diagram error fallback to a message block. Click delegation: `a[href^="http"]` → preventDefault → `viewmaster.openExternal`; all other anchors preventDefault (no in-app navigation). GitHub-dark typography CSS.

Diff toggle for markdown = the same `DiffView` with `language 'markdown'` (already wired in ContentPane routing).

- [ ] **Step 1: Implement + verify in dev** (render README.md, a mermaid fence, a code fence, click a link → default browser).
- [ ] **Step 2: Commit** — `feat: rendered markdown with mermaid, shiki, sanitization, external links`

---

### Task 13: Auto-refresh wiring

**Files:**
- Modify: `App.tsx`, `ContentPane.tsx`

Behavior: subscribe `onRepoChanged` → replace `repoState`; if selected file no longer in change set, keep it open (still viewable) but unhighlight if gone; ContentPane re-reads current file content (and base content when in diff mode) whenever `repoState` ticks (pass a `refreshKey`). Selected file identity keyed by `path`.

- [ ] **Step 1: Implement + verify in dev** — edit a file externally, see sidebar + open view update in place.
- [ ] **Step 2: Commit** — `feat: auto-refresh change list and open file on disk changes`

---

### Task 14: Packaging + final verification

**Files:**
- Create: `electron-builder.yml`, `build/icon.png` (simple placeholder icon)
- Modify: `package.json` (author/description fields required by builder)

`electron-builder.yml`: appId `com.vanhorn.viewmaster`, productName `viewmaster`, `files: [out/**, package.json]`, mac target `dmg` (unsigned: `identity: null`), linux `AppImage`, win `nsis`, `npmRebuild: false`.

- [ ] **Step 1:** Full `npm test` + `npm run build` green.
- [ ] **Step 2:** `npm run dist:mac` produces a `.dmg` in `release/` (configured output dir).
- [ ] **Step 3:** Launch packaged (or dev) app; walk the spec's flows once (open repo, tree, md render, code view, diffs, copy path, refresh).
- [ ] **Step 4:** Commit — `feat: electron-builder packaging (dmg/AppImage/nsis, unsigned)`

---

## Self-Review Notes

- Spec coverage: markdown rendering (T12), mermaid (T12), links→browser (T12), sidebar changed-only tree (T5/T6/T10), icons+status colors (T10), md diff toggle (T12/T11), code view+diff (T11), side-by-side default + inline toggle (T11), copy absolute path (T10), auto-refresh (T13), baseline model + edge cases (T3/T5), deleted excluded (T4/T5), binary/too-large (T7/T11), error handling not-git/no-baseline/git-failure (T3/T8/T10), tests-on-git-layer (T2–T7), packaging unsigned dmg/AppImage/exe (T14), README + .gitignore already exist in repo.
- Type consistency: `RepoState`/`BaselineKind`/`ChangedFile`/`FileContent` defined once in Task 2 and consumed by name everywhere else.
