import MarkdownIt from 'markdown-it'
import markdownItShiki from '@shikijs/markdown-it'
import type { BundledLanguage } from 'shiki'
import DOMPurify from 'dompurify'

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

      return md
    })()
  }
  return mdPromise
}

/** Render markdown to sanitized HTML (shiki-highlighted fences, mermaid markers). */
export async function renderMarkdown(src: string): Promise<string> {
  const md = await getMd()
  return DOMPurify.sanitize(md.render(src))
}
