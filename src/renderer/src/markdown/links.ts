import { dirnamePath, isInsideRoot, joinPath } from './paths'

export type LinkClassification =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'navigate'; absPath: string; anchor?: string }
  | { kind: 'noop' }

/**
 * Classifies a clicked markdown link's href for MarkdownView's click
 * handler: http(s) links open externally; a bare "#id" scrolls to that
 * heading in the current document; an in-workspace relative link
 * navigates View Master to that file (optionally also scrolling to a
 * "#id" suffix once it renders); everything else (mailto:, links that
 * escape the workspace root, empty hrefs) is inert.
 */
export function classifyLinkHref(
  href: string,
  mdAbsPath: string,
  workspaceRoot: string
): LinkClassification {
  if (/^https?:\/\//i.test(href)) return { kind: 'external', url: href }
  if (href === '') return { kind: 'noop' }
  if (href.startsWith('#')) return { kind: 'anchor', id: href.slice(1) }
  // Any other URI scheme (mailto:, tel:, javascript:, data:, ...) is inert here.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return { kind: 'noop' }

  const hashIdx = href.indexOf('#')
  const pathPart = (hashIdx === -1 ? href : href.slice(0, hashIdx)).split('?')[0]
  const anchor = hashIdx === -1 ? undefined : href.slice(hashIdx + 1)
  if (pathPart === '') return { kind: 'noop' }

  const base = pathPart.startsWith('/') ? workspaceRoot : dirnamePath(mdAbsPath)
  const rel = pathPart.startsWith('/') ? pathPart.slice(1) : pathPart
  const resolved = joinPath(base, rel)

  if (!isInsideRoot(resolved, workspaceRoot)) return { kind: 'noop' }
  return anchor === undefined
    ? { kind: 'navigate', absPath: resolved }
    : { kind: 'navigate', absPath: resolved, anchor }
}
