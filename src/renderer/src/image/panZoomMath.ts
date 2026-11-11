export interface Size {
  width: number
  height: number
}
/** zoom 1 = fit; x/y = content top-left offset in viewport px */
export interface PanZoomState {
  zoom: number
  x: number
  y: number
}

export const MIN_ZOOM = 1
export const MAX_ZOOM = 8
export const ZOOM_STEP = 1.25 // per +/- click and per wheel notch

/** Size of the content at zoom 1: scaled down to fit the viewport, never upscaled. */
export function fitSize(natural: Size, viewport: Size): Size | null {
  if (!(natural.width > 0) || !(natural.height > 0)) return null
  const scale = Math.min(1, viewport.width / natural.width, viewport.height / natural.height)
  return { width: natural.width * scale, height: natural.height * scale }
}

function clampAxis(offset: number, scaled: number, viewport: number): number {
  if (scaled <= viewport) return (viewport - scaled) / 2
  return Math.min(0, Math.max(viewport - scaled, offset))
}

export function clampState(s: PanZoomState, fit: Size, viewport: Size): PanZoomState {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.zoom))
  return {
    zoom,
    x: clampAxis(s.x, fit.width * zoom, viewport.width),
    y: clampAxis(s.y, fit.height * zoom, viewport.height)
  }
}

export function fitState(fit: Size, viewport: Size): PanZoomState {
  return clampState({ zoom: MIN_ZOOM, x: 0, y: 0 }, fit, viewport)
}

/** Zoom by `factor` keeping the content point under `point` (viewport px) fixed. */
export function zoomAt(
  s: PanZoomState,
  factor: number,
  point: { x: number; y: number },
  fit: Size,
  viewport: Size
): PanZoomState {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.zoom * factor))
  const ratio = zoom / s.zoom
  return clampState(
    { zoom, x: point.x - (point.x - s.x) * ratio, y: point.y - (point.y - s.y) * ratio },
    fit,
    viewport
  )
}

export function panBy(s: PanZoomState, dx: number, dy: number, fit: Size, viewport: Size): PanZoomState {
  return clampState({ zoom: s.zoom, x: s.x + dx, y: s.y + dy }, fit, viewport)
}
