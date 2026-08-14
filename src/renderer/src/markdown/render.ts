import MarkdownIt from 'markdown-it'
import markdownItShiki from '@shikijs/markdown-it'
import type { BundledLanguage } from 'shiki'
import DOMPurify from 'dompurify'
import { slugify } from './slug'

// Shiki accepts its built-in plain-text language at runtime, but the
// BundledLanguage type union omits it.
const PLAIN_TEXT = 'text' as unknown as BundledLanguage

let mdPromise: Promise<MarkdownIt> | null = null

async function getMd(): Promise<MarkdownIt> {
  if (!mdPromise) {
    mdPromise = (async () => {
      const md = new MarkdownIt({ html: true, linkify: true })
      md.use(
        await markdownItShiki({
          theme: 'dark-plus',
          fallbackLanguage: PLAIN_TEXT,
          defaultLanguage: PLAIN_TEXT
        })
      )

      // Mermaid fences bypass shiki: emit the raw source in a marker element
      // that MarkdownView hands to mermaid for diagram rendering.
      const highlightFence = md.renderer.rules.fence!
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        if (token.info.trim() === 'mermaid') {
          return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`
        }
        return highlightFence(tokens, idx, options, env, self)
      }

      // Give every heading a stable, GitHub-style id so "[Section](#section)"
      // links (and MarkdownView's anchor-click scroll) have something to
      // target. `state.env` is fresh per `md.render(src)` call (when the
      // caller doesn't pass its own), so a Map stashed there dedupes repeat
      // headings within one document without leaking across renders.
      md.core.ruler.push('heading-ids', (state) => {
        const seen: Map<string, number> = (state.env.headingSlugs ??= new Map())
        for (let i = 0; i < state.tokens.length; i++) {
          const token = state.tokens[i]
          if (token.type !== 'heading_open') continue
          const inline = state.tokens[i + 1]
          const text = inline?.children?.map((c) => c.content).join('') ?? ''
          token.attrSet('id', slugify(text, seen))
        }
      })

      return md
    })()
  }
  return mdPromise
}

/** Shared sanitizer for all rendered-markdown HTML paths. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html)
}

/** Render markdown to sanitized HTML (shiki-highlighted fences, mermaid markers, heading ids). */
export async function renderMarkdown(src: string): Promise<string> {
  const md = await getMd()
  return sanitizeHtml(md.render(src))
}
