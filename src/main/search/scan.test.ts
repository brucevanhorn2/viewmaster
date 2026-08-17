import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { searchFiles } from './scan'
import { makeRepo, type TestRepo } from '../git/testRepo'

let repo: TestRepo

beforeEach(async () => {
  repo = await makeRepo()
})

afterEach(async () => {
  await repo.cleanup()
})

describe('searchFiles', () => {
  it('finds a case-insensitive substring match', async () => {
    await repo.write('a.txt', 'Hello World\nSecond line\n')
    const { matches, truncated } = await searchFiles(repo.root, ['a.txt'], 'hello')
    expect(truncated).toBe(false)
    expect(matches).toEqual([
      {
        path: 'a.txt',
        absPath: join(repo.root, 'a.txt'),
        line: 1,
        column: 0,
        preview: 'Hello World',
        previewColumn: 0
      }
    ])
  })

  it('finds multiple matches across multiple files', async () => {
    await repo.write('a.txt', 'foo bar\n')
    await repo.write('sub/b.txt', 'bar foo\nanother foo here\n')
    const { matches } = await searchFiles(repo.root, ['a.txt', 'sub/b.txt'], 'foo')
    const byLine = matches.map((m) => `${m.path}:${m.line}`).sort()
    expect(byLine).toEqual(['a.txt:1', 'sub/b.txt:1', 'sub/b.txt:2'])
  })

  it('returns no matches for an empty or whitespace-only query', async () => {
    await repo.write('a.txt', 'hello\n')
    expect(await searchFiles(repo.root, ['a.txt'], '')).toEqual({ matches: [], truncated: false })
    expect(await searchFiles(repo.root, ['a.txt'], '   ')).toEqual({
      matches: [],
      truncated: false
    })
  })

  it('excludes binary files even when their raw bytes contain the query', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0x47, ...Buffer.from('needle')])
    await repo.write('photo.bin', bytes)
    const { matches } = await searchFiles(repo.root, ['photo.bin'], 'needle')
    expect(matches).toEqual([])
  })

  it('excludes files over the 2MB size cap', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61)
    await repo.write('big.txt', big)
    const { matches } = await searchFiles(repo.root, ['big.txt'], 'aaaa')
    expect(matches).toEqual([])
  })

  it('centers a long preview around a match far into the line', async () => {
    const line = 'x'.repeat(300) + 'NEEDLE' + 'y'.repeat(300)
    await repo.write('long.txt', line + '\n')
    const { matches } = await searchFiles(repo.root, ['long.txt'], 'needle')
    expect(matches).toHaveLength(1)
    const match = matches[0]
    expect(match.preview).toContain('NEEDLE')
    expect(match.preview.slice(match.previewColumn, match.previewColumn + 6)).toBe('NEEDLE')
    expect(match.preview.length).toBeLessThanOrEqual(200)
  })

  it('caps matches per file and marks the result truncated', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `needle ${i}`).join('\n')
    await repo.write('many.txt', lines + '\n')
    const { matches, truncated } = await searchFiles(repo.root, ['many.txt'], 'needle')
    expect(matches).toHaveLength(50)
    expect(truncated).toBe(true)
  })

  it('respects an already-aborted signal by scanning nothing', async () => {
    await repo.write('a.txt', 'needle\n')
    const controller = new AbortController()
    controller.abort()
    const { matches } = await searchFiles(repo.root, ['a.txt'], 'needle', {
      signal: controller.signal
    })
    expect(matches).toEqual([])
  })
})
