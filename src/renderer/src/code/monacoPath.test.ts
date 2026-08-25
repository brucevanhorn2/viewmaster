import { describe, it, expect } from 'vitest'
import { encodeForMonacoPath } from './monacoPath'

describe('encodeForMonacoPath', () => {
  it('percent-encodes a literal # so it is not read as a URI fragment delimiter', () => {
    expect(encodeForMonacoPath('/tmp/a#b.ts')).toBe('/tmp/a%23b.ts')
  })

  it('percent-encodes a literal ? so it is not read as a URI query delimiter', () => {
    expect(encodeForMonacoPath('/tmp/a?b.ts')).toBe('/tmp/a%3Fb.ts')
  })

  it('encodes both # and ? in the same path', () => {
    expect(encodeForMonacoPath('/tmp/a#b?c.ts')).toBe('/tmp/a%23b%3Fc.ts')
  })

  it('leaves an ordinary path with no special characters unchanged', () => {
    expect(encodeForMonacoPath('/tmp/plain/file.ts')).toBe('/tmp/plain/file.ts')
  })

  it('leaves a literal space unchanged (Uri.parse handles bare spaces correctly)', () => {
    expect(encodeForMonacoPath('/tmp/a b.ts')).toBe('/tmp/a b.ts')
  })
})
