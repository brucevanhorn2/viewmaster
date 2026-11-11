import { execFile } from 'child_process'
import { realpath } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { dirname, isAbsolute, parse, resolve } from 'path'
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

function run(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string }): Promise<string> {
  return new Promise((res, rej) => {
    try {
      execFile(cmd, args, { ...opts, timeout: 10_000, windowsHide: true }, (err, out) =>
        err ? rej(err) : res(out)
      )
    } catch (err) {
      rej(err)
    }
  })
}

const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * Realpaths `dirs` and keeps those usable as allow-list roots: existing, outside the
 * workspace (in-root files need no allowance), and never a filesystem root or the home
 * directory itself (a stray PYTHONPATH or replace entry must not open up everything).
 */
export async function outsideRoots(
  dirs: string[],
  kind: ExternalKind,
  workspaceRoot: string
): Promise<ExternalRoot[]> {
  const realRoot = await realpath(workspaceRoot).catch(() => workspaceRoot)
  const home = await realpath(homedir()).then(fold, () => null)
  const out: ExternalRoot[] = []
  const seen = new Set<string>()
  for (const d of dirs) {
    const dir = await realpath(d).catch(() => null)
    if (!dir) continue
    const key = fold(dir)
    if (seen.has(key)) continue
    seen.add(key)
    if (parse(dir).root === dir || key === home) continue
    if (isInsideRoot(dir, realRoot)) continue
    out.push({ kind, dir })
  }
  return out
}

export interface GoEditJson {
  Replace?: { New?: { Path?: string; Version?: string } }[] | null
  Use?: { DiskPath?: string }[] | null
}

/** Local directories named by a go.mod / go.work: `use` entries and versionless `replace` targets. */
export function localModuleDirs(json: GoEditJson, baseDir: string): string[] {
  const dirs: string[] = []
  for (const u of json.Use ?? []) if (u.DiskPath) dirs.push(resolve(baseDir, u.DiskPath))
  for (const r of json.Replace ?? []) {
    const p = r.New?.Path
    // A replace target without a version is a local directory path.
    if (p && !r.New?.Version && (isAbsolute(p) || p.startsWith('.'))) dirs.push(resolve(baseDir, p))
  }
  return dirs
}

/**
 * Go workspace modules outside the folder: `use` dirs of the active go.work and local
 * `replace` targets in the root go.mod and go.work. Offline (`go mod edit` and
 * `go work edit` only read files); [] when go or the files are missing.
 */
export async function goWorkspaceRoots(env: NodeJS.ProcessEnv, workspaceRoot: string): Promise<ExternalRoot[]> {
  const dirs: string[] = []
  try {
    const mod = JSON.parse(await run('go', ['mod', 'edit', '-json'], { env, cwd: workspaceRoot }))
    dirs.push(...localModuleDirs(mod, workspaceRoot))
  } catch {
    // no root go.mod
  }
  try {
    const gowork = (await run('go', ['env', 'GOWORK'], { env, cwd: workspaceRoot })).trim()
    if (gowork && gowork !== 'off') {
      const work = JSON.parse(await run('go', ['work', 'edit', '-json', gowork], { env, cwd: workspaceRoot }))
      dirs.push(...localModuleDirs(work, dirname(gowork)))
    }
  } catch {
    // no go.work
  }
  return outsideRoots(dirs, 'go-workspace', workspaceRoot)
}

const SYS_PATH_SCRIPT =
  'import sys, os, json; print(json.dumps([p for p in sys.path if p and os.path.isdir(p)]))'

/**
 * The import-search directories (site-packages, user site, conda env, stdlib) of the
 * interpreter pyright uses: `python` (the workspace venv's, when there is one), else the
 * one on PATH. Run from the temp dir so nothing in the workspace lands on its path.
 */
export async function pythonPackageRoots(
  python: string | null,
  env: NodeJS.ProcessEnv,
  workspaceRoot: string
): Promise<ExternalRoot[]> {
  const candidates = python ? [python] : process.platform === 'win32' ? ['python'] : ['python3', 'python']
  for (const exe of candidates) {
    try {
      const parsed: unknown = JSON.parse(await run(exe, ['-c', SYS_PATH_SCRIPT], { env, cwd: tmpdir() }))
      if (!Array.isArray(parsed)) continue
      const dirs = parsed.filter((p): p is string => typeof p === 'string' && isAbsolute(p))
      return outsideRoots(dirs, 'python-packages', workspaceRoot)
    } catch {
      // try the next interpreter name
    }
  }
  return []
}
