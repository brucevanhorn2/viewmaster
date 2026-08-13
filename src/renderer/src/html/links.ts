import { dirnamePath, isInsideRoot, joinPath } from './paths'

export type LinkClassification =
  | { kind: 'external'; url: string }
  | { kind: 'navigate'; absPath: string }
  | { kind: 'noop' }

/**
 * Classifies a clicked <a>/<area> href for HtmlView's click handler:
 * http(s) links open externally, in-workspace relative links navigate
 * View Master to that file, everything else (anchors, mailto:, links that
 * escape the workspace root) is inert.
 */
export function classifyLinkHref(
  href: string,
  htmlAbsPath: string,
  workspaceRoot: string
): LinkClassification {
  if (/^https?:\/\//i.test(href)) return { kind: 'external', url: href }

  const withoutFragment = href.split('#')[0].split('?')[0]
  if (withoutFragment === '') return { kind: 'noop' }
  // Any other URI scheme (mailto:, tel:, javascript:, data:, ...) is inert here.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(withoutFragment)) return { kind: 'noop' }
  // Protocol-relative ("//host/path") inherits whatever scheme the page loads
  // under — it's an external URL, not a local path, even though it starts
  // with "/" like a workspace-root-relative href does below.
  if (withoutFragment.startsWith('//')) return { kind: 'external', url: `https:${withoutFragment}` }

  const base = withoutFragment.startsWith('/') ? workspaceRoot : dirnamePath(htmlAbsPath)
  const rel = withoutFragment.startsWith('/') ? withoutFragment.slice(1) : withoutFragment
  const resolved = joinPath(base, rel)

  return isInsideRoot(resolved, workspaceRoot) ? { kind: 'navigate', absPath: resolved } : { kind: 'noop' }
}
