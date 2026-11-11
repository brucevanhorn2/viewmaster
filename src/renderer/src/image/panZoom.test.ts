// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { attachPanZoom, type PanZoomOptions } from './panZoom'
import { fitState } from './panZoomMath'

const NATURAL = { width: 2000, height: 1000 }
let viewport: HTMLElement
let content: HTMLElement

function stubRect(el: HTMLElement): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}
function attach(over: Partial<PanZoomOptions> = {}) {
  return attachPanZoom(viewport, content, {
    natural: NATURAL,
    wheelPans: false,
    controlsOnHover: false,
    ...over
  })
}
function wheel(init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init })
  viewport.dispatchEvent(e)
  return e
}
function ptr(type: string, x: number, y: number, target: EventTarget = viewport, buttons?: number): void {
  // Primary button held for down/move unless told otherwise; released on up.
  const b = buttons ?? (type === 'pointerup' ? 0 : 1)
  target.dispatchEvent(
    new MouseEvent(type, { button: 0, buttons: b, clientX: x, clientY: y, bubbles: true, cancelable: true })
  )
}
const btn = (k: string): HTMLElement => viewport.querySelector(`[data-pz=${k}]`) as HTMLElement

beforeEach(() => {
  viewport = document.createElement('div')
  content = document.createElement('div')
  viewport.appendChild(content)
  stubRect(viewport)
  document.body.innerHTML = ''
  document.body.appendChild(viewport)
})

describe('attachPanZoom', () => {
  it('applies fit on attach', () => {
    attach()
    expect(content.style.width).toBe('1000px')
    expect(content.style.height).toBe('500px')
    expect(content.style.transform).toContain('translate(0px, 150px)')
    expect(btn('pct').textContent).toBe('100%')
  })

  it('ctrl+wheel prevents default and zooms', () => {
    const c = attach()
    const e = wheel({ deltaY: -100, ctrlKey: true, clientX: 500, clientY: 400 })
    expect(e.defaultPrevented).toBe(true)
    expect(c.getState().zoom).toBeCloseTo(1.25)
    expect(content.style.width).toBe('1250px')
    expect(content.style.transform).not.toContain('scale')
  })

  it('plain wheel is not prevented when wheelPans is false', () => {
    const c = attach()
    const before = c.getState()
    const e = wheel({ deltaY: 100 })
    expect(e.defaultPrevented).toBe(false)
    expect(c.getState()).toEqual(before)
  })

  it('plain wheel pans when wheelPans is true', () => {
    const c = attach({ wheelPans: true })
    c.zoomBy(2)
    const y0 = c.getState().y
    const e = wheel({ deltaY: 100 })
    expect(e.defaultPrevented).toBe(true)
    expect(c.getState().y).toBeLessThan(y0)
    const x0 = c.getState().x
    wheel({ deltaY: 100, shiftKey: true })
    expect(c.getState().x).toBeLessThan(x0)
  })

  it('drag pans and toggles pz-dragging', () => {
    const c = attach()
    c.zoomBy(2)
    const s0 = c.getState()
    ptr('pointerdown', 500, 400)
    expect(viewport.classList.contains('pz-dragging')).toBe(true)
    ptr('pointermove', 450, 380)
    ptr('pointerup', 450, 380)
    expect(viewport.classList.contains('pz-dragging')).toBe(false)
    expect(c.getState().x).toBeCloseTo(s0.x - 50)
    expect(c.getState().y).toBeCloseTo(s0.y - 20)
  })

  it('click after a drag is suppressed, plain click is not', () => {
    const a = document.createElement('a')
    document.body.appendChild(a)
    a.appendChild(viewport)
    const spy = vi.fn()
    a.addEventListener('click', spy)
    const c = attach()
    c.zoomBy(2)
    ptr('pointerdown', 500, 400)
    ptr('pointermove', 450, 380)
    ptr('pointerup', 450, 380)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    content.dispatchEvent(click)
    expect(spy).not.toHaveBeenCalled()
    expect(click.defaultPrevented).toBe(true)

    ptr('pointerdown', 500, 400)
    ptr('pointermove', 502, 401)
    ptr('pointerup', 502, 401)
    content.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a move with no button held ends a drag whose pointerup was missed', () => {
    const c = attach()
    c.zoomBy(4)
    ptr('pointerdown', 400, 350)
    ptr('pointermove', 420, 360)
    const s1 = c.getState()
    ptr('pointermove', 480, 400, viewport, 0)
    expect(c.getState()).toEqual(s1)
    expect(viewport.classList.contains('pz-dragging')).toBe(false)
  })

  it('buttons work and zoom is capped at 8', () => {
    const c = attach()
    btn('in').click()
    expect(c.getState().zoom).toBeCloseTo(1.25)
    for (let i = 0; i < 20; i++) btn('in').click()
    expect(c.getState().zoom).toBe(8)
    btn('out').click()
    expect(c.getState().zoom).toBeCloseTo(6.4)
    btn('fit').click()
    expect(c.getState()).toEqual(fitState({ width: 1000, height: 500 }, { width: 1000, height: 800 }))
  })

  it('restores initial state', () => {
    const c = attach({ initial: { zoom: 2, x: -100, y: -50 } })
    expect(c.getState()).toEqual({ zoom: 2, x: -100, y: -50 })
  })

  it('does not throw and is inert for zero-size content', () => {
    const c = attach({ natural: { width: 0, height: 0 } })
    expect(() => {
      c.zoomBy(2)
      wheel({ deltaY: -100, ctrlKey: true })
    }).not.toThrow()
    expect(content.style.width).toBe('')
  })

  it('destroy restores original markup and stops handling events', () => {
    content.setAttribute('style', 'max-width: 300px')
    viewport.innerHTML = '<div style="max-width: 300px" id="c"></div>'
    content = viewport.firstElementChild as HTMLElement
    const html = viewport.outerHTML
    const c = attach()
    expect(content.style.maxWidth).toBe('none')
    c.destroy()
    expect(viewport.outerHTML).toBe(html)
    expect(viewport.querySelector('.pz-controls')).toBeNull()
    const e = wheel({ deltaY: -100, ctrlKey: true })
    expect(e.defaultPrevented).toBe(false)
  })

  it('destroy leaves no class/style attributes if there were none', () => {
    const html = viewport.outerHTML
    attach().destroy()
    expect(viewport.outerHTML).toBe(html)
    expect(content.hasAttribute('class')).toBe(false)
    expect(content.hasAttribute('style')).toBe(false)
  })

  it('pointerdown is default-prevented (no native drag) except on controls; dragstart is blocked', () => {
    attach()
    const down = new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })
    content.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    const ds = new Event('dragstart', { bubbles: true, cancelable: true })
    content.dispatchEvent(ds)
    expect(ds.defaultPrevented).toBe(true)
    const cd = new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })
    btn('in').dispatchEvent(cd)
    expect(cd.defaultPrevented).toBe(false)
  })

  it('pointercancel resets moved so the next control click is not swallowed', () => {
    const c = attach()
    c.zoomBy(2)
    ptr('pointerdown', 500, 400)
    ptr('pointermove', 450, 380)
    ptr('pointercancel', 450, 380)
    expect(viewport.classList.contains('pz-dragging')).toBe(false)
    const z = c.getState().zoom
    btn('in').click()
    expect(c.getState().zoom).toBeGreaterThan(z)
  })

  it('a pointerdown on the controls resets a stale moved flag', () => {
    const c = attach()
    c.zoomBy(2)
    ptr('pointerdown', 500, 400)
    ptr('pointermove', 450, 380)
    ptr('pointerup', 450, 380) // moved stays true until a click
    ptr('pointerdown', 0, 0, btn('in'))
    const z = c.getState().zoom
    btn('in').click()
    expect(c.getState().zoom).toBeGreaterThan(z)
  })

  it('a 0x0 viewport relayout keeps zoom and pan; restoring the size resumes from kept state', () => {
    const c = attach({ initial: { zoom: 1, x: 0, y: 0 } })
    c.zoomBy(3)
    ptr('pointerdown', 500, 400)
    ptr('pointermove', 400, 350)
    ptr('pointerup', 400, 350)
    const kept = c.getState()
    const orig = viewport.getBoundingClientRect
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    c.relayout()
    expect(c.getState()).toEqual(kept)
    viewport.getBoundingClientRect = orig
    c.relayout()
    expect(c.getState()).toEqual(kept)
  })

  it('clicking a control inside a link does not navigate', () => {
    const a = document.createElement('a')
    document.body.appendChild(a)
    a.appendChild(viewport)
    const spy = vi.fn()
    a.addEventListener('click', spy)
    const c = attach()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    btn('in').dispatchEvent(click)
    expect(spy).not.toHaveBeenCalled()
    expect(click.defaultPrevented).toBe(true)
    expect(c.getState().zoom).toBeCloseTo(1.25)
  })

  it('allows 200% of natural for huge images (cap 40 for 20000 in a 1000 viewport)', () => {
    const c = attach({ natural: { width: 20000, height: 10000 } })
    for (let i = 0; i < 60; i++) btn('in').click()
    expect(c.getState().zoom).toBeCloseTo(40)
  })

  it('wheel zoom scales with delta and caps one event at a notch', () => {
    const c = attach()
    wheel({ deltaY: -10, ctrlKey: true, clientX: 500, clientY: 400 })
    expect(c.getState().zoom).toBeCloseTo(1.25 ** 0.1)
    wheel({ deltaY: -1000, ctrlKey: true, clientX: 500, clientY: 400 })
    expect(c.getState().zoom).toBeCloseTo(1.25 ** 1.1)
    wheel({ deltaY: -3, deltaMode: 1, ctrlKey: true, clientX: 500, clientY: 400 }) // 48px
    expect(c.getState().zoom).toBeCloseTo(1.25 ** 1.58)
  })

  it('hover mode adds pz-hover class', () => {
    attach({ controlsOnHover: true })
    expect(viewport.classList.contains('pz-hover')).toBe(true)
  })
})
