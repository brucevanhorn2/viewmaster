import { describe, it, expect, afterEach } from 'vitest'
import { detectDefaultBranch, resolveBaseline } from './baseline'
import { makeRepo, type TestRepo } from './testRepo'

const repos: TestRepo[] = []

async function repoWithCommit(): Promise<TestRepo> {
  const repo = await makeRepo()
  repos.push(repo)
  await repo.write('a.txt', 'one\n')
  await repo.git('add', '.')
  await repo.git('commit', '-m', 'initial')
  return repo
}

afterEach(async () => {
  while (repos.length) await repos.pop()!.cleanup()
})

describe('detectDefaultBranch', () => {
  it('finds local main', async () => {
    const repo = await repoWithCommit()
    expect(await detectDefaultBranch(repo.root)).toBe('main')
  })

  it('falls back to master when main is absent', async () => {
    const repo = await repoWithCommit()
    await repo.git('branch', '-m', 'main', 'master')
    expect(await detectDefaultBranch(repo.root)).toBe('master')
  })

  it('falls back to init.defaultBranch when no main/master exists', async () => {
    const repo = await repoWithCommit()
    await repo.git('branch', '-m', 'main', 'trunk')
    await repo.git('config', 'init.defaultBranch', 'trunk')
    expect(await detectDefaultBranch(repo.root)).toBe('trunk')
  })
})

describe('resolveBaseline', () => {
  it('resolves merge-base for a feature branch off main', async () => {
    const repo = await repoWithCommit()
    const fork = (await repo.git('rev-parse', 'HEAD')).stdout.trim()
    await repo.git('checkout', '-b', 'feature')
    await repo.write('b.txt', 'two\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'feature work')
    // advance main past the fork point; baseline must stay at the fork
    await repo.git('checkout', 'main')
    await repo.write('c.txt', 'three\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'main moves on')
    await repo.git('checkout', 'feature')

    const baseline = await resolveBaseline(repo.root)
    expect(baseline).toEqual({
      kind: 'merge-base',
      base: fork,
      defaultBranch: 'main',
      branch: 'feature'
    })
  })

  it('is working-only when on the default branch', async () => {
    const repo = await repoWithCommit()
    const baseline = await resolveBaseline(repo.root)
    expect(baseline).toEqual({ kind: 'working-only', reason: 'on-default', branch: 'main' })
  })

  it('is working-only when HEAD is detached', async () => {
    const repo = await repoWithCommit()
    const head = (await repo.git('rev-parse', 'HEAD')).stdout.trim()
    await repo.git('checkout', '--detach', head)
    const baseline = await resolveBaseline(repo.root)
    expect(baseline).toEqual({ kind: 'working-only', reason: 'detached' })
  })

  it('is working-only in a brand-new repo with no commits', async () => {
    const repo = await makeRepo()
    repos.push(repo)
    const baseline = await resolveBaseline(repo.root)
    expect(baseline).toEqual({ kind: 'working-only', reason: 'no-commits' })
  })

  it('is working-only with no-baseline when no default branch is resolvable', async () => {
    const repo = await repoWithCommit()
    await repo.git('branch', '-m', 'main', 'topic')
    // no main/master, no origin/HEAD, no init.defaultBranch pointing at a real ref
    const baseline = await resolveBaseline(repo.root)
    expect(baseline).toEqual({ kind: 'working-only', reason: 'no-baseline', branch: 'topic' })
  })
})
