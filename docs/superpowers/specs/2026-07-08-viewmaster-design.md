# viewmaster — Design Spec

**Date:** 2026-07-08
**Status:** Approved (MVP)

## Purpose

A read-only desktop viewer for markdown documents and branch diffs, meant to
replace the ad-hoc use of WebStorm for these two tasks. Two functions:

1. **Markdown viewing** — render markdown beautifully (no raw source), including
   embedded mermaid diagrams, with hyperlinks that open in the default browser.
2. **Branch diff viewing** — a left sidebar showing only files changed within the
   current branch (committed, staged, modified, or untracked), and a content pane
   that renders the selected file with an optional diff view against the branch's
   baseline.

The app is view-only. It never edits files.

## Stack

- **Runtime:** Electron + TypeScript.
- **UI:** React + TypeScript.
  - `allotment` for the resizable split view (VS Code's own split-view component).
  - `monaco-editor` for read-only code viewing and diff viewing (real VS Code
    syntax highlighting, line numbers, side-by-side / inline diff).
  - `markdown-it` + `mermaid` + `shiki` (code-fence highlighting) for rendered
    markdown; `DOMPurify` to sanitize rendered HTML.
  - `material-icon-theme` icon set for file-type icons.
- **Dev toolchain:** `electron-vite` (main / preload / renderer with HMR).
- **Packaging:** `electron-builder`.
- **Git:** the system `git` CLI, spawned from the main process (no native git
  bindings).
- **Persistence:** `electron-store` for recent folders and window state.
- **Testing:** `vitest`.

Theme: **dark mode only**, VS Code dark aesthetic throughout.

## Architecture

Three Electron surfaces:

### Main process (Node)
Owns the filesystem and git. Responsibilities:
- Folder picker dialog; persist and reopen recent folders.
- All git operations (see Git Model), by spawning the `git` CLI.
- Watch the repo (`chokidar`, including `.git`) and emit debounced change events.
- Open external links via `shell.openExternal`.
- Write absolute paths to the clipboard.
- Expose all of the above through typed IPC handlers.

### Preload bridge
- `contextIsolation: true`, `nodeIntegration: false`.
- Exposes a small typed API on `window.viewmaster.*`. This is the only channel
  between the renderer and Node. The renderer has no direct filesystem or git
  access.

### Renderer (React + TS)
- Layout: horizontal `allotment` split — resizable left sidebar + content pane.
- Calls only the preload API; renders results.

## Git Model (the distinctive part)

**Baseline** = `git merge-base HEAD <defaultBranch>` — the branch's fork point.

- **Default-branch detection:** try `origin/HEAD` (`git symbolic-ref
  refs/remotes/origin/HEAD`) → fall back to local `main` / `master` → fall back
  to `init.defaultBranch`.
- **Edge cases** degrade gracefully:
  - Detached HEAD, currently on the default branch, or unresolvable baseline →
    show only working-tree changes (staged / modified / untracked).
  - Brand-new repo with no commits → show only working-tree changes.
  - Not a git repository → clear message in the sidebar, no crash.

**Changed-file set** = the union of:
1. **Committed in this branch** — `git diff --name-status <base> HEAD`
2. **Staged** — from `git status --porcelain=v2 -z`
3. **Modified (unstaged)** — from the same porcelain output
4. **Untracked** — from the same porcelain output (`--exclude-standard` honored)

**Deleted files are excluded from the list entirely** — they are not shown.

**Per-file status:** a file may be in more than one state (e.g. committed earlier
in the branch and since modified). The sidebar displays one primary status plus,
where useful, a secondary marker. Status categories, each with a distinct
VS-Code-like color:
- `untracked` — new file, not tracked by git
- `modified` — unstaged working-tree change
- `staged` — change in the index, not yet committed
- `committed` — changed in a branch commit, clean in the worktree

**Primary-status priority** (highest wins, so the most "live" state surfaces):
`untracked` > `modified` > `staged` > `committed`. When a lower-priority state
also applies (e.g. a `committed` file that is now `modified`), the lower state may
be shown as a secondary marker.

**Diff content for a file:**
- Old side = `git show <base>:<path>`.
- New side = the file as it currently exists on disk.
- Untracked / newly-added files → old side empty (renders as all-added).

## Components & Data Flow

### Left sidebar
- A file tree built from the changed-file set, **collapsed to only the
  directories that contain changed files** (branch-changes-only view).
- `material-icon-theme` file-type icons.
- Status coloring per the categories above.
- Resizable (drag the divider left/right).
- **Right-click → Copy absolute path** (writes the file's absolute path to the
  clipboard for pasting into AI chats).

### Content pane (routes by file type)
- **Markdown files:**
  - Default: rendered markdown (`markdown-it`), mermaid diagrams rendered,
    code fences syntax-highlighted (`shiki`), HTML sanitized (`DOMPurify`).
  - Hyperlinks open in the default browser (`shell.openExternal`); no in-app
    navigation.
  - **Diff toggle** → Monaco source diff (markdown syntax) vs the baseline.
- **Code / other text files:**
  - Monaco read-only editor: syntax highlighting + line numbers.
  - **Diff toggle** → Monaco `DiffEditor` vs the baseline.
- **Diff layout:** side-by-side by default, toggle to inline/unified.
- **Binary or too-large files:** a placeholder ("binary / too large to display")
  instead of loading into Monaco.

### Refresh
- **Auto-refresh:** the file/git watcher emits a debounced event; the sidebar
  change list and the currently open file update in place. Designed for running
  alongside an AI agent that is writing planning documents.

## Error Handling

Each of these degrades to a clear message rather than crashing:
- Not a git repository.
- No resolvable baseline (detached HEAD, on default branch, empty repo).
- Binary or oversized files (placeholder instead of Monaco).
- Git command failures (surface the error, keep the app usable).

## Testing

- **Git layer (primary coverage):** Vitest unit tests against temporary throwaway
  git repositories. Fixtures stage/commit/modify/leave-untracked files and assert:
  porcelain-v2 parsing, status merging across states, baseline (merge-base)
  detection including edge cases, and change-tree construction.
- **UI:** light smoke tests.
- **Electron shell:** verified manually.

## Packaging & Distribution

- `electron-builder` targets:
  - **macOS `.dmg`** (primary).
  - **Linux AppImage** (secondary).
  - **Windows NSIS `.exe`** (tertiary, for completeness).
- **Unsigned** for now (no signing keys). The README documents the one-time macOS
  Gatekeeper "right-click → Open" step so the DMG runs on the build machine.
  Code signing / notarization is a later concern.

## Project Housekeeping

- `.gitignore` — Node / Electron / build artifacts.
- `README.md` — overview, dev/build instructions, unsigned-DMG note, and a
  **Roadmap** section (below).

## Roadmap (post-MVP)

- **Rendered word-by-word diff ("editor's marks"):** instead of a source diff,
  render the markdown with added/removed text marked inline in the rendered
  output — like an editor's proofreading marks. The dream feature; deferred
  because it requires mapping a word-level diff onto rendered HTML.
- **Side-by-side rendered old vs new** markdown as an intermediate diff mode.
- **Code signing + notarization** for distributable, Gatekeeper-clean DMGs.
- **Search / filter** within the changed-file list.
- **Configurable baseline** (compare against an arbitrary branch or ref).

## Out of Scope (MVP)

- Editing files of any kind.
- Committing, staging, or any git write operations.
- Showing deleted files in the change list.
- Rendered (non-source) markdown diffs.
- Signed/notarized builds.
