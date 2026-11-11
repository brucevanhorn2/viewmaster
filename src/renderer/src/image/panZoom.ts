import {
  type PanZoomState,
  type Size,
  ZOOM_STEP,
  clampState,
  fitSize,
  fitState,
  panBy,
  zoomAt
} from './panZoomMath'

export interface PanZoomOptions {
  natural: Size // intrinsic size of the content
  wheelPans: boolean // true: plain/shift wheel pans (standalone); false: plain wheel untouched (markdown)
  controlsOnHover: boolean // true: controls hidden until viewport :hover (markdown)
  initial?: PanZoomState // restore instead of fitting
}
export interface PanZoomController {
  getState(): PanZoomState
  zoomBy(factor: number): void // anchored at viewport center
  fit(): void
  relayout(natural?: Size): void // recompute fit after a viewport resize or content swap; keeps zoom/x/y (clamped)
  destroy(): void // removes listeners, controls, and restores original class/style attributes
}

const DRAG_THRESHOLD = 4

interface Attrs {
  cls: string | null
  style: string | null
}
function snapshot(el: HTMLElement): Attrs {
  return { cls: el.getAttribute('class'), style: el.getAttribute('style') }
}
function restore(el: HTMLElement, s: Attrs): void {
  if (s.cls === null) el.removeAttribute('class')
  else el.setAttribute('class', s.cls)
  if (s.style === null) el.removeAttribute('style')
  else el.setAttribute('style', s.style)
}

/**
 * Attach map-style pan/zoom to `content` inside `viewport`. Zoom is applied by sizing the
 * content in px (keeps SVG crisp); pan is `translate()` only. If the content has no usable
 * size (fitSize === null) the content is left unsized/unpositioned and all input is inert.
 */
export function attachPanZoom(
  viewport: HTMLElement,
  content: HTMLElement,
  opts: PanZoomOptions
): PanZoomController {
  const vpSnap = snapshot(viewport)
  const ctSnap = snapshot(content)
  let natural = opts.natural
  let fit: Size | null = null
  let state: PanZoomState = { zoom: 1, x: 0, y: 0 }
  let dragging = false
  let moved = false
  let last = { x: 0, y: 0 }
  let down = { x: 0, y: 0 }

  viewport.classList.add('pz-viewport')
  if (opts.controlsOnHover) viewport.classList.add('pz-hover')
  content.classList.add('pz-content')
  content.style.maxWidth = 'none'
  content.style.maxHeight = 'none'

  const controls = document.createElement('div')
  controls.className = 'pz-controls'
  controls.innerHTML =
    '<button type="button" data-pz="out">−</button><span data-pz="pct">100%</span>' +
    '<button type="button" data-pz="in">+</button><button type="button" data-pz="fit">Fit</button>'
  viewport.appendChild(controls)
  const pct = controls.querySelector('[data-pz=pct]') as HTMLElement

  const vp = (): Size => {
    const r = viewport.getBoundingClientRect()
    return { width: r.width, height: r.height }
  }
  function apply(): void {
    if (!fit) return
    content.style.width = `${fit.width * state.zoom}px`
    content.style.height = `${fit.height * state.zoom}px`
    content.style.transform = `translate(${state.x}px, ${state.y}px)`
    pct.textContent = `${Math.round(state.zoom * 100)}%`
  }
  function set(s: PanZoomState): void {
    if (!fit) return
    state = clampState(s, fit, vp())
    apply()
  }
  function layout(initial?: PanZoomState): void {
    fit = fitSize(natural, vp())
    if (!fit) return
    state = initial ? clampState(initial, fit, vp()) : fitState(fit, vp())
    apply()
  }
  const center = (): { x: number; y: number } => {
    const v = vp()
    return { x: v.width / 2, y: v.height / 2 }
  }

  const onWheel = (e: WheelEvent): void => {
    if (!fit) return
    if (e.ctrlKey) {
      e.preventDefault()
      const r = viewport.getBoundingClientRect()
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      state = zoomAt(state, factor, { x: e.clientX - r.left, y: e.clientY - r.top }, fit, vp())
      apply()
    } else if (opts.wheelPans) {
      e.preventDefault()
      state = e.shiftKey
        ? panBy(state, -(e.deltaX || e.deltaY), 0, fit, vp())
        : panBy(state, -e.deltaX, -e.deltaY, fit, vp())
      apply()
    }
  }
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !fit || controls.contains(e.target as Node)) return
    dragging = true
    moved = false
    down = last = { x: e.clientX, y: e.clientY }
    viewport.classList.add('pz-dragging')
    if (typeof viewport.setPointerCapture === 'function' && e.pointerId !== undefined) {
      try {
        viewport.setPointerCapture(e.pointerId)
      } catch {
        /* capture is best-effort */
      }
    }
  }
  const onMove = (e: PointerEvent): void => {
    if (!dragging || !fit) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_THRESHOLD) moved = true
    state = panBy(state, e.clientX - last.x, e.clientY - last.y, fit, vp())
    last = { x: e.clientX, y: e.clientY }
    apply()
  }
  const onUp = (): void => {
    dragging = false
    viewport.classList.remove('pz-dragging')
  }
  const onClick = (e: MouseEvent): void => {
    if (!moved) return
    moved = false
    e.preventDefault()
    e.stopPropagation()
  }
  const onControls = (e: Event): void => {
    const k = (e.target as HTMLElement).closest('[data-pz]')?.getAttribute('data-pz')
    if (k === 'in') api.zoomBy(ZOOM_STEP)
    else if (k === 'out') api.zoomBy(1 / ZOOM_STEP)
    else if (k === 'fit') api.fit()
  }

  viewport.addEventListener('wheel', onWheel, { passive: false })
  viewport.addEventListener('pointerdown', onDown as EventListener)
  viewport.addEventListener('pointermove', onMove as EventListener)
  viewport.addEventListener('pointerup', onUp)
  viewport.addEventListener('pointercancel', onUp)
  viewport.addEventListener('click', onClick, true)
  controls.addEventListener('click', onControls)
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => api.relayout()) : null
  ro?.observe(viewport)

  const api: PanZoomController = {
    getState: () => ({ ...state }),
    zoomBy(factor) {
      if (fit) set(zoomAt(state, factor, center(), fit, vp()))
    },
    fit() {
      if (fit) set(fitState(fit, vp()))
    },
    relayout(n) {
      if (n) natural = n
      layout(fit ? state : opts.initial)
    },
    destroy() {
      ro?.disconnect()
      viewport.removeEventListener('wheel', onWheel)
      viewport.removeEventListener('pointerdown', onDown as EventListener)
      viewport.removeEventListener('pointermove', onMove as EventListener)
      viewport.removeEventListener('pointerup', onUp)
      viewport.removeEventListener('pointercancel', onUp)
      viewport.removeEventListener('click', onClick, true)
      controls.remove()
      restore(viewport, vpSnap)
      restore(content, ctSnap)
    }
  }
  layout(opts.initial)
  return api
}
