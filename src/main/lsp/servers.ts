import { access, realpath, stat } from 'fs/promises'
import { constants } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import type { LspLanguage } from '../../shared/types'
import {
  goExternalRoots,
  goWorkspaceRoots,
  pythonPackageRoots,
  run,
  type ExternalRoot
} from '../files/externalRoots'
import { isInsideRoot } from '../files/resource'
import type { ServerCommand } from './client'

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const s = await stat(file)
    if (!s.isFile()) return false
    await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

function goEnvGopath(env: NodeJS.ProcessEnv): Promise<string | null> {
  return run('go', ['env', 'GOPATH'], { env }).then(
    (out) => out.trim() || null,
    () => null
  )
}

/** gopls on PATH, else <GOPATH>/bin/gopls. Never throws. */
export async function findGopls(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  try {
    const exe = platform === 'win32' ? 'gopls.exe' : 'gopls'
    const delim = platform === 'win32' ? ';' : ':'
    for (const dir of (envGet(env, 'PATH') ?? '').split(delim)) {
      if (!dir) continue
      const candidate = join(dir, exe)
      if (await isExecutable(candidate, platform)) return candidate
    }
    const gopath = envGet(env, 'GOPATH') || (await goEnvGopath(env))
    const first = gopath?.split(platform === 'win32' ? ';' : ':')[0]
    if (first) {
      const candidate = join(first, 'bin', exe)
      if (await isExecutable(candidate, platform)) return candidate
    }
  } catch {
    // fall through
  }
  return null
}

export function goplsCommand(goplsPath: string, env: NodeJS.ProcessEnv): ServerCommand {
  return { command: goplsPath, args: ['serve'], env }
}

/**
 * True when `venvDir` is a real virtualenv (has pyvenv.cfg) whose realpath
 * stays strictly inside realpath(workspaceRoot). The venv dir becomes an
 * allow-listed read root, so a committed `.venv -> /` link must not count.
 * Only the dir is checked: <venv>/bin/python is normally a symlink to the
 * system interpreter.
 */
async function isTrustedVenvDir(venvDir: string, realRoot: string): Promise<boolean> {
  try {
    const realDir = await realpath(venvDir)
    if (realDir === realRoot || !isInsideRoot(realDir, realRoot)) return false
    return (await stat(join(realDir, 'pyvenv.cfg'))).isFile()
  } catch {
    return false
  }
}

/** Workspace virtualenv interpreter: .venv then venv (see isTrustedVenvDir). */
export async function findVenvPython(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  let realRoot: string
  try {
    realRoot = await realpath(workspaceRoot)
  } catch {
    return null
  }
  const rel = platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python')
  for (const name of ['.venv', 'venv']) {
    const dir = join(workspaceRoot, name)
    if (!(await isTrustedVenvDir(dir, realRoot))) continue
    const candidate = join(dir, rel)
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // try next
    }
  }
  return null
}

function pyrightPackageDir(): string {
  const req = createRequire(import.meta.url)
  const dir = dirname(req.resolve('pyright/package.json'))
  return dir.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked')
}

export function pyrightCommand(venvPython: string | null): ServerCommand {
  return {
    command: process.execPath,
    args: [join(pyrightPackageDir(), 'langserver.index.js'), '--stdio'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    settings: {
      python: { pythonPath: venvPython ?? undefined },
      'python.analysis': { autoSearchPaths: true, diagnosticMode: 'openFilesOnly' }
    }
  }
}

export function pyrightStubsDir(): string {
  return join(pyrightPackageDir(), 'dist', 'typeshed-fallback')
}

/**
 * Allow-list roots (realpath'd) for reading files outside the workspace. Go: GOROOT,
 * GOMODCACHE, and go.work / local-replace modules. Python: pyright's stubs and the
 * interpreter's package dirs. `venvPython` is the interpreter pyright was started with
 * (pass the same lookup used for pyrightCommand); undefined looks it up.
 */
export async function externalRootsFor(
  language: LspLanguage,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  venvPython?: string | null
): Promise<ExternalRoot[]> {
  if (language === 'go') {
    const [std, ws] = await Promise.all([
      goExternalRoots(env, workspaceRoot),
      goWorkspaceRoots(env, workspaceRoot)
    ])
    return [...std, ...ws]
  }
  const py = venvPython === undefined ? await findVenvPython(workspaceRoot) : venvPython
  const roots: ExternalRoot[] = []
  try {
    roots.push({ kind: 'python-stubs', dir: await realpath(pyrightStubsDir()) })
  } catch {
    // ignore
  }
  roots.push(...(await pythonPackageRoots(py, env, workspaceRoot)))
  return roots
}

