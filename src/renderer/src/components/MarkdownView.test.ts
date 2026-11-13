// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('../markdown/render', () => ({
  renderMarkdown: async () => '<p id="p">hello</p>',
  renderMarkdownToHtml: async () => '<p id="p">hello</p>',
  sanitizeHtml: (s: string) => s,
  escapeHtml: (s: string) => s
}))
vi.mock('../markdown/mermaidRunner', () => ({ runMermaidIn: async () => {} }))

import MarkdownView from './MarkdownView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('MarkdownView', () => {
  it('does not replace rendered DOM when re-rendered with unchanged html', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const props = {
      content: '# x',
      absPath: '/a.md',
      workspaceRoot: '/',
      onNavigate: () => {},
      scrollToAnchor: null,
      onAnchorConsumed: () => {}
    }
    await act(async () => root!.render(createElement(MarkdownView, props)))
    const p = host.querySelector('#p')!
    expect(p).toBeTruthy()
    p.setAttribute('data-mark', '1')
    // Same html, new props object -> re-render
    await act(async () => root!.render(createElement(MarkdownView, { ...props })))
    expect(host.querySelector('#p')).toBe(p)
    expect(host.querySelector('#p')!.getAttribute('data-mark')).toBe('1')
  })
})
