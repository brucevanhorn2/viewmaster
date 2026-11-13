import { describe, expect, it } from 'vitest'
import { baselineKey } from './baselineKey'

describe('baselineKey', () => {
  it('changes when the custom baseline ref changes', () => {
    expect(baselineKey({ kind: 'custom', ref: 'a' })).not.toBe(baselineKey({ kind: 'custom', ref: 'b' }))
  })
  it('differs between merge-base and custom, and tracks the merge-base sha', () => {
    const mb = { kind: 'merge-base' as const, base: 'abc', defaultBranch: 'main', branch: 'f' }
    expect(baselineKey(mb)).not.toBe(baselineKey({ kind: 'custom', ref: 'abc' }))
    expect(baselineKey(mb)).not.toBe(baselineKey({ ...mb, base: 'def' }))
    expect(baselineKey(mb)).toBe(baselineKey({ ...mb }))
  })
  it('handles working-only and missing baselines', () => {
    expect(baselineKey({ kind: 'working-only', reason: 'on-default' })).toBe('working-only')
    expect(baselineKey(undefined)).toBe('none')
  })
})
