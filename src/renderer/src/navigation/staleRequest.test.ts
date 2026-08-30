import { describe, expect, it } from 'vitest'
import { isStaleRequest } from './staleRequest'

describe('isStaleRequest', () => {
  it('is not stale when the id is unchanged', () => {
    expect(isStaleRequest(1, 1)).toBe(false)
  })

  it('is stale once a newer request has bumped the id', () => {
    expect(isStaleRequest(1, 2)).toBe(true)
  })

  it('is never stale for the highest id seen so far', () => {
    expect(isStaleRequest(2, 2)).toBe(false)
  })
})
