import { describe, it, expect } from 'vitest'
import { parsePorcelainV2, parseNameStatusZ } from './parse'

const NUL = '\0'

// Realistic porcelain v2 -z record prefixes (hashes shortened for readability
// is NOT allowed — git emits full 40-char hashes; use plausible fixed values).
const H1 = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
const H2 = '5716ca5987cbf97d6bb54920bea6adde242d87e6'

function type1(xy: string, path: string): string {
  return `1 ${xy} N... 100644 100644 100644 ${H1} ${H2} ${path}`
}

describe('parsePorcelainV2', () => {
  it('parses untracked entries', () => {
    const out = `? new-file.ts${NUL}`
    expect(parsePorcelainV2(out)).toEqual([
      { path: 'new-file.ts', staged: false, modified: false, untracked: true, deleted: false }
    ])
  })

  it('parses staged-only (M.)', () => {
    const out = `${type1('M.', 'src/app.ts')}${NUL}`
    expect(parsePorcelainV2(out)).toEqual([
      { path: 'src/app.ts', staged: true, modified: false, untracked: false, deleted: false }
    ])
  })

  it('parses modified-only (.M)', () => {
    const out = `${type1('.M', 'src/app.ts')}${NUL}`
    expect(parsePorcelainV2(out)).toEqual([
      { path: 'src/app.ts', staged: false, modified: true, untracked: false, deleted: false }
    ])
  })

  it('parses staged-and-modified (MM)', () => {
    const out = `${type1('MM', 'src/app.ts')}${NUL}`
    expect(parsePorcelainV2(out)).toEqual([
      { path: 'src/app.ts', staged: true, modified: true, untracked: false, deleted: false }
    ])
  })

  it('parses staged add (A.)', () => {
    const out = `${type1('A.', 'brand-new.ts')}${NUL}`
    expect(parsePorcelainV2(out)).toEqual([
      { path: 'brand-new.ts', staged: true, modified: false, untracked: false, deleted: false }
    ])
  })

  it('flags worktree deletions (.D) as deleted', () => {
    const out = `${type1('.D', 'gone.ts')}${NUL}`
    expect(parsePorcelainV2(out)).toEqual([
      { path: 'gone.ts', staged: false, modified: false, untracked: false, deleted: true }
    ])
  })

  it('flags staged deletions (D.) as deleted', () => {
    const out = `${type1('D.', 'gone.ts')}${NUL}`
    expect(parsePorcelainV2(out)).toEqual([
      { path: 'gone.ts', staged: false, modified: false, untracked: false, deleted: true }
    ])
  })

  it('parses rename records (type 2) and consumes the orig path', () => {
    const out =
      `2 R. N... 100644 100644 100644 ${H1} ${H2} R100 new-name.ts${NUL}old-name.ts${NUL}` +
      `? other.ts${NUL}`
    expect(parsePorcelainV2(out)).toEqual([
      { path: 'new-name.ts', staged: true, modified: false, untracked: false, deleted: false },
      { path: 'other.ts', staged: false, modified: false, untracked: true, deleted: false }
    ])
  })

  it('handles paths with spaces', () => {
    const out = `${type1('.M', 'docs/my notes.md')}${NUL}`
    expect(parsePorcelainV2(out)[0].path).toBe('docs/my notes.md')
  })

  it('skips ignored (!) records and empty input', () => {
    expect(parsePorcelainV2('')).toEqual([])
    expect(parsePorcelainV2(`! build/out.js${NUL}`)).toEqual([])
  })
})

describe('parseNameStatusZ', () => {
  it('parses added/modified, drops deletions, uses new path for renames', () => {
    const out = `M${NUL}src/app.ts${NUL}A${NUL}added.ts${NUL}D${NUL}removed.ts${NUL}R100${NUL}old.ts${NUL}renamed.ts${NUL}`
    expect(parseNameStatusZ(out)).toEqual([
      { path: 'src/app.ts' },
      { path: 'added.ts' },
      { path: 'renamed.ts' }
    ])
  })

  it('handles empty input', () => {
    expect(parseNameStatusZ('')).toEqual([])
  })
})
