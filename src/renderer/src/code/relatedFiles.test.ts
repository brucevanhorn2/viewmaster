import { describe, it, expect } from 'vitest'
import { aggregateReferences } from './relatedFiles'

const loc = (path: string, line: number) => ({ path, absPath: `/root/${path}`, line, column: 0 })

describe('aggregateReferences', () => {
  it('produces one row per distinct file across multiple symbol results', () => {
    const result = aggregateReferences(
      [[loc('a.ts', 1)], [loc('b.ts', 5), loc('a.ts', 9)]],
      '/root/self.ts'
    )
    expect(result).toEqual([
      { path: 'a.ts', absPath: '/root/a.ts' },
      { path: 'b.ts', absPath: '/root/b.ts' }
    ])
  })

  it('deduplicates multiple matches in the same file', () => {
    const result = aggregateReferences([[loc('a.ts', 1), loc('a.ts', 2)]], '/root/self.ts')
    expect(result).toEqual([{ path: 'a.ts', absPath: '/root/a.ts' }])
  })

  it('excludes matches inside the file being viewed itself', () => {
    const result = aggregateReferences([[loc('self.ts', 1), loc('a.ts', 1)]], '/root/self.ts')
    expect(result).toEqual([{ path: 'a.ts', absPath: '/root/a.ts' }])
  })

  it('returns an empty array when there are no results', () => {
    expect(aggregateReferences([], '/root/self.ts')).toEqual([])
    expect(aggregateReferences([[]], '/root/self.ts')).toEqual([])
  })

  it('sorts results by path', () => {
    const result = aggregateReferences([[loc('z.ts', 1), loc('a.ts', 1)]], '/root/self.ts')
    expect(result.map((r) => r.path)).toEqual(['a.ts', 'z.ts'])
  })
})
