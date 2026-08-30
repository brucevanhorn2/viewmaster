import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chmod, mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { runGit } from './run'
import { makeRepo, type TestRepo } from './testRepo'

describe('runGit', () => {
  let repo: TestRepo
  let notARepo: string

  beforeAll(async () => {
    repo = await makeRepo()
    notARepo = await mkdtemp(join(tmpdir(), 'viewmaster-notgit-'))
  })

  afterAll(async () => {
    await repo.cleanup()
    await rm(notARepo, { recursive: true, force: true })
  })

  it('returns code 0 and stdout inside a work tree', async () => {
    const res = await runGit(repo.root, ['rev-parse', '--is-inside-work-tree'])
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('true')
  })

  it('returns nonzero code without throwing outside a repo', async () => {
    const res = await runGit(notARepo, ['rev-parse', '--is-inside-work-tree'])
    expect(res.code).not.toBe(0)
  })

  it('test repo helper can write and commit files', async () => {
    await repo.write('hello.txt', 'hello\n')
    await repo.git('add', '.')
    const commit = await repo.git('commit', '-m', 'initial')
    expect(commit.code).toBe(0)
    const log = await repo.git('log', '--oneline')
    expect(log.stdout).toContain('initial')
  })

  it('rejects distinctly when cwd does not exist, instead of blaming a missing git binary', async () => {
    // A cwd that was never created (e.g. a Recent Folder that was since
    // deleted, renamed, or unmounted). Node's execFile would report this as
    // the exact same ENOENT as a missing `git` binary, so runGit must check
    // for it up front and reject with a distinguishable error.
    const missingCwd = join(tmpdir(), `viewmaster-missing-cwd-${Date.now()}`)

    let caught: unknown
    try {
      await runGit(missingCwd, ['rev-parse', '--is-inside-work-tree'])
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    const err = caught as NodeJS.ErrnoException
    expect(err.message).not.toBe('git CLI not found on PATH')
    expect(err.code).toBe('ENOCWD')
    expect(err.message).toContain(missingCwd)
  })

  it('rejects distinctly on a permission error, instead of blaming a missing folder', async () => {
    // A cwd that exists but can't be stat'd because an ancestor directory
    // isn't searchable (e.g. restrictive ACLs, a mount point that briefly
    // denies access) fails with EACCES, not ENOENT -- runGit must not
    // collapse that into the same "Folder not found" message a genuinely
    // missing folder gets.
    if (process.getuid && process.getuid() === 0) {
      // root bypasses permission checks entirely -- this test can't
      // meaningfully exercise EACCES when running as root (e.g. some CI
      // containers), so skip rather than assert a false negative.
      return
    }
    const lockedParent = await mkdtemp(join(tmpdir(), 'viewmaster-locked-parent-'))
    const child = join(lockedParent, 'child')
    await mkdir(child)
    await chmod(lockedParent, 0o000)

    let caught: unknown
    try {
      await runGit(child, ['rev-parse', '--is-inside-work-tree'])
    } catch (err) {
      caught = err
    } finally {
      await chmod(lockedParent, 0o755)
      await rm(lockedParent, { recursive: true, force: true })
    }

    expect(caught).toBeInstanceOf(Error)
    const err = caught as NodeJS.ErrnoException
    expect(err.code).not.toBe('ENOCWD')
    expect(err.message).not.toBe('git CLI not found on PATH')
    expect(err.message).not.toContain('Folder not found')
  })
})
