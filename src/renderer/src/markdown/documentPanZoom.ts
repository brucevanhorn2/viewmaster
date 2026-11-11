import { attachPanZoom, type PanZoomController } from '../image/panZoom'
import type { PanZoomState } from '../image/panZoomMath'

/** Images smaller than this on both axes are skipped (icons/badges). */
export const MIN_ZOOMABLE_PX = 64

export interface DocumentPanZoom {
  states(): PanZoomState[]
  destroy(): void
}

interface Entry {
  wrapper: HTMLElement
  el: Element
  ctl: PanZoomController
  last: PanZoomState
}

function findZoomables(container: HTMLElement): Element[] {
  const sel = 'pre.mermaid[data-processed]:not(.mermaid-error) > svg, img'
  return Array.from(container.querySelectorAll(sel)).filter((el) => {
    if (!(el instanceof HTMLImageElement)) return true
    return (
      el.complete &&
      el.naturalWidth > 0 &&
      (el.naturalWidth >= MIN_ZOOMABLE_PX || el.naturalHeight >= MIN_ZOOMABLE_PX)
    )
  })
}

/**
 * Wraps each zoomable diagram/image in `container` in a fixed-size pan/zoom box. Boxes keep the
 * element's natural rendered size. `saved` is applied by index only if its length matches the
 * number of zoomables found; otherwise everything starts at Fit.
 */
export function attachDocumentPanZoom(
  container: HTMLElement,
  saved: PanZoomState[] | null
): DocumentPanZoom {
  const found = findZoomables(container)
  // Measure everything first, before any wrapping shifts the layout.
  const measured = found
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0)
  const useSaved = saved !== null && saved.length === measured.length
  const entries: Entry[] = []

  measured.forEach(({ el, rect }, i) => {
    const parent = el.parentNode
    if (!parent) return
    const wrapper = document.createElement('div')
    wrapper.className = 'pz-doc'
    wrapper.style.width = `${rect.width}px`
    wrapper.style.height = `${rect.height}px`
    parent.replaceChild(wrapper, el)
    wrapper.appendChild(el)
    const ctl = attachPanZoom(wrapper, el as HTMLElement, {
      natural: { width: rect.width, height: rect.height },
      wheelPans: false,
      controlsOnHover: true,
      initial: useSaved ? saved![i] : undefined
    })
    entries.push({ wrapper, el, ctl, last: ctl.getState() })
  })

  return {
    states() {
      return entries.map((e) => {
        try {
          e.last = e.ctl.getState()
        } catch {
          /* keep last known */
        }
        return e.last
      })
    },
    destroy() {
      for (const e of entries) {
        try {
          e.last = e.ctl.getState()
          e.ctl.destroy()
        } catch {
          /* already torn down */
        }
        // Only unwrap if the wrapper is still part of the live container.
        if (container.contains(e.wrapper)) e.wrapper.replaceWith(e.el)
      }
      entries.length = 0
    }
  }
}
