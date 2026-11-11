import { execFile } from 'child_process'
import { realpath } from 'fs/promises'
import type { ExternalKind } from '../../shared/types'
import { isInsideRoot } from './resource'

export interface ExternalRoot {
  kind: ExternalKind
  /** realpath'd directory */
  dir: string
}

/** Kind of the first root containing `realAbsPath` (already realpath'd), else null. */
export function classifyExternal(realAbsPath: string, roots: ExternalRoot[]): ExternalKind | null {
  for (const r of roots) if (isInsideRoot(realAbsPath, r.dir)) return r.kind
  return null
}

/**
 * Resolves symlinks/`..` first, then checks the real path against the
 * allow-list — so traversal and escaping symlinks are rejected. Null when
 * missing or outside every root.
 */
export async function resolveExternal(
  absPath: string,
  roots: ExternalRoot[]
): Promise<{ real: string; kind: ExternalKind } | null> {
  let real: string
  try {
    real = await realpath(absPath)
  } catch {
    return null
  }
  const kind = classifyExternal(real, roots)
  return kind ? { real, kind } : null
}

/** GOROOT and GOMODCACHE as allow-list roots; [] if go is missing or fails. */
export async function goExternalRoots(env: NodeJS.ProcessEnv, cwd?: string): Promise<ExternalRoot[]> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'go',
        ['env', '-json', 'GOROOT', 'GOMODCACHE'],
        // From the workspace, so a go.mod toolchain pin resolves the same GOROOT gopls uses.
        { env, cwd, timeout: 10_000, windowsHide: true },
        (err, out) => (err ? reject(err) : resolve(out))
      )
    })
    const parsed = JSON.parse(stdout) as { GOROOT?: string; GOMODCACHE?: string }
    const roots: ExternalRoot[] = []
    for (const [key, kind] of [
      ['GOROOT', 'go-stdlib'],
      ['GOMODCACHE', 'go-modcache']
    ] as const) {
      const dir = parsed[key]
      if (!dir) continue
      try {
        roots.push({ kind, dir: await realpath(dir) })
      } catch {
        // directory doesn't exist — skip
      }
    }
    return roots
  } catch {
    return []
  }
}
