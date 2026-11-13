import { attachPanZoom, imageSize, type PanZoomController } from '../image/panZoom'
import type { PanZoomState } from '../image/panZoomMath'

/** Images smaller than this on either axis are skipped (icons/badges). */
export const MIN_ZOOMABLE_PX = 64
/** Boxes rendered narrower than this would clip the zoom controls (~140px), so are skipped. */
export const MIN_BOX_WIDTH_PX = 160

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
  const s = imageSize(img)
  return s.width >= MIN_ZOOMABLE_PX && s.height >= MIN_ZOOMABLE_PX
}

/**
 * The width the box prefers when the pane is wide enough: the element's intrinsic width
 * (mermaid's max-width, an unsized image's natural width) when it is currently squeezed by
 * the pane, else its rendered width. The box also has max-width:100% and a fixed aspect
 * ratio, so it shrinks and grows with the pane the way the bare element did.
 */
function preferredWidth(el: Element, rect: DOMRect): number {
  const parent = el.parentElement
  let parentWidth = 0
  if (parent) {
    // Content width: clientWidth includes padding (pre.mermaid has some).
    const cs = getComputedStyle(parent)
    parentWidth = parent.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
  }
  const squeezed = rect.width >= parentWidth - 1
  if (!squeezed) return rect.width
  let intrinsic = 0
  if (el instanceof HTMLImageElement) {
    // An explicit width (attribute or inline style) is what the author asked for.
    if (!el.hasAttribute('width') && !el.style.width) intrinsic = el.naturalWidth
  } else {
    intrinsic = parseFloat((el as SVGElement).style.maxWidth) || 0
  }
  return Math.max(rect.width, intrinsic)
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
    const preferred = preferredWidth(el, rect)
    wrapper.style.width = `${preferred}px`
    wrapper.style.aspectRatio = `${rect.width} / ${rect.height}`
    parent.replaceChild(wrapper, el)
    wrapper.appendChild(el)
    // 100% is the larger of the box's preferred width and (for images) the intrinsic width,
    // so Fit fills the box as it grows and the zoom ceiling isn't the CSS-shrunk size. The
    // rendered aspect is kept, so an image stretched by width/height attributes stays as shown.
    const naturalWidth =
      el instanceof HTMLImageElement ? Math.max(preferred, el.naturalWidth) : preferred
    const natural = { width: naturalWidth, height: (naturalWidth * rect.height) / rect.width }
    const ctl = attachPanZoom(wrapper, el as HTMLElement, {
      natural,
      wheelPans: false,
      controlsOnHover: true,
      initial: carried[i] ?? undefined
    })
    entries.set(i, { wrapper, el, ctl })
  }

  // Measure everything first, before any wrapping shifts the layout.
  const ready: { el: Element; i: number; rect: DOMRect }[] = []
  found.forEach((el, i) => {
    if (el instanceof HTMLImageElement && !isLoaded(el)) {
      const onLoad = (): void => {
        if (destroyed || !container.contains(el) || !qualifies(el)) return
        const rect = el.getBoundingClientRect()
        if (rect.width >= MIN_BOX_WIDTH_PX && rect.height > 0) wrap(el, i, rect)
      }
      el.addEventListener('load', onLoad, { once: true })
      pending.push({ img: el, onLoad })
      return
    }
    if (el instanceof HTMLImageElement && !qualifies(el)) return
    const rect = el.getBoundingClientRect()
    if (rect.width >= MIN_BOX_WIDTH_PX && rect.height > 0) ready.push({ el, i, rect })
  })
  for (const { el, i, rect } of ready) wrap(el, i, rect)

  const snapshot = (): DocumentPanZoomStates =>
    carried.map((c, i) => entries.get(i)?.ctl.getState() ?? c)

  return {
    states: snapshot,
    destroy() {
      destroyed = true
      for (const { img, onLoad } of pending) img.removeEventListener('load', onLoad)
      pending.length = 0
      const final = snapshot()
      final.forEach((s, i) => (carried[i] = s))
      for (const e of entries.values()) {
        e.ctl.destroy()
        // Only unwrap if the wrapper is still part of the live container.
        if (container.contains(e.wrapper)) e.wrapper.replaceWith(e.el)
      }
      entries.clear()
    }
  }
}
