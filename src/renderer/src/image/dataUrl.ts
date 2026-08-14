/** Builds a base64 `data:` URL for raster image bytes read via `readFile`. */
export function rasterDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`
}

/** Builds a `data:` URL for SVG markup already loaded as text — no base64 needed. */
export function svgDataUrl(svgText: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgText)}`
}
