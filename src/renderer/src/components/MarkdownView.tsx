// src/renderer/src/components/MarkdownView.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown, renderMarkdownToHtml, sanitizeHtml, escapeHtml } from '../markdown/render'
import { useDocumentPanZoom } from '../markdown/useDocumentPanZoom'
import { composeMarks } from '../markdown/marksDiff'
import { classifyLinkHref } from '../markdown/links'
import { scrollToId } from '../markdown/scrollToId'
import { resolveMarkdownImages } from '../markdown/images'
import type { ResourceReader } from '../html/render'
import RemoteImagesBar from './RemoteImagesBar'

export interface MarkdownImages {
  readLocal: ResourceReader
  readRemote: (url: string) => Promise<{ base64: string; mime: string } | null>
  allowRemote: boolean
  onAllowRemote: () => void
}

/**
 * Rendered markdown. When `baseContent` is a string (possibly ''), renders
 * editor's marks: the diff between baseContent and content shown inline in
 * the rendered output. `baseContent === null` → plain rendered view.
 */
export default function MarkdownView({
  content,
  baseContent = null,
  absPath,
  workspaceRoot,
  onNavigate,
  scrollToAnchor = null,
  onAnchorConsumed,
  images
}: {
  content: string
  baseContent?: string | null
  absPath: string
  workspaceRoot: string
  onNavigate: (absPath: string, anchor?: string) => void
  scrollToAnchor?: string | null
  onAnchorConsumed: () => void
  images: MarkdownImages
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState('')
  // Remote-image count is tagged with the path it was computed for, so a just-switched
  // file never shows the previous file's bar.
  const [remoteInfo, setRemoteInfo] = useState<{ path: string; count: number } | null>(null)
  const remoteCount = remoteInfo?.path === absPath ? remoteInfo.count : 0
  const { readLocal, readRemote, allowRemote, onAllowRemote } = images
  // Tracks which absPath the currently-rendered `html` state actually
  // belongs to. Since rendering is async, `html` can briefly still hold the
  // previous document's markup after `absPath` has already switched to a new
  // file — this ref lets consumers (e.g. the anchor-scroll effect below)
  // detect that gap instead of acting on stale DOM content.
  const htmlForPath = useRef<string | null>(null)

  useEffect(() => {
    let stale = false

    const render = async (): Promise<string> => {
      if (baseContent === null) return renderMarkdownToHtml(content)
      const [oldHtml, newHtml] = await Promise.all([
        renderMarkdown(baseContent),
        renderMarkdown(content)
      ])
      return sanitizeHtml(composeMarks(oldHtml, newHtml))
    }

    // Images resolve against the rendered HTML; a stale result (file/content/allowance
    // changed meanwhile) is discarded by the same flag as the render itself.
    const withImages = async (rendered: string): Promise<{ html: string; remoteCount: number }> => {
      try {
        return await resolveMarkdownImages(rendered, {
          docAbsPath: absPath,
          workspaceRoot,
          readLocal,
          readRemote,
          allowRemote
        })
      } catch {
        return { html: rendered, remoteCount: 0 }
      }
    }

    render()
      .then(withImages)
      .then((r) => {
        if (!stale) {
          htmlForPath.current = absPath
          setRemoteInfo({ path: absPath, count: r.remoteCount })
          setHtml(r.html)
        }
      })
      .catch(async (err: unknown) => {
        if (stale) return
        const message = err instanceof Error ? err.message : String(err)
        if (baseContent !== null) {
          // Marks composition failed — fall back to the plain rendered view.
          try {
            const plain = await withImages(await renderMarkdown(content))
            if (!stale) {
              htmlForPath.current = absPath
              setRemoteInfo({ path: absPath, count: plain.remoteCount })
              setHtml(`<p><em>Marks unavailable: ${escapeHtml(message)}</em></p>${plain.html}`)
            }
            return
          } catch {
            // fall through to the escaped-source fallback
          }
        }
        if (!stale) {
          htmlForPath.current = absPath
          setRemoteInfo({ path: absPath, count: 0 })
          setHtml(
            `<p><em>Markdown rendering failed: ${escapeHtml(message)}</em></p><pre><code>${escapeHtml(content)}</code></pre>`
          )
        }
      })

    return () => {
      stale = true
    }
  }, [content, baseContent, absPath, workspaceRoot, readLocal, readRemote, allowRemote])

  useDocumentPanZoom(ref, html, absPath)
  // Stable prop object: React 19 re-assigns innerHTML whenever this object changes,
  // which would wipe mermaid svgs and pan/zoom wrappers on every re-render.
  const innerHtml = useMemo(() => ({ __html: html }), [html])

  // Scroll to a heading requested by a cross-document navigation (set by
  // App.tsx's onNavigateToFile) once this document's content has rendered.
  useEffect(() => {
    if (!scrollToAnchor) return
    // Guard against acting on stale DOM: `html` may still hold the previous
    // document's markup while `absPath` has already moved to the file being
    // navigated to. Wait until htmlForPath confirms the current absPath's
    // content has actually rendered before attempting the scroll.
    if (htmlForPath.current !== absPath) return
    if (scrollToId(ref.current, scrollToAnchor)) onAnchorConsumed()
  }, [scrollToAnchor, html, absPath])

  const onClick = (e: React.MouseEvent): void => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    const classification = classifyLinkHref(href, absPath, workspaceRoot)
    if (classification.kind === 'external') {
      window.viewmaster.openExternal(classification.url)
    } else if (classification.kind === 'anchor') {
      scrollToId(ref.current, classification.id)
    } else if (classification.kind === 'navigate') {
      onNavigate(classification.absPath, classification.anchor)
    }
  }

  return (
    <div className="markdown-scroll">
      <RemoteImagesBar count={allowRemote ? 0 : remoteCount} onLoad={onAllowRemote} />
      <div
        ref={ref}
        className="markdown-body"
        onClick={onClick}
        dangerouslySetInnerHTML={innerHtml}
      />
    </div>
  )
}
