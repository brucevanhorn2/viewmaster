import { readFile, readdir } from 'fs/promises'
import type { Dirent } from 'fs'
import { join } from 'path'
import ignore from 'ignore'
import { runGit } from '../git/run'
import { collectChanges } from '../git/changes'
import type { BaselineKind, ChangedFile } from '@shared/types'

/**
 * Full file listing for a non-git folder, filtered through a root-level
 * .gitignore if one exists. No nested-gitignore resolution — that requires
 * a real git repo (see listGitTree below).
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
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      // The root itself failing to read (missing, no permission) is a real
      // error the caller should see. A *nested* directory failing — e.g.
      // permission-denied, or deleted between the parent's readdir and this
      // recursive descent — is skipped instead of failing the whole listing.
      if (relDir === '') throw err
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // Directory-only gitignore patterns (e.g. "node_modules/") only match
        // with a trailing slash on the tested path.
        if (ig.ignores(`${rel}/`)) continue
        await walk(join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        // Symlinks are intentionally skipped here (isFile() is false for
        // them) — unlike git ls-files, which does list them for git repos.
        // Don't "fix" this by following symlinks: it reintroduces loop risk
        // that this walk currently has none of.
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
 * their real status, everything else is 'unchanged'. A changed path absent
 * from `allPaths` -- e.g. one deleted relative to a custom baseline
 * (issue #13), which never appears in a current-HEAD listing -- is appended
 * rather than dropped, since it's still a real, meaningful diff entry.
 */
export function overlayStatus(root: string, allPaths: string[], changed: ChangedFile[]): ChangedFile[] {
  const changedByPath = new Map(changed.map((f) => [f.path, f]))
  const allPathsSet = new Set(allPaths)
  const overlaid = allPaths.map(
    (path) => changedByPath.get(path) ?? { path, absPath: join(root, path), status: 'unchanged' as const }
  )
  const changedOnly = changed.filter((f) => !allPathsSet.has(f.path))
  return [...overlaid, ...changedOnly].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Full Browse-mode file list for a git repo: every non-ignored path from
 * `listGitTree`, with real git status overlaid from `collectChanges` for
 * whichever ones are actually changed against `baseline`.
 */
export async function browseFiles(root: string, baseline: BaselineKind): Promise<ChangedFile[]> {
  const [allPaths, changed] = await Promise.all([listGitTree(root), collectChanges(root, baseline)])
  return overlayStatus(root, allPaths, changed)
}
