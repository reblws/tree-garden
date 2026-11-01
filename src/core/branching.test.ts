import { describe, expect, test } from 'vitest'

import { analyzeBranches, pipeRadii } from './branching'
import { interpret } from './lsystem'

const turtle = (symbols: string, angleDegrees = 30) =>
  interpret(symbols, { angleDegrees, angleJitter: 0, headingDegrees: 90 }, Math.random)

const chains = (symbols: string) => {
  const topology = analyzeBranches(turtle(symbols))
  return Array.from({ length: topology.chainCount }, (_, c) =>
    Array.from(topology.chainSegments.slice(topology.chainStart[c], topology.chainStart[c + 1])),
  )
}

describe('parent links', () => {
  test('a branch grows from the segment before its bracket, and the axis resumes after it', () => {
    // 0: F   1: [+F   2: F]   3: F
    expect(Array.from(turtle('F[+FF]F').parent)).toEqual([-1, 0, 1, 0])
  })

  test('nested brackets restore the right parent', () => {
    // 0 F, 1 [+F, 2 [-F], 3 F], 4 F
    expect(Array.from(turtle('F[+F[-F]F]F').parent)).toEqual([-1, 0, 1, 1, 0])
  })

  test('a move without drawing starts a new stroke', () => {
    expect(Array.from(turtle('FfF').parent)).toEqual([-1, -1])
  })
})

describe('pipeRadii', () => {
  test("Leonardo's rule: a fork's weight is the sum of its children's", () => {
    // Trunk 0 forks into 1 and 2; 1 forks into 3 and 4: three tips.
    const geometry = turtle('F[+F[+F][-F]][-F]')
    const radius = new Float32Array(geometry.count)
    const max = pipeRadii(geometry, 2, radius)
    expect(Array.from(geometry.parent)).toEqual([-1, 0, 1, 1, 0])
    expect(radius[2]).toBe(1)
    expect(radius[1]).toBeCloseTo(Math.SQRT2)
    expect(radius[0]).toBeCloseTo(Math.sqrt(3))
    expect(max).toBeCloseTo(Math.sqrt(3))
  })

  test('an unbranched chain keeps the radius of its tip', () => {
    const geometry = turtle('FFFF')
    const radius = new Float32Array(geometry.count)
    expect(pipeRadii(geometry, 2.3, radius)).toBe(1)
    expect(Array.from(radius)).toEqual([1, 1, 1, 1])
  })

  test('only visible segments count, so a growing tree thickens', () => {
    const geometry = turtle('F[+F][-F]F')
    const radius = new Float32Array(geometry.count)
    pipeRadii(geometry, 2, radius, 2)
    expect(Array.from(radius)).toEqual([1, 1, 0, 0])
    pipeRadii(geometry, 2, radius, 2, i => i !== 1)
    expect(Array.from(radius)).toEqual([1, 0, 0, 0])
    pipeRadii(geometry, 2, radius)
    expect(radius[0]).toBeCloseTo(Math.sqrt(3))
  })
})

describe('analyzeBranches', () => {
  test('the trunk continues into its heaviest child', () => {
    // From 0: a light branch 1 (one tip) and a heavy one 2 (two tips).
    const topology = analyzeBranches(turtle('F[+F]F[+F][-F]'))
    expect(Array.from(topology.childCount)).toEqual([2, 0, 2, 0, 0])
    expect(topology.mainChild[0]).toBe(2)
  })

  test('ties go to the straightest child', () => {
    // 1 turns left, 2 goes straight on: the stroke continues through 2.
    expect(chains('F[+F]F')).toEqual([[0, 2], [1]])
  })

  test('chains partition the segments, root to tip', () => {
    const geometry = turtle('F[+F[-F]F]F[-FF]F')
    const topology = analyzeBranches(geometry)
    const all = Array.from(topology.chainSegments).sort((a, b) => a - b)
    expect(all).toEqual(Array.from({ length: geometry.count }, (_, i) => i))
    for (let c = 0; c < topology.chainCount; c++) {
      const start = topology.chainStart[c] ?? 0
      const end = topology.chainStart[c + 1] ?? 0
      for (let k = start + 1; k < end; k++) {
        const segment = topology.chainSegments[k] ?? 0
        expect(geometry.parent[segment]).toBe(topology.chainSegments[k - 1])
      }
    }
  })

  test('a fractal curve without branches is a single stroke', () => {
    expect(chains('F+F--F+F')).toEqual([[0, 1, 2, 3]])
  })
})

describe('chain order and recession', () => {
  test('every chain knows the chain it branches off and its order', () => {
    // Trunk 0-2-4, a branch 1 off 0 with a twig 3 off it.
    const geometry = turtle('F[+F[-F]F]F[-FF]F')
    const topology = analyzeBranches(geometry)
    const { chainOf, chainParent, chainOrder } = topology
    const trunk = chainOf[0] ?? -1
    expect(chainParent[trunk]).toBe(-1)
    expect(chainOrder[trunk]).toBe(0)
    for (let c = 0; c < topology.chainCount; c++) {
      const up = chainParent[c] ?? -1
      if (up < 0) continue
      expect(up).toBeLessThan(c)
      expect(chainOrder[c]).toBe((chainOrder[up] ?? 0) + 1)
    }
    // A chain holds exactly the segments chainOf says it does.
    for (let c = 0; c < topology.chainCount; c++) {
      for (let k = topology.chainStart[c] ?? 0; k < (topology.chainStart[c + 1] ?? 0); k++) {
        expect(chainOf[topology.chainSegments[k] ?? 0]).toBe(c)
      }
    }
  })

  test('recession never decreases away from the trunk and stays in 0..1', () => {
    const geometry = turtle('F[+F[+F[+F[+F][-F]][-F]][-F]][-F[-F[-F]]]F'.repeat(3))
    const { chainCount, chainParent, chainRecession } = analyzeBranches(geometry)
    for (let c = 0; c < chainCount; c++) {
      const r = chainRecession[c] ?? 0
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
      const up = chainParent[c] ?? -1
      if (up < 0) expect(r).toBe(0)
      else expect(r).toBeGreaterThanOrEqual(chainRecession[up] ?? 0)
    }
  })

  test('recession is a function of the plant, not of the run', () => {
    const symbols = 'F[+F[-F]F]F[-FF]F[+F]F'
    expect(Array.from(analyzeBranches(turtle(symbols)).chainRecession)).toEqual(
      Array.from(analyzeBranches(turtle(symbols)).chainRecession),
    )
  })
})
