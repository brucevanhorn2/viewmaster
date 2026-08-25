// src/renderer/src/components/MarkdownView.tsx
import { useEffect, useRef, useState } from 'react'
import { renderMarkdown, renderMarkdownToHtml, sanitizeHtml } from '../markdown/render'
import { runMermaidIn } from '../markdown/mermaidRunner'
import { composeMarks } from '../markdown/marksDiff'
import { classifyLinkHref } from '../markdown/links'

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Scrolls `id`'s element into view inside `container`, if it exists. Returns whether it was found. */
function scrollToId(container: HTMLElement | null, id: string): boolean {
  if (!container) return false
  const target = container.querySelector(`#${CSS.escape(id)}`)
  if (!target) return false
  target.scrollIntoView({ behavior: 'smooth' })
  return true
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
  onAnchorConsumed
}: {
  content: string
  baseContent?: string | null
  absPath: string
  workspaceRoot: string
  onNavigate: (absPath: string, anchor?: string) => void
  scrollToAnchor?: string | null
  onAnchorConsumed: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState('')
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

    render()
      .then((rendered) => {
        if (!stale) {
          htmlForPath.current = absPath
          setHtml(rendered)
        }
      })
      .catch(async (err: unknown) => {
        if (stale) return
        const message = err instanceof Error ? err.message : String(err)
        if (baseContent !== null) {
          // Marks composition failed — fall back to the plain rendered view.
          try {
            const plain = await renderMarkdown(content)
            if (!stale) {
              htmlForPath.current = absPath
              setHtml(`<p><em>Marks unavailable: ${escape(message)}</em></p>${plain}`)
            }
            return
          } catch {
            // fall through to the escaped-source fallback
          }
        }
        if (!stale) {
          htmlForPath.current = absPath
          setHtml(
            `<p><em>Markdown rendering failed: ${escape(message)}</em></p><pre><code>${escape(content)}</code></pre>`
          )
        }
      })

    return () => {
      stale = true
    }
  }, [content, baseContent, absPath])

  useEffect(() => {
    const container = ref.current
    if (!container || !html) return
    runMermaidIn(container)
  }, [html])

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
      <div
        ref={ref}
        className="markdown-body"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
