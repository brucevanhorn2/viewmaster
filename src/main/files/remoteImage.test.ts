import { describe, it, expect, vi } from 'vitest'
import { fetchRemoteImage } from './remoteImage'

function fakeFetch(body: Uint8Array, init: { status?: number; type?: string; headers?: Record<string, string> } = {}) {
  return vi.fn(async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: { 'content-type': init.type ?? 'image/png', ...(init.headers ?? {}) }
    })
  ) as unknown as typeof fetch
}

describe('fetchRemoteImage', () => {
  it('fetchRemoteImage inlines an image response', async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const res = await fetchRemoteImage(
      'https://example.com/a.png',
      fakeFetch(body, { type: 'image/png; charset=binary' })
    )
    expect(res).toEqual({ mime: 'image/png', base64: Buffer.from(body).toString('base64') })
  })

  it('fetchRemoteImage rejects non-image', async () => {
    const body = new Uint8Array([1])
    expect(await fetchRemoteImage('https://e.com/x', fakeFetch(body, { type: 'text/html' }))).toBeNull()
    expect(await fetchRemoteImage('https://e.com/x', fakeFetch(body, { status: 404 }))).toBeNull()
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    expect(await fetchRemoteImage('https://e.com/x', fakeFetch(big))).toBeNull()
  })

  it('fetchRemoteImage rejects when content-length exceeds the cap', async () => {
    const f = fakeFetch(new Uint8Array([1]), { headers: { 'content-length': String(10 * 1024 * 1024 + 1) } })
    expect(await fetchRemoteImage('https://e.com/x', f)).toBeNull()
  })

  it('fetchRemoteImage returns null when fetch throws', async () => {
    const f = vi.fn(async () => { throw new Error('boom') }) as unknown as typeof fetch
    expect(await fetchRemoteImage('https://e.com/x', f)).toBeNull()
  })

  it('fetchRemoteImage refuses non-http schemes', async () => {
    const f = fakeFetch(new Uint8Array([1]))
    expect(await fetchRemoteImage('file:///etc/passwd', f)).toBeNull()
    expect(await fetchRemoteImage('data:image/png;base64,AAAA', f)).toBeNull()
    expect(await fetchRemoteImage('not a url', f)).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })
})
