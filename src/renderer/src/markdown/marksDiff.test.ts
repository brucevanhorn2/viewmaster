import { describe, it, expect } from 'vitest'
import { composeMarks } from './marksDiff'

const PRE_A = '<pre class="shiki"><code>const a = 1</code></pre>'
const PRE_B = '<pre class="shiki"><code>const b = 2</code></pre>'
const MERMAID_A = '<pre class="mermaid">flowchart LR\n A --> B</pre>'
const MERMAID_B = '<pre class="mermaid">flowchart LR\n A --> C</pre>'

describe('composeMarks', () => {
  it('marks inserted words with ins', () => {
    const out = composeMarks('<p>the cat sat</p>', '<p>the fat cat sat</p>')
    expect(out).toContain('<ins')
    expect(out).toMatch(/<ins[^>]*>\s*fat\s*<\/ins>/)
    expect(out).not.toContain('<del')
  })

  it('marks deleted words with del', () => {
    const out = composeMarks('<p>the fat cat sat</p>', '<p>the cat sat</p>')
    expect(out).toMatch(/<del[^>]*>\s*fat\s*<\/del>/)
  })

  it('passes an unchanged pre block through intact and unmarked', () => {
    const out = composeMarks(`<p>x</p>${PRE_A}`, `<p>x y</p>${PRE_A}`)
    expect(out).toContain(PRE_A)
    const preIdx = out.indexOf('<pre')
    expect(preIdx).toBeGreaterThan(-1)
    // the pre itself is not inside an unclosed ins/del
    expect(out.slice(0, preIdx)).not.toMatch(/<(ins|del)[^>]*>[^<]*$/)
  })

  it('shows a changed code block as old-removed then new-inserted', () => {
    const out = composeMarks(`<p>intro</p>${PRE_A}`, `<p>intro</p>${PRE_B}`)
    const delIdx = out.indexOf('const a = 1')
    const insIdx = out.indexOf('const b = 2')
    expect(delIdx).toBeGreaterThan(-1)
    expect(insIdx).toBeGreaterThan(delIdx)
    // old block wrapped in a removed-block container, new in an inserted one
    expect(out.slice(0, delIdx)).toMatch(/class="vm-block vm-block-del"[^]*$/)
    expect(out.slice(0, insIdx)).toMatch(/class="vm-block vm-block-ins"[^]*$/)
    // both complete blocks survive intact
    expect(out).toContain(PRE_A)
    expect(out).toContain(PRE_B)
  })

  it('treats mermaid blocks atomically', () => {
    const out = composeMarks(MERMAID_A, MERMAID_B)
    expect(out).toContain('A --> B') // old raw source preserved
    expect(out).toContain('A --> C')
    expect(out.match(/<pre class="mermaid">/g)?.length).toBe(2)
    expect(out).toContain('vm-block-del')
    expect(out).toContain('vm-block-ins')
  })

  it('marks everything inserted when the old side is empty (untracked file)', () => {
    const out = composeMarks('', '<p>brand new</p>')
    expect(out).toMatch(/<ins/)
    expect(out).not.toContain('<del')
  })

  it('returns unchanged content without marks', () => {
    const html = '<p>same</p>'
    expect(composeMarks(html, html)).not.toMatch(/<(ins|del)/)
  })
})
