import { dirnamePath, isInsideRoot, joinPath } from './paths'

export type LinkClassification =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'navigate'; absPath: string; anchor?: string }
  | { kind: 'noop' }

/**
 * Percent-decodes a URI component, per markdown-it's canonical encoding of
 * link destinations (e.g. "My%20Notes.md", "%C3%BCber.md#%C3%9Cnder").
 * Returns null on a malformed percent-sequence instead of throwing, so
 * callers can treat that as an unresolvable link.
 */
function tryDecode(component: string): string | null {
  try {
    return decodeURIComponent(component)
  } catch {
    return null
  }
}

/**
 * Classifies a clicked markdown link's href for MarkdownView's click
 * handler: http(s) links open externally; a bare "#id" scrolls to that
 * heading in the current document; an in-workspace relative link
 * navigates View Master to that file (optionally also scrolling to a
 * "#id" suffix once it renders); everything else (mailto:, links that
 * escape the workspace root, empty hrefs) is inert.
 *
 * markdown-it percent-encodes hrefs (spaces, non-ASCII characters), so both
 * the path and fragment portions are decoded before resolution/containment
 * checks -- decoding after would let a percent-encoded traversal sequence
 * slip past isInsideRoot before it's decoded into the "../.." it represents.
 */
export function classifyLinkHref(
  href: string,
  mdAbsPath: string,
  workspaceRoot: string
): LinkClassification {
  if (/^https?:\/\//i.test(href)) return { kind: 'external', url: href }
  if (href === '') return { kind: 'noop' }
  if (href.startsWith('#')) {
    const decoded = tryDecode(href.slice(1))
    return decoded === null ? { kind: 'noop' } : { kind: 'anchor', id: decoded }
  }
  // Any other URI scheme (mailto:, tel:, javascript:, data:, ...) is inert here.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return { kind: 'noop' }

  const hashIdx = href.indexOf('#')
  const rawPathPart = (hashIdx === -1 ? href : href.slice(0, hashIdx)).split('?')[0]
  const rawAnchor = hashIdx === -1 ? undefined : href.slice(hashIdx + 1)
  if (rawPathPart === '') return { kind: 'noop' }

  const pathPart = tryDecode(rawPathPart)
  if (pathPart === null) return { kind: 'noop' }
  const decodedAnchor = rawAnchor === undefined ? undefined : tryDecode(rawAnchor)
  if (decodedAnchor === null) return { kind: 'noop' }
  const anchor = decodedAnchor

  const base = pathPart.startsWith('/') ? workspaceRoot : dirnamePath(mdAbsPath)
  const rel = pathPart.startsWith('/') ? pathPart.slice(1) : pathPart
  const resolved = joinPath(base, rel)

  if (!isInsideRoot(resolved, workspaceRoot)) return { kind: 'noop' }
  return anchor === undefined
    ? { kind: 'navigate', absPath: resolved }
    : { kind: 'navigate', absPath: resolved, anchor }
}
