import mermaid from 'mermaid'

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })

let seq = 0
let queue: Promise<void> = Promise.resolve()

/**
 * Runs mermaid over any `pre.mermaid` marker nodes inside `container`
 * (emitted by render.ts's fence-rule override for ```mermaid fences).
 * Adds a `.mermaid-error` class to any node mermaid failed to turn into an
 * `<svg>`, matching the existing rendered-markdown CSS's error styling.
 * Shared by MarkdownView.tsx and MarkdownSideBySideView.tsx so mermaid's
 * one-time `initialize()` call happens exactly once regardless of which
 * component mounts first (ES module caching).
 *
 * Renders are given explicitly unique ids and serialized through a
 * module-level queue: mermaid.run()'s own Date.now()-derived ids can
 * collide when two containers are processed in the same tick (e.g.
 * MarkdownSideBySideView's two panes rendering mermaid fences in the same
 * React commit), and mermaid's internal DOM lookups during rendering are
 * not scoped to the container passed in -- a collision causes one diagram
 * to render into the wrong pane, or silently render blank. mermaid.render
 * also mutates global config via processAndSetConfigs, so truly concurrent
 * renders are unsafe independent of id collisions too. This serializes
 * mermaid rendering across every mounted markdown view in the app, not just
 * within one component -- accepted deliberately, since correctness (no id
 * collisions/corrupted diagrams) matters more than the render-time cost of
 * one extra concurrently-open view with diagrams.
 */
export function runMermaidIn(container: HTMLElement): void {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>('pre.mermaid'))
  if (nodes.length === 0) return
  queue = queue.then(async () => {
    for (const node of nodes) {
      if (node.dataset.mermaidProcessed) continue
      node.dataset.mermaidProcessed = 'true'
      const code = node.textContent ?? ''
      try {
        const { svg } = await mermaid.render(`vm-mermaid-${seq++}`, code)
        node.innerHTML = svg
      } catch {
        node.classList.add('mermaid-error')
      }
    }
  })
}
