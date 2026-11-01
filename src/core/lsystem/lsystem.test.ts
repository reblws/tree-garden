import { describe, expect, test } from 'vitest'

import { expand, generate, interpret, parseProductions } from '.'

/** A deterministic stand-in for a seeded generator. */
const sequence = (...values: ReadonlyArray<number>) => {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

const productions = (text: string) => {
  const parsed = parseProductions(text)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.productions
}

describe('parseProductions', () => {
  test('reads arrows, weights, comments and blank lines', () => {
    expect(productions('# comment\nF -> F[+F]F\n\nX (0.25) → F X\nY = YY')).toEqual([
      { predecessor: 'F', successor: 'F[+F]F', weight: 1 },
      { predecessor: 'X', successor: 'FX', weight: 0.25 },
      { predecessor: 'Y', successor: 'YY', weight: 1 },
    ])
  })

  test('reports the line number of a malformed rule', () => {
    expect(parseProductions('F -> FF\nnot a rule')).toEqual({
      ok: false,
      errors: [{ line: 2, message: expect.stringContaining('not a rule') }],
    })
  })
})

describe('expand', () => {
  test('Lindenmayer algae: string lengths follow the Fibonacci numbers', () => {
    const result = expand({ axiom: 'A', productions: productions('A -> AB\nB -> A') }, 7, Math.random, 1e6)
    expect(result.lengths).toEqual([1, 2, 3, 5, 8, 13, 21, 34])
    expect(result.result.startsWith('ABAABABAABAAB')).toBe(true)
  })

  test('picks stochastic successors by cumulative weight', () => {
    const rules = productions('F (1) -> a\nF (3) -> b')
    // 0.2 * 4 = 0.8 < 1 -> "a"; 0.5 * 4 = 2 -> "b"
    expect(expand({ axiom: 'FF', productions: rules }, 1, sequence(0.2, 0.5), 100).result).toBe('ab')
  })

  test('stops before exceeding maxSymbols and keeps the last full string', () => {
    const result = expand({ axiom: 'F', productions: productions('F -> FF') }, 10, Math.random, 100)
    expect(result).toMatchObject({ iterations: 6, truncated: true })
    expect(result.result.length).toBe(64)
  })
})

describe('interpret', () => {
  test('draws a square with F and +', () => {
    const geometry = interpret('F+F+F+F', { angleDegrees: 90, angleJitter: 0, headingDegrees: 0 }, Math.random)
    expect(geometry.count).toBe(4)
    expect(Array.from(geometry.coords.slice(12), v => Math.round(v) + 0)).toEqual([0, 1, 0, 0])
    expect(geometry.bounds.minX).toBeCloseTo(0)
    expect(geometry.bounds.maxX).toBeCloseTo(1)
  })

  test('branches record depth and restore position and path distance', () => {
    const geometry = interpret('F[+F]F', { angleDegrees: 45, angleJitter: 0, headingDegrees: 90 }, Math.random)
    expect(Array.from(geometry.depth)).toEqual([0, 1, 0])
    expect(Array.from(geometry.arrival)).toEqual([0, 1, 1])
    // The third segment starts where the first ended, at (0, 1).
    expect(geometry.coords[8]).toBeCloseTo(0)
    expect(geometry.coords[9]).toBeCloseTo(1)
    expect(geometry.maxDepth).toBe(1)
  })
})

describe('generate', () => {
  const spec = {
    axiom: 'F',
    rules: 'F (0.33) -> F[+F]F[-F]F\nF (0.33) -> F[+F]F\nF (0.34) -> F[-F]F',
    iterations: 4,
    angle: 25.7,
    jitter: 0.2,
  }

  test('same random sequence, same plant', () => {
    const a = generate(spec, sequence(0.1, 0.7, 0.4, 0.9))
    const b = generate(spec, sequence(0.1, 0.7, 0.4, 0.9))
    if (!a.ok || !b.ok) throw new Error('expected ok')
    expect(Array.from(a.geometry.coords)).toEqual(Array.from(b.geometry.coords))
  })

  test('returns parse errors instead of geometry', () => {
    expect(generate({ ...spec, rules: '???' }, Math.random).ok).toBe(false)
  })
})
