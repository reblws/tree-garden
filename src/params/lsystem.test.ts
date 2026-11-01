import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import { generateLSystem } from '../engine/lsystem'
import { type LSystemParams, paramsFromSearch, paramsToSearch } from './lsystem'

const params: LSystemParams = {
  axiom: 'X',
  rules: 'X -> F[+X]F[-X]+X\nF -> FF',
  iterations: 7,
  angle: 20,
  jitter: 0.25,
  seed: 'rowan-4821',
}

describe('URL codec', () => {
  test('round-trips params, including newlines in rules', () => {
    expect(paramsFromSearch(paramsToSearch(params), { ...params, axiom: 'other' })).toEqual(params)
  })

  test('an invalid field falls back on its own, keeping the rest', () => {
    const decoded = paramsFromSearch('?n=99&angle=abc&axiom=FX', params)
    expect(decoded).toEqual({ ...params, axiom: 'FX' })
  })

  test('rejects fractional iteration counts', () => {
    expect(paramsFromSearch('?n=2.5', params).iterations).toBe(params.iterations)
  })
})

describe('generateLSystem (Effect)', () => {
  test('the seed makes stochastic plants reproducible', () => {
    const coords = (seed: string) => {
      const result = Effect.runSync(generateLSystem({ ...params, seed }))
      if (!result.ok) throw new Error('expected ok')
      return Array.from(result.geometry.coords)
    }
    expect(coords('oak')).toEqual(coords('oak'))
    expect(coords('oak')).not.toEqual(coords('elm'))
  })
})
