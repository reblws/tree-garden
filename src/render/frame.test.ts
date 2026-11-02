import { describe, expect, test } from 'vitest'

import { strokeWidthOf, widthScale } from './frame'

describe('strokeWidthOf', () => {
  /** Pipe radii as the topology stores them, plus values that aren't. */
  const radii = [
    0,
    1,
    ...Array.from({ length: 5000 }, (_, w) => Math.fround((w + 1) ** (1 / 2.3))),
    Math.SQRT2,
    173.2050807568877,
    1e-9,
  ]

  test('gives exactly tip * radius ** exponent, hit or miss', () => {
    const widths = widthScale(180, 3.1, 2, 1376)
    const width = strokeWidthOf(widths)
    for (let pass = 0; pass < 2; pass++) {
      for (const r of radii) expect(Object.is(width(r), widths.tip * r ** widths.exponent)).toBe(true)
    }
  })

  test('two scales in use at once (a print between screen frames) stay exact', () => {
    const screen = widthScale(180, 3.1, 2, 1376)
    const print = widthScale(180, 9.4, 6.2, 4961)
    const onScreen = strokeWidthOf(screen)
    const inPrint = strokeWidthOf(print)
    for (const r of radii) {
      expect(Object.is(onScreen(r), screen.tip * r ** screen.exponent)).toBe(true)
      expect(Object.is(inPrint(r), print.tip * r ** print.exponent)).toBe(true)
    }
  })

  test('an unbranched figure gets one even width', () => {
    const widths = widthScale(1, 3, 2, 1000)
    expect(strokeWidthOf(widths)(7)).toBe(widths.tip)
  })
})
