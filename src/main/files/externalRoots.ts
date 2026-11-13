import { execFile } from 'child_process'
import { access, lstat, realpath, stat } from 'fs/promises'
import { constants } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, isAbsolute, join, parse, resolve } from 'path'
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
    // From the workspace, so a go.mod toolchain pin resolves the same GOROOT gopls uses.
    const stdout = await run('go', ['env', '-json', 'GOROOT', 'GOMODCACHE'], { env, cwd })
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

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

/**
 * Absolute path of `name` found on env PATH only (never the current or `cwd` directory;
 * on Windows also tries `name.exe`), else null. Used so a `go.exe` / `python.exe` planted
 * in the opened folder is never run in place of the installed tool: on Windows, a bare
 * name given to execFile is looked up in `cwd` before PATH.
 */
export async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  const win = platform === 'win32'
  const names = win && !/\.exe$/i.test(name) ? [name + '.exe', name] : [name]
  for (const dir of (envGet(env, 'PATH') ?? '').split(win ? ';' : ':')) {
    if (!dir || !isAbsolute(dir)) continue // a relative PATH entry would be cwd-relative
    for (const n of names) {
      const candidate = join(dir, n)
      try {
        if (win) {
          // lstat: Windows Store app-execution aliases (python.exe) are reparse points that
          // stat() can't follow, yet they run fine.
          if ((await lstat(candidate)).isDirectory()) continue
        } else {
          if (!(await stat(candidate)).isFile()) continue
          await access(candidate, constants.X_OK)
        }
        return candidate
      } catch {
        // not here
      }
    }
  }
  return null
}

/**
 * Runs `cmd` (resolved via PATH unless already absolute) and resolves its stdout.
 * Rejects when it can't be found, fails, or exceeds 10s.
 */
export async function run(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string }
): Promise<string> {
  const exe = isAbsolute(cmd) ? cmd : await findOnPath(cmd, opts.env)
  if (!exe) throw new Error(`${cmd} not found on PATH`)
  return new Promise((res, rej) => {
    try {
      execFile(exe, args, { ...opts, timeout: 10_000, windowsHide: true }, (err, out) =>
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
 * workspace (in-root files need no allowance), and never a filesystem root, the home
 * directory, or any folder containing the workspace or the home directory (a stray
 * PYTHONPATH or replace entry like `..` or `C:\Users` must not open up sibling projects).
 */
export async function outsideRoots(
  dirs: string[],
  kind: ExternalKind,
  workspaceRoot: string
): Promise<ExternalRoot[]> {
  const realRoot = await realpath(workspaceRoot).catch(() => workspaceRoot)
  const realHome = await realpath(homedir()).catch(() => null)
  const home = realHome === null ? null : fold(realHome)
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
    // An ancestor of the workspace or of home is far too broad.
    if (isInsideRoot(realRoot, dir) || (realHome !== null && isInsideRoot(realHome, dir))) continue
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
