import { describe, it, expect } from 'vitest'
import { rasterDataUrl, svgDataUrl } from './dataUrl'

describe('rasterDataUrl', () => {
  it('builds a base64 data: URL for the given MIME type', () => {
    expect(rasterDataUrl('image/png', 'aGVsbG8=')).toBe('data:image/png;base64,aGVsbG8=')
  })
})

describe('svgDataUrl', () => {
  it('percent-encodes SVG markup into a data: URL', () => {
    const svg = '<svg><circle r="1" fill="#fff"/></svg>'
    expect(svgDataUrl(svg)).toBe(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`)
  })

  it('encodes characters that would otherwise break the URL (# and &)', () => {
    const svg = '<svg><text>a &amp; b # c</text></svg>'
    const out = svgDataUrl(svg)
    expect(out).not.toContain('#c') // a raw '#' would be read as a URL fragment, truncating the SVG
    expect(out).toContain(encodeURIComponent('#'))
  })
})
