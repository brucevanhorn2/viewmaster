# Real Go & Python navigation via language servers — design

Issue: [#22 Real Python/Go semantic support (LSP integration) for find usages / go to definition](https://github.com/brucevanhorn2/viewmaster/issues/22)

Builds on: `docs/superpowers/specs/2026-08-19-find-usages-design.md` (issue #7).

## Intent

The user has started a new job whose product is written in **Go and Python**
and uses View Master to **learn an unfamiliar codebase** the way they would
in a JetBrains IDE (GoLand/PyCharm). The concrete case: `mux`, a Go
microservice that bridges to Keycloak (open-source IAM).

Their workflow: find an entry point and read. When they hit a key function,
**F12** to jump to its definition. Or pick a function and **Shift+F12** to see
everywhere it's used, tracing behavior backwards or forwards through the code.

Issue #7 already gives them that exact keyboard flow (F12, Shift+F12, Monaco's
peek widget, back/forward across cross-file jumps). For TS/JS the answers are
real (Monaco's bundled TS service). For Go and Python they are a **text-pattern
heuristic** — it can't tell same-named symbols in different packages apart,
doesn't understand imports/aliases or method receivers, and produces false
positives. This work makes Go and Python answers **real**, using actual
language servers.

Success: in `mux`, F12 on a call to a function/method in another package
lands on the right definition, and Shift+F12 lists the real call sites —
GoLand-quality for these two operations.

## Goals

- **Go to definition** (F12) and **find usages** (Shift+F12) backed by a real
  language server for:
  - **Go** — first priority (the user's immediate codebase).
  - **Python**.
- One generic LSP-client layer in the main process that both languages use,
  so adding a language later is configuration, not new architecture.
- The existing UI is unchanged: same keybindings, same peek widget, same
  back/forward behavior, same cross-file navigation (`registerEditorOpener`).

## Decided

### Where the language servers come from

- **Go: the user's installed `gopls`**, found on `PATH` (and, as a fallback,
  `$(go env GOPATH)/bin/gopls`). The user confirmed Go is installed and
  working on their machine. View Master does **not** bundle gopls.
- **Python: `pyright` bundled with View Master** _(our call — pyright is a
  JavaScript package, so it can ship inside the app and run on Electron's
  Node; the user has nothing to install)_. It uses the user's installed
  Python, and the project's virtualenv when one is detectable (e.g. `.venv/`,
  `venv/` at the workspace root), so third-party imports resolve.
  _Our guess, uncorrected by the user._

### When a server is missing or not ready

_(Our guesses; the user did not object.)_

- **gopls not found:** fall back to today's heuristic results for Go, and
  show a **one-time, non-blocking notice** per app session with the install
  command: `go install golang.org/x/tools/gopls@latest`.
- **Server still starting / indexing** a large repo, or a request **times
  out**, or the server **crashes**: return heuristic results for that request
  instead of nothing. A crashed server is restarted on the next request
  (bounded — don't loop forever on a server that crashes on start).
- **Server answers with an empty result:** that **is** the answer — do not
  fall back to the heuristic. (User: "let's try it out"; if it proves
  unhelpful in practice they'll file a follow-up issue.)
- Real results, when available, **replace** heuristic results — never merge
  the two (same reasoning as #7's decision 8 for TS).
- **Heuristic results are labeled.** Whenever a Go/Python request is answered
  by the heuristic fallback, the user sees a small, non-blocking indication
  such as _"approximate — Go index still loading"_ (or _"approximate — gopls
  not installed"_), so they don't trust a guess while learning a codebase.
  This means `SymbolLocationsResult` gains a field saying which path produced
  it (e.g. `source: 'lsp' | 'heuristic'` plus a reason).

### Jumping outside the opened folder

In `mux`, F12 on a call into the Keycloak client library, the Go standard
library, or a Python package lands in files **outside the opened folder**:
the Go module cache, GOROOT, the project's virtualenv `site-packages`, or
pyright's bundled typeshed stubs. Today `file:read` rejects any path outside
the root and shows "missing".

- **Decided: these files can be viewed** (View Master is a viewer; nothing is
  ever editable). The allowance is **scoped to the locations the language
  servers legitimately point at** — GOROOT and GOMODCACHE (from `go env`), the
  detected virtualenv, and pyright's bundled stubs directory — not arbitrary
  paths. The existing containment check stays for everything else, with tests
  for both sides.
- **Decided: an outside file is visibly marked**, like JetBrains colors the
  tab of a non-project file. View Master has no tabs, so the content-pane
  **toolbar is tinted** and shows a label naming where the file lives (e.g.
  _Go module cache_, _Go standard library_, _Python venv_, _Python stubs_)
  next to the path.
- Outside files are a destination for navigation only: F12/Shift+F12 work
  from inside them (the language server knows them), back/forward works, but
  they don't appear in the sidebar tree and git-based features (Changed,
  diff, history, marks) don't apply to them — _builder decides how those
  controls are hidden/disabled._

### Lifecycle

_(Our guesses; the user did not object.)_

- A language server starts **lazily**, the first time a definition/usages
  request is made for that language in the open folder (not at folder open).
- Workspace root = the folder the user opened in View Master.
- **gopls inherits the user's normal environment** (GOPROXY, GOPRIVATE,
  GOFLAGS, credentials), so it loads the module the same way `go build` does,
  including downloading dependencies into the module cache if needed. _Our
  call._ A gopls load failure is treated like "not ready": heuristic results,
  labeled.
- Servers shut down when the folder is closed / another folder is opened, and
  on app quit. No orphaned child processes.

### Scope of what's navigable

- Works in the plain code view of the **current on-disk files** (Browse /
  view mode) — the same place #7's providers work today. Wherever #7's
  providers already fire (e.g. a diff editor's modified side, if they do),
  leave that as is — no extra gating either way. _Our call._
- View Master is read-only; files are fed to the server from disk.

## Non-goals

- **Go to Implementation**, type hierarchy, call hierarchy — the user said
  definition and usages are the main thing. (If the LSP layer makes these
  trivial later, that's a follow-up issue, not this one.)
- Hover docs, completion, diagnostics/squiggles, rename, formatting.
- **Java, C#**, or any other language — not needed unless a customer
  engagement calls for it; none currently do.
- Bundling or auto-installing gopls / a Go toolchain.
- Semantic navigation inside historical revisions / diff views.
- Changing TypeScript/JavaScript behavior.

## Anti-goals (failure even if it "works")

- The app hangs, or F12 does nothing, because a language server is slow,
  missing, or crashed. There must always be an answer (real or heuristic)
  in reasonable time.
- Language-server processes left running after the folder or app closes.
- Real and heuristic results mixed together in one list.
- The user has to configure anything to get Go working when `gopls` is
  already installed, or anything at all for Python.
- Opening a big repo becomes slow because servers start eagerly.

## Constraints

- Electron app: main process (`src/main`), preload (`src/preload`), renderer
  (`src/renderer/src`), shared types (`src/shared/types.ts`). Tests: vitest
  (`npm test`); `npm run typecheck`. Follow existing patterns.
- **The current IPC API is word-only**: `findDefinitions(word)` /
  `findReferences(word)` → `SymbolLocationsResult`. LSP needs **file +
  position**, so the renderer→main request must carry the file's `absPath`
  and the cursor position. The result type (`SymbolLocationsResult` /
  `SymbolLocation`: repo-relative `path`, `absPath`, 1-based `line`, 0-based
  `column`) should be reused so the Monaco provider glue in
  `src/renderer/src/monacoSetup.ts` stays thin.
- The heuristic path (`src/main/search/definitionHeuristics.ts`, `scan.ts`)
  stays as the fallback and for all other languages.
- Packaging: `electron-builder.yml`; targets Windows (nsis), macOS (dmg),
  Linux (AppImage/deb). The bundled pyright must run from a packaged build on
  all three (e.g. not trapped inside asar if it needs real files). The user's
  daily machine is **Windows** — `gopls` resolution and process spawning must
  work there (`gopls.exe`, PATH semantics).
- Keep the security posture: spawn only the known server binaries, no shell
  interpolation of paths. The outside-root read allowance must be an explicit
  allow-list of directories computed in the main process, never a path the
  renderer supplies.

## Left to the builder

- Hand-rolled JSON-RPC/LSP framing vs. a small library such as
  `vscode-jsonrpc` / `vscode-languageserver-protocol` (a dependency is
  acceptable for this one).
- How the notice for missing gopls is displayed (status line, toast, etc.),
  matching existing UI patterns.
- Timeout values, restart limits, and how "server still indexing" is
  detected.
- Virtualenv detection details for pyright.
- How Go multi-module repos / `go.work` are handled (gopls handles most of
  this itself).
