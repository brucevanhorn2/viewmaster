// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { sanitizeHtmlDocument, resolveResources, type ResourceReader } from './render'

describe('sanitizeHtmlDocument', () => {
  it('strips script tags', () => {
    const out = sanitizeHtmlDocument('<html><body><script>alert(1)</script><p>hi</p></body></html>')
    expect(out).not.toContain('<script')
    expect(out).toContain('<p>hi</p>')
  })

  it('strips inline event handler attributes', () => {
    const out = sanitizeHtmlDocument('<html><body><img src="a.png" onerror="alert(1)"></body></html>')
    expect(out).not.toContain('onerror')
  })

  it('strips javascript: URLs', () => {
    const out = sanitizeHtmlDocument('<html><body><a href="javascript:alert(1)">x</a></body></html>')
    expect(out).not.toContain('javascript:')
  })

  it('strips nested iframe/object/embed', () => {
    const out = sanitizeHtmlDocument(
      '<html><body><iframe src="x"></iframe><object data="y"></object><embed src="z"></body></html>'
    )
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<object')
    expect(out).not.toContain('<embed')
  })

  it('keeps style tags, link stylesheets, and class/id/inline-style attributes', () => {
    const out = sanitizeHtmlDocument(
      '<html><head><style>.a{color:red}</style><link rel="stylesheet" href="s.css"></head>' +
        '<body class="c" id="i" style="color:blue">hi</body></html>'
    )
    expect(out).toContain('<style>')
    expect(out).toContain('rel="stylesheet"')
    expect(out).toContain('class="c"')
    expect(out).toContain('id="i"')
    expect(out).toContain('style="color:blue"')
  })

  it('keeps map/area for image-map diagrams', () => {
    const out = sanitizeHtmlDocument(
      '<html><body><map name="m"><area shape="rect" coords="0,0,10,10" href="t.html"></map>' +
        '<img usemap="#m" src="d.png"></body></html>'
    )
    expect(out).toContain('<map')
    expect(out).toContain('<area')
  })
})

function fakeReader(map: Record<string, { base64: string; mime: string }>): ResourceReader {
  return async (absPath: string) => map[absPath] ?? null
}

describe('resolveResources', () => {
  it('inlines a relative img src as a data: URI', async () => {
    const html = '<html><body><img src="./logo.png"></body></html>'
    const reader = fakeReader({ '/w/logo.png': { base64: 'aGVsbG8=', mime: 'image/png' } })
    const out = await resolveResources(html, '/w/index.html', reader)
    expect(out).toContain('src="data:image/png;base64,aGVsbG8="')
  })

  it('leaves http(s) and existing data: srcs untouched, without calling the reader', async () => {
    const html =
      '<html><body><img src="https://example.com/a.png"><img src="data:image/png;base64,xx"></body></html>'
    const reader = vi.fn(async () => null)
    const out = await resolveResources(html, '/w/index.html', reader)
    expect(out).toContain('src="https://example.com/a.png"')
    expect(out).toContain('src="data:image/png;base64,xx"')
    expect(reader).not.toHaveBeenCalled()
  })

  it('leaves an unresolved reference exactly as the file wrote it', async () => {
    const html = '<html><body><img src="./missing.png"></body></html>'
    const out = await resolveResources(html, '/w/index.html', fakeReader({}))
    expect(out).toContain('src="./missing.png"')
  })

  it('inlines an external stylesheet as a <style> block, resolving its own url()', async () => {
    const html = '<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>'
    const cssBase64 = Buffer.from('.bg{background:url(img/bg.png)}', 'utf8').toString('base64')
    const reader = fakeReader({
      '/w/style.css': { base64: cssBase64, mime: 'text/css' },
      '/w/img/bg.png': { base64: 'Zm9v', mime: 'image/png' }
    })
    const out = await resolveResources(html, '/w/index.html', reader)
    expect(out).not.toContain('<link')
    expect(out).toContain('<style>')
    expect(out).toContain('url("data:image/png;base64,Zm9v")')
  })

  it('resolves url(...) inside inline style attributes', async () => {
    const html = '<html><body><div style="background:url(bg.png)"></div></body></html>'
    const reader = fakeReader({ '/w/bg.png': { base64: 'Zm9v', mime: 'image/png' } })
    const out = await resolveResources(html, '/w/index.html', reader)
    expect(out).toContain('url(&quot;data:image/png;base64,Zm9v&quot;)')
  })
})
