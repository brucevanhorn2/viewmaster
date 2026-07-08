import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { renderMarkdown, sanitizeHtml } from '../markdown/render'
import { composeMarks } from '../markdown/marksDiff'

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Rendered markdown. When `baseContent` is a string (possibly ''), renders
 * editor's marks: the diff between baseContent and content shown inline in
 * the rendered output. `baseContent === null` → plain rendered view.
 */
export default function MarkdownView({
  content,
  baseContent = null
}: {
  content: string
  baseContent?: string | null
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState('')

  useEffect(() => {
    let stale = false

    const render = async (): Promise<string> => {
      if (baseContent === null) return renderMarkdown(content)
      const [oldHtml, newHtml] = await Promise.all([
        renderMarkdown(baseContent),
        renderMarkdown(content)
      ])
      return sanitizeHtml(composeMarks(oldHtml, newHtml))
    }

    render()
      .then((rendered) => {
        if (!stale) setHtml(rendered)
      })
      .catch(async (err: unknown) => {
        if (stale) return
        const message = err instanceof Error ? err.message : String(err)
        if (baseContent !== null) {
          // Marks composition failed — fall back to the plain rendered view.
          try {
            const plain = await renderMarkdown(content)
            if (!stale) setHtml(`<p><em>Marks unavailable: ${escape(message)}</em></p>${plain}`)
            return
          } catch {
            // fall through to the escaped-source fallback
          }
        }
        if (!stale) {
          setHtml(
            `<p><em>Markdown rendering failed: ${escape(message)}</em></p><pre><code>${escape(content)}</code></pre>`
          )
        }
      })

    return () => {
      stale = true
    }
  }, [content, baseContent])

  useEffect(() => {
    const container = ref.current
    if (!container || !html) return
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('pre.mermaid'))
    if (nodes.length === 0) return
    mermaid.run({ nodes, suppressErrors: true }).catch(() => {
      for (const node of nodes) {
        if (!node.querySelector('svg')) node.classList.add('mermaid-error')
      }
    })
  }, [html])

  // All hyperlinks open in the default browser; no in-app navigation.
  const onClick = (e: React.MouseEvent): void => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:\/\//.test(href)) window.viewmaster.openExternal(href)
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
