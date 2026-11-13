import { describe, it, expect } from 'vitest'
import { fitSize, fitState, zoomAt, clampState, panBy, maxZoomFor, MAX_ZOOM } from './panZoomMath'

const fit = { width: 1000, height: 500 }
const vp = { width: 1000, height: 800 }

describe('fitSize', () => {
  it('scales down to fit the viewport preserving aspect', () => {
    expect(fitSize({ width: 2000, height: 1000 }, vp)).toEqual({ width: 1000, height: 500 })
  })
  it('never upscales small images', () => {
    expect(fitSize({ width: 200, height: 100 }, vp)).toEqual({ width: 200, height: 100 })
  })
  it('returns null for degenerate sizes', () => {
    expect(fitSize({ width: 0, height: 0 }, vp)).toBeNull()
    expect(fitSize({ width: 100, height: 0 }, vp)).toBeNull()
  })
})

describe('fitState', () => {
  it('centers the fitted content', () => {
    expect(fitState(fit, vp)).toEqual({ zoom: 1, x: 0, y: 150 })
  })
})

describe('zoomAt', () => {
  it('keeps the content point under the cursor fixed', () => {
    const s = fitState(fit, vp)
    const p = { x: 500, y: 400 }
    const n = zoomAt(s, 2, p, fit, vp)
    expect(n.zoom).toBe(2)
    expect((p.x - n.x) / n.zoom).toBeCloseTo((p.x - s.x) / s.zoom)
    expect((p.y - n.y) / n.zoom).toBeCloseTo((p.y - s.y) / s.zoom)
  })
  it('clamps to MAX_ZOOM', () => {
    expect(zoomAt(fitState(fit, vp), 100, { x: 10, y: 10 }, fit, vp).zoom).toBe(MAX_ZOOM)
  })
  it('clamps to min zoom and returns the fit state', () => {
    const s = fitState(fit, vp)
    const n = zoomAt(s, 0.01, { x: 10, y: 10 }, fit, vp)
    expect(n.zoom).toBe(1)
    expect(n).toEqual(s)
  })
})

describe('clampState', () => {
  it('clamps oversized axes to [viewport - scaled, 0]', () => {
    const n = clampState({ zoom: 2, x: 100, y: -5000 }, fit, vp)
    expect(n.x).toBe(0)
    expect(n.y).toBe(vp.height - fit.height * 2)
    expect(clampState({ zoom: 2, x: -5000, y: 0 }, fit, vp).x).toBe(vp.width - fit.width * 2)
  })
  it('centers axes where scaled content is smaller than the viewport', () => {
    const n = clampState({ zoom: 1, x: 300, y: 0 }, fit, vp)
    expect(n.x).toBe(0)
    expect(n.y).toBe(150)
  })
})

describe('panBy', () => {
  it('moves within bounds', () => {
    const s = { zoom: 2, x: -400, y: 0 }
    expect(panBy(s, -50, 0, fit, vp).x).toBe(-450)
  })
  it('stops at the clamp bound', () => {
    const s = { zoom: 2, x: -400, y: 0 }
    expect(panBy(s, -99999, 0, fit, vp).x).toBe(vp.width - fit.width * 2)
    expect(panBy(s, 99999, 0, fit, vp).x).toBe(0)
  })
})

describe('zero viewport and dynamic max zoom', () => {
  it('fitSize is null for a 0-size viewport', () => {
    expect(fitSize({ width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull()
    expect(fitSize({ width: 100, height: 100 }, { width: 50, height: 0 })).toBeNull()
  })
  it('maxZoomFor allows 200% of natural, never below MAX_ZOOM', () => {
    expect(maxZoomFor({ width: 20000, height: 10000 }, { width: 1000, height: 500 })).toBe(40)
    expect(maxZoomFor({ width: 500, height: 500 }, { width: 500, height: 500 })).toBe(MAX_ZOOM)
  })
  it('clampState/zoomAt/panBy honor a custom maxZoom', () => {
    expect(clampState({ zoom: 99, x: 0, y: 0 }, fit, vp, 40).zoom).toBe(40)
    expect(zoomAt({ zoom: 30, x: 0, y: 0 }, 2, { x: 0, y: 0 }, fit, vp, 40).zoom).toBe(40)
    expect(panBy({ zoom: 30, x: 0, y: 0 }, 0, 0, fit, vp, 40).zoom).toBe(30)
  })
})
