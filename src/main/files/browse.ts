import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import ignore from 'ignore'
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
