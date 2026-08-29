// src/renderer/src/components/MarkdownSideBySideView.tsx
import { useEffect, useRef, useState } from 'react'
import { renderMarkdownToHtml } from '../markdown/render'
import { runMermaidIn } from '../markdown/mermaidRunner'
import { classifyLinkHref } from '../markdown/links'
import { scrollToId } from '../markdown/scrollToId'

/** Renders one pane's markdown to HTML and runs mermaid over it once mounted. */
function usePaneHtml(
  source: string,
  pathKey: string
): [string, React.RefObject<HTMLDivElement | null>, React.RefObject<string | null>] {
  const ref = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState('')
  const htmlForKey = useRef<string | null>(null)

  useEffect(() => {
    let stale = false
    void renderMarkdownToHtml(source).then((rendered) => {
      if (!stale) {
        htmlForKey.current = pathKey
        setHtml(rendered)
      }
    })
    return () => {
      stale = true
    }
  }, [source, pathKey])

  useEffect(() => {
    const container = ref.current
    if (!container || !html) return
    runMermaidIn(container)
  }, [html])

  return [html, ref, htmlForKey]
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
  const [oldHtml, oldRef] = usePaneHtml(baseContent, absPath)
  const [newHtml, newRef, newHtmlForPath] = usePaneHtml(content, absPath)
  const oldScrollRef = useRef<HTMLDivElement>(null)
  const newScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const oldEl = oldScrollRef.current
    const newEl = newScrollRef.current
    if (!oldEl || !newEl) return

    const ignoreNextOldScroll = { current: false }
    const ignoreNextNewScroll = { current: false }
    const lastFraction = { current: 0 }

    // Only writes scrollTop (and arms the echo-ignore flag) when the write
    // would actually move the pane -- if the target is already at the
    // computed position, no 'scroll' event will fire for it, so arming the
    // flag here would leave it stuck true and incorrectly swallow the
    // target's next genuine scroll.
    const applyFraction = (
      fraction: number,
      target: HTMLElement,
      ignoreFlag: { current: boolean }
    ): void => {
      const targetRange = target.scrollHeight - target.clientHeight
      if (targetRange <= 0) return
      const nextTop = fraction * targetRange
      if (Math.abs(target.scrollTop - nextTop) < 1) return
      ignoreFlag.current = true
      target.scrollTop = nextTop
    }

    const syncFrom = (
      source: HTMLElement,
      target: HTMLElement,
      targetIgnoreFlag: { current: boolean }
    ): void => {
      const range = source.scrollHeight - source.clientHeight
      const fraction = range > 0 ? source.scrollTop / range : 0
      lastFraction.current = fraction
      applyFraction(fraction, target, targetIgnoreFlag)
    }

    const onOldScroll = (): void => {
      if (ignoreNextOldScroll.current) {
        ignoreNextOldScroll.current = false
        return
      }
      syncFrom(oldEl, newEl, ignoreNextNewScroll)
    }
    const onNewScroll = (): void => {
      if (ignoreNextNewScroll.current) {
        ignoreNextNewScroll.current = false
        return
      }
      syncFrom(newEl, oldEl, ignoreNextOldScroll)
    }
    oldEl.addEventListener('scroll', onOldScroll)
    newEl.addEventListener('scroll', onNewScroll)

    // Re-apply the last-known scroll fraction whenever a pane's rendered
    // content changes size (e.g. a mermaid diagram swapping in for its
    // placeholder well after the initial render) -- otherwise the two
    // panes silently fall out of alignment with nothing to re-trigger a
    // sync, since the effect above only fires on user-driven scroll.
    const onOldResize = (): void => applyFraction(lastFraction.current, oldEl, ignoreNextOldScroll)
    const onNewResize = (): void => applyFraction(lastFraction.current, newEl, ignoreNextNewScroll)
    const oldResizeObserver = new ResizeObserver(onOldResize)
    const newResizeObserver = new ResizeObserver(onNewResize)
    if (oldRef.current) oldResizeObserver.observe(oldRef.current)
    if (newRef.current) newResizeObserver.observe(newRef.current)

    return () => {
      oldEl.removeEventListener('scroll', onOldScroll)
      newEl.removeEventListener('scroll', onNewScroll)
      oldResizeObserver.disconnect()
      newResizeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!scrollToAnchor) return
    // Guard against acting on stale DOM: `newHtml` may still hold the previous
    // document's markup while `absPath` has already moved to the file being
    // navigated to. Wait until newHtmlForPath confirms the current absPath's
    // content has actually rendered before attempting the scroll.
    if (newHtmlForPath.current !== absPath) return
    if (scrollToId(newRef.current, scrollToAnchor)) onAnchorConsumed()
  }, [scrollToAnchor, newHtml, absPath])

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
        {/* No onClick handler here -- this omission is the actual enforcement that
            old-pane links are inert; the CSS pointer-events:none rule is only for
            visual affordance (no cursor/hover), not the mechanism itself. */}
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
