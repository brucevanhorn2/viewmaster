import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rm } from 'fs/promises'
import { join } from 'path'
import { collectChanges } from './changes'
import { resolveBaseline } from './baseline'
import { makeRepo, type TestRepo } from './testRepo'
import type { ChangedFile } from '@shared/types'

let repo: TestRepo

/** main has base.txt + later.txt; feature branch checked out at fork. */
async function setupBranch(): Promise<void> {
  await repo.write('base.txt', 'base\n')
  await repo.git('add', '.')
  await repo.git('commit', '-m', 'initial')
  await repo.git('checkout', '-b', 'feature')
}

async function changes(): Promise<ChangedFile[]> {
  return collectChanges(repo.root, await resolveBaseline(repo.root))
}

function byPath(files: ChangedFile[], path: string): ChangedFile | undefined {
  return files.find((f) => f.path === path)
}

beforeEach(async () => {
  repo = await makeRepo()
})

afterEach(async () => {
  await repo.cleanup()
})

describe('collectChanges', () => {
  it('reports a file committed on the branch as committed', async () => {
    await setupBranch()
    await repo.write('feat.txt', 'work\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'feature work')

    const files = await changes()
    expect(files).toEqual([
      {
        path: 'feat.txt',
        absPath: join(repo.root, 'feat.txt'),
        status: 'committed'
      }
    ])
  })

  it('marks committed-then-modified as modified with committed secondary', async () => {
    await setupBranch()
    await repo.write('feat.txt', 'work\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'feature work')
    await repo.write('feat.txt', 'more work\n')

    const file = byPath(await changes(), 'feat.txt')
    expect(file?.status).toBe('modified')
    expect(file?.secondary).toBe('committed')
  })

  it('reports staged and staged+modified correctly', async () => {
    await setupBranch()
    await repo.write('staged.txt', 'staged\n')
    await repo.git('add', 'staged.txt')
    await repo.write('both.txt', 'v1\n')
    await repo.git('add', 'both.txt')
    await repo.write('both.txt', 'v2\n')

    const files = await changes()
    expect(byPath(files, 'staged.txt')?.status).toBe('staged')
    const both = byPath(files, 'both.txt')
    expect(both?.status).toBe('modified')
    expect(both?.secondary).toBe('staged')
  })

  it('reports untracked files', async () => {
    await setupBranch()
    await repo.write('new.txt', 'new\n')
    const file = byPath(await changes(), 'new.txt')
    expect(file?.status).toBe('untracked')
    expect(file?.secondary).toBeUndefined()
  })

  it('excludes files deleted from the worktree even if committed on the branch', async () => {
    await setupBranch()
    await repo.write('doomed.txt', 'here today\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'add doomed')
    await rm(join(repo.root, 'doomed.txt'))

    const files = await changes()
    expect(byPath(files, 'doomed.txt')).toBeUndefined()
  })

  it('excludes files changed on main after the fork point', async () => {
    await setupBranch()
    await repo.write('feat.txt', 'work\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'feature work')
    await repo.git('checkout', 'main')
    await repo.write('main-only.txt', 'main moves on\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'main advances')
    await repo.git('checkout', 'feature')

    const files = await changes()
    expect(byPath(files, 'main-only.txt')).toBeUndefined()
    expect(byPath(files, 'feat.txt')?.status).toBe('committed')
  })

  it('shows only working-tree changes in working-only mode (on default branch)', async () => {
    await repo.write('base.txt', 'base\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'initial')
    // still on main
    await repo.write('base.txt', 'edited\n')
    await repo.write('wild.txt', 'untracked\n')

    const files = await changes()
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['base.txt', 'modified'],
      ['wild.txt', 'untracked']
    ])
  })

  it('sorts results by path', async () => {
    await setupBranch()
    await repo.write('zebra.txt', 'z\n')
    await repo.write('alpha.txt', 'a\n')
    await repo.write('mid/beta.txt', 'b\n')

    const files = await changes()
    expect(files.map((f) => f.path)).toEqual(['alpha.txt', 'mid/beta.txt', 'zebra.txt'])
  })

  it('diffs directly against a custom ref, not filtered through a shared merge-base', async () => {
    await repo.write('base.txt', 'base\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'initial')
    await repo.git('branch', 'mine')
    await repo.git('checkout', '-b', 'sibling')
    await repo.write('sibling-only.txt', 'sibling work\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'sibling work')
    await repo.git('checkout', 'mine')
    await repo.write('mine-only.txt', 'my work\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'my work')

    const files = await collectChanges(repo.root, { kind: 'custom', ref: 'sibling' })

    // Diffing 'mine' (HEAD) directly against 'sibling' surfaces BOTH sides'
    // unique files, since it's a direct tip-to-tip comparison -- a
    // merge-base comparison (fork point = the 'initial' commit) would only
    // ever show mine-only.txt, never sibling-only.txt (a file that only
    // ever existed on a different branch entirely).
    expect(byPath(files, 'mine-only.txt')).toBeDefined()
    expect(byPath(files, 'sibling-only.txt')).toBeDefined()
  })

  it('excludes files deleted between merge-base and HEAD in merge-base mode (regression)', async () => {
    await setupBranch()
    // Commit a file at the fork point that will later be deleted
    await repo.write('temp.txt', 'temporary\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'add temp file')
    // Later, delete it on the feature branch
    await rm(join(repo.root, 'temp.txt'))
    await repo.git('add', 'temp.txt')
    await repo.git('commit', '-m', 'remove temp file')

    const files = await changes()

    // The deleted file should NOT appear in the changed files list for
    // merge-base mode, even though it was deleted in a commit between
    // the merge-base and HEAD. This regression test ensures that the
    // parseNameStatusZ includeDeletions parameter doesn't leak into
    // the merge-base code path.
    expect(byPath(files, 'temp.txt')).toBeUndefined()
  })
})
