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

  it('caps total matches across files and marks the result truncated', async () => {
    // 600 one-match files. One match per file keeps this test decoupled
    // from the per-file cap (covered separately above).
    const paths: string[] = []
    for (let i = 0; i < 600; i++) {
      const path = `file${i}.txt`
      await repo.write(path, `needle ${i}\n`)
      paths.push(path)
    }
    const { matches, truncated } = await searchFiles(repo.root, paths, 'needle')
    expect(truncated).toBe(true)
    // The cap is exact now (every file scans to completion, then the
    // sorted result is sliced to MAX_MATCHES_TOTAL) — no longer a soft,
    // scan-completion-timing-dependent overshoot.
    expect(matches).toHaveLength(500)
  })

  it('returns matches sorted by path then line, regardless of scan dispatch order', async () => {
    await repo.write('z.txt', 'needle\n')
    await repo.write('a.txt', 'x\nneedle\nneedle\n')
    await repo.write('m.txt', 'needle\n')
    // Dispatch order deliberately not alphabetical.
    const { matches } = await searchFiles(repo.root, ['z.txt', 'a.txt', 'm.txt'], 'needle')
    expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      'a.txt:2',
      'a.txt:3',
      'm.txt:1',
      'z.txt:1'
    ])
  })

  it('truncates to the alphabetically-first paths deterministically, not by scan-completion timing', async () => {
    const paths: string[] = []
    for (let i = 0; i < 600; i++) {
      const path = `file${String(i).padStart(3, '0')}.txt`
      await repo.write(path, 'needle\n')
      paths.push(path)
    }
    // Shuffle dispatch order so completion timing can't correlate with
    // path order — under the old behavior this could let a late-in-array,
    // fast-completing file "steal" cap headroom from an earlier one.
    const shuffled = [...paths].sort(() => Math.random() - 0.5)
    const { matches, truncated } = await searchFiles(repo.root, shuffled, 'needle')
    expect(truncated).toBe(true)
    expect(matches).toHaveLength(500)
    const expectedPaths = [...paths].sort((a, b) => a.localeCompare(b)).slice(0, 500)
    expect(matches.map((m) => m.path)).toEqual(expectedPaths)
  })

  it('stops scanning promptly when aborted mid-scan rather than completing anyway', async () => {
    const paths: string[] = []
    for (let i = 0; i < 200; i++) {
      const path = `file${i}.txt`
      await repo.write(path, `needle ${i}\n`)
      paths.push(path)
    }
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 0)
    const { matches } = await searchFiles(repo.root, paths, 'needle', {
      signal: controller.signal
    })
    // An unaborted run over these 200 one-match files would find 200
    // matches. Aborting on the same tick the scan starts must leave most
    // of the 200 files unscanned (only files already in flight when the
    // abort fires — at most CONCURRENCY of them — can still complete).
    expect(matches.length).toBeLessThan(200)
  })

  it('honors a startedAt that is already past the time budget', async () => {
    await repo.write('a.txt', 'needle\n')
    const { matches, truncated } = await searchFiles(repo.root, ['a.txt'], 'needle', {
      startedAt: Date.now() - 11_000
    })
    expect(matches).toEqual([])
    expect(truncated).toBe(true)
  })

  it('word mode matches whole words only, not substrings', async () => {
    await repo.write('a.txt', 'foo foobar barfoo\n')
    const { matches } = await searchFiles(repo.root, ['a.txt'], 'foo', { mode: 'word' })
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ line: 1, column: 0 })
  })

  it('word mode finds every occurrence on a line, not just the first', async () => {
    await repo.write('a.txt', 'foo(foo, foo)\n')
    const { matches } = await searchFiles(repo.root, ['a.txt'], 'foo', { mode: 'word' })
    expect(matches).toHaveLength(3)
    expect(matches.map((m) => m.column)).toEqual([0, 4, 9])
  })

  it('defaults to substring mode when mode is omitted', async () => {
    await repo.write('a.txt', 'foobar\n')
    const { matches } = await searchFiles(repo.root, ['a.txt'], 'foo')
    expect(matches).toHaveLength(1)
  })

  it('word mode with `words` option matches any of multiple words', async () => {
    await repo.write('a.txt', 'alpha\nbeta\ngamma\ndelta\n')
    const { matches } = await searchFiles(repo.root, ['a.txt'], 'alpha', {
      mode: 'word',
      words: ['alpha', 'gamma']
    })
    expect(matches.map((m) => m.line)).toEqual([1, 3])
  })
})
