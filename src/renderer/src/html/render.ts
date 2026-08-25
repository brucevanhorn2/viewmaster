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
  // Resolve every reference concurrently (the IPC round-trips are the cost);
  // apply the resulting string replacements afterward, in order, so the
  // "first remaining occurrence" trick that handles duplicate url(...) text
  // stays deterministic.
  const resolved = await Promise.all(
    matches.map(async (m) => {
      const raw = m[2]
      if (!isEmbeddable(raw)) return null
      const res = await readResource(joinPath(dirnamePath(cssAbsPath), raw))
      return res ? { match: m[0], mime: res.mime, base64: res.base64 } : null
    })
  )
  let result = css
  for (const r of resolved) {
    if (r) result = result.replace(r.match, `url("data:${r.mime};base64,${r.base64}")`)
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

  // Each loop below resolves independent elements, so every element in a
  // pass runs concurrently — only elements *within* the same pass race each
  // other; the passes themselves stay sequential since a later pass (e.g.
  // inline style="" attributes) may depend on nothing from an earlier one,
  // but keeping them in this order matches the document's own structure.
  await Promise.all(
    Array.from(doc.querySelectorAll('img[src], source[src]')).map(async (el) => {
      const src = el.getAttribute('src')!
      if (!isEmbeddable(src)) return
      const res = await readResource(joinPath(dir, src))
      if (res) el.setAttribute('src', `data:${res.mime};base64,${res.base64}`)
    })
  )

  await Promise.all(
    Array.from(doc.querySelectorAll('style')).map(async (styleEl) => {
      styleEl.textContent = await inlineCssUrls(styleEl.textContent ?? '', htmlAbsPath, readResource)
    })
  )

  await Promise.all(
    Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]')).map(async (linkEl) => {
      const href = linkEl.getAttribute('href')!
      if (!isEmbeddable(href)) return
      const cssAbsPath = joinPath(dir, href)
      const res = await readResource(cssAbsPath)
      if (!res) return
      const inlined = await inlineCssUrls(decodeUtf8Base64(res.base64), cssAbsPath, readResource)
      const styleEl = doc.createElement('style')
      styleEl.textContent = inlined
      linkEl.replaceWith(styleEl)
    })
  )

  await Promise.all(
    Array.from(doc.querySelectorAll('[style]')).map(async (el) => {
      const inlined = await inlineCssUrls(el.getAttribute('style') ?? '', htmlAbsPath, readResource)
      el.setAttribute('style', inlined)
    })
  )

  return doc.documentElement.outerHTML
}
