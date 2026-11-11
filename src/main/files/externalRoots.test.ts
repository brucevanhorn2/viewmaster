import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'fs/promises'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, parse } from 'path'
import {
  classifyExternal,
  resolveExternal,
  goExternalRoots,
  goWorkspaceRoots,
  localModuleDirs,
  outsideRoots,
  pythonPackageRoots,
  type ExternalRoot
} from './externalRoots'

let base: string
let modcache: string
let roots: ExternalRoot[]
let outside: string
let symlinkOk = true

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'vm-ext-')))
  modcache = join(base, 'modcache')
  await mkdir(join(modcache, 'pkg'), { recursive: true })
  await writeFile(join(modcache, 'pkg', 'x.go'), 'package x')
  outside = join(base, 'secret.txt')
  await writeFile(outside, 'secret')
  roots = [{ kind: 'go-modcache', dir: modcache }]
  try {
    await symlink(outside, join(modcache, 'link.txt'), 'file')
  } catch {
    symlinkOk = false
  }
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('external roots', () => {
  it('classifies a file inside GOMODCACHE', async () => {
    const p = join(modcache, 'pkg', 'x.go')
    expect(classifyExternal(p, roots)).toBe('go-modcache')
    const r = await resolveExternal(p, roots)
    expect(r).toEqual({ real: p, kind: 'go-modcache' })
  })

  it('rejects traversal out of an external root', async () => {
    const p = join(modcache, '..', '..', 'secret.txt')
    expect(await resolveExternal(p, roots)).toBeNull()
    expect(await resolveExternal(join(modcache, '..', 'secret.txt'), roots)).toBeNull()
  })

  it('rejects a symlink escaping an external root', async (ctx) => {
    if (!symlinkOk) ctx.skip()
    expect(await resolveExternal(join(modcache, 'link.txt'), roots)).toBeNull()
  })

  it('missing file -> null', async () => {
    expect(await resolveExternal(join(modcache, 'nope.go'), roots)).toBeNull()
  })

  it('goExternalRoots returns an array of existing dirs and never throws', async () => {
    const r = await goExternalRoots(process.env)
    expect(Array.isArray(r)).toBe(true)
    for (const x of r) expect(['go-stdlib', 'go-modcache']).toContain(x.kind)
    expect(await goExternalRoots({ PATH: '' })).toEqual([])
  })
})

const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
})()

describe('wider allow-list (python packages, go workspace modules)', () => {
  it('localModuleDirs: use dirs and versionless local replaces only', () => {
    const base = join(tmpdir(), 'ws')
    const dirs = localModuleDirs(
      {
        Use: [{ DiskPath: '../lib' }],
        Replace: [
          { New: { Path: '../fork' } },
          { New: { Path: 'example.com/other', Version: 'v1.2.3' } },
          { New: { Path: 'example.com/noversion' } }
        ]
      },
      base
    )
    expect(dirs).toEqual([join(tmpdir(), 'lib'), join(tmpdir(), 'fork')])
  })

  it('outsideRoots drops in-root, missing, duplicate, filesystem-root and home dirs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vm-or-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'vm-or-out-'))
    mkdirSync(join(root, 'inner'))
    const roots = await outsideRoots(
      [join(root, 'inner'), outside, outside, join(outside, 'missing'), parse(outside).root, homedir()],
      'python-packages',
      root
    )
    expect(roots).toEqual([{ kind: 'python-packages', dir: realpathSync(outside) }])
  })

  it('pythonPackageRoots never throws without an interpreter', async () => {
    expect(await pythonPackageRoots(null, { PATH: '' }, tmpdir())).toEqual([])
    expect(await pythonPackageRoots(join(tmpdir(), 'no-such-python'), {}, tmpdir())).toEqual([])
  })

  it('goWorkspaceRoots finds a local replace target outside the folder', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'vm-gows-'))
    const root = join(parent, 'app')
    const fork = join(parent, 'fork')
    mkdirSync(root)
    mkdirSync(fork)
    writeFileSync(join(fork, 'go.mod'), 'module example.com/fork\n\ngo 1.21\n')
    writeFileSync(
      join(root, 'go.mod'),
      'module example.com/app\n\ngo 1.21\n\nrequire example.com/fork v0.0.0\n\nreplace example.com/fork => ../fork\n'
    )
    const roots = await goWorkspaceRoots({ ...process.env, GOWORK: 'off', GOFLAGS: '' }, root)
    // [] when go is not installed; otherwise exactly the fork dir.
    expect(roots).toEqual(hasGo ? [{ kind: 'go-workspace', dir: realpathSync(fork) }] : [])
    expect(await goWorkspaceRoots({ PATH: '' }, root)).toEqual([])
  })
})
