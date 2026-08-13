import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { listFolderTree, listGitTree, overlayStatus, toUnchangedFiles } from './browse'
import { makeRepo, type TestRepo } from '../git/testRepo'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'viewmaster-folder-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(rel: string, content = ''): Promise<void> {
  const abs = join(dir, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
}

describe('listFolderTree', () => {
  it('lists every file when there is no .gitignore', async () => {
    await write('a.md', 'a')
    await write('sub/b.md', 'b')

    expect(await listFolderTree(dir)).toEqual(['a.md', 'sub/b.md'])
  })

  it('excludes files matching a root .gitignore pattern', async () => {
    await write('.gitignore', '*.log\n')
    await write('keep.md', 'k')
    await write('debug.log', 'd')

    expect(await listFolderTree(dir)).toEqual(['.gitignore', 'keep.md'])
  })

  it('excludes an entire directory matched by a trailing-slash pattern', async () => {
    await write('.gitignore', 'node_modules/\n')
    await write('node_modules/pkg/index.js', 'x')
    await write('src/app.ts', 'y')

    expect(await listFolderTree(dir)).toEqual(['.gitignore', 'src/app.ts'])
  })

  it('always excludes .git even without a .gitignore', async () => {
    await write('.git/HEAD', 'ref: refs/heads/main')
    await write('README.md', 'r')

    expect(await listFolderTree(dir)).toEqual(['README.md'])
  })

  it('sorts results by path', async () => {
    await write('zebra.txt', 'z')
    await write('alpha.txt', 'a')
    await write('mid/beta.txt', 'b')

    expect(await listFolderTree(dir)).toEqual(['alpha.txt', 'mid/beta.txt', 'zebra.txt'])
  })

  it('throws an error when the root directory does not exist', async () => {
    const nonexistent = join(tmpdir(), 'nonexistent-folder-' + Math.random())
    await expect(listFolderTree(nonexistent)).rejects.toThrow()
  })
})

describe('toUnchangedFiles', () => {
  it('maps paths to unchanged ChangedFile entries', () => {
    expect(toUnchangedFiles('/vault', ['a.md', 'sub/b.md'])).toEqual([
      { path: 'a.md', absPath: join('/vault', 'a.md'), status: 'unchanged' },
      { path: 'sub/b.md', absPath: join('/vault', 'sub/b.md'), status: 'unchanged' }
    ])
  })
})

describe('listGitTree', () => {
  let repo: TestRepo

  beforeEach(async () => {
    repo = await makeRepo()
  })

  afterEach(async () => {
    await repo.cleanup()
  })

  it('lists tracked and untracked-non-ignored files, excludes ignored ones', async () => {
    await repo.write('.gitignore', '*.log\n')
    await repo.write('a.txt', 'a')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'init')
    await repo.write('b.txt', 'b') // untracked
    await repo.write('debug.log', 'd') // untracked + ignored

    expect(await listGitTree(repo.root)).toEqual(['.gitignore', 'a.txt', 'b.txt'])
  })
})

describe('overlayStatus', () => {
  it('keeps the real status for changed paths and marks the rest unchanged', () => {
    const changed = [{ path: 'a.txt', absPath: '/r/a.txt', status: 'modified' as const }]

    expect(overlayStatus('/r', ['b.txt', 'a.txt'], changed)).toEqual([
      { path: 'a.txt', absPath: '/r/a.txt', status: 'modified' },
      { path: 'b.txt', absPath: '/r/b.txt', status: 'unchanged' }
    ])
  })
})
