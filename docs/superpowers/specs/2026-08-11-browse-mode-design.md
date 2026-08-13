# View Master — Browse Mode (Design Spec)

**Date:** 2026-08-11
**Status:** Approved
**Extends:** `2026-07-08-viewmaster-design.md` (MVP). Adds a full-folder file
browser alongside the existing git-changed-files view.

## Purpose

Today the sidebar only ever shows files that differ from a git baseline
(`collectChanges`); a folder with no pending changes — or no git repo at all —
shows nothing (`Not a git repository`) or an empty tree. That makes View Master
unusable for reading a mostly-static collection of documents, such as an
Obsidian vault, where there's nothing "changed" to show.

Browse Mode adds a full folder tree, filtered through `.gitignore`, as an
alternate view. It's the foundation two other planned features (search,
markdown link navigation) will build on: both need a way to open a file that
isn't in the git-changed set.

## Load-bearing decisions (settled during brainstorming)

1. **Scope:** the browse tree shows everything under the opened root except
   what `.gitignore` excludes. No hidden-dotfile special-casing beyond that —
   a folder with no `.gitignore` shows dotfiles too.
2. **Toggle:** git repos get a **Changed / Browse** toggle in the sidebar
   header. Non-git folders have no "changed" concept to toggle from, so they
   always browse — no toggle shown.
3. **Persistence:** the last-used mode is remembered **per folder root**, so
   reopening a repo restores whichever mode you left it in.
4. **Status overlay:** files that are git-changed keep their status badge
   even while browsing everything — Browse Mode is additive, not a separate
   file set.
5. **`.gitignore` fidelity:** git repos get fully correct, git-native
   `.gitignore` resolution (nested files, `core.excludesFile`, etc.) via
   `git ls-files`. Non-git folders only honor a **root-level `.gitignore`**,
   if present — no nested-gitignore resolution, since there's no git to ask.

## Data model

`src/shared/types.ts`:

```ts
export type FileStatus = 'untracked' | 'modified' | 'staged' | 'committed' | 'unchanged'

export type SidebarMode = 'changed' | 'browse'

export type RepoState =
  | { kind: 'repo'; root: string; baseline: BaselineKind; mode: SidebarMode; files: ChangedFile[] }
  | { kind: 'folder'; root: string; files: ChangedFile[] }
  | { kind: 'error'; root: string; message: string }
```

- `'unchanged'` renders with no status letter and a neutral (non-colored)
  badge — `FileRow` needs no structural change, just a new case in
  `STATUS_LETTER` (empty string) and the CSS status-color map.
- `'not-git'` is removed: a non-git folder is now `{ kind: 'folder' }`, always
  populated with the full (gitignore-filtered) file list. This replaces the
  dead-end "Not a git repository" message.
- `RepoState.kind === 'repo'` gains `mode`; `files` always reflects whichever
  mode is currently active, computed on open and on every watcher-triggered
  recompute.

## Main process — file listing

New module `src/main/files/browse.ts`:

- `listGitTree(root: string): Promise<string[]>` — runs
  `git ls-files --cached --others --exclude-standard -z` (reuses `runGit`,
  parsed the same way as the existing `-z`-delimited git output elsewhere in
  the codebase) and returns repo-relative paths.
- `listFolderTree(root: string): Promise<string[]>` — recursive `fs.readdir`
  walk from `root`. If `<root>/.gitignore` exists, its rules are loaded via
  the `ignore` package (new dependency) and applied to every visited path;
  `.git` itself is always excluded even without a `.gitignore` entry, matching
  `shouldIgnore`'s existing treatment in `watcher.ts`.

`computeRepoState` (in `ipc.ts`) changes shape: it takes an explicit `mode`,
resolves a `'folder'` state as before when the root isn't a git repo, and
otherwise calls either `collectChanges` (mode `'changed'`, unchanged from
today) or `listGitTree` + `overlayStatus` (mode `'browse'`) to build `files`.
The existing toplevel-resolution and error-message logic in the current
function is unchanged; only the mode branch and the `'folder'`-kind fallback
(replacing today's `'not-git'` fallback) are new. `overlayStatus(root,
allPaths, changed)` walks `allPaths`, taking the matching entry from `changed`
when one exists (keeping its real status/secondary) and defaulting to
`{ path, absPath, status: 'unchanged' }` otherwise.

`mode` is read from the persisted per-folder store on `openRepo`, and passed
through explicitly on every subsequent recompute (watcher events, manual
toggle) so a background refresh never silently reverts the user's choice.

## Renderer & UI

- Sidebar header: when `state.kind === 'repo'`, a small segmented control
  (`Changed | Browse`) next to the existing baseline label. Clicking it calls
  a new `window.viewmaster.setMode(root, mode)` IPC, which persists the choice
  and triggers a recompute (mirroring how `openRepo` already resolves
  `RepoState`).
- `state.kind === 'folder'`: renders the tree directly (same `Children`
  component), no toggle, no baseline label — a simple root path in the
  header instead.
- `buildTree`, `FileRow`, `DirNode`, `Children` are unchanged. `buildTree`'s
  doc comment ("collapsed to just the directories that contain changes") gets
  a one-line update since it now also serves the full-tree case.
- Empty-state message becomes mode-aware: "No changes in this branch" stays
  for empty Changed mode; Browse/folder modes with zero files (e.g. an
  entirely gitignored folder) get "No files to show".

## Persistence

`src/main/store.ts` schema gains:

```ts
folderModes: Record<string, SidebarMode>
```

Read in `openRepo` (default `'changed'` for a root never seen before),
written on every `setMode` call. Keyed by the resolved repo root (same string
`addRecentFolder` already uses), so it survives folder moves the same way
recents do (i.e., not robustly — matches existing behavior).

## Watcher

No changes to `watcher.ts` itself. The existing debounced recompute path in
`ipc.ts` already re-runs `computeRepoState` on every relevant filesystem
event; it just needs the current session's `mode` threaded through, and (for
non-git folders) needs to run even though today's early return only fires for
`kind === 'repo'` — the watcher already watches any opened root regardless of
git-ness, so this is a small extension of the existing recompute call, not new
watching logic.

## Error handling & edge cases

- **Folder with a huge tree:** no pagination/virtualization in v1 — matches
  the existing sidebar's approach to large changed-file sets. If this proves
  slow in practice for large vaults, virtualized rendering is a follow-up, not
  part of this spec.
- **Binary/large files in Browse mode:** unchanged — `ContentPane` already
  handles `binary` / `too-large` / `missing` `FileContent` kinds regardless of
  where the path came from.
- **`.gitignore` parse errors (non-git folder):** the `ignore` package is
  lenient about malformed patterns; a completely unreadable `.gitignore` (fs
  error) is treated as "no `.gitignore`" rather than failing the whole listing.
- **Toggle spam:** `setMode` recomputes synchronously per click; no debounce
  needed since it's a deliberate user action, not a filesystem event storm.

## Module layout

```
src/main/files/browse.ts        listGitTree, listFolderTree, overlayStatus
src/main/ipc.ts                 computeRepoState takes mode; + mode:set handler
src/main/store.ts                + folderModes
src/shared/types.ts              FileStatus + 'unchanged'; RepoState 'folder' kind; SidebarMode
src/renderer/src/components/Sidebar.tsx   mode toggle; 'folder' kind rendering
src/renderer/src/App.tsx         thread mode through openRepo/setMode
```

## Testing

- `browse.test.ts`: `overlayStatus` merges changed statuses onto a full path
  list correctly (pure function, no fs). `listFolderTree` against a temp dir
  fixture: respects root `.gitignore`, always excludes `.git`, handles a
  missing `.gitignore` (shows everything).
- `ipc`-level: `computeRepoState` returns `'folder'` for a non-git temp dir,
  `'repo'` with the right `mode`/`files` for a git fixture in both modes
  (reuse the existing `git/testRepo.ts` fixture helper).
- Sidebar: `'unchanged'` status renders no badge letter; toggle click order
  (Changed → Browse → Changed) doesn't lose the changed-file badges.

## Non-goals (v1)

- Virtualized/paginated rendering for very large trees.
- Nested `.gitignore` resolution for non-git folders.
- Image/media preview in Browse mode (binary files still show the existing
  "Binary file — Not displayed" placeholder).
- Any change to how history (local edit history) or diffing behave — both
  already operate on `file.path`/`file.absPath` regardless of how the file
  was selected.
