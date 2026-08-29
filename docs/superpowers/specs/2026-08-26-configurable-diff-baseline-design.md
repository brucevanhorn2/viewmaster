# Configurable Diff Baseline Design

## Problem

Viewmaster's "changed files" baseline is always auto-detected: `resolveBaseline()`
computes `merge-base(HEAD, <default-branch>)` (default branch = `origin/HEAD` →
local `main`/`master` → `init.defaultBranch`), and every path that recomputes
repo state (`openRepo`, the file-watcher's debounced recompute, `mode:set`,
`repo:refresh`) always calls it fresh — there is no override point anywhere.
Issue [#13](https://github.com/brucevanhorn2/viewmaster/issues/13) asks for
comparing against an arbitrary branch or ref instead.

## Scope

Add a session-only (not persisted) custom baseline: the user can type any
branch, tag, or commit SHA into a small input (with autocomplete suggestions
from local + remote-tracking branches and tags), and the "changed files" list
and every diff view switch to comparing directly against that ref's tip
instead of the auto-detected merge-base — until cleared, or the folder is
closed/reopened.

Out of scope: persisting the custom ref across restarts; validating the typed
ref before accepting it (a bad ref surfaces via the existing error-state path
once a diff against it actually fails); anything about `working-only` mode's
own behavior (unaffected — a custom ref is a third, independent `BaselineKind`
variant, not a change to the other two).

## Design

### Semantics

A custom baseline means a **direct diff against the ref's tip** — `git diff
<ref> HEAD` — not a merge-base computation. This matches comparing against a
release tag or a sibling branch that isn't an ancestor of HEAD, which is the
more useful interpretation of "compare against an arbitrary ref" (confirmed
with Bruce).

### Type

`shared/types.ts`'s `BaselineKind` gains a third variant:

```ts
export type BaselineKind =
  | { kind: 'merge-base'; base: string; defaultBranch: string; branch: string }
  | { kind: 'custom'; ref: string }
  | {
      kind: 'working-only'
      reason: 'detached' | 'on-default' | 'no-commits' | 'no-baseline'
      branch?: string
    }
```

### Session state and the override point

`src/main/ipc.ts`'s module-level `session` object (currently holding `root`,
`baseline`, `mode`, `watcher`, `recorder`, `searchPaths`, `searchGeneration`)
gains one more field: `customBaselineRef: string | null`. `computeRepoState`
(the single function every recompute path already funnels through) checks
this first: if `session?.customBaselineRef` is set, use
`{ kind: 'custom', ref: session.customBaselineRef }` directly instead of
calling `resolveBaseline()`. This means the override survives a `mode:set`
toggle and the watcher's debounced recompute (both call `computeRepoState`
without re-resolving from scratch), but is naturally cleared whenever a new
folder is opened (`openRepo` creates a fresh `session` object) — matching the
"session-only, not persisted" decision.

### New IPC handlers

- `baseline:setCustom(ref: string | null)` — `null` clears the override
  (reverting to auto-detected on the next recompute); otherwise sets
  `session.customBaselineRef` and immediately triggers a `computeRepoState`
  the same way `mode:set` does today, returning the fresh `RepoState`.
- `git:listRefs()` — returns local + remote-tracking branch names (via
  `git branch -a --format='%(refname:short)'`, filtering out the
  `origin/HEAD` symbolic pseudo-ref line) plus tag names (`git tag`),
  combined into one string array for the autocomplete suggestion list. No
  validation against this list is enforced — it's suggestions only.

### `collectChanges` and `readBaseFile`

`src/main/git/changes.ts`'s `collectChanges` currently special-cases only
`baseline.kind === 'merge-base'` for the `git diff --name-status` call. Add
`'custom'` to that same branch, just choosing which ref string to diff
against:

```ts
if (baseline.kind === 'merge-base' || baseline.kind === 'custom') {
  const compareRef = baseline.kind === 'merge-base' ? baseline.base : baseline.ref
  const diffRes = await runGit(root, ['diff', '--name-status', '-z', compareRef, 'HEAD'])
  ...
}
```

`src/main/ipc.ts`'s `file:readBase` handler currently does
`const base = baseline.kind === 'merge-base' ? baseline.base : 'HEAD'`. Extend
to a two-way check: `baseline.kind === 'merge-base' ? baseline.base :
baseline.kind === 'custom' ? baseline.ref : 'HEAD'`.

### Renderer UI

`Sidebar.tsx`'s existing header label (`baselineLabel(state)`, currently
rendering e.g. `"myBranch vs main"` or a working-tree-only reason string)
becomes clickable when `state.kind === 'repo'`. Clicking it opens a small
inline text input (replacing the label in place, not a modal) pre-filled
with the current custom ref if one is set, empty otherwise. Typing populates
an autocomplete dropdown (fetched once via `git:listRefs()` when the input
opens, filtered client-side as the user types — no need to re-fetch per
keystroke). Enter or clicking a suggestion commits the typed/selected text
via `baseline:setCustom(ref)`; Escape cancels without change. A small "×" or
"Reset" affordance next to the label (visible only when a custom baseline is
active) calls `baseline:setCustom(null)`.

`baselineLabel()` needs one more branch for the `'custom'` kind, e.g.
`` `${b.branch ?? state.root} vs ${b.ref}` `` — actually simpler: since a
custom baseline doesn't carry the current branch name the way `merge-base`
does, label it as `` `Custom: ${b.ref}` ``.

### Error handling

No upfront ref validation. If the typed ref doesn't exist, `git diff <ref>
HEAD` fails (nonzero exit), which `collectChanges` already throws on — this
bubbles through `computeRepoState`'s existing try/catch into
`{ kind: 'error', root, message }`, which `Sidebar.tsx` already renders (a
"Couldn't open folder" heading with the git error text as detail). The
heading wording is a little imprecise for this case but functional and
informative; a follow-up polish item, not blocking.

## Testing

`collectChanges`'s new `'custom'` branch and `baselineLabel`'s new case are
both plain-function-level testable, matching this repo's existing test
conventions (`changes.test.ts` already exists). The new `baseline:setCustom`/
`git:listRefs` IPC handlers follow this repo's existing convention of no
dedicated `ipc.test.ts` (none exists for any handler today). No test file for
the `Sidebar.tsx` UI addition — zero `.tsx` component tests exist anywhere in
this repo, and this plan follows that convention rather than introducing one.
Manual verification: set a custom baseline to a tag/branch that isn't an
ancestor of HEAD and confirm the changed-files list and file diffs reflect a
direct comparison against it; clear it and confirm the view reverts to the
auto-detected merge-base; close and reopen the folder and confirm the custom
ref does NOT persist (reverts to auto-detected, per the confirmed decision).

## Decisions confirmed with Bruce (2026-08-26)

1. Custom baseline means a direct diff against the ref's tip, not a
   merge-base computation against it.
2. Ref picker: free-text input with autocomplete suggestions (branches +
   tags), but accepts anything typed, including a SHA not in the suggestion
   list — no validation blocking submission.
3. The custom baseline does not persist across app restarts — it resets to
   auto-detected the next time the folder is opened.
