import { describe, it, expect } from 'vitest'
import { joinPath, dirnamePath, isInsideRoot } from './paths'

describe('joinPath', () => {
  it('joins simple segments', () => {
    expect(joinPath('/a/b', 'c.md')).toBe('/a/b/c.md')
  })

  it('resolves "." and ".." segments', () => {
    expect(joinPath('/a/b', '../c.md')).toBe('/a/c.md')
    expect(joinPath('/a/b', './c.md')).toBe('/a/b/c.md')
  })

  it('clamps excess ".." at the filesystem root instead of erroring', () => {
    expect(joinPath('/a', '../../../etc/passwd')).toBe('/etc/passwd')
  })
})

describe('dirnamePath', () => {
  it('returns everything before the last slash', () => {
    expect(dirnamePath('/a/b/c.md')).toBe('/a/b')
  })

  it('returns "/" for a top-level absolute file', () => {
    expect(dirnamePath('/c.md')).toBe('/')
  })
})

describe('isInsideRoot', () => {
  it('accepts the root itself', () => {
    expect(isInsideRoot('/w', '/w')).toBe(true)
  })

  it('accepts a descendant', () => {
    expect(isInsideRoot('/w/sub/a.md', '/w')).toBe(true)
  })

  it('rejects a path outside the root', () => {
    expect(isInsideRoot('/other/a.md', '/w')).toBe(false)
  })

  it('rejects a sibling directory with a name-prefix collision', () => {
    expect(isInsideRoot('/w-evil/a.md', '/w')).toBe(false)
  })
})
