import { describe, expect, it } from 'vitest'

import { FbmCurve, NoiseCurve, fbm1, noise1 } from './noise'

describe('NoiseCurve', () => {
  it('gives noise1 bit for bit along a walk, forwards, backwards and jumping', () => {
    const curve = new NoiseCurve(1234)
    const ts = [
      ...Array.from({ length: 400 }, (_, i) => i * 0.137),
      ...Array.from({ length: 100 }, (_, i) => 40 - i * 0.29),
      -3.5, 1e6 + 0.25, 7, 7, 8.999, 9,
    ]
    for (const t of ts) expect(curve.at(t)).toBe(noise1(1234, t))
  })

  it('starts over on reset', () => {
    const curve = new NoiseCurve(1)
    curve.at(3.3)
    curve.reset(99)
    expect(curve.at(3.4)).toBe(noise1(99, 3.4))
  })
})

describe('FbmCurve', () => {
  it('gives fbm1 bit for bit', () => {
    const curve = new FbmCurve(-77)
    for (let i = 0; i < 500; i++) {
      const t = i * 0.051
      expect(curve.at(t)).toBe(fbm1(-77, t))
    }
  })
})
