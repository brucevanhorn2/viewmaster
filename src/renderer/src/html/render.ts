import DOMPurify from 'dompurify'
import { dirnamePath, joinPath } from './paths'

export type ResourceReader = (absPath: string) => Promise<{ base64: string; mime: string } | null>

const FORBIDDEN_TAGS = ['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'applet', 'form']

/**
 * Sanitizes a full HTML document, stripping every script-execution vector.
 * This — not Shadow DOM — is the feature's actual security boundary.
 */
export function sanitizeHtmlDocument(html: string): string {
  return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: FORBIDDEN_TAGS,
    // DOMPurify's default tag allowlist omits <link> even in WHOLE_DOCUMENT
    // mode (verified against node_modules/dompurify/dist/purify.js — it's
    // tuned for body-only fragments). External stylesheets need it kept.
    ADD_TAGS: ['link']
  })
}

function isEmbeddable(url: string): boolean {
  return !/^(https?:|data:)/i.test(url)
}

function decodeUtf8Base64(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
}

async function inlineCssUrls(
  css: string,
  cssAbsPath: string,
  readResource: ResourceReader
): Promise<string> {
  const matches = Array.from(css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g))
  let result = css
  for (const m of matches) {
    const raw = m[2]
    if (!isEmbeddable(raw)) continue
    const res = await readResource(joinPath(dirnamePath(cssAbsPath), raw))
    if (res) result = result.replace(m[0], `url("data:${res.mime};base64,${res.base64}")`)
  }
  return result
}

/**
 * Resolves relative img/link/style resource references in `html` to inlined
 * data: URIs, reading each through `readResource` (main-process disk reads,
 * never fetch). Call this BEFORE sanitizeHtmlDocument — this function parses
 * raw, unsanitized markup via DOMParser, which never executes embedded
 * scripts (parser-created script elements are inert, and this function only
 * ever hands back a string, never inserts the parsed document live).
 */
export async function resolveResources(
  html: string,
  htmlAbsPath: string,
  readResource: ResourceReader
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const dir = dirnamePath(htmlAbsPath)

  for (const el of Array.from(doc.querySelectorAll('img[src], source[src]'))) {
    const src = el.getAttribute('src')!
    if (!isEmbeddable(src)) continue
    const res = await readResource(joinPath(dir, src))
    if (res) el.setAttribute('src', `data:${res.mime};base64,${res.base64}`)
  }

  for (const styleEl of Array.from(doc.querySelectorAll('style'))) {
    styleEl.textContent = await inlineCssUrls(styleEl.textContent ?? '', htmlAbsPath, readResource)
  }

  for (const linkEl of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
    const href = linkEl.getAttribute('href')!
    if (!isEmbeddable(href)) continue
    const cssAbsPath = joinPath(dir, href)
    const res = await readResource(cssAbsPath)
    if (!res) continue
    const inlined = await inlineCssUrls(decodeUtf8Base64(res.base64), cssAbsPath, readResource)
    const styleEl = doc.createElement('style')
    styleEl.textContent = inlined
    linkEl.replaceWith(styleEl)
  }

  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const inlined = await inlineCssUrls(el.getAttribute('style') ?? '', htmlAbsPath, readResource)
    el.setAttribute('style', inlined)
  }

  return doc.documentElement.outerHTML
}
