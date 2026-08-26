import { describe, it, expect } from 'vitest'
import { touchKey } from './lruMap'

/** Records every key eviction was offered, and releases all of them. */
function releaseAll(into: string[]): (key: string) => boolean {
  return (key) => {
    into.push(key)
    return true
  }
}

/** Releases every key except those in `pinned`, which stay tracked. */
function releaseExcept(into: string[], pinned: string[]): (key: string) => boolean {
  return (key) => {
    if (pinned.includes(key)) return false
    into.push(key)
    return true
  }
}

describe('touchKey', () => {
  it('does not evict anything while under the cap', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 3, releaseAll(disposed))
    touchKey(map, 'b', 3, releaseAll(disposed))
    touchKey(map, 'c', 3, releaseAll(disposed))
    expect([...map.keys()]).toEqual(['a', 'b', 'c'])
    expect(disposed).toEqual([])
  })

  it('evicts the least-recently-used key once the cap is exceeded', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 2, releaseAll(disposed))
    touchKey(map, 'b', 2, releaseAll(disposed))
    touchKey(map, 'c', 2, releaseAll(disposed))
    expect([...map.keys()]).toEqual(['b', 'c'])
    expect(disposed).toEqual(['a'])
  })

  it('re-touching an existing key moves it to most-recently-used instead of duplicating it', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 2, releaseAll(disposed))
    touchKey(map, 'b', 2, releaseAll(disposed))
    touchKey(map, 'a', 2, releaseAll(disposed)) // re-touch 'a' -- now 'b' is oldest
    touchKey(map, 'c', 2, releaseAll(disposed)) // exceeds cap -- 'b' should be evicted, not 'a'
    expect([...map.keys()]).toEqual(['a', 'c'])
    expect(disposed).toEqual(['b'])
  })

  it('evicts multiple keys in one call if several are over the cap at once', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'a', 5, releaseAll(disposed))
    touchKey(map, 'b', 5, releaseAll(disposed))
    touchKey(map, 'c', 5, releaseAll(disposed))
    // Lower the cap to 1 on this next touch -- both 'a' and 'b' must go, only the
    // just-touched 'd' (and whatever was already under the new cap) should survive.
    touchKey(map, 'd', 1, releaseAll(disposed))
    expect([...map.keys()]).toEqual(['d'])
    expect(disposed).toEqual(['a', 'b', 'c'])
  })

  it('skips over an entry the dispose callback refuses to release, evicting the next-oldest instead', () => {
    // This is the shape of the real bug: CodeView touches the displayed file's
    // own model first, then its import-preload effect touches that file's
    // imports asynchronously -- making the displayed file the oldest entry, so
    // it would otherwise be the one evicted while the editor is still showing it.
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'displayed', 2, releaseExcept(disposed, ['displayed']))
    touchKey(map, 'import1', 2, releaseExcept(disposed, ['displayed']))
    touchKey(map, 'import2', 2, releaseExcept(disposed, ['displayed']))
    expect(disposed).toEqual(['import1'])
    // 'displayed' survives, moved to the most-recently-used end as it is in use.
    expect([...map.keys()]).toEqual(['import2', 'displayed'])
  })

  it('terminates and keeps every entry when nothing may be released', () => {
    const map = new Map<string, true>()
    const disposed: string[] = []
    const pinned = ['a', 'b', 'c']
    touchKey(map, 'a', 1, releaseExcept(disposed, pinned))
    touchKey(map, 'b', 1, releaseExcept(disposed, pinned))
    touchKey(map, 'c', 1, releaseExcept(disposed, pinned))
    expect(disposed).toEqual([])
    expect(map.size).toBe(3)
    expect([...map.keys()].sort()).toEqual(['a', 'b', 'c'])
  })

  it('drops a key whose dispose callback reports it was already gone', () => {
    // modelLru returns true for a key whose model no longer exists (e.g. it was
    // disposed by the folder-switch clear), so the stale key leaves the map.
    const map = new Map<string, true>()
    const disposed: string[] = []
    touchKey(map, 'stale', 1, releaseAll(disposed))
    touchKey(map, 'fresh', 1, releaseAll(disposed))
    expect([...map.keys()]).toEqual(['fresh'])
    expect(disposed).toEqual(['stale'])
  })
})
