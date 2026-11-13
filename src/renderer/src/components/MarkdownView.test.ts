// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const mdHtml = vi.hoisted(() => ({ value: '<p id="p">hello</p>' }))
vi.mock('../markdown/render', () => ({
  renderMarkdown: async () => mdHtml.value,
  renderMarkdownToHtml: async () => mdHtml.value,
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
      onAnchorConsumed: () => {},
      images: {
        readLocal: async () => null,
        readRemote: async () => null,
        allowRemote: false,
        onAllowRemote: () => {}
      }
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

describe('MarkdownView images', () => {
  it('resolves local images, blocks remote until allowed', async () => {
    mdHtml.value = '<p><img src="a.png" alt="A"><img src="https://t/b.png"></p>'
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const readLocal = vi.fn(async () => ({ base64: 'AAAA', mime: 'image/png' }))
    const readRemote = vi.fn(async () => ({ base64: 'BBBB', mime: 'image/png' }))
    const onAllowRemote = vi.fn()
    const mk = (allowRemote: boolean) => ({
      content: '# x',
      absPath: '/d/a.md',
      workspaceRoot: '/d',
      onNavigate: () => {},
      scrollToAnchor: null,
      onAnchorConsumed: () => {},
      images: { readLocal, readRemote, allowRemote, onAllowRemote }
    })
    await act(async () => root!.render(createElement(MarkdownView, mk(false))))
    expect(host.querySelector('img[src^="data:image/png"]')).toBeTruthy()
    expect(host.querySelectorAll('.md-img-remote').length).toBe(1)
    expect(host.querySelector('.remote-images-bar')!.textContent).toContain(
      'This document has 1 remote image'
    )
    expect(readRemote).not.toHaveBeenCalled()
    await act(async () => {
      ;(host.querySelector('.remote-images-bar button') as HTMLButtonElement).click()
    })
    expect(onAllowRemote).toHaveBeenCalled()
    await act(async () => root!.render(createElement(MarkdownView, mk(true))))
    expect(readRemote).toHaveBeenCalledWith('https://t/b.png')
    expect(host.querySelector('.md-img-remote')).toBeNull()
    expect(host.querySelectorAll('img').length).toBe(2)
  })
})
