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
