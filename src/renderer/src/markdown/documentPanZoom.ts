import { attachPanZoom, type PanZoomController } from '../image/panZoom'
import type { PanZoomState } from '../image/panZoomMath'

/** Images smaller than this on either axis are skipped (icons/badges). */
export const MIN_ZOOMABLE_PX = 64

/**
 * One slot per candidate element (mermaid svg or image) in document order; `null` for a
 * candidate that is not zoomable (tiny, unmeasurable) or not yet loaded with no carried state.
 */
export type DocumentPanZoomStates = (PanZoomState | null)[]

export interface DocumentPanZoom {
  states(): DocumentPanZoomStates
  destroy(): void
}

interface Entry {
  wrapper: HTMLElement
  el: Element
  ctl: PanZoomController
  last: PanZoomState
}

/** Rendered size stands in for an SVG <img> with no intrinsic size (naturalWidth 0 once loaded). */
const sizeOf = (el: HTMLImageElement): { width: number; height: number } => {
  if (el.naturalWidth > 0) return { width: el.naturalWidth, height: el.naturalHeight }
  const r = el.getBoundingClientRect()
  return { width: r.width, height: r.height }
}

const isLoaded = (el: HTMLImageElement): boolean =>
  el.complete && (el.naturalWidth > 0 || el.getBoundingClientRect().width > 0)

function candidates(container: HTMLElement): Element[] {
  const sel = 'pre.mermaid[data-processed]:not(.mermaid-error) > svg, img'
  // Images inside mermaid output (foreignObject labels) belong to the diagram.
  return Array.from(container.querySelectorAll(sel)).filter(
    (el) => el instanceof SVGElement || !el.closest('pre.mermaid')
  )
}

/** Both axes must be big enough: badges (~100x20) and thin rules are skipped. */
const qualifies = (img: HTMLImageElement): boolean => {
  const s = sizeOf(img)
  return s.width >= MIN_ZOOMABLE_PX && s.height >= MIN_ZOOMABLE_PX
}

/**
 * Wraps each zoomable diagram/image in `container` in a fixed-size pan/zoom box that keeps the
 * element's rendered size. `saved` is applied by candidate index only when the number of
 * candidates (loaded or still loading) is unchanged; otherwise everything starts at Fit.
 * Images still loading are wrapped individually when they load, without disturbing the rest.
 */
export function attachDocumentPanZoom(
  container: HTMLElement,
  saved: DocumentPanZoomStates | null
): DocumentPanZoom {
  const found = candidates(container)
  const useSaved = saved !== null && saved.length === found.length
  // Carried-over states for candidates not (yet) wrapped, so a reload before an image
  // finishes loading doesn't lose its zoom.
  const carried: DocumentPanZoomStates = found.map((_, i) => (useSaved ? saved![i] : null))
  const entries = new Map<number, Entry>()
  const pending: { img: HTMLImageElement; onLoad: () => void }[] = []
  let destroyed = false

  const wrap = (el: Element, i: number, rect: DOMRect): void => {
    const parent = el.parentNode
    if (!parent) return
    const wrapper = document.createElement('div')
    wrapper.className = 'pz-doc'
    // Images may sit inline (side by side, or in a line of text): keep them inline.
    if (el instanceof HTMLImageElement) wrapper.classList.add('pz-doc-inline')
    wrapper.style.width = `${rect.width}px`
    wrapper.style.height = `${rect.height}px`
    parent.replaceChild(wrapper, el)
    wrapper.appendChild(el)
    // For images, the intrinsic size (not the CSS-shrunk box) sets the zoom ceiling.
    const natural =
      el instanceof HTMLImageElement && el.naturalWidth >= rect.width && el.naturalHeight > 0
        ? { width: el.naturalWidth, height: el.naturalHeight }
        : { width: rect.width, height: rect.height }
    const ctl = attachPanZoom(wrapper, el as HTMLElement, {
      natural,
      wheelPans: false,
      controlsOnHover: true,
      initial: carried[i] ?? undefined
    })
    entries.set(i, { wrapper, el, ctl, last: ctl.getState() })
  }

  // Measure everything first, before any wrapping shifts the layout.
  const ready: { el: Element; i: number; rect: DOMRect }[] = []
  found.forEach((el, i) => {
    if (el instanceof HTMLImageElement && !isLoaded(el)) {
      const onLoad = (): void => {
        if (destroyed || !container.contains(el) || !qualifies(el)) return
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) wrap(el, i, rect)
      }
      el.addEventListener('load', onLoad, { once: true })
      pending.push({ img: el, onLoad })
      return
    }
    if (el instanceof HTMLImageElement && !qualifies(el)) return
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) ready.push({ el, i, rect })
  })
  for (const { el, i, rect } of ready) wrap(el, i, rect)

  const snapshot = (): DocumentPanZoomStates =>
    carried.map((c, i) => {
      const e = entries.get(i)
      if (!e) return c
      try {
        e.last = e.ctl.getState()
      } catch {
        /* keep last known */
      }
      return e.last
    })

  return {
    states: snapshot,
    destroy() {
      destroyed = true
      for (const { img, onLoad } of pending) img.removeEventListener('load', onLoad)
      pending.length = 0
      const final = snapshot()
      final.forEach((s, i) => (carried[i] = s))
      for (const e of entries.values()) {
        try {
          e.ctl.destroy()
        } catch {
          /* already torn down */
        }
        // Only unwrap if the wrapper is still part of the live container.
        if (container.contains(e.wrapper)) e.wrapper.replaceWith(e.el)
      }
      entries.clear()
    }
  }
}
