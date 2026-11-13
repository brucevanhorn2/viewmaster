// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { cachedReader, resolveMarkdownImages, type ImageResolveOptions } from './images'

const OK = { base64: 'QUJD', mime: 'image/svg+xml' }

function setup(over: Partial<ImageResolveOptions> = {}) {
  const readLocal = vi.fn(async (_p: string) => OK as { base64: string; mime: string } | null)
  const readRemote = vi.fn(async (_u: string) => ({ base64: 'UkVN', mime: 'image/png' }) as { base64: string; mime: string } | null)
  const opts: ImageResolveOptions = {
    docAbsPath: 'C:\\r\\docs\\a.md',
    workspaceRoot: 'C:\\r',
    readLocal,
    readRemote,
    allowRemote: false,
    ...over
  }
  return { opts, readLocal, readRemote }
}

function dom(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

describe('resolveMarkdownImages', () => {
  it('resolves relative to the document folder', async () => {
    const { opts, readLocal } = setup()
    const out = await resolveMarkdownImages('<img src="img/f.svg">', opts)
    expect(readLocal).toHaveBeenCalledWith('C:/r/docs/img/f.svg')
    expect(dom(out.html).querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,QUJD$/)
  })

  it('leading slash resolves from the folder root', async () => {
    const { opts, readLocal } = setup()
    await resolveMarkdownImages('<img src="/docs/c.png">', opts)
    expect(readLocal).toHaveBeenCalledWith('C:/r/docs/c.png')
  })

  it('decodes before resolving', async () => {
    const { opts, readLocal } = setup()
    await resolveMarkdownImages('<img src="d%20e.png">', opts)
    expect(readLocal).toHaveBeenCalledWith('C:/r/docs/d e.png')
    const bad = setup()
    const out = await resolveMarkdownImages('<img src="%E0%A4%A">', bad.opts)
    expect(bad.readLocal).not.toHaveBeenCalled()
    expect(dom(out.html).querySelector('.md-img-missing')).not.toBeNull()
  })

  it('strips query and hash', async () => {
    const { opts, readLocal } = setup()
    await resolveMarkdownImages('<img src="x.png?v=1#frag">', opts)
    expect(readLocal).toHaveBeenCalledWith('C:/r/docs/x.png')
  })

  it('missing local image becomes a placeholder with alt and path', async () => {
    const { opts, readLocal } = setup()
    readLocal.mockResolvedValue(null)
    const out = await resolveMarkdownImages('<p><img alt="Flow" src="x.png"></p>', opts)
    const d = dom(out.html)
    expect(d.querySelector('img')).toBeNull()
    const ph = d.querySelector('.md-img-missing')!
    expect(ph.classList.contains('md-img-remote')).toBe(false)
    expect(ph.getAttribute('role')).toBe('img')
    expect(ph.getAttribute('aria-label')).toBe('Flow')
    expect(ph.querySelector('.md-img-missing-alt')!.textContent).toBe('Flow')
    expect(ph.querySelector('.md-img-missing-path')!.textContent).toBe('x.png')
  })

  it('omits the alt span when alt is empty and labels with src', async () => {
    const { opts, readLocal } = setup()
    readLocal.mockResolvedValue(null)
    const out = await resolveMarkdownImages('<img src="x.png">', opts)
    const ph = dom(out.html).querySelector('.md-img-missing')!
    expect(ph.querySelector('.md-img-missing-alt')).toBeNull()
    expect(ph.getAttribute('aria-label')).toBe('x.png')
  })

  it('keeps alt, title, width and height on success', async () => {
    const { opts } = setup()
    const out = await resolveMarkdownImages('<img src="a.png" alt="A" title="T" width="10" height="20">', opts)
    const img = dom(out.html).querySelector('img')!
    expect(img.getAttribute('alt')).toBe('A')
    expect(img.getAttribute('title')).toBe('T')
    expect(img.getAttribute('width')).toBe('10')
    expect(img.getAttribute('height')).toBe('20')
  })

  it('remote images are counted and blocked unless allowed', async () => {
    const html = '<img src="https://e.com/a.png"><img src="http://e.com/b.png"><img src="l.png">'
    const blocked = setup()
    const out = await resolveMarkdownImages(html, blocked.opts)
    expect(out.remoteCount).toBe(2)
    expect(dom(out.html).querySelectorAll('.md-img-remote').length).toBe(2)
    expect(blocked.readRemote).not.toHaveBeenCalled()

    const allowed = setup({ allowRemote: true })
    const out2 = await resolveMarkdownImages(html, allowed.opts)
    expect(allowed.readRemote).toHaveBeenCalledTimes(2)
    expect(out2.remoteCount).toBe(2)
    const srcs = [...dom(out2.html).querySelectorAll('img')].map((i) => i.getAttribute('src'))
    expect(srcs.every((s) => s!.startsWith('data:'))).toBe(true)
    expect(dom(out2.html).querySelector('.md-img-missing')).toBeNull()
  })

  it('failed remote read gives a remote placeholder', async () => {
    const { opts, readRemote } = setup({ allowRemote: true })
    readRemote.mockResolvedValue(null)
    const out = await resolveMarkdownImages('<img src="https://e.com/a.png">', opts)
    expect(dom(out.html).querySelector('.md-img-missing.md-img-remote')).not.toBeNull()
  })

  it('other schemes become placeholders without reads', async () => {
    const { opts, readLocal, readRemote } = setup({ allowRemote: true })
    const out = await resolveMarkdownImages(
      '<img src="file:///etc/x.png"><img src="javascript:alert(1)"><img src="//host/x.png">',
      opts
    )
    expect(readLocal).not.toHaveBeenCalled()
    expect(readRemote).not.toHaveBeenCalled()
    expect(dom(out.html).querySelectorAll('.md-img-missing').length).toBe(3)
  })

  it('strips srcset', async () => {
    const { opts } = setup()
    const out = await resolveMarkdownImages(
      '<img src="a.png" srcset="https://t/x.png 2x" sizes="10px"><picture><source srcset="https://t/y.png"><img src="a.png"></picture>',
      opts
    )
    expect(out.html).not.toContain('srcset')
    expect(out.html).not.toContain('sizes')
  })

  it('reads each distinct path once', async () => {
    const { opts, readLocal } = setup()
    const cached = cachedReader(opts.readLocal)
    await resolveMarkdownImages('<img src="a.png"><img src="a.png"><img src="a.png">', { ...opts, readLocal: cached })
    expect(readLocal).toHaveBeenCalledTimes(1)
  })

  it('leaves data: images and mermaid blocks alone', async () => {
    const { opts, readLocal } = setup()
    const out = await resolveMarkdownImages(
      '<img src="data:image/png;base64,AAAA"><pre class="mermaid"><img src="x.png"></pre>',
      opts
    )
    expect(readLocal).not.toHaveBeenCalled()
    const d = dom(out.html)
    expect(d.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(d.querySelector('pre.mermaid img')!.getAttribute('src')).toBe('x.png')
  })

  it('treats a non-image mime as failure', async () => {
    const { opts, readLocal } = setup()
    readLocal.mockResolvedValue({ base64: 'QUJD', mime: 'text/html' })
    const out = await resolveMarkdownImages('<img src="a.png">', opts)
    const d = dom(out.html)
    expect(d.querySelector('img')).toBeNull()
    expect(d.querySelector('.md-img-missing')).not.toBeNull()
  })

  it('treats a throwing reader as failure', async () => {
    const { opts, readLocal } = setup()
    readLocal.mockRejectedValue(new Error('boom'))
    const out = await resolveMarkdownImages('<img src="a.png">', opts)
    expect(dom(out.html).querySelector('.md-img-missing')).not.toBeNull()
  })

  it('placeholders when a relative path escapes the drive root', async () => {
    const { opts, readLocal } = setup({ docAbsPath: 'C:\\r\\docs\\a.md' })
    const out = await resolveMarkdownImages('<img src="../../../x.png">', opts)
    expect(readLocal).not.toHaveBeenCalled()
    expect(dom(out.html).querySelector('.md-img-missing')).not.toBeNull()
  })
})

describe('cachedReader', () => {
  it('shares one in-flight promise per key', async () => {
    const read = vi.fn(async (k: string) => ({ base64: k, mime: 'image/png' }))
    const c = cachedReader(read)
    const [a, b] = await Promise.all([c('x'), c('x')])
    await c('y')
    expect(a).toBe(b)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
