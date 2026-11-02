/**
 * Deterministic noise for the renderer. Nothing here calls Math.random:
 * every value is a hash of integers (a segment or chain index, a lattice
 * cell), so a redraw, an animation frame and a second visit to the same
 * link all paint the same marks.
 */

/** 32-bit integer hash (lowbias32 by Chris Wellons), mapped to [0, 1). */
export const hash = (n: number): number => {
  let x = n | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

/** Hash of two integers, e.g. (chain, lattice cell). */
export const hash2 = (a: number, b: number): number => hash(Math.imul(a, 0x9e3779b1) ^ (b + 0x632be5ab))

/** Smooth 1D value noise in [-1, 1] along `t`, one independent curve per
 *  `seed`. Lattice spacing is 1. */
export const noise1 = (seed: number, t: number): number => {
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  const a = hash2(seed, i)
  const b = hash2(seed, i + 1)
  return (a + (b - a) * u) * 2 - 1
}

/** Two octaves of value noise: broad wander plus a little fine tremor. */
export const fbm1 = (seed: number, t: number): number =>
  noise1(seed, t) * 0.7 + noise1(seed ^ 0x5bd1e995, t * 3.1) * 0.3

/**
 * `noise1(seed, t)` for a walk along `t`: it keeps the lattice cell it is
 * in, so the many samples a stroke takes per cell hash nothing new. Same
 * values, bit for bit, as `noise1`.
 */
export class NoiseCurve {
  seed: number
  #cell = Number.NaN
  #a = 0
  #b = 0

  constructor(seed: number) {
    this.seed = seed
  }

  /** Start over on another curve. */
  reset(seed: number): this {
    this.seed = seed
    this.#cell = Number.NaN
    return this
  }

  at(t: number): number {
    const i = Math.floor(t)
    if (i !== this.#cell) {
      if (i === this.#cell + 1) {
        this.#a = this.#b
        this.#b = hash2(this.seed, i + 1)
      } else {
        this.#a = hash2(this.seed, i)
        this.#b = hash2(this.seed, i + 1)
      }
      this.#cell = i
    }
    const f = t - i
    const u = f * f * (3 - 2 * f)
    const a = this.#a
    return (a + (this.#b - a) * u) * 2 - 1
  }
}

/** `fbm1(seed, t)` for a walk along `t`, like NoiseCurve. */
export class FbmCurve {
  readonly #broad = new NoiseCurve(0)
  readonly #fine = new NoiseCurve(0)

  constructor(seed: number) {
    this.reset(seed)
  }

  reset(seed: number): this {
    this.#broad.reset(seed)
    this.#fine.reset(seed ^ 0x5bd1e995)
    return this
  }

  at(t: number): number {
    return this.#broad.at(t) * 0.7 + this.#fine.at(t * 3.1) * 0.3
  }
}

/** A small seeded PRNG (mulberry32) for procedural textures that need a
 *  stream of numbers. Deterministic for a given seed. */
export const prng = (seed: number): (() => number) => {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
