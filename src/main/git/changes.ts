import { join } from 'path'
import type { BaselineKind, ChangedFile, FileStatus } from '@shared/types'
import { STATUS_PRIORITY } from '@shared/types'
import { runGit } from './run'
import { parseNameStatusZ, parsePorcelainV2 } from './parse'

/**
 * Changed-file set = union of branch commits (base..HEAD), staged, modified,
 * and untracked — with deleted files excluded entirely for 'merge-base' mode.
 * For 'custom' baselines, the git diff is a direct tip-to-tip comparison,
 * so "deletions" represent files that exist on the baseline ref but not
 * on HEAD, and are intentionally included (they represent real differences).
 * This also covers a file that's unchanged between the baseline and HEAD but
 * deleted (uncommitted) in the working tree: it's diffed against the working
 * tree directly and, if present at the baseline, included as 'committed' —
 * the same representation used for any other baseline deletion — so a
 * custom-baseline comparison never silently drops a deletion.
 * A file in several states gets the highest-priority one as primary and
 * the next as secondary.
 */
export async function collectChanges(
  root: string,
  baseline: BaselineKind
): Promise<ChangedFile[]> {
  const statusRes = await runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  if (statusRes.code !== 0) {
    throw new Error(`git status failed: ${statusRes.stderr.trim()}`)
  }

  const statuses = new Map<string, Set<FileStatus>>()
  const deleted = new Set<string>()
  const add = (path: string, status: FileStatus): void => {
    const set = statuses.get(path) ?? new Set<FileStatus>()
    set.add(status)
    statuses.set(path, set)
  }

  for (const entry of parsePorcelainV2(statusRes.stdout)) {
    if (entry.deleted) {
      deleted.add(entry.path)
      continue
    }
    if (entry.untracked) add(entry.path, 'untracked')
    if (entry.staged) add(entry.path, 'staged')
    if (entry.modified) add(entry.path, 'modified')
  }

  // Paths that are deleted in the working tree but still surface as a change
  // because they differ from a custom baseline ref (present there); see the
  // custom-baseline branch below.
  const deletedButDiffersFromBaseline = new Set<string>()

  if (baseline.kind === 'merge-base' || baseline.kind === 'custom') {
    const compareRef = baseline.kind === 'merge-base' ? baseline.base : baseline.ref
    // A user-typed custom ref reaches this call unvalidated -- one starting
    // with '-' would otherwise be parsed as a git option instead of a
    // revision. Reject it here rather than letting git guess.
    if (compareRef.startsWith('-')) {
      throw new Error(`invalid ref: ${compareRef}`)
    }
    // The working-tree-deletion diff below (when needed) depends only on
    // `compareRef` and `deleted`, both already known at this point -- not on
    // `diffRes` -- so the two independent `git diff` calls run concurrently
    // rather than paying their latency twice, back to back.
    const needsWorkingTreeDiff = baseline.kind === 'custom' && deleted.size > 0
    const [diffRes, wtDiffRes] = await Promise.all([
      runGit(root, ['diff', '--name-status', '-z', compareRef, 'HEAD']),
      needsWorkingTreeDiff
        ? runGit(root, ['diff', '--name-status', '-z', '--diff-filter=D', compareRef])
        : Promise.resolve(null)
    ])
    if (diffRes.code !== 0) {
      throw new Error(`git diff failed: ${diffRes.stderr.trim()}`)
    }
    const includeDeletions = baseline.kind === 'custom'
    for (const file of parseNameStatusZ(diffRes.stdout, includeDeletions)) {
      add(file.path, 'committed')
    }

    if (needsWorkingTreeDiff) {
      // The diff above only catches deletions already committed on HEAD. A
      // file that's unchanged between the baseline and HEAD but deleted
      // (uncommitted) in the working tree never shows up there -- diff the
      // baseline against the working tree directly (omit HEAD) to find those
      // too, and keep only the ones git status already flagged as deleted.
      if (!wtDiffRes || wtDiffRes.code !== 0) {
        throw new Error(`git diff failed: ${wtDiffRes?.stderr.trim() ?? 'unknown error'}`)
      }
      for (const file of parseNameStatusZ(wtDiffRes.stdout, true)) {
        if (deleted.has(file.path)) {
          add(file.path, 'committed')
          deletedButDiffersFromBaseline.add(file.path)
        }
      }
    }
  }

  const files: ChangedFile[] = []
  for (const [path, set] of statuses) {
    if (deleted.has(path) && !deletedButDiffersFromBaseline.has(path)) continue
    const present = STATUS_PRIORITY.filter((s) => set.has(s))
    if (present.length === 0) continue
    const file: ChangedFile = { path, absPath: join(root, path), status: present[0] }
    if (present.length > 1) file.secondary = present[1]
    files.push(file)
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}
