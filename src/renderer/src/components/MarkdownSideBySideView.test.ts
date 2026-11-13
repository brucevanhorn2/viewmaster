// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('../markdown/render', () => ({
  renderMarkdownToHtml: async () => '<p><img src="a.png" alt="A"><img src="https://t/b.png"></p>'
}))
vi.mock('../markdown/mermaidRunner', () => ({ runMermaidIn: async () => {} }))

import MarkdownSideBySideView from './MarkdownSideBySideView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class RO {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('MarkdownSideBySideView images', () => {
  it('side-by-side uses each side\'s reader', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const mkImages = (b64: string) => ({
      readLocal: async () => ({ base64: b64, mime: 'image/png' }),
      readRemote: async () => null,
      allowRemote: false,
      onAllowRemote: () => {}
    })
    await act(async () =>
      root!.render(
        createElement(MarkdownSideBySideView, {
          baseContent: 'x',
          content: 'y',
          absPath: '/d/a.md',
          workspaceRoot: '/d',
          onNavigate: () => {},
          scrollToAnchor: null,
          onAnchorConsumed: () => {},
          oldImages: mkImages('OLDOLD'),
          newImages: mkImages('NEWNEW')
        })
      )
    )
    const panes = host.querySelectorAll('.markdown-sidebyside-pane')
    expect(panes[0].querySelector('img')!.getAttribute('src')).toContain('OLDOLD')
    expect(panes[1].querySelector('img')!.getAttribute('src')).toContain('NEWNEW')
    expect(host.querySelectorAll('.remote-images-bar').length).toBe(1)
    expect(host.querySelector('.remote-images-bar')!.textContent).toContain('1 remote image')  // same URL in both versions counts once
    const allowed = (m: ReturnType<typeof mkImages>) => ({ ...m, allowRemote: true })
    await act(async () =>
      root!.render(
        createElement(MarkdownSideBySideView, {
          baseContent: 'x',
          content: 'y',
          absPath: '/d/a.md',
          workspaceRoot: '/d',
          onNavigate: () => {},
          scrollToAnchor: null,
          onAnchorConsumed: () => {},
          oldImages: allowed(mkImages('OLDOLD')),
          newImages: allowed(mkImages('NEWNEW'))
        })
      )
    )
    expect(host.querySelector('.remote-images-bar')).toBeNull()
  })
})
