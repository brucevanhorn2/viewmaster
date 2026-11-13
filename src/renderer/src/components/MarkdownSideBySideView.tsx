// src/renderer/src/components/MarkdownSideBySideView.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdownToHtml } from '../markdown/render'
import { useDocumentPanZoom } from '../markdown/useDocumentPanZoom'
import { classifyLinkHref } from '../markdown/links'
import { scrollToId } from '../markdown/scrollToId'
import { resolveMarkdownImagesProgressive, type ImageResult } from '../markdown/images'
import RemoteImagesBar from './RemoteImagesBar'
import type { MarkdownImages } from './MarkdownView'

/** Renders one pane's markdown to HTML and runs mermaid over it once mounted. */
function usePaneHtml(
  source: string,
  pathKey: string,
  workspaceRoot: string,
  images: MarkdownImages
): [string, React.RefObject<HTMLDivElement | null>, React.RefObject<string | null>, string[]] {
  const ref = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState('')
  const [remoteInfo, setRemoteInfo] = useState<{ path: string; urls: string[] } | null>(null)
  const remoteUrls = remoteInfo?.path === pathKey ? remoteInfo.urls : NO_URLS
  const htmlForKey = useRef<string | null>(null)
  const { readLocal, readRemote, allowRemote } = images

  useEffect(() => {
    let stale = false
    // Interim loading-boxes render: leave htmlForKey unset so an anchor scroll waits for
    // the final layout.
    const show = (r: ImageResult, ready = true): void => {
      if (stale) return
      htmlForKey.current = ready ? pathKey : null
      setRemoteInfo({ path: pathKey, urls: r.remoteUrls })
      setHtml(r.html)
    }
    void renderMarkdownToHtml(source)
      .then((rendered) =>
        resolveMarkdownImagesProgressive(
          rendered,
          { docAbsPath: pathKey, workspaceRoot, readLocal, readRemote, allowRemote },
          (r) => show(r, false)
        ).catch((): ImageResult => ({ html: rendered, remoteUrls: [] }))
      )
      .then((r) => show(r))
    return () => {
      stale = true
    }
  }, [source, pathKey, workspaceRoot, readLocal, readRemote, allowRemote])

  useDocumentPanZoom(ref, html, pathKey)

  return [html, ref, htmlForKey, remoteUrls]
}

const NO_URLS: string[] = []

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
  onAnchorConsumed,
  oldImages,
  newImages
}: {
  baseContent: string
  content: string
  absPath: string
  workspaceRoot: string
  onNavigate: (absPath: string, anchor?: string) => void
  scrollToAnchor: string | null
  onAnchorConsumed: () => void
  oldImages: MarkdownImages
  newImages: MarkdownImages
}): React.JSX.Element {
  const [oldHtml, oldRef, , oldUrls] = usePaneHtml(baseContent, absPath, workspaceRoot, oldImages)
  const [newHtml, newRef, newHtmlForPath, newUrls] = usePaneHtml(
    content,
    absPath,
    workspaceRoot,
    newImages
  )
  // Stable prop objects (see MarkdownView): avoid innerHTML re-assignment on re-render.
  const oldInner = useMemo(() => ({ __html: oldHtml }), [oldHtml])
  const newInner = useMemo(() => ({ __html: newHtml }), [newHtml])
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
      window.secondLook.openExternal(classification.url)
    } else if (classification.kind === 'anchor') {
      scrollToId(newRef.current, classification.id)
    } else if (classification.kind === 'navigate') {
      onNavigate(classification.absPath, classification.anchor)
    }
  }

  return (
    <div className="markdown-sidebyside-wrap">
      {/* The same URL in both versions counts once. */}
      <RemoteImagesBar
        count={newImages.allowRemote ? 0 : new Set([...oldUrls, ...newUrls]).size}
        onLoad={newImages.onAllowRemote}
      />
      <div className="markdown-sidebyside">
        <div ref={oldScrollRef} className="markdown-sidebyside-pane">
          {/* Old-pane links are inert: this handler swallows anchor clicks (needed since a
            pan/zoom box inside a link re-enables pointer events), and the CSS
            pointer-events:none rule removes the link cursor/hover. */}
          <div
            ref={oldRef}
            className="markdown-body"
            dangerouslySetInnerHTML={oldInner}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('a')) e.preventDefault()
            }}
          />
        </div>
        <div ref={newScrollRef} className="markdown-sidebyside-pane markdown-sidebyside-pane-new">
          <div
            ref={newRef}
            className="markdown-body"
            onClick={onNewPaneClick}
            dangerouslySetInnerHTML={newInner}
          />
        </div>
      </div>
    </div>
  )
}
