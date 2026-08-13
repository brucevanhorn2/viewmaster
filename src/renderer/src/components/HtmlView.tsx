import { useEffect, useRef } from 'react'
import { resolveResources, sanitizeHtmlDocument } from '../html/render'
import { classifyLinkHref } from '../html/links'

export default function HtmlView({
  content,
  absPath,
  workspaceRoot,
  onNavigate
}: {
  content: string
  absPath: string
  workspaceRoot: string
  onNavigate: (absPath: string) => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const propsRef = useRef({ absPath, workspaceRoot, onNavigate })
  propsRef.current = { absPath, workspaceRoot, onNavigate }

  // Create the shadow root and its click listener exactly once per mount.
  // The listener reads live prop values via propsRef so it never needs to
  // be re-attached (and never double-attached) as files/props change.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })

    const onClick = (e: Event): void => {
      const anchor = (e.target as HTMLElement).closest('a, area')
      const href = anchor?.getAttribute('href')
      if (!anchor || href === null || href === undefined) return
      e.preventDefault()
      const current = propsRef.current
      const classification = classifyLinkHref(href, current.absPath, current.workspaceRoot)
      if (classification.kind === 'external') window.viewmaster.openExternal(classification.url)
      else if (classification.kind === 'navigate') current.onNavigate(classification.absPath)
    }

    shadow.addEventListener('click', onClick)
    return () => shadow.removeEventListener('click', onClick)
  }, [])

  // Re-render sanitized content whenever the selected file (or its
  // resolved resources) changes.
  useEffect(() => {
    const host = hostRef.current
    if (!host?.shadowRoot) return
    let stale = false

    void (async () => {
      const resolved = await resolveResources(content, absPath, window.viewmaster.readResource)
      const sanitized = sanitizeHtmlDocument(resolved)
      if (!stale && host.shadowRoot) host.shadowRoot.innerHTML = sanitized
    })()

    return () => {
      stale = true
    }
  }, [content, absPath])

  return <div ref={hostRef} className="html-scroll" />
}
