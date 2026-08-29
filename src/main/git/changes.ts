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

  if (baseline.kind === 'merge-base' || baseline.kind === 'custom') {
    const compareRef = baseline.kind === 'merge-base' ? baseline.base : baseline.ref
    // A user-typed custom ref reaches this call unvalidated -- one starting
    // with '-' would otherwise be parsed as a git option instead of a
    // revision. Reject it here rather than letting git guess.
    if (compareRef.startsWith('-')) {
      throw new Error(`invalid ref: ${compareRef}`)
    }
    const diffRes = await runGit(root, ['diff', '--name-status', '-z', compareRef, 'HEAD'])
    if (diffRes.code !== 0) {
      throw new Error(`git diff failed: ${diffRes.stderr.trim()}`)
    }
    const includeDeletions = baseline.kind === 'custom'
    for (const file of parseNameStatusZ(diffRes.stdout, includeDeletions)) {
      add(file.path, 'committed')
    }
  }

  const files: ChangedFile[] = []
  for (const [path, set] of statuses) {
    if (deleted.has(path)) continue
    const present = STATUS_PRIORITY.filter((s) => set.has(s))
    if (present.length === 0) continue
    const file: ChangedFile = { path, absPath: join(root, path), status: present[0] }
    if (present.length > 1) file.secondary = present[1]
    files.push(file)
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}
