import mermaid from 'mermaid'

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })

/**
 * Runs mermaid over any `pre.mermaid` marker nodes inside `container`
 * (emitted by render.ts's fence-rule override for ```mermaid fences).
 * Adds a `.mermaid-error` class to any node mermaid failed to turn into an
 * `<svg>`, matching the existing rendered-markdown CSS's error styling.
 * Shared by MarkdownView.tsx and MarkdownSideBySideView.tsx so mermaid's
 * one-time `initialize()` call happens exactly once regardless of which
 * component mounts first (ES module caching).
 */
export function runMermaidIn(container: HTMLElement): void {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>('pre.mermaid'))
  if (nodes.length === 0) return
  mermaid.run({ nodes, suppressErrors: true }).catch(() => {
    for (const node of nodes) {
      if (!node.querySelector('svg')) node.classList.add('mermaid-error')
    }
  })
}
