import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { readCurrentFile, readBaseFile } from './content'
import { makeRepo, type TestRepo } from './testRepo'

let repo: TestRepo

beforeEach(async () => {
  repo = await makeRepo()
})

afterEach(async () => {
  await repo.cleanup()
})

describe('readCurrentFile', () => {
  it('reads a text file', async () => {
    await repo.write('a.txt', 'hello world\n')
    expect(await readCurrentFile(join(repo.root, 'a.txt'))).toEqual({
      kind: 'text',
      content: 'hello world\n'
    })
  })

  it('detects binary content (NUL bytes)', async () => {
    await repo.write('blob.bin', Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]))
    expect(await readCurrentFile(join(repo.root, 'blob.bin'))).toEqual({ kind: 'binary' })
  })

  it('rejects files over the size cap', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61)
    await repo.write('big.txt', big)
    expect(await readCurrentFile(join(repo.root, 'big.txt'))).toEqual({
      kind: 'too-large',
      size: big.length
    })
  })

  it('reports missing files', async () => {
    expect(await readCurrentFile(join(repo.root, 'nope.txt'))).toEqual({ kind: 'missing' })
  })
})

describe('readBaseFile', () => {
  it('returns the baseline content of a committed-then-modified file', async () => {
    await repo.write('doc.md', 'old content\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'initial')
    const base = (await repo.git('rev-parse', 'HEAD')).stdout.trim()
    await repo.write('doc.md', 'new content\n')

    expect(await readBaseFile(repo.root, base, 'doc.md')).toBe('old content\n')
  })

  it('returns empty string for a path absent at the baseline (untracked/added)', async () => {
    await repo.write('a.txt', 'x\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'initial')
    const base = (await repo.git('rev-parse', 'HEAD')).stdout.trim()

    expect(await readBaseFile(repo.root, base, 'never-existed.txt')).toBe('')
  })

  it('returns empty string when there is no baseline', async () => {
    expect(await readBaseFile(repo.root, null, 'a.txt')).toBe('')
  })
})
