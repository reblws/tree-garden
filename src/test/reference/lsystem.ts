// REFERENCE: a frozen copy of src/core/lsystem/index.ts as of commit 0648f8c,
// before the performance work. src/test/determinism.test.ts checks the
// optimised code against it byte for byte. Do not optimise or edit it.
import type { Segments2D } from '../../core/geometry'
import { type ParseError, expand, parseProductions } from './grammar'
import { interpret } from './turtle'

export { expand, parseProductions } from './grammar'
export type { Expansion, Grammar, ParseError, Production } from './grammar'
export { interpret } from './turtle'

export interface LSystemSpec {
  readonly axiom: string
  readonly rules: string
  readonly iterations: number
  readonly angle: number
  readonly jitter: number
}

export interface LSystemOutput {
  readonly geometry: Segments2D
  readonly symbolCount: number
  readonly iterationsApplied: number
  readonly truncated: boolean
  /** The start of the derived string, for display. */
  readonly preview: string
}

export type GenerateResult =
  | ({ readonly ok: true } & LSystemOutput)
  | { readonly ok: false; readonly errors: ReadonlyArray<ParseError> }

/** Strings longer than this stop growing; 2M symbols draws in well under a
 *  second on a laptop. */
export const MAX_SYMBOLS = 2_000_000
const PREVIEW_LENGTH = 600

/** Parse, rewrite and interpret in one call. `random` is consumed by
 *  stochastic productions first and then by angle jitter. */
export const generate = (spec: LSystemSpec, random: () => number): GenerateResult => {
  const parsed = parseProductions(spec.rules)
  if (!parsed.ok) {
    return parsed
  }
  const expansion = expand(
    { axiom: spec.axiom.replace(/\s+/g, ''), productions: parsed.productions },
    spec.iterations,
    random,
    MAX_SYMBOLS,
  )
  const geometry = interpret(
    expansion.result,
    { angleDegrees: spec.angle, angleJitter: spec.jitter, headingDegrees: 90 },
    random,
  )
  return {
    ok: true,
    geometry,
    symbolCount: expansion.result.length,
    iterationsApplied: expansion.iterations,
    truncated: expansion.truncated,
    preview: expansion.result.slice(0, PREVIEW_LENGTH),
  }
}
