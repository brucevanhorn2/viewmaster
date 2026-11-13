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
 * loopback, private, link-local, CGNAT, multicast/broadcast or unspecified ranges. IPv6
 * literals are expanded, and IPv4 embedded in them (mapped, compatible, NAT64, 6to4) is
 * checked too. Stops a doc from making the user's machine GET routers or local services.
 * The remote-images session re-checks every request (redirects included) with this.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const ip4 = parseV4(h)
  if (ip4) return privateV4(ip4)
  if (!h.includes(':')) return false
  const g = parseV6(h)
  if (!g) return true // unparseable literal: refuse rather than guess
  const fromGroups = (hi: number, lo: number): number[] => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true // :: and ::1
  if (g.slice(0, 6).every((x) => x === 0)) return privateV4(fromGroups(g[6], g[7])) // ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4(fromGroups(g[6], g[7]))
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return privateV4(fromGroups(g[6], g[7])) // NAT64
  if (g[0] === 0x2002) return privateV4(fromGroups(g[1], g[2])) // 6to4
  return (
    (g[0] & 0xfe00) === 0xfc00 || // unique local
    (g[0] & 0xffc0) === 0xfe80 || // link-local
    (g[0] & 0xff00) === 0xff00 // multicast
  )
}

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const n = m.slice(1).map(Number)
  return n.every((x) => x <= 255) ? n : null
}

function privateV4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast, reserved, broadcast
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

/** Expands an IPv6 literal (optionally ending in dotted IPv4) to 8 groups; null if malformed. */
function parseV6(s: string): number[] | null {
  let tail: number[] = []
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (dotted) {
    const v4 = parseV4(dotted[2])
    if (!v4) return null
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
    s = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1)
  }
  const parts = s.split('::')
  if (parts.length > 2) return null
  const conv = (x: string): number[] | null => {
    if (x === '') return []
    const out: number[] = []
    for (const p of x.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null
      out.push(parseInt(p, 16))
    }
    return out
  }
  const head = conv(parts[0])
  const rest = parts.length === 2 ? conv(parts[1]) : []
  if (!head || !rest) return null
  const known = head.length + rest.length + tail.length
  if (parts.length === 1) return known === 8 ? [...head, ...tail] : null
  if (known > 7) return null
  return [...head, ...new Array(8 - known).fill(0), ...rest, ...tail]
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
