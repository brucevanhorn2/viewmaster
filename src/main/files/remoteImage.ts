import { isImageMime, MAX_RESOURCE_SIZE } from './resource'

const FETCH_TIMEOUT_MS = 15_000

/**
 * Fetches a remote http(s) image and returns it base64-encoded. Null for any
 * other scheme, failed/non-ok responses, non-image content types, bodies over
 * the size cap, timeouts, or network errors.
 */
export async function fetchRemoteImage(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ base64: string; mime: string } | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (isPrivateHost(parsed.hostname)) return null

  try {
    const res = await fetchImpl(parsed.href, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!isImageMime(mime)) return null
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_RESOURCE_SIZE) return null
    const buf = await readCapped(res, MAX_RESOURCE_SIZE)
    if (!buf) return null
    return { base64: buf.toString('base64'), mime }
  } catch {
    return null
  }
}

/**
 * True for hosts a document's image URL must not reach: localhost names and IP literals in
 * loopback, private, link-local, CGNAT or unspecified ranges (IPv4, IPv6 and IPv4-mapped).
 * Stops a doc from making the user's machine GET routers or local services. A public name
 * that resolves to a private address isn't caught here.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const v4 = (s: string): number[] | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
    return m ? m.slice(1).map(Number) : null
  }
  const privateV4 = ([a, b]: number[]): boolean =>
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  const ip4 = v4(h)
  if (ip4) return privateV4(ip4)
  if (!h.includes(':')) return false
  if (h === '::' || h === '::1') return true
  const mapped = /^::ffff:(.+)$/.exec(h)
  if (mapped) {
    const inner = v4(mapped[1])
    if (inner) return privateV4(inner)
    // Hex form (::ffff:7f00:1): URL() normalizes mapped addresses to this.
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped[1])
    if (hex) {
      const hi = parseInt(hex[1], 16)
      return privateV4([hi >> 8, hi & 0xff])
    }
    return true
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)
}

/** Reads a response body, cancelling and returning null once it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return null
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}
