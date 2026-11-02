import { describe, expect, test } from 'vitest'

import { printPixels } from './print'
import { LANDSCAPE_AT, MARK_RATIO, aspectOf, orientationOf, plateMargins, printMark } from './sheet'

describe('orientationOf', () => {
  test('every tree stays portrait; a plant clearly wider than tall turns the sheet', () => {
    expect(orientationOf(0.47)).toBe('Portrait') // Weed
    expect(orientationOf(0.87)).toBe('Portrait') // Sierpinski, sideways
    expect(orientationOf(1)).toBe('Portrait')
    expect(orientationOf(LANDSCAPE_AT)).toBe('Landscape')
    expect(orientationOf(1.15)).toBe('Landscape') // Koch
  })

  test('a degenerate box counts as square', () => {
    expect(aspectOf({ minX: 0, minY: 0, maxX: 0, maxY: 0 })).toBe(1)
    expect(aspectOf({ minX: 0, minY: 0, maxX: 3, maxY: 0 })).toBe(1)
    expect(aspectOf({ minX: -1, minY: 0, maxX: 1, maxY: 4 })).toBe(0.5)
  })
})

describe('the plate mark', () => {
  test('has the same proportions on every sheet size, as MARK_RATIO says', () => {
    for (const size of ['A4', 'A3', 'A2'] as const) {
      const { width, height } = printPixels(size)
      const portrait = printMark(width, height)
      const landscape = printMark(height, width)
      expect(portrait.height / portrait.width).toBeCloseTo(MARK_RATIO.Portrait, 2)
      expect(landscape.height / landscape.width).toBeCloseTo(MARK_RATIO.Landscape, 2)
    }
  })
})

describe('plateMargins', () => {
  test('keep head room by the height and side room by the width, inside the mark', () => {
    const mark = { x: 14, y: 14, width: 520, height: 750 }
    const margins = plateMargins(mark, 548, 802)
    expect(margins.left).toBeCloseTo(14 + 520 * 0.07)
    expect(margins.right).toBeCloseTo(14 + 520 * 0.07)
    expect(margins.top).toBeCloseTo(14 + 750 * 0.065)
    expect(margins.bottom).toBeCloseTo(38 + 750 * 0.07)
  })

  test('scale with the mark, so the print and the screen compose alike', () => {
    const small = plateMargins({ x: 10, y: 10, width: 100, height: 144 }, 120, 180)
    const big = plateMargins({ x: 100, y: 100, width: 1000, height: 1440 }, 1200, 1800)
    expect((big.top - 100) / (small.top - 10)).toBeCloseTo(10)
    expect((big.left - 100) / (small.left - 10)).toBeCloseTo(10)
  })
})
