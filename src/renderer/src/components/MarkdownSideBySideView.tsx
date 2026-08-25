// src/renderer/src/components/MarkdownSideBySideView.tsx
import { useEffect, useRef, useState } from 'react'
import { renderMarkdownToHtml } from '../markdown/render'
import { runMermaidIn } from '../markdown/mermaidRunner'
import { classifyLinkHref } from '../markdown/links'

/** Scrolls `id`'s element into view inside `container`, if it exists. Returns whether it was found. */
function scrollToId(container: HTMLElement | null, id: string): boolean {
  if (!container) return false
  const target = container.querySelector(`#${CSS.escape(id)}`)
  if (!target) return false
  target.scrollIntoView({ behavior: 'smooth' })
  return true
}

/** Renders one pane's markdown to HTML and runs mermaid over it once mounted. */
function usePaneHtml(source: string): [string, React.RefObject<HTMLDivElement | null>] {
  const ref = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState('')

  useEffect(() => {
    let stale = false
    void renderMarkdownToHtml(source).then((rendered) => {
      if (!stale) setHtml(rendered)
    })
    return () => {
      stale = true
    }
  }, [source])

  useEffect(() => {
    const container = ref.current
    if (!container || !html) return
    runMermaidIn(container)
  }, [html])

  return [html, ref]
}

/**
 * Renders `baseContent` and `content` as two independent, fully-rendered
 * markdown documents side by side, with synced scrolling. The old (base)
 * pane's links are deliberately inert -- a link's target may not exist, or
 * may mean something different, at the revision being shown there, and
 * letting it navigate via the current file tree would be misleading. The
 * new (compare) pane behaves identically to MarkdownView's plain Rendered
 * mode: full link interactivity, and it's the only pane wired to
 * scrollToAnchor/onAnchorConsumed (a cross-document navigation target
 * refers to the current revision, not a historical one).
 */
export default function MarkdownSideBySideView({
  baseContent,
  content,
  absPath,
  workspaceRoot,
  onNavigate,
  scrollToAnchor,
  onAnchorConsumed
}: {
  baseContent: string
  content: string
  absPath: string
  workspaceRoot: string
  onNavigate: (absPath: string, anchor?: string) => void
  scrollToAnchor: string | null
  onAnchorConsumed: () => void
}): React.JSX.Element {
  const [oldHtml, oldRef] = usePaneHtml(baseContent)
  const [newHtml, newRef] = usePaneHtml(content)
  const oldScrollRef = useRef<HTMLDivElement>(null)
  const newScrollRef = useRef<HTMLDivElement>(null)
  const isSyncingRef = useRef(false)

  useEffect(() => {
    const oldEl = oldScrollRef.current
    const newEl = newScrollRef.current
    if (!oldEl || !newEl) return

    const syncFrom = (source: HTMLElement, target: HTMLElement): void => {
      if (isSyncingRef.current) return
      const range = source.scrollHeight - source.clientHeight
      const fraction = range > 0 ? source.scrollTop / range : 0
      const targetRange = target.scrollHeight - target.clientHeight
      isSyncingRef.current = true
      target.scrollTop = fraction * targetRange
      isSyncingRef.current = false
    }

    const onOldScroll = (): void => syncFrom(oldEl, newEl)
    const onNewScroll = (): void => syncFrom(newEl, oldEl)
    oldEl.addEventListener('scroll', onOldScroll)
    newEl.addEventListener('scroll', onNewScroll)
    return () => {
      oldEl.removeEventListener('scroll', onOldScroll)
      newEl.removeEventListener('scroll', onNewScroll)
    }
  }, [])

  useEffect(() => {
    if (!scrollToAnchor) return
    if (scrollToId(newRef.current, scrollToAnchor)) onAnchorConsumed()
  }, [scrollToAnchor, newHtml])

  const onNewPaneClick = (e: React.MouseEvent): void => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    const classification = classifyLinkHref(href, absPath, workspaceRoot)
    if (classification.kind === 'external') {
      window.viewmaster.openExternal(classification.url)
    } else if (classification.kind === 'anchor') {
      scrollToId(newRef.current, classification.id)
    } else if (classification.kind === 'navigate') {
      onNavigate(classification.absPath, classification.anchor)
    }
  }

  return (
    <div className="markdown-sidebyside">
      <div ref={oldScrollRef} className="markdown-sidebyside-pane">
        <div ref={oldRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: oldHtml }} />
      </div>
      <div ref={newScrollRef} className="markdown-sidebyside-pane markdown-sidebyside-pane-new">
        <div
          ref={newRef}
          className="markdown-body"
          onClick={onNewPaneClick}
          dangerouslySetInnerHTML={{ __html: newHtml }}
        />
      </div>
    </div>
  )
}
