import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
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
})
