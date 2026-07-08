import htmldiff from 'node-htmldiff'

// htmldiff compares tag tokens by name only (attributes and atomic-tag
// content are ignored), so <pre> blocks are swapped for hash-keyed *text*
// tokens before diffing — text tokens diff reliably — and reinflated after.
const PRE_RE = /<pre[\s\S]*?<\/pre>/g
const TOKEN_RE = /vmblk([a-z0-9]+)/g

function hashOf(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function extractBlocks(html: string, blocks: Map<string, string>): string {
  return html.replace(PRE_RE, (block) => {
    const key = hashOf(block)
    blocks.set(key, block)
    return ` vmblk${key} `
  })
}

/** Is the offset inside an unclosed <ins> or <del> in the merged output? */
function contextAt(merged: string, offset: number): 'ins' | 'del' | null {
  const prefix = merged.slice(0, offset)
  const count = (re: RegExp): number => (prefix.match(re) ?? []).length
  if (count(/<del\b/g) > count(/<\/del>/g)) return 'del'
  if (count(/<ins\b/g) > count(/<\/ins>/g)) return 'ins'
  return null
}

/**
 * Merge two rendered-markdown HTML strings into one with editor's marks:
 * word-level <ins>/<del> in prose; whole <pre> blocks (shiki fences, mermaid
 * sources) are atomic — a changed block appears as the old block in a
 * `.vm-block-del` wrapper followed by the new block in `.vm-block-ins`.
 * Blocks are split out of the surrounding ins/del so inline strikethrough
 * never bleeds into block content.
 */
export function composeMarks(oldHtml: string, newHtml: string): string {
  const blocks = new Map<string, string>()
  const reducedOld = extractBlocks(oldHtml, blocks)
  const reducedNew = extractBlocks(newHtml, blocks)
  const merged = htmldiff(reducedOld, reducedNew)

  return merged.replace(TOKEN_RE, (match, key: string, offset: number) => {
    const block = blocks.get(key)
    if (!block) return match
    const context = contextAt(merged, offset)
    if (context === 'del') {
      return `</del><div class="vm-block vm-block-del">${block}</div><del>`
    }
    if (context === 'ins') {
      return `</ins><div class="vm-block vm-block-ins">${block}</div><ins>`
    }
    return block
  })
}
