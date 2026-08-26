import { describe, it, expect } from 'vitest'
import { baselineLabel } from './baselineLabel'
import type { BaselineKind } from '@shared/types'

describe('baselineLabel', () => {
  it('labels a merge-base baseline as "<branch> vs <defaultBranch>"', () => {
    const baseline: BaselineKind = { kind: 'merge-base', base: 'abc123', defaultBranch: 'main', branch: 'feature' }
    expect(baselineLabel(baseline)).toBe('feature vs main')
  })

  it('labels a custom baseline as "Custom: <ref>"', () => {
    const baseline: BaselineKind = { kind: 'custom', ref: 'v1.2.0' }
    expect(baselineLabel(baseline)).toBe('Custom: v1.2.0')
  })

  it('labels a detached-HEAD working-only baseline', () => {
    const baseline: BaselineKind = { kind: 'working-only', reason: 'detached' }
    expect(baselineLabel(baseline)).toBe('Working tree changes only (detached HEAD)')
  })

  it('labels an on-default-branch working-only baseline using its branch name', () => {
    const baseline: BaselineKind = { kind: 'working-only', reason: 'on-default', branch: 'main' }
    expect(baselineLabel(baseline)).toBe('Working tree changes only (on main)')
  })

  it('labels a no-commits working-only baseline', () => {
    const baseline: BaselineKind = { kind: 'working-only', reason: 'no-commits' }
    expect(baselineLabel(baseline)).toBe('Working tree changes only (no commits yet)')
  })

  it('labels a no-baseline working-only baseline', () => {
    const baseline: BaselineKind = { kind: 'working-only', reason: 'no-baseline' }
    expect(baselineLabel(baseline)).toBe('Working tree changes only (no baseline branch)')
  })
})
