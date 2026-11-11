// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { attachDocumentPanZoom } from './documentPanZoom'

let container: HTMLElement

function rect(w: number, h: number): DOMRect {
  return { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
}
function stubSize(el: Element, w: number, h: number): void {
  ;(el as HTMLElement).getBoundingClientRect = () => rect(w, h)
}
function loaded(img: HTMLImageElement, w: number, h: number, complete = true): void {
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true })
  Object.defineProperty(img, 'complete', { value: complete, configurable: true })
  stubSize(img, w, h)
}
function mermaidNode(w = 400, h = 200): HTMLElement {
  const pre = document.createElement('pre')
  pre.className = 'mermaid'
  pre.setAttribute('data-processed', 'true')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  pre.appendChild(svg)
  stubSize(svg, w, h)
  return pre
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.innerHTML = ''
  document.body.appendChild(container)
  // wrappers are created inside the helper; give every element a fixed layout box
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(400, 300))
})
afterEach(() => vi.restoreAllMocks())

describe('attachDocumentPanZoom', () => {
  it('wraps a processed mermaid svg', () => {
    container.appendChild(mermaidNode())
    const d = attachDocumentPanZoom(container, null)
    const w = container.querySelector('.pz-viewport.pz-doc') as HTMLElement
    expect(w).not.toBeNull()
    expect(w.querySelector('svg')).not.toBeNull()
    expect(w.querySelector('.pz-controls')).not.toBeNull()
    expect(w.style.width).toBe('400px')
    expect(w.style.height).toBe('200px')
    d.destroy()
  })

  it('skips failed mermaid nodes', () => {
    container.innerHTML = '<pre class="mermaid mermaid-error" data-processed="true">bad</pre>'
    expect(() => attachDocumentPanZoom(container, null)).not.toThrow()
    expect(container.querySelector('.pz-doc')).toBeNull()
  })

  it('skips tiny and unloaded images, wraps big ones', () => {
    const tiny = document.createElement('img')
    const unloaded = document.createElement('img')
    const big = document.createElement('img')
    loaded(tiny, 32, 32)
    loaded(unloaded, 400, 300, false)
    loaded(big, 400, 300)
    container.append(tiny, unloaded, big)
    attachDocumentPanZoom(container, null)
    expect(container.querySelectorAll('.pz-doc')).toHaveLength(1)
    expect(big.parentElement?.classList.contains('pz-doc')).toBe(true)
    expect(tiny.parentElement).toBe(container)
    expect(unloaded.parentElement).toBe(container)
  })

  it('skips elements measuring 0 on an axis', () => {
    const img = document.createElement('img')
    loaded(img, 400, 300)
    stubSize(img, 0, 300)
    container.appendChild(img)
    attachDocumentPanZoom(container, null)
    expect(container.querySelector('.pz-doc')).toBeNull()
  })

  it('restores saved states by index', () => {
    container.append(mermaidNode(), mermaidNode())
    const saved = [
      { zoom: 2, x: -10, y: -10 },
      { zoom: 3, x: -20, y: -20 }
    ]
    const d = attachDocumentPanZoom(container, saved)
    const s = d.states()
    expect(s.map((x) => x.zoom)).toEqual([2, 3])
    d.destroy()
  })

  it('resets all when count changes', () => {
    container.append(mermaidNode(), mermaidNode(), mermaidNode())
    const d = attachDocumentPanZoom(container, [
      { zoom: 2, x: 0, y: 0 },
      { zoom: 3, x: 0, y: 0 }
    ])
    const s = d.states()
    expect(s).toHaveLength(3)
    s.forEach((x) => expect(x.zoom).toBe(1))
  })

  it('destroy unwraps', () => {
    container.append(mermaidNode())
    const img = document.createElement('img')
    loaded(img, 400, 300)
    img.setAttribute('src', 'a.png')
    container.append(img)
    const before = container.innerHTML
    const d = attachDocumentPanZoom(container, null)
    expect(container.innerHTML).not.toBe(before)
    d.destroy()
    expect(container.innerHTML).toBe(before)
  })

  it('destroy and states are safe after the container markup was replaced', () => {
    container.append(mermaidNode())
    const d = attachDocumentPanZoom(container, null)
    const last = d.states()
    container.innerHTML = '<p>new</p>'
    expect(d.states()).toEqual(last)
    expect(() => d.destroy()).not.toThrow()
    expect(container.innerHTML).toBe('<p>new</p>')
  })
})
