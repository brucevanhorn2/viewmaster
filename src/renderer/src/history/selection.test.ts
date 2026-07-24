import { describe, it, expect } from 'vitest'
import {
  defaultSelection,
  isDefaultSelection,
  sameRef,
  singleClickSelection
} from './selection'
import type { HistoryVersion } from '@shared/types'

const v = (ts: number, sha: string): HistoryVersion => ({ ts, sha, size: 1 })
const versions = [v(100, 'a'), v(200, 'b'), v(300, 'c')] // ascending

describe('selection', () => {
  it('default is baseline↔now', () => {
    expect(defaultSelection()).toEqual({ base: 'baseline', compare: 'now' })
    expect(isDefaultSelection(defaultSelection())).toBe(true)
    expect(isDefaultSelection({ base: 'baseline', compare: { sha: 'a' } })).toBe(false)
  })

  it('clicking a middle revision diffs it against the previous one', () => {
    expect(singleClickSelection(versions, { sha: 'b' })).toEqual({
      base: { sha: 'a' },
      compare: { sha: 'b' }
    })
  })

  it('clicking the oldest revision diffs it against baseline', () => {
    expect(singleClickSelection(versions, { sha: 'a' })).toEqual({
      base: 'baseline',
      compare: { sha: 'a' }
    })
  })

  it('clicking Now diffs the newest revision against now', () => {
    expect(singleClickSelection(versions, 'now')).toEqual({
      base: { sha: 'c' },
      compare: 'now'
    })
  })

  it('clicking Now with no versions is baseline↔now', () => {
    expect(singleClickSelection([], 'now')).toEqual({ base: 'baseline', compare: 'now' })
  })

  it('clicking Baseline resets to the full diff', () => {
    expect(singleClickSelection(versions, 'baseline')).toEqual({ base: 'baseline', compare: 'now' })
  })

  it('sameRef compares by sha/sentinel', () => {
    expect(sameRef({ sha: 'a' }, { sha: 'a' })).toBe(true)
    expect(sameRef({ sha: 'a' }, { sha: 'b' })).toBe(false)
    expect(sameRef('now', 'now')).toBe(true)
    expect(sameRef('now', 'baseline')).toBe(false)
  })
})
