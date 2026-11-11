import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { classifyExternal, resolveExternal, goExternalRoots, type ExternalRoot } from './externalRoots'

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
