import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import ignore from 'ignore'
import { runGit } from '../git/run'
import type { ChangedFile } from '@shared/types'

/**
 * Full file listing for a non-git folder, filtered through a root-level
 * .gitignore if one exists. No nested-gitignore resolution — that requires
 * a real git repo (see listGitTree, added in the Browse-toggle task).
 * .git itself is always excluded, gitignore or not.
 */
export async function listFolderTree(root: string): Promise<string[]> {
  const ig = ignore()
  try {
    ig.add(await readFile(join(root, '.gitignore'), 'utf8'))
  } catch {
    // no .gitignore — nothing to filter beyond .git
  }

  const results: string[] = []

  async function walk(dir: string, relDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // Directory-only gitignore patterns (e.g. "node_modules/") only match
        // with a trailing slash on the tested path.
        if (ig.ignores(`${rel}/`)) continue
        await walk(join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        if (ig.ignores(rel)) continue
        results.push(rel)
      }
    }
  }

  await walk(root, '')
  results.sort((a, b) => a.localeCompare(b))
  return results
}

/** Wrap plain filesystem paths as ChangedFile entries with no git status. */
export function toUnchangedFiles(root: string, paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, absPath: join(root, path), status: 'unchanged' as const }))
}

/**
 * Full non-ignored file listing for a git repo: tracked files plus
 * untracked-but-not-ignored ones, exactly what `.gitignore` (nested
 * included, via git itself) would allow through.
 */
export async function listGitTree(root: string): Promise<string[]> {
  const res = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (res.code !== 0) throw new Error(`git ls-files failed: ${res.stderr.trim()}`)
  return res.stdout
    .split('\0')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Merge a full path listing with the changed-file set: changed paths keep
 * their real status, everything else is 'unchanged'.
 */
export function overlayStatus(root: string, allPaths: string[], changed: ChangedFile[]): ChangedFile[] {
  const changedByPath = new Map(changed.map((f) => [f.path, f]))
  return allPaths
    .map((path) => changedByPath.get(path) ?? { path, absPath: join(root, path), status: 'unchanged' as const })
    .sort((a, b) => a.path.localeCompare(b.path))
}
