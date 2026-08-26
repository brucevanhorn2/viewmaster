import { describe, it, expect } from 'vitest'
import { touchKey } from './modelLru'

describe('touchKey', () => {
  it('does not evict anything while under the cap', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 3, (k) => disposed.push(k))
    touchKey(map, 'b', 3, (k) => disposed.push(k))
    touchKey(map, 'c', 3, (k) => disposed.push(k))
    expect([...map.keys()]).toEqual(['a', 'b', 'c'])
    expect(disposed).toEqual([])
  })

  it('evicts the least-recently-used key once the cap is exceeded', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 2, (k) => disposed.push(k))
    touchKey(map, 'b', 2, (k) => disposed.push(k))
    touchKey(map, 'c', 2, (k) => disposed.push(k))
    expect([...map.keys()]).toEqual(['b', 'c'])
    expect(disposed).toEqual(['a'])
  })

  it('re-touching an existing key moves it to most-recently-used instead of duplicating it', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 2, (k) => disposed.push(k))
    touchKey(map, 'b', 2, (k) => disposed.push(k))
    touchKey(map, 'a', 2, (k) => disposed.push(k)) // re-touch 'a' -- now 'b' is oldest
    touchKey(map, 'c', 2, (k) => disposed.push(k)) // exceeds cap -- 'b' should be evicted, not 'a'
    expect([...map.keys()]).toEqual(['a', 'c'])
    expect(disposed).toEqual(['b'])
  })

  it('evicts multiple keys in one call if several are over the cap at once', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 5, (k) => disposed.push(k))
    touchKey(map, 'b', 5, (k) => disposed.push(k))
    touchKey(map, 'c', 5, (k) => disposed.push(k))
    // Lower the cap to 1 on this next touch -- both 'a' and 'b' must go, only the
    // just-touched 'd' (and whatever was already under the new cap) should survive.
    touchKey(map, 'd', 1, (k) => disposed.push(k))
    expect([...map.keys()]).toEqual(['d'])
    expect(disposed).toEqual(['a', 'b', 'c'])
  })
})
