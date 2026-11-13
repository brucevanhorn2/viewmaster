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
}

/** Memoizes the read promise per key so concurrent and repeated calls share one read. */
export function cachedReader<K>(read: (k: K) => Promise<ImageData>): (k: K) => Promise<ImageData> {
  const cache = new Map<K, Promise<ImageData>>()
  return (k) => {
    let p = cache.get(k)
    if (!p) {
      p = read(k)
      cache.set(k, p)
    }
    return p
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const REMOTE = /^https?:/i
const ABSOLUTE = /^(\/|[A-Za-z]:\/)/

function placeholder(doc: Document, img: Element, src: string, remote: boolean): HTMLElement {
  const alt = img.getAttribute('alt') ?? ''
  const box = doc.createElement('span')
  box.className = remote ? 'md-img-missing md-img-remote' : 'md-img-missing'
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
): Promise<{ html: string; remoteCount: number }> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  let remoteCount = 0

  doc.querySelectorAll('source').forEach((s) => s.removeAttribute('srcset'))

  const jobs: Promise<void>[] = []
  doc.querySelectorAll('img').forEach((img) => {
    if (img.closest('pre.mermaid')) return
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')
    const src = (img.getAttribute('src') ?? '').trim()
    if (/^data:/i.test(src)) return

    const fail = (remote: boolean): void => img.replaceWith(placeholder(doc, img, src, remote))
    const succeed = (r: { base64: string; mime: string }): void =>
      img.setAttribute('src', `data:${r.mime};base64,${r.base64}`)

    if (REMOTE.test(src)) {
      remoteCount++
      if (!opts.allowRemote) {
        fail(true)
        return
      }
      jobs.push(safeRead(opts.readRemote, src).then((r) => (r ? succeed(r) : fail(true))))
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
    jobs.push(safeRead(opts.readLocal, abs).then((r) => (r ? succeed(r) : fail(false))))
  })

  await Promise.all(jobs)
  return { html: doc.body.innerHTML, remoteCount }
}
