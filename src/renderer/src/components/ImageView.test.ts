// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import ImageView from './ImageView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('ImageView', () => {
  it('keeps pan/zoom attached and restores state when src changes for the same file', () => {
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    }
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 2000 })
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 1000 })
    class RO {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(ImageView, { src: 'data:a', resetKey: 'f' })))
    const view = host.querySelector('.image-view') as HTMLElement
    act(() => {
      host.querySelector('img')!.dispatchEvent(new Event('load'))
    })
    expect(view.classList.contains('pz-viewport')).toBe(true)
    const img = host.querySelector('img') as HTMLImageElement
    act(() => {
      img.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }))
      view.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }))
    })
    const zoomed = img.style.width
    expect(zoomed).not.toBe('')

    // New src: load may fire before passive effect cleanups, so flush nothing between.
    act(() => root!.render(createElement(ImageView, { src: 'data:b', resetKey: 'f' })))
    // Still zoomed while the new src decodes: no flash back to the plain look.
    expect(view.classList.contains('pz-viewport')).toBe(true)
    expect((host.querySelector('img') as HTMLImageElement).style.width).toBe(zoomed)
    act(() => {
      host.querySelector('img')!.dispatchEvent(new Event('load'))
    })
    expect(view.classList.contains('pz-viewport')).toBe(true)
    expect(host.querySelectorAll('.pz-controls').length).toBe(1)
    expect((host.querySelector('img') as HTMLImageElement).style.width).toBe(zoomed)
  })
})
