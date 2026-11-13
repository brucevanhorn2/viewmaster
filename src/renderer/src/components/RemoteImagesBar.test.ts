// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import RemoteImagesBar from './RemoteImagesBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

function mount(count: number, onLoad: () => void = () => {}): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(RemoteImagesBar, { count, onLoad })))
  return host
}

describe('RemoteImagesBar', () => {
  it('renders nothing for 0', () => {
    expect(mount(0).innerHTML).toBe('')
  })

  it('says "1 remote image" / "3 remote images"', () => {
    expect(mount(1).querySelector('.remote-images-bar')!.textContent).toContain(
      'This document has 1 remote image'
    )
    expect(mount(1).textContent).not.toContain('1 remote images')
    act(() => root?.unmount())
    document.body.innerHTML = ''
    expect(mount(3).textContent).toContain('This document has 3 remote images')
  })

  it('button calls onLoad', () => {
    const onLoad = vi.fn()
    const host = mount(2, onLoad)
    const btn = host.querySelector('button')!
    expect(btn.textContent).toBe('Load images')
    act(() => btn.click())
    expect(onLoad).toHaveBeenCalledTimes(1)
  })
})
