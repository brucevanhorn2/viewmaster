import type { ResourceReader } from '../html/render'
import { dirnamePath, joinPath } from './paths'

type ImageData = { base64: string; mime: string } | null

export interface ImageResolveOptions {
  /** The .md file (may use backslashes). */
  docAbsPath: string
  workspaceRoot: string
  /** Receives forward-slash absolute paths. */
  readLocal: ResourceReader
  readRemote: (url: string) => Promise<ImageData>
  allowRemote: boolean
  /** Skip all reads: images that would be read become "loading" boxes instead. */
  deferLoads?: boolean
}

export interface ImageResult {
  html: string
  /** Distinct http(s) image URLs in the document (blocked or not). */
  remoteUrls: string[]
}

/**
 * Memoizes the read promise per key so concurrent and repeated calls share one read.
 * With `retryFailures`, a null/failed result is dropped from the cache once settled, so the
 * next render tries again (used for remote images, where failures are often transient).
 */
export function cachedReader<K>(
  read: (k: K) => Promise<ImageData>,
  { retryFailures = false }: { retryFailures?: boolean } = {}
): (k: K) => Promise<ImageData> {
  const cache = new Map<K, Promise<ImageData>>()
  return (k) => {
    let p = cache.get(k)
    if (!p) {
      const mine: Promise<ImageData> = read(k)
      p = mine
      cache.set(k, p)
      if (retryFailures) {
        const forget = (): void => {
          if (cache.get(k) === mine) cache.delete(k)
        }
        mine.then((r) => (r ? undefined : forget()), forget)
      }
    }
    return p
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const REMOTE = /^https?:/i
const ABSOLUTE = /^(\/|[A-Za-z]:\/)/

function placeholder(
  doc: Document,
  img: Element,
  src: string,
  remote: boolean,
  loading = false
): HTMLElement {
  const alt = img.getAttribute('alt') ?? ''
  const box = doc.createElement('span')
  box.className =
    'md-img-missing' + (remote ? ' md-img-remote' : '') + (loading ? ' md-img-loading' : '')
  box.setAttribute('role', 'img')
  box.setAttribute('aria-label', alt || src)
  if (alt) {
    const a = doc.createElement('span')
    a.className = 'md-img-missing-alt'
    a.textContent = alt
    box.appendChild(a)
  }
  const p = doc.createElement('span')
  p.className = 'md-img-missing-path'
  p.textContent = src
  box.appendChild(p)
  return box
}

function resolveLocalPath(src: string, opts: ImageResolveOptions): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(src.replace(/[?#].*$/s, ''))
  } catch {
    return null
  }
  decoded = decoded.replace(/\\/g, '/')
  const root = opts.workspaceRoot.replace(/\\/g, '/')
  const docDir = dirnamePath(opts.docAbsPath.replace(/\\/g, '/'))
  const joined = decoded.startsWith('/') ? joinPath(root, decoded) : joinPath(docDir, decoded)
  return ABSOLUTE.test(joined) ? joined : null
}

/** Image reads in flight at once per document (each can be up to 10 MB over IPC). */
const MAX_CONCURRENT_READS = 6

function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async (task) => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r))
    active++
    try {
      return await task()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

async function safeRead<K>(read: (k: K) => Promise<ImageData>, key: K): Promise<ImageData> {
  try {
    const r = await read(key)
    return r && r.mime.startsWith('image/') ? r : null
  } catch {
    return null
  }
}

export async function resolveMarkdownImages(
  html: string,
  opts: ImageResolveOptions
): Promise<ImageResult> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const remoteUrls = new Set<string>()

  doc.querySelectorAll('source').forEach((s) => s.removeAttribute('srcset'))

  const jobs: Promise<void>[] = []
  const limit = limiter(MAX_CONCURRENT_READS)
  doc.querySelectorAll('img').forEach((img) => {
    if (img.closest('pre.mermaid')) return
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')
    const src = (img.getAttribute('src') ?? '').trim()
    if (/^data:/i.test(src)) return

    const fail = (remote: boolean): void => img.replaceWith(placeholder(doc, img, src, remote))
    const succeed = (r: { base64: string; mime: string }): void =>
      img.setAttribute('src', `data:${r.mime};base64,${r.base64}`)
    const pending = (remote: boolean): void =>
      img.replaceWith(placeholder(doc, img, src, remote, true))

    if (REMOTE.test(src)) {
      remoteUrls.add(src)
      if (!opts.allowRemote) {
        fail(true)
        return
      }
      if (opts.deferLoads) {
        pending(true)
        return
      }
      jobs.push(limit(() => safeRead(opts.readRemote, src)).then((r) => (r ? succeed(r) : fail(true))))
      return
    }
    if (SCHEME.test(src) || src.startsWith('//') || src === '') {
      fail(false)
      return
    }
    const abs = resolveLocalPath(src, opts)
    if (!abs) {
      fail(false)
      return
    }
    if (opts.deferLoads) {
      pending(false)
      return
    }
    jobs.push(limit(() => safeRead(opts.readLocal, abs)).then((r) => (r ? succeed(r) : fail(false))))
  })

  await Promise.all(jobs)
  return { html: doc.body.innerHTML, remoteUrls: [...remoteUrls] }
}

/** How long image reads may take before the text is shown with "loading" boxes first. */
export const IMAGE_QUICK_MS = 150

/**
 * Resolves images, but never holds the document text back on slow reads: if they aren't
 * done within `quickMs`, `onPending` first gets a version whose images are loading boxes.
 * Warm caches (re-renders of the same document) finish in time and render once.
 */
export async function resolveMarkdownImagesProgressive(
  html: string,
  opts: ImageResolveOptions,
  onPending: (r: ImageResult) => void,
  quickMs = IMAGE_QUICK_MS
): Promise<ImageResult> {
  const full = resolveMarkdownImages(html, opts)
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<'slow'>((r) => {
    timer = setTimeout(() => r('slow'), quickMs)
  })
  const first = await Promise.race([full, slow])
  clearTimeout(timer)
  if (first !== 'slow') return first
  onPending(await resolveMarkdownImages(html, { ...opts, deferLoads: true }))
  return full
}
