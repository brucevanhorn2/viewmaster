# Go & Python LSP Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F12 / Shift+F12 in Go and Python files answered by real language servers (user's `gopls`, bundled `pyright`), with labeled heuristic fallback and viewable, visibly-marked files outside the opened folder.

**Architecture:** A main-process `LspManager` (one per open folder) lazily spawns one `LspClient` per language over stdio JSON-RPC and answers definition/references queries; `ipc.ts` tries it first for `.go`/`.py`/`.pyi` and falls back to the existing heuristic with a reason. A main-computed allow-list of external roots (GOROOT, GOMODCACHE, venv, pyright stubs) lets `file:read` serve outside files, which the renderer marks with a tinted toolbar.

**Tech Stack:** Electron main (Node), `vscode-languageserver-protocol` (JSON-RPC + LSP types), `pyright` npm package, React 19 + Monaco renderer, vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-lsp-go-python-design.md` (builds on `docs/superpowers/specs/2026-08-19-find-usages-design.md`)

## Global Constraints

- Languages: **Go** (`.go`) via user's `gopls` on PATH, else `$(go env GOPATH)/bin/gopls[.exe]`; **Python** (`.py`, `.pyi`) via bundled `pyright`. Nothing else changes (TS/JS untouched; other languages stay heuristic).
- Missing-gopls install command, verbatim: `go install golang.org/x/tools/gopls@latest`
- Labels, verbatim: `approximate — Go index still loading`, `approximate — gopls not installed`, `approximate — Go language server unavailable` (and the same three with `Python` / `pyright` in place of `Go` / `gopls`; Python never shows "not installed" since it is bundled — use the "unavailable" text if it fails).
- Real results **replace** heuristic results, never merged. An **empty LSP answer is the answer** (no fallback).
- Servers start **lazily** on first query per language per folder; all shut down on folder switch and app quit — no orphan processes.
- gopls inherits `process.env` unchanged.
- Spawn with `child_process.spawn(cmd, args, { shell: false })`; never interpolate paths into a shell.
- External-file reads are allowed **only** under the main-computed allow-list (GOROOT, GOMODCACHE, detected venv, pyright stubs dir), checked after `realpath`. The renderer can never add roots.
- Must work on Windows (the user's daily machine): `gopls.exe`, `file:///c%3A/...` URIs, `\` paths.
- New runtime deps go in `dependencies` (electron-vite externalizes them for main): `vscode-languageserver-protocol`, `pyright`. `pyright` must be `asarUnpack`ed.

## Review Focus

1. **Windows URIs and drive-letter casing** — gopls returns `file:///c%3A/Users/...`; results must map to the same `absPath` the renderer uses (else cross-file jump opens "missing" and same-file detection in `registerEditorOpener` breaks). → Task 1 test `translates a windows file URI`.
2. **File changed on disk after it was opened in the server** (user pulls, regenerates code) — positions would be stale. → Task 2 test `reopens a document whose mtime changed`.
3. **Server that crashes on start every time** must not respawn forever; after the restart budget the language is permanently "unavailable" for that folder, each answer labeled. → Task 4 test `stops restarting after MAX_RESTARTS`.
4. **Path tricks into the external allow-list** (`<GOMODCACHE>/../../secret`, a symlink inside the venv pointing elsewhere) must be rejected. → Task 1 tests `rejects traversal out of an external root` and `rejects a symlink escaping an external root`.
5. **Switching folders while a server is mid-load** must kill it and not deliver late answers into the new session. → Task 4 test `dispose kills children and rejects pending queries`.

---

### Task 1: Shared types, URI translation, external roots

**Files:**
- Modify: `src/shared/types.ts:69-83`
- Create: `src/main/lsp/translate.ts`, `src/main/lsp/translate.test.ts`
- Create: `src/main/files/externalRoots.ts`, `src/main/files/externalRoots.test.ts`

**Interfaces:**
- Produces (shared/types.ts):
  ```ts
  export type LspLanguage = 'go' | 'python'
  export type ApproximateReason = 'starting' | 'not-installed' | 'unavailable'
  export type ExternalKind = 'go-stdlib' | 'go-modcache' | 'python-venv' | 'python-stubs'
  export interface SymbolQuery { word: string; absPath: string; line: number /*1-based*/; column: number /*0-based*/ }
  // SymbolLocationsResult gains (optional, so existing callers compile):
  //   source?: 'lsp' | 'heuristic'
  //   approximate?: { language: LspLanguage; reason: ApproximateReason }
  ```
- Produces (translate.ts):
  ```ts
  export function lspLocationsToSymbolLocations(result: Location | Location[] | LocationLink[] | null, workspaceRoot: string): SymbolLocation[]
  export function toFileUri(absPath: string): string
  export function languageForPath(absPath: string): LspLanguage | null  // .go → go; .py/.pyi → python
  ```
  `SymbolLocation.path` is repo-relative for in-root files, the absolute path with forward slashes for outside files. LSP 0-based line → 1-based `line`; 0-based character → `column`. `LocationLink` uses `targetSelectionRange`. Deduplicate by `absPath:line:column`.
- Produces (externalRoots.ts):
  ```ts
  export interface ExternalRoot { kind: ExternalKind; dir: string /* realpath'd */ }
  export function classifyExternal(realAbsPath: string, roots: ExternalRoot[]): ExternalKind | null
  export async function resolveExternal(absPath: string, roots: ExternalRoot[]): Promise<{ real: string; kind: ExternalKind } | null>
  export async function goExternalRoots(env: NodeJS.ProcessEnv): Promise<ExternalRoot[]>  // `go env -json GOROOT GOMODCACHE` via execFile; [] if go missing
  ```

- [ ] **Step 1: Write failing tests.**
  - `translate.test.ts`: `translates a location inside the root` (line 9 → 10, `path` repo-relative); `translates a location link via targetSelectionRange`; `translates a windows file URI` — use `pathToFileURL`-style `file:///c%3A/repo/a.go` with `workspaceRoot='C:\\repo'` (run only when `process.platform === 'win32'`, via `it.runIf`) → `absPath === 'C:\\repo\\a.go'`, `path === 'a.go'`; `outside root keeps absolute path`; `null → []`; `dedupes identical locations`; `languageForPath('x.pyi') === 'python'`, `('x.ts') === null`.
  - `externalRoots.test.ts` (temp dirs): `classifies a file inside GOMODCACHE`; `rejects traversal out of an external root` (`join(modcache,'..','..','secret.txt')` → `null`); `rejects a symlink escaping an external root` (symlink inside root → file outside; skip with `it.skipIf` if symlink creation throws EPERM on Windows); `missing file → null`.
- [ ] **Step 2: Run** `npx vitest run src/main/lsp/translate.test.ts src/main/files/externalRoots.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `npm install vscode-languageserver-protocol` (dependencies). Use `fileURLToPath`/`pathToFileURL` from `url`; reuse `isInsideRoot` from `src/main/files/resource.ts` for containment (export it if not already).
- [ ] **Step 4: Run** the same command, then `npm run typecheck` — Expected: PASS, no errors.
- [ ] **Step 5: Commit** — `feat(lsp): shared types, URI translation, external roots (#22)`

---

### Task 2: LSP client over stdio

**Files:**
- Create: `src/main/lsp/client.ts`, `src/main/lsp/client.test.ts`
- Create: `src/main/lsp/fixtures/fakeServer.mjs` (test-only LSP server)

**Interfaces:**
- Consumes: `toFileUri`, `lspLocationsToSymbolLocations` (Task 1).
- Produces:
  ```ts
  export interface ServerCommand { command: string; args: string[]; env: NodeJS.ProcessEnv; initializationOptions?: unknown; settings?: Record<string, unknown> /* answered to workspace/configuration by section */ }
  export type ClientState = 'starting' | 'ready' | 'dead'
  export class LspClient {
    constructor(cmd: ServerCommand, workspaceRoot: string)
    readonly startedAt: number
    state(): ClientState
    start(): Promise<void>                       // spawn + initialize + initialized; state 'ready' when done
    definition(absPath: string, line: number, column: number, timeoutMs: number): Promise<SymbolLocation[]>
    references(absPath: string, line: number, column: number, timeoutMs: number): Promise<SymbolLocation[]>  // includeDeclaration: true
    onExit(cb: () => void): void
    dispose(): Promise<void>                     // shutdown+exit, then kill after 2000ms
  }
  export class LspTimeoutError extends Error {}
  ```
  Before a query, the client ensures the document is open: `textDocument/didOpen` with disk content and `languageId` (`go`/`python`) on first use; if the file's `mtimeMs` changed since it was opened, send `didClose` + `didOpen` (new version). Answer `workspace/configuration` requests from `settings[section] ?? null`; answer `window/workDoneProgress/create` and `client/registerCapability` with `null`.

- [ ] **Step 1: Write `fakeServer.mjs` and failing tests.** The fake server (using `vscode-languageserver-protocol/node`'s `createProtocolConnection` over stdio) answers `initialize`, records `didOpen`/`didClose` (exposed via a custom request `fake/opened` returning the list), answers `textDocument/definition` from a `FAKE_MODE` env var: `ok` → one `Location` at line 4 char 2 of the requested uri; `empty` → `[]`; `hang` → never replies; `crash` → `process.exit(1)` on first definition. Tests:
  - `start reaches ready`
  - `definition translates the server answer` → `[{ line: 5, column: 2, absPath: <file> }]`
  - `empty answer resolves to []` (not an error)
  - `timeout rejects with LspTimeoutError` (`hang`, timeoutMs 200)
  - `crash fires onExit and state becomes dead`
  - `reopens a document whose mtime changed` — query, `utimes` the file forward, query again → `fake/opened` shows `didClose` then a second `didOpen`.
  - `dispose kills the child` — pid no longer alive (`process.kill(pid, 0)` throws).
  Spawn the fake with `command: process.execPath, args: [fakeServerPath]`.
- [ ] **Step 2: Run** `npx vitest run src/main/lsp/client.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `LspClient`** with `createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin))`. Timeouts via `Promise.race` + cancel the request (`$/cancelRequest` through a `CancellationTokenSource`). Discard child stderr except keep the last 4 KB for error messages.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(lsp): stdio LSP client (#22)`

---

### Task 3: Server discovery and packaging

**Files:**
- Create: `src/main/lsp/servers.ts`, `src/main/lsp/servers.test.ts`
- Modify: `package.json` (add `pyright` to `dependencies`), `electron-builder.yml` (add `asarUnpack: ['node_modules/pyright/**']`)

**Interfaces:**
- Consumes: `ServerCommand` (Task 2), `ExternalRoot`, `goExternalRoots` (Task 1).
- Produces:
  ```ts
  export async function findGopls(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Promise<string | null>
  export function goplsCommand(goplsPath: string, env: NodeJS.ProcessEnv): ServerCommand          // args: ['serve'] ; env passed through unchanged
  export async function findVenvPython(workspaceRoot: string, platform?: NodeJS.Platform): Promise<string | null> // .venv then venv; Scripts/python.exe on win32, bin/python elsewhere
  export function pyrightCommand(venvPython: string | null): ServerCommand
  export function pyrightStubsDir(): string                                                        // <pyright pkg>/dist/typeshed-fallback, with app.asar → app.asar.unpacked
  export async function externalRootsFor(language: LspLanguage, workspaceRoot: string, env: NodeJS.ProcessEnv): Promise<ExternalRoot[]>
  ```
  `pyrightCommand`: `command: process.execPath`, `args: [<pyright pkg>/langserver.index.js, '--stdio']`, `env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }`, `settings: { python: { pythonPath: venvPython ?? undefined }, 'python.analysis': { autoSearchPaths: true, diagnosticMode: 'openFilesOnly' } }`. Resolve the pyright package dir with `require.resolve('pyright/package.json')`, swapping `app.asar` → `app.asar.unpacked`. `externalRootsFor('python')` → venv dir (`python-venv`) if found + stubs dir (`python-stubs`); `'go'` → `goExternalRoots`.

- [ ] **Step 1: Write failing tests** (temp dirs; fake PATH): `findGopls finds gopls on PATH` (create an executable `gopls`/`gopls.exe` in a temp dir, `env.PATH` = that dir); `findGopls falls back to GOPATH/bin` (set `env.GOPATH` to a temp dir containing `bin/gopls[.exe]`; `findGopls` uses `env.GOPATH` when set and only runs `go env GOPATH` when it is unset); `findGopls returns null when absent`; `findVenvPython prefers .venv over venv`, `uses Scripts/python.exe on win32`; `pyrightCommand passes the venv python in settings`; `pyrightStubsDir exists` (`existsSync`).
- [ ] **Step 2: Run** `npx vitest run src/main/lsp/servers.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; `npm install pyright` (dependencies); edit `electron-builder.yml`.
- [ ] **Step 4: Run** the same command, then `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Optional real-server smoke test** in `servers.test.ts`: `it.skipIf(!(await findGopls(process.env)))('real gopls answers a definition')` against a temp module (`go.mod` + two packages, `main.go` calls `pkg.Hello()`) → definition lands in `pkg/hello.go`. Same for pyright (always available): two `.py` files, `from b import f` → definition in `b.py`. Use timeouts of 60 s for these two tests only.
- [ ] **Step 6: Commit** — `feat(lsp): gopls/pyright discovery and packaging (#22)`

---

### Task 4: LspManager and IPC wiring

**Files:**
- Create: `src/main/lsp/manager.ts`, `src/main/lsp/manager.test.ts`
- Modify: `src/main/ipc.ts:314-319` (`file:read`), `:390-452` (`symbol:definitions`, `symbol:references`), `openRepo` (dispose previous manager), add `file:externalKind`
- Modify: `src/main/index.ts` (dispose manager on `will-quit`)
- Modify: `src/preload/index.ts:58-61`, `src/preload/index.d.ts` if it re-declares the API
- Modify: `src/main/ipc.test.ts` (new handler behavior)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  ```ts
  export const QUERY_TIMEOUT_MS = 4000
  export const STARTING_GRACE_MS = 120_000  // a timeout within this window of start = 'starting', after = 'unavailable'
  export const MAX_RESTARTS = 3
  export type LspAnswer = { kind: 'answer'; locations: SymbolLocation[] } | { kind: 'fallback'; reason: ApproximateReason }
  export interface ManagerDeps { commandFor(lang: LspLanguage): Promise<ServerCommand | null>; createClient?(cmd: ServerCommand, root: string): LspClient }
  export class LspManager {
    constructor(workspaceRoot: string, deps: ManagerDeps)
    query(kind: 'definition' | 'references', q: SymbolQuery): Promise<LspAnswer>
    externalRoots(): ExternalRoot[]           // union for languages started so far (Task 3 externalRootsFor), refreshed on start
    dispose(): Promise<void>
  }
  ```
  `commandFor('go')` returns `null` when gopls is missing → `{ kind:'fallback', reason:'not-installed' }` (no spawn attempts). A dead client is replaced on the next query until `MAX_RESTARTS` replacements, then always `unavailable`. Queries in flight when `dispose()` runs resolve to `{ kind:'fallback', reason:'unavailable' }` and are not delivered to a newer session.
  - Preload: `findDefinitions(q: SymbolQuery)`, `findReferences(q: SymbolQuery)` (still invoke `symbol:definitions` / `symbol:references`); new `externalKind(absPath: string): Promise<ExternalKind | null>` → `file:externalKind`.
  - IPC: if `languageForPath(q.absPath)` is non-null, ask the manager; `answer` → `{ locations, truncated:false, source:'lsp' }`; `fallback` → run today's heuristic on `q.word` and return it with `source:'heuristic', approximate:{ language, reason }`. Other languages: heuristic with `source:'heuristic'` and no `approximate`. `file:read`: if `resolveWithinRoot` fails, try `resolveExternal(absPath, manager.externalRoots())`. `file:externalKind`: `null` for in-root, else the `resolveExternal` kind.

- [ ] **Step 1: Write failing tests** in `manager.test.ts` using `createClient` injection with a fake client object (no processes): `starts lazily on first query` (no client before `query`); `not-installed when commandFor returns null`; `timeout soon after start is 'starting'` (fake `startedAt = now`, definition rejects `LspTimeoutError`); `timeout after grace is 'unavailable'`; `empty answer is an answer` (`{kind:'answer', locations:[]}`); `restarts a dead client`; `stops restarting after MAX_RESTARTS` (4th death → every query `unavailable`, `createClient` called exactly `1 + MAX_RESTARTS` times); `dispose kills children and rejects pending queries` (pending query resolves to `unavailable`, every client's `dispose` called). In `ipc.test.ts`: `file:read serves a file under an external root and rejects one outside`, `symbol:definitions labels heuristic fallback` (manager stubbed to return `fallback/starting` → result has `source:'heuristic'`, `approximate.reason === 'starting'`).
- [ ] **Step 2: Run** `npx vitest run src/main/lsp/manager.test.ts src/main/ipc.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** manager and IPC wiring as specified.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(lsp): language-server manager wired into symbol IPC (#22)`

---

### Task 5: Renderer — position-aware providers and the "approximate" notice

**Files:**
- Modify: `src/renderer/src/monacoSetup.ts:102-118`
- Create: `src/renderer/src/navigation/symbolNotice.ts`, `src/renderer/src/navigation/symbolNotice.test.ts`
- Create: `src/renderer/src/components/StatusNotice.tsx`
- Modify: `src/renderer/src/App.tsx` (render `<StatusNotice />`), `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `SymbolQuery`, `SymbolLocationsResult.approximate` (Task 1); preload API (Task 4).
- Produces:
  ```ts
  export function noticeText(a: { language: LspLanguage; reason: ApproximateReason }): string   // exact Global Constraints copy
  export function installHint(a: { language: LspLanguage; reason: ApproximateReason }): string | null // 'go install golang.org/x/tools/gopls@latest' only for go/not-installed
  export function subscribeNotice(cb: (n: { text: string; hint: string | null } | null) => void): () => void
  export function reportResult(r: SymbolLocationsResult): void   // emits for approximate results; the hint is included at most once per app session
  ```
  Providers build `SymbolQuery` from `model.uri.fsPath`, `position.lineNumber`, `position.column - 1`, and the word; call `reportResult` on every result. `StatusNotice` shows the text bottom-right for 4 s (8 s when a hint is present, hint rendered as selectable monospace), non-blocking, `pointer-events` only on itself.

- [ ] **Step 1: Write failing tests** (node env) in `symbolNotice.test.ts`: `noticeText` returns each of the six exact strings from Global Constraints; `installHint` only for go/not-installed; `reportResult` emits nothing for `source:'lsp'`; emits the hint on the first go/not-installed result and `hint: null` on the second.
- [ ] **Step 2: Run** `npx vitest run src/renderer/src/navigation/symbolNotice.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `symbolNotice.ts`, `StatusNotice.tsx`, provider changes, styles.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(lsp): position-aware providers and approximate-result notice (#22)`

---

### Task 6: Renderer — marking files outside the folder, and end-to-end check

**Files:**
- Modify: `src/renderer/src/components/ContentPane.tsx` (toolbar ~`:314-330` and git-only controls)
- Modify: `src/renderer/src/App.tsx:160-171` (`resolveChangedFile`), `:194-208` (history loading)
- Modify: `src/renderer/src/styles.css`
- Create: `src/renderer/src/navigation/externalLabel.ts`, `src/renderer/src/navigation/externalLabel.test.ts`

**Interfaces:**
- Consumes: `window.viewmaster.externalKind` (Task 4), `ExternalKind` (Task 1).
- Produces: `externalLabel(kind: ExternalKind): string` → `'Go standard library' | 'Go module cache' | 'Python venv' | 'Python stubs'`. ContentPane fetches `externalKind(file.absPath)` when `file.absPath` is not under the repo root; when non-null, the toolbar gets class `toolbar external` (a distinct tint using a new `--external-tint` token) and a `<span className="toolbar-external-label">` with the label before the path; the Changed/diff/marks/history/side-by-side toggles are not rendered and the file opens in plain code view. App skips `historyList` for external files and `resolveChangedFile` sets `path` to the forward-slash absolute path for them.

- [ ] **Step 1: Write failing test** `externalLabel.test.ts` — each of the four exact labels.
- [ ] **Step 2: Run** it — Expected: FAIL. **Step 3:** implement label + ContentPane/App/CSS changes. **Step 4:** `npm test`, `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: End-to-end check in the app** with the `run-viewmaster` driver (on Windows: `node .claude/skills/run-viewmaster/driver.mjs`, no `xvfb-run`; `SCREENSHOT_DIR` = a scratch folder). `npm run build`. Use a temp Go module (from Task 3's smoke test layout, plus `fmt.Println` in `main.go`) and a two-file Python project. For each: open the folder, open `main.go` / `a.py` via `send-ipc menu:openFile`, place the cursor on the call with `eval` against the Monaco editor and trigger `editor.action.revealDefinition` → current file becomes `pkg/hello.go` / `b.py`. Trigger it on `Println` → toolbar shows `Go standard library`, tinted; screenshot. Trigger `editor.action.goToReferences` on `Hello` → peek lists the real call site(s) only. If gopls isn't installed on the machine, confirm the notice with the install command appears instead, and record that in the report.
- [ ] **Step 6: Commit** — `feat(lsp): mark and view files outside the opened folder (#22)`
