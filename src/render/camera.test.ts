import { describe, expect, test } from 'vitest'

import {
  type Camera,
  MAX_ZOOM,
  cameraEquals,
  cameraView,
  clampCamera,
  fitCamera,
  formatZoom,
  interpolateCamera,
  panBy,
  relativeView,
  stepPan,
  stepZoom,
  textureScale,
  visibleRect,
  zoomAbout,
} from './camera'

/** Where a plate-normalised point lands in the view, 0..1. */
const toView = (camera: Camera, px: number, py: number) => [
  0.5 + (px - camera.x) * camera.zoom,
  0.5 + (py - camera.y) * camera.zoom,
]

describe('zoomAbout', () => {
  test('keeps the plate point under the cursor where it is', () => {
    const camera: Camera = { zoom: 1.5, x: 0.45, y: 0.55 }
    const u = 0.8
    const v = 0.3
    const plateX = camera.x + (u - 0.5) / camera.zoom
    const plateY = camera.y + (v - 0.5) / camera.zoom
    const next = zoomAbout(camera, 2.5, u, v)
    expect(next.zoom).toBeCloseTo(3.75)
    const [nu, nv] = toView(next, plateX, plateY)
    expect(nu).toBeCloseTo(u)
    expect(nv).toBeCloseTo(v)
  })

  test('about the centre, only the zoom changes', () => {
    expect(zoomAbout(fitCamera, 2, 0.5, 0.5)).toEqual({ zoom: 2, x: 0.5, y: 0.5 })
  })

  test('stops at the ends of the range without drifting', () => {
    const top: Camera = { zoom: MAX_ZOOM, x: 0.3, y: 0.7 }
    expect(zoomAbout(top, 2, 0.9, 0.1)).toEqual(top)
    expect(zoomAbout(fitCamera, 0.5, 0.2, 0.2)).toEqual(fitCamera)
  })
})

describe('panBy', () => {
  test('drags the plate with the pointer', () => {
    const next = panBy({ zoom: 4, x: 0.5, y: 0.5 }, 0.1, -0.2)
    // The plate moved right and up, so the view now looks further left and down.
    expect(next.x).toBeCloseTo(0.475)
    expect(next.y).toBeCloseTo(0.55)
  })
})

describe('clampCamera', () => {
  test('the fitted view cannot be panned', () => {
    expect(clampCamera({ zoom: 1, x: 0.9, y: 0.1 })).toEqual(fitCamera)
  })

  test('zoom stays within range, and bad numbers fall back', () => {
    expect(clampCamera({ zoom: 0.2, x: 0.5, y: 0.5 }).zoom).toBe(1)
    expect(clampCamera({ zoom: 500, x: 0.5, y: 0.5 }).zoom).toBe(MAX_ZOOM)
    expect(clampCamera({ zoom: Number.NaN, x: Number.NaN, y: 0.5 })).toEqual(fitCamera)
  })

  test('the view stays on the sheet', () => {
    expect(clampCamera({ zoom: 2, x: 0.1, y: 0.95 })).toEqual({ zoom: 2, x: 0.25, y: 0.75 })
  })

  test('the centre stays over the plant, but the sheet wins', () => {
    const plant = { minX: 0.4, minY: 0.2, maxX: 0.6, maxY: 0.9 }
    expect(clampCamera({ zoom: 10, x: 0.9, y: 0.1 }, plant)).toEqual({ zoom: 10, x: 0.6, y: 0.2 })
    expect(clampCamera({ zoom: 1.25, x: 0.5, y: 0.9 }, plant)).toEqual({ zoom: 1.25, x: 0.5, y: 0.6 })
  })

  test('is idempotent', () => {
    const plant = { minX: 0.3, minY: 0.1, maxX: 0.7, maxY: 0.8 }
    const once = clampCamera({ zoom: 7.3, x: 0.91, y: -0.2 }, plant)
    expect(clampCamera(once, plant)).toEqual(once)
    expect(clampCamera(once)).toEqual(once)
  })
})

describe('steps', () => {
  test('zoom steps land on powers of two', () => {
    expect(stepZoom(fitCamera, 'In').zoom).toBe(2)
    expect(stepZoom({ zoom: 3.1, x: 0.5, y: 0.5 }, 'In').zoom).toBe(4)
    expect(stepZoom({ zoom: 3.1, x: 0.5, y: 0.5 }, 'Out').zoom).toBe(2)
    expect(stepZoom({ zoom: 4, x: 0.5, y: 0.5 }, 'Out').zoom).toBe(2)
    expect(stepZoom({ zoom: MAX_ZOOM, x: 0.5, y: 0.5 }, 'In').zoom).toBe(MAX_ZOOM)
    expect(stepZoom({ zoom: 6, x: 0.2, y: 0.8 }, 'Fit')).toEqual(fitCamera)
  })

  test('zooming out near an edge pulls the view back onto the sheet', () => {
    expect(stepZoom({ zoom: 8, x: 0.1, y: 0.5 }, 'Out')).toEqual({ zoom: 4, x: 0.125, y: 0.5 })
  })

  test('pan steps move a fifth of the view', () => {
    const next = stepPan({ zoom: 4, x: 0.5, y: 0.5 }, 'Down')
    expect(next.x).toBe(0.5)
    expect(next.y).toBeCloseTo(0.55)
  })
})

describe('views', () => {
  test('the fitted camera is the identity', () => {
    expect(cameraView(fitCamera, 800, 600)).toEqual({ zoom: 1, e: 0, f: 0 })
    const rect = visibleRect(fitCamera, 800, 600)
    expect([rect.minX + 0, rect.minY + 0, rect.maxX, rect.maxY]).toEqual([0, 0, 800, 600])
  })

  test('the view puts the camera centre in the middle of the screen', () => {
    const camera: Camera = { zoom: 4, x: 0.25, y: 0.6 }
    const { zoom, e, f } = cameraView(camera, 800, 600)
    expect(zoom * (0.25 * 800) + e).toBeCloseTo(400)
    expect(zoom * (0.6 * 600) + f).toBeCloseTo(300)
    const rect = visibleRect(camera, 800, 600)
    expect(rect.maxX - rect.minX).toBeCloseTo(200)
    expect((rect.minX + rect.maxX) / 2).toBeCloseTo(200)
  })

  test('a picture at one camera maps onto another', () => {
    const from: Camera = { zoom: 2, x: 0.4, y: 0.5 }
    const to: Camera = { zoom: 6, x: 0.45, y: 0.52 }
    const a = cameraView(from, 800, 600)
    const b = cameraView(to, 800, 600)
    const r = relativeView(from, to, 800, 600)
    // A plate point painted at `from` lands where `to` would paint it.
    const px = 330
    const py = 290
    expect(r.zoom * (a.zoom * px + a.e) + r.e).toBeCloseTo(b.zoom * px + b.e)
    expect(r.zoom * (a.zoom * py + a.f) + r.f).toBeCloseTo(b.zoom * py + b.f)
  })
})

describe('the rest', () => {
  test('texture grows gently', () => {
    expect(textureScale(1)).toBe(1)
    expect(textureScale(8)).toBeCloseTo(2)
    expect(textureScale(0.5)).toBe(1)
  })

  test('easing runs from one camera to the other, geometrically in zoom', () => {
    const from: Camera = { zoom: 1, x: 0.5, y: 0.5 }
    const to: Camera = { zoom: 16, x: 0.3, y: 0.7 }
    expect(interpolateCamera(from, to, 0)).toEqual(from)
    expect(cameraEquals(interpolateCamera(from, to, 1), to)).toBe(true)
    expect(interpolateCamera(from, to, 0.5).zoom).toBeCloseTo(4)
  })

  test('the readout', () => {
    expect(formatZoom(1)).toBe('100%')
    expect(formatZoom(2.504)).toBe('250%')
    expect(formatZoom(MAX_ZOOM)).toBe('3200%')
  })
})
