import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { renderMarkdown } from '../markdown/render'

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })

export default function MarkdownView({ content }: { content: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState('')

  useEffect(() => {
    let stale = false
    void renderMarkdown(content).then((rendered) => {
      if (!stale) setHtml(rendered)
    })
    return () => {
      stale = true
    }
  }, [content])

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
