import { Option, Schema } from 'effect'

/**
 * One Effect Schema per algorithm is the single description of its
 * parameters. It types the Foldkit Model, validates whatever arrives in a
 * shared URL, and the ranges below drive the sliders.
 */

export const ITERATIONS = { min: 0, max: 12, step: 1 } as const
export const ANGLE = { min: 0, max: 180, step: 0.1 } as const
export const JITTER = { min: 0, max: 1, step: 0.01 } as const

const between = (range: { readonly min: number; readonly max: number }) =>
  Schema.isBetween({ minimum: range.min, maximum: range.max })

const Axiom = Schema.String.check(Schema.isMaxLength(200))
const Rules = Schema.String.check(Schema.isMaxLength(4000))
const Seed = Schema.String.check(Schema.isMaxLength(64))

export const LSystemParams = Schema.Struct({
  axiom: Axiom,
  rules: Rules,
  iterations: Schema.Int.check(between(ITERATIONS)),
  angle: Schema.Finite.check(between(ANGLE)),
  jitter: Schema.Finite.check(between(JITTER)),
  seed: Seed,
})
export type LSystemParams = typeof LSystemParams.Type

// URL CODEC
//
// Each query parameter is decoded on its own, so one bad value (say
// `?n=99`) falls back to its default instead of discarding the whole link.

const IterationsFromString = Schema.FiniteFromString.check(Schema.isInt(), between(ITERATIONS))
const AngleFromString = Schema.FiniteFromString.check(between(ANGLE))
const JitterFromString = Schema.FiniteFromString.check(between(JITTER))

const decodeField = <A>(
  schema: Schema.Codec<A, string>,
  raw: string | null,
  fallback: A,
): A =>
  raw === null
    ? fallback
    : Option.getOrElse(Schema.decodeUnknownOption(schema)(raw), () => fallback)

/** Read params from a query string such as `?axiom=X&n=5`, filling gaps
 *  from `fallback`. */
export const paramsFromSearch = (search: string, fallback: LSystemParams): LSystemParams => {
  const query = new URLSearchParams(search)
  return {
    axiom: decodeField(Axiom, query.get('axiom'), fallback.axiom),
    rules: decodeField(Rules, query.get('rules'), fallback.rules),
    iterations: decodeField(IterationsFromString, query.get('n'), fallback.iterations),
    angle: decodeField(AngleFromString, query.get('angle'), fallback.angle),
    jitter: decodeField(JitterFromString, query.get('jitter'), fallback.jitter),
    seed: decodeField(Seed, query.get('seed'), fallback.seed),
  }
}

/** True when the query string sets any L-system parameter. */
export const hasParams = (search: string): boolean => {
  const query = new URLSearchParams(search)
  return ['axiom', 'rules', 'n', 'angle', 'jitter', 'seed'].some(key => query.has(key))
}

export const paramsToSearch = (params: LSystemParams): string =>
  '?' +
  new URLSearchParams({
    axiom: params.axiom,
    rules: params.rules,
    n: String(params.iterations),
    angle: String(params.angle),
    jitter: String(params.jitter),
    seed: params.seed,
  }).toString()
