import { describe, expect, it } from 'vitest'

import { analyzeBranches } from '../core/branching'
import type { Segments2D } from '../core/geometry'
import {
  RADIUS_ROW,
  TONE_CLASSES,
  chainPrevious,
  jointDirections,
  nextArrivals,
  packSegmentMeta,
  planSlots,
  radiusFor,
  radiusTexels,
  slotClass,
  slotOf,
  toneClassOf,
  twigAlpha,
  unpackSegmentMeta,
  widthClassOf,
  widthLawOf,
} from './twigPlan'

/** A small Y: a trunk of two segments, then two branches. */
const tree = (): Segments2D => {
  const coords = new Float32Array([0, 0, 0, 1, 0, 1, 0, 2, 0, 2, -1, 3, 0, 2, 1, 3])
  return {
    count: 4,
    coords,
    depth: new Uint16Array([0, 0, 1, 1]),
    parent: new Int32Array([-1, 0, 1, 1]),
    arrival: new Float32Array([0, 1, 2, 2]),
    maxDepth: 1,
    maxArrival: 3.4,
    bounds: { minX: -1, minY: 0, maxX: 1, maxY: 3 },
  }
}

describe('width law and radius thresholds', () => {
  it('reads tip and exponent back from a width function', () => {
    const law = widthLawOf(r => 1.2 * r ** 0.8)
    expect(law.tip).toBeCloseTo(1.2, 12)
    expect(law.exponent).toBeCloseTo(0.8, 12)
    expect(widthLawOf(() => 3).exponent).toBe(0)
  })

  it('gives the radius test the same answer as the width test', () => {
    const width = (r: number) => 1.1 * r ** 0.73
    const law = widthLawOf(width)
    const threshold = 4
    const r0 = radiusFor(law, threshold)
    for (let i = 0; i < 2000; i++) {
      const r = Math.fround(1 + i * 0.37)
      // Away from float32 rounding at the threshold itself, they agree.
      if (Math.abs(width(r) - threshold) < 1e-5) continue
      expect(r >= r0).toBe(width(r) >= threshold)
    }
  })

  it('handles an even pen and infinite widths', () => {
    expect(radiusFor({ tip: 2, exponent: 0 }, 1)).toBe(0)
    expect(radiusFor({ tip: 2, exponent: 0 }, 3)).toBe(Number.POSITIVE_INFINITY)
    expect(radiusFor({ tip: 1, exponent: 0.8 }, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('classes and slots', () => {
  it('rounds widths into classes of 0.2 device px on screen', () => {
    expect(widthClassOf(2, 1, 2)).toBe(5)
    expect(widthClassOf(2, 2, 2)).toBe(10)
    expect(widthClassOf(0.01, 1, 2)).toBe(1)
  })

  it('gives every class its own slot when they fit', () => {
    const plan = planSlots(3, 10, 8)
    expect(plan.binWidth).toBe(1)
    expect(plan.slots).toBe(8 * TONE_CLASSES)
    expect(slotOf(plan, 0, 3)).toBe(0)
    expect(slotOf(plan, 0, 10)).toBe(7)
    expect(slotOf(plan, 2, 4)).toBe(17)
    expect(slotClass(plan, 17)).toBe(4)
  })

  it('shares slots between neighbouring classes when they do not, in order', () => {
    const plan = planSlots(2, 18, 8)
    expect(plan.binWidth).toBe(3)
    expect(plan.perTone).toBe(6)
    let last = -1
    for (let c = 2; c <= 18; c++) {
      const slot = slotOf(plan, 1, c)
      expect(slot).toBeGreaterThanOrEqual(last)
      expect(slot).toBeGreaterThanOrEqual(plan.perTone)
      expect(slot).toBeLessThan(2 * plan.perTone)
      last = slot
    }
    // Out-of-range classes are clamped into the tone's slots.
    expect(slotOf(plan, 1, 40)).toBe(2 * plan.perTone - 1)
  })

  it('weights twigs like the Canvas2D painter', () => {
    // Wider and nearer is denser; dilution scales it.
    expect(twigAlpha(8, 0, 1, 2, 1)).toBeGreaterThan(twigAlpha(3, 0, 1, 2, 1))
    expect(twigAlpha(5, 3, 1, 2, 1)).toBeLessThan(twigAlpha(5, 0, 1, 2, 1))
    expect(twigAlpha(5, 0, 1, 2, 0.5)).toBeCloseTo(twigAlpha(5, 0, 1, 2, 1) / 2, 12)
    expect(toneClassOf(0)).toBe(0)
    expect(toneClassOf(0.3)).toBe(1)
    expect(toneClassOf(1)).toBe(3)
  })
})

describe('segment data for the GPU', () => {
  it('packs chain position, chain start and tone', () => {
    const geometry = tree()
    const topology = analyzeBranches(geometry)
    const meta = packSegmentMeta(geometry.count, topology.chainSegments, topology.chainStart, topology.chainCount, topology.chainRecession)
    for (let c = 0; c < topology.chainCount; c++) {
      for (let k = topology.chainStart[c] ?? 0; k < (topology.chainStart[c + 1] ?? 0); k++) {
        const segment = topology.chainSegments[k] ?? 0
        const unpacked = unpackSegmentMeta(meta[segment] ?? 0)
        expect(unpacked.position).toBe(k)
        expect(unpacked.isChainStart).toBe(k === topology.chainStart[c])
        expect(unpacked.toneClass).toBe(toneClassOf(topology.chainRecession[c] ?? 0))
      }
    }
  })

  it('links each piece to its neighbours in its chain', () => {
    const geometry = tree()
    const topology = analyzeBranches(geometry)
    const previous = chainPrevious(geometry.parent, topology.mainChild, geometry.count)
    expect(previous[0]).toBe(-1)
    expect(previous[1]).toBe(0)
    // One branch continues the trunk's stroke, the other starts a chain.
    const main = topology.mainChild[1] ?? -1
    const lateral = main === 2 ? 3 : 2
    expect(previous[main]).toBe(1)
    expect(previous[lateral]).toBe(-1)

    const dirs = jointDirections(geometry.coords, geometry.parent, topology.mainChild, geometry.count)
    // The trunk's second piece comes from straight below and goes on into
    // the main branch.
    expect([dirs[4], dirs[5]]).toEqual([0, 1])
    expect(dirs[6]).toBeCloseTo(main === 2 ? -Math.SQRT1_2 : Math.SQRT1_2, 6)
    expect(dirs[7]).toBeCloseTo(Math.SQRT1_2, 6)
    // A lateral has no predecessor; a tip no successor.
    expect([dirs[lateral * 4], dirs[lateral * 4 + 1]]).toEqual([0, 0])
    expect([dirs[main * 4 + 2], dirs[main * 4 + 3]]).toEqual([0, 0])

    const next = nextArrivals(geometry.arrival, topology.mainChild, geometry.count)
    expect(next[0]).toBe(1)
    expect(next[main]).toBe(Number.POSITIVE_INFINITY)
  })

  it('pads the radii to whole texture rows', () => {
    const radius = new Float32Array([1, 2, 3])
    const texels = radiusTexels(radius, 3)
    expect(texels.length).toBe(RADIUS_ROW)
    expect(Array.from(texels.subarray(0, 4))).toEqual([1, 2, 3, 0])
  })
})
