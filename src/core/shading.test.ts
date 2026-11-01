import { describe, expect, test } from 'vitest'

import { brightness, litSide, shade } from './shading'

describe('litSide', () => {
  test('a trunk growing up the page is lit on its left-hand side as seen on the page', () => {
    // Heading up the screen (y down): the stroke's left-hand edge is on
    // the page's right, away from a light at the upper left.
    expect(litSide(0, -1)).toBeLessThan(0)
  })

  test('a branch reaching right is lit from above', () => {
    // Heading right: the stroke's left-hand edge is the top one.
    expect(litSide(1, 0)).toBeLessThan(0)
    expect(litSide(-1, 0)).toBeGreaterThan(0)
  })

  test('a stroke pointing at the light is lit evenly on both sides', () => {
    expect(litSide(-0.6, -0.8)).toBeCloseTo(0)
  })
})

describe('shade', () => {
  test('the lit side is lighter than the shadow side', () => {
    expect(shade(0.8, 1)).toBeLessThan(shade(-0.8, 1))
    expect(shade(-0.8, -1)).toBeLessThan(shade(0.8, -1))
  })

  test('the core shadow sits inside the shadow edge, which catches reflected light', () => {
    const samples = Array.from({ length: 201 }, (_, i) => -1 + i / 100)
    const darkest = samples.reduce((best, u) => (shade(u, 1) > shade(best, 1) ? u : best), 0)
    expect(darkest).toBeLessThan(-0.3)
    expect(darkest).toBeGreaterThan(-0.95)
    expect(brightness(-1, 1)).toBeGreaterThan(brightness(darkest, 1))
  })

  test('stays within 0..1 and is symmetric when the light is head on', () => {
    for (let u = -1; u <= 1; u += 0.05) {
      for (const lit of [-1, -0.3, 0, 0.4, 1]) {
        const s = shade(u, lit)
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s).toBeLessThanOrEqual(1)
      }
      expect(shade(u, 0)).toBeCloseTo(shade(-u, 0))
    }
  })
})
